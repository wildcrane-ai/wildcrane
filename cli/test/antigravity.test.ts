import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { createAntigravityRenderer } from '../src/lib/agent/wire/antigravity'
import { ANTIGRAVITY, antigravityModels } from '../src/lib/agent/harnesses/antigravity'
import { harnessGaps } from '../src/lib/agent/capabilities'
import { checkHarnesses } from '../src/lib/agent/harnesses/check'
import { priceUsd } from '../src/lib/agent/prices'
import { settingArgs } from '../src/lib/agent/run-settings'

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'test/fixtures/antigravity', name), 'utf8')
const render = (name: string, resume?: string) => {
  const r = createAntigravityRenderer(resume)
  const text = fixture(`${name}.ndjson`)
  let log = ''
  for (let i = 0; i < text.length; i += 13) log += r.push(text.slice(i, i + 13))
  log += r.flush()
  return { r, log }
}
it('reads real agy output, tool progress and per-prompt usage on a resumed session (#687)', () => {
  const { r, log } = render('tool')
  assert.match(log, /run_command pwd/)
  assert.equal(r.model?.(), 'model-from-agy')
  assert.equal(r.failure?.(), undefined)
  assert.equal(r.usage?.()?.input, 28950)
  const calls = r.events?.().filter(e => e.kind === 'tool_call') ?? []
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0]!.data.toolCallId, calls[1]!.data.toolCallId)
  const a = render('first').r
  const b = render('resume', a.resumeId?.()).r
  assert.equal(b.resumeId?.(), a.resumeId?.())
  assert.equal(b.usage?.()?.input, 10691)
  assert.match(b.result()!, /ANTIGRAVITY_OK/)
})
it('rejects soft denial, invalid models, timeouts, missing results and mismatched sessions (#687)', () => {
  for (const name of ['denied', 'invalid', 'timeout', 'signedout']) assert.ok(render(name).r.failure?.(), name)
  const r = createAntigravityRenderer()
  r.push(fixture('first.ndjson').split('\n').filter(l => !l.includes('"event":"result"')).join('\n'))
  r.flush()
  assert.match(r.failure!()!, /final result|最终结果/)
  for (const status of ['ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING']) {
    const r = createAntigravityRenderer()
    r.push(JSON.stringify({ event: 'result', result: { status, response: '' } }) + '\n')
    r.flush()
    assert.ok(r.failure?.(), status)
  }
  const requested = '00000000-0000-0000-0000-000000000687'
  const wrong = render('missing', requested).r
  assert.ok(wrong.failure?.())
  assert.equal(wrong.resumeId?.(), requested)
  const stderr = createAntigravityRenderer()
  stderr.push(fixture('first.ndjson'))
  stderr.stderr?.(fixture('denied.stderr'))
  stderr.flush()
  assert.equal(stderr.failure?.(), undefined)
})
it('surfaces a real image read error even when agy reports SUCCESS (#825)', () => {
  const { r, log } = render('image-error')
  assert.match(r.failure!()!, /could not read image.*missing\.png.*file does not exist/)
  assert.match(r.result()!, /cannot read the code/)
  assert.match(log, /file does not exist/)
  const read = r.events?.().find(e => e.kind === 'tool_call')
  assert.equal(read?.data.kind, 'read')
})

it('settles recovered image errors by full required paths at the final result (#828)', () => {
  const a = '/attachments/a.png', b = '/attachments/b.png'
  for (const { required, reads, failed } of [
    { required: [], reads: [[a, false], [a, true]], failed: false },
    { required: [a], reads: [['/wrong/a.png', false], [a, true]], failed: false },
    { required: [a], reads: [['/optional.png', false], [a, true]], failed: false },
    { required: [a, b], reads: [[a, true], [b, false]], failed: true },
    { required: [a], reads: [['/wrong/a.png', true]], failed: true },
    { required: [], reads: [[a, false], [b, true]], failed: true },
    { required: [a], reads: [], failed: true },
  ] as { required: string[]; reads: [string, boolean][]; failed: boolean }[]) {
    const r = createAntigravityRenderer(undefined, '/attachments')
    r.setRequiredImages!(required)
    let log = ''
    reads.forEach(([file, ok], step_index) => {
      log += r.push(JSON.stringify({ event: 'step_update', step_update: {
        step_index, state: ok ? 'DONE' : 'ERROR', step_type: 'tool', tool_info: {
          name: 'read_file', parameters: { Path: file === a && ok ? './a.png' : file },
          ...(ok ? {} : { error: { message: 'file does not exist' } }),
        },
      } }) + '\n')
    })
    assert.equal(r.failure?.(), undefined, 'tool errors alone do not fail the turn')
    r.push(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'answer' } }) + '\n')
    r.flush()
    assert.equal(!!r.failure?.(), failed, JSON.stringify({ required, reads }))
    const events = r.events!()
    if (reads.some(([, ok]) => !ok)) {
      assert.match(log, /file does not exist/)
      assert.ok(events.some(e => e.kind === 'tool_call_update' && e.data.status === 'failed'))
    }
    assert.equal(events.some(e => e.kind === 'error'), failed)
  }
})

it('never clears permission or native failures with image success, or carries reads into a later turn (#828)', () => {
  const file = '/attachments/a.png'
  const read = (r: ReturnType<typeof createAntigravityRenderer>, reason?: string) => r.push(JSON.stringify({ event: 'step_update', step_update: {
    step_index: reason ? 0 : 1, state: reason ? 'ERROR' : 'DONE', step_type: 'tool',
    tool_info: { name: 'view_file', parameters: { AbsolutePath: file }, ...(reason ? { error: { message: reason } } : {}) },
  } }) + '\n')
  const result = (r: ReturnType<typeof createAntigravityRenderer>, extra = {}) => r.push(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'answer', ...extra } }) + '\n')
  for (const mode of ['permission', 'native', 'missing', 'session']) {
    const r = createAntigravityRenderer(mode === 'session' ? 'expected' : undefined)
    r.setRequiredImages!([file])
    if (mode === 'session') r.push(JSON.stringify({ event: 'init', conversation_id: 'wrong' }) + '\n')
    if (mode === 'permission') read(r, 'permission denied')
    read(r)
    if (mode !== 'missing') result(r, mode === 'native' ? { error: 'native error' } : mode === 'permission' ? { denied_actions: [{}] } : {})
    r.flush()
    assert.ok(r.failure?.(), mode)
  }
  const r = createAntigravityRenderer()
  r.setRequiredImages!([file])
  read(r)
  result(r)
  assert.equal(r.failure?.(), undefined)
  result(r)
  assert.match(r.failure!()!, /Required image/)
})
it('keeps explicit session selection and model errors; parses only actual model rows (#687)', () => {
  assert.throws(() => ANTIGRAVITY.resumeArgs([], 'missing', '/project'), /session not found/)
  for (const flag of ['--continue', '-c', '--conversation=x', '--remote-agent']) assert.throws(() => ANTIGRAVITY.extraArgs([flag], 'new', '/project'))
  assert.deepEqual(antigravityModels([
    'Fetching available models...',
    'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
    'gemini-4-carbon-high\tGemini 4 Carbon (High)',
    'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
    'gemini-pro-orchestrator\tOrchestrator (Carbon)',
    'model-id\tModel title',
  ].join('\n')), [
    { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
    { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
    { id: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
    { id: 'model-id', name: 'Model title' },
  ])
  assert.deepEqual(
    settingArgs(ANTIGRAVITY, { values: { model: 'gemini-4-carbon', reasoning: 'high' }, secretsSet: [] }),
    ['--model', 'gemini-4-carbon', '--effort', 'high'],
  )
  assert.deepEqual(
    settingArgs(ANTIGRAVITY, { values: { model: 'gemini-4-carbon', reasoning: '' }, secretsSet: [] }),
    ['--model', 'gemini-4-carbon'],
  )
  assert.equal(ANTIGRAVITY.login?.loggedOut('network connection failed'), false)
  assert.equal(ANTIGRAVITY.login?.loggedOut('authentication required'), true)
})

it('reports the latest AGy request, including cache hits once, through the shared context capability (#824)', () => {
  checkHarnesses([ANTIGRAVITY])
  assert.ok(!harnessGaps(ANTIGRAVITY).some(g => g.id === 'context'))
  assert.deepEqual(render('tool').r.context?.(), { used: 9768 })
  assert.deepEqual(render('first').r.context?.(), { used: 10380 })
  assert.deepEqual(render('resume').r.context?.(), { used: 10691 })
  // agy 1.5.9, resumed Gemini request: fresh 2986 + cached 8116, not result's 13871.
  assert.deepEqual(render('cached').r.context?.(), { used: 11102 })
})

it('updates context only on a new completed response, including decreases after compaction (#824)', () => {
  const r = createAntigravityRenderer('session')
  const step = (index: number, usage: unknown, extra = {}) => r.push(JSON.stringify({ event: 'step_update',
    step_update: { conversation_id: 'session', step_index: index, state: 'DONE', step_type: 'agent_response', usage, ...extra },
  }) + '\n')
  const usage = { input_tokens: 100, cache_read_tokens: 900, output_tokens: 800 }
  step(1, usage, { state: 'ACTIVE' })
  assert.equal(r.context?.(), undefined)
  step(1, usage)
  assert.deepEqual(r.context?.(), { used: 1000 })
  step(2, { input_tokens: 10, cache_read_tokens: 0 }, { step_type: 'checkpoint' })
  step(3, { input_tokens: 20, cache_read_tokens: 0 }, { conversation_id: 'another-session' })
  assert.deepEqual(r.context?.(), { used: 1000 })
  step(3, { input_tokens: 200, cache_read_tokens: 100 })
  step(1, usage)
  step(3, usage)
  assert.deepEqual(r.context?.(), { used: 300 })
  r.push(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok', num_turns: 9,
    usage: { input_tokens: 900000, cache_read_tokens: 600000 } } }) + '\n')
  assert.deepEqual(r.context?.(), { used: 300 })
  step(3, usage)
  assert.deepEqual(r.context?.(), { used: 300 })
  let index = 4
  for (const missing of [undefined, {}, { input_tokens: 5 }, { cache_read_tokens: 5 },
    { input_tokens: -1, cache_read_tokens: 5 }, { input_tokens: '5', cache_read_tokens: 0 },
    { input_tokens: 5, cache_read_tokens: -1 }, { input_tokens: 0, cache_read_tokens: 0 }]) {
    step(index++, usage)
    step(index++, missing)
    assert.equal(r.context?.(), undefined)
  }
  const cumulativeOnly = createAntigravityRenderer()
  cumulativeOnly.push(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok', num_turns: 1,
    usage: { input_tokens: 900000, cache_read_tokens: 600000 } } }) + '\n')
  assert.equal(cumulativeOnly.context?.(), undefined)
})

it('counts new response and checkpoint estimates once across resume, results and retry (#826)', () => {
  checkHarnesses([ANTIGRAVITY])
  assert.ok(!harnessGaps(ANTIGRAVITY).some(g => g.id === 'cost'))
  const create = () => {
    const r = createAntigravityRenderer('session')
    r.push(JSON.stringify({ event: 'init', conversation_id: 'session', init: { model: 'gemini-4-hydrogen-high' } }) + '\n')
    return r
  }
  const r = create()
  const step = (index: number, extra = {}, renderer = r) => renderer.push(JSON.stringify({ event: 'step_update', step_update: {
    conversation_id: 'session', step_index: index, step_type: 'agent_response', state: 'DONE',
    usage: { input_tokens: 100, cache_read_tokens: 200, output_tokens: 30, thinking_tokens: 20 }, ...extra,
  } }) + '\n')
  step(7, { state: 'ACTIVE' })
  assert.equal(r.costUsd?.(), undefined)
  step(7)
  step(7)
  step(8, { conversation_id: 'other' })
  const unit = (100 * 1.5 + 200 * 0.075 + 30 * 7.5) / 1e6
  assert.equal(r.costUsd?.(), unit)
  step(8, { step_type: 'checkpoint' })
  const result = (status: string) => r.push(JSON.stringify({ event: 'result', result: {
    conversation_id: 'session', status, response: 'ok', num_turns: 99,
    usage: { input_tokens: 9999999, cache_read_tokens: 99999, output_tokens: 99999 },
  } }) + '\n')
  result('SUCCESS')
  assert.equal(r.costUsd?.(), unit * 2)
  step(7)
  step(9)
  result('ERROR')
  assert.equal(r.costUsd?.(), unit * 3)
  assert.equal(r.costIncomplete?.(), undefined)
  assert.ok(r.failure?.())
  const retry = create()
  step(10, {}, retry)
  assert.equal(retry.costUsd?.(), unit)
})

it('keeps unknown prices and missing counts unknown; preserves zero and marks partial costs (#826)', () => {
  for (const model of [undefined, 'gemini-pro-orchestrator', 'unpublished-model', 'gemini-4-hydrogen']) {
    for (const usage of [undefined, {}, { input_tokens: 1, output_tokens: 2 },
      { input_tokens: -1, output_tokens: 2, cache_read_tokens: 0 },
      { input_tokens: '1', output_tokens: 2, cache_read_tokens: 0 }]) {
      const r = createAntigravityRenderer()
      r.push(JSON.stringify({ event: 'init', init: { model } }) + '\n')
      r.push(JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', usage } }) + '\n')
      assert.equal(r.costUsd?.(), undefined)
      assert.equal(r.costIncomplete?.(), true)
    }
  }
  const r = createAntigravityRenderer()
  r.push(JSON.stringify({ event: 'init', init: { model: 'gemini-4-hydrogen' } }) + '\n')
  const step = (index: number, usage: unknown) => r.push(JSON.stringify({ event: 'step_update', step_update: {
    step_index: index, state: 'DONE', step_type: 'agent_response', usage,
  } }) + '\n')
  step(1, { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 })
  assert.equal(r.costUsd?.(), 0)
  step(2, undefined)
  assert.equal(r.costUsd?.(), 0)
  assert.equal(r.costIncomplete?.(), true)
  assert.equal(render('first').r.costUsd?.(), undefined)
  assert.equal(render('cached').r.costUsd?.(), priceUsd('antigravity', 'gemini-3.8-flash', { input: 2986, cacheRead: 8116, output: 3, cacheCreation: 0 }))
})


it('uses published promotional expiry dates without pricing aliases or changing other providers (#826)', () => {
  const u = { input: 1000000, cacheRead: 1000000, output: 1000000, cacheCreation: 0 }
  for (const model of ['gemini-4-carbon', 'gemini-4-argon-high']) {
    assert.equal(priceUsd('antigravity', model, u, Date.parse('2026-11-30T23:59:59Z')), 12.1)
    assert.equal(priceUsd('antigravity', model, u, Date.parse('2026-12-01T00:00:00Z')), 24.2)
  }
  assert.equal(priceUsd('antigravity', 'gemini-3.8-flash-low', u, Date.parse('2026-12-31T23:59:59Z')), 4.575)
  assert.equal(priceUsd('antigravity', 'gemini-3.8-flash', u, Date.parse('2027-01-01T00:00:00Z')), 9.15)
  for (const model of ['gemini-pro-orchestrator', 'gemini-pro-orchestrator-argon', 'proxy/gemini-4-carbon', 'claude-opus-5-5']) {
    assert.equal(priceUsd('antigravity', model, u), undefined)
  }
  assert.equal(priceUsd('openai', 'gpt-5.4', u), 17.75)
  assert.equal(priceUsd('endpoint', 'gpt-5.4', u), undefined)
})
