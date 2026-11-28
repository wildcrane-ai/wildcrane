import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { reclaimFlowWorkers, stopFlowWorker, watchFlowWorker } from '../src/flow-worker'
import { processesStopped } from '../../cli/src/lib/agent/stop'
import { tryLock } from '../../cli/src/lib/lock'
import { defaultDeps } from '../src/jobs'
import { runnerHome } from '../src/home'
import { until } from './fake-cloud'
import { machine, cloud, log, folder, calls, commands, launch, reclaimed, recordOf } from './flow-worker-harness'

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

const refineJob = (id = 'job') => {
  process.env.FAKE_AKB = JSON.stringify({ refine: { result: 'Refined once', status: 'planned' } })
  return cloud.dispatch({ id, task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'refine' } })
}

it('backs off after claim failures and runs the same waiting job once (#1116)', async () => {
  const job = refineJob()
  const requests: number[] = []
  cloud.onClaim = () => {
    requests.push(Date.now())
    if (requests.length <= 2) return 'unavailable'
  }
  launch()
  await until(() => job.taskRecovery?.attempt === 1)
  assert.equal(job.state, 'waiting')
  assert.equal(job.claims, 0)
  await until(() => job.taskRecovery?.attempt === 2)
  assert.deepEqual(job.taskRecovery, { code: 'claim', attempt: 2 })
  assert.equal(job.state, 'waiting')
  assert.equal(commands('refine').length, 0)
  await until(() => job.state === 'finished', 15_000)
  assert.equal(job.outcome, 'done', `${log}\n${job.reason}`)
  await reclaimed(recordOf(job.id))
  assert.equal(job.taskRecovery, undefined)
  assert.equal(job.claims, 1)
  assert.equal(commands('refine').length, 1)
  assert.equal(requests.length, 3)
  assert.ok(requests[1]! - requests[0]! >= 1000)
  assert.ok(requests[2]! - requests[1]! >= 2000)
  assert.match(log, /retrying job claim/)
  assert.match(log, /service_unavailable 503 Claim temporarily unavailable/)
  const diagnostics = fs.readFileSync(path.join(runnerHome(), 'logs/runner.log'), 'utf8')
  const rows = diagnostics.trim().split('\n').map(line => JSON.parse(line))
  assert.ok(rows.some(row => row.component === 'runner' && row.event === 'connected'))
  assert.ok(rows.some(row => row.component === 'worker' && row.event === 'starting'))
  assert.ok(rows.some(row => row.component === 'worker' && row.event === 'exited'))
  assert.ok(!diagnostics.includes('Claim temporarily unavailable'))
})

it('recovers an old waiting record only after its descendant exits (#1116)', async () => {
  const id = 'legacy-claim-1116'
  const file = await history(id)
  const job = refineJob(id)
  const mark = { name: 'AI4KANBAN_EXECUTION', value: JSON.stringify({ job: job.id, machine }) }
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true,
    env: { ...process.env, [mark.name]: mark.value } })
  try {
    await new Promise<void>((resolve) => descendant.once('spawn', resolve))
    launch()
    await until(() => cloud.jobReads >= 3)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, `token-${id}`)
    assert.equal(job.taskRecovery, undefined)
    assert.equal(job.claims, 0)
  } finally {
    const closed = new Promise<void>((resolve) => descendant.once('close', () => resolve()))
    descendant.kill('SIGKILL')
    await closed
  }
  assert.ok(processesStopped(mark), 'the test descendant must have exited')
  await until(() => job.state === 'finished', 15_000).catch((error) => {
    throw new Error(`${error}\n${log}\n${fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''}\n${JSON.stringify(calls())}`)
  })
  assert.equal(job.outcome, 'done', `${log}\n${job.reason}`)
  await reclaimed(file)
  assert.equal(job.claims, 1)
  assert.equal(commands('refine').length, 1)
})

it('preserves an unknown claim and hands a granted lease to existing recovery (#1116)', async () => {
  const job = refineJob()
  cloud.onClaim = (id) => {
    cloud.onClaim = undefined
    cloud.unavailableJobRead = id
    return 'lose-response'
  }
  launch()
  const file = recordOf(job.id)
  await until(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).ended === true)
  const failed = fs.readFileSync(file, 'utf8')
  await reclaimFlowWorkers(machine, sweepDeps(), job.id, true)
  assert.equal(fs.readFileSync(file, 'utf8'), failed)
  assert.equal(job.state, 'claimed')
  assert.equal(commands('refine').length, 0)
  assert.deepEqual(cloud.jobFinishes, [])
  cloud.unavailableJobRead = null
  await until(() => job.state === 'finished', 15_000)
  assert.equal(job.outcome, 'done', `${log}\n${job.reason}`)
  await reclaimed(file)
  assert.equal(job.claims, 2)
  assert.deepEqual(cloud.jobFinishes.map(({ outcome }) => outcome), ['update_prepare', 'update_resume', 'done'])
  assert.equal(commands('refine').length, 1)
})

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

it('completes the first task on an uninitialized board and recovers pre-init crashes (#1257)', async () => {
  cloud.board.clear()
  cloud.head = 0
  process.env.FAKE_AKB = JSON.stringify({
    strictBoard: true,
    refine: { result: 'Planned first card', status: 'planned' },
  })
  const crashed = cloud.dispatch({ id: 'first-crashed', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 1,
    machine, runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'create', title: 'First task' } })
  crashed.state = 'claimed'
  const crashedFile = recordOf(crashed.id)
  fs.mkdirSync(path.dirname(crashedFile), { recursive: true })
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', detached: true })
  await new Promise<void>((resolve) => child.once('close', () => resolve()))
  fs.writeFileSync(crashedFile, JSON.stringify({
    id: crashed.id, token: 'token-first', machine, account: 'acct', generation: '',
    at: Date.now(), markedAt: Date.now() - 1000, processAt: Date.now() - 1000, pid: child.pid, ended: true,
  }))
  fs.mkdirSync(path.join(runnerHome(), 'checkpoints'), { recursive: true })
  fs.writeFileSync(path.join(runnerHome(), 'checkpoints/first-crashed.json'), JSON.stringify({ pending: [], started: false }))
  launch()
  await until(() => crashed.state === 'finished', 15_000)
  assert.equal(crashed.outcome, 'done', `${log}\n${crashed.reason}`)
  await reclaimed(crashedFile)
  assert.ok(fs.existsSync(path.join(folder(), '.akb/kanban/config.md')))
  assert.equal(commands('refine').length, 1)

  const freshDir = path.join(runnerHome(), 'fresh-project')
  fs.mkdirSync(freshDir, { recursive: true })
  fs.writeFileSync(path.join(runnerHome(), 'projects.json'), JSON.stringify({ projects: [folder(), freshDir] }))
  cloud.folders.push({ project: 'prj_2', name: 'Fresh', path: freshDir, notify: false, machine })
  const fresh = cloud.dispatch({ id: 'fresh-first', task: 'task_2', project: 'prj_2', projectDir: freshDir, number: 1,
    runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'create', title: 'Fresh board task' } })
  await until(() => fresh.state === 'finished', 15_000)
  assert.equal(fresh.outcome, 'done', `${log}\n${fresh.reason}`)
  await reclaimed(recordOf(fresh.id))
  assert.ok(fs.existsSync(path.join(freshDir, '.akb/kanban/config.md')))
  assert.equal(commands('refine').length, 2)
})
