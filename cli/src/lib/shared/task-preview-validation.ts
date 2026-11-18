import { numberOfCard } from './board-files.ts'
import { parsePreviewBlocks, sourcePosition, withoutCode, type SourceProblem } from './preview-blocks.ts'

export function taskPreviewProblems(source: string, ids: readonly string[], historical: readonly string[] = [], file = 'card'): SourceProblem[] {
  const parsed = parsePreviewBlocks(source, file), problems = [...parsed.problems]
  const allowed = new Set([...ids, ...historical])
  const boundary = withoutCode(source).search(/^<!--[ \t]*agent[ \t]*-->/m)
  for (const block of parsed.blocks) {
    if (!allowed.has(block.id)) problems.push({ file, ...sourcePosition(source, block.start), path: `previews.${block.id}`, code: 'preview-id', message: `Unknown Preview ${block.id}`, hint: 'Use an ID from the task-bound Studio.' })
    if (boundary >= 0 && block.start > boundary) problems.push({ file, ...sourcePosition(source, block.start), path: `previews.${block.id}`, code: 'preview-boundary', message: 'Preview results belong above the task boundary', hint: 'Move this Preview above <!-- agent -->.' })
  }
  for (const match of withoutCode(source).matchAll(/^##[ \t]+By[ \t]+[^\n]*agent[ \t]*$/gm)) problems.push({ file, ...sourcePosition(source, match.index!), path: 'previews', code: 'preview-tag', message: 'Role sections are retired', hint: 'Use a closed Preview block with a stable Studio ID.' })
  return problems
}

export const describeTaskPreviewProblems = (problems: readonly SourceProblem[]): string =>
  problems.map(p => `#${numberOfCard(p.file)} ${p.file}:${p.line}:${p.column} — ${p.message}. ${p.hint}`).join('\n')
