import { ARCHIVE_COMPLETION_BATCH, type ArchiveCompletion, type ArchiveCompletionReceipt } from '../../cli/src/lib/shared/delivery-evidence'
import { hasText, isRecord, invalidResponse } from '../../cli/src/lib/cloud/response'
import { readRemoval, taskOfRemoval, writeRemoval } from '../../cli/src/lib/cloud/task-operation'
import { normalizeCardFrontmatter, parseFrontmatter } from '../../cli/src/lib/frontmatter'
import { landArchiveMarker, landArchiveOwners, readLandArchiveOwner, restoreLandBlockers, writeLandArchiveOwner } from '../../cli/src/lib/shared/land-archives'
import { parseStudioFile } from '../../cli/src/lib/agent/studio-def'
import { allComponents, componentDocsText } from '../../cli/src/lib/components'
// 按 seq 同步；仅自动合并无冲突修改，内容冲突留给当前任务 Agent。

import { assetRef, isAssetRef, isLegacyAssetRef, isTaskAssetRef, taskAssetPath } from '../../artifact-sdk/src/internal/task-assets'
import { collect } from '../../artifact-sdk/src/internal/collect'
import { documentPreviewKey, isDocumentPreview, officeExtension, OFFICE_TYPES, PDF, type OfficeExtension } from '../../artifact-sdk/src/internal/document'
import { bodyReferences, kindOf, TYPES, type Kind } from '../../artifact-sdk/src/internal/references'
import { encodeFileReferencePath, fileManifest, splitFileReference } from '../../artifact-sdk/src/internal/file-references'
import { mapReferences } from '../../artifact-sdk/src/internal/manifest'

import { setTimeout as delay } from 'node:timers/promises'
import { ASSET_FILE_LIMIT } from '../../cli/src/lib/shared/file-limits.ts'

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { captureConflict, conflictList, pendingConflicts, withSyncLock, type ConflictFile } from '../../cli/src/lib/shared/board-conflicts'

import { diff3Merge } from 'node-diff3'

import { BOARD_FILE_LIMIT, assetsFile, cardFront, groupOfCard, isBoardPath, isSettingsPath, numberOfCard, studioFolder, studioName, taskOfAssets } from '../../cli/src/lib/shared/board-files.ts'
import { studioContextBlocks } from '../../cli/src/lib/agent/studio-shared'
import type { ContextBlock } from '../../cli/src/lib/agent/runtime-context'
import { studioConfigContext } from '../../cli/src/lib/agent/studio-config.ts'
import { describeTaskPreviewProblems } from '../../cli/src/lib/shared/task-preview-validation'
import { parsePreviewBlocks, sourcePosition, type SourceProblem } from '../../cli/src/lib/shared/preview-blocks'
import { migrateHistoricalArchive } from '../../cli/src/lib/shared/studio-migration'
import { makeFailure, type ExecutionFailure } from '../../cli/src/lib/agent/retry'
import { itemAt, stampItem } from '../../cli/src/lib/shared/triage-files.ts'
import { ensureProjectState, projectStateDir, realPathOf } from '../../cli/src/lib/machine/project'
import { resolveBoardAsset } from '../../cli/src/lib/machine/asset-path'
import { loadPublishedStudio, missingStudioVersion, readPin, readVersion, savePin, type StudioPin } from '../../cli/src/lib/agent/cloud-studios'
import { safeStudioPath } from '../../cli/src/lib/shared/studio-files'
import { renderError } from '../../cli/src/lib/preview-validation'
import { referenceText } from '../../cli/src/lib/draw-mockup'
import * as api from './api'
import type { Assets, Job } from './api'
import { busy, hold, kept as cacheKept, markUsed, markUnsent, unsent } from './cache'
import { keepOutOfGit } from './kanban-skill'
import { sharedMemory, type Shared } from './memory-files'
import { memoryDirectories } from '../../cli/src/lib/memory'
import { errno, logRunner } from './runner-log'
import { countSync, logSync, syncDebug } from './sync-debug'

export { studioFolder }

export interface TaskFolder {
  /** What its records here are kept under: the task, or a periodic agent's own name. */
  task: string
  /** The Cloud task the job works for: its memory, tools and assets are that task's. Null for a
   *  periodic agent, which keeps the project's memory alone. */
  cloudTask: string | null
  /** The board: `<project>/.akb/kanban`; the project is `~/.wildcrane/cache/<project>` without a folder. */
  board: string
  /** Where the agent runs. */
  cwd: string
  project: string
  /** The task's short number, which its card file starts with. */
  number: number | null
  /** The task's studio, e.g. `wf_builtin_coding`. */
  studio: string | null
  studioSnapshot?: StudioPin
  bindStudio?: (snapshot: StudioPin) => void
  materialIssues?: Record<string, string>
}

interface Entry {
  version: number
  hash: string
  localHash?: string
}

/** What this computer keeps of one task beside the board: its assets and its studio's tools. */
interface Record_ {
  task?: string
  number?: number
  /** Cloud removed its archived card or confirmed the task is gone. */
  deleted?: string | true

  /** `kind` is the artifact's type (#2003); an `html` one is the page a mockup draws, and its
   *  hash is the page's. */
  assets: { [path: string]: Entry & { artifact: string; kind?: Kind; dependencies?: string[] } }
  pendingVersions?: Record<string, { artifact: string; hash: string; upload: string }>
  /** Legacy agents placed on the board, by file hash. */
  agents?: { [path: string]: string }
  /** Its skills written into the project, by file hash, and the MCP servers its runs get (#2030). */
  tools?: { skills: { [path: string]: string }; mcp: McpServers }
  /** The task runs on akb's own studio and agents. */
  builtin?: boolean
}

/** What the board last read from Cloud, or wrote to it: each file by its path in the workspace's
 *  board. */
interface Base {
  /** A base from before the workspace's board (#2114) is read again whole. */
  layout?: 'workspace'
  head_seq: number | null
  workspace?: string | null
  project?: string
  /** Cards with deferred assets stay excluded from later job writebacks. */
  deferred?: string[]
  pendingAssets?: string[]
  pendingArchives?: Record<string, string>
  archiveReceipts?: Record<string, Omit<ArchiveCompletion, 'task'> & ArchiveCompletionReceipt>
  reconciledArchives?: unknown
  pendingRemovals?: string[]
  /** Recheck refused Preview drafts before applying Cloud changes to their files. */
  pendingPreviews?: string[]
  deleted?: Record<string, number>
  files: { [path: string]: { seq: number; content: string } }
}

export type Pushed =
  | { ok: true; changed: boolean }
  | { ok: false; conflict: boolean; error: string; offline?: boolean; code?: string; status?: number; failure?: ExecutionFailure; previews?: SourceProblem[]; tasks?: Record<string, SyncProblem> }

type SyncProblem = { error: string; offline?: boolean; code?: string; blocking?: boolean; failure?: ExecutionFailure }
const validationFailure = (reason: string, code = 'validation_failed'): ExecutionFailure => makeFailure('validation', reason, { code, detail: reason })

const TASK_ID = /^[\w-]{1,100}$/
export const NO_FOLDER = 'This project has no folder on this computer. Link one, then try again.'
const EMPTY: Record_ = { assets: {} }

function openBoard(projectDir: string): string {
  const board = path.join(projectDir, '.akb', 'kanban')
  ensureProjectState(board)
  fs.mkdirSync(board, { recursive: true })
  keepOutOfGit(projectDir)
  markUsed(projectDir)
  return board
}

/** A task runs only in its project's linked folder (#516). */
export function openTaskFolder(job: Pick<Job, 'task' | 'project' | 'number' | 'studio' | 'flow'>, projectDir: string | null): TaskFolder {
  const task = job.task ?? ''
  if (!TASK_ID.test(task)) throw new Error('This job names no task.')
  if (!job.project) throw new Error('This job names no project.')
  if (!projectDir) throw new Error(NO_FOLDER)
  const board = openBoard(projectDir)
  return { task, cloudTask: task, board, cwd: projectDir, project: job.project, number: job.number ?? null, studio: job.studio ?? job.flow?.studio ?? null }
}

/** A periodic agent's folder (#2068): the project's board, where a reflect works for the first
 *  task it reads. */
export function openAgentFolder(job: Pick<Job, 'project' | 'agent'>, projectDir: string): TaskFolder {
  if (!job.project || !job.agent) throw new Error('This job names no project.')
  const board = openBoard(projectDir)
  // Keep the board record key for old jobs that already reached the sync handoff.
  const recordKey = job.agent.studio ? `${job.agent.studio}-${job.agent.name}` : job.agent.name
  return {
    task: `agent-${safe(recordKey)}`,
    cloudTask: job.agent.tasks?.[0]?.id ?? null,
    board,
    cwd: projectDir,
    project: job.project,
    number: null,
    studio: null,
  }
}

/** A discussion's folder (#2110): the project's board, as an agent job's. */
export function openDiscussionFolder(job: Pick<Job, 'project'>, projectDir: string): TaskFolder {
  if (!job.project) throw new Error('This job names no project.')
  const board = openBoard(projectDir)
  return { task: 'discussion', cloudTask: null, board, cwd: projectDir, project: job.project, number: null, studio: null }
}

/** The board itself, for no task: what a change made outside a job goes back as (#59). */
const boardFolder = (ws: Pick<TaskFolder, 'board' | 'cwd' | 'project'>): TaskFolder =>
  ({ task: 'board', cloudTask: null, board: ws.board, cwd: ws.cwd, project: ws.project, number: null, studio: null })

/** The board a project folder here keeps for Cloud, once read from it; null when never read. */
export function keptBoard(cwd: string): TaskFolder | null {
  const board = path.join(cwd, '.akb', 'kanban')
  const base = readBase({ cwd })
  const project = base.project ?? /^projects\/([^/]+)\//.exec(Object.keys(base.files).find((p) => p.startsWith('projects/')) ?? '')?.[1]
  return base.head_seq === null || !project ? null : boardFolder({ board, cwd, project })
}

const turns = new Map<string, Promise<unknown>>()

/** One read or write of a folder's board at a time. */
function inFolder<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const queued = performance.now()
  const run = async () => {
    const started = performance.now()
    logSync('board.start', { dir, waitMs: Math.round(started - queued) })
    try { return await withSyncLock(path.join(dir, '.akb', 'kanban'), work) }
    finally { logSync('board.end', { dir, ms: Math.round(performance.now() - started) }) }
  }
  const next = (turns.get(dir) ?? Promise.resolve()).then(run, run)
  const held = next.catch(() => {})
  turns.set(dir, held)
  void held.then(() => turns.get(dir) === held && turns.delete(dir))
  return next
}

const safe = (name: string) => name.replace(/[^\w.-]/g, '_') || 'default'

/** Managed studios execute in an ordinary directory. */
/** Where a studio's skills go in the project, beside the kanban skill. */
const SKILL_ROOTS = ['.claude/skills', '.agents/skills']

/** The card's file: akb's `todo/<number>-<slug>.md`, a group's `root.md`, or wherever akb moved it since. */
export const cardFile = (ws: TaskFolder): string =>
  (ws.number ? findCard(ws.board, ws.number) : null) ?? path.join(ws.board, 'todo', `${ws.number ?? 0}-task.md`)

/** Card `number` under `todo/` or `.archive/`, at any depth. */
export function findCard(board: string, number: number): string | null {
  const named = new RegExp(`^${number}-`)
  const walk = (dir: string): string | null => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const e of entries) {
      if (!named.test(e.name)) continue
      if (e.isFile() && e.name.endsWith('.md')) return path.join(dir, e.name)
      const root = path.join(dir, e.name, 'root.md')
      if (e.isDirectory() && fs.existsSync(root)) return root
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) {
      const hit = walk(path.join(dir, e.name))
      if (hit) return hit
    }
    return null
  }
  return walk(path.join(board, 'todo')) ?? walk(path.join(board, '.archive'))
}

/** The akb id of the task's card on this board, once it has one: the task's number. */
export function akbCardOf(ws: TaskFolder): number | undefined {
  return ws.number && findCard(ws.board, ws.number) ? ws.number : undefined
}

const recordFile = (ws: TaskFolder) => path.join(ws.board, '.sync', `${ws.task}.json`)

function readRecord(ws: TaskFolder): Record_ {
  try {
    return { ...EMPTY, ...(JSON.parse(fs.readFileSync(recordFile(ws), 'utf8')) as Partial<Record_>) }
  } catch {
    return structuredClone(EMPTY)
  }
}

function writeRecord(ws: TaskFolder, record: Record_): void {
  const content = `${JSON.stringify(record, null, 2)}\n`
  if (readText(recordFile(ws)) === content) return
  countSync('recordWrites')
  if (syncDebug) countSync('recordBytes', Buffer.byteLength(content))
  fs.mkdirSync(path.dirname(recordFile(ws)), { recursive: true })
  const file = recordFile(ws)
  fs.writeFileSync(`${file}.tmp`, content)
  fs.renameSync(`${file}.tmp`, file)
}

/** Only a successful Cloud read can retire an index; missing local files alone prove nothing. */
async function cleanRecords(ws: TaskFolder, base: Base, options: {
  removed?: string[]
  tasks?: Iterable<string>
  taskChat?: string
} = {}): Promise<Set<string>> {
  const { removed = [], tasks, taskChat } = options
  const retired = new Set<string>()
  const root = rootOf(ws)
  const removedPaths = new Set(removed)
  const numbers = new Set(Object.keys(base.files).filter(p => p.startsWith(root) && !removedPaths.has(p)).map(p => numberOfCard(p.slice(root.length))))
  const deleted = new Map(removed.filter(p => p.startsWith(root + '.archive/')).map(p => [numberOfCard(p.slice(root.length)), p.slice(root.length)]))
  for (const name of tasks ? [...tasks].map(task => `${task}.json`) : filesUnder(path.join(ws.board, '.sync'))) {
    if (!name.endsWith('.json') || name.includes('/')) continue
    let record: Record_
    try { record = JSON.parse(fs.readFileSync(path.join(ws.board, '.sync', name), 'utf8')) } catch { continue }
    if (!record.task || !TASK_ID.test(record.task) || name !== `${record.task}.json` || !record.number) continue
    if (numbers.has(record.number)) {
      if (record.deleted) { delete record.deleted; writeRecord({ ...ws, task: record.task }, record); syncIndex(ws)?.retiring.delete(record.task) }
      continue
    }
    const folder = { ...ws, task: record.task, cloudTask: record.task, number: record.number }
    const list = assetsFile(record.task)
    const before = base.files[root + list]?.content ?? null
    // Leave unrelated orphan lookups to board maintenance unless there is an unsent manifest.
    if (taskChat && record.task !== taskChat && !record.deleted && !deleted.has(record.number) &&
        readText(path.join(ws.board, list)) === before) continue
    const card = findCard(ws.board, record.number)
    if (!record.deleted && deleted.has(record.number)) {
      record.deleted = deleted.get(record.number)!
      writeRecord(folder, record)
    }
    if (!record.deleted) {
      if (card) continue
      const read = await api.readTask(record.task)
      if (read.ok || read.code !== 'not_found') continue
      record.deleted = true
      writeRecord(folder, record)
    }
    retired.add(record.task)
    const index = syncIndex(ws) ?? newIndex(ws)
    taskIndexes.set(ws.cwd, index)
    index.retiring.add(record.task)
    if (card || cacheKept(ws.cwd) || base.pendingAssets?.includes(record.task)) continue
    const here = readText(path.join(ws.board, list))
    if (here !== null && here !== before) continue
    let changed = false
    for (const [name, entry] of Object.entries(record.assets ?? {})) {
      let file: string | null
      try { file = assetPath(folder, name, typeof record.deleted === 'string' ? path.join(ws.board, record.deleted) : cardFile(folder)) } catch { changed = true; break }
      if (!file) continue
      const hash = hashFile(file)
      if (hash !== null && hash !== (entry.localHash ?? entry.hash)) { changed = true; break }
    }
    if (!changed) {
      fs.rmSync(recordFile(folder), { force: true })
      forgetTask(index, record.task)
    }
  }
  return retired
}

const baseFile = (ws: Pick<TaskFolder, 'cwd'>) => path.join(ws.cwd, '.akb', 'base.json')

function readBase(ws: Pick<TaskFolder, 'cwd'>): Base {
  try {
    const base = JSON.parse(fs.readFileSync(baseFile(ws), 'utf8')) as Base
    if (base.layout === 'workspace') return base
  } catch {
    // Never read.
  }
  return { layout: 'workspace', head_seq: null, files: {} }
}

function archiveMeta(content: string) {
  const { meta } = parseFrontmatter(content)
  return meta?.archived && !meta.rejected ? meta : null
}

function writeBase(ws: TaskFolder, base: Base): void {
  const root = rootOf(ws)
  for (const [task, receipt] of Object.entries(base.archiveReceipts ?? {})) {
    const archive = base.files[root + receipt.path]
    if (!archive || (archive.seq !== receipt.seq && !archiveMeta(archive.content))) delete base.archiveReceipts![task]
  }
  const file = baseFile(ws)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(base))
  fs.renameSync(`${file}.tmp`, file)
}

const hashOf = (bytes: Uint8Array | string) => crypto.createHash('sha256').update(bytes).digest('hex')

function hashFile(file: string): string | null {
  try {
    return hashOf(fs.readFileSync(file))
  } catch {
    return null
  }
}

function write(file: string, bytes: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Every file under `dir`, as `/`-joined paths relative to `base`. */
export function filesUnder(dir: string, base = dir, skipDirectory?: string): string[] {
  if (dir === skipDirectory) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return filesUnder(full, base, skipDirectory)
    return e.isFile() ? [path.relative(base, full).split(path.sep).join('/')] : []
  })
}

/** The board files Cloud keeps. */
const kept = (file: string) => isBoardPath(file) && !/^memory\/agents\/(?!planner\/)/.test(file)

const MEMORY = 'memory/'
const rootOf = (ws: TaskFolder) => `projects/${ws.project}/`

/** Where a file of this board sits in the workspace's: memory its agents share is the workspace's. */
const remoteOf = (ws: TaskFolder, shared: Shared, p: string) =>
  p.startsWith(MEMORY) && shared(p.slice(MEMORY.length)) ? p : rootOf(ws) + p

/** The board as Cloud holds it, by this board's paths: the project's files, then the shared memory
 *  over a project file at the same path. */
function viewOf(ws: TaskFolder, base: Base, shared: Shared): Map<string, string> {
  const root = rootOf(ws)
  const view = new Map<string, string>()
  for (const [p, f] of Object.entries(base.files)) if (p.startsWith(root) && kept(p.slice(root.length))) view.set(p.slice(root.length), f.content)
  for (const [p, f] of Object.entries(base.files)) if (p.startsWith(MEMORY) && shared(p.slice(MEMORY.length))) view.set(p, f.content)
  return view
}

/** The files the task's assets list names, which are artifacts', not the board's. */
function assetFiles(ws: TaskFolder, list: string | null | undefined, card = cardFile(ws)): Set<string> {
  const at = (name: string) => { try { return assetPath(ws, name, card) } catch { return null } }
  return new Set(Object.keys(assetsOf(list)).map(at).filter((f): f is string => !!f)
    .map((f) => path.relative(ws.board, f).split(path.sep).join('/')))
}

const assetsListOf = (ws: TaskFolder, base: Base) => base.files[rootOf(ws) + assetsFile(ws.task)]?.content

const localFiles = (ws: TaskFolder, base: Base) => {
  const assets = new Set([...assetFiles(ws, assetsListOf(ws, base)), ...assetFiles(ws, readText(path.join(ws.board, assetsFile(ws.task))))])
  return filesUnder(ws.board, ws.board, path.join(ws.board, 'deliveries')).filter((p) => kept(p) && !assets.has(p))
}

export interface McpServers {
  [name: string]: { command: string; args?: string[] }
}

/** Remove only unchanged files the legacy Runner recorded as its own. */
function removePlacedSkills(ws: TaskFolder, held: Record<string, string>): void {
  for (const [name, hash] of Object.entries(held)) {
    const [top, skill, ...rest] = name.split('/')
    if (top !== 'skills' || !skill || skill === 'kanban' || !rest.length || !safeStudioPath(name)) continue
    for (const root of SKILL_ROOTS) {
      const boundary = path.join(ws.cwd, root)
      const file = path.join(boundary, skill, ...rest)
      // A project skill may have been replaced by a symlink since the legacy write.
      let current = ws.cwd
      const safe = [...root.split('/'), skill, ...rest].every(part => {
        current = path.join(current, part)
        const entry = fs.lstatSync(current, { throwIfNoEntry: false })
        return current === file ? entry?.isFile() : entry?.isDirectory()
      })
      if (!safe || hashFile(file) !== hash) continue
      fs.rmSync(file, { force: true })
      for (let dir = path.dirname(file); dir !== boundary; dir = path.dirname(dir)) {
        try { fs.rmdirSync(dir) } catch { break }
      }
    }
  }
}

function studioMcp(files: Record<string, string>): McpServers {
  try {
    return (JSON.parse(files['mcp.json'] ?? '{}') as { mcpServers?: McpServers }).mcpServers ?? {}
  } catch {
    return {}
  }
}

export const mcpServersOf = (ws: TaskFolder): McpServers => {
  const pin = ws.studioSnapshot
  const held = pin && readVersion(pin.studio, pin.version)
  return held ? studioMcp(held.files) : readRecord(ws).tools?.mcp ?? {}
}

async function studioFiles(ws: TaskFolder): Promise<api.Call<Record<string, string>>> {
  const requested = ws.studioSnapshot
  const route = '/v1/tasks/' + encodeURIComponent(ws.task) + '/studio'
  const read = await loadPublishedStudio(route, route => api.request('GET', route), api.download, requested)
  if (!read.ok) {
    if (!requested || !['not_found', 'invalid_response'].includes(read.code ?? '')) return read
    const cached = readVersion(requested.studio, requested.version)
    if (!cached) return { ok: false, error: missingStudioVersion(requested), code: 'studio_version_missing' }
    ws.bindStudio?.(requested)
    return { ok: true, value: cached.files }
  }
  if (!read.value) {
    const pin = ws.studioSnapshot ?? readPin(ws.task)
    const held = pin && readVersion(pin.studio, pin.version)
    if (requested && !held) return { ok: false, code: 'studio_version_missing', error: missingStudioVersion(requested) }
    if (pin && held) {
      ws.studioSnapshot = pin
      ws.bindStudio?.(pin)
    }
    return { ok: true, value: held?.files ?? {} }
  }
  const held = read.value
  const snapshot = { studio: held.id, version: held.version, historicalPreviews: held.historicalPreviews }
  ws.studioSnapshot = snapshot
  ws.bindStudio?.(snapshot)
  if (!requested) savePin(ws.task, held, true)
  return { ok: true, value: held.files }
}

/** Load the task's Studio snapshot and remove files placed by earlier Runners. */
async function pullStudio(ws: TaskFolder, record: Record_): Promise<api.Call<void>> {
  if (ws.cloudTask === ws.task) {
    record.builtin = ws.studio?.startsWith('wf_builtin_') ?? false
    const files = await studioFiles(ws)
    if (!files.ok && (ws.studioSnapshot || files.code !== 'not_found')) return files
    if (files.ok) {
      removePlacedSkills(ws, record.tools?.skills ?? {})
      record.tools = { skills: {}, mcp: studioMcp(files.value) }
    }
  }
  dropPlacedAgents(ws)
  for (const name of Object.keys(record.agents ?? {})) fs.rmSync(path.join(ws.board, name), { force: true })
  record.agents = {}
  return { ok: true, value: undefined }
}

const agentsRecord = (ws: TaskFolder) => path.join(ws.board, '.sync', 'agents.json')

/** The studios' agents an earlier Runner placed, by file hash. */
function readPlaced(ws: TaskFolder): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(agentsRecord(ws), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

/** Clear unchanged agent files copied by an earlier Runner. */
function dropPlacedAgents(ws: TaskFolder): void {
  const placed = readPlaced(ws)
  for (const name of Object.keys(placed)) if (hashFile(path.join(ws.board, name)) === placed[name]) fs.rmSync(path.join(ws.board, name), { force: true })
  fs.rmSync(agentsRecord(ws), { force: true })
}

/** Resolve an asset inside this card's allowed files. */
export function assetPath(ws: TaskFolder, name: string, owner: string, dependency = false): string | null {
  return resolveBoardAsset(ws.board, projectStateDir(ws.board), ws.number, name, owner, dependency)
}

/** The task's asset folder. */
export function cardAssetsDir(ws: TaskFolder, id: number): string {
  return path.join(projectStateDir(ws.board), 'assets', String(id))
}

function assetsOf(text: string | null | undefined): Assets {
  try {
    const held = JSON.parse(text ?? '{}') as unknown
    return held && typeof held === 'object' && !Array.isArray(held) ? (held as Assets) : {}
  } catch {
    return {}
  }
}

const assetsText = (assets: Assets) => `${JSON.stringify(Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), null, 2)}\n`

/** Send local changes, refresh the board, then prepare the task's Studio and assets. */
export function pull(ws: TaskFolder, machineId: string, stopped?: () => boolean, mode?: 'chat' | 'implement' | 'land'): Promise<api.Call<void>> {
  if (mode === 'implement') ws.materialIssues = {}
  const taskChat = mode === 'chat' ? ws.task : undefined
  return whenPrepared(ws, { ok: false, code: 'stopped', error: 'Task preparation stopped.' }, async () => {
    if (mode === 'land') return prepareTask(ws, true, undefined, ws.task)
    const started = performance.now()
    const sent = await sendBoard(boardFolder(ws), machineId, {
      taskChat, ...(mode === 'chat' && ws.number !== null ? { taskNumber: ws.number } : {}),
    })
    logSync('board.push.done', { ms: Math.round(performance.now() - started), ok: sent.ok })
    let validation: ExecutionFailure | undefined
    if (!sent.ok) {
      const previews = sent.previews?.filter(p => numberOfCard(p.file) === ws.number)
      const refused = sent.tasks?.[ws.cloudTask ?? ''] ?? (sent.tasks || sent.previews ? undefined : { ...sent, blocking: true })
      if (previews?.length) validation = validationFailure(describeTaskPreviewProblems(previews))
      else if (refused?.failure?.source === 'validation') validation = refused.failure
      else if (refused && refused.blocking !== false) {
        if (sent.conflict) {
          const prepared = await prepareConflictTask(ws)
          if (!prepared.ok) return prepared
        }
        return { ok: false, error: `This computer's board changes could not be sent: ${refused.error}`, ...(refused.offline ? {} : { code: sent.conflict ? 'board_content_conflict' : refused.code ?? 'version_conflict' }) }
      }
    }
    const readAt = performance.now()
    try {
      const read = await prepareTask(ws, !!validation, taskChat)
      if (!read.ok && read.code === 'board_content_conflict') {
        const prepared = await prepareConflictTask(ws)
        if (!prepared.ok) return prepared
      }
      return read.ok && validation ? { ok: false, code: 'bad_request', error: validation.summary, failure: validation } : read
    } finally { logSync('board.pull.done', { ms: Math.round(performance.now() - readAt) }) }
  }, stopped)
}

async function prepareConflictTask(ws: TaskFolder): Promise<api.Call<void>> {
  if (!ws.cloudTask) return { ok: true, value: undefined }
  const conflicts = pendingConflicts(ws.board)
  const refused = (error: string): api.Call<void> => ({ ok: false, code: 'conflict', error })
  if (!conflicts.length || conflicts.some(r => r.project !== ws.project)) return refused('The saved conflicts do not belong to this project.')
  const task = await api.readTask(ws.cloudTask)
  if (!task.ok) return task
  if (task.value.project !== ws.project) return refused('This task no longer belongs to this project.')
  if (typeof task.value.request !== 'string') return refused('The actual task request could not be read.')
  const read = await readSyncedBoard(ws, null)
  if (!read.ok) return read
  const root = rootOf(ws)
  const cards = read.value.files.filter(f => ws.number !== null && f.content !== null && f.path.startsWith(root) && numberOfCard(f.path.slice(root.length)) === ws.number)
  const missing = ws.number !== null && !akbCardOf(ws)
  if (missing && (['done', 'cancelled'].includes(task.value.status ?? '') || cards.some(f => f.path.startsWith(root + '.archive/')))) {
    return refused('This task has finished. Its saved conflicts and local work are preserved.')
  }
  if (missing && !cards.length && task.value.card_version) return refused('This task no longer has a card on this board.')
  const protectedPaths = new Set(conflicts.flatMap(r => r.files.map(f => f.path)))
  const base = readBase(ws)
  let changed = false
  for (const f of read.value.files) {
    if (!f.content || !f.path.startsWith(root)) continue
    const p = f.path.slice(root.length)
    if (!kept(p)) continue
    if (!(missing && cards.includes(f)) && p !== assetsFile(ws.task)) continue
    if (protectedPaths.has(p) || readText(path.join(ws.board, p)) !== null || base.files[f.path]) continue
    write(path.join(ws.board, p), f.content)
    // Only these exact Cloud bytes were read; the board head and all other bases stay put.
    base.files[f.path] = { seq: f.seq, content: f.content }
    changed = true
  }
  if (missing && cards.length && !akbCardOf(ws)) return refused('The missing task card is part of the saved conflict batch. Resolve it before continuing.')
  if (changed) writeBase(ws, base)
  const record = readRecord(ws)
  const studio = await pullStudio(ws, record)
  if (!studio.ok) return studio
  const assets = await pullAssets(ws, record, assetsOf(readText(path.join(ws.board, assetsFile(ws.task))) ?? assetsListOf(ws, base)), true)
  if (!assets.ok) return assets
  writeRecord(ws, record)
  return { ok: true, value: undefined }
}

export const taskAssetsSynced = (ws: TaskFolder): boolean => !readBase(ws).pendingAssets?.includes(ws.task)

/** The Cloud card version the folder last synced. */
export function syncedCardVersion(ws: TaskFolder): number | null {
  const base = readBase(ws)
  const card = Object.entries(base.files).find(([p]) => p.startsWith(rootOf(ws) + 'todo/') && numberOfCard(p.slice(rootOf(ws).length)) === ws.number)
  return card?.[1].seq ?? null
}

export function syncedArchive(ws: TaskFolder): Omit<ArchiveCompletion, 'task'> | undefined {
  const p = path.relative(ws.board, cardFile(ws))
  if (!p.startsWith('.archive/')) return
  const base = readBase(ws)
  const root = rootOf(ws)
  const card = base.files[root + p]
  const list = assetsFile(ws.task)
  const assets = base.files[root + list]
  if (!card || !archiveMeta(card.content) || card.content !== readText(path.join(ws.board, p)) ||
      (assets?.content ?? null) !== readText(path.join(ws.board, list)) ||
      base.pendingAssets?.includes(ws.task) || base.pendingPreviews?.some(held => held === p || held === list)) return
  return { path: p, seq: card.seq, assets_seq: assets?.seq ?? 0 }
}

export const readHead = (ws: Pick<TaskFolder, 'cwd'>): number | null => readBase(ws).head_seq

function restoredCards(ws: TaskFolder, base: Base, files: api.BoardFile[]) {
  const root = rootOf(ws)
  return files.flatMap(({ path: remote, content, seq }) => {
    if (!remote.startsWith(root + 'todo/') || !content) return []
    const p = remote.slice(root.length)
    const number = numberOfCard(p)
    const stamp = /^restored:\s*(.+)$/m.exec(content)?.[1]
    const before = base.files[remote]?.content
    if (number === null || !stamp || (before && /^restored:\s*(.+)$/m.exec(before)?.[1] === stamp)) return []
    return [{ path: p, number, content, seq }]
  })
}

/** A restored card supersedes old local archive moves. Keep divergent copies outside the board. */
function applyRestorations(ws: TaskFolder, base: Base, files: api.BoardFile[]): Set<string> {
  const restored = new Set<string>()
  const root = rootOf(ws)
  for (const { path: p, number, content, seq } of restoredCards(ws, base, files)) {
    for (const local of ['todo', '.archive'].flatMap(dir => filesUnder(path.join(ws.board, dir), ws.board))) {
      if (numberOfCard(local) !== number) continue
      const here = readText(path.join(ws.board, local))
      if (here !== null && here !== base.files[root + local]?.content && here !== content) {
        write(path.join(ws.board, '.sync', 'restored', String(seq), local), here)
      }
      restored.add(local)
      if (local !== p) fs.rmSync(path.join(ws.board, local), { force: true })
    }
    write(path.join(ws.board, p), content)
    restored.add(p)
  }
  return restored
}

function observeConflicts(ws: TaskFolder, base: Base, files: api.BoardFile[], shared: Shared, privateArchive: (p: string) => boolean): boolean {
  const root = rootOf(ws)
  const pending = new Set(base.pendingPreviews)
  const conflicting = files.some(f => {
    const p = f.path.startsWith(root) ? f.path.slice(root.length) : f.path
    if (privateArchive(p) || pending.has(p) || !kept(p) || remoteOf(ws, shared, p) !== f.path) return false
    return !!mergeFile(base.files[f.path]?.content ?? null, readText(path.join(ws.board, p)), f.content).conflict
  })
  if (!conflicting) return false
  const changed = new Map(files.map(f => [f.path, f]))
  const candidates = new Set([...localFiles(ws, base), ...viewOf(ws, base, shared).keys()])
  const facts: ConflictFile[] = []
  for (const p of candidates) {
    if (privateArchive(p) || pending.has(p)) continue
    const remotePath = remoteOf(ws, shared, p)
    const before = base.files[remotePath]?.content ?? null
    const here = readText(path.join(ws.board, p))
    if (here === before) continue
    const there = changed.get(remotePath) ?? { content: before, seq: base.files[remotePath]?.seq ?? base.deleted?.[remotePath] ?? 0 }
    const merged = mergeFile(before, here, there.content)
    facts.push({ path: p, remotePath, base: { content: before, seq: base.files[remotePath]?.seq ?? base.deleted?.[remotePath] ?? 0 }, local: { content: here },
      remote: { content: there.content, seq: there.seq }, automatic: { content: merged.content }, conflicted: !!merged.conflict, reason: merged.conflict ? before === null ? 'same-name-created' : here === null || there.content === null ? 'edit-delete' : 'both-modified' : null })
  }
  if (!facts.some(f => f.conflicted)) return false
  captureConflict(ws.board, ws.project, facts); markUnsent(ws.cwd, true)
  return true
}

async function readSyncedBoard(ws: TaskFolder, head: number | null) {
  const read = await api.readBoard(ws.project, head)
  if (!read.ok) logRunner('board', 'failed', { stage: 'pull', task: ws.number, code: read.code ?? 'unreachable', status: read.status })
  return read
}

/** Between jobs, refresh the board without preparing a task. */
export const pullChanges = (ws: TaskFolder): Promise<api.Call<void>> => inFolder(ws.cwd, async () => {
  if (busy(preparationKey(ws))) return { ok: true, value: undefined }
  const base = readBase(ws)
  if (base.head_seq === null) return { ok: true, value: undefined }
  const read = await readSyncedBoard(ws, base.head_seq)
  if (!read.ok) return read
  const result = await reconcileBoard(ws, base, read.value, sharedMemory(ws.board))
  return result.ok ? { ok: true, value: undefined } : result
})

/** Apply Cloud changes. A deferred change keeps its file base and holds the cursor for replay. */
async function reconcileBoard(ws: TaskFolder, base: Base, board: { files: api.BoardFile[]; head_seq: number }, shared: Shared, taskChat?: string, landTask?: string): Promise<api.Call<Set<string>>> {
  const root = rootOf(ws)
  const conflict = () => {
    const code = 'board_content_conflict'
    logRunner('board', 'failed', { stage: 'pull', task: ws.number, code })
    return { ok: false as const, code, error: 'Resolve the saved board content conflicts before refreshing.' }
  }
  if (pendingConflicts(ws.board).length) return conflict()
  const restored = applyRestorations(ws, base, board.files)
  const held = pendingLandArchives(ws, base).filter(({ task }) => task !== landTask)
  const numbers = new Set(held.map(({ number }) => number))
  const manifests = new Set(held.map(({ task }) => assetsFile(task)))
  if (taskChat) {
    for (const p of filesUnder(path.join(ws.board, '.archive'), ws.board)) {
      const n = numberOfCard(p)
      if (n !== null && n !== ws.number && !base.files[root + p] && archiveMeta(readText(path.join(ws.board, p)) ?? '')) {
        numbers.add(n)
      }
    }
  }
  const privateArchive = (p: string) => numbers.has(numberOfCard(p) ?? 0) || numbers.has(groupOfCard(p) ?? 0) || manifests.has(p)
  const snapshot = base.head_seq === null ? base.files : undefined
  if (!snapshot && observeConflicts(ws, base, board.files, shared, privateArchive)) return conflict()
  if (snapshot) base.files = {}

  const index = syncIndex(ws)
  const paths: string[] = []
  const removed: string[] = []
  let skipped = false
  for (const f of board.files) {
    const p = f.path.startsWith(root) ? f.path.slice(root.length) : f.path
    paths.push(p)
    if (index) rememberDirectories(index.directories, p)
    if (!snapshot && kept(p) && remoteOf(ws, shared, p) === f.path) {
      const file = path.join(ws.board, p)
      const here = readText(file)
      if (here !== f.content) {
        if (!restored.has(p) && here !== (base.files[f.path]?.content ?? null)) {
          skipped = true
          continue
        }
        if (f.content === null) fs.rmSync(file, { force: true })
        else write(file, f.content)
      }
    }
    base.deleted ??= {}
    if (f.content === null) {
      delete base.files[f.path]
      base.deleted[f.path] = f.seq
      removed.push(f.path)
    } else {
      base.files[f.path] = { seq: f.seq, content: f.content }
      delete base.deleted[f.path]
    }
  }
  if (snapshot) {
    for (const p of Object.keys(snapshot)) if (!base.files[p]) removed.push(p)
    resetBoardSnapshot(ws, base, snapshot, shared, privateArchive)
  }
  if (!skipped) base.head_seq = board.head_seq
  base.project = ws.project
  writeBase(ws, base)
  writeIndex(ws.board)
  const tasks = index?.ready ? affectedTasks(ws, paths) : undefined
  if (ws.cloudTask === ws.task) tasks?.add(ws.task)
  return { ok: true, value: await cleanRecords(ws, base, { removed, tasks, taskChat }) }
}

function resetBoardSnapshot(ws: TaskFolder, base: Base, before: Base['files'], shared: Shared, privateArchive: (p: string) => boolean): void {
  const root = rootOf(ws)
  const deferred = new Set(base.deferred)
  const view = viewOf(ws, base, shared)
  for (const p of new Set([...localFiles(ws, base), ...view.keys()])) {
    if (!kept(p) || privateArchive(p)) continue
    const file = path.join(ws.board, p)
    const here = readText(file)
    const content = view.get(p) ?? null
    const previous = before[root + p]
    if (here === content || (here !== (previous?.content ?? null) &&
        (deferred.has(p) || previous && content === null && p.startsWith('.archive/')))) continue
    if (content !== null) write(file, content)
    else if (previous || !isSettingsPath(p)) fs.rmSync(file, { force: true })
  }
}

async function prepareTask(ws: TaskFolder, preserveAssets: boolean, taskChat?: string, landTask?: string): Promise<api.Call<void>> {
  const base = readBase(ws)
  if (base.workspace === undefined) {
    const project = await api.readProject(ws.project)
    if (!project.ok) return project
    base.workspace = project.value.workspace ?? null
  }
  const read = await readSyncedBoard(ws, base.head_seq)
  if (!read.ok) return read
  const shared = sharedMemory(ws.board)
  const refreshed = await reconcileBoard(ws, base, read.value, shared, taskChat, landTask)
  if (!refreshed.ok) return refreshed
  if (refreshed.value.has(ws.task)) return { ok: true, value: undefined }
  const record = readRecord(ws)
  const studio = await pullStudio(ws, record)
  if (!studio.ok) return studio
  const studioShared = sharedMemory(ws.board)
  const previousView = viewOf(ws, base, shared)
  for (const [p, content] of viewOf(ws, base, studioShared)) {
    if (!kept(p) || !p.startsWith(MEMORY) || remoteOf(ws, studioShared, p) === remoteOf(ws, shared, p)) continue
    const file = path.join(ws.board, p)
    if (readText(file) === (previousView.get(p) ?? null) && previousView.get(p) !== content) write(file, content)
  }
  const assets = await pullAssets(ws, record, assetsOf(assetsListOf(ws, base)), preserveAssets)
  if (!assets.ok) return assets
  writeRecord(ws, record)
  return { ok: true, value: undefined }
}

/** `todo/README.md`, which Cloud never keeps, written again from the cards in `todo/`: each card
 *  there, and each group by its root. */
export function writeIndex(board: string): void {
  const todo = path.join(board, 'todo')
  const cards: { id: number; title: string; link: string }[] = []
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(todo, { withFileTypes: true })
  } catch {
    // No cards yet.
  }
  for (const e of entries) {
    const id = /^(\d+)-/.exec(e.name)?.[1]
    if (!id) continue
    const link = e.isDirectory() ? `${e.name}/root.md` : e.name.endsWith('.md') ? e.name : null
    const text = link && readText(path.join(todo, link))
    if (text === null || !link) continue
    cards.push({ id: Number(id), title: cardFront(text).title ?? e.name.replace(/\.md$/, ''), link })
  }
  cards.sort((a, b) => a.id - b.id)
  const list = cards.length ? cards.map((c) => `- [#${c.id} ${c.title}](${c.link})`).join('\n') : '_(none)_'
  const text = `# Board\n\nOpen tasks for the kanban board. One card per file. Ids are global and never reused —\nthe number at the front of a filename is the task id.\n\n## Tasks\n\n${list}\n`
  if (readText(path.join(todo, 'README.md')) !== text) write(path.join(todo, 'README.md'), text)
}

/** The task's workspace, as its last pull read it. */
export const workspaceOf = (ws: TaskFolder): string | null => readBase(ws).workspace ?? null

async function pullAssets(ws: TaskFolder, record: Record_, assets: Assets, preserve = false, stopped?: () => boolean): Promise<api.Call<void>> {
  if (ws.cloudTask && ws.number) { record.task = ws.cloudTask; record.number = ws.number }
  const file = cardFile(ws)
  const out: Record_['assets'] = {}
  for (const [name, ref] of Object.entries(assets)) {
    if (stopped?.()) return { ok: false, code: 'stopped', error: 'Task preparation stopped.' }
    const held = record.assets[name]
    if (isDocumentPreview(name)) {
      if (held?.artifact === ref.artifact && held.version === ref.version) out[name] = held
      continue
    }
    // Implementation keeps usable files even when Cloud metadata is incomplete.
    if (ref.error && !ref.version && !ws.materialIssues) {
      if (held?.artifact === ref.artifact) out[name] = held
      continue
    }
    // One preview that cannot come down keeps its record; the next push names why (#516).
    let target: string | null
    try { target = assetPath(ws, name, file) } catch (error) {
      if (ws.materialIssues && error instanceof Error) ws.materialIssues[name] = error.message
      if (held) out[name] = held
      continue
    }
    if (!target) continue
    let kind = held?.artifact === ref.artifact ? held.kind : undefined
    let version = ref.version
    const localHash = hashFile(target)
    if (ws.materialIssues && localHash !== null) {
      if (held) out[name] = held
      continue
    }
    if (ws.materialIssues?.[name]) { if (held) out[name] = held; continue }
    const unavailable = (failure: Extract<api.Call<unknown>, { ok: false }>) => {
      if (!ws.materialIssues || ['unauthenticated', 'forbidden', 'unauthorized', 'permission_denied'].includes(failure.code ?? '')) return false
      ws.materialIssues[name] = failure.error
      if (held) out[name] = held
      return true
    }
    if (ws.materialIssues && (typeof ref.artifact !== 'string' || !/^art_[a-z0-9]+$/i.test(ref.artifact))) {
      ws.materialIssues[name] = ref.error || 'Missing asset record.'
      if (held) out[name] = held
      continue
    }
    const unpublished = held?.artifact === ref.artifact && held.version > (version ?? 0)
    if (preserve && localHash !== null && (unpublished || !held || localHash !== (held.localHash ?? held.hash))) {
      if (held) out[name] = held
      continue
    }
    const current = held?.artifact === ref.artifact && held.version === version && localHash === (held.localHash ?? held.hash)
    if (version === undefined || !kind || (!current && kind !== 'html')) {
      const latest = await api.readArtifact(ref.artifact)
      if (!latest.ok && unavailable(latest)) continue
      if (!latest.ok && latest.code === 'not_found') { if (held) out[name] = held; continue }
      if (!latest.ok) return latest
      version ??= latest.value.latest_version ?? 0
      kind = latest.value.type
      if (!kind) {
        const failure = { ok: false as const, code: 'bad_request', error: `${name}: 资源类型缺失` }
        if (unavailable(failure)) continue
        return failure
      }
    }
    if (kind === 'html' && held?.artifact === ref.artifact && localHash !== null) {
      out[name] = { ...held, kind, version }
      continue
    }
    if (held?.artifact === ref.artifact && held.version === version && current) {
      out[name] = { ...held, kind }
      continue
    }
    const bytes = await readAsset(ref.artifact, version)
    if (!bytes.ok && unavailable(bytes)) continue
    if (!bytes.ok && bytes.code === 'not_found') { if (held) out[name] = held; continue }
    if (!bytes.ok) return bytes
    let local = bytes.value
    const dependencies: string[] = []
    const manifest = fileManifest(kind, name)
    let data: unknown
    if (manifest?.references) {
      data = Buffer.from(local).toString()
      if (manifest.references.some(r => 'json' in r)) {
        try { data = JSON.parse(data as string) } catch { data = undefined /* 无效 JSON 保持原字节。 */ }
      }
    }
    if (data !== undefined) {
      let changed = false
      const ownerName = name
      const web = manifest?.references?.some(rule => 'web' in rule)
      const restored = mapReferences(manifest, data, (src, found) => {
        const [ref, suffix] = found.text ? splitFileReference(src) : [src, '']
        const name = Object.entries(assets).find(([, r]) => r.artifact === ref)?.[0]
        if (!name) return src
        let child: string | null = null
        try { child = assetPath(ws, name, file) } catch { /* 留作原引用。 */ }
        if (!child) return src
        dependencies.push(name)
        const relative = path.relative(path.dirname(target), child).split(path.sep)
        const back = found.text
          ? (web ? encodeFileReferencePath(relative) : relative.map(encodeURIComponent).join('/')) + suffix
          : isLegacyAssetRef(name) && !isAssetRef(ownerName) ? name : relative.join('/')
        if (back !== src) changed = true
        return back
      })
      if (changed) local = Buffer.from(typeof restored === 'string' ? restored : JSON.stringify(restored))
    }
    const json = data !== undefined && typeof data !== 'string'
    if (held?.artifact === ref.artifact && held.version === version && !held.localHash && json) {
      const source = readText(target)
      if (source !== null) {
        // 旧记录没有本地哈希：确认内容等价后才补记，保留源码及尚未上传的修改。
        let same = false
        try { same = JSON.stringify(JSON.parse(source)) === JSON.stringify(JSON.parse(Buffer.from(local).toString())) } catch { /* 留给上传校验。 */ }
        if (!same) {
          out[name] = { ...held, kind }
          continue
        }
        local = Buffer.from(source)
      }
    }
    if (ws.materialIssues && hashFile(target) !== null) {
      if (held) out[name] = held
      continue
    }
    write(target, local)
    // 改写过引用的页面以本地内容为准，推送时据此认出它没变。
    const hash = hashOf(typeof data === 'string' ? local : bytes.value)
    out[name] = { ...held, kind, dependencies: [...new Set(dependencies)], artifact: ref.artifact, version, hash, localHash: hashOf(local) }
  }
  record.assets = out
  return { ok: true, value: undefined }
}

export async function pullMaterials(ws: TaskFolder, assets: Assets, stopped: () => boolean): Promise<api.Call<void>> {
  return whenPrepared(ws, { ok: false, code: 'stopped', error: 'Task preparation stopped.' }, async () => {
    ws.materialIssues ??= {}
    const record = readRecord(ws)
    const result = await pullAssets(ws, record, { ...assetsOf(assetsListOf(ws, readBase(ws))), ...assets }, true, stopped)
    writeRecord(ws, record)
    return result
  }, stopped)
}

export function localMaterials(ws: TaskFolder) {
  const card = cardFile(ws)
  const { assets } = readRecord(ws)
  return (source: string) => {
    try {
      const file = assetPath(ws, source, card)
      const hash = file && hashFile(file)
      if (!file || !hash) return null
      const held = assets[source]
      return { file, pin: held && hash === (held.localHash ?? held.hash) ? held : undefined }
    } catch { return null }
  }
}

export async function readAsset(artifact: string, version: number, textField?: 'html'): Promise<api.Call<Uint8Array>> {
  const held = await api.readVersion(artifact, version)
  if (!held.ok) return held
  if (held.value.file) return api.download(held.value.file.url)
  const content = held.value.content
  if (content === undefined) return { ok: false, code: 'bad_request', error: 'The version has no saved content.' }
  if (textField && typeof content !== 'string') {
    const text = content && typeof content === 'object' ? (content as Record<string, unknown>)[textField] : undefined
    if (typeof text !== 'string') return { ok: false, code: 'bad_request', error: 'The version has no HTML content.' }
    return { ok: true, value: Buffer.from(text) }
  }
  return { ok: true, value: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)) }
}

interface Sent {
  bytes: Uint8Array
  type: string
  kind: Kind
}

/** What goes up for a file: a mockup as the page it draws, anything else as it is. */
function sentOf(file: string, kind: Kind, data: unknown): Sent {
  if (kind === 'html' && typeof data === 'string') return { bytes: Buffer.from(data), type: 'text/html', kind }
  const ext = path.extname(file).toLowerCase()
  const office = officeExtension(file)
  const type = office ? OFFICE_TYPES[office] : kind === 'tiled' && ext === '.tsx' ? 'application/xml' : TYPES[ext]
  return { bytes: fs.readFileSync(file), type: type ?? 'application/octet-stream', kind }
}

/** The card's previews that cannot be drawn, each with why. */
export const undrawnPreviews = (ws: TaskFolder): string[] =>
  Object.entries(assetsOf(readText(path.join(ws.board, assetsFile(ws.task))))).flatMap(([key, ref]) => ref.error ? [`${key}: ${ref.error}`] : [])

/** Why a preview cannot be drawn, with its paths as the card names them. */
function undrawn(ws: TaskFolder, reason: string): string {
  for (const [root, prefix] of [[path.join(projectStateDir(ws.board), 'assets', String(ws.number)), 'asset:'], [ws.board, '']]) {
    reason = reason.split(`file://${root}${path.sep}`).join(prefix).split(`${root}${path.sep}`).join(prefix)
  }
  return reason.replace(/ \(at [^)]*file:\/\/[^)]*\)$/, '').slice(0, 500)
}

function previewFailure<T extends { code?: string; status?: number }>(
  stage: 'create_artifact' | 'create_upload' | 'upload' | 'complete_upload' | 'commit_version', task: number | null, failure: T,
): T {
  logRunner('preview', 'failed', { stage, task, code: failure.code ?? 'unreachable', status: failure.status })
  return failure
}

async function uploadAsset(task: number | null, artifact: string, { bytes, type }: Sent): Promise<api.Call<string>> {
  const upload = await api.createUpload(artifact, type, Math.max(bytes.length, 1))
  if (!upload.ok) return previewFailure('create_upload', task, upload)
  const { id, url, parts } = upload.value
  if (parts) {
    for (let part = 1; part <= parts.count; part++) {
      const put = await api.upload(parts.url.replace('{part}', String(part)), bytes.subarray((part - 1) * parts.size, part * parts.size), type)
      if (!put.ok) return previewFailure('upload', task, put)
    }
    const done = await api.completeUpload(url ?? `/v1/uploads/${encodeURIComponent(id)}/complete`)
    if (!done.ok) return previewFailure('complete_upload', task, done)
  } else {
    const put = await api.upload(url ?? `/v1/uploads/${encodeURIComponent(id)}`, bytes, type)
    if (!put.ok) return previewFailure('upload', task, put)
  }
  return { ok: true, value: id }
}

const artifactKey = (task: string, file: string, kind: Kind, previous?: string) =>
  'runner-artifact-' + hashOf(JSON.stringify([task, file, kind, previous]))

async function finishAssetVersion(ws: TaskFolder, record: Record_, key: string, pending: NonNullable<Record_['pendingVersions']>[string]): Promise<api.Call<number>> {
  const made = await api.createVersion(pending.artifact, pending.upload)
  if (!made.ok) {
    previewFailure('commit_version', ws.number, made)
    if (made.code === 'conflict' && made.error === 'That upload is unfinished, or already used.') {
      delete record.pendingVersions![key]
      writeRecord(ws, record)
      return { ok: false, error: `${key}: ${made.error}` }
    }
    return { ...made, error: `${key}: ${made.error}` }
  }
  delete record.pendingVersions![key]
  return { ok: true, value: made.value.version }
}

async function pushDocumentPreview(ws: TaskFolder, record: Record_, key: string, ext: OfficeExtension, source: Uint8Array): Promise<api.Call<Assets[string] | undefined>> {
  if (!ws.cloudTask) return { ok: true, value: undefined }
  const previous = record.assets[key]
  if (previous?.version) return { ok: true, value: { artifact: previous.artifact, version: previous.version } }
  record.pendingVersions ??= {}
  let pending = record.pendingVersions[key]
  if (!pending) {
    let bytes: Uint8Array
    try {
      const { renderOfficePdf } = await import('./document-preview')
      bytes = await renderOfficePdf(source, ext)
    } catch (error) {
      logSync('assets.documentPreviewUnavailable', { project: ws.project, task: ws.task, reason: error instanceof Error ? error.message : String(error) })
      return { ok: true, value: undefined }
    }
    const made = await api.createArtifact(ws.cloudTask, key, 'asset', artifactKey(ws.cloudTask, key, 'asset'))
    if (!made.ok) return previewFailure('create_artifact', ws.number, made)
    const sent = await uploadAsset(ws.number, made.value.id, { bytes, type: PDF, kind: 'asset' })
    if (!sent.ok) return sent
    pending = record.pendingVersions[key] = { artifact: made.value.id, hash: hashOf(bytes), upload: sent.value }
    writeRecord(ws, record)
  }
  const version = await finishAssetVersion(ws, record, key, pending)
  if (!version.ok) return version
  record.assets[key] = { artifact: pending.artifact, version: version.value, hash: pending.hash, kind: 'asset' }
  writeRecord(ws, record)
  return { ok: true, value: { artifact: pending.artifact, version: version.value } }
}

/** Record each successful upload so later syncs can reuse it. */
async function pushAssets(ws: TaskFolder, record: Record_, before: Assets): Promise<api.Call<{ refs: Assets; retryPreviews: boolean } | undefined>> {
  const started = performance.now()
  logSync('assets.start', { project: ws.project, task: ws.task, entries: Object.keys(record.assets).length })
  if (ws.cloudTask && ws.number && (record.task !== ws.cloudTask || record.number !== ws.number)) {
    record.task = ws.cloudTask; record.number = ws.number; writeRecord(ws, record)
  }
  const file = cardFile(ws)
  const body = readText(file)
  if (body === null) return { ok: true, value: undefined }
  const refs: Assets = {}
  const currentDocumentPreviews = new Set<string>()
  let retryPreviews = false
  const sources = bodyReferences(body)
  // Keep the existing index of cards that still use only legacy task references.
  const legacy = !sources.some(ref => isAssetRef(ref.src))
    && (sources.some(ref => isLegacyAssetRef(ref.src)) || Object.keys(before).some(isLegacyAssetRef))
  const folder = ws.number === null ? null : realPathOf(cardAssetsDir(ws, ws.number))
  const canonical = (target: string) => {
    const real = realPathOf(target)
    if (folder && real.startsWith(folder + path.sep)) {
      const local = path.relative(folder, real).split(path.sep).join('/')
      return legacy ? `.assets/${ws.number}/${local}` : assetRef(local)
    }
    return path.relative(realPathOf(path.dirname(file)), real).split(path.sep).join('/')
  }
  const equivalent = new Map<string, string[]>()
  for (const source of new Set([...Object.keys(before), ...Object.keys(record.assets)])) {
    const name = taskAssetPath(source, ws.number ?? undefined)
    if (name !== null) equivalent.set(name, [...(equivalent.get(name) ?? []), source])
  }
  const keysOf = (source: string) => [source, ...(equivalent.get(taskAssetPath(source, ws.number ?? undefined) ?? '') ?? [])]
  const required = new Map<string, number>()
  for (const block of parsePreviewBlocks(body).blocks) {
    const contentStart = body.indexOf('>', block.start) + 1
    const content = body.slice(contentStart, body.lastIndexOf('</Preview', block.end - 1))
    const start = sourcePosition(body, contentStart).line
    const locations = new Map<string, number>()
    for (const ref of bodyReferences(content, (src, line) => {
      if (!locations.has(src)) locations.set(src, start + line - 1)
    })) {
      if (ref.types.length || isTaskAssetRef(ref.src) || /^file:/i.test(ref.src) || path.win32.isAbsolute(ref.src)) required.set(ref.src, locations.get(ref.src)!)
    }
  }
  try {
    let recoveredReferences = false
    const graph = await collect(body, file, {
      resolve: (src, owner) => {
        // 已有 artifact ID 只允许来自本任务清单。
        const id = Object.entries(before).find(([, ref]) => ref.artifact === src)
        if (id) return { key: id[0], file: null }
        const target = assetPath(ws, src, owner, owner !== file)
        if (!target) return null
        const key = canonical(target)
        if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) {
          const saved = (owner === file ? [src, ...keysOf(key)] : keysOf(key)).find(name => before[name]?.artifact)
          if (saved) return { key: saved, file: null }
          throw new Error(`file not found: ${target}`)
        }
        return { key, file: target }
      },
      read: (target, kind) => {
        if (fs.statSync(target).size > ASSET_FILE_LIMIT) throw new Error('This asset is over 100 MiB.')
        return referenceText(target, kind)
      },
      retained: (key, types) => {
        let dependencies = record.assets[key]?.dependencies ?? before[key]?.dependencies
        if (!dependencies && types.length === 1 && types[0] === 'studio' && before[key] && !recoveredReferences) {
          recoveredReferences = true
          dependencies = Object.keys(before).filter(src => src !== key)
        }
        return (dependencies ?? []).map(src => {
          const kind = record.assets[src]?.kind
          return { src, types: kind ? [kind] : [] }
        })
      },
    })
    for (const node of graph) {
      const aliases = [...node.aliases]
      const previous = [...aliases, ...keysOf(node.key)].map(key => record.assets[key]).find(Boolean)
      const old = [...aliases, ...keysOf(node.key)].map(key => before[key]).find(Boolean)
      const kind = node.kind as Kind
      let out: Sent | undefined
      const partialStudio = node.kind === 'studio' && (node.data as { version?: number })?.version === 2
      let why = node.error ?? (partialStudio ? undefined : [...node.dependencies.values()].map(key => refs[key]?.error).find(Boolean))
      if (!why && node.file) {
        try {
          if (fs.statSync(node.file).size > ASSET_FILE_LIMIT) throw new Error('This asset is over 100 MiB.')
          out = sentOf(node.file, kind, node.data)
        }
        catch (error) { why = renderError(error) }
      }
      if (!why && !node.file && old?.error && !old.version) why = old.error
      if (why) {
        const key = [...node.aliases].find(alias => required.has(alias))
        if (key) {
          const error = `${path.relative(ws.board, file)}:${required.get(key)} — ${key}: ${undrawn(ws, why)}`
          return { ok: false, code: 'bad_request', error, failure: validationFailure(error, 'preview_attachment') }
        }
        let pin: Assets[string] | null = old ? { ...old }
          : previous?.version ? { artifact: previous.artifact, version: previous.version, ...(previous.dependencies ? { dependencies: previous.dependencies } : {}) } : null
        if (!pin) {
          if (!ws.cloudTask) continue
          let artifact = previous?.artifact
          if (!artifact) {
            const made = await api.createArtifact(ws.cloudTask, node.key.slice(0, 200), kind, artifactKey(ws.cloudTask, node.key, kind))
            if (!made.ok) return { ...previewFailure('create_artifact', ws.number, made), error: `${node.key}: ${made.error}` }
            artifact = made.value.id
            for (const alias of node.aliases) record.assets[alias] = { artifact, kind, version: 0, hash: '' }
            writeRecord(ws, record)
          }
          pin = { artifact }
        }
        for (const alias of node.aliases) refs[alias] = { ...pin, error: undrawn(ws, why) }
        continue
      }
      if (!node.file || !out) {
        if (old?.error && !old.version) for (const alias of node.aliases) refs[alias] = old
        else if (old) {
          let version = old.version ?? (previous?.artifact === old.artifact ? previous.version : undefined)
          if (version === undefined) {
            const art = await api.readArtifact(old.artifact)
            if (!art.ok) return art
            version = art.value.latest_version ?? 0
          }
          for (const alias of node.aliases) refs[alias] = { artifact: old.artifact, version, ...(old.dependencies ? { dependencies: old.dependencies } : {}) }
          const previewKey = documentPreviewKey(old.artifact, version)
          currentDocumentPreviews.add(previewKey)
          if (before[previewKey]) refs[previewKey] = before[previewKey]
        }
        continue
      }
      if (previous && previous.kind !== kind) {
        const artifact = await api.readArtifact(previous.artifact)
        if (!artifact.ok) return artifact
        if (!artifact.value.type) return { ok: false, code: 'bad_request', error: `${node.key}: 资源类型缺失` }
        previous.kind = artifact.value.type
      }
      const manifest = fileManifest(kind, node.file)
      const json = !!manifest?.references && node.data !== undefined && typeof node.data !== 'string'
      if (manifest?.references && node.data !== undefined) {
        const map = (src: string) => {
          const key = node.dependencies.get(src)
          const artifact = key && refs[key]?.artifact
          return artifact ? artifact + (json ? '' : splitFileReference(src)[1]) : src
        }
        out = json
          ? { kind, type: 'application/json', bytes: Buffer.from(JSON.stringify(mapReferences(manifest, node.data, map))) }
          : { ...out, bytes: Buffer.from(mapReferences(manifest, node.data, map) as string) }
      }
      const hash = hashOf(out.bytes)
      let entry = previous
      const localHash = hashFile(node.file)
      const restored = json || (typeof node.data === 'string' && previous?.hash === localHash)
      const unchanged = restored && previous && (previous.kind ?? out.kind) === out.kind
        && localHash === (previous.localHash ?? previous.hash)
        && [...node.dependencies.values()].every(key => refs[key]?.artifact === before[key]?.artifact)
      if (!entry || (!unchanged && entry.hash !== hash) || (entry.kind && entry.kind !== out.kind)) {
        if (!ws.cloudTask) continue
        let artifact = previous && (previous.kind ?? kindOf(path.extname(node.file).toLowerCase())) === out.kind ? previous.artifact : undefined
        if (!artifact) {
          const made = await api.createArtifact(ws.cloudTask, node.key.slice(0, 200), out.kind, artifactKey(ws.cloudTask, node.key, out.kind, previous?.artifact))
          if (!made.ok) return { ...previewFailure('create_artifact', ws.number, made), error: `${node.key}: ${made.error}` }
          artifact = made.value.id
          for (const alias of node.aliases) record.assets[alias] = { artifact, kind: out.kind, version: 0, hash: '' }
          writeRecord(ws, record)
        }
        record.pendingVersions ??= {}
        let pending = record.pendingVersions[node.key]
        if (pending?.artifact !== artifact || pending.hash !== hash) {
          const sent = await uploadAsset(ws.number, artifact, out)
          if (!sent.ok) return { ...sent, error: `${node.key}: ${sent.error}` }
          pending = record.pendingVersions[node.key] = { artifact, hash, upload: sent.value }
          writeRecord(ws, record)
        }
        const version = await finishAssetVersion(ws, record, node.key, pending)
        if (!version.ok) return version
        entry = { artifact, version: version.value, hash, kind: out.kind }
      }
      entry = { ...entry, localHash: localHash ?? undefined, dependencies: [...node.dependencies.values()] }
      let changed = false
      for (const alias of node.aliases) {
        if (!isDeepStrictEqual(record.assets[alias], entry)) {
          record.assets[alias] = entry
          changed = true
        }
        refs[alias] = { artifact: entry.artifact, version: entry.version, ...(entry.dependencies?.length || /\.(html?|css|json|tsx|tmx|tmj|tsj)$/i.test(alias) ? { dependencies: entry.dependencies ?? [] } : {}) }
      }
      if (changed) writeRecord(ws, record)
      const office = out.kind === 'asset' && officeExtension(node.file)
      if (office && entry.version > 0) {
        const key = documentPreviewKey(entry.artifact, entry.version)
        currentDocumentPreviews.add(key)
        const preview = before[key]?.version ? { ok: true as const, value: before[key] } : await pushDocumentPreview(ws, record, key, office, out.bytes)
        if (!preview.ok) {
          retryPreviews ||= api.temporaryCloudFailure(preview)
          logSync('assets.documentPreviewUnavailable', { project: ws.project, task: ws.task, reason: preview.error })
          continue
        }
        if (preview.value) {
          refs[key] = preview.value
          for (const alias of node.aliases) {
            const ref = refs[alias]!
            ref.dependencies = [...(ref.dependencies ?? []), key]
          }
        }
      }
    }
    for (const name of Object.keys(record.assets)) {
      if (isDocumentPreview(name) && !refs[name]) delete record.assets[name]
    }
    for (const name of Object.keys(record.pendingVersions ?? {})) {
      if (isDocumentPreview(name) && !currentDocumentPreviews.has(name)) delete record.pendingVersions![name]
    }
  } catch (error) {
    return { ok: false, code: 'bad_request', error: error instanceof Error ? error.message : String(error) }
  }
  logSync('assets.end', { project: ws.project, task: ws.task, ms: Math.round(performance.now() - started) })
  return { ok: true, value: { refs, retryPreviews } }
}

/** Each item the job added to `triage/`, proposed from its task on its studio — the job's when
 *  the file names none — as `akb raw triage add` cannot know either. */
function proposeItems(ws: TaskFolder, base: Base, paths?: string[]): void {
  const root = rootOf(ws)
  for (const p of paths ?? localFiles(ws, base)) {
    if (itemAt(p)?.state !== 'open' || base.files[root + p]) continue
    const file = path.join(ws.board, p)
    const content = fs.readFileSync(file, 'utf8')
    const said = (key: string) => new RegExp(`^${key}:`, 'm').test(content.split(/\n---/)[0] ?? '')
    const fields: Record<string, string> = {
      ...(ws.cloudTask && !said('source_task') ? { source_task: ws.cloudTask } : {}),
      ...(ws.studio && !said('studio') ? { studio: studioName(ws.studio) } : {}),
    }
    const stamped = Object.keys(fields).length ? stampItem(content, fields) : content
    if (stamped !== content) write(file, stamped)
  }
}

/** Only unambiguous three-way changes can synchronize without a content decision. */
export function mergeFile(base: string | null, mine: string | null, theirs: string | null): { content: string | null; conflict?: true } {
  if (mine === theirs || theirs === base) return { content: mine }
  if (mine === base) return { content: theirs }
  if (mine === null || theirs === null) return { content: mine, conflict: true }
  const lines: string[] = []
  for (const block of diff3Merge(mine.split('\n'), (base ?? '').split('\n'), theirs.split('\n'), { excludeFalseConflicts: true })) {
    if (block.conflict) return { content: mine, conflict: true }
    if (block.ok) lines.push(...block.ok)
  }
  return { content: lines.join('\n') }
}

const conflictFailure = (ws: TaskFolder, status?: number): Pushed => ({ ok: false, conflict: true, code: 'board_content_conflict',
  ...(status === undefined ? {} : { status }),
  error: `Board content conflicts require explicit resolution: ${conflictList(ws.board).map(r => `${r.id} (${r.paths.join(', ')})`).join('; ')}. Read akb guide resolve-conflict.` })

export const push = (ws: TaskFolder, job: { id: string; machineId: string }, stopped?: () => boolean): Promise<Pushed> =>
  inFolder(ws.cwd, async () => {
    if (stopped?.()) return { ok: false, conflict: false, code: 'stopped', error: 'Task preparation stopped.' }
    if (busy(preparationKey(ws))) return { ok: false, conflict: false, offline: true, error: 'Task content is still being prepared.' }
    return sendMarked(ws, job)
  })

const preparationKey = (ws: TaskFolder) => path.join(projectStateDir(ws.board), 'preparing')

/** Wait outside the synchronization lock so the owner can publish and release it. */
async function whenPrepared<T>(ws: TaskFolder, cancelled: T, work: () => Promise<T>, stopped = () => false): Promise<T> {
  while (!stopped()) {
    const result = await inFolder(ws.cwd, async () => {
      if (stopped()) return { value: cancelled }
      if (!busy(preparationKey(ws))) return { value: await work() }
    })
    if (result) return result.value
    await delay(100)
  }
  return cancelled
}

/** Preparation stays private to its task until its files can be sent. */
export async function withBoard<T>(ws: TaskFolder, work: (send: (job: { id: string; machineId: string }) => Promise<Pushed>) => Promise<T>, stopped?: () => boolean): Promise<T | undefined> {
  const release = await whenPrepared(ws, undefined, async () => hold(preparationKey(ws)), stopped)
  if (!release) return
  try {
    if (!stopped?.()) return await work(job => inFolder(ws.cwd, () => sendMarked(ws, job)))
  } finally { release() }
}

/** What changed on the board, for no job (#59). */
export const pushBoard = (ws: TaskFolder, machineId: string, paths?: string[]): Promise<Pushed> =>
  inFolder(ws.cwd, () => {
    if (busy(preparationKey(ws))) {
      markUnsent(ws.cwd, true)
      return Promise.resolve({ ok: false as const, conflict: false, offline: true, error: 'Task content is still being prepared.' })
    }
    return sendBoard(ws, machineId, { paths })
  })

function pendingLandArchives(ws: TaskFolder, base: Base) {
  return landArchiveOwners(ws.board, base.pendingArchives).flatMap(owner => {
    const card = findCard(ws.board, owner.number)
    const archived = card && path.relative(ws.board, card).split(path.sep).join('/')
    return archived?.startsWith('.archive/') ? [{ ...owner, archived }] : []
  })
}

function repairLandBlockers(ws: TaskFolder, base: Base, pending: ReadonlySet<number>, selected?: Set<string>) {
  if (!pending.size) return
  const root = rootOf(ws)
  const previous = new Map<number, string>()
  for (const [name, row] of Object.entries(base.files)) {
    if (row.seq <= 0 || !name.startsWith(root + 'todo/')) continue
    const number = numberOfCard(name.slice(root.length))
    if (number !== null) previous.set(number, row.content)
  }
  for (const file of filesUnder(path.join(ws.board, 'todo'), ws.board)) {
    const number = numberOfCard(file)
    const before = number === null ? undefined : previous.get(number)
    if (!before) continue
    const target = path.join(ws.board, file)
    const text = readText(target)
    if (text === null) continue
    const repaired = restoreLandBlockers(text, before, pending)
    if (repaired === text) continue
    write(target, repaired)
    selected?.add(file)
  }
}

export function protectLandArchive(ws: TaskFolder, job: string, stopped: () => boolean) {
  return inFolder(ws.cwd, async () => {
    if (stopped() || !ws.number) return
    const file = landArchiveMarker(ws.board, ws.task)
    if (!isDeepStrictEqual(readLandArchiveOwner(file), { job, number: ws.number })) {
      writeLandArchiveOwner(file, { job, number: ws.number })
    }
    const base = readBase(ws)
    if (pendingLandArchives(ws, base).some(owner => owner.task === ws.task)) {
      repairLandBlockers(ws, base, new Set([ws.number]))
    }
    const receipt = base.archiveReceipts?.[ws.task]
    if (receipt && receipt.status !== 'confirmed') {
      delete base.archiveReceipts![ws.task]
      writeBase(ws, base)
    }
  })
}

export const confirmLandArchive = (ws: Pick<TaskFolder, 'board' | 'cwd' | 'task'>, job: string) => inFolder(ws.cwd, async () => {
  const file = landArchiveMarker(ws.board, ws.task)
  if (readLandArchiveOwner(file)?.job === job) fs.rmSync(file, { force: true })
})

type BoardWriteScope = { paths?: string[]; taskChat?: string; taskNumber?: number }

/** Never before the board was first read: everything here would go up as new. */
async function sendBoard(ws: TaskFolder, machineId: string, scope: BoardWriteScope): Promise<Pushed> {
  if (readBase(ws).head_seq === null) return { ok: true, changed: false }
  return sendMarked(ws, { id: null, machineId }, scope)
}

async function sendMarked(ws: TaskFolder, job: { id: string | null; machineId: string }, scope: BoardWriteScope = {}): Promise<Pushed> {
  const fields = { stage: 'push', task: ws.number, job: job.id }
  const fullBoardSync = !job.id && !ws.cloudTask && !scope.taskChat
  const hadUnsent = !fullBoardSync && unsent(ws.cwd)
  try {
    const pushed = pendingConflicts(ws.board).length ? conflictFailure(ws) : await send(ws, job, scope)
    if (!pushed.ok) logRunner('board', 'failed', { ...fields, code: pushed.code ?? (pushed.offline ? 'unreachable' : 'unknown_error'), status: pushed.status })
    const base = readBase(ws)
    markUnsent(ws.cwd, hadUnsent || !pushed.ok || !!base.pendingAssets?.length || !!base.pendingPreviews?.length
      || !!Object.keys(base.pendingArchives ?? {}).length || !!base.pendingRemovals?.length || pendingLandArchives(ws, base).length > 0)
    return pushed
  } catch (error) {
    logRunner('board', 'failed', { ...fields, code: errno(error) })
    throw error
  }
}

interface TaskIndex {
  task: string
  deleted?: Record_['deleted']
  number: number
  paths: Set<string>
}

interface SyncIndex {
  identity: string
  directories: Set<string>
  ready: boolean
  archivesReady: boolean
  retiring: Set<string>
  tasks: Map<string, TaskIndex>
  files: Map<string, Set<string>>
}
const boardIdentity = (ws: TaskFolder) => {
  const stat = fs.statSync(ws.board)
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
}
function rememberDirectories(directories: Set<string>, file: string): void {
  for (let dir = path.posix.dirname(file); dir !== '.' && dir !== '/'; dir = path.posix.dirname(dir)) directories.add(dir)
}
function newIndex(ws: TaskFolder): SyncIndex {
  const directories = new Set<string>()
  for (const p of Object.keys(readBase(ws).files)) {
    if (p.startsWith(rootOf(ws))) rememberDirectories(directories, p.slice(rootOf(ws).length))
  }
  return { identity: boardIdentity(ws), directories, ready: false, archivesReady: false, retiring: new Set(), tasks: new Map(), files: new Map() }
}
const taskIndexes = new Map<string, SyncIndex>()

function syncIndex(ws: TaskFolder): SyncIndex | undefined {
  const index = taskIndexes.get(ws.cwd)
  if (index && index.identity !== boardIdentity(ws)) {
    taskIndexes.delete(ws.cwd)
    return undefined
  }
  return index
}

function forgetTask(index: SyncIndex, task: string): void {
  for (const file of index.tasks.get(task)?.paths ?? []) {
    const tasks = index.files.get(file)!
    tasks.delete(task)
    if (!tasks.size) index.files.delete(file)
  }
  index.tasks.delete(task)
  index.retiring.delete(task)
}

function indexTask(ws: TaskFolder, record: Record_, card = cardFile(ws)): void {
  if (!ws.cloudTask || !ws.number) return
  const paths = new Set([card, path.join(ws.board, assetsFile(ws.task)), recordFile(ws)])
  for (const name of Object.keys(record.assets)) {
    try {
      const file = assetPath(ws, name, card)
      if (file) paths.add(file)
    } catch { /* Invalid references are reported by pushAssets. */ }
  }
  for (const file of [...paths]) {
    for (let dir = path.dirname(file); dir.startsWith(ws.cwd + path.sep); dir = path.dirname(dir)) paths.add(dir)
  }
  const index = syncIndex(ws) ?? newIndex(ws)
  for (const file of index.tasks.get(ws.task)?.paths ?? []) {
    const tasks = index.files.get(file)!
    tasks.delete(ws.task)
    if (!tasks.size) index.files.delete(file)
  }
  index.tasks.set(ws.task, { task: ws.task, number: ws.number, deleted: record.deleted, paths })
  for (const file of paths) {
    const tasks = index.files.get(file) ?? new Set<string>()
    tasks.add(ws.task)
    index.files.set(file, tasks)
  }
  taskIndexes.set(ws.cwd, index)
}

function affectedTasks(ws: TaskFolder, paths: Iterable<string>): Set<string> {
  const index = syncIndex(ws)
  const tasks = new Set<string>(index?.retiring)
  for (const p of paths) {
    for (const task of index?.files.get(path.resolve(ws.board, p)) ?? []) tasks.add(task)
    const task = taskOfRemoval(p) ?? /^\.sync\/([\w-]+)\.json$/.exec(p)?.[1]
    if (task) tasks.add(task)
  }
  return tasks
}

async function send(ws: TaskFolder, job: { id: string | null; machineId: string }, { paths, taskChat, taskNumber }: BoardWriteScope, retryRestore = true): Promise<Pushed> {
  const record = readRecord(ws)
  const base = readBase(ws)
  const fail = (error: string, conflict = false, code?: string, status?: number): Pushed =>
    ({ ok: false, conflict, error, code, ...(status === undefined ? {} : { status }), ...(api.temporaryCloudFailure({ code, status }) ? { offline: true } : {}) })

  // A first reconciliation also catches edits made while the Runner was stopped.
  const boardSync = !job.id && !ws.cloudTask
  const singleTask = ws.cloudTask && ws.number !== null
    ? { task: ws.cloudTask, number: ws.number, chat: false }
    : taskChat && taskNumber !== undefined
      ? { task: taskChat, number: taskNumber, chat: true }
      : null
  const fullBoardSync = boardSync && !singleTask
  const discoverArchives = fullBoardSync && !syncIndex(ws)?.archivesReady
  if (fullBoardSync && (!syncIndex(ws)?.ready || discoverArchives)) paths = undefined
  const heldTaskPreviews = (base.pendingPreviews ?? []).filter(p => !singleTask
    || numberOfCard(p) === singleTask.number || groupOfCard(p) === singleTask.number || taskOfAssets(p) === singleTask.task)
  const selected = paths && new Set([...paths, ...heldTaskPreviews])
  const pendingArchives = new Map(Object.entries(base.pendingArchives ?? {}))
  const names = selected ? new Set([...(base.pendingAssets ?? []), ...(fullBoardSync ? pendingArchives.keys() : [])]) : null
  if (selected) for (const task of affectedTasks(ws, selected)) names!.add(task)
  const retired = await cleanRecords(ws, base, { tasks: singleTask ? [singleTask.task] : names ?? undefined, taskChat })
  const singleFolder = singleTask ? { ...ws, task: singleTask.task, cloudTask: singleTask.task, number: singleTask.number } : null
  const singleRecord = singleFolder ? (ws.cloudTask ? record : readRecord(singleFolder)) : record
  if (retired.has(singleFolder?.task ?? ws.task)) singleRecord.deleted = true
  const records = singleFolder ? [] : names ? [...names].map(task => `${task}.json`) : [...new Set([
    ...filesUnder(path.join(ws.board, '.sync')).filter(name => name.endsWith('.json') && !taskOfRemoval('.sync/' + name)),
    ...[...(syncIndex(ws)?.tasks.keys() ?? [])].map(task => `${task}.json`),
  ])]
  const tasks = singleFolder ? [{ folder: singleFolder, record: singleRecord }] : records.flatMap(name => {
    let held: Record_
    try { held = JSON.parse(fs.readFileSync(path.join(ws.board, '.sync', name), 'utf8')) as Record_ }
    catch {
      const known = syncIndex(ws)?.tasks.get(name.replace(/\.json$/, ''))
      if (!known) return []
      const before = assetsOf(assetsListOf({ ...ws, task: known.task }, base))
      held = { task: known.task, number: known.number, deleted: known.deleted ?? (syncIndex(ws)?.retiring.has(known.task) ? true : undefined), assets: Object.fromEntries(Object.entries(before)
        .map(([name, ref]) => [name, { artifact: ref.artifact, version: ref.version ?? 0, hash: '' }])) }
      writeRecord({ ...ws, task: known.task }, held)
    }
    if (!held.task || !TASK_ID.test(held.task) || !held.number) return []
    return [{ folder: { ...ws, task: held.task, cloudTask: held.task, number: held.number }, record: held }]
  })
  if (!syncIndex(ws)) taskIndexes.set(ws.cwd, newIndex(ws))
  const archives = new Map<string, string>()
  const retryAssets = new Set(base.pendingAssets)
  const deferredCards = new Set<number>()
  const deferredLists = new Set<string>()
  const protectedCards = new Set<number>()
  const protectedLists = new Set<string>()
  const pendingBlockers = new Set<number>()
  for (const { task, file, job: owner, number, archived } of pendingLandArchives(ws, base)) {
    const ownsArchive = owner !== null && owner === job.id && singleTask?.task === task && !singleTask.chat
    if (!ownsArchive && fullBoardSync && !task.startsWith('unowned-') && (owner === null || base.files[rootOf(ws) + archived])) {
      // A Runner may have stopped after Cloud confirmed Land and before removing its mark.
      const current = await api.readTask(task)
      if (current.ok && (current.value.status === 'done' || current.value.status === 'cancelled' && !!base.files[rootOf(ws) + archived])) {
        fs.rmSync(file, { force: true })
        continue
      }
    }
    pendingBlockers.add(number)
    if (ownsArchive) continue
    protectedCards.add(number)
    protectedLists.add(assetsFile(task))
    pendingArchives.delete(task)
  }
  repairLandBlockers(ws, base, pendingBlockers, selected)
  const assetErrors: Record<string, SyncProblem> = {}
  const processed = new Set<string>()
  const assetLists = new Map<string, { local: string | null; content: string }>()
  const generatedAssets = new Set<string>()
  const cards = !selected && !singleFolder ? new Map(
    ['.archive', 'todo'].flatMap(dir => filesUnder(path.join(ws.board, dir), ws.board))
      .flatMap(p => { const number = numberOfCard(p); return number ? [[number, p] as const] : [] }),
  ) : null
  for (const item of tasks) {
    if (protectedCards.has(item.folder.number!)) continue
    processed.add(item.folder.task)
    if (processed.size === 1 || processed.size % 25 === 0) logSync('board.progress', { project: ws.project, processed: processed.size, total: tasks.length })
    const card = cards?.get(item.folder.number!) ?? path.relative(ws.board, cardFile(item.folder)).split(path.sep).join('/')
    indexTask(item.folder, item.record, path.join(ws.board, card))
    selected?.add(card)
    const before = assetsOf(assetsListOf(item.folder, base))
    const newer = Object.entries(before).some(([name, ref]) => {
      const held = item.record.assets[name]
      return held?.artifact === ref.artifact && (ref.version ?? 0) > held.version
    })
    const clean = () => Object.entries(item.record.assets).every(([name, entry]) => {
      try {
        const file = assetPath(item.folder, name, path.join(ws.board, card))
        return !file || hashFile(file) === (entry.localHash ?? entry.hash)
      } catch { return false }
    })
    const archive = fullBoardSync && card.startsWith('.archive/') && !item.record.deleted
    const listPath = assetsFile(item.folder.task)
    const archived = !selected && archive && !retryAssets.has(item.folder.task)
      && !Object.keys(item.record.pendingVersions ?? {}).length
      && readText(path.join(ws.board, listPath)) === (base.files[rootOf(ws) + listPath]?.content ?? null)
      && readText(path.join(ws.board, card)) === base.files[rootOf(ws) + card]?.content
      && !newer && clean()
    retryAssets.delete(item.folder.task)
    if (!archived && !item.record.deleted) {
      // Cloud can advance an archived preview while its local source is unchanged.
      const refreshed = newer && clean() ? await pullAssets(item.folder, item.record, before, true) : { ok: true as const, value: undefined }
      const assets = refreshed.ok ? await pushAssets(item.folder, item.record, before) : refreshed
      if (assets.ok) {
        if (assets.value?.retryPreviews) retryAssets.add(item.folder.task)
        writeRecord(item.folder, item.record)
        indexTask(item.folder, item.record)
        if (archive) archives.set(item.folder.task, card)
        const list = listPath
        const local = readText(path.join(ws.board, list))
        const refs = assets.value?.refs
        if (refs && (local !== null || Object.keys(refs).length)) {
          const content = isDeepStrictEqual(assetsOf(local), refs) && local !== null ? local : assetsText(refs)
          assetLists.set(list, { local, content })
          for (const file of assetFiles(item.folder, content, path.join(ws.board, card))) generatedAssets.add(file)
        }
        selected?.add(list)
        continue
      }
      if (!boardSync && !assets.failure) return fail(assets.error, false, assets.code, assets.status)
      if (job.id && ws.cloudTask && assets.failure) return { ok: false, conflict: false, error: assets.error, failure: assets.failure }
      if (assets.code !== 'conflict' || !assets.error.endsWith(': This task has finished.')) {
        retryAssets.add(item.folder.task)
        assetErrors[item.folder.task] = { error: assets.error, failure: assets.failure, code: assets.code, ...(api.temporaryCloudFailure(assets) ? { offline: true } : {}) }
      }
    }
    if (archived) archives.set(item.folder.task, card)
    deferredCards.add(item.folder.number!)
    deferredLists.add(listPath)
  }
  if (fullBoardSync) syncIndex(ws)!.ready = true
  const scoped = selected && [...new Set([...selected].flatMap(p => {
    if (!isBoardPath(p) && !fs.statSync(path.join(ws.board, p), { throwIfNoEntry: false })?.isDirectory()) return []
    const file = path.join(ws.board, p)
    return fs.statSync(file, { throwIfNoEntry: false })?.isDirectory() ? filesUnder(file, ws.board).filter(kept) : kept(p) ? [p] : []
  }))].filter(p => fs.statSync(path.join(ws.board, p), { throwIfNoEntry: false })?.isFile())
  for (const p of scoped ?? []) rememberDirectories(syncIndex(ws)!.directories, p)
  const ownCardPath = singleFolder ? path.relative(ws.board, cardFile(singleFolder)).split(path.sep).join('/') : null
  const ownArchived = !!ownCardPath?.startsWith('.archive/')
  const ownGroup = singleTask ? (
    (ownCardPath ? groupOfCard(ownCardPath) : null)
    ?? Object.keys(base.files).flatMap(k => {
      if (!k.startsWith(rootOf(ws))) return []
      const rel = k.slice(rootOf(ws).length)
      return numberOfCard(rel) === singleTask.number ? [groupOfCard(rel)] : []
    }).find(g => g !== null) ?? null
  ) : null
  const outOfTaskScope = (p: string): boolean => {
    if (!singleTask) return false
    const assetTask = taskOfAssets(p)
    if (assetTask !== null) return assetTask !== singleTask.task
    const cardNum = numberOfCard(p), groupNum = groupOfCard(p)
    if (cardNum === null) return false
    if (cardNum === singleTask.number || groupNum === singleTask.number) return false
    if (p.startsWith('.archive/') || singleTask.chat) return true
    if (!fs.statSync(path.join(ws.board, p), { throwIfNoEntry: false })?.isFile()) return true
    if (ownGroup !== null && cardNum === ownGroup) return false
    if (ownArchived) {
      const before = base.files[rootOf(ws) + p]?.content
      const meta = before ? parseFrontmatter(before).meta : null
      if (meta && (meta.blocked_by.includes(singleTask.number) || meta.related.includes(singleTask.number))) return false
    }
    return true
  }
  if (!singleTask?.chat) proposeItems(ws, base, scoped)

  const shared = sharedMemory(ws.board)
  const deferred = new Set((base.deferred ?? []).filter(p => !tasks.some(item =>
    processed.has(item.folder.task) && !deferredCards.has(item.folder.number!) &&
    (p === assetsFile(item.folder.task) || numberOfCard(p) === item.folder.number))))
  const retiredCards = new Set(tasks.filter(item => item.record.deleted).map(item => item.folder.number))
  const retiredLists = new Set(tasks.filter(item => item.record.deleted).map(item => assetsFile(item.folder.task)))
  const defer = (p: string) => {
    if (outOfTaskScope(p)) return true
    if (protectedCards.has(numberOfCard(p) ?? 0) || protectedCards.has(groupOfCard(p) ?? 0) || protectedLists.has(p)) return true
    if (retiredCards.has(numberOfCard(p) ?? 0) || retiredLists.has(p)) { deferred.add(p); return true }
    if (!fullBoardSync) return deferred.has(p)
    if (!deferredLists.has(p) && !deferredCards.has(numberOfCard(p) ?? 0)) return deferred.has(p)
    deferred.add(p)
    return true
  }
  const previews: SourceProblem[] = []
  const heldPreviews = new Set<string>()
  const oversize = new Set<number>()
  const success = async (changed: boolean): Promise<Pushed> => {
    const refreshDeferred = deferred.size !== (base.deferred?.length ?? 0) || base.deferred?.some(p => !deferred.has(p))
    const pendingAssets = [...retryAssets]
    const refreshPending = JSON.stringify(pendingAssets) !== JSON.stringify(base.pendingAssets ?? [])
    if (refreshDeferred) base.deferred = [...deferred]
    if (refreshPending) base.pendingAssets = pendingAssets
    const keepPreview = (p: string) => deferred.has(p) || outOfTaskScope(p)
      || protectedCards.has(numberOfCard(p) ?? 0) || protectedCards.has(groupOfCard(p) ?? 0) || protectedLists.has(p)
      || (selected !== undefined && !selected.has(p))
    const pendingPreviews = [...new Set([...heldPreviews, ...(base.pendingPreviews ?? []).filter(keepPreview)])]
    const refreshPreviews = !isDeepStrictEqual(pendingPreviews, base.pendingPreviews ?? [])
    if (refreshPreviews) base.pendingPreviews = pendingPreviews
    if (changed || refreshDeferred || refreshPending || refreshPreviews) writeBase(ws, base)
    let operations: Record<string, SyncProblem> = {}
    if (fullBoardSync) {
      for (const task of processed) {
        if (!archives.has(task) && !assetErrors[task]) pendingArchives.delete(task)
      }
      const archived = await reconcileArchives(ws, base, archives, pendingArchives, job.machineId)
      const removed = await reconcileRemovals(ws, base, selected)
      operations = { ...archived, ...removed }
      const index = syncIndex(ws)
      if (index) index.archivesReady = true
    }
    const reported = !singleTask ? previews : previews.filter(p => numberOfCard(p.file) === singleTask.number)
    const tasks = { ...assetErrors, ...operations }
    const firstError = Object.values(tasks)[0]
    if (reported.length) {
      const error = describeTaskPreviewProblems(reported)
      return { ok: false, conflict: false, error, failure: validationFailure(error), previews: reported, tasks: assetErrors }
    }
    if (firstError && (boardSync || firstError.failure)) return { ok: false, conflict: false, ...firstError, tasks }
    return { ok: true, changed }
  }
  const local = new Set([...(scoped ?? localFiles(singleFolder ?? ws, base)), ...assetLists.keys()])
  const localOf = new Map<string, string>()
  const localBefore = new Map<string, string | null>()
  const changes: api.BoardWrite[] = []
  // An item a job is adding goes up with that job, stamped with its task.
  const owed = (p: string) => !job.id && busy(ws.cwd) && itemAt(p)?.state === 'open' && !base.files[rootOf(ws) + p]
  for (const p of local) {
    if (defer(p) || owed(p) || generatedAssets.has(p)) continue
    if (selected && tasks.some(item => assetFiles(item.folder, assetsListOf(item.folder, base)).has(p))) continue
    const list = assetLists.get(p)
    const original = list?.content ?? fs.readFileSync(path.join(ws.board, p), 'utf8')
    const remote = remoteOf(ws, shared, p)
    const held = base.files[remote]
    const content = p.startsWith('.archive/') && numberOfCard(p) !== null ? migrateHistoricalArchive(original, held?.content) : original
    if (content !== original && readText(path.join(ws.board, p)) === original) {
      const backup = path.join(ws.board, '.sync', 'legacy-previews', hashOf(Buffer.from(original)), p)
      write(backup, original)
      write(path.join(ws.board, p), content)
    }
    localOf.set(remote, p)
    localBefore.set(remote, list ? list.local : content)
    if (held?.content === content && (!list || list.local === content)) continue
    if (Buffer.byteLength(content) > BOARD_FILE_LIMIT) {
      const error = `${p}:1 — File exceeds ${BOARD_FILE_LIMIT / 1024} KB. Move large results to assets and link them from the card.`
      const number = numberOfCard(p)
      if (number === null || number === singleTask?.number) return { ok: false, conflict: false, error, failure: validationFailure(error, 'card_too_large') }
      previews.push({ file: p, line: 1, column: 1, code: 'card_too_large', path: '', message: error, hint: 'Shorten the card.' })
      oversize.add(number)
      heldPreviews.add(p)
      continue
    }
    changes.push({
      path: remote, content: numberOfCard(p) === null ? content : normalizeCardFrontmatter(content),
      base_seq: held?.seq ?? base.deleted?.[remote] ?? 0,
    })
  }
  const previous = selected ? new Set([...selected].flatMap(p => {
    if (base.files[remoteOf(ws, shared, p)]) return [p]
    if (!syncIndex(ws)?.directories.has(p) && !fs.statSync(path.join(ws.board, p), { throwIfNoEntry: false })?.isDirectory()) return []
    return [...viewOf(ws, base, shared).keys()].filter(file => file.startsWith(p + '/'))
  })) : viewOf(ws, base, shared).keys()
  for (const p of previous) {
    const remote = remoteOf(ws, shared, p)
    if (!defer(p) && kept(p) && !localOf.has(remote) && base.files[remote]) {
      localOf.set(remote, p)
      localBefore.set(remote, null)
      changes.push({ path: remote, content: null, base_seq: base.files[remote]!.seq })
    }
  }
  // A project's copy of a file declared the workspace's would bring a deleted one back (#2099).
  const memory = rootOf(ws) + MEMORY
  const stale = new Set(Object.keys(base.files).filter((p) => p.startsWith(memory) && shared(p.slice(memory.length))))
  for (const p of stale) changes.push({ path: p, content: null, base_seq: base.files[p]!.seq })
  const holdCards = (numbers: Set<number | null>) => {
    const index = syncIndex(ws)!
    for (const task of index.tasks.values()) if (numbers.has(task.number)) heldPreviews.add(assetsFile(task.task))
    for (let i = changes.length - 1; i >= 0; i--) {
      const file = localOf.get(changes[i]!.path)
      if (!file) continue
      const task = taskOfAssets(file)
      const number = task ? index.tasks.get(task)?.number ?? readRecord({ ...ws, task }).number : numberOfCard(file)
      if (number == null || !numbers.has(number)) continue
      heldPreviews.add(file)
      changes.splice(i, 1)
    }
    const pendingPreviews = [...new Set([...(base.pendingPreviews ?? []), ...heldPreviews])]
    if (!isDeepStrictEqual(pendingPreviews, base.pendingPreviews ?? [])) {
      base.pendingPreviews = pendingPreviews
      writeBase(ws, base)
    }
  }
  if (oversize.size) holdCards(oversize)
  if (!changes.length) return success(false)

  const taskOfCardNumber = (number: number): string | undefined => {
    const indexed = [...(syncIndex(ws)?.tasks.values() ?? [])].find(t => t.number === number)?.task
    if (indexed) return indexed
    for (const name of filesUnder(path.join(ws.board, '.sync'))) {
      if (!name.endsWith('.json') || name.includes('/') || taskOfRemoval('.sync/' + name)) continue
      try {
        const held = JSON.parse(fs.readFileSync(path.join(ws.board, '.sync', name), 'utf8')) as Partial<Record_>
        if (held.number === number && held.task && TASK_ID.test(held.task)) return held.task
      } catch { /* ignore */ }
    }
  }

  const commit = async () => {
    while (changes.length) {
      const sent = await api.commitBoard(ws.project, job.id, job.machineId, changes)
      if (!sent.ok && sent.code === 'conflict' && sent.error === 'The current Land job must synchronize this archive.') {
        const candidates = [...new Set(changes.flatMap(c => {
          const p = localOf.get(c.path)
          const n = p?.startsWith('.archive/') ? numberOfCard(p) : null
          return n !== null && !(singleTask && !singleTask.chat && job.id && n === singleTask.number
            && readLandArchiveOwner(landArchiveMarker(ws.board, singleTask.task))?.job === job.id) ? [n] : []
        }))]
        const isolatedNumbers = new Set<number>()
        const isolatedTasks = new Set<string>()
        for (const n of candidates) {
          const task = taskOfCardNumber(n)
          if (candidates.length > 1 && task) {
            const current = await api.readTask(task)
            if (current.ok && current.value.status === 'done') continue
          }
          writeLandArchiveOwner(landArchiveMarker(ws.board, task ?? `unowned-${n}`), { job: null, number: n })
          isolatedNumbers.add(n)
          protectedCards.add(n)
          if (task) {
            isolatedTasks.add(task)
            protectedLists.add(assetsFile(task))
            pendingArchives.delete(task)
            retryAssets.delete(task)
          }
        }
        if (isolatedNumbers.size) {
          const repaired = new Set<string>()
          repairLandBlockers(ws, base, isolatedNumbers, repaired)
          for (let i = changes.length - 1; i >= 0; i--) {
            const file = localOf.get(changes[i]!.path)
            if (!file) continue
            const assetTask = taskOfAssets(file)
            const cardNum = numberOfCard(file), groupNum = groupOfCard(file)
            if ((assetTask && isolatedTasks.has(assetTask))
                || (cardNum !== null && isolatedNumbers.has(cardNum))
                || (groupNum !== null && isolatedNumbers.has(groupNum))) {
              changes.splice(i, 1)
            }
          }
          for (const file of repaired) {
            if (defer(file) || heldPreviews.has(file)) continue
            const content = readText(path.join(ws.board, file))
            if (content === null || Buffer.byteLength(content) > BOARD_FILE_LIMIT) continue
            const remote = remoteOf(ws, shared, file)
            const held = base.files[remote]
            localOf.set(remote, file)
            localBefore.set(remote, content)
            const entry = { path: remote, content: normalizeCardFrontmatter(content), base_seq: held?.seq ?? base.deleted?.[remote] ?? 0 }
            const existing = changes.findIndex(c => c.path === remote)
            if (held?.content === content) {
              if (existing >= 0) changes.splice(existing, 1)
            } else if (existing >= 0) changes[existing] = entry
            else changes.push(entry)
          }
          continue
        }
      }
      if (sent.ok || !sent.previewProblems?.length) return sent
      logRunner('board', 'failed', { stage: 'push', task: ws.number, job: job.id, code: sent.code ?? 'bad_request', status: sent.status })
      const problems = sent.previewProblems
      const submitted = new Set(changes.filter(f => f.content !== null).map(f => localOf.get(f.path)))
      if (problems.some(p => typeof p?.file !== 'string' || numberOfCard(p.file) === null || !submitted.has(p.file))) return sent
      const numbers = new Set(problems.map(p => numberOfCard(p.file)))
      for (const problem of problems) previews.push(problem)
      // Keep both sides of a move and the attachment pins with the refused card.
      holdCards(numbers)
      const own = previews.filter(p => numberOfCard(p.file) === singleTask?.number)
      if (job.id && own.length) return { ...sent, error: describeTaskPreviewProblems(own) }
    }
    return null
  }
  let sent = await commit()
  if (sent === null) return success(false)
  if (!sent.ok && sent.files) {
    const root = rootOf(ws)
    const deletedCards = new Set(sent.files.filter(f => f.content === null && f.path.startsWith(root))
      .map(f => numberOfCard(f.path.slice(root.length))).filter(number => number !== null))
    if (boardSync && retryRestore && deletedCards.size) {
      const read = await readSyncedBoard(ws, base.head_seq)
      if (read.ok && restoredCards(ws, base, read.value.files).some(card => deletedCards.has(card.number))) {
        const refreshed = await reconcileBoard(ws, base, read.value, shared, taskChat)
        if (!refreshed.ok) return conflictFailure(ws, sent.status)
        return send(ws, job, { paths, taskChat }, false)
      }
    }
    // Obsolete project copies cannot take ownership from shared memory.
    for (const f of sent.files) if (stale.has(f.path)) {
      const at = changes.findIndex(c => c.path === f.path)
      if (at >= 0) changes.splice(at, 1)
    }
    if (!changes.length) return success(false)
    const remote = new Map(sent.files.map(f => [f.path, f]))
    const facts: ConflictFile[] = changes.map(c => {
      const theirs = remote.get(c.path) ?? { content: base.files[c.path]?.content ?? null, seq: c.base_seq }
      const before = base.files[c.path]?.content ?? null
      const merged = mergeFile(before, c.content, theirs.content)
      const p = localOf.get(c.path) ?? c.path.slice(rootOf(ws).length)
      const lifecycle = remote.has(c.path) && theirs.content === null && c.content !== null && numberOfCard(p) !== null
      const local = localBefore.get(c.path)
      return { path: p, remotePath: c.path, base: { content: before, seq: c.base_seq }, local: { content: local === undefined ? c.content : local },
        remote: { content: theirs.content, seq: theirs.seq }, automatic: { content: merged.content }, conflicted: !!merged.conflict || lifecycle,
        reason: lifecycle ? 'lifecycle' : merged.conflict ? before === null ? 'same-name-created' : c.content === null || theirs.content === null ? 'edit-delete' : 'both-modified' : null }
    })
    if (facts.some(f => f.conflicted)) {
      captureConflict(ws.board, ws.project, facts)
      return conflictFailure(ws, sent.status)
    }
    for (const [i, f] of facts.entries()) {
      const content = f.automatic!.content
      changes[i] = { path: f.remotePath,
        content: content !== null && numberOfCard(f.path) !== null ? normalizeCardFrontmatter(content) : content,
        base_seq: f.remote.seq }
    }
    if (facts.some(f => readText(path.join(ws.board, f.path)) !== f.local.content)) return fail('Local files changed during synchronization. Try again.', false, 'local_changed')
    sent = await commit()
    if (sent === null) return success(false)
    if (!sent.ok && sent.files) {
      const remaining = facts.filter(f => !heldPreviews.has(f.path))
      for (const f of remaining) {
        const newer = sent.files.find(v => v.path === f.remotePath)
        if (newer) { f.remote = { content: newer.content, seq: newer.seq }; f.conflicted = true; f.reason = 'both-modified' }
      }
      captureConflict(ws.board, ws.project, remaining)
      return conflictFailure(ws, sent.status)
    }
  }
  if (!sent.ok && sent.previewProblems?.length) return { ok: false, conflict: false, error: sent.error, code: sent.code, status: sent.status, failure: validationFailure(sent.error), previews: sent.previewProblems }
  if (!sent.ok) return fail(sent.error, sent.code === 'version_conflict', sent.code, sent.status)

  const committed = sent.value
  const versions = new Map(Array.isArray(committed?.files) ? committed.files.filter(f => f && Number.isSafeInteger(f.seq) && f.seq >= 0)
    .map(f => [f.path, f.seq]) : [])
  if (!Number.isSafeInteger(committed?.head_seq) || changes.some(c => !versions.has(c.path) || versions.get(c.path) === 0 && c.content !== null)) {
    const problem = invalidResponse('a board write receipt for every file')
    return fail(problem.message, false, problem.code)
  }

  // The base keeps its `head_seq`: what others wrote meanwhile is read at the next pull.
  for (const c of changes) {
    const seq = versions.get(c.path)!
    base.deleted ??= {}
    if (c.content === null) { delete base.files[c.path]; base.deleted[c.path] = seq }
    else { base.files[c.path] = { seq, content: c.content }; delete base.deleted[c.path] }
    const p = localOf.get(c.path)
    if (p && readText(path.join(ws.board, p)) === localBefore.get(c.path)) {
      if (c.content === null) fs.rmSync(path.join(ws.board, p), { force: true })
      else write(path.join(ws.board, p), c.content)
    }
  }
  return success(true)
}

async function reconcileRemovals(ws: TaskFolder, base: Base, selected: Set<string> | undefined): Promise<Record<string, SyncProblem>> {
  const paths = selected ?? filesUnder(path.join(ws.board, '.sync'), ws.board)
  const tasks = new Set([...(base.pendingRemovals ?? []), ...Array.from(paths, taskOfRemoval).filter((task): task is string => !!task)])
  const pending: string[] = []
  const errors: Record<string, SyncProblem> = {}
  for (const task of tasks) {
    const held = readRemoval(ws.board, task)
    if (held?.status !== 'pending') continue
    const record = readRecord({ ...ws, task })
    const sent = record.task === task && !record.deleted ? await api.cancelTask(task, held.reason, held.discard)
      : { ok: false as const, code: 'not_found', error: 'This task is no longer linked to the board.' }
    const current = !sent.ok && sent.code === 'conflict' ? await api.readTask(task) : null
    if (sent.ok && sent.value?.id === task && sent.value.status === 'cancelled'
        || current?.ok && current.value?.status === 'cancelled' && (current.value.cancel_reason ?? '') === held.reason) {
      writeRemoval(ws.board, task, { status: 'confirmed', reason: held.reason, discard: held.discard })
      continue
    }
    const problem = sent.ok ? { error: invalidResponse('confirmation that the task was removed').message, code: 'invalid_response' } : sent
    const retry = api.temporaryCloudFailure(problem) || !!current && !current.ok && api.temporaryCloudFailure(current)
    if (retry) pending.push(task)
    writeRemoval(ws.board, task, { reason: held.reason, discard: held.discard,
      status: retry ? 'pending' : 'rejected', code: problem.code ?? 'unreachable', message: problem.error })
    if (held.code !== problem.code || held.message !== problem.error || !retry) {
      errors[task] = { error: `Remove ${task}: ${problem.error}`, code: problem.code ?? 'unreachable', offline: retry, blocking: false }
    }
  }
  if (!isDeepStrictEqual(base.pendingRemovals ?? [], pending)) {
    base.pendingRemovals = pending
    writeBase(ws, base)
  }
  return errors
}

async function reconcileArchives(ws: TaskFolder, base: Base, archives: Map<string, string>, pending: Map<string, string>, machine: string) {
  const root = rootOf(ws)
  const receipts = base.archiveReceipts ?? {}
  const errors: Record<string, SyncProblem> = {}
  for (const [task, p] of archives) {
    const receipt = receipts[task]
    if (receipt && receipt.status !== 'pending' && receipt.path === p && receipt.seq === base.files[root + p]?.seq &&
        receipt.assets_seq === (base.files[root + assetsFile(task)]?.seq ?? 0) && !pending.has(task)) continue
    pending.set(task, p)
  }
  const cards: ArchiveCompletion[] = []
  const held = new Set(base.pendingPreviews)
  const pendingAssets = new Set(base.pendingAssets)
  for (const [task, p] of pending) {
    const list = assetsFile(task)
    if (held.has(p) || held.has(list) || pendingAssets.has(task)) continue
    const archive = base.files[root + p]
    const local = readText(path.join(ws.board, p))
    if (local === null || !archiveMeta(local)) {
      pending.delete(task)
      continue
    }
    const manifest = base.files[root + list]
    if (!archive || archive.content !== local || readText(path.join(ws.board, list)) !== (manifest?.content ?? null)) continue
    cards.push({ task, path: p, seq: archive.seq, assets_seq: manifest?.seq ?? 0 })
  }

  const save = (changed: boolean) => {
    const next = Object.fromEntries(pending)
    if (!changed && isDeepStrictEqual(next, base.pendingArchives ?? {})) return
    base.pendingArchives = next
    base.archiveReceipts = receipts
    delete base.reconciledArchives
    writeBase(ws, base)
  }
  save(false)
  for (let i = 0; i < cards.length; i += ARCHIVE_COMPLETION_BATCH) {
    const batch = cards.slice(i, i + ARCHIVE_COMPLETION_BATCH)
    const result = await api.completeArchives(ws.project, machine, batch)
    if (!result.ok) {
      const retry = api.temporaryCloudFailure(result)
      const code = result.code ?? 'unreachable'
      for (const card of cards.slice(i)) {
        receipts[card.task] = { ...card, status: retry ? 'pending' : 'rejected', code, message: result.error }
        if (!retry) pending.delete(card.task)
        errors[card.task] = { error: `Archive ${card.task}: ${result.error}`, code, offline: retry, blocking: false }
      }
      logSync('board.archive_completion', { project: ws.project, code, pending: pending.size })
      save(true)
      break
    }
    const received = new Map<string, ArchiveCompletionReceipt>()
    const repeated = new Set<string>()
    for (const receipt of Array.isArray(result.value?.receipts) ? result.value.receipts : []) {
      if (!isRecord(receipt) || !hasText(receipt.task)) continue
      if (received.has(receipt.task)) repeated.add(receipt.task)
      if (receipt.status === 'confirmed' || (['pending', 'rejected'].includes(receipt.status)
          && 'code' in receipt && hasText(receipt.code) && hasText(receipt.message))) received.set(receipt.task, receipt)
    }
    for (const card of batch) {
      const { task, ...version } = card
      const found = received.get(task)
      const receipt = !found || repeated.has(task)
        ? { task, status: 'pending' as const, code: 'invalid_response', message: invalidResponse('an archive receipt for this task').message }
        : found
      receipts[task] = { ...version, ...receipt }
      if (receipt.status !== 'pending') pending.delete(task)
      if (receipt.status === 'rejected' || receipt.status === 'pending' && receipt.code === 'invalid_response') {
        errors[task] = { error: `Archive ${task}: ${receipt.message}`, code: receipt.code, offline: receipt.status === 'pending', blocking: false }
      }
    }
    save(true)
  }
  return errors
}

export function taskStudio(ws: TaskFolder) {
  if (!ws.cloudTask) return null
  const pin = ws.studioSnapshot ?? readPin(ws.cloudTask), held = pin && readVersion(pin.studio, pin.version)
  if (!held) throw new Error(pin ? missingStudioVersion(pin) : 'The task Studio version is not downloaded.')
  const read = parseStudioFile(studioName(held.id), held.files['STUDIO.md'] ?? '', 'STUDIO.md')
  if ('problem' in read) throw new Error(read.problem)
  return { held, def: read.def }
}

export function taskContextBlocks(ws: TaskFolder, action: string, canonicalCommands = true) {
  const studio = taskStudio(ws)
  if (!studio) return []
  const blocks = studioContextBlocks(studio.held, action, studio.def, ws.board, ws.project,
    canonicalCommands ? 'akb studio file' : 'akb raw file')
  if (action !== 'chat') return blocks
  const previews = studio.def.previews.map(({ id, title }) => {
    const titles = [title?.en, title?.zh].map(text => text?.replace(/\s+/g, ' ').trim()).filter(Boolean)
    return '- ' + id + (titles.length ? ' · ' + titles.join(' / ') : '')
  })
  const catalog = previews.length
    ? ['Studio Previews:', ...previews, 'Add any listed Preview to the review plan with `akb task review <id> --add-previews <ids> --revision <n>`.'].join('\n')
    : 'Studio Previews: none.'
  return blocks.flatMap((block): ContextBlock[] => block[0] === 'skills'
    ? [['studio-previews', catalog], ['skills', block[1] || 'Studio skills: none.']]
    : [block])
}

export function taskStudioContext(ws: TaskFolder, { docs = true, canonicalCommands = true, config = true } = {}): string {
  const studio = taskStudio(ws)
  if (!studio) return ''
  const { held, def } = studio
  const studioFile = canonicalCommands ? 'akb studio file' : 'akb raw file'
  return ['<studio>', def.rules,
    ...def.previews.map(({ id, instructions }) => `<Preview id="${id}">\n${instructions}\n</Preview>`),
    `Prepare only requested outputs. Revise saved work in place and preserve unrelated outputs. Use stable Preview IDs in task results. Read linked resources on demand with \`${studioFile} ${def.id} <path>\`. Read relevant memory on demand; do not write memory in task runs.`,
    held.files['shared/RULES.md'] ?? '', '</studio>',
    config && studioConfigContext(held.id, ws.project, 'implement', file => readText(path.join(ws.board, file)) ?? undefined),
    ...memoryDirectories(ws.board).map(dir => `Memory directory: ${dir}`),
    docs && taskStudioComponents(canonicalCommands),
  ].filter(Boolean).join('\n\n')
}

export function taskStudioComponents(canonicalCommands: boolean): string {
  const components = componentDocsText(allComponents())
  return 'Preview Components\n\n' + (canonicalCommands ? components : components.replace('akb studio preview', 'akb raw studio preview'))
}
