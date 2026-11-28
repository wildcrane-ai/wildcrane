import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { tryLock } from '../../cli/src/lib/lock'
import { probeRunner, runnerSocketPath as lockPath } from '../../cli/src/lib/machine/runner'

export type Holder = 'claude-code' | 'codex' | 'cursor' | 'dsh' | 'zcode' | 'kimi' | 'terminal'
export type MachineLock = () => Promise<void>
export class RunnerAlreadyRunning extends Error {}

export { lockPath }

function socketIdentity(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file, { bigint: true })
    if (stat.isSocket()) return `${stat.dev}:${stat.ino}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function foreignPid(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Clear an `.owner` directory left behind by a dead Runner whose PID was reused. */
async function clearStaleOwner(ownerDir: string, where: string): Promise<boolean> {
  let entries: string[]
  try { entries = fs.readdirSync(ownerDir) } catch { return false }
  if (entries.length !== 1 || !/^\d+-[a-f0-9-]{36}$/.test(entries[0]!)) return false
  const token = entries[0]!
  const pid = Number(token.split('-')[0])
  const identity = socketIdentity(where)
  const probed = await probeRunner(where)
  if (probed === true) return false
  let stale = foreignPid(pid)
  if (!stale && probed === 'ECONNREFUSED' && identity !== undefined && identity === socketIdentity(where)) {
    try { stale = fs.statSync(where).mtimeMs >= fs.statSync(ownerDir).mtimeMs - 1_000 } catch { stale = false }
  }
  if (!stale) return false
  try { fs.unlinkSync(path.join(ownerDir, token)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
  }
  try { fs.rmdirSync(ownerDir) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') return false
  }
  return true
}

export async function acquireMachine(kind: Holder): Promise<MachineLock> {
  const where = lockPath()
  const unix = process.platform !== 'win32'
  let unlock: (() => void) | undefined
  if (unix) {
    const ownerDir = `${where}.owner`
    fs.mkdirSync(path.dirname(where), { recursive: true, mode: 0o700 })
    // The listening path can disappear while the owner is still alive.
    unlock = tryLock(ownerDir)
    if (!unlock && await clearStaleOwner(ownerDir, where)) unlock = tryLock(ownerDir)
    if (!unlock) throw new RunnerAlreadyRunning()
  }
  const peers = new Set<net.Socket>()
  const listen = () => new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer((peer) => {
      peers.add(peer)
      peer.on('error', () => {}).on('close', () => peers.delete(peer))
      peer.write(`${JSON.stringify({ kind, settings: 1 })}\n`)
    })
    server.once('error', reject)
    server.listen(where, () => {
      server.off('error', reject)
      resolve(server)
    })
  })

  try {
    const server = await listen().catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EADDRINUSE') throw error
      if (!unix) throw new RunnerAlreadyRunning()
      const identity = socketIdentity(where)
      const result = await probeRunner(where)
      if (result === 'ECONNREFUSED' && identity !== undefined && identity === socketIdentity(where)) fs.unlinkSync(where)
      else if (result !== 'ENOENT') throw new RunnerAlreadyRunning()
      return listen().catch((retry: NodeJS.ErrnoException) => {
        if (retry.code === 'EADDRINUSE') throw new RunnerAlreadyRunning()
        throw retry
      })
    })
    let closing: Promise<void> | undefined
    return () => closing ??= new Promise((resolve) => {
      server.close(() => { unlock?.(); resolve() })
      for (const peer of peers) peer.destroy()
    })
  } catch (error) {
    unlock?.()
    throw error
  }
}

/** 旧执行者不识别退出广播时，先要求用户重开插件。 */
export function runnerSettingsSupport(): Promise<boolean | null> {
  return new Promise((resolve) => {
    const peer = net.connect(lockPath())
    let data = '', ended = false
    const finish = (value: boolean | null) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      peer.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), 1000)
    peer.on('error', () => finish(null))
    peer.on('data', (chunk) => {
      data += chunk
      if (!data.includes('\n')) return
      try { finish((JSON.parse(data.split('\n')[0]!) as { settings?: number }).settings === 1) }
      catch { finish(false) }
    })
    peer.on('end', () => finish(false))
  })
}
