import { BoardError } from '../io'

export interface CloudProblem {
  code: string
  message: string
  status?: number
  retryable: boolean
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export const hasText = (value: unknown): value is string => typeof value === 'string' && !!value.trim()

export function temporaryCloudFailure({ code, status }: { code?: string; status?: number }): boolean {
  if (code && ['unauthenticated', 'machine_offline', 'quota_exceeded', 'daily_write_budget_reached', 'storage_limit_reached'].includes(code)) return false
  return ['unreachable', 'invalid_response', 'idempotency_in_progress', 'service_unavailable', 'artifacts_unavailable'].includes(code ?? '')
    || status === 408 || (status !== undefined ? status >= 500 : !code)
}

export const invalidResponse = (expected: string): CloudProblem =>
  ({ code: 'invalid_response', message: `Cloud did not return ${expected}.`, retryable: true })

export async function readCloudJson(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined)
}

export function cloudProblem(response: Response, body: unknown): CloudProblem | null {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null
  if (response.ok && !error) return null
  const status = response.status
  const code = hasText(error?.code) ? error.code
    : status === 401 ? 'unauthenticated' : status >= 500 ? 'service_unavailable' : 'refused'
  const message = hasText(error?.message) ? error.message : `Cloud answered ${status}.`
  return { code, message, status, retryable: temporaryCloudFailure({ code, status }) }
}

export function cloudError(problem: CloudProblem, options: { bare?: boolean; exitCode?: number; kind?: string; details?: Record<string, unknown> } = {}): BoardError {
  return new BoardError(problem.message, { bare: options.bare, exitCode: options.exitCode, ...options.details, kind: options.kind ?? problem.code,
    code: problem.code, status: problem.status, retryable: problem.retryable })
}

export function requireResponse<T>(value: T, expected: string, check: (value: T) => boolean): T {
  if (!isRecord(value) || !check(value)) throw cloudError(invalidResponse(expected))
  return value
}

export async function cloudBytes(response: Response, expected: string, options: { size?: number } = {}): Promise<Buffer> {
  const bytes = await response.arrayBuffer().then(data => Buffer.from(data), () => null)
  const length = response.headers.get('content-length')
  const compressed = response.headers.has('content-encoding')
  if (response.status !== 200 || response.headers.has('content-range') || !bytes || (options.size === undefined && !bytes.length)
      || (length !== null && !compressed && (!/^\d+$/.test(length) || bytes.length !== Number(length)))
      || (options.size !== undefined && bytes.length !== options.size)) {
    throw cloudError(invalidResponse(expected))
  }
  return bytes
}
