// A Studio builder task (#2004): the studio it writes is `studios/<draft>/` on the task's
// board, with its agents inside, and a job finds the agents in the board's `agents/`, where akb
// reads them. The card's first job places the draft — a new one with a name and no agents,
// a change as the studio is now. After every job its agents go back into the folder and the
// files go to Cloud as written (#622), which the approval saves.

import fs from 'node:fs'
import path from 'node:path'

import { BUILDER, draftFolder } from '../../cli/src/lib/shared/board-files.ts'
import { VERSION_FILE, STUDIO_FILE, type StudioFiles } from '../../cli/src/lib/shared/studio-files.ts'
import { parseStudioFile, type StudioDef } from '../../cli/src/lib/agent/studio-def'
import { yamlScalar } from '../../cli/src/lib/yaml'
import type * as api from './api'
import { answerOf, runAkb, type Akb } from './akb'
import { filesUnder, type TaskFolder } from './task-folder'

export const isBuilder = (ws: Pick<TaskFolder, 'studio'>) => ws.studio === BUILDER

const draftDir = (ws: TaskFolder) => path.join(ws.board, 'studios', draftFolder(ws.task))

/** The line the card names its studio folder with, for the agent alone. */
export const draftLine = (ws: TaskFolder) =>
  `<!-- studio folder: ${path.relative(ws.cwd, draftDir(ws)).split(path.sep).join('/')}/ -->`

const skeleton = (name: string) =>
  ['---', `name: ${/\s#/.test(name) ? JSON.stringify(name) : yamlScalar(name)}`, 'needsArtifact: false', '---', ''].join('\n')

export async function placeDraft(ws: TaskFolder, read: Pick<typeof api, 'readTask' | 'readStudio'>): Promise<api.Call<void>> {
  const dir = draftDir(ws)
  if (fs.existsSync(path.join(dir, STUDIO_FILE))) return { ok: true, value: undefined }
  const task = await read.readTask(ws.task)
  if (!task.ok) return task
  let files: StudioFiles = { [STUDIO_FILE]: skeleton(task.value.title.trim() || 'Untitled') }
  const changes = task.value.context?.studio
  if (changes) {
    const held = await read.readStudio(changes)
    if (!held.ok) return held
    files = held.value.files
  }
  for (const [name, text] of Object.entries(files)) {
    const file = path.resolve(dir, name)
    if (!file.startsWith(dir + path.sep)) continue
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  return { ok: true, value: undefined }
}

/** The version a change's draft started from, which the approval checks Cloud is still at. */
export function draftBase(ws: TaskFolder): number | undefined {
  try {
    const version = JSON.parse(fs.readFileSync(path.join(draftDir(ws), VERSION_FILE), 'utf8')).version
    return Number.isInteger(version) ? version : undefined
  } catch {
    return undefined
  }
}

/** Everyone the studio names. */
const named = (def: StudioDef) => [...new Set([...def.previews, ...def.land, ...def.scheduled].map((h) => h.agent))]

/** The draft as it stands, with its agents; null for any other task. Whether it is right is the
 *  agent's to check (#622). */
export async function builtStudio(ws: TaskFolder, akb: Akb): Promise<StudioFiles | null> {
  if (!isBuilder(ws)) return null
  const id = draftFolder(ws.task)
  const dir = draftDir(ws)
  let source = ''
  try {
    source = fs.readFileSync(path.join(dir, STUDIO_FILE), 'utf8')
  } catch {}
  const read = parseStudioFile(id, source, `studios/${id}/${STUDIO_FILE}`)
  const names = 'def' in read ? named(read.def) : []
  // Each agent from the board's `agents/`, else the copy the draft came with, else the board's
  // built-in one (an official agent such as `builder`).
  const agents = path.join(dir, 'agents')
  if ('def' in read) {
    for (const old of fs.existsSync(agents) ? fs.readdirSync(agents) : []) {
      if (!names.includes(old)) fs.rmSync(path.join(agents, old), { recursive: true, force: true })
    }
  }
  for (const name of names) {
    const from = path.join(ws.board, 'agents', name)
    const to = path.join(agents, name)
    if (fs.existsSync(from)) {
      fs.rmSync(to, { recursive: true, force: true })
      fs.cpSync(from, to, { recursive: true })
    } else if (!fs.existsSync(path.join(to, 'AGENT.md'))) {
      const own = answerOf<{ text?: string }>(
        await runAkb(akb, ['raw', 'agent-file', name, 'AGENT.md', '--json', '--board', ws.board], { cwd: ws.cwd, board: ws.board }),
      )
      if (own?.text) {
        fs.mkdirSync(to, { recursive: true })
        fs.writeFileSync(path.join(to, 'AGENT.md'), own.text)
      }
    }
  }
  return Object.fromEntries(filesUnder(dir).filter((f) => f !== VERSION_FILE).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]))
}
