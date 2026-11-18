import type { RunEvent } from './wire/events'

export const IDLE_MS = 5 * 60_000
export const IDLE_TIMEOUT = { milliseconds: IDLE_MS }
export const IDLE_ERROR = 'No response for 5 minutes (idle timeout).'
export const IDLE_FAILURE = { code: 'idle_timeout', level: 2, reason: IDLE_ERROR } as const

/** One execution's clock. Only proven local work suspends it. */
export function createIdleWatchdog(expired: () => void, busy = () => false, milliseconds = IDLE_TIMEOUT.milliseconds, now = Date.now) {
  const calls = new Set<string>()
  const local = new Set<string>()
  const seen = new Map<string, string>()
  let last = now()
  let working = false
  let closed = false
  const touch = () => { if (!closed) last = now() }
  const check = () => {
    if (closed) return
    const active = calls.size > 0 || busy()
    if (active || working) last = now()
    working = active
    if (!active && now() - last >= milliseconds) { close(); expired() }
  }
  const timer = setInterval(check, Math.min(1000, milliseconds))
  timer.unref?.()
  const close = () => { closed = true; clearInterval(timer); calls.clear(); local.clear(); seen.clear() }
  return {
    touch, check, close,
    event(e: RunEvent) {
      if (closed || e.kind === 'log' || e.kind === 'context') return
      if (e.kind === 'phase' && !e.data.contentAt) return
      const key = e.kind === 'tool_call' || e.kind === 'tool_call_update' ? `${e.kind}:${e.data.toolCallId}` : e.kind
      const value = JSON.stringify(e.data)
      if (seen.get(key) === value) return
      seen.set(key, value)
      if (e.kind === 'tool_call' && (e.data.kind === 'execute' || e.data.subagent)) local.add(e.data.toolCallId)
      if (e.kind === 'tool_call' || e.kind === 'tool_call_update') {
        const { toolCallId, status } = e.data
        if (local.has(toolCallId) && ['in_progress', 'running'].includes(status)) calls.add(toolCallId)
        if (['completed', 'failed'].includes(status)) { calls.delete(toolCallId); local.delete(toolCallId) }
      }
      touch()
      check()
    },
  }
}
