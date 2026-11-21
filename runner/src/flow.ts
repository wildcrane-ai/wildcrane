import type { BoardRunSpend } from './recovery'
import { agentRecovery, clipDetail, clipSummary, makeFailure, MAX_RETRY_ATTEMPTS, readRetryPause, type ExecutionFailure, type FailureDetail, type RetryPause, type RetryRecord } from '../../cli/src/lib/agent/retry'
import { connectionStopped } from '../../cli/src/lib/agent/connection-process'
// A flow job (#2020): one board verb, run with the akb the Runner carries on the task's board
// and followed to its end — for `implement`, until the delivery has landed. A periodic agent's
// job (#2068) runs its own command the same way, on the project's board.

import { cloudLanguage } from '../../cli/src/lib/agent/language'
import { processesStopped, runMark } from '../../cli/src/lib/agent/stop'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { APPROVED_UI_DIR_ENV, approvedUiPreviews } from '../../cli/src/lib/agent/approved-ui'
import { SAVED_PREVIEW_FILE_ENV, SESSION_COST_ENV } from '../../cli/src/lib/agent/env'
import { EXECUTION_RUNTIMES_ENV, GLOBAL_ID, GLOBAL_NAME, type ExecutionRuntimes } from '../../cli/src/lib/agent/runtimes'
import type { DeliveryEnding, DeliveryStatus } from '../../cli/src/lib/agent/types'
import { parseFrontmatter } from '../../cli/src/lib/frontmatter'
import { asEvent, type RunEvent } from '../../cli/src/lib/agent/wire'
import { reviewOf as cardReviewOf } from '../../cli/src/lib/card-review'
import type * as api from './api'
import { RUNTIMES, type AgentJob, type AgentRuntime, type Flow, type Job, type JobReport, type RuntimeReport } from './api'
import { answerOf, runAkb, type Akb, type Ran } from './akb'
import { quoteArg } from '../../cli/src/lib/agent/argv'
import { RAW_ARGS_KEY } from '../../cli/src/lib/agent/harnesses/types'
import { LABELS, forks, providerKey, providerOf, secretKeys, settingKeys } from './runtimes'
import { runtimeCredentialsFile, secretsOf } from './secrets'
import { akbCardOf, cardAssetsDir, cardFile, findCard, mcpServersOf, pull, push, withBoard, workspaceOf, type McpServers, type TaskFolder } from './task-folder'
import { studioName } from '../../cli/src/lib/shared/board-files.ts'
import { pendingConflicts } from '../../cli/src/lib/shared/board-conflicts'
import { reviewAllows, reviewAuthorization } from '../../cli/src/lib/shared/review-plan'
import { stageApprovedUi } from './approved-ui'
import { stageSavedPreviews } from './saved-previews'
import { layOut, type Laid } from './triage'
import { removeLegacyKanbanSkill } from './kanban-skill'
import { installCommitHook } from '../../cli/src/lib/skill/hook'
import { syncBackoff, syncRefusal, syncStopped, type Sync, type SyncStep } from './sync-retry'

/** Why the runtime a job names cannot run here; null when it can. */
export function unavailable(wanted: Job['runtime'], reports: RuntimeReport[]): string | null {
  const report = reports.find((r) => r.name === wanted)
  if (!report?.installed) return `${LABELS[wanted]} is not installed on this computer.`
  if (report.loggedIn === false) return `${LABELS[wanted]} is not signed in on this computer.`
  return null
}

export interface FlowDeps {
  machineId: string
  akb: Akb
  runtimes: () => Promise<RuntimeReport[]>
  api: Pick<typeof api, 'readTask' | 'readRejections' | 'markReviewed'>
  /** How long stopping the job's board runs may take. */
  stopMs: number
}

export interface FlowIo {
  show: (text: string) => void
  event: (event: RunEvent) => void
  track: (child: ChildProcess) => void
  /** What stopping the job does beyond its own processes: the board runs it started. */
  onStop: (stop: () => Promise<void>) => void
  lost: () => boolean
  asked?: () => boolean
  diagnostic?: string
  executionRuntimes?: string
  repairDelivery?: boolean
  sync?: Sync
  syncBackoff?: (attempt: number) => number
  reconcileRetry?: {
    get: () => { attempt: number; at: number } | undefined
    set: (next: { attempt: number; at: number } | undefined) => void
  }
  starting?: () => void | Promise<void>
  flowRun?: import('./recovery').Checkpoint['flowRun']
}

const stopping = (io: FlowIo) => io.lost() || !!io.asked?.()
const attemptSync = <T>(io: FlowIo, step: SyncStep, operation: () => Promise<api.Call<T>>) => io.sync ? io.sync(step, operation) : operation()

function refusedSync(job: Job, problem: Extract<api.Call<unknown>, { ok: false }>): string {
  if (problem.code === 'stopped') return ''
  console.error('runner: task sync refused', { job: job.id, code: problem.code, error: problem.error })
  return syncRefusal(job, problem)
}


export type FlowEnd = { ok: true; report: JobReport; reviewed?: Laid } | { ok: false; reason: string; stopped?: boolean; exhausted?: boolean; failure?: ExecutionFailure; report?: JobReport }

type Delivery = { id?: string; status?: DeliveryStatus; commit?: string; branch?: string; ending?: DeliveryEnding }

interface Run extends BoardRunSpend {
  parentId?: string
  cloudExecution?: { job: string; machine: string }
  resumeId?: string
  pendingWrites?: boolean
  failure?: ExecutionFailure
  retryPause?: RetryPause
  retry?: { attempt: number; of: number; reason: string }
  retryHistory?: RetryRecord[]
  cleanup?: { status: string }
  agentPid?: number
  agentStartedAt?: number
  managedProcess?: boolean
  agentIdentity?: string
  action?: string
  status?: string
  deliveryId?: string
  result?: string
}

/** What the runs this job started spent, summed and split by runtime (#629), and the context window
 *  the latest one counting it left (#52); each part left out when none reported it. */
export function spentBy(runs: Run[], job: Pick<Job, 'runtime' | 'runtimeId' | 'agentRuntimes'>): Pick<JobReport, 'usage' | 'costUsd' | 'context' | 'runtimeCosts' | 'costIncomplete'> {
  const used = runs.filter((r) => r.usage)
  const costed = runs.filter((r) => typeof r.costUsd === 'number')
  const sum = (key: keyof api.Usage) => used.reduce((n, r) => n + (r.usage![key] || 0), 0)
  const context = runs
    .filter((r) => r.context?.used !== undefined && r.context.limit)
    .reduce<Run | undefined>((last, r) => (!last || (r.startedAt ?? 0) >= (last.startedAt ?? 0) ? r : last), undefined)?.context
  return {
    ...(used.length ? { usage: { input: sum('input'), cacheCreation: sum('cacheCreation'), cacheRead: sum('cacheRead'), output: sum('output') } } : {}),
    ...(costed.length ? { costUsd: costed.reduce((n, r) => n + r.costUsd!, 0), runtimeCosts: runtimeCosts(costed, job) } : {}),
    ...(costed.length && runs.some(r => r.costUsd === undefined || r.costIncomplete) ? { costIncomplete: true } : {}),
    ...(context ? { context: { used: context.used!, limit: context.limit! } } : {}),
  }
}

/** Each run's cost on the runtime it ran: a step's pick, or the job's own for every other run. */
function runtimeCosts(runs: Run[], job: Pick<Job, 'runtime' | 'runtimeId' | 'agentRuntimes'>): NonNullable<JobReport['runtimeCosts']> {
  const picks = Object.values(job.agentRuntimes ?? {})
  const out = new Map<string | null, { runtimeId: string | null; runtime: string; costUsd: number }>()
  for (const r of runs) {
    const pick = picks.find((p) => p.id === r.runtime)
    const runtimeId = pick ? pick.id : job.runtimeId ?? null
    const row = out.get(runtimeId) ?? { runtimeId, runtime: pick?.runtime ?? job.runtime, costUsd: 0 }
    row.costUsd += r.costUsd!
    out.set(runtimeId, row)
  }
  return [...out.values()]
}

/** 卡片当前是否待审，以及首个带选项的问题。 */
function reviewOf(file: string, questionsOnly = false): ReturnType<typeof cardReviewOf> {
  try {
    const meta = parseFrontmatter(fs.readFileSync(file, 'utf8')).meta
    return meta && (!questionsOnly || meta.questions?.length) ? cardReviewOf(meta) : null
  } catch {
    return null
  }
}

/** Whether the card holds a question for the user. */
function asks(file: string): boolean {
  try {
    return (parseFrontmatter(fs.readFileSync(file, 'utf8')).meta?.questions ?? []).length > 0
  } catch {
    return false
  }
}

/** The servers as a `--mcp-config` file, or null when there are none. */
export function mcpConfig(servers: McpServers, file: string): string | null {
  if (!Object.keys(servers).length) return null
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`)
  return file
}

/** The runtime's arguments that give this run, and no other, the studio's MCP servers (#2030):
 *  Claude Code reads them from a file, Codex as config overrides. A CLI that talks takes the file
 *  as its `mcpConfig` setting instead; Kimi Code and ZCode take none. */
export function mcpArgs(runtime: Job['runtime'], servers: McpServers, file: string): string {
  const named = Object.entries(servers)
  if (!named.length || (runtime !== 'claude-code' && runtime !== 'codex')) return ''
  if (runtime === 'claude-code') return `--mcp-config ${quoteArg(mcpConfig(servers, file)!)}`
  return named
    .flatMap(([name, s]) => [
      `-c 'mcp_servers.${name}.command=${JSON.stringify(s.command)}'`,
      ...(s.args?.length ? [`-c 'mcp_servers.${name}.args=${JSON.stringify(s.args)}'`] : []),
    ])
    .join(' ')
}

const MCP_KEY = 'mcpConfig'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Stop the runs on card `id` started since `since` (0: all of them), until none is left or `ms`
 *  passed. A delivery can start its next run between two reads, so it reads again. `run stop`
 *  pauses a delivery and keeps its worktree; its sub-runs end with it. */
async function stopRuns(akb: Akb, ws: TaskFolder, id: number, since: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  const call = (args: string[]) => runAkb(akb, [...args, '--board', ws.board], { cwd: ws.cwd, board: ws.board })
  while (Date.now() < until) {
    const runs = answerOf<{ runs?: (Run & { status?: string; agentPid?: number; agentStartedAt?: number; managedProcess?: boolean; agentIdentity?: string })[] }>(await call(['raw', 'run', 'list', '--card', String(id), '--all', '--json']))?.runs
    const live = (runs ?? []).filter((r) => r.status === 'running' && (r.startedAt ?? 0) >= since)
    if (!runs) return false
    if (!live.length && (runs ?? []).filter((r) => (r.startedAt ?? 0) >= since).every((r) =>
      (r.managedProcess ? connectionStopped(r.agentPid ? { pid: r.agentPid, identity: r.agentIdentity } : undefined) : processesStopped(runMark(r.sessionId, r.startedAt), r.agentPid && r.agentStartedAt ? { pid: r.agentPid, since: r.agentStartedAt } : undefined)))) return true
    for (const r of live) await call(['raw', 'run', 'stop', r.sessionId])
    await wait(250)
  }
  return false
}

/** The cards a job in this process works on, by board, with how many jobs hold each. */
const working = new Map<string, number>()
const workKey = (ws: TaskFolder, id: number) => `${ws.board}#${id}`

/** Stop the runs a force-quit Runner left on card `id` (#2120): a Runner's board is only the
 *  Runner's, so any run there that no job in this process holds has nobody to report to. */
export async function stopLeftBehind(akb: Akb, ws: TaskFolder, id: number, ms: number): Promise<void> {
  if (!working.has(workKey(ws, id)) && !await stopRuns(akb, ws, id, 0, ms)) {
    throw new Error('未能停止上次运行，请等待其停止后续跑。')
  }
}

/** The deliveries on card `id` whose worktree is still here. */
function checkoutsOf(ws: TaskFolder, id: number): string[] {
  const dir = path.join(ws.board, 'deliveries')
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  return names.flatMap((n) => {
    try {
      const held = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as { deliveryId?: string; cardId?: number; worktree?: string }
      return held.cardId === id && held.deliveryId ? [held.deliveryId] : []
    } catch {
      return []
    }
  })
}

/** A resume refusal meaning there is no delivery to carry on, so the card is built afresh. */
const FRESH_BUILD = new Set(['deliveryNotFound', 'deliveryCancelled', 'deliveryFinished'])

/** What the task page says when a resume cannot go on, with the button to press next. */
const RESUME_REFUSED: Record<string, string> = {
  deliveryHeld: '另一次构建正在处理这张卡，请等它结束后再点「续跑」。',
  deliveryTakenOver: '这张卡已由新的一次构建接手，请查看最新的执行。',
  deliveryRunGoing: '上次的运行还没停下，请稍后再点「续跑」。',
  deliveryCardGone: '这张卡已不在看板上，没有可续跑的内容，请点「重新发起」。',
}

const isArchived = (ws: TaskFolder, id: number) =>
  path.relative(ws.board, findCard(ws.board, id) ?? ws.board).split(path.sep)[0] === '.archive'

const refusal = (ran: Ran) => ran.last.replace(/^akb( raw)?: /, '').slice(0, 300) || 'akb stopped with an error.'
// Every line but stack frames, so a list of problems reaches the task page whole.
const reasonOf = (text?: string) => (text ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^at\s/.test(l)).join('\n').slice(0, 300) || undefined

/** What akb prints, as a terminal shows it: the JSON answer `--json` ends with gives back the
 *  prose it held, less the commands that only work on this computer. A line of
 *  `--follow --events` is an event, passed on as one (#2059). */
function logLines(show: (text: string) => void, event: (event: RunEvent) => void) {
  let held = ''
  const said = (line: string) => {
    if (line.startsWith('{"kind":')) {
      let parsed: RunEvent | undefined
      try {
        parsed = asEvent(JSON.parse(line))
      } catch {
        // not one after all
      }
      if (parsed) {
        event(parsed)
        return ''
      }
    }
    if (!line.startsWith('{"ok":')) return `${line}\n`
    let output = ''
    try {
      output = String((JSON.parse(line) as { output?: unknown }).output ?? '')
    } catch {
      return ''
    }
    return output.split('\n').filter((l) => !/^\s+(follow|stop) it:/.test(l)).map((l) => `${l}\n`).join('')
  }
  return {
    push: (chunk: string) => {
      const lines = (held + chunk).split('\n')
      held = lines.pop()!
      for (const line of lines) {
        const out = said(line)
        if (out) show(out)
      }
    },
    end: () => {
      const out = held ? said(held) : ''
      if (out) show(out)
    },
  }
}

/** akb, run on the task's board and followed to its end; with `task`, for that Cloud task. */
function boardAkb(job: Job, ws: TaskFolder, deps: FlowDeps, io: FlowIo, task?: string) {
  return async (args: string[], show = false, env?: NodeJS.ProcessEnv) => {
    const refused = (last: string): Ran => ({ code: 1, out: '', last })
    if (stopping(io)) return refused('Task preparation stopped.')
    const at = args.includes('--') ? args.indexOf('--') : args.length
    const full = [...args.slice(0, at), '--board', ws.board, ...args.slice(at)]
    const log = show ? logLines(io.show, io.event) : undefined
    if (show) await io.starting?.()
    if (stopping(io)) return refused('Task preparation stopped.')
    const ran = await runAkb(deps.akb, full, {
      cwd: ws.cwd, board: ws.board, task, language: cloudLanguage(job), show: log?.push, track: io.track,
      env: {
        ...env,
        [EXECUTION_RUNTIMES_ENV]: io.executionRuntimes,
        AI4KANBAN_SYNC_DIAGNOSTIC: io.diagnostic,
        AI4KANBAN_REVIEW_STAGES: job.flow?.review_stages ? JSON.stringify(job.flow.review_stages) : undefined,
        AI4KANBAN_TASK_REVIEW: job.taskReview ? JSON.stringify(job.taskReview) : undefined,
        AI4KANBAN_EXECUTION: JSON.stringify({ job: job.id, machine: deps.machineId }),
      },
    })
    log?.end()
    return ran
  }
}

/** The board made, brought up to Cloud and set to run on the job's runtime; the refusal when not. */
async function setUp(job: Job, ws: TaskFolder, deps: FlowDeps, io: FlowIo): Promise<string | null> {
  const akb = boardAkb(job, ws, deps, io)
  const runtime = job.runtime
  const missing = io.flowRun?.finished ? undefined : unavailable(runtime, await deps.runtimes())
  if (missing) return missing

  if (!fs.existsSync(path.join(ws.board, 'config.md'))) {
    const init = await akb(['raw', 'init'])
    if (init.code !== 0) return refusal(init)
  }
  removeLegacyKanbanSkill(ws.cwd)
  const hook = installCommitHook(ws.cwd, ws.board)
  if (hook.note) io.show(`${hook.note}\n`)
  const pulled = await attemptSync(io, 'prepare', () => pull(ws, deps.machineId, () => stopping(io)))
  if (!pulled.ok) {
    if (pulled.failure?.source === 'validation' || pulled.failure?.source === 'sync') io.diagnostic = pulled.failure.summary
    else if (pulled.code !== 'board_content_conflict') return refusedSync(job, pulled)
  }
  if (io.flowRun?.finished) return null
  const servers = mcpServersOf(ws)
  const mcpFile = path.join(ws.board, '.sync', `${ws.task}.${job.id}.mcp.json`)
  const runtimes: ExecutionRuntimes = {
    default: {
      id: GLOBAL_ID, name: GLOBAL_NAME, harness: runtime,
      ...runtimeSettings(runtime, job.model, job.settings ?? {}, job.runtimeId, servers, mcpFile),
    },
    picks: {},
    credentialsFile: runtimeCredentialsFile(),
  }
  if (job.agentRuntimes && !job.task) {
    const reports = await deps.runtimes()
    runtimes.picks = Object.fromEntries(Object.entries(job.agentRuntimes).map(([agent, r]) => [agent, pickRow(job, r, deps.machineId, reports, servers, mcpFile)]))
  }
  io.executionRuntimes = JSON.stringify(runtimes)
  return null
}

/** A runtime's settings with the model and the studio's MCP servers. */
function valuesOf(runtime: Job['runtime'], model: string | null | undefined, given: Record<string, string>, servers: McpServers, mcpFile: string): Record<string, string> {
  const values: Record<string, string> = { ...given, model: model ?? '' }
  if (settingKeys(runtime).includes(MCP_KEY)) values[MCP_KEY] = mcpConfig(servers, mcpFile) ?? given[MCP_KEY] ?? ''
  else values[RAW_ARGS_KEY] = [given[RAW_ARGS_KEY], mcpArgs(runtime, servers, mcpFile)].filter(Boolean).join(' ')
  return values
}

function runtimeSettings(runtime: Job['runtime'], model: string | null | undefined, given: Record<string, string>, credentialId: string | null | undefined, servers: McpServers, file: string) {
  const values = valuesOf(runtime, model, given, servers, file)
  const provider = providerKey(runtime)
  if (provider) values[provider] = providerOf(runtime, model, { settings: given, secrets: secretsOf(credentialId) }) ?? ''
  const privateKeys = new Set(secretKeys(runtime))
  const settings = Object.fromEntries(settingKeys(runtime).filter(key => !privateKeys.has(key) && values[key]).map(key => [key, values[key]!]))
  return { settings, ...(credentialId ? { credentialId } : {}) }
}

/** One step's runtime as the board takes it (#625); one this computer cannot run says why. */
export function pickRow(job: Job, r: AgentRuntime, machine: string, reports: RuntimeReport[], servers: McpServers, mcpFile: string) {
  const zh = cloudLanguage(job) === 'zh'
  const known = (RUNTIMES as readonly string[]).includes(r.runtime)
  const runtime = (known ? r.runtime : 'claude-code') as Job['runtime']
  const away = !known || r.runner !== machine
    ? (zh ? `所选运行时「${r.name}」不在这台电脑上。` : `The runtime "${r.name}" picked for this step is not on this computer.`)
    : unavailable(runtime, reports)
  if (away) return { id: r.id, name: r.name, harness: runtime, settings: {}, away }
  return { id: r.id, name: r.name, harness: runtime, ...runtimeSettings(runtime, r.model, r.settings, r.id, servers, mcpFile) }
}

function recoveryArgs(run: NonNullable<FlowIo['flowRun']>): string[] {
  return run.finished ? ['raw', 'run', 'log', run.id] : ['raw', 'run', 'resume', run.id, '--require-session']
}

function runsSpent(runs: Run[], since: number, job: Job, io: FlowIo): Run[] {
  const source = job.flow?.historical_recovery ? undefined : job.flow?.sync_recovery_of ?? job.syncRecoveryOf ?? io.flowRun?.from
  const current = runs.filter(r => r.cloudExecution?.job === job.id || !!source && r.cloudExecution?.job === source
    || !job.flow?.historical_recovery && r.sessionId === io.flowRun?.id || !r.cloudExecution && (r.startedAt ?? 0) >= since)
  // The CLI replaces an interrupted run record when it opens the resumed attempt.
  return [...new Map([...(job.flow?.historical_recovery ? [] : io.flowRun?.priorSpend ?? []), ...current].map(run => [run.sessionId, run])).values()]
}

/** A review of these archived tasks, each `<task>:<card>` (#2065, #165), on the project's board. */
export async function runReview(job: Job, ws: TaskFolder, tasks: string[], deps: FlowDeps, io: FlowIo): Promise<FlowEnd> {
  const since = Date.now()
  const failed = await setUp(job, ws, deps, io)
  if (failed) return { ok: false, reason: failed }
  const akb = boardAkb(job, ws, deps, io)
  const args = io.flowRun ? recoveryArgs(io.flowRun) : ['raw', 'memory', 'review', '--task', ...tasks]
  const ran = await akb([...args, '--follow', '--events', '--json'], true)
  if (io.lost()) return { ok: false, reason: '' }
  const answer = answerOf<{ result?: string; error?: { message?: string } }>(ran)
  if (ran.code !== 0) return { ok: false, reason: reasonOf(answer?.error?.message?.replace(/^run \S+ ended \w+: /, '')) ?? refusal(ran) }
  const runs = answerOf<{ runs?: Run[] }>(await akb(['raw', 'run', 'list', '--all', '--json']))?.runs ?? []
  return { ok: true, report: { ...(answer?.result?.trim() ? { reply: answer.result.trim() } : {}), ...spentBy(runsSpent(runs, since, job, io), job) } }
}

/** What the workspace's rejection review has not learned (#2067), laid out on the board,
 *  reviewed, sent back and marked learned. Its runs are answered, to count in what the job spent. */
async function reviewRejections(job: Job, ws: TaskFolder, deps: FlowDeps, io: FlowIo, refreshReview?: () => Promise<string | undefined>): Promise<{ runs: Run[]; failure?: string; laid?: Laid; session?: string }> {
  const workspace = workspaceOf(ws)
  if (!workspace) return { runs: [] }
  const read = await attemptSync(io, 'prepare', () => deps.api.readRejections(workspace))
  if (!read.ok) return { runs: [], failure: read.error }
  if ((!read.value.tasks.length && !read.value.triage.length) || stopping(io)) return { runs: [] }
  const since = Date.now()
  const akb = boardAkb(job, ws, deps, io)
  const directory = path.join(ws.board, '.sync')
  fs.mkdirSync(directory, { recursive: true })
  const scratch = fs.mkdtempSync(path.join(directory, 'rejection-review-'))
  try {
    const laid = layOut(scratch, read.value)
    const denied = await refreshReview?.()
    if (denied) return { runs: [], failure: denied }
    const ran = await akb(['raw', 'review-dismissals', '--follow', '--events', '--json'], true, { AI4KANBAN_REJECTION_INPUT: scratch })
    const runs = (answerOf<{ runs?: Run[] }>(await akb(['raw', 'run', 'list', '--all', '--json']))?.runs ?? []).filter((r) => (r.startedAt ?? 0) >= since)
    if (stopping(io)) return { runs }
    if (ran.code !== 0) return { runs, failure: refusal(ran) }
    return { runs, laid, session: answerOf<{ agentSession?: string }>(ran)?.agentSession }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}

/** Before a task is planned: leave unconfirmed reviews available for their scheduled pass. */
async function learnRejections(job: Job, ws: TaskFolder, deps: FlowDeps, io: FlowIo, refreshReview: () => Promise<string | undefined>): Promise<Run[]> {
  const { runs, failure, laid } = await reviewRejections(job, ws, deps, io, refreshReview)
  if (failure) console.error(`runner: rejections not learned: ${failure}`)
  if (laid && !stopping(io)) {
    const sent = await push(ws, { id: job.id, machineId: deps.machineId })
    const marked = sent.ok ? await deps.api.markReviewed(laid.tasks, laid.triage) : sent
    if (!marked.ok) console.error(`runner: rejections not learned: ${marked.error}`)
  }
  return runs
}

/** A project's periodic agent (#2068): its command on the project's board, followed to its end. */
export async function runAgent(job: Job & { agent: AgentJob }, ws: TaskFolder, deps: FlowDeps, io: FlowIo): Promise<FlowEnd> {
  const { name, studio, tasks } = job.agent
  if (studio) return { ok: false, reason: 'Studio roles no longer run on their own.' }
  const since = Date.now()
  const failed = await setUp(job, ws, deps, io)
  if (failed) return { ok: false, reason: failed }
  if (io.flowRun) {
    const args = recoveryArgs(io.flowRun)
    const akb = boardAkb(job, ws, deps, io)
    const ran = await akb([...args, '--follow', '--events', '--json'], true)
    if (ran.code !== 0 || stopping(io)) return { ok: false, reason: refusal(ran) }
    const answer = answerOf<{ result?: string; agentSession?: string }>(ran)
    const runs = answerOf<{ runs?: Run[] }>(await akb(['raw', 'run', 'list', '--all', '--json']))?.runs ?? []
    return { ok: true, report: { reply: answer?.result, session: answer?.agentSession,
      ...spentBy(runsSpent(runs, since, job, io), job) } }
  }
  if (name === 'review-dismissals') {
    const { runs, failure, laid, session } = await reviewRejections(job, ws, deps, io)
    if (io.lost()) return { ok: false, reason: '' }
    return failure ? { ok: false, reason: failure } : { ok: true, report: { session, ...spentBy(runs, job) }, reviewed: laid }
  }
  if (name === 'reflect' && !tasks?.length) return { ok: true, report: {} }
  const args = name === 'reflect' ? ['raw', 'reflect', '--cards', ...tasks!.map((t) => String(t.number))]
    : ['raw', ...(name === 'prune-memory' ? ['memory', 'prune'] : [name])]
  const akb = boardAkb(job, ws, deps, io, ws.cloudTask ?? undefined)
  // Listing reaps a run a stopped Runner left recorded as live, which would hold the agent for good.
  await akb(['raw', 'run', 'list', '--all', '--json'])
  const ran = await akb([...args, '--follow', '--events', '--json'], true)
  if (io.lost()) return { ok: false, reason: '' }
  const answer = answerOf<{ result?: string; agentSession?: string; error?: { message?: string } }>(ran)
  if (ran.code !== 0) return { ok: false, reason: reasonOf(answer?.error?.message?.replace(/^run \S+ ended \w+: /, '')) ?? refusal(ran) }
  const runs = answerOf<{ runs?: Run[] }>(await akb(['raw', 'run', 'list', '--all', '--json']))?.runs ?? []
  return { ok: true, report: { ...(answer?.agentSession ? { session: answer.agentSession } : {}), ...(answer?.result?.trim() ? { reply: answer.result.trim() } : {}), ...spentBy(runsSpent(runs, since, job, io), job) } }
}

/** The discussion a task came from (#2146), written in `dir` for the agent to read; its path. */
export function writeTranscript(job: Pick<Job, 'transcript'>, dir: string): string {
  if (!job.transcript) return ''
  const file = path.join(dir, 'discussion.md')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, `${job.transcript}\n`)
  return file
}

/** The request's pictures (#2182), laid in the card's asset folder and shown on it. */
export function pictures(job: Pick<Job, 'attachments'>, ws: TaskFolder, id: number): string {
  const dir = cardAssetsDir(ws, id)
  if (!job.attachments.length || !dir) return ''
  fs.mkdirSync(dir, { recursive: true })
  return job.attachments.map((a, i) => {
    const file = `${i + 1}-${path.basename(a.name).replace(/[^\w.-]+/g, '-')}`
    fs.writeFileSync(path.join(dir, file), Buffer.from(a.content, 'base64'))
    return `\n<Asset src=".assets/${id}/${file}" label="${a.name.replace(/["<>]/g, '') || file}" />\n`
  }).join('')
}

/** `raw create`'s flags for a task's card fields: `related` and `blocked_by` name only the cards
 *  still open on this board, as akb takes them. */
export function cardFlags(ws: TaskFolder, fields: api.CardFields | undefined): string[] {
  if (!fields) return []
  const open = (keys: string[] | undefined) => (keys ?? []).map((k) => Number(/(\d+)$/.exec(k)?.[1]))
    .filter((n) => n > 0 && n !== ws.number && findCard(ws.board, n)?.startsWith(path.join(ws.board, 'todo') + path.sep))
  const lists: [string, (string | number)[]][] = [['--modules', fields.modules ?? []], ['--related', open(fields.related)], ['--blocked-by', open(fields.blocked_by)]]
  return [
    ...(fields.priority ? ['--priority', fields.priority] : []),
    ...(fields.previews !== undefined ? ['--previews', fields.previews.join(',')] : []),
    ...lists.flatMap(([flag, list]) => list.length ? [flag, list.join(',')] : []),
  ]
}

export async function runFlow(job: Job & { flow: Flow }, ws: TaskFolder, deps: FlowDeps, io: FlowIo): Promise<FlowEnd> {
  const { flow } = job
  const since = Date.now()
  const fail = (reason: string): FlowEnd => ({ ok: false, reason })
  const akb = boardAkb(job, ws, deps, io, ws.task)
  const made = (ran: Ran): api.Call<number> => {
    const answer = answerOf<{ id?: number; error?: { message?: string; kind?: string } }>(ran)
    return ran.code === 0 && answer?.id ? { ok: true, value: answer.id } : { ok: false, error: answer?.error?.message ?? refusal(ran), code: answer?.error?.kind }
  }

  if (flow.verb === 'discard') return discardBuilds()
  if (io.flowRun?.failure) {
    const failure = io.flowRun.failure
    const failureDetail: FailureDetail = {
      summary: failure.summary,
      ...(failure.detail ? { detail: failure.detail } : {}),
      ...(failure.code ? { code: failure.code } : {}),
      source: failure.source,
      runtime: { connector: job.runtime, name: null, model: job.model ?? null },
      attempt: 1,
      maxAttempts: MAX_RETRY_ATTEMPTS,
      pauseReason: 'limit',
      safeToRetry: true,
      history: [],
    }
    return { ok: false, reason: failure.summary, exhausted: failure.code === 'retry_exhausted' || io.flowRun.retryPause === 'limit', failure, report: { ...spentBy(runsSpent([], since, job, io), job), failure: failureDetail } }
  }

  const hasReview = !!job.taskReview || flow.review_stages !== undefined
  const initial = job.taskReview && reviewAuthorization(job.taskReview, flow.review_stages)
  const skipPlan = initial ? initial.kind === 'unreviewed' : flow.skip_plan
  const verb = flow.verb === 'create' ? (skipPlan ? 'implement' : 'refine') : flow.verb
  const coding = verb === 'implement' && studioName(ws.studio ?? flow.studio ?? '') === 'coding'

  let currentTask: Extract<Awaited<ReturnType<typeof api.readTask>>, { ok: true }>['value'] | undefined

  async function refreshReview(): Promise<string | undefined> {
    if (!hasReview) return
    const current = await attemptSync(io, 'review', () => deps.api.readTask(ws.task))
    if (!current.ok) return refusedSync(job, current)
    const review = current.value.review
    if (!review || ['stopped', 'done', 'cancelled'].includes(current.value.status ?? '')) {
      return 'This execution no longer has review authorization.'
    }
    const authorization = reviewAuthorization(review, flow.review_stages, flow.review_revision)
    if (authorization.kind === 'changed' || verb === 'refine' && !reviewAllows(authorization, verb)) {
      return 'Review authorization changed. Read the task again.'
    }
    if (verb === 'implement' && !reviewAllows(authorization, verb)) return 'Finish the agreed review stages before delivery.'
    job.taskReview = review
    currentTask = current.value
  }

  let previewDirectory: string | undefined
  let stagedUiRevision: number | undefined

  async function launch(args: string[], show = false, env?: NodeJS.ProcessEnv): Promise<Ran & { reviewRefused?: string }> {
    const denied = await refreshReview()
    const refuse = (reason: string) => ({ code: 1, out: '', last: reason, reviewRefused: reason })
    if (denied || stopping(io)) return { code: 1, out: '', last: denied || 'Task preparation stopped.', reviewRefused: denied }
    const review = job.taskReview
    const task = currentTask
    const startsDelivery = ['delivery resume', 'run resume', 'card implement'].includes(args.slice(1, 3).join(' '))
    if (review && verb === 'implement' && startsDelivery) {
      const inputs = task?.preview_inputs
      const previews = coding ? approvedUiPreviews(review) : []
      let saved: string | undefined
      if (inputs || previews.length) {
        previewDirectory ??= fs.mkdtempSync(path.join(os.tmpdir(), 'wildcrane-previews-'))
        const directory = previewDirectory
        if (previews.length) {
          const uiDirectory = path.join(directory, 'approved-ui')
          if (stagedUiRevision !== review.revision) {
            const staged = await attemptSync(io, 'review', () => stageApprovedUi(uiDirectory, previews, () => stopping(io), cloudLanguage(job) === 'zh'))
            if (!staged.ok) {
              const reason = refusedSync(job, staged)
              return refuse(reason && staged.error)
            }
            stagedUiRevision = review.revision
          }
          env = { ...env, [APPROVED_UI_DIR_ENV]: uiDirectory }
        }
        if (inputs) {
          const staged = await attemptSync(io, 'review', () => stageSavedPreviews(directory, inputs, review.plan, () => stopping(io),
            review.preview_definitions?.map(p => p.id), previews.map(preview => preview.id)))
          if (!staged.ok) return refuse(refusedSync(job, staged))
          saved = staged.value
        }
      }
      if (saved || previews.length) {
        const changed = await refreshReview()
        if (changed) return refuse(changed)
        if (job.taskReview?.revision !== review.revision) return refuse('Review authorization changed. Read the task again.')
        if (saved && (currentTask?.card_version !== task?.card_version || !isDeepStrictEqual(currentTask?.preview_inputs, inputs))) {
          return refuse('The saved Previews changed. Read the task again.')
        }
        if (saved) env = { ...env, [SAVED_PREVIEW_FILE_ENV]: saved }
      }
    }
    return akb(args, show, env)
  }

  const failed = await setUp(job, ws, deps, io)
  if (failed) return fail(failed)

  let id = akbCardOf(ws)
  const existedBeforeCreate = flow.verb !== 'create' || !!id
  // An unplanned build (#2139) has no plan for the review to inform.
  const learned = flow.verb === 'create' && !id && !skipPlan ? await learnRejections(job, ws, deps, io, refreshReview) : []
  if (io.lost()) return fail('')
  if (flow.verb === 'create' && !id) {
    // Cloud sends the title and the request with the job; the task is read only when it did not.
    let said = { title: flow.title?.trim() ?? '', request: flow.text?.trim() ?? '' }
    if (!said.title) {
      const task = await attemptSync(io, 'review', () => deps.api.readTask(ws.task))
      if (!task.ok) return fail(refusedSync(job, task))
      said = { title: task.value.title?.trim() ?? '', request: task.value.request?.trim() ?? '' }
    }
    const title = said.title || 'Untitled'
    const body = path.join(ws.board, '.sync', `${ws.task}.request.md`)
    fs.mkdirSync(path.dirname(body), { recursive: true })
    // The card takes the task's number (#2063), and no other.
    if (!ws.number) return fail('This task has no number yet.')
    const created = await withBoard(ws, async () => {
      const existing = akbCardOf(ws)
      if (existing) return { ok: true as const, value: existing }
      fs.writeFileSync(body, `${said.request || title}\n${pictures(job, ws, ws.number!)}`)
      return akb(['raw', 'create', '--title', title, '--studio', studioName(flow.studio), '--body-file', body,
        '--id', String(ws.number), ...cardFlags(ws, flow.metadata), '--json']).then(made).finally(() => fs.rmSync(body, { force: true }))
    }, () => stopping(io))
    if (!created || stopping(io)) return fail('')
    if (!created.ok) return fail(created.error)
    id = created.value
  }
  if (flow.verb === 'create' && id && !stopping(io)) {
    const card = id
    const sent = await attemptSync(io, 'create', async () => await withBoard(ws, async (send): Promise<api.Call<FlowEnd | undefined>> => {
      const claim = { id: job.id, machineId: deps.machineId }
      const result = await send(claim)
      if (result.ok) return { ok: true, value: undefined }
      if (result.conflict && pendingConflicts(ws.board).length) {
        const ended = await onCard(card)
        if (ended.ok && !stopping(io) && !pendingConflicts(ws.board).length) await send(claim)
        return { ok: true, value: ended }
      }
      return { ok: false, error: result.error, code: result.offline ? undefined : result.code ?? 'refused', failure: result.failure }
    }, () => stopping(io)) ?? syncStopped)
    if (!sent.ok) return fail(refusedSync(job, sent))
    if (sent.value) return sent.value
  }
  if (stopping(io)) return fail('')
  if (!id) return fail('This task has no card on this computer.')
  return onCard(id)

  async function reconcileDelivery(card: number): Promise<
    | { kind: 'running'; deliveryId?: string; sessionId: string; action?: string }
    | { kind: 'completed'; deliveryId: string; sessionId?: string; commit?: string; branch?: string }
    | { kind: 'resumable'; deliveryId: string; status?: string; sessionId?: string; hasSession?: boolean }
    | { kind: 'none' }
    | { kind: 'unverified'; deliveryId?: string; diagnostic: string }
  > {
    const MAX_ATTEMPTS = 3
    let attempt = io.reconcileRetry?.get()?.attempt ?? 0
    for (;;) {
      const ran = await akb(['raw', 'delivery', 'reconcile', String(card), '--json'])
      if (stopping(io)) return { kind: 'none' }
      const parsed = answerOf<{
        kind?: string
        deliveryId?: string
        sessionId?: string
        action?: string
        commit?: string
        branch?: string
        status?: string
        hasSession?: boolean
        diagnostic?: string
        error?: { message?: string }
      }>(ran)
      if (ran.code === 0 && parsed?.kind && ['running', 'completed', 'resumable', 'none'].includes(parsed.kind)) {
        io.reconcileRetry?.set(undefined)
        return parsed as
          | { kind: 'running'; deliveryId?: string; sessionId: string; action?: string }
          | { kind: 'completed'; deliveryId: string; sessionId?: string; commit?: string; branch?: string }
          | { kind: 'resumable'; deliveryId: string; status?: string; sessionId?: string; hasSession?: boolean }
          | { kind: 'none' }
      }
      const diagnostic = parsed?.diagnostic ?? parsed?.error?.message ?? refusal(ran)
      attempt += 1
      if (attempt >= MAX_ATTEMPTS) {
        io.reconcileRetry?.set(undefined)
        return { kind: 'unverified', deliveryId: parsed?.deliveryId, diagnostic }
      }
      const delay = Math.min(5_000, (io.syncBackoff ?? syncBackoff)(attempt))
      const at = Date.now() + delay
      io.reconcileRetry?.set({ attempt, at })
      if (delay > 0) await wait(delay)
      if (stopping(io)) return { kind: 'none' }
    }
  }

  async function onCard(card: number): Promise<FlowEnd> {
    // Held before the sweep, so a job here that starts meanwhile never sweeps this one's runs.
    const key = workKey(ws, card)
    const held = working.get(key) ?? 0
    working.set(key, held + 1)
    try {
      const reconciled = !io.flowRun && !held && existedBeforeCreate ? await reconcileDelivery(card) : undefined
      if (io.lost()) return fail('')
      if (reconciled?.kind === 'unverified') {
        io.show(`[recovery] delivery reconciliation unverified${reconciled.deliveryId ? ` (delivery ${reconciled.deliveryId})` : ''}: ${reconciled.diagnostic}\n`)
        const runs = answerOf<{ runs?: Run[] }>(await akb(['raw', 'run', 'list', '--card', String(card), '--all', '--json']))?.runs ?? []
        return {
          ok: false,
          reason: 'task_recovery_unverified',
          failure: makeFailure('validation', 'task_recovery_unverified', { code: 'task_recovery_unverified' }),
          report: spentBy([...new Map([...learned, ...runsSpent(runs, since, job, io)].map(r => [r.sessionId, r])).values()], job),
        }
      }
      if (reconciled?.kind === 'completed') {
        const denied = await refreshReview()
        if (denied) return fail(denied)
        if (io.lost()) return fail('')
        const runs = answerOf<{ runs?: Run[] }>(await akb(['raw', 'run', 'list', '--card', String(card), '--all', '--json']))?.runs ?? []
        const spent = spentBy([...new Map([...learned, ...runsSpent(runs, since, job, io)].map(r => [r.sessionId, r])).values()], job)
        return {
          ok: true,
          report: {
            ...spent,
            card,
            deliveryCompleted: true,
            deliveryId: reconciled.deliveryId,
            ...(reconciled.commit ? { landing: { commit: reconciled.commit, branch: reconciled.branch ?? '' } } : {}),
          },
        }
      }
      if (reconciled?.kind === 'running') {
        const denied = await refreshReview()
        if (denied) return fail(denied)
        if (io.lost()) return fail('')
      } else if (!held && !await stopRuns(deps.akb, ws, card, 0, deps.stopMs)) {
        return fail('未能停止上次运行，请等待其停止后续跑。')
      }
      if (io.lost()) return fail('')
      const ended = await workOn(card, reconciled)
      if (ended.ok && !coding && flow.verb === 'create' && verb === 'implement' && job.taskReview &&
        reviewAuthorization(job.taskReview).kind === 'unreviewed' && !ended.report.review) ended.report.deliveryCompleted = true
      return ended
    } finally {
      if (previewDirectory) fs.rmSync(previewDirectory, { recursive: true, force: true })
      fs.rmSync(path.join(ws.board, '.sync', `${ws.task}.discussion`), { recursive: true, force: true })
      const left = working.get(key)! - 1
      if (left) working.set(key, left)
      else working.delete(key)
    }
  }

  async function workOn(id: number, reconciled?: Awaited<ReturnType<typeof reconcileDelivery>>): Promise<FlowEnd> {
    io.onStop(async () => {
      if (!await stopRuns(deps.akb, ws, id, since, deps.stopMs)) throw new Error('未能确认原执行已停止。')
    })

    const text = flow.verb === 'create' ? '' : (flow.text ?? '').trim()
    // A resume follows where the card actually is, not the step the last job was on.
    const archived = !io.flowRun && flow.resume && isArchived(ws, id)
    if (archived && (!coding || parseFrontmatter(fs.readFileSync(cardFile(ws), 'utf8')).meta?.rejected)) {
      return { ok: true, report: { card: id, ...(coding ? { deliveryCompleted: false } : {}) } }
    }
    if (!io.flowRun && flow.resume && verb === 'refine' && !hasReview && (!reconciled || reconciled.kind === 'none')) {
      const review = reviewOf(cardFile(ws))
      if (review) return { ok: true, report: { card: id, ...(review === true ? {} : { review }) } }
    }
    // A build held on a question carries on with the answer: resolved first, else handed to the
    // build as its note. A resumed one (#2128) resolved it already, and puts an ended delivery
    // back to work first.
    let note = verb === 'resolve' || verb === 'revise' ? text : ''
    const isRejected = () => isArchived(ws, id) && parseFrontmatter(fs.readFileSync(cardFile(ws), 'utf8')).meta?.rejected === true
    let ran: Awaited<ReturnType<typeof launch>> | undefined
    let continuation: string[] | undefined
    let expectedDelivery: string | undefined
    let effectiveVerb = verb
    let effectiveCoding = coding
    const resumeExistingDelivery = async () => {
      const restored = await launch(['raw', 'delivery', 'resume', String(id), '--json'])
      if (restored.reviewRefused) return fail(restored.reviewRefused)
      const resumed = answerOf<{ landed?: boolean; deliveryId?: string; sessionId?: string; delivery?: Delivery; error?: { message?: string; reason?: string; args?: { id?: string } } }>(restored)
      if (io.lost()) return fail('')
      if (restored.code === 0 && resumed?.landed && resumed.deliveryId) {
        return { ok: true as const, report: { card: id, ...(effectiveCoding ? { deliveryCompleted: true, deliveryId: resumed.deliveryId, ...landingOf(resumed.delivery) } : {}) } }
      }
      const reason = restored.code === 0 ? undefined : resumed?.error?.reason
      // No delivery left to carry on: build afresh, and the builder picks up what is on disk.
      if (reason && reason !== 'deliveryActive' && !FRESH_BUILD.has(reason)) {
        return fail(RESUME_REFUSED[reason] ?? resumed?.error?.message ?? refusal(restored))
      }
      if (archived && reason && FRESH_BUILD.has(reason)) return { ok: true as const, report: { card: id, deliveryCompleted: false } }
      const deliveryId = reason && reason !== 'deliveryActive' ? undefined : resumed?.deliveryId ?? resumed?.error?.args?.id
      expectedDelivery = deliveryId
      if (resumed?.sessionId) {
        continuation = ['raw', 'run', 'log', resumed.sessionId]
      } else if (deliveryId) {
        const previous = answerOf<{ runs?: Run[] }>(await akb(['raw', 'run', 'list', '--card', String(id), '--all', '--json']))?.runs
          ?.filter((r) => ['implement', 'conflict', 'hook'].includes(r.action ?? '') && r.deliveryId === deliveryId)
          .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
        // With no run to rejoin, a fresh build run works inside the same delivery.
        if (previous) {
          continuation = ['raw', 'run', 'resume', previous.sessionId, '--require-session']
        }
      }
      return undefined
    }
    if (io.flowRun) {
      continuation = io.repairDelivery ? ['raw', 'run', 'resume', io.flowRun.id, '--require-session'] : recoveryArgs(io.flowRun)
    } else if (reconciled?.kind === 'running') {
      expectedDelivery = reconciled.deliveryId
      continuation = ['raw', 'run', 'log', reconciled.sessionId]
    } else if (reconciled?.kind === 'resumable') {
      const denied = hasReview ? await refreshReview() : undefined
      if (denied) return fail(denied)
      const reviewAllowsImplement = !hasReview || (!!currentTask?.review && reviewAllows(reviewAuthorization(currentTask.review, flow.review_stages, flow.review_revision), 'implement'))
      const hasOpenQuestions = asks(cardFile(ws))
      const continueDelivery = verb === 'implement' || (!flow.replan && ['refine', 'revise', 'create'].includes(verb) && reviewAllowsImplement && !hasOpenQuestions)
      if (continueDelivery) {
        effectiveVerb = 'implement'
        effectiveCoding = studioName(ws.studio ?? flow.studio ?? '') === 'coding'
        const done = await resumeExistingDelivery()
        if (done) return done
      } else {
        const released = await akb(['raw', 'delivery', 'release', String(id), '--json'])
        if (released.code !== 0) {
          io.show(`[recovery] failed to release delivery lock${reconciled.deliveryId ? ` (delivery ${reconciled.deliveryId})` : ''}: ${refusal(released)}\n`)
          return {
            ok: false,
            reason: 'task_recovery_unverified',
            failure: makeFailure('validation', 'task_recovery_unverified', { code: 'task_recovery_unverified' }),
          }
        }
      }
    } else if (verb === 'implement' && flow.resume) {
      const done = await resumeExistingDelivery()
      if (done) return done
    } else if (verb === 'implement' && text) {
      const resolved = await launch(['raw', 'card', 'resolve', String(id), '--follow', '--events', '--json', '--', text], true)
      if (resolved.reviewRefused) return fail(resolved.reviewRefused)
      if (io.lost()) return fail('')
      if (isRejected()) ran = resolved
      else if (resolved.code !== 0) note = text
      else if (asks(cardFile(ws))) {
        const review = reviewOf(cardFile(ws), hasReview)
        return { ok: true, report: { card: id, ...(coding ? { deliveryCompleted: false } : {}), ...(review && review !== true ? { review } : {}) } }
      }
    }
    if (effectiveVerb === 'revise' && !text) return fail('Say what to change.')
    const fresh = (fromTranscript = false) => {
      const carry = carryArgs(effectiveVerb, fromTranscript)
      const costFrom = carry.includes('--session') && typeof job.resumeCostUsd === 'number' ? { [SESSION_COST_ENV]: String(job.resumeCostUsd) } : undefined
      return launch(['raw', 'card', effectiveVerb, String(id), '--follow', '--events', '--json', ...carry, ...(note ? ['--', note] : [])], true, costFrom)
    }
    ran ??= await (continuation ? launch([...continuation, '--follow', '--events', '--json'], true) : fresh())
    if (ran.reviewRefused) return fail(ran.reviewRefused)
    if (io.lost()) return fail('')
    type Ended = {
      ok?: boolean
      result?: string
      lastSessionId?: string
      agentSession?: string
      delivery?: Delivery
      error?: { message?: string; result?: string; lastSessionId?: string; agentSession?: string; delivery?: Delivery }
    }
    const readRuns = async () => answerOf<{ runs?: Run[] }>(await akb(['raw', 'run', 'list', '--card', String(id), '--all', '--json']))?.runs ?? []
    const lastRun = (answer: Ended | null) => answer?.lastSessionId ?? answer?.error?.lastSessionId
    let answer = answerOf<Ended>(ran)
    let runs = await readRuns()
    if (ran.code !== 0 && !continuation && job.fork && job.transcript && !stopping(io) &&
        runs.some(run => run.sessionId === lastRun(answer) && run.failure?.code === 'codex_fork_source_missing')) {
      ran = await fresh(true)
      if (ran.reviewRefused) return fail(ran.reviewRefused)
      if (io.lost()) return fail('')
      answer = answerOf<Ended>(ran)
      runs = await readRuns()
    }
    const delivery = answer?.delivery ?? answer?.error?.delivery
    if (expectedDelivery && delivery?.id && delivery.id !== expectedDelivery) {
      return fail('续跑返回了其他交付的结果，原交付保持未完成。')
    }
    const last = lastRun(answer)
    const recent = runs.find(r => r.sessionId === last) ?? runs.filter(r => !r.parentId && r.cloudExecution?.job === job.id).at(-1)
    const spent = spentBy([...new Map([...learned, ...runsSpent(runs, since, job, io)].map(run => [run.sessionId, run])).values()], job)
    const rejected = isRejected()
    if (effectiveVerb === 'implement' && !rejected) {
      const ending = delivery?.ending
      if (ending?.kind === 'stopped') return { ok: false, reason: '', stopped: true }
      if (ending?.kind === 'discarded') return fail('The build was discarded.')
      if (ending?.kind === 'blocked') return { ok: false, reason: ending.reason, report: spent }
    }
    const asked = effectiveVerb === 'implement' && !rejected && asks(cardFile(ws))
    const completed = !rejected && !asked && delivery?.status === 'finished' ? delivery.id : undefined
    const waiting = rejected ? null : reviewOf(cardFile(ws), hasReview)
    const review = waiting && waiting !== true ? waiting : undefined
    // A build held on the user's question is reported as one, like a plan's.
    if (!rejected && ran.code !== 0 && !(effectiveCoding && completed) && !(effectiveVerb === 'refine' && waiting) && !(answer?.error && asked)) {
      const failure = recent?.failure
      const rawReason = failure?.summary ?? reasonOf(answer?.error?.message?.replace(/^run \S+ ended \w+: /, '')) ?? refusal(ran)
      const pause = readRetryPause(recent?.retryPause) ?? 'limit'
      const history = recent?.retryHistory ?? []
      const lastAction = history.at(-1)?.sessionAction
      const failureDetail: FailureDetail = {
        summary: clipSummary(rawReason) || 'The run failed.',
        ...(failure?.detail ? { detail: failure.detail } : rawReason.length > 300 ? { detail: clipDetail(rawReason) } : {}),
        ...(failure?.code ? { code: failure.code } : {}),
        source: failure?.source ?? 'runtime',
        runtime: { connector: job.runtime, name: null, model: job.model ?? null },
        attempt: recent?.retry?.attempt ?? (history.length || 1),
        maxAttempts: recent?.retry?.of ?? MAX_RETRY_ATTEMPTS,
        pauseReason: pause,
        safeToRetry: pause !== 'unsafe' && lastAction !== 'pause_unsafe',
        ...(lastAction ? { sessionAction: lastAction } : {}),
        history,
      }
      return {
        ok: false,
        reason: rawReason,
        exhausted: recent?.retryPause === 'limit',
        failure,
        report: { ...spent, failure: failureDetail },
      }
    }
    if (effectiveCoding && !rejected && !completed && !asked && !waiting && delivery) {
      const reason = 'The Coding run exited without a delivery receipt. Verify the saved work and finish the original delivery.'
      return { ok: false, reason, failure: makeFailure('validation', reason, { code: 'delivery_incomplete', detail: reason }), report: spent }
    }
    const said = ((last ? runs.find((r) => r.sessionId === last)?.result : undefined) ?? answer?.result ?? answer?.error?.result)?.trim()
    const state = effectiveCoding ? { deliveryCompleted: !!completed, ...(completed ? { deliveryId: completed } : {}) }
      : effectiveVerb === 'implement' && delivery?.status === 'active' ? { review: {} } : {}
    const landing = (effectiveCoding ? completed : !rejected && ran.code === 0) ? landingOf(delivery) : {}
    const session = answer?.agentSession ?? answer?.error?.agentSession
    const retries = recent?.retryHistory?.length ? recent.retryHistory : undefined
    return { ok: true, report: { ...(said ? { reply: said } : {}), ...(session ? { session } : {}), ...spent, ...(retries ? { retries } : {}), card: id, ...state, ...(review ? { review } : {}), ...landing } }
  }

  /** A discarded build (#61): every delivery on the card still holding a checkout gives it up. */
  async function discardBuilds(): Promise<FlowEnd> {
    const pulled = await attemptSync(io, 'prepare', () => pull(ws, deps.machineId, () => stopping(io)))
    if (!pulled.ok) return fail(refusedSync(job, pulled))
    const card = akbCardOf(ws) ?? flow.card
    if (!card) return { ok: true, report: {} }
    for (const delivery of checkoutsOf(ws, card)) {
      const ran = await akb(['raw', 'delivery', 'cancel', delivery, '--json'], true)
      if (ran.code !== 0) return fail(refusal(ran))
    }
    return { ok: true, report: { card } }
  }

  /** Planning carries the discussion's session and transcript; an immediate build carries only the transcript. */
  function carryArgs(verb: string, fromTranscript: boolean): string[] {
    if (flow.replan) return ['--new-session']
    if (verb === 'implement' && flow.verb === 'create') {
      const transcript = writeTranscript(job, path.join(ws.board, '.sync', `${ws.task}.discussion`))
      return transcript ? ['--transcript', transcript] : []
    }
    if (!['refine', 'resolve', 'revise'].includes(verb)) return []
    const transcript = writeTranscript(job, path.join(ws.board, '.sync', `${ws.task}.discussion`))
    const freshSession = fromTranscript || (job.fork && !forks(job.runtime))
    return [
      ...(freshSession ? ['--new-session'] : job.resume ? ['--session', job.resume, ...(job.fork ? ['--fork'] : [])] : []),
      ...(transcript ? ['--transcript', transcript] : []),
    ]
  }
}

function landingOf(delivery?: Delivery): Pick<JobReport, 'landing'> {
  return delivery?.commit ? { landing: { commit: delivery.commit, branch: delivery.branch ?? '' } } : {}
}

export async function confirmFlowStopped(ws: TaskFolder, job: Job, deps: FlowDeps): Promise<boolean> {
  const id = akbCardOf(ws) ?? job.number
  if (!id) return false
  const ran = await runAkb(deps.akb, ['raw', 'run', 'list', '--card', String(id), '--all', '--json', '--board', ws.board], { cwd: ws.cwd, board: ws.board })
  const runs = answerOf<{ runs?: { sessionId: string; status?: string; startedAt?: number; agentPid?: number; agentStartedAt?: number; managedProcess?: boolean; agentIdentity?: string }[] }>(ran)?.runs
  return !!runs && runs.every((r) => r.status !== 'running' && (r.managedProcess ? connectionStopped(r.agentPid ? { pid: r.agentPid, identity: r.agentIdentity } : undefined) : processesStopped(runMark(r.sessionId, r.startedAt),
    r.agentPid && r.agentStartedAt ? { pid: r.agentPid, since: r.agentStartedAt } : undefined)))
}

export async function flowRunEvidence(ws: TaskFolder, job: Job, deps: FlowDeps, execution = job.id,
  prior?: FlowIo['flowRun']): Promise<{ stopped: boolean; run?: FlowIo['flowRun'] }> {
  const id = job.flow && (akbCardOf(ws) ?? job.number)
  if (job.flow && !id) return { stopped: false }
  const akb = boardAkb(job, ws, deps, { show() {}, event() {}, track() {}, onStop() {}, lost: () => false })
  const ran = await akb(['raw', 'run', 'list', '--all', '--json', ...(id ? ['--card', String(id)] : [])])
  const allRuns = answerOf<{ runs?: Run[] }>(ran)?.runs
  if (!allRuns) return { stopped: false }
  const owned = allRuns.filter(run => run.cloudExecution?.machine === deps.machineId
    && (run.cloudExecution.job === execution || run.sessionId === prior?.id && run.cloudExecution.job === prior.from))
  const deliveryIds = new Set(owned.map(r => r.deliveryId).filter((d): d is string => !!d))
  const runs = [...new Map([
    ...owned,
    ...allRuns.filter(run => !run.parentId && !!run.deliveryId && deliveryIds.has(run.deliveryId) && ['conflict', 'hook'].includes(run.action ?? '')),
  ].map(r => [r.sessionId, r])).values()]
  if (!runs.every(run => run.status !== 'running' && (run.managedProcess
    ? connectionStopped(run.agentPid ? { pid: run.agentPid, identity: run.agentIdentity } : undefined)
    : processesStopped(runMark(run.sessionId, run.agentStartedAt ?? run.startedAt),
      run.agentPid && run.agentStartedAt ? { pid: run.agentPid, since: run.agentStartedAt } : undefined)))) return { stopped: false }
  const candidates = runs
    .filter(run => !run.parentId)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const previous = candidates.find(run => run.cloudExecution?.job === execution)
    ?? candidates.find(run => run.sessionId === prior?.id)
    ?? candidates[0]
  if (!previous) return { stopped: true }
  const terminal = job.flow && previous.status === 'error' && previous.retryPause ? previous.failure : undefined
  const failure = terminal && previous.retryPause === 'limit' ? { ...terminal, code: terminal.code ?? 'retry_exhausted' } : terminal
  const recovery = agentRecovery({ stopped: true, completed: previous.status === 'done' || !!failure,
    session: previous.resumeId, unconfirmedCleanup: previous.pendingWrites || previous.cleanup?.status === 'unconfirmed' })
  if (recovery === 'unsafe') return { stopped: true }
  const { sessionId, runtime, startedAt, usage, costUsd, costIncomplete, context } = previous
  const priorSpend = new Map(prior?.priorSpend?.map(spend => [spend.sessionId, spend]))
  priorSpend.set(sessionId, { sessionId, runtime, startedAt, usage, costUsd, costIncomplete, context })
  return { stopped: true, run: { id: sessionId, finished: recovery === 'report', from: previous.cloudExecution?.job,
    ...(failure ? { failure } : {}), ...(previous.retryPause ? { retryPause: previous.retryPause } : {}), priorSpend: [...priorSpend.values()] } }
}
