import type { AgentReview, TaskReview } from '../shared/review-plan'
import { reviewFingerprint } from './runtime-context'

// The one variable a run the board started puts on the agent it spawns.
//
// It is here, on its own, because two very different parts of the board ask the same
// question of it: the commands, which print a flow instead of starting a second run
// (agent/flow.ts), and the delivery lock, which lets a delivery's own run through the
// hold it puts on the card (agent/deliveries.ts).

/** The variable a run the board started puts on the agent it spawns, holding that run's id.
 *
 *  It is the one case where the mode is not the caller's to pick: an agent working inside a
 *  run that asks for a board action gets the flow printed, so a run can never spawn a copy
 *  of itself. Anywhere else, guessing from the environment would take away the background
 *  run a user deliberately asked for. */
export const RUN_ENV = 'KANBAN_RUN'

/** Set by the Runner beside `--session` (#627): that session's last recorded cost total. */
export const SESSION_COST_ENV = 'AI4KANBAN_SESSION_COST'

/** The run this process is working inside, when the board started it — otherwise null. */
export function insideRun(): string | null {
  const id = process.env[RUN_ENV]
  return id && id.trim() ? id.trim() : null
}

/** Put the run's id into the environment its agent receives. */
export function runEnv(env: NodeJS.ProcessEnv, value: string): NodeJS.ProcessEnv {
  return { ...env, [RUN_ENV]: value }
}

export const DELIVERY_PHASE_ENV = 'AI4KANBAN_DELIVERY_PHASE'
export const DELIVERY_ID_ENV = 'AI4KANBAN_DELIVERY_ID'
export const deliveryPhase = () => process.env[DELIVERY_PHASE_ENV]

export const TASK_REQUEST_ENV = 'AI4KANBAN_TASK_REQUEST'
export const SAVED_PREVIEW_FILE_ENV = 'AI4KANBAN_SAVED_PREVIEW_FILE'
export const LAND_IMPLEMENT_RUN_ENV = 'AI4KANBAN_LAND_IMPLEMENT_RUN'
export const REVIEW_FINGERPRINT_ENV = 'AI4KANBAN_REVIEW_FINGERPRINT'

export function taskReviewContext() {
  const { AI4KANBAN_TASK_REVIEW: review, AI4KANBAN_REVIEW_STAGES: assigned } = process.env
  if (!review) return undefined
  const state: TaskReview | AgentReview = JSON.parse(review)
  return {
    review: state,
    assigned: assigned ? JSON.parse(assigned) as string[] : undefined,
    fingerprint: process.env[REVIEW_FINGERPRINT_ENV] ?? ('revision' in state ? reviewFingerprint(state) : undefined),
  }
}

/** The variable a chat turn or an agent test puts on its agent, holding a one-off id: they
 *  have no run id, and it is how a stop finds the commands that agent started (#1302). */
export const STOP_ENV = 'KANBAN_STOP_ID'

/** The variable each CLI puts its own session id in for the commands it runs (#1222). The
 *  board drops them from every agent it spawns, so one never reads a session it inherited. */
export const SESSION_VARS: Record<string, string> = {
  'claude-code': 'CLAUDE_CODE_SESSION_ID',
  codex: 'CODEX_THREAD_ID',
}
