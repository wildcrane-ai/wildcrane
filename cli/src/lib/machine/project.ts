// Project-local state shared by the CLI, host and sandboxed agents.
import fs from 'node:fs'
import path from 'node:path'

const RECORD = 'board.json'
export const SESSIONS_FILE = 'sessions.json'
export const SESSIONS_FOLDER = 'sessions'
export const ASSETS_FOLDER = 'assets'
export const SESSIONS_LOCK = 'sessions.lock'
export const INDEX_LOCK = 'index.lock'
export const UI_CONFIG_FILE = 'ui.config.json'

function realPathOf(dir: string): string {
  const here = path.resolve(dir)
  const rest: string[] = []
  let at = here
  for (;;) {
    try {
      return path.join(fs.realpathSync(at), ...rest)
    } catch {
      const up = path.dirname(at)
      if (up === at) return here
      rest.unshift(path.basename(at))
      at = up
    }
  }
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

export function projectStateDir(board: string, root = stateRootOf(board)): string {
  const relative = path.relative(realPathOf(root), realPathOf(board))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The board must be inside its project root.')
  }
  return path.join(realPathOf(root), '.akb', 'boards', relative || '_root')
}

/** Create project-local state and record its board. */
export function ensureProjectState(board: string, root = stateRootOf(board)): string {
  const dir = projectStateDir(board, root)
  fs.mkdirSync(dir, { recursive: true })
  if (recordedBoard(dir) !== realPathOf(board)) {
    fs.writeFileSync(path.join(dir, RECORD), `${JSON.stringify({ board: realPathOf(board) })}\n`)
  }
  return dir
}

export function recordedBoard(dir: string): string | null {
  try {
    const held = JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8')) as { board?: unknown }
    return typeof held.board === 'string' ? held.board : null
  } catch { return null }
}
