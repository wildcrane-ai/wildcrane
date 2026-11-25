import { z } from 'zod'
import { taskOnlyPreviews, type PreviewDefinition } from './preview-definitions.ts'

const id = z.string().trim().min(1).max(100)
export const reviewNodeSchema = z.object({
  id,
  after: z.array(id).max(50).default([]),
  previews: z.array(id).max(50).default([]),
  kind: z.literal('work').optional(),
}).strict()
export type ReviewNode = z.infer<typeof reviewNodeSchema>
export type ReviewPlan = ReviewNode[] | null
export type ReviewStatus = 'blocked' | 'available' | 'running' | 'ready' | 'approved' | 'done'
export interface ReviewStage { id: string; status: ReviewStatus; revision: number; snapshot: Record<string, unknown> | null }
export type PreviewUnavailable = 'not_generated' | 'waiting'
export interface ReviewApproval { stage: string; revision: number; starts: string[] }
export interface TaskReview {
  revision: number
  plan: ReviewPlan
  stages: ReviewStage[]
  previews?: Record<string, PreviewUnavailable>
  approvals?: ReviewApproval[]
  preview_definitions?: PreviewDefinition[]
}

export interface SavedPreviewInputs {
  body?: string | null
  sections: Record<string, { body: string; sources: string[] }>
  assets: Record<string, { artifact: string; version?: number; status?: string; error?: string; dependencies?: string[] }>
}

export function reviewPreviewIds(plan: ReviewPlan | undefined): string[] {
  return [...new Set((plan ?? []).flatMap(node => node.previews))]
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

export function parseReviewPlan(value: unknown): ReviewPlan {
  return reviewPlanSchema.parse(value)
}

type ReviewPreview = { id: string; title?: Record<string, string> }
const HANDOFF = 'delivery-handoff'
const HANDOFF_WITH_COLLISION = 'delivery-handoff:flow'

function reviewNames(catalog: readonly ReviewPreview[]) {
  return catalog.map(({ id, title }) => {
    const labels = Object.values(title ?? {}).map(label => label.trim()).filter(Boolean)
    return { id, labels: labels.length ? [...new Set(labels)] : [id] }
  })
}

function previewError(message: string, names: ReturnType<typeof reviewNames>) {
  const available = names.map(({ labels, id }) => `${labels.join(' / ')} (${id})`).join(', ') || 'none'
  return new Error(`${message} Available Previews: ${available}. Use a listed name in a flow or its ID in a JSON plan. Define custom Previews before using them. A Preview is a draft or result for review. Keep task context in the card body.`)
}

export function validateReviewPreviews(plan: ReviewPlan, catalog?: readonly ReviewPreview[], { saved = false } = {}): ReviewPlan {
  const prerequisites = new Set((plan ?? []).flatMap(node => node.after))
  const ids = new Set(catalog?.map(p => p.id))
  for (const node of plan ?? []) {
    if (node.previews.length) {
      if (!catalog) throw new Error('Preview outputs are unavailable; update Runner and try again.')
      const unknown = node.previews.find(preview => !ids.has(preview))
      if (unknown) throw previewError(`Preview ${unknown} is not defined for review node "${node.id}".`, reviewNames(catalog))
    } else if (!saved && node.kind !== 'work') {
      // Match the automatic handoff recognized by Cloud, and require it to be terminal.
      const handoff = (node.id === HANDOFF || node.id === HANDOFF_WITH_COLLISION) &&
        node.after.length && !prerequisites.has(node.id)
      if (!handoff) throw previewError(
        `Review node "${node.id}" needs at least one Preview. Use an empty plan for no extra review.`, reviewNames(catalog ?? []))
    }
  }
  return plan
}

export function parseReviewFlow(flow: string, catalog?: readonly ReviewPreview[]): ReviewNode[] {
  if (flow === '') return []
  if (!catalog) throw new Error('Preview outputs are unavailable; update Runner and try again.')
  const names = reviewNames(catalog)
  const seen = new Set<string>()
  const nodes: ReviewNode[] = []
  let after: string[] = []
  for (const [index, group] of flow.split('->').entries()) {
    const current = group.split('+').map(entry => {
      const name = entry.trim()
      if (!name) throw previewError(`Review flow group ${index + 1} contains an empty Preview name.`, names)
      const matches = names.filter(({ labels }) => labels.includes(name))
      if (matches.length !== 1) {
        throw previewError(`${matches.length ? 'Ambiguous' : 'Unknown'} Preview "${name}" in review flow group ${index + 1}.`, names)
      }
      const { id } = matches[0]!
      if (seen.has(id)) throw previewError(`Repeated Preview "${name}" in review flow group ${index + 1}.`, names)
      seen.add(id)
      nodes.push({ id, after, previews: [id] })
      return id
    })
    after = current
  }
  // Preserve the saved Flow shape. The terminal handoff completes with its prerequisites.
  nodes.push({ id: seen.has(HANDOFF) ? HANDOFF_WITH_COLLISION : HANDOFF, after, previews: [] })
  return parseReviewPlan(nodes)!
}

/** Projects stored plans onto the current contract, including plans saved with legacy titles. */
export function readReviewPlan(plan: ReviewPlan | undefined): ReviewPlan {
  return plan?.map(({ id, after, previews, kind }) => ({ id, after, previews, ...(kind && { kind }) })) ?? null
}

export function reviewEdgeNeedsApproval(from: ReviewNode, to: ReviewNode): boolean {
  return from.kind !== 'work' && to.kind !== 'work' && from.previews.length > 0 && to.previews.length > 0
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
  | { kind: 'plan' | 'unreviewed' | 'delivery' | 'changed' | 'waiting' }
  | { kind: 'stages'; nodes: ReviewNode[] }

export function reviewAuthorization(review: TaskReview, assigned?: readonly string[], dispatchRevision?: number): ReviewAuthorization {
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
  if (review.plan.every(node => {
    const status = states.get(node.id)?.status
    return status === 'approved' || status === 'done'
  })) return { kind: 'delivery' }
  return { kind: 'waiting' }
}

export function reviewAllows(authorization: ReviewAuthorization, action: 'refine' | 'implement'): boolean {
  return action === 'refine'
    ? authorization.kind === 'plan' || authorization.kind === 'stages'
    : authorization.kind === 'unreviewed' || authorization.kind === 'delivery'
}

function reviewInstruction(authorization: ReviewAuthorization): string {
  switch (authorization.kind) {
    case 'plan': return 'Planning only. Submit a review plan. Work only on dispatched stages.'
    case 'unreviewed': return 'No extra review. Complete the authorized work and Studio delivery checks.'
    case 'stages': return [
      'Work only on these unlocked stages: ' + authorization.nodes.map(node => node.id).join(', '),
      ...authorization.nodes.map(node => `- ${node.id}: ${node.previews.length ? node.previews.join(', ') : 'no Preview'}`),
    ].join('\n')
    case 'delivery': return 'Stages complete. Follow Studio delivery checks.'
    case 'changed': return 'Review authorization changed. Read the task again.'
    case 'waiting': return 'Wait for review. Do not execute locked stages.'
  }
}

const reviewWriteRules = 'Read akb task review before reporting running/done with its revision. Sync content and assets before done. Revise a stage before changing its approved output. Only stage approval accepts reviewable outputs.'

export function taskReviewBoundary(review: TaskReview, assigned?: readonly string[]): string {
  return [
    reviewInstruction(reviewAuthorization(review, assigned)),
    reviewWriteRules,
  ].join('\n')
}

export function reviewBoundary(review: TaskReview, assigned?: readonly string[], studio: readonly { id: string }[] = []): string {
  const { preview_definitions = [], ...state } = review
  const authorization = reviewAuthorization(review, assigned)
  const definitions = taskOnlyPreviews(studio, preview_definitions).filter(p =>
    authorization.kind !== 'stages' || !assigned || authorization.nodes.some(node => node.previews.includes(p.id)))
  return [
    'Task review: ' + JSON.stringify(state),
    reviewInstruction(authorization),
    ...definitions.map(p => [
      `<Preview id="${p.id}">`, p.instructions,
      ...(p.components ? [`Allowed Preview Components: ${p.components.join(', ') || 'none'}.`] : []),
      '</Preview>',
    ].join('\n')),
    reviewWriteRules,
  ].join('\n')
}
