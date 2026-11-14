// The project description and the retired goal (#1268).
//
// What a pass writes is the agent's judgement; asserted here is that the window moves only on
// a pass, and how an older board's goal is carried over.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { formatStamp } from '../src/lib/cadence.ts'
import { closeRun } from '../src/lib/agent/sessions.ts'
import { readRule } from '../src/lib/agent/rules.ts'
import { readAgentRuntime } from '../src/lib/agent/runtimes.ts'
import { stampProjectDescription } from '../src/lib/agent/settings.ts'
import { readRuns } from '../src/lib/agent/store.ts'
import { scaffoldProjectMemory } from '../src/lib/memory.ts'
import { setBoardRoot, RULES, SESSIONS, UI_CONFIG } from '../src/lib/paths.ts'
import { forgetMachineState } from './helpers/board.ts'

let root = ''

const kanban = (): string => path.join(root, 'docs', 'kanban')
const projectFile = (): string => path.join(kanban(), 'memory', 'project.md')
const goalFile = (): string => path.join(kanban(), 'memory', 'goal.md')
const decisionsFile = (): string => path.join(kanban(), 'memory', 'agents', 'planner', 'decisions.md')

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

const DESCRIBED = '# Project\n\n## What it is\n\n- A board.\n'

function describeProject(text = DESCRIBED): void {
  fs.mkdirSync(path.dirname(projectFile()), { recursive: true })
  fs.writeFileSync(projectFile(), text)
}

function pastRuns(...runs: { status: string; startedAt: number }[]): void {
  fs.mkdirSync(path.dirname(SESSIONS), { recursive: true })
  fs.writeFileSync(
    SESSIONS,
    JSON.stringify({
      runs: runs.map((run, i) => ({
        sessionId: `past-${i}`,
        cardId: null,
        action: 'describe-project',
        status: run.status,
        startedAt: run.startedAt,
        ...(run.status === 'running' ? {} : { endedAt: run.startedAt + 1 }),
        harness: 'claude-code',
        logPath: '/dev/null',
      })),
      deliveries: [],
    }),
  )
}

const saved = (): Record<string, any> => (fs.existsSync(UI_CONFIG) ? JSON.parse(fs.readFileSync(UI_CONFIG, 'utf8')) : {})

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-project-writer-'))
  fs.mkdirSync(path.join(kanban(), 'todo'), { recursive: true })
  fs.writeFileSync(path.join(kanban(), 'next-id'), '1\n')
  forgetMachineState(root)
  setBoardRoot(root)
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('the project writer', () => {
  it('moves the window to the start of a pass, and not on a failure', async () => {
    const started = Date.now() - 10 * 60_000
    pastRuns({ status: 'running', startedAt: started })
    await closeRun('past-0', { status: 'error' })
    assert.equal(saved().projectDescription?.lastRun, undefined)
    pastRuns({ status: 'running', startedAt: started })
    await closeRun('past-0', { status: 'done', ok: true, code: 0 })
    assert.equal(saved().projectDescription.lastRun, formatStamp(new Date(started)))
  })
})
