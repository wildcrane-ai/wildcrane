import { parseFrontmatter } from '../frontmatter.ts'
import { agentSectionOffset, withoutCode, parsePreviewBlocks } from './preview-blocks.ts'
import { CODING_PREVIEWS } from './coding-previews.ts'

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

/** Normalize known Coding sections before merging or submitting a historical archive. */
export function migrateHistoricalArchive(content: string, base?: string): string {
  const roleHeading = /^##[ \t]+By[ \t]+[^\n]*agent[ \t]*$/gm
  if (content.search(roleHeading) < 0) return content
  const original = parseFrontmatter(content).meta?.studio
  const target = base ? parseFrontmatter(base).meta?.studio : undefined
  if ([original, target].some(id => id && id !== 'coding')) return content
  const headings = [...withoutCode(content).matchAll(roleHeading)]
  if (!headings.length) return content
  const ids = new Set(base ? parsePreviewBlocks(base).blocks.map(block => block.id) : [])
  if (!ids.size && original !== 'coding') return content
  if (headings.some(({ index, 0: line }) => {
    const name = /^##[ \t]+By[ \t]+`([^`]+)`[ \t]+agent[ \t]*$/.exec(content.slice(index!, index! + line.length))?.[1]
    return !name || !Object.hasOwn(CODING_PREVIEWS, name) || !!ids.size && !ids.has(CODING_PREVIEWS[name]!)
  })) return content
  try {
    const migrated = migrateTask(content, [], CODING_PREVIEWS).body
    if (withoutCode(migrated).search(roleHeading) < 0) return migrated
  } catch { /* Leave ambiguous archives for conflict resolution. */ }
  return content
}
