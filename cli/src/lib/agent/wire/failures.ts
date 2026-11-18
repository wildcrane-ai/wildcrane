import { readFailure, type ExecutionFailure } from '../retry'
import { obj, str } from './json'

export class ExecutionError extends Error {
  constructor(readonly failure: ExecutionFailure) { super(failure.reason) }
}

const NETWORK = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET'])
const TEMPORARY_HTTP = new Set([502, 503, 504, 529])

export function executionFailure(error: unknown): ExecutionFailure {
  if (error instanceof ExecutionError) return error.failure
  const code = str(obj(error).code)
  const reason = error instanceof Error ? error.message : String(error)
  return {
    code: NETWORK.has(code) ? 'connection_lost' : code === 'ENOENT' ? 'executable_missing' : 'execution_failed',
    level: NETWORK.has(code) ? 2 : 3,
    source: 'harness',
    reason,
  }
}

function retryAfterMs(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== 'string') return
  const header = value.trim()
  if (/^\d+$/.test(header)) return Math.min(Number(header) * 1000, Number.MAX_SAFE_INTEGER)
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)) return
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - now)
}

export function providerFailure(error: unknown, reason: string): ExecutionFailure {
  const info = obj(error)
  const status = typeof info.status === 'number' ? info.status : undefined
  const headers = obj(info.headers)
  const wait = retryAfterMs(headers['retry-after'] ?? headers['Retry-After'])
  const code = info.code ?? info.type
  if (code === 'session_not_found') return { code, source: 'provider', level: 3, reason }
  if (status === 401 || status === 403 || ['authentication_error', 'permission_error', 'invalid_request_error'].includes(str(code))) {
    return { code: 'provider_refused', source: 'provider', level: 3, reason }
  }
  if (code === 'rate_limit_error') return { code: 'rate_limited', source: 'provider', level: 2, reason, retryAfterMs: wait }
  if (TEMPORARY_HTTP.has(status ?? 0) || code === 'overloaded_error') return { code: 'service_overloaded', source: 'provider', level: 2, reason, retryAfterMs: wait }
  if (NETWORK.has(str(code))) return { code: 'connection_lost', source: 'provider', level: 2, reason, retryAfterMs: wait }
  return { code: 'provider_failed', source: 'provider', level: 3, reason }
}

export function codexFailure(raw: unknown, fallback: string): ExecutionFailure {
  const error = obj(raw)
  const failure = readFailure(error.wildcraneFailure)
  if (failure?.source === 'harness' || failure?.source === 'invariant') return failure
  const reason = str(error.message) || fallback
  const info = error.codexErrorInfo
  if (info === 'serverOverloaded') return providerFailure({ ...error, type: 'overloaded_error' }, reason)
  if (info === 'rateLimitExceeded') return providerFailure({ ...error, type: 'rate_limit_error' }, reason)
  const types = obj(info)
  for (const kind of ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']) {
    if (!(kind in types)) continue
    const status = obj(types[kind]).httpStatusCode
    if (typeof status === 'number') return providerFailure({ ...error, status }, reason)
    if (kind !== 'responseTooManyFailedAttempts') return providerFailure({ ...error, code: 'ECONNRESET' }, reason)
  }
  return providerFailure(error, reason)
}
