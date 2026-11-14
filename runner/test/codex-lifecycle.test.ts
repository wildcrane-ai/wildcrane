import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { after, afterEach, before, beforeEach, it } from 'node:test'
import { codexServer } from '../src/codex-server'
import { connect } from '../../cli/src/lib/agent/wire/rpc'
import { FakeCloud, until, writeFakeSession } from './fake-cloud'

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-owner-'))
const entry = path.join(fixture, 'host.mjs')
const originalHome = process.env.WILDCRANE_HOME
const originalAgentHome = process.env.AI4KANBAN_HOME
let root: string
let cloud: FakeCloud
let host: ChildProcess | undefined
const peers = new Set<ChildProcess>()
const record = () => JSON.parse(fs.readFileSync(path.join(root, 'codex-service.json'), 'utf8'))
const calls = () => fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))

before(async () => {
  const esbuild = createRequire(import.meta.url)(path.join(process.env.RUNNER_DIST!, '../node_modules/esbuild'))
  await esbuild.build({ entryPoints: [path.join(process.env.RUNNER_DIST!, '../test/fixtures/flow-host.ts')], outfile: entry,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', loader: { '.md': 'text', '.json': 'text' },
    banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" },
    define: { __RUNNER_VERSION__: '"test"', __AKB_VERSION__: '"test"', __AKB_CONTRACT__: '1' } })
})
after(() => fs.rmSync(fixture, { recursive: true, force: true }))
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-life-'))
  process.env.WILDCRANE_HOME = root
  process.env.AI4KANBAN_HOME = root
  writeFakeSession(root)
  process.env.FAKE_AKB_LOG = path.join(root, 'akb.jsonl')
  process.env.FAKE_AKB_ENTRY = path.join(process.env.RUNNER_DIST!, '../test/fake-akb.mjs')
  cloud = new FakeCloud()
  await cloud.start()
  fs.writeFileSync(path.join(root, 'codex.cjs'), `
const fs=require('node:fs'),readline=require('node:readline');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
let turn=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),p=m.params||{};
 fs.appendFileSync(${JSON.stringify(path.join(root, 'calls.jsonl'))},JSON.stringify({pid:process.pid,method:m.method,thread:p.threadId})+'\\n');
 let result={};
 if(m.method==='config/read') result={config:{}};
 if(m.method==='thread/start') result={thread:{id:'thread-'+m.id}};
 if(m.method==='thread/resume') result={thread:{id:p.threadId}};
 if(m.method==='turn/start'){
  if(p.input?.[0]?.text==='crash') return process.exit(1);
  result={turn:{id:'turn-'+(++turn)}};
  send({method:'turn/started',params:{threadId:p.threadId,turn:result.turn}});
 }
 if(m.method==='thread/read') send({method:'turn/completed',params:{threadId:p.threadId,turn:{id:'turn-'+turn,status:'completed',items:[{id:'final',type:'agentMessage',text:'Finished once.'}]}}});
 if(m.method==='turn/interrupt') send({method:'turn/completed',params:{threadId:p.threadId,turn:{id:p.turnId,status:'interrupted'}}});
 if(m.method==='thread/unsubscribe') result={status:'notSubscribed'};
 if(m.id!==undefined) send({id:m.id,result});
});
process.stdin.on('end',()=>process.exit());
`)
})
afterEach(async () => {
  for (const child of peers) {
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'close'); child.kill('SIGTERM'); await ended }
  }
  peers.clear()
  if (host && host.exitCode === null && host.signalCode === null) { const ended = once(host, 'close'); host.kill('SIGTERM'); await ended }
  host = undefined
  if (fs.existsSync(path.join(root, 'codex-service.json'))) {
    const owner = await codexServer().catch(() => null)
    await owner?.shutdown()
    await owner?.close()
    await until(() => !fs.existsSync(path.join(root, 'codex-service.json')), 5000)
  }
  await cloud.stop()
  process.env.WILDCRANE_HOME = originalHome
  process.env.AI4KANBAN_HOME = originalAgentHome
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

async function launch() {
  const registrations = cloud.registrations
  host = spawn(process.execPath, [entry], { env: { ...process.env, WILDCRANE_CODEX_IDLE_MS: '10000' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let error = ''
  host.stderr!.on('data', chunk => { error += chunk })
  await until(() => fs.existsSync(path.join(root, 'codex-service.json')) || host!.exitCode !== null, 10000)
  assert.equal(host.exitCode, null, error)
  await until(() => cloud.registrations > registrations, 10000)
}
async function task() {
  const executable = path.join(root, 'codex')
  fs.writeFileSync(executable, '#!/usr/bin/env node\n' + fs.readFileSync(path.join(root, 'codex.cjs'), 'utf8'), { mode: 0o700 })
  const child = spawn(process.execPath, [path.join(process.env.RUNNER_DIST!, 'codex-proxy.mjs'), executable, 'app-server'], {
    env: { ...process.env, WILDCRANE_CODEX_SERVER: path.join(root, 'codex-service.json') }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  peers.add(child)
  const notifications: any[] = []
  const rpc = connect(child.stdout, child.stdin!, message => notifications.push(message))
  await rpc.call('initialize', {})
  const { thread } = await rpc.call('thread/start', {})
  const id = (thread as any).id
  await rpc.call('turn/start', { threadId: id })
  return { child, rpc, id, notifications }
}

for (const signal of ['SIGTERM', 'SIGKILL', 'update'] as const) {
  it(`keeps the original Codex and task connection across Runner ${signal} and adoption (#724)`, { timeout: 20000 }, async () => {
    await launch()
    const a = await task()
    const identity = record()
    const backend = calls()[0].pid
    const ended = once(host!, 'close')
    if (signal === 'update') host!.send('update')
    else host!.kill(signal)
    await ended
    host = undefined
    process.kill(identity.pid, 0)
    process.kill(backend, 0)
    assert.equal(a.notifications.some(m => m.method === 'turn/completed'), false)
    await launch()
    assert.deepEqual(record(), identity)
    await a.rpc.call('thread/read', { threadId: a.id })
    await until(() => a.notifications.some(m => m.method === 'turn/completed'))
    assert.equal(a.notifications.find(m => m.method === 'turn/completed').params.turn.status, 'completed')
    assert.equal(new Set(calls().map(m => m.pid)).size, 1)
    assert.equal(calls().filter(m => m.method === 'turn/start').length, 1)
    assert.equal(calls().filter(m => m.method === 'turn/interrupt').length, 0)
  })
}

it('reuses one service under concurrent attachment and reclaims it when unused (#724)', async () => {
  const owners = await Promise.all([codexServer(), codexServer(), codexServer()])
  const identity = record()
  for (const owner of owners) await owner.close()
  await until(() => !fs.existsSync(path.join(root, 'codex-service.json')), 5000)
  await until(() => { try { process.kill(identity.pid, 0); return false } catch { return true } }, 5000)
})

it('stops the independent service on account exit without reusing its identity (#724)', async () => {
  const owner = await codexServer()
  const a = await task()
  const closed = once(a.child, 'close')
  fs.writeFileSync(path.join(root, 'account-generation'), 'signed-out')
  await closed
  await owner.close()
  await until(() => !fs.existsSync(path.join(root, 'codex-service.json')), 5000)
  assert.equal(a.notifications.find(m => m.method === 'turn/completed')?.params.turn.status, 'interrupted')
})

it('replaces a dead service after confirming its backend stopped and resumes the saved thread (#724)', async () => {
  const owner = await codexServer()
  const a = await task()
  const identity = record()
  const closed = once(a.child, 'close')
  process.kill(identity.pid, 'SIGKILL')
  await closed
  await until(() => { try { return record().instance !== identity.instance } catch { return false } }, 10000)
  const replacement = await codexServer()
  await owner.close()
  try {
    assert.notEqual(record().instance, identity.instance)
    for (const backend of identity.backends) assert.throws(() => process.kill(backend.pid, 0), { code: 'ESRCH' })
    const executable = path.join(root, 'codex')
    const child = spawn(process.execPath, [path.join(process.env.RUNNER_DIST!, 'codex-proxy.mjs'), executable, 'app-server'], {
      env: { ...process.env, ...replacement.env }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    peers.add(child)
    const rpc = connect(child.stdout, child.stdin, () => {})
    await rpc.call('initialize', {})
    const resumed = await rpc.call('thread/resume', { threadId: a.id })
    assert.equal((resumed.thread as any).id, a.id)
    await rpc.call('turn/start', { threadId: a.id })
    await rpc.call('thread/read', { threadId: a.id })
    assert.equal(calls().filter(m => m.method === 'thread/start').length, 1)
    assert.equal(calls().filter(m => m.method === 'thread/resume').length, 1)
  } finally { await replacement.close() }
})

it('preserves a live service on incompatible metadata and refuses to overwrite it (#724)', async () => {
  const owner = await codexServer()
  const original = record()
  try {
    fs.writeFileSync(path.join(root, 'codex-service.json'), JSON.stringify({ ...original, protocol: 99 }))
    await assert.rejects(codexServer(), /protocol is incompatible/)
    process.kill(original.pid, 0)
    assert.equal(record().instance, original.instance)
  } finally {
    fs.writeFileSync(path.join(root, 'codex-service.json'), JSON.stringify(original))
    await owner.close()
  }
})

it('lets a task rebuild a confirmed dead service while Runner is offline (#724)', async () => {
  const owner = await codexServer()
  const a = await task()
  await owner.close()
  const identity = record()
  const closed = once(a.child, 'close')
  process.kill(identity.pid, 'SIGKILL')
  await closed
  const child = spawn(process.execPath, [path.join(process.env.RUNNER_DIST!, 'codex-proxy.mjs'), path.join(root, 'codex'), 'app-server'], {
    env: { ...process.env, ...owner.env }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  peers.add(child)
  const rpc = connect(child.stdout, child.stdin, () => {})
  await rpc.call('initialize', {})
  assert.notEqual(record().instance, identity.instance)
  await rpc.call('thread/resume', { threadId: a.id })
  await rpc.call('turn/start', { threadId: a.id })
  await rpc.call('thread/read', { threadId: a.id })
  assert.equal(calls().filter(m => m.method === 'thread/start').length, 1)
})
