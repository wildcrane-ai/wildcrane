import { isPollingTool, progressSnapshots, toolOutput, type RunEvent } from './wire/events'

export const IDLE_MS = 5 * 60_000
export const IDLE_TIMEOUT = { milliseconds: IDLE_MS }
export const IDLE_ERROR = 'No verifiable progress for 5 minutes (idle timeout).'
export const IDLE_FAILURE = { code: 'idle_timeout', source: 'runtime' as const, summary: IDLE_ERROR } as const

interface IdleOptions {
  milliseconds?: number
  now?: () => number
  onProgress?: (at: number) => void
  childProgress?: () => number
  activeCommand?: () => boolean
}

export function createIdleWatchdog(expired: () => void, options: IdleOptions = {}) {
  const { milliseconds = IDLE_TIMEOUT.milliseconds, now = Date.now, onProgress, childProgress, activeCommand } = options
  const calls = new Map<string, 'working' | 'finished' | 'polling'>()
  const fresh = progressSnapshots()
  let last = now()
  let closed = false

  const advance = (at: number) => {
    if (closed || at <= last) return
    last = at
    onProgress?.(at)
  }
  const touch = () => advance(now())
  const check = () => {
    if (closed) return
    const at = now()
    advance(Math.min(childProgress?.() ?? last, at))
    const silence = at - last
    if (silence < milliseconds - 5_000) return
    const waiting = silence < milliseconds * 2 && activeCommand?.()
    if (silence >= milliseconds && !waiting) { close(); expired() }
  }
  const timer = setInterval(check, Math.min(1000, milliseconds))
  timer.unref?.()
  const close = () => { closed = true; clearInterval(timer); calls.clear() }

  return {
    touch, check, close,
    event(e: RunEvent) {
      if (closed) return
      if (e.kind === 'tool_call') {
        const { toolCallId, title, status } = e.data
        if (!toolCallId || calls.has(toolCallId)) return
        const state = isPollingTool(title) ? 'polling' : ['completed', 'failed'].includes(status) ? 'finished' : 'working'
        calls.set(toolCallId, state)
        if (state !== 'polling') touch()
      }
      if (e.kind === 'tool_call_update') {
        const { toolCallId, status, result } = e.data
        const state = calls.get(toolCallId)
        if (state === 'polling') return
        const finished = state === 'working' && ['completed', 'failed'].includes(status)
        if (finished) calls.set(toolCallId, 'finished')
        const newOutput = !!toolCallId && fresh(`tool:${toolCallId}`, toolOutput(result ?? ''))
        if (finished || newOutput) touch()
      }
      if (e.kind === 'message' && e.data.text.trim() && fresh(e.kind, e.data.text.trim())) touch()
      if (e.kind === 'plan' && e.data.entries.length && fresh(e.kind, JSON.stringify(e.data.entries))) touch()
    },
  }
}
