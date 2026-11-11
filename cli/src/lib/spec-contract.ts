import fs from 'node:fs'
import path from 'node:path'

import { enclosingGroupRoot, idPrefix, isLegacyRecurring, walkMd } from './cards'
import { parseFrontmatter } from './frontmatter'
import { ASSETS, rel, TODO } from './paths'
import { compareAttrs, compareKind, shotsProblem, storyboardProblem, type Shot } from './compare'
import { assetName, storyboardMarkers, storyboardTag, studioTag } from './storyboard'
import { validatePreviewFiles } from './preview-files'
import { dependencyCycle, LEVELS, STATUSES } from './validate'

export interface ContractError {
  file: string
  line: number
  rule: string
  message: string
}

export interface CardSource {
  id: number
  text: string
}
export type SpecSnapshot = Map<string, CardSource>

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

/** Read raw files so malformed frontmatter cannot make a changed card disappear. */
export function snapshotSpecs(): SpecSnapshot {
  const out: SpecSnapshot = new Map()
  if (!fs.existsSync(TODO)) return out
  for (const file of walkMd(TODO)) {
    if (isLegacyRecurring(path.relative(TODO, file))) continue
    const id = idPrefix(path.basename(file) === 'root.md' ? path.basename(path.dirname(file)) : path.basename(file))
    if (id !== null) out.set(file, { id, text: fs.readFileSync(file, 'utf8') })
  }
  return out
}

// The ids of every group `file` sits inside, nearest first.
function enclosingGroups(file: string): number[] {
  const ids: number[] = []
  for (let root = enclosingGroupRoot(file); root; root = enclosingGroupRoot(root)) {
    const id = idPrefix(path.basename(path.dirname(root)))
    if (id !== null) ids.push(id)
  }
  return ids
}

/** Format, plus a dependency cycle through the card's own group; other semantic planning decisions remain
 *  the agent's responsibility. With `id`, a storyboard the card points at must be a file in
 *  its asset folder. */
export function validateSpec(file: string, text: string, id?: number): ContractError[] {
  const errors: ContractError[] = []
  const add = (line: number, rule: string, message: string) => errors.push({ file: rel(file), line, rule, message })
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (lines[0]?.trim() !== '---' || end < 0) {
    add(1, 'frontmatter', 'Expected a leading --- frontmatter block and its closing ---. Restore both delimiters.')
    return errors
  }
  const fields = new Map<string, { line: number; value: string }>()
  for (let i = 1; i < end; i++) {
    const line = lines[i]!
    if (!line.trim() || /^\s|^#/.test(line)) continue
    const match = line.match(/^([a-z_]+):\s*(.*)$/)
    if (!match) { add(i + 1, 'frontmatter', `Invalid field ${JSON.stringify(line)}. Use key: value; indent list entries.`); continue }
    const key = match[1]!
    if (fields.has(key)) add(i + 1, 'duplicate-field', `Field ${key} is repeated. Keep one ${key}: entry.`)
    fields.set(key, { line: i + 1, value: match[2]! })
  }
  for (const key of ['title', 'priority', 'status', 'blocked_by', 'related', 'modules', 'questions']) {
    if (!fields.has(key)) add(1, 'missing-field', `Missing ${key}: in frontmatter. Restore it with the board's metadata commands.`)
  }
  const { meta } = parseFrontmatter(text)
  if (typeof meta?.title !== 'string' || !meta.title.trim()) add(fields.get('title')?.line ?? 1, 'title', 'The title is empty. Set a non-empty title with akb raw update.')
  for (const key of ['priority', 'status'] as const) {
    const allowed = key === 'status' ? STATUSES : LEVELS
    const value = fields.get(key)
    if (value && !allowed.includes(value.value.replace(/^['"]|['"]$/g, ''))) {
      add(value.line, key, `Invalid ${key} ${JSON.stringify(value.value)}. Expected ${allowed.join(', ')}; use akb raw update.`)
    }
  }
  const approved = fields.get('preview_approved')
  if (approved && approved.value !== 'true') {
    add(approved.line, 'preview_approved', `Invalid preview_approved ${JSON.stringify(approved.value)}. Only the board writes it, as true; remove the line.`)
  }
  const rejected = fields.get('rejected')
  if (rejected && rejected.value !== 'true') {
    add(rejected.line, 'rejected', `Invalid rejected ${JSON.stringify(rejected.value)}. Only akb raw reject writes it, as true; remove the line.`)
  }
  for (const key of ['rejected_reason', 'rejected_at', 'rejected_by']) {
    const field = fields.get(key)
    if (field && !rejected) add(field.line, key, `${key} is only kept on a rejected card. Only akb raw reject writes it; remove the line.`)
  }
  for (const key of ['blocked_by', 'related', 'modules', 'questions']) {
    const field = fields.get(key)
    if (!field) continue
    if (field.value !== '' && !/^\[.*\]$/.test(field.value)) {
      add(field.line, 'list', `${key} must be a list: use [] when empty, [values], or indented list entries.`)
    }
    if (key === 'blocked_by' || key === 'related') {
      const values = field.value.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
      if (values.some((s) => !/^[1-9]\d*$/.test(s))) add(field.line, 'task-ids', `${key} must contain positive numeric task IDs, such as [12, 34].`)
      if (key === 'blocked_by') {
        const groups = enclosingGroups(file)
        for (const g of groups.filter((g) => values.includes(String(g)))) {
          add(field.line, 'dependency-cycle', `blocked_by names #${g}, a group this card is in; the group waits for this card, so neither can finish. Remove it with akb raw update.`)
        }
        // Moving a card into a group can close a cycle through other cards that no update checked.
        if (id !== undefined && groups.length) {
          for (const dep of values.filter((v) => /^\d+$/.test(v) && !groups.includes(Number(v))).map(Number)) {
            const cycle = dependencyCycle(id, dep)
            if (cycle) add(field.line, 'dependency-cycle', `blocked_by #${dep} makes a cycle: ${cycle.map((n) => `#${n}`).join(' → ')}. Drop one link with akb raw update <id> --blocked-by.`)
          }
        }
      }
    }
  }

  const headings: { title: string; line: number }[] = []
  const markers: number[] = []
  const { visible, fence, comment } = scanCardLines(lines, end + 1)
  const acceptance: { line: number; level: number }[] = []
  const sets = new Set<number>()
  for (let i = end + 1; i < lines.length; i++) {
    const line = visible[i]!
    if (/^\s*<!--\s*agent\s*-->\s*$/.test(line)) { markers.push(i + 1); continue }
    const done = line.match(/^ {0,3}(#{2,3})\s+Done when\s*#*\s*$/)
    if (done) acceptance.push({ line: i + 1, level: done[1]!.length })
    const heading = line.match(/^ {0,3}(#{1,2})\s+(.+?)\s*#*\s*$/)
    if (heading?.[1] === '#') add(i + 1, 'heading', 'Do not repeat the card title as an H1. Remove this heading or use ### inside your section.')
    if (heading?.[1] === '##') headings.push({ title: heading[2]!, line: i + 1 })
    if (/^\s*<\/?Set\b/.test(line) && !sets.has(i)) {
      const close = /^\s*<Set\b/.test(line) ? setEnd(visible, i) : -1
      if (close < 0) add(i + 1, 'set-block', 'Write <Set label="..."> on its own line after a blank line, then one <Asset ... /> per line, then </Set> followed by a blank line.')
      else {
        sets.add(i).add(close)
        if (!/\blabel="[^"]+"/.test(line)) add(i + 1, 'set-label', 'Add a non-empty label="..." attribute to the Set tag.')
      }
    }
    if (/^\s*<(?:Asset|Mockup)\b/.test(line)) {
      if (!/^\s*<(?:Asset|Mockup)\b[^<>]*\/>\s*$/.test(line) || (lines[i - 1]?.trim() && !BLOCK_LINE.test(lines[i - 1]!)) || (lines[i + 1]?.trim() && !BLOCK_LINE.test(lines[i + 1]!))) {
        add(i + 1, 'mockup-block', 'Put the self-closing <Asset ... /> tag on its own line, with blank lines separating it from prose.')
      }
      if (!/\bsrc="[^"]+"/.test(line) || !/\blabel="[^"]+"/.test(line)) add(i + 1, 'mockup-attributes', 'Add non-empty src="..." and label="..." attributes to the Asset tag.')
      const device = line.match(/\bdevice="([^"]*)"/)?.[1]
      if (device !== undefined && device !== 'mobile' && device !== 'desktop') add(i + 1, 'mockup-device', `device="${device}" is not a device. Use device="mobile" or device="desktop".`)
      const src = line.match(/\bsrc="([^"]*)"/)?.[1] ?? ''
      const variants = line.match(/\bvariants='([^']*)'/)?.[1]
      const why = variants === undefined ? null : variantsProblem(variants, src, id)
      if (why) add(i + 1, 'mockup-variants', why)
      else if (id !== undefined && src.startsWith('.assets/') && !inside(ASSETS, src.slice('.assets/'.length))) {
        add(i + 1, 'asset-src', `src="${src}" names no file. Write it as ${rel(ASSETS)}/${src.slice('.assets/'.length)}, or fix the path.`)
      }
    }
    if (/^\s*<Storyboard\b/.test(line) && (storyboardTag(line) === null || lines[i - 1]?.trim() || lines[i + 1]?.trim())) {
      add(i + 1, 'storyboard-block', 'Put one self-closing <Storyboard src=".assets/<card id>/storyboard.json" /> tag on its own line, with blank lines around it.')
    }
    if (/^\s*<Studio\b/.test(line) && (studioTag(line) === null || !/\blabel="[^"]+"/.test(line) || lines[i - 1]?.trim() || lines[i + 1]?.trim())) {
      add(i + 1, 'studio-block', 'Put one self-closing <Studio src=".assets/<card id>/studio.json" label="..." /> tag on its own line, with blank lines around it.')
    }
    if (/^\s*<Compare\b/.test(line)) {
      const attrs = compareAttrs(line)
      if (!attrs || lines[i - 1]?.trim() || lines[i + 1]?.trim()) add(i + 1, 'compare-block', 'Put one self-closing <Compare a="..." b="..." label="..." /> tag on its own line, with blank lines around it.')
      else if (!attrs.a || !attrs.b || !attrs.label) add(i + 1, 'compare-attributes', 'Add non-empty a="...", b="..." and label="..." attributes to the Compare tag.')
      else if (id !== undefined) {
        const why = compareProblem(attrs, id)
        if (why) add(i + 1, why.rule, why.message)
      }
    }
  }
  if (fence) add(fence.line, 'code-fence', `Unclosed code block. Close it with ${fence.char.repeat(fence.length)} on its own line.`)
  if (comment) add(lines.length, 'comment', 'Unclosed HTML comment. Add --> so the rest of the card remains visible.')
  const required = ['Worth noting', 'Scope', 'Todo', 'Decided by the agent']
  const human = ['Worth noting', 'Worth noting after implementation']
  const agent = ['Scope', 'Todo', 'Decided by the agent']
  const allowed = [...human, ...agent]
  const seen = new Set<string>()
  let lastOrder = -1
  for (const heading of headings) {
    const specialist = /^By `[a-z0-9]+(?:-[a-z0-9]+)*` (agent|skill)$/.test(heading.title)
    if (seen.has(heading.title)) add(heading.line, 'duplicate-section', `Duplicate ## ${heading.title}. Merge the content into one section.`)
    seen.add(heading.title)
    if (!allowed.includes(heading.title) && !specialist) add(heading.line, 'section-name', `Unknown ## ${heading.title}. Use ${allowed.map((s) => `## ${s}`).join(', ')}, or ## By \`<agent-name>\` agent. Use ### for a subheading.`)
    if (markers.length === 1) {
      const before = heading.line < markers[0]!
      if (((human.includes(heading.title) || specialist) && !before) || (agent.includes(heading.title) && before)) add(heading.line, 'section-half', `Move ## ${heading.title} ${human.includes(heading.title) || specialist ? 'above' : 'below'} <!-- agent -->.`)
      const rank = human.includes(heading.title) ? human.indexOf(heading.title) : specialist ? 2 : agent.includes(heading.title) ? 3 + agent.indexOf(heading.title) : -1
      if (rank >= 0 && rank < lastOrder) add(heading.line, 'section-order', `## ${heading.title} is out of order. Follow the section order in akb guide writing.`)
      lastOrder = Math.max(lastOrder, rank)
    }
  }
  for (const [index, done] of acceptance.entries()) {
    if (index) add(done.line, 'duplicate-section', 'Duplicate Done when. Keep one ### Done when under ## Scope.')
    const parent = headings.filter((h) => h.line < done.line).at(-1)
    if (done.level !== 3 || parent?.title !== 'Scope') add(done.line, 'acceptance-section', 'Move the acceptance list to ### Done when under ## Scope.')
  }
  for (const title of required) if (!seen.has(title)) add(end + 2, 'missing-section', `Missing ## ${title}. Restore that section; keep its title in English.`)
  if (markers.length !== 1) add(markers[1] ?? end + 2, 'boundary', `Found ${markers.length} <!-- agent --> boundaries; expected exactly one, between the human and agent sections.`)
  const todo = headings.find((h) => h.title === 'Todo')
  if (todo) {
    const next = headings.find((h) => h.line > todo.line)?.line ?? lines.length + 1
    if (!visible.slice(todo.line, next - 1).some((line) => /^\s*[-*+]\s*\[[ xX]?\]/.test(line))) add(todo.line, 'todos', '## Todo needs at least one checkbox step, for example - [ ] Implement the requested behavior.')
  }
  if (id !== undefined) errors.push(...validateStoryboards(file, id, text), ...validatePreviewFiles(file, id, text))
  return errors
}

const ASSET_LINE = /^\s*<(?:Asset|Mockup)\b[^<>]*\/>\s*$/
const BLOCK_LINE = /^\s*<(?:Asset\b|Mockup\b|Set\b|\/Set>)/

/** The line closing the `<Set>` opened at `at` (#587), or -1 when it holds anything but Asset and blank lines. */
function setEnd(lines: string[], at: number): number {
  if (!/^\s*<Set\b[^<>]*>\s*$/.test(lines[at]!) || lines[at - 1]?.trim()) return -1
  let i = at + 1
  let assets = 0
  for (; i < lines.length && (ASSET_LINE.test(lines[i]!) || !lines[i]!.trim()); i++) if (lines[i]!.trim()) assets++
  if (!assets || !/^\s*<\/Set>\s*$/.test(lines[i] ?? '') || lines[i + 1]?.trim()) return -1
  return i
}

/** A file inside `dir`, symlinks resolved — `null` when absent or when it leads out. */
function inside(dir: string, name: string): string | null {
  try {
    const root = fs.realpathSync(dir)
    const real = fs.realpathSync(path.join(dir, name))
    return real.startsWith(root + path.sep) && fs.statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

/** What is wrong with an Asset tag's `variants` (#1663), or null. With `id`, every file must be
 *  in that card's asset folder. */
function variantsProblem(raw: string, src: string, id?: number): string | null {
  const shape = `Write variants='{"<label>": ".assets/<card id>/<file>", ...}' with at least two versions.`
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return `variants is not valid JSON. ${shape}`
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return `variants is not a JSON object. ${shape}`
  const files = Object.values(parsed)
  if (files.length < 2 || !files.every((f) => typeof f === 'string' && f)) return `variants needs at least two labels, each naming a file. ${shape}`
  if (!files.includes(src)) return `src="${src}" is not one of the variants. Set src to the version shown first.`
  if (id === undefined) return null
  const dir = path.join(ASSETS, String(id))
  for (const f of files as string[]) {
    const parts = f.split('/')
    if (parts.length !== 3 || parts[0] !== '.assets' || parts[1] !== String(id) || !inside(dir, parts[2]!)) {
      return `Variant ${f} names no file in this card's asset folder .assets/${id}/. Write the file there or fix the path.`
    }
  }
  return null
}

/** What is wrong with a Compare tag's files (#1740), or null: `a` and `b` are any files in this
 *  card's asset folder but another compare (#526). `shots` is for video `a` beside a video or a
 *  storyboard of it (#1803), and required with the storyboard; it may itself be a storyboard. */
function compareProblem(attrs: Record<string, string>, id: number): { rule: string; message: string } | null {
  const dir = path.join(ASSETS, String(id))
  const src = (message: string) => ({ rule: 'compare-src', message })
  const shots = (message: string) => ({ rule: 'compare-shots', message })
  const json = (file: string): unknown => {
    try {
      return file.endsWith('.json') ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
    } catch {
      return null
    }
  }
  const files: Record<string, unknown> = {}
  for (const side of ['a', 'b'] as const) {
    const named = assetName(attrs[side]!, id, [])
    if (!('name' in named)) return src(`Compare ${side} is ${named.actual}; expected ${named.expected}.`)
    const file = inside(dir, named.name)
    if (!file) return src(`Compare ${side} ${attrs[side]} names no file in this card's asset folder. Write the file there or fix the path.`)
    const data = (files[side] = json(file)) as { a?: unknown; b?: unknown } | null
    if (typeof data?.a === 'string' && typeof data.b === 'string') return src(`Compare ${side} ${attrs[side]} is another compare. Compare its two files directly.`)
  }
  const video = compareKind(attrs.a!) === 'video'
  const board = files.b as { shots?: unknown } | null
  const script = video && Array.isArray(board?.shots)
  if (attrs.shots === undefined) return script ? shots('shots is required when b is a storyboard. Add shots="..." naming a storyboard or shots list of video a.') : null
  if (!video || !(script || compareKind(attrs.b!) === 'video')) return shots('shots is for a video beside another video or its storyboard. Remove it from this Compare tag.')
  const read = (at: string): { data: unknown } | { message: string } => {
    const named = assetName(at, id, ['json'])
    if (!('name' in named)) return { message: `Compare shots is ${named.actual}; expected ${named.expected}.` }
    const file = inside(dir, named.name)
    if (!file) return { message: `Compare shots ${at} names no file in this card's asset folder. Write the JSON there or fix the path.` }
    try {
      return { data: JSON.parse(fs.readFileSync(file, 'utf8')) }
    } catch {
      return { message: `${at} is not valid JSON.` }
    }
  }
  const list = read(attrs.shots)
  if ('message' in list) return shots(list.message)
  const why = Array.isArray(list.data) ? shotsProblem(list.data) : storyboardProblem(list.data)
  if (why) return shots(`${attrs.shots}: ${why}`)
  if (!script) return null
  const bad = storyboardProblem(board)
  if (bad) return src(`${attrs.b}: ${bad}`)
  const known = new Set((Array.isArray(list.data) ? list.data : (list.data as { shots: Shot[] }).shots).map((s: Shot) => s.id))
  const extra = (board as { shots: Shot[] }).shots.find((s) => !known.has(s.id))
  return extra ? shots(`${attrs.b} has shot ${extra.id}, which ${attrs.shots} lacks. Add ${extra.id} to ${attrs.shots}, or drop it from ${attrs.b}.`) : null
}

/** Every storyboard the card points at is a JSON file in its asset folder. Its contents are the
 *  owner agent's to check, with that agent's `scripts/validate-storyboard.mjs` (#992). */
export function validateStoryboards(file: string, id: number, text: string): ContractError[] {
  const errors: ContractError[] = []
  const dir = path.join(ASSETS, String(id))
  for (const [tag, tagOf, rule, fix] of [
    ['Storyboard', storyboardTag, 'storyboard-src', 'Write the JSON there or fix the path.'],
    ['Studio', studioTag, 'studio-src', 'Write it with `akb raw studio diagram <studio id> <card id>` or fix the path.'],
  ] as const) {
    for (const marker of storyboardMarkers(text, tagOf)) {
      const named = assetName(marker.src, id, ['json'])
      const add = (message: string) => errors.push({ file: rel(file), line: marker.line, rule, message })
      if (!('name' in named)) add(`${tag} src is ${named.actual}; expected ${named.expected}.`)
      else if (!inside(dir, named.name)) add(`${tag} src ${marker.src} names no file in this card's asset folder. ${fix}`)
    }
  }
  return errors
}

export function formatContractErrors(errors: readonly ContractError[]): string {
  return ['Spec format validation failed. Fix these errors without changing the planned behavior:', ...errors.map((e) => `${e.file}:${e.line} [${e.rule}] ${e.message}`)].join('\n')
}

/** What a run's end-of-run board check hands the agent to fix. */
export const boardCheckErrors = (errors: readonly ContractError[]): string =>
  ['Board check failed. Fix these errors without changing the planned behavior:', ...errors.map((e) => `${e.file}:${e.line} [${e.rule}] ${e.message}`)].join('\n')

/** The same errors as the task page shows them. */
export const boardProblems = (errors: readonly ContractError[]): string =>
  ['Board problems:', ...errors.map((e) => `- ${e.message}`)].join('\n')
