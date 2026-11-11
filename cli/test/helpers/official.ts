// The official studios a test reads (#409): official/, through AI4KANBAN_STUDIOS, or a copy a
// test changes and puts back with `resetOfficial`.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { forgetFileMemos } from '../../src/lib/file-memo.ts'
import { parseStudioFile, studioFileText, type StudioDef } from '../../src/lib/agent/studio-file.ts'

const ORIGINAL = process.env.AI4KANBAN_STUDIOS!
let copy = ''

/** A copy of the official folder akb reads until `resetOfficial`. */
export function editableOfficial(): string {
  if (!copy) {
    copy = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-official-'))
    for (const dir of ['studios', 'agents']) fs.cpSync(path.join(ORIGINAL, dir), path.join(copy, dir), { recursive: true })
    process.env.AI4KANBAN_STUDIOS = copy
  }
  return copy
}

export function resetOfficial(): void {
  if (!copy) return
  fs.rmSync(copy, { recursive: true, force: true })
  copy = ''
  process.env.AI4KANBAN_STUDIOS = ORIGINAL
  forgetFileMemos()
}

/** Change one official studio's `STUDIO.md`. */
export function editStudio(studio: string, change: (def: StudioDef) => void): void {
  const file = path.join(editableOfficial(), 'studios', studio, 'STUDIO.md')
  const read = parseStudioFile(studio, fs.readFileSync(file, 'utf8'), file)
  if ('problem' in read) throw new Error(read.problem)
  change(read.def)
  fs.writeFileSync(file, studioFileText(read.def))
  forgetFileMemos()
}

/** Switch one agent of an official studio on or off; one it does not list joins the end of its
 *  previews. */
export function switchAgent(studio: string, agent: string, on: boolean): { ok: true } {
  editStudio(studio, (def) => {
    const one = [...def.previews, ...def.land].find((h) => h.agent === agent)
    if (!one) def.previews.push({ agent, extra: '', ...(on ? {} : { off: true }) })
    else if (on) delete one.off
    else one.off = true
  })
  return { ok: true }
}

/** Write a file into the official copy, by its path inside it. */
export function writeOfficial(file: string, text: string): void {
  const at = path.join(editableOfficial(), file)
  fs.mkdirSync(path.dirname(at), { recursive: true })
  fs.writeFileSync(at, text)
  forgetFileMemos()
}
