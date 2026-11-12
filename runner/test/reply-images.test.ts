import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { collectReplyImages, saveReplyImages } from '../src/reply-images'
import { createCodexStreamRenderer } from '../../cli/src/lib/agent/wire/codex-stream'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-images-'))
const fixtures = path.resolve('test/fixtures/codex-images')
fs.copyFileSync(path.join(fixtures, 'reply.png'), path.join(root, 'reply.png'))
after(() => fs.rmSync(root, { recursive: true, force: true }))

test('actual Codex 0.167.0-alpha.3.2 final references keep text/image/text and omit local paths', () => {
  const r = createCodexStreamRenderer()
  r.push(fs.readFileSync(path.join(fixtures, 'local.jsonl'), 'utf8')); r.flush()
  const read = collectReplyImages(r.replyParts!(), root)
  assert.deepEqual(read.parts.map(p => p.type), ['text', 'image', 'text'])
  assert.equal(read.files.size, 1)
  assert.doesNotMatch(JSON.stringify(read.parts), /reply\.png|base64/)
})

test('actual MCP images land without image bytes in events; final references deduplicate the tool result', () => {
  const r = createCodexStreamRenderer()
  r.push(fs.readFileSync(path.join(fixtures, 'mcp.jsonl'), 'utf8')); r.flush()
  assert.doesNotMatch(JSON.stringify(r.events!()), /iVBORw0/)
  const read = collectReplyImages([...r.replyParts!().filter(p => p.type === 'image'), { type: 'text', text: 'Before\n![fixture](reply.png)\nAfter' }], root)
  assert.equal(read.files.size, 1)
  assert.deepEqual(read.parts.map(p => p.type), ['text', 'image', 'text'])
})

test('outside symlinks, missing files, URLs and forged MIME remain unavailable; examples stay text', () => {
  fs.symlinkSync(path.join(fixtures, 'reply.png'), path.join(root, 'outside.png'))
  const read = collectReplyImages([{ type: 'text', text: '![x](outside.png) ![x](missing.png) ![x](https://example.com/x.png) `![x](reply.png)`' },
    { type: 'image', data: fs.readFileSync(path.join(fixtures, 'reply.png')).toString('base64'), mime: 'image/jpeg' }], root)
  assert.equal(read.files.size, 0)
  assert.equal(read.parts.filter(p => p.type === 'image' && p.status === 'unavailable').length, 4)
  assert.match(JSON.stringify(read.parts), /`!\[x\]\(reply.png\)`/)
})

test('image-only replies retry twice at most, preserve one image, and never lose text on upload failure', async () => {
  const raw = [{ type: 'image' as const, path: 'reply.png' }]
  let attempts = 0
  const parts = await saveReplyImages(raw, root, async () => { attempts++; throw Error('offline') })
  assert.equal(attempts, 2)
  assert.deepEqual(parts, [{ type: 'image', id: undefined, status: 'not_saved', mime: 'image/png' }])
})


test('actual native image generation emits a final local reference without a tool image item', () => {
  const r = createCodexStreamRenderer()
  const stream = fs.readFileSync(path.join(fixtures, 'native.jsonl'), 'utf8')
    .replace('/home/tester/.codex/generated_images/turn/image.png', path.join(root, 'reply.png'))
  const log = r.push(stream) + r.flush()
  assert.doesNotMatch(log, /generated_images|reply\.png/)
  const read = collectReplyImages(r.replyParts!(), root)
  assert.deepEqual(read.parts.map(p => p.type), ['image'])
  assert.equal(read.files.size, 1)
})


test('quota refusal never sends the local digest as a cloud image ID', async () => {
  const parts = await saveReplyImages([{ type: 'image', path: 'reply.png' }], root, async () => ({ status: 'not_saved' }))
  assert.deepEqual(parts, [{ type: 'image', id: undefined, status: 'not_saved', mime: 'image/png' }])
})
