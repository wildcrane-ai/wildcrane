import { parsePreviewBlocks, sourcePosition } from './preview-blocks.ts'

/** Structural lines only; examples and comments cannot introduce card sections. */
export function scanCardLines(lines: string[], start = 0) {
  const visible = lines.map(() => '')
  let fence: { char: string; length: number; line: number } | null = null
  let comment = false
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fence) {
      if (delimiter && delimiter[1]![0] === fence.char && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = null
      continue
    }
    if (comment) { if (line.includes('-->')) comment = false; continue }
    if (delimiter) { fence = { char: delimiter[1]![0]!, length: delimiter[1]!.length, line: i + 1 }; continue }
    if (/^\s*<!--\s*agent\s*-->\s*$/.test(line)) { visible[i] = line; continue }
    const clean = line.replace(/<!--.*?-->/g, '')
    const open = clean.indexOf('<!--')
    comment = open >= 0
    visible[i] = comment ? clean.slice(0, open) : clean
  }
  return { visible, fence, comment }
}


export const cardHeading = /^ {0,3}#{1,2}[ \t]+/
export const todoHeading = /^## Todo[ \t]*$/

export function maskPreviewLines(text: string, visible: string[]): void {
  for (const p of parsePreviewBlocks(text).blocks) {
    const start = sourcePosition(text, p.start).line
    const end = sourcePosition(text, p.end).line
    visible.fill('', start, end - 1)
  }
}

export function todoLines(body: string): string[] {
  const { visible } = scanCardLines(body.replace(/\r\n/g, '\n').split('\n'))
  maskPreviewLines(body, visible)
  return visible
}

export function todoSection(body: string): string {
  const visible = todoLines(body)
  const start = visible.findIndex(line => todoHeading.test(line))
  if (start < 0) return ''
  const end = visible.findIndex((line, i) => i > start && cardHeading.test(line))
  return visible.slice(start + 1, end < 0 ? undefined : end).join('\n')
}
