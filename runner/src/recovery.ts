import { stopConnection } from '../../cli/src/lib/agent/connection-process'
import fs from 'node:fs'
import path from 'node:path'

import { killMarked, processesStopped, type Mark } from '../../cli/src/lib/agent/stop'
import { readFailure, readRetryPlan, type ExecutionFailure, type RetryPause, type RetryPlan } from '../../cli/src/lib/agent/retry'
import type { RunEvent } from '../../cli/src/lib/agent/wire'
import type { JobReport } from './api'
import { runnerHome } from './home'

export const UNCERTAIN = '更新中断时有操作结果尚未确认，请检查已有结果后再续跑。'

export interface Checkpoint {
  forkSource?: string
  reviewedRejections?: import('./triage').Laid
  boardContinuation?: { report: JobReport; facts: string; prompt: string; validation?: boolean }
  approvalRequested?: boolean
  approvalCancelled?: boolean
  mark?: Mark
  managedProcess?: boolean
  cleanup?: import('../../cli/src/lib/agent/wire/codex-background').Cleanup
  process?: { pid: number; since: number; identity?: string }
  updating?: boolean
  session?: string
  submitted?: boolean
  started?: boolean
  opaque?: boolean
  effects?: boolean
  retry?: { since: number; attempt: number; pending?: RetryPlan; at?: number }
  failure?: ExecutionFailure
  retryPause?: RetryPause
  launching?: true
  attempts?: (Pick<JobReport, 'session' | 'usage' | 'costUsd' | 'costIncomplete'> & { resume?: string | null })[]
  partialReply?: string
  pending: string[]
  completed?: { outcome: 'done' | 'failed'; reason?: string; report: JobReport }
}

const fileOf = (id: string) => path.join(runnerHome(), 'checkpoints', `${encodeURIComponent(id)}.json`)

export function readCheckpoint(id: string): Checkpoint | null {
  try {
    const held = JSON.parse(fs.readFileSync(fileOf(id), 'utf8')) as Checkpoint
    if (!held || !Array.isArray(held.pending) || !held.pending.every((id) => typeof id === 'string')) throw new Error('进度格式错误')
    held.failure = readFailure(held.failure)
    if (held.retry?.pending) {
      const pending = readRetryPlan(held.retry.pending, held.retry.attempt)
      if (!pending) held.retry.at = held.retry.pending.at ?? 0
      held.retry.pending = pending
    }
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
  fs.rmSync(fileOf(id), { force: true })
}

export function checkpointEvent(checkpoint: Checkpoint, event: RunEvent): void {
  if (event.kind === 'phase' && event.data.phase === 'submitted') checkpoint.submitted = true
  if (event.kind === 'tool_call') {
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
  return checkpoint.submitted !== true && (checkpoint.effects === false || checkpoint.started === false) && !checkpoint.pending.length && !checkpoint.opaque
}

export function resumable(checkpoint: Checkpoint): boolean {
  return !!checkpoint.session && !checkpoint.pending.length && !checkpoint.opaque && checkpoint.cleanup?.status !== 'unconfirmed'
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
