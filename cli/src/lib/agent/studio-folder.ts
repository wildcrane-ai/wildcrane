// A studio folder on disk as the files Cloud keeps (#523): screenshots as data URLs, the rest
// as text. Shared by official/pack.ts and `akb studio push`.

import fs from 'node:fs'
import path from 'node:path'

import { FILE_LIMITS, PUBLICATION_FILE, VERSION_FILE, isAboutFile, studioSizeProblem, type StudioFiles } from '../shared/studio-files.ts'

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** Every file under the folder except Git and publication metadata. */
export function filesOf(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.name.toLowerCase() !== '.git' && (dir !== base || e.name !== PUBLICATION_FILE)).flatMap(e => {
    const full = path.join(dir, e.name)
    if (!e.isFile() && !e.isDirectory()) throw new Error(full + ': only regular files and directories are allowed')
    return e.isDirectory() ? filesOf(full, base) : [path.relative(base, full).split(path.sep).join('/')]
  })
}

export function readStudioFile(dir: string, file: string): string {
  const full = path.join(dir, file)
  const bytes = fs.readFileSync(full)
  if (isAboutFile(file) && !file.endsWith('.md')) return 'data:' + MIME[path.extname(file)] + ';base64,' + bytes.toString('base64')
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new Error(file + ': expected a UTF-8 text file') }
}

export function readStudioFolder(dir: string): StudioFiles {
  const files = filesOf(dir).sort()
  if (files.filter(file => file !== VERSION_FILE).length > FILE_LIMITS.count) throw new Error('Studio file count limit exceeded')
  let total = 0
  return Object.fromEntries(files.map(file => {
    const size = fs.statSync(path.join(dir, file)).size
    if (file !== VERSION_FILE) total += size
    const problem = studioSizeProblem(file, size, total)
    if (problem) throw new Error(problem.file + ': ' + problem.reason)
    return [file, readStudioFile(dir, file)]
  }))
}
