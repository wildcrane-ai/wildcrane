// Every open card written before #494 names no studio and ran on Coding. Write that down
// once, so no studio has to be a default.

import fs from 'node:fs'
import path from 'node:path'

import { walkMd } from './cards'
import { BOARD_STATE, KANBAN, RULES, STUDIOS, TODO, TRIAGE } from './paths'
import { studioRenamed } from './shared/board-files'

const MARK = 'card-studios-backfilled'
const RENAMED = 'studio-names'

/** Move a board written before #645 to the Studio names, once: its folders, each definition
 *  file, and the field on open cards and triage items. Never throws. */
function renameToStudio(): void {
  if (!KANBAN || !BOARD_STATE) return
  const mark = path.join(BOARD_STATE, RENAMED)
  try {
    if (fs.existsSync(mark)) return
    for (const [from, to] of [[path.join(KANBAN, 'workflows'), STUDIOS], [path.join(RULES, 'workflows'), path.join(RULES, 'studios')]] as const) {
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to)
    }
    for (const file of [STUDIOS, TODO, TRIAGE].flatMap((dir) => (fs.existsSync(dir) ? walkMd(dir) : []))) {
      const at = path.relative(KANBAN, file).split(path.sep).join('/')
      const text = fs.readFileSync(file, 'utf8')
      const to = studioRenamed(at, text)
      if (to.path === at && to.content === text) continue
      const target = path.join(KANBAN, to.path)
      if (target !== file && fs.existsSync(target)) continue
      fs.writeFileSync(target, to.content)
      if (target !== file) fs.rmSync(file)
    }
    fs.mkdirSync(BOARD_STATE, { recursive: true })
    fs.writeFileSync(mark, '')
  } catch {
    // Tried again on the next command.
  }
}

/** Give each open card with no `studio:` the `coding` one, once per board. Never throws. */
export function backfillCardStudios(): void {
  renameToStudio()
  if (!TODO || !BOARD_STATE) return
  const mark = path.join(BOARD_STATE, MARK)
  try {
    if (fs.existsSync(mark) || !fs.existsSync(TODO)) return
    for (const file of walkMd(TODO)) {
      const text = fs.readFileSync(file, 'utf8')
      if (!text.startsWith('---\n')) continue
      const end = text.indexOf('\n---', 3)
      if (end < 0) continue
      const head = text.slice(0, end)
      if (!/\ntitle:/.test(head) || /\nstudio:/.test(head)) continue
      const modules = /\nmodules:[^\n]*/.exec(head)
      const at = modules ? modules.index + modules[0].length : end
      fs.writeFileSync(file, `${text.slice(0, at)}\nstudio: coding${text.slice(at)}`)
    }
    fs.mkdirSync(BOARD_STATE, { recursive: true })
    fs.writeFileSync(mark, '')
  } catch {
    // Tried again on the next command.
  }
}
