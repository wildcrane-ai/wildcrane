import { monitorEventLoopDelay } from 'node:perf_hooks'

export const syncDebug = process.env.WILDCRANE_DEBUG_SYNC === '1'
const counts: Record<string, number> = {}

export function countSync(name: string, amount = 1): void {
  if (syncDebug) counts[name] = (counts[name] ?? 0) + amount
}

export function logSync(event: string, fields: Record<string, unknown> = {}): void {
  if (syncDebug) console.error('[sync-debug]', JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...fields }))
}

if (syncDebug) {
  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  let cpu = process.cpuUsage()
  let at = performance.now()
  setInterval(() => {
    const now = performance.now()
    const used = process.cpuUsage(cpu)
    logSync('health', {
      cpuPercent: Math.round((used.user + used.system) / (now - at) / 10),
      delayMaxMs: Math.round(delay.max / 1e6),
      delayP99Ms: Math.round(delay.percentile(99) / 1e6),
      ...counts,
    })
    for (const name of Object.keys(counts)) delete counts[name]
    cpu = process.cpuUsage()
    at = now
    delay.reset()
  }, 5000).unref()
}
