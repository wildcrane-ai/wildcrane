import { CONVERSATION_PHASES } from '../../cli/src/lib/shared/conversation'
import type { RunEvent } from '../../cli/src/lib/agent/wire'
import type { ConversationProgress } from './api'

/** One request and one cumulative snapshot per attempt; heartbeats stay independent. */
export function conversationProgress(attempt: number, send: (progress: ConversationProgress) => Promise<void>, valid: () => boolean, unconfirmed: () => void) {
  const state: ConversationProgress = { attempt, phases: {} }
  let pending = false
  let cancelled = false
  let running: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let sentAt = 0
  let finishing = false
  let urgent = false
  const flush = () => {
    clearTimeout(timer); timer = undefined
    if (running || cancelled || !valid()) return
    running = (async () => {
      while (pending && !cancelled && valid()) {
        if (!urgent && !finishing && performance.now() - sentAt < 5_000) {
          timer = setTimeout(flush, 5_000 - (performance.now() - sentAt))
          break
        }
        pending = false
        urgent = false
        sentAt = performance.now()
        try { await send({ ...state, phases: { ...state.phases } }) }
        catch { if (!cancelled && valid()) unconfirmed() }
      }
    })().finally(() => {
      running = undefined
      if (pending && !cancelled && valid()) timer ??= setTimeout(flush, urgent || finishing ? 0 : Math.max(0, 5_000 - (performance.now() - sentAt)))
    })
  }
  return {
    active: () => !cancelled && valid(),
    observe(event: RunEvent, at: string) {
      if (cancelled || !valid()) return
      let immediate = false
      if (event.kind === 'phase' && CONVERSATION_PHASES.includes(event.data.phase)) {
        state.phases![event.data.phase] ??= at
        const rank = CONVERSATION_PHASES.indexOf(event.data.phase)
        if (rank > CONVERSATION_PHASES.indexOf(state.phase as typeof event.data.phase)) {
          state.phase = event.data.phase
          immediate = true
        }
      }
      const content = ['message', 'tool_call', 'tool_call_update', 'plan'].includes(event.kind) || event.kind === 'phase' && !!event.data.contentAt
      if (content) {
        immediate ||= !state.firstContentAt
        state.firstContentAt ??= at
        state.contentAt = at
      }
      if (!content && !immediate) return
      urgent ||= immediate
      pending = true
      if (running) return
      if (immediate || finishing) { clearTimeout(timer); timer = setTimeout(flush, 0) }
      else timer ??= setTimeout(flush, Math.max(0, 5_000 - (performance.now() - sentAt)))
    },
    async drain(ms: number) {
      finishing = true
      const empty = async () => {
        while ((pending || running) && !cancelled && valid()) { flush(); await running }
      }
      let timeout: ReturnType<typeof setTimeout> | undefined
      const done = await Promise.race([empty().then(() => true),
        new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), ms) })])
      clearTimeout(timeout)
      if (!done) { unconfirmed(); cancelled = true; pending = false }
    },
    cancel() { cancelled = true; pending = false; clearTimeout(timer) },
  }
}
