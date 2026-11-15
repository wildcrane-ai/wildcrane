import type { PreviewStageDefinition } from './agents/parse.ts'

export type PreviewStageStatus = 'pending' | 'queued' | 'running' | 'awaiting_confirmation' | 'confirmed' | 'ready' | 'failed' | 'stale'
export interface PreviewArtifact { localAssets?: Record<string, string>; stageId: string; version: number; body: string; assets: Record<string, unknown> }
export interface PreviewStage extends PreviewStageDefinition {
  status: PreviewStageStatus
  version: number | null
  artifact?: PreviewArtifact
  history?: PreviewArtifact[]
  confirmation?: { version: number; action: string }
}
export interface PreviewProgress {
  agent: string
  definitionRevision: string
  generation: number
  currentStageId: string | null
  definitions: PreviewStageDefinition[]
  body: string
  files: Record<string, string>
  stages: PreviewStage[]
  revisionBase?: PreviewStage[]
  archivedSelections?: PreviewStage[][]
  displayedArtifact: PreviewArtifact | null
  execution: string | null
  failure?: { job: string; message: string }
}
export interface PreviewBaseline { definitionRevision: string; generation: number; stageId: string; execution: string }

export function selectPreviewStages(progress: PreviewProgress, ids: string[]): void {
  const wanted = new Set(ids)
  if (!ids.length || wanted.size !== ids.length || ids.some((id) => !progress.definitions.some((stage) => stage.id === id))) throw Error('Choose a nonempty list of unique known stage IDs.')
  if (progress.stages.some(stage => stage.artifact || ['awaiting_confirmation', 'confirmed'].includes(stage.status)) && JSON.stringify(progress.stages.map(stage => stage.id)) !== JSON.stringify(ids)) throw Error('Wait for user approval before changing the selected stages.')
  const chosen = ids.map((id) => progress.definitions.find((stage) => stage.id === id)!)
  if (progress.stages.length) {
    if (JSON.stringify(progress.stages.map((stage) => stage.id)) === JSON.stringify(ids)) return
    progress.archivedSelections = [...progress.archivedSelections ?? [], structuredClone(progress.stages)]
    progress.generation++
  }
  progress.stages = chosen.map((stage, i) => structuredClone(progress.stages.find((held) => held.id === stage.id) ?? { ...stage, status: i === 0 ? 'running' : 'pending', version: null }))
  progress.currentStageId = progress.stages.find((stage) => !['confirmed', 'ready'].includes(stage.status))?.id ?? chosen.at(-1)!.id
}

export function previewBaseline(progress: PreviewProgress, stageId: string, execution: string): PreviewBaseline {
  const stage = progress.stages.find((stage) => stage.id === stageId)
  if (progress.currentStageId !== stageId || !stage) throw Error('Unknown current stage.')
  progress.execution = execution
  delete progress.failure
  if (!['awaiting_confirmation', 'ready', 'confirmed'].includes(stage.status)) stage.status = 'running'
  return { definitionRevision: progress.definitionRevision, generation: progress.generation, stageId, execution }
}

export function submitPreviewStage(progress: PreviewProgress, baseline: PreviewBaseline, body: string, assets: Record<string, unknown>): PreviewArtifact {
  const stage = progress.stages.find((stage) => stage.id === baseline.stageId)
  if (baseline.definitionRevision !== progress.definitionRevision || baseline.generation !== progress.generation || baseline.execution !== progress.execution
    || progress.currentStageId !== baseline.stageId || !stage) throw Error('This execution is outdated. Reload the task.')
  if (['awaiting_confirmation', 'ready'].includes(stage.status) && stage.artifact) return stage.artifact
  if (stage.status !== 'running') throw Error('This stage is not the current execution.')
  const artifact = { stageId: stage.id, version: (stage.version ?? 0) + 1, body, assets: structuredClone(assets) }
  stage.history = [...stage.history ?? [], artifact]
  stage.version = artifact.version
  stage.artifact = artifact
  stage.status = progress.stages.at(-1)?.id === stage.id ? 'ready' : 'awaiting_confirmation'
  progress.displayedArtifact = artifact
  return artifact
}

export function confirmPreviewStage(progress: PreviewProgress, stageId: string, version: number, definitionRevision: string, action: string): { action: string; next: string } {
  const at = progress.stages.findIndex((stage) => stage.id === stageId)
  const stage = progress.stages[at]
  const next = progress.stages[at + 1]
  if (definitionRevision !== progress.definitionRevision || !stage || stage.version !== version || !next) throw Error('The preview changed. Reload and review it again.')
  if (stage.status === 'confirmed' && stage.confirmation?.version === version) return { action: stage.confirmation.action, next: next.id }
  if (progress.currentStageId !== stageId || stage.status !== 'awaiting_confirmation' || stage.artifact?.version !== version || progress.displayedArtifact?.stageId !== stageId || progress.displayedArtifact?.version !== version) throw Error('This preview is not waiting for confirmation.')
  stage.status = 'confirmed'
  stage.confirmation = { version, action }
  next.status = 'queued'
  progress.currentStageId = next.id
  progress.execution = null
  return { action, next: next.id }
}

export function invalidatePreviewStages(progress: PreviewProgress, from: string): void {
  const at = progress.stages.findIndex((stage) => stage.id === from)
  if (at < 0) throw Error('Unknown stage.')
  progress.generation++
  progress.execution = null
  for (const stage of progress.stages.slice(at)) { stage.status = 'stale'; delete stage.confirmation }
  progress.currentStageId = from
  progress.displayedArtifact = progress.stages.slice(0, at).reverse().find((stage) => stage.artifact)?.artifact ?? null
}

export const previewReady = (progress: PreviewProgress): boolean => progress.stages.length > 0 && progress.stages.every((stage, i) => stage.status === (i === progress.stages.length - 1 ? 'ready' : 'confirmed') && !!stage.version && stage.artifact?.version === stage.version && !!stage.artifact.body.trim())
export function previewDisplay(progress: PreviewProgress, canWrite: boolean) {
  return {
    agent: progress.agent, definitionRevision: progress.definitionRevision, currentStageId: progress.currentStageId,
    stages: progress.stages.map(({ id, title, status, version }) => ({ id, title, status, version })),
    displayedArtifact: progress.displayedArtifact,
    canConfirm: canWrite && progress.stages.some((stage) => stage.id === progress.currentStageId && stage.status === 'awaiting_confirmation'),
  }
}

export function beginPreviewRevision(progress: PreviewProgress, execution: string): void {
  progress.revisionBase = structuredClone(progress.stages)
  invalidatePreviewStages(progress, progress.stages[0]!.id)
  progress.execution = execution
}
export function choosePreviewRevision(progress: PreviewProgress, from: string, execution: string): void {
  if (progress.execution !== execution) throw Error('This execution is outdated. Reload the task.')
  const saved = progress.revisionBase ?? progress.stages
  const at = saved.findIndex((stage) => stage.id === from)
  if (at < 0) throw Error('Unknown stage.')
  if (saved.slice(0, at).some(stage => stage.status !== 'confirmed')) throw Error('Wait for user approval before starting the next stage.')
  progress.archivedSelections = [...progress.archivedSelections ?? [], structuredClone(saved)]
  progress.stages = structuredClone(saved)
  progress.generation++
  for (const stage of progress.stages.slice(at)) { stage.status = 'stale'; delete stage.confirmation }
  progress.currentStageId = from
  progress.displayedArtifact = progress.stages.slice(0, at).at(-1)?.artifact ?? null
  delete progress.revisionBase
  previewBaseline(progress, from, execution)
}

export function resetPreviewSelection(progress: PreviewProgress): void {
  progress.archivedSelections = [...progress.archivedSelections ?? [], structuredClone(progress.stages)]
  progress.generation++
  progress.stages = []
  progress.currentStageId = null
  progress.execution = null
  progress.displayedArtifact = null
  delete progress.revisionBase
}


export function syncPreviewContent(progress: PreviewProgress, body: string, assets: Record<string, unknown>): void {
  let stage = progress.stages.find(stage => stage.id === progress.currentStageId)
  if (stage?.status === 'queued' && progress.displayedArtifact) stage = progress.stages.find(item => item.id === progress.displayedArtifact!.stageId)
  if (!stage || !stage.artifact && !body.trim() && !Object.keys(assets).length) return
  if (stage.artifact?.body === body && JSON.stringify(stage.artifact.assets) === JSON.stringify(assets)) return
  const artifact = { stageId: stage.id, version: (stage.version ?? 0) + 1, body, assets: structuredClone(assets) }
  stage.version = artifact.version
  stage.artifact = artifact
  stage.history = [...stage.history ?? [], artifact]
  if (['confirmed', 'ready', 'awaiting_confirmation'].includes(stage.status)) stage.status = 'running'
  delete stage.confirmation
  const at = progress.stages.indexOf(stage)
  if (progress.currentStageId !== stage.id) {
    progress.currentStageId = stage.id
    progress.execution = null
    progress.generation++
    for (const next of progress.stages.slice(at + 1)) { next.status = 'stale'; delete next.confirmation }
  }
  progress.displayedArtifact = artifact
}

export function reportPreviewStage(progress: PreviewProgress, stageId: string, status: 'running' | 'done', execution: string): PreviewBaseline {
  if (!progress.stages.length) selectPreviewStages(progress, [stageId])
  if (progress.currentStageId !== stageId) throw Error('Wait for user approval before starting the next stage.')
  const baseline = previewBaseline(progress, stageId, execution)
  const stage = progress.stages.find(stage => stage.id === stageId)!
  if (status === 'done') {
    if (stage.status !== 'confirmed') stage.status = progress.stages.at(-1)?.id === stageId ? 'ready' : 'awaiting_confirmation'
  } else if (stage.status !== 'confirmed') stage.status = 'running'
  return baseline
}
