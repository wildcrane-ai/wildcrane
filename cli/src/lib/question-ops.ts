// The ops of `update-questions`, applied to a card's question list (#620). Pure, so the board
// command and Cloud's `PATCH /v1/tasks/{id}/questions` edit questions the same way. Each op's
// positions are 1-based against the list as it stands when that op runs.

import type { Question, QuestionDraft } from './types.ts'

// `--agent` claims the question for a spec agent; left off an `--update`, the question keeps the
// agent it had.
export interface QuestionOp {
  kind: 'append' | 'update' | 'drop' | 'clear'
  ns?: string
  n?: number
  draft?: QuestionDraft
  question?: Question
}

export class QuestionOpError extends Error {}

/** One or more 1-based question positions (`1` or `1,3`), checked against the list's length. */
export function questionPositions(raw: unknown, count: number, flag: string): number[] {
  const ns = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number)
  if (ns.length === 0 || ns.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new QuestionOpError(`--${flag} needs one or more 1-based question numbers (e.g. 1 or 1,3)`)
  }
  const over = ns.find((n) => n > count)
  if (over !== undefined) throw new QuestionOpError(`the card has ${count} open question(s) — there's no question ${over}`)
  return ns
}

export interface QuestionOpsResult {
  questions: Question[]
  changes: string[]
  /** Open questions an op closed: dropped or cleared. */
  closed: Question[]
}

/** `asker` claims appended questions no op names an agent for. */
export function applyQuestionOps(start: Question[], ops: QuestionOp[], asker?: string): QuestionOpsResult {
  let questions = [...start]
  const changes: string[] = []
  const closed: Question[] = []
  const positions = (op: QuestionOp, flag: string): number[] => questionPositions(op.ns ?? String(op.n), questions.length, flag)
  for (const op of ops) {
    if (op.kind === 'clear') {
      closed.push(...questions)
      questions = []
      changes.push('cleared')
    } else if (op.kind === 'drop') {
      const ns = positions(op, 'drop')
      closed.push(...ns.map((n) => questions[n - 1]!))
      questions = questions.filter((_, i) => !ns.includes(i + 1))
      changes.push(`dropped ${ns.join(',')}`)
    } else if (op.kind === 'append') {
      const agent = op.question!.agent ?? asker
      questions.push(agent ? { ...op.question!, agent } : op.question!)
      changes.push('appended')
    } else {
      const [n] = positions(op, 'update')
      const agent = op.question!.agent ?? questions[n! - 1]!.agent
      questions[n! - 1] = { ...op.question!, ...(agent ? { agent } : {}) }
      changes.push(`rewrote ${n}`)
    }
  }
  return { questions, changes, closed }
}
