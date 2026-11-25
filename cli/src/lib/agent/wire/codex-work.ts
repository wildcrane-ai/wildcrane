import { obj, str, type Json } from './json'
import { RpcError, type Rpc } from './rpc'
import { summary, type ManagedWork } from './codex-background'

const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(obj) : []
export const terminalKey = (thread: string, item: string) => `terminal:${thread}:${item}`

async function* terminals(rpc: Rpc, threadId: string, alive: () => boolean, verify = false) {
  let cursor: string | undefined
  const cursors = new Set<string>()
  do {
    if (!alive()) return
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw Error('Codex repeated a background terminal cursor.')
      cursors.add(cursor)
    }
    const page = await rpc.call('thread/backgroundTerminals/list', { threadId, ...(cursor === undefined ? {} : { cursor }) })
    if (!alive()) return
    if (verify && (!Array.isArray(page.data) || page.nextCursor != null && typeof page.nextCursor !== 'string')) {
      throw Error('Codex background terminal state is unconfirmed.')
    }
    for (const terminal of list(page.data)) {
      const itemId = str(terminal.itemId), processId = str(terminal.processId)
      if (!itemId || !processId) throw Error('Codex returned a background terminal without its complete handles.')
      yield { terminal, itemId, processId }
    }
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined
  } while (cursor !== undefined)
}

/** Only native lineage and the current connection can establish ownership. */
export function codexWork() {
  const children = new Set<string>()
  const entries = new Map<string, ManagedWork>()
  const background = new Set<string>()
  const seenCollab = new Set<string>()
  let root = ''
  const own = (threadId: string) => threadId === root || children.has(threadId)
  const agent = (threadId: string, raw: Json) => {
    const id = `agent:${threadId}`
    const previous = entries.get(id)
    const status = str(raw.status)
    if (['shutdown', 'notFound', 'not_found'].includes(status) && previous && previous.status !== 'running') return
    const state = ['pendingInit', 'running', 'pending_init'].includes(status) ? 'running'
      : status === 'completed' ? 'completed'
        : ['interrupted', 'shutdown'].includes(status) ? 'interrupted'
          : ['errored', 'notFound', 'not_found'].includes(status) ? 'failed' : undefined
    if (!state) return
    entries.set(id, { ...previous, id, threadId, kind: 'agent', status: state, result: summary(str(raw.message)) })
  }
  const observe = (threadId: string, raw: Json) => {
    if (!own(threadId)) return
    if (raw.type === 'subAgentActivity') {
      const child = str(raw.agentThreadId)
      if (raw.kind === 'started' && child && child !== root && !children.has(child)) {
        children.add(child)
        agent(child, { status: 'running' })
        entries.get(`agent:${child}`)!.agentPath = str(raw.agentPath)
      }
      return
    }
    if (raw.type === 'collabAgentToolCall') {
      const key = JSON.stringify([threadId, raw.id, raw.agentsStates])
      if (seenCollab.has(key)) return
      seenCollab.add(key)
      if (raw.tool === 'spawnAgent') {
        for (const id of Array.isArray(raw.receiverThreadIds) ? raw.receiverThreadIds : []) if (typeof id === 'string' && id !== root) {
          children.add(id)
          if (!entries.has(`agent:${id}`)) agent(id, { status: 'running' })
        }
      }
      for (const [id, state] of Object.entries(obj(raw.agentsStates))) if (children.has(id)) agent(id, obj(state))
    }
    if (raw.type !== 'commandExecution' || !str(raw.id)) return
    const id = terminalKey(threadId, str(raw.id))
    const known = entries.get(id)
    const processId = str(raw.processId) || known?.processId
    const previous = known?.processId === processId ? known : undefined
    if (previous?.disposition === 'stopped') return
    const running = raw.status === 'inProgress'
    if (running && previous?.exitCode !== undefined) return
    const exitCode = typeof raw.exitCode === 'number' ? raw.exitCode : previous?.exitCode
    entries.set(id, { ...previous, id, threadId, kind: 'terminal', itemId: str(raw.id),
      processId,
      command: summary(str(raw.command) || previous?.command || '', 600),
      status: running ? 'running' : exitCode !== undefined ? exitCode === 0 ? 'completed' : 'failed' : 'unknown',
      result: summary(str(raw.aggregatedOutput) || previous?.result || ''), exitCode,
    })
  }
  const observeTurn = (threadId: string, turn: Json) => {
    if (!children.has(threadId)) return
    const status = str(turn.status)
    if (!['completed', 'failed', 'interrupted'].includes(status)) return
    const message = list(turn.items).filter(i => i.type === 'agentMessage' && i.phase !== 'commentary').map(i => str(i.text)).join('\n\n')
    agent(threadId, { status: status === 'failed' ? 'errored' : status, message: str(obj(turn.error).message) || message })
  }
  const readThread = async (rpc: Rpc, threadId: string) => {
    let thread = obj((await rpc.call('thread/read', { threadId, includeTurns: false })).thread)
    let turns = list(thread.turns)
    if (thread.historyMode === 'paginated') {
      turns = list((await rpc.call('thread/turns/list', { threadId, sortDirection: 'desc', limit: 1, itemsView: 'full' })).data)
    } else if (!turns.length) {
      thread = obj((await rpc.call('thread/read', { threadId, includeTurns: true })).thread)
      turns = list(thread.turns).slice(-1)
    } else turns = turns.slice(-1)
    const turn = turns[0]
    for (const item of list(turn?.items)) observe(threadId, item)
    if (threadId !== root) {
      const status = str(turn?.status)
      if (obj(thread.status).type === 'systemError') agent(threadId, { status: 'errored', message: 'Codex subagent reported a system error.' })
      else if (obj(thread.status).type !== 'active' && ['completed', 'failed', 'interrupted'].includes(status)) {
        observeTurn(threadId, turn ?? {})
      }
    }
    return thread
  }
  return {
    children, entries, background, own, observe, observeTurn,
    root(id: string, retained: string[] = []) { root = id; for (const child of retained) if (child !== id) children.add(child) },
    freeze() { for (const [id, entry] of entries) if (entry.status === 'running') background.add(id) },
    work: () => [...entries.values()].filter(e => background.has(e.id)),
    async terminate(rpc: Rpc, entry: ManagedWork, alive: () => boolean) {
      const { id, threadId, itemId, processId } = entry
      const result = await rpc.call('thread/backgroundTerminals/terminate', { threadId, processId })
      if (!alive()) return
      if (result.terminated !== true) throw Error('Codex did not acknowledge terminating the background terminal.')
      for await (const terminal of terminals(rpc, threadId, alive, true)) {
        if (terminal.itemId === itemId || terminal.processId === processId) throw Error('The background terminal is still listed after termination.')
      }
      if (!alive()) return
      const current = entries.get(id)
      if (!current || current.processId !== processId) throw Error('Codex background ownership changed during termination.')
      current.status = 'interrupted'
      current.disposition = 'stopped'
    },
    async refresh(rpc: Rpc, alive: () => boolean) {
      for (const id of children) {
        if (!alive()) return
        await readThread(rpc, id)
      }
      for (const threadId of [root, ...children]) {
        if (!alive()) return
        const present = new Set<string>()
        try {
          for await (const { terminal, itemId, processId } of terminals(rpc, threadId, alive)) {
            if (!alive()) return
            const id = terminalKey(threadId, itemId)
            present.add(id)
            const known = entries.get(id)
            const previous = known?.processId === processId ? known : undefined
            entries.set(id, { ...previous, id, threadId, kind: 'terminal', itemId, processId,
              ...(typeof terminal.osPid === 'number' ? { osPid: terminal.osPid } : {}),
              command: summary(str(terminal.command) || previous?.command || '', 600), status: 'running', result: previous?.result ?? '',
            })
            background.add(id)
          }
        } catch (e) {
          if (!(e instanceof RpcError) || ![-32601, -32600].includes(e.code ?? 0) || !/method|unknown|unsupported/i.test(e.message)) throw e
          if ([...entries.values()].some(w => w.threadId === threadId && w.kind === 'terminal' && w.status === 'running')) throw Error('This Codex version cannot report unfinished background commands; cleanup is unconfirmed.')
          continue
        }
        if (!alive()) return
        const missing = [...entries.values()].filter(e => background.has(e.id) && e.threadId === threadId && e.kind === 'terminal' && e.status === 'running' && !present.has(e.id))
        if (missing.length) {
          await readThread(rpc, threadId)
          for (const entry of missing) if (entries.get(entry.id)?.status === 'running') entries.get(entry.id)!.status = 'unknown'
        }
      }
    },
  }
}
