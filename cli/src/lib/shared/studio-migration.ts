/** One-time conversion only. Normal readers never import this module. */
import { parse, stringify } from 'yaml'
import { parseSpecAgent } from '../agents/parse.ts'
import { parseStudioFile } from '../agent/studio-def.ts'
import { type StudioFiles } from './studio-files.ts'
import { agentSectionOffset, withoutCode, parsePreviewBlocks } from './preview-blocks.ts'

import { CODING_PREVIEWS } from './coding-previews.ts'
export { CODING_PREVIEWS } from './coding-previews.ts'

export function migrateStudio(files: StudioFiles, coding = false): { files: StudioFiles; ids: Record<string, string> } {
  const source = files['STUDIO.md'] ?? ''
  const current = parseStudioFile('studio', source, 'STUDIO.md')
  if ('def' in current) return { files, ids: Object.fromEntries(current.def.previews.map(p => [p.id, p.id])) }
  const front = /^---\r?\n([^]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (!front) throw Error('Missing STUDIO.md frontmatter')
  const raw = parse(front[1]!, { uniqueKeys: true })
  if (!raw || !Array.isArray(raw.previews ?? [])) throw Error('Definition cannot be converted reliably')
  const names = (rows: unknown[]) => rows.map(row => typeof row === 'string' ? row : (row as { agent: string }).agent)
  const ids = Object.fromEntries(names(raw.previews ?? []).map(name => [name, coding ? CODING_PREVIEWS[name] ?? name : name]))
  const metadata: Record<string, unknown> = {}, previews: string[] = []
  let body = source.slice(front[0].length).trim()
  const replacements = new Map<string, string>()
  const result: StudioFiles = {}
  for (const [file, text] of Object.entries(files)) {
    if (file === 'version.json' || file === 'STUDIO.md' || /^agents\/[^/]+\/AGENT.md$/.test(file)) continue
    const moved = file.replace(/^agents\//, 'references/')
    replacements.set(file, moved)
    result[moved] = text
  }
  const instruction = (name: string) => {
    const prefix = `agents/${name}/`, text = files[`${prefix}AGENT.md`]
    if (!text) throw Error(`Missing ${prefix}AGENT.md`)
    const read = parseSpecAgent(text, name, path => files[prefix + path] ?? null, false)
    if ('problem' in read) throw Error(read.problem)
    let instructions = read.agent.body
    for (const file of Object.keys(files).filter(p => p.startsWith(prefix) && !p.endsWith('/AGENT.md'))) {
      const relative = file.slice(prefix.length), moved = replacements.get(file)!
      instructions = instructions.split(file).join(moved)
      const pattern = relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      instructions = instructions.replace(new RegExp(`(?<![\\w./-])${pattern}(?![\\w./-])`, 'g'), moved)
    }
    instructions = instructions.replace(/^## (?:Memory|What you remember)\n[\s\S]*?(?=^## |^<\/?Preview|$(?![\s\S]))/gm, '')
      .replace(/``## By `([^`]+)` agent``/g, 'Preview `$1`')
      .replace(/ and the studio['’]s memory/g, '')
    return { ...read.agent, instructions }
  }
  for (const name of names(raw.previews ?? [])) {
    const read = instruction(name), id = ids[name]!
    metadata[id] = { ...(read.icon ? { icon: read.icon } : {}), title: Object.fromEntries(Object.entries(read.i18n).flatMap(([lang, title]) => title.title ? [[lang, title.title]] : [])) }
    if (!Object.keys((metadata[id] as { title: object }).title).length) delete (metadata[id] as { title?: object }).title
    previews.push(`<Preview id="${id}">\n\n${read.instructions}\n\n</Preview>`)
  }
  const delivery = names(raw.land ?? []).map(name => instruction(name).instructions)
  body = [body, ...delivery].filter(Boolean).join('\n\n')
  const meta = Object.fromEntries(['name', 'names', 'description', 'needsArtifact', 'icon'].filter(k => raw[k] !== undefined).map(k => [k, raw[k]]))
  result['STUDIO.md'] = `---\n${stringify({ ...meta, previews: metadata }).trimEnd()}\n---\n\n${body}\n\n${previews.join('\n\n')}\n`
  for (const [file, text] of Object.entries(result)) {
    let revised = text
    for (const [before, after] of replacements) revised = revised.split(before).join(after)
    result[file] = revised
  }
  return { files: result, ids }
}

export interface TaskMigration {
  body: string
  previews: string[]
  historical: Record<string, { title: Record<string, string> }>
}
/** Convert only actual old headings, preserving fenced examples, Sets and file paths. */
export function migrateTask(body: string, previews: string[], ids: Record<string, string>, historical: TaskMigration['historical'] = {}): TaskMigration {
  historical = { ...historical }
  const historicalId = (name: string) => {
    const id = `historical-${name}`
    if (Object.values(ids).includes(id)) throw Error(`Historical Preview ${name} collides with defined Preview ${id}`)
    return id
  }
  for (const name of previews) if (!ids[name] && !Object.values(ids).includes(name) && !Object.hasOwn(historical, name)) historical[historicalId(name)] ??= { title: { en: name } }
  const marker = agentSectionOffset(body)
  const head = body.slice(0, marker), tail = body.slice(marker)
  const headings = [...withoutCode(head).matchAll(/^##[ \t]+[^\n]*$/gm)]
  const groups = new Map<string, string[]>(), chunks: { text: string }[] = []
  let at = 0
  for (let n = 0; n < headings.length; n++) {
    const heading = headings[n]!, name = /^##[ \t]+By[ \t]+`([^`]+)`[ \t]+agent[ \t]*$/.exec(head.slice(heading.index, heading.index! + heading[0].length))?.[1]
    if (!name) continue
    const end = headings[n + 1]?.index ?? head.length
    const id = ids[name] ?? historicalId(name)
    if (!ids[name]) historical[id] ??= { title: { en: name } }
    const result = head.slice(heading.index! + heading[0].length, end).trim()
    if (!result) continue
    chunks.push({ text: head.slice(at, heading.index) })
    const parts = groups.get(id) ?? []
    if (!groups.has(id)) chunks.push({ text: `\u0000${id}\u0000` })
    parts.push(result)
    groups.set(id, parts)
    at = end
  }
  chunks.push({ text: head.slice(at) })
  const migrated = chunks.map(c => c.text.replace(/\u0000([^\u0000]+)\u0000/g, (_, id) => `<Preview id="${id}">\n\n${groups.get(id)!.join('\n\n')}\n\n</Preview>\n\n`)).join('') + tail
  const parsed = parsePreviewBlocks(migrated)
  if (parsed.problems.length) throw Error(parsed.problems.map(p => p.message).join('; '))
  return { body: migrated, previews: [...new Set(previews.map(p => ids[p] ?? (historical[`historical-${p}`] ? `historical-${p}` : p)))], historical }
}
