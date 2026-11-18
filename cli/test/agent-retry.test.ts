import assert from 'node:assert/strict'
import { it } from 'node:test'
import { harnessGaps } from '../src/lib/agent/capabilities'
import { HARNESSES } from '../src/lib/agent/harnesses'
import { IDLE_FAILURE } from '../src/lib/agent/idle'
import { backoffMs, planRetry, retryLine } from '../src/lib/agent/retry'
import { createStreamRenderer } from '../src/lib/agent/wire/claude-stream'
import { createCodexStreamRenderer } from '../src/lib/agent/wire/codex-stream'
import { executionFailure, providerFailure } from '../src/lib/agent/wire/failures'

const overload = { code: 'service_overloaded', level: 2, reason: 'Busy' } as const
const validation = { code: 'validation_failed', level: 1, reason: 'Missing field' } as const

it('uses one budget across tiers with jittered 15, 30 and 60 second delays', () => {
  const now = 7_200_000
  assert.deepEqual(planRetry(validation, 1, now), { plan: { at: now, of: 2, failure: validation } })
  assert.deepEqual(planRetry(validation, 2, now), { pause: 'limit' })
  for (const [index, delay] of [15_000, 30_000, 60_000].entries()) {
    const attempt = index + 1
    for (const failure of [IDLE_FAILURE, overload, executionFailure(Object.assign(new Error('arbitrary'), { code: 'ECONNRESET' }))]) {
      for (const roll of [0, 0.5, 1]) {
        const decision = planRetry(failure, attempt, now, next => backoffMs(next, () => roll))
        assert.ok('plan' in decision)
        assert.equal(decision.plan.at - now, delay * (1 - 0.25 * roll))
        assert.match(retryLine(decision.plan, attempt, now), new RegExp(`attempt ${attempt + 1} of 4`))
      }
    }
  }
  assert.deepEqual(planRetry(overload, 4, now), { pause: 'limit' })
  assert.deepEqual(planRetry({ code: 'unknown', level: 3, reason: '503 retry-after: 1' }, 1, now), { pause: 'needs-review' })
})

it('uses a structured retry delay without changing the level', () => {
  const reasons = ['Authorization required', 'Rate limit reached', '任意诊断']
  for (const reason of reasons) {
    const failure = providerFailure({ type: 'overloaded_error', headers: { 'Retry-After': '120' } }, reason)
    assert.deepEqual(planRetry(failure, 1, 22), { plan: { at: 120_022, of: 4, failure } })
    assert.deepEqual(planRetry({ ...failure, retryAfterMs: 120_001 }, 1, 22), { pause: 'wait-too-long' })
  }
  assert.equal(providerFailure({ status: 403, type: 'overloaded_error' }, 'Busy').level, 3)
  assert.equal(providerFailure({ status: 429, headers: { 'Retry-After': '1' } }, 'Busy').level, 3)
  assert.equal(providerFailure({ type: 'rate_limit_error' }, 'Busy').level, 2)
  assert.equal(providerFailure({ type: 'rate_limit_error', headers: { 'Retry-After': '0' } }, 'Busy').retryAfterMs, 0)
})

it('uses terminal Codex events and ignores tool errors and retry prose', () => {
  const renderer = createCodexStreamRenderer()
  const send = (frame: object) => renderer.push(JSON.stringify(frame) + '\n')
  send({ type: 'item.completed', item: { type: 'error', message: 'ECONNRESET' } })
  send({ type: 'error', willRetry: true, message: 'connection lost' })
  assert.equal(renderer.executionFailure?.(), undefined)
  for (const message of ['quota exceeded', '503 retry-after: 10']) {
    send({ type: 'turn.failed', error: { message, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } } })
    assert.equal(renderer.executionFailure?.()?.level, 2)
    assert.equal(renderer.executionFailure?.()?.retryAfterMs, undefined)
  }
  send({ type: 'turn.failed', error: { message: '503 retry-after: 10' } })
  assert.equal(renderer.executionFailure?.()?.level, 3)
  send({ type: 'turn.completed' })
  assert.equal(renderer.executionFailure?.(), undefined)
})

it('classifies a confirmed Claude output validation failure regardless of its wording', () => {
  for (const reason of ['Validation failed', '503 retry-after: 1']) {
    const renderer = createStreamRenderer()
    renderer.push('API Error: Connection dropped (ECONNRESET)\n')
    assert.equal(renderer.executionFailure?.(), undefined)
    renderer.push(JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_structured_output_retries', errors: [reason] }) + '\n')
    assert.equal(renderer.executionFailure?.()?.level, 1)
  }
})

it('offers the shared retry policy for every runtime', () => {
  for (const harness of HARNESSES) assert.equal(harnessGaps(harness).some(g => g.id === 'retry'), false, harness.name)
})
