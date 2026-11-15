import { spawnSync, type ChildProcess } from 'node:child_process'
import { pidAlive } from '../lock'

/** Query only the recorded connection process, never its descendants or host environment. */
export function connectionIdentity(pid: number): string | undefined {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToUniversalTime().ToString('o')`], { encoding: 'utf8', timeout: 2000, windowsHide: true })
    : spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' } })
  return result.status === 0 ? result.stdout.trim() || undefined : undefined
}

export function connectionStopped(root?: { pid: number; identity?: string }): boolean {
  if (!root) return true
  if (!pidAlive(root.pid)) return true
  const identity = connectionIdentity(root.pid)
  return !!root.identity && !!identity && identity !== root.identity
}

export function endConnection(child: ChildProcess, grace = 12_000): void {
  child.stdin?.end()
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), grace)
  timer.unref()
  child.once('close', () => clearTimeout(timer))
}

export async function stopConnection(root: { pid: number; identity?: string } | undefined, timeout: number): Promise<boolean> {
  if (connectionStopped(root)) return true
  if (!root?.identity || connectionIdentity(root.pid) !== root.identity) return false
  try { process.kill(root.pid, 'SIGTERM') } catch {}
  const until = Date.now() + timeout
  while (!connectionStopped(root)) {
    if (Date.now() >= until) {
      if (connectionIdentity(root.pid) === root.identity) try { process.kill(root.pid, 'SIGKILL') } catch {}
      return connectionStopped(root)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return true
}
