// One studio's `STUDIO.md` (#1890), and where a board finds its studios (#409): Cloud's,
// through ./cloud-studios.ts, and the draft a Studio builder task writes on the board under
// `studios/<draft>/`. What a board saved on a studio's scheduled agents stays in
// `ui.config.json` (./studios.ts).

import fs from 'node:fs'
import path from 'node:path'
import { forgetFileMemos } from '../file-memo'

import { draftFolder } from '../shared/board-files.ts'
import { workspaceTask } from '../cloud/tasks'
import { STUDIOS, rel } from '../paths'
import { cloudFlows } from './cloud-studios'
import { groupLines, parseStudioFile, scalar, type StudioDef } from './studio-def'

export { STUDIO_ID, parseStudioFile, stagesOf, type StudioDef } from './studio-def'

const STUDIO_FILE = 'STUDIO.md'

/** One `STUDIO.md`, written the way the built-ins are; each group left out when empty. */
export function studioFileText(def: StudioDef): string {
  const lines = ['---', `name: ${scalar(def.name)}`]
  const names = Object.entries(def.names ?? {})
  if (names.length) lines.push('names:', ...names.map(([lang, said]) => `  ${lang}: ${scalar(said)}`))
  if (def.description) lines.push(`description: ${scalar(def.description)}`)
  if (def.when) lines.push(`when: ${scalar(def.when)}`)
  lines.push(`needsArtifact: ${def.needsArtifact}`)
  lines.push(...groupLines('previews', def.previews), ...groupLines('land', def.land))
  if (def.memoryFiles?.workspace.length) lines.push('memoryFiles:', `  workspace: [${def.memoryFiles.workspace.map(scalar).join(', ')}]`)
  if (def.scheduled.length) {
    lines.push('scheduled:')
    for (const s of def.scheduled) {
      lines.push(`  - agent: ${scalar(s.agent)}`)
      if (s.cadence) lines.push(`    cadence: ${scalar(s.cadence)}`)
    }
  }
  lines.push('---')
  return `${lines.join('\n')}\n${def.rules ? `\n${def.rules}\n` : ''}`
}

// ---- Cloud's -----------------------------------------------------------------

/** The official studios this board runs, read-only. */
export const builtinDefs = (): StudioDef[] => cloudFlows().filter((f) => f.builtIn).map((f) => f.def)

// ---- the board's: a Studio builder draft ------------------------------------

const fileOf = (id: string): string => path.join(STUDIOS, id, STUDIO_FILE)

/** The draft this process's Studio builder task writes, when there is one: Runner places it
 *  before the task's first job. */
export function draftId(): string | null {
  const task = workspaceTask()
  if (!task) return null
  const id = draftFolder(task)
  return fs.existsSync(fileOf(id)) ? id : null
}

export function readFolder(id: string, problems: string[]): StudioDef | null {
  let source: string
  try {
    source = fs.readFileSync(fileOf(id), 'utf8')
  } catch {
    problems.push(`${rel(fileOf(id))} is missing`)
    return null
  }
  const read = parseStudioFile(id, source, rel(fileOf(id)))
  if ('problem' in read) {
    problems.push(read.problem)
    return null
  }
  return read.def
}

/** The workspace's own studios, then this task's draft, and one line for each that could not
 *  be used. */
export function boardStudioDefs(): { defs: StudioDef[]; problems: string[] } {
  const problems: string[] = []
  const defs = cloudFlows().filter((f) => !f.builtIn).map((f) => f.def)
  const draft = draftId()
  const mine = draft ? readFolder(draft, problems) : null
  return { defs: mine ? [...defs, mine] : defs, problems }
}

/** Write the builder draft. */
export function writeStudioDef(def: StudioDef): void {
  const file = fileOf(def.id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, studioFileText(def))
  forgetFileMemos()
}

