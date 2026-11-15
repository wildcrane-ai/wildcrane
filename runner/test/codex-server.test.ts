import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, it } from 'node:test'
import { performance } from 'node:perf_hooks'
import { once } from 'node:events'
import { serveCodex as codexServer, threadConfig } from '../src/codex-service'
import { connect } from '../../cli/src/lib/agent/wire/rpc'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-singleton-'))
const fake = path.join(root, 'codex')
const calls = path.join(root, 'calls.jsonl')
const previousHome = process.env.WILDCRANE_HOME
process.env.WILDCRANE_HOME = root
after(() => { process.env.WILDCRANE_HOME = previousHome; fs.rmSync(root, { recursive: true, force: true }) })
fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs'; import readline from 'node:readline';
const file = ${JSON.stringify(calls)};
fs.appendFileSync(file, JSON.stringify({pid:process.pid, method:'spawn', env:process.env.KANBAN_STOP_ID, argv:process.argv.slice(2)})+'\\n');
let turn=0; const loaded=new Map(), terminals=new Map(), hanging=new Set();
const send = msg => process.stdout.write(JSON.stringify(msg)+'\\n');
const notify = (method, params) => send({method,params});
readline.createInterface({input:process.stdin}).on('line', async line => {
 const m=JSON.parse(line), p=m.params||{};
 fs.appendFileSync(file,JSON.stringify({pid:process.pid,...m})+'\\n');
 let result={};
 if(m.method==='config/read') result={config:{mcp_servers:{defaultProbe:{command:'node',env:{STATIC:'kept'}}}}};
 if(m.method==='initialize') await new Promise(r=>setTimeout(r,150));
 if(m.method==='thread/start') { result={thread:{id:'thread-'+m.id,modelProvider:'openai'},model:p.config.model}; loaded.set(result.thread.id,result.model); }
 if(m.method==='thread/resume') { result={thread:{id:p.threadId,modelProvider:'openai'},model:loaded.has(p.threadId)?loaded.get(p.threadId):p.config.model}; loaded.set(p.threadId,result.model); }
 if(m.method==='thread/resume' && p.threadId==='missing') { loaded.delete(p.threadId); send({id:m.id,error:{code:-32600,message:'no rollout found for thread id missing'}}); return; }
 if(m.method==='thread/fork') { result={thread:{id:'fork-'+m.id,modelProvider:'openai',forkedFromId:p.threadId}}; loaded.set(result.thread.id,p.config.model); notify('thread/started',result); }
 if(m.method.startsWith('thread/backgroundTerminals/') && !loaded.has(p.threadId)) { send({id:m.id,error:{code:-32600,message:'thread not found: '+p.threadId}}); return; }
 if(m.method==='turn/start') {
  if(p.input?.[0]?.text==='crash') { process.exit(1); return; }
  result={turn:{id:'turn-'+(++turn)}};
  notify('turn/started',{threadId:p.threadId,turn:result.turn});
  const text=p.input?.[0]?.text;
  if(text==='retain') terminals.set(p.threadId,[{itemId:'service',processId:'42',command:'service'}]);
  if(text==='hang-release') hanging.add(p.threadId);
  if(['retain','finish','hang-release'].includes(text)) notify('turn/completed',{threadId:p.threadId,turn:{id:result.turn.id,status:'completed'}});
 }
 if(m.method==='turn/interrupt') notify('turn/completed',{threadId:p.threadId,turn:{id:p.turnId,status:'interrupted'}});
 if(m.method==='thread/unsubscribe' && hanging.has(p.threadId)) return;
 if(m.method==='thread/backgroundTerminals/clean') terminals.delete(p.threadId);
 if(m.method==='thread/unsubscribe') { result={status:'unsubscribed'}; setTimeout(()=>{ loaded.delete(p.threadId); notify('thread/closed',{threadId:p.threadId}); },30); }
 if(m.method==='thread/backgroundTerminals/list') result={data:terminals.get(p.threadId)||[]};
 if(m.id!==undefined) send({id:m.id,result});
});
process.stdin.on('end',()=>process.exit());
`, { mode: 0o700 })

const read = () => fs.readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l))
const children = new Set<ChildProcessWithoutNullStreams>()
after(() => { for (const child of children) child.kill('SIGKILL') })
function peer(env: NodeJS.ProcessEnv, overrides: string[] = [], extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [path.join(process.env.RUNNER_DIST!, 'codex-proxy.mjs'), fake, 'app-server', ...overrides], {
    cwd: root, env: { ...process.env, ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  let err = ''
  child.stderr.on('data', chunk => { err += chunk })
  const notifications: any[] = []
  const rpc = connect(child.stdout, child.stdin, m => notifications.push(m))
  return { child, rpc, notifications, async close() {
    if (child.exitCode !== null) return
    const exited = once(child, 'close')
    child.kill('SIGTERM')
    await exited
    children.delete(child)
    assert.equal(child.exitCode, 0, err)
  } }
}

it('shares one server across concurrent runs, isolates settings and stops only the owner (#707)', { timeout: 15_000 }, async (t) => {
  const server = await codexServer()
  try {
    const a = peer(server.env, ['-c', 'model="alpha"', '-c', 'mcp_servers.probe.command="node"'], { KANBAN_STOP_ID: 'owner-a', KANBAN_GOALS: '/a/goals' })
    const b = peer(server.env, ['-c', 'model="beta"', '-c', 'mcp_servers.probe.command="node"'], { KANBAN_STOP_ID: 'owner-b', KANBAN_GOALS: '/b/goals' })
    const firstAt = performance.now()
    await Promise.all([a.rpc.call('initialize', {}), b.rpc.call('initialize', {})])
    const firstMs = performance.now() - firstAt
    const [ta, tb] = await Promise.all([a.rpc.call('thread/start', { cwd: '/a' }), b.rpc.call('thread/start', { cwd: '/b' })])
    const aid = (ta.thread as any).id, bid = (tb.thread as any).id
    await Promise.all([a.rpc.call('turn/start', { threadId: aid }), b.rpc.call('turn/start', { threadId: bid })])
    await assert.rejects(a.rpc.call('thread/read', { threadId: bid }), /does not own/)
    const duplicate = peer(server.env)
    await duplicate.rpc.call('initialize', {})
    await assert.rejects(duplicate.rpc.call('thread/resume', { threadId: aid }), /already in use/)
    await assert.rejects(duplicate.rpc.call('thread/fork', { threadId: aid }), /already in use/)
    await duplicate.close()
    await a.close()
    assert.equal(b.notifications.some(m => m.method === 'turn/completed'), false)
    assert.ok(await b.rpc.call('thread/read', { threadId: bid }))
    const c = peer(server.env, ['-c', 'model="gamma"'])
    const reuseAt = performance.now()
    await c.rpc.call('initialize', {})
    t.diagnostic(`Fake server preparation (includes proxy startup): first=${firstMs.toFixed(1)}ms reuse=${(performance.now() - reuseAt).toFixed(1)}ms; one spawn and initialize.`)
    const resumed = await c.rpc.call('thread/resume', { threadId: aid })
    assert.equal(resumed.model, 'gamma', 'unload the previous run before applying its replacement settings')
    await c.rpc.call('turn/start', { threadId: aid })
    await Promise.all([b.close(), c.close()])
    const rows = read()
    assert.equal(rows.filter(m => m.method === 'spawn').length, 1)
    assert.equal(rows.filter(m => m.method === 'initialize').length, 1)
    assert.ok(!['owner-a', 'owner-b'].includes(rows.find(m => m.method === 'spawn').env))
    const starts = rows.filter(m => m.method === 'thread/start')
    assert.deepEqual(starts.map(m => m.params.config.model).sort(), ['alpha', 'beta'])
    for (const s of starts) {
      const a = s.params.cwd === '/a'
      assert.equal(s.params.config['shell_environment_policy.set'].KANBAN_STOP_ID, a ? 'owner-a' : 'owner-b')
      assert.equal(s.params.config['shell_environment_policy.set'].KANBAN_GOALS, a ? '/a/goals' : '/b/goals')
      assert.equal(s.params.config['mcp_servers.probe.env'].KANBAN_GOALS, a ? '/a/goals' : '/b/goals')
      assert.equal(s.params.config['mcp_servers.defaultProbe.env'].KANBAN_GOALS, a ? '/a/goals' : '/b/goals')
      assert.equal(s.params.config['mcp_servers.defaultProbe.env'].STATIC, 'kept')
    }
    assert.equal(rows.filter(m => m.method === 'turn/interrupt' && m.params.threadId === aid).length, 2)
  } finally { await server.close() }
})

it('releases an unloaded fork source and lets the completed fork resume (#762)', { timeout: 15000 }, async () => {
  const server = await codexServer()
  try {
    const source = peer(server.env), parallel = peer(server.env)
    await Promise.all([source.rpc.call('initialize', {}), parallel.rpc.call('initialize', {})])
    const rootId = ((await source.rpc.call('thread/start', { cwd: '/project-a' })).thread as any).id
    await source.close()
    const otherId = ((await parallel.rpc.call('thread/start', { cwd: '/project-b' })).thread as any).id
    await parallel.rpc.call('turn/start', { threadId: otherId })
    const offset = read().length
    const fork = peer(server.env)
    const hello = await fork.rpc.call('initialize', {})
    const forkId = ((await fork.rpc.call('thread/fork', { threadId: rootId, cwd: '/project-a' })).thread as any).id
    await fork.rpc.call('turn/start', { threadId: forkId, input: [{ text: 'finish' }] })
    await fork.rpc.call('wildcrane/settled', { threadId: forkId, ...(hello.wildcrane as object), execution: 'fork', confirmed: true, kept: [] })
    await fork.close()
    const next = peer(server.env)
    await next.rpc.call('initialize', {})
    await next.rpc.call('thread/resume', { threadId: forkId })
    await next.rpc.call('turn/start', { threadId: forkId, input: [{ text: 'finish' }] })
    await next.close()
    assert.equal(read().slice(offset).some(m => m.params?.threadId === rootId &&
      ['thread/backgroundTerminals/list', 'thread/backgroundTerminals/clean', 'thread/unsubscribe'].includes(m.method)), false)
    assert.ok(await parallel.rpc.call('thread/read', { threadId: otherId }))
    assert.equal(parallel.notifications.some(m => m.method === 'turn/completed'), false)
    await parallel.close()
  } finally { await server.close() }
})

it('rolls back failed resume reservations without waiting for the caller to disconnect (#762)', { timeout: 15000 }, async () => {
  const server = await codexServer()
  const offset = read().length
  try {
    const a = peer(server.env), b = peer(server.env)
    await Promise.all([a.rpc.call('initialize', {}), b.rpc.call('initialize', {})])
    await assert.rejects(a.rpc.call('thread/resume', { threadId: 'missing' }), /no rollout found/)
    await assert.rejects(b.rpc.call('thread/resume', { threadId: 'missing' }), /no rollout found/)
    await Promise.all([a.close(), b.close()])
    const next = peer(server.env)
    await next.rpc.call('initialize', {})
    await assert.rejects(next.rpc.call('thread/resume', { threadId: 'missing' }), /no rollout found/)
    assert.ok(await next.rpc.call('thread/start', {}))
    await next.close()
    assert.equal(read().slice(offset).some(m => m.params?.threadId === 'missing' &&
      ['thread/backgroundTerminals/clean', 'thread/unsubscribe'].includes(m.method)), false)
  } finally { await server.close() }
})

it('runs providers concurrently and confines crashes and recovery to one provider (#707)', { timeout: 15_000 }, async () => {
  const server = await codexServer()
  const offset = read().length
  const alpha = ['-c', 'model_provider="alpha"']
  const beta = ['-c', 'model_provider="beta"']
  try {
    const a = peer(server.env, alpha), b = peer(server.env, beta)
    await Promise.all([a.rpc.call('initialize', {}), b.rpc.call('initialize', {})])
    const [ta, tb] = await Promise.all([a.rpc.call('thread/start', {}), b.rpc.call('thread/start', {})])
    const aid = (ta.thread as any).id, bid = (tb.thread as any).id
    await b.rpc.call('turn/start', { threadId: bid })
    await assert.rejects(a.rpc.call('turn/start', { threadId: aid, input: [{ text: 'crash' }] }), /closed/)
    assert.ok(await b.rpc.call('thread/read', { threadId: bid }))
    assert.equal(b.notifications.some(m => m.method === 'turn/completed'), false)
    const resumed = peer(server.env, alpha)
    await resumed.rpc.call('initialize', {})
    await resumed.rpc.call('thread/resume', { threadId: aid })
    await resumed.close()
    const rows = read().slice(offset)
    const starts = rows.filter(m => m.method === 'spawn')
    assert.equal(starts.length, 3)
    assert.equal(starts.filter(m => m.argv.includes('model_provider="beta"')).length, 1)
    assert.equal(rows.filter(m => m.method === 'turn/start' && m.params.input?.[0]?.text === 'crash').length, 1)
    await b.close()
  } finally { await server.close() }
})

it('restarts a crashed server only for a later request and resumes the saved thread (#707)', { timeout: 15_000 }, async () => {
  const offset = read().length
  const server = await codexServer()
  try {
    const a = peer(server.env)
    await a.rpc.call('initialize', {})
    const thread = await a.rpc.call('thread/start', {})
    const id = (thread.thread as any).id
    await assert.rejects(a.rpc.call('turn/start', { threadId: id, input: [{ text: 'crash' }] }), /closed/)
    const b = peer(server.env)
    await b.rpc.call('initialize', {})
    await b.rpc.call('thread/resume', { threadId: id })
    await b.close()
    const rows = read().slice(offset)
    assert.equal(rows.filter(m => m.method === 'turn/start' && m.params.input?.[0]?.text === 'crash').length, 1)
    assert.ok(new Set(rows.filter(m => m.method === 'spawn').map(m => m.pid)).size >= 2)
  } finally { await server.close() }
})

it('keeps provider selection and job environment in thread overrides (#707)', () => {
  const config = threadConfig(['codex', 'app-server', '-c', 'model_providers.test.env_key=TEST_KEY', '-c', "model_reasoning_effort='low'", '-c', 'shell_environment_policy.set={ DEMO = "yes" }'], { TEST_KEY: 'fake-credential', KANBAN_RUN: 'own-run' })
  assert.equal(config['model_providers.test.env_key'], 'TEST_KEY')
  assert.equal(config['model_providers.test.experimental_bearer_token'], undefined)
  assert.equal(config.model_reasoning_effort, 'low')
  assert.equal((config['shell_environment_policy.set'] as any).DEMO, 'yes')
  assert.equal((config['shell_environment_policy.set'] as any).KANBAN_RUN, 'own-run')
})

it('closes active connections and the server before the next owner starts (#707)', { timeout: 15_000 }, async () => {
  const server = await codexServer()
  const a = peer(server.env)
  const b = peer(server.env, ['-c', 'model_provider="other"'])
  await Promise.all([a.rpc.call('initialize', {}), b.rpc.call('initialize', {})])
  const { thread } = await a.rpc.call('thread/start', {})
  await a.rpc.call('turn/start', { threadId: (thread as any).id })
  const pids = read().filter(m => m.method === 'spawn').slice(-2).map(m => m.pid)
  const ended = Promise.all([once(a.child, 'close'), once(b.child, 'close')])
  await server.close()
  await ended
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  const next = await codexServer()
  try {
    const b = peer(next.env)
    await b.rpc.call('initialize', {})
    assert.ok(!pids.includes(read().filter(m => m.method === 'spawn').at(-1).pid))
    await b.close()
  } finally { await next.close() }
})

it('retains services without a task connection and transfers them only on an explicit resume', { timeout: 15000 }, async () => {
  const server = await codexServer()
  const offset = read().length
  try {
    const a = peer(server.env)
    const hello = await a.rpc.call('initialize', {})
    const { thread } = await a.rpc.call('thread/start', {})
    const threadId = (thread as any).id
    await a.rpc.call('turn/start', { threadId, input: [{ text: 'retain' }] })
    const proof = { threadId, ...(hello.wildcrane as object), execution: 'execution-a', confirmed: true, kept: [{ threadId, itemId: 'service', processId: '42' }] }
    await assert.rejects(a.rpc.call('wildcrane/settled', { ...proof, lease: 'old' }), /unconfirmed/)
    await a.rpc.call('wildcrane/settled', proof)
    await a.close()
    assert.equal(server.idle(), false)
    assert.equal(read().slice(offset).some(m => ['thread/unsubscribe', 'thread/backgroundTerminals/clean'].includes(m.method)), false)
    const incompatible = peer(server.env, ['-c', 'model=changed'])
    await incompatible.rpc.call('initialize', {})
    await assert.rejects(incompatible.rpc.call('thread/resume', { threadId }), /cannot change execution settings/)
    await incompatible.close()
    const b = peer(server.env)
    await b.rpc.call('initialize', {})
    const resumed = await b.rpc.call('thread/resume', { threadId })
    assert.deepEqual(resumed.retainedThreads, [{ id: threadId }])
    assert.equal(((await b.rpc.call('thread/backgroundTerminals/list', { threadId })).data as any[]).length, 1)
    const c = peer(server.env)
    await c.rpc.call('initialize', {})
    await assert.rejects(c.rpc.call('thread/resume', { threadId }), /already in use/)
    await c.close()
    await b.close()
    assert.equal(read().slice(offset).filter(m => m.method === 'spawn').length, 1)
  } finally { await server.close() }
})

it('quarantines a timed-out release without stopping parallel work or reassigning its thread', { timeout: 25000 }, async () => {
  const server = await codexServer()
  try {
    const a = peer(server.env), b = peer(server.env)
    await Promise.all([a.rpc.call('initialize', {}), b.rpc.call('initialize', {})])
    const { thread } = await a.rpc.call('thread/start', {})
    const threadId = (thread as any).id
    const other = (await b.rpc.call('thread/start', {})).thread as any
    await a.rpc.call('turn/start', { threadId, input: [{ text: 'hang-release' }] })
    await b.rpc.call('turn/start', { threadId: other.id })
    await a.close()
    assert.ok(await b.rpc.call('thread/read', { threadId: other.id }))
    assert.equal(b.notifications.some(n => n.method === 'turn/completed'), false)
    await assert.rejects(b.rpc.call('thread/resume', { threadId }), /already in use/)
    await b.close()
  } finally { await server.close() }
})
