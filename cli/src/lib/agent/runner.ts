import { flowByAction } from './flows'
import { roleForFlow } from './roles'
import { cardStudioId } from './studios'
import { deliveryFor } from './deliveries'
import { REFINE_ACTIONS } from './types'
import type { AgentAction } from './types'

/** What a run has to say about itself for its agent to be worked out. The same three fields
 *  `agent/rules.ts` reads to hand a run its rule, and read the same way. */
export interface RunAsk {
  action?: AgentAction
  /** The card this run is for, when it names one. Read only to find the card's studio —
   *  who leads a stage is the card's answer now, not the board's (#715). */
  id?: number
  /** The parent agent's name on a sub-run. */
  specAgent?: string
  /** Set on a pass a refine spawned, absent on a flow a user typed — the one thing that
   *  tells a refine's `resolve` pass from an `akb raw card resolve` of its own. */
  refineRound?: number
  /** The studio this run's card runs on (#715). Given by a caller that already knows it —
   *  a delivery hands its frozen one down — and read off the card otherwise. */
  studio?: string
  /** The delivery a review run belongs to, when it names one. */
  deliveryId?: string
}

/** The studio one run belongs to: the one it was handed, the one its card carries, or the
 *  one its delivery froze. A run on none of these has no studio. */
export const studioForRun = (ask: RunAsk): string | undefined =>
  ask.studio ??
  (typeof ask.id === 'number'
    ? cardStudioId(ask.id) || undefined
    : ask.deliveryId
      ? deliveryFor({ action: 'implement', deliveryId: ask.deliveryId })?.studio?.id
      : undefined)

/** The board role for this flow or the parent agent inherited by a sub-run. */
export function agentForRun(ask: RunAsk = {}): string | undefined {
  const { action, specAgent } = ask
  if (!action) return undefined
  if (action === 'implement') return undefined
  if (action === 'sub') return specAgent
  return roleForFlow(flowOf(ask, action))?.name
}

// The flow this run belongs to. A pass belongs to the flow that spawned it, never to a flow
// of its own name: `resolve` is both a pass of a refine and a command a user types, and only
// the round tells them apart. `clarify` is a pass either way, which is what
// `flowByAction` already says.
function flowOf(ask: RunAsk, action: AgentAction): string {
  if (ask.refineRound !== undefined && REFINE_ACTIONS.has(action)) return 'refine'
  // Flows outside the card command list, such as polish and channel, name themselves.
  return flowByAction(action)?.command ?? action
}
