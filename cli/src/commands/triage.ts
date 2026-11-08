// `akb triage add` writes one item from words the caller already has (#534); `check` says
// where a source id already is (#559). Nothing in triage is a task.

import fs from 'node:fs'

import { runAgent } from '../lib/agent/scheduled'
import { knownWorkflow } from '../lib/agent/workflows'
import { addToInbox, checkSource, migrateTriage } from '../lib/signals'
import { say } from '../lib/io'
import { die } from '../lib/paths'
import type { MoveResult } from '../lib/types'

/** `akb triage add`, as its command declares it. */
export interface TriageAddOptions {
  title?: string
  text?: string
  file?: string
  source?: string
  slug?: string
  workflow?: string
}

/** Write one item into triage. The body comes from `--text` for a line or two and from
 *  `--file` when it is longer, the same pair other writes take. */
export async function cmdTriageAdd(opts: TriageAddOptions): Promise<MoveResult> {
  const title = (opts.title ?? '').trim()
  if (!title) die('say what it is: --title "<one line>"', { kind: 'needs-input' })
  if (opts.file !== undefined && opts.text !== undefined) die('pass --file or --text, not both', { kind: 'needs-input' })
  if (!opts.workflow?.trim()) die('say which workflow does it: --workflow <id> (`akb workflow list`)', { kind: 'needs-input' })
  const workflow = knownWorkflow(opts.workflow!)

  let body = opts.text
  if (opts.file !== undefined) {
    try {
      body = fs.readFileSync(opts.file, 'utf8')
    } catch {
      die(`can't read ${opts.file} — write the item to a file, then pass its path`, { kind: 'needs-input' })
    }
  }
  if (!body?.trim()) {
    die('the item has to say something: --text ".." , or --file <path> for a longer one', { kind: 'needs-input' })
  }

  const agent = runAgent()
  const done = addToInbox({ title, text: body, source: opts.source, slug: opts.slug, workflow, ...(agent ? { agent } : {}) })
  if (!done.ok) die(done.error, { kind: 'triage-item-refused' })
  say(`added to triage: ${done.signal.relPath}`)
  return { title: done.signal.title, source_id: done.signal.sourceId, file: done.signal.relPath }
}

/** `akb triage check` — where triage already holds one source id, if it holds it at all.
 *
 *  The answer the three ways in share, said out loud so a caller can ask it before writing.
 *  `unseen` is an answer and never a failure: it is what most ids are. */
export function cmdTriageCheck(sourceId: string): MoveResult {
  const said = sourceId.trim()
  if (!said) die('say which one: `check <source-id>`', { kind: 'needs-input' })
  migrateTriage()
  const hit = checkSource(said)
  say(hit.status === 'unseen' ? `${said} — unseen` : `${said} — ${hit.status}: ${hit.relPath}`)
  return { source_id: said, status: hit.status, file: hit.relPath || null }
}
