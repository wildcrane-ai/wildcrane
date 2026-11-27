import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { after, afterEach, before, beforeEach, it } from 'node:test'
import { canKeepFlow, reclaimFlowWorkers, stopFlowWorker, watchFlowWorker } from '../src/flow-worker'
import { processesStopped } from '../../cli/src/lib/agent/stop'
import { tryLock } from '../../cli/src/lib/lock'
import { projectStateDir } from '../../cli/src/lib/machine/project'
import { openTaskFolder, push, withBoard } from '../src/task-folder'
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
const commands = (verb: string) => calls().filter((c) => c[0] === 'raw' && (verb === 'preview' ? c[1] === 'previews' && c[2] === 'designer' : c[1] === 'card' && c[2] === verb))
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
  fs.rmSync(runnerHome(), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
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
      runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb,  } })
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

it('waits for another worker to prepare the board without recreating the card after Runner restart (#882)', async () => {
  cloud.put({ 'todo/2-test.md': null })
  process.env.FAKE_AKB = JSON.stringify({ refine: { result: 'Prepared once', status: 'planned' } })
  const ws = openTaskFolder({ task: 'other', project: 'prj_1', number: 3 }, folder())
  let ready!: () => void, unlock!: () => void
  const entered = new Promise<void>(resolve => { ready = resolve })
  const held = withBoard(ws, async () => {
    ready()
    await new Promise<void>(resolve => { unlock = resolve })
  })
  await entered
  const job = cloud.dispatch({ id: 'job', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'create' } })
  try {
    launch()
    await until(() => job.state === 'claimed')
    await exit('SIGKILL')
    assert.equal(calls().filter(args => args[0] === 'raw' && args[1] === 'create').length, 0)
    launch()
    await until(() => cloud.registrations >= 2)
  } finally { unlock(); await held }
  await until(() => job.state === 'finished', 15_000)
  assert.equal(job.outcome, 'done', `${log}
${job.reason}`)
  assert.equal(calls().filter(args => args[0] === 'raw' && args[1] === 'create').length, 1)
  assert.equal(commands('refine').length, 1)
  assert.equal(job.claims, 1)
})

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

for (const interrupt of ['before', 'after'] as const) it(`recovers when card creation exits ${interrupt} writing the card (#987)`, async () => {
  cloud.put({ 'todo/2-test.md': null })
  process.env.FAKE_AKB = JSON.stringify({ create: { interrupt }, refine: { result: 'Planned once' } })
  const job = cloud.dispatch({ id: 'job', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'create' } })
  launch()
  await until(() => job.state === 'finished', 15_000)
  assert.equal(job.outcome, 'done', `${log}\n${job.reason}`)
  assert.equal(job.claims, 1)
  assert.equal(calls().filter(args => args[0] === 'raw' && args[1] === 'create').length, interrupt === 'before' ? 2 : 1)
  assert.equal(commands('refine').length, 1)
  assert.deepEqual(fs.readdirSync(path.join(folder(), '.akb/kanban/todo')).filter(name => name.startsWith('2-')), ['2-test.md'])
})

it('reclaims an accepted job when its worker dies before receiving the claim (#987)', async () => {
  cloud.put({ 'todo/2-test.md': null })
  process.env.FAKE_AKB = JSON.stringify({ refine: { result: 'Planned once' } })
  const job = cloud.dispatch({ id: 'job', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'create' } })
  cloud.onClaim = () => {
    if (job.claims) return
    const worker = JSON.parse(fs.readFileSync(recordOf(job.id), 'utf8'))
    process.kill(worker.pid, 'SIGKILL')
    return 'lose-response'
  }
  launch()
  await until(() => job.state === 'finished', 15_000)
  assert.equal(job.outcome, 'done', `${log}\n${job.reason}`)
  assert.equal(job.claims, 2)
  assert.equal(calls().filter(args => args[0] === 'raw' && args[1] === 'create').length, 1)
  assert.equal(commands('refine').length, 1)
})

for (const submitted of [false, true]) it(`recovers interrupted Antigravity planning ${submitted ? 'after' : 'before'} preview submission (#984)`, async () => {
  const asset = '.assets/2/design.txt'
  const projectDir = fs.realpathSync(folder())
  const board = path.join(projectDir, '.akb/kanban')
  const local = path.relative(board, path.join(projectStateDir(board), 'assets/2/design.txt'))
  const session = 'agy-planning-session'
  const content = 'Existing design'
  const planning = { session, asset, local, content, gate: gate(1) }
  process.env.FAKE_AKB = JSON.stringify({
    refine: { agentSession: session, writes: { [local]: content }, end: { status: 'interrupted' }, ...(submitted ? { planning } : {}) },
    resume: { planning },
  })
  const taskReview = { plan: [{ id: 'design', after: [], previews: ['ui-design'] }],
    stages: [{ id: 'design', status: 'running' as const, revision: 1, snapshot: null }], revision: 1 }
  cloud.task.review = taskReview
  const job = cloud.dispatch({ id: 'job', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    runtime: 'antigravity', taskReview, flow: { studio: 'wf_builtin_coding', verb: 'refine', review_stages: ['design'], review_revision: 1 } })
  launch()
  const card = 'todo/2-test.md'
  const ws = openTaskFolder({ task: job.task, project: job.project, number: job.number, studio: 'wf_builtin_coding' }, projectDir)
  const previewSaved = () => fs.existsSync(path.join(board, card)) && fs.readFileSync(path.join(board, card), 'utf8').includes('<Preview')
  await until(() => previewSaved() || job.state === 'finished', 10_000)
  assert.ok(previewSaved(), `${log}\n${job.reason}\n${JSON.stringify(job.events)}`)
  const published = await push(ws, { id: job.id, machineId: machine })
  assert.ok(published.ok, JSON.stringify(published))
  const { artifact, version } = JSON.parse(cloud.file('assets/task_1.json')!)[asset]
  assert.equal(cloud.task.artifacts.get(artifact)?.[version - 1]?.toString(), content)
  cloud.task.review = { ...taskReview, revision: 2, stages: [{ id: 'design', status: 'waiting_review', revision: 2, snapshot: {} }] }
  fs.writeFileSync(gate(1), '')
  await until(() => job.state === 'finished', 15_000)
  assert.equal(job.outcome, 'done', `${log}\n${job.reason}`)
  assert.equal(job.claims, 1)
  assert.equal(job.report?.session, session)
  if (!submitted) assert.equal(job.report?.reply, 'Submitted the saved UI design.')
  assert.equal(commands('refine').length, 1)
  assert.equal(calls().filter(args => args[1] === 'run' && args[2] === 'resume').length, submitted ? 0 : 1)
  assert.equal(calls().filter(args => args.slice(0, 4).join(' ') === 'raw run resume run-refine-1' && args.includes('--require-session')).length, submitted ? 0 : 1)
  assert.equal(cloud.task.review.stages[0]?.status, 'waiting_review')
  assert.match(cloud.file(card)!, /<Asset src="\.assets\/2\/design.txt"/)
  assert.equal(cloud.task.artifacts.size, 1)
})

it('preserves Antigravity progress when quota exhaustion requires user action (#989)', async () => {
  const reason = 'Antigravity quota is exhausted. Check the account credits before retrying.'
  const failure = { source: 'runtime', code: 'quota_exhausted', summary: reason }
  process.env.FAKE_AKB = JSON.stringify({ refine: { agentSession: 'agy-planning-session', writes: { 'temp-result.txt': 'Partial design' },
    end: { status: 'error', failure, retryPause: 'authorization',
      retryHistory: [{ ...failure, attempt: 1, at: new Date().toISOString(), sessionAction: 'resume' }] } } })
  const job = cloud.dispatch({ id: 'job', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    runtime: 'antigravity', flow: { studio: 'wf_builtin_coding', verb: 'refine' } })
  launch()
  await until(() => job.state === 'finished', 15_000)
  assert.equal(job.outcome, 'failed', `${log}\n${job.reason}`)
  assert.equal(job.reason, reason)
  assert.equal(job.report?.failure?.pauseReason, 'authorization')
  assert.equal(job.report?.failure?.safeToRetry, true)
  assert.equal(commands('refine').length, 1)
  assert.ok(!calls().some(args => args.includes('resume')))
  assert.equal(fs.readFileSync(path.join(folder(), '.akb/kanban/temp-result.txt'), 'utf8'), 'Partial design')
})

for (const pendingWrites of [false, true]) it(`preserves W-1198 background verification progress (${pendingWrites ? 'unconfirmed' : 'resumes'})`, async () => {
  const file = 'saved-result.txt'
  const saved = 'Completed work'
  const session = 'original-verification-session'
  const failure = { source: 'runtime', code: 'completed_operation_failed', summary: 'Runner background verification exited with failing tests.' }
  process.env.FAKE_AKB = JSON.stringify({
    implement: { agentSession: session, writes: { [file]: saved }, end: {
      status: 'error', deliveryId: 'original-delivery', failure, retryPause: 'unsafe', pendingWrites,
      cleanup: { status: 'confirmed', kept: [] },
      retryHistory: [{ ...failure, attempt: 1, at: new Date().toISOString(), sessionAction: 'resume' }],
    } },
    resume: { keep: { [file]: saved } },
  })
  // W-1198 used an active delivery and had already saved work before verification failed.
  const dispatch = { task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    runtime: 'codex', flow: { studio: 'wf_builtin_coding', verb: 'implement' } } as const
  const original = cloud.dispatch({ ...dispatch, id: 'job' })
  launch()
  await until(() => original.state === 'finished', 15_000)
  assert.equal(original.outcome, 'failed', log)
  assert.equal(original.report?.failure?.safeToRetry, !pendingWrites, `${original.reason}\n${log}`)
  assert.equal(original.report?.failure?.sessionAction, pendingWrites ? 'pause_unsafe' : 'resume')
  assert.equal(commands('implement').length, 1)
  assert.equal(fs.readFileSync(path.join(folder(), '.akb/kanban', file), 'utf8'), saved)

  const resumed = cloud.dispatch({ ...dispatch, id: 'resumed-job',
    flow: { ...dispatch.flow, resume: true, resume_execution: original.id } })
  await until(() => resumed.state === 'finished', 15_000)
  if (pendingWrites) {
    assert.match(original.report?.failure?.detail ?? '', /操作结果|operation results/i)
    assert.equal(resumed.outcome, 'failed', log)
    assert.equal(resumed.reason, 'task_recovery_unverified')
    assert.ok(!calls().some(args => args[1] === 'run' && args[2] === 'resume'))
  } else {
    assert.equal(resumed.outcome, 'done', `${log}\n${resumed.reason}`)
    assert.equal(resumed.report?.session, session)
    assert.equal(resumed.report?.deliveryId, 'original-delivery')
    assert.ok(calls().some(args => args.slice(0, 4).join(' ') === 'raw run resume run-implement-1' && args.includes('--require-session')))
  }
  assert.equal(commands('implement').length, 1)
  assert.equal(fs.readFileSync(path.join(folder(), '.akb/kanban', file), 'utf8'), saved)
})

for (const mode of ['available', 'preflight', 'runtime', 'no-id']) it(`resumes the W-1226 idle timeout from saved progress (${mode})`, async () => {
  const failure = { code: 'idle_timeout', source: 'runtime', summary: 'No verifiable progress for 5 minutes (idle timeout).' }
  const file = 'saved-result.txt'
  const saved = 'Completed work before the timeout'
  const session = 'original-antigravity-session'
  const deliveryId = 'original-delivery'
  const attempt = 'run-implement-1'
  process.env.FAKE_AKB = JSON.stringify({
    implement: {
      agentSession: mode === 'no-id' ? undefined : session, writes: { [file]: saved },
      end: { status: 'error', deliveryId, failure, retryPause: 'unsafe', pendingWrites: true,
        cleanup: { status: 'unconfirmed', execution: attempt, kept: [] },
        retryHistory: [{ ...failure, attempt: 1, at: new Date().toISOString(), sessionAction: 'pause_unsafe' }],
      },
    },
    resume: { missing: ['preflight', 'runtime'].includes(mode) ? mode : undefined, keep: { [file]: saved } },
  })
  const dispatch = { task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    runtime: 'antigravity', flow: { studio: 'wf_builtin_coding', verb: 'implement' } } as const
  const original = cloud.dispatch({ ...dispatch, id: 'job' })
  launch()
  await until(() => original.state === 'finished', 15_000)
  assert.equal(original.outcome, 'failed', log)
  assert.equal(original.report?.failure?.safeToRetry, false)
  assert.equal(original.report?.failure?.code, 'idle_timeout')

  const resumed = cloud.dispatch({ ...dispatch, id: `resumed-${mode}`,
    flow: { ...dispatch.flow, resume: true, resume_execution: original.id } })
  await until(() => resumed.state === 'finished', 20_000)
  await reclaimed(recordOf(resumed.id))
  assert.equal(resumed.outcome, 'done', `${log}\n${resumed.reason}`)
  assert.equal(resumed.claims, 1)
  assert.equal(resumed.report?.session, mode === 'available' ? session : 'new-agent-session')
  assert.equal(resumed.report?.deliveryId, deliveryId)
  const resumes = calls().filter(args => args[1] === 'run' && args[2] === 'resume')
  assert.deepEqual(resumes.map(args => args.slice(3, 5)), [
    ...(mode === 'no-id' ? [] : [[attempt, '--require-session']]),
    ...(mode === 'available' ? [] : [[mode === 'runtime' ? `missing-${attempt}` : attempt, '--new-session']]),
  ])
  assert.equal(commands('implement').length, 1)
  assert.equal(fs.readFileSync(path.join(folder(), '.akb/kanban', file), 'utf8'), saved)
})

for (const scenario of ['confirmed', 'legacy_terminal', 'running_item', 'foreign_session'] as const) {
  it(`handles manual resume after a stopped Codex run (${scenario})`, async () => {
    const file = 'todo/0002-saved.md'
    const saved = '# Saved work\n\nKeep me.\n'
    const session = 'codex-thread-stopped'
    const detail = 'Execution stopped; no further cleanup turn was submitted.'
    const cleanup = scenario === 'confirmed' || scenario === 'foreign_session'
      ? { status: 'confirmed', kept: [], items: [] }
      : { status: 'unconfirmed', detail, kept: [], items: [{ id: 'terminal:t:1', threadId: session, status: scenario === 'running_item' ? 'running' : 'completed' }] }
    process.env.FAKE_AKB = JSON.stringify({
      implement: { agentSession: session, writes: { [file]: saved }, end: { status: 'stopped', deliveryId: 'original-delivery', cleanup } },
      resume: { keep: { [file]: saved } },
    })
    const dispatch = { task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
      runtime: 'codex', flow: { studio: 'wf_builtin_coding', verb: 'implement' } } as const
    const original = cloud.dispatch({ ...dispatch, id: 'job-stopped' })
    launch()
    await until(() => original.state === 'finished', 15_000)
    if (scenario === 'foreign_session') {
      const runsFile = path.join(folder(), '.akb/kanban/.fake/runs.json')
      const runs = JSON.parse(fs.readFileSync(runsFile, 'utf8'))
      runs.push({ sessionId: 'foreign-session', cardId: 999, action: 'implement', status: 'done', resumeId: session })
      fs.writeFileSync(runsFile, JSON.stringify(runs))
    }

    const resumed = cloud.dispatch({ ...dispatch, id: 'job-resumed',
      flow: { ...dispatch.flow, resume: true, resume_execution: original.id } })
    await until(() => resumed.state === 'finished', 15_000)
    if (scenario === 'running_item' || scenario === 'foreign_session') {
      assert.equal(resumed.outcome, 'failed', log)
      assert.equal(resumed.reason, 'task_recovery_unverified')
      assert.ok(!calls().some(args => args[1] === 'run' && args[2] === 'resume'))
    } else {
      assert.equal(resumed.outcome, 'done', `${log}\n${resumed.reason}`)
      assert.equal(resumed.report?.session, session)
      assert.equal(resumed.report?.deliveryId, 'original-delivery')
      assert.ok(calls().some(args => args.slice(0, 4).join(' ') === 'raw run resume run-implement-1' && args.includes('--require-session')))
    }
    assert.equal(fs.readFileSync(path.join(folder(), '.akb/kanban', file), 'utf8'), saved)
  })
}

for (const workerExited of [false, true]) it(`retains a completed result while its upload is offline (${workerExited ? 'worker exit, #903' : 'Runner restart, #693'})`, async () => {
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
  if (workerExited) process.kill(JSON.parse(fs.readFileSync(record, 'utf8')).pid, 'SIGKILL')
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
  assert.equal(job.claims, workerExited ? 2 : 1)
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
      await until(() => job.state === 'finished', 15_000).catch(e => {
        throw new Error(`${e}: ${log}\n${fs.existsSync(record + '.log') ? fs.readFileSync(record + '.log', 'utf8') : ''}\n${fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : ''}`)
      })
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
  assert.match(job.reason ?? '', /Saved work was preserved/)
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
