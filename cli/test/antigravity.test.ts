import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { createAntigravityRenderer } from '../src/lib/agent/wire/antigravity'
import { ANTIGRAVITY, antigravityModels } from '../src/lib/agent/harnesses/antigravity'
import { harnessGaps } from '../src/lib/agent/capabilities'
import { checkHarnesses } from '../src/lib/agent/harnesses/check'
import { priceUsd } from '../src/lib/agent/prices'
import { settingArgs } from '../src/lib/agent/run-settings'
import { startRun } from '../src/lib/agent/start'
import { patch } from '../src/lib/agent/sessions'
import { readRuns } from '../src/lib/agent/store'
import { watchRun } from '../src/lib/agent/watch'
import { setBoardRoot } from '../src/lib/paths'
import { forgetMachineState, move, uiConfigOf } from './helpers/board'

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

it('reports the latest AGy request, including cache hits once, through the shared context capability (#824)', t => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-empty-'))
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
  const previous = process.env[homeKey]
  process.env[homeKey] = empty
  t.after(() => {
    if (previous === undefined) delete process.env[homeKey]
    else process.env[homeKey] = previous
    fs.rmSync(empty, { recursive: true, force: true })
  })
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

it('prices default models from the current prompt in the saved conversation (#902)', t => {
  const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined
  if (!sqlite) return t.skip('Node SQLite is unavailable')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cost-'))
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
  const previous = process.env[homeKey]
  process.env[homeKey] = home
  t.after(() => {
    if (previous === undefined) delete process.env[homeKey]
    else process.env[homeKey] = previous
    fs.rmSync(home, { recursive: true, force: true })
  })

  const session = '00000000-0000-0000-0000-000000000902'
  const folder = path.join(home, '.gemini', 'antigravity-cli', 'conversations')
  fs.mkdirSync(folder, { recursive: true })
  const db = new sqlite.DatabaseSync(path.join(folder, `${session}.db`))
  db.exec('CREATE TABLE steps (idx INTEGER, metadata BLOB); CREATE TABLE gen_metadata (data BLOB)')
  const field = (tag: number[], value: Buffer) => Buffer.concat([Buffer.from([...tag, value.length]), value])
  const first = Buffer.from('00000000-0000-0000-0000-000000000001')
  const second = Buffer.from('00000000-0000-0000-0000-000000000002')
  const prompt = db.prepare('INSERT INTO steps VALUES (?, ?)')
  prompt.run(0, field([0x62], first))
  prompt.run(130, field([0x62], second))
  const generation = db.prepare('INSERT INTO gen_metadata VALUES (?)')
  const record = (steps: number[], id: Buffer, model: string) => generation.run(Buffer.concat([
    field([0x12], Buffer.from(steps)),
    field([0x22], id),
    field([0x0a], field([0x9a, 0x01], Buffer.from(model))),
  ]))
  record([1, 0x85, 1], first, 'gemini-4-carbon') // Step 133 belongs to a different prompt.
  record([0x83, 1, 0x84, 1], second, 'gemini-4-hydrogen')
  db.close()

  const run = (resume?: string) => {
    const renderer = createAntigravityRenderer(resume)
    const feed = (event: object) => renderer.push(JSON.stringify(event) + '\n')
    feed({ event: 'init', conversation_id: session, init: {} })
    const step = (step_index: number, step_type: string, usage?: object) => feed({ event: 'step_update', step_update: {
      conversation_id: session, step_index, step_type, state: 'DONE', usage,
    } })
    const usage = { input_tokens: 100, cache_read_tokens: 200, output_tokens: 30 }
    step(resume ? 130 : 0, 'user_input')
    step(1, 'agent_response', usage)
    if (resume) {
      step(131, 'agent_response', usage)
      step(131, 'agent_response', usage)
      step(132, 'checkpoint', usage)
      step(133, 'agent_response', usage)
    }
    feed({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'ok',
      num_turns: resume ? 2 : 1, usage: { input_tokens: 9999, cache_read_tokens: 9999, output_tokens: 9999 },
    } })
    renderer.flush()
    return renderer
  }
  const fresh = run()
  assert.equal(fresh.costUsd?.(), priceUsd('antigravity', 'gemini-4-carbon', { input: 100, cacheRead: 200, output: 30, cacheCreation: 0 }))
  assert.equal(fresh.costIncomplete?.(), undefined)
  const resumed = run(session)
  assert.equal(resumed.costUsd?.(), 2 * (100 * 1.5 + 200 * 0.075 + 30 * 7.5) / 1e6)
  assert.equal(resumed.costIncomplete?.(), true)
  resumed.flush()
  assert.equal(resumed.costUsd?.(), 2 * (100 * 1.5 + 200 * 0.075 + 30 * 7.5) / 1e6)
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
  for (const suffix of ['', '-low', '-medium', '-high', '-xhigh', '-max']) {
    for (const date of ['2026-11-30T23:59:59Z', '2027-01-01T00:00:00Z']) {
      assert.equal(priceUsd('antigravity', `gemini-4-neon${suffix}`, u, Date.parse(date)), 18.15)
    }
  }
  assert.equal(priceUsd('antigravity', 'gemini-3.8-flash-low', u, Date.parse('2026-12-31T23:59:59Z')), 4.575)
  assert.equal(priceUsd('antigravity', 'gemini-3.8-flash', u, Date.parse('2027-01-01T00:00:00Z')), 9.15)
  for (const model of [
    'gemini-pro-orchestrator',
    'gemini-pro-orchestrator-argon',
    'gemini-pro-orchestrator-neon',
    'proxy/gemini-4-carbon',
    'proxy/gemini-4-neon',
    'claude-opus-5-5',
  ]) {
    assert.equal(priceUsd('antigravity', model, u), undefined)
  }
  assert.equal(priceUsd('openai', 'gpt-5.4', u), 17.75)
  assert.equal(priceUsd('endpoint', 'gpt-5.4', u), undefined)
})

it('estimates explicit and default-mode gemini-4-neon runs including background wakeups (#970)', t => {
  const wireUsage = { input_tokens: 1000, cache_read_tokens: 2000, output_tokens: 300 }
  const tokenUsage = { input: 1000, cacheRead: 2000, output: 300, cacheCreation: 0 }
  const expected = priceUsd('antigravity', 'gemini-4-neon', tokenUsage)!

  const explicit = createAntigravityRenderer()
  explicit.push(JSON.stringify({ event: 'init', init: { model: 'gemini-4-neon-high' } }) + '\n')
  explicit.push(JSON.stringify({
    event: 'step_update',
    step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', usage: wireUsage },
  }) + '\n')
  explicit.push(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok', num_turns: 1 } }) + '\n')
  explicit.flush()
  assert.equal(explicit.costUsd?.(), expected)
  assert.equal(explicit.costIncomplete?.(), undefined)

  const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined
  if (!sqlite) return t.skip('Node SQLite is unavailable')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-neon-cost-'))
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
  const previous = process.env[homeKey]
  process.env[homeKey] = home
  t.after(() => {
    if (previous === undefined) delete process.env[homeKey]
    else process.env[homeKey] = previous
    fs.rmSync(home, { recursive: true, force: true })
  })

  const session = '00000000-0000-4000-8000-000000000970'
  const folder = path.join(home, '.gemini', 'antigravity-cli', 'conversations')
  fs.mkdirSync(folder, { recursive: true })
  const db = new sqlite.DatabaseSync(path.join(folder, `${session}.db`))
  db.exec('CREATE TABLE steps (idx INTEGER, metadata BLOB); CREATE TABLE gen_metadata (data BLOB)')
  const p1 = Buffer.from('00000000-0000-4000-8000-000000000201')
  const w1 = Buffer.from('00000000-0000-4000-8000-000000000202')
  db.prepare('INSERT INTO steps VALUES (?, ?)').run(0, protoField([0x62], p1))
  db.prepare('INSERT INTO steps VALUES (?, ?)').run(2, protoField([0x62], w1))
  db.prepare('INSERT INTO steps VALUES (?, ?)').run(3, protoField([0x62], w1))
  db.prepare('INSERT INTO gen_metadata VALUES (?)').run(contextGenRecord([1], p1, undefined, 'gemini-4-neon'))
  db.prepare('INSERT INTO gen_metadata VALUES (?)').run(contextGenRecord([3], w1, undefined, 'gemini-4-neon'))
  db.close()

  const r = createAntigravityRenderer(session)
  const feed = (event: object) => r.push(JSON.stringify(event) + '\n')
  feed({ event: 'init', conversation_id: session, init: {} })
  feed({ event: 'step_update', step_update: { conversation_id: session, step_index: 0, step_type: 'user_input', state: 'DONE' } })
  feed({ event: 'step_update', step_update: { conversation_id: session, step_index: 1, step_type: 'agent_response', state: 'DONE', usage: wireUsage } })
  feed({ event: 'step_update', step_update: { conversation_id: session, step_index: 2, step_type: 'background_task_notification', state: 'DONE' } })
  feed({ event: 'step_update', step_update: { conversation_id: session, step_index: 3, step_type: 'agent_response', state: 'DONE', usage: wireUsage } })
  feed({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'ok', num_turns: 1 } })
  r.flush()
  assert.ok(Math.abs((r.costUsd?.() ?? -1) - 2 * expected) < 1e-12)
  assert.equal(r.costIncomplete?.(), undefined)
})

const varintBytes = (value: number) => {
  const bytes: number[] = []
  let n = value
  do {
    let byte = n & 0x7f
    n = Math.floor(n / 128)
    if (n > 0) byte |= 0x80
    bytes.push(byte)
  } while (n > 0)
  return Buffer.from(bytes)
}
const protoField = (tag: number[], value: Buffer) => Buffer.concat([Buffer.from(tag), varintBytes(value.length), value])
const contextGenRecord = (steps: number[], id: Buffer, limit?: number, model = 'gemini-4-hydrogen') => {
  const f1Parts = [protoField([0x9a, 0x01], Buffer.from(model))]
  if (limit !== undefined) {
    const f10 = Buffer.concat([Buffer.from([0x20]), varintBytes(limit)])
    f1Parts.push(protoField([0x4a], protoField([0x52], f10)))
  }
  return Buffer.concat([
    protoField([0x12], Buffer.concat(steps.map(varintBytes))),
    protoField([0x22], id),
    protoField([0x0a], Buffer.concat(f1Parts)),
  ])
}

it('reads AGy context window limits from local gen_metadata and degrades silently when unavailable (#956)', t => {
  const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined
  if (!sqlite) return t.skip('Node SQLite is unavailable')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ctx-'))
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
  const previous = process.env[homeKey]
  process.env[homeKey] = home
  t.after(() => {
    if (previous === undefined) delete process.env[homeKey]
    else process.env[homeKey] = previous
    fs.rmSync(home, { recursive: true, force: true })
  })

  const folder = path.join(home, '.gemini', 'antigravity-cli', 'conversations')
  fs.mkdirSync(folder, { recursive: true })
  const session = '00000000-0000-4000-8000-000000000956'
  const dbPath = path.join(folder, `${session}.db`)
  const db = new sqlite.DatabaseSync(dbPath)
  db.exec('CREATE TABLE steps (idx INTEGER, metadata BLOB); CREATE TABLE gen_metadata (data BLOB)')
  const p1 = Buffer.from('00000000-0000-4000-8000-000000000001')
  const p2 = Buffer.from('00000000-0000-4000-8000-000000000002')
  const wakeup = Buffer.from('00000000-0000-4000-8000-000000000003')
  const insertStep = db.prepare('INSERT INTO steps VALUES (?, ?)')
  const insertGen = db.prepare('INSERT INTO gen_metadata VALUES (?)')
  insertStep.run(0, protoField([0x62], p1))
  insertGen.run(contextGenRecord([1], p1, 512_000, 'gemini-4-hydrogen'))
  // Delayed write: step 3 metadata added after first context() read.
  // Wakeup step 5 has its own invocation UUID differing from user_input 0 and switches model/limit.
  insertStep.run(5, protoField([0x62], wakeup))
  insertGen.run(contextGenRecord([5], wakeup, 840_000, 'claude-sonnet-5-5-low'))
  // Step 7 under prompt p2 has a missing limit; p1 must not leak its limit onto step 7.
  insertStep.run(6, protoField([0x62], p2))
  insertGen.run(contextGenRecord([7], p1, 256_000, 'gemini-3.8-flash'))
  insertGen.run(contextGenRecord([7], p2, undefined, 'gemini-4-hydrogen'))
  // Step 9 has zero limit; step 11 has conflicting limits.
  insertGen.run(contextGenRecord([9], p2, 0))
  insertGen.run(contextGenRecord([11], p2, 256_000))
  insertGen.run(contextGenRecord([11], p2, 512_000))

  // Default mode (no model in init): live limit on step 1, delayed limit on step 3 resolved at result, wakeup limit on step 5.
  const r = createAntigravityRenderer()
  const feed = (event: object) => r.push(JSON.stringify(event) + '\n')
  const step = (step_index: number, step_type: string, usage?: object) => feed({
    event: 'step_update', step_update: { conversation_id: session, step_index, step_type, state: 'DONE', usage },
  })
  feed({ event: 'init', conversation_id: session, init: {} })
  step(0, 'user_input')
  step(1, 'agent_response', { input_tokens: 1000, cache_read_tokens: 500, output_tokens: 20 })
  assert.deepEqual(r.context?.(), { used: 1500, limit: 512_000 })

  step(3, 'agent_response', { input_tokens: 2000, cache_read_tokens: 500, output_tokens: 20 })
  assert.deepEqual(r.context?.(), { used: 2500 })
  insertGen.run(contextGenRecord([3], p1, 256_000, 'gemini-3.8-flash'))
  feed({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'ok', num_turns: 1 } })
  assert.deepEqual(r.context?.(), { used: 2500, limit: 256_000 })

  step(5, 'agent_response', { input_tokens: 3000, cache_read_tokens: 1000, output_tokens: 20 })
  assert.deepEqual(r.context?.(), { used: 4000, limit: 840_000 })

  // Missing, zero, and conflicting limits degrade silently to { used } without failing.
  step(6, 'user_input')
  step(7, 'agent_response', { input_tokens: 4000, cache_read_tokens: 0, output_tokens: 20 })
  assert.deepEqual(r.context?.(), { used: 4000 })
  step(9, 'agent_response', { input_tokens: 5000, cache_read_tokens: 0, output_tokens: 20 })
  assert.deepEqual(r.context?.(), { used: 5000 })
  step(11, 'agent_response', { input_tokens: 6000, cache_read_tokens: 0, output_tokens: 20 })
  assert.deepEqual(r.context?.(), { used: 6000 })
  r.flush()
  assert.equal(r.failure?.(), undefined)
  db.close()

  // Corrupt DB and missing DB degrade silently without error.
  for (const broken of ['00000000-0000-4000-8000-000000000957', '00000000-0000-4000-8000-000000000958']) {
    if (broken.endsWith('957')) fs.writeFileSync(path.join(folder, `${broken}.db`), 'not sqlite')
    const rr = createAntigravityRenderer()
    rr.push(JSON.stringify({ event: 'init', conversation_id: broken, init: { model: 'gpt-oss-120b-medium' } }) + '\n')
    rr.push(JSON.stringify({ event: 'step_update', step_update: { conversation_id: broken, step_index: 0, step_type: 'user_input', state: 'DONE' } }) + '\n')
    rr.push(JSON.stringify({ event: 'step_update', step_update: { conversation_id: broken, step_index: 1, step_type: 'agent_response', state: 'DONE', usage: { input_tokens: 500, cache_read_tokens: 200, output_tokens: 10 } } }) + '\n')
    rr.push(JSON.stringify({ event: 'result', result: { conversation_id: broken, status: 'SUCCESS', response: 'ok', num_turns: 1 } }) + '\n')
    rr.flush()
    assert.deepEqual(rr.context?.(), { used: 700 })
    assert.equal(rr.failure?.(), undefined)
  }
})

it('prices default-model responses and checkpoints across background wakeups while preserving isolation and conflict checks (#967)', t => {
  const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined
  if (!sqlite) return t.skip('Node SQLite is unavailable')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wakeup-cost-'))
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
  const previous = process.env[homeKey]
  process.env[homeKey] = home
  t.after(() => {
    if (previous === undefined) delete process.env[homeKey]
    else process.env[homeKey] = previous
    fs.rmSync(home, { recursive: true, force: true })
  })

  const folder = path.join(home, '.gemini', 'antigravity-cli', 'conversations')
  fs.mkdirSync(folder, { recursive: true })
  const session = '00000000-0000-4000-8000-000000000967'
  const db = new sqlite.DatabaseSync(path.join(folder, `${session}.db`))
  db.exec('CREATE TABLE steps (idx INTEGER, metadata BLOB); CREATE TABLE gen_metadata (data BLOB)')
  const p1 = Buffer.from('00000000-0000-4000-8000-000000000101')
  const w1 = Buffer.from('00000000-0000-4000-8000-000000000102')
  const p2 = Buffer.from('00000000-0000-4000-8000-000000000103')
  const w2 = Buffer.from('00000000-0000-4000-8000-000000000104')
  const w3 = Buffer.from('00000000-0000-4000-8000-000000000105')
  const insertStep = db.prepare('INSERT INTO steps VALUES (?, ?)')
  const insertGen = db.prepare('INSERT INTO gen_metadata VALUES (?)')

  // Prompt 0 (p1): step 1 has no steps row, step 2 has a malformed-length field 12 -> both fall back to p1.
  // Background wakeup at step 3 starts invocation w1; steps 4 and 5 carry w1 in their own field 12.
  insertStep.run(0, protoField([0x62], p1))
  insertStep.run(2, protoField([0x62], Buffer.from('short')))
  insertStep.run(3, protoField([0x62], w1))
  insertStep.run(4, protoField([0x62], w1))
  insertStep.run(5, protoField([0x62], w1))
  insertGen.run(contextGenRecord([1, 2], p1, undefined, 'gemini-4-carbon'))
  insertGen.run(contextGenRecord([4, 5], w1, undefined, 'gemini-4-hydrogen'))
  // Distractors under the other UUID must not leak or create false conflicts.
  insertGen.run(contextGenRecord([4], p1, undefined, 'gemini-3.8-flash'))
  insertGen.run(contextGenRecord([1], w1, undefined, 'gemini-3.8-flash'))

  // Prompt 10 (p2): step 11 has own UUID w2 (no w2 record; p1/p2 must not leak), step 12 falls back to p2 (p1 must not leak).
  insertStep.run(10, protoField([0x62], p2))
  insertStep.run(11, protoField([0x62], w2))
  insertGen.run(contextGenRecord([11], p2, undefined, 'gemini-4-carbon'))
  insertGen.run(contextGenRecord([11, 12], p1, undefined, 'gemini-4-carbon'))

  // Prompt 20 (p2) wakeup w3: step 21 conflicts under w3; step 22 matches a single model under w3.
  insertStep.run(20, protoField([0x62], p2))
  insertStep.run(21, protoField([0x62], w3))
  insertStep.run(22, protoField([0x62], w3))
  insertGen.run(contextGenRecord([21], w3, undefined, 'gemini-4-hydrogen'))
  insertGen.run(contextGenRecord([21], w3, undefined, 'gemini-4-carbon'))
  insertGen.run(contextGenRecord([22], w3, undefined, 'gemini-4-hydrogen'))
  db.close()

  const wireUsage = { input_tokens: 100, cache_read_tokens: 200, output_tokens: 30 }
  const tokenUsage = { input: 100, cacheRead: 200, output: 30, cacheCreation: 0 }
  const runTurn = (promptIndex: number, items: Array<[number, string]>) => {
    const r = createAntigravityRenderer(session)
    const feed = (event: object) => r.push(JSON.stringify(event) + '\n')
    feed({ event: 'init', conversation_id: session, init: {} })
    feed({ event: 'step_update', step_update: { conversation_id: session, step_index: promptIndex, step_type: 'user_input', state: 'DONE' } })
    for (const [step_index, step_type] of items) {
      feed({ event: 'step_update', step_update: {
        conversation_id: session, step_index, step_type, state: 'DONE',
        ...(step_type === 'agent_response' || step_type === 'checkpoint' ? { usage: wireUsage } : {}),
      } })
    }
    feed({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'ok', num_turns: 1 } })
    r.flush()
    return r
  }

  const woken = runTurn(0, [
    [1, 'agent_response'],
    [2, 'checkpoint'],
    [3, 'background_task_notification'],
    [4, 'agent_response'],
    [5, 'checkpoint'],
  ])
  const carbon = priceUsd('antigravity', 'gemini-4-carbon', tokenUsage)!
  const hydrogen = priceUsd('antigravity', 'gemini-4-hydrogen', tokenUsage)!
  assert.ok(Math.abs((woken.costUsd?.() ?? -1) - (2 * carbon + 2 * hydrogen)) < 1e-12)
  assert.equal(woken.costIncomplete?.(), undefined)

  const isolated = runTurn(10, [[11, 'agent_response'], [12, 'agent_response']])
  assert.equal(isolated.costUsd?.(), undefined)
  assert.equal(isolated.costIncomplete?.(), true)

  const conflicted = runTurn(20, [[21, 'agent_response'], [22, 'checkpoint']])
  assert.equal(conflicted.costUsd?.(), hydrogen)
  assert.equal(conflicted.costIncomplete?.(), true)
})

it('reports AGy live and final context window limits through watchRun (#956)', { timeout: 20_000 }, async t => {
  const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined
  if (!sqlite) return t.skip('Node SQLite is unavailable')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-watch-ctx-'))
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
  const previous = process.env[homeKey]
  const session = '00000000-0000-4000-8000-000000000959'
  try {
    process.env[homeKey] = root
    setBoardRoot(root)
    fs.mkdirSync(path.join(root, 'docs/kanban/todo'), { recursive: true })
    fs.writeFileSync(path.join(root, 'docs/kanban/next-id'), '1\n')
    await move(root, ['create', '--title', 'Context ring watch'])
    const dbFile = path.join(root, '.gemini/antigravity-cli/conversations', `${session}.db`)
    fs.mkdirSync(path.dirname(dbFile), { recursive: true })
    const db = new sqlite.DatabaseSync(dbFile)
    db.exec('CREATE TABLE steps (idx INTEGER, metadata BLOB); CREATE TABLE gen_metadata (data BLOB)')
    const p1 = Buffer.from('00000000-0000-4000-8000-000000000010')
    db.prepare('INSERT INTO steps VALUES (?, ?)').run(0, protoField([0x62], p1))
    db.prepare('INSERT INTO gen_metadata VALUES (?)').run(contextGenRecord([1], p1, 512_000, 'gemini-4-hydrogen'))
    db.prepare('INSERT INTO gen_metadata VALUES (?)').run(contextGenRecord([3], p1, 512_000, 'gemini-4-hydrogen'))
    db.close()

    const gate = path.join(root, 'release')
    const script = path.join(root, 'agy.mjs')
    fs.writeFileSync(script, `
      import fs from 'node:fs';
      const out = e => console.log(JSON.stringify(e));
      out({ event: 'init', conversation_id: ${JSON.stringify(session)}, init: {} });
      out({ event: 'step_update', step_update: { conversation_id: ${JSON.stringify(session)}, step_index: 0, step_type: 'user_input', state: 'DONE' } });
      out({ event: 'step_update', step_update: { conversation_id: ${JSON.stringify(session)}, step_index: 1, step_type: 'agent_response', state: 'DONE', usage: { input_tokens: 12000, cache_read_tokens: 3000, output_tokens: 50 } } });
      const wait = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(gate)})) return;
        clearInterval(wait);
        out({ event: 'step_update', step_update: { conversation_id: ${JSON.stringify(session)}, step_index: 3, step_type: 'agent_response', state: 'DONE', usage: { input_tokens: 2000, cache_read_tokens: 18000, output_tokens: 40 } } });
        out({ event: 'result', result: { conversation_id: ${JSON.stringify(session)}, status: 'SUCCESS', response: 'done', num_turns: 1 } });
      }, 20);
    `)
    fs.writeFileSync(uiConfigOf(root, 'docs', 'kanban'), JSON.stringify({
      runtimes: [{ id: 'global', name: 'Global', harness: 'antigravity', settings: { command: `node ${script}` } }],
    }))
    const started = await startRun({ action: 'clarify', id: 1 })
    if ('error' in started) throw Error(started.error)
    patch(started.run.sessionId, r => { r.pid = process.pid })
    fs.writeFileSync(started.run.logPath, '')
    const watching = watchRun(started.run.sessionId)
    const until = Date.now() + 5000
    while (true) {
      const live = readRuns().find(r => r.sessionId === started.run.sessionId)
      if (live?.context?.used === 15_000 && live.context.limit === 512_000) break
      assert.ok(Date.now() < until, 'expected live context window reading during run')
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    fs.writeFileSync(gate, 'go')
    await watching
    const ended = readRuns().find(r => r.sessionId === started.run.sessionId)!
    assert.equal(ended.status, 'done')
    assert.deepEqual(ended.context, { used: 20_000, limit: 512_000 })
  } finally {
    if (previous === undefined) delete process.env[homeKey]
    else process.env[homeKey] = previous
    forgetMachineState(root)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
