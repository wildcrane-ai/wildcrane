import { isMap, parseDocument, Scalar } from 'yaml'
import { parseStudioFile, type StudioDef } from '../agent/studio-def.ts'
import { withoutCode, sourcePosition, type SourceProblem } from './preview-blocks.ts'
import type { StudioDiagram } from '../agent/studio-diagram.ts'
import { GUIDE_TOPICS } from './guide-topics.ts'
import { isStudioScreenshot } from './studio-screenshots.ts'

export type StudioFiles = Record<string, string>

export const STUDIO_FILE = 'STUDIO.md'
export const MCP_FILE = 'mcp.json'
export const CARD_TEMPLATE_FILE = 'CARD.md'
export const SHARED_DIR = 'shared/'
export const RULES_FILE = 'shared/RULES.md'
/** Which studio and version a fetched folder came from (#564): written on every read, never stored. */
export const VERSION_FILE = 'version.json'
export const PUBLICATION_FILE = '.publication.json'
export const STUDIO_CATALOG_FILE = 'catalog.json'
export const versionText = (id: string, version: number) => `${JSON.stringify({ id, version })}\n`

const KB = 1024
export const FILE_LIMITS = { file: 2 * KB * KB, total: 10 * KB * KB, count: 500, path: 512 }

/** A marketplace studio's id: `wf_builtin_<folder>`, `-` as `_`. */
export const officialId = (folder: string) => `wf_builtin_${folder.replace(/-/g, '_')}`

/** What is hashed to tell one version of a studio's files from another. */
export const hashInput = (files: StudioFiles) => JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))

export type Checked =
  | { ok: true; def: StudioDef; files: StudioFiles }
  | ({ ok: false; problems: FilesProblem[] } & FilesProblem)

/** What Cloud's approval reads of a studio: whether a card's last approval lands it or archives
 *  it. How many approvals there are is the card's own `stages` (#2154). */
export const landsOf = (_def: StudioDef) => ({ lands: true })

export function stagesFrom(_files: StudioFiles, chosen: string[]): string[][] { return [chosen] }

/** Its `icon` (#461), or null when unset or unreadable. */
export function iconFrom(files: StudioFiles) {
  const read = parseStudioFile('studio', files[STUDIO_FILE] ?? '', STUDIO_FILE)
  return 'def' in read ? read.def.icon ?? null : null
}

/** The studio drawn for its detail page (#451), as akb draws a card's; null when unreadable. */
export function diagramFrom(_files: StudioFiles): StudioDiagram | null { return null }

const encoder = new TextEncoder()
export const safeStudioPath = (file: string) =>
  encoder.encode(file).length <= FILE_LIMITS.path && !/[<>:"\\|?*\x00-\x1f\x7f]/.test(file) && file.split('/').every(part =>
    !!part && encoder.encode(part).length <= 255 && !/[. ]$/.test(part) && !/^(?:\.git$|(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))/i.test(part))

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const skillFile = (name: string) => 'skills/' + name + '/SKILL.md'
export type StudioSkill = { name: string; description: string }

function skillMetadata(source: string, directory: string): StudioSkill | string {
  const front = /^\uFEFF?---[^\S\r\n]*\r?\n([\s\S]*?)^---[^\S\r\n]*(?:\r?\n|$)/m.exec(source)
  if (!front || front.index !== 0) return 'Start SKILL.md with YAML frontmatter'
  const doc = parseDocument(front[1]!)
  if (doc.errors.length || !isMap(doc.contents)) return 'Use valid YAML frontmatter with unique keys'
  let data: Record<string, unknown>
  try {
    data = doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown>
  } catch {
    return 'Use literal YAML metadata'
  }
  const { name, description, license, compatibility, metadata, 'allowed-tools': allowedTools, ...extra } = data
  if (name !== directory || !SKILL_NAME.test(directory) || directory.length > 64) return 'Set name to match the containing skill directory (1–64 lowercase letters, digits and single hyphens)'
  if (typeof description !== 'string' || !description.trim() || [...description].length > 1024) return 'Set description to 1–1024 characters'
  if (license !== undefined && typeof license !== 'string') return 'Set license to a string'
  if (compatibility !== undefined && (typeof compatibility !== 'string' || !compatibility.trim() || [...compatibility].length > 500)) return 'Set compatibility to 1–500 characters'
  if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.values(metadata).some(value => typeof value !== 'string'))) return 'Set metadata to a map of strings'
  if (allowedTools !== undefined && typeof allowedTools !== 'string') return 'Set allowed-tools to a string'
  if (Object.keys(extra).length) return 'Use standard Agent Skills fields and put custom fields under metadata'
  return { name: directory, description: description.trim().replace(/\s+/g, ' ') }
}

export function studioSkills(files: StudioFiles): StudioSkill[] {
  return Object.keys(files).sort().flatMap(file => {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(file)
    if (!match) return []
    const skill = skillMetadata(files[file]!, match[1]!)
    return typeof skill === 'string' ? [] : [skill]
  })
}

export const isStudioGuide = (file: string) => /^(?:README|ABOUT)(?:\.[a-zA-Z0-9-]+)?\.md$/.test(file)

export const isAboutFile = (file: string) =>
  /^ABOUT(\.[a-z]{2})?\.md$/.test(file) || isStudioScreenshot(file)

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

export const studioScreenshotPrefix = (path: string) =>
  'data:' + (path.endsWith('.png') ? 'image/png' : /\.jpe?g$/.test(path) ? 'image/jpeg' : 'image/webp') + ';base64,'

export function studioFileBody(path: string, text: string): { bytes: Uint8Array<ArrayBuffer>; binary: boolean } {
  if (isStudioScreenshot(path)) {
    const prefix = studioScreenshotPrefix(path)
    if (text.startsWith(prefix)) {
      const data = text.slice(prefix.length)
      if (/^[A-Za-z0-9+/]*={0,2}$/.test(data) && data.length % 4 === 0) {
        const raw = atob(data)
        if (btoa(raw) === data) return { bytes: Uint8Array.from(raw, c => c.charCodeAt(0)), binary: true }
      }
    }
  }
  const bytes = encoder.encode(text)
  if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) !== text) throw Error('Invalid UTF-8.')
  return { bytes, binary: false }
}

export function studioSizeProblem(file: string, size: number, total: number): FilesProblem | undefined {
  if (size > FILE_LIMITS.file) return { file, reason: 'is larger than 2 MiB', tooLarge: true }
  if (total > FILE_LIMITS.total) return { file: 'files', reason: 'are larger than 10 MiB together', tooLarge: true }
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
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return `names a server \`${name}\`; use lowercase letters, digits and dashes`
    if (typeof command !== 'string' || !command) return `server \`${name}\` needs a \`command\``
    if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === 'string'))) return `server \`${name}\`: \`args\` must be a list of strings`
    if (Object.keys(rest).length) return `server \`${name}\` takes only \`command\` and \`args\``
  }
  return null
}

export type FilesProblem = Partial<SourceProblem> & { file: string; reason: string; tooLarge?: boolean }

type StudioFileChecks = { allowLegacyPreviewCopy?: boolean; allowLegacyLand?: boolean }

export function formatStudioProblem({ file, line, column, reason, hint }: FilesProblem) {
  const location = line === undefined ? file : `${file}:${line}:${column ?? 1}`
  return `${location}: ${reason}${hint ? `. ${hint}` : ''}`
}

/** `official` allows MCP servers. */
export function checkStudioFiles(value: unknown, official = false, checks: StudioFileChecks = {}): Checked {
  const read = inspect(value, official, checks)
  const first = read.problems[0]
  return first ? { ok: false, ...first, problems: read.problems } : { ok: true, def: read.def!, files: read.files! }
}

/** Every problem `checkStudioFiles` would refuse the files for. */
export const studioFilesProblems = (value: unknown, official = false): FilesProblem[] => inspect(value, official).problems

function inspect(value: unknown, official: boolean, { allowLegacyPreviewCopy, allowLegacyLand }: StudioFileChecks = {}): { problems: FilesProblem[]; def?: StudioDef; files?: StudioFiles } {
  const problems: FilesProblem[] = []
  const fail = (file: string, reason: string, tooLarge = false) => {
    problems.push({ file, reason, ...(tooLarge ? { tooLarge } : {}) })
    return { problems }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('files', 'must be an object of path → text')
  const files: Record<string, unknown> = Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).filter(([file]) => file !== VERSION_FILE && file !== PUBLICATION_FILE)))
  const entries = Object.entries(files)
  if (entries.length > FILE_LIMITS.count) return fail('files', `holds at most ${FILE_LIMITS.count} files`, true)

  let total = 0
  const skills = new Set<string>()
  const paths = new Map<string, { path: string; file: boolean }>([VERSION_FILE, PUBLICATION_FILE].map(file => [file, { path: file, file: true }]))
  const pathProblem = (file: string, reason: string) =>
    problems.push({ file, reason, code: 'studio-path', hint: 'Use a safe relative file path unique within the Studio.' })
  for (const [file, text] of entries) {
    if (typeof text !== 'string' || text.includes('\u0000')) {
      fail(file, 'is not a text file')
      continue
    }
    let size: number
    try { size = studioFileBody(file, text).bytes.length } catch { fail(file, 'is not valid UTF-8'); continue }
    total += size
    const limit = studioSizeProblem(file, size, total)
    if (limit) return fail(limit.file, limit.reason, true)
    if (!safeStudioPath(file)) {
      pathProblem(file, 'Unsafe Studio path')
      continue
    }
    const parts = file.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const at = parts.slice(0, i).join('/')
      const key = at.normalize('NFC').toLowerCase()
      const prior = paths.get(key)
      if (prior && (prior.path !== at || prior.file || i === parts.length)) {
        pathProblem(file, 'Path conflicts with ' + prior.path)
        break
      }
      paths.set(key, { path: at, file: i === parts.length })
    }
    if (file.toLowerCase() === STUDIO_CATALOG_FILE && (!official || file !== STUDIO_CATALOG_FILE)) {
      pathProblem(file, 'The root catalog.json is reserved for official Studio metadata')
    }
    if (file === MCP_FILE) {
      const problem = official ? mcpProblem(text) : 'MCP servers are available to official Studios'
      if (problem) fail(file, problem)
    }
    if (parts[0] === 'skills') {
      const name = parts[1]
      if (parts.length < 3 || !name || !SKILL_NAME.test(name) || name.length > 64) {
        pathProblem(file, 'Expected skills/<name>/<path> with a valid Agent Skills name')
      } else skills.add(name)
    }
  }

  for (const name of skills) {
    const file = skillFile(name)
    const text = files[file]
    const problem = text === undefined ? 'SKILL.md is missing' : typeof text === 'string' ? skillMetadata(text, name) : null
    if (typeof problem === 'string') problems.push({
      file, line: 1, column: 1, code: 'studio-skill', message: problem, reason: problem,
      hint: 'Follow the Agent Skills specification at https://agentskills.io/specification.',
    })
  }

  const source = files[STUDIO_FILE]
  const read = typeof source === 'string' ? parseStudioFile('studio', source, STUDIO_FILE, { requirePreviewCopy: !official && !allowLegacyPreviewCopy, requireLand: !allowLegacyLand }) : null
  if (!read) fail(STUDIO_FILE, 'is missing')
  else if ('problem' in read) for (const problem of read.problems) problems.push({ ...problem, reason: problem.message })
  if (!read || 'problem' in read) return { problems }
  const def = read.def
  for (const [file, text] of Object.entries(files)) {
    if (typeof text !== 'string' || !file.endsWith('.md')) continue
    const masked = withoutCode(text)
    const reference = (offset: number, link: string, message: string) => problems.push({ file, ...sourcePosition(text, offset), path: link, code: 'studio-reference', message, reason: message, hint: 'Use an existing safe relative resource or a shipped AKB Guide.' })
    for (const match of masked.matchAll(/!?\[[^\]]*\]\((<[^>\r\n]+>|[^\s)]+)(?:\s+[^)]*)?\)/g)) {
      const link = match[1]!.replace(/^<|>$/g, '')
      if (/^(?:https?:|mailto:|#)/i.test(link)) continue
      let decoded: string
      try { decoded = decodeURIComponent(link.split(/[?#]/)[0]!) } catch { reference(match.index!, link, 'Invalid resource URL'); continue }
      if (/^(?:[a-z][\w+.-]*:|[/\\])|\\/i.test(decoded) || decoded.split('/').includes('..')) { reference(match.index!, link, 'Unsafe resource path'); continue }
      const target = [...file.split('/').slice(0, -1), ...decoded.split('/').filter(p => p !== '.')].join('/')
      const guideScreenshot = match[0].startsWith('!') && isStudioGuide(file) && isStudioScreenshot(target)
      if (!Object.hasOwn(files, target) && !guideScreenshot) reference(match.index!, link, `Missing resource ${target}`)
    }
    for (const match of text.matchAll(/akb guide ([a-z][a-z-]*)/g)) if (!GUIDE_TOPICS.includes(match[1]!)) reference(match.index!, match[1]!, `Unknown AKB Guide ${match[1]}`)
  }
  return { problems, def, files: files as StudioFiles }
}

/** Copy reusable files into a new workspace Studio with a new name. */
export function cloneFiles(files: StudioFiles, name?: string): { files: StudioFiles } | { refused: string } {
  if (Object.hasOwn(files, MCP_FILE)) return { refused: MCP_FILE }
  const kept = Object.fromEntries(Object.entries(files).filter(([file]) => file !== VERSION_FILE))
  const source = kept[STUDIO_FILE] ?? ''
  const read = parseStudioFile('studio', source, STUDIO_FILE)
  if ('problem' in read) return { files: kept }
  kept[STUDIO_FILE] = source.replace(/^---\r?\n([^]*?)\r?\n---(?:\r?\n|$)/, (_front, yaml: string) => {
    const document = parseDocument(yaml)
    const quoted = (value: string) => Object.assign(new Scalar(value), { type: Scalar.QUOTE_DOUBLE })
    document.set('name', quoted(name ?? `${read.def.name} (copy)`))
    if (name) document.delete('names')
    else if (read.def.names) {
      for (const [lang, text] of Object.entries(read.def.names)) {
        document.setIn(['names', lang], quoted(lang === 'zh' ? `${text}（副本）` : `${text} (copy)`))
      }
    }
    return `---\n${document.toString({ lineWidth: 0 })}---\n`
  })
  return { files: kept }
}

export function previewCatalog(files: StudioFiles) {
  const read = parseStudioFile('studio', files[STUDIO_FILE] ?? '', STUDIO_FILE)
  if ('problem' in read) throw new Error(read.problem)
  return read.def.previews
}
