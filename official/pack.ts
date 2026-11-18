// Official studios as Cloud keeps them: each self-contained folder under studios/.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseStudioFile } from '../cli/src/lib/agent/studio-def.ts'
import { readStudioFolder } from '../cli/src/lib/agent/studio-folder.ts'
import { checkStudioFiles, hashInput, landsOf, officialId, STUDIO_FILE, type StudioFiles } from '../cli/src/lib/shared/studio-files.ts'

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
  const studiosDir = path.join(root, 'studios')
  return dirs(studiosDir).map((folder) => {
    const files = readStudioFolder(path.join(studiosDir, folder))
    const parsed = parseStudioFile(folder, files[STUDIO_FILE] ?? '', STUDIO_FILE)
    if ('problem' in parsed) throw new Error(parsed.problem)
    const def = parsed.def
    const checked = loose ? { ok: true as const } : checkStudioFiles(files, true)
    if (!checked.ok) throw new Error(`official/studios/${folder}: ${checked.file}: ${checked.reason}`)
    if (!def.names?.zh && !loose) throw new Error(`official/studios/${folder}/${STUDIO_FILE}: add its Chinese name under \`names: zh\``)
    return {
      id: officialId(folder),
      name: def.name,
      names: { en: def.name, ...def.names },
      description: def.description,
      when: def.description,
      ...landsOf(def),
      hash: hashOf(files),
      files,
    }
  })
}
