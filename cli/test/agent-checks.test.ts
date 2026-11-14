import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'
import { cmdInspect } from '../src/commands/inspect'
import { cmdSpec } from '../src/commands/spec'
import { startCollecting, stopCollecting } from '../src/lib/io'
import { ASSETS, BOARD_STATE, SESSIONS, setBoardRoot } from '../src/lib/paths'
import { PREVIEW_BRIDGE_ENV } from '../src/lib/cloud/preview'
import { RUN_ENV, STOP_ENV } from '../src/lib/agent/env'
import { openRun } from '../src/lib/agent/sessions'
import { buildRun, buildPrompt } from '../src/lib/agent/prompts'
import { activatePreviewRun, freezePreviewProgress, previewRun, readPreviewBaseline, readPreviewProgress } from '../src/lib/agent/preview-progress'
import { selectPreviewStages, previewBaseline, submitPreviewStage, type PreviewProgress } from '../src/lib/preview-stages'
import { move, run, forgetMachineState } from './helpers/board'

let root = ''
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-checks-'))
  fs.mkdirSync(path.join(root, 'docs/kanban/todo'), { recursive: true })
  setBoardRoot(root)
  await move(root, ['create', '--id', '1', '--title', 'Saved work', '--previews', 'ui-designer'])
  startCollecting()
})
afterEach(() => {
  stopCollecting()
  delete process.env[RUN_ENV]
  delete process.env[STOP_ENV]
  delete process.env[PREVIEW_BRIDGE_ENV]
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
it('lets the current planning session print, select and submit its own task preview', async () => {
  const opened = openRun({ action: 'clarify', id: 1 }, 'Original task', [])
  assert.ok(!('error' in opened))
  process.env[RUN_ENV] = opened.run.sessionId
  await cmdSpec({ agent: 'ui-designer', id: 1, print: true })
  const progress = readPreviewProgress(1)['ui-designer']!
  const stage = progress.definitions.at(-1)!.id
  await cmdSpec({ agent: 'ui-designer', id: 1, stages: stage })
  fs.appendFileSync(path.join(root, 'docs/kanban/todo/1-saved-work.md'), '\n## By `ui-designer` agent\n\nSaved draft with a missing image.\n<Asset src=".assets/1/missing.png" />\n')
  await cmdSpec({ agent: 'ui-designer', id: 1, submit: true, stage })
  const before = structuredClone(readPreviewProgress(1)['ui-designer']!)
  const owner = previewRun(1, 'ui-designer').sessionId
  const oldBaseline = readPreviewBaseline(1, 'ui-designer', owner)
  delete process.env[RUN_ENV]
  process.env[STOP_ENV] = 'another-session'
  await activatePreviewRun(1, 'ui-designer')
  process.env[RUN_ENV] = opened.run.sessionId
  const after = readPreviewProgress(1)['ui-designer']!
  assert.deepEqual(after.stages, before.stages)
  assert.deepEqual(after.displayedArtifact, before.displayedArtifact)
  assert.throws(() => submitPreviewStage(after, oldBaseline, 'Late overwrite', {}), /outdated/)
  await move(root, ['create', '--id', '2', '--title', 'Other task', '--previews', 'ui-designer'])
  await assert.rejects(() => cmdSpec({ agent: 'ui-designer', id: 2, stages: stage }), /active task session/)
  assert.deepEqual(readPreviewProgress(2), {})
})
it('prints the stage body and common role once, with every required command', () => {
  const prompt = buildPrompt({ action: 'spec', id: 1, specAgent: 'ui-designer' })
  assert.match(prompt, /--stages <id,...>/)
  const marker = 'Stages:'
  assert.equal(prompt.split(marker).length - 1, 1)
  assert.doesNotMatch(buildRun({ action: 'spec', id: 1, specAgent: 'ui-designer' }).prompt, /Stages:/)
})
it('allows taking over ready work without losing its version, history or confirmation', () => {
  const p: PreviewProgress = { agent: 'writer', definitionRevision: 'one', generation: 1, currentStageId: null,
    definitions: [{ id: 'draft', title: { en: 'Draft' }, instructions: 'draft.md' }], body: '', files: {}, stages: [], displayedArtifact: null, execution: null }
  selectPreviewStages(p, ['draft'])
  const old = previewBaseline(p, 'draft', 'first')
  submitPreviewStage(p, old, 'Review this', {})
  const saved = structuredClone(p.stages)
  const next = previewBaseline(p, 'draft', 'second')
  assert.deepEqual(p.stages, saved)
  assert.throws(() => submitPreviewStage(p, old, 'Late work', {}), /outdated/)
  assert.equal(submitPreviewStage(p, next, 'Repeated submission', {}).body, 'Review this')
  assert.deepEqual(p.stages, saved)
})

it('never copies out-of-task files through nested or root asset symlinks', async () => {
  const opened = openRun({ action: 'clarify', id: 1 }, 'Original task', [])
  assert.ok(!('error' in opened))
  process.env[RUN_ENV] = opened.run.sessionId
  await cmdSpec({ agent: 'ui-designer', id: 1, print: true })
  await cmdSpec({ agent: 'ui-designer', id: 1, stages: 'ui-draft' })
  fs.appendFileSync(path.join(root, 'docs/kanban/todo/1-saved-work.md'), '\n## By `ui-designer` agent\n\n<Asset src=".assets/1/leak.txt" />\n')
  const outside = path.join(root, 'private')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'leak.txt'), 'Private bytes')
  for (const kind of ['nested', 'root']) {
    const source = path.join(ASSETS, '1')
    fs.rmSync(source, { recursive: true, force: true })
    fs.mkdirSync(ASSETS, { recursive: true })
    if (kind === 'root') fs.symlinkSync(outside, source)
    else { fs.mkdirSync(source); fs.symlinkSync(path.join(outside, 'leak.txt'), path.join(source, 'leak.txt')) }
    await assert.rejects(() => cmdSpec({ agent: 'ui-designer', id: 1, submit: true, stage: 'ui-draft' }), /inside this task/)
    const snapshots = path.join(BOARD_STATE, 'previews/assets/1')
    for (const name of fs.existsSync(snapshots) ? fs.readdirSync(snapshots) : []) assert.equal(fs.existsSync(path.join(snapshots, name, 'leak.txt')), false)
    assert.equal(readPreviewProgress(1)['ui-designer']?.displayedArtifact, null)
  }
})

it('keeps inspect read-only even before machine state or legacy studio backfill exists', async () => {
  const file = path.join(root, 'docs/kanban/todo/1-saved-work.md')
  const original = fs.readFileSync(file, 'utf8').replace(/^studio:.*\n/m, '')
  fs.writeFileSync(file, original)
  fs.rmSync(path.join(root, '.gitignore'), { force: true })
  fs.rmSync(path.join(root, '.akb'), { recursive: true, force: true })
  forgetMachineState(root)
  await run(root, ['raw', 'inspect', '1', '--json'])
  assert.equal(fs.readFileSync(file, 'utf8'), original)
  assert.equal(fs.existsSync(path.join(root, '.gitignore')), false)
  assert.equal(fs.existsSync(path.join(root, '.akb')), false)
})

it('uses the actual conversation execution for same-session previews without inventing a preview run', async () => {
  await move(root, ['create', '--id', '2', '--title', 'Other task', '--previews', 'ui-designer'])
  const progress = freezePreviewProgress(1, 'ui-designer')!
  selectPreviewStages(progress, ['ui-draft'])
  const execution = randomUUID()
  process.env[STOP_ENV] = execution
  let baseline: ReturnType<typeof previewBaseline>
  let context: string | undefined
  const operations: string[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const fields = JSON.parse(body)
      if (fields.cardId !== 1) { response.end(JSON.stringify({ ok: false, error: 'Only the current task.' })); return }
      context ??= fields.run
      assert.equal(fields.run, context)
      baseline = previewBaseline(progress, 'ui-draft', `job:${context}`)
      operations.push(fields.operation)
      if (fields.operation === 'submit') submitPreviewStage(progress, fields.baseline, 'Saved conversation work', {})
      response.end(JSON.stringify({ ok: true, value: { progress, baseline } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  process.env[PREVIEW_BRIDGE_ENV] = JSON.stringify({ url: `http://127.0.0.1:${port}/`, token: 'a'.repeat(64) })
  try {
    await cmdSpec({ agent: 'ui-designer', id: 1, print: true })
    await cmdSpec({ agent: 'ui-designer', id: 1, stages: 'ui-draft' })
    await cmdSpec({ agent: 'ui-designer', id: 1, submit: true, stage: 'ui-draft' })
    assert.deepEqual(operations, ['start', 'select', 'submit'])
    assert.equal(readPreviewProgress(1)['ui-designer']?.displayedArtifact?.body, 'Saved conversation work')
    await assert.rejects(() => cmdSpec({ agent: 'ui-designer', id: 2, print: true }), /Only the current task/)
    assert.deepEqual(readPreviewProgress(2), {})
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
