import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { connectionIdentity } from '../../cli/src/lib/agent/connection-process'
import { projectStateDir } from '../../cli/src/lib/machine/project'
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
  const checkout = '.akb/worktrees/d947'
  const ctx = setupFakeFlow({
    reconcile: [{ kind: 'none' }, { kind: 'resumable', deliveryId: 'd947', status: 'active', worktree: `${checkout}/work` }],
    implement: { trackExecution: true, delivery: { id: 'd947', status: 'active' }, agentSession: 'copy-session' },
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
    for (const dir of ['work', 'base']) fs.mkdirSync(path.join(ctx.ws.cwd, checkout, dir), { recursive: true })
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

test('re-verifies real Codex stop state on #1258/#1263 manual resume, chained resume_execution, auto recovery, and live native backend (#1270)', async (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-codex-1270-'))
  const prevCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome
  t.after(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodexHome
    fs.rmSync(codexHome, { recursive: true, force: true })
  })

  const writeRollout = (threadId: string, lines: Record<string, unknown>[]) => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const dir = path.join(codexHome, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `rollout-2026-11-27T12-00-00-${threadId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }

  // 1. #1258 isolated replay: delivery stopped/paused with static unconfirmed cleanup + pause_unsafe,
  //    plus chained resume_execution after an earlier empty failed resume attempt (job_prev_failed).
  const thread1258 = '019d7482-0000-7000-8000-000000001258'
  const ctx1258 = setupFakeFlow({
    reconcile: { kind: 'resumable', deliveryId: 'd1258', sessionId: 's1258', hasSession: true },
    resume: { sessionId: 's1258-resumed', agentSession: thread1258, delivery: { id: 'd1258', status: 'finished' } },
  }, {
    id: 'job_resume_2',
    number: 1258,
    task: 'task_1258',
    flow: { verb: 'implement', phase: 'implement', studio: 'coding', resume: true, resume_execution: 'job_prev_failed', review_stages: [], review_revision: 1 },
  })
  ctx1258.ws.number = 1258
  ctx1258.ws.task = ctx1258.ws.cloudTask = 'task_1258'
  const worktree1258 = path.join(ctx1258.ws.cwd, '.akb', 'worktrees', 'd1258', 'work')
  fs.mkdirSync(worktree1258, { recursive: true })
  const savedFile = path.join(worktree1258, 'work.txt')
  fs.writeFileSync(savedFile, 'preserved-1258')
  fs.writeFileSync(path.join(ctx1258.board, 'todo', '1258-build.md'), '---\ntitle: Build 1258\nstatus: implementing\nquestions: []\n---\n\nBody\n')
  const stateSessions = path.join(projectStateDir(ctx1258.board), 'sessions')
  fs.mkdirSync(stateSessions, { recursive: true })
  fs.writeFileSync(
    path.join(stateSessions, 's1258.events.jsonl'),
    `${JSON.stringify({ kind: 'tool_call', data: { toolCallId: 'exec-1258', title: 'Command', kind: 'execute', status: 'in_progress' } })}\n`,
  )
  fs.writeFileSync(path.join(ctx1258.board, '.fake', 'runs.json'), JSON.stringify([{
    sessionId: 's1258',
    cardId: 1258,
    harness: 'codex',
    cwd: worktree1258,
    action: 'implement',
    status: 'stopped',
    endedAt: Date.now() - 5000,
    startedAt: Date.now() - 10_000,
    deliveryId: 'd1258',
    resumeId: thread1258,
    managedProcess: true,
    pendingWrites: true,
    retryPause: 'unsafe',
    retryHistory: [{ attempt: 1, source: 'runtime', summary: 'Stopped', sessionAction: 'pause_unsafe', at: new Date().toISOString() }],
    cleanup: {
      status: 'unconfirmed',
      execution: 'exec_1258',
      detail: 'Execution stopped; no further cleanup turn was submitted.',
      kept: [],
      items: [{ id: `terminal:${thread1258}:exec-1258`, threadId: thread1258, processId: '501', status: 'running' }],
    },
    cloudExecution: { job: 'job_orig_1258', machine: 'm_1', card: 1258 },
  }]))

  try {
    // When command result is still missing from rollout, chained manual resume stays paused and preserves saved work.
    writeRollout(thread1258, [
      { type: 'session_meta', payload: { id: thread1258, cwd: worktree1258 } },
      { type: 'event_msg', payload: { type: 'item_started', item: { type: 'CommandExecution', id: 'exec-1258', status: 'inProgress' } } },
    ])
    const blocked = await runFlow(ctx1258.job, ctx1258.ws, ctx1258.deps, ctx1258.io)
    assert.equal(blocked.ok, false)
    assert.equal(!blocked.ok && blocked.reason, 'task_recovery_unverified')
    assert.match(ctx1258.logs.join(''), /操作结果|operation results/i)
    assert.ok(!ctx1258.calls().some((c) => c[1] === 'run' && c[2] === 'resume'))
    assert.equal(fs.readFileSync(savedFile, 'utf8'), 'preserved-1258')

    // Once rollout confirms exec-1258 completed, Resume unlocks even with old unconfirmed/pause_unsafe markers and chained resume_execution.
    writeRollout(thread1258, [
      { type: 'session_meta', payload: { id: thread1258, cwd: worktree1258 } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-1258', process_id: '501', status: 'completed', exit_code: 0 } } },
      { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } },
    ])
    const resumed = await runFlow(ctx1258.job, ctx1258.ws, ctx1258.deps, ctx1258.io)
    assert.equal(resumed.ok, true, !resumed.ok ? resumed.reason : '')
    assert.equal(resumed.ok && resumed.report.landReady?.deliveryId, 'd1258')
    assert.equal(resumed.ok && resumed.report.session, thread1258)
    assert.ok(ctx1258.calls().some((c) => c.slice(0, 4).join(' ') === 'raw run resume s1258' && c.includes('--require-session')))
    assert.equal(fs.readFileSync(savedFile, 'utf8'), 'preserved-1258')

    // Automatic recovery on transient failure with stale retryPause: 'unsafe' also re-verifies and resumes instead of deadlocking.
    fs.writeFileSync(path.join(ctx1258.board, '.fake', 'runs.json'), JSON.stringify([{
      sessionId: 's1258-auto',
      cardId: 1258,
      harness: 'codex',
      cwd: worktree1258,
      action: 'implement',
      status: 'error',
      endedAt: Date.now() - 2000,
      startedAt: Date.now() - 5000,
      deliveryId: 'd1258',
      resumeId: thread1258,
      managedProcess: true,
      pendingWrites: true,
      retryPause: 'unsafe',
      failure: { source: 'runtime', code: 'connection_lost', summary: 'Codex stream disconnected.' },
      cleanup: { status: 'unconfirmed', execution: 'exec_auto', kept: [], items: [{ id: `terminal:${thread1258}:exec-1258`, threadId: thread1258, processId: '501', status: 'running' }] },
      cloudExecution: { job: 'job_auto_1258', machine: 'm_1', card: 1258 },
    }]))
    const autoEvidence = await flowRunEvidence(ctx1258.ws, { ...ctx1258.job, id: 'job_auto_1258', flow: { verb: 'implement', studio: 'coding', resume: true } }, ctx1258.deps, 'job_auto_1258')
    assert.equal(autoEvidence.stopped, true)
    assert.equal(autoEvidence.run?.id, 's1258-auto')
    assert.equal(autoEvidence.run?.finished, false)
    assert.equal(autoEvidence.run?.failure, undefined)
  } finally {
    ctx1258.cleanup()
  }

  // 2. #1263 isolated replay: stopped clarify/refine planning task resumed without resume_execution.
  const thread1263 = '019d7482-0000-7000-8000-000000001263'
  const ctx1263 = setupFakeFlow({
    resume: { sessionId: 's1263-resumed', agentSession: thread1263, result: 'Refined cleanly' },
  }, {
    id: 'job_1263_resume',
    number: 1263,
    task: 'task_1263',
    taskReview: undefined,
    flow: { verb: 'refine', studio: 'coding', resume: true },
  })
  ctx1263.ws.number = 1263
  ctx1263.ws.task = ctx1263.ws.cloudTask = 'task_1263'
  fs.writeFileSync(path.join(ctx1263.board, 'todo', '1263-plan.md'), '---\ntitle: Plan 1263\nstatus: todo\nquestions: []\n---\n\nBody\n')
  fs.writeFileSync(path.join(ctx1263.board, '.fake', 'runs.json'), JSON.stringify([{
    sessionId: 's1263',
    cardId: 1263,
    harness: 'codex',
    cwd: ctx1263.ws.cwd,
    action: 'clarify',
    status: 'stopped',
    endedAt: Date.now() - 3000,
    startedAt: Date.now() - 6000,
    resumeId: thread1263,
    managedProcess: true,
    pendingWrites: true,
    cleanup: {
      status: 'unconfirmed',
      execution: 'exec_1263',
      detail: 'Execution stopped; no further cleanup turn was submitted.',
      kept: [],
      items: [{ id: `terminal:${thread1263}:exec-rg`, threadId: thread1263, processId: '777', status: 'running' }],
    },
    cloudExecution: { job: 'job_1263_orig', machine: 'm_1', card: 1263 },
  }]))

  try {
    // Unconfirmed operation keeps #1263 paused instead of launching a fresh `task refine` and repeating work.
    writeRollout(thread1263, [
      { type: 'session_meta', payload: { id: thread1263, cwd: ctx1263.ws.cwd } },
      { type: 'event_msg', payload: { type: 'item_started', item: { type: 'CommandExecution', id: 'exec-rg', status: 'inProgress' } } },
    ])
    const paused1263 = await runFlow(ctx1263.job, ctx1263.ws, ctx1263.deps, ctx1263.io)
    assert.equal(paused1263.ok, false)
    assert.equal(!paused1263.ok && paused1263.reason, 'task_recovery_unverified')
    assert.ok(!ctx1263.calls().some((c) => c.includes('refine') || (c[1] === 'run' && c[2] === 'resume')))

    // Foreign session ownership also blocks cleanly.
    fs.writeFileSync(path.join(ctx1263.board, '.fake', 'runs.json'), JSON.stringify([
      ...JSON.parse(fs.readFileSync(path.join(ctx1263.board, '.fake', 'runs.json'), 'utf8')),
      { sessionId: 'foreign-run', cardId: 9999, harness: 'codex', action: 'clarify', status: 'done', resumeId: thread1263 },
    ]))
    writeRollout(thread1263, [
      { type: 'session_meta', payload: { id: thread1263, cwd: ctx1263.ws.cwd } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-rg', process_id: '777', status: 'failed', exit_code: 1 } } },
    ])
    const foreign1263 = await runFlow(ctx1263.job, ctx1263.ws, ctx1263.deps, ctx1263.io)
    assert.equal(foreign1263.ok, false)
    assert.match(ctx1263.logs.join(''), /归属|belongs to this task/i)

    // Remove foreign run: #1263 resumes original Codex planning session cleanly!
    fs.writeFileSync(
      path.join(ctx1263.board, '.fake', 'runs.json'),
      JSON.stringify(JSON.parse(fs.readFileSync(path.join(ctx1263.board, '.fake', 'runs.json'), 'utf8')).slice(0, 1)),
    )
    const ok1263 = await runFlow(ctx1263.job, ctx1263.ws, ctx1263.deps, ctx1263.io)
    assert.equal(ok1263.ok, true, !ok1263.ok ? ok1263.reason : '')
    assert.equal(ok1263.ok && ok1263.report.session, thread1263)
    assert.ok(ctx1263.calls().some((c) => c.slice(0, 4).join(' ') === 'raw run resume s1263' && c.includes('--require-session')))
  } finally {
    ctx1263.cleanup()
  }

  // 3. Live codex-native backend WebSocket probe: blocks while turn is active or background terminal is running, then unlocks once settled.
  if (process.platform !== 'win32') {
    let mode: 'active' | 'bg' | 'settled' = 'active'
    const nativeThread = '019d7482-0000-7000-8000-000000009999'
    const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-native-1270-'))
    const sockPath = path.join(sockDir, 'native.sock')
    const sendWs = (socket: import('node:stream').Duplex, msg: unknown) => {
      const body = Buffer.from(JSON.stringify(msg))
      const head = body.length < 126
        ? Buffer.from([0x81, body.length])
        : (() => { const b = Buffer.alloc(4); b[0] = 0x81; b[1] = 126; b.writeUInt16BE(body.length, 2); return b })()
      socket.write(Buffer.concat([head, body]))
    }
    const sockets = new Set<import('node:stream').Duplex>()
    const server = http.createServer()
    server.on('upgrade', (req, socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      let buf = Buffer.alloc(0)
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk])
        for (;;) {
          if (buf.length < 2) return
          const opcode = buf[0]! & 0x0f
          let len = buf[1]! & 0x7f
          let off = 2
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
          const masked = (buf[1]! & 0x80) !== 0
          if (buf.length < off + (masked ? 4 : 0) + len) return
          const mask = masked ? buf.subarray(off, off + 4) : null
          off += masked ? 4 : 0
          const payload = Buffer.from(buf.subarray(off, off + len))
          buf = buf.subarray(off + len)
          if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!
          if (opcode === 0x01 && payload.length) {
            const m = JSON.parse(payload.toString('utf8')) as { id?: number; method?: string; params?: Record<string, unknown> }
            if (m.id === undefined) continue
            if (m.method === 'initialize') sendWs(socket, { id: m.id, result: { userAgent: 'probe-test' } })
            else if (m.method === 'thread/read') {
              sendWs(socket, {
                id: m.id,
                result: {
                  thread: {
                    id: nativeThread,
                    status: { type: mode === 'active' ? 'active' : 'idle' },
                    ...(m.params?.includeTurns ? { turns: [{ id: 't1', status: 'completed', items: [{ type: 'commandExecution', id: 'cmd-1', status: 'completed', exitCode: 0, processId: '88' }] }] } : {}),
                  },
                },
              })
            } else if (m.method === 'thread/backgroundTerminals/list') {
              sendWs(socket, { id: m.id, result: { data: mode === 'bg' ? [{ itemId: 'cmd-bg', processId: '99' }] : [], nextCursor: null } })
            }
          }
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(sockPath, resolve))
    const nativeDir = path.join(process.env.WILDCRANE_HOME || process.env.AI4KANBAN_HOME!, 'codex-native')
    fs.mkdirSync(nativeDir, { recursive: true })
    const backendKey = 'a'.repeat(64)
    const backendRecord = path.join(nativeDir, `${backendKey}.json`)
    fs.writeFileSync(backendRecord, JSON.stringify({
      pid: process.pid,
      identity: connectionIdentity(process.pid),
      instance: 'inst-probe',
      generation: 'gen-1',
      endpoint: `unix://${sockPath}`,
      key: backendKey,
    }))
    const ctxNative = setupFakeFlow({}, {
      id: 'job_native',
      number: 947,
      flow: { verb: 'refine', studio: 'coding', resume: true, resume_execution: 'job_native_orig' },
    })
    fs.writeFileSync(path.join(ctxNative.board, '.fake', 'runs.json'), JSON.stringify([{
      sessionId: 's-native',
      cardId: 947,
      harness: 'codex',
      action: 'clarify',
      status: 'stopped',
      endedAt: Date.now() - 1000,
      startedAt: Date.now() - 2000,
      resumeId: nativeThread,
      managedProcess: true,
      pendingWrites: true,
      cleanup: { status: 'unconfirmed', execution: 'e1', kept: [], items: [{ id: `terminal:${nativeThread}:cmd-1`, threadId: nativeThread, processId: '88', status: 'running' }] },
      cloudExecution: { job: 'job_native_orig', machine: 'm_1', card: 947 },
    }]))
    try {
      const whileActive = await flowRunEvidence(ctxNative.ws, ctxNative.job, ctxNative.deps, 'job_native_orig')
      assert.equal(whileActive.stopped, false)

      mode = 'bg'
      const whileBg = await flowRunEvidence(ctxNative.ws, ctxNative.job, ctxNative.deps, 'job_native_orig')
      assert.equal(whileBg.stopped, true)
      assert.equal(whileBg.run, undefined)
      assert.match(whileBg.diagnostic ?? '', /操作结果|operation results/i)

      mode = 'settled'
      const onceSettled = await flowRunEvidence(ctxNative.ws, ctxNative.job, ctxNative.deps, 'job_native_orig')
      assert.equal(onceSettled.stopped, true)
      assert.equal(onceSettled.diagnostic, undefined)
      assert.equal(onceSettled.run?.id, 's-native')
    } finally {
      ctxNative.cleanup()
      fs.rmSync(backendRecord, { force: true })
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(sockDir, { recursive: true, force: true })
    }
  }
})
