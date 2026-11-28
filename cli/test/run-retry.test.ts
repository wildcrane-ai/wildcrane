import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { IDLE_FAILURE } from '../src/lib/agent/idle.ts'
import { retryRecord } from '../src/lib/agent/retry.ts'
import { cmdLog, cmdResume, cmdRuns } from '../src/commands/run.ts'
import { startCollecting, stopCollecting } from '../src/lib/io.ts'
import { closeRun, listRuns, openResume, openRun, readSpec } from '../src/lib/agent/sessions.ts'
import { logPathOf, readStore, withStore } from '../src/lib/agent/store.ts'
import type { DeliveryRecord, RunRecord, RunView } from '../src/lib/agent/types.ts'
import { setBoardRoot } from '../src/lib/paths.ts'
import { forgetMachineState, restoreMachineHome, uiConfigOf } from './helpers/board.ts'

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
    const cwd = path.join(root, 'saved-work')
    fs.mkdirSync(cwd)
    const output = path.join(cwd, 'result.txt')
    fs.writeFileSync(output, 'saved once')
    fs.writeFileSync(uiConfigOf(root, 'docs', 'kanban'), JSON.stringify({
      runtimes: [
        { id: 'global', name: 'Global', harness: 'codex', settings: {} },
        { id: 'original', name: 'Original', harness: 'codex', settings: {} },
      ],
    }))
    delivery('build111', { sessions: ['build'] })
    run({ sessionId: 'build', action: 'implement', deliveryId: 'build111', resumeId: 'old-thread', runtime: 'original', cwd })
    assert.equal((await view('build')).canResume, true)
    const res = await openResume('build', true)
    assert.ok(!('error' in res), 'error' in res ? res.error : '')
    assert.equal(res.run.resumeId, 'old-thread')
    assert.equal(res.run.resumedFrom, 'build')
    assert.equal(res.run.deliveryId, 'build111')
    assert.equal(res.run.runtime, 'original')
    assert.equal(res.run.cwd, cwd)
    assert.equal(res.spec.plan.cwd, cwd)
    assert.match(res.spec.prompt ?? '', /Check the current state.*Do not repeat an operation/)
    assert.ok(res.spec.prompt?.endsWith('Continue delivery build111.'))
    assert.equal(res.spec.plan.resumeId, 'old-thread')
    assert.equal(fs.readFileSync(output, 'utf8'), 'saved once')
    assert.equal(fs.readFileSync(logPathOf('build'), 'utf8'), 'ran\n')
  })
})

describe('command-line recovery checks', () => {
  for (const [name, evidence] of [
    ['pending operation results', { pendingWrites: true }],
    ['unconfirmed cleanup', { cleanup: { status: 'unconfirmed', execution: 'old', kept: ['background'] } }],
  ] satisfies [string, Partial<RunRecord>][]) {
    it(`preserves the run and saved work with ${name}`, async () => {
      const output = path.join(root, 'result.txt')
      fs.writeFileSync(output, 'saved once')
      delivery('build111', { sessions: ['build'] })
      const failure = { source: 'runner', summary: 'Interrupted operation' } as const
      const pending = { at: 0, of: 4, failure, sessionAction: 'resume' } as const
      run({ sessionId: 'build', action: 'implement', deliveryId: 'build111', resumeId: 'old-thread',
        retry: { ...pending, pending, attempt: 1, since: 0, reason: failure.summary }, ...evidence })
      const before = structuredClone(readStore())
      const sink = startCollecting()
      try {
        const listed = await cmdRuns({ all: true })
        const logged = await cmdLog('build', {})
        for (const row of [(listed.runs as RunView[])[0]!, logged.run as RunView]) {
          assert.equal(row.canResume, false)
          assert.equal(row.canRetry, undefined)
        }
      } finally {
        stopCollecting()
      }
      assert.doesNotMatch(sink.out.join('\n'), /run resume/)
      const diagnostic = /The operation results could not be confirmed complete/
      await assert.rejects(cmdResume('build', {}), diagnostic)
      await assert.rejects(cmdResume('build', { fresh: true }), diagnostic)
      const web = await openResume('build', true)
      assert.ok('error' in web)
      assert.match(web.error, diagnostic)
      assert.deepEqual(readStore(), before)
      assert.equal(fs.readFileSync(logPathOf('build'), 'utf8'), 'ran\n')
      assert.equal(fs.readFileSync(output, 'utf8'), 'saved once')
    })
  }

  it('pins the selected run and rechecks evidence written before launch', async () => {
    run({ sessionId: 'original', resumeId: 'old-thread' })
    assert.equal((await view('original')).canResume, true)
    const starting = cmdResume(undefined, {})
    withStore((store) => { store.runs[0]!.pendingWrites = true })
    run({ sessionId: 'newer', resumeId: 'another-thread' })
    await assert.rejects(starting, /The operation results could not be confirmed complete/)
    assert.deepEqual(readStore().runs.map(r => r.sessionId), ['original', 'newer'])
  })

  it('requires an explicit fresh retry when the saved session is known missing', async () => {
    const failure = { source: 'runtime', code: 'session_not_found', summary: 'Session not found' } as const
    run({ sessionId: 'missing', resumeId: 'old-thread', failure,
      retryHistory: [retryRecord(failure, 1, { connector: 'codex', name: null, model: null }, 'pause_unsafe')] })
    const before = await view('missing')
    assert.equal(before.canResume, false)
    assert.equal(before.canRetry, true)
    await assert.rejects(cmdResume('missing', {}), /The original session is unavailable/)
    assert.equal(readStore().runs[0]?.sessionId, 'missing')
    const retried = await openResume('missing', { fresh: true })
    assert.ok(!('error' in retried))
    assert.equal(retried.run.resumedFrom, undefined)
  })

  it('preserves the discussion transcript when automatic reset_replay recovers a missing Codex fork source (#1288)', async () => {
    fs.writeFileSync(uiConfigOf(root, 'docs', 'kanban'), JSON.stringify({
      runtimes: [{ id: 'global', name: 'Global', harness: 'codex', settings: {} }],
    }))
    const transcript = path.join(root, 'discussion.md')
    fs.writeFileSync(transcript, 'User: Context from discussion.\n')
    const opened = openRun(
      { action: 'clarify', id: 7, carry: { resumeId: 'dead-source', fork: true, transcript } },
      'initial fork prompt',
      [],
      'fork-run',
      {
        fork: true,
        continues: 'dead-source',
        plan: (cwd) => ({ harness: 'codex', runtime: 'global', agent: 'codex', cwd, argv: ['codex', 'exec', 'fork', 'dead-source'], resumeId: null, install: '' }),
      },
      true,
    )
    assert.ok(!('error' in opened))
    fs.mkdirSync(path.dirname(opened.run.logPath), { recursive: true })
    fs.writeFileSync(opened.run.logPath, 'forking\n')
    const failure = {
      source: 'runtime' as const,
      code: 'codex_fork_source_missing',
      summary: 'invalid paginated history lineage for dead-source: missing source rollout',
    }
    const pending = { at: 0, of: 4, failure, sessionAction: 'reset_replay' as const }
    withStore((store) => {
      const held = store.runs.find(r => r.sessionId === 'fork-run')!
      held.failure = failure
      held.unspawned = true
      held.retry = { attempt: 1, of: 4, reason: failure.summary, at: 0, since: 0, pending }
    })
    await closeRun('fork-run', { status: 'error', ok: false, code: 1, failure })
    assert.ok(readSpec('fork-run')?.again)

    const retried = await openResume('fork-run', { automatic: true })
    assert.ok(!('error' in retried), 'error' in retried ? retried.error : '')
    assert.equal(retried.run.resumedFrom, undefined)
    assert.equal(retried.run.continues, undefined)
    assert.equal(retried.spec.plan.argv.includes('fork'), false)
    assert.match(retried.spec.prompt ?? '', /discussion\.md/)
    assert.equal(readSpec(retried.run.sessionId)?.again?.carry?.transcript, transcript)
    assert.equal(readSpec('fork-run'), null)
  })
})

it('requires a native idle stop receipt and an exited managed connection before resuming', async () => {
  const pending = { at: 0, of: 4, failure: IDLE_FAILURE }
  const cleanup = { status: 'confirmed', execution: 'execution', kept: [], instance: 'native' } as const
  const idleStop = { threadId: 'thread', turnId: 'turn' }
  run({ sessionId: 'no-native-receipt', managedProcess: true, resumeId: 'thread',
    cleanup: { ...cleanup, kept: [] }, retry: { ...pending, pending, attempt: 1, since: 0, reason: pending.failure.summary } })
  run({ sessionId: 'live-connection', managedProcess: true, resumeId: 'thread', agentPid: process.pid,
    cleanup: { ...cleanup, kept: [], idleStop }, retry: { ...pending, pending, attempt: 1, since: 0, reason: pending.failure.summary } })

  for (const [id, diagnostic] of [
    ['no-native-receipt', /The operation results could not be confirmed complete/],
    ['live-connection', /The previous execution could not be confirmed stopped/],
  ] as const) {
    assert.equal((await view(id)).canResume, false)
    await assert.rejects(cmdResume(id, {}), diagnostic)
    assert.ok(readStore().runs.find(record => record.sessionId === id)?.retry?.pending)
    assert.ok('error' in await openResume(id, { automatic: true }))
    const previous = readStore().runs.find(record => record.sessionId === id)!
    assert.equal(previous.retryPause, 'unsafe')
    assert.equal(previous.retry?.pending, undefined)
  }
  assert.equal(readStore().runs.length, 2)

  run({ sessionId: 'confirmed', managedProcess: true, resumeId: 'thread', failure: IDLE_FAILURE,
    cleanup: { ...cleanup, kept: [], idleStop } })
  assert.equal((await view('confirmed')).canResume, true)
  const resumed = await openResume('confirmed', true)
  assert.ok(!('error' in resumed))
  assert.equal(resumed.run.resumeId, 'thread')
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

describe('akb run list', () => {
  it('names the explicit fresh option for retries', async () => {
    run({ sessionId: 'quiet-0000' })
    run({ sessionId: 'started-00', harness: 'claude-code' })
    const sink = startCollecting()
    try {
      await cmdRuns({ all: true })
    } finally {
      stopCollecting()
    }
    const said = sink.out.join('\n')
    assert.match(said, /try it again with `akb [^`]* run resume quiet-00 --fresh`/)
    assert.match(said, /continue it with `akb [^`]* run resume started-`/)
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

  it('offers an explicit retry using the saved request', async () => {
    lost()
    run({ sessionId: 'revise', action: 'edit', harness: 'retired-cli', resumeId: 'their-id' })
    assert.deepEqual([(await view('lost')).canResume, (await view('lost')).canRetry], [false, true])
    assert.equal((await view('revise')).canResume, false)
    const res = await openResume('revise', { fresh: true })
    assert.ok(!('error' in res))
  })

  it('carries a delivery on in its worktree, in a new session', async () => {
    const worktree = path.join(root, '.akb', 'worktrees', '7', 'wt111111')
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const branch = 'card/7/wt111111'
    git('init', '-qb', 'main')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'Base')
    const base = git('rev-parse', 'HEAD')
    git('worktree', 'add', '-qb', branch, worktree)
    delivery('wt111111', { sessions: ['lost'], worktree, branch, base })
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
