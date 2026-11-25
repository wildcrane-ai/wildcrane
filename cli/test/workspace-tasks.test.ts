// A Runner workspace's new cards are Cloud tasks (#2063): numbered by Cloud, linked to the task
// the job works for, written under the new task's id, and never made twice by a retry.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, beforeEach, describe, it } from 'node:test'

import { runAgent } from '../src/lib/agent-cli.ts'
import { RUN_ENV } from '../src/lib/agent/env.ts'
import { withStore } from '../src/lib/agent/store.ts'
import { TASK_ENV } from '../src/lib/cloud/tasks.ts'
import { writeSession } from '../src/lib/cloud/session.ts'
import { setBoardRoot } from '../src/lib/paths.ts'
import { forgetMachineState, move, refuses, restoreMachineHome } from './helpers/board.ts'

const SUPABASE = 'https://project.supabase.co'
const API = 'https://api.example.test'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-workspace-tasks-'))
const kanban = path.join(root, 'docs', 'kanban')
const todo = path.join(kanban, 'todo')
const realFetch = globalThis.fetch

let home = ''
let sent: { route: string; method: string; body: Record<string, unknown> | null; key: string | null }[] = []
let made: Record<string, string> = {}

/** Cloud as far as these commands reach it: the source task, and creates kept by their key. */
function serve(refuse?: { status: number; code: string; message: string }): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = String(url).slice(API.length)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    sent.push({ route, method: init?.method ?? 'GET', body, key: headers['idempotency-key'] ?? null })
    if (route === '/v1/projects/prj_1') return Response.json({ id: 'prj_1', prefix: 'WC' })
    if (route === '/v1/tasks/task_src' || route === '/v1/tasks/WC-3') {
      return Response.json({ id: 'task_src', key: 'WC-3', project: 'prj_1', studio: { id: 'wf_builtin_coding' } })
    }
    if (route.endsWith('/archive') && init?.method === 'POST') {
      if (refuse) return Response.json({ error: { code: refuse.code, message: refuse.message } }, { status: refuse.status })
      return Response.json({ id: 'task_other', key: 'WC-4', status: 'done', card_version: 5 })
    }
    if (route === '/v1/tasks' && init?.method === 'POST') {
      if (refuse) return Response.json({ error: { code: refuse.code, message: refuse.message } }, { status: refuse.status })
      const key = headers['idempotency-key']!
      const replayed = key in made
      made[key] ??= `task_${(Object.keys(made).length + 0xa1).toString(16)}`
      const id = made[key]!
      return Response.json({ id, key: `WC-${12 + Object.values(made).indexOf(id)}`, project: 'prj_1', studio: { id: 'wf_builtin_coding' } }, {
        status: 201,
        headers: replayed ? { 'idempotent-replayed': 'true' } : {},
      })
    }
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${route}`)
  }) as typeof fetch
}

beforeEach(() => {
  delete process.env[RUN_ENV]
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-workspace-home-'))
  process.env.AI4KANBAN_HOME = home
  process.env.AI4KANBAN_SUPABASE_URL = SUPABASE
  process.env.AI4KANBAN_CLOUD_URL = API
  writeSession({
    version: 1,
    supabaseUrl: SUPABASE,
    accessToken: 'token-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + 60 * 60 * 1000,
    subject: '11111111-1111-4111-8111-111111111111',
  })
  fs.rmSync(path.join(root, 'docs'), { recursive: true, force: true })
  forgetMachineState(root)
  fs.mkdirSync(todo, { recursive: true })
  setBoardRoot(root)
  sent = []
  made = {}
  serve()
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env[TASK_ENV]
  delete process.env.AI4KANBAN_BOARD
  delete process.env.AI4KANBAN_EXECUTION
  delete process.env.AI4KANBAN_SUPABASE_URL
  delete process.env.AI4KANBAN_CLOUD_URL
  fs.rmSync(home, { recursive: true, force: true })
  restoreMachineHome()
})

after(() => fs.rmSync(root, { recursive: true, force: true }))

const create = (argv: string[]) => move(root, ['create', ...argv])

describe('raw create --id', () => {
  it('takes the number it is given', async () => {
    const out = await create(['--title', 'Own card', '--slug', 'task_1', '--id', '9'])
    assert.equal(out.id, 9)
    assert.ok(fs.existsSync(path.join(todo, '9-task-1.md')))
    assert.equal(sent.length, 0, 'a card for a task Cloud already has went to Cloud')
  })

  it('refuses a number another card holds', async () => {
    await create(['--title', 'Old', '--slug', 'old', '--id', '5'])
    await refuses(root, ['create', '--title', 'Own card', '--slug', 'task_1', '--id', '5'], /#5 is already a card here/)
  })
})

describe('in a Runner workspace', () => {
  beforeEach(() => (process.env[TASK_ENV] = 'task_src'))

  it('makes the card a Cloud task of the same project, numbered by Cloud and linked back', async () => {
    const body = path.join(root, 'body.md')
    fs.writeFileSync(body, 'Offer yearly billing.\n')
    const out = await create(['--title', 'Annual plan', '--body-file', body])
    assert.equal(out.id, 12)
    const post = sent.find((s) => s.method === 'POST')!
    assert.deepEqual(post.body, {
      title: 'Annual plan',
      project: 'prj_1',
      studio: 'wf_builtin_coding',
      request: 'Offer yearly billing.',
      source: 'api',
      source_context: { task: 'task_src' },
    })
    assert.match(post.key!, /^akb-[0-9a-f]{40}$/)
    const card = fs.readFileSync(path.join(todo, '12-annual-plan.md'), 'utf8')
    assert.match(card, /source:\n {2}- WC-3\n/)
    assert.match(card, /Offer yearly billing\./)
  })

  it('creates and indexes a numbered card from the canonical title mode', async () => {
    fs.writeFileSync(path.join(todo, 'README.md'), '## Tasks\n')
    const writes: string[] = []
    const stdout = process.stdout.write
    process.stdout.write = (line) => { writes.push(String(line)); return true }
    try {
      assert.equal(await runAgent(['task', 'create', '--title', 'Local card', '--priority', 'high', '--json'], { cwd: root }), 0)
    } finally { process.stdout.write = stdout }
    const result = JSON.parse(writes.join(''))
    assert.equal(result.id, 12)
    assert.match(fs.readFileSync(path.join(todo, '12-local-card.md'), 'utf8'), /^priority: high$/m)
    assert.match(fs.readFileSync(path.join(todo, 'README.md'), 'utf8'), /12-local-card\.md/)
    assert.equal(sent.filter((s) => s.method === 'POST').length, 1)
  })

  it('names the triage item it is made of by its file, for Cloud to move (#2107)', async () => {
    fs.mkdirSync(path.join(kanban, 'triage', 'dismissed'), { recursive: true })
    const item = (title: string) => `---\nsource_id: derived-${title.length}\ntitle: ${title}\ncollected_at: 2026-10-26 09:00\nimported_at: 2026-10-26 09:00\n---\n\nWords.\n`
    fs.writeFileSync(path.join(kanban, 'triage', 'dark-mode.md'), item('Dark mode'))
    fs.writeFileSync(path.join(kanban, 'triage', 'dismissed', 'sso.md'), item('SSO'))
    await create(['--title', 'Dark mode', '--triage', 'derived-9'])
    assert.equal(sent.find((s) => s.method === 'POST')!.body!.triage, 'tri_1_dark-mode')
    await create(['--title', 'SSO', '--triage', 'derived-3'])
    assert.equal(sent.filter((s) => s.method === 'POST')[1]!.body!.triage, 'tri_1_sso', 'one not open is Cloud’s to refuse')
    await refuses(root, ['create', '--title', 'Gone', '--triage', 'derived-0'], /nothing in triage is derived-0/)
  })

  it('a retry answers the card already written', async () => {
    await create(['--title', 'Annual plan'])
    const again = await create(['--title', 'Annual plan'])
    assert.equal(again.id, 12)
    assert.equal(Object.keys(made).length, 1)
    assert.equal(fs.readdirSync(todo).filter((f) => f.endsWith('.md') && f !== 'README.md').length, 1)
  })

  it('writes a blocked card here too, with no schedule on it: Cloud holds and starts it (#170)', async () => {
    await create(['--title', 'Pricing page', '--slug', 'task_src', '--id', '3'])
    const out = await create(['--title', 'Annual plan', '--blocked-by', '3'])
    assert.equal(out.id, 12)
    const post = sent.filter((s) => s.method === 'POST').at(-1)!.body!
    assert.equal(post.run, undefined)
    assert.equal(post.metadata, undefined)
    const card = fs.readFileSync(path.join(todo, '12-annual-plan.md'), 'utf8')
    assert.match(card, /^blocked_by: \[3\]$/m)
    assert.doesNotMatch(card, /schedule:/)
    await refuses(root, ['create', '--title', 'Nope', '--schedule', 'refine'], /unknown option '--schedule'/)
  })

  it('a refusal writes nothing', async () => {
    serve({ status: 403, code: 'forbidden', message: 'Only members may make tasks here.' })
    await refuses(root, ['create', '--title', 'Annual plan'], /Cloud did not make the task: Only members may make tasks here\./)
    assert.ok(!fs.readdirSync(todo).some((f) => /^\d+-/.test(f)))
  })

  it('names the agent of the run making it as the task’s creator (#95)', async () => {
    withStore((store) => {
      store.runs.push({ sessionId: 'project-reflection', cardId: null, action: 'reflect', status: 'running', startedAt: Date.now(), pid: process.pid } as never)
    })
    process.env[RUN_ENV] = 'project-reflection'
    await create(['--title', 'Stutter'])
    assert.deepEqual(sent.find((s) => s.method === 'POST')!.body!.source_context, { task: 'task_src', agent: 'proposer' })
  })
})

describe('task archive', () => {
  const board = path.join(root, '.akb', 'kanban')
  const current = path.join(board, 'todo', '3-current.md')
  const archived = path.join(board, '.archive', '3-current.md')
  const archive = async (ref: string) => {
    const out: string[] = []
    const errors: string[] = []
    const say = process.stdout.write, warn = process.stderr.write
    process.stdout.write = (line) => { out.push(String(line)); return true }
    process.stderr.write = (line) => { errors.push(String(line)); return true }
    try {
      const code = await runAgent(['task', 'archive', ref, '--json'], { cwd: root })
      return { code, value: JSON.parse(out.join('\n') || errors.join('\n')) }
    } finally { process.stdout.write = say; process.stderr.write = warn }
  }

  beforeEach(() => {
    fs.rmSync(path.join(root, '.akb'), { recursive: true, force: true })
    fs.mkdirSync(path.join(board, '.sync'), { recursive: true })
    fs.mkdirSync(path.dirname(current), { recursive: true })
    fs.writeFileSync(path.join(board, '..', 'base.json'), JSON.stringify({ project: 'prj_1' }))
    fs.writeFileSync(path.join(board, '.sync', 'task_src.json'), JSON.stringify({ task: 'task_src', number: 3 }))
    fs.writeFileSync(current, '---\ntitle: Current\nstudio: coding\n---\n\nDelivered.\n')
    process.env.AI4KANBAN_BOARD = board
    process.env[TASK_ENV] = 'task_src'
    process.env.AI4KANBAN_EXECUTION = JSON.stringify({ job: '11111111-1111-4111-8111-111111111111', machine: '22222222-2222-4222-8222-222222222222' })
  })

  it('archives only the current matched Runner task locally', async () => {
    const first = await archive('WC-3')
    assert.equal(first.code, 0)
    assert.equal(first.value.task, 'task_src')
    assert.equal(first.value.archive_status, 'pending_sync')
    assert.match(fs.readFileSync(archived, 'utf8'), /^archived:/m)
    assert.equal(fs.existsSync(current), false)
    const repeated = await archive('3')
    assert.equal(repeated.code, 0)
    assert.equal(repeated.value.archive_status, 'pending_sync')
    assert.deepEqual(sent.map(({ method, route }) => [method, route]), [['GET', '/v1/tasks/WC-3']])
  })

  it('reports the saved archive receipt only for the synchronized card version', async () => {
    assert.equal((await archive('3')).value.archive_status, 'pending_sync')
    const base = path.join(board, '..', 'base.json')
    const file = '.archive/3-current.md'
    const seq = 8
    const content = fs.readFileSync(archived, 'utf8')
    const save = (receipt: Record<string, unknown>) => fs.writeFileSync(base, JSON.stringify({
      project: 'prj_1', files: { [`projects/prj_1/${file}`]: { seq, content } },
      archiveReceipts: { task_src: { path: file, seq, assets_seq: 0, ...receipt } },
    }))
    save({ status: 'pending', code: 'service_unavailable', message: 'Cloud is unavailable.' })
    const pending = await archive('3')
    assert.equal(pending.value.archive_status, 'pending_sync')
    assert.equal(pending.value.sync.code, 'service_unavailable')
    save({ status: 'rejected', code: 'version_conflict', message: 'The card changed during archiving.' })
    const rejected = await archive('3')
    assert.equal(rejected.code, 1)
    assert.equal(rejected.value.error.code, 'version_conflict')
    save({ status: 'confirmed' })
    assert.equal((await archive('3')).value.archive_status, 'archived')
    fs.appendFileSync(archived, '\nEdited after synchronization.\n')
    assert.equal((await archive('3')).value.archive_status, 'pending_sync')
    assert.equal(sent.length, 0)
  })

  it('waits for Cloud when archiving another task and reports refusals', async () => {
    let result = await archive('4')
    assert.equal(result.code, 0)
    assert.equal(result.value.task, 'task_other')
    assert.equal(result.value.archive_status, 'archived')
    assert.equal(sent.at(-1)?.route, '/v1/tasks/WC-4/archive')
    assert.equal(sent.at(-1)?.body, null)
    assert.ok(fs.existsSync(current))
    delete process.env.AI4KANBAN_EXECUTION
    serve({ status: 409, code: 'conflict', message: 'Finish the agreed review plan before archiving.' })
    result = await archive('task_src')
    assert.notEqual(result.code, 0)
    assert.match(JSON.stringify(result.value), /Finish the agreed review plan before archiving/)
    assert.equal(sent.at(-1)?.route, '/v1/tasks/task_src/archive')
    assert.ok(fs.existsSync(current))
  })
})
