import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Goal } from './shared/goal'

export const goalDraftPath = () => process.env.KANBAN_GOALS || null

export function readGoalDraft<T extends { goals: Goal[] }>(file: string): T {
  const draft = JSON.parse(fs.readFileSync(file, 'utf8')) as T
  if (!Array.isArray(draft?.goals)) throw new Error('The goals array is missing or invalid.')
  return draft
}

export function writeGoalDraft<T extends { goals: Goal[] }>(file: string, draft: T) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally { fs.rmSync(temporary, { force: true }) }
}
