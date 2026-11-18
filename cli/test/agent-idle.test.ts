import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createIdleWatchdog, IDLE_MS } from '../src/lib/agent/idle'

test('five minutes of pure waiting; local calls, subagents and background work suspend the clock', () => {
  for (const kind of ['execute', 'subagent', 'background']) {
    let now = 0, expired = 0, busy = false
    const watch = createIdleWatchdog(() => expired++, () => busy, IDLE_MS, () => now)
    const call = { toolCallId: 'a', title: 'work', kind: 'execute' as const, status: 'in_progress', ...(kind === 'subagent' ? { subagent: true as const } : {}) }
    if (kind === 'background') busy = true
    else watch.event({ kind: 'tool_call', data: call })
    now = IDLE_MS * 3; watch.check()
    assert.equal(expired, 0)
    if (kind === 'background') busy = false
    else watch.event({ kind: 'tool_call_update', data: { toolCallId: 'a', status: 'completed' } })
    watch.check()
    now += IDLE_MS - 1; watch.check(); assert.equal(expired, 0)
    now++; watch.check(); assert.equal(expired, 1)
    now += IDLE_MS; watch.check(); assert.equal(expired, 1)
    watch.close()
  }
})

test('model deltas reset the clock; heartbeats and repeated tool updates cannot keep remote calls alive', () => {
  let now = 0, expired = 0
  const watch = createIdleWatchdog(() => expired++, () => false, IDLE_MS, () => now)
  const remote = { kind: 'tool_call' as const, data: { toolCallId: 'remote', title: 'MCP', kind: 'other' as const, status: 'in_progress' } }
  watch.event(remote)
  now = IDLE_MS - 1; watch.touch()
  now += IDLE_MS - 1
  watch.event({ kind: 'log', data: { text: 'heartbeat' } }); watch.event(remote); watch.check()
  assert.equal(expired, 0)
  now++; watch.check(); assert.equal(expired, 1)
  watch.close()
})
