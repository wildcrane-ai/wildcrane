// Tracked board content lives under the board; local state lives in the ignored .akb/.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { BoardError, warn as sayWarning, type BoardErrorOptions } from './io'
import {
  INDEX_LOCK as INDEX_LOCK_NAME,
  ASSETS_FOLDER,
  SESSIONS_FILE,
  SESSIONS_FOLDER,
  SESSIONS_LOCK as SESSIONS_LOCK_NAME,
  UI_CONFIG_FILE,
  ensureProjectState,
  projectStateDir,
  rootAbove,
} from './machine/project'

export let REPO_ROOT = ''
export let KANBAN = ''
export let TODO = ''
export let ARCHIVE = ''
// The folder under ARCHIVE where a Runner lays out the rejections Cloud has not had learned.
export const REJECTIONS_TO_REVIEW = '.sync'
export let ARCHIVE_MD = ''
export let README = ''
export let MODULES_MD = ''
export let CONFIG = ''
export let KANBAN_GITIGNORE = ''
// Retired release list (#1671) — only the update that deletes it names it now.
export let RELEASES = ''
// What a closed release left behind, kept as a record after releases were retired (#1671).
export let RELEASE_SUMMARIES = ''
export let AGENTS = ''
// The studios this project adds of its own (#1890), one folder each with its STUDIO.md.
export let STUDIOS = ''
export let ASSETS = ''
// The board's machine-state folder, which shipped text spells `<board-state>` (#822).
export let BOARD_STATE = ''
export let MEMORY = ''
// One folder per agent that keeps memory, named after it (#421, #473, #805): the planner's
// `decisions.md`, `rejected.md` and `redesign.md`, and a spec agent's own two.
export let AGENT_MEMORY = ''
// What the project is today (#1268) — board root only, written by `describe-project`.
export let PROJECT_MD = ''
export let LOCK = ''
// Which agent runs the board, what it is set to, and whether refining happens on its own.
// Each person's own, in the board's machine state: never committed, never uploaded (#1271).
export let UI_CONFIG = ''
export let ENV_FILE = ''
// The one record of what is running — every process reads and writes it, so a run started
// in a terminal and one started from a button are in the same list (lib/agent/sessions.ts).
export let SESSIONS = ''
// One log file per run, named by the run's id. The durable record: a run can be reread
// long after the command that started it is gone.
export let SESSIONS_DIR = ''
// The lock that record is written under. Its own, not the board's: a run's bookkeeping
// calls board moves, and those take the board lock themselves.
export let SESSIONS_LOCK = ''
export let INDEX_LOCK = ''
export let DELIVERIES = ''
// The plans a discussion wrote (#427) — one file per plan, `<id>-<slug>.md`, numbered among
// themselves. Bodies and discussion links stay in the checkout.
export let PLANS = ''
export let PLANS_ARCHIVE = ''
export let RULES = ''
export let TRIAGE = ''
export let SIGNALS_ARCHIVED = ''
export let SIGNALS_DISMISSED = ''
export let SIGNALS_FILES = ''
export let SIGNALS_OLD_INBOX = ''
export let SIGNALS_OLD_HANDLED = ''
export let AKB_DIR = ''
export let ROOT_GITIGNORE = ''
export const AKB_IGNORE_LINE = '.akb/'

/** What this board's writing lock is called inside `.akb/`. Named after where the board sits
 *  in the project, because `.akb/` is the PROJECT's: two boards in one repository share the
 *  folder and must not share a lock, or working on one would make the other wait. */
function boardLockName(kanban: string, root: string): string {
  const from = path.relative(root, kanban)
  const name = from && !from.startsWith('..') ? from : path.basename(kanban)
  return `${name.split(path.sep).join('-')}.lock`
}

export function ensureAkbDir(): string {
  fs.mkdirSync(AKB_DIR, { recursive: true })
  writeRootIgnoreIfMissing()
  return AKB_DIR
}

export function writeRootIgnoreIfMissing(): boolean {
  const text = fs.existsSync(ROOT_GITIGNORE) ? fs.readFileSync(ROOT_GITIGNORE, 'utf8') : ''
  if (text.split('\n').some((line) => line.trim() === AKB_IGNORE_LINE)) return false
  // Already ignored some other way (the Runner's `info/exclude`), or a board kept in `.akb/` of a
  // folder that is no repository: the user's folder stays untouched.
  const ignored = spawnSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', AKB_IGNORE_LINE], { stdio: 'ignore' }).status
  if (ignored === 0 || (ignored === 128 && KANBAN.startsWith(AKB_DIR + path.sep))) return false
  const separator = !text || text.endsWith('\n') ? '' : '\n'
  const block = `# Delivery state — worktrees and the like. Never committed.\n${AKB_IGNORE_LINE}\n`
  fs.writeFileSync(ROOT_GITIGNORE, `${text}${separator}${block}`)
  return true
}
export const shellWord = (value: string): string =>
  /^[\w./:@=-]+$/.test(value) ? value : `"${value.replace(/["`$\\]/g, '\\$&')}"`

export let BOARD_FLAG = ''

/** Where a board folder's project is: the nearest `.git` at or above it, else `rootAbove`.
 *  `.akb/` and the repository `.gitignore` are the project's, so two boards in one
 *  repository share them. */
export function projectRootOf(board: string): string {
  let dir = path.resolve(board)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return rootAbove(path.resolve(board))
    dir = up
  }
}

// Point every path above at one board. Called once per command, before the command runs.
function setBoard(kanban: string, root: string, flag: string): string {
  REPO_ROOT = path.resolve(root)
  KANBAN = path.resolve(kanban)
  BOARD_FLAG = flag
  TODO = path.join(KANBAN, 'todo')
  ARCHIVE = path.join(KANBAN, '.archive')
  ARCHIVE_MD = path.join(KANBAN, 'archive.md')
  README = path.join(TODO, 'README.md')
  MODULES_MD = path.join(KANBAN, 'modules.md')
  CONFIG = path.join(KANBAN, 'config.md')
  KANBAN_GITIGNORE = path.join(KANBAN, '.gitignore')
  RELEASES = path.join(KANBAN, 'releases.md')
  RELEASE_SUMMARIES = path.join(KANBAN, '.release-summaries')
  AGENTS = path.join(KANBAN, 'agents')
  STUDIOS = path.join(KANBAN, 'studios')
  MEMORY = path.join(KANBAN, 'memory')
  AGENT_MEMORY = path.join(MEMORY, 'agents')
  PROJECT_MD = path.join(MEMORY, 'project.md')
  ENV_FILE = path.join(KANBAN, '.env')
  // Local state stays in the checkout and is shared with sandboxed agents.
  const machine = projectStateDir(KANBAN, REPO_ROOT)
  BOARD_STATE = machine
  UI_CONFIG = path.join(machine, UI_CONFIG_FILE)
  ASSETS = path.join(machine, ASSETS_FOLDER)
  SESSIONS = path.join(machine, SESSIONS_FILE)
  SESSIONS_DIR = path.join(machine, SESSIONS_FOLDER)
  SESSIONS_LOCK = path.join(machine, SESSIONS_LOCK_NAME)
  INDEX_LOCK = path.join(machine, INDEX_LOCK_NAME)
  DELIVERIES = path.join(KANBAN, 'deliveries')
  RULES = path.join(KANBAN, 'rules')
  PLANS = path.join(machine, 'plans')
  PLANS_ARCHIVE = path.join(PLANS, 'archive')
  TRIAGE = path.join(KANBAN, 'triage')
  SIGNALS_ARCHIVED = path.join(TRIAGE, 'archived')
  SIGNALS_DISMISSED = path.join(TRIAGE, 'dismissed')
  SIGNALS_FILES = path.join(TRIAGE, 'files')
  SIGNALS_OLD_INBOX = path.join(TRIAGE, 'inbox')
  SIGNALS_OLD_HANDLED = path.join(TRIAGE, 'handled.md')
  AKB_DIR = path.join(REPO_ROOT, '.akb')
  ROOT_GITIGNORE = path.join(REPO_ROOT, '.gitignore')
  LOCK = path.join(AKB_DIR, boardLockName(KANBAN, REPO_ROOT))
  return REPO_ROOT
}

/** Point every path at `<root>/docs/kanban` — a project named by `--dir`, or found by the
 *  walk up. `named` is whether `--dir` chose it, which is what BOARD_FLAG reports. */
export function setBoardRoot(root: string, named = false): string {
  const project = path.resolve(root)
  return setBoard(path.join(project, 'docs', 'kanban'), project, named ? ` --dir ${shellWord(project)}` : '')
}

export function setBoardDir(board: string, root?: string): string {
  const folder = path.resolve(board)
  return setBoard(folder, root ?? projectRootOf(folder), ` --board ${shellWord(folder)}`)
}

setBoardRoot(process.cwd())

export function die(msg: string, kind?: string | BoardErrorOptions): never {
  throw new BoardError(msg, typeof kind === 'string' ? { kind } : kind)
}

// Warnings go to stderr (or into a --json answer's `warnings`) so a command's stdout —
// e.g. `create`'s id — stays clean for callers.
export function warn(msg: unknown): void {
  sayWarning(msg)
}

/** Show project-relative paths inside the checkout, absolute paths elsewhere. */
export const rel = (p: string): string => {
  const from = path.relative(REPO_ROOT, p)
  if (!from) return p
  return from.startsWith('..') ? p : from
}

/** This board's folder as the text an agent should read: `docs/kanban` on the default one,
 *  the real path on any other. The shipped flow text spells `docs/kanban` throughout, so
 *  every door that prints it swaps in the board it was asked about (#407) — otherwise an
 *  agent on `marketing/kanban` writes its memory into a folder nothing reads. */
export const BOARD_PATH_IN_TEXT = 'docs/kanban'

export function boardPath(): string {
  return rel(KANBAN).split(path.sep).join('/')
}

/** Asset folders as shipped text spells them. They are machine state (#590), so each literal
 *  is swapped for the real folder — an agent told to write into a folder nothing reads draws
 *  nothing. The `src` a card writes is untouched: it is a name, and the board resolves it. */
const ASSETS_PATH_IN_TEXT = 'docs/kanban/.assets'

export const BOARD_STATE_IN_TEXT = '<board-state>'

export function boardText(text: string): string {
  const posix = (p: string): string => rel(p).split(path.sep).join('/')
  // Longest first, and each swap applied only to text the earlier ones left, so a state
  // folder that itself spells `docs/kanban` is never rewritten again.
  const swaps: [string, string][] = [
    [ASSETS_PATH_IN_TEXT, posix(ASSETS)],
    [BOARD_STATE_IN_TEXT, posix(BOARD_STATE)],
    [BOARD_PATH_IN_TEXT, boardPath()],
  ]
  const swap = (part: string, i: number): string =>
    i === swaps.length ? part : part.split(swaps[i]![0]).map((p) => swap(p, i + 1)).join(swaps[i]![1])
  return swap(text, 0)
}

/** Initialize ignored local state before the board is used. */
export function useProjectState(): string {
  ensureAkbDir()
  return ensureProjectState(KANBAN, REPO_ROOT)
}
