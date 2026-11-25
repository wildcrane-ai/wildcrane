import { countTodos } from '../board/assemble.ts'
import { frontmatterEnd, parseFrontmatter, STATUSES } from '../frontmatter.ts'
import { parseQuestionsBlock } from '../question-block.ts'
import { unquote } from '../yaml.ts'
import { cardHeading, todoHeading, todoLines } from './card-lines.ts'
import type { SourceProblem } from './preview-blocks.ts'

export const LEVELS = ['high', 'med', 'low']

export interface CardStudioContext {
  studio?: string
  previewIds?: readonly string[]
  historicalPreviews?: readonly string[]
}

const required = ['title', 'priority', 'status', 'blocked_by', 'related', 'modules', 'questions']
const lists = new Set(['blocked_by', 'related', 'modules', 'previews', 'source'])
const flags = new Set(['preview_approved', 'rejected'])
const rejection = new Set(['rejected_reason', 'rejected_at', 'rejected_by'])
const scalars = new Set(['title', 'priority', 'status', 'studio', 'triage', 'archived', 'restored', ...flags, ...rejection])
const legacy = new Set(['cadence', 'last_run', 'channels', 'decided', 'verify', 'release', 'schedule', 'roi', 'phases', 'stages', 'phase'])

function problem(file: string, line: number, path: string, code: string, message: string, hint: string): SourceProblem {
  return { file, line, column: 1, path, code, message, hint }
}

type Entry = { line: number; value: string }
type Field = Entry & { block: Entry[] }

export function cardHeaderProblems(file: string, text: string, context?: CardStudioContext, strict = false) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const end = frontmatterEnd(lines)
  const { meta } = parseFrontmatter(text)
  const fields = new Map<string, Field>()
  const problems: SourceProblem[] = []
  const add = (line: number, path: string, code: string, message: string, hint: string) =>
    problems.push(problem(file, line, path, code, message, hint))
  if (!meta) {
    add(1, 'frontmatter', 'frontmatter', 'Expected a leading --- frontmatter block and its closing ---', 'Restore both delimiters.')
    return { lines, end, meta, problems, fields }
  }

  let current: Field | undefined
  let ended = false
  for (let i = 1; i < end; i++) {
    const raw = lines[i]!
    const match = raw.match(/^([A-Za-z_]+):\s*(.*)$/)
    if (match) {
      const name = match[1]!
      if (fields.has(name)) add(i + 1, name, 'duplicate-field', `Field ${name} is repeated`, `Keep one ${name}: entry.`)
      current = { line: i + 1, value: match[2]!, block: [] }
      fields.set(name, current)
      ended = false
    } else if (!raw.trim() || /^\s*#/.test(raw)) {
      ended = true
    } else if (/^\s/.test(raw) && current && !ended) {
      current.block.push({ line: i + 1, value: raw })
    } else {
      add(i + 1, 'frontmatter', 'frontmatter-field', `Ignored frontmatter line ${JSON.stringify(raw)}`, 'Use key: value or contiguous indented list entries.')
    }
  }

  for (const [name, field] of fields) {
    const { line, value, block } = field
    const checked = (entry: Entry, code: string, message: string, hint: string) => add(entry.line, name, code, message, hint)
    if (legacy.has(name)) continue
    if (name === 'questions') {
      if (value.trim() && value.trim() !== '[]') checked(field, 'questions', 'questions must be [] or an indented list', 'Use one indented - item per question.')
      if (value.trim() && block.length) checked(block[0]!, 'questions', 'Indented questions after an inline value are ignored', 'Use questions: followed by indented items.')
      if (!value.trim()) parseQuestionsBlock(block.map(e => e.value), (row, key, message) => {
        add(block[row]!.line, `questions.${key}`, 'questions', message, 'Use the fields written by akb task update-questions.')
      })
      continue
    }
    if (lists.has(name)) {
      const inline = /^\[(.*)\]$/.exec(value.trim())
      const isIds = name === 'blocked_by' || name === 'related'
      const checkItem = (entry: Entry) => {
        const item = unquote(entry.value)
        if (!item.trim() || !balancedScalar(entry.value)) checked(entry, 'list-item', `Invalid item in ${name}: ${JSON.stringify(entry.value)}`, 'Use a non-empty value with paired quotes.')
        else if (isIds && (!/^#?[1-9]\d*$/.test(item) || !Number.isSafeInteger(Number(item.replace(/^#/, ''))))) {
          checked(entry, 'task-ids', `${name} contains an invalid task ID ${JSON.stringify(item)}`, 'Use positive numeric task IDs, such as [12, 34].')
        }
      }
      if (!value.trim()) {
        for (const entry of block) {
          const item = /^\s*-\s+(.+)$/.exec(entry.value)
          if (item) checkItem({ ...entry, value: item[1]! })
          else checked(entry, 'list-item', `Ignored list entry in ${name}`, 'Use an indented - value.')
        }
      } else {
        if (inline) {
          for (const item of inline[1]!.split(',').filter(item => item.trim())) checkItem({ line, value: item })
        } else if (name === 'source') checkItem(field)
        else checked(field, 'list', `${name} must be a list`, 'Use [], [values], or indented list entries.')
        if (block.length) checked(block[0]!, 'list-item', `Indented entries after inline ${name} are ignored`, 'Use either an inline or an indented list.')
      }
      continue
    }
    if (!scalars.has(name)) {
      checked(field, 'unknown-field', `Unrecognized frontmatter field ${name}`, 'Correct its name or move the information to the body.')
      continue
    }
    if (block.length) checked(block[0]!, 'frontmatter-field', `Indented lines under ${name} are ignored`, 'Keep the value on the same line as the field.')
    const allowed = name === 'status' ? STATUSES : name === 'priority' ? LEVELS : undefined
    if (allowed) {
      if (!allowed.includes(name === 'status' ? meta.status : meta.priority) || !balancedScalar(value)) {
        checked(field, name, `Invalid ${name} ${JSON.stringify(value)}`, `Use ${allowed.join(', ')}.`)
      }
    } else if (flags.has(name)) {
      if (!/^(['"]?)true\1$/.test(value.trim())) checked(field, name, `Invalid ${name} ${JSON.stringify(value)}`, 'Use true or omit the field.')
    } else if ((name === 'studio' || name === 'title') && (value.startsWith('[') || !unquote(value).trim() || !balancedScalar(value))) {
      checked(field, name, `Invalid ${name} ${JSON.stringify(value)}`, 'Use a non-empty scalar with paired quotes.')
    } else if (rejection.has(name) && (!meta.rejected || name === 'rejected_by' && !meta.rejected_by)) {
      checked(field, name, `Invalid ${name} on this card`, 'Use akb task remove to record rejection details.')
    }
  }
  for (const name of required) {
    if (!fields.has(name) && (strict || name === 'title')) {
      add(1, name, 'missing-field', `Missing ${name}: in frontmatter`, 'Restore it with the board’s metadata commands.')
    }
  }
  if (context?.studio && meta.studio !== context.studio) {
    add(fields.get('studio')?.line ?? 1, 'studio', 'studio', `Expected studio: ${context.studio}${meta.studio ? `, found ${JSON.stringify(meta.studio)}` : ''}`, 'Use the Studio bound to the task.')
  }
  return { lines, end, meta, problems, fields }
}

function balancedScalar(raw: string): boolean {
  const value = raw.trim()
  const quote = value[0]
  return quote !== "'" && quote !== '"' || (value.length > 1 && value.endsWith(quote))
}

const todoCandidate = /^ {0,3}##[ \t]+Todo[ \t]*#*[ \t]*$/

export function cardTodoProblems(file: string, visible: string[], inPreview = (_line: number) => false): SourceProblem[] {
  const problems: SourceProblem[] = []
  const start = visible.findIndex((line, i) => todoCandidate.test(line) && !inPreview(i + 1))
  if (start < 0) return problems
  if (!todoHeading.test(visible[start]!)) {
    problems.push(problem(file, start + 1, 'Todo', 'todo-heading', 'This Todo heading will not count toward progress', 'Write the heading as ## Todo.'))
  }
  let total = 0
  for (let i = start + 1; i < visible.length; i++) {
    if (inPreview(i + 1)) continue
    const line = visible[i]!
    if (cardHeading.test(line)) break
    if (countTodos(line).total) total++
    else if (/^[ \t]*(?:[-+*]|\d+[.)])[ \t]*\[[ xX]*\]/.test(line)) {
      problems.push(problem(file, i + 1, 'Todo', 'todo-item', `Todo item ${JSON.stringify(line.trim())} will not count toward progress`, 'Use - [ ] or - [x] followed by the step.'))
    }
  }
  if (!total && !problems.length) problems.push(problem(file, start + 1, 'Todo', 'todos', '## Todo has no counted steps', 'Add a step such as - [ ] Implement the requested behavior.'))
  return problems
}

export function newCardWriteProblems(file: string, source: string, previous: string | null, context?: CardStudioContext): SourceProblem[] {
  if (source === previous) return []
  const inspect = (text: string, before?: ReturnType<typeof cardHeaderProblems>) => {
    const header = cardHeaderProblems(file, text, context, true)
    const offset = header.end + 1
    const visible = Array<string>(offset).fill('').concat(todoLines(header.lines.slice(offset).join('\n')))
    const todos = header.meta ? cardTodoProblems(file, visible) : []
    if (before?.meta && !visible.some(line => todoCandidate.test(line))
      && todoLines(before.lines.slice(before.end + 1).join('\n')).some(line => todoHeading.test(line))) {
      todos.push(problem(file, header.end + 2, 'Todo', 'todos', 'The existing ## Todo section is missing', 'Restore the task’s checklist.'))
    }
    return [...header.problems.filter(p => p.code !== 'missing-field' || p.path === 'title' || before?.fields.has(p.path)), ...todos]
  }
  const existing = new Map<string, number>()
  const key = (p: SourceProblem) => JSON.stringify([p.path, p.code, p.message])
  if (previous !== null) for (const p of inspect(previous)) {
    const id = key(p)
    existing.set(id, (existing.get(id) ?? 0) + 1)
  }
  return inspect(source, previous !== null ? cardHeaderProblems(file, previous) : undefined).filter(p => {
    const id = key(p)
    const count = existing.get(id) ?? 0
    if (!count) return true
    existing.set(id, count - 1)
    return false
  })
}
