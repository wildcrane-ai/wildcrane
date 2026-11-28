import { createHash } from 'node:crypto'

import { studioName } from '../shared/board-files'
import { isFlatReviewPlan, isWaitingReview, reviewAuthorization, type AgentReview, type TaskReview } from '../shared/review-plan'

export type SentContext = Record<string, string>
export type ContextBlock = [key: string, text: string, cleared?: string, identity?: string]

export const contextFingerprint = (text: string) => createHash('sha256').update(text).digest('hex')

export function contextUpdate(previous: SentContext | undefined, blocks: readonly ContextBlock[]) {
  const sent = { ...previous }
  const parts: string[] = []
  for (const [key, text, cleared, identity] of blocks) {
    const fingerprint = text ? contextFingerprint(identity ?? text) : ''
    if (sent[key] === fingerprint) continue
    if (text) parts.push(text)
    else if (sent[key] && cleared) parts.push(cleared)
    sent[key] = fingerprint
  }
  return { parts, sent }
}

export const taskCardBlock = (card: string): ContextBlock => ['card', 'Task card: ' + card]
export const taskChatGuide = 'Follow `akb guide card-chat`.'

export function studioEntry(id: string, name: string, version: number, action: string, command = 'akb studio file'): ContextBlock {
  const read = action === 'chat' ? ' before revising a draft'
    : action === 'refine' ? ' before planning' : ' for this task’s Studio instructions'
  return ['studio', 'Studio: ' + name + '. Read `' + command + ' ' + studioName(id) + ' STUDIO.md`' + read + '.', undefined, JSON.stringify([id, name, version, command])]
}

export function compactReview(review: AgentReview, assigned?: readonly string[]): string {
  if (isFlatReviewPlan(review.plan)) {
    const pending = (review.approvals ?? []).filter(approval => 'preview' in approval)
    return [
      'Review · flat plan',
      'Selected Previews: ' + (review.plan.previews.join(', ') || 'none'),
      'Review rule: ' + (review.plan.rule || 'No extra approval.'),
      ...(pending.length ? ['Pending approvals:', ...pending.map(({ preview, stage, question }) =>
        `- ${preview} · ${stage} · ${question}`)] : []),
    ].map(line => line.replace(/[\r\n]+/g, ' ')).join('\n')
  }
  const authorization = reviewAuthorization(review, assigned)
  if (authorization.kind === 'changed') return 'Review · authorization changed. Read the task again.'
  const custom = review.preview_definitions?.length
    ? '\nCustom Previews: ' + review.preview_definitions.map(d => d.id).join(', ')
    : ''
  if (!review.stages.length) return 'Review · ' + (review.plan === null ? 'planning only' : 'no extra review') + custom
  const nodePreviews = new Map((review.plan ?? []).map(node => [node.id, node.previews]))
  const starts = new Map(review.approvals?.map(action => [action.stage, 'starts' in action ? action.starts : []]))
  const unlocked = new Set(authorization.kind === 'stages' ? authorization.nodes.map(node => node.id) : [])
  const stages = review.stages.map(stage => {
    const next = starts.get(stage.id)
    const previews = nodePreviews.get(stage.id)
    const previewNote = previews?.length ? ` (previews: ${previews.join(', ')})` : ''
    const status = isWaitingReview(stage.status)
      ? next?.length ? 'waiting for approval to start ' + next.join(', ') : 'waiting for approval'
      : stage.status === 'available' ? unlocked.has(stage.id) ? 'available to start' : 'not dispatched'
      : stage.status === 'running' && assigned && !unlocked.has(stage.id) ? 'running outside this dispatch' : stage.status
    return stage.id + previewNote + ' ' + status
  })
  return ['Review', ...stages].join(' · ') + custom
}

export const configurationBlock = (text: string): ContextBlock => ['config', text, 'Studio configuration cleared.']

export function reviewFingerprint(review: TaskReview): string {
  return contextFingerprint(JSON.stringify([review.revision, review.stages.map(stage => stage.revision)]))
}

export function reviewBlock(text: string, fingerprint?: string, previous?: SentContext): ContextBlock {
  return ['review', previous?.review && /^Review ·/.test(text) ? text.replace(/^Review/, 'Review updated') : text,
    'Review context cleared. Read the current task.', text && JSON.stringify([text, fingerprint])]
}

export const contextAction = (action: string): string =>
  action === 'clarify' ? 'refine' : action === 'edit' ? 'revise' : action
