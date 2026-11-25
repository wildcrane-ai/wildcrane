import { clearStudioSnapshots } from './goals'
// Staying connected: register, keep a Realtime topic open for hints, re-register on a timer
// to stay the account's Runner, keep a presence connection so Cloud sees it go (#2163), and
// read the waiting jobs on every connect and hint. The chats it answered are reviewed for
// memory once a day (#2065), the projects' periodic agents are looked at on the hour (#291),
// the cache is cleaned at the start and once a day (#2147), and the boards kept here go back to
// Cloud as they change (#59) and come down as Cloud's change (#103).

import { connectCloudLive, type LiveConnection } from '../../cli/src/lib/cloud/live'
import { adoptLegacy } from './folders'
import fs from 'node:fs'
import path from 'node:path'
import { runnerHome } from './home'
import { accountGeneration, executorRecord } from './settings-control'
import { readSession } from '../../cli/src/lib/cloud/session'
import { askDueAgents, nextHour } from './agents'
import { followAkb, sweepAkb } from './akb-version'
import * as api from './api'
import { SWEEP_MS, removeLegacy, sweepCache, sweepStudios } from './cache'
import { pruneChats, reviewChats } from './chats'
import { watchBoards, type BoardWatch } from './board-watch'
import { answerHint } from './diff'
import { answerOf, runAkb } from './akb'
import { flowRunEvidence, stopLeftBehind } from './flow'
import { clearCheckpoint, readCheckpoint, recoverInterruptedJob, saveCheckpoint, stopReply, usesBoardRun } from './recovery'
import { status, t } from './i18n'
import { acquireMachine, RunnerAlreadyRunning, type Holder, type MachineLock } from './lock'
import { STOP_MS, defaultDeps, folderFor, runJob, type Deps } from './jobs'
import { keepPresence, type Presence } from './presence'
import { modelLists, refreshModels } from './runtimes'
import { MODEL_REFRESH_MS } from './model-list'
import { codexServer } from './codex-server'
import { akbCardOf, openAgentFolder, openTaskFolder } from './task-folder'
import { logSync } from './sync-debug'
import { canKeepFlow, reclaimFlowWorkerAfterExit, retireSyncWorker, reclaimFlowWorkers, flowWorkerEntry, hasFlowWorker, launchFlowWorker, stopFlowWorker, watchFlowWorker } from './flow-worker'

/** Re-register this often: it is what keeps the computer counted as connected, inside Cloud's
 *  15-minute lease. */
const HEARTBEAT_MS = 10 * 60_000
/** How often to read the jobs when no Realtime hint can arrive. */
const POLL_MS = 60_000
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** A look later than this has slept past its hour, and waits for the next. */
const LOOK_LATE_MS = 60_000

/** Why the Runner stopped for good. */
export type Stop = { reason: 'elsewhere'; machine: string } | { reason: 'outdated' } | { reason: 'already-running' } | { reason: 'refused'; message: string }

export interface Options {
  registration: () => Promise<api.Registration>
  deps?: Deps
  /** Override the detached job entry in integration tests. */
  flowWorkerEntry?: string
  heartbeatMs?: number
  pollMs?: number
  /** Called each time Cloud accepts the registration after it did not. */
  onConnected?: () => void
  onReconnecting?: () => void
  /** When the periodic agents are next looked at. */
  nextLook?: (now: number) => number
  kind: Holder
}

export interface Runner {
  /** Resolves if startup or registration is refused. */
  stopped: Promise<Stop>
  /** Keep detached planning/build jobs, stop other jobs, and close. */
  close(): Promise<void>
  /** 保留规划和构建的执行，其余作业保存进度后停机。 */
  update(): Promise<void>
  /** Register again now, to tell Cloud what changed. */
  renew(): void
}

export function startRunner(options: Options, lock?: MachineLock): Runner {
  const account = readSession()?.subject
  const generation = accountGeneration()
  let releaseRecord: (() => void) | undefined
  let releaseMachine: MachineLock | undefined
  let registration: api.Registration | null = null
  let connected = false
  let closed = false
  let ownsExecution = false
  let codex: Awaited<ReturnType<typeof codexServer>> | undefined
  let redetect = false
  let preparing = false
  let attempts = 0
  let live: LiveConnection | null = null
  let presence: Presence | null = null
  let boards: BoardWatch | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let claimRetry: ReturnType<typeof setTimeout> | undefined
  let claimAttempts = 0
  let flowClaimRetry: ReturnType<typeof setTimeout> | undefined
  let flowClaimRetryAt = Infinity
  let reading = false
  let readAgain = false
  let readDone = Promise.resolve()
  const jobs = new Set<Promise<void>>()
  const running = new Map<string, (() => Promise<void>) | null>()
  const attempted = new Set<string>()
  const workers = new Set<string>()
  const workerEntry = options.flowWorkerEntry ?? (options.deps ? undefined : flowWorkerEntry)
  let stop: (s: Stop) => void = () => {}
  const stopped = new Promise<Stop>((resolve) => (stop = resolve))

  const deps = (): Deps => {
    const base = options.deps ?? defaultDeps(registration!.machineId)
    return { ...base, ...(options.deps ? {} : { authorize: async (job: api.Job) => {
      if (!validAccount()) return false
      if (!job.projectDir) return true
      const folders = await api.listFolders(registration!.machineId)
      if (!validAccount()) return false
      return folders.ok ? folders.value.folders.some(f => f.project === job.project && f.path === job.projectDir) : folders
    } }), runtimes: () => base.runtimes().then(redetected) }
  }

  /** Tell Cloud where things stand, and hear which akb to run. */
  const register = async () => {
    const answer = await api.register(registration!)
    logSync('registration', { ok: answer.ok, ...(!answer.ok ? { code: answer.code, error: answer.error } : {}) })
    if (answer.ok) void followAkb(answer.value.akb)
    return answer
  }

  /** A job looked again — a test after an install or a sign-in: Cloud hears before the job ends. */
  const redetected = async (found: api.RuntimeReport[]) => {
    if (closed || !registration || JSON.stringify(found) === JSON.stringify(registration.runtimes)) return found
    registration = { ...registration, runtimes: found }
    await register()
    return found
  }
  let refreshingModels = false
  let modelsAgain = false
  const updateModels = async () => {
    if (refreshingModels) { modelsAgain = true; return }
    if (closed || !connected || !ownsExecution || !registration || !validAccount()) return
    refreshingModels = true
    try {
      do {
        modelsAgain = false
        const was = registration!.runtimes
        const found = await refreshModels(was)
        if (registration!.runtimes !== was) modelsAgain = true
        else await redetected(found)
      } while (modelsAgain && !closed)
    } catch (error) {
      console.error('runner: model refresh failed:', error instanceof Error ? error.message : String(error))
    } finally { refreshingModels = false }
  }
  const stopModels = modelLists.subscribe(() => { void updateModels() })
  const modelsTimer = setInterval(() => { void updateModels() }, MODEL_REFRESH_MS)
  modelsTimer.unref?.()

  const idle = () => (running.size ? t.running(running.size) : t.connected(registration!.machineName))

  const schedule = (ms: number) => {
    if (closed || !ownsExecution) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(tick, ms)
  }

  let looking = false
  const agentsDue = async () => {
    if (looking || closed || !connected || !registration) return
    looking = true
    try {
      if (await askDueAgents(registration.machineId)) void readJobs()
    } catch (e) {
      console.error(`runner: the periodic agents were not looked at: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      looking = false
    }
  }
  let agentsTimer: ReturnType<typeof setTimeout> | null = null
  const lookNext = () => {
    if (closed) return
    const at = (options.nextLook ?? nextHour)(Date.now())
    agentsTimer = setTimeout(() => {
      const late = Date.now() - at
      if (late >= 0 && late < LOOK_LATE_MS) void agentsDue()
      lookNext()
    }, at - Date.now())
    agentsTimer.unref?.()
  }
  lookNext()

  let sweeping = false
  let swept = false
  const sweep = async () => {
    if (sweeping || closed || !registration) return
    sweeping = true
    try {
      await reclaimFlowWorkers(registration.machineId, options.deps)
      sweepAkb()
      await sweepCache(registration.machineId)
      await sweepStudios()
    } catch (e) {
      console.error(`runner: the cache was not cleaned: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      sweeping = false
    }
  }
  const sweepTimer = setInterval(() => void sweep(), SWEEP_MS)
  sweepTimer.unref?.()

  const finish = async (s: Stop) => {
    await close(false)
    stop(s)
  }

  const validAccount = () => readSession()?.subject === account && accountGeneration() === generation
  const tick = async () => {
    if (closed || !ownsExecution) return
    if (!validAccount()) return finish({ reason: 'refused', message: '账号已退出或切换。' })
    if (!registration || redetect) { redetect = false; registration = await options.registration() }
    else {
      const was = registration.runtimes
      const runtimes = await refreshModels(was)
      if (registration.runtimes === was) registration = { ...registration, runtimes }
    }
    if (!swept) {
      swept = true
      void sweep()
    }
    const answer = await register()
    if (closed) return
    if (!answer.ok) {
      if (answer.code === 'runner_elsewhere') {
        const held = await api.readRunner()
        return finish({ reason: 'elsewhere', machine: (held.ok && held.value.runner?.machineName) || '?' })
      }
      if (answer.code === 'runner_outdated') return finish({ reason: 'outdated' })
      if (!api.temporaryCloudFailure(answer)) return finish({ reason: 'refused', message: answer.error })
      connected = false
      options.onReconnecting?.()
      status(t.reconnecting())
      return schedule(BACKOFF_MS[Math.min(attempts++, BACKOFF_MS.length - 1)]!)
    }
    attempts = 0
    if (!connected) {
      connected = true
      status(idle())
      options.onConnected?.()
      openLive()
      presence ??= keepPresence(registration.machineId, undefined, (job) => {
        replyHint(job, 'presence')
      })
      const { watchMs } = deps()
      if (watchMs !== null) boards ??= watchBoards(registration.machineId, watchMs)
      // Detection also refreshes install and login state.
      void deps().runtimes()
    }
    try {
      await reviewChats(registration.machineId, registration.runtimes)
    } catch (error) {
      console.error('runner: conversation memory review could not be scheduled', error)
    }
    await readJobs()
    if (!live?.joined()) boards?.pullAll()

    schedule(live?.joined() ? options.heartbeatMs ?? HEARTBEAT_MS : Math.min(options.pollMs ?? POLL_MS, options.heartbeatMs ?? HEARTBEAT_MS))
  }

  const openLive = () => {
    if (live) return
    const subject = readSession()?.subject
    if (!subject) return
    live = connectCloudLive({
      topic: `runner:${subject}`,
      onHint: (payload) => {
        if (payload.diff) {
          if (registration) void answerHint(registration.machineId, payload)
          return
        }
        if (typeof payload.board === 'string') {
          if (typeof payload.head_seq === 'number') boards?.hint(payload.board, payload.head_seq, payload.machine as string | undefined)
          return
        }
        if (payload.reply === true && typeof payload.jobId === 'string' && /^[0-9a-f-]{36}$/i.test(payload.jobId)) {
          replyHint(payload.jobId, 'realtime')
          return
        }
        if (payload.jobId || !(payload.alertId || payload.taskId)) {
          console.info('reply-dispatch', { event: 'hint', source: 'realtime', job: payload.jobId, at: new Date().toISOString() })
          void readJobs('realtime')
        }
      },
      onReady: () => {
        void sweep()
        void readJobs('reconnected')
        boards?.pullAll()
      },
      onState: (state, reason) => console.info('reply-dispatch', { event: state, reason, at: new Date().toISOString() }),
    })
  }

  const replyHint = (job: string, source: string) => {
    if (closed || preparing || !registration || running.has(job) || !validAccount()) return
    console.info('reply-dispatch', { event: 'hint', source, job, at: new Date().toISOString() })
    start(job, true)
  }

  const retryFlowClaimAt = (at: number) => {
    if (at >= flowClaimRetryAt) return
    clearTimeout(flowClaimRetry)
    flowClaimRetryAt = at
    flowClaimRetry = setTimeout(() => {
      flowClaimRetryAt = Infinity
      void readJobs()
    }, Math.max(0, at - Date.now()))
  }

  /** The catch-up read. One at a time; a hint during a read reads once more after it. */
  const readJobs = async (source = 'catchup'): Promise<void> => {
    if (closed || preparing || !registration) return
    if (reading) {
      readAgain = true
      return
    }
    reading = true
    let readEnded = () => {}
    readDone = new Promise<void>((resolve) => (readEnded = resolve))
    try {
      const list = await api.listJobs(registration.machineId)
      if (!list.ok || closed) return
      const listed = new Set(list.value.jobs.map((job) => job.id))
      for (const id of attempted) if (!listed.has(id) && !running.has(id)) attempted.delete(id)
      for (const job of list.value.jobs) {
        if (closed || preparing) break
        const syncSource = job.flow?.sync_recovery_of ?? job.syncRecoveryOf
        if (syncSource
            && (running.has(syncSource) || !retireSyncWorker(syncSource, registration.machineId))) continue
        if (workerEntry && canKeepFlow(job) && !running.has(job.id)
            && (job.state === 'waiting' || job.state === 'claimed') && !attempted.has(job.id)) {
          let keep = hasFlowWorker(job.id)
          if (!keep) {
            const current = await api.readJob(job.id)
            if (closed || preparing || !validAccount()) break
            if (!current.ok || current.value.job.id !== job.id || current.value.job.state === 'finished') continue
            keep = current.value.job.state === 'waiting'
          }
          if (keep) { startWorker(job); continue }
        }
        if (job.flow && hasFlowWorker(job.id)) {
          if (!running.has(job.id)) {
            const retry = await reclaimFlowWorkers(registration.machineId, options.deps, job.id, !!workerEntry && job.state === 'waiting')
            if (closed || preparing || !validAccount()) break
            if (hasFlowWorker(job.id)) {
              if (retry) retryFlowClaimAt(retry.at)
            } else if (retry) {
              console.info('runner: retrying job claim', { job: job.id, attempt: retry.attempt + 1, previousFailure: retry.failure })
              startWorker(job, retry.attempt + 1)
            } else { attempted.delete(job.id); readAgain = true }
          }
          continue
        }
        // Cloud may have accepted the result after the local owner went away.
        if (job.test && attempted.has(job.id)) continue
        if ((job.state === 'claimed' || job.state === 'interrupted') && !running.has(job.id)) {
          const valid = () => !closed && !preparing && validAccount()
          const current = await api.readJob(job.id)
          if (!valid()) break
          if (!current.ok || current.value.job.id !== job.id) continue
          const original = current.value.job
          if (original.state === 'finished' && (original.outcome === 'done' || original.outcome === 'stopped')) {
            clearCheckpoint(job.id)
          }
          if (original.state !== 'claimed' && original.state !== 'interrupted') continue
          const step = deps()
          const failure = await stopLeftOn(original)
          const checkpoint = readCheckpoint(job.id)
          let stopped = !failure && await stopReply(job.id, step.stopMs)
          if (!valid()) break
          if (checkpoint && stopped && usesBoardRun(original, checkpoint) && checkpoint.started !== false && !checkpoint.completed) {
            const folder = original.projectDir ? folderFor(original) : null
            if (folder && 'refused' in folder) continue
            const ws = original.agent && folder
              ? openAgentFolder(original, folder.cwd)
              : openTaskFolder({ ...original, task: original.task ?? original.review?.tasks[0] }, folder?.cwd ?? null)
            const evidence = await flowRunEvidence(ws, original, { ...step, akb: step.akb() }, job.id, checkpoint.flowRun)
            checkpoint.flowRun = evidence.run
            stopped = evidence.stopped
          }
          const recovered = await recoverInterruptedJob(registration.machineId, original, checkpoint, stopped, valid, failure)
          if (recovered?.resumed) attempted.delete(job.id)
          if (recovered?.resumed || stopped && recovered?.finished) readAgain = true
          continue
        }
        // Cloud lists only the jobs the plan's running limit lets start (#2209).
        if (job.state !== 'waiting' || running.has(job.id)) continue
        console.info('reply-dispatch', { event: 'discovered', job: job.id, source, at: new Date().toISOString() })
        start(job.id, !job.flow && !!(job.chat || job.discussion))
      }
    } finally {
      reading = false
      readEnded()
      if (readAgain) {
        readAgain = false
        void readJobs()
      }
    }
  }

  /** The board runs a flow job left on its card when the Runner was force-quit under it (#2120). */
  const stopLeftOn = async (job: api.Job): Promise<string | undefined> => {
    if (!job.review && (!job.flow || !job.task)) return
    try {
      const folder = job.projectDir ? folderFor(job) : null
      if (folder && 'refused' in folder) return folder.refused
      const ws = openTaskFolder({ ...job, task: job.task ?? job.review?.tasks[0] }, folder?.cwd ?? null)
      const card = akbCardOf(ws)
      if (card) {
        if (job.flow && job.flow.verb !== 'discard') {
          const reconciled = answerOf<{ kind?: string; deliveryId?: string }>(
            await runAkb(deps().akb(), ['delivery', 'reconcile', String(card), '--json', '--board', ws.board], { cwd: ws.cwd, board: ws.board }),
          )
          if (reconciled?.kind === 'running' && reconciled.deliveryId) return
        }
        await stopLeftBehind(deps().akb(), ws, card, deps().stopMs)
      }
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }



  const start = (id: string, reply = false) => {
    // 失去租约后的作业先停止进程，再申请一次带新身份的恢复。
    attempted.add(id)
    running.set(id, null)
    status(idle())
    let result: Awaited<ReturnType<typeof runJob>> = 'changed'
    const job = runJob(id, deps(), (halt) => {
      running.set(id, halt)
      if (closed) void halt()
    }, () => closed, reply)
      .then((outcome) => { result = outcome })
      .catch(() => {})
      .finally(() => {
        jobs.delete(job)
        running.delete(id)
        if (closed) return
        status(idle())
        if (result === 'changed') {
          claimAttempts = 0
          boards?.look()
          void readJobs()
          return
        }
        attempted.delete(id)
        if (result === 'retry' && !claimRetry) {
          claimRetry = setTimeout(() => {
            claimRetry = undefined
            void readJobs()
          }, BACKOFF_MS[Math.min(claimAttempts++, BACKOFF_MS.length - 1)])
        }
      })
    jobs.add(job)
  }

  const startWorker = (job: api.Job, claimAttempt = 1) => {
    const id = job.id
    attempted.add(id)
    workers.add(id)
    running.set(id, () => stopFlowWorker(id, deps().stopMs))
    status(idle())
    const watched = (async () => {
      try {
        if (!hasFlowWorker(id)) launchFlowWorker(id, registration!.machineId, workerEntry, claimAttempt)
        await watchFlowWorker(id, registration!.machineId, () => closed)
      } catch {
        // The exit sweep checks the same job in Cloud after proving the worker stopped.
      }
    })().finally(() => {
      jobs.delete(watched)
      running.delete(id)
      workers.delete(id)
      void reclaimFlowWorkerAfterExit(id, registration!.machineId, options.deps).finally(() => {
        if (!closed) {
          if (!hasFlowWorker(id)) attempted.delete(id)
          boards?.look(); status(idle()); void readJobs()
        }
      })
    })
    jobs.add(watched)
  }

  const close = async (release = true, updating = false) => {
    if (closed) return
    if (updating) {
      preparing = true
      await readDone
      // 先让云端保留作业，断网时不开始停机。
      for (const id of running.keys()) {
        if (workers.has(id)) continue
        const prepared = await api.finishJob(registration!.machineId, id, 'update_prepare')
        if (!prepared.ok || !prepared.value.prepared && !prepared.value.finished) {
          preparing = false
          void readJobs()
          throw new Error('更新暂缓：未能保存云端任务，稍后重试。')
        }
      }
    }
    closed = true
    if (updating) {
      for (const id of running.keys()) {
        if (workers.has(id)) continue
        const checkpoint = readCheckpoint(id) ?? { pending: [] }
        saveCheckpoint(id, { ...checkpoint, updating: true })
      }
    }
    if (timer) clearTimeout(timer)
    clearTimeout(claimRetry)
    clearTimeout(flowClaimRetry)
    if (agentsTimer) clearTimeout(agentsTimer)
    clearInterval(modelsTimer)
    stopModels()
    clearInterval(sweepTimer)
    live?.close()
    presence?.close()
    boards?.close()
    // A stalled protocol or upload must not block the update handoff forever.
    const preserveWorkers = (release || updating) && validAccount()
    const keptWorkers = preserveWorkers && workers.size > 0
    const stops = Promise.all([readDone, ...jobs, ...[...running.entries()].map(([id, halt]) =>
      preserveWorkers && workers.has(id) ? undefined : halt?.())])
    let timeout: ReturnType<typeof setTimeout> | undefined
    await Promise.race([stops, new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        if (updating) console.error(`runner: update cleanup timed out; checkpoints retained for jobs: ${[...running.keys()].join(', ')}`)
        resolve()
      }, (options.deps?.stopMs ?? STOP_MS) + 1_000)
    })])
    clearTimeout(timeout)
    await startingCodex
    await codex?.close()
    for (const [key, value] of Object.entries(codex?.env ?? {})) if (process.env[key] === value) delete process.env[key]
    try {
      if (release && !keptWorkers && registration) await api.release(registration.machineId)
    } finally {
      clearInterval(accountWatch)
      await releaseMachine?.()
      releaseRecord?.()
    }
  }

  let refresh = ''
  const accountWatch = setInterval(() => {
    try {
      const value = fs.readFileSync(path.join(runnerHome(), 'settings-refresh'), 'utf8')
      if (value !== refresh) { refresh = value; redetect = true; if (!closed) schedule(0) }
    } catch {}
    if (!validAccount()) clearStudioSnapshots()
    if (!closed && !validAccount()) void finish({ reason: 'refused', message: '账号已退出或切换。' })
  }, 200)
  accountWatch.unref()

  const startingCodex = (lock ? Promise.resolve(lock) : acquireMachine(options.kind)).then(async release => {
    releaseMachine = release
    if (closed) return
    adoptLegacy()
    releaseRecord = executorRecord()
    removeLegacy()
    pruneChats()
    codex = await codexServer()
    if (closed) return
    ownsExecution = true
    Object.assign(process.env, codex.env)
    void tick()
  }).catch(error => {
    if (closed) return
    void finish(error instanceof RunnerAlreadyRunning
      ? { reason: 'already-running' }
      : { reason: 'refused', message: error instanceof Error ? error.message : String(error) })
  })
  return { stopped, close: () => close(true), update: () => close(false, true), renew: () => { redetect = true; schedule(0) } }
}
