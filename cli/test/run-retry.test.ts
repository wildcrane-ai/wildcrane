// A failed run with no session to pick up is started again (#1321), and a run whose connector
// this build cannot resume carries on in a new session.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { IDLE_FAILURE } from '../src/lib/agent/idle.ts'
import { cmdRuns } from '../src/commands/run.ts'
import { startCollecting, stopCollecting } from '../src/lib/io.ts'
import { listRuns, openResume, readSpec } from '../src/lib/agent/sessions.ts'
import { logPathOf, readStore, withStore } from '../src/lib/agent/store.ts'
import type { DeliveryRecord, RunRecord, RunView } from '../src/lib/agent/types.ts'
import { setBoardRoot } from '../src/lib/paths.ts'
import { forgetMachineState, restoreMachineHome } from './helpers/board.ts'

let root = ''
let home = ''

const kanban = (): string => path.join(root, 'docs', 'kanban')

function card(where: 'todo' | '.archive', id: number): void {
  const dir = path.join(kanban(), where)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${id}-thing.md`), `---\ntitle: thing\nstatus: ready\n---\n\nA thing.\n`)
}

/** One ended run in the record, with the log `prune` insists on. */
function run(over: Partial<RunRecord> & { sessionId: string }): RunRecord {
  const logPath = logPathOf(over.sessionId)
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.writeFileSync(logPath, 'ran\n')
  const record: RunRecord = {
    cardId: 7,
    action: 'resolve',
    status: 'error',
    startedAt: 1,
    endedAt: 2,
    ok: false,
    harness: 'codex',
    logPath,
    ...over,
  }
  withStore((store) => void store.runs.push(record))
  return record
}

function delivery(deliveryId: string, over: Partial<DeliveryRecord> = {}): void {
  withStore((store) => {
    store.deliveries.push({
      deliveryId,
      cardId: 7,
      title: 'thing',
      status: 'active',
      startedAt: 1,
      sessions: [],
      approved: '# thing',
      steps: [{ step: 'implement', at: 1 }],
      ...over,
    } as DeliveryRecord)
  })
}

const view = async (sessionId: string): Promise<RunView> => (await listRuns()).find((r) => r.sessionId === sessionId)!

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-run-retry-'))
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-run-retry-home-'))
  process.env.AI4KANBAN_HOME = home
  fs.mkdirSync(path.join(kanban(), 'todo'), { recursive: true })
  fs.writeFileSync(path.join(kanban(), 'next-id'), '8\n')
  forgetMachineState(root)
  setBoardRoot(root)
  card('todo', 7)
})

afterEach(() => {
  forgetMachineState(root)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
  restoreMachineHome()
})

describe('requiring the original conversation', () => {
  it('continues a missing session with the original task', async () => {
    run({ sessionId: 'quiet', action: 'implement' })
    const res = await openResume('quiet', { fresh: true })
    assert.ok(!('error' in res))
    assert.equal(readStore().runs.length, 1)
  })

  it('continues an unsupported connector on a supported runtime', async () => {
    run({ sessionId: 'foreign', action: 'implement', harness: 'retired-cli', resumeId: 'old-thread' })
    const res = await openResume('foreign', { fresh: true })
    assert.ok(!('error' in res))
    assert.equal(readStore().runs.length, 1)
  })

  it('resumes the recorded Codex conversation in the same delivery', async () => {
    delivery('build111', { sessions: ['build'] })
    run({ sessionId: 'build', action: 'implement', deliveryId: 'build111', resumeId: 'old-thread' })
    const res = await openResume('build', true)
    assert.ok(!('error' in res), 'error' in res ? res.error : '')
    assert.equal(res.run.resumeId, 'old-thread')
    assert.equal(res.run.resumedFrom, 'build')
    assert.equal(res.run.deliveryId, 'build111')
    assert.equal(res.spec.prompt, 'Continue delivery build111.')
    assert.equal(res.spec.plan.resumeId, 'old-thread')
  })
})

it('requires a native idle stop receipt and an exited managed connection before resuming', async () => {
  const pending = { at: 0, of: 4, failure: IDLE_FAILURE }
  const cleanup = { status: 'confirmed', execution: 'execution', kept: [], instance: 'native' } as const
  const idleStop = { threadId: 'thread', turnId: 'turn' }
  run({ sessionId: 'no-native-receipt', managedProcess: true, resumeId: 'thread',
    cleanup: { ...cleanup, kept: [] }, retry: { ...pending, pending, attempt: 1, since: 0, reason: pending.failure.reason } })
  run({ sessionId: 'live-connection', managedProcess: true, resumeId: 'thread', agentPid: process.pid,
    cleanup: { ...cleanup, kept: [], idleStop }, retry: { ...pending, pending, attempt: 1, since: 0, reason: pending.failure.reason } })

  for (const id of ['no-native-receipt', 'live-connection']) {
    assert.ok('error' in await openResume(id, { automatic: true }))
    const previous = readStore().runs.find(record => record.sessionId === id)!
    assert.equal(previous.retryPause, 'unsafe')
    assert.equal(previous.retry?.pending, undefined)
  }
  assert.equal(readStore().runs.length, 2)
})

describe('Retry is offered', () => {
  it('on a failed run that never reported a session', async () => {
    run({ sessionId: 'quiet' })
    const r = await view('quiet')
    assert.equal(r.canRetry, true)
    assert.equal(r.canResume, false)
  })

  it('on a run that was cut off', async () => {
    run({ sessionId: 'cut', status: 'interrupted', ok: undefined })
    assert.equal((await view('cut')).canRetry, true)
  })

  // Claude Code takes the board's id, so only the mark says no session was ever opened.
  it('instead of Resume when the agent never started', async () => {
    run({ sessionId: 'absent', harness: 'claude-code', unspawned: true })
    run({ sessionId: 'older', harness: 'claude-code', errorWhy: [{ kind: 'notInstalled', args: { cmd: 'claude', install: 'x' } }] })
    run({ sessionId: 'started', harness: 'claude-code' })
    assert.deepEqual([(await view('absent')).canRetry, (await view('absent')).canResume], [true, false])
    assert.deepEqual([(await view('older')).canRetry, (await view('older')).canResume], [true, false])
    assert.deepEqual([(await view('started')).canRetry, (await view('started')).canResume], [undefined, true])
  })

  it('keeps the mark through a read of the record', () => {
    run({ sessionId: 'kept', unspawned: true, studio: 'quick' })
    const [kept] = readStore().runs
    assert.deepEqual([kept.unspawned, kept.studio], [true, 'quick'])
  })
})

describe('akb raw run list', () => {
  it('names the same command for a retry as for a resume, in other words', async () => {
    run({ sessionId: 'quiet-0000' })
    run({ sessionId: 'started-00', harness: 'claude-code' })
    const sink = startCollecting()
    try {
      await cmdRuns({ all: true })
    } finally {
      stopCollecting()
    }
    const said = sink.out.join('\n')
    assert.match(said, /try it again with `akb raw run resume quiet-00/)
    assert.match(said, /continue it with `akb raw run resume started-/)
  })
})

describe('Retry is not offered', () => {
  it('on a run the user stopped', async () => {
    run({ sessionId: 'stopped', status: 'stopped', ok: undefined })
    assert.equal((await view('stopped')).canRetry, undefined)
    const res = await openResume('stopped', { fresh: true })
    assert.ok(!('error' in res))
  })

  it('on a run that finished or is still going', async () => {
    run({ sessionId: 'done', status: 'done', ok: true })
    run({ sessionId: 'going', cardId: null, action: 'prune-memory', status: 'running', endedAt: undefined, pid: process.pid })
    assert.equal((await view('done')).canRetry, undefined)
    assert.equal((await view('going')).canRetry, undefined)
  })

  it('still has the original task context after the card left the board', async () => {
    run({ sessionId: 'gone', cardId: 99 })
    assert.equal((await view('gone')).canRetry, undefined)
    const res = await openResume('gone', { fresh: true })
    assert.ok(!('error' in res))
  })

  it('on a run of a delivery that can no longer be carried on', async () => {
    delivery('ended111', { status: 'cancelled', endedAt: 2 })
    run({ sessionId: 'cancelled', action: 'implement', deliveryId: 'ended111' })
    assert.equal((await view('cancelled')).canRetry, undefined)
    const res = await openResume('cancelled', { fresh: true })
    assert.ok('error' in res)
    assert.match(res.error, /was cancelled/)
  })
})

describe('retrying', () => {
  it('starts the same ask again in a new session, in place of the failed run', async () => {
    run({ sessionId: 'quiet', input: 'mind the edge case', flowId: 'flow-1' })
    const res = await openResume('quiet', { fresh: true })
    assert.ok(!('error' in res), 'error' in res ? res.error : '')
    const { run: next } = res
    assert.equal(next.action, 'resolve')
    assert.equal(next.cardId, 7)
    assert.equal(next.input, 'mind the edge case')
    assert.equal(next.harness, 'codex')
    assert.equal(next.resumedFrom, undefined)
    assert.equal(next.flowId, 'flow-1')
    const prompt = readSpec(next.sessionId)?.prompt ?? ''
    assert.match(prompt, /open questions on task 7/)
    assert.match(prompt, /Extra notes: mind the edge case/)
    assert.deepEqual(readStore().runs.map((r) => r.sessionId), [next.sessionId])
    assert.equal(fs.existsSync(logPathOf('quiet')), true)
  })

  // One that fails the same way is offered Retry again: nothing marks it a resume.
  it('can be retried again', async () => {
    run({ sessionId: 'quiet' })
    const res = await openResume('quiet', { fresh: true })
    assert.ok(!('error' in res))
    fs.writeFileSync(res.run.logPath, 'ran\n')
    withStore((store) => {
      const again = store.runs.find((r) => r.sessionId === res.run.sessionId)!
      again.status = 'error'
      again.endedAt = Date.now()
      again.pid = undefined
    })
    assert.equal((await view(res.run.sessionId)).canRetry, true)
  })

  it('carries a delivery on rather than opening another', async () => {
    delivery('build111', { sessions: ['build'] })
    run({ sessionId: 'build', action: 'implement', deliveryId: 'build111', unspawned: true, harness: 'claude-code' })
    assert.equal((await view('build')).canRetry, true)
    const res = await openResume('build', { fresh: true })
    assert.ok(!('error' in res), 'error' in res ? res.error : '')
    assert.equal(res.run.deliveryId, 'build111')
    assert.equal(res.run.resumedFrom, undefined)
    assert.match(readSpec(res.run.sessionId)?.prompt ?? '', /Continue delivery build111/)
    const store = readStore()
    assert.equal(store.deliveries.length, 1)
    assert.ok(store.deliveries[0]!.sessions.includes(res.run.sessionId))
  })
})

describe('a run whose connector this build no longer ships', () => {
  const lost = (over: Partial<RunRecord> = {}): RunRecord =>
    run({ sessionId: 'lost', action: 'implement', harness: 'retired-cli', resumeId: 'their-id', agent: 'builder', ...over })

  it('still offers Resume, where its ask can be said again', async () => {
    lost()
    run({ sessionId: 'revise', action: 'edit', harness: 'retired-cli', resumeId: 'their-id' })
    assert.deepEqual([(await view('lost')).canResume, (await view('lost')).canRetry], [true, undefined])
    assert.equal((await view('revise')).canResume, false)
    const res = await openResume('revise', { fresh: true })
    assert.ok(!('error' in res))
  })

  it('carries a delivery on in its worktree, in a new session', async () => {
    const worktree = path.join(root, '.akb', 'worktrees', '7', 'wt111111')
    fs.mkdirSync(worktree, { recursive: true })
    delivery('wt111111', { sessions: ['lost'], worktree, branch: 'card/7/wt111111' })
    lost({ deliveryId: 'wt111111' })
    const res = await openResume('lost', { fresh: true })
    assert.ok(!('error' in res), 'error' in res ? res.error : '')
    assert.equal(res.run.cwd, worktree)
    assert.notEqual(res.run.harness, 'retired-cli')
    assert.equal(res.run.resumedFrom, undefined)
    assert.equal(res.run.deliveryId, 'wt111111')
    assert.match(readSpec(res.run.sessionId)?.prompt ?? '', /Continue delivery wt111111/)
  })

  it('carries a delivery with no worktree on in the project', async () => {
    delivery('flat1111', { sessions: ['lost'] })
    lost({ deliveryId: 'flat1111' })
    const res = await openResume('lost', { fresh: true })
    assert.ok(!('error' in res), 'error' in res ? res.error : '')
    assert.equal(fs.realpathSync(res.run.cwd!), fs.realpathSync(root))
    assert.equal(res.run.deliveryId, 'flat1111')
    assert.match(readSpec(res.run.sessionId)?.prompt ?? '', /Continue delivery flat1111/)
  })

  it('does a card run again from the top where there is no delivery', async () => {
    lost({ action: 'resolve' })
    const res = await openResume('lost', { fresh: true })
    assert.ok(!('error' in res), 'error' in res ? res.error : '')
    const prompt = readSpec(res.run.sessionId)?.prompt ?? ''
    assert.match(prompt, /Continue work\./)
    assert.match(prompt, /open questions on task 7/)
  })
})
