import { hasInPlaceArchiveCommit, landingOf, recordDeliveryArchive } from '../lib/agent/delivery-archive'
import { saveDeliveryCleanupReceipt } from '../lib/agent/delivery-cleanup-receipt'
import { REVIEW_SYNC_ENV, syncPreviewForApproval } from '../lib/cloud/review-sync'
import { deliveryPhase, insideRun, SAVED_PREVIEW_FILE_ENV } from '../lib/agent/env'
import { runAgent } from '../lib/agent/project-agent'
import { activeDelivery, endedDelivery } from '../lib/agent/deliveries'
import { taskChatFile } from '../lib/agent/task-chats'
import { REPLY_APPROVAL_ENV } from '../lib/cloud/reply-approval'
import { mergePreviewDefinitions, previewDefinitionsSchema } from '../lib/shared/preview-definitions'
import { addPreviewsToPlan, agentReview, isFlatReviewPlan, parseReviewPlan, reviewAuthorization, reviewPlanFromOptions, reviewPreviewIds, type SavedPreviewInputs, type TaskReview } from '../lib/shared/review-plan'
// `akb task`, `workspace`, `project`, `runner` (#550): the signed-in account's WildCrane tasks, read
// and changed from any chat.

import { approveAfterReply } from '../lib/cloud/reply-approval'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { cloudEndpoints } from '../lib/cloud/config'
import { accessToken, CLOUD_ACCESS_HINTS } from '../lib/cloud/session'
import { confirmRunnerBinding } from '../lib/cloud/runner-binding'
import { cloudStudio, linkedProject, numberOf, runnerProject, workspaceTask } from '../lib/cloud/tasks'
import { executionOf } from '../lib/cloud/execution'
import { localArchiveInput } from '../lib/cloud/archive'
import { BOARD_LINK_HINT, resolveBoard, useBoard } from '../lib/board-cli'
import { locate, locateArchived } from '../lib/cards'
import { peekRun } from '../lib/agent/sessions'
import { withCreationLock } from '../lib/agent/creation-lock'
import { withBoardLock } from '../lib/lock'
import { readRemoval, writeRemoval, type TaskOperationResult } from '../lib/cloud/task-operation'
import type { ArchiveInput } from '../lib/shared/delivery-evidence'
import { assetsFile, legacyStudioRuleFile, projectConfigFile, studioConfigFile, studioName } from '../lib/shared/board-files'
import { withSyncLock } from '../lib/shared/board-conflicts'
import { cmdRemove, recoveredArchiveHandoff } from './remove'
import { updateCardQuestions } from './card'
import { BoardError, say, warn } from '../lib/io'
import { runnerBoardRoot } from '../lib/machine/project'
import { cloudError, cloudProblem, hasText, invalidResponse, isRecord, readCloudJson, requireResponse } from '../lib/cloud/response'
import { ASSETS, die, projectRootOf, setBoardDir, shellWord } from '../lib/paths'
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
type Task = {
  id: string
  key: string
  title: string
  status: string
  project?: string
  studio: { id: string; name: string } | null
  card_version?: number | null
  last_job?: string | null
  landing?: { commit: string; branch: string } | null
  failure?: string | null
  review?: TaskReview | null
  review_revision?: number
  preview_inputs?: SavedPreviewInputs
  preview_definitions?: TaskReview['preview_definitions']
}

export const agentTaskContext = () => Boolean(insideRun() || executionOf() || workspaceTask() || process.env[REPLY_APPROVAL_ENV])

function taskReceipt<T extends Pick<Task, 'review' | 'review_revision'>>(task: T) {
  if (!agentTaskContext()) return task
  const { review, review_revision: _revision, ...rest } = task
  return { ...rest, ...(review !== undefined && { review: review && agentReview(review) }) }
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
  return { data: data.map(taskReceipt), next: null }
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
  if (!local) return { card_file: null, asset_folder: null, chat_file, discussion_file: null, approved_inputs_file: null, delivery: null, config_files: [] }
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
    asset_folder: path.join(ASSETS, String(local.number)),
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
  const nodes = new Map(Array.isArray(review?.plan) ? review.plan.map(node => [node.id, node]) : [])
  const stages = new Map(review?.stages.map(stage => [stage.id, stage]))
  if (review) {
    say('\n## Review')
    for (const stage of stages.values()) {
      const node = nodes.get(stage.id)
      say(`- ${stage.id} · ${node?.previews.length ? node.previews.join(', ') + ' · ' : ''}${stage.status}${node?.after.length ? ' · after ' + node.after.join(', ') : ''}`)
    }
    if (isFlatReviewPlan(review.plan)) {
      if (review.plan.rule) say(review.plan.rule)
      const agent = agentTaskContext()
      for (const approval of review.approvals ?? []) {
        if ('question' in approval) say(`- ${approval.stage} · ${approval.preview} · ${agent ? '' : 'version ' + approval.revision + ' · '}${approval.question}`)
      }
    }
    const authorization = reviewAuthorization(review)
    if (authorization.kind === 'plan') say('Planning only.')
    if (authorization.kind === 'unreviewed' || authorization.kind === 'delivery' || authorization.kind === 'flat') say('Delivery authorized.')
  }

  const inputs = task.preview_inputs
  const blocks = parsePreviewBlocks(card).blocks
  const previews = new Set([...blocks.map(block => block.id), ...Object.keys(inputs?.sections ?? {}),
    ...Object.keys(review?.previews ?? {}), ...reviewPreviewIds(review?.plan)])
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
  if (files.asset_folder) say(`Asset folder: ${files.asset_folder}`)
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
  return { ...taskReceipt(task), card, local_context: files, card_read_status: card ? 'available' : task.studio ? 'not_generated' : 'no_studio', ...(sync ? { sync } : {}) }
}

export interface TaskCreateOptions {
  project?: string
  studio?: string
  review?: string
  previews?: string
  reviewFile?: string
  previewDefinitionsFile?: string
}

export async function taskCreate(request: string, opts: TaskCreateOptions, location: TaskLocation = {}): Promise<MoveResult> {
  const text = request.trim()
  if (!text) die('Say what the task is.', { kind: 'bad-args', exitCode: 2 })
  if (opts.reviewFile !== undefined && (opts.review !== undefined || opts.previews !== undefined)) die('Use --review-file or --review and --previews.')
  const line = text.split('\n')[0]!.trim()
  const title = line.length > 80 ? `${line.slice(0, 79)}…` : line
  const target = await project(opts.project, location)
  if (!opts.studio?.trim()) return refuse('Choose --studio from akb studio list.', 'no_studio')
  const from = workspaceTask()
  const agent = runAgent() ?? (insideRun() || executionOf() ? 'agent' : null)
  const body: Record<string, unknown> = {
    title,
    request: text,
    project: target,
    studio: cloudStudio(opts.studio),
    source: 'api',
    ...(from || agent ? { source_context: { ...(from ? { task: from } : {}), ...(agent ? { agent } : {}) } } : {}),
    run: true,
  }
  const flat = reviewPlanFromOptions(opts)
  if (flat) body.review_plan = flat
  else if (opts.review !== undefined) body.review_flow = opts.review
  if (opts.reviewFile !== undefined) body.review_plan = parseReviewPlan(JSON.parse(fs.readFileSync(opts.reviewFile, 'utf8')))
  if (opts.previewDefinitionsFile !== undefined) {
    body.preview_definitions = previewDefinitionsSchema.parse(JSON.parse(fs.readFileSync(opts.previewDefinitionsFile, 'utf8')))
  }
  const task = await cloud<Task>('POST', '/v1/tasks', body)
  say(`Created ${task.key}: ${task.title}  ${taskUrl(task.key)}`)
  say(`Status: ${task.status}${task.failure ? ` — ${task.failure}` : ''}`)
  return taskReceipt(task)
}

function requireTask(task: Task): Task {
  return requireResponse(task, 'a task receipt', value => hasText(value.id) && hasText(value.key) && hasText(value.status))
}

async function act(id: string, route: string, body: unknown, done: (key: string, value: Record<string, unknown>) => string,
  location: TaskLocation): Promise<MoveResult> {
  const ref = await taskRef(id, location)
  const value = await cloud<Record<string, unknown> & Pick<Task, 'review' | 'review_revision'>>('POST', `/v1/tasks/${enc(ref)}/${route}`, body)
  say(done(ref, value))
  return route === 'cancel' ? taskReceipt(value) : value
}

export interface ReviewOptions { previewDefinitionsFile?: string; stage?: string; revision?: string; review?: string; previews?: string; addPreviews?: string; requestApproval?: string; preview?: string; file?: string; status?: string; reviseFrom?: string }

function reviewRevision(value?: string): number {
  if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) die('--revision must match the review you read.')
  return Number(value)
}

export async function taskReview(id: string, opts: ReviewOptions = {}, location: TaskLocation = {}): Promise<MoveResult> {
  const updatingPlan = opts.review !== undefined || opts.previews !== undefined
  const addingPreviews = opts.addPreviews !== undefined
  const count = [updatingPlan ? true : undefined, addingPreviews ? true : undefined, opts.file, opts.status, opts.reviseFrom, opts.requestApproval].filter(v => v !== undefined).length
  if (count > 1 || opts.stage !== undefined && opts.status === undefined) die('Review operations cannot be combined.')
  if ((opts.preview === undefined) !== (opts.requestApproval === undefined)) die('--request-approval and --preview are required together.')
  const ref = await taskRef(id, location)
  if (opts.previewDefinitionsFile !== undefined && (opts.status !== undefined || opts.reviseFrom !== undefined || opts.requestApproval !== undefined)) die('Preview definitions can only change with a review plan.')
  const route = `/v1/tasks/${enc(ref)}`
  let task = await cloud<Task>('GET', route)
  if (count || opts.previewDefinitionsFile !== undefined) {
    if (opts.requestApproval !== undefined && process.env[REVIEW_SYNC_ENV]) {
      await syncPreviewForApproval(task.id)
      task = await cloud<Task>('GET', route)
    }
    const previous = task.review
    if (!previous) return refuse('This task has no review.', 'review_refused')
    const review_revision = !agentTaskContext() && opts.revision !== undefined ? reviewRevision(opts.revision) : previous.revision
    if ((updatingPlan || addingPreviews) && previous.revision !== review_revision) {
      return refuse('Review changed. Read it again.', 'review_outdated')
    }
    let fields: Record<string, unknown>
    if (updatingPlan) {
      const plan = reviewPlanFromOptions(opts, previous.plan)
      fields = plan ? { operation: 'plan', review_plan: plan } : { operation: 'plan', review_flow: opts.review }
    } else if (addingPreviews) {
      const previewsToAdd = opts.addPreviews!.split(',').map(s => s.trim()).filter(Boolean)
      if (!previewsToAdd.length) die('--add-previews requires at least one Preview ID.')
      fields = { operation: 'plan', review_plan: addPreviewsToPlan(previous.plan, previewsToAdd) }
    } else if (opts.requestApproval !== undefined) {
      fields = { operation: 'request_approval', preview: opts.preview, question: opts.requestApproval }
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
    if (opts.previewDefinitionsFile !== undefined) {
      const incoming = previewDefinitionsSchema.parse(JSON.parse(fs.readFileSync(opts.previewDefinitionsFile, 'utf8')))
      fields.preview_definitions = addingPreviews ? mergePreviewDefinitions(previous.preview_definitions ?? [], incoming) : incoming
    }
    try {
      task = await cloud<Task>('POST', `${route}/review`, { ...fields, review_revision })
    } catch (error) {
      if (error instanceof BoardError && error.details.code === 'review_outdated') {
        return refuse('Review changed. Read the task and retry.', 'review_outdated')
      }
      throw error
    }
  }
  const { review } = taskReceipt(task)
  say(JSON.stringify(review, null, 2))
  return { review }
}

export async function taskApprove(id: string, comment?: string, opts: ReviewOptions = {}, location: TaskLocation = {}): Promise<MoveResult> {
  if (process.env[REPLY_APPROVAL_ENV]) {
    const ref = linked(location) ? await taskRef(id, location) : id.trim()
    return approveAfterReply(ref, comment, opts.stage)
  }
  if (agentTaskContext()) return refuse('Only the user approves a review.', 'review_refused')
  const review_revision = reviewRevision(opts.revision)
  return act(id, 'decisions', { decision: 'approve', review_revision, ...(opts.stage ? { stage: opts.stage } : {}),
    ...(comment?.trim() ? { comment: comment.trim() } : {}) }, (key, value) => {
    requireResponse(value, 'an approval receipt', receipt => hasText(receipt.id) && receipt.decision === 'approve')
    return `Approved ${key}.`
  }, location)
}

export async function taskUpdateQuestions(id: string, typed: Typed[], location: TaskLocation = {}): Promise<MoveResult> {
  const ops = readQuestionOps(typed)
  const current = executionOf() ? workspaceTask() : null
  const board = current ? runnerTaskBoard(location, false) : null
  const localNumber = board && current ? localTaskRecord(board, current)?.number : undefined
  const ref = current && /^\d+$/.test(id.trim()) && Number(id) === localNumber ? current : await taskRef(id, location)
  const selected = current && !ref.startsWith('task_')
    ? requireTask(await cloud<Task>('GET', `/v1/tasks/${enc(ref)}`))
    : null
  const target = selected?.id ?? ref
  if (current && target === current) {
    const unavailable = () => refuse('Cannot find the current task’s local card on its Runner board.', 'local_card_unavailable')
    if (!board) return unavailable()
    const check = await confirmRunnerBinding(board)
    return withSyncLock(board, async () => {
      check?.()
      const project = runnerProject(board)
      const mapped = localTaskRecord(board, current)
      if (!mapped || !project || (selected && (selected.project !== project || numberOf(selected.key) !== mapped.number))) {
        return unavailable()
      }
      const root = runnerBoardRoot(board)!
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
  return { ...taskReceipt(task), changes, open }
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

function runnerTaskBoard(location: TaskLocation, requireLink = true): string | null {
  const runnerBoard = process.env.AI4KANBAN_BOARD?.trim()
  if (!runnerBoard) return null
  const cwd = location.cwd ?? process.cwd()
  try {
    const board = path.resolve(cwd, location.board ?? runnerBoard)
    const real = fs.realpathSync(board)
    if (real !== fs.realpathSync(path.resolve(cwd, runnerBoard))) return null
    return requireLink ? (runnerProject(board) && board) : (runnerBoardRoot(real) && real)
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

function linkedBoard(location: TaskLocation, strict = false): string | null {
  const cwd = location.cwd ?? process.cwd()
  const named = location.board ?? process.env.AI4KANBAN_BOARD
  const projectOf = (board: string) => {
    if (!strict) return runnerProject(board)
    if (path.basename(board) !== 'kanban' || path.basename(path.dirname(board)) !== '.akb') return null
    const link = linkedProject(board, path.resolve(board, '../..'))
    if (!link.ok) return refuse(`${link.error} Restore the Runner's project link before archiving.`, 'invalid_link')
    return link.value
  }
  if (named) {
    const board = path.resolve(cwd, named)
    return projectOf(board) ? board : null
  }
  for (let dir = path.resolve(cwd, location.dir ?? '.'); ; dir = path.dirname(dir)) {
    const board = path.join(dir, '.akb', 'kanban')
    if (projectOf(board)) return board
    if (path.dirname(dir) === dir) return null
  }
}

function operationStatus(result: TaskOperationResult): TaskOperationResult {
  if (result.status === 'confirmed') return { status: result.status }
  return { status: result.status, code: result.code, message: result.message }
}

function archiveReceipt(board: string, task: string): TaskOperationResult | null {
  try {
    const base = JSON.parse(fs.readFileSync(path.join(board, '..', 'base.json'), 'utf8'))
    const receipt = base.archiveReceipts?.[task]
    const root = `projects/${runnerProject(board)}/`
    const synced = receipt && base.files?.[root + receipt.path]
    const manifest = assetsFile(task)
    const assets = base.files?.[root + manifest]
    if (synced && synced.seq === receipt.seq && (assets?.seq ?? base.deleted?.[root + manifest] ?? 0) === receipt.assets_seq) {
      const local = (name: string) => {
        try { return fs.readFileSync(path.join(board, name), 'utf8') } catch { return null }
      }
      if (synced.content === local(receipt.path) && (assets?.content ?? null) === local(manifest)) return operationStatus(receipt)
    }
    return base.pendingArchives?.[task] ? { status: 'pending' } : null
  } catch { return null }
}

export async function taskArchive(asked: string, location: TaskLocation = {}): Promise<MoveResult> {
  const ref = asked.trim()
  const board = linkedBoard(location, true)
  const current = localTaskTarget(location)
  const currentRef = current && (ref === current.task || /^\d+$/.test(ref) && Number(ref) === current.number)
  if (currentRef && deliveryPhase() === 'implement') return refuse('Archive this task during Land.', 'conflict')
  if (!workspaceTask() && /^\d+$/.test(ref) && !board) {
    if (linked(location)) return refuse('Select the linked kanban folder with --board before archiving a local card.', 'invalid_link')
    const found = resolveBoard('archive', { board: location.board, dir: location.dir ?? null, cwd: location.cwd ?? process.cwd(), installHint: BOARD_LINK_HINT })
    useBoard(found, !!location.dir)
    return withCreationLock(() => withBoardLock(() => {
      const number = Number(ref)
      const archived = locateArchived(number)
      if (archived && !locate(number)) {
        const file = archived.kind === 'group' ? path.join(archived.target, 'root.md') : archived.target
        const { meta } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
        if (!meta?.archived || meta.rejected) return refuse('This task is not eligible for archive.', 'conflict')
        const receipt = activeDelivery(number) ? recoveredArchiveHandoff(number) : { archived_to: path.relative(found.root, archived.target) }
        recordDeliveryArchive(number)
        return { ...receipt, archive_status: 'archived' }
      }
      const result = cmdRemove(number, 'completed', { archivingTask: true })
      recordDeliveryArchive(number)
      return { ...result, archive_status: 'archived' }
    }))
  }
  const target = currentRef ? current.task : await taskRef(ref, location)
  const archive = async (id: string, input?: ArchiveInput) => {
    const result = requireResponse(requireTask(await cloud<Task>('POST', `/v1/tasks/${enc(id)}/archive`, input)),
      'confirmation that the task was archived', task => task.status === 'done')
    say(`Archived ${result.key}.`)
    return result
  }
  const archived = (task: Task) => ({ task: task.id, archive_status: 'archived' })
  const project = board && runnerProject(board)
  if (!board || !project) return archived(await archive(target))
  const task = requireTask(await cloud<Task>('GET', `/v1/tasks/${enc(target)}`))
  const number = numberOf(task.key)
  if (project !== task.project || !Number.isSafeInteger(number)) return archived(await archive(task.id))

  return withSyncLock(board, async () => {
    setBoardDir(board, path.resolve(board, '../..'))
    const own = task.id === workspaceTask()
    if (own && deliveryPhase() === 'implement') return refuse('Archive this task during Land.', 'conflict')
    const land = own && deliveryPhase() === 'land'
    const delivery = activeDelivery(number) ?? (land ? endedDelivery(String(number)) : undefined)
    const landing = delivery && landingOf(delivery)
    if (land && (!hasInPlaceArchiveCommit(number) || delivery?.targetBranch && !landing)) {
      return refuse('The saved implementation commit could not be verified. Apply it to the target branch and retry from Land.', 'conflict')
    }
    const found = (fs.existsSync(path.join(board, 'todo')) && locate(number)) || locateArchived(number)
    if (!found && land && task.status !== 'done') return refuse('The task card is missing from the Land workspace. Refresh the board and retry.', 'not_found')
    const file = found && (found.kind === 'group' ? path.join(found.target, 'root.md') : found.target)
    const input = file && task.status !== 'done' ? {
      ...await localArchiveInput(board, project, task.id, number, file),
      ...(delivery ? { delivery_id: delivery.deliveryId } : {}),
      ...(landing ? { landing } : {}),
    } : undefined
    const result = await archive(task.id, input)
    if (file || land) recordDeliveryArchive(number)
    const execution = executionOf()
    if (land && execution && result.last_job === execution.job && input?.card && input.delivery_id &&
        delivery?.worktree === path.join('.akb', 'worktrees', input.delivery_id, 'work') &&
        result.id === task.id && result.project === project && typeof result.card_version === 'number' &&
        (!landing || result.landing?.commit === landing.commit && result.landing.branch === landing.branch)) {
      try {
        saveDeliveryCleanupReceipt(path.resolve(board, '../..'), {
          project, task: task.id, card: number, deliveryId: input.delivery_id, seq: result.card_version,
        })
      } catch {
        warn('Could not save the delivery cleanup receipt. The archive was confirmed.')
      }
    }
    return archived(result)
  }, { migrateState: false })
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
  return taskReceipt(task)
}
export async function taskResume(id: string, location: TaskLocation = {}, runtime?: string): Promise<MoveResult> {
  const ref = await taskRef(id, location)
  const body = runtime === undefined ? undefined : { runtime: await resolveCloudRuntime(ref, runtime) }
  const task = requireTask(await cloud<Task>('POST', `/v1/tasks/${enc(ref)}/resume`, body))
  if (!['queued', 'running'].includes(task.status)) {
    const messages: Record<string, string> = {
      land_runtime_unavailable: 'The computer holding the saved work needs an available runtime. Configure one to resume Land.',
      operation_runtime_unavailable: 'The selected runtime is unavailable. Choose an available runtime and resume.',
    }
    const reason = messages[task.failure ?? ''] ?? (task.failure || (task.status === 'waiting_review' ? 'The task is waiting for review.' :
      ['done', 'cancelled'].includes(task.status) ? 'This task has finished.' : `The task is ${task.status}.`))
    return refuse(reason, task.status === 'failed' ? 'execution_failed' : 'conflict')
  }
  say(task.status === 'queued' ? `Resume queued for ${task.key}.` : `Resumed ${task.key}.`)
  return taskReceipt(task)
}

interface CloudRuntime { id: string; name: string; default?: boolean }

async function resolveCloudRuntime(task: string, asked: string): Promise<string> {
  const value = asked.trim()
  if (!value) die('Specify a runtime id or name.', { kind: 'bad-args', exitCode: 2 })
  if (value.startsWith('rt_')) return value
  const list = await cloud<{ data: CloudRuntime[] }>('GET', `/v1/tasks/${enc(task)}/runtimes?for=resume`)
  requireResponse(list, 'a list of runtimes', v => Array.isArray(v.data))
  const matches = list.data.filter(r => r.name === value || (r.default && value === 'Global default'))
  if (!matches.length) return refuse(`No runtime named "${value}".`, 'not_found')
  if (matches.length > 1) return refuse(`Multiple runtimes are named "${value}". Use its rt_... id instead.`, 'conflict')
  return matches[0]!.id
}

export async function taskStop(id: string, location: TaskLocation = {}): Promise<MoveResult> {
  const task = requireTask(await cloud<Task>('POST', `/v1/tasks/${enc(await taskRef(id, location))}/stop`))
  requireResponse(task, 'a stop receipt', value => ['running', 'queued', 'waiting_review', 'stopped'].includes(value.status))
  const stop_status = task.status === 'stopped' ? 'stopped' : 'requested'
  say(stop_status === 'stopped' ? `Stopped ${task.key}.` : `Stop requested for ${task.key}.`)
  return { ...taskReceipt(task), stop_status }
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
