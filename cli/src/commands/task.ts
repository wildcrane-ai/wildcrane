import { insideRun } from '../lib/agent/env'
import { REPLY_APPROVAL_ENV } from '../lib/cloud/reply-approval'
import { parseReviewPlan, type TaskReview } from '../lib/shared/review-plan'
// `akb task`, `workspace`, `project`, `runner` (#550): the signed-in account's WildCrane tasks, read
// and changed in Cloud from any chat. Nothing here reads or writes a board.

import { approveAfterReply } from '../lib/cloud/reply-approval'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { cloudEndpoints } from '../lib/cloud/config'
import { accessToken } from '../lib/cloud/session'
import { cloudStudio, linkedProject } from '../lib/cloud/tasks'
import { say } from '../lib/io'
import { die, projectRootOf } from '../lib/paths'
import { parseFrontmatter } from '../lib/frontmatter'
import { readQuestionOps } from '../lib/questions'
import { applyQuestionOps, questionPositions, QuestionOpError } from '../lib/question-ops'
import type { Typed } from '../lib/cli/shared'
import type { MoveResult } from '../lib/types'
import { SAID } from './cloud'

const refuse = (message: string, code: string): never => die(message, { kind: code, code })

/** One Cloud call as the signed-in account; every refusal ends the command with Cloud's words. */
export async function cloud<T>(method: string, route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  process.env.AI4KANBAN_HOME ??= process.env.WILDCRANE_HOME || path.join(os.homedir(), '.wildcrane')
  const token = await accessToken()
  if (!token.ok) return refuse(SAID[token.reason].en, token.reason.replace('-', '_'))
  let response: Response
  const request = new AbortController()
  const abort = () => request.abort()
  if (signal?.aborted) request.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 30_000)
  try {
    try {
      response = await fetch(`${cloudEndpoints().api}${route}`, {
        method,
        headers: { authorization: `Bearer ${token.token}`, ...(process.env.AI4KANBAN_EXECUTION ? { 'x-wildcrane-execution': process.env.AI4KANBAN_EXECUTION } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: request.signal,
      })
    } catch {
      refuse(SAID.unreachable.en, 'unreachable')
    }
    const value = (await response!.json().catch(() => ({}))) as T & { error?: { code?: string; message?: string } }
    if (response!.status === 401) refuse(SAID.expired.en, 'expired')
    if (!response!.ok) refuse(value.error?.message ?? `Cloud answered ${response!.status}.`, value.error?.code ?? 'refused')
    return value
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

const enc = encodeURIComponent
const WEB = () => process.env.WILDCRANE_WEB_URL || 'https://app.wildcrane.ai'
export const taskUrl = (key: string) => `${WEB()}/tasks/${enc(key)}`

interface Page<T> { data: T[]; next: string | null }
interface Project { id: string; workspace: string; name: string; prefix: string }
interface Workspace { id: string; name: string }
interface Task {
  id: string
  key: string
  title: string
  status: string
  studio: { id: string; name: string } | null
  failure?: string | null
  review?: TaskReview | null
}

async function all<T>(route: string): Promise<T[]> {
  const rows: T[] = []
  let after: string | null = null
  do {
    const page: Page<T> = await cloud('GET', `${route}${route.includes('?') ? '&' : '?'}limit=100${after ? `&after=${enc(after)}` : ''}`)
    rows.push(...page.data)
    after = page.next
  } while (after)
  return rows
}

export interface TaskLocation { board?: string | null; dir?: string | null; cwd?: string }

/** Read the selected board's project, or walk upward from the selected directory. */
function linked(location: TaskLocation): string | null {
  const cwd = location.cwd ?? process.cwd()
  const board = location.board ?? (process.env.AI4KANBAN_BOARD?.trim() || null)
  if (board) {
    const link = linkedProject('', projectRootOf(path.resolve(cwd, board)))
    return link.ok ? link.value : null
  }
  for (let dir = path.resolve(cwd, location.dir ?? '.'); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.akb', 'base.json'))) {
      const link = linkedProject('', dir)
      return link.ok ? link.value : null
    }
    if (path.dirname(dir) === dir) return null
  }
}

const projectLine = (p: Project) => `${p.id}  ${p.prefix}  ${p.name}`

async function project(asked: string | undefined, location: TaskLocation): Promise<string> {
  const id = asked ?? linked(location)
  if (id) return id
  const rows = await all<Project>('/v1/projects')
  return refuse(`Pick a project with --project: ${rows.map(projectLine).join(', ') || 'none yet'}`, 'no_project')
}

async function workspace(asked: string | undefined, location: TaskLocation): Promise<string> {
  if (asked) return asked
  const prj = linked(location)
  if (prj) return (await cloud<Project>('GET', `/v1/projects/${enc(prj)}`)).workspace
  const rows = await all<Workspace>('/v1/workspaces')
  return refuse(`Pick a workspace with --workspace: ${rows.map((w) => `${w.id}  ${w.name}`).join(', ')}`, 'no_project')
}

/** `WC-12` and `task_…` as given; a bare `12` in the linked project's numbering. */
export async function taskRef(asked: string, location: TaskLocation = {}): Promise<string> {
  if (!/^\d+$/.test(asked.trim())) return asked.trim()
  const prj = linked(location)
  if (!prj) refuse('Write the full task key, like WC-12, or run this in a linked folder.', 'no_project')
  return `${(await cloud<Project>('GET', `/v1/projects/${enc(prj!)}`)).prefix}-${asked.trim()}`
}

export async function taskList(opts: { project?: string; workspace?: string; status?: string }, location: TaskLocation = {}): Promise<MoveResult> {
  const scope = opts.project || !opts.workspace ? `project=${enc(await project(opts.project, location))}` : `workspace=${enc(opts.workspace)}`
  const data = await all<Task>(`/v1/tasks?${scope}${opts.status ? `&status=${enc(opts.status)}` : ''}`)
  for (const t of data) say(`${t.key}  ${t.status}  ${t.title}`)
  return { data, next: null }
}

export async function taskShow(id: string, location: TaskLocation = {}): Promise<MoveResult> {
  const task = await cloud<Task>('GET', `/v1/tasks/${enc(await taskRef(id, location))}`)
  const card = task.studio ? await cloud<{ body: string }>('GET', `/v1/tasks/${enc(task.id)}/card`).catch(() => null) : null
  say(`${task.key}  ${task.title}`)
  say(`${task.status}${task.studio ? `  ${task.studio.name}` : ''}  ${taskUrl(task.key)}`)
  if (card?.body) say(`\n${card.body.trim()}`)
  return { ...task, card }
}

export async function taskCreate(request: string, opts: { project?: string; studio?: string }, location: TaskLocation = {}): Promise<MoveResult> {
  const text = request.trim()
  if (!text) die('Say what the task is.', { kind: 'bad-args', exitCode: 2 })
  const line = text.split('\n')[0]!.trim()
  const title = line.length > 80 ? `${line.slice(0, 79)}…` : line
  const target = await project(opts.project, location)
  if (!opts.studio?.trim()) return refuse('Choose --studio from akb studio list.', 'no_studio')
  const task = await cloud<Task>('POST', '/v1/tasks', {
    title,
    request: text,
    project: target,
    studio: cloudStudio(opts.studio),
    source: 'api',
    run: true,
  })
  say(`Created ${task.key}: ${task.title}  ${taskUrl(task.key)}`)
  say(`Status: ${task.status}${task.failure ? ` — ${task.failure}` : ''}`)
  return { ...task }
}

/** The step names a task; each says what it did in one line. */
async function act(id: string, route: string, body: unknown, done: (key: string) => string, location: TaskLocation = {}): Promise<MoveResult> {
  const ref = await taskRef(id, location)
  const value = await cloud<Record<string, unknown>>('POST', `/v1/tasks/${enc(ref)}/${route}`, body)
  say(done(ref))
  return value
}

export interface ReviewOptions { stage?: string; revision?: string; file?: string; status?: string; reviseFrom?: string }

function reviewRevision(value?: string): number {
  if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) die('--revision must name the version you read.')
  return Number(value)
}

export async function taskReview(id: string, opts: ReviewOptions = {}, location: TaskLocation = {}): Promise<MoveResult> {
  const ref = await taskRef(id, location)
  const count = [opts.file, opts.status, opts.reviseFrom].filter(v => v !== undefined).length
  if (count > 1 || opts.stage && !opts.status) die('Use one of --file, --stage with --status, or --revise-from.')
  let task: Task
  if (!count) task = await cloud<Task>('GET', `/v1/tasks/${enc(ref)}`)
  else {
    const review_revision = reviewRevision(opts.revision)
    let fields: Record<string, unknown>
    if (opts.file) fields = { operation: 'plan', review_plan: parseReviewPlan(JSON.parse(fs.readFileSync(opts.file, 'utf8'))) }
    else if (opts.reviseFrom) fields = { operation: 'revise', stage: opts.reviseFrom }
    else {
      if (!opts.stage || !['running', 'done'].includes(opts.status!)) die('--stage and --status running|done are required.')
      fields = { operation: 'status', stage: opts.stage, status: opts.status }
    }
    task = await cloud<Task>('POST', `/v1/tasks/${enc(ref)}/review`, { ...fields, review_revision })
  }
  say(JSON.stringify(task.review, null, 2))
  return { review: task.review }
}

export async function taskApprove(id: string, comment?: string, opts: ReviewOptions = {}, location: TaskLocation = {}): Promise<MoveResult> {
  const review_revision = reviewRevision(opts.revision)
  if (insideRun() && !process.env[REPLY_APPROVAL_ENV]) return refuse('Only the user approves a review.', 'review_refused')
  const ref = process.env[REPLY_APPROVAL_ENV] && !linked(location) ? id.trim() : await taskRef(id, location)
  const deferred = await approveAfterReply(ref, comment, { stage: opts.stage, review_revision })
  if (deferred) return deferred
  return act(ref, 'decisions', { decision: 'approve', review_revision, ...(opts.stage ? { stage: opts.stage } : {}),
    ...(comment?.trim() ? { comment: comment.trim() } : {}) }, k => `Approved ${k}.`, location)
}

/** `raw update-questions` on a Cloud task's card (#620), checked here first against the card read. */
export async function taskUpdateQuestions(id: string, typed: Typed[], location: TaskLocation = {}): Promise<MoveResult> {
  const ops = readQuestionOps(typed)
  const ref = await taskRef(id, location)
  const card = await cloud<{ version: number; body: string }>('GET', `/v1/tasks/${enc(ref)}/card`)
  const questions = parseFrontmatter(card.body).meta?.questions ?? []
  let changes: string[]
  let open: number
  try {
    const done = applyQuestionOps(questions, ops)
    changes = done.changes
    open = done.questions.length
  } catch (e) {
    if (e instanceof QuestionOpError) die(`${ref}: ${e.message}`)
    throw e
  }
  const body = ops.map((op) => {
    const q = op.question && { text: op.question.text, options: op.question.options, recommend: op.question.recommend, mode: op.question.mode, agent: op.question.agent }
    if (op.kind === 'append') return { append: q }
    if (op.kind === 'update') return { update: op.n, question: q }
    if (op.kind === 'drop') return { drop: questionPositions(op.ns, Infinity, 'drop') }
    if (op.kind === 'clear') return { clear: true }
    return die(`akb task update-questions has no --${op.kind}; --drop removes a question`)
  })
  const task = await cloud<Task>('PATCH', `/v1/tasks/${enc(ref)}/questions`, { base_version: card.version, ops: body })
  say(`updated ${task.key} questions: ${changes.join(', ')} (${open} open)`)
  return { ...task, changes, open }
}

export const taskChat = (id: string, message: string, location: TaskLocation = {}) => act(id, 'chat', { body: message }, (k) => `Sent to ${k}.`, location)
export const taskRemove = (id: string, reason: string, location: TaskLocation = {}) =>
  act(id, 'cancel', reason.trim() ? { reason: reason.trim() } : undefined, (k) => `Removed ${k}. Restore it with akb task restore ${k}.`, location)
export async function taskRestore(id: string, location: TaskLocation = {}): Promise<MoveResult> {
  const task = await cloud<Task>('POST', `/v1/tasks/${enc(await taskRef(id, location))}/restore`)
  say(`Restored ${task.key}. Status: ${task.status}.`)
  return { ...task }
}
export const taskResume = (id: string, location: TaskLocation = {}) => act(id, 'resume', undefined, (k) => `Resumed ${k}.`, location)
export const taskStop = (id: string, location: TaskLocation = {}) => act(id, 'stop', undefined, (k) => `Stopped ${k}.`, location)
export const taskComment = (id: string, text: string, location: TaskLocation = {}) => act(id, 'comments', { body: text }, (k) => `Commented on ${k}.`, location)

export async function workspaceList(): Promise<MoveResult> {
  const data = await all<Workspace>('/v1/workspaces')
  for (const w of data) say(`${w.id}  ${w.name}`)
  return { data }
}

export async function projectList(opts: { workspace?: string }): Promise<MoveResult> {
  const data = await all<Project>(`/v1/projects${opts.workspace ? `?workspace=${enc(opts.workspace)}` : ''}`)
  for (const p of data) say(projectLine(p))
  return { data }
}

export async function runnerList(opts: { workspace?: string }, location: TaskLocation = {}): Promise<MoveResult> {
  const held = await cloud<{ runners: { name: string; connected: boolean }[] }>('GET', `/v1/workspaces/${enc(await workspace(opts.workspace, location))}/runners`)
  for (const r of held.runners) say(`${r.name}  ${r.connected ? 'online' : 'offline'}`)
  return held
}
