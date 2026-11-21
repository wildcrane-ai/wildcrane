import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'
import LegacyWebSocket, { WebSocketServer } from 'ws'
import { runAgent } from '../src/lib/agent-cli'
import { writeSession } from '../src/lib/cloud/session'
import { setLanguage } from '../src/lib/machine/settings'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
const originalSocket = globalThis.WebSocket
let home: string
let server: WebSocketServer
let chat: any
let taskStatus: string
let calls: { route: string; method: string; body: any }[]
let onJob: () => any
let onStop: (body: any) => any
const target = '11111111-1111-4111-8111-111111111111'
const next = '22222222-2222-4222-8222-222222222222'
const messages = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'agent' : 'user', body: `message ${i}`, created_at: new Date(1700000000000 + i * 1000).toISOString(), ...(i === 23 ? { stopped: true, image_names: ['image.png'] } : {}) }))

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'task-chat-'))
  process.env.AI4KANBAN_HOME = home
  process.env.WILDCRANE_HOME = home
  process.env.AI4KANBAN_SUPABASE_URL = 'https://project.test'
  process.env.DO_NOT_TRACK = '1'
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  process.env.AI4KANBAN_CLOUD_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  writeSession({ version: 1, supabaseUrl: 'https://project.test', subject: 'account', accessToken: 'secret-token', refreshToken: 'secret-refresh', expiresAt: Date.now() + 3600_000 })
  chat = { status: 'idle', job: null, execution: null, failure: null, messages: structuredClone(messages) }
  globalThis.WebSocket = LegacyWebSocket as unknown as typeof WebSocket
  taskStatus = 'done'
  calls = []
  onJob = () => ({ id: target, state: 'finished', outcome: 'done', reply: 'Original final reply' })
  onStop = () => ({ ...chat, execution: { stopRequested: true } })
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = new URL(String(url)).pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ route, method, body })
    assert.equal((init?.headers as any).authorization, 'Bearer secret-token')
    if (route === '/v1/tasks/WC-12' || route === '/v1/tasks/task_test') return Response.json({ key: 'WC-12', status: taskStatus })
    if (route.endsWith('/chat/stop')) return Response.json(onStop(body))
    if (route.endsWith('/chat')) return Response.json(method === 'POST' ? { status: 'queued', job: target, messages: [{ id: 'msg_new', role: 'user', body: body.body }] } : chat)
    if (route.startsWith('/v1/runner/jobs/')) return Response.json({ job: onJob() })
    throw Error(`Unexpected ${route}`)
  }) as typeof fetch
})
afterEach(async () => {
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalSocket
  for (const key of ['AI4KANBAN_HOME', 'WILDCRANE_HOME', 'AI4KANBAN_SUPABASE_URL', 'AI4KANBAN_CLOUD_URL', 'DO_NOT_TRACK']) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  for (const socket of server.clients) socket.terminate()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(home, { recursive: true, force: true })
})

async function run(...argv: string[]) {
  let stdout = ''
  const write = process.stdout.write
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    if (typeof chunk !== 'string') return (write as any).call(process.stdout, chunk, ...args)
    stdout += chunk; return true
  }) as typeof write
  try {
    const code = await runAgent(['task', 'chat', ...argv, '--json'], { program: 'akb', cwd: home })
    assert.doesNotMatch(stdout, /secret-token|secret-refresh/)
    return { code, lines: stdout.trim().split('\n').filter(Boolean).map((s) => JSON.parse(s)) }
  } finally { process.stdout.write = write }
}

it('reads chronological retained history, including failure after task completion, without writes', async () => {
  chat.status = 'failed'; chat.failure = 'Codex thread is already in use by another run.'
  const { code, lines: [value] } = await run('WC-12')
  assert.equal(code, 0)
  assert.equal(value.task.status, 'done')
  assert.equal(value.reply.state, 'failed')
  assert.equal(value.reply.failure, chat.failure)
  assert.deepEqual(value.messages, messages.slice(-20))
  assert.equal(value.total, 25); assert.equal(value.truncated, true)
  assert.deepEqual((await run('WC-12', '--all')).lines[0].messages, messages)
  assert.deepEqual((await run('task_test', '--limit', '2')).lines[0].messages, messages.slice(-2))
  assert.ok(calls.every((c) => c.method === 'GET'))
})
it('empty chats and send keep their existing semantics', async () => {
  chat.messages = []
  const value = (await run('WC-12')).lines[0]
  assert.equal(value.total, 0); assert.equal(value.reply.state, 'idle')
  const sent = await run('WC-12', 'Keep', 'this')
  assert.deepEqual(calls.at(-1), { route: '/v1/tasks/WC-12/chat', method: 'POST', body: { body: 'Keep this' } })
  assert.equal(sent.code, 0)
  assert.equal(sent.lines[0].status, 'queued')
  assert.match(sent.lines[0].output, /Reply pending/)
})
it('rejects incompatible modes and invalid limits before any request', async () => {
  for (const args of [['--all', '--limit', '2'], ['hello', '--follow'], ['hello', '--all'], ['hello', '--stop'], ['--stop', '--follow'], ['--stop', '--all'], ['--stop', '--limit', '2'], ['--limit', '0'], ['--limit', '1.5']]) {
    assert.equal((await run('WC-12', ...args)).code, 1)
  }
  assert.equal(calls.length, 0)
})
it('separates acceptance, startup, content and stop progress', async () => {
  chat.job = target
  for (const [status, execution, state] of [
    ['queued', {}, 'queued'], ['replying', { phase: 'submitted' }, 'starting'],
    ['replying', { firstContentAt: '2026-11-15T00:00:00Z' }, 'replying'],
    ['replying', { stopRequested: true }, 'stopping'], ['runner_offline', {}, 'offline'],
  ] as const) {
    chat.status = status; chat.execution = execution
    assert.equal((await run('WC-12')).lines[0].reply.state, state)
  }
})
it('stop only targets the observed reply, including queued stops and replacement races', async () => {
  assert.equal((await run('WC-12', '--stop')).lines[0].stop.state, 'not_running')
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0)
  chat.job = target; chat.status = 'replying'
  assert.equal((await run('WC-12', '--stop')).lines[0].stop.state, 'requested')
  assert.deepEqual(calls.at(-1)?.body, { job: target })
  chat.status = 'runner_offline'
  assert.equal((await run('WC-12', '--stop')).lines[0].stop.state, 'requested')
  chat.status = 'queued'
  onStop = () => ({ ...chat, job: null, status: 'idle' })
  onJob = () => ({ id: target, state: 'finished', outcome: 'stopped' })
  const stopped = (await run('WC-12', '--stop')).lines[0]
  assert.equal(stopped.stop.state, 'stopped'); assert.equal(stopped.reply.state, 'stopped')
  onStop = () => ({ ...chat, job: next })
  onJob = () => ({ id: target, state: 'finished', outcome: 'done' })
  assert.equal((await run('WC-12', '--stop')).lines[0].stop.state, 'superseded')
  assert.ok(calls.filter((c) => c.method === 'POST').every((c) => c.route.endsWith('/chat/stop') && c.body.job === target))
})
it('follow emits deduplicated log events and the original final result after replacement', async () => {
  globalThis.WebSocket = originalSocket
  chat.job = target; chat.status = 'queued'
  let reads = 0
  onJob = () => ++reads < 2 ? { id: target, state: 'claimed', outcome: null } : { id: target, state: 'finished', outcome: 'done', reply: 'Original final reply' }
  server.on('connection', (socket, request) => {
    assert.match(request.url!, new RegExp(`/jobs/${target}/stream\\?after=-1`))
    socket.send(JSON.stringify({ type: 'events', events: [{ seq: 0, text: 'First' }, { seq: 0, text: 'Duplicate' }, { seq: 1, kind: 'tool_call', text: 'Inspecting' }] }))
    socket.send(JSON.stringify({ type: 'ended' }))
    chat = { ...chat, job: next, status: 'replying' }
  })
  const { code, lines } = await run('WC-12', '--follow')
  assert.equal(code, 0)
  assert.equal(lines[0].type, 'snapshot')
  assert.deepEqual(lines.filter((l) => l.type === 'event').map((l) => l.event.seq), [0, 1])
  assert.equal(lines.at(-1).type, 'result'); assert.equal(lines.at(-1).body, 'Original final reply')
  assert.equal(lines.at(-1).reply.id, target)
  assert.ok(calls.every((c) => c.method === 'GET'))
})
it('follow reports startup failure and retained failures with exit 1', async () => {
  chat.job = target; chat.status = 'replying'
  onJob = () => ({ id: target, state: 'finished', outcome: 'failed', reason: 'The thread is already in use.' })
  const { code, lines } = await run('WC-12', '--follow')
  assert.equal(code, 1)
  assert.equal(lines.at(-1).error.kind, 'reply_failed')
  assert.equal(lines.at(-1).error.message, 'The thread is already in use.')
  chat = { ...chat, job: null, status: 'failed', failure: 'Agent could not initialize.' }
  assert.equal((await run('WC-12', '--follow')).lines.at(-1).error.message, chat.failure)
})
it('no active reply ends immediately; Ctrl+C only disconnects locally', async () => {
  assert.equal((await run('WC-12', '--follow')).lines.at(-1).type, 'result')
  chat.job = target; chat.status = 'queued'
  onJob = () => ({ id: target, state: 'waiting', outcome: null })
  server.on('connection', () => process.emit('SIGINT'))
  const { code, lines } = await run('WC-12', '--follow')
  assert.equal(code, 130); assert.equal(lines.at(-1).error.kind, 'interrupted')
  assert.ok(calls.every((c) => c.method === 'GET'))
})
it('preserves login and permission refusals, and translates only prose labels', async () => {
  setLanguage('zh')
  const value = (await run('WC-12')).lines[0]
  assert.match(value.output, /任务执行/); assert.equal(value.task.status, 'done')
  globalThis.fetch = (async () => Response.json({ error: { code: 'forbidden', message: 'No access.' } }, { status: 403 })) as typeof fetch
  const denied = await run('WC-12', '--follow')
  assert.equal(denied.code, 1); assert.equal(denied.lines.at(-1).error.kind, 'forbidden')
  fs.rmSync(path.join(home, 'session.json'))
  assert.equal((await run('WC-12')).lines[0].error.kind, 'signed_out')
})

it('reconnects the same reply after the last sequence and still verifies its outcome', async () => {
  chat.job = target; chat.status = 'replying'
  let connections = 0
  onJob = () => connections < 2 ? { id: target, state: 'claimed', outcome: null } : { id: target, state: 'finished', outcome: 'stopped', reply: 'Partial reply' }
  server.on('connection', (socket, request) => {
    connections++
    if (connections === 1) {
      socket.send(JSON.stringify({ type: 'events', events: [{ seq: 0, text: 'Partial' }] }))
      socket.close(1011, 'network')
    } else {
      assert.match(request.url!, /after=0$/)
      socket.send(JSON.stringify({ type: 'events', events: [{ seq: 0, text: 'Duplicate' }, { seq: 1, text: 'More' }] }))
    }
  })
  const { code, lines } = await run('WC-12', '--follow')
  assert.equal(code, 0); assert.equal(lines.at(-1).reply.state, 'stopped')
  assert.deepEqual(lines.filter((l) => l.type === 'event').map((l) => l.event.seq), [0, 1])
})
it('a denied log stream cannot be reported as a completed reply', async () => {
  chat.job = target; chat.status = 'queued'
  onJob = () => ({ id: target, state: 'waiting', outcome: null })
  server.removeAllListeners('connection')
  const httpServer = (server as any)._server
  httpServer.removeAllListeners('upgrade')
  httpServer.on('upgrade', (_request: any, socket: any) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'))
  const { code, lines } = await run('WC-12', '--follow')
  assert.equal(code, 1); assert.equal(lines.at(-1).error.kind, 'refused')
  assert.equal(lines.at(-1).reply.state, 'queued')
})

it('prints Runner wire-format message deltas and current activity in prose', async () => {
  chat.job = target; chat.status = 'replying'
  let ready = false
  onJob = () => ready ? { id: target, state: 'finished', outcome: 'done', reply: 'Final body' } : { id: target, state: 'claimed', outcome: null }
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'events', events: [
      { seq: 0, kind: 'message', text: '', data: { text: 'Live reply delta' } },
      { seq: 1, kind: 'tool_call', text: '', data: { title: 'Inspecting assets', status: 'in_progress' } },
    ] }))
    ready = true
  })
  const log = console.log
  const out: string[] = []
  console.log = (value: unknown) => { out.push(String(value)) }
  try {
    assert.equal(await runAgent(['task', 'chat', 'WC-12', '--follow']), 0)
    assert.match(out.join('\n'), /Live reply delta/)
    assert.match(out.join('\n'), /Activity: Inspecting assets/)
    assert.match(out.join('\n'), /Final body/)
  } finally { console.log = log }
})
