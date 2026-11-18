// A single task review starts ordinary implementation.

import { findCard } from '../view/read'
import { readRuns } from './store'
import { holdsCard } from './types'
import type { AgentRequest, CommandRequest } from './types'

/** The run started by accepting the task review. */
export function approvalRequest(req: CommandRequest): AgentRequest | { error: string } {
  const id = req.id
  const card = id === undefined ? null : findCard(id)
  if (!card) return { error: `task #${id} does not exist` }
  if (card.questions.length) return { error: `#${card.id} has open questions — answer them before approving it.` }
  if (readRuns().some((r) => r.status === 'running' && r.cardId === card.id && holdsCard(r.action))) {
    return { error: `#${card.id} has a run in flight — approve once it ends.` }
  }
  const ask = { id: card.id, title: card.title, notes: req.notes }
  return { action: 'implement', ...ask }
}

/** Retired stage entry point. */
export function advancePhase(_id: number): { error: string } | null {
  return { error: 'Task review has one approval. Continue the approved delivery.' }
}
