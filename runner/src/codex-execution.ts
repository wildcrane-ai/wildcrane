import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
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
  let stoppingForRetry = false
  const state = (): ThreadLease => ({ ...identity, lease, instance: backend.instance, settings, threads: [...threads], ...(settled ? { retained: settled } : {}) })
  const owned = (id: string) => readPrivate<ThreadLease>(leaseFile(backend, id))?.lease === lease
  const remove = (id: string) => { if (owned(id)) fs.rmSync(leaseFile(backend, id), { force: true }) }
  const leaseAt = (id: string, phase: string) => {
    const file = leaseFile(backend, id)
    try {
      const current = readPrivate<ThreadLease>(file)
      if (current === undefined || typeof current.lease === 'string' && Array.isArray(current.threads)) return current
    } catch { /* An unreadable owner must not be replaced. */ }
    throw ownershipConflict(id, state(), undefined, 'invalid-ownership-record', phase)
  }
  const claim = (id: string, loaded = true, previous?: ThreadLease, forkSource = false) => {
    if (!id) return
    const file = leaseFile(backend, id)
    const release = tryLock(file + '.lock')
    if (!release) throw ownershipConflict(id, state(), leaseAt(id, 'claim-thread'), 'ownership-transfer', loaded ? 'claim-thread' : 'reserve-source', forkSource)
    try {
      const current = leaseAt(id, 'claim-thread')
      if (current && current.lease !== lease && current.lease !== previous?.lease) throw ownershipConflict(id, state(), current, liveLease(current) ? 'owner-alive' : 'unverified', loaded ? 'claim-thread' : 'reserve-source', forkSource && liveLease(current))
      if (loaded) threads.add(id)
      writeLease(backend, id, { ...state(), ...(previous?.retained ? { retained: previous.retained, adopting: previous.lease } : {}) })
      for (const thread of threads) {
        const owner = readPrivate<ThreadLease>(leaseFile(backend, thread))
        if (owner?.lease === lease) writeLease(backend, thread, { ...owner, threads: [...threads] })
      }
    } finally { release() }
  }
  const reserve = async (id: string, forkSource: boolean) => {
    const previous = leaseAt(id, 'reserve-source')
    if (previous && previous.lease !== lease) {
      if (previous.retained) {
        if (previous.retained.root !== id) throw Error('Resume the owning Codex thread to adopt its retained work.')
        if (previous.settings !== settings) throw Error('This Codex version cannot change execution settings while retaining a loaded session. Its services and saved results were preserved; no new work was submitted.')
        const actual: Json[] = []
        for (const thread of previous.threads) actual.push(...await backgroundTerminals(connection.rpc, thread))
        const key = (value: Json) => JSON.stringify([value.threadId, value.itemId, value.processId])
        if (actual.length !== previous.retained.kept.length || actual.some(value => !previous!.retained!.kept.some(item => key(item) === key(value)))) throw Error('The retained Codex services changed; no new work was submitted.')
      } else {
        if (liveLease(previous)) throw ownershipConflict(id, state(), previous, 'owner-alive', 'reserve-source', forkSource)
        for (const thread of new Set([id, ...previous.threads])) {
          let status: string
          try { status = await inspectThread(connection.rpc, thread) }
          catch { throw ownershipConflict(thread, state(), previous, 'unverified', 'verify-source') }
          if (status !== 'idle' && status !== 'notLoaded') throw ownershipConflict(thread, state(), previous, status === 'active' || status === 'background-work' ? 'work still running; automatic replay refused' : 'unverified', 'verify-source')
        }
      }
    }
    claim(id, false, previous, forkSource)
    preparing.set(id, (preparing.get(id) ?? 0) + 1)
    return { previous: previous?.retained ? previous : undefined, release() {
      const remaining = preparing.get(id)! - 1
      if (remaining) preparing.set(id, remaining)
      else { preparing.delete(id); if (!threads.has(id)) remove(id) }
    } }
  }
  const failNotification = (error: unknown) => {
    send({ method: 'error', params: { error: error instanceof RpcError ? error.data : { message: String(error) } } })
    void close()
  }
  const notify = (message: Message) => {
    const params = obj(message.params), thread = obj(params.thread)
    const id = str(params.threadId) || str(thread.id)
    if (message.method === 'thread/closed') { unloading.get(id)?.(); unloading.delete(id) }
    if (!threads.has(id)) {
      const parent = str(thread.parentThreadId) || str(thread.forkedFromId)
      if (parent && threads.has(parent)) {
        try { claim(id) } catch (error) { failNotification(error); return }
      }
    }
    if (!threads.has(id)) {
      if (message.id !== undefined) connection.rpc.refuse(message.id, 'This execution does not own that Codex request.')
      return
    }
    if (message.method === 'turn/started') active.set(id, str(obj(params.turn).id))
    if (message.method === 'turn/completed' && active.get(id) === str(obj(params.turn).id)) active.delete(id)
    const item = obj(params.item)
    const children = item.type === 'subAgentActivity' && item.kind === 'started' ? [item.agentThreadId]
      : item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
    for (const child of children) if (typeof child === 'string' && !threads.has(child)) {
      try { claim(child) } catch (error) { failNotification(error); return }
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
  const stopForRetry = async (params: Json) => {
    const threadId = str(params.threadId), turnId = str(params.turnId)
    if (params.instance !== backend.instance || params.lease !== lease || !turnId || active.get(threadId) !== turnId || !owned(threadId)) {
      throw ownershipConflict(threadId, state(), threadId ? leaseAt(threadId, 'stop-idle-turn') : undefined, 'idle-turn-ownership-unconfirmed', 'stop-idle-turn')
    }
    stoppingForRetry = true
    const otherWork = pending.size || requests.size || active.size !== 1
    await bounded(connection.rpc.call('turn/interrupt', { threadId, turnId }), CODEX_TIMEOUT, 'Codex did not acknowledge interrupting the idle turn.')
    if (otherWork) throw Error('Other Codex operations were pending when the idle turn was interrupted.')
    const deadline = Date.now() + CODEX_TIMEOUT
    const call = (method: string, input: Json) => bounded(connection.rpc.call(method, input), deadline - Date.now(), 'Codex did not confirm the idle turn stopped.')
    for (;;) {
      const snapshot = obj((await call('thread/read', { threadId, includeTurns: false })).thread)
      if (snapshot.id !== threadId || closing) throw Error('Codex session availability could not be confirmed.')
      if (obj(snapshot.status).type === 'idle' && !active.has(threadId)) {
        const paginated = snapshot.historyMode === 'paginated'
        const listed = paginated
          ? (await call('thread/turns/list', { threadId, sortDirection: 'desc', limit: 1, itemsView: 'full' })).data
          : obj((await call('thread/read', { threadId, includeTurns: true })).thread).turns
        const turns = Array.isArray(listed) ? listed.map(obj) : []
        const turn = turns.at(paginated ? 0 : -1)
        if (turn?.id !== turnId || turn.status !== 'interrupted' || !Array.isArray(turn.items)) {
          throw Error('Codex did not record the interrupted turn in the original session.')
        }
        if (turn.items.map(obj).some(item => ['inProgress', 'interrupted'].includes(str(item.status))
          || item.type === 'commandExecution' && typeof item.exitCode !== 'number')) {
          throw Error('Codex has operations with unconfirmed results.')
        }
        break
      }
      if (Date.now() >= deadline) throw Error('Codex did not confirm the idle turn stopped.')
      await delay(50)
    }
    const claimed = [...threads]
    for (const thread of claimed) {
      if (!owned(thread) || active.has(thread) || requests.size || closing) throw Error('Codex ownership or pending operations changed during interruption.')
      const status = await bounded(inspectThread(connection.rpc, thread), CODEX_TIMEOUT, 'Codex work is unconfirmed after interruption.')
      if (status !== 'idle' && (thread === threadId || status !== 'notLoaded')) throw Error('Codex has unfinished work after interruption.')
    }
    await Promise.all(claimed.map(thread => releaseNativeThread(connection, thread, undefined, false, unloading)))
    if (active.size || requests.size || threads.size !== claimed.length || claimed.some(thread => !owned(thread)) || closing) {
      throw Error('Codex ownership or pending operations changed during release.')
    }
    for (const thread of claimed) { remove(thread); threads.delete(thread) }
    return { instance: backend.instance, lease, threadId, turnId }
  }
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
      if (closing || stoppingForRetry) throw Error('Codex execution is stopping.')
      if (keeper) throw Error('Codex execution already handed off its retained services.')
      if (message.method === 'initialize') { send({ id, result: { ...initialized, wildcrane: { instance: backend.instance, lease, idleRecovery: true } } }); return }
      if (message.method === 'initialized') return
      let params = obj(message.params)
      if (message.method === 'wildcrane/stopForRetry') {
        const result = await stopForRetry(params)
        send({ id, result })
        return
      }
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
          if (message.method !== 'thread/fork' || !leaseAt(id, 'reserve-source')?.retained) {
            source = id
            const reservation = await reserve(source, message.method === 'thread/fork')
            previous = reservation.previous; releaseSource = reservation.release
          }
        }
        const defaults = await connection.rpc.call('config/read', { cwd: params.cwd ?? cwd, includeLayers: false })
        const overrides = { ...config, ...obj(params.config), thread_unload_delay_secs: 0 }
        mcpEnvironment(overrides, obj(obj(defaults.config).mcp_servers))
        params = { ...params, cwd: params.cwd ?? cwd, config: overrides }
      } else {
        const thread = str(params.threadId)
        if (!threads.has(thread) || !owned(thread)) throw ownershipConflict(thread, state(), thread ? readPrivate<ThreadLease>(leaseFile(backend, thread)) : undefined, 'caller-does-not-own-thread', message.method)
      }
      if (message.method === 'turn/start') settled = undefined
      const result = await connection.rpc.call(message.method, params)
      if (message.method === 'thread/resume' && !previous?.retained && str(config.model) && result.model && result.model !== config.model) throw Error('The previous Codex runtime has not unloaded; new execution settings were not applied. No new work was submitted.')
      const thread = str(obj(result.thread).id)
      if (!thread && ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
        throw ownershipConflict(source ?? '', state(), undefined, 'missing-thread-id', message.method)
      }
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
      if (id !== undefined) send({ id, error: { code: error instanceof RpcError ? error.code : -32000, message: error instanceof Error ? error.message : String(error), ...(error instanceof RpcError ? { data: error.data } : {}) } })
    } finally {
      releaseSource?.()
    }
  }
  return { close, closed: connection.incoming, request(message: Message) {
    const work = request(message)
    pending.add(work); void work.finally(() => pending.delete(work))
  } }
}
