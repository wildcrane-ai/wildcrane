// 一次回复启动的子代理摘要（#628）：每个子代理只留标题、状态和用时，以及第一个子代理启动前 agent 说的话。

import type { RunEvent } from '../../cli/src/lib/agent/wire'
import type { Subagents } from './api'

const BEFORE_CHARS = 4096

export function trackSubagents(now = Date.now) {
  const said: string[] = []
  let before: string | null = null
  const items = new Map<string, { title: string; state: 'running' | 'done' | 'failed'; started: number; ms?: number }>()
  return {
    event(e: RunEvent): void {
      if (e.kind === 'message' && before === null) said.push(e.data.text)
      if (e.kind === 'tool_call' && e.data.subagent && !items.has(e.data.toolCallId)) {
        before ??= said.join('\n\n').slice(0, BEFORE_CHARS)
        items.set(e.data.toolCallId, { title: e.data.title, state: 'running', started: now() })
      }
      if (e.kind !== 'tool_call_update') return
      const item = items.get(e.data.toolCallId)
      if (item?.state === 'running' && (e.data.status === 'completed' || e.data.status === 'failed')) {
        item.state = e.data.status === 'completed' ? 'done' : 'failed'
        item.ms = now() - item.started
      }
    },
    /** Null without a subagent; one still running when the reply ends is stopped. */
    summary(): Subagents | undefined {
      if (!items.size) return undefined
      return {
        before: before ?? '',
        items: [...items.values()].map((i) => ({
          title: i.title,
          state: i.state === 'running' ? 'stopped' : i.state,
          duration_ms: i.ms ?? now() - i.started,
        })),
      }
    },
  }
}
