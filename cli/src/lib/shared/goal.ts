import type { PreviewDefinition } from './preview-definitions.ts'
import type { ReviewPlan } from './review-plan'

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

export interface GoalDraft {
  id?: string
  title: string
  outcome?: string
  acceptance?: string[]
  studio?: string
  review_plan?: ReviewPlan
  review_flow?: string
  preview_definitions?: PreviewDefinition[]
}

export function goalRoute(discussion: string, goal: string): string {
  return `/v1/discussions/${encodeURIComponent(discussion)}/goals/${encodeURIComponent(goal)}`
}
