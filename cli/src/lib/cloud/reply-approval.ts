import { BoardError, say } from '../io'
import { cloudError, hasText, requireResponse } from './response'
import { die } from '../paths'
import type { MoveResult } from '../types'

export const REPLY_APPROVAL_ENV = 'AI4KANBAN_REPLY_APPROVAL'

export async function approveAfterReply(task: string, comment?: string, target?: { stage?: string; review_revision: number }): Promise<MoveResult | null> {
  const context = process.env[REPLY_APPROVAL_ENV]
  if (!context) return null
  try {
    const { url, token } = JSON.parse(context) as { url: string; token: string }
    if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url) || !/^[a-f0-9]{64}$/.test(token)) throw Error('Invalid reply context.')
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ task, comment, ...target }), signal: AbortSignal.timeout(120_000) })
    const result = await response.json() as { ok: boolean; error?: string; value?: { id: string; status: string; task: string; reason?: string } }
    if (!response.ok || result?.ok === false) throw cloudError({ code: 'refused', message: result?.error ?? 'The request was not accepted.', retryable: false })
    const held = requireResponse(result?.value, 'a reply approval receipt',
      value => !!value && hasText(value.id) && hasText(value.task) && ['pending', 'committed', 'cancelled'].includes(value.status))!
    if (held.status === 'cancelled') throw Error(held.reason ?? 'The request was cancelled. Ask again in a new reply.')
    say(held.status === 'pending' ? `Approval pending for ${task}; it will be checked after this reply finishes.` : `Approval already committed for ${task}.`)
    return { ...held, pending: held.status === 'pending' }
  } catch (e) { if (e instanceof BoardError) throw e; return die(e instanceof Error ? e.message : 'Reply approval failed.', { kind: 'refused' }) }
}
