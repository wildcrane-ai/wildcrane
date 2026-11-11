// Every studio is Cloud's (#409): the official ones and the workspace's own. A board kept for a
// Cloud project reads the ones its workspace can run, each version downloaded once into the
// machine home's `studios/` and read from there offline. A run on a task reads the version
// its task started on.
//
// `AI4KANBAN_STUDIOS=<official folder>` reads the official ones from that folder instead,
// unpublished: what the tests and a maintainer editing them use.

import fs from 'node:fs'
import path from 'node:path'

import { studioName } from '../shared/board-files.ts'
import { packOfficial } from '../../../../official/pack.ts'
import { call, runnerProject, workspaceTask } from '../cloud/tasks'
import { cloudConfigured } from '../cloud/config'
import { readSession, sessionFile } from '../cloud/session'
import { memoByFiles } from '../file-memo'
import { machineHome } from '../machine/home'
import { KANBAN } from '../paths'
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

interface Pin {
  studio: string
  version: number
}

const DEV = 'AI4KANBAN_STUDIOS'
const FRESH_MS = 60_000

const root = () => path.join(machineHome(), 'studios')
const safe = (name: string) => name.replace(/[^\w.@-]/g, '_')
const versionFile = (id: string, version: number) => path.join(root(), 'versions', `${safe(id)}@${version}.json`)
const listFile = (project: string) => path.join(root(), 'lists', `${safe(project)}.json`)
const pinFile = (task: string) => path.join(root(), 'tasks', `${safe(task)}.json`)

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`)
  fs.renameSync(tmp, file)
}

export const readVersion = (id: string, version: number): HeldVersion | null => readJson<HeldVersion>(versionFile(id, version))

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

/** Keep one version; a version never changes, so one already kept stays. */
export function saveVersion(held: HeldVersion): void {
  const file = versionFile(held.id, held.version)
  if (!fs.existsSync(file)) writeJson(file, { id: held.id, version: held.version, name: held.name, names: held.names, files: held.files })
}

/** The version a task runs on, never changing once read. */
export function savePin(task: string, held: HeldVersion): void {
  saveVersion(held)
  writeJson(pinFile(task), { studio: held.id, version: held.version } satisfies Pin)
}

export const readPin = (task: string): Pin | null => readJson<Pin>(pinFile(task))

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
export async function sweepVersions(ended: (task: string) => Promise<boolean | null>): Promise<string[]> {
  const keep = new Set<string>()
  const held = (id: string, version: number) => keep.add(path.basename(versionFile(id, version)))
  for (const file of jsonIn('tasks')) {
    const at = path.join(root(), 'tasks', file)
    const pin = readJson<Pin>(at)
    if (!pin || (await ended(file.slice(0, -'.json'.length)))) fs.rmSync(at, { force: true })
    else held(pin.studio, pin.version)
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
  for (const file of gone) fs.rmSync(path.join(root(), 'versions', file), { force: true })
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
  const pin = readPin(task)
  return !(pin && readVersion(pin.studio, pin.version))
}

export const NEEDS_CLOUD = 'Sign in to run studios.'
export const NOT_DOWNLOADED = "This studio isn't downloaded yet. Connect and try again."

let offline = false

/** The last sync could not reach Cloud, so the list is what was downloaded before. */
export const studiosOffline = () => offline

type Answer<T> = { ok: true; value: T } | { ok: false; error: string; code?: string }

async function versionOf(id: string, version: number): Promise<Answer<HeldVersion>> {
  const held = readVersion(id, version)
  if (held) return { ok: true, value: held }
  const read = await call<HeldVersion>('GET', `/v1/studios/${encodeURIComponent(id)}`)
  if (!read.ok) return read
  saveVersion(read.value)
  return read
}

/** The version the task this process works for runs on, read once. */
async function pinTask(task: string): Promise<Answer<HeldVersion>> {
  const pin = readPin(task)
  const held = pin && readVersion(pin.studio, pin.version)
  if (held) return { ok: true, value: held }
  const read = await call<{ studio: string; version: number; name: string; files: StudioFiles }>('GET', `/v1/tasks/${encodeURIComponent(task)}/studio`)
  if (!read.ok) return read
  const value = { id: read.value.studio, version: read.value.version, name: read.value.name, files: read.value.files }
  savePin(task, value)
  return { ok: true, value }
}

/** Bring this machine's copy of the workspace's studios up to date. Never throws: offline, the
 *  copy downloaded before stands. `force` reads the list even when it is fresh. */
export async function syncStudios(force = false): Promise<void> {
  offline = false
  const project = boardProject()
  if (devFolder() || !project || !cloudConfigured() || !readSession()) return
  const task = workspaceTask()
  const held = readJson<List>(listFile(project))
  const fresh = held && Date.now() - Date.parse(held.at) < FRESH_MS
  try {
    if (task && !readPin(task)) {
      const pinned = await pinTask(task)
      if (!pinned.ok && !pinned.code) offline = true
    }
    if (fresh && !force) return
    let workspace = held?.workspace
    if (!workspace) {
      const read = await call<{ workspace: string }>('GET', `/v1/projects/${encodeURIComponent(project)}`)
      if (!read.ok) {
        offline = !read.code
        return
      }
      workspace = read.value.workspace
    }
    const listed: List['studios'] = []
    let after: string | null = null
    do {
      const page: Answer<{ data: { id: string; version: number }[]; next: string | null }> = await call('GET',
        `/v1/studios?workspace=${encodeURIComponent(workspace)}&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`)
      if (!page.ok) {
        offline = !page.code
        return
      }
      listed.push(...page.value.data.map((w) => ({ id: w.id, version: w.version })))
      after = page.value.next
    } while (after)
    const kept: List['studios'] = []
    for (const w of listed) {
      const read = await versionOf(w.id, w.version)
      if (read.ok) kept.push({ id: read.value.id, version: read.value.version })
      else if (!read.code) offline = true
    }
    writeJson(listFile(project), { at: new Date().toISOString(), workspace, studios: kept } satisfies List)
  } catch {
    offline = true
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
  const pin = task ? readPin(task) : null
  const pinned = pin && readVersion(pin.studio, pin.version)
  const mine = pinned && flowOf(pinned)
  if (!mine) return flows
  return [mine, ...flows.filter((f) => f.cloudId !== mine.cloudId)]
}

const sources = (): string[] => {
  if (devFolder()) return [devFolder()]
  const project = boardProject()
  const task = workspaceTask()
  return [sessionFile(), ...(project ? [listFile(project)] : []), ...(task ? [pinFile(task)] : [])]
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
  for (const flow of cloudFlows()) {
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
