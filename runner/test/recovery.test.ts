import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { markEnv, runMark } from '../../cli/src/lib/agent/stop'
import type { Flow, Job } from '../src/api'
import { confirmFlowStopped, flowRunEvidence, runFlow, stopFlowRuns, taskSessionMatches, type FlowIo } from '../src/flow'
import { toWire } from '../src/jobs'
import { checkpointEvent, checkpointRecovery, replayable, type Checkpoint } from '../src/recovery'
import { replyPrompt } from '../src/reply-input'
import type { TaskFolder } from '../src/task-folder'

const FAKE_AKB = path.resolve('test/fake-akb.mjs')

test('完成的写入保留副作用标记，未知旧进度不能证明可重放', () => {
  const checkpoint: Checkpoint = { pending: [], effects: false }
  assert.equal(replayable(checkpoint), true)
  checkpointEvent(checkpoint, { kind: 'tool_call', data: { toolCallId: 'write', title: 'write', kind: 'edit', status: 'in_progress' } })
  checkpointEvent(checkpoint, { kind: 'tool_call_update', data: { toolCallId: 'write', status: 'completed' } })
  assert.deepEqual(checkpoint.pending, [])
  assert.equal(replayable(checkpoint), false)
  assert.equal(replayable({ pending: [] }), false)
})

test('恢复状态在活动流中独立成项，避免与错误日志拼接', () => {
  const wire = toWire([
    { kind: 'log', data: { text: 'provider failure' } },
    { kind: 'log', data: { text: '[chat-recovery] waiting' } },
    { kind: 'log', data: { text: 'next attempt' } },
  ], 0)
  assert.deepEqual(wire.map(e => e.text), ['provider failure', '[chat-recovery] waiting', 'next attempt'])
})


test('prompt 已提交但启动结果未知时，不把没有工具事件当作可重放', () => {
  const checkpoint: Checkpoint = { pending: [], effects: false, started: true, session: 'original' }
  checkpointEvent(checkpoint, { kind: 'phase', data: { phase: 'submitted', at: new Date().toISOString() } })
  assert.equal(replayable(checkpoint), false)
  const input = { body: 'Original user message.', previousReviewRevision: null }
  const turn = replyPrompt(input, {
    initialize: false,
    task: { card: '/task.md', blocks: [['studio', 'Original Studio.']] },
    diagnostics: [], attachments: '/original.png', continuation: 'Continue the interrupted turn.',
  })
  assert.equal(turn.withAttachments, 'Follow `akb guide card-chat`.\n\nContinue the interrupted turn.')
  assert.equal(turn.sent, undefined)
})

test('同一份执行证据按已完成、原会话、安全重放、暂停排序', () => {
  const job: Job = { id: 'job', runtime: 'codex', prompt: 'Continue', projectDir: null, attachments: [], state: 'claimed' }
  const saved: Checkpoint = { pending: ['write'], session: 'original', completed: { outcome: 'done', report: {} } }
  assert.equal(checkpointRecovery(job, saved, true), 'report')
  assert.equal(checkpointRecovery(job, saved, false), 'unsafe')
  delete saved.completed
  assert.equal(checkpointRecovery(job, saved, true), 'resume')
  const repair = { ...saved, boardContinuation: { report: {}, facts: 'conflict', prompt: 'Resolve the conflict' } }
  assert.equal(checkpointRecovery(job, repair, true), 'unsafe')
  delete saved.session
  assert.equal(checkpointRecovery(job, saved, true), 'unsafe')
  assert.equal(checkpointRecovery(job, { pending: [], started: false }, true), 'replay')
})

function setupFakeFlow(fakePlan: Record<string, unknown>, taskOverrides: Partial<Job> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-reconcile-'))
  const board = path.join(dir, '.akb', 'kanban')
  fs.mkdirSync(path.join(board, 'todo'), { recursive: true })
  fs.mkdirSync(path.join(board, '.archive'), { recursive: true })
  fs.mkdirSync(path.join(board, '.fake'), { recursive: true })
  fs.writeFileSync(path.join(board, 'config.md'), '')
  fs.writeFileSync(path.join(board, 'todo', '947-reconcile.md'), '---\ntitle: Reconcile\nstatus: implementing\nquestions: []\n---\n\nBody\n')
  const akbLog = path.join(dir, 'akb.log')
  const prevFake = process.env.FAKE_AKB
  const prevLog = process.env.FAKE_AKB_LOG
  process.env.FAKE_AKB = JSON.stringify(fakePlan)
  process.env.FAKE_AKB_LOG = akbLog
  const cleanup = () => {
    if (prevFake === undefined) delete process.env.FAKE_AKB
    else process.env.FAKE_AKB = prevFake
    if (prevLog === undefined) delete process.env.FAKE_AKB_LOG
    else process.env.FAKE_AKB_LOG = prevLog
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const ws: TaskFolder = { task: 'task_947', cloudTask: 'task_947', project: 'prj_1', cwd: dir, board, number: 947, studio: 'coding' }
  const job: Job & { flow: Flow } = {
    id: 'job_947',
    task: 'task_947',
    number: 947,
    project: 'prj_1',
    projectDir: dir,
    runtime: 'codex',
    prompt: '',
    attachments: [],
    state: 'claimed',
    flow: { verb: 'revise', studio: 'coding', resume: true, review_stages: [], review_revision: 1 },
    taskReview: { plan: [], stages: [], previews: {}, revision: 1, approvals: [] },
    ...taskOverrides,
  } as Job & { flow: Flow }
  const logs: string[] = []
  const io: FlowIo = {
    show: (text) => logs.push(text),
    event: () => {},
    track: () => {},
    onStop: () => {},
    lost: () => false,
    sync: async (step, op) => (step === 'prepare' ? ({ ok: true, value: undefined } as never) : op()),
  }
  const deps = {
    machineId: 'm_1',
    akb: { command: process.execPath, args: [FAKE_AKB], shim: path.join(dir, 'shim'), version: '0.11.80' },
    runtimes: async () => [{ name: 'codex' as const, installed: true, loggedIn: true }],
    api: {
      readTask: async () => ({
        ok: true as const,
        value: {
          project: 'prj_1',
          title: 'Reconcile',
          request: 'Reconcile',
          status: 'queued',
          card_version: 1,
          review: job.taskReview,
        },
      }),
      readRejections: async () => ({ ok: true as const, value: { tasks: [], triage: [] } }),
      markReviewed: async () => ({ ok: true as const, value: { tasks: 0, triage: 0 } }),
    },
    stopMs: 1000,
  }
  const calls = () => fs.readFileSync(akbLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
  return { ws, job, io, deps, logs, calls, board, cleanup }
}

test('a saved failed report without resume evidence remains unverified (W-1207)', async () => {
  const ctx = setupFakeFlow({})
  try {
    ctx.io.flowRun = { id: 'original', card: 947, finished: true, retryPause: 'unsafe',
      failure: { code: 'completed_operation_failed', source: 'runtime', summary: 'Background verification failed' } }
    const end = await runFlow(ctx.job, ctx.ws, ctx.deps, ctx.io)
    assert.equal(end.ok, false)
    assert.equal(end.report?.failure?.safeToRetry, false)
    assert.equal(end.report?.failure?.sessionAction, 'pause_unsafe')
    assert.match(ctx.logs.join(''), /操作结果|operation results/i)
  } finally { ctx.cleanup() }
})

test('W-947: resumable delivery on stale revise continues same delivery instead of replanning (#966)', async () => {
  const ctx = setupFakeFlow({
    reconcile: { kind: 'resumable', deliveryId: 'd947', sessionId: 's947', hasSession: true },
    delivery: { deliveryId: 'd947', carryOn: 'build' },
    resume: { deliveryId: 'd947' },
  })
  fs.writeFileSync(path.join(ctx.board, '.fake', 'runs.json'), JSON.stringify([
    { sessionId: 's947', cardId: 947, action: 'implement', status: 'interrupted', deliveryId: 'd947', resumeId: 'agent-947' },
  ]))
  try {
    const end = await runFlow(ctx.job, ctx.ws, ctx.deps, ctx.io)
    assert.equal(end.ok, true, !end.ok ? end.reason : '')
    assert.equal(end.ok && end.report.deliveryCompleted, true)
    assert.equal(end.ok && end.report.deliveryId, 'd947')
    const verbs = ctx.calls().map((a) => a.slice(0, 3).join(' '))
    assert.ok(verbs.includes('raw delivery reconcile'))
    assert.ok(verbs.includes('raw delivery resume'))
    assert.ok(!verbs.includes('raw card revise'))
  } finally { ctx.cleanup() }
})

test('an approval request pauses the active delivery and retains its session', async () => {
  const plan = { rule: 'Approve the direction before drafting.', previews: ['copy'] }
  const ctx = setupFakeFlow({
    implement: { delivery: { id: 'd947', status: 'active' }, agentSession: 'copy-session' },
  }, {
    flow: { verb: 'implement', phase: 'implement', studio: 'coding', review_stages: [], review_revision: 1 },
    taskReview: { plan, revision: 1, stages: [], approvals: [] },
    reviewAtDispatch: true,
  })
  const read = ctx.deps.api.readTask
  ctx.deps.api.readTask = async () => {
    const result = await read()
    if (!fs.existsSync(path.join(ctx.board, '.fake', 'runs.json'))) return result
    return { ...result, value: { ...result.value, status: 'waiting_review', review: {
      plan, revision: 2,
      stages: [{ id: 'approval-2', status: 'ready', revision: 2, snapshot: null, preview: 'copy', job: ctx.job.id }],
      approvals: [{ stage: 'approval-2', revision: 2, preview: 'copy', question: 'Approve the idea?' }],
    } } }
  }
  try {
    const end = await runFlow(ctx.job, ctx.ws, ctx.deps, ctx.io)
    assert.ok(end.ok, !end.ok ? end.reason : '')
    assert.equal(end.report.deliveryCompleted, false)
    assert.equal(end.report.deliveryId, 'd947')
    assert.equal(end.report.session, 'copy-session')
    assert.ok(fs.existsSync(path.join(ctx.board, 'todo', '947-reconcile.md')))
  } finally { ctx.cleanup() }
})

test('running delivery attaches via run log without calling run stop (#966)', async () => {
  const ctx = setupFakeFlow({
    reconcile: { kind: 'running', deliveryId: 'd_live', sessionId: 's_live', action: 'implement' },
  }, { flow: { verb: 'implement', studio: 'coding', resume: true, review_stages: [], review_revision: 1 } })
  fs.writeFileSync(path.join(ctx.board, '.fake', 'runs.json'), JSON.stringify([
    { sessionId: 's_live', cardId: 947, action: 'implement', status: 'done', deliveryId: 'd_live', resumeId: 'agent-live' },
  ]))
  try {
    const end = await runFlow(ctx.job, ctx.ws, ctx.deps, ctx.io)
    assert.equal(end.ok, true, !end.ok ? end.reason : '')
    assert.equal(end.ok && end.report.deliveryId, 'd_live')
    const verbs = ctx.calls().map((a) => a.slice(0, 3).join(' '))
    assert.ok(verbs.includes('raw run log'))
    assert.ok(!verbs.includes('raw run stop'))
  } finally { ctx.cleanup() }
})

test('completed delivery reports deliveryId and landing without starting an agent (#966)', async () => {
  const ctx = setupFakeFlow({
    reconcile: { kind: 'completed', deliveryId: 'd_done', commit: 'c'.repeat(40), branch: 'main' },
  })
  try {
    const end = await runFlow(ctx.job, ctx.ws, ctx.deps, ctx.io)
    assert.equal(end.ok, true, !end.ok ? end.reason : '')
    assert.equal(end.ok && end.report.deliveryCompleted, true)
    assert.equal(end.ok && end.report.deliveryId, 'd_done')
    assert.deepEqual(end.ok && end.report.landing, { commit: 'c'.repeat(40), branch: 'main' })
    const verbs = ctx.calls().map((a) => a.slice(0, 3).join(' '))
    assert.ok(!verbs.includes('raw card implement'))
    assert.ok(!verbs.includes('raw card revise'))
  } finally { ctx.cleanup() }
})

test('cloud verification only reconciles the original delivery (#1059)', async () => {
  const flow = { verb: 'implement', studio: 'coding', review_stages: [], review_revision: 1,
    sync_recovery_of: 'original', verify_delivery: { id: 'saved' } } satisfies Flow
  for (const deliveryId of ['saved', 'other']) {
    const ctx = setupFakeFlow({ reconcile: { kind: 'completed', deliveryId } }, { flow })
    try {
      const end = await runFlow(ctx.job, ctx.ws, ctx.deps, ctx.io)
      assert.equal(end.ok, deliveryId === 'saved')
      if (end.ok) assert.equal(end.report.deliveryId, 'saved')
      else assert.equal(end.failure?.code, 'task_delivery_unverified')
      assert.ok(!ctx.calls().some(args => args[1] === 'card' || args[1] === 'run' && args[2] === 'resume'))
    } finally { ctx.cleanup() }
  }
})

test('cloud can replay its saved delivery receipt without invoking the Studio again (#1059)', async () => {
  const ctx = setupFakeFlow({ reconcile: { kind: 'none' } }, {
    flow: { verb: 'implement', studio: 'coding', review_stages: [], review_revision: 1,
      sync_recovery_of: 'original', verify_delivery: { id: 'saved', confirmed: true } },
  })
  ctx.deps.runtimes = async () => { throw new Error('Receipt replay should not need an agent runtime') }
  try {
    const end = await runFlow(ctx.job, ctx.ws, ctx.deps, ctx.io)
    assert.equal(end.ok, true)
    assert.equal(end.ok && end.report.deliveryId, 'saved')
    assert.ok(!fs.existsSync(path.join(ctx.ws.cwd, 'akb.log')))
  } finally { ctx.cleanup() }
})

test('failed delivery reconciliation preserves its cause and skips delivery execution', async () => {
  const ctx = setupFakeFlow({
    reconcile: { kind: 'unverified', deliveryId: 'd_bad', diagnostic: 'secret internal lock error' },
  })
  try {
    const end = await runFlow(ctx.job, ctx.ws, ctx.deps, ctx.io)
    assert.equal(end.ok, false)
    assert.equal(!end.ok && end.reason, 'secret internal lock error')
    assert.equal(!end.ok && end.failure?.code, 'task_recovery_unverified')
    assert.equal(ctx.calls().filter((a) => a.slice(0, 3).join(' ') === 'raw delivery reconcile').length, 1)
    assert.match(ctx.logs.join(''), /d_bad/)
    assert.match(ctx.logs.join(''), /secret internal lock error/)
  } finally { ctx.cleanup() }
})

test('flowRunEvidence matches interrupted clarify planning runs by cloudExecution.job without action whitelist (#996)', async () => {
  const ctx = setupFakeFlow({}, { flow: { verb: 'refine', studio: 'coding', resume: true } })
  fs.writeFileSync(path.join(ctx.board, '.fake', 'runs.json'), JSON.stringify([
    {
      sessionId: 'clarify-session',
      cardId: 947,
      action: 'clarify',
      status: 'interrupted',
      resumeId: 'codex-thread-996',
      cloudExecution: { job: 'job_947', machine: 'm_1' },
      startedAt: Date.now() - 1000,
    },
  ]))
  try {
    const evidence = await flowRunEvidence(ctx.ws, ctx.job, ctx.deps, 'job_947')
    assert.equal(evidence.stopped, true)
    assert.equal(evidence.run?.id, 'clarify-session')
    assert.equal(evidence.run?.finished, false)
  } finally { ctx.cleanup() }
})

test('a legacy #1247 run under #1246 blocks exit proof without taking ownership of #1247’s real job', async () => {
  const ctx = setupFakeFlow({}, { task: 'task_1246', number: 1246 })
  ctx.ws.task = ctx.ws.cloudTask = 'task_1246'
  ctx.ws.number = 1246
  const file = path.join(ctx.board, '.fake', 'runs.json')
  const execution = { job: ctx.job.id, machine: ctx.deps.machineId }
  fs.writeFileSync(file, JSON.stringify([
    { sessionId: 'own', cardId: 1246, action: 'clarify', status: 'done', resumeId: 'own-agent', cloudExecution: execution, costUsd: 1 },
    { sessionId: 'stray', cardId: 1247, action: 'clarify', status: 'running', resumeId: 'other-agent', cloudExecution: execution, costUsd: 8 },
    { sessionId: 'independent', cardId: 1247, action: 'clarify', status: 'running', cloudExecution: { ...execution, job: 'job-1247' } },
  ]))
  try {
    assert.equal(await confirmFlowStopped(ctx.ws, ctx.job, ctx.deps), false)
    assert.equal((await flowRunEvidence(ctx.ws, ctx.job, ctx.deps)).stopped, false)
    assert.equal(await taskSessionMatches(ctx.ws, ctx.deps, 'other-agent'), false)
    assert.equal(await stopFlowRuns(ctx.ws, ctx.job, ctx.deps), true)
    assert.deepEqual(ctx.calls().filter(c => c.slice(0, 3).join(' ') === 'raw run stop').map(c => c[3]), ['stray'])
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).find((r: { sessionId: string }) => r.sessionId === 'independent').status, 'running')
    if (process.platform !== 'win32') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        env: markEnv(process.env, runMark('stray')), stdio: 'ignore',
      })
      const exited = once(child, 'exit')
      try {
        await once(child, 'spawn')
        assert.equal(await confirmFlowStopped(ctx.ws, ctx.job, ctx.deps), false, 'the legacy stopped label does not prove exit')
        assert.equal((await flowRunEvidence(ctx.ws, ctx.job, ctx.deps)).stopped, false)
      } finally {
        child.kill()
        await exited
      }
    }
    const verified = await flowRunEvidence(ctx.ws, ctx.job, ctx.deps)
    assert.equal(verified.mismatched, true)
    assert.equal(verified.stopped, true)
    assert.equal(verified.run?.id, 'own')
    assert.equal(verified.run?.agentSession, 'own-agent')
    assert.deepEqual(verified.run?.priorSpend?.map(run => run.costUsd), [1])
  } finally { ctx.cleanup() }
})

test('missing session / no rollout replays only when no side effects occurred and pauses unsafe otherwise (#996)', () => {
  const job: Job = { id: 'job', runtime: 'codex', prompt: 'Continue', projectDir: null, attachments: [], state: 'claimed' }
  const noRollout = { code: 'session_not_found', source: 'runtime' as const, summary: 'no rollout found for thread id th_1' }
  assert.equal(checkpointRecovery(job, { pending: [], started: true, submitted: false, effects: false, session: 'th_1' }, true, noRollout), 'replay')
  assert.equal(checkpointRecovery(job, { pending: [], started: true, submitted: true, effects: true, session: 'th_1' }, true, noRollout), 'unsafe')
  assert.equal(checkpointRecovery(job, { pending: ['edit_1'], started: true, submitted: true, effects: true, session: 'th_1' }, true, noRollout), 'unsafe')
})

test('toWire preserves structured retry ACP events (#996)', () => {
  const wire = toWire([
    {
      kind: 'retry',
      data: {
        state: 'waiting',
        source: 'runtime',
        runtime: { connector: 'codex', name: 'sol', model: 'gpt-5' },
        attempt: 2,
        maxAttempts: 4,
        summary: 'HTTP 429 rate limit',
        detail: 'HTTP 429 Too Many Requests',
        code: 'rate_limited',
        nextRetryAt: '2026-11-21T10:00:12.000Z',
        sessionAction: 'resume',
        at: '2026-11-21T10:00:00.000Z',
      },
    },
  ], 10)
  assert.equal(wire.length, 1)
  assert.equal(wire[0]!.kind, 'retry')
  assert.equal(wire[0]!.seq, 10)
  assert.equal(wire[0]!.data?.state, 'waiting')
  assert.equal(wire[0]!.data?.attempt, 2)
})
