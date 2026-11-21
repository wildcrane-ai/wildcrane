import type { PreviewDefinition } from './preview-definitions.ts'
import { readReviewPlan, type ReviewPlan } from './review-plan'

export interface GoalTask {
  id: string
  key?: string
}

export interface Goal {
  id: string
  title: string
  outcome: string
  acceptance: string[]
  studio: string
  review_plan?: ReviewPlan
  preview_definitions?: PreviewDefinition[]
  task: GoalTask | null
  start?: boolean
  dropped?: boolean
}

type GoalInput = Omit<Goal, 'studio' | 'task'> & {
  studio?: string
  workflow?: string
  previews?: string[]
  task?: GoalTask | string | null
}

type GoalFields = { goals?: GoalInput[]; ideas?: GoalInput[] }
export type GoalField = keyof GoalFields
export type GoalEnvelope<T> = Omit<T, 'goals'> & GoalFields

function readGoal({ studio, workflow, previews, task, review_plan, ...goal }: GoalInput): Goal {
  // Match the Cloud migration of flat Preview selections to a review plan.
  const plan = review_plan !== undefined ? readReviewPlan(review_plan)
    : previews?.length ? [{ id: 'review', after: [], previews }]
    : previews ? [] : undefined
  return {
    ...goal,
    studio: studio ?? workflow!,
    ...(plan === undefined ? {} : { review_plan: plan }),
    task: typeof task === 'string' ? { id: task } : task ?? null,
  }
}

export function decodeGoals<T extends GoalFields>({ goals, ideas, ...rest }: T) {
  if (goals !== undefined && ideas !== undefined && JSON.stringify(goals) !== JSON.stringify(ideas)) {
    throw new Error('goals and ideas do not match.')
  }
  const entries = goals ?? ideas
  if (!Array.isArray(entries)) throw new Error('The goals array is missing or invalid.')
  const field: GoalField = goals === undefined ? 'ideas' : 'goals'
  return { field, value: { ...rest, goals: entries.map(readGoal) } }
}

export function goalRoute(discussion: string, goal: string, field: GoalField): string {
  return `/v1/discussions/${encodeURIComponent(discussion)}/${field}/${encodeURIComponent(goal)}`
}
