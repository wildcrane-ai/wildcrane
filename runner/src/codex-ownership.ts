import fs from 'node:fs'
import path from 'node:path'
import { bounded } from '../../cli/src/lib/shared/conversation'
import { tryLock } from '../../cli/src/lib/lock'
import { RpcError } from '../../cli/src/lib/agent/wire/rpc'
import { obj, str } from '../../cli/src/lib/agent/wire/json'
import { backgroundTerminals, CODEX_TIMEOUT, initializeNative, leaseFile, liveLease, nativeConnection, nativeDirectory, readPrivate, type NativeBackend, type ThreadLease } from './codex-native'

export function executionOwner(environment: NodeJS.ProcessEnv) {
  let execution: Record<string, unknown> = {}
  try { execution = obj(JSON.parse(environment.AI4KANBAN_EXECUTION ?? '{}')) } catch {}
  return { run: environment.KANBAN_RUN?.trim() || undefined, task: environment.AI4KANBAN_TASK?.trim() || undefined, job: str(execution.job).trim() || undefined }
}

export function ownershipConflict(thread: string, requester: Partial<ThreadLease>, owner: ThreadLease | undefined, status: string, phase: string, wait = false) {
  const describe = (value?: Partial<ThreadLease>) => ({ run: value?.run ?? 'unknown', task: value?.task ?? 'unknown', job: value?.job ?? 'unknown', pid: value?.pid ?? 'unknown', lease: value?.lease ?? 'unknown' })
  const evidence = { thread, requester: describe(requester), owner: describe(owner), status, phase }
  const failure = wait
    ? { code: 'codex_source_busy', level: 2, source: 'harness', reason: 'Waiting for the source conversation to finish.' }
    : { code: 'codex_ownership_unconfirmed', level: 3, source: 'invariant', reason: 'The conversation could not be opened safely. Saved work was preserved.' }
  if (!wait) console.error(JSON.stringify({ code: failure.code, ...evidence }))
  const message = status === 'caller-does-not-own-thread' ? 'This run does not own that Codex thread.' : 'Codex thread is already in use by another run.'
  return new RpcError(`${message} ${JSON.stringify(evidence)}`, -32000, { wildcraneFailure: failure })
}

export async function inspectThread(rpc: Awaited<ReturnType<typeof nativeConnection>>['rpc'], threadId: string) {
  let snapshot
  try { snapshot = obj((await rpc.call('thread/read', { threadId })).thread) }
  catch (error) {
    if (!(error instanceof RpcError) || !/thread not (?:found|loaded)|no rollout found/i.test(error.message)) throw error
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await rpc.call('thread/loaded/list', { ...(cursor ? { cursor } : {}) })
      if (!Array.isArray(page.data) || page.data.some(id => typeof id !== 'string') || page.nextCursor != null && typeof page.nextCursor !== 'string') throw Error('Codex loaded threads are unconfirmed.')
      if (page.data.includes(threadId)) return 'unverified'
      cursor = str(page.nextCursor) || undefined
      if (cursor && seen.has(cursor)) throw Error('Codex repeated a loaded-thread cursor.')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return 'notLoaded'
  }
  const status = str(obj(snapshot.status).type)
  if (status === 'idle' && (await backgroundTerminals(rpc, threadId)).length) return 'background-work'
  return status
}

/** Only dead connections are inspected; reconciliation never interrupts or cleans live work. */
export async function reconcileCodexLeases(backend: NativeBackend) {
  const directory = path.join(nativeDirectory(), 'threads', backend.instance)
  let files: string[]
  try { files = fs.readdirSync(directory).filter(name => name.endsWith('.json')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const groups = new Map<string, { file: string; thread: string; owner: ThreadLease }[]>()
  for (const name of files) {
    const file = path.join(directory, name), owner = readPrivate<ThreadLease>(file)
    if (!owner || owner.instance !== backend.instance || liveLease(owner)) continue
    const thread = owner.thread ?? owner.threads.find(id => leaseFile(backend, id) === file)
    if (!thread || leaseFile(backend, thread) !== file) continue
    const group = groups.get(owner.lease) ?? []
    group.push({ file, thread, owner }); groups.set(owner.lease, group)
  }
  if (!groups.size) return
  const connection = await nativeConnection(backend, () => {})
  try {
    await initializeNative(connection)
    for (const group of groups.values()) {
      const releases: (() => void)[] = []
      try {
        for (const { file, owner } of group) {
          const release = tryLock(file + '.lock')
          if (!release) break
          releases.push(release)
          const current = readPrivate<ThreadLease>(file)
          if (!current || current.lease !== owner.lease || liveLease(current)) break
        }
        if (releases.length !== group.length || group.some(({ file, owner }) => {
          const current = readPrivate<ThreadLease>(file)
          return !current || current.lease !== owner.lease || liveLease(current)
        })) continue
        if (group.some(({ owner }) => owner.threads.some(thread => {
          const sibling = readPrivate<ThreadLease>(leaseFile(backend, thread))
          return sibling?.lease === owner.lease && liveLease(sibling)
        }))) continue
        const safe = await bounded(Promise.all(group.map(async ({ thread }) => {
          const status = await inspectThread(connection.rpc, thread)
          return status === 'idle' || status === 'notLoaded'
        })), CODEX_TIMEOUT, 'Codex abandoned ownership verification timed out.')
        if (safe.every(Boolean)) for (const { file, owner } of group) {
          const current = readPrivate<ThreadLease>(file)
          if (current?.lease === owner.lease && !liveLease(current)) fs.rmSync(file, { force: true })
        }
      } catch (error) { console.error(`runner: Codex ownership verification: ${error instanceof Error ? error.message : String(error)}`) }
      finally { for (const release of releases.reverse()) release() }
    }
  } finally { connection.close() }
}
