import { parsePreviewBlocks } from './shared/preview-blocks'
import { studioFor } from './agent/studios'
import fs from 'node:fs'
import path from 'node:path'

import { enclosingGroupRoot, idPrefix, isLegacyRecurring, walkMd } from './cards'
import { ARCHIVE, BOARD_STATE, KANBAN, rel, TODO } from './paths'
import { compareAttrs, compareKind, shotsProblem, storyboardProblem, type Shot } from './compare'
import { assetName, storyboardMarkers, storyboardTag, studioTag } from './storyboard'
import { validatePreviewFiles } from './preview-files'
import { isTaskAssetRef } from '../../../artifact-sdk/src/internal/task-assets'
import { resolveBoardAsset } from './machine/asset-path'
import { dependencyCycle } from './validate'
import { scanCardLines } from './shared/card-lines'
import { cardHeaderProblems, cardTodoProblems, type CardStudioContext } from './shared/card-structure'

export { scanCardLines }

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

/** Read raw files so malformed frontmatter cannot make a changed card disappear. */
export function snapshotSpecs(id?: number): SpecSnapshot {
  const out: SpecSnapshot = new Map()
  for (const dir of id === undefined ? [TODO] : [TODO, ARCHIVE]) {
    if (!fs.existsSync(dir)) continue
    for (const file of walkMd(dir)) {
      if (isLegacyRecurring(path.relative(dir, file))) continue
      const number = idPrefix(path.basename(file) === 'root.md' ? path.basename(path.dirname(file)) : path.basename(file))
      if (number !== null && (id === undefined || number === id)) out.set(file, { id: number, text: fs.readFileSync(file, 'utf8') })
    }
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
export async function validateSpec(file: string, text: string, id?: number, context?: CardStudioContext, warn?: (message: string) => void): Promise<ContractError[]> {
  const errors: ContractError[] = []
  const add = (line: number, rule: string, message: string) => errors.push({ file: rel(file), line, rule, message })
  const header = cardHeaderProblems(file, text, context, true)
  for (const p of header.problems) add(p.line, p.code, `${p.message}. ${p.hint}`)
  if (!header.meta) return errors
  const { lines, end, meta } = header
  const groups = enclosingGroups(file)
  for (const dep of meta.blocked_by) {
    const line = header.fields.get('blocked_by')?.line ?? 1
    if (groups.includes(dep)) {
      add(line, 'dependency-cycle', `blocked_by names #${dep}, a group this card is in; the group waits for this card, so neither can finish. Remove it with akb task update.`)
    } else if (id !== undefined && groups.length) {
      const cycle = dependencyCycle(id, dep)
      if (cycle) add(line, 'dependency-cycle', `blocked_by #${dep} makes a cycle: ${cycle.map((n) => `#${n}`).join(' → ')}. Set the remaining blockers with akb task update <id> --blocked-by <ids>.`)
    }
  }

  const preview = parsePreviewBlocks(text, file)
  for (const p of preview.problems) add(p.line, p.code, `${p.message}. ${p.hint}`)
  const studio = studioFor(context?.studio ?? meta.studio)
  const allowedPreviews = context?.previewIds ?? studio?.previews.map(p => p.id)
  const historical = context?.historicalPreviews ?? []
  const inPreview = (line: number) => preview.blocks.some(b => {
    const start = text.slice(0, b.start).split('\n').length
    const end = text.slice(0, b.end).split('\n').length
    return line > start && line < end
  })
  for (const p of preview.blocks) {
    if (allowedPreviews && !allowedPreviews.includes(p.id) && !historical.includes(p.id)) add(text.slice(0, p.start).split('\n').length, 'preview-id', `Unknown Preview ${p.id}. Use an ID from the task Studio.`)
    if (text.indexOf('<!-- agent -->') >= 0 && p.start > text.indexOf('<!-- agent -->')) add(text.slice(0, p.start).split('\n').length, 'section-half', 'Move Preview results above <!-- agent -->.')
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
    if (heading?.[1] === '##' && !inPreview(i + 1)) headings.push({ title: heading[2]!, line: i + 1 })
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
      const why = variants === undefined ? null : variantsProblem(variants, src, file, id)
      if (why) add(i + 1, 'mockup-variants', why)
      else if (id !== undefined && isTaskAssetRef(src) && !existingAsset(file, id, src)) {
        add(i + 1, 'asset-src', `src="${src}" must name a file within this task's asset folder. Fix the reference or add the file.`)
      }
    }
    if (/^\s*<Storyboard\b/.test(line) && (storyboardTag(line) === null || lines[i - 1]?.trim() || lines[i + 1]?.trim())) {
      add(i + 1, 'storyboard-block', 'Put one self-closing <Storyboard src="asset:storyboard.json" /> tag on its own line, with blank lines around it.')
    }
    if (/^\s*<Studio\b/.test(line) && (!studioTag(line) || lines[i - 1]?.trim() || lines[i + 1]?.trim())) {
      add(i + 1, 'studio-block', 'Put one self-closing <Studio src="asset:studio-review/review.json" /> tag on its own line, with blank lines around it.')
    }
    if (/^\s*<Compare\b/.test(line)) {
      const attrs = compareAttrs(line)
      if (!attrs || lines[i - 1]?.trim() || lines[i + 1]?.trim()) add(i + 1, 'compare-block', 'Put one self-closing <Compare a="..." b="..." label="..." /> tag on its own line, with blank lines around it.')
      else if (!attrs.a || !attrs.b || !attrs.label) add(i + 1, 'compare-attributes', 'Add non-empty a="...", b="..." and label="..." attributes to the Compare tag.')
      else if (id !== undefined) {
        const why = compareProblem(attrs, file, id)
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
    const specialist = false
    if (seen.has(heading.title)) add(heading.line, 'duplicate-section', `Duplicate ## ${heading.title}. Merge the content into one section.`)
    seen.add(heading.title)
    if (!allowed.includes(heading.title) && !specialist) add(heading.line, 'section-name', `Unknown ## ${heading.title}. Use ${allowed.map((s) => `## ${s}`).join(', ')}. Use Preview blocks for task outputs and ### for a subheading.`)
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
  for (const problem of cardTodoProblems(file, visible, inPreview)) add(problem.line, problem.code, `${problem.message}. ${problem.hint}`)
  if (id !== undefined) {
    errors.push(...validateStoryboards(file, id, text))
    const attachments = await validatePreviewFiles(file, id, text, warn)
    errors.push(...attachments.filter(problem => problem.rule !== 'asset-reference'
      || !errors.some(error => error.file === problem.file && error.line === problem.line)))
  }
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

function existingAsset(card: string, id: number, source: string): string | null {
  try {
    const file = resolveBoardAsset(KANBAN, BOARD_STATE, id, source, card)
    return file && fs.statSync(file, { throwIfNoEntry: false })?.isFile() ? file : null
  } catch { return null }
}

function variantsProblem(raw: string, src: string, card: string, id?: number): string | null {
  const shape = `Write variants='{"<label>": "asset:<path>", ...}' with at least two versions.`
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
  for (const file of files as string[]) {
    if (!isTaskAssetRef(file) || !existingAsset(card, id, file)) {
      return `Variant ${file} must name a file within this task's asset folder. Fix the reference or add the file.`
    }
  }
  return null
}

/** What is wrong with a Compare tag's files (#1740), or null: `a` and `b` are any files in this
 *  card's asset folder but another compare (#526). `shots` is for video `a` beside a video or a
 *  storyboard of it (#1803), and required with the storyboard; it may itself be a storyboard. */
function compareProblem(attrs: Record<string, string>, card: string, id: number): { rule: string; message: string } | null {
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
    const file = existingAsset(card, id, attrs[side]!)
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
    const file = existingAsset(card, id, at)
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
  for (const [tag, tagOf, rule, fix] of [
    ['Storyboard', storyboardTag, 'storyboard-src', 'Write the JSON there or fix the path.'],
    ['Studio', studioTag, 'studio-src', 'Fix the path or freeze the draft with `akb studio preview <card> --folder <draft> --base <baseline>` and use the returned Studio tag.'],
  ] as const) {
    for (const marker of storyboardMarkers(text, tagOf)) {
      const named = assetName(marker.src, id, ['json'])
      const add = (message: string) => errors.push({ file: rel(file), line: marker.line, rule, message })
      if (!('name' in named)) add(`${tag} src is ${named.actual}; expected ${named.expected}.`)
      else if (!existingAsset(file, id, marker.src)) add(`${tag} src ${marker.src} names no file in this card's asset folder. ${fix}`)
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
