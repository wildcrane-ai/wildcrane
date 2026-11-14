import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { locate, locateArchived } from '../lib/cards'
import { parseFrontmatter } from '../lib/frontmatter'
import { say } from '../lib/io'
import { BOARD_STATE, KANBAN, REPO_ROOT, SESSIONS, die, rel } from '../lib/paths'
import { executionOf } from '../lib/cloud/execution'
import { bodySources } from '../../../artifact-sdk/src/internal/references'
import type { PreviewProgress } from '../lib/preview-stages'
import type { DeliveryRecord, RunRecord } from '../lib/agent/types'

export function cmdInspect(id: number) {
  const findings: { source: string; message: string }[] = []
  const unavailable: string[] = []
  function read<T>(source: string, file: string, empty: T): T {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty
      findings.push({ source, message: String(error) }); unavailable.push(source)
      return empty
    }
  }
  function fact<T>(source: string, get: () => T, empty: T): T {
    try { return get() } catch (error) { findings.push({ source, message: String(error) }); unavailable.push(source); return empty }
  }
  const found = locate(id) ?? locateArchived(id)
  if (!found) return die(`no task with id ${id}`, { kind: 'card-not-found', id })
  const file = found.kind === 'group' ? path.join(found.target, 'root.md') : found.target
  let card = null
  try {
    const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
    if (!meta) throw Error('The card frontmatter could not be parsed.')
    card = { path: rel(file), questions: meta.questions, todos: [...body.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/gm)].map((m) => ({ text: m[2]!, done: m[1] !== ' ' })) }
  } catch (error) { findings.push({ source: 'card', message: String(error) }); unavailable.push('card') }
  const progress = read<Record<string, PreviewProgress>>('previews', path.join(BOARD_STATE, 'previews', `${id}.json`), {})
  const store = read<{ runs?: RunRecord[]; deliveries?: DeliveryRecord[] }>('runs', SESSIONS, {})
  const runs = fact('runs', () => (store.runs ?? []).filter((run) => run.cardId === id).slice(-10).reverse().map((run) => ({ id: run.sessionId, status: run.status, sessionRecorded: run.harness ? !!(run.resumeId || run.continues?.resumeId) : null })), [])
  const records: DeliveryRecord[] = []
  const directory = path.join(KANBAN, 'deliveries')
  try {
    for (const name of fs.readdirSync(directory).filter((name) => name.endsWith('.json'))) {
      const held = read<DeliveryRecord | null>('delivery', path.join(directory, name), null)
      if (held?.cardId === id) records.push(held)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { findings.push({ source: 'delivery', message: String(error) }); unavailable.push('delivery') }
  }
  records.push(...fact('delivery', () => (store.deliveries ?? []).filter((held) => held.cardId === id), []))
  const held = [...new Map(records.map((held) => [held.deliveryId, held])).values()].sort((a, b) => b.startedAt - a.startedAt)[0]
  const job = executionOf()?.job
  const checkpoint = job ? read<{ pending?: string[]; submitted?: boolean } | null>('recovery', path.join(process.env.WILDCRANE_HOME || os.homedir() + '/.wildcrane', 'checkpoints', `${encodeURIComponent(job)}.json`), null) : null
  const delivery = fact('delivery', () => held ? { id: held.deliveryId, status: held.status, directory: held.worktree ?? REPO_ROOT, completedSteps: (held.completions ?? []).map((c) => c.step) } : null, null)
  const recovery = fact('recovery', () => checkpoint ? { pendingOperations: checkpoint.pending ?? [], submitted: checkpoint.submitted ?? null } : null, null)
  const result = { id, card, previews: fact('previews', () => Object.entries(progress).map(([agent, p]) => ({ agent, currentStageId: p.currentStageId,
    stages: p.stages.map(({ id, status, version }) => ({ id, status, version })), artifact: p.displayedArtifact ? { stageId: p.displayedArtifact.stageId, version: p.displayedArtifact.version, section: `## By \`${agent}\` agent`, files: [...new Set([...Object.keys(p.displayedArtifact.assets).filter((key) => key !== 'folder'), ...bodySources(p.displayedArtifact.body)])].filter((file) => !path.isAbsolute(file) && !/^[a-z][\w+.-]*:/i.test(file)) } : null })), []),
    delivery, runs, recovery,
    findings, unavailable: [...new Set(unavailable)] }
  say(JSON.stringify(result, null, 2))
  return result
}
