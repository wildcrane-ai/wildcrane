import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it, mock } from 'node:test'
import { connectCloudLive, type LiveConnection } from '../src/lib/cloud/live'
import { writeSession } from '../src/lib/cloud/session'

const original = globalThis.WebSocket
const sockets: Socket[] = []
let home: string
let live: LiveConnection | null
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
class Socket {
  sent: Record<string, any>[] = []
  closed = false
  onopen?: () => void
  onclose?: () => void
  onerror?: () => void
  onmessage?: (event: { data: string }) => void
  constructor() { sockets.push(this) }
  send(raw: string) { this.sent.push(JSON.parse(raw)) }
  close() { this.closed = true }
  receive(topic: string, event: string, payload = {}, ref?: string) {
    this.onmessage?.({ data: JSON.stringify({ topic, event, payload, ref }) })
  }
  join() { this.onopen?.(); this.receive('realtime:runner:test', 'phx_reply', { status: 'ok' }) }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-live-'))
  process.env.AI4KANBAN_HOME = home
  process.env.AI4KANBAN_SUPABASE_URL = 'https://unused.invalid'
  writeSession({ version: 1, subject: 'test', supabaseUrl: 'https://unused.invalid', accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 3600_000 })
  sockets.length = 0
  globalThis.WebSocket = Socket as unknown as typeof WebSocket
  mock.method(Math, 'random', () => 0.5)
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
})
afterEach(() => {
  live?.close()
  mock.timers.reset()
  mock.restoreAll()
  globalThis.WebSocket = original
  fs.rmSync(home, { recursive: true, force: true })
  delete process.env.AI4KANBAN_HOME
  delete process.env.AI4KANBAN_SUPABASE_URL
})

for (const event of ['phx_close', 'phx_error', 'system']) it(`rejoins after ${event}, even with an open socket (#760)`, async () => {
  live = connectCloudLive({ topic: 'runner:test', onHint() {}, onReady() {} })
  await settle()
  sockets[0]!.join()
  assert.equal(live?.joined(), true)
  sockets[0]!.receive('realtime:runner:test', event, { status: 'error' })
  assert.equal(live?.joined(), false)
  assert.equal(sockets[0]!.closed, true)
  mock.timers.tick(1000)
  await settle()
  assert.equal(sockets.length, 2)
  sockets[1]!.join()
  assert.equal(live?.joined(), true)
})

it('requires the matching heartbeat reply and reconnects after silence (#760)', async () => {
  live = connectCloudLive({ topic: 'runner:test', onHint() {}, onReady() {} })
  await settle()
  const socket = sockets[0]!
  socket.join()
  mock.timers.tick(5000)
  const pulse = [...socket.sent].reverse().find(frame => frame.event === 'heartbeat')!
  socket.receive('phoenix', 'phx_reply', { status: 'ok' }, pulse.ref)
  mock.timers.tick(5000)
  socket.receive('phoenix', 'phx_reply', { status: 'ok' }, pulse.ref)
  mock.timers.tick(5000)
  assert.equal(live?.joined(), false, 'a stale acknowledgement hid the silent connection')
  mock.timers.tick(1000)
  await settle()
  assert.equal(sockets.length, 2)
  live?.close()
  mock.timers.tick(60_000)
  await settle()
  assert.equal(sockets.length, 2, 'a stopped client reconnected')
})
