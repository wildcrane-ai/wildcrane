export type Disposition = 'collected' | 'stopped' | 'await' | 'keep' | 'unconfirmed'
export interface ManagedWork {
  id: string
  threadId: string
  kind: 'terminal' | 'agent'
  agentPath?: string
  itemId?: string
  processId?: string
  osPid?: number
  command?: string
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown'
  result: string
  exitCode?: number
  intentionalStop?: boolean
  disposition?: Disposition
}
export interface Cleanup {
  status: 'confirmed' | 'unconfirmed'
  execution: string
  instance?: string
  kept: string[]
  idleStop?: { threadId: string; turnId: string }
  detail?: string
  items?: Pick<ManagedWork, 'id' | 'threadId' | 'processId' | 'status' | 'disposition'>[]
}

export const STOPPED_CLEANUP_DETAIL = 'Execution stopped; no further cleanup turn was submitted.'

export function itemTerminal(item: { status: string; disposition?: string }): boolean {
  return item.disposition !== 'unconfirmed'
    && item.status !== 'running'
    && item.status !== 'unknown'
    && (item.status !== 'interrupted' || item.disposition === 'stopped')
}

export function stoppedCleanupConfirmed(cleanup: { status: string; detail?: string; items?: readonly { status: string; disposition?: string }[] } | undefined): boolean {
  if (!cleanup) return false
  if (cleanup.status === 'confirmed') return !Array.isArray(cleanup.items) || cleanup.items.every(itemTerminal)
  return cleanup.status === 'unconfirmed'
    && cleanup.detail === STOPPED_CLEANUP_DETAIL
    && Array.isArray(cleanup.items)
    && cleanup.items.every(itemTerminal)
}

export function idleStopConfirmed(cleanup: Cleanup | undefined, session: string | undefined): boolean {
  return !!session && cleanup?.status === 'confirmed' && !!cleanup.instance
    && Array.isArray(cleanup.kept) && cleanup.kept.length === 0
    && cleanup.idleStop?.threadId === session && typeof cleanup.idleStop.turnId === 'string' && !!cleanup.idleStop.turnId
}
