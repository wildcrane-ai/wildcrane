import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { createIdleWatchdog, IDLE_MS } from '../src/lib/agent/idle'
import { createAntigravityRenderer } from '../src/lib/agent/wire/antigravity'
import { createStreamRenderer } from '../src/lib/agent/wire/claude-stream'
import { createCodexStreamRenderer } from '../src/lib/agent/wire/codex-stream'
import { createKimiStreamRenderer } from '../src/lib/agent/wire/kimi-stream'
import type { RunEvent } from '../src/lib/agent/wire/events'
import type { StreamRenderer } from '../src/lib/agent/wire/stream'

function clock(childProgress?: () => number, activeCommand?: () => boolean) {
  let now = 0
  let expired = 0
  const watch = createIdleWatchdog(() => expired++, { now: () => now, childProgress, activeCommand })
  return {
    watch,
    expired: () => expired,
    hence(ms: number) { now += ms; watch.check() },
    feed(renderer: StreamRenderer, frame: object) {
      const prior = renderer.activity?.()
      renderer.push(JSON.stringify(frame) + '\n')
      if (renderer.activity?.() !== prior) watch.touch()
      for (const event of renderer.events?.() ?? []) watch.event(event)
    },
  }
}

test('a verified live command has a bounded idle grace period without recording progress', () => {
  let running = true
  const capped = clock(undefined, () => running)
  capped.hence(IDLE_MS)
  assert.equal(capped.expired(), 0)
  capped.hence(IDLE_MS - 1)
  assert.equal(capped.expired(), 0)
  capped.hence(1)
  assert.equal(capped.expired(), 1)

  const exited = clock(undefined, () => running)
  exited.hence(IDLE_MS)
  assert.equal(exited.expired(), 0)
  running = false
  exited.hence(1)
  assert.equal(exited.expired(), 1)

  running = true
  const reported = clock(undefined, () => running)
  reported.hence(IDLE_MS)
  reported.watch.event({ kind: 'message', data: { text: 'The tests passed.' } })
  running = false
  reported.hence(IDLE_MS - 1)
  assert.equal(reported.expired(), 0)
  reported.hence(1)
  assert.equal(reported.expired(), 1)
})

test('W-1195 idle replay: an active command and the root waiting for two background tasks cannot reset the idle timer', () => {
  const { watch, hence, expired } = clock()
  // Last two normalized events from W-1195, with the local checkout path replaced.
  const capture = fs.readFileSync('test/fixtures/antigravity/w-1195-idle.events.ndjson', 'utf8')
  const [call, waiting] = capture.trim().split('\n').map(line => JSON.parse(line) as RunEvent)
  watch.event(call!)
  watch.event(waiting!)
  for (let i = 0; i < 4; i++) {
    hence(60_000)
    watch.event(call!)
    watch.event(waiting!)
    watch.event({ kind: 'tool_call_update', data: { toolCallId: '79', status: 'running', result: 'Command is still running.' } })
    watch.event({ kind: 'status', data: { state: 'running', source: 'sync' } })
    watch.event({ kind: 'log', data: { text: `Heartbeat ${i}` } })
  }
  hence(59_999); assert.equal(expired(), 0)
  hence(1); assert.equal(expired(), 1)
  hence(IDLE_MS); assert.equal(expired(), 1)
})

test('a new background command result, subagent output and verified child progress can each extend long work', () => {
  let childAt = 0
  const { watch, hence, expired } = clock(() => childAt)
  watch.event({ kind: 'tool_call', data: { toolCallId: 'command', title: 'Test', kind: 'execute', status: 'in_progress' } })
  hence(240_000)
  const output = (result: string) => watch.event({ kind: 'tool_call_update', data: { toolCallId: 'command', status: 'running', result } })
  output('Built 45/90 targets')
  hence(240_000)
  watch.event({ kind: 'tool_call', data: { toolCallId: 'child', title: 'Check build', kind: 'other', subagent: true, status: 'running' } })
  hence(240_000)
  childAt = 720_000
  watch.check()
  hence(240_000)
  output('Built 90/90 targets')
  watch.event({ kind: 'tool_call_update', data: { toolCallId: 'child', status: 'completed', result: 'Verified outputs' } })
  hence(240_000)
  output('Built 45/90 targets\nHeartbeat at 20:00')
  output('Built 90/90 targets')
  hence(59_999); assert.equal(expired(), 0)
  hence(1); assert.equal(expired(), 1)
})

test('thinking, native retry announcements and transport phases cannot extend the shared clock', () => {
  const { watch, hence, expired } = clock()
  hence(240_000)
  watch.event({ kind: 'status', data: { source: 'codex', state: 'retrying', code: 'service_overloaded' } })
  watch.event({ kind: 'status', data: { source: 'acp', state: 'thinking' } })
  watch.event({ kind: 'phase', data: { phase: 'started', at: 'test', contentAt: 'test' } })
  hence(60_000)
  assert.equal(expired(), 1)
})

test('Antigravity measures command output across repeated polls and accepts subagent output after five minutes', () => {
  const { watch, hence, expired, feed } = clock()
  const r = createAntigravityRenderer()
  const step = (index: number, name: string, output = '', state = 'ACTIVE') => feed(r, {
    event: 'step_update', step_update: {
      step_index: index, step_type: 'tool', state, tool_info: { name, parameters: { CommandId: 'build' }, output },
    },
  })
  step(1, 'run_command')
  step(2, 'invoke_subagent')
  hence(240_000)
  step(3, 'command_status', 'Created At: 00:04\nCommand output:\nCompiled target A', 'DONE')
  hence(180_000)
  step(4, 'command_status', 'Created At: 00:07\nCommand output:\nCompiled target A\nHeartbeat at 00:07', 'DONE')
  hence(60_000)
  step(2, 'invoke_subagent', 'Inspected target A')
  hence(240_000)
  step(5, 'command_status', 'Command exited with code 0.\n\nCommand output:\nCompiled target A\nCompiled target B', 'DONE')
  step(2, 'invoke_subagent', 'Verified both targets', 'DONE')
  feed(r, { event: 'result', result: { status: 'SUCCESS', response: 'Build verified.' } })
  assert.equal(expired(), 0)
  assert.equal(r.result(), 'Build verified.')
  watch.close()
})

test('Antigravity polling ids and timestamps do not count as new background progress', () => {
  const { hence, expired, feed } = clock()
  const r = createAntigravityRenderer()
  for (let i = 0; i < 5; i++) {
    feed(r, { event: 'step_update', step_update: { step_index: i, step_type: 'tool', state: 'DONE',
      tool_info: { name: 'command_status', parameters: { CommandId: 'hung' }, output: `Created At: 00:0${i}\nCommand is running.` } } })
    hence(60_000)
  }
  assert.equal(expired(), 1)
})

test('Claude subagent and Codex and Kimi streams report work while ignoring repeat snapshots', () => {
  for (const [renderer, events] of [
    [createStreamRenderer(), [
      { type: 'system', subtype: 'task_progress', task_id: 'child', usage: { total_tokens: 20, duration_ms: 5 } },
      { type: 'system', subtype: 'task_progress', task_id: 'child', usage: { total_tokens: 20, duration_ms: 10 } },
    ]],
    [createCodexStreamRenderer(), [
      { type: 'item.updated', item: { id: 'command', type: 'command_execution', aggregated_output: 'Compiled target A' } },
      { type: 'item.updated', item: { id: 'command', type: 'command_execution', aggregated_output: 'Compiled target A' } },
    ]],
    [createKimiStreamRenderer('/tmp'), [
      { role: 'assistant', reasoning_content: 'Reviewing the work so far.' },
      { role: 'assistant', reasoning_content: 'Reviewing the work so far.' },
    ]],
  ] as const) {
    const { hence, expired, feed } = clock()
    feed(renderer, { type: 'item.started', item: { id: 'command', type: 'command_execution', command: 'build' } })
    hence(240_000)
    feed(renderer, events[0])
    hence(240_000)
    assert.equal(expired(), 0)
    feed(renderer, events[1])
    hence(60_000)
    assert.equal(expired(), 1)
  }
})
