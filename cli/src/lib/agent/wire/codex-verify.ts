import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'

import { machineHome } from '../../machine/home'
import { bounded } from '../../shared/conversation'
import { connectionStopped } from '../connection-process'
import { itemTerminal, type Cleanup } from './codex-background-types'
import { findCodexRollout } from './codex-session'
import { obj, str, type Json } from './json'
import { connect, RpcError, type Rpc } from './rpc'

const PROBE_TIMEOUT_MS = 3_000

interface NativeBackendFile {
  pid: number
  identity?: string
  instance: string
  endpoint: string
  token?: string
}

interface ThreadLeaseFile {
  pid: number
  identity?: string
  lease: string
  instance: string
  threads: string[]
  retained?: { root: string; execution: string; kept: Json[] }
  uncertain?: boolean
  thread?: string
  run?: string
  task?: string
  job?: string
}

export interface CodexVerifyRun {
  sessionId: string
  cardId?: number | null
  resumeId?: string
  harness?: string
  continues?: { resumeId: string; fork?: boolean }
  cloudExecution?: { job: string; machine: string; card?: number }
}

export interface CodexVerifyInput {
  session: string
  cwd?: string
  deliveryId?: string
  cleanup?: Cleanup
  pendingIds?: Iterable<string>
  eventsPath?: string
  cardId?: number | null
  taskId?: string | null
  runs?: readonly CodexVerifyRun[]
  selfSessionId?: string
  needsBackendProbe?: boolean
  codexHome?: string
}

export interface CodexStopVerification {
  stopped: boolean
  ownershipOk: boolean
  found: boolean
  settled: boolean
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

function nativeDirs(): string[] {
  const explicit = [process.env.WILDCRANE_HOME?.trim(), process.env.AI4KANBAN_HOME?.trim()].filter(Boolean) as string[]
  const homes = explicit.length ? [...new Set(explicit)] : [path.join(os.homedir(), '.wildcrane')]
  return homes.map((home) => path.join(home, 'codex-native')).filter((dir) => fs.existsSync(dir))
}

function liveBackends(): NativeBackendFile[] {
  const out: NativeBackendFile[] = []
  for (const dir of nativeDirs()) {
    let files: string[] = []
    try {
      files = fs.readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    } catch {
      continue
    }
    for (const file of files) {
      const backend = readJson<NativeBackendFile>(path.join(dir, file))
      if (backend && typeof backend.endpoint === 'string' && !connectionStopped(backend)) out.push(backend)
    }
  }
  return out
}

function allLeasesFor(threadIds: ReadonlySet<string>): ThreadLeaseFile[] {
  if (!threadIds.size) return []
  const hashes = new Set([...threadIds].map((id) => `${crypto.createHash('sha256').update(id).digest('hex')}.json`))
  const found: ThreadLeaseFile[] = []
  for (const dir of nativeDirs()) {
    const threadsRoot = path.join(dir, 'threads')
    let instances: string[] = []
    try {
      instances = fs.readdirSync(threadsRoot)
    } catch {
      continue
    }
    for (const instance of instances) {
      const instDir = path.join(threadsRoot, instance)
      let files: string[] = []
      try {
        files = fs.readdirSync(instDir).filter((name) => name.endsWith('.json'))
      } catch {
        continue
      }
      for (const name of files) {
        if (!hashes.has(name)) continue
        const lease = readJson<ThreadLeaseFile>(path.join(instDir, name))
        if (lease && typeof lease.lease === 'string' && Array.isArray(lease.threads)) found.push(lease)
      }
    }
  }
  return found
}

export function hasLiveCodexExecution(threadId: string): boolean {
  const leases = allLeasesFor(new Set([threadId]))
  return leases.some((lease) => !connectionStopped(lease) && !(lease.retained?.kept?.length && !lease.uncertain))
}

function stripFileUrl(value: string): string {
  if (!value.startsWith('file://')) return value
  try {
    return decodeURIComponent(new URL(value).pathname)
  } catch {
    return value.slice('file://'.length)
  }
}

function realOrResolved(dir: string): string {
  const clean = stripFileUrl(dir)
  try {
    return fs.realpathSync(clean)
  } catch {
    return path.resolve(clean)
  }
}

function worktreeIdOf(dir: string | undefined): string | undefined {
  if (!dir) return undefined
  return /[\\/]\.akb[\\/]worktrees[\\/]([^\\/]+)(?:[\\/]|$)/.exec(stripFileUrl(dir))?.[1]
}

function cwdMatches(expectedCwd: string | undefined, expectedDeliveryId: string | undefined, actualCwd: string | undefined): boolean {
  if (!actualCwd?.trim()) return true
  const expectedWt = expectedDeliveryId || worktreeIdOf(expectedCwd)
  const actualWt = worktreeIdOf(actualCwd)
  if (expectedWt && actualWt) return expectedWt === actualWt
  if (!expectedWt && expectedCwd && actualWt) return false
  if (expectedWt && expectedCwd && worktreeIdOf(expectedCwd) && !actualWt) return false
  if (!expectedWt && !actualWt && expectedCwd) return realOrResolved(actualCwd) === realOrResolved(expectedCwd)
  return true
}

function checkOwnership(input: CodexVerifyInput, leases: readonly ThreadLeaseFile[], threadCwd?: string): boolean {
  const { session, cardId, taskId, runs, selfSessionId, cwd, deliveryId } = input
  if (cardId != null && runs) {
    for (const r of runs) {
      if (r.sessionId === selfSessionId) continue
      const sameSession = r.resumeId === session || (r.continues?.resumeId === session && !r.continues.fork)
      if (!sameSession) continue
      if ((r.cardId != null && r.cardId !== cardId) || (r.cloudExecution?.card !== undefined && r.cloudExecution.card !== cardId)) {
        return false
      }
    }
  }
  const cleanTask = taskId?.trim()
  if (cleanTask) {
    for (const lease of leases) {
      if (lease.task && lease.task !== cleanTask) return false
    }
    const safeTask = cleanTask.replace(/[^\w.@-]/g, '_')
    const hashFile = `${crypto.createHash('sha256').update(session).digest('hex')}.json`
    const sessionsDir = path.join(machineHome(), 'studios', 'sessions')
    if (!fs.existsSync(path.join(sessionsDir, safeTask, hashFile))) {
      let tasks: string[] = []
      try {
        tasks = fs.readdirSync(sessionsDir)
      } catch {
        tasks = []
      }
      if (tasks.some((other) => other !== safeTask && fs.existsSync(path.join(sessionsDir, other, hashFile)))) {
        return false
      }
    }
  }
  return cwdMatches(cwd, deliveryId, threadCwd)
}

interface RolloutState {
  valid: boolean
  cwd?: string
  turnOpen: boolean
  lastTurnAborted: boolean
  pendingCalls: Set<string>
  inProgressItems: Set<string>
  terminalItems: Set<string>
  runningExecSessions: Set<string>
  exitedProcesses: Set<string>
  children: Set<string>
}

function collectItemChildren(item: Json, root: string, children: Set<string>): void {
  const t = str(item.type)
  if (t === 'SubAgentActivity' || t === 'subAgentActivity') {
    const child = str(item.agentThreadId) || str(item.agent_thread_id)
    if (child && child !== root) children.add(child)
  } else if (t === 'CollabAgentToolCall' || t === 'collabAgentToolCall' || t === 'collab_tool_call') {
    const ids = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds
      : Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : []
    for (const id of ids) if (typeof id === 'string' && id && id !== root) children.add(id)
    for (const id of Object.keys(obj(item.agentsStates ?? item.agents_states))) {
      if (id && id !== root) children.add(id)
    }
  }
}

function observeItemCompletion(
  item: Json,
  root: string,
  children: Set<string>,
  inProgressItems: Set<string>,
  terminalItems: Set<string>,
  exitedProcesses: Set<string>,
  runningExecSessions: Set<string>,
): void {
  collectItemChildren(item, root, children)
  const id = str(item.id)
  const type = str(item.type).toLowerCase()
  const status = str(item.status)
  if (type === 'commandexecution' || type === 'command_execution') {
    const exitCode = typeof item.exit_code === 'number' ? item.exit_code
      : typeof item.exitCode === 'number' ? item.exitCode : undefined
    const pid = str(item.process_id) || str(item.processId)
    if ((status === 'completed' || status === 'failed') && exitCode !== undefined) {
      if (id) {
        terminalItems.add(id)
        inProgressItems.delete(id)
      }
      if (pid) {
        exitedProcesses.add(pid)
        runningExecSessions.delete(pid)
      }
    } else if (id && !terminalItems.has(id)) {
      inProgressItems.add(id)
    }
  } else if (type === 'mcptoolcall' || type === 'mcp_tool_call' || type === 'filechange' || type === 'file_change') {
    if (status === 'completed' || status === 'failed') {
      if (id) {
        terminalItems.add(id)
        inProgressItems.delete(id)
      }
    } else if (id && !terminalItems.has(id)) {
      inProgressItems.add(id)
    }
  }
}

function inspectRolloutFile(file: string, threadId: string): RolloutState | undefined {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const state: RolloutState = {
    valid: true,
    turnOpen: false,
    lastTurnAborted: false,
    pendingCalls: new Set(),
    inProgressItems: new Set(),
    terminalItems: new Set(),
    runningExecSessions: new Set(),
    exitedProcesses: new Set(),
    children: new Set(),
  }
  const callNames = new Map<string, string>()
  const callSessions = new Map<string, string>()
  for (const line of trimmed.split('\n')) {
    if (!line.trim()) continue
    let entry: { type?: unknown; payload?: unknown }
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object') {
        state.valid = false
        return state
      }
      entry = parsed as { type?: unknown; payload?: unknown }
    } catch {
      state.valid = false
      return state
    }
    if (entry.type === 'compacted') {
      state.pendingCalls.clear()
      continue
    }
    const payload = obj(entry.payload)
    if (entry.type === 'session_meta' || entry.type === 'turn_context') {
      state.cwd = str(payload.cwd) || state.cwd
      continue
    }
    if (entry.type === 'response_item') {
      const pType = str(payload.type)
      if (pType === 'function_call' || pType === 'custom_tool_call') {
        const callId = str(payload.call_id)
        const name = str(payload.name)
        if (callId) {
          state.pendingCalls.add(callId)
          callNames.set(callId, name)
          if (name === 'write_stdin' && typeof payload.arguments === 'string') {
            try {
              const args = obj(JSON.parse(payload.arguments))
              const sid = typeof args.session_id === 'number' || typeof args.session_id === 'string' ? String(args.session_id) : ''
              if (sid) callSessions.set(callId, sid)
            } catch {}
          }
        }
      } else if (pType === 'function_call_output' || pType === 'custom_tool_call_output') {
        const callId = str(payload.call_id)
        if (callId) state.pendingCalls.delete(callId)
        const name = callNames.get(callId)
        const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '')
        if (name === 'spawn_agent') {
          try {
            const parsed = obj(JSON.parse(output))
            const child = str(parsed.agent_id)
            if (child && child !== threadId) state.children.add(child)
          } catch {}
        }
        const runningMatch = /Process running with session ID (\d+)/.exec(output)
        if (runningMatch?.[1] && !state.exitedProcesses.has(runningMatch[1])) {
          state.runningExecSessions.add(runningMatch[1])
        }
        const exitedSession = callSessions.get(callId)
        if (exitedSession && /Process exited with code -?\d+/.test(output)) {
          state.exitedProcesses.add(exitedSession)
          state.runningExecSessions.delete(exitedSession)
        }
        if (output.startsWith('{')) {
          try {
            const parsed = obj(JSON.parse(output))
            const sid = typeof parsed.session_id === 'number' || typeof parsed.session_id === 'string'
              ? String(parsed.session_id) : exitedSession
            const exitCode = typeof parsed.exit_code === 'number' ? parsed.exit_code
              : typeof obj(parsed.metadata).exit_code === 'number' ? (obj(parsed.metadata).exit_code as number) : undefined
            if (sid && exitCode !== undefined) {
              state.exitedProcesses.add(sid)
              state.runningExecSessions.delete(sid)
            } else if (sid && parsed.session_id !== undefined && !state.exitedProcesses.has(sid)) {
              state.runningExecSessions.add(sid)
            }
          } catch {}
        }
      }
      continue
    }
    if (entry.type === 'event_msg') {
      const eType = str(payload.type)
      if (eType === 'task_started') {
        state.turnOpen = true
        state.lastTurnAborted = false
      } else if (eType === 'task_complete') {
        state.turnOpen = false
        state.lastTurnAborted = false
      } else if (eType === 'turn_aborted') {
        state.turnOpen = false
        state.lastTurnAborted = true
      } else if (eType === 'item_started') {
        const item = obj(payload.item)
        collectItemChildren(item, threadId, state.children)
        const id = str(item.id)
        const iType = str(item.type).toLowerCase()
        if (id && (iType === 'commandexecution' || iType === 'command_execution'
          || iType === 'mcptoolcall' || iType === 'mcp_tool_call'
          || iType === 'filechange' || iType === 'file_change') && !state.terminalItems.has(id)) {
          state.inProgressItems.add(id)
        }
      } else if (eType === 'item_completed') {
        observeItemCompletion(
          obj(payload.item),
          threadId,
          state.children,
          state.inProgressItems,
          state.terminalItems,
          state.exitedProcesses,
          state.runningExecSessions,
        )
      }
    }
  }
  return state
}

interface Requirements {
  byThread: Map<string, { itemId: string; processId?: string }[]>
  stoppedIds: Set<string>
  stoppedProcesses: Set<string>
  retainedProcesses: Set<string>
  children: Set<string>
}

function collectRequirements(input: CodexVerifyInput, leases: readonly ThreadLeaseFile[]): Requirements {
  const byThread = new Map<string, { itemId: string; processId?: string }[]>()
  const stoppedIds = new Set<string>()
  const stoppedProcesses = new Set<string>()
  const retainedProcesses = new Set<string>()
  const children = new Set<string>()
  const addReq = (tid: string, itemId: string, processId?: string) => {
    if (!itemId) return
    const list = byThread.get(tid) ?? []
    if (!list.some((entry) => entry.itemId === itemId)) list.push({ itemId, processId })
    byThread.set(tid, list)
  }

  for (const lease of leases) {
    for (const id of lease.threads) {
      if (id && id !== input.session) children.add(id)
    }
    if (!lease.uncertain && lease.retained?.root === input.session) {
      for (const raw of lease.retained.kept) {
        const kept = obj(raw)
        const tid = str(kept.threadId) || input.session
        const itemId = str(kept.itemId)
        const pid = str(kept.processId)
        if (itemId) stoppedIds.add(`${tid}:${itemId}`)
        if (pid) retainedProcesses.add(pid)
      }
    }
  }

  for (const item of input.cleanup?.items ?? []) {
    if (item.id.startsWith('agent:')) {
      const child = item.id.slice('agent:'.length)
      if (child && child !== input.session) children.add(child)
      if (itemTerminal(item)) stoppedIds.add(item.id)
      continue
    }
    const tid = item.threadId || input.session
    const prefix = `terminal:${tid}:`
    const rawId = item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id.replace(/^terminal:[^:]+:/, '')
    if (itemTerminal(item) || (input.cleanup?.status === 'confirmed' && item.disposition === 'keep')) {
      if (rawId) stoppedIds.add(`${tid}:${rawId}`)
      if (item.processId) stoppedProcesses.add(item.processId)
    } else {
      addReq(tid, rawId, item.processId)
    }
  }

  for (const id of input.pendingIds ?? []) {
    if (id.startsWith('agent:')) {
      const child = id.slice('agent:'.length)
      if (child && child !== input.session) children.add(child)
    } else {
      addReq(input.session, id)
    }
  }

  if (input.eventsPath && fs.existsSync(input.eventsPath)) {
    try {
      const open = new Set<string>()
      for (const line of fs.readFileSync(input.eventsPath, 'utf8').split('\n')) {
        if (!line.includes('"tool_call')) continue
        const ev = obj(JSON.parse(line))
        const data = obj(ev.data)
        const id = str(data.toolCallId)
        const status = str(data.status)
        if (!id) continue
        if (ev.kind === 'tool_call') {
          if (status === 'completed' || status === 'failed') open.delete(id)
          else open.add(id)
        } else if (ev.kind === 'tool_call_update' && (status === 'completed' || status === 'failed')) {
          open.delete(id)
        }
      }
      for (const id of open) {
        if (id.startsWith('agent:')) {
          const child = id.slice('agent:'.length)
          if (child && child !== input.session) children.add(child)
        } else if (!stoppedIds.has(`${input.session}:${id}`)) {
          addReq(input.session, id)
        }
      }
    } catch {
      addReq(input.session, '__corrupt_events__')
    }
  }

  return { byThread, stoppedIds, stoppedProcesses, retainedProcesses, children }
}

interface NativeThreadObservation {
  active: boolean
  unverified: boolean
  backgroundProcessIds: string[]
  path?: string
  cwd?: string
  turns?: Json[]
}

function encodeWsText(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const mask = crypto.randomBytes(4)
  const head = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : payload.length < 65536
      ? (() => { const b = Buffer.alloc(4); b[0] = 0x81; b[1] = 0x80 | 126; b.writeUInt16BE(payload.length, 2); return b })()
      : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(payload.length), 2); return b })()
  const masked = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i & 3]!
  return Buffer.concat([head, mask, masked])
}

async function openNativeRpc(backend: NativeBackendFile, timeoutMs: number): Promise<{ rpc: Rpc; close: () => void }> {
  const unix = backend.endpoint.startsWith('unix://')
  const url = unix ? undefined : new URL(backend.endpoint.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:'))
  const key = crypto.randomBytes(16).toString('base64')
  const incoming = new PassThrough()
  let sock: import('node:stream').Duplex | undefined
  let closed = false
  const outgoing = new Writable({
    write(chunk, _enc, done) {
      if (!sock || sock.destroyed) return done(new Error('Codex socket closed.'))
      const frames = String(chunk).split('\n').map((l) => l.trim()).filter(Boolean).map(encodeWsText)
      if (!frames.length) return done()
      sock.write(Buffer.concat(frames), done)
    },
  })
  incoming.on('error', () => {})
  outgoing.on('error', () => {})
  const close = () => {
    if (closed) return
    closed = true
    incoming.destroy()
    outgoing.destroy()
    sock?.destroy()
  }
  await bounded(new Promise<void>((resolve, reject) => {
    const req = http.request({
      ...(unix
        ? { socketPath: backend.endpoint.slice('unix://'.length), path: '/' }
        : { hostname: url!.hostname, port: url!.port, path: `${url!.pathname}${url!.search}` }),
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...(backend.token ? { Authorization: `Bearer ${backend.token}` } : {}),
      },
    })
    req.once('error', reject)
    req.once('response', (res) => reject(new Error(`Unexpected HTTP ${res.statusCode ?? 0}`)))
    req.once('upgrade', (_res, socket, head) => {
      sock = socket
      let buffer: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0)
      let fragments: Buffer[] = []
      const onData = (chunk: Buffer) => {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk)
        for (;;) {
          if (buffer.length < 2) return
          const fin = (buffer[0]! & 0x80) !== 0
          const opcode = buffer[0]! & 0x0f
          const masked = (buffer[1]! & 0x80) !== 0
          let len = buffer[1]! & 0x7f
          let offset = 2
          if (len === 126) {
            if (buffer.length < 4) return
            len = buffer.readUInt16BE(2)
            offset = 4
          } else if (len === 127) {
            if (buffer.length < 10) return
            len = Number(buffer.readBigUInt64BE(2))
            offset = 10
          }
          const total = offset + (masked ? 4 : 0) + len
          if (buffer.length < total) return
          const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
          offset += masked ? 4 : 0
          const body = Buffer.from(buffer.subarray(offset, offset + len))
          buffer = buffer.subarray(total)
          if (mask) for (let i = 0; i < body.length; i++) body[i]! ^= mask[i & 3]!
          if (opcode === 0x08) {
            close()
            return
          }
          if (opcode === 0x09) {
            const pongMask = crypto.randomBytes(4)
            const pongBody = Buffer.allocUnsafe(body.length)
            for (let i = 0; i < body.length; i++) pongBody[i] = body[i]! ^ pongMask[i & 3]!
            if (body.length < 126) socket.write(Buffer.concat([Buffer.from([0x8a, 0x80 | body.length]), pongMask, pongBody]))
            continue
          }
          if (opcode === 0x01 || opcode === 0x00) {
            fragments.push(body)
            if (fin) {
              const text = Buffer.concat(fragments).toString('utf8')
              fragments = []
              if (!incoming.destroyed) incoming.write(`${text}\n`)
            }
          }
        }
      }
      if (buffer.length) {
        const initial = buffer
        buffer = Buffer.alloc(0)
        onData(initial)
      }
      socket.on('data', onData)
      socket.once('error', () => close())
      socket.once('close', () => close())
      resolve()
    })
    req.end()
  }), timeoutMs, 'Codex native probe timed out.')
  const rpc = connect(incoming, outgoing, () => {})
  try {
    await bounded(rpc.call('initialize', { clientInfo: { name: 'wildcrane-verify', version: '1' }, capabilities: { experimentalApi: true } }), timeoutMs, 'Codex initialize timed out.')
    rpc.notify('initialized')
    return { rpc, close }
  } catch (err) {
    close()
    throw err
  }
}

async function probeBackendThread(rpc: Rpc, threadId: string, deadline: number): Promise<NativeThreadObservation | undefined> {
  const call = (method: string, params: Json) => {
    const rem = deadline - Date.now()
    if (rem <= 0) throw new Error('Codex probe timed out.')
    return bounded(rpc.call(method, params), rem, 'Codex probe timed out.')
  }
  try {
    const reply = await call('thread/read', { threadId })
    const thread = obj(reply.thread)
    const status = str(obj(thread.status).type)
    if (thread.id !== threadId || (status !== 'notLoaded' && status !== 'active' && status !== 'idle')) {
      return { active: false, unverified: true, backgroundProcessIds: [] }
    }
    if (status === 'active') {
      return { active: true, unverified: false, backgroundProcessIds: [], path: str(thread.path) || undefined, cwd: str(thread.cwd) || undefined }
    }
    const backgroundProcessIds: string[] = []
    if (status === 'idle') {
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        if (cursor !== undefined) {
          if (seen.has(cursor)) return { active: false, unverified: true, backgroundProcessIds: [] }
          seen.add(cursor)
        }
        const page = await call('thread/backgroundTerminals/list', { threadId, ...(cursor ? { cursor } : {}) })
        if (!Array.isArray(page.data)) return { active: false, unverified: true, backgroundProcessIds: [] }
        for (const raw of page.data) backgroundProcessIds.push(str(obj(raw).processId) || '__unknown__')
        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined
      } while (cursor !== undefined)
    }
    let turns: Json[] | undefined
    const rolloutPath = str(thread.path) || undefined
    if (!rolloutPath || status === 'idle') {
      try {
        if (thread.historyMode === 'paginated') {
          const listed = await call('thread/turns/list', { threadId, sortDirection: 'desc', limit: 20, itemsView: 'full' })
          if (Array.isArray(listed.data)) turns = listed.data.map(obj).reverse()
        } else {
          const full = obj((await call('thread/read', { threadId, includeTurns: true })).thread)
          if (Array.isArray(full.turns)) turns = full.turns.map(obj)
        }
      } catch {
        // Unloaded threads without in-memory turns fall back to disk rollout.
      }
    }
    return {
      active: false,
      unverified: false,
      backgroundProcessIds,
      path: rolloutPath,
      cwd: str(thread.cwd) || undefined,
      turns,
    }
  } catch (err) {
    if (err instanceof RpcError) {
      try {
        let cursor: string | undefined
        const seen = new Set<string>()
        do {
          const page = await call('thread/loaded/list', cursor === undefined ? {} : { cursor })
          if (!Array.isArray(page.data)) return { active: false, unverified: true, backgroundProcessIds: [] }
          if (page.data.includes(threadId)) return { active: false, unverified: true, backgroundProcessIds: [] }
          cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined
          if (cursor !== undefined) {
            if (seen.has(cursor)) return { active: false, unverified: true, backgroundProcessIds: [] }
            seen.add(cursor)
          }
        } while (cursor !== undefined)
        return undefined
      } catch {
        return { active: false, unverified: true, backgroundProcessIds: [] }
      }
    }
    return { active: false, unverified: true, backgroundProcessIds: [] }
  }
}

function evaluateStopState(
  input: CodexVerifyInput,
  leases: readonly ThreadLeaseFile[],
  nativeMap: ReadonlyMap<string, NativeThreadObservation>,
  unprobedLiveBackend: boolean,
): CodexStopVerification {
  for (const lease of leases) {
    if (!connectionStopped(lease) && !(lease.retained?.kept?.length && !lease.uncertain)) {
      return { stopped: false, ownershipOk: checkOwnership(input, leases), found: false, settled: false }
    }
    if (unprobedLiveBackend && (lease.uncertain || !lease.retained?.kept?.length)) {
      return { stopped: false, ownershipOk: checkOwnership(input, leases), found: false, settled: false }
    }
  }

  const reqs = collectRequirements(input, leases)
  const visited = new Set<string>()
  const queue = [input.session, ...reqs.children]
  let rootFound = false
  let rootCwd: string | undefined
  let settled = true

  while (queue.length > 0) {
    const tid = queue.shift()!
    if (!tid || visited.has(tid)) continue
    visited.add(tid)

    const nativeObs = nativeMap.get(tid)
    if (nativeObs?.active) {
      return { stopped: false, ownershipOk: checkOwnership(input, leases, nativeObs.cwd ?? rootCwd), found: true, settled: false }
    }
    if (nativeObs?.unverified) {
      settled = false
    }
    for (const pid of nativeObs?.backgroundProcessIds ?? []) {
      if (!reqs.retainedProcesses.has(pid) && !reqs.stoppedProcesses.has(pid)) settled = false
    }

    const rolloutPath = nativeObs?.path || findCodexRollout(tid, input.codexHome)
    const rollout = rolloutPath ? inspectRolloutFile(rolloutPath, tid) : undefined
    const hasNativeTurns = Array.isArray(nativeObs?.turns) && nativeObs.turns.length > 0
    const threadFound = !!rollout || hasNativeTurns

    if (tid === input.session) {
      rootFound = threadFound
      rootCwd = rollout?.cwd ?? nativeObs?.cwd
    } else if (!threadFound) {
      if (!reqs.stoppedIds.has(`agent:${tid}`)) settled = false
      continue
    }

    if (rollout && !rollout.valid) settled = false

    const inProgress = new Set(rollout?.inProgressItems ?? [])
    const terminal = new Set(rollout?.terminalItems ?? [])
    const exited = new Set([...(rollout?.exitedProcesses ?? []), ...reqs.stoppedProcesses, ...reqs.retainedProcesses])
    const runningSessions = new Set(rollout?.runningExecSessions ?? [])
    const children = new Set(rollout?.children ?? [])

    if (nativeObs?.turns) {
      for (const turn of nativeObs.turns) {
        const tStatus = str(turn.status)
        if (tStatus === 'inProgress') settled = false
        if (tid !== input.session && tStatus === 'interrupted' && !reqs.stoppedIds.has(`agent:${tid}`)) settled = false
        const items = Array.isArray(turn.items) ? turn.items.map(obj) : []
        for (const item of items) {
          observeItemCompletion(item, tid, children, inProgress, terminal, exited, runningSessions)
        }
      }
    }

    for (const child of children) {
      if (!visited.has(child)) queue.push(child)
    }

    if (rollout) {
      if (rollout.pendingCalls.size > 0) settled = false
      if (tid !== input.session && (rollout.turnOpen || rollout.lastTurnAborted) && !reqs.stoppedIds.has(`agent:${tid}`)) {
        settled = false
      }
    }

    for (const id of inProgress) {
      if (!terminal.has(id) && !reqs.stoppedIds.has(`${tid}:${id}`)) settled = false
    }
    for (const sid of runningSessions) {
      if (!exited.has(sid)) settled = false
    }
    for (const req of reqs.byThread.get(tid) ?? []) {
      const ok = terminal.has(req.itemId)
        || reqs.stoppedIds.has(`${tid}:${req.itemId}`)
        || (!!req.processId && exited.has(req.processId))
      if (!ok) settled = false
    }
  }

  const extraLeases = allLeasesFor(visited)
  for (const lease of extraLeases) {
    if (!connectionStopped(lease) && !(lease.retained?.kept?.length && !lease.uncertain)) {
      return { stopped: false, ownershipOk: checkOwnership(input, extraLeases, rootCwd), found: rootFound, settled: false }
    }
  }

  const ownershipOk = checkOwnership(input, extraLeases.length ? extraLeases : leases, rootCwd)
  return {
    stopped: true,
    ownershipOk,
    found: rootFound,
    settled: rootFound && settled,
  }
}

export function verifyCodexStopStateSync(input: CodexVerifyInput): CodexStopVerification {
  if (!input.session) return { stopped: true, ownershipOk: true, found: false, settled: false }
  const initialIds = new Set<string>([input.session])
  for (const item of input.cleanup?.items ?? []) {
    if (item.threadId) initialIds.add(item.threadId)
    if (item.id.startsWith('agent:')) initialIds.add(item.id.slice('agent:'.length))
  }
  const leases = allLeasesFor(initialIds)
  const backends = leases.length || input.needsBackendProbe ? liveBackends() : []
  return evaluateStopState(input, leases, new Map(), backends.length > 0 && leases.length > 0)
}

export async function verifyCodexStopState(input: CodexVerifyInput): Promise<CodexStopVerification> {
  if (!input.session) return { stopped: true, ownershipOk: true, found: false, settled: false }
  const initialIds = new Set<string>([input.session])
  for (const item of input.cleanup?.items ?? []) {
    if (item.threadId) initialIds.add(item.threadId)
    if (item.id.startsWith('agent:')) initialIds.add(item.id.slice('agent:'.length))
  }
  const leases = allLeasesFor(initialIds)
  for (const lease of leases) {
    if (!connectionStopped(lease) && !(lease.retained?.kept?.length && !lease.uncertain)) {
      return { stopped: false, ownershipOk: checkOwnership(input, leases), found: false, settled: false }
    }
  }
  const shouldProbe = leases.length > 0 || input.needsBackendProbe === true
  const backends = shouldProbe ? liveBackends() : []
  const nativeMap = new Map<string, NativeThreadObservation>()
  let unprobed = false

  if (backends.length > 0) {
    const deadline = Date.now() + PROBE_TIMEOUT_MS
    const toInspect = new Set<string>(initialIds)
    for (const lease of leases) for (const id of lease.threads) if (id) toInspect.add(id)
    for (const backend of backends) {
      let conn: Awaited<ReturnType<typeof openNativeRpc>> | undefined
      try {
        conn = await openNativeRpc(backend, Math.max(250, deadline - Date.now()))
        const queue = [...toInspect]
        const inspected = new Set<string>()
        while (queue.length > 0) {
          const tid = queue.shift()!
          if (!tid || inspected.has(tid)) continue
          inspected.add(tid)
          const obs = await probeBackendThread(conn.rpc, tid, deadline)
          if (obs) {
            nativeMap.set(tid, obs)
            if (obs.turns) {
              for (const turn of obs.turns) {
                for (const raw of Array.isArray(turn.items) ? turn.items : []) {
                  const children = new Set<string>()
                  collectItemChildren(obj(raw), tid, children)
                  for (const child of children) if (!inspected.has(child)) queue.push(child)
                }
              }
            }
          }
        }
      } catch {
        if (!connectionStopped(backend)) unprobed = true
      } finally {
        conn?.close()
      }
    }
  }

  return evaluateStopState(input, leases, nativeMap, unprobed)
}
