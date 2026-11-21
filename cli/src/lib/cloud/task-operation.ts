import fs from 'node:fs'
import path from 'node:path'

export type TaskOperationResult =
  | { status: 'confirmed' }
  | { status: 'pending' | 'rejected'; code?: string; message?: string }

export type Removal = TaskOperationResult & { reason: string; discard: boolean }

export const removalFile = (board: string, task: string) => path.join(board, '.sync', `${task}.removal.json`)
export const taskOfRemoval = (file: string) => /^\.sync\/(task_[\w-]+)\.removal\.json$/.exec(file)?.[1]

export function readRemoval(board: string, task: string): Removal | null {
  try {
    const value = JSON.parse(fs.readFileSync(removalFile(board, task), 'utf8')) as Removal
    if (['pending', 'confirmed', 'rejected'].includes(value.status) && typeof value.reason === 'string' && typeof value.discard === 'boolean') return value
  } catch { /* No local removal receipt. */ }
  return null
}

export function writeRemoval(board: string, task: string, removal: Removal): void {
  const file = removalFile(board, task)
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(removal) + '\n')
  fs.renameSync(temp, file)
}
