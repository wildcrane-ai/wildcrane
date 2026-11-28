// The Runner itself: sign in once, then stay connected and run what Cloud sends.
// Started by the launcher (launcher.ts), which tells it apart from a crash by its exit code.

import './startup'
import { readSession } from '../../cli/src/lib/cloud/session'
import { machineId, machineName, useRunnerHome } from './home'
import { status, t } from './i18n'
import { EXIT_ALREADY_RUNNING, EXIT_OUTDATED, EXIT_REFUSED, EXIT_UPDATE, VERSION } from './protocol'
import { detectRuntimes } from './runtimes'
import { startRunner } from './connect'
import { signIn } from './signin'
import { settingsAction } from './settings'
import { openSettings } from './settings-server'
import { serveSettingsLink } from './settings-link'
import { acquireMachine, RunnerAlreadyRunning } from './lock'
import { captureRunnerOutput, errno, logRunner } from './runner-log'

const tell = (message: unknown) => process.send?.(message)
const rejectDuplicate = () => {
  process.stderr.write(`${t.alreadyRunning()}\n`, () => process.exit(EXIT_ALREADY_RUNNING))
}

async function main(): Promise<void> {
  useRunnerHome()
  const kind = (['claude-code', 'codex', 'cursor', 'dsh', 'zcode', 'kimi'] as const).find((k) => k === process.env.WILDCRANE_RUNNER_KIND) ?? 'terminal'
  const fields = { version: VERSION, source: process.env.WILDCRANE_RUNNER_KIND ?? kind }
  captureRunnerOutput('runner', fields)
  logRunner('runner', 'starting', fields)
  process.once('exit', exitCode => logRunner('runner', 'exited', { ...fields, exitCode }))
  let lock: Awaited<ReturnType<typeof acquireMachine>>
  try { lock = await acquireMachine(kind) }
  catch (error) {
    const duplicate = error instanceof RunnerAlreadyRunning
    logRunner('runner', 'startup_failed', { ...fields, stage: 'lock', code: duplicate ? 'already_running' : errno(error) })
    if (duplicate) return rejectDuplicate()
    throw error
  }
  if (!readSession()) {
    const failure = await signIn()
    if (failure) {
      logRunner('runner', 'startup_failed', { ...fields, stage: 'signin', code: 'refused' })
      await lock()
      status(t.signInFailed(failure.detail))
      process.exit(EXIT_REFUSED)
    }
    status(t.signedIn())
  }
  tell({ type: 'started' })
  serveSettingsLink(() => openSettings(settingsAction, {}, false))

  const id = machineId()
  const runner = startRunner({
    registration: async () => ({ machineId: id, machineName: machineName(), version: VERSION, runtimes: await detectRuntimes(true) }),
    kind,
    onConnected: () => tell({ type: 'connected' }),
    onReconnecting: () => tell({ type: 'reconnecting' }),
    // Tests shorten the job poll, which stands in when Realtime is out of reach.
    pollMs: Number(process.env.WILDCRANE_POLL_MS) || undefined,
  }, lock)

  process.on('message', (message: { type?: string }) => {
    if (message.type === 'renew') return runner.renew()
    if (message.type !== 'update') return
    status('正在更新 Runner，重启后自动恢复任务…')
    void runner.update().then(() => process.exit(EXIT_UPDATE)).catch((error) => { status(String(error)); tell({ type: 'update-deferred' }) })
  })

  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) return
      stopping = true
      void runner.close().finally(() => {
        status(t.stopped())
        process.exit(0)
      })
    })
  }

  const stop = await runner.stopped
  if (stop.reason === 'already-running') return rejectDuplicate()
  if (stop.reason === 'outdated') {
    status(t.outdated())
    process.exit(EXIT_OUTDATED)
  }
  status(stop.reason === 'elsewhere' ? t.elsewhere(stop.machine) : t.refused(stop.message))
  process.exit(EXIT_REFUSED)
}

void main()
