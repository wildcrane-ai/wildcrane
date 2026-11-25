// What a studio shares among its agents (#656): `shared/RULES.md`, the other files under
// `shared/`, and its memory folder `memory/studios/<studio>/`. Read from the version this run's
// task is pinned to, as every studio file is.

import fs from 'node:fs'
import path from 'node:path'

import { STUDIO_MEMORY_DIR } from '../memory'
import { MEMORY, rel } from '../paths'
import { workspaceTask } from '../cloud/tasks'
import { studioName } from '../shared/board-files'
import { RULES_FILE, SHARED_DIR } from '../shared/studio-files'
import { configurationBlock, studioEntry, type ContextBlock } from './runtime-context'
import { studioSetup } from './studio-def'
import { studioConfigContext } from './studio-config'
import { activeStudioPin, cloudFlows, cachedStudioSkillBlock, missingStudioVersion, readVersion, type HeldVersion, type StudioFiles } from './cloud-studios'

/** One studio's files by akb's name for it (`blog-post`, `wf-…`) or Cloud's id; null when this
 *  board has no such studio. */
export function studioFiles(studio: string): StudioFiles | null {
  const task = workspaceTask()
  const pin = task ? activeStudioPin(task) : null
  if (pin && (pin.studio === studio || studioName(pin.studio) === studio)) {
    const held = readVersion(pin.studio, pin.version)
    if (!held) throw new Error(missingStudioVersion(pin))
    return held.files
  }
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

/** Extra rules from the task's Studio. */
export function studioSections(studio: string | undefined): string[] {
  const files = studio ? studioFiles(studio) : null
  if (!studio || !files) return []
  const rules = files[RULES_FILE]?.trim()
  return rules ? [`——— Studio rules ———\n\n${rules}`] : []
}

export function listedStudioVersion(studio: string | undefined): HeldVersion | undefined {
  const flow = studio && cloudFlows().find(f => f.def.id === studio || f.cloudId === studio)
  return flow ? { id: flow.cloudId, version: flow.version, name: flow.def.name, files: flow.files } : undefined
}

export function studioContextBlocks(
  held: HeldVersion, action: string, definition: { name: string; rules: string }, board: string, project: string | null, command?: string,
): ContextBlock[] {
  const config = studioConfigContext(held.id, project, action, file => {
    try { return fs.readFileSync(path.join(board, file), 'utf8') } catch { return undefined }
  })
  const setup = studioSetup(definition.rules)
  return [studioEntry(held.id, definition.name, held.version, action, command),
    ['skills', cachedStudioSkillBlock(held)],
    ['setup', setup && '<studio-setup>\n' + setup + '\n</studio-setup>', 'Studio Setup cleared.'],
    configurationBlock(config)]
}
