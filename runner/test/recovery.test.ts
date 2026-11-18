import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toWire } from '../src/jobs'
import { checkpointEvent, replayable, type Checkpoint } from '../src/recovery'

test('完成的写入保留副作用标记，未知旧进度不能证明可重放', () => {
  const checkpoint: Checkpoint = { pending: [], effects: false }
  assert.equal(replayable(checkpoint), true)
  checkpointEvent(checkpoint, { kind: 'tool_call', data: { toolCallId: 'write', title: 'write', kind: 'edit', status: 'in_progress' } })
  checkpointEvent(checkpoint, { kind: 'tool_call_update', data: { toolCallId: 'write', status: 'completed' } })
  assert.deepEqual(checkpoint.pending, [])
  assert.equal(replayable(checkpoint), false)
  assert.equal(replayable({ pending: [] }), false)
})

test('恢复状态在活动流中独立成项，避免与错误日志拼接', () => {
  const wire = toWire([
    { kind: 'log', data: { text: 'provider failure' } },
    { kind: 'log', data: { text: '[chat-recovery] waiting' } },
    { kind: 'log', data: { text: 'next attempt' } },
  ], 0)
  assert.deepEqual(wire.map(e => e.text), ['provider failure', '[chat-recovery] waiting', 'next attempt'])
})


test('prompt 已提交但启动结果未知时，不把没有工具事件当作可重放', () => {
  const checkpoint: Checkpoint = { pending: [], effects: false, started: true, session: 'original' }
  checkpointEvent(checkpoint, { kind: 'phase', data: { phase: 'submitted', at: new Date().toISOString() } })
  assert.equal(replayable(checkpoint), false)
})
