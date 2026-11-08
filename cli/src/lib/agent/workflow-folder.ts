// A workflow folder on disk as the files Cloud keeps (#523): screenshots as data URLs, the rest
// as text. Shared by official/pack.ts and `akb workflow push`.

import fs from 'node:fs'
import path from 'node:path'

import { isAboutFile, type WorkflowFiles } from '../shared/workflow-files.ts'

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** Every file under `dir`, as `/`-separated paths; dot files and folders are skipped. */
export function filesOf(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? filesOf(full, base) : [path.relative(base, full).split(path.sep).join('/')]
  })
}

export function readWorkflowFile(dir: string, file: string): string {
  const full = path.join(dir, file)
  return isAboutFile(file) && !file.endsWith('.md')
    ? `data:${MIME[path.extname(file)]};base64,${fs.readFileSync(full).toString('base64')}`
    : fs.readFileSync(full, 'utf8')
}

export const readWorkflowFolder = (dir: string): WorkflowFiles =>
  Object.fromEntries(filesOf(dir).sort().map((f) => [f, readWorkflowFile(dir, f)]))
