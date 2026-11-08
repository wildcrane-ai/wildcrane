// `akb workflow pull` / `push` (#544): a pulled folder pushes back unchanged, screenshots come
// back as bytes, an edit saves the next version, and a version moved in Cloud is refused.

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
const WORKFLOW = '---\nname: Layout\ndescription: Learns a page layout.\n---\n\nThe card says which page.\n'
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
  cloud = { version: 3, files: { 'WORKFLOW.md': WORKFLOW } }
  patched = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const id = decodeURIComponent(String(url).slice(`${API}/v1/workflows/`.length))
    if (init?.method === 'PATCH') {
      patched.push(JSON.parse(String(init.body)))
      cloud = { version: cloud.version + 1, files: (patched.at(-1) as { files: Record<string, string> }).files }
      return new Response(JSON.stringify({ id, version: cloud.version }))
    }
    const files = id === OWN ? cloud.files : { 'WORKFLOW.md': WORKFLOW, 'screenshots/a.png': `data:image/png;base64,${PNG.toString('base64')}` }
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

const pulled = (version: number) => {
  const dir = path.join(root, 'layout')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.akb-workflow.json'), JSON.stringify({ id: OWN, version }))
  fs.writeFileSync(path.join(dir, 'WORKFLOW.md'), WORKFLOW)
  return dir
}

it('pulls screenshots back as bytes and refuses to push a built-in', async () => {
  const dir = path.join(root, 'coding')
  await run(root, ['workflow', 'pull', 'coding', dir])
  assert.deepEqual(fs.readFileSync(path.join(dir, 'screenshots', 'a.png')), PNG)
  await refuses(root, ['workflow', 'pull', 'coding', dir], /not empty/)
  await refuses(root, ['workflow', 'push', dir], /copy it on the web first/)
})

it('pushes only a change, and refuses once Cloud moved on', async () => {
  const dir = pulled(3)
  await run(root, ['workflow', 'push', dir])
  assert.equal(patched.length, 0)
  fs.appendFileSync(path.join(dir, 'WORKFLOW.md'), 'Name the breakpoint.\n')
  await run(root, ['workflow', 'push', dir])
  assert.equal(cloud.version, 4)
  assert.match(cloud.files['WORKFLOW.md']!, /Name the breakpoint/)
  await refuses(root, ['workflow', 'push', pulled(3)], /at v4 now; pull again/)
})
