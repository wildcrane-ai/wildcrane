// The refinement state machine. Agent sessions decide what a card should say; this file
// decides which run comes next and when the loop stops.
//
// A run that ends can also leave OTHER cards worth refining — a build that writes a
// follow-up card, a create that writes several. Which ones those are is settled by
// `claimChanges` and nothing else, under one rule: a change belongs to exactly one run.
// Several runs are up at once on this board, and their windows overlap, so a run that
// merely diffed the board against its own start would inherit whatever its neighbours
// wrote — and refine cards their own loops were already handling.

import { createHash } from 'node:crypto'

import { allCards, findCard } from '../view/read'
import { byDispatchOrder, canRefine, planDeliveryGap } from '../view/rules'
import type { Card } from '../view/types'
import { reviewAllows, reviewAuthorization } from '../shared/review-plan'
import { activeDelivery } from './deliveries'
import { taskReviewContext } from './env'
import { startRun } from './start'
import { withStore } from './store'
import { holdsCard } from './types'
import type { AgentAction, AgentRequest, CommandRequest, RunReason, RunRecord } from './types'

export type RefinementStep = 'clarify' | 'done'

export type BoardMarks = Map<number, string>

const subtaskLinesToIds = (body: string): string => {
  const out: string[] = []
  let inSubtask = false
  for (const line of body.split('\n')) {
    const match = line.match(/^[ \t]*[-*]\s+\[[ xX]\]\s*(.*)$/)
    const ids = match ? match[1]!.match(/#\d+/g) : null
    if (ids) {
      out.push(`- [ ] ${ids.join(' ')}`)
      inSubtask = true
      continue
    }
    if (inSubtask && line.trim() && /^[ \t]/.test(line) && !/^[ \t]*[-*]\s/.test(line)) continue
    inSubtask = false
    out.push(line)
  }
  return out.join('\n')
}

// The line dividing a card's two halves (`akb guide writing`).
const MARKER = /^<!--\s*agent\s*-->$/

// The body as a sorted bag of lines, marker dropped: a repair that only moves sections
// between the halves reads as no change, so the loop spends no run on it. The cost is
// that reordering `## Todo` steps reads as no change too.
const asMoved = (body: string): string[] =>
  body
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !MARKER.test(line.trim()))
    .sort()

// Blockers are Cloud's to follow up; other edits change the shared claim hash.
const wroteOf = (card: Card): string =>
  createHash('sha1')
    .update(
      JSON.stringify([
        card.status,
        card.relPath,
        card.title,
        card.priority,
        card.related,
        card.questions.map((q) => [q.text, q.mode ?? '', q.options ?? [], q.recommend ?? []]),
        card.modules,
        asMoved(card.isGroup ? subtaskLinesToIds(card.body) : card.body),
      ]),
    )
    .digest('hex')

const currentCard = (cardId: number): Card | undefined => {
  try {
    return findCard(cardId) ?? undefined
  } catch {
    return undefined
  }
}

export function markBoard(): BoardMarks {
  try {
    return new Map(allCards().map((card) => [card.id, wroteOf(card)]))
  } catch {
    return new Map()
  }
}

/**
 * The cards this run is answerable for, and the only way that question is ever answered.
 *
 * A card qualifies when it changed while the run was up AND no earlier close has already
 * accounted for that change AND no other run is holding it. Claiming is what makes the
 * middle clause true: the mark each change was taken at goes into the shared record, so the
 * first close to see an edit takes it and every later one reads its own mark back. Without
 * that, two runs whose windows overlap both inherit each other's edits, and the second one
 * refines cards whose own loop had already finished with them.
 *
 * EVERY close calls this, whatever the run ended as — a change left unclaimed is a change
 * the next unrelated run to close would pick up. What it can't tell apart is a card nobody
 * ran on: an edit made by hand goes to whichever close sees it first. Cards made through
 * the CLI name their creating run explicitly.
 */
export function claimChanges(before: BoardMarks, sessionId: string): number[] {
  const now = markBoard()
  try {
    return withStore((store) => {
      // A card another run holds is that run's to account for when it closes.
      const held = new Set(
        store.runs
          .filter((r) => r.status === 'running' && r.sessionId !== sessionId && holdsCard(r.action))
          .flatMap((r) => [r.cardId, ...(r.createdCardIds ?? [])]),
      )
      const claimed: number[] = []
      // Rebuilt from the board rather than merged into, so a card that has been archived or
      // rejected takes its mark with it.
      const marks: Record<string, string> = {}
      const discarded = new Set(store.runs.flatMap((r) => r.discardedCards?.map((c) => c.id) ?? []))
      for (const [id, mark] of now) {
        if (discarded.has(id)) continue
        const seen = store.marks[String(id)]
        const mine = !held.has(id) && before.get(id) !== mark && seen !== mark
        if (mine) claimed.push(id)
        const kept = mine ? mark : seen
        if (kept) marks[String(id)] = kept
      }
      store.marks = marks
      return claimed
    })
  } catch {
    // An unreadable record. Claiming nothing costs a refine; claiming everything would
    // start the neighbours' work again, which is the mistake this exists to stop.
    return []
  }
}

export function refinementStep(card: Card): RefinementStep {
  if (!canRefine(card)) return 'done'
  return 'clarify'
}

export function refinementRequest(req: CommandRequest): AgentRequest | { error: string } {
  const card = req.id === undefined ? null : currentCard(req.id)
  if (!card) return { error: `task #${req.id} does not exist` }
  const context = taskReviewContext()
  const canStart = context
    ? reviewAllows(reviewAuthorization(context.review, context.assigned), 'refine') && !card.questions.some(q => q.options?.length)
    : refinementStep(card) === 'clarify'
  if (!canStart) {
    // Only the user's answers are in the way (#1366).
    const waiting = card.questions.length > 0 && canRefine({ ...card, questions: [] })
    return {
      error: waiting
        ? `#${card.id} is waiting for the user to answer its open questions, so there is nothing to refine yet — the board refines it on its own once they are answered.`
        : `a refine would not move #${card.id}`,
    }
  }
  return {
    action: 'clarify', id: card.id, title: card.title, notes: req.notes, refineRound: 1,
    ...(req.session ? { session: req.session } : {}),
    ...(req.carry ? { carry: req.carry } : {}),
  }
}

export async function startRefinement(
  req: CommandRequest,
): Promise<{ run: RunRecord; spawned: boolean } | { error: string }> {
  const next = refinementRequest(req)
  return 'error' in next ? next : await startRun(next)
}

/** What follows one planning pass (#1203). Planning is one session, so a coding card is done
 *  here either way. A card whose studio lands nothing (#1057) is the one exception: until its
 *  last stage's deliverable is made, the user's answer goes back to planning. */
export function refinementAfter(
  action: AgentAction,
  cardId: number,
  flowId?: string,
): AgentRequest | null {
  const card = currentCard(cardId)
  if (!card || card.isGroup || card.openBlockers.length > 0) return null
  if (action === 'resolve' && activeDelivery(cardId)) return null
  if (card.questions.length > 0 || action === 'clarify' || card.deliversIn !== 'plan') return null
  if (planDeliveryGap(card) === null) return null
  // A stage before the last waits on the user's Approve (#1790).
  return { action: 'clarify', id: card.id, title: card.title, refineRound: 1, ...(flowId ? { flowId } : {}) }
}

// Actions that follow only the cards they CREATED. Each of them just exercised its own
// judgment on the card it names — a refine pass, a build, a revise, a resolve —
// so a refine of a card one of them merely edited spends a run re-doing what has just
// closed. A card one of them split off is another matter: it is as rough as any other
// newborn card, and nothing else comes for it.
const FOLLOWS_CREATED = new Set<AgentAction>([
  'implement',
  'edit',
  'clarify',
  'resolve',
  'approve',
])

/** Cards this run left worth refining — its own claims and no one else's. `before` is the
 * board as the run found it, so a claim it doesn't name is a card the run created. A blocked
 * card is Cloud's to start once nothing blocks it, so dependency completion is not inferred
 * here. */
function refinesAfter(
  action: AgentAction,
  changed: readonly number[],
  before: BoardMarks,
): AgentRequest[] {
  let cards: Card[]
  try {
    cards = allCards()
  } catch {
    return []
  }
  const mine = new Set(FOLLOWS_CREATED.has(action) ? changed.filter((id) => !before.has(id)) : changed)
  return cards
    .filter((card) => mine.has(card.id))
    .filter((card) => {
      if (card.openBlockers.length > 0) return false
      if (refinementStep(card) !== 'done') return true
      return !before.has(card.id) && card.status === 'planned' && !/<Preview\b/i.test(card.body) && !card.questions.length
    })
    .sort(byDispatchOrder)
    .flatMap((card) => {
      const step = refinementStep(card)
      const nextAction = step === 'done' ? 'clarify' : step
      return [{ action: nextAction, id: card.id, title: card.title, refineRound: 1 }]
    })
}

// The loop this run belonged to has ended with its card still worth refining. Nothing else
// picks the card up, so the run itself is where the user is told — an ending nobody reports
// reads exactly like one that settled.
function stalledLine(cardId: number | null, next: AgentRequest | null): string | null {
  if (next !== null) return null
  const card = cardId === null ? null : currentCard(cardId)
  if (!card || card.isGroup || refinementStep(card) === 'done') return null
  return `#${card.id} still needs planning. Refine it again or finish the plan and set --status planned.`
}

export interface RefinementFollowUp {
  runs: AgentRequest[]
  stalled?: string
  stalledWhy?: RunReason[]
}

export function refinementRunsAfter(
  run: RunRecord,
  changed: readonly number[],
  before: BoardMarks,
): RefinementFollowUp {
  const next = run.cardId !== null && ['clarify', 'resolve', 'edit', 'approve'].includes(run.action)
    ? refinementAfter(run.action, run.cardId, run.flowId)
    : null
  const starts = run.cloudExecution && run.cardId !== null ? [] : refinesAfter(run.action, changed, before).filter(
    (req) => req.id !== run.cardId || run.refineRound === undefined,
  )
  const stalled = (run.refineRound !== undefined && stalledLine(run.cardId, next)) || undefined
  return {
    runs: next ? [...starts, next] : starts,
    stalled,
    ...(stalled ? { stalledWhy: [{ kind: 'refineStalled', args: { card: String(run.cardId) } }] } : {}),
  }
}
