import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readSession } from '../../cli/src/lib/cloud/session'
import { invalidResponse } from '../../cli/src/lib/cloud/response'
import { killMarked, processesStopped } from '../../cli/src/lib/agent/stop'
import { pidAlive, tryLock } from '../../cli/src/lib/lock'
import * as api from './api'
import { hold } from './cache'
import { runnerCwd, runnerHome } from './home'
import { flowRunEvidence, stopFlowRuns } from './flow'
import { clearCheckpoint, readCheckpoint, recoverInterruptedJob, recoveryBlocked, saveCheckpoint } from './recovery'
import { openTaskFolder } from './task-folder'
import { defaultDeps, folderFor, runJob, type Deps } from './jobs'
import { accountGeneration, executorRecord } from './settings-control'
import { VERSION } from './protocol'
import { logRunner, startRunnerLogMaintenance } from './runner-log'

interface Worker {
  id: string
  token: string
  machine: string
  account: string
  generation: string
  at: number
  pid?: number
  ended?: boolean
  markedAt?: number
  processAt?: number
  claimAttempt?: number
  claimPending?: boolean
  claimFailure?: string
  claimRetryAt?: number
}

interface ClaimRetry { at: number; attempt: number; failure: string }
const CLAIM_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
const FLOW_MARK = 'WILDCRANE_FLOW_WORKER'
const directory = () => path.join(runnerHome(), 'flow-workers')
const fileOf = (id: string) => path.join(directory(), `${encodeURIComponent(id)}.json`)
const stopFile = (id: string) => `${fileOf(id)}.stop`
const freshFlow = (job: api.Job) => !job.flow?.sync_recovery_of && !job.syncRecoveryOf && !job.recoveryOf && !job.manualRecovery
export const flowWorkerEntry = fileURLToPath(new URL('./flow-worker-main.mjs', import.meta.url))
export const canKeepFlow = (job: api.Job): boolean => !!job.task && !!job.flow
  && ['create', 'refine', 'implement', 'preview'].includes(job.flow.verb)
  && !job.agent && !job.review && !job.discussion && !job.test && !job.secret

function read(id: string): Worker | null {
  try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')) as Worker } catch { return null }
}

function save(worker: Worker): void {
  const file = fileOf(worker.id)
  fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(worker), { mode: 0o600 })
  fs.renameSync(`${file}.${process.pid}.tmp`, file)
}

export function hasFlowWorker(id: string): boolean {
  return fs.existsSync(fileOf(id))
}

/** A launch is recorded before spawning; an uncertain launch is never replayed. */
export function launchFlowWorker(id: string, machine: string, entry = flowWorkerEntry, claimAttempt = 1): void {
  fs.mkdirSync(directory(), { recursive: true, mode: 0o700 })
  const account = readSession()?.subject
  if (!account) throw new Error('账号已退出，请重新登录。')
  const worker: Worker = { id, token: crypto.randomUUID(), machine, account, generation: accountGeneration(), at: Date.now(), markedAt: Date.now(), claimAttempt }
  fs.writeFileSync(fileOf(id), JSON.stringify(worker), { flag: 'wx', mode: 0o600 })
  const log = fs.openSync(`${fileOf(id)}.log`, 'a', 0o600)
  try {
    const child = spawn(process.execPath, [entry, id, worker.token], {
      cwd: runnerCwd(), env: { ...process.env, [FLOW_MARK]: worker.token }, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    })
    child.on('error', () => {})
    child.once('exit', () => { void reclaimFlowWorkers(machine, undefined, id) })
    child.unref()
  } finally { fs.closeSync(log) }
}

export async function watchFlowWorker(id: string, machine: string, detached: () => boolean): Promise<void> {
  while (!detached()) {
    const worker = read(id)
    if (!worker) {
      const remote = await api.readJob(id)
      if (remote.ok && remote.value.job.id === id && remote.value.job.state === 'finished') return
      throw new Error('无法确认原执行的状态，未重新启动。')
    }
    if (worker.machine !== machine || worker.account !== readSession()?.subject
        || worker.generation !== accountGeneration()) throw new Error('无法确认原执行的归属，未重新启动。')
    if (worker.ended) return
    if (!worker.pid && Date.now() - worker.at > 10_000) {
      const remote = await api.readJob(id)
      if (remote.ok && remote.value.job.id === id && remote.value.job.state === 'waiting' && !detached()) {
        const claim = await api.claimJob(machine, id)
        if (claim.ok && claim.value.claimed && !detached()) {
          await api.finishJob(machine, id, 'failed', recoveryBlocked(remote.value.job))
        } else if (!claim.ok) {
          console.warn('runner: could not claim job with an unverified worker', { job: id, reason: claim.error, code: claim.code })
        }
      }
      return
    }
    if (worker.pid && (!pidAlive(worker.pid) || Date.now() - worker.at > 30_000)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export async function stopFlowWorker(id: string, ms: number): Promise<void> {
  const until = Date.now() + ms
  for (;;) {
    const release = tryLock(`${fileOf(id)}.lock`)
    if (release) {
      try {
        const worker = read(id)
        if (!worker || worker.ended) return
        fs.writeFileSync(stopFile(id), worker.token, { mode: 0o600 })
      } finally { release() }
      break
    }
    if (Date.now() >= until) throw new Error('未能确认原执行已停止。')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  while (Date.now() < until) {
    const now = read(id)
    if (!now) {
      const remote = await api.readJob(id)
      if (remote.ok && remote.value.job.id === id && remote.value.job.state === 'finished') return
      throw new Error('未能确认原执行已停止。')
    }
    if (now.ended || now.pid && !pidAlive(now.pid)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('未能确认原执行已停止。')
}

/** No pid, a live writer, or an unreadable process listing is never an exit proof. */
function writerStopped(worker: Worker): boolean {
  if (!Number.isSafeInteger(worker.pid) || worker.pid! <= 0 || pidAlive(worker.pid)) return false
  if (process.platform !== 'win32') {
    try { process.kill(-worker.pid!, 0); return false } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return false
    }
  }
  if (!worker.markedAt) return process.platform !== 'win32' && processesStopped({
    name: 'AI4KANBAN_EXECUTION', value: JSON.stringify({ job: worker.id, machine: worker.machine }),
  })
  if (!Number.isFinite(worker.markedAt) || !Number.isFinite(worker.processAt)) return false
  return processesStopped({ name: FLOW_MARK, value: worker.token, since: worker.markedAt },
    { pid: worker.pid!, since: worker.processAt! })
}

/** The saved work may be reclaimed only after its previous writer is gone. */
export function retireSyncWorker(id: string, machine: string): boolean {
  const file = fileOf(id)
  if (!fs.existsSync(file)) return true
  const release = tryLock(`${file}.lock`)
  if (!release) return false
  try {
    const worker = read(id)
    if (!worker || worker.machine !== machine || worker.account !== readSession()?.subject
        || worker.generation !== accountGeneration() || !writerStopped(worker)) return false
    fs.rmSync(file, { force: true })
    fs.rmSync(stopFile(id), { force: true })
    fs.rmSync(`${file}.log`, { force: true })
    return true
  } finally { release() }
}

/** Reattached workers can outlive their ended record while their sockets close. */
export async function reclaimFlowWorkerAfterExit(id: string, machine: string, given?: Deps, token?: string): Promise<void> {
  const worker = read(id)
  if (!worker?.pid || token && worker.token !== token) return
  const account = readSession()?.subject
  const generation = accountGeneration()
  const until = Date.now() + 30_000
  let stoppedChildren = false
  while (!writerStopped(worker)) {
    if (Date.now() >= until || read(id)?.token !== worker.token
        || readSession()?.subject !== account || accountGeneration() !== generation) return
    if (!stoppedChildren && worker.generation === generation && worker.markedAt && !pidAlive(worker.pid)) {
      killMarked({ name: FLOW_MARK, value: worker.token, since: worker.markedAt })
      stoppedChildren = true
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250)
      if (!token) timer.unref()
    })
  }
  if (read(id)?.token === worker.token && readSession()?.subject === account && accountGeneration() === generation) {
    await reclaimFlowWorkers(machine, given, id)
  }
}

let reclaiming: Promise<ClaimRetry | undefined> | undefined
/** Serialize local candidates; a failed item keeps its record for the next sweep. */
export async function reclaimFlowWorkers(machine: string, given?: Deps, only?: string, retryWaiting = false): Promise<ClaimRetry | undefined> {
  if (reclaiming) {
    await reclaiming
    if (only) return reclaimFlowWorkers(machine, given, only, retryWaiting)
    return
  }
  const account = readSession()?.subject
  const generation = accountGeneration()
  const valid = () => !!account && readSession()?.subject === account && accountGeneration() === generation
  const sweep = async () => {
    let names: string[]
    try { names = only ? [`${encodeURIComponent(only)}.json`] : fs.readdirSync(directory()) } catch { return }
    for (const name of names) {
      if (!valid()) break
      if (!name.endsWith('.json')) continue
      try {
        const file = path.join(directory(), name)
        const original = fs.readFileSync(file, 'utf8')
        const worker = JSON.parse(original) as Worker
        if (!worker || typeof worker.id !== 'string' || name !== `${encodeURIComponent(worker.id)}.json`
            || typeof worker.token !== 'string' || !worker.token || worker.machine !== machine
            || worker.account !== account || typeof worker.generation !== 'string'
            || !Number.isFinite(worker.at)
            || worker.claimAttempt !== undefined && (!Number.isSafeInteger(worker.claimAttempt) || worker.claimAttempt < 1)
            || worker.claimRetryAt !== undefined && !Number.isFinite(worker.claimRetryAt)) continue
        if (!writerStopped(worker)) {
          if (!only) void reclaimFlowWorkerAfterExit(worker.id, machine, given)
          continue
        }
        const release = tryLock(`${file}.lock`)
        if (!release) continue
        try {
          if (fs.readFileSync(file, 'utf8') !== original) continue
          const queried = tryLock(path.join(directory(), '.lookup.lock'))
          if (!queried) continue
          const remote = await api.readJob(worker.id).finally(queried)
          if (!valid()) break
          if (!remote.ok || remote.value.job.id !== worker.id || !canKeepFlow(remote.value.job)) continue
          const job = remote.value.job
          let checkpoint = job.state === 'finished' ? null : readCheckpoint(worker.id)
          const updating = checkpoint?.updating && !checkpoint.pending.includes('unknown')
          const failedClaim = worker.ended && worker.claimFailure || (worker.claimPending || worker.ended && worker.claimAttempt === undefined)
            && !checkpoint && 'Previous claim result was not recorded.'
          const attempt = worker.claimAttempt ?? 1
          const retry = worker.generation === generation && job.state === 'waiting' && (!checkpoint || updating) && failedClaim ? {
            attempt,
            at: worker.claimRetryAt ?? Date.now() + CLAIM_BACKOFF_MS[Math.min(attempt - 1, CLAIM_BACKOFF_MS.length - 1)]!,
            failure: failedClaim,
          } : undefined
          if (worker.generation === generation && (job.state === 'claimed' || job.state === 'interrupted')) {
            const runner = await api.readRunner()
            if (!runner.ok || runner.value.runner?.machineId && runner.value.runner.machineId !== machine || !valid()) continue
            const deps = given ?? defaultDeps(machine)
            const folder = job.projectDir ? folderFor(job) : null
            if (folder && 'refused' in folder) continue
            const ws = openTaskFolder(job, folder?.cwd ?? null)
            const flowDeps = { ...deps, machineId: machine, akb: deps.akb() }
            let stopped = await stopFlowRuns(ws, job, flowDeps)
            if (stopped && checkpoint?.started !== false && !checkpoint?.completed) {
              const evidence = await flowRunEvidence(ws, job, flowDeps, job.id, checkpoint?.flowRun)
              if (checkpoint) checkpoint.flowRun = evidence.run
              else if (evidence.run) checkpoint = { pending: [], started: true, flowRun: evidence.run }
              stopped = evidence.stopped
            }
            if (!valid() || !writerStopped(worker) || worker.claimFailure && !stopped || fs.readFileSync(file, 'utf8') !== original) continue
            const beforeExecution = freshFlow(job) && (worker.claimPending === true || worker.claimFailure && worker.ended)
              ? { pending: [], started: false } : null
            if (beforeExecution) console.info('runner: recovering before job execution', { job: worker.id, attempt, reason: worker.claimFailure })
            const recovered = await recoverInterruptedJob(machine, job, checkpoint ?? beforeExecution, stopped, valid)
            if (!recovered?.resumed && !recovered?.finished) continue
          } else if (job.state !== 'finished' && !retry && !(job.state === 'waiting' && updating)) continue
          // Legacy workers have no inherited mark: also verify their board runs and checkpoint.
          if (!worker.markedAt) {
            const job = remote.value.job
            const folder = job.projectDir ? folderFor(job) : { cwd: path.join(runnerHome(), 'work', job.id) }
            if ('refused' in folder || !job.task || !job.project) continue
            const board = path.join(folder.cwd, '.akb', 'kanban')
            if (!fs.existsSync(board)) continue
            const deps = given ?? defaultDeps(machine)
            if (!(await flowRunEvidence({ task: job.task, cloudTask: job.task, project: job.project,
              cwd: folder.cwd, board, number: job.number ?? null, studio: job.studio ?? job.flow?.studio ?? null },
            job, { ...deps, machineId: machine, akb: deps.akb() })).stopped) continue
            const saved = readCheckpoint(worker.id)
            if (saved && (!saved.mark || !processesStopped(saved.mark, saved.process))) continue
          }
          if (!writerStopped(worker) || !valid() || fs.readFileSync(file, 'utf8') !== original) continue
          if (retry && (worker.claimRetryAt === undefined || !retryWaiting || retry.at > Date.now())) {
            if (worker.claimRetryAt === undefined) {
              await api.renewJob(machine, worker.id, { taskRecovery: { code: 'claim', attempt: retry.attempt } })
              if (!valid() || fs.readFileSync(file, 'utf8') !== original) continue
              save({ ...worker, claimRetryAt: retry.at })
            }
            if (retryWaiting) return retry
            continue
          }
          fs.rmSync(`${file}.log`, { force: true })
          fs.rmSync(`${file}.stop`, { force: true })
          fs.unlinkSync(file)
          if (job.state === 'finished' && job.outcome === 'done') clearCheckpoint(job.id)
          if (retry) return retry
        } finally { release() }
      } catch { /* Preserve the record for the next sweep. */ }
    }
  }
  reclaiming = sweep().finally(() => { reclaiming = undefined })
  return reclaiming
}

/** Own the whole job, including stage transitions and result upload, across Runner restarts. */
export async function runFlowWorker(id: string, token: string, given?: Deps, entry = flowWorkerEntry): Promise<void> {
  const worker = read(id)
  if (!worker || worker.token !== token || worker.pid || worker.ended) return
  const fields = { version: VERSION, source: process.env.WILDCRANE_RUNNER_KIND, job: id }
  startRunnerLogMaintenance()
  logRunner('worker', 'starting', fields)
  process.once('exit', exitCode => logRunner('worker', 'exited', { ...fields, exitCode }))
  const valid = () => readSession()?.subject === worker.account && accountGeneration() === worker.generation
  let stopped = false
  let halt: (() => Promise<void>) | undefined
  const stop = async () => { stopped = true; await halt?.() }
  const release = executorRecord()
  const keepVersion = hold(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
  worker.pid = process.pid
  worker.processAt = Date.now()
  worker.claimPending = true
  save(worker)
  const timer = setInterval(() => {
    let asked = false
    try { asked = fs.readFileSync(stopFile(id), 'utf8') === token } catch {}
    if (!valid() || asked) void stop()
    if (Date.now() - worker.at >= 1000) { worker.at = Date.now(); save(worker) }
  }, 100)
  try {
    const base = given ?? defaultDeps(worker.machine)
    const deps: Deps = { ...base, api: { ...base.api, claimJob: async (...args) => {
      let claim = await base.api.claimJob(...args)
      if (claim.ok && claim.value?.claimed !== false && (claim.value?.claimed !== true || claim.value.job?.id !== id)) {
        const invalid = invalidResponse('a claim for this job')
        claim = { ok: false, code: invalid.code, error: invalid.message }
      }
      const failure = !claim.ok ? [claim.code, claim.status, claim.error].filter(Boolean).join(' ')
        : claim.value.claimed === false ? claim.value.reason || 'Cloud did not grant a lease.' : undefined
      if (failure) {
        worker.claimFailure = failure
        console.warn('runner: job claim failed', { job: id, attempt: worker.claimAttempt ?? 1, reason: failure })
      }
      if (claim.ok && claim.value.claimed) {
        if (freshFlow(claim.value.job) && !readCheckpoint(id)) saveCheckpoint(id, { pending: [], started: false })
        delete worker.claimPending
        save(worker)
      }
      return claim
    }, renewJob: async (...args) => {
      const runner = await api.readRunner()
      if (runner.ok && runner.value.runner?.machineId && runner.value.runner.machineId !== worker.machine) {
        return { ok: true, value: { renewed: false } }
      }
      return base.api.renewJob(...args)
    } }, authorize: async (job) => {
      if (!valid() || !canKeepFlow(job)) return false
      if (base.authorize) {
        const allowed = await base.authorize(job)
        if (typeof allowed !== 'boolean') {
          if (!allowed.ok || !allowed.value) return allowed
        } else if (!allowed) return false
      }
      if (!job.projectDir) return true
      const folders = await api.listFolders(worker.machine)
      if (!valid()) return false
      return folders.ok ? folders.value.folders.some(f => f.project === job.project && f.path === job.projectDir) : folders
    } }
    await runJob(id, deps, (stop) => { halt = stop; if (stopped || !valid()) void stop() }, () => stopped || !valid())
  } finally {
    clearInterval(timer)
    await stop()
    worker.ended = true
    save(worker)
    keepVersion()
    release()
    // The Runner may be offline; this one-shot follower waits for this process to exit.
    try {
      const follower = spawn(process.execPath, [entry, '--reclaim', id, token, worker.machine], {
        cwd: runnerCwd(), env: { ...process.env, [FLOW_MARK]: '' },
        detached: true, windowsHide: true, stdio: 'ignore',
      })
      follower.on('error', () => {})
      follower.unref()
    } catch { /* Startup and periodic sweeps remain the fallback. */ }
  }
}
