import fs from 'node:fs'
import path from 'node:path'
import { withLock } from '../lock'

export type RetrySource = 'runtime' | 'runner' | 'sync' | 'validation'
export type RetryState = 'waiting' | 'retrying' | 'recovered' | 'paused'
export type SessionAction = 'resume' | 'reset_replay' | 'pause_unsafe'
export type PauseReason = 'limit' | 'wait_too_long' | 'unsafe' | 'authorization' | 'stopped' | 'manual'

export interface RetryRuntime {
  connector: string
  name: string | null
  model: string | null
}

export interface RetryRecord {
  attempt: number
  source: RetrySource
  runtime?: RetryRuntime
  summary: string
  detail?: string
  code?: string
  sessionAction?: SessionAction
  at: string
}

export interface RetryEventData {
  state: RetryState
  source: RetrySource
  runtime?: RetryRuntime
  attempt: number
  maxAttempts: number
  summary: string
  detail?: string
  code?: string
  nextRetryAt?: string
  sessionAction?: SessionAction
  at: string
}

export interface FailureDetail {
  summary: string
  detail?: string
  code?: string
  source: RetrySource
  runtime?: RetryRuntime
  attempt: number
  maxAttempts: number
  pauseReason: PauseReason
  safeToRetry: boolean
  sessionAction?: SessionAction
  history: RetryRecord[]
}

export interface ExecutionFailure {
  code?: string
  source: RetrySource
  summary: string
  detail?: string
  retryAfterMs?: number
}

export interface RetryPlan {
  at: number
  of: number
  failure: ExecutionFailure
  sessionAction?: SessionAction
}

export type RetryPause = PauseReason
export type Recovery = 'report' | 'resume' | 'replay' | 'unsafe'

export const MAX_RETRY_ATTEMPTS = 4
export const RETRY_FILE_ENV = 'AI4KANBAN_RETRY_FILE'

// Persist before invoking the recovery. Runner and detached CLI watches share this counter.
export function retryBudget(file: string, initialAttempt = 1) {
  const attempt = () => {
    try {
      const saved = fs.readFileSync(file, 'utf8')
      const used = Number(saved)
      return /^\d+$/.test(saved) && Number.isSafeInteger(used) && used <= MAX_RETRY_ATTEMPTS
        ? used + 1 : MAX_RETRY_ATTEMPTS + 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 1
      throw error
    }
  }
  const update = (advance: (current: number) => number) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    return withLock(file + '.lock', 'recording a task retry', () => {
      const current = attempt()
      const next = advance(current)
      if (next > MAX_RETRY_ATTEMPTS + 1) return
      if (next !== current) {
        fs.writeFileSync(file + '.tmp', String(next - 1), { mode: 0o600 })
        fs.renameSync(file + '.tmp', file)
      }
      return next
    })
  }
  if (initialAttempt > 1) update(current => Math.max(current, initialAttempt))
  return { attempt, take: () => update(current => current + 1) }
}

export function retryRecord(failure: ExecutionFailure, attempt: number, runtime: RetryRuntime, sessionAction?: SessionAction): RetryRecord {
  const { source, summary, detail, code } = failure
  return { attempt, source, runtime, summary, ...(detail ? { detail } : {}), ...(code ? { code } : {}),
    ...(sessionAction ? { sessionAction } : {}), at: new Date().toISOString() }
}

export function mergeRetryHistory(...histories: (RetryRecord[] | undefined)[]): RetryRecord[] {
  const records = histories.flatMap(history => history ?? [])
  return [...new Map(records.map(record => [JSON.stringify(record), record])).values()]
    .sort((a, b) => a.at.localeCompare(b.at))
}

export async function waitForRetry(at: number, stopped?: Promise<unknown>): Promise<void> {
  const delay = Math.max(0, at - Date.now())
  if (!delay) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([new Promise<void>(resolve => { timer = setTimeout(resolve, delay) }), ...(stopped ? [stopped] : [])])
  } finally {
    clearTimeout(timer)
  }
}
const MAX_SUMMARY_CHARS = 300
const MAX_DETAIL_CHARS = 4000
const SOURCES = new Set<RetrySource>(['runtime', 'runner', 'sync', 'validation'])
const SESSION_ACTIONS = new Set<SessionAction>(['resume', 'reset_replay', 'pause_unsafe'])

export function clipSummary(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > MAX_SUMMARY_CHARS ? `${clean.slice(0, MAX_SUMMARY_CHARS - 1)}…` : clean
}

export function clipDetail(text: string | undefined): string | undefined {
  if (!text) return undefined
  const trimmed = text.trim()
  if (!trimmed) return undefined
  return trimmed.length > MAX_DETAIL_CHARS ? `${trimmed.slice(0, MAX_DETAIL_CHARS - 1)}…` : trimmed
}

export function makeFailure(
  source: RetrySource,
  rawSummary: string,
  options?: { code?: string; detail?: string; retryAfterMs?: number },
): ExecutionFailure {
  const summary = clipSummary(rawSummary) || 'Execution failed.'
  const rawDetail = options?.detail?.trim() || (rawSummary.trim().length > summary.length || rawSummary.includes('\n') ? rawSummary.trim() : undefined)
  const detail = clipDetail(rawDetail)
  return {
    ...(options?.code ? { code: options.code } : {}),
    source,
    summary,
    ...(detail && detail !== summary ? { detail } : {}),
    ...(typeof options?.retryAfterMs === 'number' && Number.isFinite(options.retryAfterMs) && options.retryAfterMs >= 0
      ? { retryAfterMs: options.retryAfterMs }
      : {}),
  }
}

const SESSION_MISSING_RE =
  /no rollout found for thread id|no conversation found with session id|session[_\s-]*not[_\s-]*found|session[_\s-]*mismatch|(?:session|thread|conversation)\s+\S+\s+not\s+found|unknown\s+(?:session|thread)|did not resume the requested conversation|did not return the requested session/i

export function isSessionMissingText(text: string | undefined): boolean {
  return !!text && SESSION_MISSING_RE.test(text)
}

export function isSessionMissingFailure(failure: ExecutionFailure | undefined): boolean {
  if (!failure) return false
  if (failure.code === 'session_not_found' || failure.code === 'session_mismatch') return true
  return isSessionMissingText(failure.summary) || isSessionMissingText(failure.detail)
}

type RecoveryEvidence = {
  stopped: boolean
  completed?: boolean
  session?: string | null
  replayable?: boolean
  unconfirmedCleanup?: boolean
}

export function resumeBlocked({ stopped, session, unconfirmedCleanup }: RecoveryEvidence, zh = false): string | undefined {
  if (!stopped) return zh ? '无法确认原执行已退出。' : 'The previous execution could not be confirmed stopped.'
  if (unconfirmedCleanup) return zh ? '无法确认操作结果已收齐。' : 'The operation results could not be confirmed complete.'
  if (!session) return zh ? '无法接回原会话。' : 'The original session is unavailable.'
}

export function agentRecovery(evidence: RecoveryEvidence): Recovery {
  if (!evidence.stopped) return 'unsafe'
  if (evidence.completed) return 'report'
  if (evidence.unconfirmedCleanup) return 'unsafe'
  if (!resumeBlocked(evidence)) return 'resume'
  return evidence.replayable ? 'replay' : 'unsafe'
}

export const recoveryPrompt =
  'Continue the interrupted turn in this session. Check the current state and the results of previous operations first. Preserve completed work and user decisions. Do not repeat an operation whose result has already taken effect.'

export function retryContinuePrompt(failure: ExecutionFailure, attempt?: number, maxAttempts = MAX_RETRY_ATTEMPTS): string {
  const head = attempt
    ? `Previous attempt (${attempt}/${maxAttempts + 1}) failed [${failure.source}${failure.code ? `:${failure.code}` : ''}]: ${failure.summary}`
    : `Previous execution failed [${failure.source}${failure.code ? `:${failure.code}` : ''}]: ${failure.summary}`
  const parts = [head]
  if (failure.detail && failure.detail !== failure.summary) parts.push(`Diagnostics:\n${failure.detail}`)
  parts.push(recoveryPrompt)
  return parts.join('\n\n')
}

const BASE_MS = 15_000
const CAP_MS = 120_000

/** The original attempt is 1. Subsequent attempts use jittered exponential backoff (15s–120s). */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const step = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempt - 2))
  return Math.round(step * (1 - 0.25 * random()))
}

export function planRetry(
  failure: ExecutionFailure,
  attempt: number,
  now = Date.now(),
  backoff = backoffMs,
  task = false,
): { plan: RetryPlan } | { pause: RetryPause } {
  if (!Number.isSafeInteger(attempt) || attempt < 1) return { pause: 'unsafe' }
  const of = MAX_RETRY_ATTEMPTS
  if (failure.code === 'completed_operation_failed') return { pause: task ? 'manual' : 'unsafe' }
  if (['provider_refused', 'executable_missing', 'execution_blocked', 'unauthenticated', 'quota_exhausted', 'insufficient_quota'].includes(failure.code ?? '')
    || failure.source === 'runtime' && /\b(?:401 unauthorized|please (?:log in|login|sign in)|authentication failed|permission denied|(?:credits?|quota) (?:is |has been )?(?:exhausted|exceeded)|invalid model selection)\b/i.test(failure.summary)) {
    return { pause: 'authorization' }
  }
  if (attempt > of) return { pause: 'limit' }
  const delay = failure.retryAfterMs
  const valid = delay !== undefined && !Number.isNaN(delay) && delay >= 0
  const immediate = failure.source === 'validation'
  const wait = valid ? delay : immediate ? 0 : backoff(attempt + 1)
  const cap = task && failure.code === 'rate_limited' && valid ? 24 * 60 * 60_000 : CAP_MS
  if (wait > cap) return { pause: 'wait_too_long' }
  return { plan: { at: now + wait, of, failure } }
}

function normalizeSource(raw: unknown): RetrySource {
  if (SOURCES.has(raw as RetrySource)) return raw as RetrySource
  if (raw === 'provider' || raw === 'harness') return 'runtime'
  if (raw === 'invariant') return 'runner'
  return 'runtime'
}

export function readFailure(raw: unknown): ExecutionFailure | undefined {
  if (!raw || typeof raw !== 'object') return
  const r = raw as Record<string, unknown>
  const rawSummary = typeof r.summary === 'string' && r.summary.trim()
    ? r.summary
    : typeof r.reason === 'string' && r.reason.trim()
      ? r.reason
      : ''
  if (!rawSummary) return
  const code = typeof r.code === 'string' && r.code.trim() ? r.code.trim() : undefined
  const detail = typeof r.detail === 'string' ? clipDetail(r.detail) : undefined
  const retryAfterMs = typeof r.retryAfterMs === 'number' && Number.isFinite(r.retryAfterMs) && r.retryAfterMs >= 0
    ? r.retryAfterMs
    : undefined
  return {
    ...(code ? { code } : {}),
    source: normalizeSource(r.source),
    summary: clipSummary(rawSummary),
    ...(detail && detail !== clipSummary(rawSummary) ? { detail } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  }
}

export function readRetryRuntime(raw: unknown): RetryRuntime | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.connector !== 'string' || !r.connector.trim()) return undefined
  return {
    connector: r.connector.trim(),
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : null,
    model: typeof r.model === 'string' && r.model.trim() ? r.model.trim() : null,
  }
}

export function readRetryRecord(raw: unknown): RetryRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const attempt = r.attempt
  const summary = typeof r.summary === 'string' ? clipSummary(r.summary) : ''
  const at = typeof r.at === 'string' && r.at.trim() ? r.at.trim() : ''
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1 || !summary || !at) return undefined
  const runtime = readRetryRuntime(r.runtime)
  const detail = typeof r.detail === 'string' ? clipDetail(r.detail) : undefined
  const code = typeof r.code === 'string' && r.code.trim() ? r.code.trim() : undefined
  const sessionAction = SESSION_ACTIONS.has(r.sessionAction as SessionAction) ? (r.sessionAction as SessionAction) : undefined
  return {
    attempt,
    source: normalizeSource(r.source),
    ...(runtime ? { runtime } : {}),
    summary,
    ...(detail && detail !== summary ? { detail } : {}),
    ...(code ? { code } : {}),
    ...(sessionAction ? { sessionAction } : {}),
    at,
  }
}

export function readRetryHistory(raw: unknown): RetryRecord[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const records = raw.flatMap((entry) => {
    const parsed = readRetryRecord(entry)
    return parsed ? [parsed] : []
  })
  return records.length ? records : undefined
}

export function readRetryPause(raw: unknown): RetryPause | undefined {
  if (raw === 'wait-too-long') return 'wait_too_long'
  if (raw === 'needs-review') return 'limit'
  if (raw === 'limit' || raw === 'wait_too_long' || raw === 'unsafe' || raw === 'authorization' || raw === 'stopped' || raw === 'manual') return raw
  return undefined
}

export function readRetryPlan(raw: unknown, attempt: number, task = false): RetryPlan | undefined {
  if (!raw || typeof raw !== 'object') return
  const { at, of, failure: rawFailure, sessionAction } = raw as Partial<RetryPlan>
  const failure = readFailure(rawFailure)
  if (!failure || typeof at !== 'number' || !Number.isFinite(at)) return
  const decision = planRetry(failure, attempt, Date.now(), backoffMs, task)
  if ('plan' in decision && of === decision.plan.of) {
    return { at, of, failure, ...(SESSION_ACTIONS.has(sessionAction as SessionAction) ? { sessionAction } : {}) }
  }
}

export function pauseLine(pause: RetryPause, zh = false): string {
  switch (pause) {
    case 'limit': return zh ? '已达到自动重试次数上限。' : 'The automatic retry limit was reached.'
    case 'wait_too_long': return zh ? '所需等待时间超过两分钟，已暂停。' : 'Paused because the required wait exceeds two minutes.'
    case 'unsafe': return zh ? '无法确认可以安全续跑，请先核对已有进度和操作结果。' : 'Check saved progress and operation results before resuming safely.'
    case 'authorization': return zh ? '无法确认续跑授权，已暂停。' : 'Paused because authorization to resume could not be confirmed.'
    case 'stopped': return zh ? '执行已停止。' : 'Execution stopped.'
    case 'manual': return zh ? '请核对失败的操作后继续执行。' : 'Check the failed operation, then resume.'
  }
}

export function retryLine(plan: RetryPlan, attempt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((plan.at - now) / 1_000))
  return `${plan.failure.summary} — retrying ${seconds ? `in ${seconds}s` : 'now'} (retry ${attempt} of ${plan.of}).`
}

export function syncRepairPrompt(reason: string): string {
  return `The Harness could not synchronize the saved result. Correct the diagnostics below, verify the original result and its attachments, then continue from the saved work. Preserve completed work and archive state. Read the task review before changing an approved output and revise its stage first.

${reason}`
}
