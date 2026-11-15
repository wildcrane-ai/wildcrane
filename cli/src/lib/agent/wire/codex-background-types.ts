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
  detail?: string
  items?: Pick<ManagedWork, 'id' | 'threadId' | 'processId' | 'status' | 'disposition'>[]
}
