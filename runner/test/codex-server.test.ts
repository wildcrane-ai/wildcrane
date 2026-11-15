import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, beforeEach, it } from 'node:test'
import { once } from 'node:events'
import { codexServer, threadConfig } from '../src/codex-server'
import { initializeNative, leaseFile, nativeConnection, nativeDirectory, readPrivate, type NativeBackend } from '../src/codex-native'
import { connect } from '../../cli/src/lib/agent/wire/rpc'
import { until } from './fake-cloud'

const previous = process.env.WILDCRANE_HOME
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-test-'))
const fake = path.join(root, 'codex')
const calls = path.join(root, 'calls.jsonl')
const peers = new Set<ChildProcessWithoutNullStreams>()
let manager: Awaited<ReturnType<typeof codexServer>>
beforeEach(async () => {
 process.env.WILDCRANE_HOME = root; process.env.FAKE_CODEX_CALLS = calls
 fs.copyFileSync(path.join(process.env.RUNNER_DIST!, '../test/fake-codex-native.mjs'), fake);fs.chmodSync(fake, 0o755)
 manager = await codexServer()
})
afterEach(async () => { for(const child of peers){if(child.exitCode===null&&child.signalCode===null){const done=once(child,'close');child.stdin.end();await done;}}peers.clear();await manager.shutdown();fs.rmSync(nativeDirectory(),{recursive:true,force:true}) })
after(() => { process.env.WILDCRANE_HOME=previous;delete process.env.FAKE_CODEX_CALLS;fs.rmSync(root,{recursive:true,force:true}) })
const read = () => fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[]
const backends = () => fs.readdirSync(nativeDirectory()).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(name=>readPrivate<NativeBackend>(path.join(nativeDirectory(),name))!)
async function peer(args:string[]=[], local:NodeJS.ProcessEnv={}) {
 const child=spawn(process.execPath,[path.join(process.env.RUNNER_DIST!,'codex-proxy.mjs'),fake,'app-server',...args],{env:{...process.env,...manager.env,...local},stdio:['pipe','pipe','pipe']})
 peers.add(child);let error='';child.stderr.on('data',s=>error+=s);const notifications:any[]=[]
 const rpc=connect(child.stdout,child.stdin,message=>notifications.push(message))
 const hello=await rpc.call('initialize',{})
 return {child,rpc,hello,notifications,async close(){if(child.exitCode!==null||child.signalCode!==null)return;const ended=once(child,'close');child.stdin.end();await ended;assert.equal(child.exitCode,0,error)}}
}
it('shares native backends while isolating settings, thread ownership and stops (#707)',async()=>{
 const offset=read().length
 const [a,b]=await Promise.all([peer(['-c','model="alpha"'],{KANBAN_RUN:'a'}),peer(['-c','model="beta"'],{KANBAN_RUN:'b'})])
 const aid=(await a.rpc.call('thread/start',{})).thread as any,bid=(await b.rpc.call('thread/start',{})).thread as any
 await Promise.all([a.rpc.call('turn/start',{threadId:aid.id}),b.rpc.call('turn/start',{threadId:bid.id})])
 const duplicate=await peer();await assert.rejects(duplicate.rpc.call('thread/resume',{threadId:aid.id}),/already in use/)
 await assert.rejects(b.rpc.call('turn/interrupt',{threadId:aid.id,turnId:'other'}),/does not own/)
 await a.close();assert.equal(b.notifications.some(n=>n.method==='turn/completed'),false)
 await b.close();await duplicate.close()
 const relevant=read().slice(offset);assert.equal(relevant.filter(c=>c.method==='spawn').length,1)
 const started=relevant.filter(c=>c.method==='thread/start');assert.equal(started[0].params.config.model,'alpha');assert.equal(started[1].params.config.model,'beta')
 assert.equal(started[0].params.config['shell_environment_policy.set'].KANBAN_RUN,'a')
 assert.equal(started[1].params.config['mcp_servers.defaultProbe.env'].KANBAN_RUN,'b')
 assert.equal(relevant.find(c=>c.method==='spawn').marker,undefined)
})
it('releases fork sources and failed preparation reservations (#762)',async()=>{
 const a=await peer();const id=((await a.rpc.call('thread/start',{})).thread as any).id;await a.close()
 const offset=read().length
 const b=await peer();const fork=((await b.rpc.call('thread/fork',{threadId:id})).thread as any).id
 await b.rpc.call('turn/start',{threadId:fork,input:[{text:'finish'}]});await b.close()
 const c=await peer(['-c','model="updated"']);assert.equal((await c.rpc.call('thread/resume',{threadId:fork})).model,'updated')
 await assert.rejects(c.rpc.call('thread/resume',{threadId:'missing'}),/no rollout found/)
 const d=await peer();await assert.rejects(d.rpc.call('thread/resume',{threadId:'missing'}),/no rollout found/)
 await c.close();await d.close()
 assert.equal(read().slice(offset).some(c=>c.params?.threadId===id&&c.method==='thread/backgroundTerminals/clean'),false)
})
it('keeps task connections and native identity across manager replacement (#724, #766)',async()=>{
 const a=await peer();const id=((await a.rpc.call('thread/start',{})).thread as any).id;await a.rpc.call('turn/start',{threadId:id})
 const original=backends()[0]!
 await manager.close();process.kill(original.pid,0)
 manager=await codexServer()
 assert.equal(backends()[0]!.instance,original.instance)
 assert.ok(await a.rpc.call('thread/read',{threadId:id}));assert.equal(a.notifications.some(n=>n.method==='turn/completed'),false)
 const b=await peer();await b.rpc.call('thread/start',{});assert.equal(backends().length,1)
 await a.close();await b.close()
})
it('retains execution subscriptions and adopts services without a shared daemon (#750, #766)',async()=>{
 const a=await peer();const id=((await a.rpc.call('thread/start',{})).thread as any).id
 await a.rpc.call('turn/start',{threadId:id,input:[{text:'retain'}]})
 await a.rpc.call('wildcrane/settled',{threadId:id,...a.hello.wildcrane as object,execution:'kept',confirmed:true,kept:[{threadId:id,itemId:'service',processId:'42'}]})
 await a.close();await manager.close();manager=await codexServer()
 const different=await peer(['-c','model="changed"']);await assert.rejects(different.rpc.call('thread/resume',{threadId:id}),/cannot change execution settings/);await different.close()
 const b=await peer();const resumed=await b.rpc.call('thread/resume',{threadId:id});assert.deepEqual(resumed.retainedThreads,[{id}])
 assert.equal(((await b.rpc.call('thread/backgroundTerminals/list',{threadId:id})).data as any[]).length,1)
 await b.rpc.call('turn/start',{threadId:id,input:[{text:'finish-service'}]});await b.close()
 assert.equal(fs.existsSync(path.join(root,'codex-service-v2.json')),false)
})
it('isolates provider crashes and preserves saved-thread recovery',async()=>{
 const a=await peer(['-c','model_provider="alpha"']),b=await peer(['-c','model_provider="beta"'])
 const aid=((await a.rpc.call('thread/start',{})).thread as any).id,bid=((await b.rpc.call('thread/start',{})).thread as any).id
 await assert.rejects(a.rpc.call('turn/start',{threadId:aid,input:[{text:'crash'}]}),/closed|connection failed/)
 assert.ok(await b.rpc.call('thread/read',{threadId:bid}));await b.close()
 const c=await peer(['-c','model_provider="alpha"']);assert.ok(await c.rpc.call('thread/resume',{threadId:aid}));await c.close()
})
it('refuses replay behind an abandoned live turn and releases it after confirmed completion (#766)',async()=>{
 const offset=read().length
 const a=await peer();const id=((await a.rpc.call('thread/start',{})).thread as any).id
 const {turn}=await a.rpc.call('turn/start',{threadId:id})
 const ended=once(a.child,'close');a.child.kill('SIGKILL');await ended
 const b=await peer();await assert.rejects(b.rpc.call('thread/resume',{threadId:id}),/work still running/)
 const observer=await nativeConnection(backends()[0]!,()=>{})
 try{await initializeNative(observer);await observer.rpc.call('turn/interrupt',{threadId:id,turnId:(turn as any).id})}finally{observer.close()}
 await b.rpc.call('thread/resume',{threadId:id});await b.close()
 assert.equal(read().slice(offset).filter(call=>call.method==='turn/start'&&call.params.threadId===id).length,1)
})
it('keeps credentials out of thread-local job overrides',()=>{
 const config=threadConfig(['codex','app-server','-c','model="x"'],{...process.env,OPENAI_API_KEY:'never-thread-local',KANBAN_RUN:'own-run'})
 assert.equal((config['shell_environment_policy.set'] as any).OPENAI_API_KEY,undefined)
 assert.equal((config['shell_environment_policy.set'] as any).KANBAN_RUN,'own-run')
})

it('keeps fork sources reserved until every concurrent preparation completes (#762)', async () => {
 const a = await peer()
 const id = ((await a.rpc.call('thread/start', {})).thread as any).id
 await a.close()
 const b = await peer()
 const slow = b.rpc.call('thread/fork', { threadId: id, pausePreparation: true })
 await until(() => read().some(row => row.method === 'thread/fork' && row.params.pausePreparation), 2000)
 await b.rpc.call('thread/fork', { threadId: id })
 const c = await peer()
 await assert.rejects(c.rpc.call('thread/resume', { threadId: id }), /already in use/)
 await slow
 assert.ok(await c.rpc.call('thread/resume', { threadId: id }))
 await b.close(); await c.close()
})

it('routes pending approvals through Runner takeover and stops only the owning execution (#766)', async () => {
 const offset = read().length
 const a = await peer(), b = await peer()
 const aid = ((await a.rpc.call('thread/start', {})).thread as any).id
 const bid = ((await b.rpc.call('thread/start', {})).thread as any).id
 await a.rpc.call('turn/start', { threadId: aid, input: [{ text: 'approval' }] })
 await b.rpc.call('turn/start', { threadId: bid })
 await until(() => a.notifications.some(n => n.method?.endsWith('requestApproval')), 2000)
 await manager.close(); manager = await codexServer()
 assert.equal(b.notifications.some(n => n.method?.endsWith('requestApproval')), false)
 b.rpc.reply('permission', { decision: 'accept' })
 a.rpc.reply('permission', { decision: 'decline' })
 await until(() => read().slice(offset).some(row => row.method === 'approval-answer'), 2000)
 const answers = read().slice(offset).filter(row => row.method === 'approval-answer')
 assert.deepEqual(answers.map(row => row.result), [{ decision: 'decline' }])
 await a.close()
 assert.equal(b.notifications.some(n => n.method === 'turn/completed'), false)
 assert.ok(await b.rpc.call('thread/read', { threadId: bid }))
 await b.close()
})

it('bounds unconfirmed cleanup while preserving parallel work and reconciling stale ownership (#766)', { timeout: 20000 }, async () => {
 const a = await peer(), b = await peer()
 const id = ((await a.rpc.call('thread/start', {})).thread as any).id
 const other = ((await b.rpc.call('thread/start', {})).thread as any).id
 await a.rpc.call('turn/start', { threadId: id, input: [{ text: 'hang-release' }] })
 await b.rpc.call('turn/start', { threadId: other })
 await a.close()
 assert.equal(a.notifications.some(n => n.method === 'wildcrane/cleanup' && n.params.status === 'unconfirmed'), true)
 assert.ok(await b.rpc.call('thread/read', { threadId: other }))
 assert.equal(b.notifications.some(n => n.method === 'turn/completed'), false)
 const record = readPrivate<any>(leaseFile(backends()[0]!, id))
 assert.equal(record.uncertain, true)
 // The dead owner is reusable only after native state confirms it has no live work.
 const c = await peer()
 assert.ok(await c.rpc.call('thread/resume', { threadId: id }))
 await c.close(); await b.close()
})
