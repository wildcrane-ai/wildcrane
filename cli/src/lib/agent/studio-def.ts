import { Ajv } from 'ajv'
import { LineCounter, parseDocument } from 'yaml'
import { ICON_COLORS, ICON_NAMES, type AgentIcon } from '../agents/icon.ts'
import { parsePreviewBlocks, sourcePosition, withoutCode, PREVIEW_ID, type PreviewBlock, type SourceProblem } from '../shared/preview-blocks.ts'
import { yamlScalar } from '../yaml.ts'

export interface StudioPreview {
  id: string
  instructions: string
  title?: Record<string, string>
  description?: Record<string, string>
  icon?: AgentIcon
}
export interface StudioDef {
  id: string
  name: string
  names?: Record<string, string>
  description: string
  summaries?: Record<string, string>
  entrypoints?: string[]
  needsArtifact: boolean
  allowedFollowUps?: string
  icon?: AgentIcon
  previews: StudioPreview[]
  rules: string
}
export const STUDIO_ID = PREVIEW_ID

export function withoutStudioCatalog(source: string): string {
  return source.replace(/^---\r?\n([^]*?)\r?\n---(?:\r?\n|$)/, (front, yaml: string) => {
    const document = parseDocument(yaml)
    const summaries = document.delete('summaries')
    const entrypoints = document.delete('entrypoints')
    const followUps = document.delete('allowedFollowUps')
    return summaries || entrypoints || followUps ? `---\n${document.toString({ lineWidth: 0 })}---\n` : front
  })
}
export const scalar = (value: string): string => (/\s#/.test(value) ? JSON.stringify(value) : yamlScalar(value))
const titles = { type: 'object', minProperties: 1, propertyNames: { pattern: '^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$' }, additionalProperties: { type: 'string', minLength: 1, pattern: '\\S' } }
const icon = { anyOf: [
  { type: 'string', enum: ICON_NAMES },
  { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', required: ['d'], additionalProperties: false, properties: {
    d: { type: 'string', minLength: 1, pattern: '^[MmLlHhVvCcSsQqTtAaZz0-9.,\\s-]+$' },
    f: { enum: ICON_COLORS }, o: { const: true }, s: { enum: ICON_COLORS }, w: { type: 'number', exclusiveMinimum: 0, maximum: 3 },
  } } },
] }
export const STUDIO_SCHEMA = {
  type: 'object', required: ['name'], additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, pattern: '\\S' }, names: titles,
    description: { type: 'string' }, summaries: titles,
    entrypoints: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { type: 'string', pattern: PREVIEW_ID.source } },
    needsArtifact: { type: 'boolean' }, allowedFollowUps: { type: 'string' }, icon,
    previews: { type: 'object', propertyNames: { pattern: PREVIEW_ID.source }, additionalProperties: {
      type: 'object', additionalProperties: false, properties: { title: titles, description: titles, icon },
    } },
  },
} as const
const validate = new Ajv({ allErrors: true, meta: false, validateSchema: false }).compile(STUDIO_SCHEMA)

const comments = /<!--[^]*?(?:-->|$)/g
const blank = (text: string) => text.replace(/[^\r\n]/g, ' ')

function studioSections(body: string) {
  const headings = [...withoutCode(body).replace(comments, blank).matchAll(/^ {0,3}#{1,2}(?=[ \t\r\n]|$)[^\r\n]*/gm)]
  return headings.map((heading, index) => {
    const start = heading.index + heading[0].indexOf('#')
    const content = heading.index + heading[0].length
    const name = /^##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(body.slice(start, content))?.[1]
    return { name, start, content, end: headings[index + 1]?.index ?? body.length }
  })
}

function sectionText(body: string, name: string): string {
  const section = studioSections(body).find(heading => heading.name === name)
  return section ? body.slice(section.content, section.end).trim() : ''
}

export function studioSetup(body: string): string {
  const text = sectionText(body, 'Setup')
  return text.replace(comments, '').trim() ? text : ''
}

export const studioLand = (rules: string): string => sectionText(rules, 'Land').replace(comments, '').trim()

function checkStudioSections(body: string, previews: PreviewBlock[], fail: (offset: number, path: string, code: string, message: string, hint: string) => void) {
  let visible = '', end = 0
  for (const block of previews) {
    visible += body.slice(end, block.start) + blank(body.slice(block.start, block.end))
    end = block.end
  }
  visible += body.slice(end)

  const sections = studioSections(visible)
  const instructions = {
    Land: 'Describe delivery, checks and what to record.',
    Work: 'Describe the workflow and tools.',
    Previews: 'Put Preview blocks under this heading, or leave it empty if none are needed.',
  }
  for (const name of ['Land', 'Work', 'Previews'] as const) {
    const matching = sections.filter(section => section.name === name)
    const code = `studio-${name.toLowerCase()}`
    if (!matching.length) fail(0, name, `${code}-missing`, `Missing ## ${name} section`, `Add ## ${name} to the Studio body. ${instructions[name]}`)
    for (const [index, section] of matching.entries()) {
      if (index) fail(section.start, name, `${code}-duplicate`, `Repeated ## ${name} section`, `Combine its contents under one ## ${name} heading.`)
      if (name !== 'Previews' && !visible.slice(section.content, section.end).replace(comments, '').trim()) {
        fail(section.start, name, `${code}-empty`, `The ## ${name} section is empty`, instructions[name])
      }
    }
  }

  let index = 0
  for (const block of previews) {
    while (sections[index] && sections[index]!.end <= block.start) index++
    const section = sections[index]
    if (section?.name !== 'Previews' || block.start < section.content) {
      fail(block.start, `previews.${block.id}`, 'preview-section', `Preview ${block.id} is outside ## Previews`, 'Move the block under ## Previews.')
    }
  }
}

export function parseStudioFile(id: string, source: string, from: string, { requirePreviewCopy = false, requireSections = false } = {}): { def: StudioDef } | { problem: string; problems: SourceProblem[] } {
  const problems: SourceProblem[] = []
  const fail = (offset: number, path: string, code: string, message: string, hint: string) => problems.push({ file: from, ...sourcePosition(source, offset), path, code, message, hint })
  const result = () => ({ problem: problems.map(p => `${p.file}:${p.line}:${p.column} ${p.path}: ${p.code} — ${p.message}. ${p.hint}`).join('\n'), problems })
  if (!STUDIO_ID.test(id)) fail(0, 'id', 'studio-schema', `Invalid Studio ID ${id}`, 'Use lowercase letters, digits and dashes.')
  const front = /^---\r?\n([^]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (!front) { fail(0, '', 'yaml-syntax', 'Missing YAML frontmatter', 'Enclose metadata between --- lines.'); return result() }
  const metaOffset = source.indexOf('\n') + 1, bodyOffset = front[0].length
  const counter = new LineCounter()
  const document = parseDocument(front[1]!, { lineCounter: counter, uniqueKeys: true, strict: true })
  for (const error of document.errors) fail(metaOffset + (error.pos[0] ?? 0), '', error.code === 'DUPLICATE_KEY' ? 'yaml-duplicate-key' : 'yaml-syntax', error.message.split('\n')[0]!, 'Correct the indicated YAML location.')
  if (problems.length) return result()
  let raw: Record<string, unknown>
  try { raw = document.toJS({ maxAliasCount: 0 }) } catch { fail(metaOffset, '', 'yaml-syntax', 'YAML aliases are not supported', 'Write metadata explicitly.'); return result() }
  if (!validate(raw)) {
    for (const error of validate.errors ?? []) {
      const parts = error.instancePath.split('/').slice(1)
      const key = error.params.additionalProperty ?? error.params.missingProperty
      if (key) parts.push(String(key))
      const node = parts.length ? document.getIn(parts, true) as { range?: number[] } | undefined : document.contents
      fail(metaOffset + (node?.range?.[0] ?? 0), parts.join('.'), 'studio-schema', `${parts.join('.') || 'metadata'} ${error.message}`, 'Use only Studio metadata and previews: {id: {title?, description?, icon?}} with the declared field types.')
    }
  }
  const body = source.slice(bodyOffset)
  const parsed = parsePreviewBlocks(body, from)
  problems.push(...parsed.problems.map(p => ({ ...p, line: p.line + source.slice(0, bodyOffset).split('\n').length - 1 })))
  if (problems.length) return result()
  const map = (raw.previews ?? {}) as Record<string, Omit<StudioPreview, 'id' | 'instructions'>>
  for (const block of parsed.blocks) if (!Object.hasOwn(map, block.id)) fail(bodyOffset + block.start, `previews.${block.id}`, 'preview-metadata-missing', `Preview ${block.id} has no metadata entry`, 'Add the ID under previews, using {} if needed.')
  for (const key of Object.keys(map)) if (!parsed.blocks.some(b => b.id === key)) fail(metaOffset + ((document.getIn(['previews', key], true) as { range?: number[] })?.range?.[0] ?? 0), `previews.${key}`, 'preview-body-missing', `Preview ${key} has no body`, 'Add its block or remove unused metadata.')
  if (requirePreviewCopy) for (const block of parsed.blocks) {
    const metadata = Object.hasOwn(map, block.id) ? map[block.id]! : undefined
    if (!metadata) continue
    for (const field of ['title', 'description'] as const) for (const lang of ['en', 'zh']) {
      if (metadata[field]?.[lang]) continue
      fail(bodyOffset + block.start, `previews.${block.id}.${field}.${lang}`, 'preview-display-missing',
        `Preview ${block.id} needs a ${lang} ${field}`, 'Add non-blank en and zh display text in the Preview metadata.')
    }
  }
  if (requireSections) checkStudioSections(body, parsed.blocks, (offset, ...problem) => fail(bodyOffset + offset, ...problem))
  if (problems.length) return result()
  let rules = '', at = 0
  for (const block of parsed.blocks) { rules += body.slice(at, block.start); at = block.end }
  rules += body.slice(at)
  const allowedFollowUps = (raw.allowedFollowUps as string | undefined)?.trim()
  return { def: {
    id, name: (raw.name as string).trim(), ...(raw.names ? { names: raw.names as Record<string, string> } : {}),
    description: raw.description as string ?? '', needsArtifact: raw.needsArtifact as boolean ?? false,
    ...(allowedFollowUps ? { allowedFollowUps } : {}),
    ...(raw.summaries ? { summaries: raw.summaries as Record<string, string> } : {}),
    ...(raw.entrypoints ? { entrypoints: raw.entrypoints as string[] } : {}),
    ...(raw.icon ? { icon: raw.icon as AgentIcon } : {}),
    previews: parsed.blocks.map(b => ({ id: b.id, instructions: b.instructions, ...map[b.id] })), rules: rules.trim(),
  } }
}
