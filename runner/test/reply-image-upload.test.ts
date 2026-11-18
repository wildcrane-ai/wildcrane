import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { uploadReplyImage } from '../src/api'
import { saveReplyImages } from '../src/reply-images'
import { writeFakeSession } from './fake-cloud'

test('slow reply uploads survive 40–60 seconds, retry transient failures, and bound stalled images', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-upload-'))
  const previous = { AI4KANBAN_HOME: process.env.AI4KANBAN_HOME, AI4KANBAN_SUPABASE_URL: process.env.AI4KANBAN_SUPABASE_URL }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  process.env.AI4KANBAN_HOME = root
  writeFakeSession(root)
  const png = fs.readFileSync(path.resolve('test/fixtures/codex-images/reply.png'))
  const images = [png, Buffer.concat([png, Buffer.from([1])]), Buffer.concat([png, Buffer.from([2])])]
  images.forEach((bytes, i) => fs.writeFileSync(path.join(root, `${i}.png`), bytes))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Drive the request's timeout value with the same virtual clock as the network.
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms)
    return controller.signal
  })
  const attempts = [0, 0, 0]
  const stored = new Map<string, Uint8Array>()
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    const bytes = init.body as Uint8Array
    const index = images.findIndex(image => Buffer.from(bytes).equals(image))
    assert.ok(index >= 0)
    assert.equal(init.method, 'PUT')
    attempts[index]++
    if (index === 1 && attempts[index] === 1) return new Response('{}', { status: 503 })
    return new Promise<Response>((resolve, reject) => {
      const timer = index === 2 ? undefined : setTimeout(() => {
        init.signal!.removeEventListener('abort', abort)
        const id = `rim_cloud${index}`
        stored.set(id, bytes.slice())
        resolve(Response.json({ id, status: 'saved' }))
      }, index === 0 ? 40_000 : 60_000)
      const abort = () => { clearTimeout(timer); reject(init.signal!.reason) }
      init.signal!.addEventListener('abort', abort, { once: true })
    })
  })
  const upload = async (key: string, bytes: Uint8Array, mime: string) => {
    const result = await uploadReplyImage('machine', 'job', key, bytes, mime)
    if (!result.ok) throw Error(result.error)
    return result.value
  }
  const pending = saveReplyImages([{ type: 'text', text: 'Before ![a](0.png) Between ![b](1.png) After ![c](2.png) End' }], root, upload)
  for (const ms of [40_000, 60_000, 90_000, 90_000]) {
    await setImmediate()
    t.mock.timers.tick(ms)
  }
  assert.deepEqual(await pending, [
    { type: 'text', text: 'Before ' }, { type: 'image', id: 'rim_cloud0', mime: 'image/png', status: 'saved' },
    { type: 'text', text: ' Between ' }, { type: 'image', id: 'rim_cloud1', mime: 'image/png', status: 'saved' },
    { type: 'text', text: ' After ' }, { type: 'image', id: undefined, mime: 'image/png', status: 'not_saved' },
    { type: 'text', text: ' End' },
  ])
  assert.deepEqual(attempts, [1, 2, 2])
  assert.deepEqual(Buffer.from(stored.get('rim_cloud0')!), images[0])
  assert.deepEqual(Buffer.from(stored.get('rim_cloud1')!), images[1])
  const imageOnly = saveReplyImages([{ type: 'image', path: '0.png' }], root, upload)
  await setImmediate()
  t.mock.timers.tick(40_000)
  assert.deepEqual(await imageOnly, [{ type: 'image', id: 'rim_cloud0', mime: 'image/png', status: 'saved' }])
})
