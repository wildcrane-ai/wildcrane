import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { runAgent } from '../src/lib/agent-cli'
import { listRuns, openResume } from '../src/lib/agent/sessions'
import { logPathOf, withStore } from '../src/lib/agent/store'
import { cmdStudioFile } from '../src/commands/studio-file'
import { buildPrompt } from '../src/lib/agent/prompts'
import { startRun } from '../src/lib/agent/start'
import { studioFor } from '../src/lib/agent/studios'
import { taskPreviewProblems } from '../src/lib/shared/task-preview-validation'
import { setBoardRoot } from '../src/lib/paths'
import { startCollecting, stopCollecting } from '../src/lib/io'
import { restoreMachineHome } from './helpers/board'

let root = ''
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-session-'))
  process.env.AI4KANBAN_HOME = path.join(root, 'home')
  setBoardRoot(root)
  fs.mkdirSync(path.join(root, 'docs/kanban/todo'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs/kanban/todo/1-task.md'), '---\ntitle: Saved work\npriority: med\nstatus: ready\nblocked_by: []\nrelated: []\nmodules: []\nstudio: coding\npreviews: [api-docs]\nquestions: []\n---\n\n<Preview id="api-docs">\nSaved API draft.\n</Preview>\n\n<!-- agent -->\n\n## Scope\nOriginal requirement.\n')
  startCollecting()
})
afterEach(() => { stopCollecting(); restoreMachineHome(); fs.rmSync(root, { recursive: true, force: true }) })

test('planning, edits and delivery share the bound instructions without role files, maps or independent memory', () => {
  for (const action of ['clarify','edit','implement'] as const) {
    const prompt = buildPrompt({ action, id: 1 })
    assert.match(prompt, /<Preview id="api-docs">/)
    assert.match(prompt, /Selected Preview IDs: \["api-docs"\]/)
    assert.doesNotMatch(prompt, /you, the .* agent|AGENT\.md|memory\/agents|memory\/studios|title: \{en:/)
    assert.match(prompt, /Prepare only the outputs requested/)
  }
  assert.equal(studioFor('coding')!.previews.length, 7)
  assert.match(String(cmdStudioFile('coding', 'scripts/render.mjs').text), /react-email/i)
})
test('refuses the removed role execution entry rather than substituting another agent', async () => {
  assert.equal(await runAgent(['raw', 'previews', 'api-designer', '1'], { cwd: root }), 1)
  assert.equal(await runAgent(['raw', 'agent', 'run', 'coding', 'qa-manager'], { cwd: root }), 1)
  assert.match((await startRun({ action: 'spec', id: 1, specAgent: 'api-designer' }) as {error: string}).error, /task session/)
})
test('keeps old Studio runs readable without offering to resume their role', async () => {
  for (const [action, specAgent] of [['spec', 'api-designer'], ['scheduled', 'qa-manager']] as const) {
    const logPath = logPathOf(action)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(logPath, 'Saved run output.')
    withStore(store => {
      store.runs.push({
        sessionId: action, action, specAgent, status: 'interrupted',
        studio: 'coding', cardId: action === 'spec' ? 1 : null,
        harness: 'claude-code', resumeId: 'saved-conversation', startedAt: 1, logPath,
      })
    })
    const held = (await listRuns()).find(run => run.sessionId === action)
    assert.equal(held?.specAgent, specAgent)
    assert.equal(held?.canResume, false)
    assert.equal(fs.readFileSync(logPath, 'utf8'), 'Saved run output.')
    assert.ok('error' in await openResume(action))
  }
  assert.match(fs.readFileSync(path.join(root, 'docs/kanban/todo/1-task.md'), 'utf8'), /Saved API draft/)
})
test('validates stable task result IDs and admits only recorded migration history', () => {
  const result = '<Preview id="api-docs">Saved output.</Preview>'
  assert.deepEqual(taskPreviewProblems(result, ['api-docs']), [])
  assert.equal(taskPreviewProblems(result.replace('api-docs','unknown'), ['api-docs'])[0]!.code, 'preview-id')
  assert.deepEqual(taskPreviewProblems(result.replace('api-docs','historical-old'), [], ['historical-old']), [])
  assert.equal(taskPreviewProblems('## By `api-designer` agent\nOld output.', [])[0]!.code, 'preview-tag')
  assert.equal(taskPreviewProblems('<!-- agent -->\n'+result, ['api-docs'])[0]!.code, 'preview-boundary')
})
