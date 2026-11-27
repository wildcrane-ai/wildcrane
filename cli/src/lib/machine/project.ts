// Project-local state shared by the CLI, host and sandboxed agents.
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BoardError } from '../io'

const RECORD = 'board.json'
export const SESSIONS_FILE = 'sessions.json'
export const SESSIONS_FOLDER = 'sessions'
export const ASSETS_FOLDER = 'assets'
export const SESSIONS_LOCK = 'sessions.lock'
export const INDEX_LOCK = 'index.lock'
export const UI_CONFIG_FILE = 'ui.config.json'

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')

/** Resolve even a missing file or a link left dangling by migration. */
export function realPathOf(file: string, links = 0): string {
  const here = path.resolve(file)
  try { return fs.realpathSync(here) } catch (error) {
    if (!missing(error)) throw error
  }
  const parent = path.dirname(here)
  if (parent === here) return here
  let link: string | undefined
  try { link = fs.readlinkSync(here) } catch (error) {
    if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'EINVAL') throw error
  }
  if (link !== undefined) {
    if (links >= 40) throw new Error(`Too many symbolic links: ${file}`)
    return realPathOf(path.resolve(parent, link), links + 1)
  }
  return path.join(realPathOf(parent, links), path.basename(here))
}

/** Match the explicit checkout root when supplied; otherwise find the board's repository. */
export function stateRootOf(board: string): string {
  let dir = realPathOf(board)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return rootAbove(realPathOf(board))
}

/** A board's project outside git: the folder holding `docs/` or `.akb/`, else the parent. */
export function rootAbove(board: string): string {
  const parent = path.dirname(board)
  return ['docs', '.akb'].includes(path.basename(parent)) ? path.dirname(parent) : parent
}

const NESTED_STATE = /(^|[/\\])\.akb[/\\](?:(?:boards|hidden-boards)[/\\])?\.akb(?=[/\\]|$)/

export class InvalidBoardStatePath extends BoardError {
  constructor(file: string, state?: string, id?: number | null) {
    const use = state ? `Use ${state}${id ? ` or an asset:<path> reference` : ''}.` : 'Use the board’s project-local state directory.'
    super(`Invalid nested board state path: ${file}. ${use}`, { kind: 'board-state-path' })
  }
}

export function assertBoardStatePath(file: string, state?: string, id?: number | null): void {
  if (NESTED_STATE.test(file)) throw new InvalidBoardStatePath(file, state, id)
}

function stateLayout(board: string, root: string) {
  assertBoardStatePath(board)
  assertBoardStatePath(root)
  const project = realPathOf(root)
  const recorded = realPathOf(board)
  assertBoardStatePath(project)
  assertBoardStatePath(recorded)
  const relative = path.relative(project, recorded)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The board must be inside its project root.')
  }
  const hiddenPrefix = `.akb${path.sep}`
  const hidden = relative.startsWith(hiddenPrefix)
  const runnerBoard = relative === `${hiddenPrefix}kanban`
  const akb = path.join(project, '.akb')
  const state = runnerBoard ? path.join(akb, 'state')
    : hidden ? path.join(akb, 'hidden-boards', relative.slice(hiddenPrefix.length))
    : path.join(akb, 'boards', relative || '_root')
  assertBoardStatePath(state, state)
  assertBoardStatePath(realPathOf(state), state)
  const legacy = hidden ? [path.join(akb, 'boards', relative)] : []
  if (runnerBoard) legacy.push(path.join(akb, 'hidden-boards', 'kanban'))
  return { project, state, legacy, runnerBoard }
}

export function projectStateDir(board: string, root = stateRootOf(board)): string {
  return stateLayout(board, root).state
}

export function hasLegacyProjectState(board: string, root = stateRootOf(board)): boolean {
  const { legacy } = stateLayout(board, root)
  return legacy.some(dir => fs.lstatSync(dir, { throwIfNoEntry: false }))
}

function hasRunningSession(dir: string): boolean {
  try {
    const store = JSON.parse(fs.readFileSync(path.join(dir, SESSIONS_FILE), 'utf8'))
    const runs = Array.isArray(store?.runs) ? store.runs : store?.live
    return Array.isArray(runs) && runs.some(run => run?.status === 'running' && [run.pid, run.agentPid].some(isLivePid))
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return false
    throw error
  }
}

function isLivePid(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Existing Runner jobs hold the project directory until they finish syncing. */
function hasRunnerJob(project: string): boolean {
  const home = process.env.WILDCRANE_HOME || path.join(os.homedir(), '.wildcrane')
  const prefix = `${createHash('sha256').update(project).digest('hex')}.`
  try {
    return fs.readdirSync(path.join(home, 'holds')).some(name => name.startsWith(prefix) && isLivePid(Number(name.slice(prefix.length))))
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

/** Move the whole directory before any new state is created. */
export function migrateProjectState(board: string, root = stateRootOf(board)): string {
  const { project, state, legacy, runnerBoard } = stateLayout(board, root)
  const present = legacy.filter(dir => {
    const entry = fs.lstatSync(dir, { throwIfNoEntry: false })
    if (!entry) return false
    if (!entry.isDirectory() || realPathOf(dir) !== dir) {
      throw new BoardError(`Legacy board state must be a regular directory: ${dir}. Move the saved state to ${state} before restarting.`, { kind: 'board-state-path' })
    }
    return true
  })
  if (!present.length) return state
  if ((runnerBoard && hasRunnerJob(project)) || [...present, state].some(hasRunningSession)) {
    throw new BoardError(`Board state migration is waiting for the running tasks in ${project} to exit.`, { kind: 'board-state-busy' })
  }
  const sources = present.filter(dir => {
    try { fs.rmdirSync(dir); return false } catch (error) {
      if (missing(error)) return false
      if (['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return true
      throw error
    }
  })
  const conflict = (dirs: string[]) => new BoardError(`Board state exists at ${dirs.join(' and ')}. Compare the saved state before moving it to ${state}.`, { kind: 'board-state-conflict' })
  if (sources.length > 1) throw conflict(sources)
  const source = sources[0]
  if (!source) return state
  if (fs.lstatSync(state, { throwIfNoEntry: false })) {
    if (fs.lstatSync(source, { throwIfNoEntry: false })) throw conflict([source, state])
    return state
  }
  fs.mkdirSync(path.dirname(state), { recursive: true })
  try { fs.renameSync(source, state) } catch (error) {
    if (fs.lstatSync(state, { throwIfNoEntry: false })) {
      if (fs.lstatSync(source, { throwIfNoEntry: false })) throw conflict([source, state])
      if (missing(error)) return state
    }
    throw error
  }
  return state
}

/** Create project-local state and record its board. */
export function ensureProjectState(board: string, root = stateRootOf(board)): string {
  const dir = migrateProjectState(board, root)
  fs.mkdirSync(dir, { recursive: true })
  const recorded = realPathOf(board)
  if (recordedBoard(dir) !== recorded) {
    const temp = path.join(dir, `${RECORD}.${randomUUID()}`)
    try {
      fs.writeFileSync(temp, `${JSON.stringify({ board: recorded })}\n`)
      fs.renameSync(temp, path.join(dir, RECORD))
    } finally { fs.rmSync(temp, { force: true }) }
  }
  return dir
}

export function recordedBoard(dir: string): string | null {
  try {
    const held = JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8')) as { board?: unknown }
    return typeof held.board === 'string' ? held.board : null
  } catch { return null }
}
