// Refinements explicitly requested by a finished task session.
import { refinementRequest } from './refine'
import type { AgentRequest, RefineAsk } from './types'

export function refineRunsAfter(asks: RefineAsk[]): AgentRequest[] {
  return asks.flatMap((ask) => {
    const next = refinementRequest({
      action: 'refine',
      id: ask.cardId,
      notes: ask.notes,
    })
    return 'error' in next ? [] : [next]
  })
}
