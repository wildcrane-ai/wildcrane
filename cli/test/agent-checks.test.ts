import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'
import { cmdInspect } from '../src/commands/inspect'
import { startCollecting, stopCollecting } from '../src/lib/io'
import { ASSETS, BOARD_STATE, SESSIONS, setBoardRoot } from '../src/lib/paths'
import { RUN_ENV, STOP_ENV } from '../src/lib/agent/env'
import { openRun } from '../src/lib/agent/sessions'
import { buildRun, buildPrompt } from '../src/lib/agent/prompts'
import { move, run, forgetMachineState } from './helpers/board'

let root = ''
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-checks-'))
  fs.mkdirSync(path.join(root, 'docs/kanban/todo'), { recursive: true })
  setBoardRoot(root)
  await move(root, ['create', '--id', '1', '--title', 'Saved work', '--previews', 'ui-design'])
  startCollecting()
})
afterEach(() => {
  stopCollecting()
  delete process.env[RUN_ENV]
  delete process.env[STOP_ENV]
  forgetMachineState(root)
  fs.rmSync(root, { recursive: true, force: true })
})
it('inspects saved facts without reaping runs, acquiring ownership or grading incomplete work', () => {
  const opened = openRun({ action: 'clarify', id: 1 }, 'Original task', [])
  assert.ok(!('error' in opened))
  const before = fs.readFileSync(SESSIONS, 'utf8')
  const observed = cmdInspect(1)
  assert.equal(observed.id, 1)
  assert.equal(observed.runs[0]?.status, 'running')
  assert.ok(observed.card?.todos.some((todo) => !todo.done))
  assert.deepEqual(observed.findings, [])
  assert.equal(fs.readFileSync(SESSIONS, 'utf8'), before)
  fs.mkdirSync(path.join(BOARD_STATE, 'previews'), { recursive: true })
  fs.writeFileSync(path.join(BOARD_STATE, 'previews/1.json'), '{')
  const partial = cmdInspect(1)
  assert.ok(partial.card)
  assert.deepEqual(partial.unavailable, ['previews'])
  assert.equal(partial.findings[0]?.source, 'previews')
})

it('reports the selected board’s asset folder without creating it', async (t) => {
  const board = path.join(root, '.akb', 'kanban')
  fs.mkdirSync(path.join(board, 'todo'), { recursive: true })
  fs.writeFileSync(path.join(board, 'config.md'), '# Configuration\n')
  fs.writeFileSync(path.join(board, 'todo', '1-synced.md'), '---\ntitle: Synced card\n---\n')
  const assetFolder = path.join(fs.realpathSync(root), '.akb', 'state', 'assets', '1')
  stopCollecting()
  const args = ['task', 'inspect', '1', '--board', '.akb/kanban']
  const output: string[] = []
  t.mock.method(process.stdout, 'write', (chunk: string) => { output.push(chunk); return true })
  for (const flags of [[], ['--json']]) {
    await run(root, [...args, ...flags])
    assert.equal(JSON.parse(output.join('')).asset_folder, assetFolder)
    output.length = 0
  }
  assert.equal(fs.existsSync(assetFolder), false)
})
