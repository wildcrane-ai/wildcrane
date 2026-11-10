// `akb task`, `workspace`, `project`, `runner` (#550): the signed-in account's WildCrane tasks, read
// and changed in Cloud from any chat. Nothing here reads or writes a board.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { cloudEndpoints } from '../lib/cloud/config'
import { accessToken } from '../lib/cloud/session'
import { cloudWorkflow, linkedProject } from '../lib/cloud/tasks'
import { say } from '../lib/io'
import { die } from '../lib/paths'
import { parseFrontmatter } from '../lib/frontmatter'
import { readQuestionOps } from '../lib/questions'
import { applyQuestionOps, questionPositions, QuestionOpError } from '../lib/question-ops'
import type { Typed } from '../lib/cli/shared'
import type { MoveResult } from '../lib/types'
import { SAID } from './cloud'

const refuse = (message: string, code: string): never => die(message, { kind: code, code })

/** One Cloud call as the signed-in account; every refusal ends the command with Cloud's words. */
export async function cloud<T>(method: string, route: string, body?: unknown): Promise<T> {
  process.env.AI4KANBAN_HOME ??= process.env.WILDCRANE_HOME || path.join(os.homedir(), '.wildcrane')
  const token = await accessToken()
  if (!token.ok) return refuse(SAID[token.reason].en, token.reason.replace('-', '_'))
  let response: Response
  try {
    response = await fetch(`${cloudEndpoints().api}${route}`, {
      method,
      headers: { authorization: `Bearer ${token.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    refuse(SAID.unreachable.en, 'unreachable')
  }
  const value = (await response!.json().catch(() => ({}))) as T & { error?: { code?: string; message?: string } }
  if (response!.status === 401) refuse(SAID.expired.en, 'expired')
  if (!response!.ok) refuse(value.error?.message ?? `Cloud answered ${response!.status}.`, value.error?.code ?? 'refused')
  return value
}

const enc = encodeURIComponent
const WEB = () => process.env.WILDCRANE_WEB_URL || 'https://app.wildcrane.ai'
const taskUrl = (key: string) => `${WEB()}/tasks/${enc(key)}`

interface Page<T> { data: T[]; next: string | null }
interface Project { id: string; workspace: string; name: string; prefix: string }
interface Workspace { id: string; name: string }
interface Task {
  id: string
  key: string
  title: string
  status: string
  workflow: { id: string; name: string } | null
  review?: { status: string | null; revision: number } | null
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

/** The project `.akb/base.json` links the nearest folder at or above this one to; null when none. */
function linked(): string | null {
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.akb', 'base.json'))) {
      const link = linkedProject('', dir)
      return link.ok ? link.value : null
    }
    if (path.dirname(dir) === dir) return null
  }
}

const projectLine = (p: Project) => `${p.id}  ${p.prefix}  ${p.name}`

async function project(asked?: string): Promise<string> {
  const id = asked ?? linked()
  if (id) return id
  const rows = await all<Project>('/v1/projects')
  return refuse(`Pick a project with --project: ${rows.map(projectLine).join(', ') || 'none yet'}`, 'no_project')
}

async function workspace(asked?: string): Promise<string> {
  if (asked) return asked
  const prj = linked()
  if (prj) return (await cloud<Project>('GET', `/v1/projects/${enc(prj)}`)).workspace
  const rows = await all<Workspace>('/v1/workspaces')
  return refuse(`Pick a workspace with --workspace: ${rows.map((w) => `${w.id}  ${w.name}`).join(', ')}`, 'no_project')
}

/** `WC-12` and `task_…` as given; a bare `12` in the linked project's numbering. */
async function taskRef(asked: string): Promise<string> {
  if (!/^\d+$/.test(asked.trim())) return asked.trim()
  const prj = linked()
  if (!prj) refuse('Write the full task key, like WC-12, or run this in a linked folder.', 'no_project')
  return `${(await cloud<Project>('GET', `/v1/projects/${enc(prj!)}`)).prefix}-${asked.trim()}`
}

export async function taskList(opts: { project?: string; workspace?: string; status?: string }): Promise<MoveResult> {
  const scope = opts.project || !opts.workspace ? `project=${enc(await project(opts.project))}` : `workspace=${enc(opts.workspace)}`
  const page = await cloud<Page<Task>>('GET', `/v1/tasks?${scope}&limit=100${opts.status ? `&status=${enc(opts.status)}` : ''}`)
  for (const t of page.data) say(`${t.key}  ${t.status}  ${t.title}`)
  return { ...page }
}

export async function taskShow(id: string): Promise<MoveResult> {
  const task = await cloud<Task>('GET', `/v1/tasks/${enc(await taskRef(id))}`)
  const card = task.workflow ? await cloud<{ body: string }>('GET', `/v1/tasks/${enc(task.id)}/card`).catch(() => null) : null
  say(`${task.key}  ${task.title}`)
  say(`${task.status}${task.workflow ? `  ${task.workflow.name}` : ''}  ${taskUrl(task.key)}`)
  if (card?.body) say(`\n${card.body.trim()}`)
  return { ...task, card }
}

export async function taskCreate(request: string, opts: { project?: string; workflow?: string }): Promise<MoveResult> {
  const text = request.trim()
  if (!text) die('Say what the task is.', { kind: 'bad-args', exitCode: 2 })
  const line = text.split('\n')[0]!.trim()
  const title = line.length > 80 ? `${line.slice(0, 79)}…` : line
  const task = await cloud<Task>('POST', '/v1/tasks', {
    title,
    request: text,
    project: await project(opts.project),
    ...(opts.workflow ? { workflow: cloudWorkflow(opts.workflow) } : {}),
    source: 'api',
  })
  say(`Created ${task.key}: ${task.title}  ${taskUrl(task.key)}`)
  return { ...task }
}

/** The step names a task; each says what it did in one line. */
async function act(id: string, route: string, body: unknown, done: (key: string) => string): Promise<MoveResult> {
  const ref = await taskRef(id)
  const value = await cloud<Record<string, unknown>>('POST', `/v1/tasks/${enc(ref)}/${route}`, body)
  say(done(ref))
  return value
}

export async function taskApprove(id: string, comment?: string): Promise<MoveResult> {
  const task = await cloud<Task>('GET', `/v1/tasks/${enc(await taskRef(id))}`)
  return act(task.key, 'decisions', {
    decision: 'approve',
    ...(comment?.trim() ? { comment: comment.trim() } : {}),
    ...(task.review ? { review_revision: task.review.revision } : {}),
  }, (k) => `Approved ${k}.`)
}

/** `raw update-questions` on a Cloud task's card (#620), checked here first against the card read. */
export async function taskUpdateQuestions(id: string, typed: Typed[]): Promise<MoveResult> {
  const ops = readQuestionOps(typed)
  const ref = await taskRef(id)
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

export const taskChat = (id: string, message: string) => act(id, 'chat', { body: message }, (k) => `Sent to ${k}.`)
export const taskRemove = (id: string, reason: string) =>
  act(id, 'cancel', reason.trim() ? { reason: reason.trim() } : undefined, (k) => `Removed ${k}. Restore it on the web.`)
export const taskResume = (id: string) => act(id, 'resume', undefined, (k) => `Resumed ${k}.`)
export const taskStop = (id: string) => act(id, 'stop', undefined, (k) => `Stopped ${k}.`)
export const taskComment = (id: string, text: string) => act(id, 'comments', { body: text }, (k) => `Commented on ${k}.`)

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

export async function runnerList(opts: { workspace?: string }): Promise<MoveResult> {
  const held = await cloud<{ runners: { name: string; connected: boolean }[] }>('GET', `/v1/workspaces/${enc(await workspace(opts.workspace))}/runners`)
  for (const r of held.runners) say(`${r.name}  ${r.connected ? 'online' : 'offline'}`)
  return held
}
