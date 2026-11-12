import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, it } from 'node:test'
import { createCodexStreamRenderer } from '../src/lib/agent/wire/codex-stream.ts'
import { createCodexClient, createCodexConnection } from '../src/lib/agent/wire/codex.ts'
import { streamFinished } from '../src/lib/agent/wire/background.ts'
import { createStreamRenderer } from '../src/lib/agent/wire/claude-stream.ts'
import { BACKGROUND_WAIT } from '../src/lib/agent/settings.ts'
import type { RunEvent } from '../src/lib/agent/wire/index.ts'

const originalWait = BACKGROUND_WAIT.minutes
afterEach(() => { BACKGROUND_WAIT.minutes = originalWait })
const tick = () => new Promise(r => setImmediate(r))

function server(handle: (method: string, params: any) => any, options?: Parameters<typeof createCodexClient>[0]) {
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
  const end = client.turn({ stdout, stdin, prompt: 'original task', cwd: '/tmp', log: () => {}, gotResumeId: () => {}, gotModel: () => {}, event: e => events.push(e) })
  const item = (item: any) => notify('item/completed', { threadId: 'main', turnId: 't1', item })
  const complete = (id = 't1', status = 'completed') => notify('turn/completed', { threadId: 'main', turn: { id, status, items: [] } })
  const reply = (text: string, id: string) => item({ type: 'agentMessage', id, text })
  return { stdout, stdin, client, end, calls, events, notify, item, complete, reply }
}

it('keeps two subagents in the same run, presents results once, then accepts the final reply', async () => {
  let release!: (v: any) => void
  let starts = 0
  const s = server((method, params) => {
    if (method === 'initialize') return {}
    if (method === 'thread/start') return { thread: { id: 'main', modelProvider: 'openai' }, model: 'test-model' }
    if (method === 'turn/start') { starts++; return { turn: { id: `t${starts}` } } }
    if (method === 'thread/read') return new Promise(r => { release = r })
    if (method === 'thread/backgroundTerminals/list') return { data: [], nextCursor: null }
    throw Error(method)
  })
  await tick()
  s.item({ id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['a', 'b'], agentsStates: { a: { status: 'running' }, b: { status: 'running' } } })
  s.reply('STARTED', 'reply1'); s.complete()
  await tick()
  assert.equal(s.client.background?.(), 2)
  let settled = false; void s.end.then(() => { settled = true })
  release({ thread: { status: { type: 'idle' }, turns: [{ status: 'completed', items: [{ type: 'agentMessage', text: 'A result' }] }] } })
  await tick()
  assert.equal(s.client.background?.(), 1)
  assert.equal(settled, false)
  release({ thread: { status: { type: 'idle' }, turns: [{ status: 'completed', items: [{ type: 'agentMessage', text: 'B result' }] }] } })
  await tick()
  assert.equal(starts, 2)
  const continuation = s.calls.filter(c => c.method === 'turn/start')[1]!.params
  assert.match(continuation.input[0].text, /A result.*B result/)
  assert.equal(continuation.threadId, 'main')
  assert.equal(settled, false)
  s.reply('FINISHED', 'reply2'); s.complete('t2'); s.complete('t2')
  const end = await s.end
  assert.equal(end.ok, true, end.error)
  assert.equal(end.result, 'FINISHED')
  assert.equal(s.events.filter(e => e.kind === 'tool_call_update').length, 2)
  assert.equal(starts, 2)
})

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

it('bounds background waiting even when polling still receives responses', async () => {
  BACKGROUND_WAIT.minutes = 0.002
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : method === 'thread/backgroundTerminals/list' ? { data: [{ itemId: 'cmd', processId: '1' }] } : {})
  await tick(); s.reply('STARTED', 'reply'); s.complete()
  const end = await s.end
  assert.equal(end.ok, false)
  assert.match(end.error!, /background tasks did not finish/)
})

it('fails an unexpected connection close with a pending subagent', async () => {
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : {})
  await tick()
  s.item({ id: 'spawn', type: 'collabAgentToolCall', agentsStates: { a: { status: 'running' } } })
  s.stdout.destroy()
  assert.equal((await s.end).ok, false)
})

it('retains a failed background outcome after the parent presents its result', async () => {
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : method === 'thread/read' ? { thread: { status: { type: 'idle' }, turns: [{ status: 'failed', error: { message: 'child failed' } }] } } : method === 'thread/backgroundTerminals/list' ? { data: [] } : {})
  await tick()
  s.item({ id: 'spawn', type: 'collabAgentToolCall', agentsStates: { a: { status: 'running' } } })
  s.reply('STARTED', 'first'); s.complete()
  await tick(); s.reply('The task failed.', 'last'); s.complete('t2')
  const end = await s.end
  assert.equal(end.ok, false)
  assert.match(end.error!, /child failed/)
  assert.equal(end.result, 'The task failed.')
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

it('reads the latest paginated child turn without mistaking an older completed turn for new work', async () => {
  const s = server(method => {
    if (method === 'thread/start') return { thread: { id: 'main' } }
    if (method === 'thread/read') return { thread: { historyMode: 'paginated', status: { type: 'idle' }, turns: [] } }
    if (method === 'thread/turns/list') return { data: [{ status: 'completed', items: [{ type: 'agentMessage', text: 'PAGED RESULT' }] }] }
    if (method === 'thread/backgroundTerminals/list') return { data: [] }
    return {}
  })
  await tick()
  const spawn = { id: 'spawn', type: 'collabAgentToolCall', agentsStates: { a: { status: 'running' } } }
  s.item(spawn); s.reply('STARTED', 'm1'); s.complete()
  await tick()
  assert.match(s.calls.filter(c => c.method === 'turn/start')[1]!.params.input[0].text, /PAGED RESULT/)
  // A completed turn may backfill its old spawn snapshot.
  s.item(spawn)
  assert.equal(s.client.background?.(), 0)
  s.item({ id: 'close', type: 'collabAgentToolCall', agentsStates: { a: { status: 'shutdown' } } })
  s.reply('FINISHED', 'm2'); s.complete('t2')
  assert.equal((await s.end).ok, true)
})

it('keeps background commands open through terminal-list pagination and reports a failed exit', async () => {
  let listing = 0
  let release!: (v: any) => void
  const s = server(method => {
    if (method === 'thread/start') return { thread: { id: 'main' } }
    if (method === 'thread/backgroundTerminals/list') {
      listing++
      return listing === 1 ? new Promise(r => { release = r }) : { data: [], nextCursor: null }
    }
    return {}
  })
  await tick()
  s.notify('item/started', { threadId: 'main', item: { id: 'cmd', type: 'commandExecution', command: 'test', processId: '1', status: 'inProgress' } })
  s.reply('STARTED', 'm1'); s.complete()
  await tick()
  assert.equal(s.client.background?.(), 1)
  s.item({ id: 'cmd', type: 'commandExecution', command: 'test', processId: '1', status: 'failed', exitCode: 1, aggregatedOutput: 'TEST FAILED' })
  release({ data: [], nextCursor: 'page2' })
  await tick()
  s.reply('Reported failure', 'm2'); s.complete('t2')
  const end = await s.end
  assert.equal(end.ok, false)
  assert.match(end.error!, /TEST FAILED/)
  assert.equal(listing, 3)
})

it('lets the main agent recover from a foreground command failure', async () => {
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : { data: [] })
  await tick()
  s.notify('item/started', { threadId: 'main', item: { id: 'cmd', type: 'commandExecution', command: 'test', processId: '1', status: 'inProgress' } })
  s.item({ id: 'cmd', type: 'commandExecution', command: 'test', status: 'failed', exitCode: 1, aggregatedOutput: 'retry needed' })
  s.reply('Fixed and verified', 'reply'); s.complete()
  assert.equal((await s.end).ok, true)
})


it('bounds an unresponsive background-state query even when no work was reported yet', async () => {
  BACKGROUND_WAIT.minutes = 0.002
  const s = server(method => method === 'thread/start' ? { thread: { id: 'main' } } : method === 'thread/backgroundTerminals/list' ? new Promise(() => {}) : {})
  await tick(); s.reply('DONE', 'reply'); s.complete()
  assert.equal((await s.end).ok, false)
})


for (const mode of ['resume', 'fork'] as const) {
  it(`preserves missing-session recovery when Codex cannot ${mode} its saved rollout`, async () => {
    const s = server(method => {
      if (method === `thread/${mode}`) throw { code: -32600, message: 'no rollout found for thread id missing' }
      return {}
    }, { mode, threadId: 'missing', images: [] })
    const end = await s.end
    assert.equal(end.ok, false)
    assert.match(end.error!, /Thread not found: no rollout found/)
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


it('returns a startup failure when the agent closes its input pipe', async () => {
  const stdout = new PassThrough()
  const stdin = new Writable({ write(_chunk, _encoding, callback) { queueMicrotask(() => callback(Error('EPIPE: agent input closed'))) } })
  const end = await createCodexClient().turn({ stdout, stdin, cwd: '/tmp', prompt: 'go', log: () => {}, gotResumeId: () => {}, gotModel: () => {} })
  assert.equal(end.ok, false)
  assert.match(end.error!, /EPIPE/)
  stdout.destroy()
})
