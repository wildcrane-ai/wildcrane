import fs from 'node:fs'
import path from 'node:path'
import { effectivePreviewCatalog, previewDefinitionsSchema, type PreviewDefinition } from '../lib/shared/preview-definitions'
import { parseReviewFlow, parseReviewPlan, readReviewPlan, reviewPlanFromOptions, validateReviewPreviews, type ReviewPlan } from '../lib/shared/review-plan'

import { type Goal } from '../lib/shared/goal'
import { goalDraftPath, readGoalDraft, writeGoalDraft } from '../lib/goal-draft'
import { confirmRunnerBinding } from '../lib/cloud/runner-binding'
import { say } from '../lib/io'
import { die } from '../lib/paths'
import { noStudioMessage } from '../lib/agent/studios'
import type { MoveResult } from '../lib/types'

export interface GoalOptions {
  id?: string
  title?: string
  bodyFile?: string
  studio?: string
  review?: string
  previews?: string
  reviewFile?: string
  previewDefinitionsFile?: string
}

export interface GoalStudio {
  previews?: import("../lib/agent/studio-def").StudioPreview[]
  id: string
  name: string
  description?: string
  when?: string
}

export interface GoalsFile {
  workspace?: string
  studios: GoalStudio[]
  goals: Goal[]
}

const MAX_GOALS = 10

export { goalDraftPath as goalsFile }
export type { Goal }

function loadGoals() {
  const file = goalDraftPath()
  if (!file) die('Goals exist only inside a WildCrane goal discussion.')
  const value = readGoalDraft<GoalsFile>(file)
  const held = { ...value, studios: value.studios ?? [] }
  return { held, write: () => writeGoalDraft(file, held) }
}

/** A built-in's short name, as `akb studio list` shows it: `wf_builtin_slide_deck` → `slide-deck`. */
export const shortStudioId = (id: string) =>
  id.startsWith('wf_builtin_') ? id.slice('wf_builtin_'.length).replace(/_/g, '-') : id

export function studioOf(held: GoalsFile, asked: string): string {
  const wanted = asked.trim()
  const found = held.studios.find((w) => w.id === wanted || shortStudioId(w.id) === wanted)
  if (!found) die(`No studio \`${wanted}\` here. It has: ${held.studios.map((w) => shortStudioId(w.id)).join(', ')}.`)
  return found.id
}

function fallbackStudio(held: GoalsFile): string {
  const first = held.studios[0]?.id
  if (!first) die(noStudioMessage(''))
  return first!
}

/** The body split as Cloud keeps it: `## Done when` items are the acceptance, the rest the outcome. */
export function splitBody(text: string): { outcome: string; acceptance: string[] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const at = lines.findIndex((l) => /^##\s+done when\s*$/i.test(l.trim()))
  if (at < 0) return { outcome: text.trim(), acceptance: [] }
  const rest = lines.slice(at + 1)
  const end = rest.findIndex((l) => /^#{1,2}\s/.test(l))
  const section = end < 0 ? rest : rest.slice(0, end)
  const acceptance = section.map((l) => l.trim().replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '').trim()).filter(Boolean)
  const outcome = [...lines.slice(0, at), ...(end < 0 ? [] : rest.slice(end))].join('\n').trim()
  return { outcome, acceptance }
}

function readBody(bodyFile: string | undefined): { outcome: string; acceptance: string[] } {
  if (!bodyFile) die('--body-file is required; write the goal in a writable temporary file first.')
  const text = fs.readFileSync(bodyFile, 'utf8')
  if (!text.trim()) die('The goal must not be empty.')
  return splitBody(text)
}

const open = (goal: Goal) => !goal.dropped && !goal.task

function named(held: GoalsFile, id: string | undefined): Goal {
  const goal = held.goals.find((i) => i.id === id?.trim() && !i.dropped)
  if (!goal) die(`--id must name a goal of this conversation: ${held.goals.filter((i) => !i.dropped).map((i) => i.id).join(', ') || 'none yet'}.`)
  return goal
}

export async function cmdGoal(args: string[], opts: GoalOptions, cwd = process.cwd()): Promise<MoveResult> {
  if (!goalDraftPath()) die('Goals exist only inside a WildCrane goal discussion.')
  const board = process.env.AI4KANBAN_BOARD?.trim()
  const check = board ? await confirmRunnerBinding(path.resolve(cwd, board)) : undefined
  const { held, write } = loadGoals()
  const result = editGoal(args, opts, held)
  check?.()
  write()
  if ('dropped' in result) say(`Dropped goal ${result.id}.`)
  else if ('start' in result) say(`Goal ${result.id} starts as a task when this turn ends.`)
  else say(`Goal ${result.id} will be saved when this turn ends: ${result.title} (${shortStudioId(result.studio)}).`)
  return result
}

export function editGoal(args: string[], opts: GoalOptions, held: GoalsFile) {
  const sub = args[0] ?? ''
  if (sub === 'new') {
    const title = opts.title?.trim()
    if (!title) die('--title must not be empty')
    if (held.goals.filter(open).length >= MAX_GOALS) die(`A conversation holds at most ${MAX_GOALS} goals; drop one first.`)
    const body = readBody(opts.bodyFile)
    const studio = opts.studio ? studioOf(held, opts.studio) : fallbackStudio(held)
    const id = `new_${held.goals.filter((i) => i.id.startsWith('new_')).length + 1}`
    const preview_definitions = goalDefinitions(opts)
    const review_plan = goalReview(held, studio, opts, null, preview_definitions)
    held.goals.push({ id, title, ...body, studio, review_plan, ...(opts.previewDefinitionsFile !== undefined ? { preview_definitions } : {}), task: null })
    return { id, title, studio, review_plan, preview_definitions }
  }

  const goal = named(held, opts.id)
  if (goal.task) die(`${goal.id} is already a task; it no longer changes here.`)
  if (sub === 'save') {
    const studio = opts.studio !== undefined ? studioOf(held, opts.studio) : goal.studio
    const preview_definitions = goalDefinitions(opts, goal.preview_definitions)
    const review_plan = goalReview(held, studio, opts, goal.review_plan ?? null, preview_definitions)
    if (opts.title !== undefined) {
      if (!opts.title.trim()) die('--title must not be empty')
      goal.title = opts.title.trim()
    }
    if (opts.bodyFile !== undefined) Object.assign(goal, readBody(opts.bodyFile))
    Object.assign(goal, { studio, review_plan })
    if (opts.previewDefinitionsFile !== undefined) goal.preview_definitions = preview_definitions
    return { id: goal.id, title: goal.title, studio: goal.studio, review_plan, preview_definitions }
  }
  if (sub === 'drop') {
    goal.dropped = true
    return { id: goal.id, dropped: true }
  }
  if (sub === 'start') {
    goal.start = true
    return { id: goal.id, start: true }
  }
  die('Use goal new, save, drop or start.')
}

/** `akb studio list` inside a goal discussion: the workspace's installed studios. */
export function cmdGoalStudios(held = loadGoals().held): MoveResult {
  for (const w of held.studios) {
    say(`${shortStudioId(w.id)}  ${w.name}`)
    if (w.description && w.description !== w.name) say(`  ${w.description}`)
    if (w.when) say(`  when        ${w.when}`)
  }
  return { studios: held.studios.map((w) => ({ ...w, id: shortStudioId(w.id) })) }
}


function goalDefinitions(opts: GoalOptions, previous: PreviewDefinition[] = []) {
  return opts.previewDefinitionsFile === undefined ? previous
    : previewDefinitionsSchema.parse(JSON.parse(fs.readFileSync(opts.previewDefinitionsFile, 'utf8')))
}

function goalCatalog(held: GoalsFile, studio: string, definitions: PreviewDefinition[]) {
  const builtIn = held.studios.find(w => w.id === studio)?.previews
  if (!builtIn && definitions.length) die('Preview outputs are unavailable; update Runner and try again.')
  return builtIn && effectivePreviewCatalog(builtIn, definitions)
}

function goalReview(held: GoalsFile, studio: string, opts: GoalOptions, previous: ReviewPlan, definitions: PreviewDefinition[]): ReviewPlan {
  const catalog = goalCatalog(held, studio, definitions)
  if (opts.reviewFile !== undefined && (opts.review !== undefined || opts.previews !== undefined)) die('Use --review-file or --review and --previews.')
  const flat = reviewPlanFromOptions(opts, previous)
  if (flat) return validateReviewPreviews(flat, catalog)
  if (opts.review !== undefined) {
    return parseReviewFlow(opts.review, catalog)
  }
  const value = opts.reviewFile === undefined ? readReviewPlan(previous) : JSON.parse(fs.readFileSync(opts.reviewFile, 'utf8'))
  const saved = opts.reviewFile === undefined && opts.previewDefinitionsFile === undefined && opts.studio === undefined
  return validateReviewPreviews(parseReviewPlan(value), catalog, { saved })
}

export function cmdGoalPreviews(studio: string, held = loadGoals().held): MoveResult {
  const id = studioOf(held, studio)
  const catalog = held.studios.find((w) => w.id === id)?.previews
  if (!catalog) die('Preview outputs are unavailable; update Runner and try again.')
  const previews = catalog
  say(previews.map(p => `${p.id}\n  ${p.instructions}`).join('\n'))
  return { previews, problems: [] }
}
