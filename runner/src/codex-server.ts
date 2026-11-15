import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { bounded } from '../../cli/src/lib/shared/conversation'
import { spawnable } from '../../cli/src/lib/agent/spawnable'
import { connectionIdentity as processIdentityFor } from '../../cli/src/lib/agent/connection-process'
import { markEnv, stopMark } from '../../cli/src/lib/agent/stop'
import { obj } from '../../cli/src/lib/agent/wire/json'
import { providerCredentials, threadConfig, tomlValue } from './codex-config'
import { backendFile, CODEX_PROTOCOL, CODEX_TIMEOUT, codexRecordFile, initializeNative, liveBackend, nativeConnection, nativeDirectory, nativeEndpoint, processIdentity, readPrivate, stopNativeBackends, writePrivate, type NativeBackend, type ThreadLease } from './codex-native'
import { runnerCwd } from './home'
import { accountGeneration } from './settings-control'

export { threadConfig } from './codex-config'
export { CODEX_PROTOCOL, codexRecordFile } from './codex-native'
export interface CodexRecord { path: string; token: string; pid: number; instance: string; protocol: number; generation: string }
const entryOf = (name: string) => process.env.RUNNER_DIST ? path.join(process.env.RUNNER_DIST, name) : fileURLToPath(new URL(name, import.meta.url))
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** The machine-lock holder owns this endpoint; executions connect directly to native backends. */
export async function codexServer() {
  fs.mkdirSync(nativeDirectory(), { recursive: true, mode: 0o700 })
  const generation = accountGeneration()
  const token = crypto.randomBytes(32).toString('hex')
  const instance = crypto.randomUUID()
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\wc-codex-runner-${instance}` : nativeEndpoint(`runner-${instance}`).slice(7)
  const record: CodexRecord = { path: address, token, pid: process.pid, instance, protocol: CODEX_PROTOCOL, generation }
  const pending = new Map<string, Promise<NativeBackend>>()
  const sockets = new Set<net.Socket>()
  const idle = new Map<string, number>()
  let closed = false

  const ensure = async (argv: string[], environment: NodeJS.ProcessEnv) => {
    const config = threadConfig(argv, environment)
    const provider = Object.fromEntries(Object.entries(config).filter(([key]) => key === 'model_provider' || key.startsWith('model_providers.')))
    const credentials = providerCredentials(provider, environment)
    const key = crypto.createHash('sha256').update(JSON.stringify([argv[0], environment.CODEX_HOME ?? '', Object.entries(provider).sort(), credentials])).digest('hex')
    if (pending.has(key)) return pending.get(key)!
    const work = (async () => {
      const previous = readPrivate<NativeBackend>(backendFile(key))
      if (previous && previous.generation === generation && liveBackend(previous)) {
        const probe = await nativeConnection(previous, () => {})
        try { await initializeNative(probe) } finally { probe.close() }
        return previous
      }
      if (previous && liveBackend(previous)) throw Error('Codex backend belongs to an expired account session; stop it before reconnecting.')
      const backend: NativeBackend = { ...processIdentity(), key, instance: crypto.randomUUID(), generation, endpoint: nativeEndpoint(key) }
      const extra: string[] = []
      if (process.platform === 'win32') {
        const reservation = net.createServer()
        await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
        const port = (reservation.address() as net.AddressInfo).port
        await new Promise<void>(resolve => reservation.close(() => resolve()))
        backend.endpoint = `ws://127.0.0.1:${port}`
        backend.token = crypto.randomBytes(32).toString('hex')
        const file = path.join(nativeDirectory(), `${key}.token`)
        fs.writeFileSync(file, backend.token, { mode: 0o600 })
        extra.push('--ws-auth', 'capability-token', '--ws-token-file', file)
      }
      const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: environment.CODEX_HOME ?? process.env.CODEX_HOME, OPENAI_API_KEY: undefined, WILDCRANE_JOB: '1' }
      for (const name of Object.keys(env)) if (/^(KANBAN_|AI4KANBAN_EXECUTION|WILDCRANE_FLOW_WORKER|WILDCRANE_CODEX_)/.test(name)) delete env[name]
      Object.assign(env, credentials)
      const log = fs.openSync(path.join(nativeDirectory(), `${key}.log`), 'a', 0o600)
      const start = spawnable(argv[0]!, ['app-server', '--listen', backend.endpoint, ...extra, '-c', 'thread_unload_delay_secs=0', ...Object.entries(provider).flatMap(([name, value]) => ['-c', `${name}=${tomlValue(value)}`])], { cwd: runnerCwd(), env: markEnv(env, stopMark()), detached: process.platform !== 'win32', stdio: ['ignore', log, log] })
      const child = spawn(start.command, start.args, start.options)
      fs.closeSync(log)
      let failure: Error | undefined
      child.on('error', error => { failure = error })
      child.unref()
      backend.pid = child.pid!
      const until = Date.now() + CODEX_TIMEOUT
      try {
        for (;;) {
          if (failure) throw failure
          if (child.exitCode !== null || child.signalCode !== null || Date.now() >= until) throw Error('Codex did not start its native listener. Update Codex to a version supporting persistent local App Server connections.')
          if (backend.endpoint.startsWith('unix://') && !fs.existsSync(backend.endpoint.slice(7))) { await delay(25); continue }
          try {
            const probe = await nativeConnection(backend, () => {})
            try { await initializeNative(probe) } finally { probe.close() }
            break
          } catch (error) { if (Date.now() >= until) throw error; await delay(50) }
        }
        backend.identity = processIdentityFor(child.pid!)
        if (!backend.identity) throw Error('Codex native process identity could not be confirmed.')
        writePrivate(backendFile(key), backend)
        return backend
      } catch (error) { child.kill('SIGKILL'); throw error }
    })()
    pending.set(key, work)
    try { return await work } finally { pending.delete(key) }
  }
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {})
    const timer = setTimeout(() => socket.destroy(), CODEX_TIMEOUT)
    const lines = createInterface({ input: socket })
    let accepted = false
    lines.on('line', line => {
      if (accepted) return
      accepted = true
      void (async () => {
        try {
          const request = JSON.parse(line)
          if (closed || request.token !== token || request.protocol !== CODEX_PROTOCOL || request.generation !== generation || accountGeneration() !== generation) throw Error('Codex Runner ownership expired.')
          if (!Array.isArray(request.argv) || typeof request.argv[0] !== 'string') throw Error('Invalid Codex backend request.')
          socket.end(JSON.stringify({ backend: await ensure(request.argv, obj(request.env) as NodeJS.ProcessEnv) }) + '\n')
        } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n') }
        finally { clearTimeout(timer) }
      })()
    })
    socket.once('close', () => { clearTimeout(timer); sockets.delete(socket) })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address, resolve) })
  if (process.platform !== 'win32') fs.chmodSync(address, 0o600)
  writePrivate(codexRecordFile(), record)
  const sweep = async () => {
    if (closed) return
    retireLegacy(generation)
    for (const name of fs.readdirSync(nativeDirectory()).filter(value => /^[a-f0-9]{64}\.json$/.test(value))) {
      const backend = readPrivate<NativeBackend>(path.join(nativeDirectory(), name))!
      let used = false
      const leases = path.join(nativeDirectory(), 'threads', backend.instance)
      try { used = fs.readdirSync(leases).filter(file => file.endsWith('.json')).some(file => !!readPrivate<ThreadLease>(path.join(leases, file))) } catch {}
      if (used || pending.has(backend.key)) idle.delete(backend.key)
      else {
        const since = idle.get(backend.key) ?? Date.now(); idle.set(backend.key, since)
        if (Date.now() - since > (Number(process.env.WILDCRANE_CODEX_IDLE_MS) || 30_000) && liveBackend(backend)) {
          try { process.kill(backend.pid, 'SIGTERM') } catch {}
        }
      }
    }
  }
  const timer = setInterval(() => void sweep().catch(error => console.error(`runner: Codex cleanup: ${String(error)}`)), 1000)
  timer.unref()
  void sweep()
  const close = async () => {
    if (closed) return
    closed = true; clearInterval(timer); server.close()
    for (const socket of sockets) socket.destroy()
    await Promise.allSettled(pending.values())
    if (readPrivate<CodexRecord>(codexRecordFile())?.instance === instance) fs.rmSync(codexRecordFile(), { force: true })
    if (process.platform !== 'win32') fs.rmSync(address, { force: true })
    if (generation !== accountGeneration()) stopNativeBackends()
  }
  return { env: { WILDCRANE_CODEX_SERVER: codexRecordFile(), WILDCRANE_CODEX_GENERATION: generation, WILDCRANE_CODEX_PROXY: entryOf('codex-proxy.mjs') }, close,
    async shutdown() { stopNativeBackends(); await close() },
  }
}

/** Old tasks drain on their original connection; new work never attaches to the old daemon. */
function retireLegacy(generation: string) {
  const legacy = readPrivate<CodexRecord>(path.join(runnerCwd(), 'codex-service-v2.json'))
  if (!legacy || legacy.generation !== generation) return
  const socket = net.connect(legacy.path)
  socket.on('error', () => socket.destroy())
  socket.once('connect', () => socket.write(JSON.stringify({ token: legacy.token, protocol: 2, generation, control: true }) + '\n'))
  socket.once('data', () => { socket.end(JSON.stringify({ method: 'shutdown' }) + '\n') })
  const timer = setTimeout(() => socket.destroy(), 1000); timer.unref()
  socket.once('close', () => clearTimeout(timer))
}

export async function requestCodexBackend(argv: string[], env: NodeJS.ProcessEnv): Promise<NativeBackend> {
  const until = Date.now() + CODEX_TIMEOUT
  for (;;) {
    const record = readPrivate<CodexRecord>(codexRecordFile())
    if (record && record.generation === accountGeneration()) {
      try {
        return await bounded(new Promise<NativeBackend>((resolve, reject) => {
          const socket = net.connect(record.path)
          let text = ''
          socket.on('error', reject)
          socket.once('connect', () => socket.write(JSON.stringify({ token: record.token, protocol: CODEX_PROTOCOL, generation: accountGeneration(), argv, env }) + '\n'))
          socket.on('data', chunk => {
            text += chunk
            if (!text.includes('\n')) return
            try { const answer = JSON.parse(text.split('\n')[0]!); socket.destroy(); answer.error ? reject(Error(answer.error)) : resolve(answer.backend) } catch (error) { reject(error) }
          })
          socket.once('end', () => { if (!text.includes('\n')) reject(Error('Codex Runner closed during backend preparation.')) })
          socket.setTimeout(Math.max(1, until - Date.now()), () => { socket.destroy(); reject(Error('Codex Runner preparation timed out.')) })
        }), Math.max(1, until - Date.now()), 'Codex Runner preparation timed out.')
      } catch (error) {
        if (Date.now() >= until || !/ENOENT|ECONNREFUSED|closed during/.test(String(error))) throw error
      }
    }
    if (Date.now() >= until) throw Error('No active Runner could prepare Codex. Existing work was preserved.')
    await delay(50)
  }
}
