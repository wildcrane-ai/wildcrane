import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { harnessGaps } from '../src/lib/agent/capabilities'
import { HARNESSES } from '../src/lib/agent/harnesses'
import { IDLE_FAILURE } from '../src/lib/agent/idle'
import { backoffMs, isSessionMissingFailure, pauseLine, planRetry, retryBudget, retryContinuePrompt, retryLine, type ExecutionFailure } from '../src/lib/agent/retry'
import { createStreamRenderer } from '../src/lib/agent/wire/claude-stream'
import { createCodexStreamRenderer } from '../src/lib/agent/wire/codex-stream'
import { codexFailure, executionFailure, providerFailure } from '../src/lib/agent/wire/failures'

const overload: ExecutionFailure = { code: 'service_overloaded', source: 'runtime', summary: 'Busy' }
const validation: ExecutionFailure = { code: 'validation_failed', source: 'validation', summary: 'Missing field' }
const syncFail: ExecutionFailure = { code: 'sync_conflict', source: 'sync', summary: 'Board revision changed' }

it('uses English for local retry notices and keeps explicit Runner localization', (t) => {
  const original = process.env.AI4KANBAN_LANGUAGE
  process.env.AI4KANBAN_LANGUAGE = 'zh'
  t.after(() => {
    if (original === undefined) delete process.env.AI4KANBAN_LANGUAGE
    else process.env.AI4KANBAN_LANGUAGE = original
  })
  assert.equal(pauseLine('limit'), 'The automatic retry limit was reached.')
  assert.equal(pauseLine('limit', true), '已达到自动重试次数上限。')
})

it('allows four retries after the original failure with shared backoff', () => {
  const now = 7_200_000
  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.deepEqual(planRetry(validation, attempt, now), { plan: { at: now, of: 4, failure: validation } })
  }
  for (const [index, delay] of [15_000, 30_000, 60_000, 120_000].entries()) {
    const attempt = index + 1
    for (const failure of [
      IDLE_FAILURE,
      syncFail,
      overload,
      executionFailure(Object.assign(new Error('arbitrary'), { code: 'ECONNRESET' })),
      { code: 'unknown', source: 'runtime' as const, summary: 'HTTP 503 Service Unavailable' },
    ]) {
      for (const roll of [0, 0.5, 1]) {
        const decision = planRetry(failure, attempt, now, next => backoffMs(next, () => roll))
        assert.ok('plan' in decision)
        assert.equal(decision.plan.at - now, delay * (1 - 0.25 * roll))
        assert.match(retryLine(decision.plan, attempt, now), new RegExp(`retry ${attempt} of 4`))
      }
    }
  }
  assert.deepEqual(planRetry(overload, 5, now), { pause: 'limit' })
})

it('leaves only the remaining retries for a CLI attaching after Cloud dispatch (#1059)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-retry-'))
  try {
    const counter = join(dir, 'retries')
    const runner = retryBudget(counter, 4)
    const cli = retryBudget(counter)
    assert.equal(cli.attempt(), 4)
    assert.equal(cli.take(), 5)
    assert.equal(runner.take(), undefined)
    assert.equal(retryBudget(counter, 2).attempt(), 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
  assert.match(prompt, /Previous attempt \(1\/5\) failed \[runtime:connection_lost\]: EOF from app-server/)
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
