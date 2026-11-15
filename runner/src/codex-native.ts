import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { Agent, WebSocket } from 'undici'
import { bounded } from '../../cli/src/lib/shared/conversation'
import { connectionIdentity, connectionStopped } from '../../cli/src/lib/agent/connection-process'
import { connect, RpcError, type Message } from '../../cli/src/lib/agent/wire/rpc'
import { obj, type Json } from '../../cli/src/lib/agent/wire/json'
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

/** Native connections belong to executions, so replacing Runner does not break their streams. */
export async function nativeConnection(backend: NativeBackend, onMessage: (message: Message) => void) {
  const unix = backend.endpoint.startsWith('unix://')
  const dispatcher = unix ? new Agent({ connect: { socketPath: backend.endpoint.slice(7) } }) : undefined
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
  ws.addEventListener('message', event => incoming.write(String(event.data) + '\n'))
  ws.addEventListener('close', () => incoming.destroy())
  ws.addEventListener('error', () => incoming.destroy(Error('Codex native connection failed.')))
  const close = () => { ws.close(); incoming.destroy(); outgoing.destroy(); void dispatcher?.destroy() }
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(Error('Codex native listener did not answer.')), { once: true })
    }), CODEX_TIMEOUT, 'Codex native connection timed out.')
  } catch (error) { close(); throw error }
  const rpc = connect(incoming, outgoing, onMessage)
  return { rpc, incoming, close }
}

export async function initializeNative(connection: Awaited<ReturnType<typeof nativeConnection>>) {
  const result = await bounded(connection.rpc.call('initialize', { clientInfo: { name: 'wildcrane', version: '1' }, capabilities: { experimentalApi: true } }), CODEX_TIMEOUT, 'Codex initialize timed out.')
  connection.rpc.notify('initialized')
  return result
}

export async function backgroundTerminals(rpc: ReturnType<typeof connect>, threadId: string) {
  const result: Json[] = [], seen = new Set<unknown>()
  let cursor: unknown = null
  do {
    if (seen.has(cursor)) throw Error('Codex repeated a terminal cursor.')
    seen.add(cursor)
    const page = await rpc.call('thread/backgroundTerminals/list', { threadId, ...(cursor ? { cursor } : {}) })
    if (!Array.isArray(page.data) || page.nextCursor != null && typeof page.nextCursor !== 'string') throw Error('Codex background terminal state is unconfirmed.')
    for (const value of page.data) result.push({ ...obj(value), threadId })
    cursor = page.nextCursor
  } while (cursor)
  return result
}

export async function releaseNativeThread(connection: Awaited<ReturnType<typeof nativeConnection>>, threadId: string, turnId: string | undefined, stopWork: boolean, unloading: Map<string, () => void>) {
  const missing = (error: unknown) => error instanceof RpcError && /thread not (?:found|loaded)/i.test(error.message)
  try {
    await bounded((async () => {
      if (stopWork) {
        if (turnId) {
          try { await connection.rpc.call('turn/interrupt', { threadId, turnId }) }
          catch (error) { if (!missing(error)) throw error }
        }
        try { await connection.rpc.call('thread/backgroundTerminals/clean', { threadId }) }
        catch (error) { if (!(error instanceof RpcError) || error.code !== -32601 && !missing(error)) throw error }
      }
      const unloaded = new Promise<void>(resolve => unloading.set(threadId, resolve))
      let result
      try { result = await connection.rpc.call('thread/unsubscribe', { threadId }) }
      catch (error) { if (!missing(error)) throw error; result = { status: 'notLoaded' } }
      if (result.status === 'unsubscribed') await unloaded
      else if (result.status !== 'notLoaded') {
        const snapshot = obj((await connection.rpc.call('thread/read', { threadId })).thread)
        if (obj(snapshot.status).type !== 'notLoaded') throw Error('Codex thread unload is unconfirmed.')
      }
    })(), CODEX_TIMEOUT, 'Codex thread cleanup timed out; ownership remains unconfirmed.')
  } finally { unloading.delete(threadId) }
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
