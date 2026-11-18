export interface SourceProblem {
  file: string
  line: number
  column: number
  path: string
  code: string
  message: string
  hint: string
}
export interface PreviewBlock {
  id: string
  instructions: string
  start: number
  end: number
}
export const PREVIEW_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export function sourcePosition(source: string, offset: number) {
  const before = source.slice(0, offset)
  return { line: before.split('\n').length, column: offset - before.lastIndexOf('\n') }
}
/** Mask Markdown code without changing source offsets. */
export function withoutCode(source: string): string {
  const blank = (s: string) => s.replace(/[^\n\r]/g, ' ')
  let fence: { char: string; length: number } | undefined
  let indented = false, afterBlank = true, inList = false
  return source.split(/(?<=\n)/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line)
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined
      return blank(line)
    }
    if (marker) { fence = { char: marker[1]![0]!, length: marker[1]!.length }; return blank(line) }
    if (!line.trim()) { afterBlank = true; return line }
    const hasIndent = /^(?: {4}|\t)/.test(line)
    if (!hasIndent) indented = false
    if (/^ {0,3}(?:[-+*]|\d+[.)])\s/.test(line)) inList = true
    else if (/^\S/.test(line)) inList = false
    if (hasIndent && (indented || afterBlank && !inList)) { indented = true; return blank(line) }
    afterBlank = false
    return line
  }).join('').replace(/(`+)([^]*?)\1(?!`)/g, blank)
}
export function agentSectionOffset(source: string): number {
  return /^<!--[ \t]*agent[ \t]*-->/m.exec(withoutCode(source))?.index ?? source.length
}

/** Definition and task results share exactly the same delimiters. */
export function parsePreviewBlocks(source: string, file = 'STUDIO.md') {
  const blocks: PreviewBlock[] = [], problems: SourceProblem[] = []
  const masked = withoutCode(source)
  let open: { id: string; start: number; content: number } | undefined
  const seen = new Set<string>()
  const fail = (offset: number, id: string, code: string, message: string, hint: string) => problems.push({ file, ...sourcePosition(source, offset), path: id ? `previews.${id}` : 'previews', code, message, hint })
  for (const tag of masked.matchAll(/<\/?Preview\b[^>]*(?:>|$)/g)) {
    const offset = tag.index!, text = tag[0]
    const closing = /^<\/Preview\s*>$/.test(text)
    if (closing) {
      if (!open) fail(offset, '', 'preview-unexpected-close', 'Preview has no opening tag', 'Remove it or restore its opening tag.')
      else {
        const instructions = source.slice(open.content, offset).trim()
        if (!instructions) fail(open.start, open.id, 'preview-empty', `Preview ${open.id} is empty`, 'Describe the requested output inside the block.')
        blocks.push({ id: open.id, instructions, start: open.start, end: offset + text.length })
        open = undefined
      }
      continue
    }
    const opening = /^<Preview\s+id=(?:"([^"]*)"|'([^']*)')\s*>$/.exec(text)
    if (!opening || open) {
      fail(offset, open?.id ?? '', 'preview-tag', 'Malformed or nested Preview tag', 'Use one non-nested <Preview id="stable-id"> block with only id.')
      continue
    }
    const id = opening[1] ?? opening[2]!
    if (!PREVIEW_ID.test(id) || seen.has(id)) fail(offset, id, 'preview-id', `Invalid or repeated Preview ID ${id}`, 'Use a unique lowercase ID with digits and dashes.')
    seen.add(id)
    open = { id, start: offset, content: offset + text.length }
  }
  if (open) fail(open.start, open.id, 'preview-unclosed', `Preview ${open.id} is not closed`, 'Add </Preview> after this block.')
  return { blocks, problems }
}
