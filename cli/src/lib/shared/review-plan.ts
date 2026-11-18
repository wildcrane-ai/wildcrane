import { z } from 'zod'

const id = z.string().trim().min(1).max(100)
export const reviewNodeSchema = z.object({
  id,
  after: z.array(id).max(50).default([]),
  previews: z.array(id).max(50).default([]),
  kind: z.literal('work').optional(),
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

/** Projects stored plans onto the current contract, including plans saved with legacy titles. */
export function readReviewPlan(plan: ReviewPlan | undefined): ReviewPlan {
  return plan?.map(({ id, after, previews, kind }) => ({ id, after, previews, ...(kind && { kind }) })) ?? null
}

export function reviewEdgeNeedsApproval(from: ReviewNode, to: ReviewNode): boolean {
  return from.kind !== 'work' && to.kind !== 'work'
}

export function reviewDependencies(plan?: ReviewPlan): ReviewNode[] {
  const nodes = new Map((plan ?? []).map(node => [node.id, node]))
  const linked = new Set<string>()
  const points = (plan ?? []).map(node => {
    const after = node.after.filter(id => {
      const from = nodes.get(id)
      if (!from || !reviewEdgeNeedsApproval(from, node)) return false
      linked.add(id)
      linked.add(node.id)
      return true
    })
    return { ...node, after }
  })
  return points.filter(point => linked.has(point.id))
}

type ReviewAuthorization =
  | { kind: 'plan' | 'pending' | 'unreviewed' | 'delivery' | 'changed' | 'waiting' }
  | { kind: 'stages'; nodes: ReviewNode[] }

export function reviewAuthorization(review: TaskReview, assigned?: readonly string[], dispatchRevision?: number): ReviewAuthorization {
  if (review.pending_plan) return { kind: 'pending' }
  const states = new Map(review.stages.map(stage => [stage.id, stage]))
  const nodes = (review.plan ?? []).filter(node => {
    const stage = states.get(node.id)
    if (!stage || (assigned && !assigned.includes(node.id))) return false
    // An available stage revised after dispatch needs a new grant. Starting it advances its running revision.
    return stage.status === 'running' ||
      (stage.status === 'available' && (dispatchRevision === undefined || stage.revision <= dispatchRevision))
  })
  if (assigned?.some(id => !nodes.some(node => node.id === id))) return { kind: 'changed' }
  if (review.plan === null) return { kind: 'plan' }
  if (review.plan.length === 0) return { kind: 'unreviewed' }
  if (nodes.length) return { kind: 'stages', nodes }
  if (review.plan.every(node => states.get(node.id)?.status === 'approved')) return { kind: 'delivery' }
  return { kind: 'waiting' }
}

export function reviewAllows(authorization: ReviewAuthorization, action: 'refine' | 'implement'): boolean {
  return action === 'refine'
    ? authorization.kind === 'plan' || authorization.kind === 'stages'
    : authorization.kind === 'unreviewed' || authorization.kind === 'delivery'
}

function reviewInstruction(authorization: ReviewAuthorization): string {
  switch (authorization.kind) {
    case 'plan': return 'Planning only. Propose a review plan; wait for explicit plan approval.'
    case 'pending': return 'Wait for the proposed plan decision. Do not start new stages.'
    case 'unreviewed': return 'No extra review. Complete the authorized work and Studio delivery checks.'
    case 'stages': return [
      'Work only on these unlocked stages: ' + authorization.nodes.map(node => node.id).join(', '),
      ...authorization.nodes.map(node => `- ${node.id}: ${node.previews.length ? node.previews.join(', ') : 'card body'}`),
    ].join('\n')
    case 'delivery': return 'Stages complete. Follow Studio delivery checks.'
    case 'changed': return 'Review authorization changed. Read the task again.'
    case 'waiting': return 'Wait for review. Do not execute locked stages.'
  }
}

export function reviewBoundary(review: TaskReview, assigned?: readonly string[]): string {
  return [
    'Task review: ' + JSON.stringify(review),
    reviewInstruction(reviewAuthorization(review, assigned)),
    'Read akb task review before reporting running/done with its revision. Sync content and assets before done. Revise a stage before changing its approved output. Questions and plan approval never approve outputs.',
  ].join('\n')
}
