import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { deliveryCleanupDir, saveDeliveryCleanupReceipt } from '../../cli/src/lib/agent/delivery-cleanup-receipt'
import { runMark } from '../../cli/src/lib/agent/stop'
import { IDLE_MS, cacheDir, markUsed, sweepCache } from '../src/cache'
import { cleanDeliveryWorkspaces, noteLandArchive } from '../src/delivery-cleanup'
import { runnerHome, useRunnerHome } from '../src/home'
import { FakeCloud, writeFakeSession } from './fake-cloud'

const machine = randomUUID()
const project = 'prj_1'
const task = 'task_1'
const id = 'delivery'
const branch = 'akb/' + id
const archive = { path: '.archive/1-delivered.md', seq: 12, assets_seq: 0 }
const occupancy = { skip: process.platform !== 'darwin' && process.platform !== 'linux' }

function put(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function fixture(t: TestContext, cwd?: string) {
  cwd ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wildcrane-cleanup-')))
  const root = cwd
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const akb = path.join(root, '.akb')
  const worktrees = path.join(akb, 'worktrees')
  const dir = path.join(worktrees, id)
  const work = path.join(dir, 'work')
  const receipt = path.join(deliveryCleanupDir(root), id + '.json')
  const saved = { project, task, card: 1, deliveryId: id, seq: archive.seq }
  const sessionId = randomUUID()
  const startedAt = Date.now() - 20_000
  const delivery = {
    deliveryId: id, cardId: 1, worktree: path.relative(root, work), status: 'finished', sessions: [sessionId],
    startedAt, endedAt: startedAt + 1000,
  }
  const run = { sessionId, cardId: 1, deliveryId: id, status: 'done', cwd: work, startedAt, endedAt: startedAt + 2000 }
  const registry = (d = delivery, runs: unknown[] = [run]) => put(path.join(akb, 'state', 'sessions.json'), JSON.stringify({ runs, deliveries: [d] }))
  registry()
  const content = '---\ntitle: Delivered\narchived: 2026-11-26\n---\n'
  const card = path.join(akb, 'kanban', archive.path)
  put(card, content)
  put(path.join(akb, 'kanban', '.sync', task + '.json'), JSON.stringify({ task, number: 1 }))
  const base = (status = 'confirmed') => put(path.join(akb, 'base.json'), JSON.stringify({
    layout: 'workspace', project, head_seq: archive.seq,
    files: { [`projects/${project}/${archive.path}`]: { seq: archive.seq, content } },
    archiveReceipts: { [task]: { ...archive, status } },
  }))
  base()
  const audit = path.join(akb, 'kanban', 'deliveries', id + '.json')
  put(audit, JSON.stringify({ ...delivery, sessions: [run] }))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const gitDelivery = () => {
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Cleanup Test')
    git('config', 'user.email', 'cleanup@example.test')
    fs.writeFileSync(path.join(root, '.gitignore'), '.akb/\n')
    git('add', '.gitignore')
    git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD')
    git('worktree', 'add', '-qb', branch, work)
    fs.writeFileSync(path.join(work, 'result.txt'), 'save the result')
    git('-C', work, 'add', 'result.txt')
    git('-C', work, 'commit', '-qm', 'implementation')
    const commit = git('-C', work, 'rev-parse', 'HEAD')
    const row = { ...delivery, base, branch, targetBranch: 'main', landing: { status: 'landed', commit, at: delivery.endedAt, attempts: 0 } }
    registry(row)
    return row
  }
  const copies = () => {
    put(path.join(dir, 'work', 'result.txt'), 'delivered')
    put(path.join(dir, 'base', 'source.txt'), 'source')
  }
  const confirm = () => saveDeliveryCleanupReceipt(root, saved)
  const hasBranch = () => git('branch', '--list', branch).includes(branch)
  return { root, worktrees, dir, work, card, audit, receipt, saved, delivery, run, registry, base, git, gitDelivery, copies, confirm, hasBranch }
}

async function cloudFor(t: TestContext) {
  process.env.WILDCRANE_HOME = fs.realpathSync(runnerHome())
  useRunnerHome()
  writeFakeSession(runnerHome())
  const cloud = new FakeCloud()
  await cloud.start()
  t.after(() => cloud.stop())
  cloud.taskStatus[task] = 'done'
  cloud.taskDetails[task] = { card_version: archive.seq }
  return cloud
}

test('a finished Land result reclaims its Git workspace and preserves the archive and audit', occupancy, async t => {
  const cloud = await cloudFor(t)
  const f = fixture(t)
  f.gitDelivery()
  f.git('merge', '-q', '--ff-only', branch)
  const job = cloud.dispatch({ id: randomUUID(), project, projectDir: f.root, task, number: 1,
    flow: { verb: 'implement', studio: 'coding', phase: 'land', delivery_id: 'different' } })
  job.state = 'finished'
  job.outcome = 'done'
  cloud.taskDetails[task]!.last_job = job.id
  await cleanDeliveryWorkspaces(f.root)
  assert.ok(fs.existsSync(f.work))
  job.flow!.delivery_id = id
  await cleanDeliveryWorkspaces(f.root)
  assert.equal(f.hasBranch(), false)
  assert.equal(fs.existsSync(f.worktrees), false)
  assert.ok(fs.existsSync(f.card) && fs.existsSync(f.audit))
  await cleanDeliveryWorkspaces(f.root)
})

test('a matching versioned sync receipt is required when using historical Git landing evidence', occupancy, async t => {
  const cloud = await cloudFor(t)
  const f = fixture(t)
  const d = f.gitDelivery()
  f.git('merge', '-q', '--ff-only', branch)
  cloud.taskDetails[task]!.landing = { commit: d.landing.commit, branch: 'main' }
  f.base('pending')
  await cleanDeliveryWorkspaces(f.root)
  assert.ok(fs.existsSync(f.work))
  f.base()
  cloud.taskDetails[task]!.card_version = archive.seq + 1
  await cleanDeliveryWorkspaces(f.root)
  assert.ok(fs.existsSync(f.work))
  cloud.taskDetails[task]!.card_version = archive.seq
  await cleanDeliveryWorkspaces(f.root)
  assert.equal(f.hasBranch(), false)
})

test('Git defers an unmerged tip, dirty workspace and a branch held by another worktree, then resumes', occupancy, async t => {
  const f = fixture(t)
  f.gitDelivery()
  f.confirm()
  await cleanDeliveryWorkspaces(f.root)
  assert.ok(f.hasBranch() && fs.existsSync(f.work))

  f.git('merge', '-q', '--ff-only', branch)
  fs.appendFileSync(path.join(f.work, 'result.txt'), '\nextra commit')
  f.git('-C', f.work, 'commit', '-qam', 'new tip')
  await cleanDeliveryWorkspaces(f.root)
  assert.ok(f.hasBranch() && fs.existsSync(f.work))
  f.git('merge', '-q', '--ff-only', branch)
  fs.writeFileSync(path.join(f.work, 'dirty.txt'), 'uncommitted')
  await cleanDeliveryWorkspaces(f.root)
  assert.ok(f.hasBranch() && fs.existsSync(f.work) && fs.existsSync(f.receipt))
  fs.unlinkSync(path.join(f.work, 'dirty.txt'))

  // Resume with only branch cleanup left, as after an interrupted cleanup.
  f.git('worktree', 'remove', f.work)
  const other = path.join(f.root, 'other')
  f.git('worktree', 'add', '-q', other, branch)
  await cleanDeliveryWorkspaces(f.root)
  assert.ok(f.hasBranch() && fs.existsSync(other) && fs.existsSync(f.receipt))
  f.git('worktree', 'remove', other)
  fs.appendFileSync(f.card, '\nAn archive edit after confirmation.\n')
  await cleanDeliveryWorkspaces(f.root)
  assert.equal(f.hasBranch(), false)
  assert.equal(fs.existsSync(f.worktrees), false)
  assert.equal(fs.existsSync(f.receipt), false)
})

test('archive receipts leave active, cancelled, unverified and occupied copies in place', occupancy, async t => {
  const f = fixture(t)
  f.copies()
  f.confirm()
  for (const status of ['active', 'cancelled', 'failed']) {
    f.registry({ ...f.delivery, status })
    await cleanDeliveryWorkspaces(f.root)
    assert.ok(fs.existsSync(f.work), status)
  }
  f.registry(f.delivery, [])
  await cleanDeliveryWorkspaces(f.root)
  assert.ok(fs.existsSync(f.work))
  f.registry()
  const watcher = path.join(f.root, 'watcher.mjs')
  put(watcher, 'setInterval(() => {}, 1000)')
  const hold = ['-e', 'setInterval(() => {}, 1000)']
  for (const [argv, options] of [
    [hold, { cwd: f.work }],
    [hold, { env: { ...process.env, [runMark(f.run.sessionId).name]: f.run.sessionId } }],
    [[watcher, '__watch', f.run.sessionId], { cwd: f.root }],
  ] as const) {
    const held = spawn(process.execPath, argv, { ...options, stdio: 'ignore' })
    await once(held, 'spawn')
    try {
      await cleanDeliveryWorkspaces(f.root)
      assert.ok(fs.existsSync(f.work))
    } finally {
      held.kill()
      await once(held, 'exit')
    }
  }

  const outside = path.join(f.root, 'outside')
  put(path.join(outside, 'mine'), 'keep')
  fs.renameSync(f.work, path.join(f.root, 'original'))
  fs.symlinkSync(outside, f.work, 'dir')
  await cleanDeliveryWorkspaces(f.root)
  assert.ok(fs.lstatSync(f.work).isSymbolicLink())
  assert.equal(fs.readFileSync(path.join(outside, 'mine'), 'utf8'), 'keep')
  assert.ok(fs.existsSync(path.join(f.dir, 'base')))
})

test('confirmed Land lets non-Git cleanup resume after a copy is gone and unblock cache eviction', occupancy, async t => {
  const cloud = await cloudFor(t)
  const f = fixture(t, cacheDir(project))
  f.copies()
  const job = { task, project, number: 1, flow: { verb: 'implement', phase: 'land', studio: 'coding', delivery_id: id } } as const
  noteLandArchive(f.root, job, { card: 1, deliveryId: 'mismatch', archive })
  assert.equal(fs.existsSync(f.receipt), false)
  noteLandArchive(f.root, job, { card: 1, deliveryId: id, archive })
  assert.ok(fs.existsSync(f.receipt))
  fs.rmSync(path.join(f.dir, 'base'), { recursive: true })
  const now = Date.now()
  markUsed(f.root, now - IDLE_MS - 1)
  assert.ok((await sweepCache(machine, now, cleanDeliveryWorkspaces)).includes(f.root))
  assert.equal(fs.existsSync(f.root), false)
})
