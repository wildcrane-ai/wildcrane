import fs from 'node:fs'
import path from 'node:path'
import { frontmatterEnd, parseFrontmatter } from '../frontmatter.ts'
import { numberOfCard } from './board-files.ts'

const markerDirectory = (board: string) => path.join(board, '.sync', 'land-archives')
export const landArchiveMarker = (board: string, task: string) => path.join(markerDirectory(board), task)

export function readLandArchiveOwner(file: string): { job: string | null; number?: number } | null {
  try {
    const saved = fs.readFileSync(file, 'utf8')
    if (/^[\w-]{1,100}$/.test(saved)) return { job: saved }
    const owner = JSON.parse(saved)
    const validJob = owner?.job === null || typeof owner?.job === 'string' && !!owner.job.trim()
    return validJob && Number.isSafeInteger(owner?.number) && owner.number > 0
      ? { job: owner.job, number: owner.number } : null
  } catch { return null }
}

export function writeLandArchiveOwner(file: string, owner: { job: string | null; number: number }): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(owner))
  fs.renameSync(tmp, file)
}

export function landArchiveOwners(board: string, pending?: Record<string, string>) {
  const dir = markerDirectory(board)
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return entries.flatMap(entry => {
    const task = entry.name
    if (!entry.isFile() || !/^[\w-]{1,100}$/.test(task)) return []
    const file = landArchiveMarker(board, task)
    const owner = readLandArchiveOwner(file)
    if (!owner) return []
    let number = owner.number ?? legacyNumber(board, task)
    if (!number) {
      pending ??= legacyArchivePaths(board)
      number = numberOfCard(pending[task] ?? '') ?? undefined
    }
    return number ? [{ task, file, job: owner.job, number }] : []
  })
}

function legacyArchivePaths(board: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(path.join(board, '..', 'base.json'), 'utf8')).pendingArchives ?? {} }
  catch { return {} }
}

function legacyNumber(board: string, task: string): number | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(board, '.sync', task + '.json'), 'utf8'))
    if (Number.isSafeInteger(record?.number) && record.number > 0) return record.number
  } catch { return undefined }
}

/** Older archivers removed the inline dependency. Recover it from a synchronized card. */
export function restoreLandBlockers(text: string, before: string, pending: ReadonlySet<number>): string {
  const current = parseFrontmatter(text).meta?.blocked_by
  const missing = parseFrontmatter(before).meta?.blocked_by.filter(id => pending.has(id) && !current?.includes(id))
  if (!current || !missing?.length) return text
  const lines = text.split('\n')
  const end = frontmatterEnd(lines)
  for (let i = 1; i < end; i++) {
    const line = lines[i]!
    if (!/^blocked_by:[ \t]*\[.*\][ \t]*\r?$/.test(line)) continue
    const refs = line.slice(line.indexOf('[') + 1, line.lastIndexOf(']')).trim()
    lines[i] = line.replace(/\[.*\]/, `[${[refs, ...missing].filter(Boolean).join(', ')}]`)
    return lines.join('\n')
  }
  return text
}
