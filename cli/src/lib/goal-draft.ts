import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { decodeGoals, type Goal, type GoalEnvelope, type GoalField } from './shared/goal'

export const goalDraftPath = () => process.env.KANBAN_GOALS || process.env.KANBAN_IDEAS || null
export const goalDraftEnv = (file: string) => ({ KANBAN_GOALS: file, KANBAN_IDEAS: file })

export function readGoalDraft<T extends { goals: Goal[] }>(file: string) {
  return decodeGoals(JSON.parse(fs.readFileSync(file, 'utf8')) as GoalEnvelope<T>)
}

export function writeGoalDraft<T extends { goals: Goal[] }>(file: string, { goals, ...draft }: T, field: GoalField) {
  const entries = field === 'goals' ? goals : goals.map(({ task, ...goal }) => ({ ...goal, task: task?.key ? task : task?.id ?? null }))
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ ...draft, [field]: entries }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally { fs.rmSync(temporary, { force: true }) }
}
