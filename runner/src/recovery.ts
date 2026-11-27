import { stopConnection } from '../../cli/src/lib/agent/connection-process'
import fs from 'node:fs'
import path from 'node:path'

import { killMarked, processesStopped, type Mark } from '../../cli/src/lib/agent/stop'
import { agentRecovery, isSessionMissingFailure, readFailure, readRetryHistory, readRetryPause, readRetryPlan, type ExecutionFailure, type RetryPause, type RetryPlan, type RetryRecord } from '../../cli/src/lib/agent/retry'
import type { LocalReplyPart } from '../../cli/src/lib/shared/reply-parts'
import { isPollingTool, turnSubmitted, type RunEvent } from '../../cli/src/lib/agent/wire/events'
import { cloudLanguage } from '../../cli/src/lib/agent/language'
import { idleStopConfirmed } from '../../cli/src/lib/agent/wire/codex-background-types'
import { verifyCodexStopState, verifyCodexStopStateSync, type CodexStopVerification } from '../../cli/src/lib/agent/wire/codex-verify'
import * as api from './api'
import type { Job, JobReport, ReplyContext } from './api'
import { runnerHome } from './home'
import { migrateGoalData } from './goal-migration'
import type { SyncStep } from './sync-retry'

export const recoveryBlocked = (job: Job) => cloudLanguage(job) === 'zh'
  ? '无法核对上次执行，已有成果已保留。' : 'The previous execution could not be verified. Saved work was preserved.'

export interface BoardRunSpend extends Pick<JobReport, 'usage' | 'costUsd' | 'costIncomplete'> {
  sessionId: string
  runtime?: string
  startedAt?: number
  context?: Partial<NonNullable<JobReport['context']>>
}

export interface Checkpoint {
  studioSnapshot?: import('../../cli/src/lib/agent/cloud-studios').StudioPin
  retryRound?: string
  syncRetries?: Partial<Record<SyncStep, { attempt: number; at: number; record?: RetryRecord }>>
  syncFailure?: { failure: ExecutionFailure; pause: RetryPause; safe: boolean }
  ending?: { outcome: 'done' | 'failed' | 'conflict' | 'stopped'; reason: string; report?: JobReport; unconfirmed?: boolean; refreshArchive?: boolean }
  reconcileRetry?: { attempt: number; at: number }
  taskRecovery?: api.TaskRecovery
  verifyingDelivery?: boolean
  boardRepair?: { reason: string; run: string }
  flowRun?: { id: string; finished: boolean; freshSession?: boolean; card?: number; agentSession?: string; deliveryId?: string; from?: string; failure?: ExecutionFailure; retryPause?: RetryPause; resumeDiagnostic?: string | null; priorSpend?: BoardRunSpend[] }
  forkSource?: string
  reviewMarks?: ReturnType<typeof import('./chats').reviewMarks>
  reviewedRejections?: import('./triage').Laid
  boardContinuation?: { report: JobReport; facts: string; prompt: string; validation?: boolean; sessionTotal?: number | null }
  approvalRequested?: boolean
  approvalCancelled?: boolean
  replyInitializing?: boolean
  replyReviewRevision?: number
  replyContext?: ReplyContext
  mark?: Mark
  managedProcess?: boolean
  cleanup?: import('../../cli/src/lib/agent/wire/codex-background').Cleanup
  process?: { pid: number; since: number; identity?: string }
  updating?: boolean
  interrupted?: true
  flowResume?: boolean
  session?: string
  submitted?: boolean
  submissionUnknown?: boolean
  started?: boolean
  opaque?: boolean
  effects?: boolean
  retry?: { since: number; attempt: number; pending?: RetryPlan; at?: number }
  retryHistory?: RetryRecord[]
  failure?: ExecutionFailure
  retryPause?: RetryPause
  launching?: true
  attempts?: (Pick<JobReport, 'session' | 'usage' | 'costUsd' | 'costIncomplete'> & { resume?: string | null })[]
  partialReply?: string
  replyParts?: { cwd: string; parts: LocalReplyPart[] }
  replyImages?: { job: string; files: Record<string, { id?: string; status: 'saved' | 'not_saved' }> }
  pending: string[]
  goalsVersion?: number
  completed?: { outcome: 'done' | 'failed'; reason?: string; report: JobReport }
}

export const retryFileOf = (id: string) => path.join(runnerHome(), 'checkpoints', `${encodeURIComponent(id)}.retry`)

const fileOf = (id: string) => path.join(runnerHome(), 'checkpoints', `${encodeURIComponent(id)}.json`)

export function readCheckpoint(id: string): Checkpoint | null {
  try {
    const held = JSON.parse(fs.readFileSync(fileOf(id), 'utf8')) as Checkpoint & { syncRetry?: { step: SyncStep; attempt: number; at: number } }
    if (!held || !Array.isArray(held.pending) || !held.pending.every((id) => typeof id === 'string')) throw new Error('进度格式错误')
    const pending = held.syncRetry
    if (pending && Number.isSafeInteger(pending.attempt) && pending.attempt >= 1 && Number.isFinite(pending.at)) {
      held.syncRetries ??= {}
      held.syncRetries[pending.step] ??= { attempt: pending.attempt, at: pending.at }
    }
    delete held.syncRetry
    held.failure = readFailure(held.failure)
    held.retryPause = readRetryPause(held.retryPause)
    held.retryHistory = readRetryHistory(held.retryHistory)
    if (held.retry?.pending) {
      const pending = readRetryPlan(held.retry.pending, held.retry.attempt)
      if (!pending) held.retry.at = held.retry.pending.at ?? 0
      held.retry.pending = pending
    }
    const migrated = [held.completed?.report, held.ending?.report, held.boardContinuation?.report]
      .map(report => report && migrateGoalData(report)).some(Boolean)
    if (migrated) saveCheckpoint(id, held)
    return held
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    // 损坏的进度不能当成从未执行。
    return { updating: true, started: true, pending: ['unknown'] }
  }
}

export function saveCheckpoint(id: string, checkpoint: Checkpoint): void {
  const file = fileOf(id)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(checkpoint), { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file)
}

export function clearCheckpoint(id: string): void {
  const checkpoint = readCheckpoint(id)
  fs.rmSync(fileOf(id), { force: true })
  if (checkpoint) fs.rmSync(retryFileOf(checkpoint.retryRound ?? id), { force: true })
}

export function checkpointEvent(checkpoint: Checkpoint, event: RunEvent): void {
  if (turnSubmitted(event)) checkpoint.submitted = true
  if (event.kind === 'tool_call' && !isPollingTool(event.data.title)) {
    const { toolCallId, status, kind } = event.data
    if (!['read', 'search', 'fetch'].includes(kind)) checkpoint.effects = true
    if (['completed', 'failed'].includes(status)) checkpoint.pending = checkpoint.pending.filter((id) => id !== toolCallId)
    if (!['read', 'search', 'fetch'].includes(kind) && !['completed', 'failed'].includes(status)
      && !checkpoint.pending.includes(toolCallId)) checkpoint.pending.push(toolCallId)
  }
  if (event.kind === 'tool_call_update' && ['completed', 'failed'].includes(event.data.status)) {
    checkpoint.pending = checkpoint.pending.filter((id) => id !== event.data.toolCallId)
  }
}

/** 恢复前确认所有带本轮标记的进程已结束。 */
export async function stopReply(id: string, timeout: number): Promise<boolean> {
  const checkpoint = readCheckpoint(id)
  if (checkpoint?.managedProcess) return stopConnection(checkpoint.process, timeout)
  if (!checkpoint?.mark) return true
  killMarked(checkpoint.mark, checkpoint.process)
  const until = Date.now() + timeout
  while (!processesStopped(checkpoint.mark, checkpoint.process)) {
    if (Date.now() >= until) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

export function replayable(checkpoint: Checkpoint): boolean {
  return !checkpoint.submissionUnknown && checkpoint.submitted !== true && checkpoint.effects !== true && (checkpoint.effects === false || checkpoint.started === false) && !checkpoint.pending.length && !checkpoint.opaque && !checkpoint.launching
}

export const isReply = (job: Job) => !job.flow && !!(job.chat || job.discussion)
export const usesBoardRun = (job: Job, checkpoint: Checkpoint) =>
  !checkpoint.boardContinuation && !!(job.flow || job.agent || job.review)

export function checkpointRecovery(
  job: Job,
  checkpoint: Checkpoint,
  stopped: boolean,
  failure?: ExecutionFailure,
  codex?: CodexStopVerification,
) {
  const board = usesBoardRun(job, checkpoint)
  const staticUnconfirmed = !!checkpoint.boardContinuation && checkpoint.pending.length > 0
    || checkpoint.cleanup?.status === 'unconfirmed'
    || failure?.code === 'codex_ownership_unconfirmed'
    || failure?.code === 'idle_timeout' && (checkpoint.pending.length > 0
      || checkpoint.managedProcess && !idleStopConfirmed(checkpoint.cleanup, checkpoint.session))
  const verified = codex ?? (!board && !checkpoint.boardContinuation && stopped && job.runtime === 'codex' && checkpoint.session && !isSessionMissingFailure(failure)
    ? verifyCodexStopStateSync({
        session: checkpoint.session,
        cwd: job.projectDir ?? undefined,
        cleanup: checkpoint.cleanup,
        pendingIds: checkpoint.pending,
        taskId: job.task,
        needsBackendProbe: staticUnconfirmed,
      })
    : undefined)
  const effectiveStopped = stopped && (!verified || verified.stopped)
  if (verified && !verified.ownershipOk) return 'unsafe'
  const unconfirmedCleanup = !!checkpoint.boardContinuation && checkpoint.pending.length > 0
    || (verified?.found ? !verified.settled : staticUnconfirmed)
  const canReplay = failure?.code !== 'idle_timeout' && replayable(checkpoint) && (!board || checkpoint.started === false)
    && (job.runtime !== 'antigravity' || checkpoint.started === false)
  if (isSessionMissingFailure(failure)) {
    if (!effectiveStopped || unconfirmedCleanup) return 'unsafe'
    return canReplay ? 'replay' : 'unsafe'
  }
  return agentRecovery({
    stopped: effectiveStopped,
    completed: !!checkpoint.ending || !!checkpoint.completed || board && checkpoint.flowRun?.finished,
    session: board ? checkpoint.flowRun?.id : checkpoint.opaque && !checkpoint.boardContinuation ? undefined : checkpoint.session,
    replayable: canReplay,
    unconfirmedCleanup,
  })
}

export function replyRecovery(
  job: Job,
  checkpoint: Checkpoint,
  stopped: boolean,
  codex?: CodexStopVerification,
): NonNullable<JobReport['recovery']> {
  const recovery = checkpointRecovery(job, checkpoint, stopped, checkpoint.failure, codex)
  return { safe: recovery === 'replay', stopped: stopped && (!codex || codex.stopped), resumable: recovery === 'resume' }
}

/** Both the Runner and a detached worker sweep use the same handoff after checking ownership and process exit. */
export async function recoverInterruptedJob(machine: string, job: Job, checkpoint: Checkpoint | null,
  stopped: boolean, valid: () => boolean, reason?: string) {
  if (!valid() || job.flow && !stopped) return
  const effectiveFailure = checkpoint ? (checkpoint.retry?.pending?.failure ?? checkpoint.failure) : undefined
  const codex = checkpoint && !usesBoardRun(job, checkpoint) && !checkpoint.boardContinuation && stopped
    && job.runtime === 'codex' && checkpoint.session && !isSessionMissingFailure(effectiveFailure)
    ? await verifyCodexStopState({
        session: checkpoint.session,
        cwd: job.projectDir ?? undefined,
        cleanup: checkpoint.cleanup,
        pendingIds: checkpoint.pending,
        taskId: job.task,
        needsBackendProbe: true,
      })
    : undefined
  const recovery = checkpoint ? checkpointRecovery(job, checkpoint, stopped, effectiveFailure, codex) : 'unsafe'
  const effectiveStopped = stopped && (!codex || codex.stopped)
  const proof = effectiveStopped ? { processesStopped: true } : undefined
  const reply = isReply(job)
  const report = reply && checkpoint ? {
    ...proof, session: checkpoint.session, reply: checkpoint.partialReply, ...replySpent(checkpoint, job.runtime),
    recovery: replyRecovery(job, checkpoint, effectiveStopped, codex),
  } : proof
  if (checkpoint && recovery !== 'unsafe' && job.flow?.phase !== 'land') {
    const prepared = await api.finishJob(machine, job.id, 'update_prepare', '', report)
    if (!valid() || !prepared.ok) return
    if (prepared.value.finished) {
      clearCheckpoint(job.id)
      return prepared.value
    }
    if (!prepared.value.prepared) return
    if (!checkpoint.updating) checkpoint.interrupted = true
    if (job.flow) checkpoint.flowResume ??= job.flow.resume === true
    checkpoint.updating = true
    saveCheckpoint(job.id, checkpoint)
    const resumed = await api.finishJob(machine, job.id, 'update_resume', '', report && { ...report, session: undefined })
    if (!valid() || !resumed.ok) return
    if (resumed.value.finished) clearCheckpoint(job.id)
    return resumed.value
  }
  // A failed renewal can still allow Cloud to settle a lapsed claim with proof of exit.
  const renewed = await api.renewJob(machine, job.id)
  if (!valid() || !renewed.ok) return
  const requestedStop = renewed.value.stop
  if (requestedStop && !stopped) return
  const message = reason ?? (reply ? 'recovery_unsafe' : recoveryBlocked(job))
  const result = await api.finishJob(machine, job.id, requestedStop ? 'stopped' : 'failed', requestedStop ? '' : message, report)
  if (!valid() || !result.ok) return
  if (result.value.finished && checkpoint) {
    if (requestedStop) clearCheckpoint(job.id)
    else if (reply && report && !checkpoint.completed) {
      checkpoint.completed = { outcome: 'failed', reason: message, report }
      saveCheckpoint(job.id, checkpoint)
    }
  }
  return result.value
}

/** Tokens are per attempt; Claude's prices remain session totals for Cloud to subtract. */
export function replySpent(checkpoint: Checkpoint, runtime: string): Pick<JobReport, 'usage' | 'costUsd' | 'attemptCosts' | 'costIncomplete'> {
  const attempts = checkpoint.attempts ?? []
  const used = attempts.filter(a => a.usage)
  const costed = attempts.filter(a => a.costUsd !== undefined)
  const sum = (key: keyof NonNullable<JobReport['usage']>) => used.reduce((n, a) => n + a.usage![key], 0)
  const incomplete = costed.length > 0 && attempts.some(a => a.costUsd === undefined || a.costIncomplete)
  const spent = {
    ...(incomplete ? { costIncomplete: true } : {}),
    ...(used.length ? { usage: { input: sum('input'), cacheCreation: sum('cacheCreation'), cacheRead: sum('cacheRead'), output: sum('output') } } : {}),
    ...(costed.length ? { costUsd: costed.reduce((n, a) => n + a.costUsd!, 0) } : {}),
  }
  if (runtime !== 'claude-code' || !attempts.length) return spent
  return {
    ...(incomplete ? { costIncomplete: true } : {}),
    ...(spent.usage ? { usage: spent.usage } : {}),
    ...(attempts.at(-1)?.costUsd !== undefined ? { costUsd: attempts.at(-1)!.costUsd } : {}),
    attemptCosts: attempts.map(({ resume, session, costUsd }) => ({ resume, session, costUsd })),
  }
}
