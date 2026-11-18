import { z } from 'zod'

const id = z.string().trim().min(1).max(100)
export const reviewNodeSchema = z.object({
  id, title: z.string().trim().min(1).max(200),
  after: z.array(id).max(50).default([]),
  previews: z.array(id).max(50).default([]),
}).strict()
export type ReviewNode = z.infer<typeof reviewNodeSchema>
export type ReviewPlan = ReviewNode[] | null
export type ReviewStatus = 'blocked' | 'available' | 'running' | 'ready' | 'approved'
export interface ReviewStage { id: string; status: ReviewStatus; revision: number; snapshot: Record<string, unknown> | null }
export interface TaskReview {
  revision: number
  plan: ReviewPlan
  pending_plan: { revision: number; snapshot: { kind: 'plan'; plan: ReviewNode[] } } | null
  stages: ReviewStage[]
}

export function reviewLayers(plan: ReviewNode[]): ReviewNode[][] {
  const remaining = new Set(plan.map(n => n.id))
  if (remaining.size !== plan.length) throw new Error('Review node IDs must be unique.')
  for (const n of plan) {
    if (new Set(n.after).size !== n.after.length) throw new Error(`Duplicate dependency in ${n.id}.`)
    if (new Set(n.previews).size !== n.previews.length) throw new Error(`Duplicate Preview in ${n.id}.`)
    for (const dep of n.after) {
      if (dep === n.id) throw new Error(`Review node ${n.id} depends on itself.`)
      if (!remaining.has(dep)) throw new Error(`Unknown review dependency ${dep}.`)
    }
  }
  const layers: ReviewNode[][] = []
  while (remaining.size) {
    const layer = plan.filter(n => remaining.has(n.id) && n.after.every(d => !remaining.has(d)))
    if (!layer.length) throw new Error('Review dependencies contain a cycle.')
    layers.push(layer)
    for (const n of layer) remaining.delete(n.id)
  }
  return layers
}

export const reviewPlanSchema = z.array(reviewNodeSchema).max(50).superRefine((nodes, ctx) => {
  try { reviewLayers(nodes) } catch (e) { ctx.addIssue({ code: 'custom', message: (e as Error).message }) }
}).nullable()

export function parseReviewPlan(value: unknown, previews?: readonly string[]): ReviewPlan {
  const plan = reviewPlanSchema.parse(value)
  if (previews) for (const n of plan ?? []) for (const p of n.previews) {
    if (!previews.includes(p)) throw new Error(`Preview ${p} is not defined in this Studio.`)
  }
  return plan
}

export function reviewBoundary(review: TaskReview, assigned?: readonly string[]): string {
  const allowed = review.pending_plan ? [] : review.stages.filter(s => (s.status === 'available' || s.status === 'running') && (!assigned || assigned.includes(s.id)))
  return [
    'Task review: ' + JSON.stringify(review),
    review.plan === null ? 'Planning only. Propose a review plan; wait for explicit plan approval.' :
      review.pending_plan ? 'Wait for the proposed plan decision. Do not start new stages.' :
      !review.plan.length ? 'No extra review. Complete the authorized work and Studio delivery checks.' :
      allowed.length ? 'Work only on these unlocked stages: ' + allowed.map(s => s.id).join(', ') :
      review.stages.every(s => s.status === 'approved') ? 'Stages complete. Follow Studio delivery checks.' : 'Wait for review. Do not execute locked stages.',
    'Read akb task review before reporting running/done with its revision. Sync content and assets before done. Revise a stage before changing its approved output. Questions and plan approval never approve outputs.',
  ].join('\n')
}
