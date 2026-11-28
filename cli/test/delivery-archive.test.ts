import { prepareDelivery } from '../src/lib/agent/commit-mode.ts'
import { recordDeliveryArchive, recordImplementationCommit } from '../src/lib/agent/delivery-archive.ts'
import { lockDeliveryProject } from '../src/lib/agent/delivery-workspace.ts'
import { taskArchive } from '../src/commands/task.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, it } from 'node:test'
import { buildAkbProgram } from '../src/lib/cli/akb.ts'
import { buildBoardProgram } from '../src/lib/cli/board.ts'
import { cmdLog, cmdResume } from '../src/commands/run.ts'
import { activeDelivery, findDelivery, joinDelivery, settleOrphanedDeliveries } from '../src/lib/agent/deliveries.ts'
import { DELIVERY_PHASE_ENV, RUN_ENV } from '../src/lib/agent/env.ts'
import { nextDeliveryRun } from '../src/lib/agent/progress.ts'
import { closeRun, cancelDelivery, openResume, openRun, reconcileCardDelivery } from '../src/lib/agent/sessions.ts'
import { logPathOf, readAction, withStore } from '../src/lib/agent/store.ts'
import type { RunRecord } from '../src/lib/agent/types.ts'
import { BoardError } from '../src/lib/io.ts'
import { setBoardDir, setBoardRoot } from '../src/lib/paths.ts'
import { writeSession } from '../src/lib/cloud/session.ts'
import { move, run } from './helpers/board.ts'

let root: string
let card: string
let deliveryId: string
const sha = 'a'.repeat(40)

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-complete-'))
  fs.mkdirSync(path.join(root, 'docs/kanban/todo'), { recursive: true })
  setBoardRoot(root)
  delete process.env[RUN_ENV]
  await move(root, ['create', '--id', '1', '--title', 'Deliver it'])
  card = path.join(root, 'docs/kanban/todo/1-deliver-it.md')
  fs.writeFileSync(card, fs.readFileSync(card, 'utf8').replace('- [ ] ', '- [x] '))
  deliveryId = open('first')
  process.env[RUN_ENV] = 'first'
})
afterEach(() => {
  delete process.env[RUN_ENV]
  fs.rmSync(root, { recursive: true, force: true })
})
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function open(sessionId: string): string {
  return withStore((store) => {
    const run: RunRecord = { sessionId, cardId: 1, action: 'implement', status: 'running', startedAt: Date.now(),
      harness: 'claude-code', logPath: logPathOf(sessionId) }
    fs.mkdirSync(path.dirname(run.logPath), { recursive: true })
    fs.writeFileSync(run.logPath, '')
    store.runs.push(run)
    return joinDelivery(store, run, 'Deliver it', 'implement').deliveryId
  })
}
function patch(change: (delivery: NonNullable<ReturnType<typeof findDelivery>>) => void) {
  withStore((store) => change(store.deliveries.find((d) => d.deliveryId === deliveryId)!))
}

it('does not finish on a successful process exit', async () => {
  await closeRun('first', { status: 'done' })
  assert.equal(activeDelivery(1)?.status, 'active')
  assert.ok(fs.existsSync(card))
})
it('distinguishes a cancelled delivery from a recorded discard when following a stopped run', async () => {
  await closeRun('first', { status: 'stopped' })
  assert.equal((await cancelDelivery(deliveryId)).ok, true)
  const followed = () => cmdLog('first', { follow: true })

  for (const kind of ['stopped', 'discarded']) {
    await assert.rejects(followed, (error: unknown) => {
      assert.ok(error instanceof BoardError)
      assert.equal(error.kind, 'run-failed')
      assert.deepEqual(error.details.delivery, { id: deliveryId, status: 'cancelled', line: 'cancelled', ending: { kind } })
      return true
    })
    if (kind === 'stopped') patch(d => { d.steps.push({ step: 'discarded', at: Date.now() }) })
  }
})
it('returns the original delivery blocker even when the followed run exited successfully', async () => {
  await closeRun('first', { status: 'done' })
  const reason = 'could not land on main\nThe API moved.'
  patch(d => { d.review = { rounds: [], stopped: { reason: 'landing', why: reason, at: 1 } } })
  const followed = await cmdLog('first', { follow: true })
  assert.equal(followed.status, 'done')
  const delivery = followed.delivery as { status: string; ending: unknown }
  assert.equal(delivery.status, 'active')
  assert.deepEqual(delivery.ending, { kind: 'blocked', reason })
})
it('keeps a non-Git implementation and its baseline separate from the project', () => {
  process.env[DELIVERY_PHASE_ENV] = 'implement'
  try {
    fs.writeFileSync(path.join(root, 'article.md'), 'Original')
    const made = prepareDelivery(1)
    assert.ok('start' in made)
    const work = path.join(root, made.start.worktree!)
    fs.writeFileSync(path.join(work, 'article.md'), 'Draft')
    assert.equal(fs.readFileSync(path.join(work, '../base/article.md'), 'utf8'), 'Original')
    assert.equal(fs.readFileSync(path.join(root, 'article.md'), 'utf8'), 'Original')
  } finally { delete process.env[DELIVERY_PHASE_ENV] }
})

it('saves the first Git implementation commit without including user changes or a later target commit', async () => {
  git('init', '-qb', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  const made = prepareDelivery(1)
  assert.ok('start' in made)
  assert.equal(made.start.worktree, '.')
  assert.equal(made.start.base, undefined)
  patch(d => Object.assign(d, { ...made.start, deliveryId }))
  fs.writeFileSync(path.join(root, 'user.txt'), 'Staged')
  git('add', 'user.txt')
  fs.writeFileSync(path.join(root, 'user.txt'), 'Unstaged')
  fs.writeFileSync(path.join(root, 'task.txt'), 'Finished')
  git('add', 'task.txt')
  git('commit', '-qm', 'Task result', '--only', '--', 'task.txt')
  const commit = git('rev-parse', 'HEAD')
  assert.equal(git('ls-tree', '--name-only', 'HEAD'), 'task.txt')
  assert.equal(git('show', ':user.txt'), 'Staged')
  assert.equal(fs.readFileSync(path.join(root, 'user.txt'), 'utf8'), 'Unstaged')
  assert.equal(recordImplementationCommit(deliveryId, 'first', null), true)
  git('commit', '-qm', 'Parallel change', '--allow-empty', '--only')
  await closeRun('first', { status: 'done' })
  assert.equal(nextDeliveryRun(deliveryId), undefined)
  process.env[DELIVERY_PHASE_ENV] = 'land'
  try {
    assert.equal((await reconcileCardDelivery(1)).kind, 'resumable')
    recordDeliveryArchive(1)
    assert.deepEqual(await reconcileCardDelivery(1), {
      kind: 'completed', deliveryId, sessionId: 'first', commit, branch: 'main',
    })
  } finally { delete process.env[DELIVERY_PHASE_ENV] }
})

it('uses a directory copy with an initialized repository when Git is unavailable', () => {
  git('init', '-qb', 'main')
  const env = process.env.PATH
  process.env.PATH = ''
  try {
    const made = prepareDelivery(1)
    assert.ok('start' in made)
    assert.match(made.start.worktree!, /worktrees[/\\].+[/\\]work$/)
    assert.equal(made.start.branch, undefined)
  } finally { process.env.PATH = env }
})

it('serializes project access and lets a waiting operation stop and retry', async () => {
  const release = await lockDeliveryProject(root, () => false)
  assert.ok(release)
  const alias = path.join(root, 'alias')
  fs.symlinkSync(root, alias, 'junction')
  let stopped = false
  let granted = false
  const waiting = lockDeliveryProject(alias, () => stopped).then(unlock => { granted = !!unlock; unlock?.() })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(granted, false)
  stopped = true
  await waiting
  assert.equal(granted, false)
  release()
  const retried = await lockDeliveryProject(alias, () => false)
  assert.ok(retried)
  retried()
})

it('archives an active non-Git delivery and returns the same archive on retry', async () => {
  assert.equal(findDelivery(deliveryId)?.base, undefined)
  const result = await taskArchive('1', { cwd: root })
  assert.equal(result.archive_status, 'archived')
  assert.equal(fs.existsSync(card), false)
  assert.equal(findDelivery(deliveryId)?.status, 'finished')
  assert.equal(findDelivery(deliveryId)?.landing, undefined)
  assert.equal((await taskArchive('1', { cwd: root })).archived_to, result.archived_to)
  const resumed = await cmdResume('first', {})
  assert.equal((resumed.delivery as { id: string }).id, deliveryId)
})

it('does not return a completed delivery for a different task on resume (#1248)', async () => {
  await taskArchive('1', { cwd: root })
  const execution = { job: '11111111-1111-4111-8111-111111111111', machine: '22222222-2222-4222-8222-222222222222' }
  try {
    process.env.AI4KANBAN_EXECUTION = JSON.stringify({ ...execution, card: 2 })
    await assert.rejects(cmdResume('first', {}), /belongs to a different task/)
    process.env.AI4KANBAN_EXECUTION = JSON.stringify({ ...execution, card: 1 })
    const own = await cmdResume('first', {})
    assert.equal((own.delivery as { id: string }).id, deliveryId)
    patch(d => { d.cardId = 2 })
    await assert.rejects(cmdResume('first', {}), /belongs to a different task/)
    const resumed = await openResume('first')
    assert.match('error' in resumed ? resumed.error : '', /belongs to a different task/)
  } finally {
    delete process.env.AI4KANBAN_EXECUTION
  }
})

it('refuses to archive a delivery with open questions', async () => {
  await move(root, ['update-questions', '1', '--append', 'Grant deployment access?',
    '--recommended-option', 'Grant this account access', '--option', 'Use another account'])
  await assert.rejects(() => taskArchive('1', { cwd: root }), /open questions/)
  assert.equal(findDelivery(deliveryId)?.status, 'active')
})

it('retains old Git context and leaves directories intact on cancel', async () => {
  const tree = path.join(root, '.akb/worktrees/1/legacy')
  fs.mkdirSync(tree, { recursive: true })
  fs.writeFileSync(path.join(tree, 'pending.txt'), 'work')
  patch((d) => { d.worktree = tree; d.branch = 'card/1/legacy'; d.base = sha; d.landing = { status: 'landing', at: 1, attempts: 1 } })
  await closeRun('first', { status: 'stopped' })
  await cancelDelivery(deliveryId)
  assert.equal(fs.readFileSync(path.join(tree, 'pending.txt'), 'utf8'), 'work')
  assert.equal(findDelivery(deliveryId)?.branch, 'card/1/legacy')
  assert.equal(readAction('conflict'), 'implement')
  const stale = openRun({ action: 'implement', id: 1, deliveryId }, 'Continue', [])
  assert.ok('error' in stale)
  assert.equal(findDelivery(deliveryId)?.status, 'cancelled')
})
it('keeps questions open and supersedes changed approved requirements', async () => {
  patch((d) => { d.answers = [{ outcome: 'changed', why: 'New requirement', at: Date.now() }] })
  await closeRun('first', { status: 'done' })
  const next = nextDeliveryRun(deliveryId)
  assert.equal(next?.id, 1)
  assert.equal(next?.deliveryId, undefined)
  assert.equal(findDelivery(deliveryId)?.status, 'cancelled')
})
it('waits on nextDeliveryRun while open questions remain and resumes implement once all are cleared', async () => {
  await move(root, ['update-questions', '1', '--append', 'First?', '--recommended-option', 'A', '--option', 'B',
    '--append', 'Second?', '--recommended-option', 'C', '--option', 'D'])
  patch((d) => { d.answers = [{ outcome: 'changed', why: 'Updated scope', at: Date.now() }] })
  await closeRun('first', { status: 'done' })
  await move(root, ['update-questions', '1', '--drop', '1'])
  assert.equal(nextDeliveryRun(deliveryId), undefined)
  assert.equal(findDelivery(deliveryId)?.status, 'active')
  await move(root, ['update-questions', '1', '--drop', '1'])
  const next = nextDeliveryRun(deliveryId)
  assert.equal(next?.action, 'implement')
  assert.equal(next?.id, 1)
  assert.equal(findDelivery(deliveryId)?.status, 'cancelled')
})

it('delivers through the CLI after agent-owned conflict repair, checks and a newer target', async () => {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(root, 'app.txt'), 'base\n')
  git('add', 'app.txt')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const tree = path.join(root, '.akb/worktrees/1/builder')
  git('worktree', 'add', '-b', 'card/1/builder', tree, base)
  const atTree = (...args: string[]) => execFileSync('git', ['-C', tree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  patch((d) => { d.base = base; d.targetBranch = 'main'; d.branch = 'card/1/builder'; d.worktree = tree })
  fs.writeFileSync(path.join(root, 'app.txt'), 'target\n')
  git('commit', '-am', 'parallel change')
  fs.writeFileSync(path.join(tree, 'app.txt'), 'task\n')
  atTree('commit', '-am', 'task')
  assert.throws(() => atTree('merge', 'main'))
  const mergeHead = path.resolve(tree, atTree('rev-parse', '--git-path', 'MERGE_HEAD'))
  await closeRun('first', { status: 'interrupted' })
  assert.equal(fs.existsSync(mergeHead), true, 'the runtime must preserve unfinished Git state')
  assert.ok(fs.existsSync(card))
  open('git-resumed')
  process.env[RUN_ENV] = 'git-resumed'
  fs.writeFileSync(path.join(tree, 'app.txt'), 'target and task\n')
  atTree('add', 'app.txt')
  atTree('commit', '-m', 'resolve both intentions')
  const check = () => execFileSync(process.execPath, ['-e', "const fs=require('fs');if(fs.readFileSync('app.txt','utf8')!=='target and task\\n')process.exit(1)"], { cwd: tree })
  fs.writeFileSync(path.join(tree, 'app.txt'), 'broken\n')
  assert.throws(check)
  assert.equal(findDelivery(deliveryId)?.status, 'active')
  fs.writeFileSync(path.join(tree, 'app.txt'), 'target and task\n')
  fs.writeFileSync(path.join(root, 'parallel.txt'), 'another target update')
  git('add', 'parallel.txt')
  git('commit', '-qm', 'newer target')
  atTree('merge', 'main', '--no-edit')
  check()
  const commit = atTree('rev-parse', 'HEAD')
  git('merge', '--ff-only', 'card/1/builder')
  git('merge-base', '--is-ancestor', commit, 'main')
  const candidate = fs.readFileSync(card, 'utf8').replace('<!-- agent -->', '## Worth noting after implementation\n\n- Preserved both edits.\n\n<!-- agent -->')
  assert.match(candidate, /Worth noting after implementation/)
  fs.writeFileSync(card, candidate)
  const complete = ['task', 'archive', '1', '--json']
  await run(root, complete)
  await closeRun('git-resumed', { status: 'interrupted' })
  const archived = path.join(path.dirname(card), '../.archive', path.basename(card))
  const saved = fs.readFileSync(archived, 'utf8')
  assert.match(saved, /Preserved both edits/)
  const reconciled = await reconcileCardDelivery(1)
  assert.deepEqual(reconciled, { kind: 'completed', deliveryId, sessionId: 'git-resumed', commit, branch: 'main' })
  assert.equal((await taskArchive('1', { cwd: root })).archived_to, path.relative(root, archived))
  assert.equal(git('rev-parse', 'main'), commit)
  assert.equal(fs.readFileSync(archived, 'utf8'), saved)
  assert.equal(fs.readFileSync(path.join(root, 'parallel.txt'), 'utf8'), 'another target update')
  assert.equal(fs.existsSync(tree), true)
})

it('recovers an archive interrupted after the card moved and repairs its index', async () => {
  const index = path.join(root, 'docs/kanban/todo/README.md')
  fs.writeFileSync(index, '- [Deliver it](1-deliver-it.md)\n')
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    rename(from, to)
    if (String(from) === card) throw new Error('Interrupted after archive move')
  }
  try {
    await assert.rejects(() => taskArchive('1', { cwd: root }), /Interrupted/)
  } finally { fs.renameSync = rename }
  assert.equal(fs.existsSync(card), false)
  assert.equal(findDelivery(deliveryId)?.status, 'active')
  await closeRun('first', { status: 'interrupted' })
  assert.equal(findDelivery(deliveryId)?.status, 'active')
  assert.equal(open('after-archive'), deliveryId)
  process.env[RUN_ENV] = 'after-archive'
  const result = await taskArchive('1', { cwd: root })
  assert.equal(result.archive_status, 'archived')
  assert.equal(findDelivery(deliveryId)?.status, 'finished')
  assert.doesNotMatch(fs.readFileSync(index, 'utf8'), /1-deliver-it/)
  assert.equal((await taskArchive('1', { cwd: root })).archived_to, result.archived_to)
})

it('recovers a non-Git delivery from its local log when its live index is lost', async () => {
  await closeRun('first', { status: 'done' })
  withStore((store) => { store.runs = []; store.deliveries = [] })
  assert.equal(activeDelivery(1), undefined)
  const recovered = settleOrphanedDeliveries()
  assert.deepEqual(recovered.recovered.map((d) => d.deliveryId), [deliveryId])
  assert.equal(activeDelivery(1)?.status, 'active')
})

it('rejects retired Git commands and keeps leaf arguments strict', async () => {
  for (const args of [
    ['delivery', 'complete', '1'], ['raw', 'delivery', 'complete', '1'], ['delivery', 'conflict', '1'], ['raw', 'delivery', 'blocked', '1', 'why'],
    ['raw', 'delivery', 'discard', '1', '--yes'], ['studio', 'worktree', 'coding', 'on'],
  ]) {
    const program = args[0] === 'raw'
      ? buildBoardProgram({ program: 'akb raw', cwd: root, installHint: '', version: null })
      : buildAkbProgram({ program: 'akb', cwd: root, installHint: '' })
    await assert.rejects(() => program.parseAsync(args[0] === 'raw' ? args.slice(1) : args, { from: 'user' }), { code: 'commander.unknownCommand' })
  }
  await assert.rejects(() => run(root, ['studio', 'list', '--unexpected']), /unknown option/)
})

it('reads a legacy landing receipt from the archived delivery', async () => {
  patch(d => {
    d.completions = [{ sessionId: 'first', step: 0, at: Date.now(), commit: sha, branch: 'main', finished: true }]
    d.status = 'finished'
  })
  await closeRun('first', { status: 'done' })
  assert.deepEqual(await reconcileCardDelivery(1), {
    kind: 'completed', deliveryId, sessionId: 'first', commit: sha, branch: 'main',
  })
})

it('verifies the Land commit and saves the receipt only after Cloud confirms', async () => {
  const board = path.join(root, '.akb', 'kanban')
  const todo = 'todo/1-deliver-it.md'
  const file = path.join(board, todo)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.copyFileSync(card, file)
  const content = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(path.join(board, '..', 'base.json'), JSON.stringify({
    project: 'prj_1', files: { ['projects/prj_1/' + todo]: { seq: 7, content } },
  }))
  const restore = { ...process.env }
  const fetch = globalThis.fetch
  try {
    setBoardDir(board, root)
    git('init', '-qb', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('commit', '-qm', 'Baseline', '--allow-empty')
    const base = git('rev-parse', 'HEAD')
    const currentId = open('cloud-land')
    process.env[RUN_ENV] = 'cloud-land'
    withStore(store => Object.assign(store.deliveries.find(d => d.deliveryId === currentId)!, {
      worktree: '.', branch: 'main', targetBranch: 'main', base,
    }))
    process.env.AI4KANBAN_HOME = path.join(root, '.test-cloud')
    process.env.AI4KANBAN_SUPABASE_URL = 'https://test.supabase.co'
    process.env.AI4KANBAN_CLOUD_URL = 'https://api.example.test'
    process.env.AI4KANBAN_BOARD = board
    process.env.AI4KANBAN_TASK = 'task_abc'
    process.env[DELIVERY_PHASE_ENV] = 'land'
    writeSession({ version: 1, supabaseUrl: 'https://test.supabase.co', accessToken: 'test', refreshToken: 'test',
      expiresAt: Date.now() + 60 * 60 * 1000, subject: '11111111-1111-4111-8111-111111111111' })
    let blocked = true
    const posted: unknown[] = []
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)))
        if (blocked) return Response.json({ error: { code: 'conflict', message: 'Finish review.' } }, { status: 409 })
      }
      return Response.json({ id: 'task_abc', key: 'WC-1', project: 'prj_1', status: init?.method === 'POST' ? 'done' : 'running' })
    }) as typeof fetch
    const archive = () => taskArchive('task_abc', { cwd: root, board })
    await assert.rejects(archive, /implementation commit could not be verified/)
    assert.deepEqual(posted, [])
    git('commit', '-qm', 'Implementation', '--allow-empty')
    const commit = git('rev-parse', 'HEAD')
    assert.ok(recordImplementationCommit(currentId, 'cloud-land', base))
    await assert.rejects(archive, /Finish review/)
    assert.equal(findDelivery(currentId)?.status, 'active')
    blocked = false
    assert.equal((await archive()).archive_status, 'archived')
    assert.equal(findDelivery(currentId)?.status, 'finished')
    assert.equal(findDelivery(currentId)?.landing?.commit, commit)
    assert.deepEqual(posted.at(-1), { card: { path: todo, base_seq: 7, content }, delivery_id: currentId, landing: { branch: 'main', commit } })
    assert.equal(fs.readFileSync(file, 'utf8'), content)
  } finally {
    globalThis.fetch = fetch
    for (const name of ['AI4KANBAN_HOME', 'AI4KANBAN_SUPABASE_URL', 'AI4KANBAN_CLOUD_URL', 'AI4KANBAN_BOARD', 'AI4KANBAN_TASK', DELIVERY_PHASE_ENV]) {
      if (restore[name] === undefined) delete process.env[name]
      else process.env[name] = restore[name]
    }
  }
})
