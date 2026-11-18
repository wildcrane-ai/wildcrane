import type { ExecutionFailure } from '../retry'
import { codexFailure, executionFailure } from './failures'
import { bounded, CONVERSATION_MS } from '../../shared/conversation'
import type { RunClient, ClientTurn, TurnEnd } from './client'
import { randomUUID } from 'node:crypto'
import { batch, CODEX_SETTLE_MS, settlementPrompt, type Cleanup, type ManagedWork } from './codex-background'
import { codexWork } from './codex-work'
import { createCodexStreamRenderer } from './codex-stream'
import { childSpend, readCodexRunFacts } from './codex-session'
import { addUsage, ownUsage, ZERO_USAGE } from './usage'
import { obj, str, type Json } from './json'
import { connect, RpcError } from './rpc'
import { priceUsd } from '../prices'
import type { TokenUsage, ContextWindow } from '../types'

const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(obj) : []

/** Keep saved exec plans and user flags, but use a persistent server for supported shapes. */
export function createCodexConnection(argv: string[]): { argv: string[]; client: RunClient } | undefined {
  const execAt = argv.indexOf('exec')
  if (execAt < 1) return undefined
  const server = [argv[0]!, 'app-server']
  const options: Options = { images: [] }
  const roots: string[] = []
  for (let i = 1; i < argv.length; i++) {
    if (i === execAt) continue
    const arg = argv[i]!
    const [flag, inline] = arg.split(/=(.*)/s)
    const value = () => inline ?? argv[++i]
    if (['--json', '--experimental-json', '--skip-git-repo-check'].includes(arg)) continue
    if (['-c', '--config', '--enable', '--disable'].includes(flag!)) {
      const v = value()
      if (!v) return undefined
      server.push(flag!, v)
    } else if (['-m', '--model', '-s', '--sandbox'].includes(flag!)) {
      const v = value()
      if (!v) return undefined
      server.push('-c', `${flag === '-m' || flag === '--model' ? 'model' : 'sandbox_mode'}=${JSON.stringify(v)}`)
    } else if (arg === '--dangerously-bypass-approvals-and-sandbox') {
      server.push('-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"')
    } else if (arg === '--full-auto') {
      server.push('-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"')
    } else if (flag === '--add-dir') {
      const v = value()
      if (!v) return undefined
      roots.push(v)
    } else if (flag === '-C' || flag === '--cd') {
      options.cwd = value()
      if (!options.cwd) return undefined
    } else if (flag === '-i' || flag === '--image') {
      const v = value()
      if (!v) return undefined
      options.images.push(v)
    } else if (arg === 'resume' || arg === 'fork') {
      options.mode = arg
      options.threadId = argv[++i]
      if (!options.threadId || options.threadId.startsWith('-')) return undefined
    } else {
      // A custom exec mode or flag keeps its exact command and existing parser.
      return undefined
    }
  }
  if (roots.length) server.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`)
  const proxy = process.env.WILDCRANE_CODEX_PROXY
  return { argv: proxy && process.env.WILDCRANE_CODEX_SERVER ? [process.execPath, proxy, ...server] : server, client: createCodexClient(options) }
}

interface Options {
  mode?: 'resume' | 'fork'
  threadId?: string
  cwd?: string
  images: string[]
}

/** Codex app-server v2, checked against the CLI's generated protocol. */
export function createCodexClient(options: Options = { images: [] }): RunClient {
  let background = 0
  return {
    structured: true,
    managedProcess: true,
    background: () => background,
    turn: (io) => run(io, options, count => { background = count }),
  }
}

async function run(io: ClientTurn, options: Options, count: (value: number) => void): Promise<TurnEnd> {
  const since = Date.now()
  const renderer = createCodexStreamRenderer()
  const preparingUntil = Math.min(io.prepareUntil ?? Infinity, Date.now() + CONVERSATION_MS.prepare)
  const phase = (phase: import('../../shared/conversation').ConversationPhase) => io.event?.({ kind: 'phase', data: { phase, at: new Date().toISOString() } })
  let submitted = false
  let started = false
  let contentAt = 0
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  const began = () => { if (!submitted || started || ended) return; started = true; clearTimeout(startupTimer); phase('started') }
  const work = codexWork()
  const children = work.children
  const execution = randomUUID()
  let host: Json = {}
  let cleanup: Cleanup = { status: 'confirmed', execution, kept: [] }
  let settlement: { work: ManagedWork[]; polled: Set<string>; messages: { raw: Json; completed: boolean }[] } | undefined
  let replySnapshots = new Map<string, string>()
  const visible = new Set<string>()
  const retained = new Map<string, string>()
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  const presented = new Map<string, string>()
  const offered = new Map<string, string>()
  const snapshot = (w: ManagedWork) => JSON.stringify([w.threadId, w.processId, w.status, w.exitCode, w.result])
  const childEvents = new Map<string, string>()
  const seenItems = new Set<string>()
  const completedTurns = new Set<string>()
  const historicalTurns = new Set<string>()
  let currentTurn = ''
  let threadId = ''
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let ended = false
  let checking = false
  let context: ContextWindow | undefined
  let total: TokenUsage | undefined
  let baseline: TokenUsage | undefined
  let model: string | undefined
  let provider: string | undefined
  let resolve!: (end: TurnEnd) => void
  const done = new Promise<TurnEnd>(r => { resolve = r })
  const emit = (type: string, extra: Json = {}) => {
    io.log(renderer.push(JSON.stringify({ type, ...extra }) + '\n'))
    for (const event of renderer.events?.() ?? []) io.event?.(event)
  }
  const end = (error?: string, classified?: ExecutionFailure) => {
    if (ended) return
    ended = true
    clearTimeout(timer)
    clearTimeout(startupTimer)
    clearTimeout(settleTimer)
    io.signal?.removeEventListener('abort', cancelled)
    count(0)
    io.stdout.off('close', closed)
    io.stdin.off('error', inputFailed)
    if (settlement) flushMessages(work.work().some(w => !w.intentionalStop && !['running', 'unknown'].includes(w.status) && presented.get(w.id) !== snapshot(w)))
    cleanup.items = work.work().map(({ id, threadId, processId, status, disposition }) => ({ id, threadId, processId, status, disposition }))
    io.log(renderer.flush())
    const usage = ownUsage(total, baseline)
    const child = childSpend(children, since)
    const cost = priceUsd(provider, model, usage)
    const combinedUsage = usage && child.usage ? addUsage(usage, child.usage) : usage ?? child.usage
    const costUsd = cost === undefined ? child.costUsd : cost + (child.costUsd ?? 0)
    const failure = error || (cleanup.status === 'unconfirmed' ? cleanup.detail : undefined) || work.work().filter(w => !w.intentionalStop && ['failed', 'interrupted'].includes(w.status)).map(w => w.result || `Background work ${w.id} ${w.status}.`).join('\n') || undefined
    if (failure) io.event?.({ kind: 'error', data: { text: failure } })
    resolve({ ok: !failure, error: failure, failure: failure ? classified ?? { code: 'execution_failed', level: 3, reason: failure } : undefined, cleanup, result: renderer.result(), replyParts: renderer.replyParts?.(), usage: combinedUsage, context, costUsd, costIncomplete: child.costIncomplete || (cost === undefined && child.costUsd !== undefined) || undefined })
  }
  const closed = () => {
    const reason = 'Codex connection closed before all work and results finished.'
    if (work.work().some(w => ['running', 'unknown'].includes(w.status))) note('Connection lost; managed cleanup is unconfirmed.')
    end(reason, { code: 'connection_lost', level: 2, reason })
  }
  const inputFailed = (e: Error) => {
    if (work.work().some(w => ['running', 'unknown'].includes(w.status))) note('Connection input failed; managed cleanup is unconfirmed.')
    end(e.message, executionFailure(e))
  }
  io.stdout.once('close', closed)
  io.stdin.once('error', inputFailed)
  const note = (detail: string) => {
    cleanup = { ...cleanup, status: 'unconfirmed', detail }
    io.log(`[Codex cleanup] ${detail}\n`)
    io.event?.({ kind: 'log', data: { text: `[Codex cleanup] ${detail}` } })
  }
  const cancelled = () => { work.freeze(); note('Execution stopped; no further cleanup turn was submitted.'); end('Codex execution stopped.') }
  io.signal?.addEventListener('abort', cancelled, { once: true })
  const childUpdates = () => {
    for (const w of work.entries.values()) {
      if (w.kind !== 'agent' || childEvents.get(w.id) === w.status) continue
      if (!childEvents.has(w.id)) io.event?.({ kind: 'tool_call', data: { toolCallId: w.id, title: 'Agent', kind: 'other', status: 'in_progress', subagent: true } })
      if (w.status !== 'running') io.event?.({ kind: 'tool_call_update', data: { toolCallId: w.id, status: w.status === 'completed' ? 'completed' : 'failed', result: w.result } })
      childEvents.set(w.id, w.status)
    }
  }
  const flushMessages = (report: boolean) => {
    if (!settlement) return
    const messages = settlement.messages.splice(0)
    if (report) for (const { raw, completed } of messages) emit(completed ? 'item.completed' : 'item.started', { item: { ...raw, type: 'agent_message' } })
  }
  const item = (raw: Json, completed: boolean, proof = true) => {
    if (ended) return
    const id = str(raw.id)
    if (['collabAgentToolCall', 'subAgentActivity'].includes(str(raw.type))) { if (proof) began(); childUpdates(); return }
    const key = `${id}:${completed}`
    if (seenItems.has(key)) return
    seenItems.add(key)
    if (raw.type === 'agentMessage' && completed && raw.phase !== 'commentary' && str(raw.text).trim()) {
      const eligible = new Set([...(settlement?.work.map(w => w.id) ?? []), ...visible])
      replySnapshots = new Map([...work.entries.values()].filter(w => eligible.has(w.id) && !['running', 'unknown'].includes(w.status)).map(w => [w.id, snapshot(w)]))
    }
    if (settlement && raw.type === 'agentMessage') {
      if (proof) began()
      settlement.messages.push({ raw, completed })
      return
    }
    const types: Record<string, string> = { agentMessage: 'agent_message', commandExecution: 'command_execution', fileChange: 'file_change', mcpToolCall: 'mcp_tool_call', webSearch: 'web_search', imageGeneration: 'image_generation' }
    const type = types[str(raw.type)]
    if (!type) return
    if (proof) began()
    emit(completed ? 'item.completed' : 'item.started', { item: {
      ...raw, type, ...(raw.type === 'imageGeneration' ? { path: raw.savedPath ?? raw.path } : {}),
      ...(raw.type === 'fileChange' ? { changes: list(raw.changes).map(c => ({ ...c, kind: str(obj(c.kind).type) || c.kind })) } : {}),
      aggregated_output: raw.aggregatedOutput, exit_code: raw.exitCode,
      status: raw.status === 'inProgress' ? 'in_progress' : raw.status,
    } })
  }
  const start = async (text: string, images: string[] = []) => {
    if (ended || io.signal?.aborted) return
    active = true
    submitted = true
    currentTurn = ''
    replySnapshots.clear()
    visible.clear()
    started = false
    phase('submitted')
    startupTimer = setTimeout(() => { if (!started) io.event?.({ kind: 'log', data: { text: '[conversation] start_unconfirmed' } }) }, CONVERSATION_MS.start)
    await bounded(rpc.call('turn/start', { threadId, input: [{ type: 'text', text }, ...images.map(path => ({ type: 'localImage', path }))] }), CONVERSATION_MS.start, 'Codex turn/start timed out; submission outcome is unknown.').catch(error => { if (!started) throw error })
  }
  const schedule = () => {
    if (ended || timer) return
    timer = setTimeout(() => { timer = undefined; void check() }, 1000)
  }
  const refresh = async (until: number) => {
    let expired = false
    try { await bounded(work.refresh(rpc, () => !ended && !expired), Math.max(0, until - Date.now()), 'Codex background verification timed out.') }
    finally { expired = true }
    childUpdates()
  }
  const finishManaged = async (until: number) => {
    if (ended) return
    const kept = work.work().filter(w => w.disposition === 'keep' && w.status === 'running')
    cleanup.kept = kept.map(w => w.id)
    if (host.instance) {
      try {
        const answer = await bounded(rpc.call('wildcrane/settled', { threadId, execution, instance: host.instance,
          lease: host.lease, confirmed: cleanup.status === 'confirmed',
          kept: kept.map(w => ({ threadId: w.threadId, itemId: w.itemId, processId: w.processId })),
        }), Math.max(0, until - Date.now()), 'Codex host did not confirm retention and release.')
        if (answer.confirmed !== true || answer.instance !== host.instance || answer.lease !== host.lease) throw Error('Codex host returned an invalid retention acknowledgement.')
      } catch (e) { cleanup.kept = []; note(e instanceof Error ? e.message : String(e)) }
    } else if (kept.length) { cleanup.kept = []; note('This connection cannot retain services after its exclusive backend closes.') }
    end()
  }
  const armCleanup = () => {
    const pending = settlement
    if (!pending || ended) return
    const necessary = pending.work.some(w => work.entries.get(w.id)?.status === 'running' && (w.kind === 'agent' || pending.polled.has(w.id)))
    if (necessary) { clearTimeout(settleTimer); settleTimer = undefined; return }
    if (settleTimer) return
    settleTimer = setTimeout(() => {
      if (ended) return
      note('Codex cleanup exceeded 60 seconds; operations remain unconfirmed.')
      if (currentTurn) void rpc.call('turn/interrupt', { threadId, turnId: currentTurn }).catch(() => {})
      end()
    }, CODEX_SETTLE_MS.turn)
  }
  const check = async () => {
    if (ended || checking || active) return
    checking = true
    try {
      const verifyUntil = Date.now() + CODEX_SETTLE_MS.verify
      await refresh(verifyUntil)
      if (ended) return
      if (settlement) {
        clearTimeout(settleTimer)
        settleTimer = undefined
        const pending = settlement
        for (const before of pending.work) {
          const current = work.entries.get(before.id)!
          if (current.threadId !== before.threadId || current.processId !== before.processId) throw Error('Codex background ownership changed during cleanup.')
          if (current.status === 'running') {
            if (current.kind === 'terminal' && current.processId && retained.get(current.id) === current.processId && host.instance) current.disposition = 'keep'
            else if (current.kind === 'agent' || pending.polled.has(current.id)) current.disposition = 'await'
            else throw Error(`Background work ${current.id} is still running; neither a necessary wait nor service retention could be verified.`)
          } else if (current.status === 'unknown') throw Error(`Background work ${current.id} disappeared without a verified result.`)
          else {
            current.disposition = current.intentionalStop ? 'stopped' : 'collected'
            if (!current.intentionalStop && replySnapshots.get(current.id) !== snapshot(current)) throw Error(`Codex did not deliver the new result for ${current.id} in a final reply.`)
          }
        }
        const report = work.work().some(w => !w.intentionalStop && !['running', 'unknown'].includes(w.status) && replySnapshots.get(w.id) === snapshot(w) && presented.get(w.id) !== snapshot(w))
        flushMessages(report)
        if (report) for (const [id, value] of replySnapshots) presented.set(id, value)
        settlement = undefined
      }
      const outstanding = work.work().filter(w => offered.get(w.id) !== snapshot(w) && presented.get(w.id) !== snapshot(w) && w.disposition !== 'keep' && !(w.intentionalStop && !['running', 'unknown'].includes(w.status)))
      if (outstanding.length) {
        const entries = batch(outstanding).map(w => ({ ...w }))
        for (const entry of entries) offered.set(entry.id, snapshot(entry))
        settlement = { work: entries, polled: new Set(), messages: [] }
        armCleanup()
        await start(settlementPrompt(entries, execution, !!host.instance))
        return
      }
      const awaited = work.work().filter(w => w.status === 'running' && w.disposition !== 'keep')
      if (awaited.length) { count(awaited.length); schedule(); return }
      count(0)
      await finishManaged(Date.now() + CODEX_SETTLE_MS.verify)
    } catch (e) {
      note(e instanceof Error ? e.message : String(e))
      end(cleanup.detail)
    } finally { checking = false; if (!ended && !active) schedule() }
  }
  const rpc = connect(io.stdout, io.stdin, msg => {
    if (ended) return
    if (msg.id !== undefined) {
      // Never silently grant an approval the user's command did not grant.
      rpc.refuse(msg.id, 'WildCrane cannot answer interactive requests in an unattended run.')
      end(`Codex requested interaction: ${msg.method}`)
      return
    }
    const p = obj(msg.params)
    const source = str(p.threadId)
    if (!work.own(source)) return
    if (msg.method === 'item/commandExecution/terminalInteraction') {
      for (const w of work.entries.values()) if (w.kind === 'terminal' && w.threadId === source && w.processId === p.processId && w.status === 'running') {
        if (str(p.stdin).includes('\u0003')) w.intentionalStop = true
        else if (settlement && p.stdin === '') { settlement.polled.add(w.id); armCleanup() }
      }
    }
    if (msg.method === 'item/started' || msg.method === 'item/completed') {
      const raw = obj(p.item)
      work.observe(source, raw)
      if (source === threadId && active) {
        if (raw.type === 'commandExecution') visible.add(`terminal:${source}:${str(raw.id)}`)
        if (raw.type === 'collabAgentToolCall') for (const id of Object.keys(obj(raw.agentsStates))) visible.add(`agent:${id}`)
      }
      armCleanup()
      if (source === threadId && obj(p.item).type !== 'agentMessage') item(obj(p.item), msg.method === 'item/completed', false)
    }
    if (source !== threadId) {
      if (msg.method === 'turn/completed') { work.observeTurn(source, obj(p.turn)); armCleanup() }
      childUpdates(); return
    }
    if (submitted && /\/delta$/.test(msg.method ?? '') && str(p.delta)) io.activity?.()
    const turnId = str(p.turnId) || str(obj(p.turn).id)
    if (historicalTurns.has(turnId) || currentTurn && turnId && currentTurn !== turnId) return
    if (msg.method === 'turn/started') { if (!submitted || completedTurns.has(turnId)) return; currentTurn = turnId; active = true; began(); return }
    if (submitted && msg.method === 'item/agentMessage/delta' && Date.now() - contentAt >= 1000) {
      began(); contentAt = Date.now(); io.event?.({ kind: 'phase', data: { phase: 'started', at: new Date().toISOString(), contentAt: new Date(contentAt).toISOString() } })
    }
    if (msg.method === 'item/started' || msg.method === 'item/completed') item(obj(p.item), msg.method === 'item/completed', !completedTurns.has(turnId))
    if (msg.method === 'thread/tokenUsage/updated') {
      if (!submitted) return
      const token = obj(p.tokenUsage)
      const counts = obj(token.total)
      const input = Number(counts.inputTokens) || 0
      const read = Number(counts.cachedInputTokens) || 0
      const write = Number(counts.cacheWriteInputTokens) || 0
      total = { input: Math.max(0, input - read - write), cacheRead: read, cacheCreation: write, output: Number(counts.outputTokens) || 0 }
      const last = obj(token.last)
      if (!baseline && Object.keys(last).length) {
        const cached = Number(last.cachedInputTokens) || 0
        const written = Number(last.cacheWriteInputTokens) || 0
        baseline = ownUsage(total, { input: Math.max(0, (Number(last.inputTokens) || 0) - cached - written), cacheRead: cached, cacheCreation: written, output: Number(last.outputTokens) || 0 })
      }
      context = { used: (Number(last.inputTokens) || 0) + (Number(last.outputTokens) || 0), ...(Number(token.modelContextWindow) > 0 ? { limit: Number(token.modelContextWindow) } : {}) }
      io.gotContext?.(context)
    }
    if (msg.method === 'error' && p.willRetry !== true) {
      const failure = codexFailure(p.error, 'Codex failed.')
      end(failure.reason, failure)
    }
    if (msg.method === 'turn/completed') {
      const turn = obj(p.turn)
      const id = str(turn.id)
      if (completedTurns.has(id)) return
      completedTurns.add(id)
      for (const raw of list(turn.items)) { work.observe(threadId, raw); item(raw, true) }
      if (turn.status !== 'completed') {
        const reason = str(obj(turn.error).message) || `Codex turn ${str(turn.status)}.`
        const failure = turn.status === 'failed' ? codexFailure(turn.error, reason) : { code: 'turn_stopped', level: 3 as const, reason }
        end(reason, failure)
        return
      }
      active = false
      clearTimeout(settleTimer)
      settleTimer = undefined
      work.freeze()
      if (!settlement) for (const [id, value] of replySnapshots) presented.set(id, value)
      count(work.work().filter(w => w.status === 'running' && w.disposition !== 'keep').length)
      void check()
    }
  })
  try {
    if (io.signal?.aborted) { cancelled(); return done }
    phase('preparing')
    const initialized = await bounded(rpc.call('initialize', { clientInfo: { name: 'wildcrane', version: '1' }, capabilities: { experimentalApi: true } }), preparingUntil - Date.now(), 'Codex initialize timed out.')
    host = obj(initialized.wildcrane)
    if (host.instance) cleanup.instance = str(host.instance)
    phase('initialized')
    rpc.notify('initialized')
    const mode = options.mode ?? (io.resumeId ? 'resume' : undefined)
    const response = await bounded(rpc.call(`thread/${mode ?? 'start'}`, { cwd: options.cwd ?? io.cwd, ...(mode ? { threadId: options.threadId ?? io.resumeId } : {}) }), preparingUntil - Date.now(), `Codex thread/${mode ?? 'start'} timed out.`)
    const thread = obj(response.thread)
    for (const turn of list(thread.turns)) historicalTurns.add(str(turn.id))
    threadId = str(thread.id)
    if (!threadId) throw Error('Codex did not return a thread id.')
    work.root(threadId, list(response.retainedThreads).map(t => str(t.id)))
    for (const terminal of list(response.retainedTerminals)) retained.set(`terminal:${str(terminal.threadId)}:${str(terminal.itemId)}`, str(terminal.processId))
    provider = str(thread.modelProvider) || undefined
    model = str(response.model) || str(thread.model) || undefined
    if (model) io.gotModel(model)
    io.gotResumeId(threadId)
    baseline = readCodexRunFacts(threadId)?.turns?.at(-1)?.total
      ?? (!options.threadId && !io.resumeId ? ZERO_USAGE : undefined)
    emit('thread.started', { thread_id: threadId })
    if (Date.now() >= preparingUntil) throw Error('Codex preparation timed out.')
    phase('ready')
    await start(io.prompt, options.images)
  } catch (e) {
    const failure = e instanceof RpcError ? codexFailure(e.data, e.message) : executionFailure(e)
    end(failure.reason, failure)
  }
  return done
}
