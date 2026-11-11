// `akb raw file <studio> <path>` (#656): one file of a studio, as `akb studio pull` lays it out —
// `shared/…` or `agents/<name>/…`. In a task's run, the version the task is pinned to.

import { say } from '../lib/io'
import { die } from '../lib/paths'
import { studioFiles } from '../lib/agent/studio-shared'
import { isAboutFile, STUDIO_FILE } from '../lib/shared/studio-files'
import type { MoveResult } from '../lib/types'

export function cmdStudioFile(askedStudio: string, askedFile: string): MoveResult {
  const studio = askedStudio.trim()
  const files = studioFiles(studio)
  if (!files) die(`no studio ${studio}`, { kind: 'no-such-studio', studio })
  const file = askedFile.trim().replace(/^\.\//, '')
  const readable = Object.keys(files!).filter((f) => f === STUDIO_FILE || f.startsWith('shared/') || f.startsWith('agents/')).sort()
  if (!readable.includes(file) || isAboutFile(file)) {
    die(`${studio} has no ${file}. It has: ${readable.join(', ')}.`, { kind: 'no-such-studio-file', studio, file })
  }
  const text = files![file]!
  say(text)
  return { studio, file, text }
}
