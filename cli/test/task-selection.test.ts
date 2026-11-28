import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'
import { runAgent } from '../src/lib/agent-cli'
import { readSession, writeSession } from '../src/lib/cloud/session'
import { parseFrontmatter } from '../src/lib/frontmatter'
import { runnerMachineFile, runnerGrantsFile, runnerSocketPath } from '../src/lib/machine/runner'
import { projectStateDir } from '../src/lib/machine/project'
import { tryLock } from '../src/lib/lock'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
const machine = '00000000-0000-4000-8000-000000000002'
const execution = JSON.stringify({ job: '00000000-0000-4000-8000-000000000001', machine })
let root: string
let a: string
let b: string
let empty: string
let calls: { url: URL; method: string; body: any }[]
let serve: (url: URL) => Response
let socket: net.Server | undefined
const card = '---\ntitle: Current\npriority: med\nstatus: todo\nquestions: []\n---\n\nCard body.\n'

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

afterEach(async () => {
  if (socket) await new Promise<void>((resolve, reject) => socket!.close(error => error ? reject(error) : resolve()))
  socket = undefined
  globalThis.fetch = originalFetch
  for (const key of ['AI4KANBAN_HOME', 'WILDCRANE_HOME', 'AI4KANBAN_SUPABASE_URL', 'AI4KANBAN_CLOUD_URL', 'AI4KANBAN_BOARD', 'AI4KANBAN_REPLY_APPROVAL', 'AI4KANBAN_TASK', 'AI4KANBAN_EXECUTION', 'AI4KANBAN_REVIEW_SYNC', 'KANBAN_GOALS']) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

function localBoard(board = path.join(a, '.akb', 'kanban'), content = card) {
  fs.mkdirSync(path.join(board, 'todo'), { recursive: true })
  fs.writeFileSync(path.join(board, 'config.md'), '# Board\n')
  fs.writeFileSync(path.join(board, 'todo', 'README.md'), '# Tasks\n')
  fs.writeFileSync(path.join(board, 'todo', '12-card.md'), content)
  return board
}

function boundRunner() {
  fs.writeFileSync(runnerMachineFile(), JSON.stringify({ id: machine }))
  fs.writeFileSync(runnerGrantsFile(), JSON.stringify({ projects: [a] }))
  const normal = serve
  serve = url => {
    if (url.pathname !== '/v1/runner/folders') return normal(url)
    assert.equal(url.searchParams.get('machine'), machine)
    return Response.json({ folders: [{ path: a, project: 'prj_a' }] })
  }
}

async function online() {
  socket = net.createServer(peer => peer.end()).listen(runnerSocketPath())
  await once(socket, 'listening')
}

function boardSnapshot(board: string) {
  return fs.readdirSync(board, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name)).sort()
    .map(file => [path.relative(board, file), fs.readFileSync(file, 'utf8')])
}

async function runnerRefusal(argv: string[], code: string) {
  const out = await run(argv)
  assert.equal(out.code, 1, out.stderr || out.stdout)
  assert.equal(out.value.error.kind, 'runner-required', out.stdout)
  assert.equal(out.value.error.code, code, out.stdout)
  assert.match(out.value.error.message, /try again/)
}

async function run(argv: string[], json = true, cwd = a) {
  let stdout = ''; let stderr = ''
  const out = process.stdout.write; const err = process.stderr.write
  process.stdout.write = ((chunk: any) => {
    if (typeof chunk !== 'string') return out.call(process.stdout, chunk)
    stdout += chunk; return true
  }) as typeof out
  process.stderr.write = ((chunk: any) => {
    if (typeof chunk !== 'string') return err.call(process.stderr, chunk)
    stderr += chunk; return true
  }) as typeof err
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

it('resumes a linked project task number through the Cloud resume route', async () => {
  const normal = serve
  serve = url => url.pathname === '/v1/tasks/B-1198/resume'
    ? Response.json({ id: 'task_b', key: 'B-1198', status: 'queued' })
    : normal(url)
  const out = await run(['task', 'resume', '1198', '--dir', b])
  assert.equal(out.code, 0)
  assert.equal(out.value.key, 'B-1198')
  assert.equal(out.value.status, 'queued')
  assert.deepEqual(calls.map(({ method, url, body }) => [method, url.pathname, body]), [
    ['GET', '/v1/projects/prj_b', null],
    ['POST', '/v1/tasks/B-1198/resume', null],
  ])

  serve = () => Response.json({ error: { code: 'conflict', message: 'This task is already queued.' } }, { status: 409 })
  const refused = await run(['task', 'resume', 'task_b'])
  assert.notEqual(refused.code, 0)
  assert.equal(refused.value.error.message, 'This task is already queued.')
  assert.equal(calls.at(-1)!.url.pathname, '/v1/tasks/task_b/resume')
})

it('rejects the old public delivery resume command before opening the board', async () => {
  const help = await run(['delivery', '--help'], false)
  assert.match(help.stdout, /akb task resume <task>/)
  assert.doesNotMatch(help.stdout, /^\s+resume\s/m)

  const retired = await run(['delivery', 'resume', '1198', '--board', path.join(b, '.akb', 'kanban')])
  assert.notEqual(retired.code, 0)
  assert.match(retired.value.error.message, /unknown command 'resume'/)
  assert.deepEqual(calls, [])
  assert.deepEqual(fs.readdirSync(path.join(b, '.akb')), ['base.json'])
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
  process.env.AI4KANBAN_EXECUTION = execution
  boundRunner()
  await online()
  const normal = serve
  serve = url => {
    if (url.pathname === '/v1/tasks/A-12') return Response.json({ id: 'task_a', key: 'A-12', project: 'prj_a', status: 'running' })
    // The binding lookup leaves the board's sync lock free.
    if (url.pathname === '/v1/runner/folders') {
      const unlock = tryLock(path.join(projectStateDir(board), 'board-sync.lock'))
      assert.ok(unlock)
      unlock()
    }
    return normal(url)
  }

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

it('refuses offline edits before backfilling cards, renaming, indexing, or adding to the inbox', async () => {
  const board = localBoard()
  const before = boardSnapshot(board)
  for (const argv of [
    ['task', 'update', '12', '--slug', 'renamed'],
    ['raw', 'update', '12', '--title', 'Changed'],
    ['raw', 'update-questions', '12', '--clear'],
    ['raw', 'reject', '12', '--discard'],
    ['triage', 'add', '--title', 'Suggestion', '--text', 'Add this.'],
  ]) await runnerRefusal([...argv, '--board', board], 'runner-offline')
  assert.deepEqual(boardSnapshot(board), before)
  assert.equal(fs.existsSync(projectStateDir(board)), false)

  process.env.AI4KANBAN_BOARD = board
  process.env.AI4KANBAN_TASK = 'task_a'
  process.env.AI4KANBAN_EXECUTION = execution
  fs.mkdirSync(path.join(board, '.sync'))
  fs.writeFileSync(path.join(board, '.sync', 'task_a.json'), JSON.stringify({ task: 'task_a', number: 12 }))
  const current = boardSnapshot(board)
  for (const ref of ['task_a', '12']) await runnerRefusal(['task', 'update-questions', ref, '--clear'], 'runner-offline')
  assert.deepEqual(boardSnapshot(board), current)
  assert.equal(calls.length, 0)
  assert.equal((await run(['task', 'update-questions', 'task_b', '--clear'])).code, 0)
  assert.equal(calls.at(-1)!.url.pathname, '/v1/tasks/task_b/questions')
  assert.equal((await run(['task', 'inspect', '12', '--board', board])).code, 0)
  assert.equal((await run(['board', 'conflict', 'list', '--board', board])).code, 0)
  assert.equal((await run(['guide', 'board'])).code, 0)
  assert.equal(calls.filter(({ url }) => url.pathname === '/v1/runner/folders').length, 0)
})

it('rejects a Runner socket left behind by a crashed process', { skip: process.platform === 'win32' }, async () => {
  const board = localBoard()
  const file = runnerSocketPath()
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(process.argv[1], () => console.log('ready'))`, file])
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => assert.fail('Socket listener exited'))])
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }
  assert.ok(fs.lstatSync(file).isSocket())
  await runnerRefusal(['task', 'update', '12', '--title', 'Changed', '--board', board], 'runner-offline')
  assert.ok(fs.lstatSync(file).isSocket())
})

it('checks the Runner account, machine and matching Cloud folder before writing', async () => {
  const board = localBoard()
  const before = boardSnapshot(board)
  const update = ['task', 'update', '12', '--title', 'Changed', '--board', board]
  boundRunner()
  await online()
  const session = readSession()!
  const home = process.env.WILDCRANE_HOME!
  fs.rmSync(path.join(home, 'session.json'))
  await runnerRefusal(update, 'runner-signed-out')
  writeSession(session)
  fs.writeFileSync(runnerGrantsFile(), JSON.stringify({ projects: [a], accounts: { other: [a] } }))
  await runnerRefusal(update, 'runner-folder-not-authorized')
  fs.writeFileSync(runnerGrantsFile(), JSON.stringify({ projects: [], accounts: { account: [a] } }))
  const normal = serve
  for (const [reply, code] of [
    [() => Response.json({ folders: [] }), 'runner-project-not-bound'],
    [() => Response.json({ folders: [{ path: b, project: 'prj_a' }] }), 'runner-project-not-bound'],
    [() => Response.json({ folders: [{ path: a, project: 'prj_b' }] }), 'runner-project-link-invalid'],
    [() => Response.json({ folders: null }), 'runner-binding-unverified'],
    [() => { throw new Error('Cloud unreachable') }, 'runner-binding-unverified'],
    [(url: URL) => { writeSession({ ...session, subject: 'other' }); return normal(url) }, 'runner-signed-out'],
    [(url: URL) => { fs.writeFileSync(runnerMachineFile(), JSON.stringify({ id: '00000000-0000-4000-8000-000000000003' })); return normal(url) }, 'runner-project-not-bound'],
  ] as const) {
    writeSession(session)
    fs.writeFileSync(runnerMachineFile(), JSON.stringify({ id: machine }))
    serve = reply
    await runnerRefusal(update, code)
    assert.deepEqual(boardSnapshot(board), before)
  }
  const base = path.join(a, '.akb', 'base.json')
  for (const data of ['{', JSON.stringify({ project: 'prj_a', files: { 'projects/prj_b/config.md': {} } })]) {
    fs.writeFileSync(base, data)
    await runnerRefusal(update, 'runner-project-link-invalid')
    assert.deepEqual(boardSnapshot(board), before)
  }
})

it('checks the selected Runner board and accepts legacy grants and project records', async () => {
  const board = localBoard()
  boundRunner()
  await online()
  fs.writeFileSync(path.join(a, '.akb', 'base.json'), JSON.stringify({ files: { 'projects/prj_a/config.md': {} } }))
  const nested = path.join(a, 'sub')
  fs.mkdirSync(nested)
  assert.equal((await run(['task', 'update', '12', '--title', 'Nested'], true, nested)).code, 0)
  assert.equal((await run(['task', 'update', '12', '--title', 'Selected', '--dir', '../a'], true, b)).code, 0)
  const alias = path.join(b, 'board-alias')
  fs.symlinkSync(board, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await run(['task', 'update', '12', '--title', 'Alias', '--board', alias, '--dir', b])).code, 0)
  assert.match(fs.readFileSync(path.join(board, 'todo', '12-card.md'), 'utf8'), /title: Alias/)
  assert.equal((await run(['triage', 'add', '--title', 'Suggestion', '--text', 'Add this.', '--board', alias])).code, 0)
  assert.ok(boardSnapshot(board).some(([file]) => file?.startsWith('triage/')))

  const standalone = localBoard(path.join(a, 'docs', 'kanban'))
  calls = []
  assert.equal((await run(['task', 'update', '12', '--title', 'Local', '--dir', a])).code, 0)
  assert.match(fs.readFileSync(path.join(standalone, 'todo', '12-card.md'), 'utf8'), /title: Local/)
  assert.deepEqual(calls, [])
})

it('uses the Runner discussion board for goal drafts and preserves the direct triage job routes', async () => {
  const board = localBoard(undefined, card.replace('priority: med', 'studio: coding\npriority: med'))
  process.env.AI4KANBAN_BOARD = board
  const file = path.join(root, 'goals.json')
  const body = path.join(root, 'body.md')
  fs.writeFileSync(file, JSON.stringify({ studios: [{ id: 'wf_builtin_coding', name: 'Coding' }], goals: [] }))
  fs.writeFileSync(body, 'Content')
  process.env.KANBAN_GOALS = file
  const goals = [
    ['goal', 'new', '--title', 'New', '--body-file', body],
    ['goal', 'save', '--id', 'new_1', '--title', 'Changed'],
    ['goal', 'start', '--id', 'new_1'],
    ['goal', 'drop', '--id', 'new_1'],
  ]
  delete process.env.AI4KANBAN_BOARD
  const standalone = localBoard(path.join(a, 'docs', 'kanban'))
  assert.equal((await run([...goals[0]!, '--board', board], true, standalone)).code, 0)
  process.env.AI4KANBAN_BOARD = board
  const before = fs.readFileSync(file, 'utf8')
  for (const goal of goals) await runnerRefusal([...goal, '--board', standalone, '--dir', empty], 'runner-offline')
  assert.equal(fs.readFileSync(file, 'utf8'), before)

  process.env.AI4KANBAN_TASK = 'task_a'
  process.env.AI4KANBAN_EXECUTION = execution
  const normal = serve
  serve = url => url.pathname.endsWith('/triage') ? Response.json({ file: 'triage/1-suggestion.md' }) : normal(url)
  for (const [args, action] of [
    [['triage', 'add', '--title', 'Follow-up', '--text', 'Body', '--source', '#12', '--studio', 'coding', '--decision', 'review'], 'add'],
    [['triage', 'decide', 'source', '--decision', 'skip', '--reason', 'Handled'], 'decide'],
  ] as const) {
    const out = await run([...args])
    assert.equal(out.code, 0, out.stderr || out.stdout)
    assert.match(calls.at(-1)!.url.pathname, /^\/v1\/runner\/jobs\/[^/]+\/triage$/)
    assert.equal(calls.at(-1)!.body.action, action)
  }
  assert.equal(calls.filter(({ url }) => url.pathname === '/v1/runner/folders').length, 0)
  boundRunner()
  await online()
  for (const goal of goals) assert.equal((await run(goal)).code, 0)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).goals
  assert.equal(saved.length, 2)
  assert.equal(saved[0].start, true)
  assert.equal(saved[0].dropped, true)
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
  const out = await run(['task', 'approve', '12', '--stage', 'script', '--dir', '../b'])
  assert.equal(out.code, 0)
  assert.equal(out.value.pending, true)
  assert.deepEqual(calls.at(-1)!.body, { task: 'B-12', stage: 'script' })
})

it('uses one review snapshot for a conditional merge and reads again only after Preview synchronization', async () => {
  process.env.AI4KANBAN_TASK = 'task_b'
  const saved = { id: 'saved', title: { en: 'Saved', zh: '已保存' }, instructions: 'Keep it.' }
  const incoming = { id: 'new', title: { en: 'New', zh: '新增' }, instructions: 'Add it.' }
  const definitions = path.join(root, 'definitions.json')
  fs.writeFileSync(definitions, JSON.stringify([incoming]))
  let revision = 4
  const plan = { rule: 'Ask before delivery.', previews: ['saved'] }
  const review = () => ({ revision, plan, stages: [], preview_definitions: [saved] })
  let conflict = false
  serve = url => {
    if (url.pathname === '/') {
      revision++
      return Response.json({ ok: true })
    }
    if (url.pathname.endsWith('/review') && conflict) {
      return Response.json({ error: { code: 'review_outdated', message: 'Review changed.' } }, { status: 409 })
    }
    return Response.json({ id: 'task_b', review: review() })
  }
  const runReview = (args: string[]) => run(['task', 'review', 'B-12', ...args])
  const added = await runReview(['--add-previews', 'new', '--preview-definitions-file', definitions])
  assert.equal(added.code, 0, added.stderr)
  assert.equal(added.value.review.revision, undefined)
  assert.deepEqual(calls.map(c => c.method), ['GET', 'POST'])
  assert.deepEqual(calls.at(-1)!.body, {
    operation: 'plan', review_revision: 4, review_plan: { rule: plan.rule, previews: ['saved', 'new'] }, preview_definitions: [saved, incoming],
  })

  process.env.AI4KANBAN_REVIEW_SYNC = JSON.stringify({ url: 'http://127.0.0.1:12345/', token: 'a'.repeat(64) })
  calls = []
  const submitted = await runReview(['--request-approval', 'Approve this?', '--preview', 'saved'])
  assert.equal(submitted.code, 0, submitted.stderr)
  assert.deepEqual(calls.map(c => c.url.pathname), ['/v1/tasks/B-12', '/', '/v1/tasks/B-12', '/v1/tasks/B-12/review'])
  assert.deepEqual(calls[1]!.body, { task: 'task_b' })
  assert.deepEqual(calls[3]!.body, { operation: 'request_approval', question: 'Approve this?', preview: 'saved', review_revision: 5 })

  conflict = true
  calls = []
  const failed = await runReview(['--stage', 'saved', '--status', 'done'])
  assert.equal(failed.value.error.code, 'review_outdated')
  assert.match(failed.value.error.message, /Read the task and retry/)
  assert.deepEqual(calls.map(c => c.method), ['GET', 'POST'])
  assert.deepEqual(calls[1]!.body, { operation: 'status', stage: 'saved', status: 'done', review_revision: 5 })
})

it('projects every Agent Task receipt and keeps the standalone approval input explicit', async () => {
  const normal = serve
  const snapshot = { evidence: { assets: { 'draft.txt': { version: 55 } } } }
  const review = { revision: 21, plan: { rule: 'Ask for approval.', previews: ['copy'] },
    stages: [{ id: 'approval-19', revision: 20, requested_at_revision: 19, status: 'waiting_review', preview: 'copy',
      snapshot: { evidence: { ...snapshot.evidence, after: { draft: 18 } } } }],
    approvals: [{ stage: 'approval-19', revision: 20, preview: 'copy', question: 'Approve the copy?' }] }
  serve = url => {
    if (url.pathname.endsWith('/decisions')) return normal(url)
    const operation = url.pathname.split('/').at(-1)
    if (operation === 'card') return normal(url)
    const task = {
      id: 'task_b', key: 'B-12', title: 'Write copy', studio: null, runtime: 'rt_test',
      status: operation === 'cancel' ? 'cancelled' : operation === 'restore' ? 'stopped' : 'queued',
      review_revision: 21, review,
    }
    return Response.json(operation === 'tasks' && calls.at(-1)?.method === 'GET' ? { data: [task], next: null } : task)
  }
  const denied = await run(['task', 'approve', 'B-12'])
  assert.match(denied.value.error.message, /--revision/)
  assert.equal(calls.length, 0)
  assert.equal((await run(['task', 'review', 'B-12'])).value.review.revision, 21)
  assert.equal((await run(['task', 'approve', 'B-12', '--stage', 'approval-19', '--revision', '20'])).code, 0)
  assert.deepEqual(calls.at(-1)!.body, { decision: 'approve', stage: 'approval-19', review_revision: 20 })

  process.env.AI4KANBAN_TASK = 'task_b'
  for (const args of [
    ['review', 'B-12'], ['show', 'B-12'], ['list', '--project', 'prj_a'],
    ['create', 'New copy', '--studio', 'coding', '--project', 'prj_a'], ['remove', 'B-12'], ['restore', 'B-12'],
    ['resume', 'B-12'], ['resume', 'B-12', '--runtime', 'rt_test'], ['stop', 'B-12'], ['update-questions', 'B-12', '--clear'],
  ]) {
    const result = await run(['task', ...args])
    assert.equal(result.code, 0, result.stderr || result.stdout)
    const receipt = args[0] === 'list' ? result.value.data[0] : result.value
    assert.doesNotMatch(JSON.stringify(receipt), /"review_revision"|"revision"|"requested_at_revision"|version 20/)
    assert.deepEqual(receipt.review.stages[0].snapshot, snapshot)
    assert.deepEqual(receipt.review.approvals, [{ stage: 'approval-19', preview: 'copy', question: 'Approve the copy?' }])
  }
  const terminal = await run(['task', 'show', 'B-12'], false)
  assert.match(terminal.stdout, /approval-19 · copy · Approve the copy\?/)
  assert.doesNotMatch(terminal.stdout, /version 20/)
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

it('passes --review, --review-file, and --preview-definitions-file on request creation and rejects invalid combinations', async () => {
  const reviewFile = path.join(a, 'review.json')
  const defsFile = path.join(a, 'defs.json')
  const plan = [{ id: 'ui-design', after: [], previews: ['ui-design'] }]
  const defs = [{ id: 'accessibility-report', title: { en: 'Accessibility report', zh: '无障碍检查报告' }, instructions: 'Check contrast.' }]
  fs.writeFileSync(reviewFile, JSON.stringify(plan))
  fs.writeFileSync(defsFile, JSON.stringify(defs))

  calls = []
  serve = () => Response.json({ id: 'task_new', key: 'B-14', title: 'Review task', status: 'queued' })
  let out = await run(['task', 'create', 'Review task', '--studio', 'coding', '--review', 'UI design -> Accessibility report', '--preview-definitions-file', defsFile], true, a)
  assert.equal(out.code, 0)
  assert.deepEqual(calls[0]!.body, {
    title: 'Review task', request: 'Review task', project: 'prj_a', studio: 'wf_builtin_coding',
    source: 'api', run: true, review_flow: 'UI design -> Accessibility report', preview_definitions: defs,
  })

  calls = []
  out = await run(['task', 'create', 'File plan', '--studio', 'coding', '--review-file', reviewFile], true, a)
  assert.equal(out.code, 0)
  assert.deepEqual(calls[0]!.body, {
    title: 'File plan', request: 'File plan', project: 'prj_a', studio: 'wf_builtin_coding',
    source: 'api', run: true, review_plan: plan,
  })

  for (const args of [
    ['task', 'create', 'Both', '--studio', 'coding', '--review', 'UI design', '--review-file', reviewFile],
    ['task', 'create', '--title', 'Local', '--review', 'UI design'],
    ['task', 'create', '--title', 'Local', '--review-file', reviewFile],
    ['task', 'create', '--title', 'Local', '--preview-definitions-file', defsFile],
  ]) {
    calls = []
    const bad = await run(args, true, a)
    assert.equal(bad.code, 1, args.join(' '))
    assert.equal(calls.length, 0)
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

it('resumes with a runtime ID or a name from the operation options', async () => {
  const baseServe = serve
  serve = (url) => {
    if (url.pathname === '/v1/tasks/B-12/runtimes' && url.searchParams.get('for') === 'resume') {
      return Response.json({ action: 'implement', data: [
        { id: 'rt_default', name: 'Default', default: true },
        { id: 'rt_kimi', name: 'Kimi Lite' },
        { id: 'rt_dup_1', name: 'Shared' },
        { id: 'rt_dup_2', name: 'Shared' },
      ] })
    }
    if (url.pathname === '/v1/tasks/B-12/resume') return Response.json({ id: 'task_b', key: 'B-12', status: 'queued' })
    return baseServe(url)
  }
  for (const [input, target] of [['rt_kimi', 'rt_kimi'], ['Kimi Lite', 'rt_kimi'], ['Global default', 'rt_default']]) {
    calls = []
    const receipt = await run(['task', 'resume', 'B-12', '--runtime', input!])
    assert.equal(receipt.code, 0)
    assert.equal(receipt.value.status, 'queued')
    assert.equal(calls.at(-1)?.method, 'POST')
    assert.equal(calls.at(-1)?.body?.runtime, target)
    assert.equal(calls.length, input === 'rt_kimi' ? 1 : 2)
  }
  for (const [name, error] of [['Missing', 'not_found'], ['Shared', 'conflict']]) {
    calls = []
    const receipt = await run(['task', 'resume', 'B-12', '--runtime', name!])
    assert.equal(receipt.code, 1)
    assert.equal(receipt.value.error.code, error)
    assert.equal(calls.length, 1)
  }
  assert.notEqual((await run(['task', 'runtime', 'B-12', 'rt_kimi'])).code, 0)
})

it('uses the same Cloud error and reason for terminal and JSON, and requires mutation receipts', async () => {
  const commands = [
    ['archive', 'B-12'], ['remove', 'B-12'], ['restore', 'B-12'], ['resume', 'B-12'], ['resume', 'B-12', '--runtime', 'rt_kimi'], ['stop', 'B-12'],
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

it('shows the readable card, current review, approved pins and chat together', async (t) => {
  const board = path.join(a, '.akb', 'kanban')
  const assetFolder = path.join(fs.realpathSync(a), '.akb', 'state', 'assets', '12')
  const card = path.join(board, 'todo', '12-export', 'root.md')
  const chat = path.join(process.env.AI4KANBAN_HOME!, 'chats', 'task_a.jsonl')
  const manifest = path.join(root, 'previews.md')
  const record = path.join(board, '.sync', 'task_a.json')
  const source = '.assets/12/export.txt'
  const body = '---\ntitle: Export\nquestions:\n  - Which format?\n---\n\n<Preview id="ui-design">\n\nDraft here.\n\n</Preview>\n'
  for (const [file, content] of [[card, body], [chat, '{"text":"A private message"}\n'], [manifest, 'Frozen inputs\n'],
    [record, JSON.stringify({ task: 'task_a', number: 12 })]] as const) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  process.env.AI4KANBAN_BOARD = board
  process.env.AI4KANBAN_TASK = 'task_a'
  const previousManifest = process.env.AI4KANBAN_SAVED_PREVIEW_FILE
  process.env.AI4KANBAN_SAVED_PREVIEW_FILE = manifest
  t.after(() => {
    if (previousManifest === undefined) delete process.env.AI4KANBAN_SAVED_PREVIEW_FILE
    else process.env.AI4KANBAN_SAVED_PREVIEW_FILE = previousManifest
  })

  const review = { revision: 7, plan: [{ id: 'design', after: [], previews: ['ui-design'] }],
    stages: [{ id: 'design', status: 'approved', revision: 6, snapshot: {
      body: 'Frozen review text',
      evidence: { content: { 'ui-design': { sources: [source] } }, assets: { [source]: { artifact: 'art_a', version: 2 } } },
    } }] }
  serve = url => url.pathname.endsWith('/card') ? Response.json({ body, version: 8 }) : Response.json({
    id: 'task_a', key: 'A-12', project: 'prj_a', title: 'Export', status: 'running',
    studio: { id: 'wf_builtin_coding', name: 'Coding' }, review, card_version: 8,
    preview_inputs: { sections: { 'ui-design': { sources: [source] } }, assets: { [source]: { version: 3 } } },
  })
  const shown = await run(['task', 'show', 'A-12'])
  assert.equal(shown.code, 0, shown.stderr)
  assert.deepEqual(shown.value.review, { plan: review.plan, stages: [{ id: 'design', status: 'approved', snapshot: review.stages[0]!.snapshot }] })
  assert.deepEqual(shown.value.card, { body, version: 8 })
  assert.equal(shown.value.local_context.card_file, card)
  assert.equal(shown.value.local_context.asset_folder, assetFolder)
  assert.equal(shown.value.local_context.chat_file, chat)
  assert.equal(shown.value.local_context.approved_inputs_file, manifest)
  assert.match(shown.value.output, /Which format\?[\s\S]*## Review[\s\S]*design · ui-design · approved/)
  assert.match(shown.value.output, /saved version 3[\s\S]*approved version 2 · design/)
  assert.doesNotMatch(shown.value.output, /A private message|Frozen review text|Frozen inputs|\br[67]\b/)
  assert.equal(calls.length, 2)

  const terminal = await run(['task', 'show', 'A-12', '--board', '.akb/kanban'], false)
  assert.equal(terminal.code, 0, terminal.stderr)
  assert.ok(terminal.stdout.split('\n').includes(`Asset folder: ${assetFolder}`))
  assert.equal(fs.existsSync(assetFolder), false)

  const otherArgs = ['task', 'show', 'A-12', '--board', '../b/.akb/kanban']
  const otherBoard = await run(otherArgs)
  assert.equal(otherBoard.value.local_context.card_file, null)
  assert.equal(otherBoard.value.local_context.asset_folder, null)
  assert.equal(otherBoard.value.local_context.approved_inputs_file, null)
  const otherTerminal = await run(otherArgs, false)
  assert.equal(otherTerminal.code, 0, otherTerminal.stderr)
  assert.doesNotMatch(otherTerminal.stdout, /^Asset folder:/m)
})
