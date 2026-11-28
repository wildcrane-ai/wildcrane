import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'
import { codexServer } from '../src/codex-server'
import { codexRecordFile, nativeDirectory, readPrivate, type NativeBackend } from '../src/codex-native'
import { connect } from '../../cli/src/lib/agent/wire/rpc'
import { FakeCloud, until, writeFakeSession } from './fake-cloud'

const entry=process.env.RUNNER_TEST_FLOW_HOST!
const originalHome=process.env.WILDCRANE_HOME,originalAgentHome=process.env.AI4KANBAN_HOME
let root:string,cloud:FakeCloud,host:ChildProcess|undefined
const peers=new Set<ChildProcess>()
const backend=()=>fs.readdirSync(nativeDirectory()).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(name=>readPrivate<NativeBackend>(path.join(nativeDirectory(),name))!)[0]!
const calls=()=>fs.existsSync(path.join(root,'calls.jsonl'))?fs.readFileSync(path.join(root,'calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[]
beforeEach(async()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-native-home-'));process.env.WILDCRANE_HOME=root;process.env.AI4KANBAN_HOME=root
 writeFakeSession(root);process.env.FAKE_CODEX_CALLS=path.join(root,'calls.jsonl');process.env.FAKE_AKB_LOG=path.join(root,'akb.jsonl');process.env.FAKE_AKB_ENTRY=path.join(process.env.RUNNER_DIST!,'../test/fake-akb.mjs')
 fs.copyFileSync(path.join(process.env.RUNNER_DIST!,'../test/fake-codex-native.mjs'),path.join(root,'codex'));fs.chmodSync(path.join(root,'codex'),0o755)
 cloud=new FakeCloud();await cloud.start()
})
afterEach(async()=>{
 for(const child of peers)if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'close');child.kill('SIGTERM');await ended}peers.clear()
 if(host&&host.exitCode===null&&host.signalCode===null){const ended=once(host,'close');host.kill('SIGTERM');await ended}host=undefined
 const owner=await codexServer();await owner.shutdown()
 await cloud.stop();process.env.WILDCRANE_HOME=originalHome;process.env.AI4KANBAN_HOME=originalAgentHome;delete process.env.FAKE_CODEX_CALLS;fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20})
})
async function launch(){
 const count=cloud.registrations
 host=spawn(process.execPath,[entry],{env:process.env,stdio:['ignore','ignore','pipe','ipc']});let error='';host.stderr!.on('data',s=>error+=s)
 await until(()=>fs.existsSync(codexRecordFile())||host!.exitCode!==null,10000);assert.equal(host.exitCode,null,error);await until(()=>cloud.registrations>count,10000)
}
async function task(){
 const child=spawn(process.execPath,[path.join(process.env.RUNNER_DIST!,'codex-proxy.mjs'),path.join(root,'codex'),'app-server'],{env:process.env,stdio:['pipe','pipe','pipe']});peers.add(child)
 const notifications:any[]=[];const rpc=connect(child.stdout!,child.stdin!,message=>notifications.push(message));await rpc.call('initialize',{});const{thread}=await rpc.call('thread/start',{});const id=(thread as any).id;await rpc.call('turn/start',{threadId:id});return{child,rpc,id,notifications}
}
for(const signal of ['SIGTERM','SIGKILL','update']as const){
 it(`keeps native Codex and task connections across Runner ${signal} and takeover (#724, #766)`,{timeout:20000},async()=>{
  await launch();const a=await task();const original=backend();const old=JSON.parse(fs.readFileSync(codexRecordFile(),'utf8'));assert.equal(old.pid,host!.pid)
  const ended=once(host!,'close');if(signal==='update')host!.send('update');else host!.kill(signal);await ended;host=undefined
  process.kill(original.pid,0);assert.equal(a.notifications.some(n=>n.method==='turn/completed'),false)
  await launch();const current=JSON.parse(fs.readFileSync(codexRecordFile(),'utf8'));assert.notEqual(current.pid,old.pid);assert.equal(current.pid,host!.pid)
  assert.equal(backend().instance,original.instance);assert.ok(await a.rpc.call('thread/read',{threadId:a.id}));assert.equal(calls().filter(c=>c.method==='spawn').length,1);assert.equal(calls().filter(c=>c.method==='turn/start').length,1);assert.equal(calls().filter(c=>c.method==='turn/interrupt').length,0)
  assert.equal(fs.existsSync(path.join(root,'codex-service-v2.json')),false)
 })
}
it('rebuilds a dead native backend and resumes saved history without replacing another live backend',async()=>{
 await launch();const a=await task(),original=backend();const closed=once(a.child,'close');process.kill(original.pid,'SIGKILL');await closed
 const next=await task();assert.notEqual(backend().instance,original.instance);assert.ok(await next.rpc.call('thread/read',{threadId:next.id}))
})
it('account exit stops native work even though the backend is independent of Runner',async()=>{
 await launch();const a=await task();const pid=backend().pid;const ended=once(a.child,'close');fs.writeFileSync(path.join(root,'account-generation'),'signed-out');await ended
 await until(()=>{try{process.kill(pid,0);return false}catch{return true}},5000)
})
