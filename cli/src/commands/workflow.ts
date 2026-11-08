// ---- workflow --------------------------------------------------------------
//
// The workflows this board runs, from a terminal (#715). They are Cloud's (#409); `pull` and
// `push` edit the workspace's own as a folder (#544).

import fs from 'node:fs'
import path from 'node:path'

import { findSpecAgent } from '../lib/agents'
import { locate } from '../lib/cards'
import { say } from '../lib/io'
import { ASSETS, die } from '../lib/paths'
import { workflowDiagram } from '../lib/agent/workflow-diagram'
import { NEEDS_CLOUD, cloudFlows, workflowsOffline, workflowsReachable, type WorkflowFiles } from '../lib/agent/cloud-workflows'
import {
  workflowPurpose,
  workflowWhen,
  agentAfter,
  previewMembers,
  scheduledMembers,
  listedScheduled,
  renameWorkflow,
  workflowById,
  workflowFileProblems,
  workflowProblems,
  workflows,
  type WorkflowHelper,
} from '../lib/agent/workflows'
import type { MoveResult } from '../lib/types'
import { readWorkflowFolder } from '../lib/agent/workflow-folder'
import { checkWorkflowFiles, isAboutFile } from '../lib/shared/workflow-files'
import { workflowName } from '../lib/shared/board-files'
import { call } from '../lib/cloud/tasks'

const found = (id: string) => {
  const flow = workflowById(id)
  if (!flow) {
    die(`no workflow called "${id}" here. There are: ${workflows().map((w) => w.id).join(', ')}.`, {
      kind: 'no-such-workflow',
      workflow: id,
    })
  }
  return flow!
}

const done = (res: { ok: boolean; error?: string; reason?: string }): void => {
  if (!res.ok) die(res.error ?? 'the board refused that change', res.reason === 'workflowReadOnly' ? 'workflow-read-only' : undefined)
}

const names = (rows: WorkflowHelper[]): string => rows.map((h) => `${h.agent}${h.off ? ' (off)' : ''}`).join(', ')

// A preview with the approvals it waits on (#2154).
const previewNames = (rows: WorkflowHelper[]): string =>
  rows.map((h) => `${names([h])}${agentAfter(h.agent).length ? ` (after ${agentAfter(h.agent).join(', ')})` : ''}`).join(', ')

export function cmdWorkflowList(): MoveResult {
  if (!workflowsReachable().ok) die(NEEDS_CLOUD, 'needs-cloud')
  const offline = workflowsOffline()
  const rows = workflows()
  for (const flow of rows) {
    const previews = previewNames(previewMembers(flow))
    const land = names(flow.land)
    const line = [flow.id, flow.name, ...(previews ? [`previews: ${previews}${land ? ` → land: ${land}` : ''}`] : land ? [`land: ${land}`] : [])]
    say(`${line.join('  ')}${offline ? '  (offline)' : ''}`)
    for (const agent of listedScheduled(flow)) say(`  scheduled: ${agent}`)
    for (const problem of workflowProblems(flow.id)) say(`  ! ${problem}`)
  }
  const fileProblems = workflowFileProblems()
  for (const problem of fileProblems) say(`! ${problem}`)
  return {
    workflows: rows.map((flow) => ({
      ...flow,
      previews: previewMembers(flow).map((h) => ({ ...h, after: agentAfter(h.agent) })),
      scheduled: listedScheduled(flow),
      description: workflowPurpose(flow),
      when: workflowWhen(flow),
      problems: workflowProblems(flow.id),
    })),
    problems: fileProblems,
    ...(offline ? { offline } : {}),
  }
}

export function cmdWorkflowRename(id: string, name: string): MoveResult {
  done(renameWorkflow(id, name))
  say(`renamed ${id} to "${name.trim()}"`)
  return { id, name: name.trim() }
}

export function cmdWorkflowDiagram(id: string, card: string): MoveResult {
  const flow = found(id)
  const cardId = Number(card)
  if (!Number.isInteger(cardId) || !locate(cardId)) die(`no card #${card} on this board`, 'no-such-card')
  const diagram = workflowDiagram({ previews: previewMembers(flow), land: flow.land, scheduled: scheduledMembers(flow) }, (name) => {
    const agent = findSpecAgent(name)
    return agent ? { ...agent, after: agentAfter(name) } : null
  })
  const file = path.join(ASSETS, String(cardId), 'workflow.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(diagram, null, 2)}\n`)
  const tag = `<Workflow src=".assets/${cardId}/workflow.json" label="${flow.name.replace(/"/g, '')}" />`
  say(tag)
  return { file, tag, diagram }
}

// What `pull` leaves in the folder for `push`: which workflow, at which version.
const PULLED = '.akb-workflow.json'

const cloudIdOf = (id: string): string | undefined => cloudFlows().find((f) => workflowName(f.cloudId) === id)?.cloudId

/** `akb workflow pull <id> [folder]` (#544): the workflow's current version as a folder. */
export async function cmdWorkflowPull(id: string, folder?: string): Promise<MoveResult> {
  const cloudId = cloudIdOf(id)
  if (!cloudId) found(id)
  const dir = path.resolve(folder ?? id)
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) die(`${folder ?? id} is not empty`, 'bad-args')
  const read = await call<{ id: string; version: number; files: WorkflowFiles }>('GET', `/v1/workflows/${encodeURIComponent(cloudId!)}`)
  if (!read.ok) die(read.error, read.code === 'not_found' ? 'no-such-workflow' : 'cloud-refused')
  const { version, files } = read.value
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(dir, ...file.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    const data = isAboutFile(file) && !file.endsWith('.md') && /^data:[^;]+;base64,/.exec(text)
    fs.writeFileSync(full, data ? Buffer.from(text.slice(data[0].length), 'base64') : text)
  }
  fs.writeFileSync(path.join(dir, PULLED), `${JSON.stringify({ id: cloudId, version })}\n`)
  const shown = folder ?? `./${id}`
  say(`Pulled ${id} v${version} into ${shown}.`)
  return { id, version, folder: dir }
}

/** `akb workflow push <folder>` (#544): a pulled folder as the workflow's next version. */
export async function cmdWorkflowPush(folder: string, opts: { dryRun?: boolean }): Promise<MoveResult> {
  const dir = path.resolve(folder)
  let pulled: { id: string; version: number } | null = null
  try {
    pulled = JSON.parse(fs.readFileSync(path.join(dir, PULLED), 'utf8'))
  } catch {}
  if (!pulled?.id || !Number.isInteger(pulled.version)) die(`${folder} was not written by \`akb workflow pull\``, 'bad-args')
  const { id: cloudId, version } = pulled!
  const id = workflowName(cloudId)
  const readOnly = () => die(`${id} is not this workspace's own; copy it on the web first.`, 'workflow-read-only')
  if (cloudId.startsWith('wf_builtin_')) readOnly()
  const files = readWorkflowFolder(dir)
  const checked = checkWorkflowFiles(files)
  if (!checked.ok) die(`${checked.file} ${checked.reason}`, 'bad-workflow')
  const now = await call<{ version: number; files: WorkflowFiles }>('GET', `/v1/workflows/${encodeURIComponent(cloudId)}`)
  if (!now.ok) die(now.error, now.code === 'not_found' ? 'no-such-workflow' : 'cloud-refused')
  if (now.value.version !== version) die(`${id} is at v${now.value.version} now; pull again and redo the change.`, 'workflow-moved')
  if (JSON.stringify(files) === JSON.stringify(Object.fromEntries(Object.entries(now.value.files).sort()))) {
    say(`${id} is unchanged (v${version}).`)
    return { id, version, changed: false, ...(opts.dryRun ? { dryRun: true } : {}) }
  }
  if (opts.dryRun) {
    say(`${id} would push v${version + 1}.`)
    return { id, version: version + 1, changed: true, dryRun: true }
  }
  const res = await call<{ version: number }>('PATCH', `/v1/workflows/${encodeURIComponent(cloudId)}`, { files })
  if (!res.ok) {
    // Installed from the marketplace: another workspace's, so Cloud does not find it to change.
    if (res.code === 'read_only' || res.code === 'not_found') readOnly()
    die(res.error, res.code === 'bad_request' || res.code === 'payload_too_large' ? 'bad-workflow' : 'cloud-refused')
  }
  const next = res.value.version
  fs.writeFileSync(path.join(dir, PULLED), `${JSON.stringify({ id: cloudId, version: next })}\n`)
  say(`Pushed ${id} v${next}. New tasks take it.`)
  return { id, version: next, changed: true }
}
