import { say } from '../lib/io'
import { die } from '../lib/paths'
import { studioFiles } from '../lib/agent/studio-shared'
import { isAboutFile, safeStudioPath, studioSkills, VERSION_FILE } from '../lib/shared/studio-files'
import type { MoveResult } from '../lib/types'

export function cmdStudioFile(askedStudio: string, askedFile: string): MoveResult {
  const studio = askedStudio.trim()
  const files = studioFiles(studio)
  if (!files) die(`no studio ${studio}`, { kind: 'no-such-studio', studio })
  const file = askedFile.trim().replace(/^\.\//, '')
  const readable = Object.keys(files!).filter(f => safeStudioPath(f) && f !== VERSION_FILE && !isAboutFile(f)).sort()
  if (!readable.includes(file)) {
    die(`${studio} has no ${file}. It has: ${readable.join(', ')}.`, { kind: 'no-such-studio-file', studio, file })
  }
  const text = files![file]!
  say(text)
  return { studio, file, text }
}

export function cmdStudioSkills(studio: string): MoveResult {
  const files = studioFiles(studio.trim())
  if (!files) die('no studio ' + studio, { kind: 'no-such-studio', studio })
  const skills = studioSkills(files!)
  for (const { name, description } of skills) say(name + '  ' + description)
  return { skills }
}
