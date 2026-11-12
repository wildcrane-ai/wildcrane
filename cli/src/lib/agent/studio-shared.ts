// What a studio shares among its agents (#656): `shared/RULES.md`, the other files under
// `shared/`, and its memory folder `memory/studios/<studio>/`. Read from the version this run's
// task is pinned to, as every studio file is.

import fs from 'node:fs'
import path from 'node:path'

import { STUDIO_MEMORY_DIR } from '../memory'
import { MEMORY, rel } from '../paths'
import { RULES_FILE, SHARED_DIR } from '../shared/studio-files'
import { rawMove } from './command'
import { cloudFlows, type StudioFiles } from './cloud-studios'

/** One studio's files by akb's name for it (`blog-post`, `wf-…`) or Cloud's id; null when this
 *  board has no such studio. */
export function studioFiles(studio: string): StudioFiles | null {
  const flow = cloudFlows().find((f) => f.def.id === studio || f.cloudId === studio)
  if (flow) return flow.files
  return null
}

/** The paths under `shared/` other than `RULES.md`. */
export const sharedFiles = (files: StudioFiles): string[] =>
  Object.keys(files).filter((f) => f.startsWith(SHARED_DIR) && f !== RULES_FILE).sort()

export const studioMemoryDir = (studio: string): string => path.join(MEMORY, STUDIO_MEMORY_DIR, studio)

/** Every top-level `.md` in the studio's memory folder. */
export function readStudioMemory(studio: string): { name: string; text: string }[] {
  const dir = studioMemoryDir(studio)
  let names: string[] = []
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name).sort()
  } catch {
    return []
  }
  return names.flatMap((name) => {
    try {
      return [{ name, text: fs.readFileSync(path.join(dir, name), 'utf8').trim() }]
    } catch {
      return []
    }
  })
}

const fileLine = (studio: string, file: string) => `- \`${file}\` — \`${rawMove(`file ${studio} ${file}`)}\``

/** The prompt sections a run on `studio` gets: its rules, its files (with `agent`'s own when it
 *  is one of the studio's agents), and, with `memory`, what it remembers. */
export function studioSections(studio: string | undefined, opts: { agent?: string; memory?: boolean } = {}): string[] {
  const files = studio ? studioFiles(studio) : null
  if (!studio || !files) return []
  const rules = files[RULES_FILE]?.trim()
  const own = opts.agent ? Object.keys(files).filter((f) => f.startsWith(`agents/${opts.agent}/`) && f !== `agents/${opts.agent}/AGENT.md`).sort() : []
  const listed = [...sharedFiles(files), ...own]
  const remembered = opts.memory ? readStudioMemory(studio) : []
  return [
    rules ? `——— your studio's rules ———\n\n${rules}` : '',
    listed.length ? `——— your studio's files ———\n\nRead one only when the work calls for it:\n\n${listed.map((f) => fileLine(studio, f)).join('\n')}` : '',
    remembered.length
      ? `——— what your studio remembers ———\n\nFrom \`${rel(studioMemoryDir(studio))}/\`:\n\n${remembered.map((m) => `### \`${m.name}\`\n\n${m.text || '_(empty)_'}`).join('\n\n')}`
      : '',
  ].filter(Boolean)
}

/** Whether `studio`'s files list `agent`'s own, so `studioSections` names them. */
export const studioHoldsAgent = (studio: string | undefined, agent: string): boolean =>
  !!studio && Object.keys(studioFiles(studio) ?? {}).some((f) => f.startsWith(`agents/${agent}/`))
