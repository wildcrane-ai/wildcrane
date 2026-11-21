import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, it } from 'node:test'
import { createCodexStreamRenderer } from '../src/lib/agent/wire/codex-stream.ts'
import { createCodexClient, createCodexConnection } from '../src/lib/agent/wire/codex.ts'
import { streamFinished } from '../src/lib/agent/wire/background.ts'
import { createStreamRenderer } from '../src/lib/agent/wire/claude-stream.ts'
import { CODEX_SETTLE_MS, batch } from '../src/lib/agent/wire/codex-background.ts'
import { BACKGROUND_WAIT } from '../src/lib/agent/settings.ts'
import type { RunEvent } from '../src/lib/agent/wire/index.ts'

const originalWait = BACKGROUND_WAIT.minutes
const originalSettle = { ...CODEX_SETTLE_MS }
afterEach(() => { BACKGROUND_WAIT.minutes = originalWait; Object.assign(CODEX_SETTLE_MS, originalSettle) })
const tick = () => new Promise(r => setImmediate(r))

function server(handle: (method: string, params: any) => any, options?: Parameters<typeof createCodexClient>[0], completed?: () => boolean) {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const calls: { method: string; params: any }[] = []
  const events: RunEvent[] = []
  const notify = (method: string, params: any) => stdout.write(JSON.stringify({ method, params }) + '\n')
  let buf = ''
  stdin.on('data', chunk => {
    buf += chunk
    const lines = buf.split('\n'); buf = lines.pop()!
    for (const line of lines) {
      const request = JSON.parse(line)
      if (!request.method) continue
      calls.push(request)
      if (request.id === undefined) continue
      void Promise.resolve().then(() => handle(request.method, request.params)).then(result => {
        stdout.write(JSON.stringify({ id: request.id, result }) + '\n')
      }, error => stdout.write(JSON.stringify({ id: request.id, error }) + '\n'))
    }
  })
  const client = createCodexClient(options)
  const end = client.turn({ stdout, stdin, prompt: 'original task', cwd: '/tmp', completed, log: () => {}, gotResumeId: () => {}, gotModel: () => {}, event: e => events.push(e) })
  const item = (item: any) => notify('item/completed', { threadId: 'main', turnId: `t${calls.filter(c => c.method === 'turn/start').length}`, item })
  const complete = (id = 't1', status = 'completed') => notify('turn/completed', { threadId: 'main', turn: { id, status, items: [] } })
  const reply = (text: string, id: string) => item({ type: 'agentMessage', id, text })
  return { stdout, stdin, client, end, calls, events, notify, item, complete, reply }
}


it('finishes ordinary turns on old servers without inventing background work', async () => {
  const s = server(method => {
    if (method === 'thread/start') return { thread: { id: 'main' } }
    if (method === 'thread/backgroundTerminals/list') throw { code: -32601, message: 'unknown method' }
    return {}
  })
  await tick(); s.reply('DONE', 'reply'); s.complete()
  assert.equal((await s.end).ok, true)
  assert.equal(s.client.background?.(), 0)
})

for (const { model, provider, hasUsage, expected } of [
  { model: 'gpt-6.2-sol', provider: 'openai', hasUsage: true, expected: 0.71 },
  { model: 'gpt-6.2-astra', provider: 'openai-api', hasUsage: true, expected: 2.84 },
  { model: 'gpt-6.2-sol', provider: 'openai', hasUsage: false },
  { model: 'gpt-6.2-astra', provider: 'endpoint', hasUsage: true },
]) {
  it(`reports the cost for ${model} (${provider}, ${hasUsage ? 'with' : 'without'} usage)`, async () => {
    const s = server(method => method === 'thread/start' ? { thread: { id: 'main', modelProvider: provider }, model } : {})
    await tick()
    if (hasUsage) s.notify('thread/tokenUsage/updated', { threadId: 'main', tokenUsage: {
      total: { inputTokens: 200_000, cachedInputTokens: 100_000, outputTokens: 50_000 },
    } })
    s.reply('DONE', 'reply'); s.complete()
    const end = await s.end
    assert.equal(end.ok, true)
    assert.equal(end.costUsd, expected)
  })
}

it('leaves announced provider retries with Codex and clears waiting on current-turn output (#885)', async () => {
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : {})
  await tick()
  s.notify('turn/started', { threadId: 'main', turn: { id: 't1' } })
  const error = { message: 'Selected model is at capacity.', codexErrorInfo: 'serverOverloaded' }
  s.notify('error', { threadId: 'other', turnId: 't1', willRetry: true, error })
  s.notify('error', { threadId: 'main', turnId: 'old', willRetry: true, error })
  assert.equal(s.events.some(e => e.kind === 'status'), false)
  s.notify('error', { threadId: 'main', turnId: 't1', willRetry: true, error })
  assert.deepEqual(s.events.filter(e => e.kind === 'status').map(e => e.data), [{ state: 'retrying', source: 'codex', code: 'service_overloaded' }])
  s.notify('item/reasoning/textDelta', { threadId: 'main', turnId: 'old', delta: 'stale' })
  assert.equal(s.events.filter(e => e.kind === 'status').at(-1)?.data.state, 'retrying')
  s.notify('item/reasoning/summaryTextDelta', { threadId: 'main', turnId: 't1', delta: 'continuing' })
  assert.equal(s.events.filter(e => e.kind === 'status').at(-1)?.data.state, 'thinking')
  s.reply('Recovered on the original turn', 'reply'); s.complete()
  assert.equal((await s.end).ok, true)
  assert.equal(s.calls.filter(c => c.method === 'turn/start').length, 1)
})


it('fails an unexpected connection close with a pending subagent', async () => {
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : {})
  await tick()
  s.item({ id: 'spawn', type: 'collabAgentToolCall', agentsStates: { a: { status: 'running' } } })
  s.stdout.destroy()
  assert.equal((await s.end).ok, false)
})


it('translates standard exec plans without changing provider, sandbox, language or resume intent', () => {
  const converted = createCodexConnection(['codex', 'exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_provider=private', '-c', 'developer_instructions="中文"', '--model', 'test', '--add-dir', '/project', 'fork', 'parent'])!
  assert.equal(converted.argv[1], 'app-server')
  assert.ok(converted.argv.includes('model_provider=private'))
  assert.ok(converted.argv.includes('developer_instructions="中文"'))
  assert.ok(converted.argv.includes('sandbox_mode="danger-full-access"'))
  assert.ok(converted.argv.includes('model="test"'))
  assert.ok(converted.argv.includes('sandbox_workspace_write.writable_roots=["/project"]'))
  assert.equal(createCodexConnection(['custom', 'exec', '--output-last-message', 'answer.txt']), undefined)
})

it('does not close Claude input on its first reply while background work remains', () => {
  const r = createStreamRenderer()
  const push = (event: any) => r.push(JSON.stringify(event) + '\n')
  push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a' }] })
  push({ type: 'result', result: 'STARTED' })
  assert.equal(streamFinished(r), false)
  push({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
  assert.equal(streamFinished(r), false)
  push({ type: 'result', result: 'FINISHED' })
  assert.equal(streamFinished(r), true)
})

it('reads legacy exec subagent states without treating a spawn as completed work', () => {
  const r = createCodexStreamRenderer()
  const item = (id: string, status: string) => r.push(JSON.stringify({ type: 'item.completed', item: {
    id, type: 'collab_tool_call', tool: 'spawn_agent', agents_states: { a: { status, message: status === 'completed' ? 'RESULT' : null } },
  } }) + '\n')
  item('spawn', 'running')
  assert.equal(r.background?.(), 1)
  item('wait', 'completed')
  item('spawn', 'running')
  item('close', 'shutdown')
  assert.equal(r.failure?.(), undefined)
  assert.equal(r.background?.(), 0)
  assert.equal(r.events?.().filter(e => e.kind === 'tool_call_update').length, 1)
})



it('lets the main agent recover from a foreground command failure', async () => {
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : { data: [] })
  await tick()
  s.notify('item/started', { threadId: 'main', item: { id: 'cmd', type: 'commandExecution', command: 'test', processId: '1', status: 'inProgress' } })
  s.item({ id: 'cmd', type: 'commandExecution', command: 'test', status: 'failed', exitCode: 1, aggregatedOutput: 'retry needed' })
  s.reply('Fixed and verified', 'reply'); s.complete()
  assert.equal((await s.end).ok, true)
})



for (const mode of ['resume', 'fork'] as const) {
  it(`preserves missing-session recovery when Codex cannot ${mode} its saved rollout`, async () => {
    const s = server(method => {
      if (method === `thread/${mode}`) throw { code: -32600, message: 'no rollout found for thread id missing' }
      return {}
    }, { mode, threadId: 'missing', images: [] })
    const end = await s.end
    assert.equal(end.ok, false)
    assert.match(end.error!, /no rollout found/)
    assert.equal(end.failure?.code === 'codex_fork_source_missing', mode === 'fork')
    assert.equal(s.calls.some(c => c.method === 'turn/start'), false)
  })
}


it('confirms a new turn without waiting for its first content, ignoring resume history', async () => {
  const s = server(method => method === 'thread/resume' ? { thread: { id: 'main', turns: [{ id: 'old' }] } } : {} , { mode: 'resume', threadId: 'main', images: [] })
  await tick()
  s.notify('turn/started', { threadId: 'main', turn: { id: 'old' } })
  assert.equal(s.events.some(e => e.kind === 'phase' && e.data.phase === 'started'), false)
  s.notify('turn/started', { threadId: 'main', turn: { id: 't1' } })
  assert.equal(s.events.some(e => e.kind === 'phase' && e.data.phase === 'started'), true)
  assert.equal(s.events.some(e => e.kind === 'message'), false)
  s.reply('DONE', 'answer'); s.complete()
  assert.equal((await s.end).ok, true)
})

it('bounds initialize and never submits a prompt after its timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const s = server(() => new Promise(() => {}))
  t.mock.timers.tick(60_001)
  const end = await s.end
  assert.match(end.error!, /initialize timed out/)
  assert.equal(s.calls.some(c => c.method === 'turn/start'), false)
  s.stdout.destroy()
})

it('does not repeat a prompt whose start response is lost', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : method === 'turn/start' ? new Promise(() => {}) : {})
  await tick()
  t.mock.timers.tick(15_001)
  const end = await s.end
  assert.match(end.error!, /submission outcome is unknown/)
  assert.equal(s.calls.filter(c => c.method === 'turn/start').length, 1)
  s.stdout.destroy()
})

it('prices a discussion fork from its first new usage reading without a completed baseline (#689)', async () => {
  const s = server(method => method === 'thread/fork' ? { thread: { id: 'main', modelProvider: 'openai' }, model: 'gpt-6.1-sol' } : {}, { mode: 'fork', threadId: 'missing-rollout', images: [] })
  await tick()
  s.notify('thread/tokenUsage/updated', { threadId: 'main', tokenUsage: {
    total: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 150 },
    last: { inputTokens: 200, cachedInputTokens: 100, outputTokens: 50 },
  } })
  s.reply('done', 'r'); s.complete()
  const end = await s.end
  assert.deepEqual(end.usage, { input: 100, cacheRead: 100, cacheCreation: 0, output: 50 })
  assert.ok(Math.abs(end.costUsd! - 0.00071) < 1e-10)
})

it('returns a startup failure when the agent closes its input pipe', async () => {
  const stdout = new PassThrough()
  const stdin = new Writable({ write(_chunk, _encoding, callback) { queueMicrotask(() => callback(Error('EPIPE: agent input closed'))) } })
  const end = await createCodexClient().turn({ stdout, stdin, cwd: '/tmp', prompt: 'go', log: () => {}, gotResumeId: () => {}, gotModel: () => {} })
  assert.equal(end.ok, false)
  assert.match(end.error!, /EPIPE/)
  stdout.destroy()
})

const terminal = { itemId: 'cmd', processId: '42', command: 'temporary service' }
const command = (exitCode?: number) => ({ id: 'cmd', processId: '42', type: 'commandExecution', command: 'temporary service', status: exitCode === undefined ? 'inProgress' : 'completed', exitCode, aggregatedOutput: exitCode === 2 ? 'TEST FAILED' : 'result' })
const finish = (s: ReturnType<typeof server>, text?: string) => {
  if (text) s.reply(text, `answer-${s.calls.length}`)
  s.complete(`t${s.calls.filter(c => c.method === 'turn/start').length}`)
}
const poll = (s: ReturnType<typeof server>, stdin = '') => s.notify('item/commandExecution/terminalInteraction', { threadId: 'main', itemId: 'cmd', processId: '42', stdin })

it('stops temporary work through its actual handle without replacing the original reply', async () => {
  let running = true
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : method === 'thread/backgroundTerminals/list' ? { data: running ? [terminal] : [] } : {})
  await tick(); s.item(command()); s.reply('REVIEW READY', 'answer'); s.complete(); await tick()
  const start = s.calls.filter(c => c.method === 'turn/start')[1]!.params
  assert.equal(start.threadId, 'main')
  assert.equal(start.outputSchema, undefined)
  assert.match(start.input[0].text, /Include new task results/)
  assert.doesNotMatch(start.input[0].text, /receipt|reported|collected =/)
  poll(s, '\u0003'); running = false; s.item(command(1))
  s.notify('thread/tokenUsage/updated', { threadId: 'main', tokenUsage: { total: { inputTokens: 20, outputTokens: 10 } } })
  finish(s)
  const end = await s.end
  assert.equal(end.ok, true, end.error)
  assert.equal(end.cleanup?.status, 'confirmed')
  assert.equal(end.result, 'REVIEW READY')
  assert.equal(end.usage?.input, 20)
  assert.equal(s.events.filter(e => e.kind === 'message').length, 1)
  assert.equal(s.calls.some(c => /clean|terminate/.test(c.method)), false)
})

for (const exit of [0, 2]) it(`delivers the actual result completed during cleanup, including failed exit ${exit} (#757)`, async () => {
  let running = true
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : method === 'thread/backgroundTerminals/list' ? { data: running ? [terminal] : [] } : {})
  await tick(); s.item(command()); s.reply('STARTED', 'answer'); s.complete(); await tick()
  poll(s); running = false; s.item(command(exit))
  s.item({ id: 'image', type: 'imageGeneration', savedPath: '/tmp/result.png' })
  finish(s, exit ? 'TEST FAILED; preserved the report' : 'Verified result: 42')
  const end = await s.end
  assert.equal(end.ok, exit === 0)
  if (exit) assert.match(end.error!, /TEST FAILED/)
  assert.equal(end.result, exit ? 'TEST FAILED; preserved the report' : 'Verified result: 42')
  assert.equal(end.replyParts?.[0]?.type, 'image')
  assert.equal(s.events.filter(e => e.kind === 'message').length, 2)
  assert.equal(s.calls.filter(c => c.method === 'turn/start').length, 2)
})

it('waits for pending commands without repeating an unchanged snapshot or extending the deadline', async () => {
  let running = true
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : method === 'thread/backgroundTerminals/list' ? { data: running ? [terminal] : [] } : {})
  await tick(); s.item(command()); s.reply('STARTED', 'answer'); s.complete(); await tick()
  poll(s); finish(s); await tick()
  assert.equal(s.calls.filter(c => c.method === 'turn/start').length, 2)
  running = false; s.item(command(2))
  await new Promise(r => setTimeout(r, 1100))
  const prompt = s.calls.filter(c => c.method === 'turn/start').at(-1)!.params
  assert.match(prompt.input[0].text, /TEST FAILED/)
  finish(s, 'Failure reported; saved the diagnostic')
  const end = await s.end
  assert.equal(end.ok, false)
  assert.equal(end.result, 'Failure reported; saved the diagnostic')
  assert.equal(s.calls.filter(c => c.method === 'turn/start').length, 3)
})

it('does not treat a collected tool output without a final reply as delivered', async () => {
  let running = true
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : method === 'thread/backgroundTerminals/list' ? { data: running ? [terminal] : [] } : {})
  await tick(); s.item(command()); s.reply('STARTED', 'answer'); s.complete(); await tick()
  poll(s); running = false; s.item(command(0)); finish(s)
  const end = await s.end
  assert.equal(end.ok, false)
  assert.match(end.error!, /did not deliver/)
  assert.equal(end.result, 'STARTED')
  assert.equal(s.calls.filter(c => c.method === 'turn/start').length, 2)
})

for (const acknowledged of [true, false]) it(`retains an already verified service only with a fresh host acknowledgement (${acknowledged})`, async () => {
  const s = server(method => method === 'initialize' ? { wildcrane: { instance: 'backend', lease: 'lease' } } : method === 'thread/resume' ? { thread: { id: 'main' }, retainedTerminals: [{ threadId: 'main', ...terminal }] } : method === 'thread/backgroundTerminals/list' ? { data: [terminal] } : { confirmed: acknowledged, instance: 'backend', lease: 'lease' }, { mode: 'resume', threadId: 'main', images: [] })
  await tick(); s.item(command()); s.reply('Preview ready', 'answer'); s.complete(); await tick()
  finish(s, 'Routine cleanup: service remains running')
  const end = await s.end
  assert.equal(end.ok, acknowledged)
  assert.equal(end.cleanup?.status, acknowledged ? 'confirmed' : 'unconfirmed')
  assert.deepEqual(end.cleanup?.kept, acknowledged ? ['terminal:main:cmd'] : [])
  assert.equal(end.result, 'Preview ready')
  assert.equal(s.events.filter(e => e.kind === 'message').length, 1)
  assert.equal(s.client.background?.(), 0)
})

for (const scenario of ['running without evidence', 'disappeared without exit'] as const) {
  it(`records unconfirmed state without inventing a service or successful stop: ${scenario}`, async () => {
    let running = true
    const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : method === 'thread/backgroundTerminals/list' ? { data: running ? [terminal] : [] } : {})
    await tick(); s.item(command()); s.reply('Saved result', 'answer'); s.complete(); await tick()
    if (scenario === 'disappeared without exit') running = false
    finish(s)
    const end = await s.end
    assert.equal(end.ok, false)
    assert.equal(end.result, 'Saved result')
    assert.equal(end.cleanup?.status, 'unconfirmed')
    assert.deepEqual(end.cleanup?.kept, [])
  })
}

it('delivers a paginated child result once without adopting unknown threads', async () => {
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : method === 'thread/read' ? { thread: { historyMode: 'paginated', status: { type: 'idle' } } } : method === 'thread/turns/list' ? { data: [{ status: 'completed', items: [{ type: 'agentMessage', phase: 'commentary', text: 'Working' }, { type: 'agentMessage', phase: 'final_answer', text: 'CHILD RESULT' }] }] } : { data: [] })
  await tick()
  s.item({ id: 'spawn', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child', agentPath: '/root/worker' })
  s.item({ id: 'unowned', type: 'collabAgentToolCall', agentsStates: { stranger: { status: 'running' } } })
  s.reply('Started', 'answer'); s.complete(); await tick()
  const prompt = s.calls.filter(c => c.method === 'turn/start')[1]!.params.input[0].text
  assert.match(prompt, /CHILD RESULT/)
  assert.doesNotMatch(prompt, /stranger/)
  finish(s, 'CHILD RESULT: delivered')
  const end = await s.end
  assert.equal(end.ok, true, end.error)
  assert.equal(end.result, 'CHILD RESULT: delivered')
  assert.equal(s.events.filter(e => e.kind === 'message').length, 2)
  assert.ok(s.calls.some(c => c.method === 'thread/backgroundTerminals/list' && c.params.threadId === 'child'))
  assert.equal(s.calls.filter(c => c.method === 'turn/start').length, 2)
})

it('observes independent native child completion before the parent final reply (#757)', async () => {
  let done = false
  const childTurn = { status: 'completed', items: [{ type: 'agentMessage', phase: 'commentary', text: 'Working' }, { type: 'agentMessage', phase: 'final_answer', text: 'NATIVE CHILD RESULT' }] }
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : method === 'thread/read' ? { thread: { status: { type: done ? 'idle' : 'active' }, turns: done ? [childTurn] : [] } } : { data: [] })
  await tick()
  s.item({ id: 'spawn', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child', agentPath: '/root/worker' })
  s.reply('Started', 'answer'); s.complete(); await tick()
  done = true
  s.notify('turn/completed', { threadId: 'child', turn: childTurn })
  finish(s, 'NATIVE CHILD RESULT')
  const end = await s.end
  assert.equal(end.ok, true, end.error)
  assert.equal(end.result, 'NATIVE CHILD RESULT')
  assert.equal(s.calls.filter(c => c.method === 'turn/start').length, 2)
})

it('never mistakes a pending child without a terminal handle for a retained service', async () => {
  let done = false
  const s = server(method => method === 'initialize' ? { wildcrane: { instance: 'host', lease: 'lease' } } : method === 'thread/start' ? { thread: { id: 'main' } } : method === 'thread/read' ? { thread: { status: { type: done ? 'idle' : 'active' }, turns: done ? [{ status: 'completed', items: [{ type: 'agentMessage', text: 'CHILD RESULT' }] }] : [] } } : method === 'wildcrane/settled' ? { confirmed: true, instance: 'host', lease: 'lease' } : { data: [] })
  await tick()
  s.item({ id: 'spawn', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child' })
  s.reply('Started', 'answer'); s.complete(); await tick()
  finish(s); await tick()
  assert.equal(s.client.background?.(), 1)
  assert.equal(s.calls.some(c => c.method === 'wildcrane/settled'), false)
  done = true
  await new Promise(r => setTimeout(r, 1100))
  finish(s, 'CHILD RESULT')
  const end = await s.end
  assert.equal(end.ok, true, end.error)
  assert.deepEqual(end.cleanup?.kept, [])
  assert.equal(end.result, 'CHILD RESULT')
})

it('does not repeat child results delivered before the initial final reply', async () => {
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : { data: [] })
  await tick()
  s.item({ id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } })
  s.item({ id: 'wait', type: 'collabAgentToolCall', tool: 'wait', agentsStates: { child: { status: 'completed', message: 'CHILD RESULT' } } })
  s.reply('CHILD RESULT delivered', 'answer'); s.complete()
  const end = await s.end
  assert.equal(end.result, 'CHILD RESULT delivered')
  assert.equal(s.calls.filter(c => c.method === 'turn/start').length, 1)
})

it('delivers mixed completed batches without marking an unoffered result as presented', async () => {
  let running = true
  const items = Array.from({ length: 12 }, (_, n) => ({ ...command(0), id: `cmd${n}`, processId: `${n}`, exitCode: n === 11 ? 2 : 0, aggregatedOutput: `RESULT_${n}:` + 'x'.repeat(1700) }))
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : method === 'thread/backgroundTerminals/list' ? { data: running ? items.map(i => ({ itemId: i.id, processId: i.processId })) : [] } : method === 'thread/read' ? { thread: { turns: [{ items }] } } : {})
  await tick()
  for (const i of items) s.item({ ...i, status: 'inProgress', exitCode: undefined, aggregatedOutput: '' })
  s.reply('STARTED', 'answer'); running = false; s.complete(); await tick()
  const first = s.calls.filter(c => c.method === 'turn/start')[1]!.params.input[0].text
  assert.doesNotMatch(first, /RESULT_11:/)
  finish(s, 'First batch delivered'); await tick()
  const next = s.calls.filter(c => c.method === 'turn/start')[2]!.params.input[0].text
  assert.match(next, /RESULT_11:/)
  assert.doesNotMatch(next, /RESULT_0:/)
  finish(s, 'Remaining batch failed; diagnostic saved')
  const end = await s.end
  assert.equal(end.ok, false)
  assert.match(end.error!, /RESULT_11:/)
  assert.equal(end.result, 'Remaining batch failed; diagnostic saved')
  assert.equal(s.calls.filter(c => c.method === 'turn/start').length, 3)
})

it('does not interrupt a necessary wait at the cleanup timeout', async () => {
  CODEX_SETTLE_MS.turn = 25
  let running = true
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : method === 'thread/backgroundTerminals/list' ? { data: running ? [terminal] : [] } : {})
  await tick(); s.item(command()); s.reply('Started', 'answer'); s.complete(); await tick(); poll(s)
  await new Promise(r => setTimeout(r, 40))
  assert.equal(s.calls.some(c => c.method === 'turn/interrupt'), false)
  running = false; s.item(command(0)); finish(s, 'Actual result')
  assert.equal((await s.end).result, 'Actual result')
})

it('bounds silent cleanup and state queries independently of the background wait', async () => {
  CODEX_SETTLE_MS.turn = 30
  CODEX_SETTLE_MS.verify = 30
  for (const hang of ['turn', 'query']) {
    const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : method === 'thread/backgroundTerminals/list' ? hang === 'query' ? new Promise(() => {}) : { data: [terminal] } : {})
    await tick(); s.reply('Saved', 'answer'); s.complete()
    assert.equal((await s.end).cleanup?.status, 'unconfirmed')
    s.stdout.destroy()
  }
})

it('does not end genuine background work at the old deadline', async () => {
  BACKGROUND_WAIT.minutes = 0.002
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : method === 'thread/backgroundTerminals/list' ? { data: [terminal] } : {})
  await tick(); s.reply('Waiting', 'answer'); s.complete(); await tick(); poll(s); finish(s)
  await new Promise(resolve => setTimeout(resolve, 180))
  s.stdout.destroy()
  assert.doesNotMatch((await s.end).error ?? '', /background tasks did not finish/)
})

it('batches complete identifiers at the snapshot limit', () => {
  const work = Array.from({ length: 80 }, (_, n) => ({ id: `terminal:main:${n}`, threadId: 'main', kind: 'terminal' as const, status: 'running' as const, result: 'x'.repeat(1800) }))
  const first = batch(work)
  assert.ok(first.length > 0 && first.length < work.length)
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 16 * 1024)
  assert.equal(first[0], work[0])
})
