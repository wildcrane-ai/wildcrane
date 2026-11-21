import { isSessionMissingText, makeFailure, readFailure, type ExecutionFailure } from '../retry'
import { obj, str } from './json'

export class ExecutionError extends Error {
  constructor(readonly failure: ExecutionFailure) { super(failure.summary) }
}

const NETWORK = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET'])
const TEMPORARY_HTTP = new Set([502, 503, 504, 529])

export function executionFailure(error: unknown): ExecutionFailure {
  if (error instanceof ExecutionError) return error.failure
  const code = str(obj(error).code)
  const raw = error instanceof Error ? error.message : String(error)
  const resolvedCode = isSessionMissingText(raw)
    ? 'session_not_found'
    : NETWORK.has(code)
      ? 'connection_lost'
      : code === 'ENOENT'
        ? 'executable_missing'
        : 'execution_failed'
  return makeFailure('runner', raw, { code: resolvedCode, detail: raw })
}

function retryAfterMs(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== 'string') return
  const header = value.trim()
  if (/^\d+$/.test(header)) return Math.min(Number(header) * 1000, Number.MAX_SAFE_INTEGER)
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)) return
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - now)
}

export function providerFailure(error: unknown, reason: string, detail?: string): ExecutionFailure {
  const info = obj(error)
  const status = typeof info.status === 'number' ? info.status : undefined
  const headers = obj(info.headers)
  const wait = retryAfterMs(headers['retry-after'] ?? headers['Retry-After'])
  const rawCode = info.code ?? info.type
  const fullDetail = detail || reason
  if (rawCode === 'session_not_found' || isSessionMissingText(reason) || isSessionMissingText(fullDetail)) {
    return makeFailure('runtime', reason, { code: 'session_not_found', detail: fullDetail })
  }
  if (status === 401 || status === 403 || ['authentication_error', 'permission_error', 'invalid_request_error'].includes(str(rawCode))) {
    return makeFailure('runtime', reason, { code: 'provider_refused', detail: fullDetail })
  }
  if (status === 429 || rawCode === 'rate_limit_error') {
    return makeFailure('runtime', reason, { code: 'rate_limited', detail: fullDetail, retryAfterMs: wait })
  }
  if (TEMPORARY_HTTP.has(status ?? 0) || rawCode === 'overloaded_error') {
    return makeFailure('runtime', reason, { code: 'service_overloaded', detail: fullDetail, retryAfterMs: wait })
  }
  if (NETWORK.has(str(rawCode))) {
    return makeFailure('runtime', reason, { code: 'connection_lost', detail: fullDetail, retryAfterMs: wait })
  }
  return makeFailure('runtime', reason, { code: 'provider_failed', detail: fullDetail, retryAfterMs: wait })
}

export function codexFailure(raw: unknown, fallback: string): ExecutionFailure {
  const error = obj(raw)
  const failure = readFailure(error.wildcraneFailure)
  if (failure) return failure
  const reason = str(error.message) || fallback
  const additional = str(error.additionalDetails)
  const detail = [reason, additional].filter(Boolean).join('\n')
  const info = error.codexErrorInfo
  if (info === 'serverOverloaded') return providerFailure({ ...error, type: 'overloaded_error' }, reason, detail)
  if (info === 'rateLimitExceeded') return providerFailure({ ...error, type: 'rate_limit_error' }, reason, detail)
  const types = obj(info)
  for (const kind of ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']) {
    if (!(kind in types)) continue
    const status = obj(types[kind]).httpStatusCode
    if (typeof status === 'number') return providerFailure({ ...error, status }, reason, detail)
    if (kind !== 'responseTooManyFailedAttempts') return providerFailure({ ...error, code: 'ECONNRESET' }, reason, detail)
  }
  return providerFailure(error, reason, detail)
}
