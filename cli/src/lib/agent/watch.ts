import { reviewBoundary, taskReviewBoundary } from '../shared/review-plan'
import { SAVED_PREVIEW_FILE_ENV, taskReviewContext } from './env'
import { connectionIdentity, connectionStopped, endConnection } from './connection-process'
import { deliveryFor, findDelivery } from './deliveries'
import { studioForRun } from './runner'
import { runnerProject, workspaceTask } from '../cloud/tasks'
import { missingStudioVersion, readRuntimeContext, readVersion, saveRuntimeContext, saveStudioSession, STUDIO_SNAPSHOT_ENV, type HeldVersion } from './cloud-studios'
import { listedStudioVersion, studioContextBlocks } from './studio-shared'
import { compactReview, contextAction, contextFingerprint, contextUpdate, reviewBlock, taskCardBlock, type ContextBlock } from './runtime-context'
import { parseStudioFile } from './studio-def'
import { boardCommand } from './command'
import { studioFor } from './studios'
// The process that watches one run.
//
// A run has to outlive the command that started it: close the terminal and the agent keeps
// working, and the run is still there to follow and to stop. So the command writes the run
// down and spawns this — detached, with nothing attached to the terminal — and returns.
// This is what actually starts the agent, writes its log, and does the bookkeeping either
// side of it.
//
// It is one process per run. That is what makes a stop a real signal to a real process,
// and what lets a run queued behind the shared-file lock keep waiting after whoever asked
// for it has gone home.

import { spawn, type ChildProcessByStdio, type StdioNull, type StdioPipe } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import fs from 'node:fs'

import { conflictPrompt } from '../shared/board-conflicts'

import { KANBAN, REPO_ROOT, SESSIONS_DIR } from '../paths'
import { eventsPathOf, readRuns, withStore } from './store'
import { lastSessionTotal, ownCost, reportsSessionTotal } from './own-cost'
import { cleanupDiscardedCards } from '../../commands/remove'
import { cardFileOf, discardedCardsPrompt, studioRulesBlock } from './prompts'
import { contextLimit, refreshCatalog } from './catalog'
import { runEnv } from './flow'
import { spawnable } from './spawnable'
import { endAgent, killMarked, processesStopped, runMark } from './stop'
import { refineRunsAfter } from './follow'
import { queueCompleted } from './propose'
import { costLine, durationLine, modelLine, RESULT_MARKER, usageLine } from './log'
import { createStderrFilter, streamFinished, type RunEvent } from './wire'
import { compactTaskPrompt, restartPrompt, resumePrompt } from './prompts'
import { openPlan } from './resolve'
import { promptInput } from './harnesses/launch'
import { createIdleWatchdog, IDLE_FAILURE, IDLE_MS } from './idle'
import { idleStopConfirmed } from './wire/codex-background-types'
import { agentRecovery, backoffMs, isSessionMissingFailure, makeFailure, MAX_RETRY_ATTEMPTS, pauseLine, planRetry, retryBudget, RETRY_FILE_ENV, retryContinuePrompt, retryLine, retryRecord, syncRepairPrompt, waitForRetry, type ExecutionFailure, type RetryPause, type RetryRecord, type RetryRuntime, type SessionAction } from './retry'
import { runtimeById } from './runtimes'
import { executionFailure } from './wire/failures'
import { turnSubmitted } from './wire/events'
import { executionHeld, executionOf } from '../cloud/execution'
import {
  claimChanges,
  markBoard,
  refinementRunsAfter,
  type BoardMarks,
  type RefinementFollowUp,
} from './refine'
import {
  acquireIndexLock,
  claimCard,
  clearAsks,
  carriesSession,
  closeRun,
  forgetRun,
  needsIndexLock,
  patch,
  peekRun,
  readRefineAsks,
  readSpec,
  liveSubRuns,
  stopSubRuns,
  resumeSessionId,
  setCardStatus,
  requestOf,
  type CardClaim,
} from './sessions'
import { startResume, startRun } from './start'
import type { TurnEnd } from './wire'
import type { AgentRequest, ContextWindow, RunReason, RunRecord, RunStatus } from './types'

// How long a run gets to end on its own after a stop asks it to, before it is killed
// outright.
const STOP_GRACE_MS = 5_000
// And how long after that before the run is closed out whatever the child's pipes are
// doing. See the note beside giveUp.
const STOP_CLOSE_MS = 2_000
// And how long the ending path itself gets to write the board out before the process
// leaves anyway.
const STOP_FINISH_MS = 10_000

// Five minutes of pure waiting, excluding active local work.
const silenceSaid = (minutes: number): string =>
  `the agent said nothing for ${minutes} minute${minutes === 1 ? '' : 's'}, so the run was ended.`


export async function watchRun(sessionId: string, resume = startResume, retryBackoff = backoffMs): Promise<number> {
  const spec = readSpec(sessionId)
  const run = peekRun(sessionId)
  if (!run || !spec) {
    // Nothing to watch. Either the record has gone (a stop that landed before this process
    // was up closed it) or the plan was never written.
    if (run?.status === 'running') await closeRun(sessionId, { status: 'interrupted', code: null })
    return 1
  }

  if (run.stopping) {
    await closeRun(sessionId, { status: 'stopped', code: null })
    return 1
  }


  let studio: HeldVersion | undefined
  try {
    const pin = run.studioPin
    if (pin) {
      const held = readVersion(pin.studio, pin.version)
      if (!held) throw new Error(missingStudioVersion(pin))
      process.env[STUDIO_SNAPSHOT_ENV] = JSON.stringify(pin)
      studio = held
    } else {
      studio = listedStudioVersion(studioForRun({ action: run.action, id: run.cardId ?? undefined, studio: run.studio }))
    }
  } catch (error) {
    await closeRun(sessionId, { status: 'error', code: null, error: error instanceof Error ? error.message : String(error) })
    return 1
  }

  // A stop can reach a run before it ever spawns, and an index run can wait a long time for
  // its turn — so the record, not this process's own memory, is what says whether to carry
  // on. It is re-read at every step.
  const stopping = (): boolean => peekRun(sessionId)?.status !== 'running'

  let releaseIndex: (() => void) | null = null
  if (needsIndexLock(run.action)) {
    releaseIndex = await acquireIndexLock(stopping)
    if (!releaseIndex) {
      // Stopped while queued, or waited past all reason. Either way nothing spawned.
      if (!stopping()) await closeRun(sessionId, { status: 'interrupted', code: null })
      return 0
    }
  }
  const letGo = () => {
    if (releaseIndex) releaseIndex()
    releaseIndex = null
  }

  if (stopping()) {
    letGo()
    return 0
  }

  // Save the stage before the agent touches the card, so anything reading the board
  // mid-run finds it already marked. The record keeps what was there, so the end of the run
  // can put it back.
  //
  // Two steps, because `patch` holds the run record's lock across its callback and the
  // board write is awaited: the record remembers the prior stage under the lock, and the
  // card is marked once the lock is back.
  let claim: CardClaim | undefined
  const claimed = patch(sessionId, (r) => {
    claim = claimCard(r)
  })
  const record = claimed ?? run
  // A sub-run leaves the board's bookkeeping to its parent (#1421): no card hold, no checks,
  // no landing and no follow-ups.
  const sub = record.action === 'sub'
  const retryFile = record.cloudExecution && !sub && process.env[RETRY_FILE_ENV]
  const budget = retryFile ? retryBudget(retryFile, record.retry?.attempt) : undefined
  if (claim) await setCardStatus(claim.cardId, claim.status)

  // The log is machine state like the record it belongs to, so a folder that refuses writes
  // costs this run its log and nothing else (#622) — the stream swallows what it cannot
  // write rather than throwing an error nothing here is listening for.
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  const logFile = fs.createWriteStream(record.logPath, { flags: 'a' })
  logFile.on('error', () => {})
  // Beside the log, the run's structured events (#2059): what the agent did, from a source
  // that reports it, and every other line of the log as `log`.
  const eventsFile = fs.createWriteStream(eventsPathOf(sessionId), { flags: 'a' })
  eventsFile.on('error', () => {})
  let observeActivity = (_e: RunEvent) => {}
  const pendingOperations = new Set<string>()
  let hadEffects = false
  let submitted = record.submitted === true
  let saveContext = () => {}
  const event = (e: RunEvent) => {
    observeActivity(e)
    const hadPending = pendingOperations.size > 0
    if (e.kind === 'tool_call' && !['read', 'search', 'fetch'].includes(e.data.kind)) {
      hadEffects = true
      if (!['completed', 'failed'].includes(e.data.status)) pendingOperations.add(e.data.toolCallId)
    }
    if ((e.kind === 'tool_call' || e.kind === 'tool_call_update') && ['completed', 'failed'].includes(e.data.status ?? '')) pendingOperations.delete(e.data.toolCallId)
    const newSubmission = !submitted && turnSubmitted(e)
    const operationsChanged = record.cloudExecution && hadPending !== (pendingOperations.size > 0)
    if (newSubmission || operationsChanged) patch(sessionId, run => {
      if (newSubmission) run.submitted = true
      if (operationsChanged) run.pendingWrites = pendingOperations.size > 0
    })
    submitted ||= newSubmission
    if (newSubmission) saveContext()
    eventsFile.write(`${JSON.stringify(e)}\n`)
  }
  const runtimeInfo = (): RetryRuntime => ({
    connector: record.harness,
    name: record.runtime ? (runtimeById(record.runtime)?.name ?? null) : null,
    model: peekRun(sessionId)?.model ?? record.model ?? null,
  })
  const log = {
    write(text: string) {
      logFile.write(text)
      if (text.trim()) event({ kind: 'log', data: { text } })
    },
    end: (closed?: () => void) => {
      eventsFile.end()
      logFile.end(closed)
    },
  }
  // Runtime notes precede the agent's output.
  for (const note of spec.notes ?? []) log.write(`[board] ${note}\n`)

  // The keys are read here and nowhere else: the plan on disk carries the command and the
  // agent's name, never a key, and this is the one moment one is needed.
  const active = openPlan(spec.plan, record.pictures)
  if (active.startNote) log.write(`[board] ${active.startNote}\n`)
  // Resume the recorded action, not another phase of the same delivery. A resume that could
  // only open a new session (#1321) brings the whole ask instead.
  const basePrompt = record.resumedFrom ? spec.prompt || resumePrompt(record.deliveryId, record.action, record.cardId ?? undefined) : spec.prompt
  const studioRequest = {
    action: record.action,
    id: record.cardId ?? undefined,
    deliveryId: record.deliveryId,
    studio: record.studio,
  }
  const compact = compactTaskPrompt(studioRequest)
  const task = workspaceTask()
  const scope = task ?? 'board-' + contextFingerprint(KANBAN)
  const fromSession = record.continues?.resumeId ?? (carriesSession(record) ? active.resumeId : undefined)
  const previous = fromSession ? readRuntimeContext(scope, record.harness, fromSession) : undefined
  const action = contextAction(record.action)
  const parsed = studio && parseStudioFile(studio.id, studio.files['STUDIO.md'] ?? '', 'STUDIO.md')
  const command = boardCommand()
  const studioBlocks = studio ? studioContextBlocks(studio, action, parsed && 'def' in parsed ? parsed.def : { name: studio.name, rules: '' },
    KANBAN, runnerProject(KANBAN), /^akb(?: |$)/.test(command) ? undefined : command + ' studio file') : []
  const launchStudio = !compact && (spec.studioAtLaunch || record.resumedFrom)
    ? studioRulesBlock(studioRequest, !studio) : ''
  const card = compact ? cardFileOf(studioRequest.id) : ''
  const recoveryPrompt = record.harness === 'antigravity' && record.resumedFrom
    ? 'First verify existing progress and operation results. Preserve user decisions and completed work; do not repeat completed operations. Check actual state before continuing any operation whose result is uncertain.' : ''
  const reviewContext = taskReviewContext()
  const savedPreviews = record.action === 'implement' && process.env[SAVED_PREVIEW_FILE_ENV]
  const review = reviewContext?.review
  const studioPreviews = !compact && review?.preview_definitions?.length
    ? (deliveryFor(studioRequest)?.studio ?? studioFor(studioForRun(studioRequest)))?.previews
    : undefined
  const boundary = review && (compact
    ? review.plan === null ? compactReview(review, reviewContext.assigned) : taskReviewBoundary(review, reviewContext.assigned)
    : reviewBoundary(savedPreviews ? { ...review, stages: review.stages.map(stage => ({ ...stage, snapshot: null })) }
      : review, reviewContext.assigned, studioPreviews))
  const savedPrompt = !compact && savedPreviews
    ? `Use the task inputs and pinned files listed in \`${savedPreviews}\`. Follow the task's delivery instructions.`
    : ''
  const retryDiag = record.retry
    ? record.failure
      ? retryContinuePrompt(record.failure, record.retry.attempt, record.retry.of)
      : `Previous execution failed: ${record.retry.reason}. Check existing results before continuing; do not repeat completed operations.`
    : ''
  const blocks = (prior: typeof previous): ContextBlock[] => [
    ...(card ? [taskCardBlock(card)] : []),
    ...studioBlocks.filter(([key]) => key === 'studio' || key === 'skills'),
    reviewBlock(boundary ?? '', review, prior),
    ...studioBlocks.filter(([key]) => key === 'setup' && compact || key === 'config' && (compact || spec.studioAtLaunch)),
    ['inline-studio', launchStudio], ['approved-inputs', savedPrompt],
  ]
  const context = contextUpdate(previous, blocks(previous))
  const diagnostics = [process.env.AI4KANBAN_SYNC_DIAGNOSTIC ? syncRepairPrompt(process.env.AI4KANBAN_SYNC_DIAGNOSTIC) : '',
    retryDiag, conflictPrompt(KANBAN)]
  const rest = [recoveryPrompt, discardedCardsPrompt(record.discardedCards)]
  const assemble = (base: string, parts: string[]) => {
    if (!compact) return [...diagnostics, ...parts, base, ...rest].filter(Boolean).join('\n\n')
    const split = base.indexOf('\n\n')
    const [ask, notes] = split === -1 ? [base, ''] : [base.slice(0, split), base.slice(split + 2)]
    return [...diagnostics, ask, ...parts, ...rest, notes].filter(Boolean).join('\n\n')
  }
  const prompt = assemble(basePrompt, context.parts)

  // The board as it was the moment before the agent touched it. The difference between this
  // and the same read at the close is what this run could be answerable for; which of it
  // really is its own — and not a neighbouring run's — is settled at the close by
  // `claimChanges`, and that is what earns a card the refine that follows.
  const before = markBoard()
  active.renderer?.setRequiredImages?.(record.pictures ?? [])
  const { command: cmd, args, stdin } = promptInput(active, prompt)
  const workDir = active.cwd ?? REPO_ROOT
  // How long this run may say nothing. Read once, here, like every other setting a run
  // uses: a limit changed mid-run belongs to the next run.
  const silenceFor = IDLE_MS / 60_000
  // The catalogue the context ring's window comes from (#675), pulled behind the run rather
  // than in front of it: this supervisor outlives the download, and a run must never wait on
  // a network the board doesn't need. Whatever is already on disk answers until it lands.
  void refreshCatalog()
  // A connector the board talks to is started differently in two ways: the prompt is sent
  // in the conversation rather than spelled on the command line, and its stdin stays open,
  // because that is the half of the conversation this end writes (agent/wire/client.ts).
  const client = active.client
  const restartBase = !client || record.cardId !== null || record.retry?.launching ? undefined
    : record.resumedFrom ? restartPrompt(requestOf(record), record.deliveryId, false)
    : record.continues && !record.continues.fork ? spec.prompt : undefined
  const freshContext = restartBase ? contextUpdate(undefined, blocks(undefined)) : undefined
  const restart = restartBase && freshContext ? assemble(restartBase, freshContext.parts) : undefined
  // A printing agent that reads its turns off stdin (#1540) is handed the prompt there, and
  // stdin stays open until a turn ends with nothing left in the background.
  // Spelled out rather than written inline so both shapes stay one spawn: stdin is a pipe
  // for a conversation and closed for a command that only prints.
  const stdio: [StdioNull | StdioPipe, StdioPipe, StdioPipe] = [client || stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
  // stdout and stderr are pipes whichever shape this is; only stdin differs.
  let child: ChildProcessByStdio<Writable | null, Readable, Readable>
  if (record.retry?.launching && !await executionHeld(executionOf())) {
    log.end()
    await closeRun(sessionId, { status: 'error', code: null, error: joinNotes(record.retry.reason, pauseLine('authorization')), retryPause: 'authorization', failure: record.failure })
    letGo()
    return 1
  }
  if (record.retry?.launching && peekRun(sessionId)?.stopping) {
    log.end()
    await closeRun(sessionId, { status: 'stopped', code: null })
    letGo()
    return 1
  }
  if (record.retry?.launching) {
    const nextAttempt = budget ? budget.take() : record.retry.attempt + 1
    if (nextAttempt === undefined || nextAttempt > MAX_RETRY_ATTEMPTS + 1) {
      log.end()
      await closeRun(sessionId, { status: 'error', code: null, error: joinNotes(record.retry.reason, pauseLine('limit')), retryPause: 'limit', failure: record.failure })
      letGo()
      return 1
    }
    patch(sessionId, (r) => {
      if (!r.retry?.launching) return
      r.retry.attempt = nextAttempt
      delete r.retry.launching
    })
    event({
      kind: 'retry',
      data: {
        state: 'retrying',
        source: record.failure?.source ?? 'runtime',
        runtime: runtimeInfo(),
        attempt: nextAttempt - 1,
        maxAttempts: record.retry.of,
        summary: record.failure?.summary ?? record.retry.reason,
        ...(record.failure?.detail ? { detail: record.failure.detail } : {}),
        ...(record.failure?.code ? { code: record.failure.code } : {}),
        sessionAction: record.resumedFrom ? 'resume' : 'reset_replay',
        at: new Date().toISOString(),
      },
    })
  }
  try {
    const start = spawnable(cmd, args, {
      // Where this run works: the project, or — inside a delivery with a worktree of its
      // own (#303) — that worktree. Settled when the run was planned and written down with
      // it, so the spawn, the connector's own folder flag and `PWD` are one answer.
      cwd: workDir,
      // The run's own id goes into the agent's environment, and this is the one place it
      // can: the environment a run starts under is settled by the settings (resolve.ts),
      // which never see a run id. It is what stops a run spawning a copy of itself —
      // an agent inside a run that asks for a board action gets the flow printed instead
      // (lib/agent/flow.ts).
      env: runEnv(active.env, sessionId),
      shell: false,
      // `claude -p` waits ~3s on a piped stdin, then logs a "no stdin data" warning into
      // our log. Close stdin so the log is only agent output.
      stdio,
    })
    child = spawn(start.command, start.args, start.options) as ChildProcessByStdio<Writable | null, Readable, Readable>
  } catch (e) {
    log.end()
    patch(sessionId, (r) => {
      r.unspawned = true
    })
    await closeRun(sessionId, { status: 'error', ok: false, code: null, error: String(e), failure: executionFailure(e) })
    letGo()
    return 1
  }
  // Read after the spawn, so the agent itself is never younger than its record (#1313).
  const agentStartedAt = Date.now()
  if (child.pid) {
    patch(sessionId, (r) => {
      r.agentPid = child.pid
      r.agentStartedAt = agentStartedAt
      r.managedProcess = client?.managedProcess
      r.agentIdentity = client?.managedProcess ? connectionIdentity(child.pid!) : undefined
    })
  }

  const renderer = active.renderer
  // A source that reports events has its log text in them already.
  const structured = !!renderer?.events || !!client?.structured
  const append = (str: string) => {
    if (!str) return
    if (structured) logFile.write(str)
    else log.write(str)
  }
  const drainEvents = () => {
    for (const e of renderer?.events?.() ?? []) event(e)
  }
  let inputOpen = stdin !== undefined && !!child.stdin
  const endInput = () => {
    if (!inputOpen) return
    inputOpen = false
    child.stdin?.end()
  }
  if (inputOpen) {
    child.stdin!.on('error', () => {})
    child.stdin!.write(stdin!)
  }
  // A turn that ends with nothing left in the background is the last one.
  const completed = () => !!record.deliveryId && findDelivery(record.deliveryId)?.status === 'finished'
  let finishCompletedTurn = () => {}
  let turnsSeen = 0
  const afterTurn = () => {
    const turns = renderer?.turns?.() ?? []
    if (turns.length === turnsSeen) return
    turnsSeen = turns.length
    if (completed()) finishCompletedTurn()
    else if (renderer && streamFinished(renderer)) endInput()
  }
  // Both ids are written into the record the first time the stream names them, and never
  // looked for again — every write takes the record's lock, and a run's output arrives in
  // hundreds of chunks.
  const bindStudioSession = (id: string | undefined) => {
    if (task && id && record.studioPin) saveStudioSession(task, id, record.studioPin)
  }
  let runtimeSession = resumeSessionId(record)
  let sent = context.sent
  let recordedSession: string | undefined
  saveContext = () => {
    if (!runtimeSession || runtimeSession === recordedSession || !Object.keys(sent).length) return
    saveRuntimeContext(scope, record.harness, runtimeSession, sent)
    recordedSession = runtimeSession
  }
  let sawResumeId = !!record.resumeId
  bindStudioSession(resumeSessionId(record))
  let sawModel = false
  const gotResumeId = (id: string | undefined, restarted = false) => {
    if (restarted || !sawResumeId) {
      sawResumeId = catchResumeId(sessionId, id, restarted)
      if (sawResumeId) {
        runtimeSession = id
        if (restarted && freshContext) sent = freshContext.sent
        bindStudioSession(id)
        if (submitted) saveContext()
      }
    }
  }
  const gotModel = (model: string | undefined) => {
    if (!sawModel) sawModel = catchModel(sessionId, model)
  }
  // How full the window is, written down again every time the reading moves (#675) — unlike
  // the two above, which are caught once. It is what makes a long run's ring climb while it
  // works.
  //
  // The reading only moves when a request comes back, and a run's output arrives in hundreds
  // of chunks that say nothing new — so a chunk that repeats the last reading stops here,
  // before the record is read or written. The exceptions are a window still unknown — where a
  // connector names none it comes from the model, and the model can arrive long after the
  // first reading does (OpenCode names one only once its stream has ended) — and one the
  // connector names late: Claude Code's arrives after its reading, and outranks the catalogue.
  let lastUsed = 0
  let lastLimit: number | undefined
  const gotContext = (reading: ContextWindow | undefined) => {
    if (!reading?.used) return
    if (reading.used === lastUsed && lastLimit !== undefined && (reading.limit ?? lastLimit) === lastLimit) return
    lastUsed = reading.used
    // A connector's own window, or the catalogue's for the model this run named — so a run
    // with neither carries a reading with no window and draws no ring.
    const limit = reading.limit ?? contextLimit(record.harness, peekRun(sessionId)?.model)
    lastLimit = limit
    patch(sessionId, (r) => {
      r.context = { used: reading.used, limit }
    })
  }

  // stdout is the agent's event stream — render it to readable lines as it arrives, with
  // the parser its own agent brings. stderr is plain text and passes through, whichever
  // kind of command this is: it is where a CLI puts its warnings either way — minus the
  // agent's own housekeeping chatter, which says nothing about the run.
  //
  // `touch` restarts the silence window and is set once the promise below is running, which
  // is where the run can be ended. stdout is listened to even when nothing renders it: a
  // conversation's protocol is still the agent talking.
  let touch = (): void => {}
  let activityVersion = 0
  let endTerminal = () => {}
  child.stdout.on('data', (d: Buffer) => {
    if (renderer) {
      append(renderer.push(d.toString()))
      drainEvents()
      gotResumeId(renderer.resumeId?.())
      gotModel(renderer.model?.())
      gotContext(renderer.context?.())
      afterTurn()
      if (renderer.terminalFailure?.()) endTerminal()
    }
    // After the render, so the window it restarts knows what is in the background now.
    const version = renderer?.activity?.() ?? 0
    if (version !== activityVersion) { activityVersion = version; touch() }
  })
  const errs = createStderrFilter(active.quietStderr)
  child.stderr.on('data', (d: Buffer) => {
    renderer?.stderr?.(d.toString())
    const text = errs.push(d.toString())
    if (text) log.write(text)
  })

  let spawnError: string | undefined
  let spawnFailure: ExecutionFailure | undefined
  let spawnWhy: RunReason | undefined
  child.on('error', (err) => {
    // The one failure worth saying in our own words: the agent's binary isn't on this
    // machine — or isn't on the PATH this run started with. "spawn claude ENOENT" tells a
    // user nothing.
    spawnFailure = executionFailure(err)
    const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
    spawnError = missing
      ? `${cmd} isn't installed, or isn't on this run's PATH. Install it with: ${active.install}`
      : String(err)
    spawnWhy = missing ? { kind: 'notInstalled', args: { cmd, install: active.install } } : undefined
    // No process, so no session either — whatever id the connector would have taken (#1321).
    if (child.pid === undefined) {
      patch(sessionId, (r) => {
        r.unspawned = true
      })
    }
    log.write(`\n[error] ${spawnError}`)
  })

  return await new Promise<number>((resolve) => {
    // Whichever path gets here first wins and the rest are no-ops: the child's own close,
    // and the backstop below.
    let done = false
    // How the conversation ended, on a run the board talked to. It stands in for
    // everything a printing agent's own output would have said.
    let spoken: TurnEnd | undefined
    // The idle clock belongs to this execution.
    let silent = false
    let uncertainAtIdle = false
    let watchdog: ReturnType<typeof createIdleWatchdog> | undefined
    // How a wait between retry attempts is cut short (#525). Set only while one is going,
    // and it is what a stop reaches then: there is no child left to signal.
    let wakeUp: (() => void) | undefined
    const sleep = (ms: number): Promise<void> =>
      new Promise((wake) => {
        const t = setTimeout(() => {
          wakeUp = undefined
          wake()
        }, ms)
        wakeUp = () => {
          clearTimeout(t)
          wakeUp = undefined
          wake()
        }
      })
    const finish = async (code: number | null, wanted: boolean): Promise<void> => {
      if (done) return
      done = true
      let asked = wanted
      watchdog?.close()
      // Its sub-runs end first, so what they leave is in the folder this close reads.
      await stopSubRuns(sessionId)
      const taskCompleted = completed()
      if (taskCompleted && !client?.managedProcess) {
        endChild()
        const mark = runMark(sessionId, agentStartedAt)
        const root = child.pid ? { pid: child.pid, since: agentStartedAt } : undefined
        const until = Date.now() + STOP_GRACE_MS + STOP_CLOSE_MS
        while (!processesStopped(mark, root) && Date.now() < until) await sleep(100)
        if (!processesStopped(mark, root)) {
          spawnError = 'Task completed, but its background processes could not be confirmed stopped.'
          code = 1
        }
      }
      if (renderer) {
        append(renderer.flush())
        drainEvents()
        // The ids may have been in the last partial line, on a very short run.
        gotResumeId(renderer.resumeId?.())
        gotModel(renderer.model?.())
        gotContext(renderer.context?.())
      }
      const errRest = errs.flush()
      if (errRest) log.write(errRest)

      const endedAt = Date.now()
      // A run somebody ended exits non-zero — we killed it — but that is not a failure, so
      // the ask, not the code it died with, names the outcome.
      // An implementation may exit cleanly after recording that it cannot continue. The
      // blocker, not its shell code, makes that run unfinished and keeps the delivery ready
      // for Resume rather than landing incomplete work.
      const blocker = peekRun(sessionId)?.blocker
      // And the same for a CLI that reports a failure on its stream and still exits 0.
      // Only Claude Code does (agent/wire/stream.ts) — read after the flush above, so the
      // closing event is in. A run that failed this way must not close as done: its card
      // would advance and the refinements behind it would run on work that never happened.
      const held = peekRun(sessionId) ?? record
      const rendered = renderer?.failure?.() ?? (!taskCompleted && renderer?.background?.() ? 'The agent exited with unfinished background tasks.' : undefined)
      const said = spawnError ?? (silent ? silenceSaid(silenceFor) : spoken?.error ?? rendered)
      const failed = code !== 0 || spoken?.ok === false || !!rendered || silent || !!blocker
      const failure: ExecutionFailure | undefined = failed && !asked
        ? silent ? makeFailure('runtime', said ?? IDLE_FAILURE.summary, { code: IDLE_FAILURE.code, detail: said ?? IDLE_FAILURE.summary })
          : spawnFailure ?? spoken?.failure ?? renderer?.executionFailure?.()
          ?? (!blocker ? held.validationFailure : undefined)
          ?? makeFailure('runtime', said ?? blocker?.cause ?? `Agent exited with code ${code}.`, {
            code: blocker ? 'execution_blocked' : 'execution_failed',
            detail: said ?? blocker?.cause ?? `Agent exited with code ${code}.`,
          })
        : undefined
      const result = spoken ? spoken.result : renderer?.result()
      let retryPause: RetryPause | undefined
      let retrying = false
      let retryHistory: RetryRecord[] | undefined = held.retryHistory ? [...held.retryHistory] : undefined
      let sessionAction: SessionAction | undefined
      if (failure && !sub && !taskCompleted) {
        const attempt = Math.max(held.retry?.attempt ?? 1, budget?.attempt() ?? 1)
        const missingSession = isSessionMissingFailure(failure)
        const mark = runMark(sessionId, agentStartedAt)
        const root = child.pid ? { pid: child.pid, since: agentStartedAt, identity: held.agentIdentity } : undefined
        const stopped = () => client?.managedProcess ? connectionStopped(root) : processesStopped(mark, root)
        const until = Date.now() + STOP_GRACE_MS + STOP_CLOSE_MS
        while (!stopped() && Date.now() < until) await sleep(100)
        const isStopped = stopped()
        const session = structured && !spawnFailure && !missingSession ? resumeSessionId(held) : undefined
        const unconfirmedCleanup = pendingOperations.size > 0 || !!blocker || spoken?.cleanup?.status === 'unconfirmed'
          || failure.code === 'codex_ownership_unconfirmed'
          || (client?.managedProcess && silent && (uncertainAtIdle || !idleStopConfirmed(spoken?.cleanup, session)))
        const canResetReplay = isStopped && !unconfirmedCleanup && !pendingOperations.size && !submitted
          && (held.unspawned === true || (structured && !hadEffects && !record.resumedFrom))
        const recovery = missingSession
          ? (canResetReplay ? 'replay' : 'unsafe')
          : agentRecovery({
              stopped: isStopped,
              session,
              replayable: canResetReplay,
              unconfirmedCleanup,
            })
        sessionAction = recovery === 'unsafe' ? 'pause_unsafe' : recovery === 'replay' ? 'reset_replay' : 'resume'
        const failedAttempt = retryRecord(failure, attempt, runtimeInfo(), sessionAction)
        retryHistory = [...(retryHistory ?? []), failedAttempt]
        if (recovery === 'unsafe') {
          retryPause = 'unsafe'
        } else {
          const decision = planRetry(failure, attempt, Date.now(), retryBackoff, !!held.cloudExecution)
          if ('pause' in decision) {
            retryPause = decision.pause
          } else {
            const pending = { ...decision.plan, sessionAction }
            patch(sessionId, r => {
              r.failure = failure
              r.error = said ?? failure.summary
              r.retryHistory = retryHistory
              if (sessionAction === 'reset_replay') {
                r.resumeId = undefined
                r.unspawned = true
              }
              r.retry = { attempt, of: pending.of, reason: failure.summary, at: pending.at, since: held.retry?.since ?? held.startedAt, pending }
            })
            event({
              kind: 'retry',
              data: {
                state: 'waiting',
                source: failure.source,
                runtime: runtimeInfo(),
                attempt,
                maxAttempts: pending.of,
                summary: failure.summary,
                ...(failure.detail ? { detail: failure.detail } : {}),
                ...(failure.code ? { code: failure.code } : {}),
                nextRetryAt: new Date(pending.at).toISOString(),
                sessionAction,
                at: failedAttempt.at,
              },
            })
            log.write(`\n[board] ${retryLine(pending, attempt)}\n`)
            if (!stoppedByUser()) {
              const stopped = new Promise<void>(resolve => { wakeUp = resolve })
              await waitForRetry(pending.at, stopped)
              wakeUp = undefined
            }
            retrying = true
          }
        }
        if (retryPause && !stoppedByUser()) {
          event({
            kind: 'retry',
            data: {
              state: 'paused',
              source: failure.source,
              runtime: runtimeInfo(),
              attempt,
              maxAttempts: held.retry?.of ?? MAX_RETRY_ATTEMPTS,
              summary: failure.summary,
              ...(failure.detail ? { detail: failure.detail } : {}),
              ...(failure.code ? { code: failure.code } : {}),
              sessionAction,
              at: failedAttempt.at,
            },
          })
        }
      }
      asked ||= stoppedByUser()
      retrying &&= !asked
      const error = asked ? undefined : joinNotes(said ?? failure?.summary, retryPause ? pauseLine(retryPause) : undefined)
      const status: RunStatus = asked ? 'stopped' : failed || code !== 0 ? 'error' : 'done'
      if (status === 'done' && !sub && retryHistory?.length) {
        const lastRetry = retryHistory[retryHistory.length - 1]!
        event({
          kind: 'retry',
          data: {
            state: 'recovered',
            source: lastRetry.source,
            runtime: runtimeInfo(),
            attempt: Math.max(1, (held.retry?.attempt ?? retryHistory.length + 1) - 1),
            maxAttempts: held.retry?.of ?? MAX_RETRY_ATTEMPTS,
            summary: lastRetry.summary,
            ...(lastRetry.code ? { code: lastRetry.code } : {}),
            at: new Date().toISOString(),
          },
        })
      }
      const reported = spoken ? spoken.costUsd : renderer?.costUsd?.()
      // A session total carries what the session it continues spent (#1480, #1483).
      const totals = reportsSessionTotal(record.harness)
      const sessionTotal = totals ? reported : undefined
      const carriedId = record.continues?.resumeId
      const totalFrom = !totals
        ? undefined
        : record.resumedFrom
          ? record.sessionCostFrom
          : carriedId
            ? record.sessionCostFrom ?? lastSessionTotal(carriedId, readRuns())
            : undefined
      if (status === 'done') saveContext()
      const totalCost = sessionTotal === undefined ? reported : ownCost(sessionTotal, totalFrom)
      const usage = spoken ? spoken.usage : renderer?.usage?.()
      // A connector the board TALKS to hands its reading back with the turn rather than on
      // the stream, so this is where its ring gets its one update (#675).
      if (spoken) gotContext(spoken.context)
      if (!sub) cleanupDiscardedCards(sessionId)
      const changed = sub ? [] : claimChanges(before, sessionId).filter((id) => !peekRun(sessionId)?.discardedCards?.some((c) => c.id === id))
      const original = before
      // The log is closed here and not before it, so what the board had to say about the run
      // sits with the agent's output rather than after the marker that ends it.
      //
      // Stamp the elapsed time through the same stream (not an append after the stream is
      // closed, which would race its pending flush), and hand the same instant to the
      // record so the file and the record agree.
      logFile.write(durationLine(endedAt - record.startedAt))
      if (totalCost !== undefined) logFile.write(costLine(totalCost))
      if (usage) logFile.write(usageLine(usage))
      const model = peekRun(sessionId)?.model
      if (model) logFile.write(modelLine(model))
      // The final message goes to the log behind a marker line, so the file alone is the
      // complete durable record and a later read can split events from message again.
      if (result) logFile.write(`\n${RESULT_MARKER}\n${result}\n`)
      await new Promise<void>((closed) => log.end(closed))

      patch(sessionId, (r) => {
        if (totalCost !== undefined) r.costUsd = totalCost
        r.costIncomplete = (spoken ? spoken.costIncomplete : renderer?.costIncomplete?.()) || undefined
        if (sessionTotal !== undefined) r.sessionCostUsd = sessionTotal
        if (typeof totalFrom === 'number') r.sessionCostFrom = totalFrom
        if (usage) r.usage = usage
        if (result) r.result = result
      })
      // The refines themselves are only for a run that finished. One that failed or was
      // ended left the board half-written, and a refine of half a card is a refine you throw
      // away.
      //
      // Worked out BEFORE the record closes, so anything watching for the run to end sees
      // the note it ended with rather than catching the record a beat too early.
      const settled = status === 'done' && !sub ? settleBoard(record, changed, original) : null
      const note = status === 'done' ? settled?.stalled : undefined
      const noteWhy: RunReason[] = status === 'done' ? settled?.stalledWhy ?? [] : []
      // Only what the board said in its own words has a kind; an agent's own error has none,
      // and a screen shows nothing for it (#1241).
      const saidOurs = !asked && silent && !spawnError
      const errorWhy: RunReason[] = [
        ...(spawnWhy ? [spawnWhy] : []),
        ...(saidOurs ? [{ kind: 'silent' as const, args: { n: String(silenceFor) } }] : []),
      ]
      if (sub) {
        await closeRun(sessionId, {
          status,
          ok: asked ? undefined : status === 'done',
          code: asked ? null : code,
          error,
          failure,
          errorWhy,
          endedAt,
        })
        finishWatch(status === 'done' ? 0 : 1)
        return
      }
      await closeRun(sessionId, {
        status,
        // `ok` stays unset on a stopped run, as it does on one that was cut off: it
        // neither passed nor failed, it was ended.
        ok: asked ? undefined : status === 'done',
        code: asked ? null : code,
        // What went wrong, in whoever's words know: ours when the command wouldn't start or
        // when it went quiet, the agent's own when the conversation ended badly or its
        // stream said so. That cause leads; a card it left half-written follows.
        error,
        failure,
        retryPause,
        retryHistory,
        note,
        errorWhy,
        noteWhy,
        endedAt,
      })
      letGo()
      if (retrying) {
        const next = await resume(sessionId, { automatic: true })
        if ('error' in next) patch(sessionId, (r) => {
          if (r.retry) delete r.retry.pending
          r.error = joinNotes(r.error, `Could not try again: ${next.error}`)
          r.errorWhy = [...r.errorWhy ?? [], { kind: 'retryUnstarted', refusals: [next] }]
        })
      }
      // And the proposer's queue (#534, #1467): every card that reached the archive while this
      // run was up — the one it archived itself, the one its landing completed, a group closed
      // by either. `before` is the board as it stood at the spawn, which is the only record of
      // what was still open then. The board's timer starts the reflection (#1475).
      if (status === 'done') queueCompleted(before.keys())
      if (status === 'done') await followUp(sessionId, record.flowId, settled?.runs ?? [])
      finishWatch(status === 'done' ? 0 : 1)
    }

    // Ending the command ourselves — a stop asked, the silence window ran out, or the
    // conversation is over. It gets a moment to end on its own, then it is killed, and the
    // commands it started go with it (#1302, #1499).
    let ending = false
    const endChild = () => {
      if (ending) return
      ending = true
      try {
        child.stdin?.end()
      } catch {
        // already gone
      }
      if (client?.managedProcess) endConnection(child)
      else endAgent(child, runMark(sessionId), STOP_GRACE_MS)
    }

    finishCompletedTurn = () => { endChild(); void finish(0, false) }

    // Putting the command down and declaring the run over whether or not its pipes come
    // with it. Both endings take this path: a stop, and the silence window running out.
    //
    // Declaring it is not belt and braces. The child's `close` waits on the output PIPE,
    // not on the process: a tool the agent left behind inherits that pipe and can hold it
    // open long after the agent itself is gone, which would leave the run reading as
    // running and its card locked for good.
    const giveUp = (asked: boolean) => {
      endChild()
      after(STOP_GRACE_MS + STOP_CLOSE_MS, () => {
        if (done) return
        // Nothing else is waiting on this process, and something is still holding a pipe
        // open — so leave rather than sit here for as long as it does. The ending path
        // writes the board, so it is awaited first: exiting on the same tick would drop
        // the card's stage, a stopped run's question, and the delivery's next run. The
        // second timer is the bound — a landing that hangs cannot hold the process open.
        after(STOP_FINISH_MS, () => process.exit(0))
        void finish(null, asked).finally(() => process.exit(0))
      })
    }

    endTerminal = () => { watchdog?.close(); giveUp(false) }

    const cancellation = new AbortController()
    const idle = new AbortController()
    let stopped = false
    const stoppedByUser = () => stopped || peekRun(sessionId)?.stopping === true
    const askToStop = () => {
      if (stopped) return
      stopped = true
      cancellation.abort()
      // Waiting between retry attempts (#525): there is no child to signal, so the wait is
      // cut short and the close it was holding open carries on as a stop.
      if (wakeUp) {
        wakeUp()
        return
      }
      if (done) return
      giveUp(true)
    }
    const finishWatch = (code: number) => {
      process.off('SIGTERM', askToStop)
      process.off('SIGINT', askToStop)
      resolve(code)
    }
    process.on('SIGTERM', askToStop)
    process.on('SIGINT', askToStop)

    watchdog = createIdleWatchdog(() => {
      if (done || stopped || silent) return
      silent = true
      log.write(`\n[board] ${silenceSaid(silenceFor)}\n`)
      if (!client?.idleRecovery) { giveUp(false); return }
      uncertainAtIdle = pendingOperations.size > 0
      patch(sessionId, run => { run.cleanup = { status: 'unconfirmed', execution: sessionId, kept: [] } })
      idle.abort()
    }, () => !!(client?.background?.() ?? renderer?.background?.()) || liveSubRuns(sessionId).length > 0)
    touch = watchdog.touch
    observeActivity = watchdog.event

    // The conversation, on a run the board talks to. It is the run: a command that answers
    // back is a server and never exits on its own, so the turn's ending is the run's
    // ending, and the process is closed out after it rather than waited on. What the turn
    // says happened is the verdict — the exit code of a process we killed says nothing.
    if (client) {
      const toAgent = child.stdin
      if (!toAgent) {
        log.write(`\n[error] nothing could be written to ${cmd}, so there was no way to send it the task\n`)
        void finish(1, false)
      } else {
        void client
          .turn({
            stdout: child.stdout,
            stdin: toAgent,
            prompt,
            cwd: workDir,
            // Only a resumed run carries a conversation to continue. A fresh run's session
            // is opened inside the conversation, and its id comes back here.
            resumeId: carriesSession(record) ? record.resumeId : undefined,
            restartPrompt: restart,
            log: append,
            gotResumeId: (id, restarted) => gotResumeId(id, restarted),
            gotModel: (model) => gotModel(model),
            event,
            gotContext,
            completed,
            activity: touch,
            signal: cancellation.signal,
            idleSignal: idle.signal,
          })
          .then((end) => {
            if (done) return
            spoken = end
            if (end.cleanup) patch(sessionId, r => {
              r.cleanup = uncertainAtIdle || silent && pendingOperations.size
                ? { ...end.cleanup!, status: 'unconfirmed' }
                : end.cleanup
            })
            endChild()
            void finish(end.ok ? 0 : 1, peekRun(sessionId)?.stopping === true || stopped)
          })
      }
    }

    // An agent that exited on its own leaves what it put in the background running, in a
    // worktree about to go and often holding the pipe `close` waits on (#1499).
    child.once('exit', () => {
      if (!ending && !client?.managedProcess) killMarked(runMark(sessionId), child.pid ? { pid: child.pid, since: agentStartedAt } : undefined)
    })
    child.on('close', (code) => void finish(code, peekRun(sessionId)?.stopping === true || stopped))
  })
}

const joinNotes = (...parts: (string | null | undefined)[]): string | undefined =>
  parts.filter(Boolean).join('\n\n') || undefined

// The refinement sessions this run leaves behind, worked out but not started, plus
// `stalled` — a refinement loop that ended with its card unsettled (agent/refine.ts). The
// pass's own call on the status stands: nothing out here has read the card.
function settleBoard(
  run: RunRecord,
  changed: readonly number[],
  before: BoardMarks,
): RefinementFollowUp | null {
  try {
    return refinementRunsAfter(run, changed, before)
  } catch {
    // an unreadable board — the run it followed is done either way
    return null
  }
}

// What follows this run: the refinements it requested, and
// refinement on each card it wrote, changed, or set free. Each one is an ordinary run of its
// own, so it shows in the panel with its own log and can be stopped.
//
// Every one joins this run's flow, so the panel shows one job with its sessions on a
// timeline rather than a scatter of unrelated rows.
//
// What was asked for by name goes first — a refine nobody asked for was inferred.
//
// A refusal is not worth reporting: the only one that comes up is a card that already has a
// run on it, and that run is doing more than this one would have. Nothing here can fail the
// run that just ended — it is over.
async function followUp(
  sessionId: string,
  flowId: string | undefined,
  runs: AgentRequest[],
): Promise<void> {
  // A request that already names its flow keeps it — a refinement pass carries its loop's
  // id, and that loop is this flow anyway.
  const join = (req: AgentRequest): AgentRequest =>
    req.flowId || !flowId ? req : { ...req, flowId }
  try {
    const asked = refineRunsAfter(readRefineAsks(sessionId))
    for (const req of asked) await startRun(join(req))
    clearAsks(sessionId)
    for (const req of runs) await startRun(join(req))
  } catch {
    // a spawn that wouldn't — the run it followed is done either way
  }
}

// setTimeout that can't hold this process open on its own.
function after(ms: number, fn: () => void): void {
  const t = setTimeout(fn, ms)
  if (typeof t.unref === 'function') t.unref()
}

// An agent that mints its own session id reports it out of its output stream, so the id
// shows up partway through the run. Save it the moment it does — a stop or a crash a
// second later would otherwise leave a run with no way to continue it. First one wins: an
// agent that names its id more than once is still one conversation.
//
// `restarted` is the one exception: a session opened because the resumed one was gone is a
// DIFFERENT conversation, and the id the run is holding no longer resolves — so it is
// written over, or every resume after this one would reseed from scratch again (#395).
function catchResumeId(sessionId: string, id: string | undefined, restarted = false): boolean {
  if (!id) return false
  patch(sessionId, (r) => {
    if (restarted || !r.resumeId) r.resumeId = id
  })
  return true
}

// The model the agent named for this run, taken the instant its output says one — the
// opening banner, seconds in — so a live run can show what it is working with instead of
// waiting for the end.
function catchModel(sessionId: string, model: string | undefined): boolean {
  if (!model) return false
  patch(sessionId, (r) => {
    if (!r.model) r.model = model
  })
  return true
}
