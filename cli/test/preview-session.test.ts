import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { cmdSpec } from '../src/commands/spec'
import { activatePreviewRun, previewRun, readPreviewBaseline, readPreviewProgress, updatePreviewProgress } from '../src/lib/agent/preview-progress'
import { openRun, patch } from '../src/lib/agent/sessions'
import { RUN_ENV, STOP_ENV } from '../src/lib/agent/env'
import { previewBaseline, selectPreviewStages, submitPreviewStage, confirmPreviewStage, resetPreviewSelection, type PreviewProgress } from '../src/lib/preview-stages'
import { ASSETS, setBoardRoot } from '../src/lib/paths'
import { startCollecting, stopCollecting } from '../src/lib/io'
import { previewBridge } from '../../runner/src/preview-bridge'
import { PREVIEW_BRIDGE_ENV } from '../src/lib/cloud/preview'
import { writeSession } from '../src/lib/cloud/session'
import { cloudEndpoints } from '../src/lib/cloud/config'
import { restoreMachineHome } from './helpers/board'

let root: string
const card = (id: number) => path.join(root, 'docs/kanban/todo', `${id}-task.md`)
const run = (action: 'clarify' | 'spec' | 'implement', id = 1, specAgent?: string) => {
  const opened = openRun({ action, id, specAgent }, 'test', [])
  if ('error' in opened) throw Error(opened.error)
  process.env[RUN_ENV] = opened.run.sessionId
  return opened.run.sessionId
}
const enter = (agent: string, id = 1, notes?: string) => cmdSpec({ agent, id, print: true, notes })
const select = (agent: string, stages: string, id = 1) => cmdSpec({ agent, id, stages })
const submit = (agent: string, stage: string, id = 1) => cmdSpec({ agent, id, submit: true, stage })
const section = (agent: string, id = 1) => {
  const text = fs.readFileSync(card(id), 'utf8')
  fs.writeFileSync(card(id), text.replace('<!-- agent -->', `## By \`${agent}\` agent\n\n<Asset src=".assets/${id}/${agent}.diff" label="Draft" />\n\n<!-- agent -->`))
  fs.mkdirSync(path.join(ASSETS, String(id)), { recursive: true })
  fs.writeFileSync(path.join(ASSETS, String(id), `${agent}.diff`), '-old\n+new\n')
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-preview-session-'))
  process.env.AI4KANBAN_HOME = path.join(root, 'home')
  setBoardRoot(root)
  fs.mkdirSync(path.dirname(card(1)), { recursive: true })
  for (const id of [1, 2]) fs.writeFileSync(card(id), `---\ntitle: Preview ${id}\npriority: med\nstatus: ready\nblocked_by: []\nrelated: []\nmodules: []\nstudio: coding\npreviews: [ui-designer, prompt-writer]\nquestions: []\n---\n\nKeep this plan.\n\n<!-- agent -->\n\n## Scope\nSaved requirements.\n`)
  delete process.env[RUN_ENV]
  process.env[STOP_ENV] = 'external-session'
  startCollecting()
})
afterEach(() => {
  stopCollecting()
  restoreMachineHome()
  delete process.env[RUN_ENV]
  delete process.env[STOP_ENV]
  fs.rmSync(root, { recursive: true, force: true })
})

test('a planning session selects and submits several roles with isolated baselines (#736, #738)', async () => {
  run('clarify')
  await assert.rejects(submit('prompt-writer', 'preview'), /Enter this preview/)
  await enter('ui-designer')
  await select('ui-designer', 'ui-draft')
  const ui = previewRun(1, 'ui-designer').sessionId
  const baseline = readPreviewBaseline(1, 'ui-designer', ui)
  await enter('prompt-writer')
  await enter('ui-designer')
  assert.deepEqual(readPreviewBaseline(1, 'ui-designer', ui), baseline)
  await select('ui-designer', 'ui-draft')
  for (const agent of ['prompt-writer', 'ui-designer']) section(agent)
  await submit('prompt-writer', 'preview')
  await submit('ui-designer', 'ui-draft')
  const saved = readPreviewProgress(1)
  assert.equal(saved['ui-designer'].stages[0].status, 'ready')
  assert.equal(saved['prompt-writer'].stages[0].status, 'ready')
  fs.writeFileSync(path.join(ASSETS, '1/ui-designer.diff'), 'changed after submission')
  await submit('ui-designer', 'ui-draft')
  await enter('ui-designer')
  assert.deepEqual(readPreviewProgress(1), saved)
  assert.match(fs.readFileSync(card(1), 'utf8'), /Saved requirements/)
  await assert.rejects(enter('ui-designer', 2), /active task session/)
  await assert.rejects(enter('api-designer'), /Choose this preview agent/)
  await assert.rejects(submit('ui-designer', 'copywriting'), /Wrong stage/)
})

test('external sessions and standalone preview runs resume saved work and preserve the confirmed prefix', async () => {
  await enter('ui-designer')
  await select('ui-designer', 'copywriting,ui-draft')
  section('ui-designer')
  await submit('ui-designer', 'copywriting')
  updatePreviewProgress(1, (all) => confirmPreviewStage(all['ui-designer'], 'copywriting', 1, all['ui-designer'].definitionRevision, 'approved'))
  const independent = run('spec', 1, 'ui-designer')
  await activatePreviewRun(1, 'ui-designer', independent)
  await submit('ui-designer', 'ui-draft')
  const original = readPreviewProgress(1)['ui-designer']
  assert.equal(original.stages[0].status, 'confirmed')
  patch(independent, (record) => { record.status = 'done' })
  await assert.rejects(submit('ui-designer', 'ui-draft'), /active task session/)
  delete process.env[RUN_ENV]
  await enter('ui-designer', 1, 'Revise the page, retain approved copy.')
  await cmdSpec({ agent: 'ui-designer', id: 1, reviseFrom: 'ui-draft' })
  const revised = readPreviewProgress(1)['ui-designer']
  assert.deepEqual(revised.stages[0], original.stages[0])
  assert.equal(revised.stages[1].history!.length, 1)
  await submit('ui-designer', 'ui-draft')
  assert.equal(readPreviewProgress(1)['ui-designer'].stages[1].version, 2)
  assert.equal(readPreviewProgress(1)['ui-designer'].stages[1].history![0].body, original.stages[1].artifact!.body)
})

test('old sessions, reset generations and unrelated runs cannot overwrite saved previews', async () => {
  await enter('prompt-writer')
  section('prompt-writer')
  process.env[STOP_ENV] = 'new-session'
  await enter('prompt-writer')
  await submit('prompt-writer', 'preview')
  const saved = readPreviewProgress(1)
  process.env[STOP_ENV] = 'external-session'
  await assert.rejects(submit('prompt-writer', 'preview'), /outdated/)
  await assert.rejects(enter('prompt-writer'), /outdated/)
  assert.deepEqual(readPreviewProgress(1), saved)
  process.env[STOP_ENV] = 'new-session'
  updatePreviewProgress(1, (all) => resetPreviewSelection(all['prompt-writer']))
  await assert.rejects(submit('prompt-writer', 'preview'), /outdated/)
  run('implement')
  await assert.rejects(enter('prompt-writer'), /active task session/)
})


test('task chats without a local run use the Runner bridge and reject other tasks before synchronization', async () => {
  const realFetch = globalThis.fetch
  const calls: string[] = []
  let progress: PreviewProgress | undefined
  writeSession({ version: 1, supabaseUrl: cloudEndpoints().supabaseUrl, subject: 'test', accessToken: 'test', refreshToken: 'test', expiresAt: Date.now() + 3600000 })
  globalThis.fetch = async (input, options) => String(input).endsWith('/v1/tasks/task-current')
    ? Response.json({ key: 'W-1' }) : realFetch(input, options)
  const bridge = await previewBridge(async (agent, fields) => {
    calls.push(`${agent}:${fields.operation}`)
    progress ??= structuredClone(readPreviewProgress(1)[agent])
    const execution = `job:${fields.run}`
    if (fields.operation === 'select') {
      selectPreviewStages(progress, fields.stages as string[])
      previewBaseline(progress, progress.currentStageId!, execution)
    } else if (fields.operation === 'submit') {
      submitPreviewStage(progress, fields.baseline as Parameters<typeof submitPreviewStage>[1], 'Synchronized page', {})
    } else if (fields.operation === 'start') {
      progress.execution = execution
    }
    return { ok: true, value: { progress, baseline: progress.currentStageId ? { definitionRevision: progress.definitionRevision, generation: progress.generation, stageId: progress.currentStageId, execution } : null } }
  })
  process.env[PREVIEW_BRIDGE_ENV] = bridge.env
  process.env.AI4KANBAN_TASK = 'task-current'
  process.env.AI4KANBAN_EXECUTION = JSON.stringify({ job: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', machine: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
  try {
    // Build the same frozen definition the remote service returns.
    const { freezePreviewProgress } = await import('../src/lib/agent/preview-progress')
    freezePreviewProgress(1, 'ui-designer')
    await enter('ui-designer')
    await select('ui-designer', 'ui-draft')
    await submit('ui-designer', 'ui-draft')
    await submit('ui-designer', 'ui-draft')
    assert.equal(readPreviewProgress(1)['ui-designer'].stages[0].version, 1)
    assert.deepEqual(calls, ['ui-designer:start', 'ui-designer:select', 'ui-designer:submit', 'ui-designer:submit'])
    await assert.rejects(enter('ui-designer', 2), /Only the current task/)
    await assert.rejects(select('ui-designer', 'ui-draft', 2), /Only the current task/)
    assert.equal(calls.length, 4)
  } finally {
    delete process.env[PREVIEW_BRIDGE_ENV]
    delete process.env.AI4KANBAN_TASK
    delete process.env.AI4KANBAN_EXECUTION
    globalThis.fetch = realFetch
    bridge.close()
  }
})
