import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it, type TestContext } from 'node:test'

import { setBoardRoot } from '../src/lib/paths.ts'
import { savePin, STUDIO_SNAPSHOT_ENV } from '../src/lib/agent/cloud-studios.ts'
import { writeSession } from '../src/lib/cloud/session.ts'
import { restoreMachineHome, run } from './helpers/board.ts'

const refuses = (root: string, argv: string[], why: RegExp) => assert.rejects(() => run(root, argv), why)

const API = 'https://api.example.test'
const OWN = 'wf_01own'
const STUDIO = '---\nname: Layout\ndescription: Learns a page layout.\n---\n\n## Work\n\nThe card says which page.\n\n## Land\n\nCheck and save the page.\n\n## Previews\n'
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
    const route = new URL(url).pathname
    if (route === '/v1/projects/prj_clone') return Response.json({ workspace: 'ws_clone' })
    if (route === '/v1/studios') {
      return Response.json({ data: [OWN, 'wf_builtin_coding'].map(id => ({ id, version: cloud.version })), next: null })
    }
    const id = decodeURIComponent(route.slice('/v1/studios/'.length))
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

function cloneBoard(t: TestContext) {
  const dev = process.env.AI4KANBAN_STUDIOS
  delete process.env.AI4KANBAN_STUDIOS
  t.after(() => { if (dev !== undefined) process.env.AI4KANBAN_STUDIOS = dev })
  const state = path.join(root, '.akb')
  const board = path.join(state, 'kanban')
  fs.mkdirSync(path.join(board, 'todo'), { recursive: true })
  fs.writeFileSync(path.join(board, 'config.md'), '')
  fs.writeFileSync(path.join(state, 'base.json'), JSON.stringify({ project: 'prj_clone' }))
  return (id: string, folder: string, ...options: string[]) => run(root, ['--board', board, 'studio', 'clone', id, folder, ...options])
}

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

it('clones the latest built-in and workspace Studios as independent, validated drafts', async (t) => {
  const clone = cloneBoard(t)
  const fetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const response = await fetch(url, init)
    if (!new URL(String(url)).pathname.startsWith('/v1/studios/')) return response
    const studio = await response.json() as { version: number; files: Record<string, string> }
    studio.version = 5
    studio.files['STUDIO.md'] = STUDIO.replace('name: Layout', 'name: |-\n  Layout\nnames: { zh: 布局 }').replaceAll('\n', '\r\n')
    studio.files['CARD.md'] = 'Name the page.'
    studio.files['skills/local/SKILL.md'] = '---\nname: local\ndescription: Prepare the local layout.\n---\nRead [style](references/style.md).\n'
    studio.files['skills/local/references/style.md'] = 'Keep the original layout.'
    studio.files['references/style.md'] = 'Match the project style.'
    studio.files['shared/RULES.md'] = 'Use supported breakpoints.'
    studio.files['scripts/check.mjs'] = 'export const check = () => true\n'
    studio.files['ABOUT.zh.md'] = 'Market description.'
    studio.files['README.md'] = '![Preview](screenshots/a.png)'
    studio.files['README.zh.md'] = '使用指南'
    studio.files['screenshots/a.png'] = `data:image/png;base64,${PNG.toString('base64')}`
    return Response.json(studio)
  }
  const builtin = path.join(root, 'drafts', 'built-in')
  const own = path.join(root, 'workspace-draft')
  fs.mkdirSync(own)
  const write = process.stdout.write
  let stdout = ''
  process.stdout.write = ((chunk: string) => { stdout += String(chunk); return true }) as typeof process.stdout.write
  try { await clone('coding', builtin, '--json') }
  finally { process.stdout.write = write }
  const { ok, source, sourceVersion, folder } = JSON.parse(stdout)
  assert.deepEqual({ ok, source, sourceVersion, folder }, { ok: true, source: 'coding', sourceVersion: 5, folder: builtin })
  await clone('wf-01own', own, '--name', 'Responsive layout')
  for (const [dir, expected] of [[builtin, /Layout \(copy\)[\s\S]*布局（副本）/], [own, /name: "Responsive layout"/]] as const) {
    assert.match(fs.readFileSync(path.join(dir, 'STUDIO.md'), 'utf8'), expected)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['ABOUT.zh.md', 'CARD.md', 'README.md', 'README.zh.md', 'STUDIO.md', 'references', 'screenshots', 'scripts', 'shared', 'skills'])
    assert.equal(fs.readFileSync(path.join(dir, 'README.zh.md'), 'utf8'), '使用指南')
    assert.deepEqual(fs.readFileSync(path.join(dir, 'screenshots/a.png')), PNG)
    assert.equal(fs.readFileSync(path.join(dir, 'references/style.md'), 'utf8'), 'Match the project style.')
    assert.equal(fs.readFileSync(path.join(dir, 'skills/local/references/style.md'), 'utf8'), 'Keep the original layout.')
    await run(root, ['studio', 'validate', dir])
    await refuses(root, ['studio', 'push', dir], /version\.json/)
  }
  assert.doesNotMatch(fs.readFileSync(path.join(own, 'STUDIO.md'), 'utf8'), /names:/)
  assert.deepEqual(patched, [])
})

it('lists only skill metadata and reads resources from the pinned execution version', async (t) => {
  cloneBoard(t)
  const board = path.join(root, '.akb', 'kanban')
  const files = (version: number) => ({
    'STUDIO.md': STUDIO,
    'skills/layout/SKILL.md': '---\nname: layout\ndescription: Layout v' + version + '.\n---\n\nPrivate body for the selected skill.',
    'skills/layout/style.txt': 'Style v' + version,
  })
  cloud.files = files(3)
  const json = async (...args: string[]) => {
    const write = process.stdout.write
    let output = ''
    process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true }) as typeof write
    try { await run(root, ['--board', board, 'studio', ...args, '--json']) } finally { process.stdout.write = write }
    return JSON.parse(output)
  }
  assert.deepEqual((await json('skills', 'wf-01own')).skills, [{ name: 'layout', description: 'Layout v3.' }])
  cloud = { version: 4, files: files(4) }
  assert.deepEqual((await json('skills', 'wf-01own')).skills, [{ name: 'layout', description: 'Layout v4.' }])
  savePin('task_layout', { id: OWN, version: 3, name: 'Layout', files: files(3) })
  process.env.AI4KANBAN_TASK = 'task_layout'
  process.env[STUDIO_SNAPSHOT_ENV] = JSON.stringify({ studio: OWN, version: 3 })
  t.after(() => { delete process.env.AI4KANBAN_TASK; delete process.env[STUDIO_SNAPSHOT_ENV] })
  assert.deepEqual((await json('skills', 'wf-01own')).skills, [{ name: 'layout', description: 'Layout v3.' }])
  assert.equal((await json('file', OWN, 'skills/layout/style.txt')).text, 'Style v3')
  fs.rmSync(path.join(root, 'home', 'studios', 'versions', OWN + '@3.json'))
  await refuses(root, ['--board', board, 'studio', 'skills', 'wf-01own'], /Cannot recover Studio wf-01own v3/)
})

it('refuses incompatible sources and destinations before writing the clone', async (t) => {
  const clone = cloneBoard(t)
  const dir = path.join(root, 'draft')
  const original = path.join(root, 'occupied')
  fs.mkdirSync(original)
  fs.writeFileSync(path.join(original, 'STUDIO.md'), 'Keep my draft.')
  await assert.rejects(() => clone('coding', original), /not empty/)
  assert.equal(fs.readFileSync(path.join(original, 'STUDIO.md'), 'utf8'), 'Keep my draft.')
  for (const file of ['mcp.json']) {
    cloud.files = { 'STUDIO.md': STUDIO, [file]: 'Unsupported in a workspace Studio.' }
    await assert.rejects(() => clone('wf-01own', dir), /cannot carry/)
    assert.equal(fs.existsSync(dir), false)
  }
  cloud.files = { 'STUDIO.md': STUDIO.split('## Land')[0]! }
  await assert.rejects(() => clone('wf-01own', dir), /Missing ## Land/)
  assert.equal(fs.existsSync(dir), false)
})

it('refuses to create or push files missing a required section before a publication request', async () => {
  const dir = pulled(3)
  for (const section of ['Land', 'Work', 'Previews']) {
    fs.writeFileSync(path.join(dir, 'STUDIO.md'), STUDIO.replace(`## ${section}\n`, ''))
    const why = new RegExp(`STUDIO\\.md:\\d+:1: Missing ## ${section} section. Add ## ${section}`)
    await refuses(root, ['studio', 'create', dir, '--request-id', 'invalid'], why)
    await refuses(root, ['studio', 'push', dir], why)
  }
  assert.deepEqual(note(dir), { id: OWN, version: 3 })
  assert.equal(patched.length, 0)
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

it('validates an unregistered local studio and detects a changed baseline or draft', async () => {
  const { cmdStudioValidate } = await import('../src/commands/studio')
  const dir = pulled(3)
  fs.writeFileSync(path.join(root, 'docs/kanban/todo/7-draft.md'), '---\ntitle: Draft\nmodules: []\n---\n')
  fs.appendFileSync(path.join(dir, 'STUDIO.md'), '')
  const before = cmdStudioValidate(dir).fingerprint
  assert.match(String(before), /^[0-9a-f]{64}$/)
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ id: OWN, version: 4 }))
  assert.notEqual(cmdStudioValidate(dir).fingerprint, before)
  const baseline = cmdStudioValidate(dir).fingerprint
  fs.appendFileSync(path.join(dir, 'STUDIO.md'), 'Unreviewed change.\n')
  assert.notEqual(cmdStudioValidate(dir).fingerprint, baseline)
})

it('does not write a local Studio version when Cloud omits its confirmation', async () => {
  const dir = pulled(3)
  fs.appendFileSync(path.join(dir, 'STUDIO.md'), '\nName the breakpoint.\n')
  const fetch = globalThis.fetch
  globalThis.fetch = async (url, init) => init?.method === 'PATCH' ? Response.json({ id: OWN }) : fetch(url, init)
  await refuses(root, ['studio', 'push', dir], /confirmation of the saved Studio version/)
  assert.deepEqual(note(dir), { id: OWN, version: 3 })
  const create = path.join(root, 'new-studio')
  fs.mkdirSync(create)
  fs.writeFileSync(path.join(create, 'STUDIO.md'), STUDIO)
  globalThis.fetch = async () => Response.json({ version: 1 })
  await refuses(root, ['studio', 'create', create, '--workspace', 'ws_1', '--request-id', 'create-no-receipt'], /confirmation of the saved Studio version/)
  assert.equal(fs.existsSync(path.join(create, 'version.json')), false)
})
