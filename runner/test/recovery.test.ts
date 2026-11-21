import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Flow, Job } from '../src/api'
import { runFlow, type FlowIo } from '../src/flow'
import { toWire } from '../src/jobs'
import { checkpointEvent, checkpointRecovery, replayable, type Checkpoint } from '../src/recovery'
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
    syncBackoff: () => 0,
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

test('reconcile failure retries with bounded backoff and isolates diagnostic to log (#966)', async () => {
  const ctx = setupFakeFlow({
    reconcile: { kind: 'unverified', deliveryId: 'd_bad', diagnostic: 'secret internal lock error' },
  })
  try {
    const end = await runFlow(ctx.job, ctx.ws, ctx.deps, ctx.io)
    assert.equal(end.ok, false)
    assert.equal(!end.ok && end.reason, 'task_recovery_unverified')
    assert.equal(!end.ok && end.failure?.code, 'task_recovery_unverified')
    assert.equal(ctx.calls().filter((a) => a.slice(0, 3).join(' ') === 'raw delivery reconcile').length, 3)
    assert.match(ctx.logs.join(''), /d_bad/)
    assert.match(ctx.logs.join(''), /secret internal lock error/)
  } finally { ctx.cleanup() }
})
