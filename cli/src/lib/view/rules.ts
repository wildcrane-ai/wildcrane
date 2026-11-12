// The board's judgments about a card, as plain functions over what a reader already has.
//
// Nothing here touches a file or a process, and it imports only its sibling types — which
// is what lets it be copied into the board UI (`scripts/sync-format.mjs` →
// `kanban-ui/lib/format/view/rules.ts`) and run in a browser. A card page decides whether
// to offer Refine, and the refine that follows a run decides which cards it is worth
// starting on, from this one set of rules rather than two that agree until they don't.

import type { Card, CardCreation, OptionsQuestion, Question } from './types'

// ---- a card that is not finished being created -----------------------------

/** Unfinished cards permit explicit discard; live creation permits no removal. */
export function creationRefusal(id: number, creation: CardCreation | undefined | null, what: string, discard = false): string | null {
  if (!creation || (creation.state === 'unfinished' && discard)) return null
  const run = creation.runId.slice(0, 8)
  return creation.state === 'creating'
    ? `#${id} is still being created by run ${run} — \`${what}\` is refused until that run finishes.`
    : `#${id} was never finished being created: run ${run} stopped short. \`${what}\` is refused until ` +
      'that run is picked back up from the board and finishes. Use reject --discard to discard it instead.'
}

// ---- questions -------------------------------------------------------------

/** True when this question carries choices to tick rather than a box to type in. */
export function hasOptions(q: Question): q is OptionsQuestion {
  return Array.isArray(q.options) && q.options.length > 0
}

// ---- a card that finishes in planning (#1057) -------------------------------
//
// A product video, slide deck (#1075), carousel post (#1117) or blog post (#1126) is made while
// the card is planned: the user approves each stage (#1790, #2154), and approving the last one
// archives the card. Nothing is built.

/** The finished files a card finishing in planning delivers: a video, a PowerPoint deck or an
 *  article. */
export const PLAN_DELIVERABLE = /\.(mp4|webm|mov|m4v|pptx|md|mdx)$/i

/** A carousel's rendered pages, one storyboard per ratio: `pages-3x4.json`. */
const PAGES_STORYBOARD = /(^|\/)pages-[^/]*\.json$/i

/** What a card finishing in planning still lacks before it can be archived, or null when it
 *  is done: nothing left to answer, a deliverable in its body, a ticked todo recording where
 *  it went or the command that rebuilds it, and every todo ticked. */
export function planDeliveryGap(card: Pick<Card, 'questions' | 'todos' | 'body'>): 'questions' | 'deliverable' | 'command' | 'todos' | null {
  if (card.questions.length > 0) return 'questions'
  if (!planDeliverables(card.body).length) return 'deliverable'
  if (!/^[ \t]*[-*]\s+\[[xX]\].*`[^`]+`/m.test(card.body)) return 'command'
  const { total, done } = card.todos
  return total > 0 && done === total ? null : 'todos'
}

/** The `src` of every deliverable in a card's body: a finished file's `<Asset>`, or a
 *  `<Storyboard>` of carousel pages. */
export const planDeliverables = (body: string): string[] => [
  ...[...body.matchAll(/<Asset\s[^>]*src="([^"]+)"/gi)].map((m) => m[1]!).filter((src) => PLAN_DELIVERABLE.test(src)),
  ...[...body.matchAll(/<Storyboard\s[^>]*src="([^"]+)"/gi)].map((m) => m[1]!).filter((src) => PAGES_STORYBOARD.test(src)),
]

/** The stage whose previews wait on the user's Approve (#1790, #2154), or null: a stage before
 *  the last, planned (`ready`), with nothing left to answer. A run in flight is the caller's to
 *  rule out. */
export function awaitingApproval(card: Pick<Card, 'stages' | 'stage' | 'questions' | 'status'>): number | null {
  const { stages, stage } = card
  if (!stages || !stage || stage >= stages || card.status !== 'ready') return null
  return card.questions.length ? null : stage
}

/** A card finishing in planning with more to do before it is archived. */
const planUnfinished = (card: Card): boolean => card.deliversIn === 'plan' && planDeliveryGap(card) !== null

// ---- pick order ------------------------------------------------------------
//
// Which card to start next. `ready` cards lead (vetted, plan concrete), `implementing`
// follows (already in flight), raw `todo` last; then priority, then id. Unranked
// — an empty or unknown value — sorts after everything ranked.

const LEVEL_RANK: Record<string, number> = { high: 0, med: 1, low: 2 }

const rank = (table: Record<string, number>, value: string): number =>
  table[value] ?? Object.keys(table).length

/** Highest priority first, then id — the order the board takes cards in when it
 *  starts them itself. Every candidate is
 *  `todo`, so status doesn't enter this one. */
export function byDispatchOrder(a: Card, b: Card): number {
  return (
    rank(LEVEL_RANK, a.priority) - rank(LEVEL_RANK, b.priority) ||
    a.id - b.id
  )
}

// ---- would a refine move this card? ----------------------------------------

// Explicit refinement also checks an existing split. Questions and approvals still wait
// for the user; blocked cards may be refined explicitly but are not followed automatically.
export function canRefine(card: Card): boolean {
  if (awaitingApproval(card)) return false
  const unfinished = !card.isGroup && planUnfinished(card)
  if (card.status !== 'todo' && !unfinished) return false
  const { total, done } = card.todos
  if (total > 0 && done === total && !unfinished) return false
  if (card.questions.length > 0 && card.questions.every(hasOptions)) return false
  return true
}

// ---- would an implement move this card? ------------------------------------

/**
 * True when building this card is a move that fits it.
 *
 * A group root is built by finishing its subtasks, so there is nothing on the root itself to
 * do. And a card whose every box is ticked is finished: what it is waiting for is an
 * archive, not another build.
 *
 * A card whose studio lands nothing is never built (#1057): approving it archives it.
 *
 * Being blocked is not part of this, the same as with `canRefine`: it is a judgment about
 * when to spend a turn, not a fact about the card.
 */
export function canImplement(card: Card): boolean {
  if (card.isGroup) return false
  if (card.deliversIn === 'plan') return false
  const { total, done } = card.todos
  return !(total > 0 && done === total)
}
