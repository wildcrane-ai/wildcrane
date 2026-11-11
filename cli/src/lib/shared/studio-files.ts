/**
 * A studio as files (#2040): `STUDIO.md` and the folders of the agents it runs,
 * `agents/<name>/AGENT.md` and whatever sits beside it — the layout of a board, read by the
 * same code akb reads them with. Used by the API and by the build that packs the built-ins.
 * An official studio may also carry skills, `skills/<name>/SKILL.md` and its files, and the
 * MCP servers its runs get, `mcp.json` (#2030). `shared/` holds what all its agents use (#656):
 * `shared/RULES.md`, sent with every run, and files any of them may read. `CARD.md` is the
 * template its planner fits each card to (#660).
 */

import { groupLines, parseStudioFile, stagesOf, type StudioDef } from '../agent/studio-def.ts'
import { AGENT_NAME, parseSpecAgent, type SpecAgent } from '../agents/parse.ts'
import { studioDiagram, type StudioDiagram } from '../agent/studio-diagram.ts'

export type StudioFiles = Record<string, string>

export const STUDIO_FILE = 'STUDIO.md'
export const MCP_FILE = 'mcp.json'
export const CARD_TEMPLATE_FILE = 'CARD.md'
export const SHARED_DIR = 'shared/'
export const RULES_FILE = 'shared/RULES.md'
/** Which studio and version a fetched folder came from (#564): written on every read, never stored. */
export const VERSION_FILE = 'version.json'
export const versionText = (id: string, version: number) => `${JSON.stringify({ id, version })}\n`

const KB = 1024
export const FILE_LIMITS = { file: 2 * KB * KB, total: 2 * KB * KB, count: 500, path: 512 }

/** A marketplace studio's id: `wf_builtin_<folder>`, `-` as `_`. */
export const officialId = (folder: string) => `wf_builtin_${folder.replace(/-/g, '_')}`

/** What is hashed to tell one version of a studio's files from another. */
export const hashInput = (files: StudioFiles) => JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))

export type Checked =
  | { ok: true; def: StudioDef; files: StudioFiles }
  | { ok: false; file: string; reason: string; tooLarge?: boolean }

/** What Cloud's approval reads of a studio: whether a card's last approval lands it or archives
 *  it. How many approvals there are is the card's own `stages` (#2154). */
export const landsOf = (def: StudioDef) => ({ lands: def.land.some((h) => !h.off) })

/** The approvals a card's chosen previews make (#2154), each agent's `after` read from the
 *  studio's own files, as the board stages them. */
export function stagesFrom(files: StudioFiles, chosen: string[]): string[][] {
  const read = parseStudioFile('studio', files[STUDIO_FILE] ?? '', STUDIO_FILE)
  if ('problem' in read) return []
  const previews = read.def.previews.filter((h) => !h.off).map((h) => h.agent)
  const after = (name: string): string[] => {
    const text = files[`agents/${name}/AGENT.md`]
    const parsed = text === undefined ? null : parseSpecAgent(text, name, () => null, false)
    return parsed && 'agent' in parsed ? parsed.agent.after.filter((other) => previews.includes(other)) : []
  }
  return stagesOf(previews.filter((name) => chosen.includes(name)), after)
}

/** Its `icon` (#461), or null when unset or unreadable. */
export function iconFrom(files: StudioFiles) {
  const read = parseStudioFile('studio', files[STUDIO_FILE] ?? '', STUDIO_FILE)
  return 'def' in read ? read.def.icon ?? null : null
}

/** The studio drawn for its detail page (#451), as akb draws a card's; null when unreadable. */
export function diagramFrom(files: StudioFiles): StudioDiagram | null {
  const read = parseStudioFile('studio', files[STUDIO_FILE] ?? '', STUDIO_FILE)
  if ('problem' in read) return null
  return studioDiagram(read.def, (name) => {
    const text = files[`agents/${name}/AGENT.md`]
    const parsed = text === undefined ? null : parseSpecAgent(text, name, () => null, false)
    return parsed && 'agent' in parsed ? parsed.agent : null
  })
}

const SEGMENT = /^[\w.-]+$/

/** An official studio's marketplace details (#437): `ABOUT.md`, `ABOUT.<lang>.md` and the
 *  images under `screenshots/`, each held as a data URL. */
export const isAboutFile = (file: string) =>
  /^ABOUT(\.[a-z]{2})?\.md$/.test(file) || /^screenshots\/[\w.-]+\.(png|jpe?g|webp)$/.test(file)

/** Its `ABOUT` in `lang`, else English: the Markdown, with each `![caption](screenshots/…)`
 *  line taken out as a screenshot. */
export function aboutFrom(files: StudioFiles, lang: string | null) {
  const text = (lang && files[`ABOUT.${lang}.md`]) || files['ABOUT.md'] || ''
  const screenshots: { url: string; caption: string }[] = []
  const about = text.split('\n').filter((line) => {
    const shot = /^!\[([^\]]*)\]\((screenshots\/[^)\s]+)\)\s*$/.exec(line.trim())
    const url = shot && files[shot[2] as string]
    if (url) screenshots.push({ url, caption: shot[1] as string })
    return !url
  }).join('\n').trim()
  return { about, screenshots }
}

const bytes = (text: string) => new TextEncoder().encode(text).length

const isSharedFile = (file: string) => {
  const parts = file.split('/')
  return parts.length > 1 && parts[0] === 'shared' && parts.slice(1).every((p) => SEGMENT.test(p) && p !== '.' && p !== '..')
}

/** `<top>/<name>/<path>` → `[name, path]`; null for any other path. */
function folderPath(file: string, top: string): [string, string] | null {
  const parts = file.split('/')
  if (parts.length < 3 || parts[0] !== top || !AGENT_NAME.test(parts[1] as string)) return null
  if (parts.slice(2).some((p) => !SEGMENT.test(p) || p === '.' || p === '..')) return null
  return [parts[1] as string, parts.slice(2).join('/')]
}

/** `{ mcpServers: { <name>: { command, args? } } }`: local servers that need no credentials. */
function mcpProblem(text: string): string | null {
  let read: unknown
  try {
    read = JSON.parse(text)
  } catch {
    return 'is not JSON'
  }
  const servers = (read as { mcpServers?: unknown } | null)?.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return 'must hold `mcpServers`, an object of name → server'
  for (const [name, server] of Object.entries(servers)) {
    const { command, args, ...rest } = (server ?? {}) as Record<string, unknown>
    if (!AGENT_NAME.test(name)) return `names a server \`${name}\`; use lowercase letters, digits and dashes`
    if (typeof command !== 'string' || !command) return `server \`${name}\` needs a \`command\``
    if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === 'string'))) return `server \`${name}\`: \`args\` must be a list of strings`
    if (Object.keys(rest).length) return `server \`${name}\` takes only \`command\` and \`args\``
  }
  return null
}

export type FilesProblem = { file: string; reason: string; tooLarge?: boolean }

/** `official` lets the files carry skills and MCP servers. */
export function checkStudioFiles(value: unknown, official = false): Checked {
  const read = inspect(value, official)
  const first = read.problems[0]
  return first ? { ok: false, ...first } : { ok: true, def: read.def!, files: read.files! }
}

/** Every problem `checkStudioFiles` would refuse the files for. */
export const studioFilesProblems = (value: unknown, official = false): FilesProblem[] => inspect(value, official).problems

function inspect(value: unknown, official: boolean): { problems: FilesProblem[]; def?: StudioDef; files?: StudioFiles } {
  const problems: FilesProblem[] = []
  const fail = (file: string, reason: string, tooLarge = false) => {
    problems.push({ file, reason, ...(tooLarge ? { tooLarge } : {}) })
    return { problems }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('files', 'must be an object of path → text')
  const files = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([file]) => file !== VERSION_FILE))
  const entries = Object.entries(files)
  if (entries.length > FILE_LIMITS.count) return fail('files', `holds at most ${FILE_LIMITS.count} files`, true)

  let total = 0
  const folders = new Map<string, Map<string, string>>()
  const skills = new Set<string>()
  for (const [file, text] of entries) {
    if (typeof text !== 'string' || text.includes('\u0000')) {
      fail(file, 'is not a text file')
      continue
    }
    if (file.length > FILE_LIMITS.path) {
      fail(file, `the path is longer than ${FILE_LIMITS.path} characters`)
      continue
    }
    const size = bytes(text)
    if (size > FILE_LIMITS.file) return fail(file, `is larger than ${FILE_LIMITS.file / KB} KB`, true)
    total += size
    if (total > FILE_LIMITS.total) return fail('files', `are larger than ${FILE_LIMITS.total / KB / KB} MB together`, true)
    if (file === STUDIO_FILE || file === CARD_TEMPLATE_FILE) continue
    if (official && file === MCP_FILE) {
      const problem = mcpProblem(text)
      if (problem) fail(file, problem)
      continue
    }
    if (official && isAboutFile(file)) continue
    if (official && file.startsWith('skills/')) {
      if (!folderPath(file, 'skills')) fail(file, 'is not inside skills/<name>/')
      else skills.add(file.split('/')[1] as string)
      continue
    }
    if (isSharedFile(file)) continue
    const at = folderPath(file, 'agents')
    if (!at) {
      fail(file, `is neither ${STUDIO_FILE}, ${CARD_TEMPLATE_FILE}, shared/ nor inside agents/<name>/`)
      continue
    }
    if (!folders.has(at[0])) folders.set(at[0], new Map())
    folders.get(at[0])!.set(at[1], text)
  }

  for (const name of skills) {
    if (files[`skills/${name}/SKILL.md`] === undefined) fail(`skills/${name}/SKILL.md`, 'is missing')
  }

  const source = files[STUDIO_FILE]
  const read = typeof source === 'string' ? parseStudioFile('studio', source, STUDIO_FILE) : null
  if (!read) fail(STUDIO_FILE, 'is missing')
  else if ('problem' in read) fail(STUDIO_FILE, read.problem.replace(`${STUDIO_FILE}: `, ''))

  const agents = new Map<string, SpecAgent>()
  for (const [name, own] of folders) {
    const from = `agents/${name}/AGENT.md`
    const text = own.get('AGENT.md')
    if (text === undefined) {
      fail(from, 'is missing')
      continue
    }
    const parsed = parseSpecAgent(text, from, (p) => own.get(p) ?? null, false, () => [...own.keys()].filter((p) => p !== 'AGENT.md'))
    if ('problem' in parsed) fail(from, parsed.problem.replace(`${from}: `, ''))
    else if (parsed.agent.name !== name) fail(from, `calls itself \`${parsed.agent.name}\`; it must match its folder`)
    else agents.set(name, parsed.agent)
  }

  if (!read || 'problem' in read) return { problems }
  const def = read.def
  const named: [string, string][] = [
    ...def.previews.map((h): [string, string] => [h.agent, 'it previews with']),
    ...def.land.map((h): [string, string] => [h.agent, 'it lands with']),
    ...def.scheduled.map((s): [string, string] => [s.agent, 'it schedules']),
  ]
  for (const [name, why] of named) {
    if (!agents.has(name) && !folders.has(name)) fail(STUDIO_FILE, `${why} \`${name}\`, which has no agents/${name}/AGENT.md`)
  }
  return { problems, def, files: files as StudioFiles }
}

/** An official studio's files as a new own studio (#444): `STUDIO.md` and `agents/`, its
 *  `name` replaced by `name` and its `names` dropped, or else each marked as a copy. Fails on
 *  what an own studio cannot hold. */
export function cloneFiles(files: StudioFiles, name?: string): { files: StudioFiles } | { refused: string } {
  const refused = Object.keys(files).find((file) => file === MCP_FILE || file.startsWith('skills/'))
  if (refused) return { refused: refused === MCP_FILE ? MCP_FILE : `${refused.split('/').slice(0, 2).join('/')}/` }
  const kept = Object.fromEntries(Object.entries(files).filter(([file]) => !isAboutFile(file)))
  const source = kept[STUDIO_FILE] ?? ''
  const read = parseStudioFile('studio', source, STUDIO_FILE)
  if ('problem' in read) return { files: kept }
  const lines = source.split('\n')
  const end = lines.indexOf('---', 1)
  const head: string[] = []
  for (let i = 1; i < end; i++) {
    const line = lines[i] as string
    if (/^names\s*:/.test(line)) {
      while (i + 1 < end && /^\s/.test(lines[i + 1] as string)) i++
      continue
    }
    if (!/^name\s*:/.test(line)) head.push(line)
  }
  const names = name ? {} : Object.fromEntries(Object.entries(read.def.names ?? {}).map(([lang, said]) => [lang, lang === 'zh' ? `${said}（副本）` : `${said} (copy)`]))
  const named = [
    `name: ${JSON.stringify(name ?? `${read.def.name} (copy)`)}`,
    ...(Object.keys(names).length ? ['names:', ...Object.entries(names).map(([lang, said]) => `  ${lang}: ${JSON.stringify(said)}`)] : []),
  ]
  kept[STUDIO_FILE] = ['---', ...named, ...head, ...lines.slice(end)].join('\n')
  return { files: kept }
}

/** Its files with the workspace's `off` preview agents written `off: true` (#571). */
export function withPreviewsOff(files: StudioFiles, off: string[]): StudioFiles {
  const source = files[STUDIO_FILE] ?? ''
  const read = parseStudioFile('studio', source, STUDIO_FILE)
  if ('problem' in read || !read.def.previews.some((h) => !h.off && off.includes(h.agent))) return files
  const lines = source.split('\n')
  const end = lines.indexOf('---', 1)
  const at = lines.findIndex((line, i) => i > 0 && i < end && /^previews\s*:/.test(line))
  let to = at + 1
  while (to < end && /^[\s-]/.test(lines[to] as string)) to++
  lines.splice(at, to - at, ...groupLines('previews', read.def.previews.map((h) => (off.includes(h.agent) ? { ...h, off: true } : h))))
  return { ...files, [STUDIO_FILE]: lines.join('\n') }
}

export function previewCatalog(files: StudioFiles) {
  const read = parseStudioFile('studio', files[STUDIO_FILE] ?? '', STUDIO_FILE)
  if ('problem' in read) throw new Error(read.problem)
  return read.def.previews.filter((h) => !h.off).map(({ agent: name }) => {
    const text = files[`agents/${name}/AGENT.md`]
    if (text === undefined) throw new Error(`Preview agent ${name} is missing.`)
    const parsed = parseSpecAgent(text, name, () => null, false)
    if ('problem' in parsed) throw new Error(parsed.problem)
    const agent = parsed.agent
    return { agent: name, title: { en: agent.i18n.en?.title, zh: agent.i18n.zh?.title }, when: agent.when ?? '' }
  })
}
