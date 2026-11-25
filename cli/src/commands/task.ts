import { insideRun, SAVED_PREVIEW_FILE_ENV } from '../lib/agent/env'
import { activeDelivery, endedDelivery } from '../lib/agent/deliveries'
import { taskChatFile } from '../lib/agent/task-chats'
import { REPLY_APPROVAL_ENV } from '../lib/cloud/reply-approval'
import { previewDefinitionsSchema } from '../lib/shared/preview-definitions'
import { parseReviewPlan, reviewAuthorization, type SavedPreviewInputs, type TaskReview } from '../lib/shared/review-plan'
// `akb task`, `workspace`, `project`, `runner` (#550): the signed-in account's WildCrane tasks, read
// and changed from any chat.

import { approveAfterReply } from '../lib/cloud/reply-approval'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { cloudEndpoints } from '../lib/cloud/config'
import { accessToken, CLOUD_ACCESS_HINTS } from '../lib/cloud/session'
import { cloudStudio, linkedProject, numberOf, runnerProject, workspaceTask } from '../lib/cloud/tasks'
import { executionOf } from '../lib/cloud/execution'
import { BOARD_LINK_HINT, resolveBoard, useBoard } from '../lib/board-cli'
import { locate, locateArchived } from '../lib/cards'
import { peekRun } from '../lib/agent/sessions'
import { withCreationLock } from '../lib/agent/creation-lock'
import { withBoardLock } from '../lib/lock'
import { readRemoval, writeRemoval, type TaskOperationResult } from '../lib/cloud/task-operation'
import { assetsFile, legacyStudioRuleFile, projectConfigFile, studioConfigFile, studioName } from '../lib/shared/board-files'
import { withSyncLock } from '../lib/shared/board-conflicts'
import { cmdRemove } from './remove'
import { updateCardQuestions } from './card'
import { BoardError, say } from '../lib/io'
import { cloudError, cloudProblem, hasText, invalidResponse, isRecord, readCloudJson, requireResponse } from '../lib/cloud/response'
import { die, projectRootOf, shellWord } from '../lib/paths'
import { parsePreviewBlocks } from '../lib/shared/preview-blocks'
import { parseFrontmatter } from '../lib/frontmatter'
import { readQuestionOps } from '../lib/questions'
import { applyQuestionOps, questionPositions, QuestionOpError } from '../lib/question-ops'
import type { Typed } from '../lib/cli/shared'
import type { MoveResult } from '../lib/types'

const refuse = (message: string, code: string): never => { throw cloudError({ code, message, retryable: false }) }

/** One Cloud call as the signed-in account; every refusal ends the command with Cloud's words. */
export async function cloud<T>(method: string, route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  process.env.AI4KANBAN_HOME ??= process.env.WILDCRANE_HOME || path.join(os.homedir(), '.wildcrane')
  const token = await accessToken()
  if (!token.ok) throw cloudError({ code: token.reason.replace('-', '_'), message: ('error' in token ? token.error : undefined) ?? CLOUD_ACCESS_HINTS[token.reason],
    retryable: token.reason === 'unreachable' })
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
      throw cloudError({ code: 'unreachable', message: CLOUD_ACCESS_HINTS.unreachable, retryable: true })
    }
    const value = await readCloudJson(response)
    const problem = cloudProblem(response, value)
    if (problem) throw cloudError(problem)
    if (!isRecord(value)) throw cloudError(invalidResponse('a valid JSON response'))
    return value as T
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
  project?: string
  runtime?: string | null
  runtime_info?: { id: string | null; name: string; connector: string; model: string | null; default: boolean }
  studio: { id: string; name: string } | null
  card_version?: number | null
  failure?: string | null
  review?: TaskReview | null
  preview_inputs?: SavedPreviewInputs
  preview_definitions?: TaskReview['preview_definitions']
}

async function all<T>(route: string): Promise<T[]> {
  const rows: T[] = []
  const cursors = new Set<string>()
  let after: string | null = null
  do {
    const page: Page<T> = await cloud('GET', `${route}${route.includes('?') ? '&' : '?'}limit=100${after ? `&after=${enc(after)}` : ''}`)
    requireResponse(page, 'a valid results page', value => Array.isArray(value.data)
      && (value.next === null || hasText(value.next) && !cursors.has(value.next)))
    rows.push(...page.data)
    after = page.next
    if (after) cursors.add(after)
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

function readableFile(file?: string): string | null {
  if (!file) return null
  try {
    fs.accessSync(file, fs.constants.R_OK)
    return fs.statSync(file).isFile() ? file : null
  } catch { return null }
}

function taskFiles(task: Task, board: string | null, location: TaskLocation) {
  const local = board && runnerProject(board) === task.project ? localTaskRecord(board, task.id) : null
  const chat_file = /^task_[\w-]+$/.test(task.id) ? readableFile(taskChatFile(task.id)) : null
  if (!local) return { card_file: null, chat_file, discussion_file: null, approved_inputs_file: null, delivery: null, config_files: [] }
  useBoard({ root: projectRootOf(local.board), board: local.board, named: true }, false, true)
  const found = (fs.existsSync(path.join(local.board, 'todo')) && locate(local.number)) || locateArchived(local.number)
  const card_file = found ? readableFile(found.kind === 'group' ? path.join(found.target, 'root.md') : found.target) : null
  const active = activeDelivery(local.number)
  const delivery = active ?? endedDelivery(String(local.number))
  const current = workspaceTask() === local.task && !!runnerTaskBoard(location)
  const studio = task.studio?.id
  const config_files = [projectConfigFile, ...(studio ? [studioConfigFile(studio), legacyStudioRuleFile(studio)] : [])]
    .map(file => readableFile(path.join(local.board, file))).filter(file => file !== null)
  return {
    card_file,
    chat_file,
    discussion_file: readableFile(path.join(local.board, '.sync', `${local.task}.discussion`, 'discussion.md')),
    approved_inputs_file: current ? readableFile(process.env[SAVED_PREVIEW_FILE_ENV]) : null,
    delivery: delivery ? {
      id: delivery.deliveryId, status: delivery.status, landing: delivery.landing ?? null,
      ...(active && card_file ? { requirements: `akb --board ${shellWord(local.board)} task implement ${local.number} --print` } : {}),
    } : null,
    config_files,
  }
}

function approvedPreviewFiles(snapshot: Record<string, unknown> | null, id: string): Record<string, unknown> {
  const evidence = snapshot?.evidence
  const content = isRecord(evidence) && isRecord(evidence.content) ? evidence.content[id] : undefined
  const frozen = Array.isArray(snapshot?.previews) ? snapshot.previews.find(preview => isRecord(preview) && preview.id === id) : undefined
  const files = isRecord(frozen) && isRecord(frozen.assets) ? { ...frozen.assets } : {}
  if (isRecord(evidence) && isRecord(content) && Array.isArray(content.sources)) {
    const assets = isRecord(evidence.assets) ? evidence.assets : {}
    const dependencies = isRecord(evidence.dependencies) ? evidence.dependencies : {}
    for (const source of content.sources) {
      if (typeof source !== 'string') continue
      const pin = Object.hasOwn(assets, source) ? assets[source] : Object.hasOwn(dependencies, source) ? dependencies[source] : null
      if (pin) files[source] = pin
    }
  }
  return files
}

function showReview(task: Task, card: string) {
  const review = task.review
  const nodes = new Map(review?.plan?.map(node => [node.id, node]))
  const stages = new Map(review?.stages.map(stage => [stage.id, stage]))
  if (review) {
    say('\n## Review')
    for (const stage of stages.values()) {
      const node = nodes.get(stage.id)
      say(`- ${stage.id} · ${node?.previews.length ? node.previews.join(', ') + ' · ' : ''}${stage.status}${node?.after.length ? ' · after ' + node.after.join(', ') : ''}`)
    }
    const authorization = reviewAuthorization(review)
    if (authorization.kind === 'plan') say('Planning only.')
    if (authorization.kind === 'unreviewed' || authorization.kind === 'delivery') say('Delivery authorized.')
  }

  const inputs = task.preview_inputs
  const blocks = parsePreviewBlocks(card).blocks
  const previews = new Set([...blocks.map(block => block.id), ...Object.keys(inputs?.sections ?? {}),
    ...Object.keys(review?.previews ?? {}), ...[...nodes.values()].flatMap(node => node.previews)])
  if (!previews.size) return
  say('\n## Previews')
  for (const id of previews) {
    const planned = [...stages.values()].filter(stage => nodes.get(stage.id)?.previews.includes(id))
    const status = planned.map(stage => `${stage.status} (${stage.id})`).join(', ') ||
      review?.previews?.[id] || 'saved on the card'
    say(`- ${id} · ${status}`)
    for (const source of inputs?.sections?.[id]?.sources ?? []) {
      const pin = inputs?.assets?.[source]
      say(`  - ${source}${pin?.version === undefined ? '' : ` · saved version ${pin.version}`}${pin?.status ? ` · ${pin.status}` : ''}`)
    }
    for (const stage of planned) {
      if (stage.status !== 'approved') continue
      for (const [source, pin] of Object.entries(approvedPreviewFiles(stage.snapshot, id))) {
        if (isRecord(pin) && typeof pin.version === 'number') say(`  - ${source} · approved version ${pin.version} · ${stage.id}`)
      }
    }
  }
}

export async function taskShow(id: string, location: TaskLocation = {}): Promise<MoveResult> {
  const task = await cloud<Task>('GET', `/v1/tasks/${enc(await taskRef(id, location))}`)
  requireTask(task)
  if (task.studio != null && (!isRecord(task.studio) || !hasText(task.studio.name))) {
    throw cloudError(invalidResponse('the task’s Studio'))
  }
  let card: { body: string } | null = null
  if (task.studio) {
    try {
      card = requireResponse(await cloud<{ body: string }>('GET', `/v1/tasks/${enc(task.id)}/card`),
        'the card body', value => hasText(value.body))
    } catch (error) {
      if (!(error instanceof BoardError) || error.details.code !== 'not_found' || (task.card_version ?? 0) > 0) throw error
    }
  }
  const board = linkedBoard(location)
  const removal = board && /^task_[\w-]+$/.test(task.id) ? readRemoval(board, task.id) : null
  const archive = board ? archiveReceipt(board, task.id) : null
  const sync = removal && (removal.status !== 'confirmed' || task.status === 'cancelled')
    ? { kind: 'remove', ...operationStatus(removal) }
    : archive && (archive.status === 'confirmed') === (task.status === 'done') ? { kind: 'archive', ...operationStatus(archive) } : null
  const files = taskFiles(task, board, location)
  say(`${task.key}  ${task.title}`)
  say(`${task.status}${task.studio ? `  ${task.studio.name}` : ''}  ${taskUrl(task.key)}`)
  if (files.card_file || task.studio) say(`Card file: ${files.card_file ?? 'unavailable on this computer'}`)
  if (card) say(`\n${card.body.trim()}`)
  else if (task.studio) say('The card has not been generated yet.')
  const questions = parseFrontmatter(card?.body ?? '').meta?.questions ?? []
  if (card) {
    say('\n## Questions')
    say(questions.length ? questions.map(q => `- ${q.text}${q.options?.length ? ` (${q.options.join(' / ')})` : ''}`).join('\n') : 'No open questions.')
  }
  showReview(task, card?.body ?? '')
  if (task.review || files.delivery || files.approved_inputs_file) {
    say('\n## Delivery')
    if (files.delivery) {
      say(`- ${files.delivery.id} · ${files.delivery.status}`)
      if (files.delivery.landing) say(`- Landing: ${files.delivery.landing.commit ?? files.delivery.landing.status}`)
      if (files.delivery.requirements) say(`- Frozen requirements: \`${files.delivery.requirements}\``)
    }
    say(`- Approved inputs: ${files.approved_inputs_file ?? 'no local manifest available'}`)
    if (task.review?.stages.some(stage => stage.snapshot)) say(`- Review snapshots: \`akb task review ${task.key}\``)
  }
  say('\n## Chat')
  say(`- Recent task chat: ${files.chat_file ?? `no local file; use \`akb task chat ${task.key}\``}`)
  if (files.discussion_file) say(`- Source discussion: ${files.discussion_file}`)
  if (task.studio?.id) {
    const studio = studioName(task.studio.id)
    say(`\n## Studio\n- ${task.studio.name} · ${studio}`)
    say(`- Instructions and Preview definitions: \`akb studio file ${studio} STUDIO.md\`; check \`shared/RULES.md\` if present.`)
    say(`- Component documentation: \`akb raw components --studio ${studio} --docs\`.`)
    say(`- Shared configuration: \`akb studio rule ${studio}\`.`)
    for (const file of files.config_files) say(`- Configuration file: ${file}`)
    if (task.preview_definitions?.length || task.review?.preview_definitions?.length) {
      say(`- Custom Preview definitions: \`akb task show ${task.key} --json\`.`)
    }
  }
  if (sync) say(`${sync.kind === 'remove' ? 'Removal' : 'Archive'}: ${sync.status}${'code' in sync && sync.code ? ` [${sync.code}] ${sync.message ?? ''}` : ''}.`)
  return { ...task, card, local_context: files, card_read_status: card ? 'available' : task.studio ? 'not_generated' : 'no_studio', ...(sync ? { sync } : {}) }
}

export interface TaskCreateOptions {
  project?: string
  studio?: string
  review?: string
  reviewFile?: string
  previewDefinitionsFile?: string
}

export async function taskCreate(request: string, opts: TaskCreateOptions, location: TaskLocation = {}): Promise<MoveResult> {
  const text = request.trim()
  if (!text) die('Say what the task is.', { kind: 'bad-args', exitCode: 2 })
  if (opts.review !== undefined && opts.reviewFile !== undefined) die('Use either --review or --review-file.')
  const line = text.split('\n')[0]!.trim()
  const title = line.length > 80 ? `${line.slice(0, 79)}…` : line
  const target = await project(opts.project, location)
  if (!opts.studio?.trim()) return refuse('Choose --studio from akb studio list.', 'no_studio')
  const body: Record<string, unknown> = {
    title,
    request: text,
    project: target,
    studio: cloudStudio(opts.studio),
    source: 'api',
    run: true,
  }
  if (opts.review !== undefined) body.review_flow = opts.review
  if (opts.reviewFile !== undefined) body.review_plan = parseReviewPlan(JSON.parse(fs.readFileSync(opts.reviewFile, 'utf8')))
  if (opts.previewDefinitionsFile !== undefined) {
    body.preview_definitions = previewDefinitionsSchema.parse(JSON.parse(fs.readFileSync(opts.previewDefinitionsFile, 'utf8')))
  }
  const task = await cloud<Task>('POST', '/v1/tasks', body)
  say(`Created ${task.key}: ${task.title}  ${taskUrl(task.key)}`)
  say(`Status: ${task.status}${task.failure ? ` — ${task.failure}` : ''}`)
  return { ...task }
}

function requireTask(task: Task): Task {
  return requireResponse(task, 'a task receipt', value => hasText(value.id) && hasText(value.key) && hasText(value.status))
}

async function act(id: string, route: string, body: unknown, done: (key: string, value: Record<string, unknown>) => string,
  location: TaskLocation): Promise<MoveResult> {
  const ref = await taskRef(id, location)
  const value = await cloud<Record<string, unknown>>('POST', `/v1/tasks/${enc(ref)}/${route}`, body)
  say(done(ref, value))
  return value
}

export interface ReviewOptions { previewDefinitionsFile?: string; stage?: string; revision?: string; review?: string; file?: string; status?: string; reviseFrom?: string }

function reviewRevision(value?: string): number {
  if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) die('--revision must match the review you read.')
  return Number(value)
}

export async function taskReview(id: string, opts: ReviewOptions = {}, location: TaskLocation = {}): Promise<MoveResult> {
  const count = [opts.review, opts.file, opts.status, opts.reviseFrom].filter(v => v !== undefined).length
  if (count > 1 || opts.stage !== undefined && opts.status === undefined) die('Use one of --review, --file, --stage with --status, or --revise-from.')
  const ref = await taskRef(id, location)
  let task: Task
  if (opts.previewDefinitionsFile !== undefined && (opts.status !== undefined || opts.reviseFrom !== undefined)) die('Preview definitions can only change with a review plan.')
  if (!count && opts.previewDefinitionsFile === undefined) task = await cloud<Task>('GET', `/v1/tasks/${enc(ref)}`)
  else {
    const review_revision = reviewRevision(opts.revision)
    let fields: Record<string, unknown>
    if (opts.review !== undefined) {
      fields = { operation: 'plan', review_flow: opts.review }
    } else if (opts.file !== undefined) {
      fields = { operation: 'plan', review_plan: parseReviewPlan(JSON.parse(fs.readFileSync(opts.file, 'utf8'))) }
    } else if (opts.reviseFrom !== undefined) {
      fields = { operation: 'revise', stage: opts.reviseFrom }
    } else if (opts.previewDefinitionsFile !== undefined) {
      fields = { operation: 'plan' }
    } else {
      if (!opts.stage || !['running', 'done'].includes(opts.status!)) die('--stage and --status running|done are required.')
      fields = { operation: 'status', stage: opts.stage, status: opts.status }
    }
    if (opts.previewDefinitionsFile !== undefined) fields.preview_definitions = previewDefinitionsSchema.parse(JSON.parse(fs.readFileSync(opts.previewDefinitionsFile, 'utf8')))
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
    ...(comment?.trim() ? { comment: comment.trim() } : {}) }, (key, value) => {
    requireResponse(value, 'an approval receipt', receipt => hasText(receipt.id) && receipt.decision === 'approve')
    return `Approved ${key}.`
  }, location)
}

export async function taskUpdateQuestions(id: string, typed: Typed[], location: TaskLocation = {}): Promise<MoveResult> {
  const ops = readQuestionOps(typed)
  const current = executionOf() ? workspaceTask() : null
  const ref = await taskRef(id, location)
  const selected = current && !ref.startsWith('task_')
    ? requireTask(await cloud<Task>('GET', `/v1/tasks/${enc(ref)}`))
    : null
  const target = selected?.id ?? ref
  if (current && target === current) {
    const board = runnerTaskBoard(location)
    const unavailable = () => refuse('Cannot find the current task’s local card on its Runner board.', 'local_card_unavailable')
    if (!board) return unavailable()
    return withSyncLock(board, async () => {
      const project = runnerProject(board)
      const mapped = localTaskRecord(board, current)
      if (!mapped || !project || (selected && (selected.project !== project || numberOf(selected.key) !== mapped.number))) {
        return unavailable()
      }
      const root = projectRootOf(board)
      useBoard({ board, root, named: true }, false, true)
      return withBoardLock(() => {
        const run = insideRun()
        const runCard = run ? peekRun(run)?.cardId : null
        if ((runCard != null && runCard !== mapped.number) || !fs.existsSync(path.join(board, 'todo')) || !locate(mapped.number)) {
          return unavailable()
        }
        return updateCardQuestions(mapped.number, ops)
      })
    })
  }

  const card = requireResponse(await cloud<{ version: number; body: string }>('GET', `/v1/tasks/${enc(target)}/card`),
    'the card body and version', value => hasText(value.body) && Number.isSafeInteger(value.version) && value.version >= 0)
  const meta = parseFrontmatter(card.body).meta
  if (!meta) return refuse('The card has no frontmatter.', 'bad_request')
  let changes: string[]
  let open: number
  try {
    const done = applyQuestionOps(meta.questions, ops)
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
    return { clear: true }
  })
  const task = await cloud<Task>('PATCH', `/v1/tasks/${enc(target)}/questions`, { base_version: card.version, ops: body })
  say(`updated ${task.key} questions: ${changes.join(', ')} (${open} open)`)
  return { ...task, changes, open }
}

export const taskChat = (id: string, message: string, location: TaskLocation = {}) =>
  act(id, 'chat?preserveWhitespace=true', { body: message }, (key, chat) => {
    requireResponse(chat, 'a chat message receipt', value => Array.isArray(value.messages)
      && value.messages.some(msg => isRecord(msg) && hasText(msg.id) && msg.role === 'user'
        && (msg.body === message || msg.body === message.trim())))
    if (hasText(chat.failure) || ['failed', 'conflict', 'runner_offline', 'stopped'].includes(String(chat.status))) {
      return refuse(hasText(chat.failure) ? chat.failure : `Chat reply: ${chat.status}.`, 'reply_failed')
    }
    return ['queued', 'replying'].includes(String(chat.status)) ? `Sent to ${key}. Reply pending.` : `Sent to ${key}.`
  }, location)

function runnerTaskBoard(location: TaskLocation): string | null {
  const runnerBoard = process.env.AI4KANBAN_BOARD?.trim()
  if (!runnerBoard) return null
  const cwd = location.cwd ?? process.cwd()
  try {
    const board = path.resolve(cwd, location.board ?? runnerBoard)
    return fs.realpathSync(board) === fs.realpathSync(path.resolve(cwd, runnerBoard)) && runnerProject(board) ? board : null
  } catch { return null }
}

// The Runner's sync record maps a task ID to its card number.
function localTaskRecord(board: string, task: string) {
  if (!/^task_[\w-]+$/.test(task)) return null
  try {
    const record = JSON.parse(fs.readFileSync(path.join(board, '.sync', task + '.json'), 'utf8'))
    if (record.task === task && Number.isSafeInteger(record.number) && record.number > 0 && !record.deleted) {
      return { board, task, number: record.number as number }
    }
  } catch { /* The task has no local sync record. */ }
  return null
}

function localTaskTarget(location: TaskLocation) {
  const task = workspaceTask()
  if (!task || !executionOf()) return null
  const board = runnerTaskBoard(location)
  return board ? localTaskRecord(board, task) : null
}

function linkedBoard(location: TaskLocation): string | null {
  const cwd = location.cwd ?? process.cwd()
  const named = location.board ?? process.env.AI4KANBAN_BOARD
  if (named) {
    const board = path.resolve(cwd, named)
    return runnerProject(board) ? board : null
  }
  for (let dir = path.resolve(cwd, location.dir ?? '.'); ; dir = path.dirname(dir)) {
    const board = path.join(dir, '.akb', 'kanban')
    if (runnerProject(board)) return board
    if (path.dirname(dir) === dir) return null
  }
}

function operationStatus(result: TaskOperationResult): TaskOperationResult {
  if (result.status === 'confirmed') return { status: result.status }
  return { status: result.status, code: result.code, message: result.message }
}

function archiveReceipt(board: string, task: string, file?: string): TaskOperationResult | null {
  try {
    const base = JSON.parse(fs.readFileSync(path.join(board, '..', 'base.json'), 'utf8'))
    const receipt = base.archiveReceipts?.[task]
    const root = `projects/${runnerProject(board)}/`
    const synced = receipt && base.files?.[root + receipt.path]
    const manifest = assetsFile(task)
    const assets = base.files?.[root + manifest]
    if (synced && (!file || receipt.path === file) && synced.seq === receipt.seq && (assets?.seq ?? 0) === receipt.assets_seq) {
      const local = (name: string) => {
        try { return fs.readFileSync(path.join(board, name), 'utf8') } catch { return null }
      }
      if (synced.content === local(receipt.path) && (assets?.content ?? null) === local(manifest)) return operationStatus(receipt)
      if (file) return { status: 'pending' }
    }
    return base.pendingArchives?.[task] ? { status: 'pending' } : null
  } catch { return null }
}

export async function taskArchive(asked: string, location: TaskLocation = {}): Promise<MoveResult> {
  const ref = asked.trim()
  const local = localTaskTarget(location)
  const keyMatch = local && /^[a-z][a-z0-9]{0,9}-[1-9]\d{0,8}$/i.test(ref)
    ? await cloud<Task>('GET', `/v1/tasks/${enc(ref)}`) : null
  if (local && (ref === local.task || /^\d+$/.test(ref) && Number(ref) === local.number || keyMatch && keyMatch.id === local.task)) {
    const archive = await withSyncLock(local.board, async () => {
      useBoard({ board: local.board, root: projectRootOf(local.board), named: true }, false)
      return withCreationLock(() => withBoardLock(() => {
        if (locate(local.number)) return { receipt: cmdRemove(local.number, 'completed', { archivingTask: true }) }
        const existing = locateArchived(local.number)
        if (!existing) return null
        const file = existing.kind === 'group' ? path.join(existing.target, 'root.md') : existing.target
        const { meta } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
        if (!meta?.archived || meta.rejected) return refuse('This task is not eligible for archive.', 'conflict')
        return { receipt: { archived_to: path.relative(local.board, existing.target) },
          existing: path.relative(local.board, file) }
      }))
    })
    if (archive) {
      const receipt = archive.existing && archiveReceipt(local.board, local.task, archive.existing)
      if (receipt && receipt.status === 'confirmed') {
        say('Archive confirmed by Cloud.')
        return { task: local.task, archive_status: 'archived' }
      }
      if (receipt && receipt.status === 'rejected') {
        if (receipt.code === 'version_conflict' || receipt.code === 'not_found') {
          return refuse(receipt.message ?? 'Cloud rejected the archive.', receipt.code)
        }
        // An explicit retry rechecks the Cloud refusal after review or questions change.
      } else {
        const pending = receipt && receipt.status === 'pending' && receipt.code ? receipt : null
        say(`Archived locally. Waiting for Runner synchronization.${pending ? ` [${pending.code}] ${pending.message}` : ''}`)
        return { ...archive.receipt, task: local.task, archive_status: 'pending_sync', ...(pending ? { sync: pending } : {}) }
      }
    }
  }
  const result = await cloud<Task>('POST', `/v1/tasks/${enc(keyMatch?.id ??
    (local && /^\d+$/.test(ref) && Number(ref) === local.number ? local.task : await taskRef(ref, location)))}/archive`)
  requireResponse(requireTask(result), 'confirmation that the task was archived', task => task.status === 'done')
  say(`Archived ${result.key}.`)
  return { task: result.id, archive_status: 'archived' }
}

export async function taskRemove(asked: string, reason: string, location: TaskLocation = {}, discard = false): Promise<MoveResult> {
  const ref = asked.trim()
  const text = reason.trim()
  if (text.length > 2000) return refuse('The removal reason must be at most 2000 characters.', 'payload_too_large')
  const local = localTaskTarget(location)
  const numeric = /^\d+$/.test(ref)
  const run = insideRun()
  const keyMatch = local && /^[a-z][a-z0-9]{0,9}-[1-9]\d{0,8}$/i.test(ref) && ref.endsWith(`-${local.number}`)
    ? await cloud<Task>('GET', `/v1/tasks/${enc(ref)}`) : null
  if (local && (ref === local.task || numeric && Number(ref) === local.number || keyMatch?.id === local.task)) {
    return withSyncLock(local.board, async () => {
      const held = readRemoval(local.board, local.task)
      if (held?.status === 'confirmed') {
        const current = requireTask(keyMatch ?? await cloud<Task>('GET', `/v1/tasks/${enc(local.task)}`))
        if (current.status === 'cancelled') {
          say('Removal confirmed by Cloud.')
          return { task: local.task, remove_status: 'removed' }
        }
      } else if (held?.status === 'rejected') {
        const current = requireTask(keyMatch ?? await cloud<Task>('GET', `/v1/tasks/${enc(local.task)}`))
        if (current.status === 'done' || current.status === 'cancelled') return refuse(held.message ?? 'Cloud rejected the removal.', held.code ?? 'conflict')
      }
      if (held?.status !== 'pending') writeRemoval(local.board, local.task, { status: 'pending', reason: text, discard: true })
      const pending = held?.status === 'pending' && held.code ? operationStatus(held) : null
      say(`Removal queued for Runner synchronization.${pending && pending.status !== 'confirmed' ? ` [${pending.code}] ${pending.message}` : ''}`)
      return { task: local.task, board: local.board, remove_status: 'pending_sync', ...(pending ? { sync: pending } : {}) }
    })
  }

  if (!workspaceTask() && run && numeric) {
    const found = resolveBoard('reject', { board: location.board, dir: location.dir ?? null,
      cwd: location.cwd ?? process.cwd(), installHint: BOARD_LINK_HINT })
    useBoard(found, location.dir != null, true)
    const number = Number(ref)
    if (peekRun(run)?.cardId === number) {
      useBoard(found, location.dir != null)
      return { board: found.board, ...withCreationLock(() => withBoardLock(() => cmdRemove(number, 'rejected', { reason: text, discard }))) }
    }
  }

  const skipLearning = discard || Boolean(workspaceTask() || run)
  const body = { ...(text ? { reason: text } : {}), ...(skipLearning ? { discard: true } : {}) }
  return act(keyMatch?.id ?? ref, 'cancel', Object.keys(body).length ? body : undefined,
    (key, value) => {
      requireResponse(value, 'confirmation that the task was removed', task => hasText(task.id) && task.status === 'cancelled')
      return `Removed ${keyMatch ? ref : key} in Cloud. Restore it with akb task restore ${keyMatch ? ref : key}.`
    }, location)
}
export async function taskRestore(id: string, location: TaskLocation = {}): Promise<MoveResult> {
  const task = await cloud<Task>('POST', `/v1/tasks/${enc(await taskRef(id, location))}/restore`)
  requireResponse(requireTask(task), 'confirmation that the task was restored', value => ['stopped', 'waiting_review', 'failed'].includes(value.status))
  say(`Restored ${task.key}. Status: ${task.status}.`)
  return { ...task }
}
export async function taskResume(id: string, location: TaskLocation = {}): Promise<MoveResult> {
  const task = requireTask(await cloud<Task>('POST', `/v1/tasks/${enc(await taskRef(id, location))}/resume`))
  if (!['queued', 'running'].includes(task.status)) {
    const reason = task.failure || (task.status === 'waiting_review' ? 'The task is waiting for review.' :
      ['done', 'cancelled'].includes(task.status) ? 'This task has finished.' : `The task is ${task.status}.`)
    return refuse(reason, task.status === 'failed' ? 'execution_failed' : 'conflict')
  }
  say(task.status === 'queued' ? `Resume queued for ${task.key}.` : `Resumed ${task.key}.`)
  return { ...task }
}

interface CloudRuntime { id: string; name: string; default?: boolean }

async function resolveCloudRuntime(asked: string): Promise<string> {
  const value = asked.trim()
  if (!value) die('Specify a runtime id or name.', { kind: 'bad-args', exitCode: 2 })
  if (value.startsWith('rt_')) return value
  const list = await cloud<{ data: CloudRuntime[] }>('GET', '/v1/runtimes')
  requireResponse(list, 'a list of runtimes', v => Array.isArray(v.data))
  const matches = list.data.filter(r => r.name === value || (r.default && value === 'Global default'))
  if (!matches.length) return refuse(`No runtime named "${value}".`, 'not_found')
  if (matches.length > 1) return refuse(`Multiple runtimes are named "${value}". Use its rt_... id instead.`, 'conflict')
  return matches[0]!.id
}

export async function taskRuntime(id: string, runtime: string, location: TaskLocation = {}): Promise<MoveResult> {
  const runtimeId = await resolveCloudRuntime(runtime)
  const ref = await taskRef(id, location)
  const task = requireTask(await cloud<Task>('PATCH', `/v1/tasks/${enc(ref)}`, { runtime: runtimeId }))
  if (task.runtime !== runtimeId || (task.runtime_info != null && task.runtime_info.id !== runtimeId)) {
    const effective = task.runtime_info == null ? '' : `, effective ${task.runtime_info.id ?? 'missing'}`
    throw cloudError(invalidResponse(`a matching runtime (requested ${runtimeId}, saved ${task.runtime ?? 'missing'}${effective})`))
  }
  const name = task.runtime_info?.name
  say(`Updated ${task.key} runtime to ${hasText(name) ? name : task.runtime}.`)
  return { ...task }
}

export async function taskStop(id: string, location: TaskLocation = {}): Promise<MoveResult> {
  const task = requireTask(await cloud<Task>('POST', `/v1/tasks/${enc(await taskRef(id, location))}/stop`))
  requireResponse(task, 'a stop receipt', value => ['running', 'queued', 'waiting_review', 'stopped'].includes(value.status))
  const stop_status = task.status === 'stopped' ? 'stopped' : 'requested'
  say(stop_status === 'stopped' ? `Stopped ${task.key}.` : `Stop requested for ${task.key}.`)
  return { ...task, stop_status }
}

export const taskComment = (id: string, text: string, location: TaskLocation = {}) =>
  act(id, 'comments', { body: text }, (key, value) => {
    requireResponse(value, 'a comment receipt', receipt => hasText(receipt.id) && receipt.body === text.trim())
    return `Commented on ${key}.`
  }, location)

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
