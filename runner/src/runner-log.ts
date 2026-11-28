import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Writable } from 'node:stream'

import { tryLock } from '../../cli/src/lib/lock'
import { runnerHome } from './home'

const MAX_BYTES = 5 * 1024 * 1024
const OUTPUT_CHARS = 32 * 1024
const ARCHIVES = 3
const DAY_MS = 86_400_000
const MAINTENANCE_MS = 60_000
const ARCHIVE_NAME = /^runner\.log\.(\d{4}-\d{2}-\d{2})\.([1-9]\d*)$/
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0
const waitWord = new Int32Array(new SharedArrayBuffer(4))

const EVENTS = {
  launcher: ['starting', 'startup_failed', 'connected', 'exited', 'update_ready', 'update_failed', 'update_deferred', 'rollback'],
  runner: ['starting', 'startup_failed', 'connected', 'reconnecting', 'connection_refused', 'exited'],
  worker: ['starting', 'exited'],
  task: ['exited'],
  board: ['failed'],
  preview: ['failed'],
} as const

const SOURCES = new Set(['terminal', 'codex', 'claude-code', 'cursor', 'dsh', 'zcode', 'kimi', 'grok', 'opencode', 'antigravity'])
const STAGES = new Set(['plugin_entry', 'spawn', 'download', 'signin', 'lock', 'startup', 'registration', 'realtime',
  'pull', 'push', 'create_artifact', 'create_upload', 'upload', 'complete_upload', 'commit_version'])
const CODES = new Set([
  'already_running', 'artifacts_unavailable', 'bad_request', 'board_content_conflict', 'conflict', 'content_too_large',
  'connection_closed', 'crashed', 'daily_write_budget_reached', 'forbidden', 'heartbeat_error', 'heartbeat_timeout',
  'idempotency_in_progress', 'integrity', 'invalid_response', 'join_timeout', 'local_changed', 'machine_offline',
  'node', 'not_found', 'open_timeout', 'ph_close', 'ph_error', 'quota_exceeded', 'refused', 'runner_elsewhere',
  'runner_outdated', 'send_failed', 'service_unavailable', 'signed_out', 'storage_limit_reached', 'system',
  'timeout', 'unauthenticated', 'unavailable', 'unreachable', 'version_conflict',
  'EACCES', 'EADDRINUSE', 'EIO', 'EMFILE', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'EPERM', 'EROFS',
])
const SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL', 'SIGABRT', 'SIGQUIT', 'SIGSEGV'])
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-(?:alpha|beta|rc|test)(?:\.\d{1,9}){0,3})?$/
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const JOB_ID = /^[a-z0-9_-]{1,128}$/i

type Component = keyof typeof EVENTS
type Stream = 'stdout' | 'stderr'
type OutputFields = { source?: string; job?: string; pid?: number }
type Fields = {
  version?: unknown
  source?: unknown
  stage?: unknown
  task?: unknown
  job?: unknown
  pid?: unknown
  code?: unknown
  status?: unknown
  exitCode?: unknown
  signal?: unknown
}

const allowed = (values: Set<string>, value: unknown) => typeof value === 'string' && values.has(value) ? value : undefined
const matches = (pattern: RegExp, value: unknown) => typeof value === 'string' && pattern.test(value) ? value : undefined
const integer = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined
export const errno = (error: unknown): unknown =>
  error instanceof Error ? (error as NodeJS.ErrnoException).code ?? 'unknown_error' : 'unknown_error'

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function logDay(file: string, stat: fs.Stats): string {
  const prefix = Buffer.alloc(20)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW)
  try { fs.readSync(fd, prefix) } finally { fs.closeSync(fd) }
  return /^\{"time":"(\d{4}-\d{2}-\d{2})T/.exec(prefix.toString())?.[1] ?? utcDay(stat.mtimeMs)
}

function append(file: string, bytes: Buffer, size: number): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | NO_FOLLOW, 0o600)
  try {
    if (fs.writeSync(fd, bytes) !== bytes.length) {
      fs.ftruncateSync(fd, size)
      throw new Error('Incomplete Runner log write')
    }
  } finally { fs.closeSync(fd) }
}

function maintain(dir: string, now: Date, line?: Buffer): void {
  const current = path.join(dir, 'runner.log')
  const today = utcDay(+now)
  const oldest = utcDay(+now - 6 * DAY_MS)
  const stat = fs.lstatSync(current, { throwIfNoEntry: false })
  if (stat && !stat.isFile()) throw new Error('Invalid Runner log file')
  const day = stat?.size ? logDay(current, stat) : today
  const size = stat?.size ?? 0
  const rotate = size > 0 && (day !== today || size + (line?.length ?? 0) > MAX_BYTES)
  const archives = fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const match = entry.isFile() && ARCHIVE_NAME.exec(entry.name)
    return match ? [{ file: path.join(dir, entry.name), day: match[1]!, seq: Number(match[2]) }] : []
  })
  if (rotate) {
    const seq = archives.reduce((last, archive) => archive.day === day ? Math.max(last, archive.seq) : last, 0) + 1
    const file = `${current}.${day}.${seq}`
    fs.renameSync(current, file)
    archives.push({ file, day, seq })
  }
  let kept = 0
  for (const archive of archives.sort((a, b) => b.day.localeCompare(a.day) || b.seq - a.seq)) {
    if (kept >= ARCHIVES || archive.day < oldest) {
      fs.unlinkSync(archive.file)
    } else kept++
  }
  if (line) append(current, line, rotate ? 0 : size)
}

let lastWarning = -Infinity
function withLogLock(write: (dir: string) => void): void {
  try {
    const dir = path.join(runnerHome(), 'logs')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('Invalid Runner log directory')
    const deadline = performance.now() + 150
    do {
      const unlock = tryLock(path.join(dir, 'runner.log.lock'))
      if (unlock) {
        try { write(dir) } finally { unlock() }
        return
      }
      Atomics.wait(waitWord, 0, 0, 5)
    } while (performance.now() < deadline)
  } catch { /* Diagnostics must never interrupt the Runner. */ }
  if (performance.now() - lastWarning >= MAINTENANCE_MS) {
    lastWarning = performance.now()
    try { fs.writeSync(2, 'WildCrane could not write its local Runner log.\n') } catch {}
  }
}

let maintenance: ReturnType<typeof setInterval> | undefined
export function startRunnerLogMaintenance(): void {
  maintenance ??= setInterval(() => withLogLock(dir => maintain(dir, new Date())), MAINTENANCE_MS).unref()
}

function writeRecord(record: object): void {
  withLogLock(dir => {
    const now = new Date()
    maintain(dir, now, Buffer.from(JSON.stringify({ time: now.toISOString(), ...record }) + '\n'))
  })
}

export function logRunnerOutput(component: Component, stream: Stream, text: string, fields: OutputFields = {}): void {
  const source = allowed(SOURCES, fields.source)
  const job = matches(JOB_ID, fields.job)
  for (let offset = 0; offset < text.length; offset += OUTPUT_CHARS) {
    writeRecord({ component, event: 'output', stream, pid: fields.pid ?? process.pid, source, job,
      text: text.slice(offset, offset + OUTPUT_CHARS) })
  }
}

export function logChildOutput(child: ChildProcess, component: Component, fields: OutputFields): void {
  const context = { ...fields, pid: child.pid }
  for (const stream of ['stdout', 'stderr'] as const) {
    child[stream]?.setEncoding('utf8').on('data', (text: string) => logRunnerOutput(component, stream, text, context))
  }
  child.on('error', error => logRunnerOutput(component, 'stderr', `${error.stack ?? error.message}\n`, context))
  if (component === 'task') child.once('close', (exitCode, signal) => logRunner(component, 'exited', { ...context, exitCode, signal }))
}

export function captureRunnerOutput(component: Component, fields: OutputFields = {}, stderrOnly = false): void {
  startRunnerLogMaintenance()
  for (const stream of stderrOnly ? ['stderr'] as const : ['stdout', 'stderr'] as const) {
    const output = process[stream]
    const write = output.write.bind(output)
    output.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      logRunnerOutput(component, stream, typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'), fields)
      return typeof encoding === 'function' ? write(chunk, encoding) : write(chunk, encoding, callback)
    }) as Writable['write']
  }
  process.on('uncaughtExceptionMonitor', error => logRunnerOutput(component, 'stderr', `${error.stack ?? error.message}\n`, fields))
}

export function logRunner<C extends Component>(component: C, event: (typeof EVENTS)[C][number], fields: Fields = {}): void {
  if (!Object.hasOwn(EVENTS, component) || !(EVENTS[component] as readonly string[]).includes(event)) return
  writeRecord({
    component, event,
    version: matches(VERSION, fields.version),
    source: allowed(SOURCES, fields.source),
    stage: allowed(STAGES, fields.stage),
    task: integer(fields.task, 1, Number.MAX_SAFE_INTEGER),
    job: matches(component === 'task' ? JOB_ID : UUID, fields.job),
    pid: integer(fields.pid, 1, Number.MAX_SAFE_INTEGER),
    code: fields.code === undefined ? undefined : allowed(CODES, fields.code) ?? 'unknown_error',
    status: integer(fields.status, 100, 599),
    exitCode: integer(fields.exitCode, 0, 255),
    signal: allowed(SIGNALS, fields.signal),
  })
}
