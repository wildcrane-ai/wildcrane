import crypto from 'node:crypto'
import diagnosticsChannel from 'node:diagnostics_channel'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { Agent, WebSocket } from 'undici'
import { bounded } from '../../cli/src/lib/shared/conversation'
import { connectionIdentity, connectionStopped } from '../../cli/src/lib/agent/connection-process'
import { connect, RpcError, type Message } from '../../cli/src/lib/agent/wire/rpc'
import { obj, str, type Json } from '../../cli/src/lib/agent/wire/json'
import { runnerCwd } from './home'

export const CODEX_PROTOCOL = 3
export const CODEX_TIMEOUT = 10_000
export interface NativeBackend {
  pid: number
  identity?: string
  instance: string
  generation: string
  endpoint: string
  token?: string
  key: string
}
export interface ThreadLease {
  pid: number
  identity?: string
  lease: string
  instance: string
  settings: string
  threads: string[]
  retained?: { root: string; execution: string; kept: Json[] }
  uncertain?: boolean
  adopting?: string
  thread?: string
  run?: string
  task?: string
  job?: string
}
export const nativeDirectory = () => path.join(runnerCwd(), 'codex-native')
export const codexRecordFile = () => path.join(nativeDirectory(), 'runner.json')
export const backendFile = (key: string) => path.join(nativeDirectory(), `${key}.json`)
export const leaseFile = (backend: NativeBackend, thread: string) => path.join(nativeDirectory(), 'threads', backend.instance, `${crypto.createHash('sha256').update(thread).digest('hex')}.json`)
export const liveBackend = (backend: NativeBackend) => !connectionStopped(backend)
export const liveLease = (lease: ThreadLease) => !connectionStopped(lease)
export const processIdentity = () => ({ pid: process.pid, identity: connectionIdentity(process.pid) })

export function writePrivate(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  fs.renameSync(temporary, file)
}
export function readPrivate<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}
export function writeLease(backend: NativeBackend, thread: string, value: ThreadLease) {
  writePrivate(leaseFile(backend, thread), { ...value, thread })
}
export function nativeEndpoint(key: string): string {
  const directory = path.join(os.tmpdir(), `wc-codex-${crypto.createHash('sha256').update(runnerCwd()).digest('hex').slice(0, 12)}`)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
  return `unix://${path.join(directory, `${key.slice(0, 12)}-${crypto.randomBytes(6).toString('hex')}.sock`)}`
}

function nativeErrorText(error: unknown): string {
  if (!error) return ''
  if (error instanceof RpcError) return `RPC ${error.code ?? 'unknown'}: ${error.message}`
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    const text = error.message.trim() || error.name
    return code && !text.includes(code) ? `${code}: ${text}` : text
  }
  return String(error)
}

function nativeEventDetail(event: Event, fallback?: string) {
  const value = event as Event & { error?: unknown; message?: string; code?: number; reason?: string }
  const message = typeof value.message === 'string' && value.message.trim() && value.message !== 'undefined' ? value.message.trim() : ''
  const code = typeof value.code === 'number' ? `code ${value.code}${value.reason ? `: ${value.reason}` : ''}` : ''
  const error = value.error instanceof Error && !value.error.message.trim() ? '' : nativeErrorText(value.error)
  return fallback || error || message || code || nativeErrorText(value.error)
}

/** Native connections belong to executions, so replacing Runner does not break their streams. */
export async function nativeConnection(backend: NativeBackend, onMessage: (message: Message) => void) {
  const unix = backend.endpoint.startsWith('unix://')
  const socketPath = unix ? backend.endpoint.slice(7) : undefined
  const dispatcher = unix ? new Agent({ connect: { socketPath } }) : undefined
  let lastError = ''
  const onSocketError = (err: unknown) => { lastError = nativeErrorText(err) || lastError }
  const onConnectError = (data: unknown) => {
    const record = data as { connectParams?: { socketPath?: string }; error?: unknown }
    if (!socketPath || record.connectParams?.socketPath === socketPath) lastError = nativeErrorText(record.error) || lastError
  }
  diagnosticsChannel.subscribe('undici:websocket:socket_error', onSocketError)
  diagnosticsChannel.subscribe('undici:client:connectError', onConnectError)
  const unsubscribeDiagnostics = () => {
    diagnosticsChannel.unsubscribe('undici:websocket:socket_error', onSocketError)
    diagnosticsChannel.unsubscribe('undici:client:connectError', onConnectError)
  }
  const ws = new WebSocket(unix ? 'ws://localhost' : backend.endpoint, {
    ...(dispatcher ? { dispatcher } : {}),
    ...(backend.token ? { headers: { authorization: `Bearer ${backend.token}` } } : {}),
  })
  const incoming = new PassThrough()
  const outgoing = new Writable({ write(chunk, _encoding, done) {
    try { ws.send(String(chunk).trimEnd()); done() } catch (error) { done(error as Error) }
  } })
  incoming.on('error', () => {})
  outgoing.on('error', () => {})
  let closing = false
  ws.addEventListener('message', event => incoming.write(String(event.data) + '\n'))
  ws.addEventListener('close', event => {
    unsubscribeDiagnostics()
    if (!closing && !incoming.destroyed && (!event.wasClean || event.code !== 1000 && event.code !== 1005)) {
      const detail = nativeEventDetail(event, lastError)
      const message = detail ? `Codex native connection closed (${detail}).` : 'Codex native connection closed.'
      console.error(message)
      incoming.destroy(Error(message))
      return
    }
    incoming.destroy()
  })
  ws.addEventListener('error', event => {
    if (closing || incoming.destroyed) return
    const detail = nativeEventDetail(event, lastError)
    const message = detail ? `Codex native connection failed: ${detail}` : 'Codex native connection failed.'
    console.error(message)
    incoming.destroy(Error(message))
  })
  const close = () => {
    closing = true
    unsubscribeDiagnostics()
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
    incoming.destroy(); outgoing.destroy(); void dispatcher?.destroy()
  }
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', event => {
        const detail = nativeEventDetail(event, lastError)
        reject(Error(detail ? `Codex native listener did not answer (${detail}).` : 'Codex native listener did not answer.'))
      }, { once: true })
    }), CODEX_TIMEOUT, 'Codex native connection timed out.')
  } catch (error) { close(); throw error }
  const unloads = new EventTarget()
  const rpc = connect(incoming, outgoing, message => {
    const params = obj(message.params), id = str(params.threadId)
    if (id && message.id === undefined && (message.method === 'thread/closed'
      || message.method === 'thread/status/changed' && obj(params.status).type === 'notLoaded')) unloads.dispatchEvent(new Event(id))
    onMessage(message)
  })
  return { rpc, incoming, close, unloads }
}

type NativeConnection = Awaited<ReturnType<typeof nativeConnection>>

export async function initializeNative(connection: Awaited<ReturnType<typeof nativeConnection>>) {
  const result = await bounded(connection.rpc.call('initialize', { clientInfo: { name: 'wildcrane', version: '1' }, capabilities: { experimentalApi: true } }), CODEX_TIMEOUT, 'Codex initialize timed out.')
  connection.rpc.notify('initialized')
  return result
}

export async function backgroundTerminals(rpc: ReturnType<typeof connect>, threadId: string, deadline = Date.now() + CODEX_TIMEOUT) {
  const result: Json[] = [], seen = new Set<string>()
  let cursor: string | undefined
  do {
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw Error('Codex repeated a terminal cursor.')
      seen.add(cursor)
    }
    const page = await beforeDeadline(deadline, 'background terminal verification', () => rpc.call('thread/backgroundTerminals/list', { threadId, ...(cursor === undefined ? {} : { cursor }) }))
    if (!Array.isArray(page.data) || page.nextCursor != null && typeof page.nextCursor !== 'string') throw Error('Codex background terminal state is unconfirmed.')
    for (const value of page.data) result.push({ ...obj(value), threadId })
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined
  } while (cursor !== undefined)
  return result
}

export function codexDiagnostic(error: unknown) {
  return error instanceof RpcError ? `RPC ${error.code ?? 'unknown'}: ${error.message}`
    : error instanceof Error ? error.message : String(error)
}

function beforeDeadline<T>(deadline: number, operation: string, run: () => Promise<T>) {
  const timeout = `Codex ${operation} timed out.`
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw Error(timeout)
  return bounded(run(), remaining, timeout)
}

type ThreadEvidence = {
  status: 'notLoaded' | 'idle' | 'active' | 'background-work' | 'unverified'
  thread?: Json
  diagnostic?: string
}

export async function inspectNativeThread(rpc: NativeConnection['rpc'], threadId: string, deadline = Date.now() + CODEX_TIMEOUT, checkBackground = true): Promise<ThreadEvidence> {
  let diagnostic: string
  try {
    const reply = await beforeDeadline(deadline, 'thread/read', () => rpc.call('thread/read', { threadId }))
    const thread = obj(reply.thread), status = obj(thread.status).type
    if (thread.id !== threadId || status !== 'notLoaded' && status !== 'active' && status !== 'idle') {
      throw Error('thread/read returned an unexpected thread or status.')
    }
    if (status === 'idle' && checkBackground) {
      const work = await backgroundTerminals(rpc, threadId, deadline)
      if (work.length) return { status: 'background-work', thread }
    }
    return { status, thread }
  } catch (error) { diagnostic = codexDiagnostic(error) }

  let cursor: string | undefined
  const seen = new Set<string>()
  try {
    do {
      const page = await beforeDeadline(deadline, 'thread/loaded/list', () => rpc.call('thread/loaded/list', cursor === undefined ? {} : { cursor }))
      const next = page.nextCursor
      if (!Array.isArray(page.data) || page.data.some(id => typeof id !== 'string' || !id.trim())
        || next != null && typeof next !== 'string') throw Error('thread/loaded/list returned an invalid page.')
      if (page.data.includes(threadId)) return { status: 'unverified', diagnostic: `${diagnostic} The thread is still loaded.` }
      cursor = typeof next === 'string' ? next : undefined
      if (cursor !== undefined) {
        if (seen.has(cursor)) throw Error('thread/loaded/list repeated a cursor.')
        seen.add(cursor)
      }
    } while (cursor !== undefined)
    return { status: 'notLoaded', diagnostic }
  } catch (error) {
    return { status: 'unverified', diagnostic: `${diagnostic} ${codexDiagnostic(error)}` }
  }
}

function releaseError(method: string, threadId: string, evidence: ThreadEvidence, error?: unknown) {
  const diagnostic = [`${method} could not confirm Codex thread ${threadId}: ${evidence.status}.`, evidence.diagnostic].filter(Boolean).join(' ')
  return error instanceof RpcError ? new RpcError(`${error.message} ${diagnostic}`, error.code, error.data)
    : Error([error && codexDiagnostic(error), diagnostic].filter(Boolean).join(' '))
}

export async function interruptNativeThread(connection: NativeConnection, threadId: string, turnId: string, deadline: number) {
  try { await beforeDeadline(deadline, 'turn/interrupt', () => connection.rpc.call('turn/interrupt', { threadId, turnId })) }
  catch (error) {
    const evidence = await inspectNativeThread(connection.rpc, threadId, deadline, false)
    if (evidence.status !== 'idle' && evidence.status !== 'notLoaded') throw releaseError('turn/interrupt', threadId, evidence, error)
    console.error(`Codex turn/interrupt: ${codexDiagnostic(error)} (${evidence.status}, ${threadId})`)
  }
}

export async function releaseNativeThread(connection: NativeConnection, threadId: string, turnId: string | undefined, stopWork: boolean, deadline = Date.now() + CODEX_TIMEOUT) {
  const { rpc, unloads } = connection
  let closed = false
  let observed!: () => void
  const unloaded = new Promise<void>(resolve => { observed = () => { closed = true; resolve() } })
  unloads.addEventListener(threadId, observed, { once: true })
  const release = async () => {
    if (stopWork && turnId) await interruptNativeThread(connection, threadId, turnId, deadline)
    if (closed) return
    if (stopWork) {
      try { await beforeDeadline(deadline, 'thread/backgroundTerminals/clean', () => rpc.call('thread/backgroundTerminals/clean', { threadId })) }
      catch (error) {
        if (closed) return
        if (!(error instanceof RpcError && error.code === -32601)) {
          const evidence = await inspectNativeThread(rpc, threadId, deadline, false)
          if (!closed && evidence.status !== 'notLoaded') throw releaseError('thread/backgroundTerminals/clean', threadId, evidence, error)
          console.error(`Codex thread/backgroundTerminals/clean: ${codexDiagnostic(error)} (${threadId})`)
          return
        }
      }
    }
    if (closed) return
    let status: unknown, failure: unknown
    try { status = (await beforeDeadline(deadline, 'thread/unsubscribe', () => rpc.call('thread/unsubscribe', { threadId }))).status }
    catch (error) { failure = error }
    if (status === 'notLoaded') return
    while (!closed) {
      const evidence = await inspectNativeThread(rpc, threadId, deadline, false)
      if (closed || evidence.status === 'notLoaded') {
        if (failure) console.error(`Codex thread/unsubscribe: ${codexDiagnostic(failure)} (${threadId})`)
        return
      }
      if (status !== 'unsubscribed') throw releaseError('thread/unsubscribe', threadId, evidence, failure)
      if (Date.now() >= deadline) throw releaseError('thread unload', threadId, evidence, Error('Codex thread cleanup timed out.'))
      await delay(Math.min(50, deadline - Date.now()))
    }
  }
  try { await Promise.race([release(), unloaded]) }
  finally { unloads.removeEventListener(threadId, observed) }
}

export function stopNativeBackends() {
  let files: string[] = []
  try { files = fs.readdirSync(nativeDirectory()).filter(name => /^[a-f0-9]{64}\.json$/.test(name)) } catch { return [] }
  const targets: NativeBackend[] = []
  for (const file of files) {
    const backend = readPrivate<NativeBackend>(path.join(nativeDirectory(), file))
    if (backend?.identity && liveBackend(backend) && connectionIdentity(backend.pid) === backend.identity) {
      targets.push(backend)
      try { process.kill(backend.pid, 'SIGTERM') } catch {}
    }
  }
  return targets
}
