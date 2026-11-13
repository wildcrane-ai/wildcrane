import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { after, afterEach, before, beforeEach, it } from 'node:test'
import { canKeepFlow, reclaimFlowWorkers, stopFlowWorker, watchFlowWorker } from '../src/flow-worker'
import { tryLock } from '../../cli/src/lib/lock'
import { defaultDeps } from '../src/jobs'
import { runnerHome } from '../src/home'
import { FakeCloud, until, writeFakeSession } from './fake-cloud'

const machine = '44444444-4444-4444-8444-444444444444'
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-host-'))
const entry = path.join(fixture, 'host.mjs')
let cloud: FakeCloud
let host: ChildProcess | undefined
let log = ''
const folder = () => path.join(runnerHome(), 'project')
const gate = (n: number) => path.join(runnerHome(), `gate-${n}`)
const calls = () => fs.existsSync(process.env.FAKE_AKB_LOG!)
  ? fs.readFileSync(process.env.FAKE_AKB_LOG!, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]) : []
const commands = (verb: string) => calls().filter((c) => c[0] === 'raw' && c[1] === 'card' && c[2] === verb)
const launch = () => {
  host = spawn(process.execPath, [entry], { env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  host.stderr!.on('data', (s) => { log += s })
  host.stdout!.on('data', (s) => { log += s })
  return host
}
const exit = async (signal: 'SIGKILL' | 'SIGTERM' | 'update') => {
  const child = host!
  const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  if (signal === 'update') child.send('update')
  else child.kill(signal)
  await ended
  host = undefined
}

before(async () => {
  const esbuild = createRequire(import.meta.url)(path.join(process.env.RUNNER_DIST!, '../node_modules/esbuild'))
  await esbuild.build({
    entryPoints: [path.join(process.env.RUNNER_DIST!, '../test/fixtures/flow-host.ts')], outfile: entry,
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    loader: { '.md': 'text', '.json': 'text' }, banner: { js: "import { createRequire as makeRequire } from 'node:module'; const require = makeRequire(import.meta.url);" },
    define: { __RUNNER_VERSION__: '"test"', __AKB_VERSION__: '"test"', __AKB_CONTRACT__: '1' },
  })
})
after(() => fs.rmSync(fixture, { recursive: true, force: true }))
beforeEach(async () => {
  fs.rmSync(runnerHome(), { recursive: true, force: true })
  writeFakeSession(runnerHome())
  fs.mkdirSync(folder(), { recursive: true })
  fs.writeFileSync(path.join(runnerHome(), 'projects.json'), JSON.stringify({ projects: [folder()] }))
  process.env.FAKE_AKB_LOG = path.join(runnerHome(), 'calls.jsonl')
  process.env.FAKE_AKB_ENTRY = path.join(process.env.RUNNER_DIST!, '../test/fake-akb.mjs')
  log = ''
  cloud = new FakeCloud()
  cloud.folders = [{ project: 'prj_1', name: 'Project', path: folder(), notify: false, machine }]
  cloud.task = { artifacts: new Map(), title: 'Test', request: 'Build it' }
  cloud.put({ 'config.md': '# Configuration\n', 'todo/2-test.md': '---\ntitle: Test\nstudio: coding\nquestions: []\n---\n\nBuild it.\n' })
  await cloud.start()
})
afterEach(async () => {
  await stopFlowWorker('job', 4000).catch(() => {})
  if (host && host.exitCode === null) await exit('SIGTERM')
  await cloud.stop()
})

for (const verb of ['create', 'refine', 'implement']) for (const signal of ['SIGTERM', 'SIGKILL', 'update'] as const) {
  it(`${verb} survives Runner ${signal} without a second execution (#693)`, async () => {
    const action = verb === 'create' ? 'refine' : verb
    if (verb === 'create') cloud.put({ 'todo/2-test.md': null })
    process.env.FAKE_AKB = JSON.stringify({ [action]: { gates: [gate(1), gate(2)], result: 'Original result',
      spent: { costUsd: 0.25, usage: { input: 10, output: 2 } }, ...(verb === 'refine' ? { status: 'planned' } : {}) } })
    const job = cloud.dispatch({ id: 'job', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
      runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb } })
    launch()
    await until(() => commands(action).length === 1, 15_000)
    const record = path.join(runnerHome(), 'flow-workers/job.json')
    const pid = JSON.parse(fs.readFileSync(record, 'utf8')).pid
    await exit(signal)
    process.kill(pid, 0)
    assert.equal(job.state, 'claimed', log)
    fs.writeFileSync(gate(1), '')
    launch()
    await until(() => cloud.registrations >= 2, 10_000)
    fs.writeFileSync(gate(2), '')
    await until(() => job.state === 'finished', 15_000)
    await reclaimed(record)
    assert.ok(!fs.existsSync(`${record}.log`))
    assert.ok(!fs.existsSync(`${record}.stop`))
    assert.equal(job.outcome, 'done', `${log}\n${job.reason}`)
    assert.equal(job.claims, 1)
    assert.equal(commands(action).length, 1)
    assert.equal(job.report?.costUsd, verb === 'implement' ? 0.5 : 0.25)
    assert.equal((job.report?.usage as { input?: number } | undefined)?.input, verb === 'implement' ? 20 : 10)
    assert.equal(job.report?.reply, verb === 'implement' ? 'Landed it.' : 'Original result')
    assert.ok(!calls().some((c) => c[1] === 'run' && c[2] === 'stop'))
  })
}

it('collects a result completed with the Runner offline (#693)', async () => {
  process.env.FAKE_AKB = JSON.stringify({ refine: { gates: [gate(1)], result: 'Offline result', status: 'planned' } })
  const job = cloud.dispatch({ id: 'job', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'refine' } })
  launch()
  await until(() => commands('refine').length === 1, 15_000)
  await exit('SIGKILL')
  fs.writeFileSync(gate(1), '')
  await until(() => job.state === 'finished', 15_000)
  launch()
  await until(() => cloud.registrations >= 2)
  assert.equal(job.outcome, 'done', log)
  await until(() => !fs.existsSync(path.join(runnerHome(), 'flow-workers/job.json')), 10_000)
  assert.equal(job.report?.reply, 'Offline result')
  assert.equal(job.claims, 1)
})

it('retains a completed result while its upload is offline across a restart (#693)', async () => {
  process.env.FAKE_AKB = JSON.stringify({ refine: { gates: [gate(1)], result: 'Pending upload', spent: { costUsd: 0.25 } } })
  const job = cloud.dispatch({ id: 'job', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'refine' } })
  launch()
  await until(() => commands('refine').length === 1, 15_000)
  await exit('SIGKILL')
  cloud.offline = true
  fs.writeFileSync(gate(1), '')
  await until(() => {
    try { return !!JSON.parse(fs.readFileSync(path.join(runnerHome(), 'checkpoints/job.json'), 'utf8')).completed } catch { return false }
  }, 10_000)
  const record = path.join(runnerHome(), 'flow-workers/job.json')
  assert.ok(fs.existsSync(record))
  await reclaimFlowWorkers(machine)
  assert.ok(fs.existsSync(record))
  launch()
  cloud.offline = false
  await until(() => job.state === 'finished', 15_000)
  assert.equal(job.outcome, 'done', log)
  await reclaimed(record)
  assert.equal(job.report?.reply, 'Pending upload')
  assert.equal(job.report?.costUsd, 0.25)
  assert.equal(commands('refine').length, 1)
  assert.equal(job.claims, 1)
})

for (const reason of ['stop', 'account', 'transfer', 'runner-transfer', 'crash'] as const) {
  it(`does not continue or replay after ${reason} (#693)`, async () => {
    process.env.FAKE_AKB = JSON.stringify({ implement: { gates: [gate(1)], result: 'Must not land' } })
    const job = cloud.dispatch({ id: 'job', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
      runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'implement' } })
    launch()
    const record = path.join(runnerHome(), 'flow-workers/job.json')
    await until(() => commands('implement').length === 1, 15_000)
    const worker = JSON.parse(fs.readFileSync(record, 'utf8'))
    if (reason !== 'crash') await exit('SIGKILL')
    if (reason === 'stop') job.stop = true
    if (reason === 'transfer') job.leaseLost = true
    if (reason === 'runner-transfer') cloud.runner = { machineId: 'another-machine', machineName: 'Elsewhere', live: true }
    if (reason === 'account') fs.writeFileSync(path.join(runnerHome(), 'account-generation'), 'signed-out')
    if (reason === 'crash') process.kill(worker.pid, 'SIGKILL')
    if (reason === 'stop' || reason === 'crash') {
      await until(() => job.state === 'finished', 15_000)
      await reclaimed(record)
      assert.equal(job.outcome, reason === 'stop' ? 'stopped' : 'failed', `${log}\n${job.reason}`)
    } else {
      await until(() => JSON.parse(fs.readFileSync(record, 'utf8')).ended === true, 15_000)
    }
    assert.equal(commands('implement').length, 1)
    assert.equal(job.claims, 1)
    assert.notEqual(job.outcome, 'done')
    assert.ok(!fs.existsSync(path.join(folder(), '.akb/kanban/.archive/2-test.md')))
  })
}

it('refuses a recorded launch whose execution cannot be identified (#693)', async () => {
  process.env.FAKE_AKB = '{}'
  const directory = path.join(runnerHome(), 'flow-workers')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'job.json'), JSON.stringify({ id: 'job', token: 'old', account: 'acct',
    machine, generation: '', at: 0 }))
  const job = cloud.dispatch({ id: 'job', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'refine' } })
  launch()
  await until(() => job.state === 'finished', 10_000)
  assert.equal(job.outcome, 'failed', log)
  assert.equal(commands('refine').length, 0)
  assert.match(job.reason ?? '', /已有成果已保留/)
})

it('keeps replies and other flow types outside detached execution (#693)', () => {
  const base = { task: 'task_1', flow: { verb: 'implement' } }
  assert.ok(canKeepFlow(base as never))
  for (const other of [{ chat: {} }, { discussion: {} }, { flow: { verb: 'resolve' } }, { flow: { verb: 'discard' } }, { review: {} }, { agent: {} }]) {
    assert.equal(canKeepFlow({ ...base, flow: null, ...other } as never), false)
  }
})

const reclaimed = (file: string) => until(() => !fs.existsSync(file), 10_000)

const recordOf = (id: string) => path.join(runnerHome(), 'flow-workers', `${encodeURIComponent(id)}.json`)
const sweepDeps = () => ({ ...defaultDeps(machine), akb: () => ({ command: process.execPath,
  args: [process.env.FAKE_AKB_ENTRY!], version: 'test', shim: path.join(runnerHome(), 'shim') }) })
async function history(id: string, patch: Record<string, unknown> = {}) {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', detached: true })
  await new Promise<void>((resolve) => child.once('close', () => resolve()))
  const file = recordOf(id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.mkdirSync(path.join(folder(), '.akb/kanban'), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ id, token: `token-${id}`, machine, account: 'acct', generation: '',
    at: Date.now(), pid: child.pid, ended: true, ...patch }))
  fs.writeFileSync(`${file}.log`, 'diagnostics')
  fs.writeFileSync(`${file}.stop`, `token-${id}`)
  const job = cloud.dispatch({ id, task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    flow: { studio: 'wf_builtin_coding', verb: 'refine' } })
  job.state = 'finished'
  return file
}

it('reclaims legacy history at startup, including missing ended, and keeps orphan files (#696)', async () => {
  const ended = await history('ended')
  const crashed = await history('crashed', { ended: false })
  const orphan = path.join(runnerHome(), 'flow-workers/orphan.json.log')
  fs.writeFileSync(orphan, 'unknown owner')
  launch()
  await until(() => !fs.existsSync(ended) && !fs.existsSync(crashed), 10_000)
  for (const file of [ended, crashed]) {
    assert.ok(!fs.existsSync(`${file}.log`))
    assert.ok(!fs.existsSync(`${file}.stop`))
  }
  assert.ok(fs.existsSync(orphan))
  assert.equal(commands('refine').length, 0)
})

it('retains unknown, live, unacknowledged and foreign records independently (#696)', async () => {
  const kept = []
  for (const [id, patch] of Object.entries({ launch: { pid: undefined }, live: { pid: process.pid },
    foreign: { account: 'other' }, machine: { machine: 'other' }, malformed: { token: null } })) {
    kept.push(await history(id, patch))
  }
  for (const state of ['waiting', 'claimed'] as const) {
    kept.push(await history(state))
    cloud.jobs.get(state)!.state = state
  }
  kept.push(await history('missing'))
  cloud.jobs.delete('missing')
  const broken = await history('broken')
  fs.writeFileSync(broken, '{')
  kept.push(broken)
  const removable = await history('finished')
  await reclaimFlowWorkers(machine, sweepDeps())
  for (const file of kept) assert.ok(fs.existsSync(file), file)
  assert.ok(!fs.existsSync(removable))
})

it('retries offline queries and partial deletion without blocking another candidate (#696)', async () => {
  const file = await history('retry')
  const other = await history('other')
  cloud.offline = true
  await reclaimFlowWorkers(machine, sweepDeps())
  assert.ok(fs.existsSync(file))
  cloud.offline = false
  fs.rmSync(`${file}.stop`)
  fs.mkdirSync(`${file}.stop`)
  await reclaimFlowWorkers(machine, sweepDeps())
  assert.ok(fs.existsSync(file))
  assert.ok(!fs.existsSync(`${file}.log`))
  assert.ok(!fs.existsSync(other))
  fs.rmdirSync(`${file}.stop`)
  await reclaimFlowWorkers(machine, sweepDeps())
  await reclaimFlowWorkers(machine, sweepDeps())
  assert.ok(!fs.existsSync(file))
})

it('a watcher accepts a concurrently reclaimed record only after explicit cloud confirmation (#696)', async () => {
  await history('finished')
  await Promise.all([reclaimFlowWorkers(machine, sweepDeps()), watchFlowWorker('finished', machine, () => false)])
  await watchFlowWorker('finished', machine, () => false)
  cloud.jobs.get('finished')!.state = 'claimed'
  await assert.rejects(watchFlowWorker('finished', machine, () => false), /无法确认/)
  assert.equal(cloud.jobs.get('finished')!.claims, 0)
})


it('stops a sweep on account changes and rechecks record identity after the cloud read (#696)', async () => {
  const first = await history('first')
  const second = await history('second')
  cloud.beforeReadJob = () => { fs.writeFileSync(path.join(runnerHome(), 'account-generation'), 'changed') }
  await reclaimFlowWorkers(machine, sweepDeps())
  assert.ok(fs.existsSync(first))
  assert.ok(fs.existsSync(second))
  cloud.beforeReadJob = () => {
    const worker = JSON.parse(fs.readFileSync(first, 'utf8'))
    fs.writeFileSync(first, JSON.stringify({ ...worker, token: 'replacement' }))
  }
  await reclaimFlowWorkers(machine, sweepDeps(), 'first')
  assert.ok(fs.existsSync(first))
  assert.ok(fs.existsSync(`${first}.log`))
  cloud.beforeReadJob = null
  await reclaimFlowWorkers(machine, sweepDeps())
  assert.ok(!fs.existsSync(first))
  assert.ok(!fs.existsSync(second))
})

it('retains records while an orphaned execution descendant can still write (#696)', async () => {
  const file = await history('descendant')
  const worker = JSON.parse(fs.readFileSync(file, 'utf8'))
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true,
    env: { ...process.env, AI4KANBAN_EXECUTION: JSON.stringify({ job: worker.id, machine }) } })
  try {
    await new Promise<void>((resolve) => child.once('spawn', resolve))
    await reclaimFlowWorkers(machine, sweepDeps())
    assert.ok(fs.existsSync(file))
  } finally {
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.kill('SIGKILL')
    await closed
  }
  await reclaimFlowWorkers(machine, sweepDeps())
  assert.ok(!fs.existsSync(file))
})


it('does not relaunch a reclaimed execution from a stale waiting list (#696)', async () => {
  const job = cloud.dispatch({ id: 'stale', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    flow: { studio: 'wf_builtin_coding', verb: 'refine' } })
  let checked = false
  cloud.beforeReadJob = (id) => {
    if (id === job.id) { checked = true; job.state = 'finished' }
  }
  launch()
  await until(() => checked)
  assert.equal(job.claims, 0)
  assert.equal(commands('refine').length, 0)
  assert.ok(!fs.existsSync(recordOf(job.id)))
})

it('keeps legacy recovery evidence when board runs or checkpoints remain uncertain (#696)', async () => {
  const file = await history('uncertain')
  const state = path.join(folder(), '.akb/kanban/.fake')
  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(path.join(state, 'runs.json'), JSON.stringify([{ sessionId: 'pending', cardId: 2, status: 'running' }]))
  await reclaimFlowWorkers(machine, sweepDeps())
  assert.ok(fs.existsSync(file))
  fs.writeFileSync(path.join(state, 'runs.json'), '[]')
  fs.mkdirSync(path.join(runnerHome(), 'checkpoints'), { recursive: true })
  const checkpoint = path.join(runnerHome(), 'checkpoints/uncertain.json')
  fs.writeFileSync(checkpoint, '{')
  await reclaimFlowWorkers(machine, sweepDeps())
  assert.ok(fs.existsSync(file))
  fs.rmSync(checkpoint)
  await reclaimFlowWorkers(machine, sweepDeps())
  assert.ok(!fs.existsSync(file))
})


it('coordinates stop markers with concurrent deletion and retries a held cleanup lock (#696)', async () => {
  const file = await history('stop-race', { ended: false })
  const release = tryLock(`${file}.lock`)!
  assert.ok(release)
  const stopping = stopFlowWorker('stop-race', 4000)
  try {
    await reclaimFlowWorkers(machine, sweepDeps())
    assert.ok(fs.existsSync(file))
  } finally { release() }
  await Promise.all([stopping, reclaimFlowWorkers(machine, sweepDeps())])
  assert.ok(!fs.existsSync(file))
  assert.ok(!fs.existsSync(`${file}.stop`))
  assert.ok(!fs.existsSync(`${file}.lock`))
})


it('bounds cleanup lookups across processes and retries after another reader releases (#696)', async () => {
  const file = await history('lookup')
  const release = tryLock(path.join(runnerHome(), 'flow-workers/.lookup.lock'))!
  let queries = 0
  cloud.beforeReadJob = () => { queries++ }
  try {
    await reclaimFlowWorkers(machine, sweepDeps())
    assert.ok(fs.existsSync(file))
    assert.equal(queries, 0)
  } finally { release() }
  await reclaimFlowWorkers(machine, sweepDeps())
  assert.equal(queries, 1)
  assert.ok(!fs.existsSync(file))
})
