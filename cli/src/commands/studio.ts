// ---- studio --------------------------------------------------------------
//
// The studios this board runs, from a terminal (#715). They are Cloud's (#409); `pull` and
// `push` edit the workspace's own as a folder (#544).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { findSpecAgent } from '../lib/agents'
import { locate } from '../lib/cards'
import { say } from '../lib/io'
import { ASSETS, die } from '../lib/paths'
import { NEEDS_CLOUD, boardProject, cloudFlows, studiosOffline, studiosReachable, type StudioFiles } from '../lib/agent/cloud-studios'
import {
  studioPurpose,
  studioWhen,
  agentAfter,
  previewMembers,
  scheduledMembers,
  listedScheduled,
  studioById,
  studioFileProblems,
  studioProblems,
  studios,
  type StudioHelper,
} from '../lib/agent/studios'
import type { MoveResult } from '../lib/types'
import { readStudioFolder } from '../lib/agent/studio-folder'
import { checkStudioFiles, isAboutFile, VERSION_FILE, versionText, STUDIO_FILE, studioFilesProblems, hashInput, diagramFrom } from '../lib/shared/studio-files'
import { parseStudioFile } from '../lib/agent/studio-def'
import { studioName } from '../lib/shared/board-files'
import { call, type CloudCall } from '../lib/cloud/tasks'

const found = (id: string) => {
  const flow = studioById(id)
  if (!flow) {
    die(`no studio called "${id}" here. There are: ${studios().map((w) => w.id).join(', ')}.`, {
      kind: 'no-such-studio',
      studio: id,
    })
  }
  return flow!
}

export function cmdStudioList(): MoveResult {
  if (!studiosReachable().ok) die(NEEDS_CLOUD, 'needs-cloud')
  const rows = studios()
  for (const flow of rows) say(`${flow.id}  ${flow.name}  ${flow.previews.map(p => p.id).join(', ')}`)
  return { studios: rows.map(({ id, name, names, icon, needsArtifact, previews, description, builtIn }) => ({ id, name, names, icon, needsArtifact, previews, description, builtIn })), problems: studioFileProblems(), ...(studiosOffline() ? { offline: true } : {}) }
}

export function cmdStudioDiagram(_id: string, _card: string, _folder?: string): MoveResult {
  die('Studios have no agent graph. Read STUDIO.md for instructions and Preview outputs.', 'bad-args')
}

/** `akb raw studio validate <folder>` (#622): every problem in a studio folder, the agents it
 *  names but does not hold read from the board. */
export function cmdStudioValidate(folder: string): MoveResult {
  const dir = path.resolve(folder)
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) die(`${folder} is not a folder`, 'bad-args')
  const files = readStudioFolder(dir)
  let builtin = false
  try { builtin = JSON.parse(files[VERSION_FILE] ?? 'null')?.id?.startsWith('wf_builtin_') === true } catch {}
  const problems = studioFilesProblems(files, builtin)
  if (problems.length) die(problems.map((p) => `! ${p.file}:${p.line ?? 1}:${p.column ?? 1} ${p.path ?? ""} ${p.code ?? "studio-file"}: ${p.reason}. ${p.hint ?? ""}`).join('\n'), { kind: 'studio-problems', bare: true, problems })
  say(`${folder}: no problems`)
  const checked = checkStudioFiles(files, builtin)
  const fingerprint = checked.ok ? crypto.createHash('sha256').update(hashInput({ ...checked.files, ...(files[VERSION_FILE] ? { [VERSION_FILE]: files[VERSION_FILE] } : {}) })).digest('hex') : null
  return { folder: dir, problems, fingerprint }
}

const cloudIdOf = (id: string): string | undefined => cloudFlows().find((f) => studioName(f.cloudId) === id)?.cloudId

/** `akb studio pull <id> [folder]` (#544): the studio's current version as a folder. */
export async function cmdStudioPull(id: string, folder?: string): Promise<MoveResult> {
  const cloudId = cloudIdOf(id)
  if (!cloudId) found(id)
  const dir = path.resolve(folder ?? id)
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) die(`${folder ?? id} is not empty`, 'bad-args')
  const read = await call<{ id: string; version: number; files: StudioFiles }>('GET', `/v1/studios/${encodeURIComponent(cloudId!)}`)
  if (!read.ok) die(read.error, read.code === 'not_found' ? 'no-such-studio' : 'cloud-refused')
  const { version, files } = read.value
  for (const [file, text] of Object.entries({ ...files, [VERSION_FILE]: versionText(cloudId!, version) })) {
    const full = path.join(dir, ...file.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    const data = isAboutFile(file) && !file.endsWith('.md') && /^data:[^;]+;base64,/.exec(text)
    fs.writeFileSync(full, data ? Buffer.from(text.slice(data[0].length), 'base64') : text)
  }
  const shown = folder ?? `./${id}`
  say(`Pulled ${id} v${version} into ${shown}.`)
  return { id, version, folder: dir }
}

interface PublishOptions { dryRun?: boolean; requestId?: string; workspace?: string }

function publicationFiles(dir: string): StudioFiles {
  const checked = checkStudioFiles(readStudioFolder(dir))
  if (!checked.ok) die(`${checked.file} ${checked.reason}`, { kind: 'bad-studio', problems: checked.problems })
  return (checked as { files: StudioFiles }).files
}

interface Publication {
  requestId: string
  hash: string
  body: { files: StudioFiles; expectedVersion?: number; workspace?: string }
  route: string
  resultVersion?: number
}

async function publishFolder(dir: string, route: string, body: Publication['body'], requestId?: string): Promise<MoveResult> {
  const pendingFile = path.join(dir, '.publication.json')
  const hash = crypto.createHash('sha256').update(JSON.stringify({ route, files: body.files, workspace: body.workspace })).digest('hex')
  let held: Publication | undefined
  try { held = JSON.parse(fs.readFileSync(pendingFile, 'utf8')) } catch {}
  if (requestId && held?.requestId === requestId && held.hash !== hash) die('This request ID already names different files; use a new request ID.', 'bad-args')
  const replay = held?.hash === hash && held.route === route && (!requestId || held.requestId === requestId)
    && (body.expectedVersion === held.body.expectedVersion || body.expectedVersion === held.resultVersion)
  const pending: Publication = replay ? held! : { requestId: requestId ?? crypto.randomUUID(), hash, body, route }
  fs.writeFileSync(pendingFile, JSON.stringify(pending, null, 2) + '\n')
  const res = await call<{ id: string; version: number }>(route === '/v1/studios' ? 'POST' : 'PATCH', route, pending.body, pending.requestId)
  if (!res.ok) die(res.error, res.code === 'version_conflict' || res.code === 'conflict' ? 'studio-moved' : 'cloud-refused')
  const { id, version } = res.value
  pending.resultVersion = version
  fs.writeFileSync(pendingFile, JSON.stringify(pending, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, VERSION_FILE), versionText(id, version))
  say(`Saved ${studioName(id)} v${version}. New tasks take it.`)
  return { id, version, changed: true, requestId: pending.requestId }
}

/** Create a workspace studio from an ordinary local folder. */
export async function cmdStudioCreate(folder: string, opts: PublishOptions): Promise<MoveResult> {
  if (!opts.requestId) die('--request-id is required', 'bad-args')
  const dir = path.resolve(folder)
  const files = publicationFiles(dir)
  const workspace = opts.workspace ?? (await cloudScope()).workspace
  return publishFolder(dir, '/v1/studios', { files, workspace }, opts.requestId)
}

/** Publish against the pulled version; the server compares it under its row lock. */
export async function cmdStudioPush(folder: string, opts: PublishOptions): Promise<MoveResult> {
  const dir = path.resolve(folder)
  let pulled: { id: string; version: number } | null = null
  try { pulled = JSON.parse(fs.readFileSync(path.join(dir, VERSION_FILE), 'utf8')) } catch {}
  if (!pulled?.id || !Number.isInteger(pulled.version) || pulled.version < 1) die(`${folder} has no valid version.json; pull again.`, 'bad-args')
  const { id, version } = pulled!
  if (id.startsWith('wf_builtin_')) die('Copy this studio before editing it.', 'studio-read-only')
  const files = publicationFiles(dir)
  if (!fs.existsSync(path.join(dir, '.publication.json')) && !opts.requestId) {
    const now = await call<{ version: number; files: StudioFiles }>('GET', `/v1/studios/${encodeURIComponent(id)}`)
    if (now.ok && now.value.version === version && JSON.stringify(files) === JSON.stringify(Object.fromEntries(Object.entries(now.value.files).filter(([f]) => f !== VERSION_FILE).sort()))) {
      say(`${studioName(id)} is unchanged (v${version}).`)
      return { id: studioName(id), version, changed: false, ...(opts.dryRun ? { dryRun: true } : {}) }
    }
  }
  if (opts.dryRun) {
    const now = cloudOk(await call<{ version: number }>('GET', `/v1/studios/${encodeURIComponent(id)}`))
    if (now.version !== version) die(`The studio is at v${now.version}; pull again.`, 'studio-moved')
    say(`${studioName(id)} would push v${version + 1}.`)
    return { id: studioName(id), version: version + 1, changed: true, dryRun: true }
  }
  return publishFolder(dir, `/v1/studios/${encodeURIComponent(id)}`, { files, expectedVersion: version }, opts.requestId)
}

// ---- rules and instructions, saved to Cloud the way the web saves them (#585) ----

interface NoteOptions {
  file?: string
  text?: string
}

/** The new text, or undefined to read the current one. */
function noteText({ file, text }: NoteOptions): string | undefined {
  if (file !== undefined && text !== undefined) die('pass --file or --text, not both', 'bad-args')
  if (file !== undefined) {
    try {
      return fs.readFileSync(file, 'utf8').trim()
    } catch {
      die(`can't read ${file}`, 'bad-args')
    }
  }
  return text?.trim()
}

function cloudOk<T>(res: CloudCall<T>): T {
  if (!res.ok) die(res.error, res.code === 'unauthenticated' ? 'needs-cloud' : 'cloud-refused')
  return (res as { value: T }).value
}

const enc = encodeURIComponent

async function cloudScope(): Promise<{ project: string; workspace: string }> {
  const project = boardProject()
  if (!project) die('This board is not linked to a Cloud project.', 'needs-cloud')
  const held = cloudOk(await call<{ workspace: string }>('GET', `/v1/projects/${enc(project)}`))
  return { project, workspace: held.workspace }
}

interface WorkspaceRules {
  studios: { id: string; rule?: string }[]
}

/** `akb studio rule <studio>`: the rules every card on it follows. */
export async function cmdStudioRule(name: string, opts: NoteOptions): Promise<MoveResult> {
  const rule = noteText(opts)
  const { workspace } = await cloudScope()
  const held = cloudOk(await call<WorkspaceRules>('GET', `/v1/workspaces/${enc(workspace)}/studio-rules`))
  const flow = held.studios.find((w) => studioName(w.id) === name)
  if (!flow) {
    die(`no studio called "${name}" here. There are: ${held.studios.map((w) => studioName(w.id)).join(', ')}.`, {
      kind: 'no-such-studio',
      studio: name,
    })
  }
  if (rule === undefined) {
    const now = flow!.rule ?? ''
    say(now || `${name} has no rules`)
    return { studio: name, rule: now }
  }
  cloudOk(await call('PUT', `/v1/workspaces/${enc(workspace)}/studios/${enc(flow!.id)}/rule`, { rule }))
  say(`${rule ? 'saved' : 'cleared'} the rules of ${name}`)
  return { studio: name, rule }
}

/** The current project's background-task instructions. */
export async function cmdStudioInstructions(agent: string, opts: NoteOptions): Promise<MoveResult> {
  const rule = noteText(opts)
  const project = boardProject()
  if (!project) die('This board is not linked to a Cloud project.', 'needs-cloud')
  const own = cloudOk(await call<{ board: string[]; data: { agent: string; rule?: string }[] }>('GET', `/v1/projects/${enc(project)}/agents`))
  if (!own.board.includes(agent)) {
    die(`no agent called "${agent}" here. There are: ${own.board.join(', ')}.`, { kind: 'no-such-agent', agent })
  }
  if (rule === undefined) {
    const now = own.data.find((a) => a.agent === agent)?.rule ?? ''
    say(now || `${agent} has no instructions`)
    return { agent, rule: now, scope: 'project' }
  }
  cloudOk(await call('PUT', `/v1/projects/${enc(project)}/agents/${enc(agent)}`, { rule }))
  say(rule ? `saved ${agent}'s instructions (this project)` : `cleared ${agent}'s instructions`)
  return { agent, rule, scope: 'project' }
}
