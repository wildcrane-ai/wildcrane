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
const flatReviewPlanSchema = z.object({
  rule: z.string().trim().max(20_000),
  previews: z.array(id).max(50).transform(ids => [...new Set(ids)]),
}).strict()
export type FlatReviewPlan = z.infer<typeof flatReviewPlanSchema>
export type ReviewPlan = FlatReviewPlan | ReviewNode[] | null

export function isFlatReviewPlan(plan: ReviewPlan | undefined): plan is FlatReviewPlan {
  return plan != null && !Array.isArray(plan)
}

export function reviewPlanFromOptions(opts: { review?: string; previews?: string }, previous?: ReviewPlan): FlatReviewPlan | undefined {
  if (opts.previews === undefined && !(opts.review !== undefined && isFlatReviewPlan(previous))) return
  const held = isFlatReviewPlan(previous) ? previous : { rule: '', previews: [] }
  return flatReviewPlanSchema.parse({
    rule: opts.review ?? held.rule,
    previews: opts.previews === undefined ? held.previews : opts.previews.trim() ? opts.previews.split(',') : [],
  })
}

/** Append Preview IDs to an existing Flat or Legacy review plan without resetting existing stages. */
export function addPreviewsToPlan(previous: ReviewPlan | undefined, previews: readonly string[]): ReviewPlan {
  const toAdd = [...new Set(previews.map(id => id.trim()).filter(Boolean))]
  if (isFlatReviewPlan(previous)) {
    return flatReviewPlanSchema.parse({ rule: previous.rule, previews: [...previous.previews, ...toAdd] })
  }
  if (!previous?.length) {
    if (!toAdd.length) return []
    const handoffId = toAdd.includes(HANDOFF) ? HANDOFF_WITH_COLLISION : HANDOFF
    return legacyReviewPlanSchema.parse([
      ...toAdd.map(id => ({ id, after: [], previews: [id] })),
      { id: handoffId, after: toAdd, previews: [] },
    ])
  }
  const existingPreviews = new Set(reviewPreviewIds(previous))
  const missing = toAdd.filter(id => !existingPreviews.has(id))
  if (!missing.length) return previous
  const usedIds = new Set(previous.map(node => node.id))
  const addedNodes: ReviewNode[] = missing.map(previewId => {
    let nodeId = previewId
    let suffix = 2
    while (usedIds.has(nodeId)) nodeId = `${previewId}-${suffix++}`
    usedIds.add(nodeId)
    return { id: nodeId, after: [], previews: [previewId] }
  })
  const prerequisites = new Set(previous.flatMap(node => node.after))
  const handoffIndex = previous.findIndex(node =>
    (node.id === HANDOFF || node.id === HANDOFF_WITH_COLLISION) &&
    node.kind !== 'work' && !node.previews.length && !prerequisites.has(node.id))
  if (handoffIndex === -1) return legacyReviewPlanSchema.parse([...previous, ...addedNodes])
  const handoff = previous[handoffIndex]!
  const updatedHandoff: ReviewNode = { ...handoff, after: [...handoff.after, ...addedNodes.map(node => node.id)] }
  return legacyReviewPlanSchema.parse([
    ...previous.slice(0, handoffIndex),
    ...addedNodes,
    updatedHandoff,
    ...previous.slice(handoffIndex + 1),
  ])
}
export type ReviewStatus = 'blocked' | 'available' | 'running' | 'waiting_review' | 'approved' | 'done' | 'changes_requested' | 'superseded'
export interface ReviewStage { id: string; status: ReviewStatus | 'ready'; revision: number; snapshot: Record<string, unknown> | null; preview?: string; question?: string; job?: string }

/** Read stages in older responses and saved Runner state during an upgrade. */
export function isWaitingReview(status: ReviewStage['status']): boolean {
  return status === 'waiting_review' || status === 'ready'
}
export type PreviewUnavailable = 'not_generated' | 'waiting'
export interface LegacyReviewApproval { stage: string; revision: number; starts: string[] }
export interface PendingApproval { stage: string; revision: number; preview: string; question: string }
export type ReviewApproval = LegacyReviewApproval | PendingApproval
export interface TaskReview {
  revision: number
  plan: ReviewPlan
  stages: ReviewStage[]
  previews?: Record<string, PreviewUnavailable>
  approvals?: ReviewApproval[]
  preview_definitions?: PreviewDefinition[]
}

type AgentApproval = Omit<LegacyReviewApproval, 'revision'> | Omit<PendingApproval, 'revision'>
type AgentReviewStage = Pick<ReviewStage, 'id' | 'status' | 'snapshot' | 'preview' | 'question'>
export interface AgentReview extends Omit<TaskReview, 'revision' | 'stages' | 'approvals'> {
  stages: AgentReviewStage[]
  approvals?: AgentApproval[]
}

function agentSnapshot(snapshot: ReviewStage['snapshot']): ReviewStage['snapshot'] {
  const evidence = snapshot?.evidence
  if (!evidence || typeof evidence !== 'object' || !('after' in evidence)) return snapshot
  const { after: _reviewRevisions, ...pins } = evidence
  return { ...snapshot, evidence: pins }
}

export function agentReview(review: AgentReview): AgentReview {
  const { plan, stages, previews, approvals, preview_definitions } = review
  return {
    plan,
    stages: stages.map(({ id, status, snapshot, preview, question }) => ({ id, status, snapshot: agentSnapshot(snapshot), preview, question })),
    previews,
    approvals: approvals?.map(approval => 'preview' in approval
      ? { stage: approval.stage, preview: approval.preview, question: approval.question }
      : { stage: approval.stage, starts: approval.starts }),
    preview_definitions,
  }
}

export interface SavedPreviewInputs {
  body?: string | null
  sections: Record<string, { body: string; sources: string[] }>
  assets: Record<string, { artifact: string; version?: number; status?: string; error?: string; dependencies?: string[] }>
}

export function reviewPreviewIds(plan: ReviewPlan | undefined): string[] {
  return isFlatReviewPlan(plan) ? plan.previews : [...new Set((plan ?? []).flatMap(node => node.previews))]
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

const legacyReviewPlanSchema = z.array(reviewNodeSchema).max(50).superRefine((nodes, ctx) => {
  try { reviewLayers(nodes) } catch (e) { ctx.addIssue({ code: 'custom', message: (e as Error).message }) }
})
export const reviewPlanSchema = z.union([flatReviewPlanSchema, legacyReviewPlanSchema]).nullable()

export function parseReviewPlan(value: unknown[]): ReviewNode[]
export function parseReviewPlan(value: unknown): ReviewPlan
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
  return new Error(`${message} Available Previews: ${available}. Use a listed Preview ID or its name in a legacy flow. Define custom Previews before using them. A Preview is a draft or result for review. Keep task context in the card body.`)
}

export function validateReviewPreviews(plan: ReviewPlan, catalog?: readonly ReviewPreview[], { saved = false } = {}): ReviewPlan {
  const ids = new Set(catalog?.map(p => p.id))
  if (isFlatReviewPlan(plan)) {
    const unknown = plan.previews.find(preview => !ids.has(preview))
    if (unknown) throw previewError(`Preview ${unknown} is not defined.`, reviewNames(catalog ?? []))
    return plan
  }
  const prerequisites = new Set((plan ?? []).flatMap(node => node.after))
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
  return legacyReviewPlanSchema.parse(nodes)
}

/** Projects stored plans onto the current contract, including plans saved with legacy titles. */
export function readReviewPlan(plan: ReviewPlan | undefined): ReviewPlan {
  if (isFlatReviewPlan(plan)) return plan
  return plan?.map(({ id, after, previews, kind }) => ({ id, after, previews, ...(kind && { kind }) })) ?? null
}

export function reviewEdgeNeedsApproval(from: ReviewNode, to: ReviewNode): boolean {
  return from.kind !== 'work' && to.kind !== 'work' && from.previews.length > 0 && to.previews.length > 0
}

export function reviewDependencies(plan?: ReviewPlan): ReviewNode[] {
  if (isFlatReviewPlan(plan)) return []
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
  | { kind: 'plan' | 'unreviewed' | 'delivery' | 'changed' | 'waiting'
  }
  | { kind: 'flat'; plan: FlatReviewPlan }
  | { kind: 'stages'; nodes: ReviewNode[] }

export function reviewAuthorization(review: AgentReview, assigned?: readonly string[], dispatchRevision?: number): ReviewAuthorization {
  if (isFlatReviewPlan(review.plan)) {
    return review.stages.some(stage => isWaitingReview(stage.status)) ? { kind: 'waiting' } : { kind: 'flat', plan: review.plan }
  }
  const states = new Map(review.stages.map(stage => [stage.id, stage]))
  const nodes = (review.plan ?? []).filter(node => {
    const stage = states.get(node.id)
    if (!stage || (assigned && !assigned.includes(node.id))) return false
    // An available stage revised after dispatch needs a new grant. Starting it advances its running revision.
    return stage.status === 'running' ||
      (stage.status === 'available' && (dispatchRevision === undefined ||
        'revision' in stage && typeof stage.revision === 'number' && stage.revision <= dispatchRevision))
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
    ? authorization.kind === 'plan' || authorization.kind === 'stages' || authorization.kind === 'flat'
    : authorization.kind === 'unreviewed' || authorization.kind === 'delivery' || authorization.kind === 'flat'
}

interface ReviewBoundaryOptions {
  phase?: string
}

function reviewInstruction(authorization: ReviewAuthorization, review: AgentReview, delivery: boolean): string {
  switch (authorization.kind) {
    case 'plan': return 'Planning only. Submit a review plan. Work only on dispatched stages.'
    case 'unreviewed': return 'No extra review. Complete the authorized work and Studio delivery checks.'
    case 'stages': return [
      'Work only on these unlocked stages: ' + authorization.nodes.map(node => node.id).join(', '),
      ...authorization.nodes.map(node => `- ${node.id}: ${node.previews.length ? node.previews.join(', ') : 'no Preview'}`),
    ].join('\n')
    case 'flat': return [
      'Selected Previews: ' + (authorization.plan.previews.join(', ') || 'none'),
      delivery ? 'Complete the authorized work and follow Studio delivery checks.'
        : 'Review rule: ' + (authorization.plan.rule || 'No extra approval.'),
      ...(!delivery && authorization.plan.rule ? [
        'At each approval point, save the current Preview and assets. Run akb task review <task> --request-approval <question> --preview <id>.',
        'End this run after submitting an approval. On continuation, read the task review and the latest decision before continuing or revising the draft.',
      ] : []),
      ...review.stages.filter(stage => stage.preview && (stage.status === 'approved' || stage.status === 'changes_requested'))
        .map(stage => `- ${stage.preview} · ${stage.id} · ${stage.status === 'approved' ? 'approved' : 'changes requested'}`),
    ].join('\n')
    case 'delivery': return 'Stages complete. Follow Studio delivery checks.'
    case 'changed': return 'Review authorization changed. Read the task again.'
    case 'waiting': return isFlatReviewPlan(review.plan)
      ? 'An approval question is pending. Read akb task review <task> before making any requested changes. Wait for an explicit decision before continuing work.'
      : 'Wait for review. Do not execute locked stages.'
  }
}

const reviewWriteRules = 'Sync content and assets before reporting a stage done. Revise a stage before changing its approved output. Only stage approval accepts reviewable outputs.'

export function taskReviewBoundary(review: AgentReview, assigned?: readonly string[], options?: ReviewBoundaryOptions): string {
  const delivery = options?.phase === 'implement' || options?.phase === 'land'
  return [
    reviewInstruction(reviewAuthorization(review, assigned), review, delivery),
    ...(isFlatReviewPlan(review.plan) ? [] : [reviewWriteRules]),
  ].join('\n')
}

export function reviewBoundary(review: AgentReview, assigned?: readonly string[], studio: readonly { id: string }[] = [],
  options?: ReviewBoundaryOptions): string {
  const { preview_definitions = [], ...state } = agentReview(review)
  const authorization = reviewAuthorization(review, assigned)
  const delivery = options?.phase === 'implement' || options?.phase === 'land'
  const details = delivery && isFlatReviewPlan(state.plan)
    ? { ...state, plan: { previews: state.plan.previews } } : state
  const definitions = taskOnlyPreviews(studio, preview_definitions).filter(p =>
    authorization.kind !== 'stages' || !assigned || authorization.nodes.some(node => node.previews.includes(p.id)))
  return [
    'Task review: ' + JSON.stringify(details),
    reviewInstruction(authorization, review, delivery),
    ...definitions.map(p => [
      `<Preview id="${p.id}">`, p.instructions,
      ...(p.components ? [`Allowed Preview Components: ${p.components.join(', ') || 'none'}.`] : []),
      '</Preview>',
    ].join('\n')),
    ...(isFlatReviewPlan(review.plan) ? [] : [reviewWriteRules]),
  ].join('\n')
}
