import { REVIEW_SYNC_ENV } from '../../cli/src/lib/cloud/review-sync'
import { isFlatReviewPlan } from '../../cli/src/lib/shared/review-plan'
import { readPin, readRuntimeContext, readStudioSession, saveRuntimeContext, saveStudioSession, STUDIO_SNAPSHOT_ENV } from '../../cli/src/lib/agent/cloud-studios'
import { reviewAllows, reviewAuthorization } from '../../cli/src/lib/shared/review-plan'
import { reviewBoundary, taskReviewBoundary } from '../../cli/src/lib/shared/review-plan'
import { createHash } from 'node:crypto'
import { ownCost } from '../../cli/src/lib/agent/own-cost'
import { attachmentPaths } from '../../cli/src/lib/agent/pictures'
import { conflictPrompt, pendingConflicts } from '../../cli/src/lib/shared/board-conflicts'
import { idleStopConfirmed } from '../../cli/src/lib/agent/wire/codex-background-types'
import { createIdleWatchdog, IDLE_FAILURE } from '../../cli/src/lib/agent/idle'
import { clipDetail, clipSummary, isSessionMissingFailure, makeFailure, MAX_RETRY_ATTEMPTS, mergeRetryHistory, pauseLine, planRetry, recoveryPrompt, retryBudget, retryContinuePrompt, retryRecord, syncRepairPrompt, waitForRetry, type ExecutionFailure, type FailureDetail, type RetryPause, type RetryRecord, type RetryRuntime, type SessionAction } from '../../cli/src/lib/agent/retry'
import { ExecutionError, executionFailure } from '../../cli/src/lib/agent/wire/failures'
import { contextUpdate, reviewBlock, taskCardBlock, type ContextBlock, type SentContext } from '../../cli/src/lib/agent/runtime-context'
import { taskContextBlocks, taskStudioContext, taskStudioComponents, taskStudio } from './task-folder'
import { connectionIdentity, endConnection } from '../../cli/src/lib/agent/connection-process'
import { conversationProgress } from './conversation-progress'
import { readSession } from '../../cli/src/lib/cloud/session'
import { accountGeneration } from './settings-control'
import { CONVERSATION_MS } from '../../cli/src/lib/shared/conversation'
import { streamFinished } from '../../cli/src/lib/agent/wire/background'
import { saveReplyImages } from './reply-images'
import { replyPrompt, writeReplyHistory } from './reply-input'
// 领取作业、运行并回写；断网只能运行到租约到期，失效后停止本地执行。

import { cloudLanguage } from '../../cli/src/lib/agent/language'
import { authorizedFolder, progressEvidence, progressFolder, restartFolder } from './handoff'
import { markEnv, stopMark } from '../../cli/src/lib/agent/stop'
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { spawnable } from '../../cli/src/lib/agent/spawnable'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { contextLimit, refreshCatalog } from '../../cli/src/lib/agent/catalog'
import { previewSyncBridge, replyApprovalBridge } from './reply-approval'
import { confirmLandArchive, protectLandArchive, syncedArchive, syncedCardVersion, withBoard, taskAssetsSynced } from './task-folder'
import { akbEnv, type Akb } from './akb'
import { currentAkb } from './akb-version'
import { turnSubmitted } from '../../cli/src/lib/agent/wire/events'
import type { RunEvent, TurnEnd } from '../../cli/src/lib/agent/wire'
import * as api from './api'
import type { AgentJob, Flow, Job, JobEvent, JobReport, ReplyContext, RuntimeReport } from './api'
import { keepChat, keepCloudChat, keepDecisions, markReviewed, reviewMarks } from './chats'
import { confirmFlowStopped, deliverySession, flowRunEvidence, runAgent, runFlow, runReview, stopFlowRuns, taskSessionMatches, writeTranscript } from './flow'
import { hold } from './cache'
import { allowedProjects } from './folders'
import { readGoals, writeGoals } from './goals'
import { replySpent, checkpointEvent, checkpointRecovery, clearCheckpoint, readCheckpoint, recoveryBlocked, retryFileOf, saveCheckpoint, stopReply, isReply, replyRecovery, replayable, usesBoardRun, type Checkpoint } from './recovery'
import { runnerHome } from './home'
import { landArchiveRefusal, landLeaseLost, resumeArchive, retryableSync, staleArchiveReceipt, syncBackoff, syncRefusal, syncStopped, writeBlock, type SyncStep, type Sync } from './sync-retry'
import { logSync } from './sync-debug'
import { trackSubagents } from './subagents'
import { followProxy } from './proxy'
import { detectRuntimes, forks, plan as realPlan, takesImageArgs, type DiscussionImages, type Plan, type Settings } from './runtimes'
import { keepSecrets, secretsOf } from './secrets'
import { NO_FOLDER, cardFile, openAgentFolder, openDiscussionFolder, openTaskFolder, pull, push, undrawnPreviews, type Pushed, type TaskFolder } from './task-folder'

/** Output goes every 2 seconds or 32 KB while a page watches and not at all while none does:
 *  the job's log object costs nothing until someone opens it (#228). */
const FLUSH_MS = 2_000
const FLUSH_CHARS = 32 * 1024
/** Cloud's caps: events per message, and the text one event keeps. */
const BATCH_EVENTS = 500
const BATCH_CHARS = 512 * 1024
const EVENT_CHARS = 64 * 1024
const END_MS = 10_000
const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** Well inside the service's 15-minute lease. */
const RENEW_MS = 5 * 60_000
/** A silent socket gets no error until written to, and a page opening the log waits on it. */
const LOG_PING_MS = 30_000
/** cloud/src/config.ts's RUNNER_LEASE_SECONDS: a job not renewed for this long is no longer ours. */
const LEASE_MS = 15 * 60_000
/** How often a result waiting offline tries Cloud again. */
const RETRY_MS = 30_000
const KILL_GRACE_MS = 5_000
/** Board changes this close together go to Cloud as one write (#59). */
const WATCH_MS = 1_000
/** How long stopping a job's board runs may take before the Runner exits anyway. */
export const STOP_MS = 10_000
/** A connection test's limit; cloud/src/config.ts's RUNTIME_TEST_SECONDS matches it. */
export const TEST_MS = 30_000

interface Shared {
  authorize?: (job: Job) => Promise<boolean | api.Call<boolean>>
  machineId: string
  api: Pick<typeof api, 'claimJob' | 'renewJob' | 'openLog' | 'finishJob' | 'readTask' | 'listStudios' | 'readRejections' | 'markReviewed' | 'readChat' | 'readDecisions' | 'listChats' | 'uploadReplyImage' | 'readReplyHistory'>
  plan: typeof realPlan
  /** How often output goes while a page watches. */
  flushMs: number
  logPingMs: number
  /** How long the end waits for the log to be stored before finishing anyway. */
  endMs: number
  testMs: number
  renewMs: number
  leaseMs: number
  retryMs: number
  replyBackoff?: (attempt: number) => number
  syncBackoff?: (attempt: number) => number
  stopMs: number
  /** How long a board change waits for the next before it goes; null watches no board. */
  watchMs: number | null
  runtimes: () => Promise<RuntimeReport[]>
}

export interface Deps extends Shared {
  /** The akb a new step starts on. */
  akb: () => Akb
}

/** One step's, its akb chosen once: a release mid-step reaches the next one (#171). */
interface StepDeps extends Shared {
  akb: Akb
}

export const defaultDeps = (machineId: string): Deps => ({
  machineId,
  api,
  plan: realPlan,
  flushMs: FLUSH_MS,
  logPingMs: LOG_PING_MS,
  endMs: END_MS,
  renewMs: RENEW_MS,
  leaseMs: LEASE_MS,
  retryMs: RETRY_MS,
  testMs: TEST_MS,
  stopMs: STOP_MS,
  watchMs: WATCH_MS,
  akb: currentAkb,
  runtimes: detectRuntimes,
})

export const ownFolder = () => path.join(runnerHome(), 'work')

/** Where a job runs, or why it may not. A named folder must be inside one the user allowed;
 *  links and `..` are resolved first, so neither can step outside it. */
export function folderFor(job: Pick<Job, 'id' | 'projectDir'>): { cwd: string } | { refused: string } {
  if (!job.projectDir) {
    const cwd = path.join(ownFolder(), job.id)
    fs.mkdirSync(cwd, { recursive: true })
    return { cwd }
  }
  const real = realpath(job.projectDir)
  if (real && allowedProjects().some((root) => real === root || real.startsWith(root + path.sep))) return { cwd: real }
  return { refused: `This Runner is not allowed to work in ${job.projectDir}.` }
}

function realpath(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

const attachmentsOf = (job: Pick<Job, 'id'>) => path.join(runnerHome(), 'attachments', job.id)

/** The attachments, written beside the Runner's files, and the lines that tell the agent. They
 *  go once the job ends. */
function writeAttachments(job: Job, nativeImages: boolean): { text: string; files: string[] } {
  if (!job.attachments.length) return { text: '', files: [] }
  const dir = attachmentsOf(job)
  fs.mkdirSync(dir, { recursive: true })
  const files = job.attachments.map((a, index) => {
    const name = path.basename(a.name)
    const file = path.join(dir, nativeImages ? `${index + 1}-${name}` : name)
    fs.writeFileSync(file, Buffer.from(a.content, 'base64'))
    return file
  })
  return { text: nativeImages ? '' : attachmentPaths(files), files }
}

const cut = (text: string) => (text.length > EVENT_CHARS ? text.slice(0, EVENT_CHARS) : text)

/** Events as Cloud keeps them: neighbouring log text joined, long text cut, one `seq` each. */
export function toWire(events: RunEvent[], first: number): JobEvent[] {
  const out: JobEvent[] = []
  let log = ''
  const endLog = () => {
    for (let at = 0; at < log.length; at += EVENT_CHARS) out.push({ seq: first + out.length, kind: 'log', text: log.slice(at, at + EVENT_CHARS) })
    log = ''
  }
  for (const e of events) {
    if (e.kind === 'log') {
      if (e.data.text.startsWith('[chat-recovery] ')) {
        endLog()
        out.push({ seq: first + out.length, kind: 'log', text: e.data.text })
        continue
      }
      log += e.data.text
      continue
    }
    endLog()
    const data: Record<string, unknown> = { ...e.data, eventAt: 'eventAt' in e.data ? e.data.eventAt : new Date().toISOString() }
    for (const key of ['text', 'result'] as const) if (typeof data[key] === 'string') data[key] = cut(data[key] as string)
    if (e.kind === 'retry') {
      if (typeof data.summary === 'string') data.summary = clipSummary(data.summary)
      if (typeof data.detail === 'string') data.detail = clipDetail(data.detail)
    }
    out.push({ seq: first + out.length, kind: e.kind, text: '', data })
  }
  endLog()
  return out
}

/** When the lease was last renewed: the job is Cloud's again `leaseMs` after. */
interface Lease {
  at: number
  monotonic: number
  lost?: boolean
}

const leaseNow = (): Lease => ({ at: Date.now(), monotonic: performance.now() })

/** Output sent back over the job's log stream while a page watches, and the lease kept; a lost
 *  lease stops what it adopted and what it was told to stop. Every event stays here, so a page
 *  or a new connection gets what the log does not have yet. Cloud asking to stop, over the log
 *  or on a renewal, stops what it adopted too, the job still ours to finish. */
function streamOut(deps: Shared, id: string, lease: Lease) {
  const wire: JobEvent[] = []
  let firstContent = false
  let bufferedChars = 0
  let firstSeq: number | null = null
  let pending: RunEvent[] = []
  let size = 0
  let lost = false
  let ending = false
  let closed = false
  let flushedAt = Date.now()
  const log = { ws: null as WebSocket | null, after: null as number | null, watched: false, heard: 0, tries: 0, retry: undefined as ReturnType<typeof setTimeout> | undefined }
  let ended = () => {}
  const stored = new Promise<void>((resolve) => (ended = resolve))
  const children = new Set<ChildProcess>()
  const groups = new Set<number>()
  const connections = new Set<ChildProcess>()
  let stopConfirmed = true
  const killed = new Set<Promise<void>>()
  const kill = (child: ChildProcess) => {
    if (!child.pid) return
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
    killed.add(exited)
    void exited.then(() => killed.delete(exited))
    if (connections.has(child)) { endConnection(child); return }
    signalTree(child, 'SIGTERM')
    const timer = setTimeout(() => signalTree(child, 'SIGKILL'), KILL_GRACE_MS)
    timer.unref()
    void exited.then(() => clearTimeout(timer))
  }
  let halt: (() => Promise<void>) | null = null
  let stopping = Promise.resolve()
  const messages: string[] = []
  let asked = false
  let onAsked = () => {}
  const askedOnce = new Promise<void>((resolve) => (onAsked = resolve))
  const ask = () => {
    if (asked || lost) return
    asked = true
    for (const child of children) kill(child)
    if (halt) stopping = halt().catch(() => { stopConfirmed = false })
    onAsked()
  }
  const loseLease = () => {
    if (lost) return stopping
    lost = true
    lease.lost = true
    onAsked()
    for (const child of children) kill(child)
    stopping = Promise.all([halt?.(), ...killed]).then(() => {}).catch(() => { stopConfirmed = false })
    return stopping
  }
  const valid = () => {
    if (!held(deps, lease)) void loseLease()
    return !lost
  }

  /** What the log does not have yet, then the end once asked for. */
  const send = () => {
    if (!valid()) return
    const ws = log.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || log.after === null) return
    const after = log.after
    const unsent = log.watched ? wire.filter((e) => e.seq > after) : []
    let batch: JobEvent[] = []
    let chars = 0
    const out = () => {
      if (batch.length) ws.send(JSON.stringify({ type: 'events', events: batch }))
      batch = []
      chars = 0
    }
    for (const e of unsent) {
      const n = JSON.stringify(e).length
      if (batch.length === BATCH_EVENTS || chars + n > BATCH_CHARS) out()
      batch.push(e)
      chars += n
    }
    out()
    if (unsent.length) log.after = unsent[unsent.length - 1]!.seq
    if (ending) ws.send(JSON.stringify({ type: 'end' }))
  }
  const flush = () => {
    flushedAt = Date.now()
    if (firstSeq !== null && pending.length) {
      wire.push(...toWire(pending, firstSeq + wire.length))
      pending = []
    }
    size = 0
    send()
  }
  const connect = async () => {
    log.retry = undefined
    const ws = await deps.api.openLog(deps.machineId, id).catch(() => null)
    if (closed || !valid()) return ws?.close()
    if (!ws) return reconnect()
    log.ws = ws
    log.heard = Date.now()
    ws.addEventListener('message', (m) => {
      log.heard = Date.now()
      let said: { type?: string; after?: number; watched?: boolean; on?: boolean }
      try {
        said = JSON.parse(String(m.data))
      } catch {
        return
      }
      if (said.type === 'hello') {
        log.tries = 0
        log.after = Number.isInteger(said.after) ? said.after! : -1
        firstSeq ??= log.after + 1
        log.watched = said.watched === true
        flush()
      } else if (said.type === 'watched') {
        log.watched = said.on === true
        if (log.watched) flush()
      } else if (said.type === 'ended') ended()
      else if (said.type === 'stop') ask()
    })
    ws.addEventListener('close', () => drop(ws))
    ws.addEventListener('error', () => {})
  }
  const drop = (ws: WebSocket) => {
    if (log.ws !== ws) return
    log.ws = null
    log.after = null
    reconnect()
  }
  const reconnect = () => {
    if (log.retry || lost || closed) return
    log.retry = setTimeout(() => void connect(), RECONNECT_MS[Math.min(log.tries++, RECONNECT_MS.length - 1)])
  }
  void connect()

  const event = (e: RunEvent) => {
    if (!valid()) return
    if (e.kind === 'message') messages.push(e.data.text)
    const content = ['message', 'tool_call', 'tool_call_update', 'plan'].includes(e.kind) || e.kind === 'phase' && !!e.data.contentAt || e.kind === 'status' && e.data.state === 'thinking'
    const immediate = e.kind === 'phase' || e.kind === 'status' || e.kind === 'retry' || content && !firstContent
    firstContent ||= content
    const stamped = Object.assign({}, e, { data: { ...e.data, eventAt: 'eventAt' in e.data ? e.data.eventAt : new Date().toISOString() } })
    const chars = JSON.stringify(stamped).length
    // Match RunLog's retention cap, including while disconnected or unwatched.
    if (bufferedChars + chars > 16 * 1024 * 1024) return
    bufferedChars += chars
    pending.push(stamped)
    size += chars
    if (immediate || log.watched && size >= FLUSH_CHARS) flush()
  }
  const flusher = setInterval(() => {
    if (log.watched && pending.length && Date.now() - flushedAt >= deps.flushMs) flush()
  }, Math.min(deps.flushMs, 1_000))
  const pinger = setInterval(() => {
    const ws = log.ws
    if (ws?.readyState !== WebSocket.OPEN) return
    if (Date.now() - log.heard <= deps.logPingMs * 2) return ws.send('ping')
    drop(ws)
    ws.close()
  }, deps.logPingMs)
  // 不依赖网络响应；休眠唤醒后的回调也必须先检查截止时间。
  const expiry = setInterval(valid, Math.min(1_000, deps.leaseMs))
  let renewing = false
  const renewer = setInterval(async () => {
    if (renewing || !valid()) return
    renewing = true
    const requestedAt = leaseNow()
    const renewed = await deps.api.renewJob(deps.machineId, id).catch(() => null).finally(() => { renewing = false })
    if (!valid() || closed || !renewed) return
    if (renewed.ok && !renewed.value.renewed) return void loseLease()
    if (!renewed.ok) return
    Object.assign(lease, requestedAt)
    if (renewed.value.stop) ask()
    // A run quiet for a while is still running: its log must not end itself.
    if (!ending && log.ws?.readyState === WebSocket.OPEN) log.ws.send(JSON.stringify({ type: 'alive' }))
  }, deps.renewMs)
  return {
    event,
    out: (text: string) => {
      if (text) event({ kind: 'log', data: { text } })
    },
    adopt: (child: ChildProcess, managed = false) => {
      if (managed) connections.add(child)
      else if (child.pid) groups.add(child.pid)
      if (!valid() || asked) return kill(child)
      children.add(child)
      child.on('close', () => children.delete(child))
    },
    onStop: (stop: () => Promise<void>) => {
      halt = stop
      if (lost || asked) stopping = stop().catch(() => { stopConfirmed = false })
    },
    /** What stopping the job's board runs is still doing. */
    halted: () => stopping,
    confirmed: async () => {
      await stopping
      if (!stopConfirmed) return false
      const until = Date.now() + deps.stopMs
      const alive = (pid: number) => {
        try { process.kill(-pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH' }
      }
      if (process.platform === 'win32') return children.size === 0
      while ([...groups].some(alive) || [...connections].some(c => c.exitCode === null && c.signalCode === null)) {
        if (Date.now() >= until) return false
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return true
    },
    stop: loseLease,
    requestStop: ask,
    lost: () => !valid(),
    asked: () => asked,
    whenAsked: askedOnce,
    /** The agent's messages so far. */
    said: () => messages.join('\n\n'),
    /** The rest sent and the log stored, or given up on after a while: `finish` comes after. */
    end: async () => {
      if (closed) return
      clearInterval(flusher)
      clearInterval(pinger)
      clearInterval(renewer)
      clearInterval(expiry)
      ending = !lost
      flush()
      if (ending) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([stored, new Promise<void>((resolve) => (timer = setTimeout(resolve, deps.endMs)))])
        clearTimeout(timer)
      }
      closed = true
      clearTimeout(log.retry)
      const ws = log.ws
      log.ws = null
      ws?.close()
      await stopping
    },
  }
}

/** Claim and run one job. Only a changed queue requires an immediate reread. */
export async function runJob(id: string, deps: Deps, track: (stop: () => Promise<void>) => void = () => {}, stopped = () => false, reply = false): Promise<'changed' | 'unchanged' | 'retry'> {
  followProxy()
  const lease = leaseNow()
  const claim = await deps.api.claimJob(deps.machineId, id, reply)
  if (!claim.ok) return api.temporaryCloudFailure(claim) ? 'retry' : 'unchanged'
  if (!claim.value.claimed) return claim.value.retired ? 'changed' : 'unchanged'
  if (stopped() || !held(deps, lease)) return 'changed'
  const job = claim.value.job
  if (job.chat || job.discussion) console.info('reply-dispatch', { event: 'claimed', job: id, at: new Date().toISOString() })
  const releases: (() => void)[] = []
  try {
    const akb = deps.akb()
    releases.push(hold(path.dirname(akb.shim)))
    releases.push(hold(akb.shim))
    await runClaimed(job, { ...deps, akb }, track, (dir) => releases.push(hold(dir)), lease)
  } finally {
    for (const release of releases) release()
    fs.rmSync(attachmentsOf(job), { recursive: true, force: true })
  }
  return 'changed'
}

interface JobScope {
  bridge?: Awaited<ReturnType<typeof replyApprovalBridge>>
  reviewSync?: Awaited<ReturnType<typeof previewSyncBridge>>
  progress?: ReturnType<typeof conversationProgress>
  waitingStream?: ReturnType<typeof streamOut>
}

/** `keep` keeps a project folder out of the cache's cleanup until the job ends. */
async function runClaimed(job: Job, deps: StepDeps, track: (stop: () => Promise<void>) => void, keep: (dir: string) => void, lease: Lease, replyStream?: ReturnType<typeof streamOut>): Promise<void> {
  const scope: JobScope = {}
  try { await runClaimedStep(job, deps, track, keep, lease, scope, replyStream) }
  finally {
    scope.progress?.cancel()
    scope.bridge?.close()
    scope.reviewSync?.close()
    await scope.waitingStream?.end()
  }
}

async function runClaimedStep(job: Job, deps: StepDeps, track: (stop: () => Promise<void>) => void, keep: (dir: string) => void,
  lease: Lease, scope: JobScope, replyStream?: ReturnType<typeof streamOut>): Promise<void> {
  const id = job.id
  const local = readCheckpoint(id)
  const sourceId = job.flow?.sync_recovery_of ?? job.syncRecoveryOf ?? job.recoveryOf
  const source = sourceId && job.flow?.phase !== 'land' ? readCheckpoint(sourceId) : null
  const previous = local ?? source
  const priorExecution = !!previous && previous.started !== false
  const checkpoint: Checkpoint = previous ?? { pending: [], started: false, effects: false }
  const manual = job.manualRecovery === true
  if (manual && !local) {
    delete checkpoint.retryRound
    delete checkpoint.syncRetries
    delete checkpoint.reconcileRetry
    delete checkpoint.syncFailure
    delete checkpoint.ending
    delete checkpoint.retryHistory
  }
  const verification = job.flow?.verify_delivery
  if (verification && !local) {
    delete checkpoint.ending
    delete checkpoint.syncFailure
    if (checkpoint.completed?.outcome !== 'done' || !verification.confirmed || checkpoint.completed.report.deliveryId !== verification.id) {
      delete checkpoint.completed
    }
  }
  checkpoint.retryRound ??= manual && !local ? id : sourceId ?? id
  const retryFile = retryFileOf(checkpoint.retryRound)
  const legacyAttempt = Math.max(1 + Math.max(job.flow?.recovery_attempts ?? 0, manual ? 0 : verification?.attempts ?? 0), manual && !local ? 1 : checkpoint.retry?.attempt ?? 1,
    ...Object.values(checkpoint.syncRetries ?? {}).map(retry => retry?.attempt ?? 1), checkpoint.reconcileRetry?.attempt ?? 1)
  const budget = retryBudget(retryFile, Math.min(MAX_RETRY_ATTEMPTS + 1, legacyAttempt))
  if (job.flow && checkpoint.flowResume !== undefined) job = { ...job, flow: { ...job.flow, resume: checkpoint.flowResume } }
  const flow = job.flow
  let ws: TaskFolder | null = null
  let verifiedFlow = false
  if (flow?.historical_recovery && source && !local) {
    for (const saved of [checkpoint.completed, checkpoint.boardContinuation]) {
      if (!saved) continue
      const { usage, costUsd, costIncomplete, runtimeCosts, attemptCosts, ...report } = saved.report
      saved.report = report
    }
  }
  // A legacy result can contain the last run of another card. Check the saved command's
  // ownership before replaying its report or turning a flow into a writeback conversation.
  if (flow && (priorExecution || sourceId) && job.projectDir) {
    const folder = folderFor(job)
    if (folder && !('refused' in folder)) {
      const ws = openTaskFolder(job, folder.cwd)
      const execution = local ? id : sourceId!
      if (!await stopFlowRuns(ws, { ...job, id: execution }, deps)) return
      const saved = await flowRunEvidence(ws, job, deps, execution, checkpoint.flowRun)
      if (!saved.stopped) return
      verifiedFlow = true
      checkpoint.flowRun = saved.run
      const reports = [checkpoint.completed?.report, checkpoint.ending?.report, checkpoint.boardContinuation?.report]
      if (saved.mismatched || reports.some(report => report?.card !== undefined && report.card !== ws.number)) {
        delete checkpoint.completed
        delete checkpoint.ending
        delete checkpoint.boardContinuation
        delete checkpoint.session
        delete checkpoint.retryHistory
        delete checkpoint.syncFailure
      }
    }
  }
  if (checkpoint.boardContinuation) job = { ...job, task: job.task ?? job.review?.tasks[0], flow: undefined, review: undefined, handoff: undefined, prompt: checkpoint.boardContinuation.prompt, resume: checkpoint.session, fork: false }
  const reply = !flow && isReply(job)
  const replyInput = reply && !checkpoint.boardContinuation ? job.replyInput : undefined
  let sessionContext: SentContext | undefined
  let replyContext: ReplyContext | undefined
  let replyReviewRevision: number | undefined
  const spent = (): JobReport | undefined => reply && checkpoint.attempts?.length && !(job.recoveryOf && !local && checkpoint.completed)
    ? { session: checkpoint.session, ...replySpent(checkpoint, job.runtime) } : undefined
  const unsavedGoals = (report: JobReport): JobReport => {
    const { goals, goalsVersion, ...saved } = report
    const notice = cloudLanguage(job) === 'zh' ? '目标未能保存到当前讨论。' : 'The goals could not be saved to this discussion.'
    return { ...saved, reply: [notice, saved.reply].filter(Boolean).join('\n\n'),
      ...(saved.parts ? { parts: [{ type: 'text', text: `${notice}\n\n` }, ...saved.parts] } : {}) }
  }
  const retryHistory = (report?: JobReport) => mergeRetryHistory(checkpoint.retryHistory, report?.retries)
  const checkingArchive = cloudLanguage(job) === 'zh' ? '正在同步已保存的归档。' : 'Synchronizing the saved archive.'
  const finishClaimed: FinishJob = async (outcome, reason = '', said, landed) => {
    const before = spent()
    let report = before ? { ...before, ...said } : said
    if (flow && (flow.phase === 'land' || outcome === 'stopped') && !report?.processesStopped) {
      const stream = watching()
      if (stream.asked()) await stream.halted()
      if (!await stream.confirmed() || ws && !await confirmFlowStopped(ws, job, deps)) return
      report = { ...report, processesStopped: true }
    }
    if (reply && checkpoint.replyParts && report) {
      const stream = watching()
      const parts = await saveReplyImages(checkpoint.replyParts.parts, checkpoint.replyParts.cwd, async (key, bytes, mime) => {
        const saved = checkpoint.replyImages?.job === id ? checkpoint.replyImages.files[key] : undefined
        if (saved) return saved
        if (outcome !== 'done' || report?.stopped || checkpoint.syncFailure || stream.asked() || stream.lost()) return { status: 'not_saved' }
        const uploaded = await sync(`reply-image:${key}`, () => deps.api.uploadReplyImage(deps.machineId, id, key, bytes, mime))
        if (!uploaded.ok) return { status: 'not_saved' }
        if (checkpoint.replyImages?.job !== id) checkpoint.replyImages = { job: id, files: {} }
        checkpoint.replyImages.files[key] = uploaded.value
        persist()
        return uploaded.value
      })
      if (stream.lost()) return
      if (parts) report = { ...report, parts, reply: parts.filter(p => p.type === 'text').map(p => p.text).join('') }
      if (outcome === 'done' && checkpoint.syncFailure) outcome = 'failed'
    }
    if (outcome === 'failed' && checkpoint.syncFailure) {
      const { failure: saved, pause, safe } = checkpoint.syncFailure
      const failure = saved.summary === checkingArchive && flow?.phase === 'land' ? { ...saved, summary: resumeArchive(job) } : saved
      const recovery = report?.recovery ?? (reply && safe && (checkpoint.completed?.outcome === 'done' || checkpoint.ending)
        ? { safe: false, resumable: true, stopped: true } : reply && safe ? replyRecovery(job, checkpoint, true) : undefined)
      report = { ...report, failure: buildFailureDetail(failure, pause, safe), ...(recovery ? { recovery } : {}) }
      if (pause === 'limit' && job.flow) reason = 'task_retry_exhausted: ' + failure.summary
      else reason = failure.summary
    }
    if (checkpoint.boardContinuation?.report.deliveryCompleted && !said?.deliveryCompleted) {
      report = continuationResult(report ?? {})
    }
    if (reply && outcome === 'failed' && !report?.reply && checkpoint.partialReply) {
      report = { ...report, reply: checkpoint.partialReply }
    }
    if (reply && outcome === 'failed' && !report?.recovery && checkpoint.started === false
        && (!(job.recoveryOf || job.manualRecovery) || previous || job.retryReplay === true)
        && checkpointRecovery(job, checkpoint, true) === 'replay') {
      report = { ...report, recovery: replyRecovery(job, checkpoint, true) }
      saveCheckpoint(id, checkpoint)
    }
    const retries = retryHistory(report)
    if (outcome === 'done' && retries.length) report = { ...report, retries }
    const recoveryAttempts = budget.attempt() - 1
    if (flow && report && !report.review &&
        (report.deliveryId && report.deliveryCompleted === false ||
         recoveryAttempts > 0 && (report.deliveryId || report.deliveryCompleted === false || flow.verify_delivery))) {
      report = { ...report, recoveryAttempts }
    }
    const draft = report
    if (job.discussion && draft?.goals !== undefined) {
      const unsaved = unsavedGoals(draft)
      const notice = unsaved.reply!.split('\n\n')[0]!
      if (outcome === 'done' && !draft.stopped) {
        await settle(outcome, reason, draft, async () => {
          checkpoint.completed = { outcome: 'failed', reason: notice, report: unsaved }
          persist()
          return settle('failed', notice, unsaved)
        })
        return
      }
      report = unsaved
    }
    if (before && outcome === 'failed' && checkpoint.completed?.outcome !== 'done') {
      checkpoint.completed = { outcome, reason, report: report! }
      saveCheckpoint(id, checkpoint)
    }
    if (await settle(outcome, reason, report)) landed?.()
  }
  if (replyInput && manual && !previous && !job.retryReplay) checkpoint.submissionUnknown = true
  const updating = checkpoint.updating === true
  const recovering = updating || !!checkpoint.taskRecovery || !!sourceId || manual || !!checkpoint.retry?.pending || !!previous?.boardContinuation
  const persist = () => {
    checkpoint.updating ||= readCheckpoint(id)?.updating
    saveCheckpoint(id, checkpoint)
  }
  const starting = () => {
    checkpoint.started = true
    delete checkpoint.updating
    delete checkpoint.interrupted
    saveCheckpoint(id, checkpoint)
  }
  if (manual && !local && checkpoint.completed?.outcome !== 'done') {
    if (checkpoint.completed?.outcome === 'failed') {
      delete checkpoint.completed
      delete checkpoint.attempts
      delete checkpoint.partialReply
    }
    checkpoint.retry = { since: Date.now(), attempt: 1 }
    delete checkpoint.retryPause
    delete checkpoint.failure
    delete checkpoint.launching
  }
  const forkSource = job.fork ? job.resume : checkpoint.forkSource
  if (forkSource && checkpoint.submitted !== true) {
    checkpoint.forkSource = forkSource
    if (checkpoint.session === forkSource) delete checkpoint.session
  }
  // A Cloud replay receipt describes a turn that never ran, not the carried conversation.
  if (manual && !local && job.retryReplay && !checkpoint.completed && replayable(checkpoint)) delete checkpoint.session
  if (!forkSource && (!previous || checkpoint.started === false) && !job.retryReplay) checkpoint.session ??= job.resume ?? undefined

  const runtimeInfo = (): RetryRuntime => ({ connector: job.runtime, name: null, model: job.model ?? null })
  const buildFailureDetail = (
    failure: ExecutionFailure | undefined,
    pause: RetryPause,
    safeToRetry: boolean,
    sessionAction?: SessionAction,
    fallbackSummary?: string,
  ): FailureDetail => {
    const history = retryHistory(checkpoint.completed?.report)
    const summary = clipSummary(failure?.summary || fallbackSummary || pauseLine(pause, cloudLanguage(job) === 'zh')) || 'Execution failed.'
    const detail = clipDetail(failure?.detail)
    return {
      summary,
      ...(detail && detail !== summary ? { detail } : {}),
      ...(failure?.code ? { code: failure.code } : {}),
      source: failure?.source ?? 'runtime',
      runtime: runtimeInfo(),
      attempt: Math.min(MAX_RETRY_ATTEMPTS, Math.max(1, budget.attempt() - 1)),
      maxAttempts: MAX_RETRY_ATTEMPTS,
      pauseReason: pause,
      safeToRetry,
      ...(sessionAction ? { sessionAction } : {}),
      history,
    }
  }

  const pauseRecovery = (pause: RetryPause, stopped: boolean) => {
    checkpoint.retryPause = pause
    if (checkpoint.retry) delete checkpoint.retry.pending
    persist()
    const recovery = replyRecovery(job, checkpoint, stopped)
    const safeToRetry = pause !== 'unsafe' && (recovery.safe || recovery.resumable)
    const sessionAction: SessionAction | undefined = pause === 'unsafe' ? 'pause_unsafe' : recovery.safe ? 'reset_replay' : recovery.resumable ? 'resume' : undefined
    const failureDetail = buildFailureDetail(checkpoint.failure, pause, safeToRetry, sessionAction)
    const reason = [checkpoint.failure?.summary, pauseLine(pause, cloudLanguage(job) === 'zh')].filter(Boolean).join('\n')
    return finishClaimed('failed', pause === 'unsafe' && reply ? 'recovery_unsafe' : reason, {
      ...(reply ? { recovery } : {}),
      failure: failureDetail,
    })
  }
  const watching = () => {
    const stream = replyStream ?? (scope.waitingStream ??= streamOut(deps, id, lease))
    track(stream.stop)
    return stream
  }
  const recoveryState = async (state: api.TaskRecovery | null) => {
    if (state) checkpoint.taskRecovery = state
    else delete checkpoint.taskRecovery
    persist()
    const stream = watching()
    const sentAt = leaseNow()
    const renewed = await deps.api.renewJob(deps.machineId, id, { taskRecovery: state })
    if (renewed.ok && renewed.value.renewed && state?.code !== 'allowance') Object.assign(lease, sentAt)
    if (renewed.ok && renewed.value.stop) stream.requestStop()
    if (renewed.ok && renewed.value.projectDir && !job.projectDir) job = { ...job, projectDir: renewed.value.projectDir }
    return renewed
  }
  const waitForAccess = async (code: 'folder' | 'login', ready: () => boolean | Promise<boolean>) => {
    const stream = watching()
    while (!stream.asked() && !stream.lost()) {
      if (await ready()) {
        if (checkpoint.taskRecovery?.code === code) await recoveryState(null)
        return !stream.asked() && !stream.lost()
      }
      const status = await recoveryState({ code })
      if (status.ok && !status.value.renewed) return false
      await waitForRetry(Date.now() + deps.retryMs, stream.whenAsked)
    }
    return false
  }
  function retryEvent(stream: ReturnType<typeof streamOut>, record: RetryRecord, state: 'waiting' | 'retrying' | 'recovered' | 'paused',
    attempt: number, at?: number) {
    stream.event({ kind: 'retry', data: { ...record, state, attempt: Math.max(1, attempt), maxAttempts: MAX_RETRY_ATTEMPTS,
      ...(at === undefined ? {} : { nextRetryAt: new Date(at).toISOString() }) } })
  }
  const quietArchiveSync = (step: SyncStep) => flow?.phase === 'land' && (step === 'publish' || step === 'repair' || step === 'confirm'
    || step === 'finish' && !!checkpoint.ending?.report?.archive)
  function schedule(step: SyncStep, failure: ExecutionFailure, backoff = deps.syncBackoff ?? syncBackoff) {
    const attempt = budget.attempt()
    const record = retryRecord(failure, attempt, runtimeInfo())
    if (!quietArchiveSync(step)) checkpoint.retryHistory = [...(checkpoint.retryHistory ?? []), record]
    const decision = planRetry(failure, attempt, Date.now(), next => backoff(next - 1))
    if ('plan' in decision) {
      checkpoint.syncRetries ??= {}
      checkpoint.syncRetries[step] = { attempt, at: decision.plan.at, record }
    }
    else checkpoint.syncFailure = { failure, pause: decision.pause, safe: true }
    persist()
    return { decision, record, attempt }
  }
  const sync: Sync = async (step, operation) => {
    const stream = watching()
    const archiveSync = quietArchiveSync(step)
    const reportsStop = step === 'finish' && (checkpoint.ending?.outcome === 'stopped' || checkpoint.ending?.report?.stopped)
    const stopped = () => stream.lost() || stream.asked() && !reportsStop
    let recovered: RetryRecord | undefined
    let showedRecovery = false
    while (!stopped()) {
      const pending = checkpoint.syncRetries?.[step]
      let renewalFailure: Extract<api.Call<unknown>, { ok: false }> | undefined
      if (pending) {
        const record = pending.record ?? checkpoint.retryHistory?.at(-1)
        if (record && !archiveSync) retryEvent(stream, record, 'waiting', budget.attempt(), pending.at)
        stream.event({ kind: 'status', data: { state: 'retrying', source: 'sync' } })
        await waitForRetry(pending.at, reportsStop ? undefined : stream.whenAsked)
        if (stopped()) return syncStopped
        const next = budget.take()
        if (next === undefined) {
          const failure = record ? makeFailure(record.source, record.summary, record) : makeFailure('sync', 'The automatic retry limit was reached.')
          delete checkpoint.syncRetries![step]
          checkpoint.syncFailure = { failure, pause: 'limit', safe: true }
          persist()
          return { ok: false, error: failure.summary, code: 'retry_exhausted' }
        }
        if (record && !archiveSync) retryEvent(stream, record, 'retrying', next - 1)
        recovered = record
        if (step !== 'finish' && step !== 'renew') {
          const requestedAt = leaseNow()
          const renewed = await deps.api.renewJob(deps.machineId, id)
          if (!renewed.ok) renewalFailure = renewed
          else {
            if (!renewed.value.renewed) { await stream.stop(); return syncStopped }
            Object.assign(lease, requestedAt)
            if (renewed.value.stop) stream.requestStop()
            if (flow && !stopped() && !verification && !writeBlock({ code: record?.code, error: record?.summary ?? '' })) {
              await recoveryState({ code: 'recovering', attempt: next - 1,
                ...(step === 'publish' || step === 'prepare' ? { step: 'sync' as const } : {}) })
              showedRecovery = true
            }
          }
          if (stopped()) return syncStopped
        }
      }
      const result = renewalFailure ?? await operation()
      if (pending && checkpoint.syncRetries?.[step] === pending) {
        delete checkpoint.syncRetries![step]
        persist()
      }
      if (stopped()) return syncStopped
      if (result.ok) {
        if (showedRecovery || checkpoint.taskRecovery?.code === 'storage' || checkpoint.taskRecovery?.code === 'allowance') {
          await recoveryState(null)
        }
        if (recovered) {
          if (!archiveSync) retryEvent(stream, recovered, 'recovered', budget.attempt() - 1)
          stream.event({ kind: 'status', data: { state: 'running', source: 'sync' } })
        }
        return result
      }
      const blocked = flow && !reportsStop ? writeBlock(result) : undefined
      if (archiveSync) logSync('land.archive', { step, job: id, task: job.task, code: result.code, status: result.status, error: result.error })
      const failure = archiveSync && !blocked ? makeFailure('sync', checkingArchive, { code: result.code })
        : result.failure ?? makeFailure('sync', result.error, { code: result.code })
      if (!retryableSync(result) && !blocked) {
        if (!archiveSync) {
          checkpoint.retryHistory = [...(checkpoint.retryHistory ?? []), retryRecord(failure, budget.attempt(), runtimeInfo())]
          persist()
        }
        return result
      }
      if (blocked) await recoveryState({ code: blocked })
      const { decision, record, attempt } = schedule(step, failure, blocked || step === 'finish' ? () => deps.retryMs : undefined)
      if ('pause' in decision) {
        if (!archiveSync) retryEvent(stream, record, 'paused', attempt - 1)
        return decision.pause === 'limit' ? { ...result, code: 'retry_exhausted' } : result
      }
    }
    return syncStopped
  }
  const recover = <T>(failure: ExecutionFailure, operation: () => Promise<api.Call<T>>) => {
    if (flow?.phase === 'land' && (failure.source === 'validation' || failure.source === 'sync')) {
      logSync('land.archive_repair', { job: id, task: job.task, failure })
      failure = makeFailure(failure.source, checkingArchive, { code: failure.code, retryAfterMs: failure.retryAfterMs })
    }
    if (!checkpoint.syncRetries?.repair && 'pause' in schedule('repair', failure).decision) {
      const error = quietArchiveSync('repair') ? resumeArchive(job) : failure.summary
      return Promise.resolve({ ok: false as const, error, code: 'retry_exhausted', failure })
    }
    return sync('repair', operation)
  }
  async function settle(outcome: Outcome, reason = '', report?: JobReport, onRefused?: (problem: Extract<api.Call<unknown>, { ok: false }>) => Promise<boolean>): Promise<boolean> {
    const prior = checkpoint.ending
    const archive = flow?.phase === 'land' && outcome === 'done' && report?.archive
    const ending = checkpoint.ending = { outcome, reason, report,
      unconfirmed: prior?.outcome === outcome && prior.unconfirmed,
      refreshArchive: !!archive && prior?.refreshArchive }
    persist()
    let refused = false
    const sent = await sync('finish', async () => {
      if (!held(deps, lease)) return syncStopped
      if (ending.unconfirmed) {
        const remote = await api.readJob(id)
        if (!remote.ok) return remote
        if (remote.value.job.state === 'finished') return { ok: true, value: remote.value.job.outcome === outcome }
        const requestedAt = leaseNow()
        const renewed = await deps.api.renewJob(deps.machineId, id)
        if (!renewed.ok) return renewed
        if (!renewed.value.renewed) return { ok: true, value: false }
        Object.assign(lease, requestedAt)
        if (renewed.value.stop && outcome !== 'stopped' && !report?.stopped) {
          watching().requestStop()
          return syncStopped
        }
      }
      if (ending.refreshArchive && ws) {
        const stream = watching()
        const stopped = () => stream.asked() || stream.lost()
        const pulled = await pull(ws, deps.machineId, stopped, 'land')
        if (!pulled.ok) return pulled
        const pushed = await push(ws, { id, machineId: deps.machineId }, stopped)
        if (!pushed.ok) return pushed.conflict ? { ...pushed, code: 'board_content_conflict' } : pushed
        const current = syncedArchive(ws)
        if (!current) return { ok: false, code: 'service_unavailable', error: 'The saved archive versions are not ready.' }
        report = ending.report = { ...report, archive: current }
        delete ending.refreshArchive
      }
      ending.unconfirmed = true
      persist()
      const result = await deps.api.finishJob(deps.machineId, id, outcome, reason, report)
      if (result.ok) return { ok: true, value: result.value.finished }
      if (archive && ws && staleArchiveReceipt(result)) {
        logSync('land.archive_receipt', { job: id, task: job.task, code: result.code, error: result.error })
        ending.refreshArchive = true
        persist()
        return { ...result, code: 'service_unavailable' }
      }
      refused = !retryableSync(result) && result.status !== undefined
      return result
    })
    if (sent.ok && sent.value) {
      if (archive && ws) await confirmLandArchive(ws, id)
      if (outcome !== 'failed' || !report?.recovery && (!job.task || !report?.failure?.safeToRetry)) clearCheckpoint(id)
      return true
    }
    if (watching().asked() && outcome !== 'stopped' && !report?.stopped) return settle('stopped', '', { ...report, stopped: true })
    if (refused && onRefused && !sent.ok && held(deps, lease)) return onRefused(sent)
    if (archive && !sent.ok && held(deps, lease) && !watching().asked() && sent.code !== 'stopped') {
      const stream = watching()
      if (landLeaseLost(sent)) { await stream.stop(); return false }
      const action = landArchiveRefusal(job, sent)
      stream.event({ kind: 'error', data: { text: action } })
      await stream.end()
      if (!stream.lost()) await settle('failed', action, { ...report, archive: undefined })
      return false
    }
    if (!sent.ok && sent.code === 'retry_exhausted' && checkpoint.syncFailure && outcome !== 'failed' && outcome !== 'stopped') {
      // The final failure report is separate from attempts to publish the saved result.
      const failure = checkpoint.syncFailure.failure
      if (report?.goals !== undefined) report = unsavedGoals(report)
      const failed: JobReport = { ...report, failure: buildFailureDetail(failure, 'limit', true),
        ...(reply ? { recovery: { safe: false, resumable: true, stopped: true } } : {}) }
      const remote = await api.readJob(id)
      if (remote.ok && remote.value.job.state === 'finished') {
        clearCheckpoint(id)
        return remote.value.job.outcome === outcome
      }
      checkpoint.ending = { outcome: 'failed', reason: failure.summary, report: failed, unconfirmed: true }
      persist()
      if (held(deps, lease) && remote.ok) {
        const result = await deps.api.finishJob(deps.machineId, id, 'failed', failure.summary, failed)
        if (result.ok && result.value.finished) return false
      }
    }
    return false
  }
  const replayingArchive = flow?.phase === 'land' && checkpoint.ending?.outcome === 'done' && !!checkpoint.ending.report?.archive
  if (checkpoint.ending && !replayingArchive) {
    const { outcome, reason, report } = checkpoint.ending
    await settle(outcome, reason, report)
    return
  }
  if (checkpoint.syncFailure && !replayingArchive) {
    return finishClaimed('failed', checkpoint.syncFailure.failure.summary, checkpoint.completed?.report)
  }
  if (!replyStream && previous && !usesBoardRun(job, checkpoint)
    && !await stopReply(local ? id : sourceId ?? id, deps.stopMs)) {
    return reply ? pauseRecovery('unsafe', false) : finishClaimed('failed', recoveryBlocked(job), {
      failure: buildFailureDetail(checkpoint.failure, 'unsafe', false, 'pause_unsafe', recoveryBlocked(job)),
    })
  }

  if (!usesBoardRun(job, checkpoint)) {
    const hadRetryCount = !!checkpoint.retry
    const retry = checkpoint.retry ??= { since: Date.now(), attempt: 1 }
    if (!checkpoint.completed) {
      if (!previous && recovering && !(manual && (job.retryReplay === true || !!checkpoint.session))) return pauseRecovery('unsafe', true)
      if (retry.at !== undefined || !Number.isSafeInteger(retry.attempt) || retry.attempt < 1) return pauseRecovery('unsafe', true)
      if (job.runtime === 'antigravity' && recovering && checkpoint.started && !checkpoint.session) {
        const msg = 'Antigravity did not record a conversation ID before interruption. The original session cannot be resumed.'
        return finishClaimed('failed', msg, {
          failure: buildFailureDetail(makeFailure('runtime', msg, { code: 'session_not_found' }), 'unsafe', false, 'pause_unsafe', msg),
        })
      }
      if (!replyStream && priorExecution && !(manual && !local) && !retry.pending && !checkpoint.boardContinuation) {
        if (!recovering || reply && !hadRetryCount) return pauseRecovery('unsafe', true)
        if (!updating || checkpoint.interrupted || checkpoint.failure) {
          const failure = checkpoint.failure ?? makeFailure('runner', 'The Runner was interrupted.', { code: 'runner_interrupted' })
          checkpoint.failure = failure
          const decision = planRetry(failure, budget.attempt(), Date.now(), deps.replyBackoff)
          checkpoint.retryHistory = [...(checkpoint.retryHistory ?? []), retryRecord(failure, budget.attempt(), runtimeInfo())]
          if ('pause' in decision) return pauseRecovery(decision.pause, true)
          retry.pending = decision.plan
        }
      }
      if (retry.pending) checkpoint.failure = retry.pending.failure
    }
  }
  const pendingRetry = checkpoint.retry?.pending
  const recoveryFailure = pendingRetry?.failure ?? checkpoint.failure
  const directRecovery = (recovering || priorExecution) && !usesBoardRun(job, checkpoint)
    ? checkpointRecovery(job, checkpoint, true, recoveryFailure) : undefined
  if (directRecovery === 'unsafe') return reply ? pauseRecovery('unsafe', true) : finishClaimed('failed', recoveryBlocked(job), {
    failure: buildFailureDetail(checkpoint.failure, 'unsafe', false, 'pause_unsafe', recoveryBlocked(job)),
  })
  const replay = directRecovery === 'replay'
  if (directRecovery === 'resume' && checkpoint.started !== false) job = { ...job, resume: checkpoint.session, fork: false }
  if (replay) {
    const source = replyInput && isSessionMissingFailure(recoveryFailure) ? null : forkSource
    if (!source) delete checkpoint.forkSource
    job = { ...job, resume: source ?? null, fork: !!source }
  }
  if (directRecovery === 'resume' && manual && !previous) job = { ...job, resume: checkpoint.session, fork: false }
  if (reply || !recovering || previous) persist()
  if (job.handoff?.kind === 'execution') {
    if (recovering) job = { ...job, handoff: { ...job.handoff, recovering: true } }
    const handoff = job.handoff!

    const runtime = (await deps.runtimes()).find((r) => r.name === job.runtime)
    if (!runtime?.installed || runtime.loggedIn === false) return finishClaimed('failed', '目标运行工具已不可用，请安装并登录后重试。')
    const folder = authorizedFolder(job.projectDir)
    if (!folder) return finishClaimed('failed', '目标目录授权已变化。')
    if (handoff.action === 'runtime') job = { ...job, projectDir: folder, resume: null, fork: false }
    if (handoff.action === 'continue') {
      const progress = progressFolder(job, folder)
      if (!progress || !handoff.recovering && (!handoff.evidence || progressEvidence({ ...job, flow: job.flow ? { ...job.flow, verb: handoff.verb ?? job.flow.verb } : job.flow }, progress) !== handoff.evidence)) {
        return finishClaimed('failed', '本地进度已变化，请重新检查。')
      }
      job = { ...job, projectDir: progress }
    }
    if (handoff.action === 'restart') {
      try { job = { ...job, projectDir: restartFolder(job, folder), resume: null, fork: false } }
      catch { return finishClaimed('failed', '无法准备新隔离目录，已有文件已保留。') }
    }
  }
  const authorize = async () => !deps.authorize ? { ok: true as const, value: true } : sync('authorize', async () => {
    const allowed = await deps.authorize!(flow ? { ...job, flow } : job)
    return typeof allowed === 'boolean' ? { ok: true, value: allowed } : allowed
  })
  const unauthorized = async (allowed: api.Call<boolean>, report?: JobReport) => {
    const stream = scope.waitingStream ?? replyStream
    await stream?.end()
    if (stream?.lost()) return
    if (stream?.asked()) return finishClaimed('stopped', '', report)
    return finishClaimed('failed', allowed.ok ? (cloudLanguage(job) === 'en' ? 'Project folder access changed. Confirm access and retry.' : '项目目录授权已变化，请重新确认后重试。') : syncRefusal(job, allowed), report)
  }
  const folderReady = () => !!job.projectDir && !('refused' in folderFor(job))
  if (flow?.review_revision !== undefined && flow.verb !== 'discard' && job.task && !await waitForAccess('folder', folderReady)) {
    if (watching().asked()) return finishClaimed('stopped')
    return unauthorized({ ok: true, value: false })
  }
  const allowed = await authorize()
  if (!allowed.ok || !allowed.value) return unauthorized(allowed)
  if (job.flow && job.flow.verb !== 'discard' && job.task && !folderReady()) {
    return unauthorized({ ok: true, value: false })
  }
  if (job.secret) return runSecret(job, deps)
  if (job.test) return runTest(job, deps, lease)

  const waitingStream = pendingRetry || job.task || reply ? watching() : replyStream
  if (verification && job.task) {
    const current = await sync('review', () => deps.api.readTask(job.task!))
    if (!current.ok) return unauthorized(current)
    const review = current.value.review
    if (!review || flow?.review_revision !== review.revision || !reviewAllows(reviewAuthorization(review), 'implement')) {
      return finishClaimed('failed', 'This execution no longer has review authorization.')
    }
  }
  if (verification && !checkpoint.verifyingDelivery && !manual) {
    await recoveryState({ code: 'recovering', attempt: Math.min(budget.attempt(), MAX_RETRY_ATTEMPTS) })
    const failure = makeFailure('sync', 'Checking the saved delivery and archive.', { code: 'task_delivery_unverified' })
    const ready = await recover(failure, async () => {
      checkpoint.verifyingDelivery = true
      persist()
      return { ok: true, value: undefined }
    })
    if (!ready.ok) return finishClaimed(watching().asked() ? 'stopped' : 'failed', ready.error)
  }
  if (pendingRetry && waitingStream) {
    const stream = waitingStream
    track(stream.stop)
    stream.event({ kind: 'log', data: { text: '[chat-recovery] waiting' } })
    stream.event({
      kind: 'retry',
      data: {
        state: 'waiting',
        source: pendingRetry.failure.source,
        runtime: runtimeInfo(),
        attempt: Math.min(MAX_RETRY_ATTEMPTS, budget.attempt()),
        maxAttempts: pendingRetry.of,
        summary: pendingRetry.failure.summary,
        ...(pendingRetry.failure.detail ? { detail: pendingRetry.failure.detail } : {}),
        ...(pendingRetry.failure.code ? { code: pendingRetry.failure.code } : {}),
        nextRetryAt: new Date(pendingRetry.at).toISOString(),
        ...(pendingRetry.sessionAction ? { sessionAction: pendingRetry.sessionAction } : {}),
        at: new Date().toISOString(),
      },
    })
    await waitForRetry(pendingRetry.at, stream.whenAsked)
    const finishWait = async (pause: RetryPause) => {
      await stream.end()
      if (stream.lost()) return
      if (stream.asked()) {
        if (checkpoint.retry) delete checkpoint.retry.pending
        persist()
        return finishClaimed(job.runtime === 'antigravity' ? 'stopped' : 'done', '', {
          session: checkpoint.session, ...(checkpoint.partialReply ? { reply: checkpoint.partialReply } : {}), stopped: true,
        })
      }
      return pauseRecovery(pause, true)
    }
    if (stream.asked() || stream.lost()) return finishWait('authorization')
    const allowed = await authorize()
    if (!allowed.ok || !allowed.value) return unauthorized(allowed)
    const requestedAt = leaseNow()
    const renewed = await sync('renew', () => deps.api.renewJob(deps.machineId, id))
    if (renewed.ok && renewed.value.stop) stream.requestStop()
    if (!renewed.ok) return unauthorized(renewed)
    if (!renewed.value.renewed || stream.asked() || stream.lost()) return finishWait('authorization')
    Object.assign(lease, requestedAt)
  }

  if (recovering && !pendingRetry) {
    if (job.flow && !verification && !Object.keys(checkpoint.syncRetries ?? {}).length) await recoveryState({ code: 'recovering', attempt: Math.min(MAX_RETRY_ATTEMPTS, Math.max(1, budget.attempt() - 1)) })
    let requestedAt = leaseNow()
    const renewed = await sync('renew', () => {
      requestedAt = leaseNow()
      return deps.api.renewJob(deps.machineId, id)
    })
    if (watching().asked() || renewed.ok && renewed.value.stop) return finishClaimed('stopped', '', { ...checkpoint.completed?.report, stopped: true })
    if (!renewed.ok) return unauthorized(renewed)
    if (!renewed.value.renewed || !held(deps, lease)) return
    Object.assign(lease, requestedAt)
  }

  // A task, and a review in its first task's, runs only in the project's folder here (#516).
  const task = job.task ?? job.review?.tasks[0] ?? null
  const folder = task && !job.projectDir ? { refused: NO_FOLDER }
    : job.agent && !job.projectDir ? { refused: 'This project has no folder on this computer.' } : folderFor(job)
  if (folder && 'refused' in folder) {
    return finishClaimed('failed', folder.refused)
  }

  let cwd = folder?.cwd ?? ''
  let run: Plan | null = null
  let goalFile: string | null = null
  let discussed: string | undefined
  let syncDiagnostic = ''
  function continuationResult(report: JobReport): JobReport {
    const prior = checkpoint.boardContinuation?.report
    if (!prior) return report
    const sum = (key: keyof NonNullable<JobReport['usage']>) => (prior.usage?.[key] ?? 0) + (report.usage?.[key] ?? 0)
    const usage = prior.usage && report.usage && !reply
      ? { input: sum('input'), cacheCreation: sum('cacheCreation'), cacheRead: sum('cacheRead'), output: sum('output') } : report.usage ?? prior.usage
    if (prior.deliveryCompleted) {
      const cost = ownCost(report.costUsd, job.runtime === 'claude-code' ? checkpoint.boardContinuation?.sessionTotal ?? null : undefined)
      const runtimeCosts = prior.runtimeCosts?.map(row => ({ ...row })) ?? []
      if (cost !== undefined) {
        const runtimeId = job.runtimeId ?? null
        const row = runtimeCosts.find(r => r.runtimeId === runtimeId && r.runtime === job.runtime)
        if (row) row.costUsd += cost
        else runtimeCosts.push({ runtimeId, runtime: job.runtime, costUsd: cost })
      }
      return {
        ...prior,
        ...(report.failure ? { failure: report.failure } : {}),
        ...(report.stopped ? { stopped: true } : {}),
        ...(usage ? { usage } : {}),
        ...(cost !== undefined ? { costUsd: (prior.costUsd ?? 0) + cost, runtimeCosts } : {}),
        ...(report.costIncomplete || cost === undefined && report.costUsd !== undefined ? { costIncomplete: true } : {}),
      }
    }
    const costUsd = prior.costUsd !== undefined && report.costUsd !== undefined && !reply && job.runtime !== 'claude-code'
      ? prior.costUsd + report.costUsd : report.costUsd ?? prior.costUsd
    return { ...prior, session: report.session ?? prior.session, ...(usage ? { usage } : {}), ...(costUsd !== undefined ? { costUsd } : {}) }
  }
  const sendResult = (report: JobReport, landed = () => {}) => {
    const completed = continuationResult(report)
    const publishingJob = flow ? { ...job, flow } : job
    const stream = watching()
    return sendBack(publishingJob, deps, ws!, completed, sync, stream, finishClaimed, landed, async pushed => {
      const records = pushed.conflict ? pendingConflicts(ws!.board) : []
      const facts = createHash('sha256').update(JSON.stringify(pushed.conflict
        ? records.map(r => ({ id: r.id, state: r.state, files: r.files })) : pushed.failure)).digest('hex')
      const failRepair = async (reason: string) => {
        if (flow?.phase === 'land') {
          logSync('land.archive_repair', { job: id, task: job.task, code: pushed.code, error: reason })
          reason = landArchiveRefusal(job, { ...pushed, code: pushed.conflict ? 'board_content_conflict' : pushed.code, error: reason })
        }
        if (!stream.asked()) stream.event({ kind: 'error', data: { text: reason } })
        await stream.end()
        if (stream.lost()) return
        if (stream.asked()) return finishClaimed('stopped', '', completed)
        return finishClaimed('failed', reason, writebackRecovery(job, completed))
      }
      if (pushed.conflict && !records.length) {
        console.error(JSON.stringify({ code: 'board_conflict_missing', phase: 'publish-result', job: id, task: job.task, project: job.project }))
        return failRepair('The result could not be saved safely. Saved work was preserved.')
      }
      const diagnostic = [pushed.error, ...records.flatMap(r => r.error ? [r.error] : [])].join('\n')
      if (checkpoint.boardContinuation?.facts === facts || !pushed.conflict && checkpoint.boardContinuation?.validation) {
        return failRepair(pushed.conflict ? `Board content conflicts remain unresolved: ${records.map(r => r.id).join(', ')}. Contents and resolution drafts are preserved.\n${diagnostic}` : pushed.error)
      }
      const delivery = completed.deliveryCompleted && (!completed.session || job.runtime === 'claude-code' && !checkpoint.boardContinuation)
        ? await deliverySession(ws!, job, deps, completed) : undefined
      const session = completed.deliveryCompleted ? completed.session ?? delivery?.session : report.session ?? checkpoint.session
      if ((flow?.phase === 'land' || completed.deliveryCompleted || job.review || checkpoint.completed && flow) && !session) {
        return failRepair(pushed.conflict
          ? `Board content conflicts could not be resolved because the original session is unavailable. Saved work was preserved.\n${diagnostic}`
          : `${diagnostic}\nThe original session is unavailable. Saved work was preserved.`)
      }
      const requestedAt = leaseNow()
      const renewed = await sync('renew', () => deps.api.renewJob(deps.machineId, id))
      if (!renewed.ok) return unauthorized(renewed, completed)
      if (!renewed.value.renewed || !held(deps, lease)) return
      if (renewed.value.stop) stream.requestStop()
      if (stream.asked()) {
        await stream.end()
        return finishClaimed('stopped', '', completed)
      }
      Object.assign(lease, requestedAt)
      const allowed = await authorize()
      if (!allowed.ok || !allowed.value) return unauthorized(allowed, completed)
      const prompt = pushed.conflict
        ? [diagnostic, conflictPrompt(ws!.board, 'Resolve and confirm synchronization, preserve completed work, then return the saved result.'),
            ...(completed.deliveryCompleted ? [`Resume only the board writeback for card #${completed.card ?? ws!.number}. The delivery is complete${completed.landing ? ` (${completed.landing.commit} on ${completed.landing.branch})` : ''}. If blocked, report the concrete reason and keep the saved versions and draft.`] : [])].join('\n\n')
        : syncRepairPrompt(pushed.failure!.summary)
      const repairPrompt = flow?.phase === 'land'
        ? `${prompt} Verify the saved archive and fix its synchronization. Resume from the existing delivery result.`
        : prompt
      const sessionTotal = job.runtime === 'claude-code'
        ? (checkpoint.boardContinuation && report.costUsd !== undefined ? report.costUsd : checkpoint.boardContinuation?.sessionTotal ?? delivery?.sessionCostUsd ?? null)
        : undefined
      const failure = pushed.failure ?? makeFailure('validation', diagnostic, { code: pushed.code })
      const prepared = await recover(failure, async () => {
        checkpoint.boardContinuation = { report: { ...completed, session }, facts, prompt: repairPrompt, validation: !pushed.conflict || checkpoint.boardContinuation?.validation, sessionTotal }
        checkpoint.session = session
        // The saved result is the input to this repair. Its launch evidence belongs to the prior phase.
        Object.assign(checkpoint, { started: false, submitted: false, effects: false, pending: [] })
        delete checkpoint.completed
        delete checkpoint.opaque
        delete checkpoint.cleanup
        persist()
        return { ok: true, value: undefined }
      })
      if (!prepared.ok) return failRepair(prepared.error)
      scope.progress?.cancel()
      scope.bridge?.close()
      scope.reviewSync?.close()
      await runClaimed({ ...publishingJob, prompt: repairPrompt, resume: session, fork: false }, deps, track, keep, lease, stream)
    }, async () => {
      const reviewed = checkpoint.reviewedRejections
      if (!reviewed) return { ok: true, value: undefined }
      const marked = await deps.api.markReviewed(reviewed.tasks, reviewed.triage)
      if (marked.ok) {
        delete checkpoint.reviewedRejections
        persist()
      }
      return marked
    })
  }
  const recoverBoard = async (folder: TaskFolder) => {
    if (!recovering && !priorExecution) return true
    if (checkpoint.completed) return true
    if (!verifiedFlow && !replyStream && (local || sourceId) && (!previous || checkpoint.started !== false)) {
      const evidence = await flowRunEvidence(folder, job, deps, local ? id : sourceId!, checkpoint.flowRun)
      if (!evidence.stopped) return false
      checkpoint.flowRun = evidence.run
    }
    if (!previous && !checkpoint.flowRun) return false
    const decision = checkpointRecovery(job, checkpoint, true)
    if (decision === 'unsafe') return false
    if (decision === 'resume' && !manual && !Object.keys(checkpoint.syncRetries ?? {}).length && (sourceId || checkpoint.interrupted)) {
      const failure = makeFailure('runner', 'The Runner was interrupted.', { code: 'runner_interrupted' })
      const ready = await recover(failure, async () => ({ ok: true, value: undefined }))
      if (!ready.ok) return false
    }
    persist()
    return true
  }
  try {
    if (job.agent) {
      ws = openAgentFolder(job, folder.cwd)
      cwd = ws.cwd
      keep(cwd)
      if (!checkpoint.boardContinuation) {
        if (!await recoverBoard(ws)) return finishClaimed('failed', recoveryBlocked(job))
        return runAgentJob(job as Job & { agent: AgentJob }, ws, deps, watching(), sync, retryFile, checkpoint, persist, starting, sendResult, finishClaimed)
      }
    } else if (task) {
      ws = openTaskFolder({ ...job, task }, folder?.cwd ?? null)
      if (job.task && job.resume && !await taskSessionMatches(ws, deps, job.resume)) {
        if (replyInput && !job.fork || checkpoint.boardContinuation) {
          return finishClaimed('failed', recoveryBlocked(job))
        }
        job = { ...job, resume: null, fork: false }
      }
      const sessionStudio = job.resume ? readStudioSession(task, job.resume) : null
      ws.studioSnapshot = checkpoint.studioSnapshot ?? sessionStudio
        ?? (priorExecution || job.flow?.resume || job.resume && !job.fork ? readPin(task) ?? undefined : undefined)
      ws.bindStudio = snapshot => {
        if (checkpoint.studioSnapshot?.studio === snapshot.studio && checkpoint.studioSnapshot.version === snapshot.version) return
        checkpoint.studioSnapshot = snapshot
        persist()
      }
      cwd = ws.cwd
      keep(cwd)
      if (flow?.phase === 'land') await protectLandArchive(ws, id, () => watching().asked() || watching().lost())
      if (replayingArchive && checkpoint.ending) {
        const { outcome, reason, report } = checkpoint.ending
        await settle(outcome, reason, report)
        return
      }
      if (usesBoardRun(job, checkpoint) && flow?.phase !== 'land' && !verification && !await recoverBoard(ws)) {
        return finishClaimed('failed', job.flow?.historical_conflict ? 'Board content conflicts could not be resolved. Saved work was preserved.' : recoveryBlocked(job))
      }
      // A flow job, and a review, pulls once its board is there.
      if (!job.flow && !job.review && !checkpoint.completed && !checkpoint.boardContinuation?.report.deliveryCompleted) {
        const pulled = await sync('prepare', () => pull(ws!, deps.machineId,
          () => !!waitingStream?.asked() || !!waitingStream?.lost(), job.chat ? 'chat' : undefined))
        if (!pulled.ok) {
          if (pulled.code === 'stopped') {
            await waitingStream?.end()
            return waitingStream?.asked() ? finishClaimed('stopped') : undefined
          }
          if (pulled.failure?.source === 'validation' || pulled.failure?.source === 'sync') syncDiagnostic = syncRepairPrompt(pulled.failure.summary)
          else if (pulled.code !== 'board_content_conflict') {
            console.error('runner: task sync refused', { job: id, code: pulled.code, error: pulled.error })
            throw new Error(syncRefusal(job, pulled))
          }
        }
      }
    }
    if (ws && job.chat && !job.flow && !checkpoint.completed) {
      const folder = ws
      if (job.number && isFlatReviewPlan(job.taskReview?.plan)) {
        scope.reviewSync = await previewSyncBridge(folder, { id, machineId: deps.machineId },
          () => !held(deps, lease) || !!waitingStream?.asked())
      }
      scope.bridge = await replyApprovalBridge(job.task!, job.number!, async (comment, asked, target) => await withBoard(folder, async (send) => {
        if (checkpoint.approvalCancelled) return { ok: false, error: 'This reply failed before. Ask again in a new reply.' }
        const pushed = await send({ id, machineId: deps.machineId })
        if (!pushed.ok) return { ok: false, error: pushed.error }
        if (!taskAssetsSynced(folder)) return { ok: false, error: 'Preview uploads are still pending. Try again after they finish.' }
        const version = syncedCardVersion(folder)
        const task = await deps.api.readTask(job.task!)
        if (!task.ok) return task
        if (asked !== job.task && asked !== String(job.number) && asked?.toUpperCase() !== task.value.key?.toUpperCase()) return { ok: false, error: 'Only the current task can be approved from this reply.' }
        if (!version || version !== task.value.card_version || !task.value.review) return { ok: false, error: 'The task changed or has no review. Review it again.' }
        checkpoint.approvalRequested = true
        persist()
        return api.approveReply(deps.machineId, id, { card_version: version, review_revision: target.review_revision, stage: target.stage, comment })
      }, () => !held(deps, lease) || !!waitingStream?.asked()) ?? { ok: false, error: 'Task preparation stopped.' })
    }
    if (checkpoint.completed) {
      const done = checkpoint.completed
      if (done.outcome === 'failed' || !ws) return finishClaimed(done.outcome, done.reason, done.report)
      return sendResult(done.report, () => keepChat(job, done.report.reply))
    }
    if (job.flow && !ws) throw new Error('This job names no task.')
    // Discussions bind the local board; background synchronization owns its freshness.
    if (job.discussion && job.projectDir && folder) {
      const board = openDiscussionFolder(job, folder.cwd)
      keep(board.cwd)
      discussed = board.board
    }
    if (job.discussion) {
      const wrote = await writeGoals({ ...job, discussion: job.discussion }, (...args) => sync('studios', () => deps.api.listStudios(...args)), recovering, source ? sourceId : undefined)
      if ('error' in wrote) throw new Error(wrote.error)
      goalFile = wrote.file
      if (!wrote.preserved || checkpoint.goalsVersion === undefined) {
        checkpoint.goalsVersion = job.discussion.version
        persist()
      }
    }
    if (!job.flow && !job.review) {
      // Behind the reply: until it lands, the catalogue on disk names the window.
      void refreshCatalog()
      const nativeImages = !!replyInput && takesImageArgs(job.runtime)
      const attachments = writeAttachments(job, nativeImages)
      const conflicts = ws && (!checkpoint.boardContinuation || checkpoint.boardContinuation.validation)
        ? conflictPrompt(ws.board) : ''
      const recoveringTurn = recovering && !checkpoint.boardContinuation && !replay
        && (!forkSource || checkpoint.submitted === true) && (checkpoint.started || job.recoveryOf)
      const recovery = pendingRetry ? retryContinuePrompt(pendingRetry.failure, checkpoint.retry?.attempt, pendingRetry.of) : recoveryPrompt
      const planned = async (resume: string | null | undefined, fork: boolean) => {
        let prompt: string
        let images: string[] | undefined
        let discussionImages: DiscussionImages | undefined
        let requiredImages = attachments.files
        const canonical = deps.akb.canonicalCommands === true
        const previous = ws?.cloudTask && resume ? readRuntimeContext(ws.cloudTask, job.runtime, resume) : undefined
        const action = job.chat ? 'chat' : job.stage === 'plan' ? 'refine' : 'implement'
        const blocks = ws && !job.agent ? taskContextBlocks(ws, action, canonical) : []
        sessionContext = undefined
        if (replyInput) {
          const continuing = directRecovery === 'resume' && !replayable(checkpoint)
          const fresh = !resume || fork && !previous
          const retryingFirstTurn = checkpoint.replyInitializing === true && !previous?.['card-chat']
          const initialize = !continuing && (fresh || retryingFirstTurn || !previous?.['card-chat'] && replyInput.firstCardChat === true)
          checkpoint.replyInitializing = initialize
          if (fresh) {
            delete checkpoint.replyReviewRevision
            delete checkpoint.replyContext
          }
          let historyFile: string | undefined
          if (initialize && (fresh || retryingFirstTurn)) {
            let history: api.ReplyHistoryMessage[] | string = replyInput.history ?? ''
            if (replyInput.historyOnDemand) {
              const read = await sync('reply-history', () => deps.api.readReplyHistory(deps.machineId, id))
              if (!read.ok) throw new Error(syncRefusal(job, read))
              history = read.value.messages
            }
            historyFile = writeReplyHistory(attachmentsOf(job), history)
          }
          const discussion = job.discussion
          const assembled = replyPrompt(replyInput, {
            initialize, historyFile,
            ...(ws && job.chat ? { task: { card: cardFile(ws), review: job.taskReview, blocks, previous } } : {}),
            goals: discussion && (discussion.goals.length || historyFile || replay || job.sessionFallback || job.resume) ? discussion.goals : undefined,
            diagnostics: [syncDiagnostic, conflicts],
            attachments: attachments.text.trimStart(),
            continuation: continuing ? recovery : undefined,
          })
          prompt = assembled.withAttachments
          sessionContext = assembled.sent
          replyContext = assembled.context
          replyReviewRevision = assembled.reviewRevision
          if (continuing) requiredImages = []
          if (nativeImages) images = requiredImages
          else if (discussion && attachments.files.length) discussionImages = { files: requiredImages, prompt: assembled.prompt }
        } else {
          const file = writeTranscript(job, attachmentsOf(job))
          const needsTranscript = !resume || recoveringTurn && replayable(checkpoint) && !previous?.transcript
          const transcript = file && needsTranscript ? `This task came out of a discussion. Read it for what the card leaves out: ${file}` : ''
          const review = job.taskReview
          const previews = !canonical && ws && !job.agent && review?.preview_definitions?.length ? taskStudio(ws)?.def.previews : undefined
          const boundary = review ? (canonical ? taskReviewBoundary(review) : reviewBoundary(review, undefined, previews)) : ''
          const direct: ContextBlock[] = [
            ...(ws && !job.agent ? [taskCardBlock(cardFile(ws)), ...blocks] : []),
            reviewBlock(boundary, review, previous),
            ['inline-studio', ws && !job.agent && !canonical ? taskStudioContext(ws, { docs: false, canonicalCommands: false, config: false }) : ''],
            ['transcript', transcript],
          ]
          if (ws && !job.agent && !canonical && !job.resume) direct.push(['components', taskStudioComponents(false)])
          const update = contextUpdate(previous, direct)
          sessionContext = ws && !job.agent ? update.sent : undefined
          const previewIssues = ws && !job.agent ? undrawnPreviews(ws) : []
          const head = [syncDiagnostic, conflicts, ...update.parts,
            previewIssues.length ? 'Previews that cannot be drawn:\n' + previewIssues.map(l => '- ' + l).join('\n') : '']
            .filter(Boolean).join('\n\n')
          const submitted = recoveringTurn && (checkpoint.submitted === true || checkpoint.submissionUnknown === true)
          const body = recoveringTurn ? [submitted ? '' : job.prompt, recovery].filter(Boolean).join('\n\n') : job.prompt
          const withHead = (text: string) => text.trim() ? `${text.trim()}\n\n---\n\n${body}` : body
          if (submitted) requiredImages = []
          prompt = withHead(head + (submitted ? '' : attachments.text))
          if (job.discussion && attachments.files.length) {
            discussionImages = { files: requiredImages, prompt: withHead(head) }
          }
        }
        const configure = (p: Plan): Plan => {
          p.renderer?.setRequiredImages?.(requiredImages)
          if (ws) p = { ...p, env: akbEnv(deps.akb, ws.board, ws.cloudTask ?? undefined, cloudLanguage(job), p.env) }
          if (scope.reviewSync) p = { ...p, env: { ...p.env, [REVIEW_SYNC_ENV]: scope.reviewSync.env } }
          if (scope.bridge) p = { ...p, env: { ...p.env, AI4KANBAN_REPLY_APPROVAL: scope.bridge.env } }
          if (goalFile) p = { ...p, env: { ...akbEnv(deps.akb, discussed, undefined, cloudLanguage(job), p.env), KANBAN_GOALS: goalFile } }
          const env = { ...p.env, AI4KANBAN_EXECUTION: JSON.stringify({ job: job.id, machine: deps.machineId,
            ...(job.task && ws?.number ? { card: ws.number } : {}) }), AI4KANBAN_TASK: job.task ?? '', [STUDIO_SNAPSHOT_ENV]: ws?.studioSnapshot && JSON.stringify(ws.studioSnapshot) }
          const fallback = p.fallback
          return { ...p, env, fallback: fallback && (() => configure(fallback())) }
        }
        return configure(deps.plan(job.runtime, prompt, cwd, resume, job.model, settingsOf(job), fork, cloudLanguage(job), images, discussionImages))
      }
      // A discussion task's session (#2146), else a new one reading the discussion.
      let carried = !!job.resume && (!job.fork || forks(job.runtime))
      if (!carried && checkpoint.boardContinuation?.report.deliveryCompleted) throw Error('The original delivery session is unavailable. Saved work was preserved.')
      try {
        run = carried ? await planned(job.resume, !!job.fork) : await planned(null, false)
      } catch (error) {
        // Antigravity can establish that the requested session is missing before anything launches.
        if (!replyInput || !carried || !replayable(checkpoint) || !(error instanceof ExecutionError) || !isSessionMissingFailure(error.failure)) throw error
        carried = false
        delete checkpoint.session
        delete checkpoint.forkSource
        const replayed = await recover(error.failure, async () => ({ ok: true, value: await planned(null, false) }))
        if (!replayed.ok) throw new Error(replayed.error)
        run = replayed.value
      }
      if (!carried) job = { ...job, resume: null, fork: false }
    }
  } catch (e) {
    await waitingStream?.end()
    if (waitingStream?.lost()) return
    if (waitingStream?.asked()) return finishClaimed('stopped', '', { stopped: true })
    return finishClaimed('failed', e instanceof Error ? e.message : String(e))
  }

  const authorized = await authorize()
  if (!authorized.ok || !authorized.value) return unauthorized(authorized)
  if (!held(deps, lease)) return
  if (reply) {
    for (let check = 0; ; check++) {
      let requestedAt = leaseNow()
      const renewed = await sync('renew', () => {
        requestedAt = leaseNow()
        return deps.api.renewJob(deps.machineId, id)
      })
      if (waitingStream?.asked() || renewed.ok && renewed.value.stop) {
        await waitingStream?.end()
        return finishClaimed('stopped', '', { stopped: true })
      }
      if (!renewed.ok) return unauthorized(renewed)
      if (!renewed.value.renewed || !held(deps, lease)) return
      Object.assign(lease, requestedAt)
      if (!job.discussion || !renewed.value.catalog || renewed.value.catalog.version === job.discussion.catalog?.version && renewed.value.catalog.account === job.discussion.catalog.account) break
      if (check >= 2) return finishClaimed('failed', 'The studio catalog keeps changing. Try again.')
      job.discussion.catalog = renewed.value.catalog
      const wrote = await writeGoals({ ...job, discussion: job.discussion }, (...args) => sync('studios', () => deps.api.listStudios(...args)), true)
      if ('error' in wrote) return finishClaimed('failed', wrote.error)
      goalFile = wrote.file
      const authorized = await authorize()
      if (!authorized.ok || !authorized.value) return unauthorized(authorized)
    }
  }
  if (waitingStream?.lost()) return
  if (waitingStream?.asked()) return finishClaimed('stopped', '', { stopped: true })
  const stream = watching()
  if (pendingRetry) {
    if (budget.take() === undefined) return pauseRecovery('limit', true)
    stream.event({ kind: 'log', data: { text: '[chat-recovery] running' } })
    stream.event({
      kind: 'retry',
      data: {
        state: 'retrying',
        source: pendingRetry.failure.source,
        runtime: runtimeInfo(),
        attempt: budget.attempt() - 1,
        maxAttempts: pendingRetry.of,
        summary: pendingRetry.failure.summary,
        ...(pendingRetry.failure.detail ? { detail: pendingRetry.failure.detail } : {}),
        ...(pendingRetry.failure.code ? { code: pendingRetry.failure.code } : {}),
        ...(pendingRetry.sessionAction ? { sessionAction: pendingRetry.sessionAction } : {}),
        at: new Date().toISOString(),
      },
    })
  }
  if (run?.startNote) stream.out(`${run.startNote}\n`)
  let attempt: NonNullable<Checkpoint['attempts']>[number] | undefined
  const beginAttempt = () => {
    if (!reply || attempt) return
    attempt = { resume: job.resume }
    checkpoint.attempts ??= []
    checkpoint.attempts.push(attempt)
    persist()
  }
  const measure = (said: JobReport): JobReport => {
    if (!attempt) return said
    Object.assign(attempt, { session: said.session, usage: said.usage, costUsd: said.costUsd, costIncomplete: said.costIncomplete })
    persist()
    const { usage: _usage, costUsd: _cost, ...rest } = said
    return { ...rest, ...replySpent(checkpoint, job.runtime) }
  }
  const messages: string[] = []
  const retainReply = (report: JobReport, failed: boolean): JobReport => {
    if (!reply) return report
    const text = report.reply?.trim() ? report.reply : messages.join('\n\n') || (failed ? checkpoint.partialReply : undefined)
    if (text) { checkpoint.partialReply = text; persist() }
    return text ? { ...report, reply: text } : report
  }
  const account = readSession()?.subject
  const generation = accountGeneration()
  const replyAttempt = (checkpoint.retry?.attempt ?? 1) + Number(!!pendingRetry)
  const evidence = scope.progress = conversationProgress(replyAttempt, async progress => {
    const result = await deps.api.renewJob(deps.machineId, id, { ...progress, ...(job.claim ? { claim: job.claim } : {}) })
    if (!evidence.active()) return
    if (!result.ok) throw new Error(result.error)
    if (!result.value.renewed) await stream.stop()
    else if (result.value.stop) stream.requestStop()
  }, () => reply && progressValid(), () => stream.out('[chat-progress] Evidence was not confirmed.\n'))
  const progressValid = () => !stream.asked() && !stream.lost() && readSession()?.subject === account && accountGeneration() === generation
  const subagents = trackSubagents()
  let idleWatch: ReturnType<typeof createIdleWatchdog> | undefined
  let boundSession: string | undefined
  const bindStudioSession = (session: string | undefined) => {
    if (!session || session === boundSession || !ws?.cloudTask || !ws.studioSnapshot) return
    saveStudioSession(ws.cloudTask, session, ws.studioSnapshot)
    boundSession = session
  }
  let contextSession: string | undefined
  const recordContext = (session: string | undefined) => {
    if (!session || session === contextSession || !ws?.cloudTask || !sessionContext) return
    saveRuntimeContext(ws.cloudTask, job.runtime, session, sessionContext)
    contextSession = session
    if (replyReviewRevision !== undefined) checkpoint.replyReviewRevision = replyReviewRevision
    if (replyContext) checkpoint.replyContext = replyContext
  }
  const remember = (event: RunEvent) => {
    idleWatch?.event(event)
    if (stream.lost()) return
    const at = new Date().toISOString()
    event = Object.assign({}, event, { data: { ...event.data, eventAt: at, ...(reply ? { attempt: replyAttempt } : {}) } })
    evidence.observe(event, at)
    subagents.event(event)
    checkpointEvent(checkpoint, event)
    if (replyInput && checkpoint.submitted) checkpoint.replyInitializing = false
    if (reply && event.kind === 'message' && event.data.text.trim()) {
      messages.push(event.data.text)
      checkpoint.partialReply = messages.join('\n\n')
    }
    const session = run?.session()
    if (session && (!job.fork || session !== forkSource)) {
      checkpoint.session = session
      bindStudioSession(session)
      if (turnSubmitted(event)) recordContext(session)
    }
    if (attempt && !run?.converse) measure(report(job, run!))
    persist()
    stream.event(event)
  }
  const retry = async (failure: ExecutionFailure | undefined): Promise<boolean> => {
    if (!failure || stream.asked() || stream.lost()) return false
    checkpoint.failure = failure
    const currentAttempt = budget.attempt()
    checkpoint.approvalCancelled = true
    persist()
    if (job.chat && checkpoint.approvalRequested) await api.cancelReplyApproval(deps.machineId, id)
    const stopped = await stopReply(id, deps.stopMs) && await stream.confirmed()
    const recovery = checkpointRecovery(job, checkpoint, stopped, failure)
    const sessionAction: SessionAction = recovery === 'unsafe' ? 'pause_unsafe' : recovery === 'replay' ? 'reset_replay' : 'resume'
    const record = retryRecord(failure, currentAttempt, runtimeInfo(), sessionAction)
    checkpoint.retryHistory = [...(checkpoint.retryHistory ?? []), record]
    const decision = recovery === 'unsafe' ? { pause: 'unsafe' as const } : planRetry(failure, currentAttempt, Date.now(), deps.replyBackoff)
    if ('pause' in decision) {
      checkpoint.retryPause = decision.pause
      persist()
      retryEvent(stream, record, 'paused', currentAttempt - 1)
      return false
    }
    if (stream.asked() || stream.lost()) return false
    if (sessionAction === 'reset_replay') checkpoint.session = undefined
    checkpoint.retry ??= { since: Date.now(), attempt: 1 }
    checkpoint.retry.pending = { ...decision.plan, sessionAction }
    persist()
    evidence.cancel()
    scope.bridge?.close()
    scope.reviewSync?.close()
    await runClaimed({ ...job, manualRecovery: false }, deps, track, keep, lease, stream)
    await stream.end()
    return true
  }
  const complete = (outcome: 'done' | 'failed', report: JobReport, reason?: string) => {
    if (outcome === 'failed' && stream.lost()) return
    checkpoint.completed = { outcome, report, reason }
    checkpoint.session = report.session ?? checkpoint.session
    bindStudioSession(report.session)
    persist()
  }
  const told = (report: JobReport): JobReport => {
    const goals = goalFile ? readGoals(goalFile) : undefined
    const ran = subagents.summary()
    const revision = checkpoint.replyReviewRevision
    const context = checkpoint.replyContext
    const said = { ...report, ...(replyInput && revision !== undefined ? { replyReviewRevision: revision } : {}),
      ...(replyInput && context ? { replyContext: context } : {}), ...(ran ? { subagents: ran } : {}), ...(checkpoint.approvalRequested && checkpoint.approvalCancelled ? { replyApprovalSynced: false } : {}) }
    return goals && !isDeepStrictEqual(goals, job.discussion?.goals)
      ? { ...said, goals, goalsVersion: checkpoint.goalsVersion } : said
  }
  track(stream.stop)

  const io = {
    repairDelivery: !!checkpoint.boardRepair && checkpoint.boardRepair.run === checkpoint.flowRun?.id,
    diagnostic: checkpoint.boardRepair?.reason,
    show: stream.out,
    event: remember,
    track: stream.adopt,
    onStop: stream.onStop,
    lost: stream.lost,
    asked: stream.asked,
    sync,
    retryFile,
    recover,
    waitForLogin: flow?.review_revision === undefined ? undefined : async () => {
      const ready = await waitForAccess('login', async () => {
        const runtime = (await deps.runtimes()).find(r => r.name === job.runtime)
        return runtime?.loggedIn !== false || !runtime.installed
      })
      if (!ready) return false
      const allowed = await authorize()
      return allowed.ok && allowed.value
    },
    starting: async () => {
      if (checkpoint.taskRecovery?.code === 'recovering') await recoveryState(null)
      if (!stream.lost() && !stream.asked()) starting()
    },
    flowRun: checkpoint.flowRun,
  }
  if (job.review) {
    // What is reviewed is what was said by now; a later message waits for the next review.
    for (const task of job.review.tasks) {
      const chat = await sync(`chat:${task}`, () => deps.api.readChat(task))
      if (!chat.ok && chat.code !== 'not_found') {
        await stream.end()
        return finishClaimed('failed', 'The complete conversation could not be read; memory review will retry.')
      }
      if (chat.ok) keepCloudChat(task, chat.value.messages)
      if (!await keepDecisions(task, (...args) => sync(`decisions:${task}`, () => deps.api.readDecisions(...args)))) {
        await stream.end()
        return finishClaimed('failed', 'Review decisions could not be read; memory review will retry.')
      }
    }
    const listed = await sync('chats', () => deps.api.listChats(deps.machineId))
    if (!listed.ok) {
      await stream.end()
      return finishClaimed('failed', listed.error)
    }
    // A task Cloud no longer lists has moved on since the review was asked for.
    const tasks = listed.value.chats.filter((c) => job.review!.tasks.includes(c.task))
    const marks = checkpoint.reviewMarks ?? (io.flowRun ? {} : reviewMarks(tasks))
    checkpoint.reviewMarks = marks
    persist()
    const refs = tasks.map((c) => `${c.task}:${c.number}`)
    const ended = refs.length || io.flowRun ? await runReview(job, ws!, refs, deps, io) : { ok: true as const, report: {} }
    if (ended.ok) complete('done', ended.report)
    if (!ended.ok) {
      await stream.end()
      if (!stream.lost()) return finishClaimed(stream.asked() ? 'stopped' : 'failed', ended.reason)
      return
    }
    return !stream.lost() ? sendResult(ended.report, () => markReviewed(marks)) : undefined
  }
  if (!run) {
    if (checkpoint.syncRetries?.repair &&
        (io.repairDelivery || checkpoint.syncRetries.repair.record?.code === 'board_command_interrupted')) {
      const ready = await sync('repair', async () => ({ ok: true, value: undefined }))
      if (!ready.ok) {
        await stream.end()
        if (!stream.lost()) return finishClaimed(stream.asked() ? 'stopped' : 'failed', ready.error)
        return
      }
    }
    const flowJob = job as Job & { flow: Flow }
    if (flow?.phase === 'land' && checkpoint.started && !io.flowRun) {
      const saved = await flowRunEvidence(ws!, job, deps, id)
      if (!saved.stopped) return finishClaimed('failed', 'The previous Land session has not stopped.')
      io.flowRun = saved.run
    }
    let result = await runFlow(flowJob, ws!, deps, io)
    while (!result.ok && result.failure?.code === 'board_command_interrupted' && !stream.asked() && !stream.lost()) {
      const failure = result.failure
      const saved = await flowRunEvidence(ws!, job, deps, id, checkpoint.flowRun)
      if (!saved.stopped || !saved.run || !await stream.confirmed()) {
        result = { ...result, reason: recoveryBlocked(job),
          failure: makeFailure(failure.source, recoveryBlocked(job), { code: failure.code, detail: failure.detail }) }
        break
      }
      checkpoint.flowRun = saved.run
      persist()
      if (!saved.run.finished) {
        const ready = await recover(failure, authorize)
        if (!ready.ok || !ready.value) {
          result = { ok: false, reason: ready.ok ? 'Project folder access changed. Confirm access and retry.' : syncRefusal(job, ready), failure }
          break
        }
        io.diagnostic = failure.summary
      }
      io.flowRun = saved.run
      result = await runFlow(flowJob, ws!, deps, io)
      if (saved.run.finished && !result.ok && result.failure?.code === failure.code) break
    }
    if (!result.ok && !verification && result.failure?.code === 'delivery_incomplete' && !stream.asked() && !stream.lost()) {
      const saved = await flowRunEvidence(ws!, job, deps, id, checkpoint.flowRun)
      if (saved.stopped && saved.run?.finished && await stream.confirmed()) {
        const failure = result.failure
        checkpoint.flowRun = saved.run
        checkpoint.boardRepair = { reason: failure.summary, run: saved.run.id }
        const ready = await recover(failure, async () => ({ ok: true, value: undefined }))
        if (ready.ok) {
          io.flowRun = saved.run
          io.repairDelivery = true
          io.diagnostic = failure.summary
          result = await runFlow(flowJob, ws!, deps, io)
        }
      }
    }
    if (result.ok) complete('done', result.report)
    const stopped = !result.ok && (stream.asked() || result.stopped === true)
    if (stopped && stream.asked()) await stream.halted()
    if (!result.ok) {
      if (result.exhausted || result.failure?.code === 'retry_exhausted') stream.event({ kind: 'error', data: { text: result.reason } })
      await stream.end()
    }
    if (stream.lost()) return
    const boardStopped = await confirmFlowStopped(ws!, job, deps)
    const evidence = job.handoff?.action === 'continue' || job.handoff?.action === 'restart' ? progressEvidence(job, ws!.cwd) : null
    if (!boardStopped || !await stream.confirmed()) return
    const proof = { processesStopped: true, ...(evidence ? { evidence } : {}) }
    if (result.ok) complete('done', { ...result.report, ...proof })
    if (stopped) return finishClaimed('stopped', '', { ...result.report, ...proof })
    if (!result.ok) {
      const reason = result.exhausted || result.failure?.code === 'retry_exhausted' ? 'task_retry_exhausted: ' + result.reason : result.reason
      const safeToRetry = result.exhausted === true || result.safeToRetry === true
      const failureDetail = result.report?.failure ?? buildFailureDetail(
        result.failure ?? makeFailure('runtime', result.reason || 'The run failed.'),
        result.exhausted ? 'limit' : safeToRetry ? 'manual' : 'unsafe',
        safeToRetry,
        undefined,
        result.reason,
      )
      const report = { ...result.report, ...proof, failure: failureDetail }
      complete('failed', report, reason)
      return finishClaimed('failed', reason, report)
    }
    const mergedRetries = retryHistory(result.report)
    const report = { ...result.report, ...(mergedRetries.length ? { retries: mergedRetries } : {}) }
    return sendResult({ ...report, ...proof }, () => keepChat(job, report.reply))
  }

  const launchAttempt = (plan: Plan) => {
    checkpoint.managedProcess = plan.managedProcess
    checkpoint.mark = stopMark()
    checkpoint.started = true
    checkpoint.opaque = !plan.converse && !plan.renderer?.events
    const session = plan.session()
    checkpoint.session = job.fork && session === forkSource ? undefined : session ?? (replay && !forkSource ? undefined : checkpoint.session)
    checkpoint.launching = true
    if (pendingRetry && checkpoint.retry?.pending) {
      checkpoint.retry.attempt++
      delete checkpoint.retry.pending
    }
    delete checkpoint.process
    delete checkpoint.cleanup
    starting()
    const child = launch(plan.command, plan.args, { cwd, env: markEnv(plan.env, checkpoint.mark), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    if (child.pid) {
      checkpoint.process = { pid: child.pid, since: Date.now(), ...(plan.managedProcess ? { identity: connectionIdentity(child.pid) } : {}) }
    }
    delete checkpoint.launching
    delete checkpoint.failure
    delete checkpoint.retryPause
    delete checkpoint.replyParts
    delete checkpoint.replyImages
    beginAttempt()
    persist()
    return child
  }
  const converse = async (plan: Plan) => {
    const child = launchAttempt(plan)
    stream.adopt(child, plan.managedProcess)
    child.stdin.on('error', () => {})
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => stream.out(quietLines(plan, chunk)))
    const spawned = new Promise<ExecutionFailure>((resolve) => child.on('error', (e) => resolve(executionFailure(e))))
    const cancellation = new AbortController()
    const idle = new AbortController()
    let uncertainAtIdle = false
    void stream.whenAsked.then(() => cancellation.abort())
    let timedOut!: (end: TurnEnd) => void
    const timeout = new Promise<TurnEnd>(resolve => { timedOut = resolve })
    idleWatch = createIdleWatchdog(() => {
      uncertainAtIdle = checkpoint.pending.length > 0
      checkpoint.failure = IDLE_FAILURE
      if (plan.managedProcess || uncertainAtIdle) checkpoint.cleanup = { status: 'unconfirmed', execution: id, kept: [] }
      persist()
      idle.abort()
      if (!plan.idleRecovery) {
        timedOut({ ok: false, error: IDLE_FAILURE.summary, failure: IDLE_FAILURE, cleanup: checkpoint.cleanup })
        cancellation.abort()
        stop(child, plan.managedProcess)
      }
    })
    const end = await Promise.race([
      timeout,
      plan.converse!(child, remember, false, Date.now() + CONVERSATION_MS.prepare, cancellation.signal, () => idleWatch?.touch(), idle.signal),
      spawned.then((failure): TurnEnd => ({ ok: false, error: failure.summary, failure })),
      // Killed, the turn ends with what it said so far; one that never does is not waited on.
      stream.whenAsked.then(() => wait(KILL_GRACE_MS * 2)).then((): TurnEnd => ({ ok: false })),
    ])
    idleWatch.close()
    if (idle.signal.aborted) {
      const unconfirmed = uncertainAtIdle || checkpoint.pending.length
        || plan.managedProcess && !idleStopConfirmed(end.cleanup, checkpoint.session)
      checkpoint.cleanup = unconfirmed
        ? { ...end.cleanup, status: 'unconfirmed', execution: end.cleanup?.execution ?? id, kept: end.cleanup?.kept ?? [] }
        : end.cleanup
      persist()
      return { child, end: { ...end, ok: false, canFallback: false }, failure: IDLE_FAILURE }
    }
    checkpoint.cleanup = end.cleanup
    persist()
    return { child, end, failure: end.failure }
  }
  const conversation = run.converse ? await converse(run) : undefined
  let fallbackFailure: ExecutionFailure | undefined
  if (conversation?.end.canFallback && run.fallback && !checkpoint.submitted && !checkpoint.submissionUnknown && !stream.asked() && !stream.lost()
      && await stopReply(id, deps.stopMs) && !stream.asked() && !stream.lost()) {
    try {
      run = run.fallback()
      checkpoint.session = job.resume ?? undefined
      persist()
    } catch (error) {
      if (replyInput && replayable(checkpoint) && error instanceof ExecutionError && isSessionMissingFailure(error.failure)) {
        // Both transports failed before the turn could be submitted.
        checkpoint.started = false
        fallbackFailure = error.failure
      }
    }
  }
  if (run.converse && conversation) {
    const plan = run
    const { child, end, failure: turnFailure } = conversation
    let measured = measure(report(job, plan, end))
    if (end.ok && !stream.lost()) recordContext(measured.session)
    if (reply && end.replyParts) checkpoint.replyParts = { cwd, parts: end.replyParts }
    const rawFailure = end.ok ? undefined : fallbackFailure ?? turnFailure ?? makeFailure('runtime', end.error ?? 'The agent did not complete the reply.', { code: 'execution_failed', detail: end.error })
    if (isSessionMissingFailure(rawFailure)) checkpoint.session = undefined
    measured = retainReply(measured, !end.ok)
    if (await retry(rawFailure)) return
    await evidence.drain(deps.endMs)
    const stopped = await stopReply(id, deps.stopMs)

    stop(child, plan.managedProcess)
    if (stream.asked() && (!stopped || !await stream.confirmed())) { await stream.end(); return }
    const ok = end.ok || stream.asked()
    const recovery = replyRecovery(job, checkpoint, stopped)
    const unsafe = reply && !ok && !recovery.safe && !recovery.resumable
    const retries = ok && !stream.asked() && checkpoint.retryHistory?.length ? checkpoint.retryHistory : undefined
    if (retries) {
      const last = retries[retries.length - 1]!
      stream.event({
        kind: 'retry',
        data: {
          state: 'recovered',
          source: last.source,
          runtime: runtimeInfo(),
          attempt: Math.max(1, budget.attempt() - 1),
          maxAttempts: MAX_RETRY_ATTEMPTS,
          summary: last.summary,
          ...(last.code ? { code: last.code } : {}),
          at: new Date().toISOString(),
        },
      })
    }
    const failureDetail = !ok && !stream.asked()
      ? buildFailureDetail(
          rawFailure,
          unsafe ? 'unsafe' : (checkpoint.retryPause ?? 'limit'),
          !unsafe && (recovery.safe || recovery.resumable),
          unsafe ? 'pause_unsafe' : recovery.safe ? 'reset_replay' : recovery.resumable ? 'resume' : undefined,
        )
      : undefined
    const said: JobReport = {
      ...told(stream.asked() ? cutShort(measured, stream.said()) : measured),
      ...(reply ? { recovery } : {}),
      ...(retries ? { retries } : {}),
      ...(failureDetail ? { failure: failureDetail } : {}),
    }
    const failure = replyReason(rawFailure, checkpoint.retryPause, job, unsafe)
    if (!stream.asked()) complete(ok ? 'done' : 'failed', said, failure)
    if (!ok && rawFailure && unsafe) stream.event({ kind: 'error', data: { text: rawFailure.summary } })
    if (!ok || !ws || stream.asked()) {
      await stream.end()
      if (stream.lost()) return
      if (stream.asked() && (ws && !reply || job.runtime === 'antigravity')) return finishClaimed('stopped', '', said)
      return finishClaimed(ok ? 'done' : 'failed', ok ? '' : failure, said)
    }
    if (!stream.lost()) return sendResult(said, () => keepChat(job, said.reply))
    return
  }
  const printed = async (plan: Plan) => {
    const child = launchAttempt(plan)
    stream.adopt(child, plan.managedProcess)
    child.stdin.on('error', () => {})
    const renderer = plan.renderer!
    if (plan.stdin) child.stdin.write(plan.stdin)
    else child.stdin.end()
    child.stdout.setEncoding('utf8')
    const structured = !!renderer.events
    let backgroundFailure: ExecutionFailure | undefined
    let finishIdle!: () => void
    const idleEnded = new Promise<{ code: null }>(resolve => { finishIdle = () => resolve({ code: null }) })
    let idleExit: ReturnType<typeof setTimeout> | undefined
    idleWatch = createIdleWatchdog(() => {
      backgroundFailure = IDLE_FAILURE
      checkpoint.failure = IDLE_FAILURE
      if (checkpoint.pending.length) checkpoint.cleanup = { status: 'unconfirmed', execution: id, kept: [] }
      persist()
      stop(child, plan.managedProcess)
      idleExit = setTimeout(() => {
        finishIdle()
        child.stdout.destroy()
        child.stderr.destroy()
      }, KILL_GRACE_MS * 2)
    })
    let activityVersion = 0
    let stderr = ''
    const fromAgent = (text: string) => {
      const version = renderer.activity?.() ?? 0
      if (version !== activityVersion) { activityVersion = version; idleWatch?.touch() }
      const session = plan.session()
      if (!stream.lost() && session && session !== checkpoint.session) {
        checkpoint.session = session
        persist()
      }
      if (!structured) {
        stream.out(text)
      }
      if (attempt) measure(report(job, plan))
      for (const e of renderer.events?.() ?? []) {
        remember(e)
      }
    }
    const readOutput = (chunk: string) => {
      fromAgent(renderer.push(chunk))
      if (renderer.terminalFailure?.()) {
        idleWatch?.close()
        stop(child, plan.managedProcess)
      }
      // A runtime reading turns from stdin keeps going until stdin closes.
      if (plan.stdin && streamFinished(renderer) && !child.stdin.writableEnded) child.stdin.end()
    }
    child.stdout.on('data', readOutput)
    child.stderr.setEncoding('utf8')
    const readError = (chunk: string) => {
      renderer.stderr?.(chunk)
      const visible = quietLines(plan, chunk)
      stderr = (stderr + visible).slice(-4_000)
      stream.out(visible)
    }
    child.stderr.on('data', readError)
    const ended = await Promise.race([
      idleEnded,
      new Promise<{ code: number | null; failure?: ExecutionFailure }>((resolve) => {
        child.on('error', (e) => resolve({ code: null, failure: executionFailure(e) }))
        child.on('close', (code) => resolve({ code }))
      }),
    ])
    clearTimeout(idleExit)
    child.stdout.off('data', readOutput)
    child.stderr.off('data', readError)
    idleWatch?.close()
    fromAgent(renderer.flush())
    const pending = renderer.background?.() ? makeFailure('runtime', 'The agent exited with unfinished background tasks.', { code: 'background_unfinished' }) : undefined
    return { ...ended, stderr: stderr.trim(), failure: backgroundFailure ?? ('failure' in ended ? ended.failure : undefined) ?? pending }
  }
  const plan = run
  const ended = await printed(plan)
  let measured = measure(report(job, plan))
  const renderer = plan.renderer!
  if (reply && job.runtime === 'codex') {
    checkpoint.replyParts = { cwd, parts: renderer.replyParts?.() ?? [{ type: 'text', text: measured.reply ?? '' }] }
  }
  const diagnostic = renderer.failure?.() ?? (ended.code === 0 ? undefined : ended.stderr || `Exited with code ${ended.code}.`)
  const rawFailure = ended.failure ?? renderer.executionFailure?.()
    ?? (diagnostic ? makeFailure('runtime', diagnostic, { code: 'execution_failed' }) : undefined)
  if (!rawFailure && !stream.lost()) recordContext(measured.session)
  measured = retainReply(measured, !!rawFailure)
  if (isSessionMissingFailure(rawFailure)) checkpoint.session = undefined
  if (await retry(rawFailure)) return
  const stopped = await stopReply(id, deps.stopMs)
  if (stream.asked() && (!stopped || !await stream.confirmed())) { await stream.end(); return }
  const recovery = replyRecovery(job, checkpoint, stopped)
  const unsafe = reply && !!rawFailure && !recovery.safe && !recovery.resumable
  const failure = stream.asked() ? undefined : replyReason(rawFailure, checkpoint.retryPause, job, unsafe)
  if (rawFailure && unsafe) stream.event({ kind: 'error', data: { text: rawFailure.summary } })
  const retries = !failure && !stream.asked() && checkpoint.retryHistory?.length ? checkpoint.retryHistory : undefined
  if (retries) {
    const last = retries[retries.length - 1]!
    stream.event({
      kind: 'retry',
      data: {
        state: 'recovered',
        source: last.source,
        runtime: runtimeInfo(),
        attempt: Math.max(1, budget.attempt() - 1),
        maxAttempts: MAX_RETRY_ATTEMPTS,
        summary: last.summary,
        ...(last.code ? { code: last.code } : {}),
        at: new Date().toISOString(),
      },
    })
  }
  const failureDetail = failure && !stream.asked()
    ? buildFailureDetail(
        rawFailure,
        unsafe ? 'unsafe' : (checkpoint.retryPause ?? 'limit'),
        !unsafe && (recovery.safe || recovery.resumable),
        unsafe ? 'pause_unsafe' : recovery.safe ? 'reset_replay' : recovery.resumable ? 'resume' : undefined,
      )
    : undefined
  const said: JobReport = {
    ...told(stream.asked() ? cutShort(measured, stream.said()) : measured),
    ...(reply ? { recovery } : {}),
    ...(retries ? { retries } : {}),
    ...(failureDetail ? { failure: failureDetail } : {}),
  }
  if (!stream.asked()) complete(failure ? 'failed' : 'done', said, failure)
  if (failure || !ws || stream.asked()) {
    await stream.end()
    if (stream.lost()) return
    if (stream.asked() && (ws && !reply || job.runtime === 'antigravity')) return finishClaimed('stopped', '', said)
    return finishClaimed(failure ? 'failed' : 'done', failure, said)
  }
  if (!stream.lost()) return sendResult(said, () => keepChat(job, said.reply))
}

/** A periodic agent, on the project's folder here; a job for a project with none here fails. */
async function runAgentJob(job: Job & { agent: AgentJob }, ws: TaskFolder, deps: StepDeps, stream: ReturnType<typeof streamOut>, sync: Sync, retryFile: string,
  checkpoint: Checkpoint, persist: () => void, starting: () => void, sendResult: (report: JobReport) => Promise<void>, finish: (outcome: Outcome, reason?: string, report?: JobReport) => Promise<void>): Promise<void> {
  if (stream.lost()) return
  if (checkpoint.completed) {
    const { outcome, reason, report } = checkpoint.completed
    return outcome === 'done' ? sendResult(report) : finish(outcome, reason, report)
  }
  const ended = await runAgent(job, ws, deps, { flowRun: checkpoint.flowRun, starting, show: stream.out, event: (event) => {
    if (stream.lost()) return
    checkpointEvent(checkpoint, event)
    persist()
    stream.event(event)
  }, track: stream.adopt, onStop: stream.onStop, lost: stream.lost, asked: stream.asked, sync, retryFile })
  if (ended.ok) {
    checkpoint.completed = { outcome: 'done', report: ended.report }
    checkpoint.reviewedRejections = ended.reviewed
    persist()
  }
  if (ended.ok && !stream.asked() && !stream.lost()) return sendResult(ended.report)
  await stream.end()
  if (stream.lost()) return
  if (stream.asked()) return finish('stopped')
  if (!ended.ok) return finish('failed', ended.reason)
}

const quietLines = (plan: Plan, chunk: string) =>
  chunk.split('\n').filter((line) => line && !plan.quiet(line)).map((line) => `${line}\n`).join('')

function replyReason(failure: ExecutionFailure | undefined, pause: RetryPause | undefined, job: Job, unsafe: boolean): string | undefined {
  if (!failure) return
  if (failure.code === 'codex_ownership_unconfirmed' || failure.code === 'completed_operation_failed') return failure.summary
  if (unsafe || pause === 'unsafe') return isReply(job) ? 'recovery_unsafe' : failure.summary
  if (isSessionMissingFailure(failure) && job.sessionFallback) return 'session_unavailable'
  return pause ? `${failure.summary}\n${pauseLine(pause, cloudLanguage(job) === 'zh')}` : failure.summary
}

/** A runtime's process, started the way Windows needs (agent/spawnable.ts). */
function launch(command: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams {
  const start = spawnable(command, args, options)
  return spawn(start.command, start.args, start.options) as ChildProcessWithoutNullStreams
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const kill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    kill.on('error', () => child.kill(signal))
    kill.on('exit', (code) => code && child.exitCode === null && child.kill(signal))
    return
  }
  try { process.kill(-child.pid, signal) } catch { child.kill(signal) }
}

/** A child that never spawned has no pid: killing it would signal this whole process group. */
const stop = (child: ChildProcess, managed = false) => {
  if (managed) { endConnection(child); return }
  if (!child.pid) return
  signalTree(child, 'SIGTERM')
  const timer = setTimeout(() => signalTree(child, 'SIGKILL'), KILL_GRACE_MS)
  timer.unref()
  child.once('close', () => clearTimeout(timer))
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const held = (deps: Shared, lease: Lease) => {
  // 墙上时钟覆盖休眠，单调时钟防止系统时间回拨延长租约。
  if (Math.max(Date.now() - lease.at, performance.now() - lease.monotonic) >= deps.leaseMs) lease.lost = true
  return !lease.lost
}

type Outcome = 'done' | 'failed' | 'conflict' | 'stopped'

function writebackRecovery(job: Job, report: JobReport): JobReport {
  return job.chat && !job.flow ? { ...report, recovery: { safe: false, stopped: true, resumable: true, writeback: true } } : report
}

type FinishJob = (outcome: Outcome, reason?: string, report?: JobReport, landed?: () => void) => Promise<void>

/** What the job changed goes back, then how it ended; `landed` once both were taken. */
async function sendBack(job: Job, deps: StepDeps, ws: TaskFolder, report: JobReport, sync: Sync, stream: ReturnType<typeof streamOut>,
  finish: FinishJob,
  landed: () => void, repair: (problem: Extract<Pushed, { ok: false }>) => Promise<void>, confirm: () => Promise<api.Call<unknown>>): Promise<void> {
  const lands = job.flow?.phase === 'land' && !report.review
  const closesTask = job.flow && !report.review && !report.landReady && (report.deliveryCompleted ??
    (job.flow.verb === 'implement' || job.flow.verb === 'create' && job.flow.skip_plan))
  const taskReply = job.chat && !job.flow
  const result = await sync('publish', async () => {
    const pushed = await push(ws, { id: job.id, machineId: deps.machineId }, () => stream.asked() || stream.lost())
    if (pushed.ok && (taskReply || closesTask || report.landReady) && !taskAssetsSynced(ws)) {
      return { ok: false, code: 'service_unavailable', error: 'Preview uploads are pending.' }
    }
    if (!pushed.ok && writeBlock(pushed)) return pushed
    return !pushed.ok && pushed.offline
      ? { ok: false, error: pushed.error, code: 'service_unavailable' }
      : { ok: true, value: pushed }
  })
  const pushed = result.ok ? result.value : result
  const confirmed = pushed.ok ? await sync('confirm', confirm) : undefined
  const repairable = !pushed.ok && 'conflict' in pushed && (pushed.conflict || pushed.failure?.source === 'validation' || pushed.failure?.source === 'sync') ? pushed : null
  const denied = confirmed && !confirmed.ok ? confirmed : !pushed.ok && !repairable ? pushed : null
  if (lands && denied && landLeaseLost(denied)) { await stream.stop(); return }
  const action = denied && (lands ? landArchiveRefusal(job, denied) : syncRefusal(job, denied))
  if (action && !stream.lost() && !stream.asked()) stream.event({ kind: 'error', data: { text: action } })
  if (repairable && !stream.lost() && !stream.asked()) {
    const savedErrors = repairable.conflict ? pendingConflicts(ws.board).flatMap(r => r.error ? [r.error] : []) : []
    if (lands) logSync('land.archive_repair', { job: job.id, task: job.task, code: repairable.code, error: repairable.error, savedErrors })
    else stream.event({ kind: 'error', data: { text: [repairable.error, ...savedErrors].join('\n') } })
    return repair(repairable)
  }
  if (lands && !denied && !stream.asked() && !stream.lost()) {
    const archive = syncedArchive(ws)
    if (archive) return finish('done', '', { ...report, archive }, landed)
    const error = 'Verify the saved card is archived and its attachments are available.'
    return repair({ ok: false, conflict: false, error, failure: makeFailure('validation', error, { code: 'land_archive_sync' }) })
  }
  await stream.end()
  if (stream.lost()) return
  if (stream.asked()) return finish('stopped', '', report)
  if (denied) {
    console.error('runner: task sync refused', { job: job.id, code: denied.code, error: denied.error })
    return finish('failed', action || denied.error, writebackRecovery(job, report))
  }
  const archive = closesTask && report.deliveryId ? syncedArchive(ws) : undefined
  return finish('done', '', {
    ...report,
    ...(taskReply ? { replyWriteSynced: true } : {}),
    ...(archive ? { archive } : {}),
    ...(readCheckpoint(job.id)?.approvalRequested ? { replyApprovalSynced: report.replyApprovalSynced !== false && taskAssetsSynced(ws) } : {}),
  }, landed)
}

/** The runtime's settings and the keys this computer holds for it. */
export const settingsOf = (job: Job): Settings => ({ settings: job.settings, secrets: secretsOf(job.runtimeId) })

/** A runtime's keys (#2135), kept here and nowhere else; Cloud hears only that it is done. */
async function runSecret(job: Job, deps: Shared): Promise<void> {
  if (!job.runtimeId || !job.secrets) return void (await deps.api.finishJob(deps.machineId, job.id, 'failed', 'This job carries no keys.'))
  try {
    keepSecrets(job.runtimeId, job.secrets)
  } catch (e) {
    return void (await deps.api.finishJob(deps.machineId, job.id, 'failed', e instanceof Error ? e.message : String(e)))
  }
  await deps.api.finishJob(deps.machineId, job.id, 'done', '')
}

/** A connection test (#2074): the prompt alone, on the job's connector and model, reported as
 *  `not_installed`, `signed_out` or `timeout`, the connector's own words, or done with how long it took. */
async function runTest(job: Job, deps: Shared, lease: Lease): Promise<void> {
  const finish = async (outcome: 'done' | 'failed', reason: string, ms?: number) => {
    for (let attempt = 1; held(deps, lease); attempt++) {
      const sent = await deps.api.finishJob(deps.machineId, job.id, outcome, reason, ms === undefined ? undefined : { ms })
      if (sent.ok && sent.value.finished) { clearCheckpoint(job.id); return }
      if (sent.ok || !retryableSync(sent)) break
      const decision = planRetry(makeFailure('sync', sent.error, { code: sent.code }), attempt, Date.now(), () => deps.retryMs)
      if ('pause' in decision) break
      await waitForRetry(decision.plan.at)
    }
    console.error(`runner: connection test ${job.id}: Cloud did not accept the result.`)
  }
  const report = (await deps.runtimes()).find((r) => r.name === job.runtime)
  if (!report?.installed) return finish('failed', 'not_installed')
  if (report.loggedIn === false) return finish('failed', 'signed_out')
  const cwd = path.join(ownFolder(), 'test')
  fs.mkdirSync(cwd, { recursive: true })
  const run = deps.plan(job.runtime, job.prompt, cwd, null, job.model, settingsOf(job))
  const startedAt = Date.now()
  if (run.converse) {
    const child = launch(run.command, run.args, { cwd, env: run.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] })
    child.stdin.on('error', () => {})
    let timer: NodeJS.Timeout | undefined
    const end = await Promise.race([
      run.converse(child, () => {}),
      new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), deps.testMs))),
      new Promise<NodeJS.ErrnoException>((resolve) => child.on('error', resolve)),
    ])
    clearTimeout(timer)
    stop(child, run.managedProcess)
    const ms = Date.now() - startedAt
    if (end === 'timeout') return finish('failed', 'timeout', ms)
    if (end instanceof Error) return end.code === 'ENOENT' ? finish('failed', 'not_installed') : finish('failed', end.message.slice(0, 300), ms)
    return end.ok ? finish('done', '', ms) : finish('failed', (end.error || 'The connector stopped.').slice(0, 300), ms)
  }
  const renderer = run.renderer!
  const exited = await new Promise<{ code: number | null; error?: NodeJS.ErrnoException; timedOut?: boolean; said: string }>((resolve) => {
    let said = ''
    const child = launch(run.command, run.args, { cwd, env: run.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref()
      resolve({ code: null, timedOut: true, said })
    }, deps.testMs)
    child.stdin.on('error', () => {})
    if (run.stdin) child.stdin.write(run.stdin)
    else child.stdin.end()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      renderer.push(chunk)
      if (run.stdin && streamFinished(renderer) && !child.stdin.writableEnded) child.stdin.end()
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      renderer.stderr?.(chunk)
      said += chunk.split('\n').filter((line) => line && !run.quiet(line)).map((line) => `${line}\n`).join('')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, error, said })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, said })
    })
  })
  const ms = Date.now() - startedAt
  if (exited.timedOut) return finish('failed', 'timeout', ms)
  if (exited.error?.code === 'ENOENT') return finish('failed', 'not_installed')
  renderer.flush()
  const failure = exited.error?.message ?? renderer.failure?.() ?? (exited.code === 0 ? undefined : exited.said.trim().split('\n').at(-1) || `Exited with code ${exited.code}.`)
  if (failure) return finish('failed', failure.slice(0, 300), ms)
  return finish('done', '', ms)
}

function report(job: Job, run: Plan, turn?: TurnEnd): JobReport {
  const context = turn ? turn.context : run.renderer?.context?.()
  const limit = context?.limit ?? contextLimit(job.runtime, run.model?.() ?? job.model ?? undefined)
  const usage = turn ? turn.usage : run.renderer?.usage?.()
  const costUsd = turn ? turn.costUsd : run.renderer?.costUsd?.()
  return {
    reply: turn ? turn.result : run.renderer?.result(),
    session: run.session(),
    ...(usage ? { usage } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...((turn ? turn.costIncomplete : run.renderer?.costIncomplete?.()) ? { costIncomplete: true } : {}),
    ...(context?.used !== undefined && limit ? { context: { used: context.used, limit } } : {}),
  }
}

/** A reply stopped part way: what the agent said by then. */
const cutShort = (said: JobReport, text: string): JobReport => ({ ...said, reply: said.reply || text || undefined, stopped: true })
