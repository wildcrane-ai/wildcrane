import type { Goal } from '../../cli/src/lib/shared/goal'

type SavedGoal = Omit<Goal, 'studio' | 'task'> & {
  studio?: string
  workflow?: string
  previews?: string[]
  task?: Goal['task'] | string
}

export interface SavedGoalData {
  goals?: Goal[]
  ideas?: SavedGoal[]
  goalsVersion?: number
  ideas_version?: number
}

/** Rewrite old on-disk drafts and unsent reports when Runner resumes them. */
export function migrateGoalData(data: SavedGoalData): boolean {
  const goals: SavedGoal[] | undefined = data.goals ?? data.ideas
  const changed = 'ideas' in data || 'ideas_version' in data || (Array.isArray(goals) && goals.some(goal =>
    'workflow' in goal || 'previews' in goal || typeof goal.task === 'string' || goal.task === undefined))
  if (!changed) return false
  if (Array.isArray(goals)) {
    data.goals = goals.map(({ studio, workflow, previews, task, ...goal }) => ({
      ...goal,
      studio: studio ?? workflow!,
      ...(goal.review_plan === undefined && previews
        ? { review_plan: previews.length ? [{ id: 'review', after: [], previews }] : [] } : {}),
      task: typeof task === 'string' ? { id: task } : task ?? null,
    }))
  }
  if (data.goalsVersion === undefined && data.ideas_version !== undefined) data.goalsVersion = data.ideas_version
  delete data.ideas
  delete data.ideas_version
  return true
}
