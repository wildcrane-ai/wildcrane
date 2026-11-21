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

/** Extra rules from the task's Studio. */
export function studioSections(studio: string | undefined): string[] {
  const files = studio ? studioFiles(studio) : null
  if (!studio || !files) return []
  const rules = files[RULES_FILE]?.trim()
  return rules ? [`——— Studio rules ———\n\n${rules}`] : []
}
