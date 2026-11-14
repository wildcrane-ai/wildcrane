import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'
import { Conversion, convertCard, convertConfig, convertDefinition, convertPlatformPrompt, convertRecord, convertSourceCard, convertTriage, rollback } from '../scripts/retire-legacy/convert.ts'
import { findGuide } from '../src/lib/guide.ts'
import { readAgentRuntime, readRuntimes, pickRuntime } from '../src/lib/agent/runtimes.ts'
import { parseSpecAgent } from '../src/lib/agents/parse.ts'

let root: string, board: string, state: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akb-retire-')))
  board = path.join(root, 'docs/kanban'); state = path.join(root, '.akb/boards/docs/kanban')
  fs.mkdirSync(board, { recursive: true })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const read = (file: string) => fs.readFileSync(file, 'utf8')

it('retires guide aliases, old discovery values and runtime guesses', () => {
  for (const name of ['discuss-idea', 'spec-skill', 'spec-agent']) assert.equal(findGuide(name), null)
  assert.ok(findGuide('discuss-goal'))
  assert.deepEqual(readAgentRuntime({ agentHarness: { builder: 'codex' } }), {})
  assert.equal(readRuntimes({ harness: 'codex', harnessSettings: { codex: { model: 'old' } } })[0]!.harness, 'claude-code')
  const rows = [{ id: 'global', name: 'Default', harness: 'claude-code', settings: {} }, { id: 'fast', name: 'Fast', harness: 'codex', settings: {} }]
  assert.equal(pickRuntime(rows, 'codex').id, 'global')
  const result = parseSpecAgent('---\nname: example\ndescription: Example\nakb:\n  reads: commits\n---\nDo the work.', 'example', () => null, false, () => [])
  assert.ok('problem' in result)
})

it('translates config and model bindings without reading or moving secrets', () => {
  const cfg = convertConfig({ harness: 'codex', harnessSettings: { codex: { model: 'base' }, 'claude-code': { model: 'other' } }, agentHarness: { 'ui-design': 'codex' } }, { agents: { 'ui-design': { codex: { model: 'mine' } } } })
  const runtime = cfg.runtimes.find((r: any) => r.id === cfg.agentRuntime['ui-designer'])
  assert.equal(runtime.settings.model, 'mine'); assert.equal(runtime.harness, 'codex'); assert.equal(runtime.secretRefs.OPENAI_API_KEY, 'OPENAI_API_KEY__GLOBAL')
  assert.equal(cfg.agentHarness, undefined)
  const unscoped = convertConfig({ harness: 'codex' }, {}, new Set(['OPENAI_API_KEY']))
  assert.equal(unscoped.runtimes[0].secretRefs.OPENAI_API_KEY, 'OPENAI_API_KEY')
  assert.deepEqual(convertConfig(cfg), cfg)
  assert.throws(() => convertConfig({ agentRuntime: { 'ui-design': 'one', 'ui-designer': 'two' }, runtimes: [{ id: 'one' }, { id: 'two' }] }), /conflicting/)
})

it('moves complete asset trees and agent files, preserves paused approval state, and repeats without changes', () => {
  write(path.join(state, 'mockups/12/page.html'), '<img src="nested/picture.svg">')
  write(path.join(state, 'mockups/12/nested/picture.svg'), '<svg/>')
  write(path.join(state, 'mockups/12/unreferenced.bin'), 'keep me')
  fs.chmodSync(path.join(state, 'mockups/12/unreferenced.bin'), 0o700)
  write(path.join(board, 'skills/ui-design/SKILL.md'), '---\nname: ui-design\ndescription: UI\nakb:\n  session: new\n  after: [recommend-tech-stack]\n---\nInstructions\n')
  const binary = Buffer.from([0, 128, 255, 254, 1])
  write(path.join(board, 'agents/ui-design/picture.bin'), '')
  fs.writeFileSync(path.join(board, 'agents/ui-design/picture.bin'), binary)
  write(path.join(board, 'todo/12-example.md'), '---\ntitle: Example\npreviews: [ui-design]\n---\n## By `ui-design` skill\n\n<Asset src=".mockups/12/page.html" />\n')
  write(path.join(state, 'previews/12.json'), JSON.stringify({ 'ui-design': { agent: 'ui-design', currentStageId: 'design', generation: 3, stages: [{ id: 'design', status: 'confirmed', version: 2, artifact: { body: '<Asset src=".mockups/12/page.html" />' } }] } }))
  write(path.join(board, 'ui.config.json'), JSON.stringify({ harness: 'codex', harnessSettings: { codex: { model: 'saved-model' } } }))
  write(path.join(state, 'sessions.json'), JSON.stringify({ runs: [{ action: 'spec', status: 'stopped', runtime: 'codex', harness: 'codex', specAgent: 'ui-design', resumeId: 'saved-session' }] }))
  write(path.join(board, 'deliveries/paused.json'), JSON.stringify({ status: 'active', steps: [{ status: 'stopped' }], sessions: ['same-session'], rules: { implement: 'User rule' } }))
  const plan = new Conversion(root, board), report = plan.plan()
  assert.deepEqual(report.conflicts, [])
  const receipt = path.join(root, 'receipt.json'); assert.equal(plan.apply(receipt).status, 'verified')
  assert.equal(read(path.join(state, 'assets/12/unreferenced.bin')), 'keep me')
  assert.equal(fs.statSync(path.join(state, 'assets/12/unreferenced.bin')).mode & 0o777, 0o700)
  assert.equal(read(path.join(state, 'assets/12/page.html')), '<img src="nested/picture.svg">')
  assert.match(read(path.join(board, 'agents/ui-designer/AGENT.md')), /session: new[\s\S]*after: \[tech-stack-advisor\]/)
  assert.deepEqual(fs.readFileSync(path.join(board, 'agents/ui-designer/picture.bin')), binary)
  const progress = JSON.parse(read(path.join(state, 'previews/12.json')))
  assert.equal(progress['ui-designer'].stages[0].status, 'confirmed')
  assert.equal(progress['ui-designer'].stages[0].version, 2)
  assert.equal(progress['ui-designer'].generation, 3)
  const resume = JSON.parse(read(path.join(state, 'sessions.json'))).runs[0]
  assert.equal(resume.runtime, 'global'); assert.equal(resume.resumeId, 'saved-session'); assert.equal(resume.specAgent, 'ui-designer')
  const paused = JSON.parse(read(path.join(board, 'deliveries/paused.json')))
  assert.deepEqual(paused.sessions, ['same-session']); assert.equal(paused.rules.builder, 'User rule')
  assert.equal(new Conversion(root, board).plan().changes.length, 0)
  rollback(receipt)
  assert.equal(read(path.join(state, 'mockups/12/unreferenced.bin')), 'keep me')
})

it('stops on asset, configuration and memory conflicts without modifying either side', () => {
  write(path.join(state, 'mockups/3/a.txt'), 'old'); write(path.join(state, 'assets/3/a.txt'), 'new')
  write(path.join(board, 'memory/agents/video-assets/assets.md'), 'old memory')
  write(path.join(board, 'memory/agents/hyperframes-editor/assets.md'), 'new memory')
  write(path.join(board, 'ui.config.json'), '{"one":1}'); write(path.join(state, 'ui.config.json'), '{"two":2}')
  const plan = new Conversion(root, board), report = plan.plan()
  assert.ok(report.conflicts.length >= 3)
  assert.throws(() => plan.apply(path.join(root, 'receipt.json')), /blocked/)
  assert.equal(read(path.join(state, 'mockups/3/a.txt')), 'old'); assert.equal(read(path.join(state, 'assets/3/a.txt')), 'new')
})

it('blocks active runs and files changed after planning; rollback protects new user content', () => {
  write(path.join(state, 'sessions.json'), '{"runs":[{"status":"running"}]}')
  write(path.join(state, 'mockups/3/a.txt'), 'old')
  assert.match(new Conversion(root, board).plan().conflicts.join('\n'), /active runs/)
  fs.rmSync(path.join(state, 'sessions.json'))
  const plan = new Conversion(root, board); plan.plan()
  write(path.join(state, 'mockups/3/a.txt'), 'changed')
  assert.throws(() => plan.apply(path.join(root, 'receipt.json')), /changed since/)
  const next = new Conversion(root, board); next.plan(); const receipt = path.join(root, 'receipt.json'); next.apply(receipt)
  write(path.join(state, 'assets/3/a.txt'), 'user added')
  assert.throws(() => rollback(receipt), /changed after/)
})

it('folds UI preferences once and retains the global memory and video catalogue files', () => {
  write(path.join(board, 'memory/agents/copywriting/style.md'), 'Copy preference')
  write(path.join(board, 'memory/agents/illustrator/redesign.md'), 'Illustration feedback')
  write(path.join(board, 'memory/agents/video-assets/catalogue/file.bin'), 'asset')
  write(path.join(board, 'memory/competitors/readme.md'), 'Global memory')
  const plan = new Conversion(root, board); assert.deepEqual(plan.plan().conflicts, []); plan.apply(path.join(root, 'receipt.json'))
  assert.match(read(path.join(board, 'memory/agents/ui-designer/writing.md')), /Copy preference/)
  assert.match(read(path.join(board, 'memory/agents/ui-designer/redesign.md')), /Illustration feedback/)
  assert.equal(read(path.join(board, 'memory/agents/hyperframes-editor/catalogue/file.bin')), 'asset')
  assert.equal(read(path.join(board, 'memory/competitors/readme.md')), 'Global memory')
  assert.equal(new Conversion(root, board).plan().changes.length, 0)
})

it('preserves user prose and quotations while translating structural identities and origins', () => {
  const prose = 'Use ui-design in this sentence.\n\n```md\n## By `ui-design` skill\n```'
  assert.equal(convertCard(prose), prose)
  assert.match(convertDefinition('---\nname: ui-design\nakb:\n  reads: commits\n---\nText'), /name: ui-designer[\s\S]*reads: archived-cards/)
  const card = convertSourceCard('---\ntitle: Card\n---\n## Source\n- plans/9-example.md\n- #3\n- triage/archived/from.md\n', () => ({ id: 'origin' }))
  assert.match(card, /source: \[plan:9, "#3"\]/); assert.match(card, /triage: origin/)
  assert.match(convertTriage('---\nsource_id: origin\nplatform: twitter\n---\nWords'), /source_type: x/)
  assert.equal(convertRecord({ prompt: 'User quoted\n\n请用中文回复和写作。', languageLine: '请用中文回复和写作。', language: null }).prompt, 'User quoted\n\n请用中文回复和写作。')
  assert.deepEqual(convertRecord({ rules: 'Studio prose', handoff: { files: ['file.md'] } }), { rules: 'Studio prose', handoff: { files: ['file.md'] } })
  assert.equal(convertPlatformPrompt('Answer following `akb guide discuss-idea`.'), 'Answer following `akb guide discuss-goal`.')
})

it('imports an authorized old state once, rebases recovery paths and retains its original logs', () => {
  const legacy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akb-old-state-')))
  try {
    write(path.join(legacy, 'board.json'), JSON.stringify({ board }))
    write(path.join(legacy, 'sessions.json'), JSON.stringify({ runs: [{ action: 'implement', status: 'stopped', resumeId: 'same-thread', logPath: path.join(legacy, 'sessions/run.log'), plan: path.join(legacy, 'plans/9-plan.md') }] }))
    write(path.join(legacy, 'sessions/run.log'), 'Original ui-design log')
    write(path.join(legacy, 'plans/9-plan.md'), '# Plan')
    const plan = new Conversion(root, board, legacy)
    assert.deepEqual(plan.plan().conflicts, [])
    plan.apply(path.join(root, 'receipt.json'))
    const run = JSON.parse(read(path.join(state, 'sessions.json'))).runs[0]
    assert.equal(run.logPath, path.join(state, 'sessions/run.log'))
    assert.equal(run.plan, 'plans/9-plan.md'); assert.equal(run.resumeId, 'same-thread')
    assert.equal(read(path.join(legacy, 'sessions/run.log')), 'Original ui-design log')
    assert.equal(read(path.join(state, 'sessions/run.log')), 'Original ui-design log')
    assert.equal(new Conversion(root, board).plan().changes.length, 0)
  } finally { fs.rmSync(legacy, { recursive: true, force: true }) }
})
