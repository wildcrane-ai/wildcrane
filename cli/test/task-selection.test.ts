import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'
import { runAgent } from '../src/lib/agent-cli'
import { writeSession } from '../src/lib/cloud/session'
import { parseFrontmatter } from '../src/lib/frontmatter'

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
    if (route.endsWith('/decisions')) return Response.json({ id: 'dec_1', decision: 'approve' })
    if (route.endsWith('/comments')) return Response.json({ id: 'cmt_1', body: 'Note' })
    if (route.endsWith('/stop') || route.endsWith('/resume')) return Response.json({ id: 'task_b', key: 'B-12', status: 'queued' })
    if (route.endsWith('/cancel')) return Response.json({ id: 'task_b', key: 'B-12', status: 'cancelled' })
    if (route.endsWith('/restore')) return Response.json({ id: 'task_b', key: 'B-12', status: 'stopped' })
    if (route.endsWith('/card')) return Response.json({ version: 1, body: '---\nquestions: []\n---\n' })
    if (route.endsWith('/chat')) return Response.json(calls.at(-1)?.method === 'POST'
      ? { status: 'queued', job: 'job_1', messages: [{ id: 'msg_1', role: 'user', body: 'Hello' }] }
      : { status: 'idle', job: null, messages: [] })
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
  for (const key of ['AI4KANBAN_HOME', 'WILDCRANE_HOME', 'AI4KANBAN_SUPABASE_URL', 'AI4KANBAN_CLOUD_URL', 'AI4KANBAN_BOARD', 'AI4KANBAN_REPLY_APPROVAL', 'AI4KANBAN_TASK', 'AI4KANBAN_EXECUTION']) {
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

it('edits only the current Runner task locally, using the selected board and task identity', async () => {
  const board = path.join(a, '.akb', 'kanban')
  const record = path.join(board, '.sync', 'task_a.json')
  const file = path.join(board, 'todo', '12-card.md')
  fs.mkdirSync(path.dirname(record), { recursive: true })
  fs.mkdirSync(path.dirname(file))
  const card = ['---', 'title: Current', 'status: implementing', 'questions:',
    '  - Plain?', '  - question: Owned?', '    options:', '      - Yes', '      - No',
    '    agent: first-agent', '---', '', 'Local answer already saved.', ''].join('\n')
  fs.writeFileSync(file, card)
  fs.writeFileSync(record, JSON.stringify({ task: 'task_a', number: 12 }))
  process.env.AI4KANBAN_BOARD = board
  process.env.AI4KANBAN_TASK = 'task_a'
  process.env.AI4KANBAN_EXECUTION = JSON.stringify({ job: '00000000-0000-4000-8000-000000000001', machine: '00000000-0000-4000-8000-000000000002' })
  const normal = serve
  serve = url => url.pathname === '/v1/tasks/A-12'
    ? Response.json({ id: 'task_a', key: 'A-12', project: 'prj_a', status: 'running' })
    : normal(url)

  for (const [ref, args] of [
    ['task_a', ['--append', 'New?', '--option', 'One', '--recommended-option', 'Two', '--agent', 'new-agent',
      '--drop', '2', '--update', '2', 'Rewritten?', '--option', 'A', '--option', 'B']],
    ['A-12', ['--append', 'Temporary?', '--option', 'A', '--option', 'B', '--drop', '3']],
    ['12', ['--append', 'Temporary?', '--option', 'A', '--option', 'B', '--drop', '3']],
  ] as const) {
    const out = await run(['task', 'update-questions', ref, ...args])
    assert.equal(out.code, 0, out.stderr || out.stdout)
    assert.equal(out.value.id, 12)
    assert.equal(out.value.open, 2)
    assert.match(out.value.file, /todo\/12-card\.md$/)
    assert.deepEqual(out.value.changes, ref === 'task_a' ? ['appended', 'dropped 2', 'rewrote 2'] : ['appended', 'dropped 3'])
  }
  assert.ok(calls.every(call => call.method === 'GET'))
  const saved = fs.readFileSync(file, 'utf8')
  assert.match(saved, /Local answer already saved\./)
  assert.deepEqual(parseFrontmatter(saved).meta?.questions, [
    { text: 'Plain?' },
    { text: 'Rewritten?', options: ['A', 'B'], mode: 'single', recommend: [], agent: 'new-agent' },
  ])
  assert.notEqual((await run(['task', 'update-questions', 'task_a', '--clear', '--drop', '1'])).code, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), saved)

  const remote = await run(['task', 'update-questions', '12', '--clear', '--board', path.join(b, '.akb', 'kanban')])
  assert.equal(remote.code, 0, remote.stderr || remote.stdout)
  assert.equal(calls.at(-1)!.url.pathname, '/v1/tasks/task_b/questions')
  assert.equal(fs.readFileSync(file, 'utf8'), saved)

  for (const badNumber of [12, 13, null]) {
    if (badNumber === 12) fs.renameSync(file, file + '.bak')
    else if (badNumber === 13) fs.writeFileSync(record, JSON.stringify({ task: 'task_a', number: 13 }))
    else fs.rmSync(record)
    const refused = await run(['task', 'update-questions', '12', '--clear'])
    assert.equal(refused.value.error?.code, 'local_card_unavailable')
    assert.equal(fs.readFileSync(file + '.bak', 'utf8'), saved)
    assert.equal(calls.filter(call => call.method === 'PATCH').length, 1)
    if (badNumber === 12) fs.writeFileSync(path.join(board, 'todo', '13-other.md'), card)
  }
  assert.equal(fs.readFileSync(path.join(board, 'todo', '13-other.md'), 'utf8'), card)
})

it('validates the entire question batch before a write and reports a stale Cloud version without retrying', async () => {
  const edit = ['task', 'update-questions', 'task_b']
  for (const args of [
    Array(51).fill('--clear'),
    ['--append', '问'.repeat(1334), '--option', 'A', '--option', 'B'],
    ['--append', 'New?', '--option', '选'.repeat(67), '--option', 'B'],
    ['--append', 'New?', ...Array.from({ length: 21 }, (_, i) => ['--option', String(i)]).flat()],
    ['--append', 'New?', '--option', 'A', '--option', 'A'],
    ['--append', 'New?', '--mode', 'multi', '--recommended-option', 'A', '--recommended-option', 'B'],
    ['--append', 'New?', '--option', 'A', '--option', 'B', '--agent', 'Invalid Name'],
    ['--clear', '--option', 'A'],
  ]) assert.notEqual((await run([...edit, ...args])).code, 0)
  assert.equal(calls.length, 0)

  const normal = serve
  serve = url => url.pathname.endsWith('/questions')
    ? Response.json({ error: { code: 'version_conflict', message: 'The card changed.' } }, { status: 409 })
    : normal(url)
  const out = await run([...edit, '--append', 'New?', '--option', 'A', '--option', 'B', '--drop', '1'])
  assert.notEqual(out.code, 0)
  assert.equal(out.value.error?.code, 'version_conflict')
  assert.deepEqual(calls.map(call => [call.method, call.url.pathname]), [
    ['GET', '/v1/tasks/task_b/card'], ['PATCH', '/v1/tasks/task_b/questions'],
  ])
  assert.deepEqual(calls.at(-1)!.body, {
    base_version: 1,
    ops: [{ append: { text: 'New?', options: ['A', 'B'], recommend: [], mode: 'single' } }, { drop: [1] }],
  })
})

it('removes only the current task locally and sends any other removal to Cloud', async () => {
  const boardFor = (dir: string) => {
    const board = path.join(dir, '.akb', 'kanban')
    const card = (title: string, blockers = '[]') =>
      `---\ntitle: ${title}\npriority: med\nstatus: todo\nstudio: coding\nblocked_by: ${blockers}\nquestions: []\n---\n\nBody.\n`
    fs.mkdirSync(path.join(board, '.sync'), { recursive: true })
    fs.mkdirSync(path.join(board, 'todo'))
    fs.writeFileSync(path.join(board, 'config.md'), '# Board\n')
    fs.writeFileSync(path.join(board, '.sync', 'task_a.json'), JSON.stringify({ task: 'task_a', number: 12 }))
    fs.writeFileSync(path.join(board, 'todo', '12-current.md'), card('Current'))
    fs.writeFileSync(path.join(board, 'todo', '13-blocked.md'), card('Waiting', '[12]'))
    return board
  }
  const current = boardFor(a)
  const other = boardFor(b)
  process.env.AI4KANBAN_BOARD = current
  process.env.AI4KANBAN_TASK = 'task_a'
  process.env.AI4KANBAN_EXECUTION = JSON.stringify({ job: '00000000-0000-4000-8000-000000000001', machine: '00000000-0000-4000-8000-000000000002' })
  const normal = serve
  serve = url => url.pathname === '/v1/tasks/OLD-12'
    ? Response.json({ id: 'task_a', key: 'A-12', project: 'prj_a' })
    : normal(url)

  const remote = await run(['task', 'remove', '12', 'Cleanup', '--board', other])
  assert.equal(remote.code, 0)
  assert.equal(calls.at(-1)!.url.pathname, '/v1/tasks/B-12/cancel')
  assert.deepEqual(calls.at(-1)!.body, { reason: 'Cleanup', discard: true })
  assert.ok(fs.existsSync(path.join(other, 'todo', '12-current.md')))
  assert.ok(fs.existsSync(path.join(current, 'todo', '12-current.md')))

  const local = await run(['task', 'remove', 'OLD-12', '--reason', 'Superseded'])
  assert.equal(local.code, 0)
  assert.match(local.value.output, /queued for Runner synchronization/)
  assert.equal(local.value.remove_status, 'pending_sync')
  assert.equal(calls.at(-1)!.url.pathname, '/v1/tasks/OLD-12')
  const receipt = path.join(current, '.sync', 'task_a.removal.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), { status: 'pending', reason: 'Superseded', discard: true })
  assert.ok(fs.existsSync(path.join(current, 'todo', '12-current.md')))
  assert.match(fs.readFileSync(path.join(current, 'todo', '13-blocked.md'), 'utf8'), /blocked_by: \[12\]/)
  assert.equal((await run(['task', 'remove', '12', 'Keep why', '--discard'])).value.remove_status, 'pending_sync')
  assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).reason, 'Superseded')
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
      assert.deepEqual(out.value.error, { kind: 'forbidden', code: 'forbidden', message: 'Second page refused.', status: 403, retryable: false })
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

it('uses the same Cloud error and reason for terminal and JSON, and requires mutation receipts', async () => {
  const commands = [
    ['archive', 'B-12'], ['remove', 'B-12'], ['restore', 'B-12'], ['resume', 'B-12'], ['stop', 'B-12'],
    ['approve', 'B-12', '--revision', '0'], ['chat', 'B-12', 'Hello'], ['comment', 'B-12', 'Hello'],
  ]
  for (const args of commands) {
    serve = () => Response.json({})
    const missing = await run(['task', ...args])
    assert.equal(missing.code, 1, args[0])
    assert.equal(missing.value.error.code, 'invalid_response')
    assert.equal(missing.value.error.retryable, true)
    assert.equal(missing.value.output, undefined)

    serve = () => Response.json({ error: { code: 'conflict', message: 'The task changed.' } }, { status: 409 })
    const terminal = await run(['task', ...args], false)
    const json = await run(['task', ...args])
    assert.equal(terminal.code, 1)
    assert.equal(json.code, 1)
    assert.equal(json.value.error.code, 'conflict')
    assert.equal(json.value.error.retryable, false)
    assert.equal(terminal.stderr.trim(), `akb: [${json.value.error.code}] ${json.value.error.message}`)
  }
})

it('distinguishes a missing card, read failure, queued resume and requested stop', async () => {
  const task = { id: 'task_b', key: 'B-12', title: 'Work', status: 'running', studio: { name: 'Coding' } }
  const missing = () => Response.json({ error: { code: 'not_found', message: 'No card.' } }, { status: 404 })
  serve = url => url.pathname.endsWith('/card') ? missing() : Response.json({ ...task, card_version: null })
  assert.equal((await run(['task', 'show', 'B-12'])).value.card_read_status, 'not_generated')

  serve = url => url.pathname.endsWith('/card') ? missing() : Response.json({ ...task, card_version: 3 })
  assert.equal((await run(['task', 'show', 'B-12'])).value.error.code, 'not_found')

  serve = url => url.pathname.endsWith('/card')
    ? Response.json({ error: { code: 'service_unavailable', message: 'Card storage unavailable.' } }, { status: 503 })
    : Response.json({ ...task, card_version: null })
  const show = await run(['task', 'show', 'B-12'])
  assert.equal(show.code, 1)
  assert.equal(show.value.error.message, 'Card storage unavailable.')
  assert.equal(show.value.error.retryable, true)

  serve = () => Response.json({ ...task, status: 'queued' })
  assert.match((await run(['task', 'resume', 'B-12'])).value.output, /Resume queued/)
  serve = () => Response.json({ ...task, status: 'done' })
  assert.match((await run(['task', 'resume', 'B-12'])).value.error.message, /has finished/)
  serve = () => Response.json({ ...task, status: 'failed', failure: 'The target computer is offline.' })
  assert.equal((await run(['task', 'resume', 'B-12'])).value.error.message, 'The target computer is offline.')
  serve = () => Response.json(task)
  assert.equal((await run(['task', 'stop', 'B-12'])).value.stop_status, 'requested')
  serve = () => Response.json({ ...task, status: 'stopped' })
  assert.equal((await run(['task', 'stop', 'B-12'])).value.stop_status, 'stopped')

  serve = () => Response.json({ id: 'cmt_1', body: 'Hello' }, { status: 201 })
  assert.equal((await run(['task', 'comment', 'B-12', 'Hello'])).code, 0)
})

it('reports account verification failure and cached identity without claiming sign-in was verified', async () => {
  const commands = ['account']
  for (const [code, status, value] of [
    ['invalid_response', 200, { session: {} }],
    ['service_unavailable', 503, { error: { code: 'service_unavailable', message: 'Cloud is unavailable.' } }],
    ['unauthenticated', 401, { error: { code: 'unauthenticated', message: 'Sign in again.' } }],
  ] as const) {
    serve = () => Response.json(value, { status })
    const json = await run(commands)
    assert.equal(json.code, 1)
    assert.equal(json.value.error.code, code)
    assert.equal(json.value.error.cached, true)
    const terminal = await run(commands, false)
    assert.equal(terminal.code, 1)
    assert.ok(terminal.stderr.includes(json.value.error.message))
  }
})
