import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { killMarked, processesStopped } from '../../cli/src/lib/agent/stop'
import { pidAlive, tryLock } from '../../cli/src/lib/lock'
import { CODEX_PROTOCOL, codexRecordFile, type CodexRecord } from './codex-service'
import { runnerCwd } from './home'
import { accountGeneration } from './settings-control'

export { threadConfig } from './codex-service'
const entryOf = (name: string) => process.env.RUNNER_DIST ? path.join(process.env.RUNNER_DIST, name) : fileURLToPath(new URL(name, import.meta.url))
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function readRecord(): CodexRecord | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(codexRecordFile(), 'utf8')) as CodexRecord
    if (!record.path || !record.token || !record.instance || !Number.isSafeInteger(record.pid) || record.pid <= 0 || !Array.isArray(record.backends)) throw Error('Invalid Codex service record.')
    if (record.protocol !== CODEX_PROTOCOL) throw Error('Codex service protocol is incompatible; existing work was preserved.')
    return record
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function attach(record: CodexRecord): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(record.path)
    const timer = setTimeout(() => fail(Error('Codex service did not answer; existing work was preserved.')), 2000)
    const fail = (error: Error) => { clearTimeout(timer); socket.destroy(); reject(error) }
    let buffer = ''
    socket.once('error', fail)
    socket.once('connect', () => socket.write(JSON.stringify({ token: record.token, control: true, protocol: CODEX_PROTOCOL, generation: accountGeneration() }) + '\n'))
    socket.on('data', function hello(chunk) {
      buffer += chunk
      if (!buffer.includes('\n')) return
      try {
        const answer = JSON.parse(buffer.split('\n')[0]!) as CodexRecord
        if (answer.instance !== record.instance || answer.pid !== record.pid || answer.protocol !== CODEX_PROTOCOL || answer.generation !== accountGeneration()) throw Error('Codex service identity changed; existing work was preserved.')
        clearTimeout(timer)
        socket.removeListener('data', hello)
        socket.removeListener('error', fail)
        socket.on('error', () => {})
        resolve(socket)
      } catch (error) { fail(error as Error) }
    })
    socket.once('end', () => fail(Error('Codex service refused this Runner.')))
  })
}

/** Attach to the machine's service; only confirmed dead instances can be replaced. */
async function openService(): Promise<net.Socket> {
  const until = Date.now() + 10_000
  let socket: net.Socket | undefined
  for (;;) {
    const release = tryLock(path.join(runnerCwd(), 'codex-service.start.lock'))
    if (!release) {
      if (Date.now() >= until) throw Error('Codex service startup is busy.')
      await wait(50)
      continue
    }
    try {
      let record = readRecord()
      if (record) {
        try { socket = await attach(record) } catch (error) {
          if (pidAlive(record.pid)) throw error
          for (const backend of record.backends) {
            if (!backend.mark?.name || !backend.mark.value || !Number.isSafeInteger(backend.pid) || !Number.isFinite(backend.since)) throw Error('Cannot identify the old Codex execution; existing work was preserved.')
            killMarked(backend.mark, backend)
            while (!processesStopped(backend.mark, backend)) {
              if (Date.now() >= until) throw Error('Previous Codex execution could not be confirmed stopped.')
              await wait(50)
            }
          }
          fs.rmSync(codexRecordFile(), { force: true })
        }
      }
      if (!socket) {
        const entry = entryOf('codex-service-main.mjs')
        const env = { ...process.env }
        for (const key of Object.keys(env)) if (/^(KANBAN_|AI4KANBAN_EXECUTION|WILDCRANE_FLOW_WORKER|WILDCRANE_CODEX_(SERVER|PROXY)|WILDCRANE_JOB)/.test(key)) delete env[key]
        const log = fs.openSync(path.join(runnerCwd(), 'codex-service.log'), 'a', 0o600)
        let child
        try { child = spawn(process.execPath, [entry], { cwd: runnerCwd(), env, detached: true, stdio: ['ignore', log, log], windowsHide: true }) }
        finally { fs.closeSync(log) }
        let failure: Error | undefined
        child.on('error', error => { failure = error })
        child.unref()
        for (;;) {
          if (failure) throw failure
          record = readRecord()
          if (record) { socket = await attach(record); break }
          if (child.exitCode !== null || Date.now() >= until) throw Error('Codex service failed to start; inspect codex-service.log.')
          await wait(50)
        }
      }
      return socket
    } finally { release() }
  }
}

export async function codexServer() {
  const generation = accountGeneration()
  let socket = await openService()
  let closed = false
  let recovering: Promise<void> | undefined
  const watch = () => socket.once('close', () => {
    if (closed || generation !== accountGeneration()) return
    recovering = (async () => {
      for (let attempt = 0; attempt < 3 && !closed && generation === accountGeneration(); attempt++) {
        try {
          await wait(250 * (attempt + 1))
          if (closed || generation !== accountGeneration()) return
          const next = await openService()
          if (closed || generation !== accountGeneration()) { next.destroy(); return }
          socket = next
          watch()
          return
        } catch { /* A live or uncertain instance must never be replaced. */ }
      }
      if (!closed && generation === accountGeneration()) console.error('runner: Codex service recovery failed; existing task progress was preserved.')
    })()
  })
  watch()
  return {
    env: { WILDCRANE_CODEX_SERVER: codexRecordFile(), WILDCRANE_CODEX_GENERATION: generation, WILDCRANE_CODEX_PROXY: entryOf('codex-proxy.mjs') },
    async close() { closed = true; socket.destroy(); await recovering },
    async shutdown() { closed = true; socket.write(JSON.stringify({ method: 'shutdown' }) + '\n') },
  }
}
