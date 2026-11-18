import { Ajv } from 'ajv'
import { LineCounter, parseDocument } from 'yaml'
import { ICON_COLORS, ICON_NAMES, type AgentIcon } from '../agents/icon.ts'
import { parsePreviewBlocks, sourcePosition, PREVIEW_ID, type SourceProblem } from '../shared/preview-blocks.ts'
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
  needsArtifact: boolean
  icon?: AgentIcon
  previews: StudioPreview[]
  rules: string
}
export const STUDIO_ID = PREVIEW_ID
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
    description: { type: 'string' }, needsArtifact: { type: 'boolean' }, icon,
    previews: { type: 'object', propertyNames: { pattern: PREVIEW_ID.source }, additionalProperties: {
      type: 'object', additionalProperties: false, properties: { title: titles, description: titles, icon },
    } },
  },
} as const
const validate = new Ajv({ allErrors: true, meta: false, validateSchema: false }).compile(STUDIO_SCHEMA)

export function parseStudioFile(id: string, source: string, from: string, requirePreviewCopy = false): { def: StudioDef } | { problem: string; problems: SourceProblem[] } {
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
  if (problems.length) return result()
  let rules = '', at = 0
  for (const block of parsed.blocks) { rules += body.slice(at, block.start); at = block.end }
  rules += body.slice(at)
  return { def: {
    id, name: (raw.name as string).trim(), ...(raw.names ? { names: raw.names as Record<string, string> } : {}),
    description: raw.description as string ?? '', needsArtifact: raw.needsArtifact as boolean ?? false,
    ...(raw.icon ? { icon: raw.icon as AgentIcon } : {}),
    previews: parsed.blocks.map(b => ({ id: b.id, instructions: b.instructions, ...map[b.id] })), rules: rules.trim(),
  } }
}
