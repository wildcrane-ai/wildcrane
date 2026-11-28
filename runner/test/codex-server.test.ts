import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { once } from 'node:events'
import { threadConfig } from '../src/codex-server'
import { initializeNative, leaseFile, nativeConnection, readPrivate, releaseNativeThread, writePrivate } from '../src/codex-native'
import { createCodexClient } from '../../cli/src/lib/agent/wire/codex'
import { RpcError } from '../../cli/src/lib/agent/wire/rpc'
import { reconcileCodexLeases } from '../src/codex-ownership'
import { until } from './fake-cloud'

import { root, fake, calls, peers, manager, read, backends, peer, openManager } from './codex-server-harness'

it('shares native backends while isolating settings, thread ownership and stops (#707)',async()=>{
 const offset=read().length
 const [a,b]=await Promise.all([peer(['-c','model="alpha"'],{KANBAN_RUN:'a',AI4KANBAN_TASK:'task-a',CUSTOM_TASK_VALUE:'task-a'}),peer(['-c','model="beta"'],{KANBAN_RUN:'b',CUSTOM_TASK_VALUE:'task-b'})])
 const aid=(await a.rpc.call('thread/start',{})).thread as any,bid=(await b.rpc.call('thread/start',{})).thread as any
 await Promise.all([a.rpc.call('turn/start',{threadId:aid.id}),b.rpc.call('turn/start',{threadId:bid.id})])
 const duplicate=await peer([],{KANBAN_RUN:'duplicate',AI4KANBAN_TASK:'task-b'});await assert.rejects(duplicate.rpc.call('thread/resume',{threadId:aid.id}),error=>{
  assert.match(String(error),/already in use/)
  assert.ok(error instanceof RpcError)
  assert.equal((error.data as any).wildcraneFailure.code, 'codex_ownership_unconfirmed')
  assert.equal((error.data as any).wildcraneFailure.source, 'runner')
  const details=JSON.parse((error as Error).message.slice((error as Error).message.indexOf('{')))
  assert.equal(details.thread,aid.id);assert.equal(details.owner.run,'a');assert.equal(details.owner.task,'task-a')
  assert.equal(details.requester.run,'duplicate');assert.equal(details.requester.task,'task-b');assert.equal(details.status,'owner-alive')
  return true
 })
 await assert.rejects(b.rpc.call('wildcrane/stopForRetry', { ...(a.hello.wildcrane as object), threadId: aid.id, turnId: 'turn-1' }), /already in use/)
 assert.equal(read().slice(offset).filter(c => c.method === 'turn/interrupt').length, 0)
 await assert.rejects(b.rpc.call('turn/interrupt',{threadId:aid.id,turnId:'other'}),/does not own/)
 await a.close();assert.equal(b.notifications.some(n=>n.method==='turn/completed'),false)
 await b.close();await duplicate.close()
 const relevant=read().slice(offset);assert.equal(relevant.filter(c=>c.method==='spawn').length,1)
 const started=relevant.filter(c=>c.method==='thread/start').sort((a,b)=>a.params.config.model.localeCompare(b.params.config.model));assert.equal(started[0].params.config.model,'alpha');assert.equal(started[1].params.config.model,'beta')
 assert.equal(started[0].params.config['shell_environment_policy.set'].KANBAN_RUN,'a')
 assert.equal(started[1].params.config['mcp_servers.defaultProbe.env'].KANBAN_RUN,'b')
 assert.equal(started[0].params.config['shell_environment_policy.set'].CUSTOM_TASK_VALUE,'task-a')
 assert.equal(started[1].params.config['mcp_servers.defaultProbe.env'].CUSTOM_TASK_VALUE,'task-b')
 assert.equal(relevant.find(c=>c.method==='spawn').marker,undefined)
})
for (const stop of [false, true]) it(`holds a discussion fork before submission until its owner releases it (${stop ? 'stopped' : 'continues'}, #883)`, async () => {
 const owner = await peer()
 const source = (await owner.rpc.call('thread/start', {})).thread as { id: string }
 await owner.rpc.call('turn/start', { threadId: source.id, input: [{ text: 'source discussion' }] })
 const child = spawn(process.execPath, [path.join(process.env.RUNNER_DIST!, 'codex-proxy.mjs'), fake, 'app-server'], {
  env: { ...process.env, ...manager.env, KANBAN_RUN: 'new-task' }, stdio: ['pipe', 'pipe', 'pipe'],
 })
 peers.add(child)
 const request = 'first task request'
 const controller = new AbortController()
 const sessions: string[] = []
 let waiting = false
 const offset = read().length
 // The fake completes "finish" without background work.
 const run = createCodexClient({ mode: 'fork', threadId: source.id, images: [] }).turn({
  stdout: child.stdout, stdin: child.stdin, cwd: root, prompt: stop ? request : 'finish', signal: controller.signal,
  log: () => {}, gotModel: () => {}, gotResumeId: id => sessions.push(id),
  event: event => { if (event.kind === 'log' && event.data.text.includes('source conversation')) waiting = true },
 })
 try {
  await until(() => waiting)
  assert.deepEqual(sessions, [])
  assert.equal(read().slice(offset).filter(row => row.method === 'thread/fork' || row.method === 'turn/start').length, 0)
  await manager.close()
  await openManager()
  if (stop) controller.abort()
  else await owner.close()
  assert.equal((await run).ok, !stop)
  const calls = read().slice(offset)
  assert.equal(calls.filter(row => row.method === 'thread/fork').length, stop ? 0 : 1)
  assert.equal(calls.filter(row => row.method === 'turn/start').length, stop ? 0 : 1)
  assert.equal(sessions.length, stop ? 0 : 1)
  if (!stop) assert.notEqual(sessions[0], source.id)
 } finally { controller.abort(); child.stdin.end(); await owner.close() }
})

const strThread = (value: Record<string, unknown>) => (value.thread as { id: string }).id

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
 await openManager()
 assert.equal(backends()[0]!.instance,original.instance)
 assert.ok(await a.rpc.call('thread/read',{threadId:id}));assert.equal(a.notifications.some(n=>n.method==='turn/completed'),false)
 const b=await peer();await b.rpc.call('thread/start',{});assert.equal(backends().length,1)
 await a.close();await b.close()
})
it('retains execution subscriptions and adopts services without a shared daemon (#750, #766)',async()=>{
 const a=await peer();const id=((await a.rpc.call('thread/start',{})).thread as any).id
 await a.rpc.call('turn/start',{threadId:id,input:[{text:'retain'}]})
 await a.rpc.call('wildcrane/settled',{threadId:id,...a.hello.wildcrane as object,execution:'kept',confirmed:true,kept:[{threadId:id,itemId:'service',processId:'42'}]})
 await a.close();await manager.close();await openManager()
 const different=await peer(['-c','model="changed"']);await assert.rejects(different.rpc.call('thread/resume',{threadId:id}),/cannot change execution settings/);await different.close()
 const b=await peer();const resumed=await b.rpc.call('thread/resume',{threadId:id});assert.deepEqual(resumed.retainedThreads,[{id}]);assert.deepEqual(resumed.retainedTerminals,[{threadId:id,itemId:'service',processId:'42'}])
 assert.equal(((await b.rpc.call('thread/backgroundTerminals/list',{threadId:id})).data as any[]).length,1)
 await b.rpc.call('turn/start',{threadId:id,input:[{text:'leave-terminal'}]})
 const settle = { ...b.hello.wildcrane as object, threadId: id, execution: 'unconfirmed', confirmed: false }
 await assert.rejects(b.rpc.call('wildcrane/settled', { ...settle, kept: [{ threadId: id, itemId: 'temporary', processId: '43' }] }), /previously retained/)
 const offset = read().length
 const kept = await b.rpc.call('wildcrane/settled', { ...settle, kept: resumed.retainedTerminals })
 assert.equal(kept.confirmed, false)
 await b.close()
 assert.equal(read().slice(offset).some(c => c.method === 'thread/backgroundTerminals/clean' && c.params.threadId === id), false)
 const c = await peer()
 await assert.rejects(c.rpc.call('thread/resume', { threadId: id }), /services changed/)
 const observer = await nativeConnection(backends()[0]!, () => {})
 try {
  await initializeNative(observer)
  assert.equal((await observer.rpc.call('thread/backgroundTerminals/terminate', { threadId: id, processId: '43' })).terminated, true)
 } finally { observer.close() }
 assert.deepEqual((await c.rpc.call('thread/resume', { threadId: id })).retainedTerminals, resumed.retainedTerminals)
 await c.rpc.call('turn/start',{threadId:id,input:[{text:'finish-service'}]});await c.close()
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
 await until(() => !fs.existsSync(leaseFile(backends()[0]!, id)), 5000)
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
 const c = await peer()
 const gate = path.join(root, 'release-preparation')
 const slow = b.rpc.call('thread/fork', { threadId: id, pausePreparation: gate })
 try {
  await until(() => read().some(row => row.method === 'thread/fork' && row.params.pausePreparation === gate), 2000)
  await b.rpc.call('thread/fork', { threadId: id })
  await assert.rejects(c.rpc.call('thread/resume', { threadId: id }), /already in use/)
 } finally { fs.writeFileSync(gate, '') }
 await slow
 fs.rmSync(gate)
 assert.ok(await c.rpc.call('thread/resume', { threadId: id }))
 await b.close(); await c.close()
})

it('assigns a fork to its requester when the source owner sees the notification first (#1015)', async () => {
 const owner = await peer(), requester = await peer(), other = await peer()
 const source = strThread(await owner.rpc.call('thread/start', {}))
 await owner.rpc.call('turn/start', { threadId: source, input: [{ text: 'retain' }] })
 await owner.rpc.call('wildcrane/settled', {
  ...owner.hello.wildcrane as object, threadId: source, execution: 'kept', confirmed: true,
  kept: [{ threadId: source, itemId: 'service', processId: '42' }],
 })

 const offset = read().length
 const gate = path.join(root, 'release-fork-response')
 const response = requester.rpc.call('thread/fork', { threadId: source, pauseForkResponse: gate })
 try {
  await until(() => owner.notifications.some(n => n.method === 'thread/name/updated' && n.params.threadId === source))
 } finally { fs.writeFileSync(gate, '') }
 const fork = strThread(await response)
 assert.equal(owner.notifications.some(n => n.method === 'thread/started' && n.params.thread.id === fork), false)
 await assert.rejects(other.rpc.call('thread/resume', { threadId: fork }), /already in use/)

 const { turn } = await requester.rpc.call('turn/start', { threadId: fork, input: [{ text: 'spawn-child' }] })
 await assert.rejects(other.rpc.call('turn/interrupt', { threadId: fork, turnId: (turn as { id: string }).id }), /does not own/)
 const child = requester.notifications.find(n => n.method === 'thread/started' && n.params.thread.parentThreadId === fork)?.params.thread.id
 assert.ok(child)
 await requester.rpc.call('turn/start', { threadId: child })
 await requester.close()

 const trace = read().slice(offset)
 assert.equal(trace.filter(call => call.method === 'turn/start' && call.params.threadId === fork).length, 1)
 assert.equal(trace.filter(call => call.method === 'turn/interrupt' && call.params.threadId === fork).length, 1)
 assert.ok(trace.some(call => call.method === 'turn/interrupt' && call.params.threadId === child))
 assert.ok(trace.some(call => call.method === 'thread/unsubscribe' && call.params.threadId === child))
 assert.ok(!trace.some(call => call.params?.threadId === source && ['turn/interrupt', 'thread/unsubscribe'].includes(call.method)))

 await owner.close()
 await other.rpc.call('thread/resume', { threadId: source })
 await other.rpc.call('turn/start', { threadId: source, input: [{ text: 'finish-service' }] })
 await other.close()
})

it('routes pending approvals through Runner takeover and stops only the owning execution (#766)', async () => {
 const offset = read().length
 const a = await peer(), b = await peer()
 const aid = ((await a.rpc.call('thread/start', {})).thread as any).id
 const bid = ((await b.rpc.call('thread/start', {})).thread as any).id
 await a.rpc.call('turn/start', { threadId: aid, input: [{ text: 'approval' }] })
 await b.rpc.call('turn/start', { threadId: bid })
 await until(() => a.notifications.some(n => n.method?.endsWith('requestApproval')), 2000)
 await manager.close(); await openManager()
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

for (const fault of ['missing', 'missing-reworded']) it(`cleans an already unloaded source with ${fault} RPC diagnostics (#932)`, async () => {
 const offset = read().length
 const a = await peer(), b = await peer()
 const missing = strThread(await a.rpc.call('thread/start', { testCleanup: fault, testLoadedList: 'paged' }))
 const sibling = ((await a.rpc.call('thread/start', {})).thread as any).id
 const parallel = ((await b.rpc.call('thread/start', {})).thread as any).id
 await b.rpc.call('turn/start', { threadId: parallel })
 const backend = backends()[0]!
 await a.close()
 assert.equal(fs.existsSync(leaseFile(backend, missing)), false)
 assert.equal(fs.existsSync(leaseFile(backend, sibling)), false)
 assert.equal(a.notifications.some(n => n.method === 'wildcrane/cleanup'), false)
 assert.equal(b.notifications.some(n => n.method === 'turn/completed'), false)
 const pages = read().slice(offset).filter(call => call.method === 'thread/loaded/list')
 assert.deepEqual(pages.map(call => call.params.cursor), [undefined, 'page-two'])
 await b.close()
})

for (const fault of ['paged', 'invalid', 'timeout']) it(`keeps ownership without valid absence on every loaded page (${fault}, #932)`, async () => {
 const a = await peer()
 const id = strThread(await a.rpc.call('thread/start', {
  testCleanup: 'refuse-release', testReadFailure: 'Unexpected conversation lookup result', testLoadedList: fault,
 }))
 const backend = backends()[0]!
 const observer = await nativeConnection(backend, () => {})
 try {
  await initializeNative(observer)
  await assert.rejects(releaseNativeThread(observer, id, undefined, false, Date.now() + 300), error => {
   assert.ok(error instanceof RpcError)
   assert.equal(error.code, -32600)
   assert.match(error.message, /Unexpected release response.*Unexpected conversation lookup result/)
   assert.match(error.message, { paged: /still loaded/, invalid: /invalid page/, timeout: /thread\/loaded\/list timed out/ }[fault]!)
   return true
  })
  assert.ok(fs.existsSync(leaseFile(backend, id)))
 } finally { observer.close() }
 await manager.close()
 if (fault !== 'timeout') {
  await a.close()
  assert.equal(a.notifications.find(n => n.method === 'wildcrane/cleanup')?.params.status, 'unconfirmed')
  assert.ok(fs.existsSync(leaseFile(backend, id)))
 } else {
  const ended = once(a.child, 'close'); a.child.kill('SIGKILL'); await ended
 }
})

it('preserves an abandoned root while a recorded child is still active (#932)', async () => {
 const a = await peer(), successor = await peer()
 const rootId = strThread(await a.rpc.call('thread/start', {}))
 const childId = strThread(await a.rpc.call('thread/fork', { threadId: rootId }))
 const { turn } = await a.rpc.call('turn/start', { threadId: childId })
 const backend = backends()[0]!, rootLease = leaseFile(backend, rootId)
 const observer = await nativeConnection(backend, () => {})
 try {
  await initializeNative(observer)
  await observer.rpc.call('thread/resume', { threadId: rootId })
  await manager.close()
  const ended = once(a.child, 'close'); a.child.kill('SIGKILL'); await ended
  fs.rmSync(leaseFile(backend, childId))
  writePrivate(rootLease, { ...readPrivate<object>(rootLease), retained: { root: rootId, execution: 'legacy-empty', kept: [] } })
  const offset = read().length
  await reconcileCodexLeases(backend)
  assert.ok(fs.existsSync(rootLease))
  await assert.rejects(successor.rpc.call('thread/resume', { threadId: rootId }), /work still running/)
  assert.equal(read().slice(offset).filter(row => row.method === 'thread/resume' || row.method === 'turn/start').length, 0)
  await observer.rpc.call('turn/interrupt', { threadId: childId, turnId: (turn as { id: string }).id })
  await reconcileCodexLeases(backend)
  assert.equal(fs.existsSync(rootLease), false)
  assert.equal(strThread(await successor.rpc.call('thread/resume', { threadId: rootId })), rootId)
 } finally { observer.close() }
 await successor.close()
})

for (const evidence of ['status', 'list']) it(`confirms release with ${evidence} when there is no close event (#932)`, async () => {
 const a = await peer()
 const id = strThread(await a.rpc.call('thread/start', { testUnloadEvidence: evidence }))
 const backend = backends()[0]!
 await a.close()
 assert.equal(a.notifications.some(n => n.method === 'wildcrane/cleanup'), false)
 assert.equal(fs.existsSync(leaseFile(backend, id)), false)
})

it('automatically reclaims failed cleanup without blocking another thread or replaying work (#773)', async () => {
 const a = await peer()
 const failed = ((await a.rpc.call('thread/start', { testCleanup: 'fail' })).thread as any).id
 const sibling = ((await a.rpc.call('thread/start', {})).thread as any).id
 const backend = backends()[0]!
 await a.rpc.call('turn/start', { threadId: failed, input: [{ text: 'finish' }] })
 await a.close()
 assert.equal(fs.existsSync(leaseFile(backend, sibling)), false)
 await until(() => !fs.existsSync(leaseFile(backend, failed)), 5000)
 const b = await peer()
 assert.equal(((await b.rpc.call('thread/resume', { threadId: failed })).thread as any).id, failed)
 assert.equal(read().filter(row => row.pid === backend.pid && row.method === 'turn/start' && row.params.threadId === failed).length, 1)
 await b.close()
})

it('preserves abandoned background work until it finishes and then automatically releases ownership (#773)', async () => {
 const offset = read().length
 const a = await peer([], { KANBAN_RUN: 'original-run', AI4KANBAN_TASK: 'original-task' })
 const id = ((await a.rpc.call('thread/start', {})).thread as any).id
 await a.rpc.call('turn/start', { threadId: id, input: [{ text: 'retain' }] })
 const backend = backends()[0]!, file = leaseFile(backend, id)
 const ended = once(a.child, 'close'); a.child.kill('SIGKILL'); await ended
 await until(() => read().slice(offset).some(row => row.method === 'thread/backgroundTerminals/list' && row.params.threadId === id), 5000)
 assert.equal(fs.existsSync(file), true)
 const b = await peer([], { KANBAN_RUN: 'new-run' })
 await assert.rejects(b.rpc.call('thread/resume', { threadId: id }), error => {
  assert.match(String(error), /work still running/)
  assert.match(String(error), /original-run/); assert.match(String(error), /original-task/)
  return true
 })
 assert.equal(read().slice(offset).some(row => row.method === 'turn/interrupt' || row.method === 'thread/backgroundTerminals/clean'), false)
 const observer = await nativeConnection(backend, () => {})
 try {
  await initializeNative(observer)
  await observer.rpc.call('thread/backgroundTerminals/clean', { threadId: id })
 } finally { observer.close() }
 await until(() => !fs.existsSync(file), 5000)
 assert.ok(await b.rpc.call('thread/resume', { threadId: id }))
 assert.equal(read().slice(offset).filter(row => row.method === 'turn/start' && row.params.threadId === id).length, 1)
 await b.close()
})

for (const fault of ['unverified', 'malformed']) it(`retains ownership when native verification is ${fault} and recovers automatically (#773)`, async () => {
 const a = await peer([], { KANBAN_RUN: '' })
 const id = ((await a.rpc.call('thread/start', { testCleanup: fault })).thread as any).id
 const backend = backends()[0]!, file = leaseFile(backend, id)
 const observer = await nativeConnection(backend, () => {})
 await initializeNative(observer); await observer.rpc.call('thread/resume', { threadId: id })
 const ended = once(a.child, 'close'); a.child.kill('SIGKILL'); await ended
 try {
  await reconcileCodexLeases(backend)
  assert.equal(fs.existsSync(file), true)
  const b = await peer([], { KANBAN_RUN: 'requester' })
  await assert.rejects(b.rpc.call('thread/resume', { threadId: id }), /"run":"unknown".*"status":"unverified"/)
  await b.close()
 } finally { observer.close() }
 await until(() => !fs.existsSync(file), 5000)
})

it('does not delete a new owner when reconciliation and resumption overlap (#773)', async () => {
 const a = await peer()
 const id = ((await a.rpc.call('thread/start', { testReadDelay: 250 })).thread as any).id
 const backend = backends()[0]!, file = leaseFile(backend, id)
 const observer = await nativeConnection(backend, () => {})
 await initializeNative(observer); await observer.rpc.call('thread/resume', { threadId: id })
 const b = await peer([], { KANBAN_RUN: 'next-owner' })
 await manager.close()
 const ended = once(a.child, 'close'); a.child.kill('SIGKILL'); await ended
 try {
  const reaping = reconcileCodexLeases(backend)
  await until(() => fs.existsSync(file + '.lock'), 3000)
  const resumed = b.rpc.call('thread/resume', { threadId: id })
  await reaping
  await resumed
  await Promise.all([reconcileCodexLeases(backend), reconcileCodexLeases(backend)])
  assert.equal(readPrivate<any>(file).run, 'next-owner')
  assert.equal(readPrivate<any>(file).pid, b.child.pid)
 } finally { observer.close() }
 await b.close()
})

it('confirms cleanup via probe connection or exited backend when native connection drops (#1018)', async () => {
 const a = await peer()
 const threadId = strThread(await a.rpc.call('thread/start', {}))
 const backend = backends()[0]!, file = leaseFile(backend, threadId)
 const offset = read().length
 await a.rpc.call('turn/start', { threadId, input: [{ text: 'drop-connection' }] })
 await until(() => !fs.existsSync(file) &&
  a.notifications.some(n => n.method === 'wildcrane/cleanup' && n.params.status === 'confirmed'), 5000)
 assert.equal(a.notifications.some(n => n.method === 'wildcrane/cleanup' && n.params.status === 'unconfirmed'), false)
 assert.equal(read().slice(offset).some(row => row.method === 'turn/interrupt' && row.params.threadId === threadId), true)
 await a.close()

 // End-to-end via createCodexClient: mid-turn drop with running command still confirms cleanup so auto-retry can proceed.
 const client = createCodexClient()
 const proxy = spawn(process.execPath, [path.join(process.env.RUNNER_DIST!, 'codex-proxy.mjs'), fake, 'app-server'], {
  env: { ...process.env, ...manager.env, WILDCRANE_HOME: root, AI4KANBAN_HOME: root, FAKE_CODEX_CALLS: calls },
 })
 try {
  const end = await client.turn({
   stdout: proxy.stdout,
   stdin: proxy.stdin,
   prompt: 'drop-connection',
   cwd: root,
   log: () => {},
   gotResumeId: () => {},
   gotModel: () => {},
  })
  assert.equal(end.ok, false)
  assert.equal(end.cleanup?.status, 'confirmed')
 } finally {
  proxy.kill('SIGKILL')
 }

 // Backend process exit during turn also confirms cleanup without unconfirmed status.
 const c = await peer()
 const exitedThread = strThread(await c.rpc.call('thread/start', {}))
 const exitedLease = leaseFile(backend, exitedThread)
 await c.rpc.call('turn/start', { threadId: exitedThread, input: [{ text: 'crash' }] }).catch(() => {})
 await until(() => !fs.existsSync(exitedLease) &&
  c.notifications.some(n => n.method === 'wildcrane/cleanup' && n.params.status === 'confirmed'), 5000)
 assert.equal(c.notifications.some(n => n.method === 'wildcrane/cleanup' && n.params.status === 'unconfirmed'), false)
 await c.close()
})

it('preserves underlying error details when native connection fails (#1018)', async () => {
 await assert.rejects(
  nativeConnection({ pid: process.pid, instance: 'missing', generation: 'g', endpoint: `unix://${path.join(root, 'missing.sock')}`, key: 'k' }, () => {}),
  error => {
   assert.match(String(error), /Codex native listener did not answer \(.+\)/)
   return true
  },
 )
 const a = await peer()
 const backend = backends()[0]!
 const conn = await nativeConnection(backend, () => {})
 const closed = once(conn.incoming, 'close')
 // Trigger an abnormal socket close from the server side.
 const id = strThread(await a.rpc.call('thread/start', {}))
 await conn.rpc.call('initialize', { clientInfo: { name: 'test', version: '1' }, capabilities: { experimentalApi: true } })
 conn.rpc.notify('initialized')
 await conn.rpc.call('thread/resume', { threadId: id })
 await conn.rpc.call('turn/start', { threadId: id, input: [{ text: 'drop-connection' }] }).catch(() => {})
 await assert.rejects(closed, /Codex native connection (failed|closed)/)
 conn.close()
 await a.close()
})
