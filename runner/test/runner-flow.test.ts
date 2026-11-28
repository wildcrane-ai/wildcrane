import { taskPreviewProblems } from '../../cli/src/lib/shared/task-preview-validation'
import { agentReview } from '../../cli/src/lib/shared/review-plan'
import { conflictList, conflictShow, pendingConflicts, withSyncLock } from '../../cli/src/lib/shared/board-conflicts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, mock } from 'node:test'
import { saveCheckpoint } from '../src/recovery'
import { runnerHome } from '../src/home'
import { spentBy } from '../src/flow'
import { canKeepFlow } from '../src/flow-worker'
import { runAkb } from '../src/akb'
import { projectStateDir } from '../../cli/src/lib/machine/project'
import { keptBoard, openTaskFolder, pull, pullChanges, push, pushBoard, readHead, withBoard } from '../src/task-folder'
import { until, type FakeJob } from './fake-cloud'
import { cloud, setInstalled, planned, MACHINE, cached, fakeRuntime, start, flowReport, flowFixture, useCustomStudio } from './runner-harness'

describe('flow jobs (#2020)', () => {
  const { board, calls, runtimeFor, cardCalls, flowJob } = flowFixture()

  it('continues the refine slot after a failed revision and retries a missing session once (#1280)', async () => {
    cloud.put({ 'config.md': '# Board\n', 'todo/2-pricing.md': '---\ntitle: Pricing\nstudio: coding\nquestions: []\n---\n' })
    process.env.FAKE_AKB = JSON.stringify({
      revise: { agentSession: 'refine-native', end: { status: 'error',
        failure: { source: 'runtime', code: 'execution_failed', summary: 'Revision interrupted.' } } },
      resume: { missing: 'preflight' },
    })
    const revision = { verb: 'revise', card: 2, text: 'Keep the shorter copy.' }
    const prior = await flowJob('revision-1280', revision, { sessionKind: 'refine' })
    assert.equal(prior.outcome, 'failed')
    assert.equal(prior.report?.session, 'refine-native')
    assert.ok(cardCalls().some(call => call.includes('Keep the shorter copy.')))
    const resumed = await flowJob('resumed-1280', { ...revision, resume: true, session_from: prior.id },
      { sessionKind: 'refine', resume: 'refine-native' })
    assert.equal(resumed.outcome, 'done', resumed.reason ?? '')
    assert.equal(resumed.report?.session, 'new-agent-session')
    assert.equal(resumed.report?.deliveryCompleted, undefined)
    assert.deepEqual(calls().filter(args => args[0] === 'run' && args[1] === 'resume').map(args => args.slice(2, 4)), [
      ['run-revise-1', '--require-session'], ['run-revise-1', '--fresh'],
    ])
    assert.ok(!calls().some(args => args[0] === 'delivery'))
  })

  it('replays the saved revision input when its bound session is missing after startup (#1280)', async () => {
    cloud.put({ 'config.md': '# Board\n', 'todo/2-pricing.md': '---\ntitle: Pricing\nstudio: coding\nquestions: []\n---\n' })
    process.env.FAKE_AKB = JSON.stringify({ revise: { missingSession: true, agentSession: 'new-refine' } })
    const text = 'Keep the shorter copy.'
    const resumed = await flowJob('refine-without-local-run', { verb: 'revise', card: 2, text, resume: true },
      { sessionKind: 'refine', resume: 'missing-refine' })
    assert.equal(resumed.outcome, 'done', resumed.reason)
    assert.equal(resumed.report?.session, 'new-refine')
    const attempts = calls().filter(args => args[0] === 'card' && args[1] === 'revise')
    assert.equal(attempts.length, 2)
    assert.equal(attempts[0][attempts[0].indexOf('--session') + 1], 'missing-refine')
    assert.ok(attempts[1].includes('--new-session'))
    assert.ok(attempts.every(args => args.at(-1) === text))
    assert.ok(!calls().some(args => args[0] === 'delivery'))
  })

  it('enters the original refine despite a preflight conflict and continues after explicit synchronization (#806)', async () => {
    cloud.put({ 'config.md': '# Board\n', 'todo/2-pricing.md': '---\ntitle: Pricing\nstudio: coding\nquestions: []\n---\n', 'memory/readme.md': 'base' })
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 2, studio: 'wf_builtin_coding' }, cached())
    assert.ok((await pull(ws, MACHINE)).ok)
    fs.writeFileSync(path.join(ws.board, 'memory/readme.md'), 'local cadence')
    cloud.put({ 'memory/readme.md': 'remote cadence' })
    const gate = path.join(runnerHome(), 'refine-conflict-gate')
    process.env.FAKE_AKB = JSON.stringify({ refine: { gates: [gate], result: 'Original refine completed.' } })
    const job = cloud.dispatch({ id: crypto.randomUUID(), task: 'task_1', project: 'prj_1', number: 2, runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'refine' } })
    start()
    await until(() => fs.existsSync(path.join(ws.board, '.fake/agent-board')))
    assert.equal(job.state, 'claimed')
    assert.equal(cardCalls().filter(c => c.startsWith('card refine')).length, 1)
    const id = conflictList(ws.board)[0]!.id
    const shown = conflictShow(ws.board, id)
    const file = path.join(runnerHome(), 'refine-resolution.json')
    fs.writeFileSync(file, JSON.stringify({ files: [{ path: 'memory/readme.md', content: 'Settled cadence' }] }))
    const cli = { command: process.execPath, args: [path.join(process.env.RUNNER_DIST!, 'akb/bin/ai4kanban.mjs')], version: 'test', shim: path.join(runnerHome(), 'real-shim') }
    const resolved = await runAkb(cli, ['--board', ws.board, 'raw', 'conflict', 'resolve', id, '--expect', shown.revision, '--file', file, '--json'], {
      cwd: ws.cwd, board: ws.board, task: ws.task, env: { AI4KANBAN_EXECUTION: JSON.stringify({ job: job.id, machine: MACHINE }) },
    })
    assert.equal(resolved.code, 0, resolved.out)
    fs.writeFileSync(gate, '')
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.report?.reply, 'Original refine completed.')
    assert.equal(cardCalls().filter(c => c.startsWith('card refine')).length, 1)
    assert.equal(cloud.file('memory/readme.md'), 'Settled cadence')
  })

  const savedConflict = async () => {
    cloud.put({ 'config.md': '# Board\n', 'memory/readme.md': 'base' })
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 2, studio: 'wf_builtin_coding' }, cached())
    assert.ok((await pull(ws, MACHINE)).ok)
    fs.writeFileSync(path.join(ws.board, 'memory/readme.md'), 'local cadence')
    cloud.put({ 'memory/readme.md': 'remote cadence' })
    assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, false)
    fs.mkdirSync(path.join(ws.board, 'todo'), { recursive: true })
    fs.mkdirSync(path.join(ws.board, '.archive'), { recursive: true })
    const saved = conflictList(ws.board)[0]!.id
    return { ws, saved }
  }

  for (const action of ['create', 'refine', 'implement'] as const) it(`starts ${action} with saved conflicts and a missing local card (#846)`, async () => {
    const verb = action === 'implement' ? 'create' : action
    const command = action === 'implement' ? 'implement' : 'refine'
    const { ws, saved } = await savedConflict()
    const original = '---\ntitle: Cloud pricing\nstudio: coding\nstatus: implementing\npreview_approved: true\nquestions: []\n---\n\nActual saved request.\n\n- [x] Shipped work\n'
    const baseBefore = JSON.parse(fs.readFileSync(path.join(cached(), '.akb/base.json'), 'utf8'))
    cloud.put({ 'memory/not-for-this-task.md': 'New remote context' })
    if (verb === 'refine') {
      cloud.put({ 'todo/2-cloud-pricing.md': original, 'assets/task_1.json': JSON.stringify({ '.assets/2/request.txt': { artifact: 'request', version: 1 } }) })
      cloud.task.artifacts.set('request', [Buffer.from('Actual attachment')])
    }
    const gate = path.join(runnerHome(), 'new-task-conflict-gate')
    process.env.FAKE_AKB = JSON.stringify({ [command]: { gates: [gate], status: 'ready', result: 'Original request completed.', landed: 'Original request completed.' } })
    const job = cloud.dispatch({ id: crypto.randomUUID(), task: 'task_1', project: 'prj_1', number: 2, runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb, skip_plan: action === 'implement' } })
    start()
    await until(() => job.state === 'finished' || fs.existsSync(path.join(ws.board, '.fake/runs.json')))
    assert.equal(job.state, 'claimed', job.reason)
    assert.equal(cardCalls().filter(c => c.startsWith(`card ${command}`)).length, 1)
    const file = path.join(ws.board, 'todo', verb === 'create' ? '2-pricing-page.md' : '2-cloud-pricing.md')
    assert.match(fs.readFileSync(file, 'utf8'), verb === 'create' ? /Two tiers, monthly and yearly/ : /Actual saved request.[\s\S]*- \[x\] Shipped work/)
    assert.equal(conflictList(ws.board)[0]!.id, saved)
    assert.equal(readHead(ws), baseBefore.head_seq)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cached(), '.akb/base.json'), 'utf8')).files['projects/prj_1/memory/readme.md'], baseBefore.files['projects/prj_1/memory/readme.md'])
    assert.equal(fs.existsSync(path.join(ws.board, 'memory/not-for-this-task.md')), false)
    if (verb === 'refine') assert.equal(fs.readFileSync(path.join(projectStateDir(ws.board), 'assets/2/request.txt'), 'utf8'), 'Actual attachment')
    const shown = conflictShow(ws.board, saved)
    assert.equal(shown.files.find(f => f.path === 'memory/readme.md')!.local.content, 'local cadence')
    assert.equal(shown.files.find(f => f.path === 'memory/readme.md')!.remote.content, 'remote cadence')
    const resolution = path.join(runnerHome(), 'new-task-resolution.json')
    fs.writeFileSync(resolution, JSON.stringify({ files: [{ path: 'memory/readme.md', content: 'Settled cadence' }] }))
    const cli = { command: process.execPath, args: [path.join(process.env.RUNNER_DIST!, 'akb/bin/ai4kanban.mjs')], version: 'test', shim: path.join(runnerHome(), 'real-shim') }
    const resolved = await runAkb(cli, ['--board', ws.board, 'raw', 'conflict', 'resolve', saved, '--expect', shown.revision, '--file', resolution, '--json'], {
      cwd: ws.cwd, board: ws.board, task: ws.task, env: { AI4KANBAN_EXECUTION: JSON.stringify({ job: job.id, machine: MACHINE }) },
    })
    assert.equal(resolved.code, 0, resolved.out)
    if (verb === 'create') {
      assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, false, 'preparation must remain private after resolution')
      assert.equal((await push({ ...ws, task: 'other', cloudTask: 'other', number: 3 }, { id: 'other', machineId: MACHINE })).ok, false)
      let cancelled = false, entered = false
      const queued = withBoard(ws, async () => { entered = true }, () => cancelled)
      await new Promise(resolve => setTimeout(resolve, 125))
      cancelled = true
      await queued
      assert.equal(entered, false)
      assert.equal(cloud.file('todo/2-pricing-page.md'), null)
    }
    assert.equal(await withSyncLock(ws.board, async () => 'available'), 'available')
    fs.writeFileSync(gate, '')
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.report?.reply, 'Original request completed.')
    assert.equal(cardCalls().filter(c => c.startsWith(`card ${command}`)).length, 1)
    assert.equal(calls().filter(c => c[0] === 'raw' && c[1] === 'create').length, verb === 'create' ? 1 : 0)
    assert.equal(cloud.file('memory/readme.md'), 'Settled cadence')
    assert.equal(pendingConflicts(ws.board).length, 0)
    if (verb === 'refine') assert.match(cloud.file('todo/2-cloud-pricing.md')!, /preview_approved: true[\s\S]*- \[x\] Shipped work/)
    const resumed = await flowJob('resume-saved', { verb, resume: true, skip_plan: action === 'implement' })
    assert.equal(resumed.outcome, 'done', resumed.reason)
    assert.equal(cardCalls().filter(c => c.startsWith(`card ${command}`)).length, 1)
    assert.equal(calls().filter(c => c[0] === 'raw' && c[1] === 'create').length, verb === 'create' ? 1 : 0)
  })

  it('refuses unavailable or ended tasks without preparing or launching a repair (#846)', async () => {
    const { ws, saved } = await savedConflict()
    cloud.put({ 'todo/2-cloud-pricing.md': '---\ntitle: Real request\n---\nSaved work' })
    const base = fs.readFileSync(path.join(cached(), '.akb/base.json'), 'utf8')
    for (const status of ['gone', 'down', 'unauthenticated', 'forbidden', 'done', 'cancelled', 'wrong-project', 'offline']) {
      cloud.taskStatus.task_1 = status
      cloud.task.project = status === 'wrong-project' ? 'prj_other' : 'prj_1'
      cloud.offline = status === 'offline'
      const result = await pull(ws, MACHINE)
      assert.equal(result.ok, false, status)
      assert.notEqual(!result.ok && result.code, 'board_content_conflict', status)
      assert.equal(fs.existsSync(path.join(ws.board, 'todo/2-cloud-pricing.md')), false, status)
      assert.equal(fs.readFileSync(path.join(cached(), '.akb/base.json'), 'utf8'), base)
    }
    cloud.offline = false
    assert.equal(conflictList(ws.board)[0]!.id, saved)
    assert.equal(planned.length, 0)
    assert.equal(cloud.jobs.size, 0)
  })

  for (const stop of [false, true]) it(`preserves a new task when its conflict is ${stop ? 'stopped' : 'unresolved'} (#846)`, async () => {
    const { ws, saved } = await savedConflict()
    const gate = path.join(runnerHome(), 'unfinished-conflict-gate')
    process.env.FAKE_AKB = JSON.stringify({ refine: { ...(stop ? { gates: [gate] } : {}), result: 'Saved draft.' } })
    const job = cloud.dispatch({ id: 'unfinished-new-task', task: 'task_1', project: 'prj_1', number: 2, runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'create' } })
    start()
    if (stop) {
      await until(() => fs.existsSync(path.join(ws.board, '.fake/runs.json')))
      job.stop = true
    }
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, stop ? 'stopped' : 'failed', job.reason)
    if (!stop) assert.match(job.reason!, /conflict.*preserved|unresolved/i)
    assert.match(fs.readFileSync(path.join(ws.board, 'todo/2-pricing-page.md'), 'utf8'), /Two tiers, monthly and yearly/)
    assert.equal(conflictList(ws.board)[0]!.id, saved)
    assert.equal(fs.readFileSync(path.join(ws.board, 'memory/readme.md'), 'utf8'), 'local cadence')
    assert.equal(cloud.file('memory/readme.md'), 'remote cadence')
    assert.equal(cloud.file('todo/2-pricing-page.md'), null)
    assert.equal(calls().filter(c => c[0] === 'raw' && c[1] === 'create').length, 1)
    assert.equal(cardCalls().filter(c => c.startsWith('card refine')).length, 1)
  })

  it('replans a reopened completed task in a new session without replaying its delivery (#807)', async () => {
    cloud.put({ 'todo/2-pricing.md': '---\ntitle: Pricing\nstatus: todo\nquestions: []\nrestored: 2026-11-17T01:00:00Z\n---\n\n- [x] Saved work\n' })
    const job = await flowJob('reopen', { verb: 'revise', card: 2, text: 'Prepare a new plan for review.', replan: true }, { resume: 'old-build-session' })
    assert.equal(job.outcome, 'done', job.reason)
    assert.ok(cardCalls().some(c => c.startsWith('card revise 2 ') && c.includes('--new-session')))
    assert.ok(!cardCalls().some(c => c.includes('--session old-build-session') || c.startsWith('card implement')))
    assert.ok(!calls().some(c => c[0] === 'delivery' && c[1] === 'resume'))
    assert.match(cloud.file('todo/2-pricing.md')!, /- \[x\] Saved work/)
  })

  it('运行时跨机续跑不检查摘要，保留目录并使用目标工具', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: { result: '保留已有进度。' } })
    await flowJob('source', { verb: 'create' })
    const { allow } = await import('../src/folders')
    allow(cached())
    fs.writeFileSync(path.join(cached(), 'existing.txt'), '已有工作')
    setInstalled([{ name: 'kimi', installed: true, loggedIn: true }])
    const job = await flowJob('target', { verb: 'refine', resume: true }, {
      runtime: 'kimi', projectDir: cached(), resume: 'incompatible-native-session',
      handoff: { kind: 'execution', action: 'runtime' },
    })
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(fs.readFileSync(path.join(cached(), 'existing.txt'), 'utf8'), '已有工作')
    assert.equal(runtimeFor().harness, 'kimi')
    assert.equal(job.report?.evidence, undefined)
  })

  it('运行时交接实际工具不可用时保留原因，不回退工具', async () => {
    const job = await flowJob('target', { verb: 'refine', resume: true }, {
      runtime: 'kimi', projectDir: cached(), handoff: { kind: 'execution', action: 'runtime' },
    })
    assert.equal(job.outcome, 'failed')
    assert.match(job.reason!, /目标运行工具已不可用/)
    assert.equal(planned.length, 0)
  })

  it('creates the card from the task, refines it, and reports the card, its question and the reply', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: { result: 'Planned two tiers.', question: 'Which billing period leads?' } })
    const job = await flowJob('j1', { verb: 'create' }, { number: 12 })
    assert.equal(job.outcome, 'done', job.reason)
    const create = calls().find((c) => c[0] === 'raw' && c[1] === 'create')!
    assert.deepEqual(create.slice(0, 6), ['raw', 'create', '--title', 'Pricing page', '--studio', 'coding'])
    assert.deepEqual(create.slice(create.indexOf('--id'), create.indexOf('--id') + 2), ['--id', '12'])
    assert.equal(fs.readFileSync(path.join(board(), '.fake', 'task-env'), 'utf8'), 'task_1')
    assert.equal(runtimeFor(12).harness, 'claude-code')
    assert.equal(runtimeFor(12).settings.model, undefined)
    assert.deepEqual(cardCalls(), [`card refine 12 --follow --events --json --board ${board()}`])
    assert.deepEqual(flowReport(job), {
      reply: 'Planned two tiers.',
      card: 12,
      review: { question: 'Which billing period leads?', options: ['Monthly', 'Yearly'], position: 2 },
    })
    const file = path.join(board(), 'todo', '12-pricing-page.md')
    assert.equal(cloud.file('todo/12-pricing-page.md'), fs.readFileSync(file, 'utf8'))
    assert.match(cloud.file('todo/12-pricing-page.md')!, /^---\ntitle: Pricing page\n[\s\S]*Two tiers, monthly and yearly\./)
    assert.match(job.events.map((e) => e.text).join(''), /working on #12/)
    assert.doesNotMatch(job.events.map((e) => e.text).join(''), /"ok":/)
    assert.deepEqual(job.events.find((e) => e.kind === 'message')?.data?.text, 'Read #12.')
    assert.equal(fs.readFileSync(path.join(board(), '.fake', 'agent-board'), 'utf8'), board())
    assert.equal(spawnSync('git', ['-C', cached(), 'log', '--oneline'], { encoding: 'utf8' }).stdout.trim().split('\n').length, 1)
  })

  it('sends a new card to Cloud before planning it, so another task’s pull keeps it (#575)', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: { refuse: 'stopped' } })
    const job = await flowJob('j1', { verb: 'create' })
    assert.equal(job.outcome, 'failed')
    assert.match(cloud.file('todo/2-pricing-page.md') ?? '', /^---\ntitle: Pricing page\n/)
  })

  it('cleans managed skills before runs without requiring a replacement', async () => {
    await flowJob('j1', { verb: 'create' })
    const dir = path.join(cached(), '.claude/skills/kanban')
    assert.equal(fs.existsSync(dir), false)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '<!-- ai4kanban managed -->\nOld skill')
    const job = await flowJob('j2', { verb: 'refine' })
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(fs.existsSync(dir), false)
    assert.equal((await flowJob('j3', { verb: 'refine' })).outcome, 'done')
    assert.equal(fs.existsSync(dir), false)
  })

  it('starts tasks with empty or dangling legacy skills and when cleanup is denied', async () => {
    await flowJob('j1', { verb: 'create' })
    const dir = path.join(cached(), '.claude/skills/kanban')
    fs.mkdirSync(dir, { recursive: true })
    assert.equal((await flowJob('j2', { verb: 'refine' })).outcome, 'done')
    fs.rmdirSync(dir)
    fs.symlinkSync(path.join(cached(), 'missing-skill'), dir)
    assert.equal((await flowJob('j3', { verb: 'refine' })).outcome, 'done')
    assert.ok(fs.lstatSync(dir).isSymbolicLink())
    fs.unlinkSync(dir)
    fs.mkdirSync(dir)
    const file = path.join(dir, 'SKILL.md')
    fs.writeFileSync(file, '<!-- ai4kanban managed -->')
    const unlink = fs.unlinkSync
    const denied = mock.method(fs, 'unlinkSync', (target: fs.PathLike) => {
      if (target === file) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      unlink(target)
    })
    try {
      const job = await flowJob('j4', { verb: 'refine' })
      assert.equal(job.outcome, 'done', job.reason)
      assert.ok(fs.existsSync(file))
    } finally { denied.mock.restore() }
  })

  it('implements an explicit empty review plan once and reports delivery (#818)', async () => {
    const taskReview = { plan: [], stages: [], revision: 0 }
    cloud.task.review = taskReview
    const job = await flowJob('j818', { verb: 'create', review_stages: [] }, { taskReview })
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.report?.deliveryCompleted, true)
    assert.equal(job.report?.deliveryId, 'd1')
    assert.deepEqual(cardCalls(), [`card implement 2 --follow --events --json --board ${board()}`])
  })

  it('syncs the results of a direct build that exits without a delivery record (#918)', async () => {
    const taskReview = { plan: [], stages: [], revision: 0 }
    cloud.task.review = taskReview
    process.env.FAKE_AKB = JSON.stringify({ implement: { delivery: null, writes: { 'memory/progress.md': 'Saved progress.' } } })
    const job = await flowJob('j918', { verb: 'create', review_stages: [] }, { taskReview })
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.report?.deliveryCompleted, true)
    assert.equal(job.report?.deliveryDirect, true)
    assert.match(cloud.file('todo/2-pricing-page.md')!, /implement$/m)
    assert.equal(cloud.file('memory/progress.md'), 'Saved progress.')
    assert.equal(cardCalls().length, 1)
  })

  const stagePlan = [
    { id: 'a', after: [], previews: [] },
    { id: 'b', after: ['a'], previews: ['ui-design'] },
    { id: 'c', after: [], previews: ['api-docs'] },
  ]

  const makeReview = (plan: NonNullable<FakeJob['taskReview']>['plan'], stages: NonNullable<FakeJob['taskReview']>['stages'] = []) =>
    ({ plan, stages, revision: 3 })

  const readyCard = '---\ntitle: Pricing\nstudio: coding\nstatus: ready\nquestions: []\n---\n'

  const available = { id: 'b', status: 'available' as const, revision: 3, snapshot: null }

  it('starts planning for an undecided review', async () => {
    const taskReview = makeReview(null)
    cloud.task.review = taskReview
    const planning = await flowJob('undecided', { verb: 'create', review_stages: [] }, { taskReview })
    assert.equal(planning.outcome, 'done', planning.reason)
    assert.deepEqual(cardCalls(), [`card refine 2 --follow --events --json --board ${board()}`])
  })

  it('keeps a planning job from starting work on a newly assigned review plan', async () => {
    const taskReview = makeReview(null)
    cloud.rejections = { tasks: [{ id: 'task_9', number: 9, title: 'Mobile app', request: '', reason: 'never', cancelled_at: '2026-10-20T09:00:00.000Z' }], triage: [] }
    cloud.task.review = makeReview(stagePlan, [available])
    const job = await flowJob('reassigned', { verb: 'create', review_stages: [] }, { taskReview })
    assert.equal(job.outcome, 'failed')
    assert.match(job.reason ?? '', /Review authorization changed/)
    assert.ok(!calls().some(c => c[0] === 'review-dismissals'))
    assert.deepEqual(cardCalls(), [])
  })

  it('continues the assigned stage on a ready card using the latest review and original assignment', async () => {
    cloud.put({ 'todo/2-pricing.md': readyCard })
    const approved = { id: 'a', status: 'approved' as const, revision: 3, snapshot: {} }
    const taskReview = makeReview(stagePlan, [approved, available, { ...available, id: 'c' }])
    cloud.task.review = { ...taskReview, revision: 4, stages: [approved, available, { ...available, id: 'c', status: 'approved', revision: 4, snapshot: {} }] }
    const job = await flowJob('assigned', { verb: 'refine', resume: true, review_stages: ['b'], review_revision: 3 }, { taskReview })
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(cardCalls(), [`card refine 2 --follow --events --json --board ${board()}`])
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(board(), '.fake/review-context.json'), 'utf8')), {
      review: JSON.parse(JSON.stringify(agentReview(cloud.task.review!))), assigned: ['b'],
    })
  })

  it('runs the dispatched stage when a newer draft changes its review prerequisites', async () => {
    cloud.put({ 'todo/2-pricing.md': readyCard })
    const approved = { id: 'a', status: 'approved' as const, revision: 3, snapshot: {} }
    const taskReview = makeReview(stagePlan, [approved, available])
    cloud.task.review = { ...taskReview, revision: 4, stages: [
      { ...approved, status: 'available', revision: 4, snapshot: null },
      { ...available, status: 'blocked', revision: 4 },
    ] }
    const job = await flowJob('draft-updated', { verb: 'refine', review_stages: ['b'], review_revision: 3 }, {
      taskReview, reviewAtDispatch: true,
    })
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(cardCalls(), [`card refine 2 --follow --events --json --board ${board()}`])
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(board(), '.fake/review-context.json'), 'utf8')), {
      review: JSON.parse(JSON.stringify(agentReview(taskReview))), assigned: ['b'],
    })
  })

  for (const status of ['blocked', 'available'] as const) {
    it(`refuses execution when an assigned stage was revised to ${status} before launch`, async () => {
      cloud.put({ 'todo/2-pricing.md': readyCard })
      const taskReview = makeReview(stagePlan, [available])
      cloud.task.review = { ...taskReview, revision: 4, stages: [{ ...available, status, revision: 4 }] }
      const job = await flowJob('revoked', { verb: 'refine', review_stages: ['b'], review_revision: 3 }, { taskReview })
      assert.equal(job.outcome, 'failed')
      assert.match(job.reason ?? '', /authorization changed/)
      assert.equal(job.report?.processesStopped, true)
      assert.equal(job.finishedLogEnded, true)
      assert.deepEqual(cardCalls(), [])
    })
  }

  it('checks the delivery grant before resuming the CLI delivery', async () => {
    cloud.put({ 'todo/2-pricing.md': readyCard })
    const taskReview = makeReview(stagePlan, stagePlan.map(n => ({ ...available, id: n.id, status: 'approved', snapshot: {} })))
    cloud.task.review = { ...taskReview, revision: 4, stages: [taskReview.stages[0]!, { ...available, revision: 4 }, taskReview.stages[2]!] }
    const job = await flowJob('revoked-delivery', { verb: 'implement', resume: true, review_stages: [] }, { taskReview })
    assert.equal(job.outcome, 'failed')
    assert.match(job.reason ?? '', /Finish the agreed review stages/)
    assert.ok(!calls().some(c => c[0] === 'delivery' && c[1] === 'resume'))
    assert.deepEqual(cardCalls(), [])
  })

  it('stages separate frozen versions for a custom Studio through delivery and resume', async () => {
    useCustomStudio()
    const flow = { studio: 'wf_custom', verb: 'implement', review_stages: [] }
    const src = 'asset:pages/screen.html'
    const alternate = 'asset:pages/mobile.html'
    const css = 'asset:styles/main.css'
    const theme = 'asset:styles/theme/colors.css'
    const image = 'asset:images/cover%20photo.svg'
    const legacyImage = '.assets/2/images/cover photo.svg'
    const body = `<Asset src="${src}" device="desktop" variants='{"Mobile":"${alternate}"}' />`
    const pins = (version: number | undefined) => ({
      [src]: { artifact: 'art_page', version: 1 },
      [alternate]: { artifact: 'art_mobile', version: 1 },
      [css]: { artifact: 'art_css', version: 1 },
      [theme]: { artifact: 'art_theme', version: 1 },
      [image]: { artifact: 'art_image', version },
    })
    const taskReviewAt = (revision: number, version: number | undefined) => ({
      ...makeReview([{ id: 'first', after: [], previews: ['legacy-output'] }, { id: 'second', after: ['first'], previews: ['custom-output'] }], [
        { id: 'first', status: 'approved', revision: 2, snapshot: {
          body: `<Preview id="legacy-output">\n<Asset src="${legacyImage}" />\n</Preview>`,
          previews: [{ id: 'legacy-output', assets: { [legacyImage]: pins(2)[image] } }],
        } },
        { id: 'second', status: 'approved', revision, snapshot: {
          evidence: { content: { 'custom-output': { body } }, dependencies: pins(version) },
        } },
      ]), revision,
    })
    const taskReview = taskReviewAt(3, 1)
    for (const [id, versions] of Object.entries({
      art_page: ['<link rel="stylesheet" href="art_css"><img src="../images/cover photo.svg#detail">', 'Draft HTML'],
      art_mobile: ['<img src="art_image">'],
      art_css: ['@import "art_theme";', 'Draft CSS'],
      art_theme: ['body { background-image: url(art_image); }', 'Draft theme'],
      art_image: ['Approved image', 'Earlier approval', 'Approved again'],
    })) cloud.task.artifacts.set(id, versions.map(text => Buffer.from(text)))
    cloud.task.previewInputs = {
      sections: { 'custom-output': { body: 'Unapproved draft', sources: [src] } },
      assets: { ...pins(2), [src]: { artifact: 'art_page', version: 2 }, [css]: { artifact: 'art_css', version: 2 } },
    }
    cloud.task.review = taskReview
    cloud.put({ 'todo/2-pricing.md': readyCard })
    process.env.FAKE_AKB = JSON.stringify({ implement: { failed: 'Interrupted', delivery: { id: 'd1' } } })
    const failed = await flowJob('approved-start', flow, { taskReview })
    assert.equal(failed.outcome, 'failed')
    const staged = () => JSON.parse(fs.readFileSync(path.join(board(), '.fake/saved-previews.json'), 'utf8'))
    const check = (revision: number, approvedImage: string) => {
      const { files, directory } = staged()
      const manifest = files['previews.md']
      assert.match(manifest, /first · approved · legacy-output/)
      assert.match(manifest, /second · approved · custom-output/)
      assert.doesNotMatch(manifest, /Unapproved draft/)
      delete files['previews.md']
      const stable = path.join(projectStateDir(board()), 'assets/2/images/cover photo.svg')
      assert.equal(fs.readFileSync(stable, 'utf8'), 'Earlier approval')
      const first = manifest.split('## second')[0]!
      assert.match(first, /art_image, version 2/)
      assert.ok(first.includes(stable) || files['1/1-cover photo.svg'] === 'Earlier approval')
      if (revision === 3) assert.match(first, /local file:/)
      const contents = (name: string) => Object.entries(files).find(([file]) => file.startsWith('2/') && file.endsWith(name))?.[1]
      assert.equal(contents('cover photo.svg'), approvedImage)
      assert.match(String(contents('screen.html')), /rel="stylesheet" href="\d+-main.css".*src="\d+-cover%20photo.svg#detail"/)
      assert.match(String(contents('main.css')), /@import "\d+-colors.css"/)
      assert.match(String(contents('colors.css')), /url\(\d+-cover%20photo.svg\)/)
      assert.match(String(contents('mobile.html')), /src="\d+-cover%20photo.svg"/)
      assert.equal(fs.existsSync(directory), false)
    }
    check(3, 'Approved image')

    fs.writeFileSync(path.join(board(), '.fake/runs.json'), JSON.stringify([{
      sessionId: 'old-build', cardId: 2, action: 'implement', status: 'stopped',
      deliveryId: 'd1', resumeId: 'original-thread', startedAt: Date.now() - 1000, endedAt: Date.now(),
    }]))
    const before = calls().filter(c => c[0] === 'delivery' && c[1] === 'resume').length
    for (const version of [undefined, 4]) {
      cloud.task.review = taskReviewAt(6, version)
      const missing = await flowJob(`missing-approved-file-${version}`, { ...flow, resume: true }, { taskReview })
      assert.equal(missing.outcome, 'failed')
      assert.ok(missing.reason?.includes(image), missing.reason)
      assert.match(missing.reason ?? '', version ? /version 4/ : /invalid saved review evidence/)
    }
    cloud.task.review = { ...taskReview, revision: 7, stages: [
      taskReview.stages[0]!, { id: 'second', status: 'available', revision: 7, snapshot: null },
    ] }
    const revoked = await flowJob('revoked', { ...flow, resume: true }, { taskReview })
    assert.equal(revoked.outcome, 'failed')
    assert.match(revoked.reason ?? '', /Finish the agreed review stages/)
    assert.equal(calls().filter(c => c[0] === 'delivery' && c[1] === 'resume').length, before)

    cloud.task.previewInputs = undefined
    process.env.FAKE_AKB = '{}'
    cloud.task.review = taskReviewAt(8, 1)
    const resumed = await flowJob('approved-resume', { ...flow, resume: true }, { taskReview })
    assert.equal(resumed.outcome, 'done', resumed.reason)
    check(8, 'Approved image')
    assert.ok(calls().some(c => c[0] === 'run' && c[1] === 'resume'), 'the original run was resumed')

    cloud.task.review = taskReviewAt(9, 3)
    const replacement = await flowJob('reapproved', flow, { taskReview })
    assert.equal(replacement.outcome, 'done', replacement.reason)
    check(9, 'Approved again')
    assert.ok(!cloud.log.some(request => /\/art_(page|css|theme)\/versions\/2/.test(request)))
  })

  it('uses the last synced body and exact asset pins for an unreviewed direct build', async () => {
    useCustomStudio()
    const src = '.assets/2/contract.md'
    const taskReview = makeReview([])
    const body = `<Asset src="${src}" label="New contract" />`
    cloud.task.artifacts.set('art_1', ['previous', 'saved after chat', 'unselected draft'].map(text => Buffer.from(text)))
    cloud.task.review = taskReview
    cloud.task.previewInputs = {
      body: 'Saved requirements',
      sections: { 'custom-output': { body, sources: [src] } },
      assets: { [src]: { artifact: 'art_1', version: 2 } },
    }
    cloud.put({ 'todo/2-pricing.md': readyCard, 'assets/task_1.json': JSON.stringify(cloud.task.previewInputs.assets) })
    process.env.FAKE_AKB = JSON.stringify({ implement: { delivery: null } })
    const job = await flowJob('saved-preview', { studio: 'wf_custom', verb: 'implement', review_stages: [] }, { taskReview })
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.report?.deliveryDirect, true)
    const staged = JSON.parse(fs.readFileSync(path.join(board(), '.fake/saved-previews.json'), 'utf8'))
    assert.equal(fs.readFileSync(path.join(projectStateDir(board()), 'assets/2/contract.md'), 'utf8'), 'saved after chat')
    assert.deepEqual(Object.keys(staged.files), ['previews.md'])
    assert.match(staged.files['previews.md'], /art_1, version 2 · local file:/)
    assert.match(staged.files['previews.md'], /Saved requirements/)
    assert.match(staged.files['previews.md'], /New contract/)
    assert.ok(!cloud.log.some(request => /\/art_1\/versions\/[13](?:\/|$)/.test(request)))
    assert.equal(fs.existsSync(staged.directory), false)
  })

  it('downloads missing materials on another computer and launches with partial download diagnostics (#1030)', async () => {
    const page = '.assets/2/page.html'
    const image = '.assets/2/image.svg'
    const broken = '.assets/2/broken.md'
    const noVersion = '.assets/2/latest.md'
    const unrecorded = '.assets/2/unrecorded.png'
    const body = `<Asset src="${page}" />\n<Asset src="${broken}" />\n<Asset src="${noVersion}" />`
    const assets = {
      [page]: { artifact: 'art_page', version: 1, dependencies: [image, unrecorded] },
      [image]: { artifact: 'art_image', version: 1 },
      [broken]: { artifact: 'art_broken', version: 1 },
      [noVersion]: { artifact: 'art_latest' },
    }
    const taskReview = makeReview([{ id: 'content', after: [], previews: ['api-docs'] }], [{
      id: 'content', status: 'approved', revision: 3, snapshot: { evidence: { content: { 'api-docs': { body } }, assets } },
    }])
    cloud.task.artifacts.set('art_page', [Buffer.from('<img src="art_image"><img src="unrecorded.png">')])
    cloud.task.artifacts.set('art_image', [Buffer.from('<svg/>')])
    cloud.task.artifacts.set('art_latest', [Buffer.from('Available latest material')])
    cloud.types.set('art_page', 'html')
    cloud.failArtifactRead = 'art_broken'
    cloud.task.previewInputs = { sections: { 'api-docs': { body, sources: Object.keys(assets) } }, assets }
    cloud.task.review = taskReview
    cloud.put({ 'todo/2-pricing.md': readyCard, 'assets/task_1.json': JSON.stringify(assets) })
    const job = await flowJob('partial-materials', { verb: 'implement', review_stages: [] }, { taskReview })
    assert.equal(job.outcome, 'done', job.reason)
    const saved = JSON.parse(fs.readFileSync(path.join(board(), '.fake/saved-previews.json'), 'utf8')).files['previews.md']
    assert.match(saved, /broken.md.*unavailable.*类型读取失败/)
    assert.match(saved, /latest.md.*local file:.*Missing approved asset version/)
    assert.match(saved, /unrecorded.png.*unavailable.*Missing asset record/)
    const local = path.join(projectStateDir(board()), 'assets/2')
    assert.equal(fs.readFileSync(path.join(local, 'page.html'), 'utf8'), '<img src="image.svg"><img src="unrecorded.png">')
    assert.equal(fs.readFileSync(path.join(local, 'image.svg'), 'utf8'), '<svg/>')
    assert.equal(fs.readFileSync(path.join(local, 'latest.md'), 'utf8'), 'Available latest material')
    assert.equal(cloud.log.filter(request => request === 'GET /v1/artifacts/art_broken').length, 1)
  })

  it('publishes a completed flow after the lease lapses without starting the Agent again (#892)', async () => {
    const card = 'todo/2-pricing.md'
    cloud.put({ [card]: readyCard })
    const flow = { studio: 'wf_builtin_coding', verb: 'refine', resume: true }
    const source = cloud.dispatch({ id: 'prior-publication', state: 'finished', task: 'task_1', project: 'prj_1', number: 2, flow })
    const ws = openTaskFolder({ task: source.task, project: source.project, number: source.number }, source.projectDir)
    assert.ok((await pull(ws, MACHINE)).ok)
    fs.appendFileSync(path.join(ws.board, card), '\nSaved by the original flow.\n')
    saveCheckpoint(source.id, { pending: [], started: true, completed: { outcome: 'done', report: { card: 2, reply: 'Original reply' } } })
    const successor = cloud.dispatch({ id: 'continue-publication', task: source.task, project: source.project, number: source.number,
      flow: { ...flow, sync_recovery_of: source.id } })
    start()
    await until(() => successor.state === 'finished')
    assert.equal(successor.outcome, 'done', successor.reason)
    assert.equal(successor.report?.reply, 'Original reply')
    assert.match(cloud.file(card)!, /Saved by the original flow/)
    assert.ok(calls().every(call => call[0] === 'run' && call[1] === 'list'))
  })

  for (const outcome of ['done', 'failed', 'stopped'] as const) it(`continues a completed delivery at conflicted writeback (${outcome}) (#1048)`, async () => {
    const card = 'todo/2-pricing.md'
    const archive = '.archive/2-pricing.md'
    const legacy = '.archive/818-goal-task.md'
    const original = readyCard.replace('questions:', 'priority: med\nblocked_by: []\nrelated: []\nmodules: []\nquestions:') + '\nOriginal scope.\n'
    const landed = original.replace('questions:', 'archived: 2026-11-22\nquestions:') + '\nSaved delivery.\n\n<Asset src=".assets/2/delivery.txt" />\n'
    const legacyCard = original.replace('questions:', 'archived: 2026-11-17\npreview_approved: true\nquestions:') +
      '\n## By `prompt-writer` agent\n\nApproved historical result.\n\n<!-- agent -->\n\n## Scope\n\nLocal history.\n'
    cloud.put({ 'config.md': '# Board\n', [card]: original })
    const flow = { studio: 'wf_builtin_coding', verb: 'implement', resume: true } as const
    const scope = { task: 'task_1', project: 'prj_1', number: 2, runtime: 'claude-code' as const, flow }
    const prior = cloud.dispatch({ ...scope, id: 'original-delivery', state: 'finished' })
    const ws = openTaskFolder(scope, prior.projectDir)
    assert.ok((await pull(ws, MACHINE)).ok)
    fs.mkdirSync(path.join(ws.board, '.fake'), { recursive: true })
    fs.mkdirSync(path.join(ws.board, '.archive'), { recursive: true })
    fs.writeFileSync(path.join(ws.board, '.fake/runs.json'), JSON.stringify([{
      cardId: 2, sessionId: 'original-thread', action: 'implement', status: 'done', deliveryId: 'd1', harness: 'claude-code',
      startedAt: Date.now() - 1000, costUsd: 0.5, sessionCostUsd: 0.5,
    }, { cardId: 2, sessionId: 'different-thread', action: 'implement', status: 'done', deliveryId: 'd2', harness: 'claude-code',
      startedAt: Date.now() - 500 }]))
    const commit = 'c'.repeat(40)
    const report = { card: 2, deliveryCompleted: true, deliveryId: 'd1', landing: { commit, branch: 'main' }, costUsd: 0.5,
      runtimeCosts: [{ runtimeId: null, runtime: 'claude-code', costUsd: 0.5 }] }
    if (outcome === 'done') {
      saveCheckpoint(prior.id, { pending: [], started: true, completed: { outcome: 'done', report } })
    } else {
      process.env.FAKE_AKB = JSON.stringify({ reconcile: { kind: 'completed', deliveryId: 'd1', commit, branch: 'main' } })
    }
    fs.rmSync(path.join(ws.board, card))
    fs.writeFileSync(path.join(ws.board, archive), landed)
    fs.writeFileSync(path.join(ws.board, legacy), legacyCard)
    const assetFolder = path.join(projectStateDir(ws.board), 'assets/2')
    fs.mkdirSync(assetFolder, { recursive: true })
    fs.writeFileSync(path.join(assetFolder, 'delivery.txt'), 'Delivered bytes')
    cloud.put({ [card]: original.replace('Original scope.', 'Cloud edit to scope.') })
    assert.equal((await pullChanges(ws)).ok, false)
    assert.equal(pendingConflicts(ws.board)[0]!.files.find(f => f.path === legacy)?.local.content, legacyCard)
    cloud.previewProblems = (file, content) => taskPreviewProblems(content, ['prompts'], [], file)
    const script = `
      const fs = require('fs'), cp = require('child_process'), path = require('path'), assert = require('assert/strict')
      const board = process.env.AI4KANBAN_BOARD
      const cli = ${JSON.stringify(path.join(process.env.RUNNER_DIST!, 'akb/bin/ai4kanban.mjs'))}
      const run = (...args) => cp.spawnSync(process.execPath, [cli, '--board', board, 'raw', 'conflict', ...args, '--json'], {encoding:'utf8'})
      const id = JSON.parse(run('list').stdout).conflicts[0].id
      const show = () => JSON.parse(run('show', id).stdout).conflict
      const file = path.join(board, '.sync/writeback-draft.json')
      const resolve = (shown, files) => {
        fs.writeFileSync(file, JSON.stringify({ files }))
        return run('resolve', id, '--expect', shown.revision, '--file', file)
      }
      const first = show()
      const current = first.files.find(f => f.path === ${JSON.stringify(card)})
      const archived = first.files.find(f => f.path === ${JSON.stringify(archive)})
      const proposed = archived.local.content.replace('Original scope.', current.remote.content.split('\\n').find(l => l.includes('Cloud edit')))
      const deletion = { path: current.path, content: null }
      fs.writeFileSync(path.join(board, archived.path), proposed)
      assert.notEqual(resolve(show(), [deletion]).status, 0)
      const content = proposed + (${JSON.stringify(outcome)} === 'done' ? '' : '\\n<Preview id="bad">\\n')
      const sent = resolve(show(), [deletion, { path: archived.path, content }])
      assert.equal(sent.status, ${outcome === 'done' ? 0 : 1}, sent.stdout + sent.stderr)
      fs.writeFileSync(path.join(board, '.sync/writeback-attempted'), '')
      ${outcome === 'stopped' ? "setInterval(() => {}, 50)" : ''}
    `
    start('', {
      authorize: async job => canKeepFlow(job),
      plan: (runtime, prompt, cwd, resume) => {
        const plan = fakeRuntime(script)(runtime, prompt, cwd, resume)
        return { ...plan, renderer: { ...plan.renderer!, costUsd: () => 0.75 } }
      },
    })
    const historical = { ...flow, sync_recovery_of: prior.id, historical_recovery: true }
    const job = cloud.dispatch({ ...scope, id: crypto.randomUUID(), flow: outcome === 'done' ? historical : flow })
    if (outcome === 'stopped') {
      await until(() => fs.existsSync(path.join(ws.board, '.sync/writeback-attempted')))
      job.stop = true
    }
    await until(() => job.state === 'finished', 10_000)
    assert.equal(job.outcome, outcome, [job.reason, ...job.events.map(e => e.text)].join('\n'))
    assert.deepEqual(planned.map(plan => plan.resume), outcome === 'failed' ? ['original-thread', 'original-thread'] : ['original-thread'])
    assert.match(planned[0]!.prompt, /Board content conflicts require explicit resolution/)
    assert.match(planned[0]!.prompt, /delivery is complete/)
    assert.deepEqual(cardCalls(), [])
    assert.equal(job.report?.deliveryId, 'd1')
    assert.deepEqual(job.report?.landing, { commit, branch: 'main' })
    if (outcome === 'done') {
      assert.equal(job.report?.costUsd, 0.25)
      assert.equal(job.report?.runtimeCosts?.[0]?.costUsd, 0.25)
      assert.equal(cloud.file(card), null)
      assert.match(cloud.file(archive)!, /Cloud edit to scope.[\s\S]*Saved delivery./)
      assert.match(cloud.file(legacy)!, /preview_approved: true[\s\S]*<Preview id="prompts">[\s\S]*Approved historical result.[\s\S]*Local history./)
      const { artifact, version } = JSON.parse(cloud.file('assets/task_1.json')!)['.assets/2/delivery.txt']
      assert.equal(cloud.task.artifacts.get(artifact)?.[version - 1]?.toString(), 'Delivered bytes')
      assert.deepEqual(conflictList(ws.board), [])
    } else {
      const [conflict] = pendingConflicts(ws.board)
      assert.ok(conflict?.draft)
      assert.match(conflict.error!, /Cloud rejected Preview blocks/)
      assert.equal(cloud.file(card), original.replace('Original scope.', 'Cloud edit to scope.'))
      assert.equal(cloud.file(archive), null)
      if (outcome === 'failed') {
        assert.match(planned[1]!.prompt, /Cloud rejected Preview blocks/)
        assert.ok(job.events.some(e => e.kind === 'error' && String(e.data?.text).includes('Cloud rejected Preview blocks')))
      }
    }
  })

  it('recovers the original build and usage after a lapsed job saved the wrong card’s result (#1248)', async () => {
    const card = 'todo/2-pricing.md'
    cloud.put({ [card]: readyCard })
    const flow = { studio: 'wf_builtin_coding', verb: 'implement' } as const
    const scope = { task: 'task_1', project: 'prj_1', number: 2, flow }
    const prior = cloud.dispatch({ ...scope, id: 'lapsed-build', state: 'finished' })
    const ws = openTaskFolder(scope, prior.projectDir)
    assert.ok((await pull(ws, MACHINE)).ok)
    const run = { cardId: 2, cloudExecution: { job: prior.id, machine: MACHINE }, deliveryId: 'd1', startedAt: Date.now() - 1000 }
    fs.mkdirSync(path.join(ws.board, '.fake'), { recursive: true })
    fs.writeFileSync(path.join(ws.board, '.fake/runs.json'), JSON.stringify([
      { ...run, sessionId: 'original-implement', action: 'implement', status: 'done', costUsd: 0.25 },
      { ...run, sessionId: 'original-conflict', startedAt: run.startedAt + 10, action: 'conflict', status: 'interrupted', resumeId: 'original-thread', costUsd: 0.5 },
      { ...run, sessionId: 'other-build', status: 'done', costUsd: 9, cloudExecution: { job: 'other', machine: MACHINE } },
      { ...run, cardId: 3, sessionId: 'foreign-run', startedAt: run.startedAt + 20, status: 'done', resumeId: 'foreign-thread', costUsd: 20 },
    ]))
    saveCheckpoint(prior.id, { pending: ['write'], started: true, completed: { outcome: 'done', report: {
      card: 2, reply: 'Foreign result', session: 'foreign-thread', deliveryId: 'foreign-delivery', costUsd: 20,
    } } })
    process.env.FAKE_AKB = JSON.stringify({ resume: { spent: { costUsd: 0.125 } } })
    const job = cloud.dispatch({ ...scope, id: 'recovered-build', flow: { ...flow, resume: true, sync_recovery_of: prior.id } })
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.report?.session, 'original-thread')
    assert.equal(job.report?.costUsd, 0.875)
    assert.equal(job.report?.deliveryId, 'd1')
    assert.equal(job.report?.reply, 'Continued it.')
    assert.deepEqual(cardCalls(), [])
    assert.ok(!calls().some(c => c[0] === 'delivery' && c[1] === 'resume'))
    assert.ok(calls().some(c => c[0] === 'run' && c[1] === 'resume' && c[2] === 'original-conflict'))
  })

  it('bounds delivery reconciliation and preserves the underlying reason (#1057)', async () => {
    cloud.put({ 'todo/2-pricing.md': readyCard })
    process.env.FAKE_AKB = JSON.stringify({ reconcile: { kind: 'unverified', deliveryId: 'd1', diagnostic: 'Could not read delivery receipts.' } })
    start('', { syncBackoff: () => 0 })
    const job = cloud.dispatch({ id: 'delivery-reconcile-limit', task: 'task_1', project: 'prj_1', number: 2,
      flow: { verb: 'implement', studio: 'wf_builtin_coding' } })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'failed')
    assert.match(job.reason!, /Could not read delivery receipts/)
    assert.equal(job.report?.failure?.pauseReason, 'limit')
    assert.equal(job.report?.failure?.safeToRetry, true)
    assert.equal(calls().filter(c => c[0] === 'delivery' && c[1] === 'reconcile').length, 5)
    assert.deepEqual(cardCalls(), [])
  })

  it('reports the original failure and spend after a restart with exhausted retries (#947)', async () => {
    cloud.put({ 'todo/2-pricing.md': readyCard })
    const flow = { studio: 'wf_builtin_coding', verb: 'implement' } as const
    const scope = { task: 'task_1', project: 'prj_1', number: 2, flow }
    const source = cloud.dispatch({ ...scope, id: 'exhausted-build', state: 'finished' })
    const ws = openTaskFolder(scope, source.projectDir)
    assert.ok((await pull(ws, MACHINE)).ok)
    fs.mkdirSync(path.join(ws.board, '.fake'), { recursive: true })
    fs.writeFileSync(path.join(ws.board, '.fake/runs.json'), JSON.stringify([{
      cardId: 2, cloudExecution: { job: source.id, machine: MACHINE }, action: 'implement',
      sessionId: 'original-run', resumeId: 'original-thread', status: 'error', startedAt: Date.now() - 1000,
      retryPause: 'limit', failure: { code: 'service_overloaded', source: 'runtime', summary: 'Service returned 503.' }, costUsd: 0.25,
    }]))
    const job = cloud.dispatch({ ...scope, id: 'recovered-exhausted', flow: { ...flow, sync_recovery_of: source.id } })
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'failed')
    assert.equal(job.reason, 'task_retry_exhausted: Service returned 503.')
    assert.equal(job.report?.costUsd, 0.25)
    assert.ok(!calls().some(c => c[0] === 'card' || c[0] === 'run' && c[1] === 'resume'))
  })

  it('builds a card made unplanned straight after writing it (#2139)', async () => {
    cloud.rejections = { tasks: [{ id: 'task_9', number: 9, title: 'Mobile app', request: '', reason: 'never', cancelled_at: '2026-10-20T09:00:00.000Z' }], triage: [] }
    const job = await flowJob('j1', { verb: 'create', skip_plan: true })
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(cardCalls(), [`card implement 2 --follow --events --json --board ${board()}`])
    assert.deepEqual(cloud.reviewed, [], 'an unplanned build ran the rejection review')
  })

  it('sends each item the job added up with the board, from its task, on its studio (#2107)', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: { propose: 'Own idea', studio: 'wf-own1' } })
    assert.equal((await flowJob('j1', { verb: 'create' })).outcome, 'done')
    assert.match(cloud.file('triage/proposed.md')!, /\nstudio: wf-own1\n[\s\S]*source_task: task_1\n/)
    cloud.put({ 'triage/proposed.md': null })
    process.env.FAKE_AKB = JSON.stringify({ refine: { propose: 'Plain idea', studio: '' } })
    assert.equal((await flowJob('j2', { verb: 'create' })).outcome, 'done')
    assert.match(cloud.file('triage/proposed.md')!, /title: Plain idea\n[\s\S]*source_task: task_1\nstudio: coding\n---/)
    assert.ok(!cloud.log.some((l) => l.includes('/v1/triage')), 'triage went to Cloud on its own')
  })

  it('reports what the runs this job started spent, not the card\'s earlier ones', async () => {
    const spent = { usage: { input: 10, cacheCreation: 1, cacheRead: 100, output: 5 }, costUsd: 0.25 }
    process.env.FAKE_AKB = JSON.stringify({ refine: { spent }, implement: { spent } })
    await flowJob('j1', { verb: 'create' })
    await new Promise((r) => setTimeout(r, 5))
    const job = await flowJob('j2', { verb: 'implement', card: 2 })
    assert.deepEqual(job.report?.usage, { input: 20, cacheCreation: 2, cacheRead: 200, output: 10 })
    assert.equal(job.report?.costUsd, 0.5)
  })

  it('marks partial costs without turning a known zero into unknown (#689)', () => {
    const job = { runtime: 'codex' as const }
    assert.equal(spentBy([{ sessionId: 'a', costUsd: 0 }], job).costIncomplete, undefined)
    const partial = spentBy([{ sessionId: 'a', costUsd: 0 }, { sessionId: 'b' }], job)
    assert.equal(partial.costUsd, 0)
    assert.equal(partial.costIncomplete, true)
  })
})
