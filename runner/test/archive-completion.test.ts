import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as it, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { projectStateDir } from '../../cli/src/lib/machine/project'
import type { ArchiveCompletion, ArchiveCompletionReceipt } from '../../cli/src/lib/shared/delivery-evidence'
import { readRemoval, writeRemoval } from '../../cli/src/lib/cloud/task-operation'
import { runnerHome } from '../src/home'
import { keptBoard, openTaskFolder, pull, pullChanges, pushBoard, type Pushed } from '../src/task-folder'
import { FakeCloud, writeFakeSession } from './fake-cloud'

const MACHINE = '44444444-4444-4444-8444-444444444444'
const ACTIVE = 'todo/1-work.md'
const task = (number: number) => `task_${number}`
const archive = (number: number) => `.archive/${number}-done.md`
const manifest = (number: number) => `assets/${task(number)}.json`
const confirmed = (cards: ArchiveCompletion[]): ArchiveCompletionReceipt[] => cards.map(({ task }) => ({ task, status: 'confirmed' }))
const preview = (number: number) => `.assets/${number}/note.txt`
const body = (number: number) => `---\ntitle: Done ${number}\narchived: 2026-11-19\nstudio: coding\n---\n\nDelivered.\n\n## Result\n\n<Asset src="${preview(number)}" />\n`

type Step = 'first' | 'idle' | 'edit'
async function syncInProcess(dir: string, steps: Step[]): Promise<Pushed[]> {
  const ws = keptBoard(dir)!
  const trials: Pushed[] = []
  for (const step of steps) {
    if (step === 'edit') fs.appendFileSync(path.join(ws.board, ACTIVE), '\nActive edit.\n')
    trials.push(await pushBoard(ws, MACHINE, step === 'first' ? undefined : step === 'edit' ? [ACTIVE] : []))
  }
  return trials
}

async function runSync(dir: string, ...steps: Step[]): Promise<Pushed[]> {
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(import.meta.url), '--sync-archives', dir, ...steps], { timeout: 90_000 })
  return JSON.parse(stdout)
}

async function fixture(t: TestContext) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wildcrane-archive-sync-')))
  const cloud = new FakeCloud()
  t.after(async () => { await cloud.stop(); fs.rmSync(dir, { recursive: true, force: true }) })
  process.env.AI4KANBAN_HOME = process.env.WILDCRANE_HOME = path.join(dir, 'runner-home')
  writeFakeSession(runnerHome())
  await cloud.start()
  cloud.put({ [ACTIVE]: '---\ntitle: Work\n---\n\nIn progress.\n' })
  assert.ok((await pull(openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, dir), MACHINE)).ok)
  const ws = keptBoard(dir)!
  const base = () => JSON.parse(fs.readFileSync(path.join(dir, '.akb', 'base.json'), 'utf8')) as {
    archiveReceipts?: Record<string, Omit<ArchiveCompletion, 'task'> & ArchiveCompletionReceipt>
    pendingArchives?: Record<string, string>
  }
  const assetPath = (number: number) => path.join(projectStateDir(ws.board), preview(number).slice(1))
  const seed = async (start: number, count: number) => {
    const files: Record<string, string> = {}
    const bytes = 'Archived attachment'
    const hash = crypto.createHash('sha256').update(bytes).digest('hex')
    const save = (file: string, data: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, data)
    }
    for (let number = start; number < start + count; number++) {
      const artifact = `art_${number}`
      const ref = { artifact, version: 1 }
      const archived = archive(number)
      const content = body(number)
      files[archived] = content
      files[manifest(number)] = JSON.stringify({ [preview(number)]: ref })
      cloud.task.artifacts.set(artifact, [Buffer.from(bytes)])
      save(assetPath(number), bytes)
      save(path.join(ws.board, '.sync', `${task(number)}.json`), JSON.stringify({
        task: task(number), number, assets: { [preview(number)]: { ...ref, hash, kind: 'asset' } },
      }))

    }
    cloud.put(files)
    assert.ok((await pullChanges(ws)).ok)
  }
  const batches: ArchiveCompletion[][] = []
  cloud.completeArchives = ({ cards }) => { batches.push(cards); return { receipts: confirmed(cards) } }
  const acked = () => Object.fromEntries(Object.entries(base().archiveReceipts ?? {}).filter(([, receipt]) => receipt.status === 'confirmed'))
  return { dir, ws, cloud, seed, base, acked, batches, assetPath }
}

if (process.argv[2] === '--sync-archives') {
  const [dir, ...steps] = process.argv.slice(3)
  process.stdout.write(JSON.stringify(await syncInProcess(dir!, steps as Step[])))
} else {
  for (const count of [300, 3000]) {
    it(`skips acknowledged archive versions after restarting with ${count} archived cards (#974)`, async (t) => {
      const { dir, cloud, seed, base, acked, batches } = await fixture(t)
      await seed(10, count)
      assert.equal(base().archiveReceipts, undefined)

      const interrupted = count === 300
      if (interrupted) cloud.completeArchives = ({ cards }) => {
        batches.push(cards)
        return batches.length === 1 ? { receipts: [{ task: cards[0].task, status: 'pending', code: 'conflict', message: 'The job is active.' }, ...confirmed(cards.slice(1))] } : null
      }
      const [initial] = await runSync(dir, 'first')
      assert.equal(initial!.ok, !interrupted)
      if (!initial!.ok) assert.equal(initial!.code, 'service_unavailable')
      assert.deepEqual(batches.map(batch => batch.length), Array(interrupted ? 2 : count / 100).fill(100))
      for (const card of batches.flat()) {
        const number = Number(card.task.slice('task_'.length))
        assert.deepEqual(card, { task: task(number), path: archive(number), seq: cloud.head, assets_seq: cloud.head })
      }

      if (interrupted) {
        const checked = Object.keys(acked())
        const pending = Object.keys(base().pendingArchives ?? {})
        assert.equal(checked.length, 99)
        assert.deepEqual(new Set(checked), new Set(batches[0]!.slice(1).map(card => card.task)))
        assert.deepEqual(new Set(pending), new Set(Array.from({ length: count }, (_, i) => task(10 + i)).filter(id => !checked.includes(id))))
        batches.length = 0
        cloud.completeArchives = ({ cards }) => { batches.push(cards); return { receipts: confirmed(cards) } }
        const [resumed] = await runSync(dir, 'first')
        assert.ok(resumed!.ok)
        assert.deepEqual(batches.map(batch => batch.length), [100, 100, 1])
        assert.deepEqual(new Set(batches.flat().map(card => card.task)), new Set(pending))
      }

      assert.equal(Object.keys(acked()).length, count)
      assert.deepEqual(base().pendingArchives, {})
      batches.length = 0
      const restarted = await runSync(dir, 'first', 'idle', 'edit')
      assert.deepEqual(restarted, [false, false, true].map(changed => ({ ok: true, changed })))
      assert.deepEqual(batches, [])
      assert.match(cloud.file(ACTIVE)!, /Active edit/)
    })
  }

  it('checks only synced new versions and removes records for restored, deleted and rejected archives (#974)', async (t) => {
    const { dir, ws, cloud, seed, base, acked, batches, assetPath } = await fixture(t)
    await seed(10, 5)
    assert.ok((await runSync(dir, 'first'))[0]!.ok)
    const checked = acked()
    batches.length = 0

    fs.appendFileSync(path.join(ws.board, archive(10)), '\nBody changed.\n')
    fs.writeFileSync(assetPath(11), 'Attachment changed.')
    await seed(15, 1)
    cloud.serviceUnavailableUploads = true
    const [failed] = await runSync(dir, 'first')
    assert.equal(failed!.ok, false)
    assert.deepEqual(batches.flat().map(card => card.task).sort(), [task(10), task(15)])
    assert.deepEqual(acked()[task(11)], checked[task(11)])
    assert.deepEqual(cloud.task.artifacts.get('art_11'), [Buffer.from('Archived attachment')])
    const updated = acked()
    assert.notEqual(updated[task(10)]!.seq, checked[task(10)]!.seq)
    assert.equal(updated[task(10)]!.assets_seq, checked[task(10)]!.assets_seq)

    batches.length = 0
    cloud.serviceUnavailableUploads = false
    const [retried] = await runSync(dir, 'first')
    assert.ok(retried!.ok)
    assert.deepEqual(batches.flat().map(card => card.task), [task(11)])
    const attachment = acked()[task(11)]!
    assert.notEqual(attachment.assets_seq, checked[task(11)]!.assets_seq)
    assert.equal(attachment.seq, checked[task(11)]!.seq)
    assert.equal(cloud.task.artifacts.get('art_11')?.at(-1)?.toString(), 'Attachment changed.')

    cloud.put({ [archive(12)]: null, 'todo/12-done.md': body(12).replace('archived:', 'restored:'),
      [archive(13)]: null, [archive(14)]: body(14).replace('archived:', 'rejected: true\narchived:') })
    assert.ok((await pullChanges(ws)).ok)
    for (const number of [12, 13, 14]) assert.equal(acked()[task(number)], undefined)
    batches.length = 0
    await runSync(dir, 'first')
    assert.deepEqual(batches, [])
  })

  it('retains explicit archive rejections and retries only pending or changed versions', async (t) => {
    const { dir, cloud, seed, base, batches, ws } = await fixture(t)
    await seed(10, 4)
    cloud.completeArchives = ({ cards }) => {
      batches.push(cards)
      return { receipts: [
        { task: task(10), status: 'confirmed' },
        { task: task(11), status: 'rejected', code: 'conflict', message: 'Finish the agreed review plan before archiving.' },
        { task: task(12), status: 'pending', code: 'conflict', message: 'Finish the active job before archiving.' },
      ] }
    }
    const [first] = await runSync(dir, 'first')
    assert.equal(first!.ok, false)
    if (!first!.ok) assert.match(first!.tasks![task(11)]!.error, /agreed review plan/)
    const receipts = base().archiveReceipts!
    assert.deepEqual([10, 11, 12, 13].map(n => receipts[task(n)]!.status), ['confirmed', 'rejected', 'pending', 'pending'])
    const missing = receipts[task(13)]!
    assert.equal(missing.status === 'pending' && missing.code, 'invalid_response')
    batches.length = 0
    cloud.completeArchives = ({ cards }) => { batches.push(cards); return { receipts: confirmed(cards) } }
    fs.appendFileSync(path.join(ws.board, archive(11)), '\nReview completed.\n')
    assert.ok((await runSync(dir, 'first'))[0]!.ok)
    assert.deepEqual(batches.flat().map(card => card.task).sort(), [task(11), task(12), task(13)])
  })

  it('persists queued removals, confirms a lost response once and leaves a refused card in place', async (t) => {
    const { dir, cloud, ws } = await fixture(t)
    const attempted: string[] = []
    const same = { reason: 'Superseded', discard: true }
    writeRemoval(ws.board, task(1), { ...same, status: 'pending' })
    cloud.cancelTask = (id, body) => {
      attempted.push(id)
      assert.deepEqual(body, same)
      if (cloud.taskStatus[id] === 'cancelled' || cloud.taskStatus[id] === 'done') {
        return { status: 409, value: { error: { code: 'conflict', message: 'This task has finished.' } } }
      }
      cloud.taskStatus[id] = 'cancelled'
      cloud.taskCancelReasons[id] = body.reason!
      return { status: 503, value: { error: { code: 'service_unavailable', message: 'The response was interrupted.' } } }
    }
    const [first] = await runSync(dir, 'first')
    assert.equal(first!.ok, false)
    assert.deepEqual(readRemoval(ws.board, task(1)), { ...same, status: 'pending', code: 'service_unavailable', message: 'The response was interrupted.' })
    assert.ok((await runSync(dir, 'first', 'idle')).every(result => result.ok))
    assert.deepEqual(readRemoval(ws.board, task(1)), { ...same, status: 'confirmed' })
    assert.deepEqual(attempted, [task(1), task(1)])

    cloud.taskStatus[task(1)] = 'done'
    writeRemoval(ws.board, task(1), { ...same, status: 'pending' })
    const [rejected, idle] = await runSync(dir, 'first', 'idle')
    assert.equal(rejected!.ok, false)
    assert.equal(idle!.ok, true)
    assert.deepEqual(readRemoval(ws.board, task(1)), { ...same, status: 'rejected', code: 'conflict', message: 'This task has finished.' })
    assert.ok(fs.existsSync(path.join(ws.board, ACTIVE)))
    assert.equal(attempted.length, 3)
  })
}
