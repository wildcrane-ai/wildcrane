import { createInterface } from 'node:readline'
import { codexExecution } from './codex-execution'
import { requestCodexBackend } from './codex-server'
import { accountGeneration, executorRecord } from './settings-control'

async function proxy() {
  const generation = accountGeneration()
  if (process.env.WILDCRANE_CODEX_GENERATION !== undefined && process.env.WILDCRANE_CODEX_GENERATION !== generation) throw Error('Codex task belongs to an expired account session.')
  const release = executorRecord()
  const input = createInterface({ input: process.stdin })
  const queued: string[] = []
  let execution: Awaited<ReturnType<typeof codexExecution>> | undefined
  let ending = false
  const send = (message: unknown) => { if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(message) + '\n') }
  const receive = (line: string) => {
    try { execution!.request(JSON.parse(line)) }
    catch { send({ method: 'error', params: { error: { message: 'Invalid Codex request.' } } }) }
  }
  const close = async () => {
    if (ending) return
    ending = true
    await execution?.close()
    input.close(); process.stdin.destroy()
  }
  process.stdout.on('error', () => { void close() })
  input.on('line', line => execution ? receive(line) : queued.push(line))
  input.on('close', () => { void close() })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void close() })
  const timer = setInterval(() => { if (generation !== accountGeneration()) void close() }, 200)
  timer.unref()
  try {
    const argv = process.argv.slice(2)
    const prepared = await requestCodexBackend(argv, process.env)
    execution = await codexExecution(prepared.backend, prepared.config, process.env, process.cwd(), send)
    execution.closed.once('close', () => { void close() })
    if (ending) await execution.close()
    else for (const line of queued) receive(line)
    if (!execution.closed.destroyed) await new Promise<void>(resolve => execution!.closed.once('close', resolve))
  } finally { clearInterval(timer); await execution?.close(); release(); input.close(); process.stdin.destroy() }
}
void proxy().catch(error => {
  process.stdout.write(JSON.stringify({ method: 'error', params: { error: { message: error instanceof Error ? error.message : String(error) } } }) + '\n')
  process.exitCode = 1
})
