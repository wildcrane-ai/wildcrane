import { insideRun } from './env'
import { flowNodes } from './stages'
import { readStore } from './store'
import type { RunRecord } from './types'

/** Project background work can attribute the items it creates. */
export function runAgent(): string | null {
  const sessionId = insideRun()
  const runs = sessionId ? readStore().runs : []
  const run = runs.find((r) => r.sessionId === sessionId)
  if (!run) return null
  if (run.action !== 'sub') return agentOf(run)
  const parent = runs.find((r) => r.sessionId === run.parentId)
  return parent ? agentOf(parent) : (run.specAgent ?? null)
}

function agentOf(run: RunRecord): string | null {
  return flowNodes().find((n) => n.flow === run.action)?.agent ?? null
}
