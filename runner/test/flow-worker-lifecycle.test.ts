import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { projectStateDir } from '../../cli/src/lib/machine/project'
import { openTaskFolder, push, withBoard } from '../src/task-folder'
import { runnerHome } from '../src/home'
import { until } from './fake-cloud'
import { machine, cloud, log, folder, gate, calls, commands, launch, exit, recordOf } from './flow-worker-harness'

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
