// `akb template` — read the shared template catalog and publish as a maintainer.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { cloudEndpoints } from '../lib/cloud/config'
import { accessToken, CLOUD_ACCESS_HINTS } from '../lib/cloud/session'
import { BoardError, say } from '../lib/io'
import { cloudBytes, cloudError, cloudProblem, hasText, invalidResponse, isRecord, readCloudJson, requireResponse, type CloudProblem } from '../lib/cloud/response'
import { die } from '../lib/paths'
import type { MoveResult } from '../lib/types'

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CAPTURED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
const MAX_BYTES = 50 * 1024 * 1024

const WITHOUT = 'You can continue without a template.'
const UNAVAILABLE = 'Templates are not available right now. Try again later.'
const CORRUPT = 'A downloaded file did not match the catalog, so nothing was written. Try again.'

interface Entry {
  path: string
  size: number
  sha256?: string
  url?: string
}

interface WebsitePage {
  path: string
  title: string
  role: string
  previewUrl?: string | null
}

interface WebsiteMeta {
  scope: 'page' | 'site'
  useCase: string
  primaryAction: string
  entry: string
  pages: WebsitePage[]
}

interface TemplateMeta {
  name: string
  title: string
  summary: string
  description: string
  tags: string[]
  access: 'free' | 'pro'
  revision?: string
  pageUrl?: string
  previews: Entry[]
  website?: WebsiteMeta
}

function usage(problem: string, line: string): never {
  die(`${problem}\nusage: ${line}`, { kind: 'bad-args', bare: true, exitCode: 2 })
}

function refuse(message: string, fallback?: string, problem?: CloudProblem): never {
  const text = [message, fallback].filter(Boolean).join('\n')
  if (problem) throw cloudError({ ...problem, message: text }, { bare: true })
  die(text, { kind: 'cloud-refused', bare: true })
}

async function ask(route: string, init: RequestInit = {}, fallback?: string): Promise<Response> {
  const token = await accessToken()
  if (!token.ok) refuse([CLOUD_ACCESS_HINTS[token.reason], 'error' in token ? token.error : undefined].filter(Boolean).join('\n'),
    fallback, { code: token.reason.replace('-', '_'), message: '', retryable: token.reason === 'unreachable' })
  let res: Response
  try {
    res = await fetch(`${cloudEndpoints().api}/v1/templates${route}`, {
      ...init,
      headers: { authorization: `Bearer ${token.token}` },
    })
  } catch {
    refuse(CLOUD_ACCESS_HINTS.unreachable, fallback, { code: 'unreachable', message: '', retryable: true })
  }
  if (res.ok) return res
  const problem = cloudProblem(res, await readCloudJson(res))!
  if (res.status === 401) refuse(`${CLOUD_ACCESS_HINTS.expired}\n${problem.message}`, fallback, problem)
  const detail = problem.message === `Cloud answered ${res.status}.` ? undefined : problem.message
  switch (problem.code) {
    case 'pro_required':
      refuse('This template requires Pro.', fallback, problem)
    case 'not_found':
      // Tags and search can fail even when they don't name a template.
      if (route.startsWith('/') && !route.startsWith('/tags?')) {
        const message = !detail || detail === 'No template has this name.'
          ? 'There is no template with this name.' : detail
        refuse(message, fallback, problem)
      }
      refuse(detail ? `${UNAVAILABLE}\n${detail}` : UNAVAILABLE, fallback, problem)
    case 'owner_only':
      refuse('Only the catalog’s maintainers can publish or delete templates.', undefined, problem)
    case 'template_exists': {
      const message = detail ?? 'A template with this name already exists.'
      refuse(`${message}\nPublish again with --replace to replace it.`, undefined, problem)
    }
    case 'templates_unavailable':
      refuse(detail && detail !== 'Templates are not available right now.' ? detail : UNAVAILABLE, fallback, problem)
  }
  refuse(detail ?? (res.status === 400 ? 'The template request is not valid.' : UNAVAILABLE), fallback, problem)
}

async function asJson<T>(res: Response): Promise<T> {
  const value = await readCloudJson(res)
  const problem = cloudProblem(res, value)
  if (problem) throw cloudError(problem)
  if (!isRecord(value)) throw cloudError(invalidResponse('a valid template response'))
  return value as T
}

function entries(value: unknown): value is Entry[] {
  return Array.isArray(value) && value.every(entry => isRecord(entry) && hasText(entry.path)
    && !/[\\:\0]/.test(entry.path) && entry.path.split('/').every(part => !!part && part !== '.' && part !== '..')
    && typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0
    && (entry.sha256 === undefined || typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256))
    && (entry.url === undefined || hasText(entry.url)))
}

async function downloadEntries(name: string, kind: 'previews' | 'evidence', files: Entry[], to: string, fallback?: string): Promise<string[]> {
  if (!SLUG.test(name)) throw cloudError(invalidResponse('a valid template name'))
  const fetched: { out: string; bytes: Buffer; url?: string }[] = []
  const names = new Set<string>()
  const expected = 'a matching template download'
  for (const file of files) {
    const leaf = path.basename(file.path)
    const out = path.join(to, kind === 'previews' && leaf.startsWith(`${name}-`) ? leaf : `${name}-${leaf}`)
    if (names.has(out)) refuse(CORRUPT, fallback, invalidResponse(expected))
    names.add(out)
    const response = await ask(`/${encodeURIComponent(name)}/${kind}/${route(file.path)}`, {}, fallback)
    const bytes = await cloudBytes(response, expected, { size: file.size }).catch(error => {
      if (!(error instanceof BoardError)) throw error
      return refuse(CORRUPT, fallback, invalidResponse(expected))
    })
    if (file.sha256 && createHash('sha256').update(bytes).digest('hex') !== file.sha256) refuse(CORRUPT, fallback, invalidResponse(expected))
    fetched.push({ out, bytes, url: file.url })
  }
  if (fetched.length) fs.mkdirSync(to, { recursive: true })
  return fetched.map(({ out, bytes, url }) => {
    fs.writeFileSync(out, bytes)
    say(url ? `${out} (${url})` : out)
    return out
  })
}

function category(value: string | undefined, line: string): string {
  if (!value) usage('Missing --category.', line)
  if (!SLUG.test(value)) usage(`--category ${value}: use a lowercase word, like ui or video.`, line)
  return value
}

// ---- reading -----------------------------------------------------------------------

/** `akb template list-tags --category <category>` */
export async function templateTags(opts: { category?: string }, program: string): Promise<MoveResult> {
  const cat = category(opts.category, `${program} template list-tags --category <category>`)
  const { tags } = await asJson<{ tags: { tag: string; count: number }[] }>(
    await ask(`/tags?category=${cat}`, {}, WITHOUT),
  )
  if (tags.length === 0) say('No templates in this category yet.')
  for (const { tag, count } of tags) say(`${tag} (${count})`)
  return { category: cat, tags }
}

/** `akb template search --category <category> --tags <tags> [--limit N] [words…]` */
export async function templateSearch(
  opts: { category?: string; tags?: string; limit?: string; words: string[] },
  program: string,
): Promise<MoveResult> {
  const line = `${program} template search --category <category> --tags <tag[,tag]> [--limit N] [topic words…]`
  const cat = category(opts.category, line)
  const tags = (opts.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean)
  if (tags.length === 0) usage('Missing --tags.', line)
  const query = new URLSearchParams({ category: cat, tags: tags.join(',') })
  if (opts.words.length > 0) query.set('q', opts.words.join(' '))
  if (opts.limit) query.set('limit', opts.limit)
  const { templates } = await asJson<{ templates: TemplateMeta[] }>(await ask(`?${query}`, {}, WITHOUT))
  if (templates.length === 0) say('No template matches.')
  for (const t of templates) {
    const scope = t.website?.scope
    const details = [t.access, scope, t.revision ? `rev ${t.revision}` : undefined].filter(Boolean).join(', ')
    say(`${t.name} — ${t.title} [${details}]`)
    say(`  ${t.summary}`)
    if (t.pageUrl) say(`  page: ${t.pageUrl}`)
    const previewList = t.previews.map((p) => (p.url ? `${p.path} (${p.url})` : p.path)).join(', ') || '-'
    say(`  tags: ${t.tags.join(', ') || '-'} · previews: ${previewList}`)
    for (const l of t.description.split('\n')) say(`  ${l}`)
  }
  return { templates }
}

/** `akb template preview <name> --to <dir>` — its catalog previews, as `<name>-<file>`
 * unless the file already starts with `<name>-`. */
export async function templatePreview(name: string, opts: { to?: string }, program: string): Promise<MoveResult> {
  if (!opts.to) usage('Missing --to.', `${program} template preview <name> --to <dir>`)
  const at = encodeURIComponent(name)
  const { previews, revision, pageUrl } = requireResponse(
    await asJson<{ previews: Entry[]; revision?: string; pageUrl?: string }>(await ask(`/${at}/previews`, {}, WITHOUT)),
    'the template preview list',
    value => entries(value.previews)
      && (value.revision === undefined || hasText(value.revision))
      && (value.pageUrl === undefined || hasText(value.pageUrl)),
  )
  if (previews.length === 0) say('This template has no preview.')
  const written = await downloadEntries(name, 'previews', previews, opts.to, WITHOUT)
  if (pageUrl) say(`page: ${pageUrl}`)
  return {
    name,
    ...(revision !== undefined && { revision }),
    ...(pageUrl !== undefined && { pageUrl }),
    previews: written,
    files: previews.map((p, i) => ({
      path: p.path,
      file: written[i]!,
      size: p.size,
      ...(p.sha256 !== undefined && { sha256: p.sha256 }),
      ...(p.url !== undefined && { url: p.url }),
    })),
  }
}

/** `akb template get <name> --to <dir>` — every file, checked against the catalog's
 *  hashes before any is written, and never over a file already there. */
export async function templateGet(name: string, opts: { to?: string }, program: string): Promise<MoveResult> {
  if (!opts.to) usage('Missing --to.', `${program} template get <name> --to <dir>`)
  const to = opts.to
  const at = encodeURIComponent(name)
  const { template } = requireResponse(
    await asJson<{
      template: {
        title?: string
        revision?: string
        pageUrl?: string
        previews?: Entry[]
        files: Entry[]
      }
    }>(await ask(`/${at}`, {}, WITHOUT)),
    'the template file list',
    value => isRecord(value.template)
      && entries(value.template.files)
      && (value.template.previews === undefined || entries(value.template.previews)),
  )
  const fetched: { out: string; bytes: Buffer }[] = []
  for (const f of template.files) {
    const out = path.resolve(to, f.path)
    if (!out.startsWith(path.resolve(to) + path.sep)) refuse(CORRUPT, WITHOUT)
    const response = await ask(`/${at}/files/${route(f.path)}`, {}, WITHOUT)
    const bytes = await cloudBytes(response, 'a matching template file', { size: f.size }).catch(error => {
      if (!(error instanceof BoardError)) throw error
      return refuse(CORRUPT, WITHOUT, invalidResponse('a matching template file'))
    })
    if (bytes.byteLength !== f.size || createHash('sha256').update(bytes).digest('hex') !== f.sha256) {
      refuse(CORRUPT, WITHOUT)
    }
    fetched.push({ out, bytes })
  }
  const taken = fetched.filter((f) => fs.existsSync(f.out)).map((f) => path.relative(to, f.out))
  if (taken.length > 0) {
    refuse(`The folder already has ${taken.join(', ')}. Use another folder, or move those files first.`)
  }
  for (const f of fetched) {
    fs.mkdirSync(path.dirname(f.out), { recursive: true })
    fs.writeFileSync(f.out, f.bytes)
  }
  say(`Fetched ${name}: ${fetched.length} files into ${to}`)
  if (template.pageUrl) say(`page: ${template.pageUrl}`)
  for (const p of template.previews ?? []) {
    if (p.url) say(`preview: ${p.path} (${p.url})`)
  }
  return {
    name,
    to,
    files: template.files.map((f) => f.path),
    ...(template.title !== undefined && { title: template.title }),
    ...(template.revision !== undefined && { revision: template.revision }),
    ...(template.pageUrl !== undefined && { pageUrl: template.pageUrl }),
    ...(template.previews !== undefined && { previews: template.previews }),
  }
}

const route = (p: string) => p.split('/').map(encodeURIComponent).join('/')

/** `akb template source <name> [--to <dir>]` — where it came from, and the evidence
 *  captured at the time, which stays readable after the original site changes. */
export async function templateSource(name: string, opts: { to?: string }): Promise<MoveResult> {
  const at = encodeURIComponent(name)
  const { source, evidence } = requireResponse(await asJson<{ source: Record<string, unknown>; evidence: Entry[] }>(await ask(`/${at}/source`)),
    'the template source and evidence list', value => isRecord(value.source) && entries(value.evidence))
  const written = opts.to ? await downloadEntries(name, 'evidence', evidence, opts.to) : []
  if (source.original === true) say('An original template, with no outside reference.')
  for (const [k, v] of Object.entries(source)) if (k !== 'original') say(`${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
  if (!opts.to) for (const file of evidence) say(`evidence: ${file.path}`)
  return { name, source, evidence: opts.to ? written : evidence.map((e) => e.path) }
}


// ---- publishing ---------------------------------------------------------------------

/** `akb template publish <dir> [--preview <file>]… [--evidence <file>]… [--replace]` */
export async function templatePublish(
  dir: string,
  opts: { preview: string[]; evidence: string[]; replace?: boolean },
): Promise<MoveResult> {
  const root = path.resolve(dir)
  const manifest = path.join(root, 'template.md')
  if (!fs.existsSync(manifest)) refuse('template.md is missing from the folder’s top level.')
  const meta = readTemplateMeta(fs.readFileSync(manifest, 'utf8'))
  const files = walk(root)
  const total = files.reduce((sum, f) => sum + fs.statSync(path.join(root, f)).size, 0)
  if (total > MAX_BYTES) refuse('The template’s files exceed 50 MB.')
  for (const extra of [...opts.preview, ...opts.evidence]) {
    if (!fs.existsSync(extra)) refuse(`${extra} does not exist.`)
    if (path.resolve(extra).startsWith(root + path.sep)) {
      refuse(`${extra} is inside the template folder. Move the previews and evidence outside it.`)
    }
  }
  if (meta.source.original !== true && opts.evidence.length === 0) {
    refuse('A template cloned from a reference needs its captured evidence, via --evidence.')
  }

  const form = new FormData()
  form.set('meta', JSON.stringify({ ...meta, replace: !!opts.replace }))
  const add = (kind: string, name: string, file: string) =>
    form.append(`${kind}:${name}`, new Blob([fs.readFileSync(file)]), path.basename(name))
  for (const f of files) add('files', f, path.join(root, f))
  for (const f of opts.preview) add('previews', path.basename(f), f)
  for (const f of opts.evidence) add('evidence', path.basename(f), f)

  const done = requireResponse(await asJson<{ name: string; replaced: boolean }>(await ask('', { method: 'POST', body: form })),
    'a template publication receipt', value => value.name === meta.name && typeof value.replaced === 'boolean')
  say(
    done.replaced
      ? `Replaced ${done.name}: ${files.length} files.`
      : `Published ${done.name}: ${files.length} files.`,
  )
  return { name: done.name, replaced: done.replaced, files }
}

/** `akb template delete <name>` — maintainers only. */
export async function templateDelete(name: string): Promise<MoveResult> {
  requireResponse(await asJson<{ name: string; deleted: boolean }>(await ask(`/${encodeURIComponent(name)}`, { method: 'DELETE' })),
    'confirmation that the template was deleted', value => value.name === name && value.deleted === true)
  say(`Deleted ${name} from the catalog.`)
  return { name, deleted: true }
}

/** `akb template showcase <name> <dir>` — what the site shows for a published template,
 *  described by `<dir>/showcase.json` and kept apart from the template. Maintainers only. */
export async function templateShowcase(name: string, dir: string): Promise<MoveResult> {
  const file = path.join(dir, 'showcase.json')
  if (!fs.existsSync(file)) refuse(`showcase.json is missing from ${dir}.`)
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return refuse('showcase.json is not valid JSON.')
  }
  const sides = [meta.original, meta.recreation].filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
  const pages = (Array.isArray(meta.pages) ? meta.pages : []).flatMap((p: unknown) =>
    p && typeof p === 'object' ? [(p as Record<string, unknown>).image, (p as Record<string, unknown>).video] : [p],
  )
  const named = [meta.cover, ...pages, ...sides.flatMap((s) => [s.image, s.video])].filter((p): p is string => typeof p === 'string')
  const form = new FormData()
  form.set('meta', JSON.stringify(meta))
  for (const p of new Set(named)) {
    const at = path.join(dir, p)
    if (!fs.existsSync(at)) refuse(`${at} does not exist.`)
    form.append(`media:${p}`, new Blob([fs.readFileSync(at)]), p)
  }
  const done = requireResponse(await asJson<{ name: string; files: number }>(await ask(`/${encodeURIComponent(name)}/showcase`, { method: 'PUT', body: form })),
    'a showcase publication receipt', value => value.name === name && value.files === new Set(named).size)
  say(`Updated ${name}'s showcase: ${done.files} files.`)
  return { name, files: done.files }
}

/** Every file under the folder, as relative paths; dotfiles and `node_modules` stay home. */
function walk(root: string, sub = ''): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(root, sub), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const rel = sub ? `${sub}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(root, rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out.sort()
}

interface PublishMeta {
  name: string
  category: string
  tags: string[]
  title: string
  summary: string
  description: string
  access: 'free' | 'pro'
  source: Record<string, unknown>
}

/** `template.md`'s frontmatter, checked the way the catalog will check it. */
export function readTemplateMeta(text: string): PublishMeta {
  const m = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'))
  if (!m) refuse('template.md has no frontmatter.')
  const fm = parseYamlSubset(m[1] ?? '')
  const text_ = (k: string, oneLine = true): string => {
    const v = typeof fm[k] === 'string' ? (fm[k] as string).trim() : ''
    if (!v) refuse(`${k} is missing.`)
    if (oneLine && v.includes('\n')) refuse(`${k} must be one line.`)
    return v
  }
  const name = text_('name')
  if (!SLUG.test(name)) refuse('name must use lowercase letters, numbers, and hyphens, like hero-tilted-screen.')
  const cat = text_('category')
  if (!SLUG.test(cat)) refuse('category is a lowercase word, like ui or video.')
  const rawTags = fm.tags === undefined || fm.tags === '' ? [] : fm.tags
  if (!Array.isArray(rawTags)) return refuse('tags must be a list, like [hero, saas].')
  const tags = [...new Set((rawTags as Yaml[]).map(String))]
  const bad = tags.filter((t) => !SLUG.test(t))
  if (bad.length > 0) refuse(`tag ${bad.join(', ')}: use lowercase words joined by hyphens.`)
  const access = fm.access === undefined || fm.access === '' ? 'pro' : fm.access
  if (access !== 'free' && access !== 'pro') return refuse('access must be free or pro.')
  // An absent source means original; the creator answers for that.
  const source = fm.source === undefined || fm.source === '' ? { original: true } : fm.source
  if (typeof source !== 'object' || Array.isArray(source)) {
    refuse('source is malformed. For an original template, omit source or set original: true.')
  }
  const s = source as Record<string, unknown>
  if (s.original !== true) {
    if (typeof s.site !== 'string' || !/^https?:\/\//.test(s.site)) refuse('source.site must be the referenced site’s URL.')
    if (!Array.isArray(s.references) || s.references.length === 0) {
      refuse('source.references must list the URLs used.')
    }
    if (typeof s.captured !== 'string' || !CAPTURED.test(s.captured)) {
      refuse('source.captured must include the capture time and time zone, like 2026-10-16T09:00:00+08:00.')
    }
    if (typeof s.note !== 'string' || !s.note.trim()) {
      refuse('source.note must describe the evidence and who captured it.')
    }
  }
  return {
    name,
    category: cat,
    tags,
    title: text_('title'),
    summary: text_('summary'),
    description: text_('description', false),
    access,
    source: s,
  }
}

type Yaml = string | boolean | Yaml[] | { [k: string]: Yaml }

/** The YAML a template's frontmatter uses: scalars, `[a, b]` and `- item` lists, `|` and `>`
 *  blocks, and nested maps by indentation. */
export function parseYamlSubset(src: string): Record<string, Yaml> {
  const lines = src.split('\n')
  let i = 0
  const indentOf = (l: string) => l.length - l.trimStart().length
  const scalar = (raw: string): Yaml => {
    const v = raw.trim()
    if (v === 'true') return true
    if (v === 'false') return false
    if (v.startsWith('[') && v.endsWith(']')) {
      return v.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter((x) => x !== '')
    }
    return unquote(v)
  }
  const block = (min: number, fold: boolean): string => {
    const out: string[] = []
    while (i < lines.length && (lines[i]!.trim() === '' || indentOf(lines[i]!) >= min)) out.push(lines[i++]!.slice(min))
    while (out.length && out[out.length - 1] === '') out.pop()
    return fold ? out.join(' ').replace(/\s+/g, ' ').trim() : out.join('\n')
  }
  const map = (indent: number): Record<string, Yaml> => {
    const out: Record<string, Yaml> = {}
    while (i < lines.length) {
      const line = lines[i]!
      if (!line.trim() || line.trim().startsWith('#')) { i++; continue }
      if (indentOf(line) < indent) break
      const kv = /^\s*([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line)
      if (!kv) { i++; continue }
      i++
      const [, key = '', rest = ''] = kv
      const next = lines[i] ?? ''
      if (rest === '|' || rest === '>') out[key] = block(indent + 2, rest === '>')
      else if (rest) out[key] = scalar(rest)
      else if (next.trim().startsWith('- ') && indentOf(next) >= indent) {
        const items: Yaml[] = []
        while (i < lines.length && lines[i]!.trim().startsWith('- ')) items.push(scalar(lines[i++]!.trim().slice(2)))
        out[key] = items
      } else if (indentOf(next) > indent) out[key] = map(indentOf(next))
      else out[key] = ''
    }
    return out
  }
  return map(0)
}

function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.length >= 2 ? v.slice(1, -1) : v
  }
  return v
}
