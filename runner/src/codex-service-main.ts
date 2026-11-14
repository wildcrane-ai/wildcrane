import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tryLock } from '../../cli/src/lib/lock'
import { hold } from './cache'
import { serveCodex } from './codex-service'
import { runnerCwd, useRunnerHome } from './home'
import { accountGeneration, executorRecord } from './settings-control'

useRunnerHome()
const release = tryLock(path.join(runnerCwd(), 'codex-service.owner.lock'))
if (!release) process.exit(1)
const keep = hold(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
const unregister = executorRecord()
const generation = accountGeneration()
try {
  const service = await serveCodex()
  let idleAt = Date.now()
  const timer = setInterval(() => {
    if (!service.idle()) idleAt = Date.now()
    if (generation !== accountGeneration() || service.idle() && Date.now() - idleAt >= (Number(process.env.WILDCRANE_CODEX_IDLE_MS) || 30_000)) void service.close()
  }, 200)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void service.close() })
  await service.closed
  clearInterval(timer)
} finally { unregister(); keep(); release() }
