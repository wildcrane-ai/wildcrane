import { assetRef } from '../../artifact-sdk/src/internal/task-assets'
import { REVIEW_SYNC_ENV } from '../../cli/src/lib/cloud/review-sync'
import { previewSyncBridge } from './reply-approval'
import { STUDIO_SNAPSHOT_ENV } from '../../cli/src/lib/agent/cloud-studios'
import type { BoardRunSpend } from './recovery'
import { agentRecovery, clipDetail, clipSummary, isSessionMissingFailure, makeFailure, MAX_RETRY_ATTEMPTS, mergeRetryHistory, planRetry, RETRY_FILE_ENV, readRetryPause, resumeBlocked, type ExecutionFailure, type FailureDetail, type RetryPause, type RetryRecord } from '../../cli/src/lib/agent/retry'
import { idleStopConfirmed, stoppedCleanupConfirmed } from '../../cli/src/lib/agent/wire/codex-background-types'
import { hasLiveCodexExecution, verifyCodexStopState, type CodexStopVerification } from '../../cli/src/lib/agent/wire/codex-verify'
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

import { DELIVERY_PHASE_ENV, SAVED_PREVIEW_FILE_ENV, SESSION_COST_ENV, TASK_REQUEST_ENV } from '../../cli/src/lib/agent/env'
import { EXECUTION_RUNTIMES_ENV, GLOBAL_ID, GLOBAL_NAME, type ExecutionRuntimes } from '../../cli/src/lib/agent/runtimes'
import { resumeSessionId } from '../../cli/src/lib/agent/sessions'
import type { DeliveryEnding, DeliveryStatus, RunRecord } from '../../cli/src/lib/agent/types'
import { parseFrontmatter } from '../../cli/src/lib/frontmatter'
import { asEvent, type RunEvent } from '../../cli/src/lib/agent/wire'
import { reviewOf as cardReviewOf } from '../../cli/src/lib/card-review'
import type * as api from './api'
import { RUNTIMES, type AgentJob, type AgentRuntime, type Flow, type Job, type JobReport, type RuntimeReport } from './api'
import { answerOf, runAkb, type Akb, type Ran } from './akb'
import { git } from '../../cli/src/lib/agent/worktree'
import { quoteArg } from '../../cli/src/lib/agent/argv'
import { RAW_ARGS_KEY } from '../../cli/src/lib/agent/harnesses/types'
import { LABELS, forks, providerKey, providerOf, secretKeys, settingKeys } from './runtimes'
import { runtimeCredentialsFile, secretsOf } from './secrets'
import { akbCardOf, cardAssetsDir, cardFile, findCard, mcpServersOf, pull, push, withBoard, workspaceOf, type McpServers, type TaskFolder } from './task-folder'
import { studioName } from '../../cli/src/lib/shared/board-files.ts'
import { projectStateDir } from '../../cli/src/lib/machine/project'
import { pendingConflicts } from '../../cli/src/lib/shared/board-conflicts'
import { isFlatReviewPlan, isWaitingReview, reviewAllows, reviewAuthorization } from '../../cli/src/lib/shared/review-plan'
import { stageSavedPreviews } from './saved-previews'
import { layOut, type Laid } from './triage'
import { removeLegacyKanbanSkill } from './kanban-skill'
import { installCommitHook } from '../../cli/src/lib/skill/hook'
import { syncRefusal, syncStopped, type Sync, type SyncStep } from './sync-retry'

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
  retryFile?: string
  recover?: <T>(failure: ExecutionFailure, operation: () => Promise<api.Call<T>>) => Promise<api.Call<T>>
  waitForLogin?: () => Promise<boolean>
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


export type FlowEnd = { ok: true; report: JobReport; reviewed?: Laid } | { ok: false; reason: string; stopped?: boolean; exhausted?: boolean; safeToRetry?: boolean; failure?: ExecutionFailure; report?: JobReport }

type Delivery = { id?: string; status?: DeliveryStatus; commit?: string; branch?: string; ending?: DeliveryEnding }

function commandFailure(ran: Ran): Extract<api.Call<never>, { ok: false }> {
  const error = answerOf<{ error?: { message?: string; kind?: string; code?: string; status?: number } }>(ran)?.error
  return { ok: false, error: error?.message ?? refusal(ran),
    code: error?.code ?? error?.kind ?? (ran.code === null ? undefined : 'command_failed'), status: error?.status }
}

interface Run extends BoardRunSpend {
  cardId?: number | null
  parentId?: string
  cloudExecution?: { job: string; machine: string; card?: number }
  harness?: string
  cwd?: string
  unspawned?: boolean
  resumeId?: string
  continues?: { resumeId: string; fork?: boolean }
  canResume?: boolean
  pendingWrites?: boolean
  blocker?: RunRecord['blocker']
  failure?: ExecutionFailure
  retryPause?: RetryPause
  retry?: { attempt: number; of: number; reason: string }
  retryHistory?: RetryRecord[]
  cleanup?: import('../../cli/src/lib/agent/wire/codex-background-types').Cleanup
  agentPid?: number
  agentStartedAt?: number
  managedProcess?: boolean
  agentIdentity?: string
  action?: string
  status?: string
  endedAt?: number
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

function isSuccessfulArchive(file: string): boolean {
  const { meta } = parseFrontmatter(fs.readFileSync(file, 'utf8'))
  return !!meta?.archived && !meta.rejected
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

function runCommand(akb: Akb, ws: TaskFolder, args: string[]) {
  return runAkb(akb, ['run', ...args, '--board', ws.board, '--json'], { cwd: ws.cwd, board: ws.board })
}

async function boardRuns(akb: Akb, ws: TaskFolder, scope: string[]): Promise<Run[] | undefined> {
  const ran = await runCommand(akb, ws, ['list', '--all', ...scope])
  const parsed = answerOf<{ runs?: Run[]; error?: { kind?: string } }>(ran)
  if (parsed?.runs) return parsed.runs
  if (parsed?.error?.kind === 'no-board'
      && !fs.existsSync(path.join(ws.board, 'config.md'))
      && !fs.existsSync(path.join(ws.board, 'todo'))
      && !fs.existsSync(path.join(projectStateDir(ws.board), 'sessions.json'))) {
    return []
  }
  return undefined
}

const jobOwns = (run: Run, job: string, machine: string) =>
  run.cloudExecution?.job === job && run.cloudExecution.machine === machine
const onTask = (run: Run, card: number) =>
  run.cardId === card && (run.cloudExecution?.card === undefined || run.cloudExecution.card === card)

/** Legacy runs may have the right lease and the wrong card. Check and stop them by lease. */
export async function stopFlowRuns(ws: TaskFolder, job: Job, deps: FlowDeps): Promise<boolean> {
  const until = Date.now() + deps.stopMs
  do {
    const runs = await boardRuns(deps.akb, ws, ['--execution', job.id])
    if (!runs) return false
    const owned = runs.filter(r => jobOwns(r, job.id, deps.machineId))
    if (owned.every(runStopped)) return true
    for (const run of owned) {
      if (run.status === 'running' && !run.parentId) await runCommand(deps.akb, ws, ['stop', run.sessionId])
    }
    await wait(250)
  } while (Date.now() < until)
  return false
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
        [DELIVERY_PHASE_ENV]: job.flow?.phase ?? (job.flow?.verb === 'resolve' && job.flow.land_from ? 'resolve' : undefined),
        [RETRY_FILE_ENV]: io.retryFile,
        [EXECUTION_RUNTIMES_ENV]: io.executionRuntimes,
        AI4KANBAN_SYNC_DIAGNOSTIC: io.diagnostic,
        AI4KANBAN_REVIEW_STAGES: job.flow?.review_stages ? JSON.stringify(job.flow.review_stages) : undefined,
        AI4KANBAN_TASK_REVIEW: job.taskReview ? JSON.stringify(job.taskReview) : undefined,
        [STUDIO_SNAPSHOT_ENV]: task && ws.studioSnapshot ? JSON.stringify(ws.studioSnapshot) : undefined,
        AI4KANBAN_EXECUTION: JSON.stringify({ job: job.id, machine: deps.machineId,
          ...(task && job.flow && ws.number ? { card: ws.number } : {}) }),
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
  const replayingReceipt = job.flow?.verify_delivery?.confirmed === true ||
    job.flow?.phase === 'land' && !!ws.number && isArchived(ws, ws.number) && !asks(cardFile(ws))
  if (!io.flowRun?.finished && !replayingReceipt) {
    let missing = unavailable(runtime, await deps.runtimes())
    if (missing?.endsWith(' is not signed in on this computer.') && io.waitForLogin) {
      if (!await io.waitForLogin()) return stopping(io) ? '' : missing
      missing = unavailable(runtime, await deps.runtimes())
    }
    if (missing) return missing
  }

  const config = path.join(ws.board, 'config.md')
  if (!fs.existsSync(config)) {
    const init = await attemptSync(io, 'init', async () => {
      const ran = await akb(['raw', 'init', '--json'])
      return ran.code === 0 ? { ok: true, value: undefined } : commandFailure(ran)
    })
    if (!init.ok) return refusedSync(job, init)
  }
  removeLegacyKanbanSkill(ws.cwd)
  const hook = installCommitHook(ws.cwd, ws.board)
  if (hook.note) io.show(`${hook.note}\n`)
  const pulled = await attemptSync(io, 'prepare', () => pull(ws, deps.machineId, () => stopping(io), job.flow?.phase === 'land' ? 'land' : ws.materialIssues ? 'implement' : undefined))
  if (!pulled.ok) {
    if (pulled.failure?.source === 'validation' || pulled.failure?.source === 'sync') io.diagnostic = pulled.failure.summary
    else if (pulled.code !== 'board_content_conflict') return refusedSync(job, pulled)
  }
  if (io.flowRun?.finished && job.flow?.phase !== 'land') return null
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

function sessionOfRun(run: Run | undefined): string | undefined {
  return run && !isSessionMissingFailure(run.failure)
    ? run.resumeId ?? (run.continues && !run.continues.fork ? run.continues.resumeId : undefined) ?? (run.canResume ? run.sessionId : undefined)
    : undefined
}

function isCodexRun(run: Run | undefined, job: Pick<Job, 'runtime'>): boolean {
  return (run?.harness ?? job.runtime) === 'codex'
}

function runStopped(run: Run): boolean {
  if (!run.status || run.status === 'running') return false
  const root = run.agentPid ? { pid: run.agentPid, since: run.agentStartedAt ?? run.startedAt ?? 0, identity: run.agentIdentity } : undefined
  const stopped = run.managedProcess ? connectionStopped(root) : processesStopped(runMark(run.sessionId, run.agentStartedAt ?? run.startedAt), root)
  if (!stopped) return false
  const session = run.harness === 'codex' || run.managedProcess ? sessionOfRun(run) : undefined
  return !(session && hasLiveCodexExecution(session))
}

async function verifyFlowCodexRun(
  ws: TaskFolder,
  job: Pick<Job, 'runtime'>,
  run: Run | undefined,
  runs?: readonly Run[],
): Promise<CodexStopVerification | undefined> {
  if (!run || !isCodexRun(run, job)) return undefined
  const session = sessionOfRun(run)
  if (!session) return undefined
  const cleanupUnconfirmed = run.cleanup ? !stoppedCleanupConfirmed(run.cleanup) : false
  const needsBackendProbe = !!run.pendingWrites || cleanupUnconfirmed || !!run.retryPause
    || (!!run.managedProcess && run.failure?.code === 'idle_timeout' && !idleStopConfirmed(run.cleanup, session))
  return verifyCodexStopState({
    session,
    cwd: run.cwd,
    deliveryId: run.deliveryId,
    cleanup: run.cleanup,
    eventsPath: path.join(projectStateDir(ws.board), 'sessions', `${run.sessionId}.events.jsonl`),
    cardId: ws.number ?? run.cardId,
    taskId: ws.task,
    runs: runs?.map((r) => ({
      sessionId: r.sessionId,
      cardId: r.cardId,
      resumeId: r.resumeId,
      harness: r.harness,
      continues: r.continues,
      cloudExecution: r.cloudExecution,
    })),
    selfSessionId: run.sessionId,
    needsBackendProbe,
  })
}

function failedRunResumeDiagnostic(
  run: Run | undefined,
  stopped: boolean,
  zh: boolean,
  manual = false,
  codex?: CodexStopVerification,
): string | undefined {
  const session = sessionOfRun(run)
  const exited = stopped && (!codex || codex.stopped) && !!run?.endedAt
    && (run.status === 'error' || run.status === 'stopped' || run.status === 'interrupted')
  if (exited && codex && !codex.ownershipOk) {
    return zh ? '原会话归属无法核实。' : 'Could not verify that the session belongs to this task.'
  }
  const cleanupUnconfirmed = run?.cleanup ? !stoppedCleanupConfirmed(run.cleanup) : false
  const legacyIdle = manual && !run?.managedProcess && run?.failure?.code === 'idle_timeout' && !run.cleanup?.kept?.length
  const staticUnconfirmed = !legacyIdle && (!!run?.pendingWrites || cleanupUnconfirmed
    || !!run?.managedProcess && run.failure?.code === 'idle_timeout' && !idleStopConfirmed(run.cleanup, session))
  const unconfirmedCleanup = !!run?.blocker || (codex?.found ? !codex.settled : staticUnconfirmed)
  if (manual && exited && !unconfirmedCleanup && run?.failure?.code !== 'session_mismatch') return
  return resumeBlocked({
    stopped: exited,
    session,
    unconfirmedCleanup,
  }, zh)
}

function recoveryArgs(run: NonNullable<FlowIo['flowRun']>): string[] {
  return run.finished ? ['run', 'log', run.id] : ['run', 'resume', run.id, run.freshSession ? '--new-session' : '--require-session']
}

function runsSpent(runs: Run[], since: number, job: Job, io: FlowIo, machine: string, card?: number): Run[] {
  const source = job.flow?.historical_recovery ? undefined : job.flow?.sync_recovery_of ?? job.syncRecoveryOf ?? io.flowRun?.from
  const current = runs.filter(r => (card === undefined || onTask(r, card)) &&
    (jobOwns(r, job.id, machine) || !!source && jobOwns(r, source, machine)
    || card === undefined && !r.cloudExecution && (r.startedAt ?? 0) >= since))
  // The CLI replaces an interrupted run record when it opens the resumed attempt.
  const saved = job.flow?.historical_recovery || card !== undefined && io.flowRun?.card !== card ? [] : io.flowRun?.priorSpend ?? []
  return [...new Map([...saved, ...current].map(run => [run.sessionId, run])).values()]
}

/** A review of these archived tasks, each `<task>:<card>` (#2065, #165), on the project's board. */
export async function runReview(job: Job, ws: TaskFolder, tasks: string[], deps: FlowDeps, io: FlowIo): Promise<FlowEnd> {
  const since = Date.now()
  const failed = await setUp(job, ws, deps, io)
  if (failed) return { ok: false, reason: failed, safeToRetry: !io.flowRun }
  const akb = boardAkb(job, ws, deps, io)
  const args = io.flowRun ? recoveryArgs(io.flowRun) : ['memory', 'review', '--task', ...tasks]
  const ran = await akb([...args, '--follow', '--events', '--json'], true)
  if (io.lost()) return { ok: false, reason: '' }
  const answer = answerOf<{ result?: string; error?: { message?: string } }>(ran)
  if (ran.code !== 0) return { ok: false, reason: reasonOf(answer?.error?.message?.replace(/^run \S+ ended \w+: /, '')) ?? refusal(ran) }
  const runs = answerOf<{ runs?: Run[] }>(await akb(['run', 'list', '--all', '--json']))?.runs ?? []
  return { ok: true, report: { ...(answer?.result?.trim() ? { reply: answer.result.trim() } : {}), ...spentBy(runsSpent(runs, since, job, io, deps.machineId), job) } }
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
    const runs = (await boardRuns(deps.akb, ws, ['--execution', job.id]) ?? []).filter(r => (r.startedAt ?? 0) >= since &&
      r.cardId == null && jobOwns(r, job.id, deps.machineId))
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
  if (failed) return { ok: false, reason: failed, safeToRetry: !io.flowRun }
  if (io.flowRun) {
    const args = recoveryArgs(io.flowRun)
    const akb = boardAkb(job, ws, deps, io)
    const ran = await akb([...args, '--follow', '--events', '--json'], true)
    if (ran.code !== 0 || stopping(io)) return { ok: false, reason: refusal(ran) }
    const answer = answerOf<{ result?: string; agentSession?: string }>(ran)
    const runs = answerOf<{ runs?: Run[] }>(await akb(['run', 'list', '--all', '--json']))?.runs ?? []
    return { ok: true, report: { reply: answer?.result, session: answer?.agentSession,
      ...spentBy(runsSpent(runs, since, job, io, deps.machineId), job) } }
  }
  if (name === 'review-dismissals') {
    const { runs, failure, laid, session } = await reviewRejections(job, ws, deps, io)
    if (io.lost()) return { ok: false, reason: '' }
    return failure ? { ok: false, reason: failure } : { ok: true, report: { session, ...spentBy(runs, job) }, reviewed: laid }
  }
  if (name === 'reflect' && !tasks?.length) return { ok: true, report: {} }
  const args = name === 'reflect' ? ['raw', 'reflect', '--cards', ...tasks!.map((t) => String(t.number))]
    : name === 'describe-project' ? ['memory', name] : ['raw', ...(name === 'prune-memory' ? ['memory', 'prune'] : [name])]
  const akb = boardAkb(job, ws, deps, io, ws.cloudTask ?? undefined)
  // Listing reaps a run a stopped Runner left recorded as live, which would hold the agent for good.
  await akb(['run', 'list', '--all', '--json'])
  const ran = await akb([...args, '--follow', '--events', '--json'], true)
  if (io.lost()) return { ok: false, reason: '' }
  const answer = answerOf<{ result?: string; agentSession?: string; error?: { message?: string } }>(ran)
  if (ran.code !== 0) return { ok: false, reason: reasonOf(answer?.error?.message?.replace(/^run \S+ ended \w+: /, '')) ?? refusal(ran) }
  const runs = answerOf<{ runs?: Run[] }>(await akb(['run', 'list', '--all', '--json']))?.runs ?? []
  return { ok: true, report: { ...(answer?.agentSession ? { session: answer.agentSession } : {}), ...(answer?.result?.trim() ? { reply: answer.result.trim() } : {}), ...spentBy(runsSpent(runs, since, job, io, deps.machineId), job) } }
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
    return `\n<Asset src="${assetRef(file)}" label="${a.name.replace(/["<>]/g, '') || file}" />\n`
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
  if (job.task !== ws.cloudTask || !ws.number || job.number !== undefined && job.number !== ws.number) {
    return fail('The task and its execution workspace do not match.')
  }
  const akb = boardAkb(job, ws, deps, io, ws.task)

  if (flow.verb === 'discard') return discardBuilds()
  if (io.flowRun && io.flowRun.card !== ws.number) return unverifiedResume()
  if (io.flowRun?.failure) {
    const failure = io.flowRun.failure
    const pause = io.flowRun.retryPause ?? 'unsafe'
    const resumable = io.flowRun.resumeDiagnostic === null
    const diagnostic = resumable ? undefined : io.flowRun.resumeDiagnostic
      ?? resumeBlocked({ stopped: true, unconfirmedCleanup: true }, cloudLanguage(job) === 'zh')
    const detail = [diagnostic, failure.detail].filter(Boolean).join('\n')
    if (diagnostic) io.show(`[recovery] ${diagnostic}\n`)
    const failureDetail: FailureDetail = {
      summary: failure.summary,
      ...(detail ? { detail: clipDetail(detail) } : {}),
      ...(failure.code ? { code: failure.code } : {}),
      source: failure.source,
      runtime: { connector: job.runtime, name: null, model: job.model ?? null },
      attempt: 1,
      maxAttempts: MAX_RETRY_ATTEMPTS,
      pauseReason: pause,
      safeToRetry: resumable,
      sessionAction: resumable ? 'resume' : 'pause_unsafe',
      history: [],
    }
    return { ok: false, reason: failure.summary, exhausted: failure.code === 'retry_exhausted' || io.flowRun.retryPause === 'limit', failure, report: { ...spentBy(runsSpent([], since, job, io, deps.machineId, ws.number), job), failure: failureDetail } }
  }

  const dispatchedReview = job.reviewAtDispatch ? job.taskReview : undefined
  const hasReview = !!job.taskReview || flow.review_stages !== undefined
  const initial = job.taskReview && reviewAuthorization(job.taskReview, flow.review_stages)
  const skipPlan = initial ? initial.kind === 'unreviewed' || initial.kind === 'flat' && flow.skip_plan : flow.skip_plan
  const verb = flow.verb === 'create' ? (skipPlan ? 'implement' : 'refine') : flow.verb

  if (verb === 'implement') ws.materialIssues = {}

  let currentTask: Extract<Awaited<ReturnType<typeof api.readTask>>, { ok: true }>['value'] | undefined

  async function refreshReview(action = verb): Promise<string | undefined> {
    if (!hasReview) return
    const current = await attemptSync(io, 'review', () => deps.api.readTask(ws.task))
    if (!current.ok) return refusedSync(job, current)
    const review = dispatchedReview ?? current.value.review
    if (!review || ['stopped', 'done', 'cancelled'].includes(current.value.status ?? '')) {
      return 'This execution no longer has review authorization.'
    }
    const authorization = reviewAuthorization(review, flow.review_stages, dispatchedReview ? undefined : flow.review_revision)
    if (authorization.kind === 'changed' || action === 'refine' && !reviewAllows(authorization, action)) {
      return 'Review authorization changed. Read the task again.'
    }
    if (action === 'implement') {
      if (!reviewAllows(authorization, action)) return 'Finish the agreed review stages before delivery.'
      if (flow.review_revision !== undefined && (flow.verify_delivery || flow.phase === 'land'
        ? flow.review_revision !== current.value.review?.revision : !dispatchedReview && flow.review_revision !== review.revision)) {
        return 'Review authorization changed. Read the task again.'
      }
    }
    job.taskReview = review
    currentTask = current.value
  }

  let previewDirectory: string | undefined
  async function launch(args: string[], show = false, env?: NodeJS.ProcessEnv, action = verb): Promise<Ran & { reviewRefused?: string }> {
    const denied = await refreshReview(action)
    const refuse = (reason: string) => ({ code: 1, out: '', last: reason, reviewRefused: reason })
    if (denied || stopping(io)) return { code: 1, out: '', last: denied || 'Task preparation stopped.', reviewRefused: denied }
    const review = job.taskReview
    const task = currentTask
    const startsDelivery = ['delivery resume', 'run resume', 'task implement'].includes(args.slice(0, 2).join(' '))
    if (review && action === 'implement' && startsDelivery) {
      previewDirectory ??= fs.mkdtempSync(path.join(os.tmpdir(), 'wildcrane-previews-'))
      const inputs = task?.preview_inputs
      const staged = await attemptSync(io, 'previews', () => stageSavedPreviews(previewDirectory!, ws, review, inputs, () => stopping(io)))
      if (!staged.ok) return refuse(refusedSync(job, staged))
      const changed = await refreshReview(action)
      if (changed) return refuse(changed)
      if (!isDeepStrictEqual(job.taskReview, review)) return refuse('Review authorization changed. Read the task again.')
      if (!dispatchedReview && (!Array.isArray(review.plan) || !review.plan.length) && (currentTask?.card_version !== task?.card_version || !isDeepStrictEqual(currentTask?.preview_inputs, inputs))) {
        return refuse('The saved Previews changed. Read the task again.')
      }
      if (staged.value) env = { ...env, [SAVED_PREVIEW_FILE_ENV]: staged.value }
    }
    if (!show || !review || Array.isArray(review.plan) || !ws.number) return akb(args, show, env)
    const bridge = await previewSyncBridge(ws, { id: job.id, machineId: deps.machineId }, () => stopping(io))
    try { return await akb(args, show, { ...env, [REVIEW_SYNC_ENV]: bridge.env }) }
    finally { bridge.close() }
  }

  const failed = await setUp(job, ws, deps, io)
  if (failed) return { ok: false, reason: failed, safeToRetry: !io.flowRun }

  let id = akbCardOf(ws)
  if (flow.phase === 'land') {
    try { return id ? await land(id) : fail('This task has no card in the Land workspace.') }
    finally { if (previewDirectory) fs.rmSync(previewDirectory, { recursive: true, force: true }) }
  }
  let newRequest: string | undefined
  const existedBeforeCreate = flow.verb !== 'create' || !!id
  // An unplanned build (#2139) has no plan for the review to inform.
  const learned = flow.verb === 'create' && !id && !skipPlan ? await learnRejections(job, ws, deps, io, refreshReview) : []
  if (io.lost()) return fail('')
  if (flow.verb === 'create' && !id && !flow.resume_execution) {
    // Cloud sends the title and the request with the job; the task is read only when it did not.
    let said = { title: flow.title?.trim() ?? '', request: flow.text ?? '' }
    if (!said.title) {
      const task = await attemptSync(io, 'review', () => deps.api.readTask(ws.task))
      if (!task.ok) return fail(refusedSync(job, task))
      said = { title: task.value.title?.trim() ?? '', request: task.value.request ?? '' }
    }
    const title = said.title || 'Untitled'
    const body = path.join(ws.board, '.sync', `${ws.task}.request.md`)
    fs.mkdirSync(path.dirname(body), { recursive: true })
    // The card takes the task's number (#2063), and no other.
    if (!ws.number) return fail('This task has no number yet.')
    const created = await attemptSync(io, 'create', async () => await withBoard(ws, async () => {
      const existing = akbCardOf(ws)
      if (existing) return { ok: true as const, value: existing }
      fs.writeFileSync(body, `${said.request.trim() || title}\n${pictures(job, ws, ws.number!)}`)
      try {
        const ran = await akb(['raw', 'create', '--title', title, '--studio', studioName(flow.studio), '--body-file', body,
          '--id', String(ws.number), ...cardFlags(ws, flow.metadata), '--json'])
        const saved = akbCardOf(ws)
        if (saved) return { ok: true as const, value: saved }
        return commandFailure(ran)
      } finally { fs.rmSync(body, { force: true }) }
    }, () => stopping(io)) ?? syncStopped)
    if (stopping(io)) return fail('')
    if (!created.ok) return fail(created.error)
    id = created.value
    newRequest = said.request.trim() ? said.request : undefined
  }
  if (flow.verb === 'create' && id && !flow.resume_execution && !stopping(io)) {
    const card = id
    const sent = await attemptSync(io, 'create-sync', async () => await withBoard(ws, async (send): Promise<api.Call<FlowEnd | undefined>> => {
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
  if (!id) return flow.resume_execution ? unverifiedResume() : fail('This task has no card on this computer.')
  return onCard(id)

  function unverifiedResume(diagnostic = cloudLanguage(job) === 'zh' ? '找不到原执行记录。' : 'The original execution record could not be found.'): FlowEnd {
    io.show(`[recovery] ${diagnostic}\n`)
    return { ok: false, reason: 'task_recovery_unverified',
      failure: makeFailure('runner', diagnostic, { code: 'task_recovery_unverified', detail: diagnostic }) }
  }

  async function reconcileDelivery(card: number): Promise<
    | { kind: 'running'; deliveryId?: string; sessionId: string; action?: string }
    | { kind: 'completed'; deliveryId: string; sessionId?: string; commit?: string; branch?: string }
    | { kind: 'resumable'; deliveryId: string; status?: string; sessionId?: string; hasSession?: boolean; worktree?: string; branch?: string; base?: string }
    | { kind: 'none' }
    | { kind: 'unverified'; deliveryId?: string; diagnostic: string }
  > {
    let deliveryId: string | undefined
    const checked = await attemptSync(io, 'reconcile', async () => {
      const ran = await akb(['delivery', 'reconcile', String(card), '--json'])
      if (stopping(io)) return syncStopped
      const parsed = answerOf<{
        kind?: string
        deliveryId?: string
        sessionId?: string
        action?: string
        commit?: string
        branch?: string
        status?: string
        hasSession?: boolean
        worktree?: string
        base?: string
        diagnostic?: string
        retryable?: boolean
        error?: { message?: string }
      }>(ran)
      deliveryId = parsed?.deliveryId
      if (ran.code === 0 && parsed?.kind && ['running', 'completed', 'resumable', 'none'].includes(parsed.kind)) {
        return { ok: true, value: parsed as
          | { kind: 'running'; deliveryId?: string; sessionId: string; action?: string }
          | { kind: 'completed'; deliveryId: string; sessionId?: string; commit?: string; branch?: string }
          | { kind: 'resumable'; deliveryId: string; status?: string; sessionId?: string; hasSession?: boolean; worktree?: string; branch?: string; base?: string }
          | { kind: 'none' } }
      }
      return { ok: false, error: parsed?.diagnostic ?? parsed?.error?.message ?? refusal(ran),
        ...(parsed?.retryable === false ? { code: 'task_recovery_unverified' } : {}) }
    })
    return checked.ok ? checked.value : stopping(io) ? { kind: 'none' } : { kind: 'unverified', deliveryId, diagnostic: checked.error }
  }

  async function land(card: number): Promise<FlowEnd> {
    io.onStop(async () => {
      if (!await stopFlowRuns(ws, job, deps)) throw new Error('The Land session did not stop.')
    })
    const reason = await refreshReview('implement')
    if (reason || stopping(io)) return fail(reason ?? '')

    const observed = await reconcileDelivery(card)
    const deliveryId = 'deliveryId' in observed ? observed.deliveryId : undefined
    const sourceJob = flow.land_from
    if (stopping(io)) return fail('')
    if (!sourceJob || flow.delivery_id && flow.delivery_id !== deliveryId) {
      return fail('The saved implementation does not match this Land job.')
    }

    const readRuns = async () => answerOf<{ runs?: Run[] }>(
      await akb(['run', 'list', '--card', String(card), '--all', '--json']),
    )?.runs ?? []
    const wroteArchive = async (runs: Run[]): Promise<FlowEnd> => {
      const saved = await reconcileDelivery(card)
      const landing = saved.kind === 'completed' && saved.deliveryId === deliveryId && saved.commit && saved.branch
        ? { commit: saved.commit, branch: saved.branch } : undefined
      const owned = runs.filter(r => onTask(r, card) && jobOwns(r, job.id, deps.machineId))
      const last = owned.filter(r => !r.parentId).at(-1)
      return { ok: true, report: { ...spentBy(owned, job), card, deliveryId, landing,
        reply: last?.result, session: last?.resumeId } }
    }
    const localArchive = () => isArchived(ws, card) && !asks(cardFile(ws))
      && isSuccessfulArchive(cardFile(ws))

    const unverified = observed.kind === 'unverified' ? observed.diagnostic : 'The saved implementation workspace or its run could not be verified.'
    const matchesSource = async () => {
      if (!deliveryId) return false
      const { stopped, mismatched, run } = await flowRunEvidence(ws, job, deps, sourceJob)
      return stopped && !mismatched && run?.finished && !run.failure && run.deliveryId === deliveryId
    }

    if (localArchive() && (deliveryId ? (observed.kind === 'completed' || observed.kind === 'resumable') : !flow.delivery_id && observed.kind === 'none')) {
      if (flow.reviewed_implementation && (observed.kind === 'resumable' && !savedWorkspace(observed) || !await matchesSource())) {
        return fail(unverified)
      }
      if (observed.kind === 'resumable') {
        const saved = await akb(['task', 'archive', String(card), '--json'])
        if (saved.code !== 0) return fail(refusal(saved))
      }
      return wroteArchive(await readRuns())
    }

    if (!savedWorkspace(observed) || !await matchesSource()) return fail(unverified)

    let resume = io.flowRun
    if (!resume && flow.sync_recovery_of) {
      if (!await stopFlowRuns(ws, { ...job, id: flow.sync_recovery_of }, deps)) {
        return fail('The previous Land session has not stopped.')
      }
      const previous = await flowRunEvidence(ws, job, deps, flow.sync_recovery_of)
      if (!previous.stopped) return fail('The previous Land session has not stopped.')
      resume = previous.run
    }
    while (!stopping(io)) {
      const args = resume
        ? ['run', 'resume', resume.id, '--require-session']
        : ['task', 'implement', String(card)]
      const ran = await launch([...args, '--follow', '--events', '--json'], true, undefined, 'implement')
      if (stopping(io)) return fail('')
      if (ran.reviewRefused) return fail(ran.reviewRefused)
      const runs = await readRuns()
      if (localArchive()) return wroteArchive(runs)
      const owned = runs.filter(r => onTask(r, card) && jobOwns(r, job.id, deps.machineId))
      const recent = owned.filter(r => !r.parentId).at(-1)
      const report = { ...spentBy(owned, job), card, deliveryId, session: recent?.resumeId, reply: recent?.result }
      if (asks(cardFile(ws))) {
        const review = reviewOf(cardFile(ws), true)
        return { ok: true, report: { ...report, review: review && review !== true ? review : {} } }
      }
      if (ran.code !== 0) return { ok: false, reason: refusal(ran), failure: recent?.failure, report }
      const diagnostic = `The Land session ended before task #${card} was archived. Verify saved results and run akb task archive ${card}.`
      const failure = makeFailure('validation', diagnostic, { code: 'land_archive_missing' })
      const saved = await flowRunEvidence(ws, job, deps, job.id, io.flowRun)
      if (!io.recover || !saved.stopped || !saved.run?.finished) return { ok: false, reason: diagnostic, failure, report }
      const retry = await io.recover(failure, async () => ({ ok: true, value: undefined }))
      if (!retry.ok) return { ok: false, reason: retry.error, failure, exhausted: retry.code === 'retry_exhausted', report }
      resume = saved.run
      io.flowRun = saved.run
      io.diagnostic = diagnostic
    }
    return fail('')
  }

  function savedWorkspace(observed: Awaited<ReturnType<typeof reconcileDelivery>>): observed is Extract<
    Awaited<ReturnType<typeof reconcileDelivery>>, { kind: 'resumable' }
  > {
    if (observed.kind !== 'resumable' || observed.status !== 'active' || !observed.worktree) return false
    const work = path.resolve(ws.cwd, observed.worktree)
    const present = (file: string) => fs.statSync(file, { throwIfNoEntry: false })?.isDirectory() === true
    return path.relative(ws.cwd, work).startsWith(`.akb${path.sep}worktrees${path.sep}`) && present(work) && (observed.base
      ? !!observed.branch && git(['symbolic-ref', '--short', 'HEAD'], work)?.trim() === observed.branch
        && git(['merge-base', '--is-ancestor', observed.base, 'HEAD'], work) !== null
      : present(path.join(path.dirname(work), 'base')))
  }

  async function onCard(card: number): Promise<FlowEnd> {
    try {
      if (flow.resume_execution && !io.flowRun) {
        const saved = await flowRunEvidence(ws, job, deps, flow.resume_execution)
        if (stopping(io)) return fail('')
        if (!saved.stopped || saved.mismatched || saved.diagnostic) return unverifiedResume(saved.diagnostic)
        if (saved.run) return await workOn(card, undefined, saved.run)
      }
      const verification = flow.verify_delivery
      if (verification) {
        const denied = await refreshReview('implement')
        if (denied) return fail(denied)
        if (stopping(io)) return fail('')
        if (verification.confirmed && verification.id) {
          return { ok: true, report: { card, deliveryId: verification.id, deliveryCompleted: true,
            ...(verification.landing ? { landing: verification.landing } : {}) } }
        }
      }
      const reconciled = (!io.flowRun || verification) && existedBeforeCreate ? await reconcileDelivery(card) : undefined
      if (io.lost()) return fail('')
      if (verification) {
        const saved = await flowRunEvidence(ws, job, deps, flow.sync_recovery_of, io.flowRun)
        const receipt = reconciled && 'deliveryId' in reconciled ? reconciled.deliveryId : undefined
        const expected = verification.id ?? saved.run?.deliveryId
        if (!saved.stopped || !expected || receipt !== expected || reconciled?.kind !== 'completed' &&
            (reconciled?.kind !== 'resumable' || !saved.run || saved.run.id !== reconciled.sessionId || !reconciled.hasSession)) {
          const reason = reconciled?.kind === 'unverified' ? reconciled.diagnostic : 'No delivery receipt or safe session matches the original run.'
          return { ok: false, reason, failure: makeFailure('sync', reason, { code: 'task_delivery_unverified' }) }
        }
        if (reconciled.kind === 'resumable') {
          io.flowRun = saved.run
          io.repairDelivery = true
          io.diagnostic = 'Verify the original delivery using the Studio delivery requirements and the saved results. Record the existing result once you confirm it. Do not repeat land or publish when the earlier result is already in place.'
          return workOn(card, reconciled)
        }
      }
      if (reconciled?.kind === 'unverified') {
        io.show(`[recovery] delivery reconciliation unverified${reconciled.deliveryId ? ` (delivery ${reconciled.deliveryId})` : ''}: ${reconciled.diagnostic}\n`)
        const runs = answerOf<{ runs?: Run[] }>(await akb(['run', 'list', '--card', String(card), '--all', '--json']))?.runs ?? []
        return {
          ok: false,
          reason: reconciled.diagnostic,
          failure: makeFailure('sync', reconciled.diagnostic, { code: 'task_recovery_unverified' }),
          report: spentBy([...learned, ...runsSpent(runs, since, job, io, deps.machineId, card)], job),
        }
      }
      if (reconciled?.kind === 'completed') {
        const denied = await refreshReview('implement')
        if (denied) return fail(denied)
        if (io.lost()) return fail('')
        const runs = answerOf<{ runs?: Run[] }>(await akb(['run', 'list', '--card', String(card), '--all', '--json']))?.runs ?? []
        const spent = spentBy([...learned, ...runsSpent(runs, since, job, io, deps.machineId, card)], job)
        if (flow.phase === 'implement') {
          return { ok: true, report: { ...spent, card, landReady: { deliveryId: reconciled.deliveryId } } }
        }
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
      if (flow.phase === 'implement' && verb === 'implement' && (!reconciled || reconciled.kind === 'none')
          && isArchived(ws, card) && !asks(cardFile(ws)) && isSuccessfulArchive(cardFile(ws))) {
        const denied = await refreshReview('implement')
        if (denied) return fail(denied)
        if (io.lost()) return fail('')
        const runs = answerOf<{ runs?: Run[] }>(await akb(['run', 'list', '--card', String(card), '--all', '--json']))?.runs ?? []
        const spent = spentBy([...learned, ...runsSpent(runs, since, job, io, deps.machineId, card)], job)
        return { ok: true, report: { ...spent, card, landReady: {} } }
      }
      const runs = await boardRuns(deps.akb, ws, ['--card', String(card)])
      if (!runs) return unverifiedResume(resumeBlocked({ stopped: false }, cloudLanguage(job) === 'zh'))
      if (runs.some(run => !jobOwns(run, job.id, deps.machineId) && !runStopped(run))) return fail(`#${card} is already being worked on`)
      if (reconciled?.kind === 'running') {
        const run = runs.find(r => r.sessionId === reconciled.sessionId && onTask(r, card) && r.deliveryId === reconciled.deliveryId)
        if (!run || run.cloudExecution && !jobOwns(run, job.id, deps.machineId)) return unverifiedResume()
        const denied = await refreshReview()
        if (denied) return fail(denied)
        if (io.lost()) return fail('')
      } else if (!await confirmFlowStopped(ws, job, deps)) {
        return unverifiedResume(resumeBlocked({ stopped: false }, cloudLanguage(job) === 'zh'))
      }
      if (io.lost()) return fail('')
      if (flow.resume && !flow.replan && !flow.resume_execution && !io.flowRun && (!reconciled || reconciled.kind === 'none')) {
        const zh = cloudLanguage(job) === 'zh'
        const latest = runs
          .filter(r => !r.parentId && onTask(r, card) && (!r.cloudExecution || r.cloudExecution.machine === deps.machineId))
          .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
        if (latest && latest.status !== 'done') {
          const session = sessionOfRun(latest)
          if (session && !await taskSessionMatches(ws, deps, session)) {
            return unverifiedResume(zh ? '原会话归属无法核实。' : 'Could not verify that the session belongs to this task.')
          }
          const codex = await verifyFlowCodexRun(ws, job, latest, runs)
          if (codex && !codex.stopped) return unverifiedResume(resumeBlocked({ stopped: false }, zh))
          if (codex && !codex.ownershipOk) {
            return unverifiedResume(zh ? '原会话归属无法核实。' : 'Could not verify that the session belongs to this task.')
          }
          const diagnostic = failedRunResumeDiagnostic(latest, true, zh, true, codex)
          if (diagnostic && (session || latest.pendingWrites || latest.cleanup?.status === 'unconfirmed')) {
            return unverifiedResume(diagnostic)
          }
          if (!diagnostic && session && verb === 'refine' && !flow.text?.trim() && !(!hasReview && reviewOf(cardFile(ws)))) {
            return await workOn(card, reconciled, { id: latest.sessionId, finished: false, card, deliveryId: latest.deliveryId })
          }
        }
      }
      return await workOn(card, reconciled)
    } finally {
      if (previewDirectory) fs.rmSync(previewDirectory, { recursive: true, force: true })
      fs.rmSync(path.join(ws.board, '.sync', `${ws.task}.discussion`), { recursive: true, force: true })
    }
  }

  async function workOn(id: number, reconciled?: Awaited<ReturnType<typeof reconcileDelivery>>, original?: FlowIo['flowRun']): Promise<FlowEnd> {
    io.onStop(async () => {
      if (!await stopFlowRuns(ws, job, deps)) throw new Error('The task processes could not be confirmed stopped.')
    })

    const text = flow.verb === 'create' || !flow.text?.trim() ? '' : flow.text
    // A resume follows where the card actually is, not the step the last job was on.
    const archived = !original && !io.flowRun && flow.resume && isArchived(ws, id)
    if (archived && (verb !== 'implement' || parseFrontmatter(fs.readFileSync(cardFile(ws), 'utf8')).meta?.rejected)) {
      return { ok: true, report: { card: id, ...(verb === 'implement' ? { deliveryCompleted: false } : {}) } }
    }
    if (!original && !io.flowRun && flow.resume && verb === 'refine' && !hasReview && (!reconciled || reconciled.kind === 'none')) {
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
    if (io.flowRun && verb === 'refine' && flow.review_stages?.length && flow.review_revision !== undefined) {
      const recorded = await attemptSync(io, 'review', () => deps.api.readTask(ws.task))
      if (!recorded.ok) return fail(refusedSync(job, recorded))
      const review = recorded.value.review
      const beforePlan = job.taskReview?.plan
      const currentPlan = review?.plan
      const submitted = flow.review_stages.every(stage => {
        const current = review?.stages.find(state => state.id === stage)
        const before = Array.isArray(beforePlan) ? beforePlan.find(node => node.id === stage) : undefined
        return current && current.revision > flow.review_revision! &&
          (isWaitingReview(current.status) || current.status === 'approved' || current.status === 'done')
          && (!before || isDeepStrictEqual(before, (Array.isArray(currentPlan) ? currentPlan.find(node => node.id === stage) : undefined)))
      })
      if (submitted) {
        return { ok: true, report: { card: id, session: io.flowRun.agentSession, ...spentBy(io.flowRun.priorSpend ?? [], job) } }
      }
    }
    const mismatchedReceipt = cloudLanguage(job) === 'en'
      ? 'The receipt belongs to a different delivery.' : '续跑返回了其他交付的结果，原交付保持未完成。'
    const resumeExistingDelivery = async () => {
      const target = reconciled?.kind === 'resumable' ? reconciled.deliveryId : String(id)
      const restored = await launch(['delivery', 'resume', target, '--follow', '--events', '--json'], true, undefined, 'implement')
      if (restored.reviewRefused) return fail(restored.reviewRefused)
      const resumed = answerOf<{ landed?: boolean; deliveryId?: string; sessionId?: string; delivery?: Delivery; error?: { message?: string; reason?: string; sessionId?: string; args?: { id?: string } } }>(restored)
      if (io.lost()) return fail('')
      if (restored.code === 0 && resumed?.deliveryId && reconciled?.kind === 'resumable' && resumed.deliveryId !== reconciled.deliveryId) {
        return fail(mismatchedReceipt)
      }
      if (restored.code === 0 && resumed?.landed && resumed.deliveryId) {
        if (flow.phase === 'implement') return { ok: true as const, report: { card: id, landReady: { deliveryId: resumed.deliveryId } } }
        return { ok: true as const, report: { card: id, deliveryCompleted: true, deliveryId: resumed.deliveryId, ...landingOf(resumed.delivery) } }
      }
      if (resumed?.sessionId || resumed?.error?.sessionId) {
        expectedDelivery = reconciled?.kind === 'resumable' ? reconciled.deliveryId : resumed.deliveryId
        ran = restored
        return undefined
      }
      const reason = restored.code === 0 ? undefined : resumed?.error?.reason
      // No delivery left to carry on: build afresh, and the builder picks up what is on disk.
      if (reason && reason !== 'deliveryActive' && !FRESH_BUILD.has(reason)) {
        return fail(RESUME_REFUSED[reason] ?? resumed?.error?.message ?? refusal(restored))
      }
      if (archived && reconciled?.kind === 'none' && reason && FRESH_BUILD.has(reason)) {
        return { ok: true as const, report: { card: id, deliveryCompleted: false } }
      }
      const deliveryId = reason && reason !== 'deliveryActive' ? undefined : resumed?.deliveryId ?? resumed?.error?.args?.id
      expectedDelivery = deliveryId ?? (reconciled?.kind === 'resumable' ? reconciled.deliveryId : undefined)
      if (deliveryId) {
        const previous = answerOf<{ runs?: Run[] }>(await akb(['run', 'list', '--card', String(id), '--all', '--json']))?.runs
          ?.filter((r) => ['implement', 'conflict', 'hook'].includes(r.action ?? '') && r.deliveryId === deliveryId)
          .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
        // With no run to rejoin, a fresh build run works inside the same delivery.
        if (previous) {
          const allowFreshMissing = !!flow.resume_execution && isSessionMissingFailure(previous.failure)
            && !previous.pendingWrites && (!previous.cleanup || stoppedCleanupConfirmed(previous.cleanup))
          continuation = ['run', 'resume', previous.sessionId, allowFreshMissing ? '--fresh' : '--require-session']
        }
      }
      return undefined
    }
    if (original) {
      expectedDelivery = original.deliveryId
      if (expectedDelivery) effectiveVerb = 'implement'
      continuation = recoveryArgs(original)
    } else if (io.flowRun) {
      expectedDelivery = io.flowRun.deliveryId
      if (expectedDelivery) effectiveVerb = 'implement'
      continuation = io.repairDelivery ? ['run', 'resume', io.flowRun.id, '--require-session'] : recoveryArgs(io.flowRun)
    } else if (reconciled?.kind === 'running') {
      expectedDelivery = reconciled.deliveryId
      if (expectedDelivery) effectiveVerb = 'implement'
      continuation = ['run', 'log', reconciled.sessionId]
    } else if (reconciled?.kind === 'resumable') {
      const denied = hasReview ? await refreshReview('revise') : undefined
      if (denied) return fail(denied)
      const reviewAllowsImplement = !hasReview || (!!job.taskReview && reviewAllows(reviewAuthorization(
        job.taskReview, flow.review_stages, dispatchedReview ? undefined : flow.review_revision), 'implement'))
      const hasOpenQuestions = asks(cardFile(ws))
      const continueDelivery = verb === 'implement' || (!flow.replan && ['refine', 'revise', 'create'].includes(verb) && reviewAllowsImplement && !hasOpenQuestions)
      if (continueDelivery) {
        effectiveVerb = 'implement'
        const done = await resumeExistingDelivery()
        if (done) return done
      } else if (!(verb === 'resolve' && flow.land_from)) {
        const released = await akb(['delivery', 'release', String(id), '--json'])
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
      const resolved = await launch(['task', 'resolve', String(id), '--follow', '--events', '--json', '--', text], true)
      if (resolved.reviewRefused) return fail(resolved.reviewRefused)
      if (io.lost()) return fail('')
      if (isRejected()) ran = resolved
      else if (resolved.code !== 0) note = text
      else if (asks(cardFile(ws))) {
        const review = reviewOf(cardFile(ws), hasReview)
        return { ok: true, report: { card: id, deliveryCompleted: false, ...(review && review !== true ? { review } : {}) } }
      }
    }
    if (effectiveVerb === 'revise' && !text) return fail('Say what to change.')
    const fresh = (fromTranscript = false) => {
      const carry = carryArgs(effectiveVerb, fromTranscript)
      const env = {
        [SESSION_COST_ENV]: carry.includes('--session') && typeof job.resumeCostUsd === 'number' ? String(job.resumeCostUsd) : undefined,
        [TASK_REQUEST_ENV]: newRequest ?? (effectiveVerb === 'refine' ? text || undefined : undefined),
      }
      const command = effectiveVerb === 'approve' ? ['raw', 'card', 'approve'] : ['task', effectiveVerb]
      return launch([...command, String(id), '--follow', '--events', '--json', ...carry, ...(note ? ['--', note] : [])], true, env, effectiveVerb)
    }
    ran ??= await (continuation ? launch([...continuation, '--follow', '--events', '--json'], true, undefined, effectiveVerb) : fresh())
    if (ran.reviewRefused) return fail(ran.reviewRefused)
    if (io.lost()) return fail('')
    type Ended = {
      ok?: boolean
      result?: string
      sessionId?: string
      lastSessionId?: string
      agentSession?: string
      delivery?: Delivery
      error?: { message?: string; reason?: string; result?: string; sessionId?: string; lastSessionId?: string; agentSession?: string; delivery?: Delivery }
    }
    const readRuns = async () => (await boardRuns(deps.akb, ws, ['--card', String(id)]) ?? []).filter(r => onTask(r, id))
    const lastRun = (answer: Ended | null) => answer?.lastSessionId ?? answer?.error?.lastSessionId ?? answer?.sessionId ?? answer?.error?.sessionId
    const logged = continuation?.[1] === 'log' ? continuation[2] : undefined
    let answer = answerOf<Ended>(ran)
    let runs = await readRuns()
    if (flow.resume && !io.repairDelivery && ran.code !== 0 && continuation?.[1] === 'resume' && continuation.includes('--require-session') && !stopping(io)) {
      const missing = runs.find(run => run.sessionId === lastRun(answer) && jobOwns(run, job.id, deps.machineId) &&
        run.deliveryId === expectedDelivery && isSessionMissingFailure(run.failure)
        && !run.pendingWrites && (!run.cleanup || stoppedCleanupConfirmed(run.cleanup)))
      // Once a resume starts, its record replaces the previous attempt's.
      const retryFrom = missing?.sessionId ?? (answer?.error?.reason === 'runSessionMissing' ? continuation[2] : undefined)
      if (retryFrom) {
        ran = await launch(['run', 'resume', retryFrom, '--new-session', '--follow', '--events', '--json'], true, undefined, effectiveVerb)
        if (ran.reviewRefused) return fail(ran.reviewRefused)
        if (io.lost()) return fail('')
        answer = answerOf<Ended>(ran)
        runs = await readRuns()
      }
    }
    if (ran.code !== 0 && !continuation && job.fork && job.transcript && !stopping(io) &&
        runs.some(run => run.sessionId === lastRun(answer) && run.failure?.code === 'codex_fork_source_missing')) {
      const failure = runs.find(run => run.sessionId === lastRun(answer))!.failure!
      if (io.recover) {
        const result = await io.recover(failure, async () => ({ ok: true, value: await fresh(true) }))
        if (!result.ok) return fail(result.error)
        ran = result.value
      } else ran = await fresh(true)
      if (ran.reviewRefused) return fail(ran.reviewRefused)
      if (io.lost()) return fail('')
      answer = answerOf<Ended>(ran)
      runs = await readRuns()
    }
    const delivery = answer?.delivery ?? answer?.error?.delivery
    const last = lastRun(answer)
    const followed = logged ? runs.find(r => r.sessionId === logged) : undefined
    const fromThisJob = runs.filter(r => !r.parentId && jobOwns(r, job.id, deps.machineId))
    const recent = last ? runs.find(r => !r.parentId && r.sessionId === last &&
      (fromThisJob.includes(r) || r === followed || !!followed?.cloudExecution &&
        jobOwns(r, followed.cloudExecution.job, followed.cloudExecution.machine))) : fromThisJob.at(-1)
    if (last && !recent) return unverifiedResume('The final run does not belong to this task execution.')
    if (delivery && !recent) return unverifiedResume('The delivery has no verified run in this task execution.')
    const rejected = isRejected()
    const deliveryId = expectedDelivery ?? recent?.deliveryId ?? delivery?.id
    if (!rejected && deliveryId && delivery?.id && delivery.id !== deliveryId) {
      return { ok: false, reason: mismatchedReceipt, report: { deliveryId, deliveryCompleted: false } }
    }
    const executed = runsSpent(runs, since, job, io, deps.machineId, id)
    const spent = spentBy([...learned, ...executed], job)
    const history = mergeRetryHistory(...executed.map(run => run.retryHistory), recent?.retryHistory)
    const managedBuild = flow.phase === 'implement' && effectiveVerb === 'implement'
    if (!rejected && (managedBuild && hasReview || isFlatReviewPlan(job.taskReview?.plan) || job.taskReview?.plan === null && effectiveVerb === 'refine')) {
      const saved = await attemptSync(io, 'review', () => deps.api.readTask(ws.task))
      if (!saved.ok) return fail(refusedSync(job, saved))
      const review = saved.value.review
      if (review?.stages.some(stage => stage.job === job.id && (!managedBuild ||
        isFlatReviewPlan(review.plan) && (isWaitingReview(stage.status) || stage.status === 'approved'))) && (!managedBuild || ran.code === 0)) {
        if (managedBuild) {
          if (!deliveryId || recent?.status !== 'done' || recent.deliveryId !== deliveryId ||
              !jobOwns(recent, job.id, deps.machineId) || !runStopped(recent) || recent.pendingWrites ||
              recent.retryPause || recent.cleanup?.status === 'unconfirmed') {
            return fail('The implementation result or delivery workspace was not saved.')
          }
          const workspace = await reconcileDelivery(id)
          if (!savedWorkspace(workspace) || workspace.deliveryId !== deliveryId) {
            return fail(workspace.kind === 'unverified' ? workspace.diagnostic : 'The saved implementation workspace could not be verified.')
          }
        }
        const session = recent?.resumeId ?? (recent ? answer?.agentSession ?? answer?.error?.agentSession : undefined)
        return { ok: true, report: {
          ...spent, card: id, deliveryCompleted: false, ...(deliveryId ? { deliveryId } : {}),
          ...(session ? { session } : {}), ...(recent?.result ? { reply: recent.result } : {}),
        } }
      }
    }
    if (ran.code !== 0 && !recent?.retryPause && (ran.code === null || recent?.status === 'interrupted')) {
      const reason = recent?.failure?.summary ?? 'The task command was interrupted.'
      return { ok: false, reason, failure: makeFailure('runner', reason, { code: 'board_command_interrupted', detail: ran.last }) }
    }
    if (effectiveVerb === 'implement' && !rejected) {
      const ending = delivery?.ending
      if (ending?.kind === 'stopped') return { ok: false, reason: '', stopped: true,
        report: { ...spent, ...(deliveryId ? { deliveryId, deliveryCompleted: false } : {}) } }
      if (ending?.kind === 'discarded') return fail('The build was discarded.')
      if (ending?.kind === 'blocked') return { ok: false, reason: ending.reason,
        report: { ...spent, ...(deliveryId ? { deliveryId, deliveryCompleted: false } : {}) } }
    }
    const asked = effectiveVerb === 'implement' && !rejected && asks(cardFile(ws))
    const completed = !rejected && !asked && delivery?.status === 'finished' ? delivery.id : undefined
    const tracked = deliveryId || delivery ? { deliveryCompleted: !!completed, ...(deliveryId ? { deliveryId } : {}) } : {}
    const waiting = rejected ? null : reviewOf(cardFile(ws), hasReview)
    const review = waiting && waiting !== true ? waiting : undefined
    // A build held on the user's question is reported as one, like a plan's.
    if (!rejected && ran.code !== 0 && !completed &&
        (recent?.retryPause || !(effectiveVerb === 'refine' && waiting) && !(answer?.error && asked))) {
      const failure = recent?.failure
      const rawReason = failure?.summary ?? reasonOf(answer?.error?.message?.replace(/^run \S+ ended \w+: /, '')) ?? refusal(ran)
      const pause = readRetryPause(recent?.retryPause) ?? 'unsafe'
      const stopped = recent?.cloudExecution?.job === job.id && recent.cloudExecution.machine === deps.machineId && runs
        .filter(run => run.cloudExecution?.job === job.id).every(runStopped)
      const codex = stopped ? await verifyFlowCodexRun(ws, job, recent, runs) : undefined
      const diagnostic = failedRunResumeDiagnostic(recent, stopped, cloudLanguage(job) === 'zh', false, codex)
      const detail = [diagnostic, failure?.detail ?? (rawReason.length > 300 ? rawReason : undefined)].filter(Boolean).join('\n')
      if (diagnostic) io.show(`[recovery] ${diagnostic}\n`)
      const failureDetail: FailureDetail = {
        summary: clipSummary(rawReason) || 'The run failed.',
        ...(detail ? { detail: clipDetail(detail) } : {}),
        ...(failure?.code ? { code: failure.code } : {}),
        source: failure?.source ?? 'runtime',
        runtime: { connector: job.runtime, name: null, model: job.model ?? null },
        attempt: Math.max(1, (recent?.retry?.attempt ?? history.length) - 1),
        maxAttempts: recent?.retry?.of ?? MAX_RETRY_ATTEMPTS,
        pauseReason: pause,
        safeToRetry: !diagnostic,
        sessionAction: diagnostic ? 'pause_unsafe' : 'resume',
        history,
      }
      return {
        ok: false,
        reason: rawReason,
        exhausted: recent?.retryPause === 'limit',
        failure,
        report: { ...spent, ...tracked, failure: failureDetail },
      }
    }
    if (managedBuild && !rejected && !asked && !waiting) {
      if (completed) return { ok: true, report: { ...spent, card: id, landReady: { deliveryId: completed },
        session: recent?.resumeId ?? answer?.agentSession, reply: recent?.result, ...(history.length ? { retries: history } : {}) } }
      if (!deliveryId || !recent || !runStopped(recent)) return fail('The implementation result or delivery workspace was not saved.')
      return { ok: true, report: { ...spent, card: id, landReady: { deliveryId },
        session: recent.resumeId ?? answer?.agentSession, reply: recent.result, ...(history.length ? { retries: history } : {}) } }
    }
    if (!rejected && !completed && !asked && !waiting && (deliveryId || delivery)) {
      const reason = 'The run ended without a delivery receipt. Verify the saved work and finish the original delivery.'
      return { ok: false, reason, failure: makeFailure('validation', reason, { code: 'delivery_incomplete', detail: reason }), report: { ...spent, ...tracked } }
    }
    const said = (recent?.result ?? (recent ? answer?.result ?? answer?.error?.result : undefined))?.trim()
    const direct = effectiveVerb === 'implement' && !deliveryId && !delivery && !rejected && !asked && !waiting
    const state = rejected && effectiveVerb === 'implement' || asked && !deliveryId && !delivery ? { deliveryCompleted: false }
      : direct ? { deliveryCompleted: true, deliveryDirect: true } : tracked
    const landing = completed ? landingOf(delivery) : {}
    const session = recent?.resumeId ?? (recent ? answer?.agentSession ?? answer?.error?.agentSession : undefined)
    const retries = history.length ? history : undefined
    return { ok: true, report: { ...(said ? { reply: said } : {}), ...(session ? { session } : {}), ...spent, ...(retries ? { retries } : {}), card: id, ...state, ...(review ? { review } : {}), ...landing } }
  }

  /** A discarded build (#61): every delivery on the card still holding a checkout gives it up. */
  async function discardBuilds(): Promise<FlowEnd> {
    const pulled = await attemptSync(io, 'prepare', () => pull(ws, deps.machineId, () => stopping(io)))
    if (!pulled.ok) return fail(refusedSync(job, pulled))
    const card = ws.number
    if (!card) return { ok: true, report: {} }
    for (const delivery of checkoutsOf(ws, card)) {
      const ran = await akb(['delivery', 'cancel', delivery, '--json'], true)
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

export async function deliverySession(ws: TaskFolder, job: Job, deps: FlowDeps, report: JobReport) {
  const card = ws.number
  if (!card || report.card !== undefined && report.card !== card || !report.deliveryId && !report.session) return undefined
  const ran = await runAkb(deps.akb, ['run', 'list', '--card', String(card), '--all', '--json', '--board', ws.board], { cwd: ws.cwd, board: ws.board })
  const runs = answerOf<{ runs?: RunRecord[] }>(ran)?.runs ?? []
  return runs.flatMap(r => {
    if (!onTask(r, card) || r.parentId || r.status !== 'done' || r.harness !== job.runtime) return []
    const source = job.flow?.sync_recovery_of ?? job.syncRecoveryOf
    if (r.cloudExecution && !jobOwns(r, job.id, deps.machineId) && (!source || !jobOwns(r, source, deps.machineId))) return []
    const session = resumeSessionId(r)
    if (!session || (report.session ? session !== report.session : r.deliveryId !== report.deliveryId || r.action !== 'implement')) return []
    return [{ session, sessionCostUsd: r.sessionCostUsd, startedAt: r.startedAt }]
  }).sort((a, b) => b.startedAt - a.startedAt)[0]
}

export async function taskSessionMatches(ws: TaskFolder, deps: FlowDeps, session: string): Promise<boolean> {
  const card = ws.number
  if (!card) return false
  // The conversation can originate outside the board. Reject a known foreign card,
  // while leaving an unrecorded discussion or reply session eligible for normal resume.
  const ran = await runCommand(deps.akb, ws, ['list', '--conversation', session, '--all'])
  const runs = answerOf<{ runs?: Run[] }>(ran)?.runs
  return !!runs && !runs.some(r => (r.cardId != null || r.cloudExecution?.card !== undefined) && !onTask(r, card))
}

export async function confirmFlowStopped(ws: TaskFolder, job: Job, deps: FlowDeps): Promise<boolean> {
  const runs = await boardRuns(deps.akb, ws, ['--execution', job.id])
  if (!runs) return false
  const owned = runs.filter(r => jobOwns(r, job.id, deps.machineId))
  if (!owned.every(runStopped)) return false
  for (const r of owned) {
    const codex = await verifyFlowCodexRun(ws, job, r, runs)
    if (codex && !codex.stopped) return false
  }
  return true
}

export async function flowRunEvidence(ws: TaskFolder, job: Job, deps: FlowDeps, execution = job.id,
  prior?: FlowIo['flowRun']): Promise<{ stopped: boolean; run?: FlowIo['flowRun']; diagnostic?: string; mismatched?: boolean }> {
  const manual = job.flow?.resume_execution === execution
  const zh = cloudLanguage(job) === 'zh'
  const id = job.flow && ws.number
  if (job.flow && !id) return { stopped: false }
  const executions = prior?.from && prior.from !== execution ? [execution, prior.from] : [execution]
  const [byExecution, onCard] = await Promise.all([
    boardRuns(deps.akb, ws, ['--execution', ...executions]),
    id ? boardRuns(deps.akb, ws, ['--card', String(id)]) : Promise.resolve([]),
  ])
  if (!byExecution || !onCard) return { stopped: false }
  const bound = byExecution.filter(run => jobOwns(run, execution, deps.machineId) ||
    run.sessionId === prior?.id && !!prior?.from && jobOwns(run, prior.from, deps.machineId))
  const owned = bound.filter(run => !id || onTask(run, id))
  const mismatched = !!id && bound.some(run => run.cardId != null && !onTask(run, id))
  const allProbes = [...new Map([...onCard, ...bound].map(run => [run.sessionId, run])).values()]
  if (!allProbes.every(runStopped)) {
    return { stopped: false, mismatched, diagnostic: resumeBlocked({ stopped: false }, zh) }
  }
  const candidates = owned
    .filter(run => !run.parentId)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const fallbackOnCard = manual && id && candidates.length === 0
    ? onCard
        .filter(run => !run.parentId && onTask(run, id) && (!run.cloudExecution || run.cloudExecution.machine === deps.machineId))
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
    : undefined
  const previous = candidates.find(run => run.cloudExecution?.job === execution)
    ?? candidates.find(run => run.sessionId === prior?.id)
    ?? candidates[0]
    ?? (fallbackOnCard && fallbackOnCard.status !== 'done' ? fallbackOnCard : undefined)
  if (!previous || (manual && previous !== fallbackOnCard && previous.cloudExecution?.job !== execution)) {
    return { stopped: true, mismatched }
  }
  if (manual && id && isArchived(ws, id) && !asks(cardFile(ws)) && isSuccessfulArchive(cardFile(ws))) {
    return { stopped: true, mismatched }
  }
  const session = sessionOfRun(previous)
  if (session && id && !await taskSessionMatches(ws, deps, session)) {
    return { stopped: true, mismatched: true, diagnostic: zh ? '原会话归属无法核实。' : 'Could not verify that the session belongs to this task.' }
  }
  const codex = await verifyFlowCodexRun(ws, job, previous, allProbes)
  if (codex && !codex.stopped) {
    return { stopped: false, mismatched, diagnostic: resumeBlocked({ stopped: false }, zh) }
  }
  if (codex && !codex.ownershipOk) {
    return { stopped: true, mismatched: true, diagnostic: zh ? '原会话归属无法核实。' : 'Could not verify that the session belongs to this task.' }
  }
  const resumeDiagnostic = failedRunResumeDiagnostic(previous, true, zh, manual, codex)
  if (manual) {
    if (!session && previous.unspawned === true
        && !previous.pendingWrites && (!previous.managedProcess || stoppedCleanupConfirmed(previous.cleanup) || !previous.cleanup)) {
      return { stopped: true, mismatched }
    }
    if (resumeDiagnostic) return { stopped: true, diagnostic: resumeDiagnostic }
    return { stopped: true, mismatched, run: {
      id: previous.sessionId, finished: false, freshSession: !session, card: id || undefined, deliveryId: previous.deliveryId,
    } }
  }
  const retryableUnsafe = previous.retryPause === 'unsafe' && !resumeDiagnostic && !!session && !!previous.failure
    && 'plan' in planRetry(previous.failure, previous.retry?.attempt ?? 1, Date.now(), undefined, true)
  const terminal = job.flow && previous.status === 'error' && previous.retryPause && !retryableUnsafe
    ? previous.failure
    : undefined
  const failure = terminal && previous.retryPause === 'limit' ? { ...terminal, code: terminal.code ?? 'retry_exhausted' } : terminal
  const cleanupUnconfirmed = previous.cleanup ? !stoppedCleanupConfirmed(previous.cleanup) : false
  const staticUnconfirmed = (!!previous.retryPause && !retryableUnsafe) || !!previous.pendingWrites || cleanupUnconfirmed
  const unconfirmedCleanup = codex?.found
    ? (!codex.settled || (!!previous.retryPause && !retryableUnsafe))
    : staticUnconfirmed
  const recovery = agentRecovery({
    stopped: true,
    completed: previous.status === 'done' || !!failure,
    session,
    unconfirmedCleanup,
  })
  if (recovery === 'unsafe') return { stopped: true, mismatched }
  const { sessionId, runtime, startedAt, usage, costUsd, costIncomplete, context } = previous
  const priorSpend = new Map((!id || prior?.card === id ? prior?.priorSpend : undefined)?.map(spend => [spend.sessionId, spend]))
  priorSpend.set(sessionId, { sessionId, runtime, startedAt, usage, costUsd, costIncomplete, context })
  return { stopped: true, mismatched, run: { id: sessionId, finished: recovery === 'report', from: previous.cloudExecution?.job, card: id || undefined,
    ...(previous.resumeId ? { agentSession: previous.resumeId } : {}),
    ...(previous.deliveryId ? { deliveryId: previous.deliveryId } : {}),
    ...(failure ? { failure, resumeDiagnostic: resumeDiagnostic ?? null } : {}), ...(previous.retryPause && !retryableUnsafe ? { retryPause: previous.retryPause } : {}), priorSpend: [...priorSpend.values()] } }
}
