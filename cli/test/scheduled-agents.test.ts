// A studio's scheduled agents (#1401): listed by a studio, each pass a card-less delivery
// that commits and lands like a build. Switching and timing them is the project's Agents page.
//
// The board is a real git repository: whether a pass leaves a commit is a git question.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { listDeliveries } from '../src/lib/agent/deliveries.ts'
import { RUN_ENV } from '../src/lib/agent/env.ts'
import { completeDelivery } from '../src/lib/agent/complete.ts'
import { buildPrompt } from '../src/lib/agent/prompts.ts'
import { scheduledBusy, scheduledRequest } from '../src/lib/agent/scheduled.ts'
import { cmdTriageAdd } from '../src/commands/triage.ts'
import { cmdStudioList } from '../src/commands/studio.ts'
import { runAgent } from '../src/lib/agent-cli.ts'
import { archiveInboxItem, readInbox } from '../src/lib/signals/inbox.ts'
import { closeRun, openRun } from '../src/lib/agent/sessions.ts'
import { startRun } from '../src/lib/agent/start.ts'
import { withStore } from '../src/lib/agent/store.ts'
import {
  listedScheduled,
  scheduledAgent,
  stampScheduledRun,
  scheduledMembers,
  studioById,
} from '../src/lib/agent/studios.ts'
import { worktreeDir } from '../src/lib/agent/worktree.ts'
import { agentRoster } from '../src/lib/agent/roles.ts'
import { parseSpecAgent } from '../src/lib/agents/parse.ts'
import { formatStamp } from '../src/lib/cadence.ts'
import { setBoardRoot } from '../src/lib/paths.ts'
import { forgetMachineState, move, refuses, saveScheduled } from './helpers/board.ts'

let root = ''
const kanban = (): string => path.join(root, 'docs', 'kanban')
// No studio lists it, so it sits in the first one.
const PASS = { studio: 'blog-post', agent: 'night-auditor' }

const git = (args: string[], cwd = root): string => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`)
  return out.stdout.trim()
}

const agentFile = (name: string, reads = ''): string =>
  ['---', `name: ${name}`, 'description: Use when.', ...(reads ? ['akb:', `  reads: ${reads}`] : []), '---', '', `You are ${name}.`, ''].join('\n')

const scheduleAgent = (name: string, reads = ''): void => {
  const home = path.join(kanban(), 'agents', name)
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'AGENT.md'), agentFile(name, reads))
}

const at = (iso: string): Date => new Date(iso)

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-scheduled-'))
  fs.mkdirSync(path.join(kanban(), 'todo'), { recursive: true })
  fs.writeFileSync(path.join(kanban(), 'next-id'), '9\n')
  fs.writeFileSync(path.join(kanban(), 'todo', 'README.md'), '# Tasks\n\n## Tasks\n')
  fs.writeFileSync(path.join(kanban(), 'config.md'), '- **Solution** — product\n')
  fs.writeFileSync(path.join(root, 'shared.txt'), 'base\n')
  git(['init', '--quiet', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'test'])
  git(['add', '-A'])
  git(['commit', '--quiet', '-m', 'start'])
  setBoardRoot(root)
  scheduleAgent(PASS.agent)
})

afterEach(() => {
  delete process.env[RUN_ENV]
  forgetMachineState(root)
  fs.rmSync(root, { recursive: true, force: true })
})

// One pass, opened the way the board opens it.
function open(): string {
  const opened = openRun(scheduledRequest(PASS), 'prompt', [])
  if ('error' in opened) throw new Error(opened.error)
  return opened.run.sessionId
}

async function end(sessionId: string, status: 'done' | 'error' = 'done'): Promise<void> {
  const record = withStore((store) => store.runs.find((r) => r.sessionId === sessionId))
  fs.writeFileSync(record!.logPath, 'log\n')
  await closeRun(sessionId, { status, ok: status === 'done', code: 0 })
}

const enable = (now: Date, more: Record<string, unknown> = {}): void => {
  saveScheduled(root, PASS.studio, [{ agent: PASS.agent, extra: '', since: formatStamp(now), ...more }])
}

describe('declaring a scheduled agent', () => {
  it('reads `akb.reads`, and refuses a value it does not know', () => {
    const read = parseSpecAgent(agentFile('night-auditor', 'chats'), 'AGENT.md', () => null)
    assert.ok('agent' in read)
    assert.equal(read.agent.reads, 'chats')
    const bad = parseSpecAgent(agentFile('night-auditor', 'tweets'), 'AGENT.md', () => null)
    assert.ok('problem' in bad)
    assert.match(bad.problem, /`archived-cards` or `chats` or `dismissals`$/)
  })

  it('rejects the retired `akb.reads: commits` value', () => {
    const read = parseSpecAgent(agentFile('night-auditor', 'commits'), 'AGENT.md', () => null)
    assert.ok('problem' in read)
  })

  it('refuses `akb.hook: schedule`, from before its studio listed it', () => {
    const file = agentFile('night-auditor', 'chats').replace('akb:', 'akb:\n  hook: schedule')
    const read = parseSpecAgent(file, 'AGENT.md', () => null)
    assert.ok('problem' in read)
    assert.match(read.problem, /declares `akb.hook`, which the board no longer reads/)
  })
})

describe("a studio's scheduled agents", () => {

})

describe('`studio list`', () => {

  it('has no `studio schedule` to report changes from', async () => {
    assert.notEqual(await runAgent(['studio', 'schedule', 'coding', '--off', PASS.agent], { program: 'akb', cwd: root }), 0)
  })
})

describe('the prompt a pass is given', () => {
})

describe('what a pass sends to triage', () => {

  it('leaves an item added outside a run unclaimed', async () => {
    await cmdTriageAdd({ title: 'By hand', text: 'Typed in.', studio: 'coding' })
    assert.equal(readInbox()[0]!.agent, undefined)
  })
})

describe('one pass', () => {
})

describe('`raw list --archived --since last-run`', () => {
  it('is refused outside a scheduled run', async () => {
    await refuses(root, ['list', '--archived', '--since', 'last-run'], /only works inside a scheduled agent's run/)
  })
})
