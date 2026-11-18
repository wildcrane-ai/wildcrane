import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'
import { runAgent } from '../src/lib/agent-cli'
import { writeSession } from '../src/lib/cloud/session'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
let root: string
let a: string
let b: string
let empty: string
let calls: { url: URL; method: string; body: any }[]
let serve: (url: URL) => Response

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-selection-'))
  a = path.join(root, 'a'); b = path.join(root, 'b'); empty = path.join(root, 'empty')
  for (const [dir, project] of [[a, 'prj_a'], [b, 'prj_b'], [empty, null]] as const) {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    if (project) {
      fs.mkdirSync(path.join(dir, '.akb'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.akb/base.json'), JSON.stringify({ project }))
    }
  }
  fs.mkdirSync(path.join(b, 'nested'))
  process.env.AI4KANBAN_HOME = path.join(root, 'home')
  process.env.WILDCRANE_HOME = process.env.AI4KANBAN_HOME
  process.env.AI4KANBAN_SUPABASE_URL = 'https://project.test'
  process.env.AI4KANBAN_CLOUD_URL = 'https://api.test'
  delete process.env.AI4KANBAN_BOARD
  delete process.env.AI4KANBAN_REPLY_APPROVAL
  writeSession({ version: 1, supabaseUrl: 'https://project.test', subject: 'account', accessToken: 'test-token', refreshToken: 'test-refresh', expiresAt: Date.now() + 3600_000 })
  calls = []
  serve = (url) => {
    const route = url.pathname
    if (route.startsWith('/v1/projects/')) {
      const id = route.split('/').at(-1)!
      return Response.json({ id, prefix: id === 'prj_b' ? 'B' : 'A', workspace: `ws_${id}` })
    }
    if (route === '/v1/projects' || route === '/v1/workspaces' || route === '/v1/tasks') return Response.json({ data: [], next: null })
    if (route.endsWith('/runners')) return Response.json({ runners: [] })
    if (route.endsWith('/card')) return Response.json({ version: 1, body: '---\nquestions: []\n---\n' })
    if (route.endsWith('/chat')) return Response.json({ status: 'idle', job: null, messages: [] })
    return Response.json({ id: 'task_b', key: 'B-12', title: 'Selected task', status: 'done', studio: null })
  }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    return serve(url)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of ['AI4KANBAN_HOME', 'WILDCRANE_HOME', 'AI4KANBAN_SUPABASE_URL', 'AI4KANBAN_CLOUD_URL', 'AI4KANBAN_BOARD', 'AI4KANBAN_REPLY_APPROVAL']) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

async function run(argv: string[], json = true, cwd = a) {
  let stdout = ''; let stderr = ''
  const out = process.stdout.write; const err = process.stderr.write
  process.stdout.write = ((chunk: any) => { stdout += chunk; return true }) as typeof out
  process.stderr.write = ((chunk: any) => { stderr += chunk; return true }) as typeof err
  try {
    const code = await runAgent([...argv, ...(json ? ['--json'] : [])], { program: 'akb', cwd })
    const values = json ? stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
    return { code, stdout, stderr, value: values[0], values }
  } finally { process.stdout.write = out; process.stderr.write = err }
}

it('selects directories and board ownership from shared options without touching the board', async () => {
  for (const args of [
    ['--dir', '../b/nested', 'task', 'list'],
    ['task', '--dir', b, 'list'],
    ['task', 'list', '--dir', b],
    ['--board', '../b/.akb/kanban', 'task', 'list', '--dir', a],
    ['task', 'list', '--board', '../b/docs/kanban'],
  ]) {
    assert.equal((await run(args)).code, 0)
    assert.equal(calls.at(-1)!.url.searchParams.get('project'), 'prj_b')
  }
  process.env.AI4KANBAN_BOARD = '../b/.akb/kanban'
  await run(['task', 'list', '--dir', a])
  assert.equal(calls.at(-1)!.url.searchParams.get('project'), 'prj_b')
  await run(['task', 'list', '--board', '../a/.akb/kanban'])
  assert.equal(calls.at(-1)!.url.searchParams.get('project'), 'prj_a')
  delete process.env.AI4KANBAN_BOARD
  await run(['task', 'list'], true, path.join(b, 'nested'))
  assert.equal(calls.at(-1)!.url.searchParams.get('project'), 'prj_b')
  assert.deepEqual(fs.readdirSync(path.join(b, '.akb')), ['base.json'])
  // A board in a folder without git uses the existing docs/.akb ownership rule.
  fs.rmSync(path.join(b, '.git'), { recursive: true })
  await run(['task', 'list', '--board', '../b/.akb/kanban'])
  assert.equal(calls.at(-1)!.url.searchParams.get('project'), 'prj_b')
})

it('resolves numeric references for every task entry point, including chat follow', async () => {
  for (const args of [
    ['show', '12'], ['approve', '12', '--revision', '1'], ['update-questions', '12', '--clear'],
    ['chat', '12', 'Hello'], ['chat', '12'], ['chat', '12', '--stop'], ['chat', '12', '--follow'],
    ['remove', '12', 'Done'], ['resume', '12'], ['stop', '12'], ['comment', '12', 'Note'],
  ]) {
    calls = []
    const out = await run(['task', ...args, '--dir', '../b'])
    assert.equal(out.code, 0, JSON.stringify(out))
    assert.equal(calls[0]!.url.pathname, '/v1/projects/prj_b')
    assert.ok(calls.slice(1).every((c) => c.url.pathname.startsWith('/v1/tasks/B-12')))
  }
})

it('resolves numeric approvals before handing them to the reply approval bridge', async () => {
  process.env.AI4KANBAN_REPLY_APPROVAL = JSON.stringify({ url: 'http://127.0.0.1:12345/', token: 'a'.repeat(64) })
  const normal = serve
  serve = (url) => url.pathname === '/'
    ? Response.json({ ok: true, value: { id: 'approval', status: 'pending', task: 'B-12' } })
    : normal(url)
  const out = await run(['task', 'approve', '12', '--revision', '1', '--dir', '../b'])
  assert.equal(out.code, 0)
  assert.equal(out.value.pending, true)
  assert.deepEqual(calls.at(-1)!.body, { task: 'B-12', review_revision: 1 })
})

it('honors explicit scopes and full keys/ids without requiring a local link', async () => {
  process.env.AI4KANBAN_BOARD = path.join(empty, '.akb/kanban')
  await run(['task', 'list', '--project', 'prj_explicit', '--workspace', 'ws_other'])
  assert.equal(calls.at(-1)!.url.searchParams.get('project'), 'prj_explicit')
  assert.equal(calls.at(-1)!.url.searchParams.has('workspace'), false)
  await run(['task', 'list', '--workspace', 'ws_explicit'])
  assert.equal(calls.at(-1)!.url.searchParams.get('workspace'), 'ws_explicit')
  for (const ref of ['A-12', 'task_opaque']) {
    calls = []
    assert.equal((await run(['task', 'show', ref])).code, 0)
    assert.equal(calls[0]!.url.pathname, `/v1/tasks/${ref}`)
  }
  await run(['task', 'create', 'New task', '--studio', 'coding', '--project', 'prj_explicit'])
  assert.equal(calls.at(-1)!.body.project, 'prj_explicit')
  await run(['runner', 'list', '--workspace', 'ws_explicit'])
  assert.equal(calls.at(-1)!.url.pathname, '/v1/workspaces/ws_explicit/runners')
})

it('uses the same location for creation and Runners and never falls back to the caller project', async () => {
  await run(['task', 'create', 'New task', '--studio', 'coding', '--dir', '../b'])
  assert.equal(calls.at(-1)!.body.project, 'prj_b')
  await run(['runner', 'list', '--board', '../b/.akb/kanban'])
  assert.equal(calls.at(-1)!.url.pathname, '/v1/workspaces/ws_prj_b/runners')
  for (const location of [['--dir', empty], ['--board', path.join(empty, '.akb/kanban')], ['--dir', b]]) {
    if (location[1] === b) fs.writeFileSync(path.join(b, '.akb/base.json'), '{invalid')
    for (const args of [['task', 'list'], ['task', 'show', '12'], ['task', 'create', 'New'], ['runner', 'list']]) {
      calls = []
      const out = await run([...args, ...location])
      assert.equal(out.code, 1)
      assert.equal(out.value.error.code, 'no_project')
      assert.ok(calls.every((c) => ['/v1/projects', '/v1/workspaces'].includes(c.url.pathname)))
    }
  }
})

it('reads 101 tasks and empty lists in both formats, preserving scope, status, cursor and order', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => ({ id: `task_${i}`, key: `B-${i + 1}`, status: 'running', title: `Task ${i + 1}` }))
  const cursor = 'cursor+/=? &中文'
  for (const json of [true, false]) {
    for (const scope of [['--project', 'prj_b'], ['--workspace', 'ws_b']]) {
      for (const data of [rows, []]) {
        calls = []
        serve = (url) => Response.json({ data: url.searchParams.has('after') ? data.slice(100) : data.slice(0, 100), next: data.length && !url.searchParams.has('after') ? cursor : null })
        const out = await run(['task', 'list', ...scope, '--status', 'running'], json)
        assert.equal(out.code, 0)
        if (json) { assert.deepEqual(out.value.data, data); assert.equal(out.value.next, null) }
        else assert.equal(out.stdout, data.map((t) => `${t.key}  running  ${t.title}\n`).join(''))
        assert.equal(calls.length, data.length ? 2 : 1)
        for (const { url } of calls) {
          assert.equal(url.searchParams.get(scope[0]!.slice(2)), scope[1])
          assert.equal(url.searchParams.get('status'), 'running')
          assert.equal(url.searchParams.get('limit'), '100')
        }
        if (data.length) assert.equal(calls[1]!.url.searchParams.get('after'), cursor)
      }
    }
  }
})

it('refuses a failed later page without printing a partial success', async () => {
  serve = (url) => url.searchParams.has('after')
    ? Response.json({ error: { code: 'forbidden', message: 'Second page refused.' } }, { status: 403 })
    : Response.json({ data: [{ key: 'B-1', status: 'running', title: 'Partial task' }], next: 'next' })
  for (const json of [true, false]) {
    const out = await run(['task', 'list', '--project', 'prj_b'], json)
    assert.equal(out.code, 1)
    assert.doesNotMatch(out.stdout, /Partial task|B-1/)
    if (json) {
      assert.equal(out.value.ok, false)
      assert.deepEqual(out.value.error, { kind: 'forbidden', code: 'forbidden', message: 'Second page refused.' })
      assert.equal(out.value.data, undefined)
    } else assert.match(out.stderr, /Second page refused/)
  }
})

it('keeps project and workspace lists complete without implicit location scopes', async () => {
  for (const args of [['project', 'list'], ['project', 'list', '--workspace', 'ws_filter'], ['workspace', 'list']]) {
    calls = []
    serve = (url) => Response.json({ data: [{ id: url.searchParams.has('after') ? 'second' : 'first', prefix: 'P', name: 'Name' }], next: url.searchParams.has('after') ? null : 'next' })
    const out = await run([...args, '--dir', empty])
    assert.equal(out.code, 0)
    assert.deepEqual(out.value.data.map((p: any) => p.id), ['first', 'second'])
    assert.equal(calls.length, 2)
    for (const { url } of calls) {
      assert.equal(url.searchParams.has('project'), false)
      assert.equal(url.searchParams.get('workspace'), args.includes('--workspace') ? 'ws_filter' : null)
    }
  }
})

it('submits creation once in the selected project and reports the actual asynchronous state', async () => {
  const request = '修复任务创建\n\n## Done when\n- 保留中文正文'
  for (const [args, cwd, project] of [
    [[], a, 'prj_a'], [['--dir', b], a, 'prj_b'], [['--project', 'prj_explicit'], empty, 'prj_explicit'],
  ] as const) for (const status of ['queued', 'running', 'failed']) for (const json of [true, false]) {
    calls = []
    serve = () => Response.json({ id: 'task_new', key: 'B-13', title: '修复任务创建', status, failure: status === 'failed' ? 'Runner failed.' : null })
    const out = await run(['task', 'create', request, '--studio', 'coding', ...args], json, cwd)
    assert.equal(out.code, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.method, 'POST')
    assert.equal(calls[0]!.url.pathname, '/v1/tasks')
    assert.deepEqual(calls[0]!.body, { title: '修复任务创建', request, project, studio: 'wf_builtin_coding', source: 'api', run: true })
    if (json) assert.equal(out.value.status, status)
    else {
      assert.match(out.stdout, /Created B-13: 修复任务创建.*\/tasks\/B-13/)
      assert.ok(out.stdout.includes(`Status: ${status}`))
      if (status === 'failed') assert.match(out.stdout, /Runner failed\./)
      assert.doesNotMatch(out.stdout, /card is ready|completed/i)
    }
  }
})

it('does not create without a studio or resend on refusal or a lost creation receipt', async () => {
  let out = await run(['task', 'create', 'New'])
  assert.equal(out.value.error.code, 'no_studio')
  assert.equal(calls.length, 0)
  for (const failure of ['forbidden', 'unreachable']) {
    calls = []
    serve = () => {
      if (failure === 'unreachable') throw new Error('Response lost after submission')
      return Response.json({ error: { code: failure, message: 'Creation refused.' } }, { status: 403 })
    }
    out = await run(['task', 'create', 'New', '--studio', 'coding'])
    assert.equal(out.code, 1)
    assert.equal(out.value.error.code, failure)
    assert.equal(calls.length, 1)
    assert.doesNotMatch(out.stdout, /Created B-|Status:/)
  }
})

it('restores the selected original task and reports its actual status', async () => {
  const r = await run(['task', 'restore', '12', '--board', b + '/.akb/kanban'])
  assert.equal(r.code, 0)
  assert.equal(r.value.ok, true)
  assert.equal(r.value.key, 'B-12')
  assert.equal(calls.at(-1)!.method, 'POST')
  assert.equal(calls.at(-1)!.url.pathname, '/v1/tasks/B-12/restore')
  serve = () => Response.json({ id: 'task_b', key: 'B-12', status: 'stopped' })
  assert.match((await run(['task', 'restore', 'B-12'], false)).stdout, /Restored B-12\. Status: stopped\./)
  serve = () => Response.json({ error: { code: 'conflict', message: 'The original card is missing.' } }, { status: 409 })
  const failed = await run(['task', 'restore', 'task_b'])
  assert.equal(failed.code, 1)
  assert.equal(failed.value.ok, false)
  assert.doesNotMatch(failed.stdout, /Restored /)
})
