import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { captureConflict, conflictList, conflictRecords, conflictShow, resolveConflict, withSyncLock, type BoardFile, type BoardWrite, type ConflictFile, type ConflictTransport } from '../src/lib/shared/board-conflicts'
import { projectStateDir } from '../src/lib/machine/project'
import { move } from './helpers/board'

let root: string, board: string, facts: ConflictFile[], id: string, remote: BoardFile[], writes: BoardWrite[][]
let transport: ConflictTransport
const project = 'prj_test'
const put = (name: string, content: string) => { fs.mkdirSync(path.dirname(path.join(board, name)), { recursive: true }); fs.writeFileSync(path.join(board, name), content) }
const at = (name: string) => fs.readFileSync(path.join(board, name), 'utf8')
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-conflict-'))
  board = path.join(root, '.akb/kanban')
  fs.mkdirSync(path.join(board, 'todo'), { recursive: true })
  put('config.md', '# Board\n'); put('memory/readme.md', 'yearly first'); put('memory/other.md', 'local addition')
  facts = [
    { path: 'memory/readme.md', remotePath: `projects/${project}/memory/readme.md`, conflicted: true, reason: 'both-modified', base: { content: 'choose cadence', seq: 1 }, local: { content: 'yearly first' }, remote: { content: 'monthly first', seq: 2 } },
    { path: 'memory/other.md', remotePath: `projects/${project}/memory/other.md`, conflicted: false, reason: null, base: { content: 'before', seq: 1 }, local: { content: 'local addition' }, remote: { content: 'before', seq: 1 } },
  ]
  fs.writeFileSync(path.join(root, '.akb/base.json'), JSON.stringify({ layout: 'workspace', project, head_seq: 1, files: Object.fromEntries(facts.map(f => [f.remotePath, f.base])) }))
  id = captureConflict(board, project, facts).id
  remote = facts.map(f => ({ path: f.remotePath, ...f.remote })); writes = []
  transport = {
    held: async () => true,
    read: async () => ({ ok: true, value: { head_seq: 2, files: remote } }),
    commit: async (_project, files) => {
      const seq = Math.max(...remote.map(f => f.seq)) + 1
      writes.push(files); remote = files.map(f => ({ path: f.path, content: f.content, seq }))
      return { ok: true, value: { head_seq: seq, files: remote.map(({ path, seq }) => ({ path, seq })) } }
    },
  }
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
const result = (content: string | null = 'monthly first') => ({ files: [{ path: 'memory/readme.md', content }] })
const resolve = (expect = conflictShow(board, id).revision, value: unknown = result()) => resolveConflict(board, project, id, expect, value, transport)

describe('explicit board conflict resolution (#806)', () => {
  it('reads offline through the CLI without synchronization and deduplicates observations', async () => {
    const before = fs.readFileSync(path.join(root, '.akb/base.json'), 'utf8')
    const listed = await move(root, ['conflict', 'list', '--board', board, '--json'])
    assert.equal((listed.conflicts as unknown[]).length, 1)
    const shown = (await move(root, ['conflict', 'show', id, '--board', board, '--json'])).conflict as ReturnType<typeof conflictShow>
    assert.equal(shown.files[0]!.base.content, 'choose cadence')
    assert.equal(shown.files[0]!.working.content, 'yearly first')
    assert.equal(shown.files[0]!.remote.content, 'monthly first')
    assert.equal(fs.readFileSync(path.join(root, '.akb/base.json'), 'utf8'), before)
    assert.equal(captureConflict(board, project, facts).id, id)
  })

  it('commits the entire batch once; repetition returns the receipt without overwriting new edits', async () => {
    const revision = conflictShow(board, id).revision
    const sent = await resolve(revision)
    assert.equal(sent.state, 'resolved')
    assert.deepEqual(writes[0]!.map(f => f.content), ['monthly first', 'local addition'])
    put('memory/readme.md', 'newer edit')
    assert.deepEqual(await resolve(revision), sent)
    assert.equal(writes.length, 1)
    assert.equal(at('memory/readme.md'), 'newer edit')
    assert.deepEqual(conflictList(board), [])
    const file = path.join(projectStateDir(board), 'conflicts', `${id}.json`)
    const damaged = JSON.parse(fs.readFileSync(file, 'utf8'))
    damaged.draft.writes[0].path = '../outside'
    fs.writeFileSync(file, JSON.stringify(damaged))
    assert.throws(() => conflictList(board), /Cannot read/)
  })

  it('checks local credentials and preserves edits to an unconflicted batch member', async () => {
    const revision = conflictShow(board, id).revision
    put('memory/other.md', 'newer addition')
    await assert.rejects(resolve(revision), /changed/)
    await assert.rejects(resolve(), /batch member changed/)
    assert.equal(writes.length, 0)
    assert.equal(conflictShow(board, id).files[1]!.conflicted, true)
    await resolve(undefined, { files: [...result().files, { path: 'memory/other.md', content: 'newer addition' }] })
    assert.equal(at('memory/other.md'), 'newer addition')
  })

  it('rejects all remote writes if any member changes and retains the old draft', async () => {
    remote[1] = { ...remote[1]!, content: 'another computer', seq: 4 }
    await assert.rejects(resolve(), /Cloud versions changed/)
    assert.equal(writes.length, 0)
    assert.equal(at('memory/readme.md'), 'yearly first')
    const shown = conflictShow(board, id)
    assert.equal(shown.files[1]!.conflicted, true)
    assert.ok(conflictRecords(board)[0]!.history?.[0]?.draft)
    assert.ok(shown.draft?.record)
    assert.ok(!('history' in shown))
    assert.ok(!('automatic' in shown.files[0]!))
    const files = [...result().files, { path: 'memory/other.md', content: 'merged addition' }]
    const commit = transport.commit
    transport.commit = async () => {
      remote[0] = { ...remote[0]!, content: 'changed during commit', seq: 5 }
      return { ok: false, error: 'Versions changed during commit.', code: 'version_conflict', files: [remote[0]!] }
    }
    await assert.rejects(resolve(shown.revision, { files }), /Versions changed during commit/)
    assert.equal(writes.length, 0)
    assert.equal(conflictShow(board, id).state, 'open')
    transport.commit = commit
    const revision = conflictShow(board, id).revision
    const sent = await resolve(revision, { files })
    assert.deepEqual(await resolve(revision, { files: [...files].reverse() }), sent)
    assert.equal(writes.length, 1)
    assert.equal(writes[0]![1]!.base_seq, 4)
  })

  it('keeps edits made while a confirmed commit was in flight', async () => {
    const commit = transport.commit
    transport.commit = async (...args) => { const sent = await commit(...args); put('memory/readme.md', 'edited during commit'); return sent }
    await resolve()
    assert.equal(at('memory/readme.md'), 'edited during commit')
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.akb/base.json'), 'utf8')).files[facts[0]!.remotePath].content, 'monthly first')
  })

  it('recovers an accepted but unacknowledged commit without sending another', async () => {
    const commit = transport.commit
    transport.commit = async (...args) => { await commit(...args); return { ok: false, error: 'connection closed' } }
    const revision = conflictShow(board, id).revision
    await assert.rejects(resolve(revision), /connection closed/)
    assert.equal(conflictList(board)[0]!.state, 'unconfirmed')
    assert.equal(at('memory/readme.md'), 'yearly first')
    assert.equal((await resolve(revision)).state, 'resolved')
    assert.equal(writes.length, 1)
  })

  it('recovers a persisted receipt after interruption during local writeback', async (t) => {
    const revision = conflictShow(board, id).revision
    const write = fs.writeFileSync
    const fail = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof write>) => {
      if (String(args[0]).endsWith('/memory/readme.md')) throw Error('writeback interrupted')
      return write(...args)
    })
    await assert.rejects(resolve(revision), /writeback interrupted/)
    assert.ok(conflictShow(board, id).receipt)
    fail.mock.restore()
    put('memory/readme.md', 'new work after restart')
    assert.equal((await resolve(revision)).state, 'resolved')
    assert.equal(writes.length, 1)
    assert.equal(at('memory/readme.md'), 'new work after restart')
  })

  it('validates card metadata and forbids inventing approval or reviving a removed task', async () => {
    const card = (status: string) => `---\ntitle: Pricing\npriority: med\nstatus: ${status}\nblocked_by: []\nrelated: []\nmodules: []\nquestions: []\n---\n\nBody\n`
    const name = 'todo/1-pricing.md'
    facts[0] = { ...facts[0]!, path: name, remotePath: `projects/${project}/${name}`, base: { content: card('todo'), seq: 1 }, local: { content: card('ready') }, remote: { content: card('implementing'), seq: 2 } }
    put(name, card('ready'))
    fs.rmSync(path.join(projectStateDir(board), 'conflicts'), { recursive: true })
    id = captureConflict(board, project, facts).id
    remote[0] = { path: facts[0]!.remotePath, ...facts[0]!.remote }
    const value = (content: string) => ({ files: [{ path: name, content }] })
    await assert.rejects(resolve(undefined, value(card('ready').replace('priority: med', 'priority: med\npriority: low'))), /Invalid card metadata/)
    await assert.rejects(resolve(undefined, value(card('ready').replace('title: Pricing', 'title: [Pricing]'))), /Invalid card metadata/)
    await assert.rejects(resolve(undefined, value(card('ready').replace('questions: []', 'questions: [Unsettled]'))), /open questions/)
    await assert.rejects(resolve(undefined, value(card('ready').replace('questions:', 'preview_approved: true\nquestions:'))), /operation to change preview_approved/)
    remote[0] = { ...remote[0]!, content: null, seq: 5 }
    await assert.rejects(resolve(undefined, value(card('ready'))), /Cloud versions changed/)
    await assert.rejects(resolve(undefined, value(card('ready'))), /removed or moved/)
    assert.equal(writes.length, 0)
  })

  it('does not replay an uncertain commit hidden by a later remote edit', async () => {
    transport.commit = async () => ({ ok: false, error: 'timeout' })
    await assert.rejects(resolve(), /timeout/)
    remote[0] = { ...remote[0]!, content: 'later edit', seq: 5 }
    await assert.rejects(resolve(), /cannot be confirmed/)
    assert.equal(conflictList(board)[0]!.state, 'unconfirmed')
    assert.equal(writes.length, 0)
  })

  it('uses explicit null for deletion and preserves tombstone versions', async () => {
    const f = facts[0]!
    f.remote = { content: null, seq: 7 }; remote[0] = { path: f.remotePath, ...f.remote }
    fs.rmSync(path.join(projectStateDir(board), 'conflicts'), { recursive: true })
    id = captureConflict(board, project, facts).id
    await resolve(undefined, result(null))
    assert.equal(writes[0]![0]!.base_seq, 7)
    assert.equal(fs.existsSync(path.join(board, f.path)), false)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.akb/base.json'), 'utf8')).deleted[f.remotePath], 8)
  })

  it('refuses invalid sets, foreign paths, missing rights and damaged records', async () => {
    for (const value of [{ files: [] }, { files: [{ path: '../escape', content: '' }] }, { ...result(), extra: true }, result('<<<<<<< mine\n')]) {
      await assert.rejects(resolve(undefined, value), e => (e as { kind: string }).kind === 'invalid-usage')
    }
    transport.held = async () => false
    await assert.rejects(resolve(), /no longer owns/)
    assert.equal(writes.length, 0)
    fs.writeFileSync(path.join(projectStateDir(board), 'conflicts', `${id}.json`), '{}')
    assert.throws(() => conflictList(board), /Cannot read/)
  })

  it('serializes asynchronous synchronization and resolution', async () => {
    const order: string[] = []
    await Promise.all([
      withSyncLock(board, async () => { order.push('first'); await new Promise(r => setTimeout(r, 40)); order.push('first done') }),
      withSyncLock(board, async () => { order.push('second') }),
    ])
    assert.deepEqual(order, ['first', 'first done', 'second'])
  })
})
