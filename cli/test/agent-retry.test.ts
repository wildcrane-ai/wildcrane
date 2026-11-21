import assert from 'node:assert/strict'
import { it } from 'node:test'
import { harnessGaps } from '../src/lib/agent/capabilities'
import { HARNESSES } from '../src/lib/agent/harnesses'
import { IDLE_FAILURE } from '../src/lib/agent/idle'
import { backoffMs, isSessionMissingFailure, planRetry, retryContinuePrompt, retryLine, type ExecutionFailure } from '../src/lib/agent/retry'
import { createStreamRenderer } from '../src/lib/agent/wire/claude-stream'
import { createCodexStreamRenderer } from '../src/lib/agent/wire/codex-stream'
import { codexFailure, executionFailure, providerFailure } from '../src/lib/agent/wire/failures'

const overload: ExecutionFailure = { code: 'service_overloaded', source: 'runtime', summary: 'Busy' }
const validation: ExecutionFailure = { code: 'validation_failed', source: 'validation', summary: 'Missing field' }
const syncFail: ExecutionFailure = { code: 'sync_conflict', source: 'sync', summary: 'Board revision changed' }

it('uses one unified 4-attempt budget with 0ms handoff for validation/sync and jittered 15s-60s backoff for others', () => {
  const now = 7_200_000
  for (const immediate of [validation, syncFail]) {
    assert.deepEqual(planRetry(immediate, 1, now), { plan: { at: now, of: 4, failure: immediate } })
    assert.deepEqual(planRetry(immediate, 3, now), { plan: { at: now, of: 4, failure: immediate } })
    assert.deepEqual(planRetry(immediate, 4, now), { pause: 'limit' })
  }
  for (const [index, delay] of [15_000, 30_000, 60_000].entries()) {
    const attempt = index + 1
    for (const failure of [
      IDLE_FAILURE,
      overload,
      executionFailure(Object.assign(new Error('arbitrary'), { code: 'ECONNRESET' })),
      { code: 'unknown', source: 'runtime' as const, summary: 'HTTP 503 Service Unavailable' },
    ]) {
      for (const roll of [0, 0.5, 1]) {
        const decision = planRetry(failure, attempt, now, next => backoffMs(next, () => roll))
        assert.ok('plan' in decision)
        assert.equal(decision.plan.at - now, delay * (1 - 0.25 * roll))
        assert.match(retryLine(decision.plan, attempt, now), new RegExp(`attempt ${attempt + 1} of 4`))
      }
    }
  }
  assert.deepEqual(planRetry(overload, 4, now), { pause: 'limit' })
})

it('honors structured retryAfterMs up to the wait cap without short-circuiting by error tier', () => {
  const reasons = ['Authorization required', 'Rate limit reached', '任意诊断']
  for (const reason of reasons) {
    const failure = providerFailure({ type: 'overloaded_error', headers: { 'Retry-After': '120' } }, reason)
    assert.deepEqual(planRetry(failure, 1, 22), { plan: { at: 120_022, of: 4, failure } })
    assert.deepEqual(planRetry({ ...failure, retryAfterMs: 120_001 }, 1, 22), { pause: 'wait_too_long' })
  }
  assert.equal(providerFailure({ status: 403, type: 'overloaded_error' }, 'Busy').code, 'provider_refused')
  assert.equal(providerFailure({ status: 429, headers: { 'Retry-After': '1' } }, 'Busy').code, 'rate_limited')
  assert.equal(providerFailure({ type: 'rate_limit_error', headers: { 'Retry-After': '0' } }, 'Busy').retryAfterMs, 0)
})

it('detects missing session and missing Codex rollout errors', () => {
  const rollout = codexFailure({ message: 'no rollout found for thread id 01a1f83e-4dc4-7bd3' }, 'Codex failed')
  assert.equal(rollout.code, 'session_not_found')
  assert.equal(isSessionMissingFailure(rollout), true)
  assert.equal(isSessionMissingFailure({ source: 'runtime', summary: 'HTTP 503 Service Unavailable' }), false)
})

it('builds structured diagnostic continuation prompts for retries', () => {
  const prompt = retryContinuePrompt({ source: 'runtime', code: 'connection_lost', summary: 'EOF from app-server', detail: 'stream_disconnected\nreq=1' }, 1, 4)
  assert.match(prompt, /Previous attempt \(1\/4\) failed \[runtime:connection_lost\]: EOF from app-server/)
  assert.match(prompt, /stream_disconnected/)
  assert.match(prompt, /Check the current state/)
})

it('uses terminal Codex events and ignores tool errors and retry prose', () => {
  const renderer = createCodexStreamRenderer()
  const send = (frame: object) => renderer.push(JSON.stringify(frame) + '\n')
  for (const status of [403, 503]) send({ type: 'item.completed', item: { type: 'command_execution', exit_code: 1, aggregated_output: `Expected HTTP ${status} in test fixture` } })
  send({ type: 'error', willRetry: true, message: 'connection lost' })
  assert.equal(renderer.executionFailure?.(), undefined)
  send({ type: 'turn.failed', error: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } } })
  assert.equal(renderer.executionFailure?.()?.code, 'provider_refused')
  assert.equal(renderer.executionFailure?.()?.source, 'runtime')
  for (const message of ['quota exceeded', '503 retry-after: 10']) {
    send({ type: 'turn.failed', error: { message, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } } })
    assert.equal(renderer.executionFailure?.()?.code, 'service_overloaded')
    assert.equal(renderer.executionFailure?.()?.retryAfterMs, undefined)
  }
  send({ type: 'turn.completed' })
  assert.equal(renderer.executionFailure?.(), undefined)
})

it('classifies a confirmed Claude output validation failure regardless of its wording', () => {
  for (const reason of ['Validation failed', '503 retry-after: 1']) {
    const renderer = createStreamRenderer()
    renderer.push('API Error: Connection dropped (ECONNRESET)\n')
    assert.equal(renderer.executionFailure?.(), undefined)
    renderer.push(JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_structured_output_retries', errors: [reason] }) + '\n')
    assert.equal(renderer.executionFailure?.()?.source, 'validation')
    assert.equal(renderer.executionFailure?.()?.code, 'validation_failed')
  }
})

it('offers the shared retry policy for every runtime', () => {
  for (const harness of HARNESSES) assert.equal(harnessGaps(harness).some(g => g.id === 'retry'), false, harness.name)
})
