import fs from 'node:fs'
import path from 'node:path'
import { tryLock } from '../../cli/src/lib/lock'
import { RpcError } from '../../cli/src/lib/agent/wire/rpc'
import { obj, str } from '../../cli/src/lib/agent/wire/json'
import { CODEX_TIMEOUT, initializeNative, inspectNativeThread, leaseFile, liveLease, nativeConnection, nativeDirectory, readPrivate, type NativeBackend, type ThreadLease } from './codex-native'

export function executionOwner(environment: NodeJS.ProcessEnv) {
  let execution: Record<string, unknown> = {}
  try { execution = obj(JSON.parse(environment.AI4KANBAN_EXECUTION ?? '{}')) } catch {}
  return { run: environment.KANBAN_RUN?.trim() || undefined, task: environment.AI4KANBAN_TASK?.trim() || undefined, job: str(execution.job).trim() || undefined }
}

export function ownershipConflict(thread: string, requester: Partial<ThreadLease>, owner: ThreadLease | undefined, status: string, phase: string, wait = false, diagnostic?: string) {
  const describe = (value?: Partial<ThreadLease>) => ({ run: value?.run ?? 'unknown', task: value?.task ?? 'unknown', job: value?.job ?? 'unknown', pid: value?.pid ?? 'unknown', lease: value?.lease ?? 'unknown' })
  const evidence = { thread, requester: describe(requester), owner: describe(owner), status, phase, diagnostic }
  const failure = wait
    ? { code: 'codex_source_busy', source: 'runner' as const, summary: 'Waiting for the source conversation to finish.' }
    : { code: 'codex_ownership_unconfirmed', source: 'runner' as const, summary: 'The conversation could not be opened safely. Saved work was preserved.' }
  if (!wait) console.error(JSON.stringify({ code: failure.code, ...evidence }))
  const message = status === 'caller-does-not-own-thread' ? 'This run does not own that Codex thread.' : 'Codex thread is already in use by another run.'
  return new RpcError(`${message} ${JSON.stringify(evidence)}`, -32000, { wildcraneFailure: failure })
}

function leaseGroups(backend: NativeBackend) {
  const directory = path.join(nativeDirectory(), 'threads', backend.instance)
  const groups = new Map<string, Map<string, ThreadLease>>()
  let files: string[]
  try { files = fs.readdirSync(directory).filter(name => name.endsWith('.json')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return groups; throw error }
  for (const name of files) {
    const file = path.join(directory, name), owner = readPrivate<ThreadLease>(file)
    if (!owner || owner.instance !== backend.instance || !Array.isArray(owner.threads)) continue
    const thread = owner.thread ?? owner.threads.find(id => leaseFile(backend, id) === file)
    if (!thread || leaseFile(backend, thread) !== file) continue
    const group = groups.get(owner.lease) ?? new Map<string, ThreadLease>()
    group.set(thread, owner); groups.set(owner.lease, group)
  }
  return groups
}

export function abandonedLeaseGroup(backend: NativeBackend, thread: string, owner: ThreadLease) {
  const group = leaseGroups(backend).get(owner.lease) ?? new Map<string, ThreadLease>()
  group.set(thread, owner)
  return group
}

export function lockLeaseGroup(backend: NativeBackend, group: Map<string, ThreadLease>) {
  const threads = [...new Set([...group].flatMap(([thread, owner]) => [thread, ...owner.threads]))].sort()
  const releases: (() => void)[] = []
  const release = () => { for (const unlock of releases.reverse()) unlock() }
  try {
    for (const thread of threads) {
      const unlock = tryLock(leaseFile(backend, thread) + '.lock')
      if (!unlock) { release(); return }
      releases.push(unlock)
    }
    const abandoned = () => threads.every(thread => {
      const owner = readPrivate<ThreadLease>(leaseFile(backend, thread)), expected = group.get(thread)
      return !owner || !!expected && Number.isInteger(owner.pid) && owner.pid > 0
        && JSON.stringify(owner) === JSON.stringify(expected) && !liveLease(owner)
    })
    return { threads, abandoned, release }
  } catch (error) { release(); throw error }
}

export async function verifyStoppedThreads(rpc: Awaited<ReturnType<typeof nativeConnection>>['rpc'], threads: string[], deadline = Date.now() + CODEX_TIMEOUT) {
  const evidence = await Promise.all(threads.map(async threadId => ({ threadId, ...await inspectNativeThread(rpc, threadId, deadline) })))
  return evidence.find(({ status }) => status !== 'idle' && status !== 'notLoaded')
}

/** Only dead connections are inspected; reconciliation never interrupts or cleans live work. */
export async function reconcileCodexLeases(backend: NativeBackend) {
  const groups = leaseGroups(backend)
  for (const [lease, group] of groups) if ([...group.values()].some(liveLease)) groups.delete(lease)
  if (!groups.size) return
  const connection = await nativeConnection(backend, () => {})
  try {
    await initializeNative(connection)
    for (const group of groups.values()) {
      const locked = lockLeaseGroup(backend, group)
      if (!locked) continue
      try {
        if (!locked.abandoned()) continue
        const problem = await verifyStoppedThreads(connection.rpc, locked.threads)
        if (problem?.diagnostic) console.error(`runner: Codex ownership verification: ${problem.threadId}: ${problem.diagnostic}`)
        if (!problem && locked.abandoned()) for (const thread of group.keys()) fs.rmSync(leaseFile(backend, thread), { force: true })
      } catch (error) { console.error(`runner: Codex ownership verification: ${error instanceof Error ? error.message : String(error)}`) }
      finally { locked.release() }
    }
  } finally { connection.close() }
}
