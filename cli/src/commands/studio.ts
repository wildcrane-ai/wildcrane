// ---- studio --------------------------------------------------------------
//
// The studios this board runs, from a terminal (#715). They are Cloud's (#409); `pull` and
// `push` edit the workspace's own as a folder (#544).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { findSpecAgent } from '../lib/agents'
import { locate } from '../lib/cards'
import { say } from '../lib/io'
import { ASSETS, die } from '../lib/paths'
import { NEEDS_CLOUD, boardProject, cloudFlows, isStudioFiles, isStudioVersion, loadWorkspaceStudio, readStudioMetadata, studioVerification, studiosReachable, studioSkillBlock, type StudioFiles } from '../lib/agent/cloud-studios'
import {
  studioPurpose,
  studioWhen,
  studioById,
  studioFileProblems,
  studioProblems,
  studios,
} from '../lib/agent/studios'
import type { MoveResult } from '../lib/types'
import { readStudioFolder } from '../lib/agent/studio-folder'
import { checkStudioFiles, cloneFiles, isAboutFile, PUBLICATION_FILE, VERSION_FILE, versionText, STUDIO_FILE, studioFilesProblems, studioSkills, hashInput, diagramFrom, formatStudioProblem } from '../lib/shared/studio-files'
import { parseStudioFile } from '../lib/agent/studio-def'
import { studioName } from '../lib/shared/board-files'
import { call, workspaceTask, type CloudCall } from '../lib/cloud/tasks'
import { cloudError, hasText, requireResponse, temporaryCloudFailure } from '../lib/cloud/response'
import { taskReviewContext } from '../lib/agent/env'
import { reviewAllows, reviewAuthorization } from '../lib/shared/review-plan'

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
  const result = { studios: rows.map(({ id, name, names, icon, needsArtifact, previews, description, builtIn }) =>
    ({ id, name, names, icon, needsArtifact, previews, description, builtIn })), problems: studioFileProblems() }
  const { cached, problem } = studioVerification()
  if (!problem || cached) for (const flow of rows) say(`${flow.id}  ${flow.name}  ${flow.previews.map(p => p.id).join(', ')}`)
  if (problem) throw cloudError({ ...problem, message: `Cloud Studio verification failed. ${cached ? 'Showing cached Studios.' : 'No cached Studio list is available.'} ${problem.message}` },
    { details: { ...result, cached, offline: problem.retryable } })
  return result

}

export function cmdStudioDiagram(_id: string, _card: string, _folder?: string): MoveResult {
  die('Freeze a Studio draft with akb studio preview <card> --folder <draft> --base <baseline>.', 'bad-args')
}

/** `akb raw studio validate <folder>` (#622): every problem in a studio folder, the agents it
 *  names but does not hold read from the board. */
export function cmdStudioValidate(folder: string): MoveResult {
  const dir = path.resolve(folder)
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) die(`${folder} is not a folder`, 'bad-args')
  let files: StudioFiles
  try { files = readStudioFolder(dir) } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    die(reason, { kind: 'studio-problems', problems: [{ file: folder, reason, hint: 'Use a Studio folder with regular UTF-8 files within the size limits.' }] })
  }
  let builtin = false
  try { builtin = JSON.parse(files[VERSION_FILE] ?? 'null')?.id?.startsWith('wf_builtin_') === true } catch {}
  const problems = studioFilesProblems(files, builtin)
  if (problems.length) die(problems.map((p) => `! ${p.file}:${p.line ?? 1}:${p.column ?? 1} ${p.path ?? ""} ${p.code ?? "studio-file"}: ${p.reason}. ${p.hint ?? ""}`).join('\n'), { kind: 'studio-problems', bare: true, problems })
  say(`${folder}: no problems`)
  const checked = checkStudioFiles(files, builtin)
  const fingerprint = checked.ok ? crypto.createHash('sha256').update(hashInput({ ...checked.files, ...(files[VERSION_FILE] ? { [VERSION_FILE]: files[VERSION_FILE] } : {}) })).digest('hex') : null
  const skillContext = studioSkillBlock(studioSkills(files), dir)
  return { folder: dir, problems, fingerprint, ...(skillContext ? { skillContext } : {}) }
}

const cloudIdOf = (id: string): string | undefined => cloudFlows().find((f) => studioName(f.cloudId) === id)?.cloudId

async function currentStudio(id: string) {
  const cloudId = cloudIdOf(id)
  if (!cloudId) {
    const { problem } = studioVerification()
    if (problem) throw cloudError(problem)
    found(id)
  }
  const read = await loadWorkspaceStudio(cloudId!)
  const held = requireResponse(cloudOk(read, read.ok || read.code !== 'not_found' ? undefined : 'no-such-studio'),
    'the Studio version and files', value => value.id === cloudId && isStudioVersion(value.version) && isStudioFiles(value.files))
  const { 'catalog.json': _catalog, ...files } = held.files
  return { ...held, files }
}

function emptyStudioFolder(dir: string): boolean {
  const destination = fs.lstatSync(dir, { throwIfNoEntry: false })
  if (!destination) return false
  if (!destination.isDirectory()) die(`${dir} is not a directory. Choose a new or empty folder.`, 'bad-args')
  if (fs.readdirSync(dir).length) die(`${dir} is not empty. Choose a new or empty folder.`, 'bad-args')
  return true
}

function writeStudioFiles(dir: string, files: StudioFiles): void {
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(dir, ...file.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    const data = isAboutFile(file) && !file.endsWith('.md') && /^data:[^;]+;base64,/.exec(text)
    fs.writeFileSync(full, data ? Buffer.from(text.slice(data[0].length), 'base64') : text, { flag: 'wx' })
  }
}

export async function cmdStudioPull(id: string, folder?: string): Promise<MoveResult> {
  const dir = path.resolve(folder ?? id)
  emptyStudioFolder(dir)
  const { id: cloudId, version, files } = await currentStudio(id)
  writeStudioFiles(dir, { ...files, [VERSION_FILE]: versionText(cloudId, version) })
  const shown = folder ?? `./${id}`
  say(`Pulled ${id} v${version} into ${shown}.`)
  return { id, version, folder: dir }
}

export async function cmdStudioClone(id: string, folder: string, name?: string): Promise<MoveResult> {
  const dir = path.resolve(folder)
  emptyStudioFolder(dir)
  if (name !== undefined && !name.trim()) die('--name needs a non-blank Studio name.', 'bad-args')
  const { version, files } = await currentStudio(id)
  const cloned = cloneFiles(files, name?.trim())
  if ('refused' in cloned) {
    die(`Studio "${id}" uses ${cloned.refused}, which a workspace Studio cannot carry. Use studio pull to inspect it or choose another Studio.`, 'studio-not-cloneable')
  }
  const checked = checkStudioFiles(cloned.files)
  if (!checked.ok) die(formatStudioProblem(checked), { kind: 'bad-studio', problems: checked.problems })

  const parent = path.dirname(dir)
  fs.mkdirSync(parent, { recursive: true })
  const staging = fs.mkdtempSync(path.join(parent, '.studio-clone-'))
  let removedEmpty = false
  try {
    writeStudioFiles(staging, checked.files)
    if (emptyStudioFolder(dir) && process.platform === 'win32') {
      fs.rmdirSync(dir)
      removedEmpty = true
    }
    fs.renameSync(staging, dir)
  } catch (error) {
    if (removedEmpty) fs.mkdirSync(dir, { recursive: true })
    throw error
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  say(`Cloned ${id} v${version} into ${folder}.`)
  return { source: id, sourceVersion: version, folder: dir }
}

interface PublishOptions { dryRun?: boolean; requestId?: string; workspace?: string }

function publicationFiles(dir: string): StudioFiles {
  const checked = checkStudioFiles(readStudioFolder(dir))
  if (!checked.ok) die(formatStudioProblem(checked), { kind: 'bad-studio', problems: checked.problems })
  return (checked as { files: StudioFiles }).files
}

interface Publication {
  requestId: string
  hash: string
  body: { files: StudioFiles; expectedVersion?: number; workspace?: string; source_task?: string }
  route: string
  resultVersion?: number
}

async function publishFolder(dir: string, route: string, body: Publication['body'], requestId?: string): Promise<MoveResult> {
  const context = taskReviewContext()
  const task = workspaceTask()
  if (task && context && reviewAllows(reviewAuthorization(context.review, context.assigned), 'implement')) {
    body = { ...body, source_task: task }
  }
  const pendingFile = path.join(dir, PUBLICATION_FILE)
  const hash = crypto.createHash('sha256').update(JSON.stringify({ route, files: body.files, workspace: body.workspace })).digest('hex')
  let held: Publication | undefined
  try { held = JSON.parse(fs.readFileSync(pendingFile, 'utf8')) } catch {}
  if (requestId && held?.requestId === requestId && held.hash !== hash) die('This request ID already names different files; use a new request ID.', 'bad-args')
  const replay = held?.hash === hash && held.route === route && (!requestId || held.requestId === requestId)
    && (body.expectedVersion === held.body.expectedVersion || body.expectedVersion === held.resultVersion)
  const pending: Publication = replay ? held! : { requestId: requestId ?? crypto.randomUUID(), hash, body, route }
  fs.writeFileSync(pendingFile, JSON.stringify(pending, null, 2) + '\n')
  const res = await call<{ id: string; version: number }>(route === '/v1/studios' ? 'POST' : 'PATCH', route, pending.body, pending.requestId)
  const { id, version } = requireResponse(cloudOk(res, !res.ok && ['version_conflict', 'conflict'].includes(res.code ?? '') ? 'studio-moved' : undefined),
    'confirmation of the saved Studio version', value => hasText(value.id) && /^wf_[\w-]+$/.test(value.id) && isStudioVersion(value.version)
      && (pending.body.expectedVersion === undefined || (route === `/v1/studios/${encodeURIComponent(value.id)}` && value.version === pending.body.expectedVersion + 1)))
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
  if (!fs.existsSync(path.join(dir, PUBLICATION_FILE)) && !opts.requestId) {
    const now = await readStudioMetadata(id)
    const digest = now.ok ? now.value.package?.filesSha256 ?? (isStudioFiles(now.value.files)
      ? crypto.createHash('sha256').update(hashInput(Object.fromEntries(Object.entries(now.value.files).filter(([file]) => file !== VERSION_FILE)))).digest('hex') : undefined) : undefined
    if (now.ok && now.value.version === version && digest === crypto.createHash('sha256').update(hashInput(files)).digest('hex')) {
      say(`${studioName(id)} is unchanged (v${version}).`)
      return { id: studioName(id), version, changed: false, ...(opts.dryRun ? { dryRun: true } : {}) }
    }
  }
  if (opts.dryRun) {
    const now = requireResponse(cloudOk(await readStudioMetadata(id)),
      'the current Studio version', value => isStudioVersion(value.version))
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

function cloudOk<T>(res: CloudCall<T>, kind?: string): T {
  if (!res.ok) throw cloudError({ code: res.code ?? 'unreachable', message: res.error, status: res.status,
    retryable: res.retryable ?? temporaryCloudFailure(res) }, { kind })
  return res.value
}

const enc = encodeURIComponent

async function cloudScope(): Promise<{ project: string; workspace: string }> {
  const project = boardProject()
  if (!project) die('This board is not linked to a Cloud project.', 'needs-cloud')
  const held = cloudOk(await call<{ workspace: string }>('GET', `/v1/projects/${enc(project)}`))
  return { project, workspace: requireResponse(held, 'the Studio workspace', value => hasText(value.workspace)).workspace }
}

interface WorkspaceRules {
  studios: { id: string; rule?: string; revision?: number }[]
}

/** `akb studio rule <studio>`: shared Studio configuration. */
export async function cmdStudioRule(name: string, opts: NoteOptions & { revision?: string }): Promise<MoveResult> {
  const rule = noteText(opts)
  const expected = opts.revision === undefined ? undefined : Number(opts.revision)
  if (expected !== undefined && (!/^\d+$/.test(opts.revision!) || !Number.isSafeInteger(expected))) {
    die('--revision must be a nonnegative integer', 'bad-args')
  }
  const { workspace } = await cloudScope()
  const held = requireResponse(cloudOk(await call<WorkspaceRules>('GET', `/v1/workspaces/${enc(workspace)}/studio-rules`)),
    'the workspace’s Studio rules', value => Array.isArray(value.studios))
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
    return { studio: name, rule: now, revision: flow!.revision }
  }
  const saved = requireResponse(cloudOk(await call<{ id: string; rule: string; revision?: number }>('PUT', `/v1/workspaces/${enc(workspace)}/studios/${enc(flow!.id)}/rule`, { rule, revision: expected ?? flow!.revision })),
    'the saved Studio rules', value => value.id === flow!.id && value.rule === rule)
  say(`${rule ? 'saved' : 'cleared'} the rules of ${name}`)
  return { studio: name, rule, revision: saved.revision }
}

/** The current project's background-task instructions. */
export async function cmdStudioInstructions(agent: string, opts: NoteOptions): Promise<MoveResult> {
  const rule = noteText(opts)
  const project = boardProject()
  if (!project) die('This board is not linked to a Cloud project.', 'needs-cloud')
  const own = requireResponse(cloudOk(await call<{ board: string[]; data: { agent: string; rule?: string }[] }>('GET', `/v1/projects/${enc(project)}/agents`)),
    'the project’s agent instructions', value => Array.isArray(value.board) && Array.isArray(value.data))
  if (!own.board.includes(agent)) {
    die(`no agent called "${agent}" here. There are: ${own.board.join(', ')}.`, { kind: 'no-such-agent', agent })
  }
  if (rule === undefined) {
    const now = own.data.find((a) => a.agent === agent)?.rule ?? ''
    say(now || `${agent} has no instructions`)
    return { agent, rule: now, scope: 'project' }
  }
  requireResponse(cloudOk(await call<{ agent: string; rule: string }>('PUT', `/v1/projects/${enc(project)}/agents/${enc(agent)}`, { rule })),
    'the saved instructions', value => value.agent === agent && value.rule === rule)
  say(rule ? `saved ${agent}'s instructions (this project)` : `cleared ${agent}'s instructions`)
  return { agent, rule, scope: 'project' }
}

const DASHBOARD_MAX_BYTES = 25 * 1024 * 1024
const DASHBOARD_MAX_FILES = 1000

function tarHeader(name: string, size: number, kind = '0'): Uint8Array {
  const header = new Uint8Array(512)
  const writeStr = (at: number, val: string) => header.set(Buffer.from(val, 'utf8'), at)
  writeStr(0, name)
  writeStr(100, '0000644\0')
  writeStr(108, '0000000\0')
  writeStr(116, '0000000\0')
  writeStr(124, `${size.toString(8).padStart(11, '0')}\0`)
  writeStr(136, '00000000000\0')
  writeStr(148, '        ')
  header[156] = kind.charCodeAt(0)
  writeStr(257, 'ustar\0')
  writeStr(263, '00')
  const sum = header.reduce((a, b) => a + b, 0)
  writeStr(148, `${sum.toString(8).padStart(6, '0')}\0 `)
  return header
}

function tarBlock(body: Uint8Array): Uint8Array {
  const pad = Math.ceil(body.length / 512) * 512
  if (pad === 0) return new Uint8Array(0)
  const out = new Uint8Array(pad)
  out.set(body)
  return out
}

export function packDashboardDir(dir: string): { gzip: Uint8Array; fileCount: number; sizeBytes: number } {
  const root = path.resolve(dir)
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    die(`${dir} is not a folder`, 'bad-args')
  }
  const indexStat = fs.lstatSync(path.join(root, 'index.html'), { throwIfNoEntry: false })
  if (!indexStat?.isFile()) {
    die(`${dir} must contain index.html at its root`, 'bad-args')
  }

  const files: { rel: string; body: Uint8Array }[] = []
  let totalBytes = 0
  const walk = (current: string, prefix: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) die(`Symlinks are not allowed in dashboard bundles: ${prefix}${entry.name}`, 'bad-args')
      const full = path.join(current, entry.name)
      const rel = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        walk(full, `${rel}/`)
      } else if (entry.isFile()) {
        const body = fs.readFileSync(full)
        totalBytes += body.length
        if (files.length >= DASHBOARD_MAX_FILES) die(`Dashboard bundle exceeds ${DASHBOARD_MAX_FILES} files`, 'bad-args')
        if (totalBytes > DASHBOARD_MAX_BYTES) die('Dashboard bundle exceeds 25 MB unpacked', 'bad-args')
        files.push({ rel, body })
      }
    }
  }
  walk(root, '')

  const chunks: Uint8Array[] = []
  for (const { rel, body } of files) {
    const nameBytes = Buffer.byteLength(rel, 'utf8')
    if (nameBytes > 100) {
      const paxEntry = `path=${rel}\n`
      const len = Buffer.byteLength(paxEntry, 'utf8') + String(Buffer.byteLength(paxEntry, 'utf8') + 4).length + 1
      const paxBody = Buffer.from(`${len} ${paxEntry}`, 'utf8')
      chunks.push(tarHeader(`pax/${rel.slice(0, 80)}`, paxBody.length, 'x'), tarBlock(paxBody))
      chunks.push(tarHeader(rel.slice(0, 99), body.length), tarBlock(body))
    } else {
      chunks.push(tarHeader(rel, body.length), tarBlock(body))
    }
  }
  chunks.push(new Uint8Array(1024))
  return { gzip: zlib.gzipSync(Buffer.concat(chunks)), fileCount: files.length, sizeBytes: totalBytes }
}

interface DashboardResponse {
  id: string
  studio: string
  url: string
  access: 'private' | 'public'
  fileCount: number
  sizeBytes: number
}

/** `akb studio dashboard publish <studioId> <dir>`: pack and publish a Studio's static Dashboard. */
export async function cmdStudioDashboardPublish(
  studioId: string,
  dir: string,
  opts: { access?: string; name?: string; workspace?: string } = {},
): Promise<MoveResult> {
  if (opts.access !== undefined && opts.access !== 'private' && opts.access !== 'public') {
    die('--access must be "private" or "public"', 'bad-args')
  }
  const { gzip } = packDashboardDir(dir)
  const workspace = opts.workspace ?? (await cloudScope()).workspace
  const listed = requireResponse(
    cloudOk(await call<{ data: DashboardResponse[] }>('GET', `/v1/dashboards?workspace=${enc(workspace)}&studio=${enc(studioId)}&limit=1`)),
    'the Studio dashboard list',
    (v) => Array.isArray(v.data),
  )

  let dash = listed.data[0]
  if (!dash) {
    dash = requireResponse(
      cloudOk(await call<DashboardResponse>('POST', '/v1/dashboards', {
        workspace,
        studio: studioId,
        name: opts.name?.trim() || studioId,
        ...(opts.access ? { access: opts.access } : {}),
      })),
      'the created dashboard',
      (v) => typeof v.id === 'string',
    )
  } else if (opts.access !== undefined || opts.name !== undefined) {
    dash = requireResponse(
      cloudOk(await call<DashboardResponse>('PATCH', `/v1/dashboards/${enc(dash.id)}`, {
        ...(opts.name !== undefined ? { name: opts.name.trim() } : {}),
        ...(opts.access !== undefined ? { access: opts.access } : {}),
      })),
      'the updated dashboard',
      (v) => typeof v.id === 'string',
    )
  }

  const published = requireResponse(
    cloudOk(await call<DashboardResponse>('PUT', `/v1/dashboards/${enc(dash.id)}/bundle`, new Blob([new Uint8Array(gzip)], { type: 'application/gzip' }))),
    'the published dashboard',
    (v) => typeof v.id === 'string' && typeof v.url === 'string',
  )
  say(`${published.id}  ${published.studio}  ${published.access}  ${published.url}  (${published.fileCount} files, ${published.sizeBytes} bytes)`)
  return {
    id: published.id,
    studio: published.studio,
    url: published.url,
    access: published.access,
    fileCount: published.fileCount,
    sizeBytes: published.sizeBytes,
  }
}
