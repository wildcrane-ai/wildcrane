import { obj, str, type Json } from './json'
import { RpcError, type Rpc } from './rpc'
import { summary, type ManagedWork } from './codex-background'

const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(obj) : []
export const terminalKey = (thread: string, item: string) => `terminal:${thread}:${item}`

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
    const previous = entries.get(id)
    const running = raw.status === 'inProgress'
    if (running && previous?.exitCode !== undefined) return
    const exitCode = typeof raw.exitCode === 'number' ? raw.exitCode : previous?.exitCode
    entries.set(id, { ...previous, id, threadId, kind: 'terminal', itemId: str(raw.id),
      processId: str(raw.processId) || previous?.processId,
      command: summary(str(raw.command) || previous?.command || '', 600),
      status: running ? 'running' : exitCode !== undefined ? exitCode === 0 ? 'completed' : 'failed' : 'unknown',
      result: summary(str(raw.aggregatedOutput) || previous?.result || ''), exitCode,
    })
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
        const message = list(turn?.items).filter(i => i.type === 'agentMessage').map(i => str(i.text)).join('\n\n')
        agent(threadId, { status: status === 'failed' ? 'errored' : status, message: str(obj(turn?.error).message) || message })
      }
    }
    return thread
  }
  return {
    children, entries, background, own, observe,
    root(id: string, retained: string[] = []) { root = id; for (const child of retained) if (child !== id) children.add(child) },
    freeze() { for (const [id, entry] of entries) if (entry.status === 'running') background.add(id) },
    work: () => [...entries.values()].filter(e => background.has(e.id)),
    async refresh(rpc: Rpc, alive: () => boolean) {
      for (const id of children) {
        if (!alive()) return
        await readThread(rpc, id)
      }
      for (const threadId of [root, ...children]) {
        if (!alive()) return
        const present = new Set<string>()
        let cursor: unknown = null
        const cursors = new Set<unknown>()
        try {
          do {
            if (!alive()) return
            if (cursors.has(cursor)) throw Error('Codex repeated a background terminal cursor.')
            cursors.add(cursor)
            const page = await rpc.call('thread/backgroundTerminals/list', { threadId, ...(cursor ? { cursor } : {}) })
            for (const terminal of list(page.data)) {
              const itemId = str(terminal.itemId), processId = str(terminal.processId)
              if (!itemId || !processId) throw Error('Codex returned a background terminal without its complete handles.')
              const id = terminalKey(threadId, itemId)
              present.add(id)
              const previous = entries.get(id)
              entries.set(id, { ...previous, id, threadId, kind: 'terminal', itemId, processId,
                ...(typeof terminal.osPid === 'number' ? { osPid: terminal.osPid } : {}),
                command: summary(str(terminal.command) || previous?.command || '', 600), status: 'running', result: previous?.result ?? '',
              })
              background.add(id)
            }
            cursor = page.nextCursor
          } while (cursor)
        } catch (e) {
          if (!(e instanceof RpcError) || ![-32601, -32600].includes(e.code ?? 0) || !/method|unknown|unsupported/i.test(e.message)) throw e
          if ([...entries.values()].some(w => w.threadId === threadId && w.kind === 'terminal' && w.status === 'running')) throw Error('This Codex version cannot report unfinished background commands; cleanup is unconfirmed.')
          continue
        }
        const missing = [...entries.values()].filter(e => background.has(e.id) && e.threadId === threadId && e.kind === 'terminal' && e.status === 'running' && !present.has(e.id))
        if (missing.length) {
          await readThread(rpc, threadId)
          for (const entry of missing) if (entries.get(entry.id)?.status === 'running') entries.get(entry.id)!.status = 'unknown'
        }
      }
    },
  }
}
