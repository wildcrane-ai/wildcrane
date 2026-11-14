import assert from 'node:assert/strict'
import { it } from 'node:test'
import { conversationProgress } from '../src/conversation-progress'
import type { ConversationProgress } from '../src/api'
import { CONVERSATION_PHASES } from '../../cli/src/lib/shared/conversation'

it('五阶段合并，慢请求后只发送最新快照与原始时间 (#722)', async () => {
  const sent: ConversationProgress[] = []
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const progress = conversationProgress(1, async snapshot => { sent.push(snapshot); entered(); if (sent.length === 1) await gate }, () => true, () => assert.fail('unconfirmed'))
  progress.observe({ kind: 'phase', data: { phase: 'preparing', at: 'adapter' } }, 'first')
  await started
  for (const phase of CONVERSATION_PHASES) progress.observe({ kind: 'phase', data: { phase, at: 'adapter' } }, phase)
  progress.observe({ kind: 'message', data: { text: 'Hello' } }, 'content')
  assert.equal(sent.length, 1)
  release()
  await progress.drain(1000)
  assert.equal(sent.length, 2)
  assert.equal(sent[1]!.phase, 'started')
  assert.deepEqual(sent[1]!.phases, { preparing: 'first', initialized: 'initialized', ready: 'ready', submitted: 'submitted', started: 'started' })
  assert.equal(sent[1]!.firstContentAt, 'content')
  progress.cancel()
})

it('同轮五阶段只发一次，停止或账号失效废弃待发快照，失败不重复提交 (#722)', async () => {
  const sent: ConversationProgress[] = []
  let valid = true
  const progress = conversationProgress(1, async snapshot => { sent.push(snapshot) }, () => valid, () => assert.fail())
  for (const phase of CONVERSATION_PHASES) progress.observe({ kind: 'phase', data: { phase, at: 'adapter' } }, phase)
  await progress.drain(1000)
  assert.equal(sent.length, 1)
  progress.observe({ kind: 'message', data: { text: 'Next' } }, 'content')
  valid = false
  await progress.drain(1000)
  assert.equal(sent.length, 1)
  progress.cancel()
  let failures = 0
  const failed = conversationProgress(2, async () => { throw new Error('offline') }, () => true, () => failures++)
  failed.observe({ kind: 'phase', data: { phase: 'started', at: 'adapter' } }, 'original')
  await failed.drain(1000)
  assert.equal(failures, 1)
  failed.cancel()
})
