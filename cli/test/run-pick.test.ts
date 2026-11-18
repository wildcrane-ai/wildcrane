// The runtime one Add task or Start now run goes on (#518).
//
// The promise is the same one a conversation's pick makes, one level up: the pick belongs to
// the run it starts. The board's settings are untouched, the next run of that flow is back on
// its agent's own runtime, and the pick reaches the spawn rather than only the screen.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { buildAsk, buildPrompt, restartPrompt } from '../src/lib/agent/prompts.ts'
import { HARNESSES } from '../src/lib/agent/harnesses/index.ts'
import { openRun } from '../src/lib/agent/sessions.ts'
import { replaceAgentRuntimes } from '../src/lib/agent/runtimes.ts'
import { readRuns } from '../src/lib/agent/store.ts'
import type { AgentRequest } from '../src/lib/agent/types.ts'
import { setBoardRoot } from '../src/lib/paths.ts'
import { uiConfigOf } from './helpers/board.ts'

let root = ''

const runtime = (id: string, harness: string, settings: Record<string, string>) => ({
  id,
  name: id === 'global' ? 'Global default' : id,
  harness,
  settings,
})

// Three rows and two agents pointed at two of them, so "the flow's own agent's" is a
// different answer for each of the sheet's two run modes.
const BOARD = {
  runtimes: [
    runtime('global', 'claude-code', { model: 'claude-sonnet-5' }),
    runtime('strong', 'claude-code', { model: 'claude-opus-5' }),
    runtime('cheap', 'codex', { model: 'gpt-5.1-codex' }),
  ],
  agentRuntime: { builder: 'cheap' },
}

const config = (cfg: Record<string, unknown>): void => {
  const kanban = path.join(root, 'docs', 'kanban')
  fs.mkdirSync(kanban, { recursive: true })
  fs.writeFileSync(uiConfigOf(kanban), JSON.stringify(cfg, null, 2))
  setBoardRoot(root)
}

const held = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(uiConfigOf(root, 'docs', 'kanban'), 'utf8'))

// A prune names no card and opens no delivery, so this file can start it without a git
// repository under it.
const create = (runtime?: string) =>
  openRun({ action: 'prune-memory', ...(runtime ? { runtime } : {}) }, 'prompt')

// The model list a row offers is read partly off the CLIs' own files under $HOME, so the home
// is a scratch one too.
let home = ''
let realHome: string | undefined

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-run-pick-'))
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-run-pick-home-'))
  realHome = process.env.HOME
  process.env.HOME = home
  config(BOARD)
})

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

describe('the pick reaching the run', () => {
  it('spawns the picked runtime and records it, leaving the board alone', () => {
    const opened = create('strong')
    assert.ok('run' in opened)
    assert.equal(opened.run.runtime, 'strong')
    assert.equal(opened.run.harness, 'claude-code')
    assert.ok(opened.spec.plan.argv.includes('claude-opus-5'))
    assert.deepEqual(held(), BOARD)
  })

  it("runs the flow's own agent's runtime when the send picked none", () => {
    const opened = create()
    assert.ok('run' in opened)
    assert.equal(opened.run.runtime, 'global')
    assert.ok(opened.spec.plan.argv.includes('claude-sonnet-5'))
  })

  it('is the one run’s alone — the next one is back on the agent’s own', () => {
    create('strong')
    openRun({ action: 'review-dismissals' }, 'prompt')
    assert.deepEqual(
      readRuns().map((r) => r.runtime),
      ['strong', 'global'],
    )
  })

  it('refuses a runtime this board does not have rather than quietly running another', () => {
    const opened = create('nonesuch')
    assert.ok('error' in opened && /no runtime called "nonesuch"/.test(opened.error))
    assert.equal(readRuns().length, 0)
  })
})

// A Runner's picks per studio step (#625): each agent runs its own, and one bound to another
// computer fails the step rather than running something else.
describe('a step’s own runtime', () => {
  const spec = (specAgent: string) => openRun({ action: 'spec', id: 1, specAgent }, 'prompt')

  it('runs the agent’s pick, and refuses one not on this computer', () => {
    assert.ok(replaceAgentRuntimes({
      'ui-designer': runtime('rt_codex', 'codex', { model: 'gpt-5.5' }),
      writer: { ...runtime('rt_far', 'codex', {}), away: 'The runtime "Far" is not on this computer.' },
    }).ok)
    const here = spec('ui-designer')
    assert.ok('run' in here)
    assert.equal(here.run.runtime, 'rt_codex')
    assert.ok(here.spec.plan.argv.includes('gpt-5.5'))
    const far = spec('writer')
    assert.ok('error' in far)
    assert.equal(far.reason, 'runtimeAway')
    assert.equal(far.error, 'The runtime "Far" is not on this computer.')
    const other = spec('critic')
    assert.ok('run' in other)
    assert.equal(other.run.runtime, 'global')
  })
})
