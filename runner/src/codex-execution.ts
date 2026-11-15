import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bounded } from '../../cli/src/lib/shared/conversation'
import { tryLock } from '../../cli/src/lib/lock'
import { RpcError, type Message } from '../../cli/src/lib/agent/wire/rpc'
import { obj, str, type Json } from '../../cli/src/lib/agent/wire/json'
import { mcpEnvironment } from './codex-config'
import { executionOwner, inspectThread, ownershipConflict } from './codex-ownership'
import { backgroundTerminals, backendFile, CODEX_TIMEOUT, initializeNative, leaseFile, liveLease, nativeConnection, processIdentity, readPrivate, releaseNativeThread, writeLease, type NativeBackend, type ThreadLease } from './codex-native'

export async function codexExecution(backend: NativeBackend, config: Json, environment: NodeJS.ProcessEnv, cwd: string, send: (message: unknown) => void) {
  const identity = { ...processIdentity(), ...executionOwner(environment) }
  const lease = crypto.randomUUID()
  const settings = crypto.createHash('sha256').update(JSON.stringify([cwd, config])).digest('hex')
  const threads = new Set<string>(), active = new Map<string, string>(), requests = new Set<string>()
  const preparing = new Map<string, number>()
  const pending = new Set<Promise<void>>()
  const unloading = new Map<string, () => void>()
  let closing: Promise<void> | undefined
  let settled: ThreadLease['retained'] | undefined
  let keeper = false
  const state = (): ThreadLease => ({ ...identity, lease, instance: backend.instance, settings, threads: [...threads], ...(settled ? { retained: settled } : {}) })
  const owned = (id: string) => readPrivate<ThreadLease>(leaseFile(backend, id))?.lease === lease
  const remove = (id: string) => { if (owned(id)) fs.rmSync(leaseFile(backend, id), { force: true }) }
  const claim = (id: string, loaded = true, previous?: ThreadLease) => {
    if (!id) return
    const file = leaseFile(backend, id)
    const release = tryLock(file + '.lock')
    if (!release) throw ownershipConflict(id, state(), readPrivate<ThreadLease>(file), 'ownership-transfer; try again')
    try {
      const current = readPrivate<ThreadLease>(file)
      if (current && current.lease !== lease && current.lease !== previous?.lease) throw ownershipConflict(id, state(), current, liveLease(current) ? 'owner-alive' : 'unverified')
      if (loaded) threads.add(id)
      writeLease(backend, id, { ...state(), ...(previous?.retained ? { retained: previous.retained, adopting: previous.lease } : {}) })
      for (const thread of threads) {
        const owner = readPrivate<ThreadLease>(leaseFile(backend, thread))
        if (owner?.lease === lease) writeLease(backend, thread, { ...owner, threads: [...threads] })
      }
    } finally { release() }
  }
  const reserve = async (id: string) => {
    const previous = readPrivate<ThreadLease>(leaseFile(backend, id))
    if (previous && previous.lease !== lease) {
      if (previous.retained) {
        if (previous.retained.root !== id) throw Error('Resume the owning Codex thread to adopt its retained work.')
        if (previous.settings !== settings) throw Error('This Codex version cannot change execution settings while retaining a loaded session. Its services and saved results were preserved; no new work was submitted.')
        const actual: Json[] = []
        for (const thread of previous.threads) actual.push(...await backgroundTerminals(connection.rpc, thread))
        const key = (value: Json) => JSON.stringify([value.threadId, value.itemId, value.processId])
        if (actual.length !== previous.retained.kept.length || actual.some(value => !previous!.retained!.kept.some(item => key(item) === key(value)))) throw Error('The retained Codex services changed; no new work was submitted.')
      } else {
        if (liveLease(previous)) throw ownershipConflict(id, state(), previous, 'owner-alive')
        for (const thread of new Set([id, ...previous.threads])) {
          let status: string
          try { status = await inspectThread(connection.rpc, thread) }
          catch { throw ownershipConflict(thread, state(), previous, 'unverified') }
          if (status !== 'idle' && status !== 'notLoaded') throw ownershipConflict(thread, state(), previous, status === 'active' || status === 'background-work' ? 'work still running; automatic replay refused' : 'unverified')
        }
      }
    }
    claim(id, false, previous)
    preparing.set(id, (preparing.get(id) ?? 0) + 1)
    return { previous: previous?.retained ? previous : undefined, release() {
      const remaining = preparing.get(id)! - 1
      if (remaining) preparing.set(id, remaining)
      else { preparing.delete(id); if (!threads.has(id)) remove(id) }
    } }
  }
  const notify = (message: Message) => {
    const params = obj(message.params), thread = obj(params.thread)
    const id = str(params.threadId) || str(thread.id)
    if (message.method === 'thread/closed') { unloading.get(id)?.(); unloading.delete(id) }
    if (!threads.has(id)) {
      const parent = str(thread.parentThreadId) || str(thread.forkedFromId)
      if (parent && threads.has(parent)) {
        try { claim(id) } catch (error) { send({ method: 'error', params: { error: { message: String(error) } } }); return }
      }
    }
    if (!threads.has(id)) {
      if (message.id !== undefined) connection.rpc.refuse(message.id, 'This execution does not own that Codex request.')
      return
    }
    if (message.method === 'turn/started') active.set(id, str(obj(params.turn).id))
    if (message.method === 'turn/completed') active.delete(id)
    const item = obj(params.item)
    const children = item.type === 'subAgentActivity' && item.kind === 'started' ? [item.agentThreadId]
      : item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
    for (const child of children) if (typeof child === 'string' && !threads.has(child)) {
      try { claim(child) } catch (error) { send({ method: 'error', params: { error: { message: String(error) } } }); return }
    }
    if (message.id !== undefined) requests.add(String(message.id))
    send(message)
  }
  const connection = await nativeConnection(backend, notify)
  let initialized: Json
  try { initialized = await initializeNative(connection) }
  catch (error) { connection.close(); throw error }
  const keep = async () => {
    const entry = process.env.RUNNER_DIST ? path.join(process.env.RUNNER_DIST, 'codex-retained.mjs') : fileURLToPath(new URL('./codex-retained.mjs', import.meta.url))
    const child = spawn(process.execPath, [entry, backendFile(backend.key), leaseFile(backend, settled!.root), lease], {
      cwd, env: { ...environment, WILDCRANE_CODEX_GENERATION: backend.generation }, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    child.on('error', () => {})
    try {
      await bounded(new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', () => reject(Error('Codex retained execution exited before connecting.')))
        child.on('message', value => { if (obj(value).ready === lease) resolve() })
      }), CODEX_TIMEOUT, 'Codex retained execution did not acknowledge ownership.')
      keeper = true
      child.disconnect(); child.unref()
    } catch (error) { child.kill('SIGTERM'); throw error }
  }
  const cleanup = async () => {
    await bounded(Promise.allSettled(pending), CODEX_TIMEOUT, 'Codex pending requests did not settle.')
    if (keeper) return
    for (const id of requests) connection.rpc.refuse(id, 'Execution disconnected.')
    const results = await Promise.allSettled([...threads].map(async id => {
      if (!owned(id)) return
      await releaseNativeThread(connection, id, active.get(id), !settled, unloading)
      remove(id)
    }))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  const close = () => closing ??= (async () => {
    try { await cleanup() }
    catch (error) {
      for (const id of threads) if (owned(id)) writeLease(backend, id, { ...state(), uncertain: true })
      send({ method: 'wildcrane/cleanup', params: { status: 'unconfirmed', lease } })
      console.error(error instanceof Error ? error.message : String(error))
    } finally { connection.close() }
  })()
  const request = async (message: Message) => {
    const id = message.id
    let source: string | undefined, previous: ThreadLease | undefined
    let releaseSource: (() => void) | undefined
    try {
      if (message.method === 'wildcrane/release') { void close(); return }
      if (!message.method) {
        if (id === undefined || !requests.delete(String(id))) return
        if (message.error) connection.rpc.refuse(id, message.error.message ?? 'Interaction refused.')
        else connection.rpc.reply(id, obj(message.result))
        return
      }
      if (closing) throw Error('Codex execution is stopping.')
      if (keeper) throw Error('Codex execution already handed off its retained services.')
      if (message.method === 'initialize') { send({ id, result: { ...initialized, wildcrane: { instance: backend.instance, lease } } }); return }
      if (message.method === 'initialized') return
      let params = obj(message.params)
      if (message.method === 'wildcrane/settled') {
        if (params.instance !== backend.instance || params.lease !== lease || !threads.has(str(params.threadId)) || params.confirmed !== true || !str(params.execution)) throw Error('Codex cleanup ownership is unconfirmed.')
        const kept = Array.isArray(params.kept) ? params.kept.map(obj) : []
        const actual: Json[] = []
        for (const thread of threads) {
          if (active.has(thread)) throw Error('A Codex turn is still active.')
          actual.push(...await backgroundTerminals(connection.rpc, thread))
        }
        const key = (value: Json) => JSON.stringify([value.threadId, value.itemId, value.processId])
        if (new Set(kept.map(key)).size !== kept.length || actual.length !== kept.length || actual.some(value => !kept.some(item => key(item) === key(value)))) throw Error('Codex retained terminal state changed before handoff.')
        settled = { root: str(params.threadId), execution: str(params.execution), kept }
        for (const thread of threads) writeLease(backend, thread, state())
        if (kept.length) await keep()
        send({ id, result: { confirmed: true, instance: backend.instance, lease } })
        return
      }
      if (['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
        if (message.method !== 'thread/start') {
          const id = str(params.threadId)
          if (message.method !== 'thread/fork' || !readPrivate<ThreadLease>(leaseFile(backend, id))?.retained) {
            source = id
            const reservation = await reserve(source)
            previous = reservation.previous; releaseSource = reservation.release
          }
        }
        const defaults = await connection.rpc.call('config/read', { cwd: params.cwd ?? cwd, includeLayers: false })
        const overrides = { ...config, ...obj(params.config), thread_unload_delay_secs: 0 }
        mcpEnvironment(overrides, obj(obj(defaults.config).mcp_servers))
        params = { ...params, cwd: params.cwd ?? cwd, config: overrides }
      } else {
        const thread = str(params.threadId)
        if (!threads.has(thread) || !owned(thread)) throw Error('This run does not own that Codex thread.')
      }
      if (message.method === 'turn/start') settled = undefined
      const result = await connection.rpc.call(message.method, params)
      if (message.method === 'thread/resume' && !previous?.retained && str(config.model) && result.model && result.model !== config.model) throw Error('The previous Codex runtime has not unloaded; new execution settings were not applied. No new work was submitted.')
      const thread = str(obj(result.thread).id)
      if (thread) claim(thread, true, message.method === 'thread/resume' ? previous : undefined)
      if (previous?.retained && message.method === 'thread/resume') {
        for (const child of previous.threads) if (child !== thread) {
          claim(child, true, previous)
          await connection.rpc.call('thread/resume', { threadId: child })
          writeLease(backend, child, state())
        }
        result.retainedThreads = [...threads].map(id => ({ id }))
        result.retainedTerminals = previous.retained!.kept
        writeLease(backend, thread, state())
      }
      if (id !== undefined) send({ id, result })
    } catch (error) {
      if (source && previous?.retained) for (const thread of previous.threads) {
        if (owned(thread)) writeLease(backend, thread, previous)
        threads.delete(thread)
      }
      if (id !== undefined) send({ id, error: { code: error instanceof RpcError ? error.code : -32000, message: error instanceof Error ? error.message : String(error) } })
    } finally {
      releaseSource?.()
    }
  }
  return { close, closed: connection.incoming, request(message: Message) {
    const work = request(message)
    pending.add(work); void work.finally(() => pending.delete(work))
  } }
}
