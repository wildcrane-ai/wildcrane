import { reviewBoundary } from '../../cli/src/lib/shared/review-plan'
import { createHash } from 'node:crypto'
import { conflictPrompt, pendingConflicts } from '../../cli/src/lib/shared/board-conflicts'
import { idleStopConfirmed } from '../../cli/src/lib/agent/wire/codex-background-types'
import { createIdleWatchdog, IDLE_FAILURE } from '../../cli/src/lib/agent/idle'
import { pauseLine, planRetry, syncRepairPrompt, type ExecutionFailure, type RetryPause } from '../../cli/src/lib/agent/retry'
import { executionFailure } from '../../cli/src/lib/agent/wire/failures'
import { taskStudioContext } from './task-folder'
import { connectionIdentity, endConnection } from '../../cli/src/lib/agent/connection-process'
import { conversationProgress } from './conversation-progress'
import { readSession } from '../../cli/src/lib/cloud/session'
import { accountGeneration } from './settings-control'
import { CONVERSATION_MS } from '../../cli/src/lib/shared/conversation'
import { streamFinished } from '../../cli/src/lib/agent/wire/background'
import { saveReplyImages } from './reply-images'
// 领取作业、运行并回写；断网只能运行到租约到期，失效后停止本地执行。

import { cloudLanguage } from '../../cli/src/lib/agent/language'
import { authorizedFolder, progressEvidence, progressFolder, restartFolder } from './handoff'
import { markEnv, stopMark } from '../../cli/src/lib/agent/stop'
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { spawnable } from '../../cli/src/lib/agent/spawnable'
import fs from 'node:fs'
import path from 'node:path'

import { contextLimit, refreshCatalog } from '../../cli/src/lib/agent/catalog'
import { replyApprovalBridge } from './reply-approval'
import { syncedCardVersion, withBoard, replyAssetsSynced } from './task-folder'
import { akbEnv, type Akb } from './akb'
import { currentAkb } from './akb-version'
import type { RunEvent, TurnEnd } from '../../cli/src/lib/agent/wire'
import * as api from './api'
import type { AgentJob, Flow, Job, JobEvent, JobReport, RuntimeReport } from './api'
import { keepChat, keepCloudChat, keepDecisions, markReviewed, reviewMarks } from './chats'
import { confirmFlowStopped, runAgent, runFlow, runReview, writeTranscript } from './flow'
import { hold } from './cache'
import { allowedProjects } from './folders'
import { readGoals, writeGoals } from './goals'
import { replySpent, checkpointEvent, clearCheckpoint, readCheckpoint, saveCheckpoint, stopReply, replayable, resumable, syncing, type Checkpoint } from './recovery'
import { runnerHome } from './home'
import { retryableSync, syncBackoff, syncRefusal, syncStopped, SYNC_RETRY_MAX_MS, type Sync } from './sync-retry'
import { trackSubagents } from './subagents'
import { followProxy } from './proxy'
import { detectRuntimes, forks, plan as realPlan, type Plan, type Settings } from './runtimes'
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
  api: Pick<typeof api, 'claimJob' | 'renewJob' | 'openLog' | 'finishJob' | 'readTask' | 'readStudio' | 'listStudios' | 'readRejections' | 'markReviewed' | 'readAgents' | 'readChat' | 'readDecisions' | 'listChats'>
  plan: (runtime: Job['runtime'], prompt: string, cwd: string, resume?: string | null, model?: string | null, settings?: Settings, fork?: boolean, language?: 'zh' | 'en' | null) => Plan
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
function writeAttachments(job: Job): { text: string; files: string[] } {
  if (!job.attachments.length) return { text: '', files: [] }
  const dir = attachmentsOf(job)
  fs.mkdirSync(dir, { recursive: true })
  const files = job.attachments.map((a) => {
    const file = path.join(dir, path.basename(a.name))
    fs.writeFileSync(file, Buffer.from(a.content, 'base64'))
    return file
  })
  return { text: `\n\nAttached files:\n${files.map((f) => `- ${f}`).join('\n')}`, files }
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
    const immediate = e.kind === 'phase' || e.kind === 'status' || content && !firstContent
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

/** Claim and run one job. Resolves once it has ended, or at once when it was not ours to run.
 *  `track` receives what stops it; a stopped job is left for Cloud to hand out again. */
export async function runJob(id: string, deps: Deps, track: (stop: () => Promise<void>) => void = () => {}, stopped = () => false, reply = false): Promise<void> {
  followProxy()
  const lease = leaseNow()
  const claim = await deps.api.claimJob(deps.machineId, id, reply)
  if (!claim.ok || !claim.value.claimed || stopped() || !held(deps, lease)) return
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
}

interface JobScope {
  bridge?: Awaited<ReturnType<typeof replyApprovalBridge>>
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
    await scope.waitingStream?.end()
  }
}

async function runClaimedStep(job: Job, deps: StepDeps, track: (stop: () => Promise<void>) => void, keep: (dir: string) => void,
  lease: Lease, scope: JobScope, replyStream?: ReturnType<typeof streamOut>): Promise<void> {
  const id = job.id
  const local = readCheckpoint(id)
  const sourceId = job.flow?.sync_recovery_of ?? job.recoveryOf
  const source = sourceId ? readCheckpoint(sourceId) : null
  const previous = local ?? (job.flow && !syncing(source) ? null : source)
  const checkpoint: Checkpoint = previous ?? { pending: [], started: false, effects: false }
  if (checkpoint.boardContinuation) job = { ...job, task: job.task ?? job.review?.tasks[0], flow: undefined, review: undefined, handoff: undefined, prompt: checkpoint.boardContinuation.prompt, resume: checkpoint.session, fork: false }
  const reply = !!(job.chat || job.discussion) && !job.flow
  const spent = (): JobReport | undefined => reply && checkpoint.attempts?.length && !(job.recoveryOf && !local && checkpoint.completed)
    ? { session: checkpoint.session, ...replySpent(checkpoint, job.runtime) } : undefined
  const finishClaimed = (outcome: Outcome, reason = '', said?: JobReport) => {
    const before = spent()
    let report = before ? { ...before, ...said } : said
    if (reply && outcome === 'failed' && !report?.reply && checkpoint.partialReply) {
      report = { ...report, reply: checkpoint.partialReply }
    }
    if (reply && outcome === 'failed' && checkpoint.started === false && checkpoint.effects === false
        && !checkpoint.pending.length && !checkpoint.opaque
        && (!(job.recoveryOf || job.manualRecovery) || previous || job.retryReplay === true)) {
      report = { ...report, recovery: { safe: true, stopped: true, resumable: false } }
      saveCheckpoint(id, checkpoint)
    }
    if (before && outcome === 'failed') {
      checkpoint.completed = { outcome, reason, report: report! }
      saveCheckpoint(id, checkpoint)
    }
    return finish(deps, id, lease, outcome, reason, report)
  }
  const manual = job.manualRecovery === true
  const updating = checkpoint.updating === true
  const recovering = updating || !!job.recoveryOf || !!(job.flow?.sync_recovery_of && previous) || !!checkpoint.retry?.pending
  const persist = () => {
    checkpoint.updating ||= readCheckpoint(id)?.updating
    saveCheckpoint(id, checkpoint)
  }
  if (manual && !local && checkpoint.completed?.outcome === 'failed') {
    delete checkpoint.completed
    delete checkpoint.attempts
    delete checkpoint.partialReply
  }
  const forkSource = job.fork ? job.resume : checkpoint.forkSource
  if (forkSource && !checkpoint.submitted) {
    checkpoint.forkSource = forkSource
    if (!job.fork && !checkpoint.session && replayable(checkpoint)) job = { ...job, resume: forkSource, fork: true }
  }
  if (forkSource && checkpoint.session === forkSource && checkpoint.submitted !== true) delete checkpoint.session
  if (!forkSource) checkpoint.session ??= job.resume ?? undefined
  const updateContinuation = updating && !checkpoint.failure && !checkpoint.retry?.pending
  const updateReplay = reply && updateContinuation && !checkpoint.session && job.runtime !== 'antigravity'
    && checkpoint.cleanup?.status !== 'unconfirmed' && replayable(checkpoint)
  const pauseRecovery = (pause: RetryPause, stopped: boolean) => {
    checkpoint.retryPause = pause
    if (checkpoint.retry) delete checkpoint.retry.pending
    persist()
    const reason = [checkpoint.failure?.reason, pauseLine(pause, cloudLanguage(job) === 'zh')].filter(Boolean).join('\n')
    return finishClaimed('failed', pause === 'unsafe' ? 'recovery_unsafe' : reason, {
      recovery: { safe: replayable(checkpoint), stopped, resumable: resumable(checkpoint) },
    })
  }
  if (reply) {
    const hadRetryCount = !!checkpoint.retry
    checkpoint.retry ??= { since: Date.now(), attempt: 1 }
    if (!replyStream && previous?.started && checkpoint.completed?.outcome !== 'done'
      && !await stopReply(local ? id : job.recoveryOf ?? id, deps.stopMs)) return pauseRecovery('unsafe', false)
    if (!checkpoint.completed && (!manual || local)) {
      if (!previous && job.recoveryOf) return pauseRecovery('unsafe', true)
      const retry = checkpoint.retry
      if (checkpoint.launching || retry.at !== undefined || !Number.isSafeInteger(retry.attempt) || retry.attempt < 1) return pauseRecovery('unsafe', true)
      if (job.runtime === 'antigravity' && recovering && checkpoint.started && !checkpoint.session) {
        return finishClaimed('failed', 'Antigravity did not record a conversation ID before interruption. The original session cannot be resumed.')
      }
      if (!replyStream && !retry.pending && previous?.started && (updating || job.recoveryOf)) {
        if (!hadRetryCount) return pauseRecovery('unsafe', true)
        if (updateContinuation) {
          if (!resumable(checkpoint) && !updateReplay) return pauseRecovery('unsafe', true)
        } else {
          const failure = checkpoint.failure ?? { code: 'runner_interrupted', level: 2 as const, reason: 'The Runner was interrupted.' }
          checkpoint.failure = failure
          const decision = planRetry(failure, retry.attempt, Date.now(), deps.replyBackoff)
          if ('pause' in decision) return pauseRecovery(decision.pause, true)
          retry.pending = decision.plan
        }
      } else if (!replyStream && !recovering && previous?.started && !checkpoint.boardContinuation) {
        return pauseRecovery('unsafe', true)
      }
      if (retry.pending) {
        checkpoint.failure = retry.pending.failure
        if (!canRetryReply(checkpoint, retry.pending.failure, job.runtime)) return pauseRecovery('unsafe', true)
      }
    }
  }
  const pendingRetry = reply && checkpoint.retry?.pending || undefined
  const replay = !(job.runtime === 'antigravity' && checkpoint.session) && (
    updateReplay
    || (manual && !!previous && replayable(previous))
    || (job.retryReplay === true && !local)
    || (!!pendingRetry && pendingRetry.failure.level === 2 && replayable(checkpoint)
      && (pendingRetry.failure.code !== 'runner_interrupted' || !checkpoint.session)))
  if (recovering && checkpoint.session && (!replay || forkSource && !checkpoint.submitted)) job = { ...job, resume: checkpoint.session, fork: false }
  else if (replay && !forkSource) job = { ...job, resume: null, fork: false }
  if (updating) {
    delete checkpoint.updating
    saveCheckpoint(id, checkpoint)
  } else if (reply || !recovering || checkpoint.syncRetry || checkpoint.completed) persist()
  if (!reply && !job.flow && updating && checkpoint.started && !checkpoint.completed && !resumable(checkpoint)) {
    return finishClaimed('failed', 'recovery_unsafe')
  }
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
  const watching = () => {
    const stream = replyStream ?? (scope.waitingStream ??= streamOut(deps, id, lease))
    track(stream.stop)
    return stream
  }
  const sync: Sync = async (step, operation) => {
    const stream = watching()
    let waiting = false
    while (!stream.lost() && !stream.asked()) {
      let renewed: Extract<api.Call<unknown>, { ok: false }> | undefined
      const retry = checkpoint.syncRetry?.step === step ? checkpoint.syncRetry : undefined
      if (retry) {
        if (!waiting) stream.event({ kind: 'status', data: { state: 'retrying', source: 'sync' } })
        waiting = true
        let timer: ReturnType<typeof setTimeout> | undefined
        const ms = Math.max(0, Math.min(SYNC_RETRY_MAX_MS, retry.at - Date.now()))
        await Promise.race([new Promise<void>(resolve => { timer = setTimeout(resolve, ms) }), stream.whenAsked])
        clearTimeout(timer)
        if (stream.asked() || stream.lost()) break
        const requestedAt = leaseNow()
        const hold = await deps.api.renewJob(deps.machineId, id)
        if (stream.lost()) break
        if (hold.ok) {
          if (!hold.value.renewed) { await stream.stop(); break }
          Object.assign(lease, requestedAt)
          if (hold.value.stop) { stream.requestStop(); break }
        } else renewed = hold
      }
      const result = renewed ?? await operation()
      if (stream.asked() || stream.lost()) break
      if (result.ok || !retryableSync(result)) {
        if (waiting) stream.event({ kind: 'status', data: { state: 'running', source: 'sync' } })
        if (retry) {
          delete checkpoint.syncRetry
          persist()
        }
        return result
      }
      console.error('runner: task sync', { job: id, code: result.code, error: result.error })
      const attempt = (checkpoint.syncRetry?.attempt ?? 0) + 1
      checkpoint.syncRetry = { step, attempt, at: Date.now() + (deps.syncBackoff ?? syncBackoff)(attempt) }
      persist()
    }
    return syncStopped
  }
  const authorize = async () => !deps.authorize ? { ok: true as const, value: true } : sync('authorize', async () => {
    const allowed = await deps.authorize!(job)
    return typeof allowed === 'boolean' ? { ok: true, value: allowed } : allowed
  })
  const unauthorized = async (allowed: api.Call<boolean>) => {
    const stream = scope.waitingStream ?? replyStream
    await stream?.end()
    if (stream?.lost()) return
    if (stream?.asked()) return finishClaimed('stopped')
    return finishClaimed('failed', allowed.ok ? '项目目录授权已变化，请重新确认后重试。' : syncRefusal(job, allowed))
  }
  const allowed = await authorize()
  if (!allowed.ok || !allowed.value) return unauthorized(allowed)
  if (job.secret) return runSecret(job, deps)
  if (job.test) return runTest(job, deps, lease)

  const waitingStream = pendingRetry || job.task ? watching() : replyStream
  if (pendingRetry && waitingStream) {
    const stream = waitingStream
    track(stream.stop)
    stream.event({ kind: 'log', data: { text: '[chat-recovery] waiting' } })
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, pendingRetry.at - Date.now())) }), stream.whenAsked])
    clearTimeout(timer)
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
    if (!allowed.ok || !allowed.value) return finishWait('authorization')
    const requestedAt = leaseNow()
    const renewed = await deps.api.renewJob(deps.machineId, id)
    if (renewed.ok && renewed.value.stop) stream.requestStop()
    if (!renewed.ok || !renewed.value.renewed || stream.asked() || stream.lost()) return finishWait('authorization')
    Object.assign(lease, requestedAt)
  }

  // A task, and a review in its first task's, runs only in the project's folder here (#516).
  const task = job.task ?? job.review?.tasks[0] ?? null
  const folder = task && !job.projectDir ? { refused: NO_FOLDER }
    : job.agent && !job.projectDir ? { refused: 'This project has no folder on this computer.' } : folderFor(job)
  if (folder && 'refused' in folder) {
    return finishClaimed('failed', folder.refused)
  }

  let ws: TaskFolder | null = null
  let cwd = folder?.cwd ?? ''
  let run: Plan | null = null
  let goalFile: string | null = null
  let discussed: string | undefined
  let syncDiagnostic = ''
  const sendResult = (report: JobReport, landed = () => {}) => {
    const prior = checkpoint.boardContinuation?.report
    const sum = (key: keyof NonNullable<JobReport['usage']>) => (prior?.usage?.[key] ?? 0) + (report.usage?.[key] ?? 0)
    const usage = prior?.usage && report.usage && !reply
      ? { input: sum('input'), cacheCreation: sum('cacheCreation'), cacheRead: sum('cacheRead'), output: sum('output') } : report.usage ?? prior?.usage
    const costUsd = prior?.costUsd !== undefined && report.costUsd !== undefined && !reply && job.runtime !== 'claude-code'
      ? prior.costUsd + report.costUsd : report.costUsd ?? prior?.costUsd
    const completed = prior ? { ...prior, session: report.session ?? prior.session, ...(usage ? { usage } : {}), ...(costUsd !== undefined ? { costUsd } : {}) } : report
    return sendBack(job, deps, lease, ws!, completed, sync, watching(), landed, async pushed => {
      const records = pushed.conflict ? pendingConflicts(ws!.board) : []
      const facts = createHash('sha256').update(JSON.stringify(pushed.conflict
        ? records.map(r => ({ id: r.id, state: r.state, files: r.files })) : pushed.failure)).digest('hex')
      if (pushed.conflict && !records.length) {
        console.error(JSON.stringify({ code: 'board_conflict_missing', phase: 'publish-result', job: id, task: job.task, project: job.project }))
        return finishClaimed('failed', 'The result could not be saved safely. Saved work was preserved.', completed)
      }
      if (checkpoint.boardContinuation?.facts === facts || !pushed.conflict && checkpoint.boardContinuation?.validation) {
        return finishClaimed('failed', pushed.conflict ? `Board content conflicts remain unresolved: ${records.map(r => r.id).join(', ')}. Contents and resolution drafts are preserved.` : pushed.error, completed)
      }
      const session = report.session ?? checkpoint.session
      if (job.review && !session) return finishClaimed('failed', pushed.error, completed)
      const requestedAt = leaseNow()
      const renewed = await deps.api.renewJob(deps.machineId, id)
      if (!renewed.ok || !renewed.value.renewed || !held(deps, lease)) return
      if (renewed.value.stop) return finishClaimed('stopped', '', completed)
      Object.assign(lease, requestedAt)
      const allowed = await authorize()
      if (!allowed.ok || !allowed.value) return unauthorized(allowed)
      const prompt = pushed.conflict
        ? conflictPrompt(ws!.board, 'Resolve and confirm synchronization, preserve completed work, then return the saved result.')
        : syncRepairPrompt(pushed.failure!.reason)
      checkpoint.boardContinuation = { report: completed, facts, prompt, validation: !pushed.conflict || checkpoint.boardContinuation?.validation }
      checkpoint.session = session
      delete checkpoint.completed
      persist()
      scope.progress?.cancel()
      scope.bridge?.close()
      await runClaimed({ ...job, prompt, resume: session, fork: false }, deps, track, keep, lease)
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
  try {
    if (job.agent) {
      ws = openAgentFolder(job, folder.cwd)
      cwd = ws.cwd
      keep(cwd)
      if (!checkpoint.boardContinuation) return runAgentJob(job as Job & { agent: AgentJob }, ws, deps, watching(), sync, lease, checkpoint, persist, sendResult)
    } else if (task) {
      ws = openTaskFolder({ ...job, task }, folder?.cwd ?? null)
      cwd = ws.cwd
      keep(cwd)
      // A flow job, and a review, pulls once its board is there.
      if (!job.flow && !job.review && !checkpoint.completed) {
        const pulled = await sync('prepare', () => pull(ws!, deps.machineId, () => !!waitingStream?.asked() || !!waitingStream?.lost()))
        if (!pulled.ok) {
          if (pulled.code === 'stopped') {
            await waitingStream?.end()
            return waitingStream?.asked() ? finishClaimed('stopped') : undefined
          }
          if (pulled.failure?.level === 1) syncDiagnostic = syncRepairPrompt(pulled.failure.reason)
          else if (pulled.code !== 'board_content_conflict') {
            console.error('runner: task sync refused', { job: id, code: pulled.code, error: pulled.error })
            throw new Error(syncRefusal(job, pulled))
          }
        }
      }
    }
    if (ws && job.chat && !job.flow && !checkpoint.completed) {
      const folder = ws
      scope.bridge = await replyApprovalBridge(job.task!, job.number!, async (comment, asked, target) => await withBoard(folder, async (send) => {
        if (checkpoint.approvalCancelled) return { ok: false, error: 'This reply failed before. Ask again in a new reply.' }
        const pushed = await send({ id, machineId: deps.machineId })
        if (!pushed.ok) return { ok: false, error: pushed.error }
        if (!replyAssetsSynced(folder)) return { ok: false, error: 'Preview uploads are still pending. Try again after they finish.' }
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
      const wrote = await writeGoals({ ...job, discussion: job.discussion }, deps.api.listStudios, recovering)
      if ('error' in wrote) throw new Error(wrote.error)
      goalFile = wrote.file
    }
    if (!job.flow && !job.review) {
      // Behind the reply: until it lands, the catalogue on disk names the window.
      void refreshCatalog()
      const attachments = writeAttachments(job)
      const head = (syncDiagnostic ? syncDiagnostic + '\n\n' : '') + (job.taskReview ? reviewBoundary(job.taskReview) + '\n\n' : '') + folderLines(job.agent ? null : ws) + (ws ? '\n\n' + conflictPrompt(ws.board) : '') + (ws && !job.agent ? '\n\n' + taskStudioContext(ws, !job.resume) : '') + attachments.text
      const file = writeTranscript(job, attachmentsOf(job))
      const transcript = file ? `\n\nThis task came out of a discussion. Read it for what the card leaves out: ${file}` : ''
      const promptOf = (said: string) => {
        const lines = (head + said).trim()
        const prompt = recovering && !replay && (!forkSource || checkpoint.submitted === true) && (checkpoint.started || job.recoveryOf)
          ? [job.runtime === 'antigravity' ? job.prompt : '', '连接恢复后继续之前中断的回复。先核对已有进度和操作结果，保留完成的工作与用户决定，不要重复已经执行的操作；结果尚未确认时先检查实际状态。', pendingRetry ? `Previous execution failed: ${pendingRetry.failure.reason}` : ''].filter(Boolean).join('\n\n')
          : job.prompt
        return lines ? `${lines}\n\n---\n\n${prompt}` : prompt
      }
      const planned = (resume: string | null | undefined, fork: boolean, said = '') => {
        let p = deps.plan(job.runtime, promptOf(said), cwd, resume, job.model, settingsOf(job), fork, cloudLanguage(job))
        p.renderer?.setRequiredImages?.(attachments.files)
        // A task's chat changes its card with the akb the Runner carries, on the task's board.
        if (ws) p = { ...p, env: akbEnv(deps.akb, ws.board, ws.cloudTask ?? undefined, cloudLanguage(job), p.env) }
        if (ws) p = { ...p, env: { ...p.env, AI4KANBAN_EXECUTION: JSON.stringify({ job: job.id, machine: deps.machineId }) } }
        if (scope.bridge) p = { ...p, env: { ...p.env, AI4KANBAN_REPLY_APPROVAL: scope.bridge.env } }
        if (goalFile) p = { ...p, env: { ...akbEnv(deps.akb, discussed, undefined, cloudLanguage(job), p.env), KANBAN_GOALS: goalFile, KANBAN_IDEAS: goalFile } }
        p = { ...p, env: { ...p.env, AI4KANBAN_EXECUTION: JSON.stringify({ job: job.id, machine: deps.machineId }), AI4KANBAN_TASK: job.task ?? '' } }
        return p
      }
      // A discussion task's session (#2146), else a new one reading the discussion.
      const carried = !!job.resume && (!job.fork || forks(job.runtime))
      run = carried ? planned(job.resume, !!job.fork) : planned(null, false, transcript)
      if (!carried) job = { ...job, resume: null, fork: false }
    }
  } catch (e) {
    await waitingStream?.end()
    return finishClaimed('failed', e instanceof Error ? e.message : String(e))
  }

  const authorized = await authorize()
  if (!authorized.ok || !authorized.value) return unauthorized(authorized)
  if (!held(deps, lease)) return
  if (reply) {
    for (let check = 0; ; check++) {
      let requestedAt = leaseNow()
      const renewed = await sync('prepare', () => {
        requestedAt = leaseNow()
        return deps.api.renewJob(deps.machineId, id)
      })
      if (waitingStream?.asked() || renewed.ok && renewed.value.stop) {
        await waitingStream?.end()
        return finishClaimed('stopped', '', { stopped: true })
      }
      if (!renewed.ok || !renewed.value.renewed || !held(deps, lease)) return
      Object.assign(lease, requestedAt)
      if (!job.discussion || !renewed.value.catalog || renewed.value.catalog.version === job.discussion.catalog?.version && renewed.value.catalog.account === job.discussion.catalog.account) break
      if (check >= 2) return finishClaimed('failed', 'The studio catalog keeps changing. Try again.')
      job.discussion.catalog = renewed.value.catalog
      const wrote = await writeGoals({ ...job, discussion: job.discussion }, deps.api.listStudios, true)
      if ('error' in wrote) return finishClaimed('failed', wrote.error)
      goalFile = wrote.file
      const authorized = await authorize()
      if (!authorized.ok || !authorized.value) return unauthorized(authorized)
    }
  }
  if (waitingStream?.lost()) return
  if (waitingStream?.asked()) return finishClaimed('stopped', '', { stopped: true })
  const stream = watching()
  if (pendingRetry) stream.event({ kind: 'log', data: { text: '[chat-recovery] running' } })
  if (run?.startNote) stream.out(`${run.startNote}\n`)
  let attempt: NonNullable<Checkpoint['attempts']>[number] | undefined
  const beginAttempt = () => {
    if (!reply) return
    attempt = { resume: job.resume }
    checkpoint.attempts ??= []
    checkpoint.attempts.push(attempt)
    persist()
  }
  const measure = (said: JobReport): JobReport => {
    if (!attempt || stream.lost()) return said
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
  const remember = (event: RunEvent) => {
    idleWatch?.event(event)
    if (stream.lost()) return
    const at = new Date().toISOString()
    event = Object.assign({}, event, { data: { ...event.data, eventAt: at, ...(reply ? { attempt: replyAttempt } : {}) } })
    evidence.observe(event, at)
    subagents.event(event)
    checkpointEvent(checkpoint, event)
    if (reply && event.kind === 'message' && event.data.text.trim()) {
      messages.push(event.data.text)
      checkpoint.partialReply = messages.join('\n\n')
    }
    const session = run?.session()
    if (session && (!job.fork || session !== forkSource)) checkpoint.session = session
    if (attempt && !run?.converse) measure(report(job, run!))
    persist()
    stream.event(event)
  }
  const retry = async (failure: ExecutionFailure | undefined): Promise<boolean> => {
    if (!reply || !failure || stream.asked() || stream.lost()) return false
    checkpoint.failure = failure
    const decision = planRetry(failure, checkpoint.retry!.attempt, Date.now(), deps.replyBackoff)
    if ('pause' in decision) {
      checkpoint.retryPause = decision.pause
      persist()
      return false
    }
    checkpoint.approvalCancelled = true
    persist()
    if (job.chat && checkpoint.approvalRequested) await api.cancelReplyApproval(deps.machineId, id)
    if (!await stopReply(id, deps.stopMs) || !await stream.confirmed() || !canRetryReply(checkpoint, failure, job.runtime)) {
      checkpoint.retryPause = 'unsafe'
      persist()
      return false
    }
    if (stream.asked() || stream.lost()) return false
    checkpoint.retry!.pending = decision.plan
    persist()
    evidence.cancel()
    scope.bridge?.close()
    await runClaimed({ ...job, manualRecovery: false }, deps, track, keep, lease, stream)
    await stream.end()
    return true
  }
  const complete = (outcome: 'done' | 'failed', report: JobReport, reason?: string) => {
    if (stream.lost()) return
    checkpoint.completed = { outcome, report, reason }
    checkpoint.session = report.session ?? checkpoint.session
    persist()
  }
  let savedGoals: JobReport['goals']
  const told = (report: JobReport): JobReport => {
    if (goalFile) savedGoals ??= readGoals(goalFile)
    const ran = subagents.summary()
    const said = { ...report, ...(ran ? { subagents: ran } : {}), ...(checkpoint.approvalRequested && checkpoint.approvalCancelled ? { replyApprovalSynced: false } : {}) }
    return savedGoals ? { ...said, ...(job.discussion?.goals !== undefined ? { goals: savedGoals } : { ideas: savedGoals }) } : said
  }
  track(stream.stop)

  const io = { show: stream.out, event: remember, track: stream.adopt, onStop: stream.onStop, lost: stream.lost, asked: stream.asked, sync }
  if (job.review) {
    checkpoint.started = true
    persist()
    // What is reviewed is what was said by now; a later message waits for the next review.
    for (const task of job.review.tasks) {
      const chat = await deps.api.readChat(task)
      if (!chat.ok && chat.code !== 'not_found') {
        await stream.end()
        return finishClaimed('failed', 'The complete conversation could not be read; memory review will retry.')
      }
      if (chat.ok) keepCloudChat(task, chat.value.messages)
      if (!await keepDecisions(task, deps.api.readDecisions)) {
        await stream.end()
        return finishClaimed('failed', 'Review decisions could not be read; memory review will retry.')
      }
    }
    const listed = await deps.api.listChats(deps.machineId)
    if (!listed.ok) {
      await stream.end()
      return finishClaimed('failed', listed.error)
    }
    // A task Cloud no longer lists has moved on since the review was asked for.
    const tasks = listed.value.chats.filter((c) => job.review!.tasks.includes(c.task))
    const marks = reviewMarks(tasks)
    const refs = tasks.map((c) => `${c.task}:${c.number}`)
    const ended = refs.length ? await runReview(job, ws!, refs, deps, io) : { ok: true as const, report: {} }
    if (ended.ok) complete('done', ended.report)
    if (!ended.ok) {
      await stream.end()
      if (!stream.lost()) return finishClaimed(stream.asked() ? 'stopped' : 'failed', ended.reason)
      return
    }
    return !stream.lost() ? sendResult(ended.report, () => markReviewed(marks)) : undefined
  }
  if (!run) {
    checkpoint.started = true
    persist()
    const ended = await runFlow(job as Job & { flow: Flow }, ws!, deps, io)
    if (ended.ok) complete('done', ended.report)
    // Stopped by the user (#2128), or its delivery cancelled (#59): kept here for a resume.
    const stopped = !ended.ok && (stream.asked() || ended.stopped === true)
    if (stopped && stream.asked()) await stream.halted()
    if (!ended.ok) await stream.end()
    if (stream.lost()) return
    const boardStopped = await confirmFlowStopped(ws!, job, deps)
    const evidence = job.handoff?.action === 'continue' || job.handoff?.action === 'restart' ? progressEvidence(job, ws!.cwd) : null
    const proof = boardStopped && await stream.confirmed() ? { processesStopped: true, ...(evidence ? { evidence } : {}) } : {}
    if (ended.ok) complete('done', { ...ended.report, ...proof })
    if (stopped) return finishClaimed('stopped', '', proof)
    if (!ended.ok) return finishClaimed('failed', ended.reason, proof)
    return sendResult({ ...ended.report, ...proof }, () => keepChat(job, ended.report.reply))
  }

  const launchAttempt = (plan: Plan) => {
    checkpoint.managedProcess = plan.managedProcess
    checkpoint.mark = stopMark()
    checkpoint.started = true
    checkpoint.opaque = !plan.converse && !plan.renderer?.events
    const session = plan.session()
    checkpoint.session = job.fork && session === forkSource ? undefined : session ?? (replay && !forkSource ? undefined : checkpoint.session)
    checkpoint.launching = true
    delete checkpoint.process
    delete checkpoint.cleanup
    persist()
    const child = launch(plan.command, plan.args, { cwd, env: markEnv(plan.env, checkpoint.mark), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    if (child.pid) {
      checkpoint.process = { pid: child.pid, since: Date.now(), ...(plan.managedProcess ? { identity: connectionIdentity(child.pid) } : {}) }
      if (pendingRetry) checkpoint.retry!.attempt++
    }
    if (checkpoint.retry) delete checkpoint.retry.pending
    delete checkpoint.launching
    delete checkpoint.failure
    delete checkpoint.retryPause
    beginAttempt()
    persist()
    return child
  }
  if (run.converse) {
    const plan = run
    const converse = run.converse
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
      if (plan.idleRecovery) {
        uncertainAtIdle = checkpoint.pending.length > 0
        checkpoint.failure = IDLE_FAILURE
        checkpoint.cleanup = { status: 'unconfirmed', execution: id, kept: [] }
        persist()
        idle.abort()
        return
      }
      timedOut({ ok: false, error: IDLE_FAILURE.reason, failure: IDLE_FAILURE,
        ...(plan.managedProcess ? { cleanup: { status: 'unconfirmed', execution: id, kept: [] } } : {}) })
      cancellation.abort()
      stop(child, plan.managedProcess)
    }, () => !!plan.background?.())
    const end = await Promise.race([
      timeout,
      converse(child, remember, false, Date.now() + CONVERSATION_MS.prepare, cancellation.signal, () => idleWatch?.touch(), idle.signal),
      spawned.then((failure): TurnEnd => ({ ok: false, error: failure.reason, failure })),
      // Killed, the turn ends with what it said so far; one that never does is not waited on.
      stream.whenAsked.then(() => wait(KILL_GRACE_MS * 2)).then((): TurnEnd => ({ ok: true })),
    ])
    idleWatch.close()
    if (idle.signal.aborted) {
      if (!uncertainAtIdle && !checkpoint.pending.length && idleStopConfirmed(end.cleanup, checkpoint.session)) checkpoint.cleanup = end.cleanup
      else checkpoint.cleanup = { ...end.cleanup, status: 'unconfirmed', execution: end.cleanup?.execution ?? id, kept: end.cleanup?.kept ?? [] }
    } else checkpoint.cleanup = end.cleanup
    persist()
    let measured = measure(report(job, plan, end))
    if (reply && end.replyParts) {
      const parts = await saveReplyImages(end.replyParts, cwd, async (key, bytes, mime) => {
        if (stream.asked() || stream.lost() || !end.ok) return { status: 'not_saved' as const }
        const result = await api.uploadReplyImage(deps.machineId, id, key, bytes, mime)
        if (!result.ok) throw Error('image_upload_failed')
        return stream.asked() || stream.lost() ? { status: 'not_saved' as const } : result.value
      })
      if (parts) measured = { ...measured, parts, reply: parts.filter(p => p.type === 'text').map(p => p.text).join('') }
    }
    const rawFailure = idle.signal.aborted ? IDLE_FAILURE : end.ok ? undefined : end.failure ?? { code: 'execution_failed', level: 3 as const, reason: end.error ?? 'The agent did not complete the reply.' }
    if (rawFailure?.code === 'session_not_found') checkpoint.session = undefined
    measured = retainReply(measured, !end.ok)
    if (await retry(rawFailure)) return
    await evidence.drain(deps.endMs)
    const stopped = await stopReply(id, deps.stopMs)

    stop(child, plan.managedProcess)
    if (stream.asked() && (!stopped || !await stream.confirmed())) { await stream.end(); return }
    const ok = end.ok || stream.asked()
    const unsafe = reply && !ok && (!stopped || !replayable(checkpoint) && !resumable(checkpoint))
    const said = {
      ...told(stream.asked() ? cutShort(measured, stream.said()) : measured),
      ...(reply ? { recovery: { safe: replayable(checkpoint), stopped, resumable: resumable(checkpoint) } } : {}),
    }
    const failure = replyReason(rawFailure, checkpoint.retryPause, job, unsafe)
    if (!stream.asked()) complete(ok ? 'done' : 'failed', said, failure)
    if (!ok && rawFailure && unsafe) stream.event({ kind: 'error', data: { text: rawFailure.reason } })
    if (!ok || !ws || stream.asked()) {
      await stream.end()
      if (stream.lost()) return
      if (stream.asked() && ws && !reply) return finishClaimed('stopped', '', said)
      return finishClaimed(ok ? 'done' : 'failed', ok ? '' : failure, said)
    }
    if (!stream.lost()) return sendResult(said, () => keepChat(job, said.reply))
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
    idleWatch = createIdleWatchdog(() => {
      backgroundFailure = IDLE_FAILURE
      stop(child, plan.managedProcess)
    }, () => !!renderer.background?.())
    let activityVersion = 0
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
    child.stdout.on('data', (chunk: string) => {
      fromAgent(renderer.push(chunk))
      if (renderer.terminalFailure?.()) {
        idleWatch?.close()
        stop(child, plan.managedProcess)
      }
      // A runtime reading turns from stdin keeps going until stdin closes.
      if (plan.stdin && streamFinished(renderer) && !child.stdin.writableEnded) { idleWatch?.close(); child.stdin.end() }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      renderer.stderr?.(chunk)
      stream.out(quietLines(plan, chunk))
    })
    const ended = await new Promise<{ code: number | null; failure?: ExecutionFailure }>((resolve) => {
      child.on('error', (e) => resolve({ code: null, failure: executionFailure(e) }))
      child.on('close', (code) => resolve({ code }))
    })
    idleWatch?.close()
    fromAgent(renderer.flush())
    const pending = renderer.background?.() ? { code: 'background_unfinished', level: 3 as const, reason: 'The agent exited with unfinished background tasks.' } : undefined
    return { ...ended, failure: ended.failure ?? backgroundFailure ?? pending }
  }
  const plan = run
  const ended = await printed(plan)
  let measured = measure(report(job, plan))
  const renderer = plan.renderer!
  if (reply && job.runtime === 'codex') {
    const parts = await saveReplyImages(renderer.replyParts?.() ?? [{ type: 'text', text: measured.reply ?? '' }], cwd,
      async (key, bytes, mime) => {
        if (stream.asked() || stream.lost() || ended.code !== 0) return { status: 'not_saved' as const }
        const result = await api.uploadReplyImage(deps.machineId, id, key, bytes, mime)
        if (!result.ok) throw Error('image_upload_failed')
        return stream.asked() || stream.lost() ? { status: 'not_saved' as const } : result.value
      })
    if (parts) measured = { ...measured, parts, reply: parts.filter(p => p.type === 'text').map(p => p.text).join('') }
  }
  const diagnostic = renderer.failure?.() ?? (ended.code === 0 ? undefined : `Exited with code ${ended.code}.`)
  const rawFailure = ended.failure ?? renderer.executionFailure?.()
    ?? (diagnostic ? { code: 'execution_failed', level: 3 as const, reason: diagnostic } : undefined)
  measured = retainReply(measured, !!rawFailure)
  if (rawFailure?.code === 'session_not_found' || rawFailure?.code === 'session_mismatch') checkpoint.session = undefined
  if (await retry(rawFailure)) return
  const stopped = await stopReply(id, deps.stopMs)
  if (stream.asked() && (!stopped || !await stream.confirmed())) { await stream.end(); return }
  const unsafe = reply && !!rawFailure && (!stopped || !replayable(checkpoint) && !resumable(checkpoint))
  const failure = stream.asked() ? undefined : replyReason(rawFailure, checkpoint.retryPause, job, unsafe)
  if (rawFailure && unsafe) stream.event({ kind: 'error', data: { text: rawFailure.reason } })
  const said = {
    ...told(stream.asked() ? cutShort(measured, stream.said()) : measured),
    ...(reply ? { recovery: { safe: replayable(checkpoint), stopped, resumable: resumable(checkpoint) } } : {}),
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
async function runAgentJob(job: Job & { agent: AgentJob }, ws: TaskFolder, deps: StepDeps, stream: ReturnType<typeof streamOut>, sync: Sync, lease: Lease,
  checkpoint: Checkpoint, persist: () => void, sendResult: (report: JobReport) => Promise<void>): Promise<void> {
  if (stream.lost()) return
  if (checkpoint.completed) return sendResult(checkpoint.completed.report)
  checkpoint.started = true
  persist()
  const ended = await runAgent(job, ws, deps, { show: stream.out, event: (event) => {
    if (stream.lost()) return
    checkpointEvent(checkpoint, event)
    persist()
    stream.event(event)
  }, track: stream.adopt, onStop: stream.onStop, lost: stream.lost, asked: stream.asked, sync })
  if (ended.ok && !stream.lost()) {
    checkpoint.completed = { outcome: 'done', report: ended.report }
    checkpoint.reviewedRejections = ended.reviewed
    persist()
  }
  if (ended.ok && !stream.asked() && !stream.lost()) return sendResult(ended.report)
  await stream.end()
  if (stream.lost()) return
  if (stream.asked()) return finish(deps, job.id, lease, 'stopped')
  if (!ended.ok) return finish(deps, job.id, lease, 'failed', ended.reason)
}

const quietLines = (plan: Plan, chunk: string) =>
  chunk.split('\n').filter((line) => line && !plan.quiet(line)).map((line) => `${line}\n`).join('')

function canRetryReply(checkpoint: Checkpoint, failure: ExecutionFailure, runtime: string): boolean {
  if (checkpoint.cleanup?.status === 'unconfirmed') return false
  if (checkpoint.managedProcess && failure.code === 'idle_timeout') {
    return resumable(checkpoint) && idleStopConfirmed(checkpoint.cleanup, checkpoint.session)
  }
  if (resumable(checkpoint)) return true
  return failure.level === 2 && runtime !== 'antigravity' && replayable(checkpoint)
}

function replyReason(failure: ExecutionFailure | undefined, pause: RetryPause | undefined, job: Job, unsafe: boolean): string | undefined {
  if (!failure) return
  if (failure.source === 'invariant') return failure.reason
  if (unsafe || pause === 'unsafe') return 'recovery_unsafe'
  if (failure.code === 'session_not_found' && job.sessionFallback) return 'session_unavailable'
  return pause ? `${failure.reason}\n${pauseLine(pause, cloudLanguage(job) === 'zh')}` : failure.reason
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

/** Cloud unreached, try again while the lease holds, renewing it once Cloud answers. Past the
 *  lease Cloud refuses the result and runs the task's step again; this one is dropped. */
async function whileOffline<T extends object>(deps: Shared, id: string, lease: Lease, attempt: () => Promise<T>): Promise<T | null> {
  while (held(deps, lease)) {
    const out = await attempt()
    if (!('offline' in out && out.offline) || !held(deps, lease)) return out
    await wait(deps.retryMs)
    if (!held(deps, lease)) return null
    const requestedAt = leaseNow()
    const renewed = await deps.api.renewJob(deps.machineId, id)
    if (!held(deps, lease)) return null
    if (renewed.ok && renewed.value.renewed) Object.assign(lease, requestedAt)
    if (renewed.ok && !renewed.value.renewed) return out
  }
  return null
}

type Outcome = 'done' | 'failed' | 'conflict' | 'stopped'

/** Whether Cloud took the ending. */
async function ended(deps: Shared, id: string, lease: Lease, outcome: Outcome, reason = '', report?: JobReport): Promise<boolean> {
  const sent = await whileOffline(deps, id, lease, async () => {
    const done = await deps.api.finishJob(deps.machineId, id, outcome, reason, report)
    return { offline: !done.ok && retryableSync(done), finished: done.ok && done.value.finished }
  })
  if (sent?.finished && (outcome !== 'failed' || !report?.recovery)) clearCheckpoint(id)
  return sent?.finished ?? false
}

async function finish(deps: Shared, id: string, lease: Lease, outcome: Outcome, reason = '', report?: JobReport): Promise<void> {
  await ended(deps, id, lease, outcome, reason, report)
}

/** What the job changed goes back, then how it ended; `landed` once both were taken. */
async function sendBack(job: Job, deps: StepDeps, lease: Lease, ws: TaskFolder, report: JobReport, sync: Sync, stream: ReturnType<typeof streamOut>,
  landed: () => void, repair: (problem: Extract<Pushed, { ok: false }>) => Promise<void>, confirm: () => Promise<api.Call<unknown>>): Promise<void> {
  const result = await sync('publish', async () => {
    const pushed = await push(ws, { id: job.id, machineId: deps.machineId }, () => stream.asked() || stream.lost())
    return !pushed.ok && pushed.offline ? { ok: false, error: pushed.error } : { ok: true, value: pushed }
  })
  const pushed = result.ok ? result.value : result
  const confirmed = pushed.ok ? await sync('confirm', confirm) : undefined
  const repairable = !pushed.ok && 'conflict' in pushed && (pushed.conflict || pushed.failure?.level === 1) ? pushed : null
  const denied = confirmed && !confirmed.ok ? confirmed : !pushed.ok && !repairable ? pushed : null
  if (denied && !stream.lost() && !stream.asked()) stream.event({ kind: 'error', data: { text: syncRefusal(job, denied) } })
  await stream.end()
  if (stream.lost()) return
  if (stream.asked()) return finish(deps, job.id, lease, 'stopped', '', report)
  if (repairable) return repair(repairable)
  if (denied) {
    console.error('runner: task sync refused', { job: job.id, code: denied.code, error: denied.error })
    return finish(deps, job.id, lease, 'failed', syncRefusal(job, denied), report)
  }
  if (await ended(deps, job.id, lease, 'done', '', { ...report, ...(readCheckpoint(job.id)?.approvalRequested ? { replyApprovalSynced: report.replyApprovalSynced !== false && replyAssetsSynced(ws) } : {}) })) landed()
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
    if (!await ended(deps, job.id, lease, outcome, reason, ms === undefined ? undefined : { ms })) {
      console.error(`runner: connection test ${job.id}: Cloud did not accept the result.`)
    }
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

/** Where the task's card, studio and memory are, for the agent. */
function folderLines(ws: TaskFolder | null): string {
  if (!ws) return ''
  const undrawn = undrawnPreviews(ws)
  return `\n\nTask card: ${cardFile(ws)}` + (undrawn.length ? `\nPreviews that cannot be drawn:\n${undrawn.map(l => `- ${l}`).join('\n')}` : '')
}
