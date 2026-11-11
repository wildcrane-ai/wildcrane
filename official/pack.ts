// The official studios as Cloud keeps them (#409): each folder of `studios/` with the
// `agents/` folders it names, plus its own `shared/`, skills and `mcp.json`. Read by the publish script and
// by akb's tests; nothing ships this folder.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSpecAgent } from '../cli/src/lib/agents/parse.ts'
import { parseStudioFile } from '../cli/src/lib/agent/studio-def.ts'
import { filesOf, readStudioFile, readStudioFolder } from '../cli/src/lib/agent/studio-folder.ts'
import { CARD_TEMPLATE_FILE, checkStudioFiles, hashInput, isAboutFile, landsOf, MCP_FILE, officialId, SHARED_DIR, STUDIO_FILE, type StudioFiles } from '../cli/src/lib/shared/studio-files.ts'

export const OFFICIAL = path.dirname(fileURLToPath(import.meta.url))

export interface OfficialStudio {
  id: string
  name: string
  names: Record<string, string>
  description: string
  when: string
  lands: boolean
  /** What tells one version of its files from another. */
  hash: string
  files: StudioFiles
}

const dirs = (dir: string) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()

export { officialId }

export const hashOf = (files: StudioFiles) => crypto.createHash('sha256').update(hashInput(files)).digest('hex')

/** Every official studio under `root`. A broken one throws; `loose`, it is packed as it is,
 *  what akb's tests read. */
export function packOfficial(root = OFFICIAL, loose = false): OfficialStudio[] {
  const agentsDir = path.join(root, 'agents')
  const agentFiles = Object.fromEntries(dirs(agentsDir).map((name) => {
    const dir = path.join(agentsDir, name)
    return [name, readStudioFolder(dir)]
  })) as Record<string, StudioFiles>
  for (const [name, own] of Object.entries(loose ? {} : agentFiles)) {
    const read = parseSpecAgent(own['AGENT.md'] ?? '', `official/agents/${name}/AGENT.md`, (p) => own[p] ?? null, true)
    if ('problem' in read) throw new Error(read.problem)
  }
  const studiosDir = path.join(root, 'studios')
  return dirs(studiosDir).map((folder) => {
    const dir = path.join(studiosDir, folder)
    const files: StudioFiles = {}
    for (const f of filesOf(dir).sort()) {
      if (f === STUDIO_FILE || f === CARD_TEMPLATE_FILE || f === MCP_FILE || f.startsWith('skills/') || f.startsWith(SHARED_DIR) || isAboutFile(f)) files[f] = readStudioFile(dir, f)
    }
    const read = checkStudioFiles({ [STUDIO_FILE]: files[STUDIO_FILE], ...Object.fromEntries(
      Object.entries(agentFiles).flatMap(([name, own]) => Object.entries(own).map(([f, t]) => [`agents/${name}/${f}`, t]))) })
    if (!read.ok && !loose) throw new Error(`official/studios/${folder}: ${read.file}: ${read.reason}`)
    const parsed = parseStudioFile(folder, files[STUDIO_FILE] ?? '', STUDIO_FILE)
    if ('problem' in parsed) throw new Error(parsed.problem)
    const def = parsed.def
    for (const name of [...new Set([...def.previews, ...def.land, ...def.scheduled].map((h) => h.agent))].sort()) {
      for (const [f, text] of Object.entries(agentFiles[name] ?? {})) files[`agents/${name}/${f}`] = text
    }
    const checked = loose ? { ok: true as const } : checkStudioFiles(files, true)
    if (!checked.ok) throw new Error(`official/studios/${folder}: ${checked.file}: ${checked.reason}`)
    if (!def.names?.zh && !loose) throw new Error(`official/studios/${folder}/${STUDIO_FILE}: add its Chinese name under \`names: zh\``)
    return {
      id: officialId(folder),
      name: def.name,
      names: { en: def.name, ...def.names },
      description: def.description,
      when: def.when,
      ...landsOf(def),
      hash: hashOf(files),
      files,
    }
  })
}
