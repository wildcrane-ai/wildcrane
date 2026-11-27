import fs from 'node:fs'
import path from 'node:path'

import type { TaskReview } from '../../cli/src/lib/shared/review-plan'
import type { Goal } from '../../cli/src/lib/shared/goal'
import type { Job, ReplyContext, ReplyHistoryMessage } from './api'
import { compactReview, contextFingerprint, contextUpdate, reviewBlock, taskCardBlock, taskChatGuide, type ContextBlock, type SentContext } from '../../cli/src/lib/agent/runtime-context'

const empty = contextFingerprint('')
const chatGuide: ContextBlock = ['card-chat', taskChatGuide]

export function replyPrompt(input: NonNullable<Job['replyInput']>, turn: {
  initialize: boolean
  historyFile?: string
  task?: { card: string; review?: TaskReview; blocks: ContextBlock[]; previous?: SentContext }
  goals?: Goal[]
  diagnostics: string[]
  attachments: string
  continuation?: string
}): { prompt: string; withAttachments: string; context?: ReplyContext; sent?: SentContext; reviewRevision?: number } {
  const parts = [...turn.diagnostics]
  if (turn.continuation) {
    const prompt = [...parts, turn.task && taskChatGuide, turn.continuation].filter(Boolean).join('\n\n')
    return { prompt, withAttachments: prompt }
  }

  const { task } = turn
  let sent: SentContext | undefined
  if (task) {
    const prior = input.previousContext
    const previous = task.previous ?? (!turn.initialize && prior ? {
      review: prior.review === empty ? '' : prior.review,
      config: prior.setup === empty ? '' : prior.setup,
    } : undefined)
    const review = task.review ? compactReview(task.review) : ''
    const update = contextUpdate(previous, [
      chatGuide, taskCardBlock(task.card),
      ...task.blocks.filter(([key]) => key === 'studio' || key === 'studio-previews' || key === 'skills'),
      ['history', turn.historyFile ? 'Consult the chat history at `' + turn.historyFile + '` as needed.' : ''],
      reviewBlock(review, task.review, previous),
      ...task.blocks.filter(([key]) => key === 'setup' || key === 'config'),
    ])
    parts.push(...update.parts)
    sent = update.sent
  } else if (turn.initialize) {
    parts.push('Follow `akb guide discuss-goal` for this Goal discussion.')
    if (turn.historyFile) parts.push('Consult the discussion history at `' + turn.historyFile + '` as needed.')
    if (turn.goals) parts.push(replyGoals(turn.goals))
  }
  return {
    prompt: [...parts, input.body].filter(Boolean).join('\n\n'),
    withAttachments: [...parts, turn.attachments, input.body].filter(Boolean).join('\n\n'),
    sent,
    context: sent && { review: sent.review || empty, setup: sent.config || empty },
    reviewRevision: task?.review?.revision,
  }
}

export function writeReplyHistory(dir: string, messages: ReplyHistoryMessage[] | string): string | undefined {
  const history = typeof messages === 'string' ? messages : messages.map(({ role, body, image_names }) => {
    const pictures = image_names?.length ? `[Pictures: ${image_names.join(', ')}]` : ''
    return `${role === 'user' ? 'User' : 'Agent'}: ${[body, pictures].filter(Boolean).join('\n\n')}`
  }).join('\n\n')
  if (!history) return
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(fs.mkdtempSync(path.join(dir, 'context-')), 'history.md')
  fs.writeFileSync(file, history + '\n', { mode: 0o400, flag: 'wx' })
  return file
}

function replyGoals(goals: Goal[]): string {
  if (!goals.length) return 'No goals yet.'
  return ['Current Goals:', ...goals.slice(0, 10).map(goal =>
    `- ${goal.id} · ${goal.title} · ${goal.studio} · ${goal.task ? 'started as ' + (goal.task.key ?? goal.task.id) : 'not started'}`,
  )].join('\n')
}
