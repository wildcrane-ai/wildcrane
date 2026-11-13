import { REPLY_APPROVAL_ENV } from '../lib/cloud/reply-approval'
import { PREVIEW_BRIDGE_ENV } from '../lib/cloud/preview'
import { randomUUID } from 'node:crypto'
import { confirmPreviewStage } from '../lib/preview-stages'
import { readPreviewProgress, updatePreviewProgress } from '../lib/agent/preview-progress'
import { insideRun } from '../lib/agent/env'
import { startRun } from '../lib/agent/start'
import { readRuns, askForSpec, titleOf } from '../lib/agent/sessions'
import { cloud, taskApprove } from './task'
import { runnerProject } from '../lib/cloud/tasks'
import { KANBAN } from '../lib/paths'
import { die } from '../lib/paths'
import { say } from '../lib/io'
import type { MoveResult } from '../lib/types'

export interface PreviewConfirmOptions { preview?: string; previewStage?: string; previewVersion?: string; definitionRevision?: string }
export function previewConfirmation(opts: PreviewConfirmOptions) {
  if (!opts.preview || !opts.previewStage || !opts.definitionRevision || !/^[1-9]\d*$/.test(opts.previewVersion ?? '')) throw Error('Preview confirmation needs --preview, --preview-stage, --preview-version and --definition-revision.')
  return { decision: 'confirm_preview', preview_agent: opts.preview, preview_stage: opts.previewStage, preview_version: Number(opts.previewVersion), definition_revision: opts.definitionRevision }
}
export async function confirmLocalPreview(id: number, opts: PreviewConfirmOptions): Promise<MoveResult> {
  try {
    if (insideRun() || process.env[REPLY_APPROVAL_ENV] || process.env[PREVIEW_BRIDGE_ENV]) throw Error('Only the user confirms a preview stage.')
    const fields = previewConfirmation(opts)
    const project = runnerProject(KANBAN)
    if (project) {
      const held = await cloud<{ prefix: string }>('GET', `/v1/projects/${encodeURIComponent(project)}`)
      return taskApprove(`${held.prefix}-${id}`, undefined, opts)
    }
    const old = readPreviewProgress(id)[fields.preview_agent]
    if (!old) throw Error('This preview has no saved stages.')
    const action = randomUUID()
    const result = updatePreviewProgress(id, (all) => confirmPreviewStage(all[fields.preview_agent]!, fields.preview_stage, fields.preview_version, fields.definition_revision, action))
    if (result.action === action) {
      const parent = readRuns().find((run) => run.cardId === id && run.status === 'running')
      if (parent && askForSpec(parent.sessionId, { specAgent: fields.preview_agent, cardId: id }) !== 'no-run') {
        say('Preview confirmed; continuation queued after the active run.')
        return result
      }
      const started = await startRun({ action: 'spec', id, title: titleOf(id), specAgent: fields.preview_agent })
      if ('error' in started || !started.spawned) throw Error('error' in started ? started.error : 'The preview continuation could not start. Resume the task.')
    }
    say('Preview confirmed; continuation queued.')
    return result
  } catch (error) { return die(error instanceof Error ? error.message : 'Preview confirmation failed.', { kind: 'preview-refused' }) }
}

export async function resetPreviewScope(id: number, agent: string, comment?: string): Promise<MoveResult> {
  if (insideRun() || process.env[REPLY_APPROVAL_ENV] || process.env[PREVIEW_BRIDGE_ENV]) return die('Only an explicit user action can reset the preview scope.', { kind: 'preview-refused' })
  const project = runnerProject(KANBAN)
  if (project) {
    const held = await cloud<{ prefix: string }>('GET', `/v1/projects/${encodeURIComponent(project)}`)
    const task = await cloud<{ id: string; review: { revision: number } | null; previewReviewRevision?: number; previewProgress: Record<string, { definitionRevision: string }> }>('GET', `/v1/tasks/${held.prefix}-${id}`)
    const progress = task.previewProgress[agent]
    if (!progress) return die('This preview has no stages.', { kind: 'preview-refused' })
    return cloud('POST', `/v1/tasks/${task.id}/decisions`, { decision: 'request_changes', preview_reset: true, preview_agent: agent, definition_revision: progress.definitionRevision, review_revision: task.previewReviewRevision ?? task.review?.revision ?? 0, comment })
  }
  const { resetPreviewSelection } = await import('../lib/preview-stages')
  const { readRuns } = await import('../lib/agent/store')
  const { stopRun } = await import('../lib/agent/sessions')
  for (const run of readRuns().filter((run) => run.cardId === id && run.specAgent === agent && run.status === 'running')) await stopRun(run.sessionId)
  updatePreviewProgress(id, (all) => {
    if (!all[agent]) throw Error('This preview has no stages.')
    resetPreviewSelection(all[agent])
  })
  const started = await startRun({ action: 'spec', id, title: titleOf(id), specAgent: agent, notes: comment })
  if ('error' in started) return die(started.error, { kind: 'preview-refused' })
  say('Preview scope reset; stage selection queued.')
  return { sessionId: started.run.sessionId }
}
