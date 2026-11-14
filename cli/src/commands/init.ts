import fs from 'node:fs'

import { rel, writeRootIgnoreIfMissing, KANBAN, TODO, README, CONFIG, KANBAN_GITIGNORE, MODULES_MD, ARCHIVE, ROOT_GITIGNORE } from '../lib/paths'
import { CONFIG_TEMPLATE } from '../lib/config-template'
import { say } from '../lib/io'
import { walkMd } from '../lib/cards'
import { scaffoldProjectMemory, type Scaffolded } from '../lib/memory'
import { TASKS_HEADING } from '../lib/readme'
import type { MoveResult } from '../lib/types'

const MODULES_TEMPLATE = `# Modules

What this project is made of — one line per module, each led by its **bolded name**, then
what it is and the paths it covers. A module is a part of the product that grows on its
own, judged by meaning, not by folder.

If a line here disagrees with the repo you just read, fix the line.

_(not filled in yet — build the map from the repo before tagging a card.)_
`

function boardReadme(): string {
  return `# Board

Open tasks for the kanban board. One card per file. Ids are global and never reused —
the number at the front of a filename is the task id.

## ${TASKS_HEADING}

_(none)_
`
}

function writeConfigIfMissing() {
  if (fs.existsSync(CONFIG)) return false
  fs.mkdirSync(KANBAN, { recursive: true })
  fs.writeFileSync(CONFIG, CONFIG_TEMPLATE)
  return true
}

function writeModulesIfMissing() {
  if (fs.existsSync(MODULES_MD)) return false
  fs.mkdirSync(KANBAN, { recursive: true })
  fs.writeFileSync(MODULES_MD, MODULES_TEMPLATE)
  return true
}

const IGNORE_RULES = [
  { line: '.env', comment: "# The board's API keys — never commit them." },
]

function writeGitignoreIfMissing(): boolean {
  fs.mkdirSync(KANBAN, { recursive: true })
  const text = fs.existsSync(KANBAN_GITIGNORE) ? fs.readFileSync(KANBAN_GITIGNORE, 'utf8') : ''
  const has = (rule: { line: string }): boolean => text.split('\n').some((line) => line.trim() === rule.line)
  const missing = IGNORE_RULES.filter((rule) => !has(rule))
  if (!missing.length) return false
  const block = missing.map((rule) => `${rule.comment}\n${rule.line}\n`).join('')
  const separator = !text || text.endsWith('\n') ? '' : '\n'
  fs.writeFileSync(KANBAN_GITIGNORE, `${text}${separator}${block}`)
  return true
}

function writeSkeletonIfMissing(): string[] {
  const added: string[] = []
  if (!fs.existsSync(TODO)) {
    fs.mkdirSync(TODO, { recursive: true })
    added.push(`${rel(TODO)}/`)
  }
  if (!fs.existsSync(README)) {
    fs.writeFileSync(README, boardReadme())
    added.push(rel(README))
  }
  return added
}

// Releases are retired (#1671): drop `releases.md` and every card's `release:` line, open or
// archived. `.release-summaries/` stays as the record of what each closed release held.
export function cmdInit(): MoveResult {
  if (fs.existsSync(KANBAN)) {
    const added: string[] = [
      ...writeSkeletonIfMissing(),
      writeConfigIfMissing() && rel(CONFIG),
      writeModulesIfMissing() && rel(MODULES_MD),
      writeGitignoreIfMissing() && rel(KANBAN_GITIGNORE),
      writeRootIgnoreIfMissing() && rel(ROOT_GITIGNORE),
    ].filter(Boolean) as string[]
    const scaffolded: Scaffolded[] = []
    const project = scaffoldProjectMemory()
    if (project) scaffolded.push(project)
    say(added.length ? `board already exists at ${rel(KANBAN)}/ — added the missing ${added.join(', ')}` : `board already exists at ${rel(KANBAN)}/ — nothing to do`)
    if (added.includes(rel(MODULES_MD))) {
      say(`  next: fill in ${rel(MODULES_MD)} (see "The module map")`)
    }
    return { board: rel(KANBAN), created: false, added, memory_paths: scaffolded.map((s) => rel(s.dir)) }
  }
  fs.mkdirSync(TODO, { recursive: true })
  fs.writeFileSync(README, boardReadme())
  writeConfigIfMissing()
  scaffoldProjectMemory()
  writeModulesIfMissing()
  writeGitignoreIfMissing()
  writeRootIgnoreIfMissing()
  say(`initialised board at ${rel(KANBAN)}/`)
  return { board: rel(KANBAN), created: true }
}
