import { createHash } from 'node:crypto'

import { studioName } from '../shared/board-files'
import { reviewAuthorization, type TaskReview } from '../shared/review-plan'

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

export function compactReview(review: TaskReview, assigned?: readonly string[]): string {
  const authorization = reviewAuthorization(review, assigned)
  if (authorization.kind === 'changed') return 'Review r' + review.revision + ' · authorization changed. Read the task again.'
  if (!review.stages.length) return 'Review · ' + (review.plan === null ? 'planning only' : 'no extra review')
  const starts = new Map(review.approvals?.map(action => [action.stage, action.starts]))
  const unlocked = new Set(authorization.kind === 'stages' ? authorization.nodes.map(node => node.id) : [])
  const stages = review.stages.map(stage => {
    const next = starts.get(stage.id)
    const status = stage.status === 'ready'
      ? next?.length ? 'ready for approval and start ' + next.join(', ') : 'ready for approval'
      : stage.status === 'available' ? unlocked.has(stage.id) ? 'available to start' : 'not dispatched'
      : stage.status === 'running' && assigned && !unlocked.has(stage.id) ? 'running outside this dispatch' : stage.status
    return stage.id + ' ' + status
  })
  return ['Review r' + review.revision, ...stages].join(' · ')
}

export const configurationBlock = (text: string): ContextBlock => ['config', text, 'Studio configuration cleared.']

export function reviewBlock(text: string, review: TaskReview | undefined, previous?: SentContext): ContextBlock {
  return ['review', previous?.review && /^Review (?:r\d+|·)/.test(text) ? text.replace(/^Review/, 'Review updated') : text,
    'Review context cleared. Read the current task.', text && JSON.stringify([text, review?.revision, review?.stages.map(stage => stage.revision)])]
}

export const contextAction = (action: string): string =>
  action === 'clarify' ? 'refine' : action === 'edit' ? 'revise' : action
