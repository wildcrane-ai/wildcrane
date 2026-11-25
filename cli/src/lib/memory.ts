import fs from 'node:fs'
import path from 'node:path'

import { AGENT_MEMORY, MEMORY } from './paths'
import { moduleNames } from './validate'

// What a scaffold made: the path, the files it wrote, and whether the folder itself is new.
export interface Scaffolded {
  dir: string
  made: string[]
  fresh: boolean
}

// One `## ` heading of a memory file, with how many entries sit under it.
export interface Topic {
  name: string
  entries: number
}

// Where a note belongs: the file, and the topics already in it.
export interface MemoryTarget {
  file: string
  topics: Topic[]
}

/** The agent every planning memory belongs to. The reviews write them, not its flows (#212). */
export const PLANNER = 'planner'

/** The planner's files, in the order a roster lists them. The memory review writes the first
 *  and last (#212), the rejection review `rejected.md` (#929, #1497). */
export const PLANNER_MEMORY_FILES = ['decisions.md', 'rejected.md', 'redesign.md'] as const

/** The board's own record — what it did, and what the project is. Not an agent's. */
export const BOARD_MEMORY_FILES = ['readme.md', 'project.md'] as const

// Each starter is a short header telling the next reader what the file is for; the flows
// fill in the rest over time. Plain language, to match the skill.
const STARTERS: Record<string, string> = {
  'readme.md': `# Shipped

User-facing work that has shipped, one line each — a link to the published doc that
covers it, or a plain-words note.

_(nothing recorded yet — the first finished task fills it in.)_
`,
  'decisions.md': `# Decisions

Settled answers to cards' open questions, grouped by topic. Keep only **user-facing**
calls that guide future planning — what a user can see, do, or would care about.
Internal detail stays on the card.
`,
  'redesign.md': `# Redesign

Design mistakes to avoid when writing a card, grouped by topic. One entry each: the
mistake, then the design we actually want. Read before writing or reviewing a card.
`,
  'rejected.md': `# Rejected

Ideas we turned down, grouped by topic. One line each: the idea, and why we said no. Read
before proposing so you don't re-suggest them.
`,
  // Only a header: `describe-project` writes the body, and runs while there is none (#1268).
  'project.md': `# Project

What the project is today, from its users' side. Rewritten whole by \`akb memory describe-project\`;
edits here do not last.
`,
}

/** Whether a memory file says nothing beyond the header it was seeded with. */
export const onlyStarter = (name: string, text: string): boolean => !text.trim() || normalizeStarter(text) === normalizeStarter(STARTERS[name] ?? '')

const normalizeStarter = (text: string): string =>
  text.trim().replace(/`akb (?:raw )?describe-project`/, '`akb memory describe-project`')

const setOf = (names: readonly string[]): Record<string, string> =>
  Object.fromEntries(names.map((name) => [name, STARTERS[name]!]))

/** The board's record in `memory/` itself, and the planner's folder beside it. Idempotent:
 *  creates only what is missing, so a flow about to write a note can call it first. */
export function scaffoldProjectMemory(): Scaffolded | null {
  const board = scaffoldMemoryDir(MEMORY, setOf(BOARD_MEMORY_FILES))
  const planner = scaffoldMemoryDir(agentMemoryDir(PLANNER), setOf(PLANNER_MEMORY_FILES))
  return board ?? planner
}

function scaffoldMemoryDir(dir: string, set: Record<string, string>): Scaffolded | null {
  const existed = fs.existsSync(dir)
  fs.mkdirSync(dir, { recursive: true })
  const made: string[] = []
  for (const [name, body] of Object.entries(set)) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, body)
      made.push(name)
    }
  }
  if (!existed) return { dir, made, fresh: true }
  return made.length ? { dir, made, fresh: false } : null
}

/** The one folder name a module may not take: it is where agent memories live. */
export const RESERVED_MEMORY_DIR = 'agents'
/** Where each studio's memory lives (#656), `memory/studios/<studio>/`. */
export const STUDIO_MEMORY_DIR = 'studios'

/** One file in an agent's folder: its name, where it is, and what it says. */
export interface AgentMemory {
  name: string
  file: string
  text: string
}

export const agentMemoryDir = (agent: string): string =>
  path.join(AGENT_MEMORY, agent)

export const agentMemoryFile = (agent: string, name: string): string => path.join(agentMemoryDir(agent), name)

// The `.md` files actually in one agent's folder, sorted.
const writtenMemoryNames = (agent: string): string[] => {
  try {
    return fs
      .readdirSync(agentMemoryDir(agent), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** The files an agent owns, by name — the planner's three, or what a spec agent has written. */
export const memoryNamesOf = (agent: string): readonly string[] =>
  agent === PLANNER ? PLANNER_MEMORY_FILES : writtenMemoryNames(agent)

/** Those files' paths — what a roster lists and a delete removes. */
export const agentMemoryFiles = (agent: string): string[] =>
  memoryNamesOf(agent).map((name) => agentMemoryFile(agent, name))

/** What one spec agent remembers: every `.md` in its folder, as written. */
export function readAgentMemory(agent: string): AgentMemory[] {
  return writtenMemoryNames(agent).flatMap((name) => {
    const file = agentMemoryFile(agent, name)
    try {
      return [{ name, file, text: fs.readFileSync(file, 'utf8').trim() }]
    } catch {
      return []
    }
  })
}

// ---- a module's planning memory (#1484) -------------------------------------

/** Names a module may not take: a folder of that name beside the planner's file is what was
 *  split out of it (#959), not a module. */
export const RESERVED_MODULE_NAMES: readonly string[] = PLANNER_MEMORY_FILES.map((name) => name.replace(/\.md$/, ''))

const isModule = (name: string): boolean => !!name && !RESERVED_MODULE_NAMES.includes(name)

/** One module's copy of a planner file. */
export const moduleMemoryFile = (module: string, name: string): string => path.join(agentMemoryDir(PLANNER), module, name)

/** The module folders the planner holds, in `modules.md` order, then any other by name. */
export function plannerModules(): string[] {
  let dirs: string[]
  try {
    dirs = fs
      .readdirSync(agentMemoryDir(PLANNER), { withFileTypes: true })
      .filter((e) => e.isDirectory() && isModule(e.name))
      .map((e) => e.name)
  } catch {
    return []
  }
  const order = moduleNames() ?? []
  return [...order.filter((m) => dirs.includes(m)), ...dirs.filter((d) => !order.includes(d)).sort()]
}

/** One planner file and every module's copy of it that exists — what a run judging for the
 *  whole board reads. */
export const plannerCopies = (name: string): string[] => [
  agentMemoryFile(PLANNER, name),
  ...plannerModules()
    .map((m) => moduleMemoryFile(m, name))
    .filter((file) => fs.existsSync(file)),
]

// ---- where a note goes ------------------------------------------------------

/** The file one memory name lives in — the board's own record in `memory/`, the planner's in
 *  its folder, or the module's copy when a module is named. */
export const memoryFile = (name: string, module = ''): string =>
  (BOARD_MEMORY_FILES as readonly string[]).includes(name)
    ? path.join(MEMORY, name)
    : isModule(module)
      ? moduleMemoryFile(module, name)
      : agentMemoryFile(PLANNER, name)

/** Where a card's note belongs, with the `## ` topics already in that file — a hint for
 *  picking a section without opening the file blind. The note itself is written by hand,
 *  because where a line goes, and whether it merges into one already there, is a judgment
 *  call. Scaffolds first, so the file is there to open. */
export function memoryTarget(name: string, module = ''): MemoryTarget {
  scaffoldProjectMemory()
  const file = memoryFile(name, module)
  scaffoldFile(file, name)
  return { file, topics: readTopics(file) }
}

function scaffoldFile(file: string, name: string): void {
  if (fs.existsSync(file) || !STARTERS[name]) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, STARTERS[name])
}

// The `## ` headings of a memory file, each with how many entries sit under it — enough
// to name a section in the receipt without printing the file.
function readTopics(file: string): Topic[] {
  if (!fs.existsSync(file)) return []
  const topics: Topic[] = []
  let current: Topic | null = null
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      current = { name: heading[1]!, entries: 0 }
      topics.push(current)
    } else if (current && /^\s*[-*] /.test(line)) {
      current.entries++
    }
  }
  return topics
}

/** Directory hints only; memory contents stay on disk for on-demand reads. */
export function memoryDirectories(board?: string): string[] {
  const root = board ? path.join(board, 'memory') : MEMORY
  const walk = (dir: string, depth: number, scoped = true): string[] => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
    return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).flatMap(e => {
      const target = path.join(dir, e.name)
      return depth === 1 ? (!scoped || ['project', 'workspace'].includes(e.name) ? [target] : []) : walk(target, depth - 1, scoped)
    })
  }
  return [
    root,
    ...walk(path.join(root, 'previews'), 3),
    ...walk(path.join(root, 'studios'), 1, false),
    path.join(root, 'agents', PLANNER),
  ].filter(dir => fs.existsSync(dir)).map(dir => `${dir}/`)
}
