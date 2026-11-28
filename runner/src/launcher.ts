import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { cloudEndpoints } from '../../cli/src/lib/cloud/config'
import { machineId, runnerCwd } from './home'
import { status, t } from './i18n'
import { acceptAlphaUpdates } from './preferences'
import { EXIT_ALREADY_RUNNING, EXIT_UPDATE } from './protocol'
import { compare, entryOf, install, legacyVersionsDir, versionDir, versionsDir } from './update'
import { busy, hold } from './cache'
import { errno, logRunner, startRunnerLogMaintenance } from './runner-log'

const ASK_MS = 5_000
const CONNECT_MS = 2 * 60_000
const RETRY_MS = 5 * 60_000
const isVersion = (value: unknown): value is string => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)

interface Candidate {
  version: string
  entry: string
  target?: Target
}

interface State {
  verified: string | null
  retry?: { version: string; after: number }
  alpha?: string[]
  rollbackAt?: Record<string, number>
}

const stateFile = () => path.join(versionsDir(), 'state.json')

export function readState(): State {
  try {
    const { verified, good, retry, alpha, rollbackAt } = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Partial<State> & { good?: string[] }
    const last = verified === undefined && Array.isArray(good) ? good[0] : verified
    return { verified: isVersion(last) ? last : null, retry, alpha, rollbackAt }
  } catch {
    return { verified: null }
  }
}

function writeState(state: State): void {
  const staged = `${stateFile()}.${process.pid}.tmp`
  fs.mkdirSync(versionsDir(), { recursive: true })
  fs.writeFileSync(staged, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(staged, stateFile())
}

function verify(candidate: Candidate): void {
  const state = readState()
  const changed = state.verified !== candidate.version
  state.verified = candidate.version
  if (state.retry?.version === candidate.version || (state.retry?.after ?? 0) <= Date.now()) delete state.retry
  if (candidate.target) remember(state, candidate.target)
  writeState(state)
  if (!changed) return
  for (const version of fs.readdirSync(versionsDir()).filter(isVersion)) {
    if (version !== candidate.version && !busy(versionDir(version))) fs.rmSync(versionDir(version), { recursive: true, force: true })
  }
}

function cooling(version: string): boolean {
  const { retry } = readState()
  return retry?.version === version && retry.after > Date.now()
}

interface Target { version: string; restartable: boolean; alpha?: boolean; rollback?: number }

async function askTarget(machine: string): Promise<Target | null> {
  const alpha = acceptAlphaUpdates()
  try {
    const answer = await fetch(`${cloudEndpoints().api}/v1/runner/version?machine=${machine}&alpha=${alpha}`, {
      signal: AbortSignal.timeout(ASK_MS),
    })
    if (!answer.ok) return null
    const { version, restartable, alpha: selectedAlpha, rollback } = (await answer.json()) as Partial<Target>
    if (acceptAlphaUpdates() !== alpha) return null
    return isVersion(version) ? { version, restartable: restartable === true, alpha: selectedAlpha === true, rollback } : null
  } catch {
    return null
  }
}

function waiting(target: Target, current: string): boolean {
  const state = readState()
  return !target.alpha && !!state.alpha?.includes(current) && compare(target.version, current) < 0
    && (target.rollback === undefined || target.rollback === (state.rollbackAt?.[current] ?? 0))
}

function remember(state: State, target: Target): boolean {
  let changed = false
  if (target.alpha && !state.alpha?.includes(target.version)) {
    state.alpha = [...(state.alpha ?? []), target.version]
    changed = true
  }
  if (target.rollback !== undefined && state.rollbackAt?.[target.version] !== target.rollback) {
    state.rollbackAt = { ...state.rollbackAt, [target.version]: target.rollback }
    changed = true
  }
  return changed
}

function verifiedCandidate(): Candidate | null {
  const { verified } = readState()
  if (!verified) return null
  const entry = entryOf(versionDir(verified))
  return fs.existsSync(entry) ? { version: verified, entry } : null
}

export function provenNewer(own: string): string | null {
  const verified = verifiedCandidate()
  return verified && compare(verified.version, own) > 0 ? verified.version : null
}

const cached = (candidate: Candidate): boolean => candidate.entry === entryOf(versionDir(candidate.version))

async function findUpdate(own: Candidate, current: Candidate, source: string, online = false): Promise<Candidate | null> {
  const desired = await askTarget(machineId())
  if (!desired || online && !desired.restartable || waiting(desired, current.version)) return null
  const version = desired.version
  if (version === current.version) return { ...current, target: desired }
  if (cooling(version)) return null
  let entry = own.entry
  if (version !== own.version || !fs.existsSync(entry)) {
    const got = await install(version)
    if (!got.ok) {
      logRunner('launcher', 'update_failed', { version, source, stage: 'download', code: got.why })
      if (got.why === 'node') status(t.nodeTooOld(got.detail))
      else if (online) status(t.updateDownloadFailed())
      return null
    }
    entry = entryOf(got.dir)
  }
  const latest = await askTarget(machineId())
  if (latest?.version !== version || online && !latest.restartable || waiting(latest, current.version)) return null
  logRunner('launcher', 'update_ready', { version, source, stage: 'download' })
  return { version, entry, target: latest }
}

export const pluginOf = (dir: string) => path.join(dir, 'dist', 'plugin.mjs')

export async function pluginEntry(min?: string, source?: string, bundled?: string): Promise<string | null> {
  if (process.env.WILDCRANE_RUNNER_DIR) return pluginOf(process.env.WILDCRANE_RUNNER_DIR)
  const { verified, retry } = readState()
  let names: string[] = []
  try { names = fs.readdirSync(versionsDir()) } catch { /* nothing installed */ }
  const installed = names.filter((v) => isVersion(v) && (!min || compare(v, min) >= 0) && fs.existsSync(pluginOf(versionDir(v))))
    .sort((a, b) => a === verified ? -1 : b === verified ? 1 : compare(b, a))
    .filter((v) => retry?.version !== v || retry.after <= Date.now())
  const current = installed.find((v) => !bundled || compare(v, bundled) >= 0)
  if (current) return pluginOf(versionDir(current))

  const target = await askTarget(machineId())
  // The plugin's own release carries its launcher, even when Cloud targets an older Runner.
  const offered = target && (!bundled || compare(target.version, bundled) >= 0) && !cooling(target.version) ? target.version : undefined
  for (const version of new Set([offered, bundled])) {
    if (!version || min && compare(version, min) < 0) continue
    const got = await install(version)
    if (!got.ok) {
      logRunner('launcher', 'update_failed', { version, source, stage: 'download', code: got.why })
      continue
    }
    if (fs.existsSync(pluginOf(got.dir))) {
      logRunner('launcher', 'update_ready', { version, source, stage: 'download' })
      return pluginOf(got.dir)
    }
  }
  return installed[0] ? pluginOf(versionDir(installed[0])) : null
}

type Outcome = { exit: number } | { failed: 'crashed' | 'timeout' } | { update: Candidate }

export interface LaunchOptions {
  signal?: AbortSignal
  onMessage?: (message: { type?: string }) => void
  onSpawn?: (send: (type: string) => void) => void
  quiet?: boolean
  kind?: string
}

function runOnce(own: Candidate, candidate: Candidate, options: LaunchOptions, trial: boolean): Promise<Outcome> {
  const fields = { version: candidate.version, source: options.kind ?? 'terminal' }
  logRunner('launcher', 'starting', fields)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [candidate.entry], {
      cwd: runnerCwd(),
      stdio: ['ignore', options.quiet ? 2 : 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, WILDCRANE_RUNNER_VERSION: candidate.version, WILDCRANE_RUNNER_KIND: options.kind ?? 'terminal' },
    })
    options.onSpawn?.((type) => { if (child.connected) child.send({ type }, () => {}) })
    let update: Candidate | null = null
    let checking = false
    const check = async () => {
      if (checking || stopping || update) return
      checking = true
      try {
        const next = await findUpdate(own, candidate, fields.source, true)
        if (!next || stopping || !child.connected) return
        if (next.version === candidate.version) {
          const state = readState()
          if (next.target && state.verified === candidate.version && remember(state, next.target)) writeState(state)
          return
        }
        update = next
        child.send({ type: 'update' }, () => {})
      } finally { checking = false }
    }
    const poll = setInterval(() => { if (connected) void check().catch(() => {}) }, Number(process.env.WILDCRANE_UPDATE_MS) || 60_000)
    let connected = false
    let timedOut = false
    let stopping = false
    let duplicate = false
    let forceKill: ReturnType<typeof setTimeout> | undefined
    const timer = trial ? setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000)
    }, Number(process.env.WILDCRANE_CONNECT_MS) || CONNECT_MS) : undefined
    const forward = (signal: NodeJS.Signals) => () => {
      if (stopping) return
      stopping = true
      child.kill(signal)
    }
    const onInt = forward('SIGINT')
    const onTerm = forward('SIGTERM')
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)
    options.signal?.addEventListener('abort', onTerm, { once: true })
    if (options.signal?.aborted) onTerm()

    child.on('message', (message: { type?: string }) => {
      if (message.type === 'update-deferred') {
        if (update) logRunner('launcher', 'update_deferred', { ...fields, version: update.version })
        update = null
      }
      // Older Runner versions wait for the owner to exit.
      if (message.type === 'waiting') {
        duplicate = true
        process.stderr.write(`${t.alreadyRunning()}\n`)
        child.kill('SIGTERM')
        return
      }
      if (timedOut || duplicate || stopping) return
      if (message.type === 'connected' && !connected) {
        connected = true
        logRunner('launcher', 'connected', fields)
        if (timer) clearTimeout(timer)
        if (cached(candidate)) fs.rmSync(legacyVersionsDir(), { recursive: true, force: true })
        verify(candidate)
        if (trial) status(t.updated(candidate.version))
      }
      options.onMessage?.(message)
    })
    let spawnError: Error | undefined
    child.once('error', (error) => { spawnError = error })
    child.once('close', (code, signal) => {
      clearInterval(poll)
      clearTimeout(forceKill)
      if (timer) clearTimeout(timer)
      process.off('SIGINT', onInt)
      process.off('SIGTERM', onTerm)
      options.signal?.removeEventListener('abort', onTerm)
      logRunner('launcher', 'exited', { ...fields, exitCode: code, signal })
      if (spawnError) {
        logRunner('launcher', 'startup_failed', { ...fields, stage: 'spawn', code: errno(spawnError) })
        status(t.spawnFailed(spawnError.message))
        return resolve(trial && !stopping ? { failed: 'crashed' } : { exit: 1 })
      }
      if (duplicate || code === EXIT_ALREADY_RUNNING) {
        logRunner('launcher', 'startup_failed', { ...fields, code: 'already_running' })
        return resolve({ exit: EXIT_ALREADY_RUNNING })
      }
      if (code === EXIT_UPDATE && update && !stopping) return resolve({ update })
      const failed = timedOut ? 'timeout' : 'crashed'
      if (!connected && !stopping && (trial || code === null || code === 1)) {
        logRunner('launcher', 'startup_failed', { ...fields, code: failed })
      }
      resolve(trial && !connected && !stopping ? { failed } : { exit: code ?? (signal ? 1 : 0) })
    })
  })
}

/** Start the Runner and answer the exit code to leave with. */
export async function launch(own: Candidate, options: LaunchOptions = {}): Promise<number> {
  startRunnerLogMaintenance()
  const source = options.kind ?? 'terminal'
  const release = cached(own) ? hold(versionDir(own.version)) : undefined
  try {
    return await supervise(own, source, options)
  } catch (error) {
    logRunner('launcher', 'startup_failed', { version: own.version, source, code: errno(error) })
    throw error
  } finally { release?.() }
}

async function supervise(own: Candidate, source: string, options: LaunchOptions): Promise<number> {
  const verified = verifiedCandidate()
  const current = verified && (cached(own) || compare(verified.version, own.version) > 0) ? verified : own
  let candidate = await findUpdate(own, current, source) ?? current
  let previous = candidate.version === current.version ? null : current
  while (!options.signal?.aborted) {
    if (previous && compare(candidate.version, previous.version) < 0) logRunner('launcher', 'rollback', { version: candidate.version, source })
    const outcome = await runOnce(own, candidate, options, previous !== null)
    if ('exit' in outcome) return outcome.exit
    if ('update' in outcome) {
      const latest = await askTarget(machineId())
      if (!latest?.restartable || latest.version !== outcome.update.version || waiting(latest, candidate.version)) {
        previous = null
        continue
      }
      previous = candidate
      candidate = { ...outcome.update, target: latest }
    } else if (previous) {
      const state = readState()
      state.retry = { version: candidate.version, after: Date.now() + RETRY_MS }
      writeState(state)
      logRunner('launcher', 'rollback', { version: previous.version, source, code: outcome.failed })
      status(t.rolledBack(previous.version))
      candidate = previous
      previous = null
    }
  }
  return 0
}
