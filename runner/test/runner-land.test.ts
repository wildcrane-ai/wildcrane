import { stampLeavingIn } from '../../cli/src/lib/leaving'
import { conflictList } from '../../cli/src/lib/shared/board-conflicts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { readCheckpoint } from '../src/recovery'
import { runnerHome } from '../src/home'
import { until } from './fake-cloud'
import { cloud, cached, start, flowFixture, useCustomStudio } from './runner-harness'

describe('flow jobs (#2020)', () => {
  const { board, typed, calls, runtimeFor, cardCalls, flowJob } = flowFixture()

  it('lands an in-place implementation using the original run and rejects a mismatched checkout', async () => {
    const todo = 'todo/2-pricing.md'
    cloud.put({ 'config.md': '# Board\n', [todo]: '---\ntitle: Pricing\nstudio: coding\nquestions: []\n---\n' })
    const project = cached()
    fs.mkdirSync(project, { recursive: true })
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', project, ...args], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trimEnd()
    }
    git('init', '-qb', 'main')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'Task result')
    const commit = git('rev-parse', 'HEAD')
    const flow = { verb: 'implement', card: 2 }
    process.env.FAKE_AKB = JSON.stringify({ implement: { trackExecution: true, cwd: project,
      result: 'Passed pricing checks.', delivery: { id: 'd1', status: 'active' } } })
    const built = await flowJob('implement-in-place', { ...flow, phase: 'implement' })
    assert.deepEqual(built.report?.landReady, { deliveryId: 'd1' })

    const land = { ...flow, phase: 'land' as const, land_from: built.id, delivery_id: 'd1' }
    const saved = { kind: 'resumable', deliveryId: 'd1', status: 'active', worktree: '.', branch: 'main' }
    process.env.FAKE_AKB = JSON.stringify({ reconcile: saved })
    git('switch', '-qc', 'another-branch')
    const wrong = await flowJob('land-wrong-branch', land)
    assert.equal(wrong.outcome, 'failed')
    assert.match(wrong.reason ?? '', /could not be verified/)
    assert.equal(cardCalls().length, 1)
    git('switch', '-q', 'main')

    fs.rmSync(path.join(board(), '.fake/reconcile-attempts.json'))
    process.env.FAKE_AKB = JSON.stringify({ reconcile: [saved, { kind: 'completed', deliveryId: 'd1', commit, branch: 'main' }],
      implement: { trackExecution: true, delivery: { id: 'd1', status: 'finished' } } })
    const landed = await flowJob('land-in-place', land)
    assert.equal(landed.outcome, 'done', landed.reason)
    assert.deepEqual(landed.report?.landing, { commit, branch: 'main' })
    assert.equal(git('rev-parse', 'HEAD'), commit)
    assert.equal(fs.readFileSync(path.join(board(), '.fake/land-implement-run'), 'utf8'), 'run-implement-1')
  })

  it('hands off saved implementation even if a Preview approval is attached to its job', async () => {
    const todo = 'todo/2-pricing.md'
    cloud.put({ 'config.md': '# Board\n', [todo]: '---\ntitle: Pricing\nstudio: coding\nquestions: []\n---\n' })
    const worktree = '.akb/worktrees/d1/work'
    const work = path.join(cached(), worktree)
    fs.mkdirSync(cached(), { recursive: true })
    const gitIn = (cwd: string, ...args: string[]) => {
      const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trimEnd()
    }
    const git = (...args: string[]) => gitIn(work, ...args)
    const projectGit = (...args: string[]) => gitIn(cached(), ...args)
    const branch = 'akb/d1'
    projectGit('init', '-qb', 'main')
    fs.writeFileSync(path.join(cached(), 'tracked.txt'), 'Base')
    projectGit('add', 'tracked.txt')
    projectGit('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'Base')
    projectGit('worktree', 'add', '-qb', branch, work)
    const base = git('rev-parse', 'HEAD')
    fs.writeFileSync(path.join(work, 'tracked.txt'), 'Modified')
    fs.writeFileSync(path.join(work, 'new.txt'), 'New')
    const dirty = git('status', '--porcelain')
    assert.equal(dirty, ' M tracked.txt\n?? new.txt')

    const flow = { verb: 'implement', review_revision: 1, review_stages: [] }
    const review = { revision: 1, plan: { previews: ['draft'], rule: 'Approve before publishing.' }, stages: [] }
    const gate = path.join(runnerHome(), 'review-1247-gate')
    const active = { kind: 'resumable', deliveryId: 'd1', status: 'active', worktree, branch, base }
    cloud.task.review = review
    process.env.FAKE_AKB = JSON.stringify({ implement: { gates: [gate], trackExecution: true,
      result: 'Preview submitted.', delivery: { id: 'd1', status: 'active' } }, reconcile: [{ kind: 'none' }, active] })
    const built = flowJob('implement-review-1247', { ...flow, phase: 'implement' }, { taskReview: review })
    await until(() => fs.existsSync(path.join(board(), '.fake/agent-board')))
    const stage = { id: 'approval-2', job: 'implement-review-1247', status: 'waiting_review' as const, preview: 'draft', revision: 2,
      snapshot: { evidence: { content: { draft: { body: 'Saved preview.', sources: [] } } } } }
    cloud.task.review = { ...review, revision: 2, stages: [stage] }
    fs.writeFileSync(gate, '')
    const ended = await built
    assert.equal(ended.outcome, 'done', ended.reason)
    assert.deepEqual(ended.report?.landReady, { deliveryId: 'd1' })
    assert.equal(ended.report?.deliveryCompleted, undefined)
    assert.equal(cardCalls().length, 1)
    assert.ok(cloud.file(todo))
    assert.equal(git('status', '--porcelain'), dirty)
  })

  it('finishes Land after its Cloud archive while the local card is still in todo', async () => {
    useCustomStudio()
    await flowJob('prepare-direct-land', { verb: 'create', studio: 'wf_custom' })
    const card = 'todo/2-pricing-page.md'
    const archive = '.archive/2-pricing-page.md'
    const review = { revision: 1, plan: [], stages: [] }
    cloud.task.review = review
    const flow = { verb: 'implement', studio: 'wf_custom', card: 2, review_revision: 1, review_stages: [] }
    process.env.FAKE_AKB = JSON.stringify({
      implement: { trackExecution: true, agentSession: 'direct-implementation', delivery: { id: 'direct', status: 'active' } },
    })
    const built = await flowJob('build-direct-land', { ...flow, phase: 'implement' }, { taskReview: review, sessionKind: 'implement' })
    assert.equal(built.outcome, 'done', built.reason)
    const worktree = '.akb/worktrees/direct/work'
    fs.mkdirSync(path.join(cached(), worktree), { recursive: true })
    fs.mkdirSync(path.join(cached(), worktree, '../base'))
    const gate = path.join(runnerHome(), 'direct-land-gate')
    process.env.FAKE_AKB = JSON.stringify({
      reconcile: [{ kind: 'resumable', deliveryId: 'direct', status: 'active', worktree }, { kind: 'completed', deliveryId: 'direct' }],
      implement: { gates: [gate], trackExecution: true, agentSession: 'direct-land-session',
        keep: {}, delivery: { id: 'direct', status: 'active' } },
    })
    const pending = flowJob('direct-land', { ...flow, phase: 'land', land_from: built.id, delivery_id: 'direct' }, { taskReview: review, sessionKind: 'land' })
    const landJob = cloud.jobs.get('direct-land')!
    await until(() => landJob.state === 'finished' ||
      landJob.events.some(event => event.kind === 'message' && event.data?.text === `Waiting for ${path.basename(gate)}.`), 15_000)
    assert.equal(cloud.jobs.get('direct-land')?.state, 'claimed', cloud.jobs.get('direct-land')?.reason)
    const text = fs.readFileSync(path.join(board(), card), 'utf8') + '\nDelivered in this session.\n'
    fs.writeFileSync(path.join(board(), card), text)
    const content = stampLeavingIn(text, '2026-11-27', null)
    cloud.put({ [card]: null, [archive]: content })
    cloud.taskStatus.task_1 = 'done'
    assert.equal(fs.existsSync(path.join(board(), archive)), false)
    fs.writeFileSync(gate, '')
    const land = await pending
    assert.equal(land.outcome, 'done', land.reason)
    assert.equal(land.report?.processesStopped, true)
    assert.equal(land.report?.archive?.path, archive)
    assert.equal(fs.readFileSync(path.join(board(), archive), 'utf8'), content)
    assert.equal(conflictList(board()).length, 0)
  })

  it('hands off a non-Git Studio, resumes Land for a missing archive, and refreshes a refused archive receipt', async () => {
    useCustomStudio()
    start('', { syncBackoff: () => 400 })
    await flowJob('prepare-land', { verb: 'create', studio: 'wf_custom' })
    const revision = 1
    const review = { revision, plan: [], stages: [] }
    cloud.task.review = review
    const flow = { verb: 'implement', studio: 'wf_custom', card: 2, review_revision: revision, review_stages: [] }
    const worktree = '.akb/worktrees/d1/work'
    fs.mkdirSync(path.join(cached(), worktree), { recursive: true })
    fs.mkdirSync(path.join(cached(), worktree, '../base'))
    process.env.FAKE_AKB = JSON.stringify({
      implement: { trackExecution: true, agentSession: 'implementation-session', result: 'Saved files.', delivery: { id: 'd1', status: 'active' } },
    })
    const built = await flowJob('implement-land', { ...flow, phase: 'implement' }, { taskReview: review, sessionKind: 'implement' })
    assert.equal(built.outcome, 'done', built.reason)
    assert.deepEqual(built.report?.landReady, { deliveryId: 'd1' })
    const runs = JSON.parse(fs.readFileSync(path.join(board(), '.fake/runs.json'), 'utf8')) as
      { sessionId: string; cloudExecution?: { job: string } }[]
    const implementationRun = runs.find(run => run.cloudExecution?.job === built.id)?.sessionId
    assert.ok(implementationRun)
    assert.ok(cloud.file('todo/2-pricing-page.md'))
    assert.equal(cloud.file('.archive/2-pricing-page.md'), null)

    const resumable = { kind: 'resumable', deliveryId: 'd1', status: 'active', worktree }
    process.env.FAKE_AKB = JSON.stringify({
      reconcile: [resumable, { kind: 'completed', deliveryId: 'd1' }],
      implement: { trackExecution: true, agentSession: 'land-session', delivery: { id: 'd1', status: 'active' } },
      resume: { keep: {}, spent: { costUsd: 0.5 } },
    })
    cloud.boardWritesUnavailable = true
    const landing = flowJob('land', { ...flow, phase: 'land', land_from: built.id, delivery_id: 'd1' },
      { taskReview: review, sessionKind: 'land', resume: 'land-session' })
    await until(() => !!readCheckpoint('land')?.syncRetries?.publish || cloud.jobs.get('land')?.state === 'finished', 15_000)
    assert.equal(cloud.jobs.get('land')?.state, 'claimed', cloud.jobs.get('land')?.reason)
    assert.ok(fs.existsSync(path.join(board(), '.archive/2-pricing-page.md')))
    assert.equal(cloud.file('.archive/2-pricing-page.md'), null)
    const archive = '.archive/2-pricing-page.md'
    const staleReceipt = 'The current card and attachment archive versions must be synchronized.'
    let finishAttempts = 0
    cloud.refuseJobFinish = (id, report) => {
      if (id !== 'land') return
      finishAttempts++
      if (finishAttempts === 1) {
        cloud.put({ [archive]: cloud.file(archive)! + '\nCloud edit.\n' })
        return staleReceipt
      }
      if (report?.archive?.seq !== cloud.head) return staleReceipt
    }
    const launches = cardCalls().length
    cloud.boardWritesUnavailable = false
    const landed = await landing
    assert.equal(landed.outcome, 'done', landed.reason)
    assert.equal(landed.report?.archive?.path, '.archive/2-pricing-page.md')
    assert.equal(landed.report?.processesStopped, true)
    assert.equal(finishAttempts, 2)
    assert.equal(cardCalls().length, launches)
    assert.ok(!landed.events.some(e => JSON.stringify(e).includes(staleReceipt) || e.kind === 'error'))
    assert.ok(!landed.report?.retries?.length)
    assert.match(fs.readFileSync(path.join(board(), archive), 'utf8'), /Cloud edit/)
    assert.equal(cloud.file('todo/2-pricing-page.md'), null)
    const resumed = JSON.parse(fs.readFileSync(path.join(board(), '.fake/land-resume.json'), 'utf8'))
    assert.equal(resumed.session, 'land-session')
    assert.equal(resumed.implementationRun, implementationRun)
    assert.ok(cardCalls().some(call => call.includes('implement 2 --session land-session')))
    assert.match(resumed.diagnostic, /before task #2 was archived/)

    const callsBefore = cardCalls().length
    process.env.FAKE_AKB = JSON.stringify({ reconcile: { kind: 'completed', deliveryId: 'd1' } })
    const recovered = await flowJob('land-writeback', { ...flow, phase: 'land', land_from: built.id, delivery_id: 'd1', session_from: landed.id }, { taskReview: review, sessionKind: 'land' })
    assert.equal(recovered.outcome, 'done', recovered.reason)
    assert.deepEqual(recovered.report?.archive, landed.report?.archive)
    assert.equal(recovered.report?.costUsd, undefined)
    assert.equal(cardCalls().length, callsBefore)

    const authorizationChanged = 'Land no longer has review authorization.'
    cloud.refuseJobFinish = (id, report) => id === 'land-review-refused' && report?.archive ? authorizationChanged : undefined
    const refused = await flowJob('land-review-refused', { ...flow, phase: 'land', land_from: built.id, delivery_id: 'd1' },
      { taskReview: review, language: 'en', sessionKind: 'land' })
    assert.equal(refused.outcome, 'failed')
    const action = 'Land review authorization changed. Confirm the current review and resume the task.'
    assert.equal(refused.reason, action)
    assert.ok(refused.events.some(e => e.kind === 'error' && JSON.stringify(e).includes(action)))
    assert.ok(!refused.events.some(e => JSON.stringify(e).includes(authorizationChanged)))
    assert.equal(cardCalls().length, callsBefore)
  })
})
