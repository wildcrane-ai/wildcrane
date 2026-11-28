import fs from 'node:fs'
import { runAgent } from '../lib/agent/project-agent'
import { insideRun } from '../lib/agent/env'
import { peekRun } from '../lib/agent/sessions'
import { cardStudio, knownStudio } from '../lib/agent/studios'
import { executionOf } from '../lib/cloud/execution'
import { confirmRunnerBinding } from '../lib/cloud/runner-binding'
import { call, workspaceTask } from '../lib/cloud/tasks'
import { addToInbox, checkSource, migrateTriage } from '../lib/signals'
import { triageDecisionOf } from '../lib/shared/triage-files'
import { say } from '../lib/io'
import { die, KANBAN } from '../lib/paths'
import type { MoveResult } from '../lib/types'

export interface TriageAddOptions {
  title?: string
  text?: string
  file?: string
  source?: string
  slug?: string
  studio?: string
  decision?: string
}

async function submit(fields: Record<string, unknown>): Promise<MoveResult> {
  const run = executionOf()
  if (!run) die('A held Runner job is required to submit a triage decision.', { kind: 'triage-item-refused' })
  const result = await call<MoveResult>('POST', `/v1/runner/jobs/${run!.job}/triage`, { ...fields, machineId: run!.machine })
  if (!result.ok) die(result.error, { kind: 'triage-item-refused', ...(result.code ? { code: result.code } : {}) })
  return result.value
}

export async function cmdTriageAdd(opts: TriageAddOptions, prepare?: (check?: () => void) => Promise<void>): Promise<MoveResult> {
  const title = opts.title?.trim()
  if (!title) die('say what it is: --title "<one line>"', { kind: 'needs-input' })
  if (opts.file !== undefined && opts.text !== undefined) die('pass --file or --text, not both', { kind: 'needs-input' })
  let body = opts.text
  if (opts.file !== undefined) {
    try {
      body = fs.readFileSync(opts.file, 'utf8')
    } catch {
      die(`can't read ${opts.file} — write the item to a file, then pass its path`, { kind: 'needs-input' })
    }
  }
  if (!body?.trim()) die('the item has to say something: --text ".." or --file <path>', { kind: 'needs-input' })

  const session = insideRun()
  const run = session ? peekRun(session) : undefined
  const agent = runAgent()
  const proposal = agent === 'proposer' || !!workspaceTask() || run?.cardId != null
  const submits = proposal || opts.decision !== undefined
  const check = submits ? undefined : await confirmRunnerBinding(KANBAN)
  if (prepare) await prepare(check)
  else check?.()
  const studio = opts.studio?.trim() ? knownStudio(opts.studio) : undefined
  if (submits) {
    const decision = triageDecisionOf(opts.decision)
    const number = Number(/^#([1-9]\d{0,9})$/.exec(opts.source?.trim() ?? '')?.[1])
    if ((decision !== 'plan' && decision !== 'review') || !Number.isSafeInteger(number) || !studio) {
      die('Follow-ups need --source "#<card>", --studio <id>, and --decision <plan|review>.', { kind: 'needs-input' })
    }
    const source = cardStudio(number)
    if (!source?.allowedFollowUps || source.id !== studio) {
      die('The source card must use a Studio that allows follow-ups.', { kind: 'triage-item-refused' })
    }
    const result = await submit({ action: 'add', title, text: body, number, studio, decision, slug: opts.slug })
    say(`added to triage: ${result.file}`)
    return { title, ...result }
  }

  const done = addToInbox({ title, text: body, source: opts.source, slug: opts.slug, studio, ...(agent ? { agent } : {}) })
  if (!done.ok) die(done.error, { kind: 'triage-item-refused' })
  say(`added to triage: ${done.signal.relPath}`)
  return { title: done.signal.title, source_id: done.signal.sourceId, file: done.signal.relPath }
}

export async function cmdTriageDecide(sourceId: string, opts: { decision: string; reason: string; studio?: string }): Promise<MoveResult> {
  const source = sourceId.trim()
  const decision = triageDecisionOf(opts.decision)
  const reason = opts.reason.trim()
  if (!source || !decision || !reason) die('Give a source id, decision, and reason.', { kind: 'needs-input' })
  const result = await submit({ action: 'decide', source, decision, reason, studio: opts.studio })
  say(`recorded ${decision} for ${source}`)
  return { source_id: source, ...result }
}

export function cmdTriageCheck(sourceId: string): MoveResult {
  const said = sourceId.trim()
  if (!said) die('say which one: `check <source-id>`', { kind: 'needs-input' })
  migrateTriage()
  const hit = checkSource(said)
  say(hit.status === 'unseen' ? `${said} — unseen` : `${said} — ${hit.status}: ${hit.relPath}`)
  return { source_id: said, status: hit.status, file: hit.relPath || null }
}
