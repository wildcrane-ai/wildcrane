// `akb studio pull` / `push` (#544, #564): a pulled folder, with its visible `version.json`, pushes
// back unchanged, screenshots come back as bytes, an edit saves the next version, and a version
// moved in Cloud is refused.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'

import { setBoardRoot } from '../src/lib/paths.ts'
import { writeSession } from '../src/lib/cloud/session.ts'
import { restoreMachineHome, run } from './helpers/board.ts'

const refuses = (root: string, argv: string[], why: RegExp) => assert.rejects(() => run(root, argv), why)

const API = 'https://api.example.test'
const OWN = 'wf_01own'
const STUDIO = '---\nname: Layout\ndescription: Learns a page layout.\n---\n\nThe card says which page.\n'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255])

let root = ''
let cloud: { version: number; files: Record<string, string> }
let patched: unknown[] = []
const realFetch = globalThis.fetch

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-pull-push-'))
  const kanban = path.join(root, 'docs', 'kanban')
  fs.mkdirSync(path.join(kanban, 'todo'), { recursive: true })
  fs.writeFileSync(path.join(kanban, 'todo', 'README.md'), '# Tasks\n\n## Tasks\n')
  setBoardRoot(root)
  process.env.AI4KANBAN_HOME = path.join(root, 'home')
  process.env.AI4KANBAN_SUPABASE_URL = 'https://project.supabase.co'
  process.env.AI4KANBAN_CLOUD_URL = API
  writeSession({
    version: 1, supabaseUrl: 'https://project.supabase.co', accessToken: 't', refreshToken: 'r',
    expiresAt: Date.now() + 3600_000, subject: '11111111-1111-4111-8111-111111111111',
  })
  cloud = { version: 3, files: { 'STUDIO.md': STUDIO } }
  patched = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const id = decodeURIComponent(String(url).slice(`${API}/v1/studios/`.length))
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body))
      if (body.expectedVersion !== cloud.version) return new Response(JSON.stringify({ error: { code: 'version_conflict', message: 'Studio moved; pull again.' } }), { status: 409 })
      patched.push(body)
      cloud = { version: cloud.version + 1, files: (patched.at(-1) as { files: Record<string, string> }).files }
      return new Response(JSON.stringify({ id, version: cloud.version }))
    }
    const files = id === OWN ? { ...cloud.files, 'version.json': JSON.stringify({ id, version: cloud.version }) } : { 'STUDIO.md': STUDIO, 'screenshots/a.png': `data:image/png;base64,${PNG.toString('base64')}` }
    return new Response(JSON.stringify({ id, version: cloud.version, files }))
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(root, { recursive: true, force: true })
  restoreMachineHome()
  delete process.env.AI4KANBAN_SUPABASE_URL
  delete process.env.AI4KANBAN_CLOUD_URL
})

const note = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'))

const pulled = (version: number) => {
  const dir = path.join(root, `layout-${version}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ id: OWN, version }))
  fs.writeFileSync(path.join(dir, 'STUDIO.md'), STUDIO)
  return dir
}

it('pulls screenshots back as bytes and refuses to push a built-in', async () => {
  const dir = path.join(root, 'coding')
  await run(root, ['studio', 'pull', 'coding', dir])
  assert.deepEqual(fs.readFileSync(path.join(dir, 'screenshots', 'a.png')), PNG)
  assert.deepEqual(note(dir), { id: 'wf_builtin_coding', version: 3 })
  await refuses(root, ['studio', 'pull', 'coding', dir], /not empty/)
  await refuses(root, ['studio', 'push', dir], /Copy this studio/)
})

it('pushes only a change, and refuses once Cloud moved on', async () => {
  const dir = pulled(3)
  await run(root, ['studio', 'push', dir])
  assert.equal(patched.length, 0)
  fs.appendFileSync(path.join(dir, 'STUDIO.md'), 'Name the breakpoint.\n')
  await run(root, ['studio', 'push', dir])
  assert.equal(cloud.version, 4)
  assert.match(cloud.files['STUDIO.md']!, /Name the breakpoint/)
  assert.deepEqual(Object.keys(cloud.files), ['STUDIO.md'])
  assert.deepEqual(note(dir), { id: OWN, version: 4 })
  await refuses(root, ['studio', 'push', pulled(3)], /Studio moved; pull again/)
})

it('retries the same persisted publication after the server committed but its response was lost', async () => {
  const dir = pulled(3)
  fs.appendFileSync(path.join(dir, 'STUDIO.md'), 'Changed.\n')
  const send = globalThis.fetch
  const requests: { key: string; body: string }[] = []
  let receipt: Response | undefined
  globalThis.fetch = (async (url, init) => {
    if (init?.method !== 'PATCH') return send(url, init)
    requests.push({ key: new Headers(init.headers).get('idempotency-key')!, body: String(init.body) })
    if (receipt) return receipt.clone()
    receipt = await send(url, init)
    throw new Error('response lost')
  }) as typeof fetch
  await refuses(root, ['studio', 'push', dir], /response lost/)
  assert.equal(cloud.version, 4)
  assert.deepEqual(note(dir), { id: OWN, version: 3 })
  await run(root, ['studio', 'push', dir])
  assert.equal(cloud.version, 4)
  assert.deepEqual(requests[0], requests[1])
  assert.deepEqual(note(dir), { id: OWN, version: 4 })
  await run(root, ['studio', 'push', dir])
  assert.deepEqual(requests[1], requests[2])
})

it('creates in an explicit workspace and reuses the same request after a lost response', async () => {
  const dir = path.join(root, 'new')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'STUDIO.md'), STUDIO)
  let calls = 0
  let payload = ''
  globalThis.fetch = (async (_url, init) => {
    assert.equal(init?.method, 'POST')
    assert.equal(new Headers(init.headers).get('idempotency-key'), 'create-layout')
    const body = String(init.body)
    assert.equal(JSON.parse(body).workspace, 'ws_team')
    assert.equal(JSON.parse(body).files['version.json'], undefined)
    if (payload) assert.equal(body, payload)
    payload = body
    if (++calls === 1) throw new Error('timeout')
    return new Response(JSON.stringify({ id: OWN, version: 1 }))
  }) as typeof fetch
  const args = ['studio', 'create', dir, '--workspace', 'ws_team', '--request-id', 'create-layout']
  await refuses(root, args, /timeout/)
  await run(root, args)
  assert.deepEqual(note(dir), { id: OWN, version: 1 })
  await run(root, args)
  fs.appendFileSync(path.join(dir, 'STUDIO.md'), 'Changed after review.\n')
  await refuses(root, args, /different files/)
  assert.equal(calls, 3)
})

it('validates and diagrams an unregistered local studio and detects a changed baseline or draft', async () => {
  const { cmdStudioDiagram, cmdStudioValidate } = await import('../src/commands/studio')
  const dir = pulled(3)
  fs.writeFileSync(path.join(root, 'docs/kanban/todo/7-draft.md'), '---\ntitle: Draft\nmodules: []\n---\n')
  fs.appendFileSync(path.join(dir, 'STUDIO.md'), '')
  const before = cmdStudioValidate(dir).fingerprint
  assert.match(String(before), /^[0-9a-f]{64}$/)
  const result = cmdStudioDiagram('7', '7', dir)
  assert.deepEqual(JSON.parse(fs.readFileSync(String(result.file), 'utf8')).rounds, [])
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ id: OWN, version: 4 }))
  assert.notEqual(cmdStudioValidate(dir).fingerprint, before)
  const baseline = cmdStudioValidate(dir).fingerprint
  fs.appendFileSync(path.join(dir, 'STUDIO.md'), 'Unreviewed change.\n')
  assert.notEqual(cmdStudioValidate(dir).fingerprint, baseline)
})
