// Reading a card's `questions:` block. No filesystem and `.ts` imports, so Cloud's Worker
// reads a card with the same parser (#2064).

import { unquote } from './yaml.ts'
import type { Question } from './types.ts'

export const MODES = ['single', 'multi']

// An old card may still lead a question with the `[user] ` tag; the next write drops it.
const withoutTag = (text: string): string => text.replace(/^\[user\]\s+/, '')

// Read any accepted form — a plain string, or the mapping the block above parses
// into — as one question object. An options list shorter than one entry reads as
// a plain question, so a half-written card still opens.
export function normalizeQuestion(raw: unknown): Question {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const source = raw as Record<string, unknown>
    const text = withoutTag(String(source.question ?? source.text ?? ''))
    const extra = {
      ...(typeof source.agent === 'string' && source.agent.trim() ? { agent: source.agent.trim() } : {}),
    }
    const options = (Array.isArray(source.options) ? source.options : [])
      .map((o) => String(o).trim())
      .filter(Boolean)
    if (options.length === 0) return { text, ...extra }
    const mode = (MODES.includes(String(source.mode)) ? String(source.mode) : 'single') as 'single' | 'multi'
    const recommend = (Array.isArray(source.recommend) ? source.recommend : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length)
    return { text, mode, options, recommend: mode === 'single' ? recommend.slice(0, 1) : recommend, ...extra }
  }
  return { text: withoutTag(String(raw)) }
}

// Read the indented block under `questions:`. An item is either `- <text>` (plain)
// or `- question: <text>` followed by its `mode:`, `options:` and `recommend:` lines.
// One an old akb marked `skipped: true` is dropped; the next write leaves it out.
export function parseQuestionsBlock(
  lines: string[],
  problem: (row: number, key: string, message: string) => void = () => {},
): Question[] {
  const out: Question[] = []
  const item = /^(\s*)-\s+(.*)$/
  for (let i = 0; i < lines.length; i++) {
    const m = item.exec(lines[i]!)
    if (!m) {
      problem(i, 'item', 'Ignored question line')
      continue
    }
    const [, indent, head] = m as unknown as [string, string, string]
    const opened = head.match(/^question:\s*(.*)$/)
    const text = unquote(opened ? opened[1]! : head)
    if (!text.trim()) problem(i, 'question', 'Question text is empty')
    if (!opened) {
      out.push(normalizeQuestion(text))
      continue
    }
    let skipped = false
    const q: Record<string, unknown> & { options: string[]; recommend: number[] } = {
      question: text, options: [], recommend: [],
    }
    const fields = new Map<string, number>()
    while (i + 1 < lines.length && !item.test(lines[i + 1]!)) {
      const field = lines[++i]!.match(/^(\s*)([A-Za-z_]+):\s*(.*)$/)
      if (!field) {
        problem(i, 'field', 'Ignored question field')
        continue
      }
      const [, fieldIndent, key, val] = field as unknown as [string, string, string, string]
      if (fields.has(key)) problem(i, key, `Repeated question field ${key}`)
      fields.set(key, i)
      if (key === 'options') {
        if (val.trim() && val.trim() !== '[]') problem(i, key, 'Inline question options are ignored')
        let option = item.exec(lines[i + 1] ?? '')
        while (option && option[1]!.length > Math.max(indent.length, fieldIndent.length)) {
          const value = unquote(option[2]!)
          if (!value.trim()) problem(i + 1, key, 'Empty question option is ignored')
          q.options.push(value)
          option = item.exec(lines[++i + 1] ?? '')
        }
      } else if (key === 'recommend') {
        const raw = val.trim()
        const entries = raw.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean)
        if (!/^\[.*\]$/.test(raw) || entries.some(s => !/^[1-9]\d*$/.test(s))) {
          problem(i, key, 'Question recommendations must be a list of positive option numbers')
        }
        q.recommend = entries.map(Number).filter(Number.isInteger)
      } else if (key === 'mode') {
        q.mode = unquote(val)
        if (!MODES.includes(String(q.mode))) problem(i, key, 'Invalid question mode; use single or multi')
      } else if (key === 'agent') {
        q.agent = unquote(val)
        if (!(q.agent as string).trim()) problem(i, key, 'Empty question agent is ignored')
      } else if (key === 'skipped') {
        skipped = unquote(val) === 'true'
        problem(i, key, skipped ? 'Skipped question is dropped when saved' : 'The skipped field is retired')
      } else {
        problem(i, key, `Ignored question field ${key}`)
      }
    }
    const normalized = normalizeQuestion(q)
    if (q.recommend.length !== (normalized.recommend?.length ?? 0)) {
      problem(fields.get('recommend')!, 'recommend', 'Question recommendation is outside the options or single mode allows only one')
    }
    if (fields.has('options') && !q.options.length) problem(fields.get('options')!, 'options', 'Question options need an indented list of non-empty choices')
    if (fields.has('mode') && !normalized.options?.length && MODES.includes(String(q.mode))) {
      problem(fields.get('mode')!, 'mode', 'Question mode is ignored without options')
    }
    if (!skipped) out.push(normalized)
  }
  return out
}
