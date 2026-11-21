import { translating } from './language'

export interface ExecutionFailure {
  code: string
  level: 1 | 2 | 3
  reason: string
  source?: 'validation' | 'provider' | 'harness' | 'invariant'
  retryAfterMs?: number
}

export interface RetryPlan {
  at: number
  of: number
  failure: ExecutionFailure
}

export type RetryPause = 'needs-review' | 'limit' | 'wait-too-long' | 'unsafe' | 'authorization'

export type Recovery = 'report' | 'resume' | 'replay' | 'unsafe'

export function agentRecovery(evidence: {
  stopped: boolean
  completed?: boolean
  session?: string | null
  replayable?: boolean
  unconfirmedCleanup?: boolean
}): Recovery {
  if (!evidence.stopped) return 'unsafe'
  if (evidence.completed) return 'report'
  if (evidence.unconfirmedCleanup) return 'unsafe'
  if (evidence.session) return 'resume'
  return evidence.replayable ? 'replay' : 'unsafe'
}

export const recoveryPrompt = 'Continue the interrupted turn in this session. Check the current state and the results of previous operations first. Preserve completed work and user decisions. Do not repeat an operation whose result has already taken effect.'

const BASE_MS = 15_000
const CAP_MS = 120_000

/** The original attempt is 1. The next three attempts use this same curve. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const step = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempt - 2))
  return Math.round(step * (1 - 0.25 * random()))
}

export function planRetry(failure: ExecutionFailure, attempt: number, now = Date.now(), backoff = backoffMs, task = false):
  { plan: RetryPlan } | { pause: RetryPause } {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || failure.level === 3) return { pause: 'needs-review' }
  const of = failure.level === 1 ? 2 : 4
  if (attempt >= of) return { pause: 'limit' }
  const delay = failure.retryAfterMs
  const valid = delay !== undefined && !Number.isNaN(delay) && delay >= 0
  const wait = valid ? delay : failure.level === 1 ? 0 : backoff(attempt + 1)
  const cap = task && failure.code === 'rate_limited' && valid ? 24 * 60 * 60_000 : CAP_MS
  if (wait > cap) return { pause: 'wait-too-long' }
  return { plan: { at: now + wait, of, failure } }
}

export function readFailure(raw: unknown): ExecutionFailure | undefined {
  if (!raw || typeof raw !== 'object') return
  const { code, level, reason, source, retryAfterMs } = raw as Partial<ExecutionFailure>
  if (typeof code !== 'string' || !code || typeof reason !== 'string' || (level !== 1 && level !== 2 && level !== 3)) return
  return { code, level, reason, ...(['validation', 'provider', 'harness', 'invariant'].some(value => value === source) ? { source } : {}), ...(typeof retryAfterMs === 'number' && retryAfterMs >= 0 ? { retryAfterMs } : {}) }
}

export function readRetryPlan(raw: unknown, attempt: number, task = false): RetryPlan | undefined {
  if (!raw || typeof raw !== 'object') return
  const { at, of, failure: rawFailure } = raw as Partial<RetryPlan>
  const failure = readFailure(rawFailure)
  if (!failure || typeof at !== 'number' || !Number.isFinite(at)) return
  const decision = planRetry(failure, attempt, Date.now(), backoffMs, task)
  if ('plan' in decision && of === decision.plan.of) return { at, of, failure }
}

export function pauseLine(pause: RetryPause, zh = translating()): string {
  switch (pause) {
    case 'needs-review': return zh ? '已暂停，请检查失败原因后续跑。' : 'Paused. Review the failure before resuming.'
    case 'limit': return zh ? '已达到自动重试次数上限。' : 'The automatic retry limit was reached.'
    case 'wait-too-long': return zh ? '所需等待时间超过两分钟，已暂停。' : 'Paused because the required wait exceeds two minutes.'
    case 'unsafe': return zh ? '无法确认可以安全续跑，请先核对已有进度和操作结果。' : 'Check saved progress and operation results before resuming safely.'
    case 'authorization': return zh ? '无法确认续跑授权，已暂停。' : 'Paused because authorization to resume could not be confirmed.'
  }
}

export function retryLine(plan: RetryPlan, attempt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((plan.at - now) / 1_000))
  return `${plan.failure.reason} — retrying ${seconds ? `in ${seconds}s` : 'now'} (attempt ${attempt + 1} of ${plan.of}).`
}

export function syncRepairPrompt(reason: string): string {
  return `The Harness could not synchronize the saved result. Correct the diagnostics below, verify the original result and its attachments, then continue from the saved work. Preserve completed work and archive state. Read the task review before changing an approved output and revise its stage first.

${reason}`
}
