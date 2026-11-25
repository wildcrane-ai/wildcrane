// Every studio is Cloud's (#409): the official ones and the workspace's own. A board kept for a
// Cloud project reads the ones its workspace can run, each version downloaded once into the
// machine home's `studios/` and read from there offline. A run on a task reads the version
// its task started on.
//
// `AI4KANBAN_STUDIOS=<official folder>` reads the official ones from that folder instead,
// unpublished: what the tests and a maintainer editing them use.

import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import fs from 'node:fs'
import path from 'node:path'

import { tryLock } from '../lock'
import { hashInput, safeStudioPath, skillFile, studioSkills, VERSION_FILE, type StudioSkill } from '../shared/studio-files'
import { decodeStudioZip, isDigest, STUDIO_ZIP_LIMIT, type StudioPackage } from '../shared/studio-package'
import { studioName } from '../shared/board-files.ts'
import { packOfficial } from '../../../../official/pack.ts'
import { call, runnerProject, workspaceTask, type CloudCall } from '../cloud/tasks'
import { hasText, invalidResponse, isRecord, temporaryCloudFailure, type CloudProblem } from '../cloud/response'
import { cloudConfigured } from '../cloud/config'
import { readSession, sessionFile } from '../cloud/session'
import { memoByFiles } from '../file-memo'
import { machineHome } from '../machine/home'
import { KANBAN } from '../paths'
import type { SentContext } from './runtime-context'
import { parseStudioFile, type StudioDef } from './studio-def'

export type StudioFiles = Record<string, string>

/** One version of one studio, as Cloud answers it. */
export interface HeldVersion {
  /** Cloud's id: `wf_builtin_coding`, `wf_…`. */
  id: string
  version: number
  name: string
  names?: Record<string, string>
  files: StudioFiles
  historicalPreviews?: Record<string, unknown>
  filesSha256?: string
}

/** One studio as this board runs it. */
export interface CloudFlow {
  def: StudioDef
  cloudId: string
  version: number
  builtIn: boolean
  files: StudioFiles
}

interface List {
  at: string
  workspace: string
  studios: { id: string; version: number }[]
}

export const STUDIO_SNAPSHOT_ENV = 'AI4KANBAN_STUDIO_SNAPSHOT'

export interface StudioPin {
  studio: string
  version: number
  historicalPreviews?: Record<string, unknown>
}

const DEV = 'AI4KANBAN_STUDIOS'
const FRESH_MS = 60_000

const root = () => path.join(machineHome(), 'studios')
const safe = (name: string) => name.replace(/[^\w.@-]/g, '_')
const versionFile = (id: string, version: number) => path.join(root(), 'versions', `${safe(id)}@${version}.json`)
const listFile = (project: string) => path.join(root(), 'lists', `${safe(project)}.json`)
const pinFile = (task: string) => path.join(root(), 'tasks', `${safe(task)}.json`)
const sessionDir = (task: string) => path.join(root(), 'sessions', safe(task))
const sessionFileOf = (task: string, session: string) => path.join(sessionDir(task), createHash('sha256').update(session).digest('hex') + '.json')
const skillDir = (id: string, version: number) => path.join(root(), 'bundles', safe(id) + '@' + version)

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
  } finally { fs.rmSync(tmp, { force: true }) }
}

const filesHash = (files: StudioFiles) => createHash('sha256').update(hashInput(files)).digest('hex')
export const readVersion = (id: string, version: number): HeldVersion | null => {
  const held = readJson<HeldVersion>(versionFile(id, version))
  return held?.id === id && held.version === version && isStudioFiles(held.files)
    && (!held.filesSha256 || filesHash(held.files) === held.filesSha256) ? held : null
}

/** The name a studio had in any version downloaded here, by akb's name for it; empty when none
 *  was. */
export function heldStudioName(name: string): string {
  let files: string[]
  try {
    files = fs.readdirSync(path.join(root(), 'versions'))
  } catch {
    return ''
  }
  const held = files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, f.lastIndexOf('@'))).find((id) => studioName(id) === name)
  if (!held) return ''
  const file = files.filter((f) => f.startsWith(`${held}@`)).sort().pop()!
  return readJson<HeldVersion>(path.join(root(), 'versions', file))?.name ?? ''
}

/** Keep one version; overwrites so updates to the Studio's latest files take effect. */
export function saveVersion(held: HeldVersion): void {
  const file = versionFile(held.id, held.version)
  writeJson(file, { id: held.id, version: held.version, name: held.name, names: held.names, files: held.files, filesSha256: held.filesSha256 })
}

/** The version a task runs on, never changing once read. */
export function savePin(task: string, held: HeldVersion, saved = false): void {
  if (!saved) saveVersion(held)
  writeJson(pinFile(task), { studio: held.id, version: held.version, historicalPreviews: held.historicalPreviews } satisfies StudioPin)
}

export const readPin = (task: string): StudioPin | null => readJson<StudioPin>(pinFile(task))

export const readStudioSession = (task: string, session: string) => readJson<StudioPin>(sessionFileOf(task, session))

export function saveStudioSession(task: string, session: string, pin: StudioPin): void {
  const file = sessionFileOf(task, session)
  if (!fs.existsSync(file)) writeJson(file, pin)
}

function runtimeContextFile(task: string, runtime: string, session: string): string {
  const key = createHash('sha256').update(JSON.stringify([runtime, session])).digest('hex')
  return path.join(sessionDir(task), 'context', key + '.json')
}

export function readRuntimeContext(task: string, runtime: string, session: string): SentContext | undefined {
  return readJson<SentContext>(runtimeContextFile(task, runtime, session)) ?? undefined
}

export function saveRuntimeContext(task: string, runtime: string, session: string, sent: SentContext): void {
  writeJson(runtimeContextFile(task, runtime, session), sent)
}

export function studioSkillBlock(skills: StudioSkill[], folder: string): string {
  if (!skills.length) return ''
  return [
    'When a skill applies, read its listed SKILL.md and resolve its relative references from the skill directory.',
    '',
    '## Skills',
    '',
    '### Available skills',
    ...skills.map(({ name, description }) => '- ' + name + ': ' + description + ' (file: ' + path.join(folder, skillFile(name)) + ')'),
  ].join('\n')
}

export function cachedStudioSkillBlock(held: HeldVersion): string {
  const skills = studioSkills(held.files)
  if (!skills.length) return ''
  const folder = path.resolve(skillDir(held.id, held.version))
  if (!fs.existsSync(folder)) {
    const parent = path.dirname(folder)
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
    const temp = fs.mkdtempSync(path.join(parent, '.studio-'))
    try {
      const prefixes = new Set(skills.map(({ name }) => 'skills/' + name + '/'))
      for (const [file, text] of Object.entries(held.files)) {
        if (!safeStudioPath(file) || !prefixes.has(file.split('/').slice(0, 2).join('/') + '/')) continue
        const target = path.join(temp, file)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, text, { flag: 'wx', mode: 0o444 })
      }
      try { fs.renameSync(temp, folder) } catch (error) { if (!fs.existsSync(folder)) throw error }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  }
  return studioSkillBlock(skills, folder)
}

const jsonIn = (dir: string): string[] => {
  try {
    return fs.readdirSync(path.join(root(), dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
}

/** Forget ended tasks' versions (#651): what stays is each studio's newest version here, the
 *  listed ones, and those a task still runs on. `ended` answers null when it cannot tell, which
 *  keeps the task's version. Answers the version files removed. */
export async function sweepVersions(ended: (task: string) => Promise<boolean | 'gone' | null>): Promise<string[]> {
  const keep = new Set<string>()
  const held = (id: string, version: number) => keep.add(path.basename(versionFile(id, version)))
  const tasks = new Set(jsonIn('tasks').map(file => file.slice(0, -'.json'.length)))
  const dir = path.join(root(), 'sessions')
  if (fs.existsSync(dir)) for (const task of fs.readdirSync(dir)) tasks.add(task)
  for (const task of tasks) {
    const pin = readPin(task)
    const finished = await ended(task)
    if (finished) fs.rmSync(pinFile(task), { force: true })
    else if (pin) held(pin.studio, pin.version)
    if (finished === 'gone') {
      fs.rmSync(sessionDir(task), { recursive: true, force: true })
      continue
    }
    for (const file of jsonIn('sessions/' + safe(task))) {
      const bound = readJson<StudioPin>(path.join(sessionDir(task), file))
      if (bound) held(bound.studio, bound.version)
    }
  }
  for (const file of jsonIn('lists')) {
    for (const w of readJson<List>(path.join(root(), 'lists', file))?.studios ?? []) held(w.id, w.version)
  }
  const versions = jsonIn('versions')
  const newest = new Map<string, number>()
  const parts = (file: string) => ({ id: file.slice(0, file.lastIndexOf('@')), version: Number(file.slice(file.lastIndexOf('@') + 1, -'.json'.length)) })
  for (const file of versions) {
    const { id, version } = parts(file)
    if (version > (newest.get(id) ?? -1)) newest.set(id, version)
  }
  const gone = versions.filter((file) => !keep.has(file) && newest.get(parts(file).id) !== parts(file).version)
  for (const file of gone) {
    fs.rmSync(path.join(root(), 'versions', file), { force: true })
    const { id, version } = parts(file)
    fs.rmSync(skillDir(id, version), { recursive: true, force: true })
  }
  return gone
}

/** The Cloud project this board is kept for, or null. */
export const boardProject = (): string | null => (KANBAN ? runnerProject(KANBAN) : null)

const devFolder = () => process.env[DEV]?.trim() || ''

/** Whether this board can run studios: from the dev folder, or signed in on a linked board. */
export function studiosReachable(): { ok: true } | { ok: false; kind: 'needs-cloud' } {
  if (devFolder()) return { ok: true }
  return boardProject() && readSession() ? { ok: true } : { ok: false, kind: 'needs-cloud' }
}

/** Offline, and the version this process's task runs on was never downloaded. */
export function pinMissing(): boolean {
  const task = workspaceTask()
  if (devFolder() || !task) return false
  const pin = activeStudioPin(task)
  return !(pin && readVersion(pin.studio, pin.version))
}

export const NEEDS_CLOUD = 'Sign in to run studios.'
export const NOT_DOWNLOADED = "This studio isn't downloaded yet. Connect and try again."

let verification: { cached: boolean; problem?: CloudProblem } = { cached: false }

export const studioVerification = () => verification
export const studiosOffline = () => verification.problem?.retryable === true

type Answer<T> = CloudCall<T>

function invalid<T>(expected: string): Answer<T> {
  const problem = invalidResponse(expected)
  return { ...problem, ok: false, error: problem.message }
}

export const isStudioVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export function isStudioFiles(value: unknown): value is StudioFiles {
  return isRecord(value) && hasText(value['STUDIO.md']) && Object.entries(value).every(([file, text]) =>
    typeof text === 'string' && safeStudioPath(file))
}

interface StudioRead {
  id?: string
  studio?: string
  version?: number
  deleted?: boolean
  name?: string
  names?: Record<string, string>
  files?: StudioFiles
  historicalPreviews?: Record<string, unknown>
  package?: StudioPackage | null
}

type ReadStudio = (route: string) => Promise<Answer<StudioRead>>
type DownloadStudio = (route: string, size: number) => Promise<Answer<Uint8Array>>
const downloads = new Map<string, Promise<Answer<HeldVersion>>>()
const studioRoute = (id: string) => '/v1/studios/' + encodeURIComponent(id)
const taskRoute = (id: string) => '/v1/tasks/' + encodeURIComponent(id) + '/studio'

function checkedPackage(pack: StudioPackage, version: number): boolean {
  return pack.version === version && isDigest(pack.zipSha256) && isDigest(pack.filesSha256)
    && Number.isSafeInteger(pack.zipBytes) && pack.zipBytes > 0 && pack.zipBytes <= STUDIO_ZIP_LIMIT
    && typeof pack.downloadUrl === 'string'
    && new RegExp('^/v1/(studios/[A-Za-z0-9_-]+|tasks/[A-Za-z0-9_-]+/studio)/versions/' + version + '/package$').test(pack.downloadUrl)
}

async function cachedPackage(held: Omit<HeldVersion, 'files'>, pack: StudioPackage, download: DownloadStudio): Promise<Answer<HeldVersion>> {
  const file = versionFile(held.id, held.version)
  const cached = (): HeldVersion | null => {
    const local = readVersion(held.id, held.version)
    if (!local) return null
    const { [VERSION_FILE]: _stamp, ...files } = local.files
    return (local.filesSha256 ?? filesHash(files)) === pack.filesSha256 ? { ...held, files, filesSha256: pack.filesSha256 } : null
  }
  const existing = cached()
  if (existing) return { ok: true, value: existing }
  const key = file + ':' + pack.filesSha256
  let work = downloads.get(key)
  if (!work) {
    work = (async (): Promise<Answer<HeldVersion>> => {
      const deadline = Date.now() + 60_000
      let release: (() => void) | undefined
      while (!(release = tryLock(file + '.lock'))) {
        if (Date.now() >= deadline) return { ok: false, code: 'studio_cache_busy', error: 'The Studio package is still being downloaded.' }
        await delay(50)
      }
      try {
        const local = cached()
        if (local) return { ok: true, value: local }
        const read = await download(pack.downloadUrl, pack.zipBytes)
        if (!read.ok) return read
        const zip = read.value
        if (zip.length !== pack.zipBytes || createHash('sha256').update(zip).digest('hex') !== pack.zipSha256) return invalid('the Studio ZIP digest')
        let files: StudioFiles
        try { files = decodeStudioZip(zip) } catch { return invalid('a valid Studio ZIP') }
        if (!isStudioFiles(files) || filesHash(files) !== pack.filesSha256) return invalid('the Studio files digest')
        const value = { ...held, files, filesSha256: pack.filesSha256 }
        saveVersion(value)
        return { ok: true, value }
      } finally { release() }
    })().finally(() => downloads.delete(key))
    downloads.set(key, work)
  }
  const got = await work
  return got.ok ? { ok: true, value: { ...got.value, ...held } } : got
}

const readStudio: ReadStudio = route => call('GET', route)
const downloadStudio: DownloadStudio = (route, size) => call('GET', route, undefined, undefined, { downloadBytes: size })

export const readStudioMetadata = (id: string) => readStudio(studioRoute(id) + '?view=metadata')

export async function loadPublishedStudio(route: string, read: ReadStudio, download: DownloadStudio, pin?: StudioPin): Promise<Answer<HeldVersion | null>> {
  const metadata = await read(route + '?view=metadata' + (pin ? '&version=' + pin.version : ''))
  if (!metadata.ok) return metadata
  if (!isRecord(metadata.value)) return invalid('Studio metadata')
  let row: StudioRead = metadata.value
  if (row.deleted) return { ok: true, value: null }
  const pack = row.package
  if (!pack && !row.files) {
    const legacy = await read(route)
    if (!legacy.ok) return legacy
    row = legacy.value
    if (row.deleted) return { ok: true, value: null }
  }
  const id = row.id ?? row.studio
  if (!hasText(id) || !/^wf_[A-Za-z0-9_-]+$/.test(id)) return invalid('the Studio id')
  const version = row.version ?? 1
  if (!isStudioVersion(version) || (pin && (pin.studio !== id || pin.version !== version))) return invalid('the Studio version')
  const held = { id, version, name: row.name ?? id, names: row.names, historicalPreviews: row.historicalPreviews }
  if (pack) return checkedPackage(pack, version) ? cachedPackage(held, pack, download) : invalid('the Studio package reference')
  if (!isStudioFiles(row.files)) return invalid('the Studio files')
  const value: HeldVersion = { ...held, files: row.files }
  saveVersion(value)
  return { ok: true, value }
}

export async function loadWorkspaceStudio(id: string): Promise<Answer<HeldVersion>> {
  const read = await loadPublishedStudio(studioRoute(id), readStudio, downloadStudio)
  if (!read.ok) return read
  return read.value?.id === id ? { ok: true, value: read.value } : invalid('a valid Studio version')
}

export const missingStudioVersion = (pin: StudioPin) =>
  'Cannot recover Studio ' + studioName(pin.studio) + ' v' + pin.version + '. Its saved version is missing.'

const sessionTaskStudios = new Map<string, HeldVersion>()

function executionSnapshot(): StudioPin | undefined {
  try {
    const value = JSON.parse(process.env[STUDIO_SNAPSHOT_ENV] ?? 'null')
    if (hasText(value?.studio) && isStudioVersion(value.version)) return value
  } catch {}
}

export const activeStudioPin = (task: string) => executionSnapshot() ?? readPin(task)

async function pinTask(task: string): Promise<Answer<HeldVersion>> {
  const snapshot = executionSnapshot()
  const pinned = snapshot && readVersion(snapshot.studio, snapshot.version)
  if (pinned) return { ok: true, value: pinned }
  const cached = sessionTaskStudios.get(task)
  if (cached && !snapshot) return { ok: true, value: cached }
  const pin = readPin(task)
  const read = await loadPublishedStudio(taskRoute(task), readStudio, downloadStudio, snapshot)
  if (!read.ok) return read
  const fallback = snapshot ?? pin
  const held = read.value ?? (fallback && readVersion(fallback.studio, fallback.version))
  if (!held) return invalid('the task’s Studio')
  if (!snapshot) {
    savePin(task, held, true)
    sessionTaskStudios.set(task, held)
  }
  return { ok: true, value: held }
}

/** Bring this machine's copy of the workspace's studios up to date. Never throws: offline, the
 *  copy downloaded before stands. `force` reads the list even when it is fresh. */
export async function syncStudios(force = false): Promise<void> {
  verification = { cached: false }
  const project = boardProject()
  if (devFolder() || !project || !cloudConfigured() || !readSession()) return
  const task = workspaceTask()
  const held = readJson<List>(listFile(project))
  const fresh = held && Date.now() - Date.parse(held.at) < FRESH_MS
  const failed = (failure: Extract<CloudCall<unknown>, { ok: false }>) => {
    verification = { cached: !!held, problem: { code: failure.code ?? 'unreachable', message: failure.error,
      status: failure.status, retryable: failure.retryable ?? temporaryCloudFailure(failure) } }
  }
  try {
    if (task) {
      const pinned = await pinTask(task)
      if (!pinned.ok) failed(pinned)
    }
    if (fresh && !force) {
      verification.cached = true
      return
    }
    let workspace = held?.workspace
    if (!workspace) {
      const read = await call<{ workspace: string }>('GET', `/v1/projects/${encodeURIComponent(project)}`)
      if (!read.ok) return failed(read)
      if (!hasText(read.value.workspace)) return failed({ ok: false, error: 'Cloud did not return a workspace.', code: 'invalid_response' })
      workspace = read.value.workspace
    }
    const listed: List['studios'] = []
    const cursors = new Set<string>()
    let after: string | null = null
    do {
      const page: Answer<{ data: List['studios']; next: string | null }> = await call('GET',
        `/v1/studios?workspace=${encodeURIComponent(workspace)}&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`)
      if (!page.ok) return failed(page)
      if (!Array.isArray(page.value.data) || page.value.data.some(w => !isRecord(w) || !hasText(w.id) || !isStudioVersion(w.version))
          || (page.value.next !== null && (!hasText(page.value.next) || cursors.has(page.value.next)))) {
        return failed({ ok: false, error: 'Cloud did not return a valid Studio list.', code: 'invalid_response' })
      }
      listed.push(...page.value.data.map(({ id, version }) => ({ id, version })))
      after = page.value.next
      if (after) cursors.add(after)
    } while (after)
    const kept: List['studios'] = []
    for (const w of listed) {
      const read = await loadWorkspaceStudio(w.id)
      if (!read.ok) return failed(read)
      kept.push({ id: read.value.id, version: read.value.version })
    }
    writeJson(listFile(project), { at: new Date().toISOString(), workspace, studios: kept } satisfies List)
    verification.cached = false
  } catch (error) {
    failed({ ok: false, code: 'studio_cache_error', error: error instanceof Error ? error.message : String(error) })
  }
}

const flowOf = (held: HeldVersion): CloudFlow | null => {
  const id = studioName(held.id)
  const read = parseStudioFile(id, held.files['STUDIO.md'] ?? '', `the \`${id}\` studio`)
  if ('problem' in read) return null
  return { def: read.def, cloudId: held.id, version: held.version, builtIn: held.id.startsWith('wf_builtin_'), files: held.files }
}

function readFlows(): CloudFlow[] {
  const dev = devFolder()
  if (dev) {
    return packOfficial(dev, true).flatMap((w) => flowOf({ id: w.id, version: 1, name: w.name, names: w.names, files: w.files }) ?? [])
  }
  const project = boardProject()
  if (!project || !readSession()) return []
  const list = readJson<List>(listFile(project))?.studios ?? []
  const flows = list.flatMap((w) => {
    const held = readVersion(w.id, w.version)
    return held ? (flowOf(held) ?? []) : []
  })
  const task = workspaceTask()
  const pin = task ? activeStudioPin(task) : null
  const pinned = pin && readVersion(pin.studio, pin.version)
  const mine = pinned && flowOf(pinned)
  if (!mine) return pin ? flows.filter(flow => flow.cloudId !== pin.studio) : flows
  return [mine, ...flows.filter((f) => f.cloudId !== mine.cloudId)]
}

const sources = (): string[] => {
  if (devFolder()) return [devFolder()]
  const project = boardProject()
  const task = workspaceTask()
  const pin = task && activeStudioPin(task)
  return [sessionFile(), ...(project ? [listFile(project)] : []), ...(task ? [pinFile(task)] : []),
    ...(pin ? [versionFile(pin.studio, pin.version)] : [])]
}

const flows = memoByFiles(sources, readFlows)

/** What `cloudFlows` reads, for a memo built on it. */
export const cloudStudioSources = sources

/** The studios this board runs: the task's own version first, then official ones, then the
 *  workspace's own. Empty when none can be read. */
export const cloudFlows = (): CloudFlow[] => flows()

/** Every file of every studio's agents, `<agent>/<path>`, the first studio naming one winning;
 *  and whether that agent came with an official one. */
export function cloudAgentFiles(): { files: Record<string, string>; official: Set<string> } {
  const files: Record<string, string> = {}
  const official = new Set<string>()
  const owner = new Map<string, string>()
  for (const flow of devFolder() ? cloudFlows() : []) {
    for (const [name, text] of Object.entries(flow.files)) {
      const at = /^agents\/([^/]+)\/(.+)$/.exec(name)
      if (!at) continue
      const [, agent, rest] = at as unknown as [string, string, string]
      if (owner.has(agent) && owner.get(agent) !== flow.cloudId) continue
      owner.set(agent, flow.cloudId)
      if (flow.builtIn) official.add(agent)
      files[`${agent}/${rest}`] = text
    }
  }
  return { files, official }
}
