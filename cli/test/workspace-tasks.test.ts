// A Runner workspace's new cards are Cloud tasks (#2063): numbered by Cloud, linked to the task
// the job works for, written under the new task's id, and never made twice by a retry.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, beforeEach, describe, it } from 'node:test'

import { runAgent } from '../src/lib/agent-cli.ts'
import { DELIVERY_PHASE_ENV, RUN_ENV } from '../src/lib/agent/env.ts'
import { withStore } from '../src/lib/agent/store.ts'
import { TASK_ENV } from '../src/lib/cloud/tasks.ts'
import { writeSession } from '../src/lib/cloud/session.ts'
import { setBoardDir, setBoardRoot } from '../src/lib/paths.ts'
import { stampLeavingIn } from '../src/lib/leaving.ts'
import { forgetMachineState, move, refuses, restoreMachineHome } from './helpers/board.ts'

const SUPABASE = 'https://project.supabase.co'
const API = 'https://api.example.test'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-workspace-tasks-'))
const kanban = path.join(root, 'docs', 'kanban')
const todo = path.join(kanban, 'todo')
const realFetch = globalThis.fetch

let home = ''
let sent: { route: string; method: string; body: Record<string, unknown> | null; key: string | null; execution?: string; upload?: string }[] = []
let made: Record<string, string> = {}
let archivedTask: boolean

/** Cloud as far as these commands reach it: the source task, and creates kept by their key. */
function serve(refuse?: { status: number; code: string; message: string }): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = String(url).slice(API.length)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const upload = init?.body instanceof Blob ? await init.body.text() : undefined
    const body = init?.body && upload === undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    sent.push({ route, method: init?.method ?? 'GET', body, key: headers['idempotency-key'] ?? null,
      execution: headers['x-wildcrane-execution'], upload })
    if (route === '/v1/projects/prj_1') return Response.json({ id: 'prj_1', prefix: 'WC' })
    if (route === '/v1/tasks/task_src' || route === '/v1/tasks/WC-3') {
      return Response.json({ id: 'task_src', key: 'WC-3', project: 'prj_1', status: archivedTask ? 'done' : 'running', studio: { id: 'wf_builtin_coding' } })
    }
    if (route === '/v1/tasks/WC-4') return Response.json({ id: 'task_other', key: 'WC-4', project: 'prj_1', status: 'running' })
    if (route === '/v1/tasks/task_src/artifacts') return Response.json({ id: 'art_abc' }, { status: 201 })
    if (route === '/v1/artifacts/art_abc/uploads') return Response.json({ id: 'upload_abc', url: '/v1/uploads/upload_abc' }, { status: 201 })
    if (route === '/v1/uploads/upload_abc') return Response.json({ id: 'upload_abc' })
    if (route === '/v1/artifacts/art_abc/versions') return Response.json({ version: 1 }, { status: 201 })
    if (route.endsWith('/archive') && init?.method === 'POST') {
      if (refuse) return Response.json({ error: { code: refuse.code, message: refuse.message } }, { status: refuse.status })
      if (route === '/v1/tasks/task_src/archive') {
        archivedTask = true
        return Response.json({ id: 'task_src', key: 'WC-3', status: 'done', card_version: 5 })
      }
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
  delete process.env[DELIVERY_PHASE_ENV]
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
  archivedTask = false
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
      assert.equal(await runAgent(['task', 'create', '--title', 'Local card', '--json'], { cwd: root }), 0)
    } finally { process.stdout.write = stdout }
    const result = JSON.parse(writes.join(''))
    assert.equal(result.id, 12)
    assert.doesNotMatch(fs.readFileSync(path.join(todo, '12-local-card.md'), 'utf8'), /^priority:/m)
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
    const content = '---\ntitle: Current\nstudio: coding\n---\n\nDelivered.\n'
    fs.writeFileSync(path.join(board, '..', 'base.json'), JSON.stringify({
      project: 'prj_1', files: { 'projects/prj_1/todo/3-current.md': { seq: 3, content } },
    }))
    fs.writeFileSync(path.join(board, '.sync', 'task_src.json'), JSON.stringify({ task: 'task_src', number: 3 }))
    fs.writeFileSync(current, content)
    process.env.AI4KANBAN_BOARD = board
    process.env[TASK_ENV] = 'task_src'
    process.env.AI4KANBAN_EXECUTION = JSON.stringify({ job: '11111111-1111-4111-8111-111111111111', machine: '22222222-2222-4222-8222-222222222222' })
  })

  const post = () => sent.filter(({ route, method }) => route === '/v1/tasks/task_src/archive' && method === 'POST')

  it('archives directly without a Runner and retries idempotently without moving the board', async () => {
    delete process.env[TASK_ENV]
    delete process.env.AI4KANBAN_BOARD
    delete process.env.AI4KANBAN_EXECUTION
    const base = path.join(board, '..', 'base.json')
    const before = fs.readFileSync(base, 'utf8')
    const dependent = path.join(board, 'todo', '4-dependent.md')
    fs.writeFileSync(dependent, '---\ntitle: Dependent\nblocked_by: [3]\n---\n')
    fs.appendFileSync(current, '\nEdited right before archive.\n')
    assert.equal((await archive('3')).value.archive_status, 'archived')
    assert.equal((await archive('WC-3')).value.archive_status, 'archived')
    assert.deepEqual(post()[0]?.body?.card, { path: 'todo/3-current.md', base_seq: 3, content: fs.readFileSync(current, 'utf8') })
    assert.equal(post()[1]?.body, null)
    assert.equal(fs.existsSync(archived), false)
    assert.equal(fs.readFileSync(base, 'utf8'), before)
    assert.match(fs.readFileSync(dependent, 'utf8'), /^blocked_by: \[3\]$/m)
  })

  it('replays the legacy archive from a task discussion and keeps the isolation marker for pull', async () => {
    const marker = path.join(board, '.sync', 'land-archives', 'task_src')
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.writeFileSync(marker, JSON.stringify({ job: null, number: 3 }))
    fs.mkdirSync(path.dirname(archived), { recursive: true })
    fs.writeFileSync(archived, stampLeavingIn(fs.readFileSync(current, 'utf8'), '2026-11-27', null))
    fs.rmSync(current)
    const result = await archive('WC-3')
    assert.equal(result.code, 0)
    assert.equal(result.value.archive_status, 'archived')
    assert.equal(post()[0]?.execution, process.env.AI4KANBAN_EXECUTION)
    assert.deepEqual(post()[0]?.body?.card, { path: '.archive/3-current.md', base_seq: 3, content: fs.readFileSync(archived, 'utf8') })
    assert.ok(fs.existsSync(marker))
  })

  it('records the exact Cloud archive version for a managed Land delivery', async () => {
    const deliveryId = 'testland'
    process.env[DELIVERY_PHASE_ENV] = 'land'
    setBoardDir(board, root)
    withStore(store => store.deliveries.push({
      deliveryId, cardId: 3, title: 'Current', status: 'active', startedAt: Date.now(), sessions: [], steps: [], approved: '',
      worktree: path.join('.akb', 'worktrees', deliveryId, 'work'),
    }))
    const job = JSON.parse(process.env.AI4KANBAN_EXECUTION!).job
    const fetch = globalThis.fetch
    globalThis.fetch = (async (url, init) => {
      const response = await fetch(url, init)
      if (!String(url).endsWith('/archive')) return response
      return Response.json({ ...await response.json() as object, project: 'prj_1', last_job: job })
    }) as typeof fetch
    const result = await archive('3')
    assert.equal(result.code, 0, JSON.stringify(result.value))
    assert.equal(post()[0]?.body?.delivery_id, deliveryId)
    const receipt = path.join(root, '.akb', 'state', 'delivery-cleanup', deliveryId + '.json')
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), { project: 'prj_1', task: 'task_src', card: 3, deliveryId, seq: 5 })
  })

  it('uploads attachments in the calling session and sends their manifest in the archive request', async () => {
    setBoardRoot(root)
    const folder = path.join(root, '.akb', 'state', 'assets', '3')
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'result.txt'), 'New result')
    fs.appendFileSync(current, '\n<Asset src="asset:result.txt" />\n')
    const result = await archive('3')
    assert.equal(result.code, 0, JSON.stringify(result.value))
    assert.equal(result.value.archive_status, 'archived')
    assert.equal(sent.find(s => s.method === 'PUT')?.upload, 'New result')
    const assets = post()[0]?.body?.assets as { content: string; base_seq: number }
    assert.equal(assets.base_seq, 0)
    assert.deepEqual(JSON.parse(assets.content), { 'asset:result.txt': { artifact: 'art_abc', version: 1 } })
    assert.equal(fs.existsSync(path.join(board, 'assets')), false)
  })

  it('rejects Implement, and keeps the local card when Cloud is unreachable', async () => {
    process.env[DELIVERY_PHASE_ENV] = 'implement'
    assert.match(JSON.stringify((await archive('3')).value), /during Land/)
    assert.equal(sent.length, 0)
    process.env[DELIVERY_PHASE_ENV] = 'land'
    const before = fs.readFileSync(current, 'utf8')
    const fetch = globalThis.fetch
    globalThis.fetch = (async (url, init) => {
      if (String(url).endsWith('/archive')) throw new Error('offline')
      return fetch(url, init)
    }) as typeof fetch
    const failed = await archive('3')
    assert.equal(failed.code, 1)
    assert.equal(failed.value.error.code, 'unreachable')
    assert.equal(fs.readFileSync(current, 'utf8'), before)
    assert.equal(fs.existsSync(archived), false)
    globalThis.fetch = fetch
    assert.equal((await archive('3')).value.archive_status, 'archived')
  })

  it('waits for Cloud when archiving another task and reports refusals', async () => {
    let result = await archive('4')
    assert.equal(result.code, 0)
    assert.equal(result.value.task, 'task_other')
    assert.equal(result.value.archive_status, 'archived')
    assert.equal(sent.at(-1)?.route, '/v1/tasks/task_other/archive')
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
