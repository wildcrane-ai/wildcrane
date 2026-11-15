import fs from 'node:fs'
import { bounded } from '../../cli/src/lib/shared/conversation'
import { backgroundTerminals, CODEX_TIMEOUT, initializeNative, leaseFile, nativeConnection, processIdentity, readPrivate, writePrivate, type NativeBackend, type ThreadLease } from './codex-native'
import { accountGeneration, executorRecord } from './settings-control'
import { obj, str } from '../../cli/src/lib/agent/wire/json'

/** One execution's retained services keep their subscription, not a second shared manager. */
async function retain() {
  const backend = readPrivate<NativeBackend>(process.argv[2]!)
  const initial = readPrivate<ThreadLease>(process.argv[3]!)
  const lease = process.argv[4]
  if (!backend || !initial?.retained || initial.lease !== lease || initial.instance !== backend.instance || backend.generation !== accountGeneration()) throw Error('Codex retained ownership expired.')
  const identity = processIdentity()
  const release = executorRecord()
  const state = { ...initial, ...identity }
  let closing = false, transferred = false
  const active = new Map<string, string>(), unloaded = new Map<string, () => void>()
  let wake!: () => void
  const done = new Promise<void>(resolve => { wake = resolve })
  const connection = await nativeConnection(backend, message => {
    const params = obj(message.params), id = str(params.threadId)
    if (message.id !== undefined) { connection.rpc.refuse(message.id, 'Retained services cannot request new interaction.'); return }
    if (message.method === 'turn/started') active.set(id, str(obj(params.turn).id))
    if (message.method === 'turn/completed') active.delete(id)
    if (message.method === 'thread/closed') unloaded.get(id)?.()
    if (message.method === 'item/completed' && obj(params.item).type === 'commandExecution') {
      state.retained = { ...state.retained!, kept: state.retained!.kept.filter(item => item.threadId !== id || item.itemId !== obj(params.item).id) }
      for (const thread of initial.threads) {
        const current = readPrivate<ThreadLease>(leaseFile(backend, thread))
        if (current?.lease === lease && current.pid === process.pid) writePrivate(leaseFile(backend, thread), { ...state, retained: state.retained.kept.length ? state.retained : undefined })
      }
      if (!state.retained.kept.length) wake()
    }
  })
  try {
    await initializeNative(connection)
    for (const id of initial.threads) await connection.rpc.call('thread/resume', { threadId: id })
    if (readPrivate<ThreadLease>(process.argv[3]!)?.lease !== lease) throw Error('Codex retained ownership changed during preparation.')
    for (const id of initial.threads) writePrivate(leaseFile(backend, id), state)
    process.send?.({ ready: lease })
    const timer = setInterval(() => {
      const current = readPrivate<ThreadLease>(process.argv[3]!)
      if (current?.lease !== lease && current?.adopting !== lease) { transferred = true; wake() }
      if (backend.generation !== accountGeneration()) wake()
    }, 200)
    connection.incoming.once('close', wake)
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, wake)
    await done
    closing = true; clearInterval(timer)
    if (transferred) return
    await bounded((async () => {
      for (const id of initial.threads) {
        if (readPrivate<ThreadLease>(leaseFile(backend, id))?.lease !== lease) continue
        if (active.has(id)) await connection.rpc.call('turn/interrupt', { threadId: id, turnId: active.get(id) })
        const terminals = await backgroundTerminals(connection.rpc, id)
        if (terminals.length) await connection.rpc.call('thread/backgroundTerminals/clean', { threadId: id })
        const closed = new Promise<void>(resolve => unloaded.set(id, resolve))
        const answer = await connection.rpc.call('thread/unsubscribe', { threadId: id })
        if (answer.status === 'unsubscribed') await closed
        if (readPrivate<ThreadLease>(leaseFile(backend, id))?.lease === lease) fs.rmSync(leaseFile(backend, id), { force: true })
      }
    })(), CODEX_TIMEOUT, 'Retained Codex cleanup is unconfirmed.')
  } catch (error) {
    for (const id of initial.threads) if (readPrivate<ThreadLease>(leaseFile(backend, id))?.lease === lease) writePrivate(leaseFile(backend, id), { ...state, retained: undefined, uncertain: true })
    if (!closing) throw error
  } finally { connection.close(); release() }
}
void retain().catch(error => { console.error(String(error)); process.exitCode = 1 })
