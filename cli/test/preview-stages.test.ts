import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSpecAgent } from '../src/lib/agents/parse.ts'
import { beginPreviewRevision, choosePreviewRevision, resetPreviewSelection, confirmPreviewStage, invalidatePreviewStages, previewBaseline, previewReady, selectPreviewStages, submitPreviewStage, type PreviewProgress } from '../src/lib/preview-stages.ts'

const definitions = ['copy', 'images', 'layout'].map((id) => ({ id, title: { en: id, zh: id }, instructions: `${id}.md`, when: `Needs ${id}` }))
const fresh = (): PreviewProgress => ({ agent: 'designer', definitionRevision: 'frozen', generation: 1, currentStageId: null, definitions: structuredClone(definitions), body: 'Design', files: {}, stages: [], displayedArtifact: null, execution: null })

describe('preview confirmation boundaries (#704)', () => {
  it('runs three stages with version-specific idempotent confirmations and one final approval', () => {
    let p = fresh()
    selectPreviewStages(p, ['copy', 'images', 'layout'])
    for (let index = 0; index < 3; index++) {
      const stage = p.stages[index]
      const baseline = previewBaseline(p, stage.id, `execution-${index}`)
      const assets = { picture: { artifact: 'original', version: 1 } }
      const saved = submitPreviewStage(p, baseline, `work ${stage.id}`, assets)
      assets.picture.version = 99
      assert.equal((saved.assets.picture as { version: number }).version, 1)
      assert.equal(submitPreviewStage(p, baseline, 'retry must not replace work', {}).version, 1)
      p = JSON.parse(JSON.stringify(p))
      if (index === 2) { assert.equal(previewReady(p), true); break }
      assert.equal(previewReady(p), false)
      assert.throws(() => previewBaseline(p, p.stages[index + 1].id, 'skip'))
      assert.throws(() => confirmPreviewStage(p, stage.id, 2, 'frozen', 'wrong'))
      assert.throws(() => confirmPreviewStage(p, stage.id, 1, 'new-definition', 'wrong'))
      const expected = { action: 'once', next: p.stages[index + 1].id }
      assert.deepEqual(confirmPreviewStage(p, stage.id, 1, 'frozen', 'once'), expected)
      assert.deepEqual(confirmPreviewStage(p, stage.id, 1, 'frozen', 'duplicate'), expected)
    }
  })
  it('retains confirmed prefixes, rejects late and concurrent work, and requires re-review after revision', () => {
    const p = fresh()
    selectPreviewStages(p, ['copy', 'images', 'layout'])
    submitPreviewStage(p, previewBaseline(p, 'copy', 'copy-run'), 'approved words', {})
    confirmPreviewStage(p, 'copy', 1, 'frozen', 'next')
    const old = previewBaseline(p, 'images', 'old')
    invalidatePreviewStages(p, 'images')
    assert.equal(p.stages[0].status, 'confirmed')
    assert.equal(p.displayedArtifact?.body, 'approved words')
    assert.throws(() => submitPreviewStage(p, old, 'late', {}))
    const first = previewBaseline(p, 'images', 'first')
    const second = previewBaseline(p, 'images', 'second')
    assert.throws(() => submitPreviewStage(p, first, 'racing', {}))
    submitPreviewStage(p, second, 'new images', {})
    assert.throws(() => selectPreviewStages(p, ['layout']))
    assert.throws(() => confirmPreviewStage(p, 'images', 0, 'frozen', 'stale'))
  })
  it('handles conditional omission and single-stage delivery, rejecting empty, unknown, unordered and incomplete selections', () => {
    for (const ids of [['images', 'layout'], ['layout'], ['copy']]) {
      const p = fresh(); selectPreviewStages(p, ids)
      assert.deepEqual(p.stages.map((stage) => stage.id), ids)
      if (ids.length === 1) {
        submitPreviewStage(p, previewBaseline(p, ids[0], 'one'), 'finished', {})
        assert.equal(previewReady(p), true)
        assert.throws(() => confirmPreviewStage(p, ids[0], 1, 'frozen', 'not-needed'))
      }
    }
    for (const ids of [[], ['unknown'], ['copy', 'copy'], ['layout', 'copy']]) assert.throws(() => selectPreviewStages(fresh(), ids))
    const p = fresh(); delete p.definitions[0].when
    assert.throws(() => selectPreviewStages(p, ['layout']))
  })
  it('routes a requested revision without losing a confirmed prefix and retains history on explicit scope changes', () => {
    const p = fresh(); selectPreviewStages(p, ['copy', 'images', 'layout'])
    submitPreviewStage(p, previewBaseline(p, 'copy', 'a'), 'original words', {})
    confirmPreviewStage(p, 'copy', 1, 'frozen', 'b')
    submitPreviewStage(p, previewBaseline(p, 'images', 'b'), 'original image', {})
    confirmPreviewStage(p, 'images', 1, 'frozen', 'c')
    submitPreviewStage(p, previewBaseline(p, 'layout', 'c'), 'original page', {})
    beginPreviewRevision(p, 'requested-revision')
    assert.equal(previewReady(p), false)
    assert.throws(() => choosePreviewRevision(p, 'images', 'old-run'))
    choosePreviewRevision(p, 'images', 'requested-revision')
    assert.equal(p.stages[0].status, 'confirmed')
    assert.equal(p.displayedArtifact?.body, 'original words')
    assert.equal(p.stages[2].status, 'stale')
    assert.throws(() => confirmPreviewStage(p, 'images', 1, 'frozen', 'old-confirmation'))
    submitPreviewStage(p, { definitionRevision: 'frozen', generation: p.generation, stageId: 'images', execution: 'requested-revision' }, 'revised image', {})
    assert.equal(p.stages[1].version, 2)
    assert.equal(p.stages[1].history?.[0].body, 'original image')
    resetPreviewSelection(p)
    assert.equal(p.archivedSelections?.[0][1].artifact?.body, 'revised image')
    selectPreviewStages(p, ['layout'])
    assert.deepEqual(p.stages.map((stage) => stage.id), ['layout'])
  })
  it('validates translated titles and reachable Markdown instruction paths', () => {
    const source = `---\nname: designer\ndescription: Design\nakb:\n  stages:\n    - id: copy\n      title: {en: Copy, zh: 文案}\n      instructions: copy.md\n---\nDesign the work.`
    const read = parseSpecAgent(source, 'AGENT.md', (file) => file === 'copy.md' ? 'Write copy.' : null)
    assert.ok('agent' in read)
    assert.equal(read.agent.stages?.[0].title.zh, '文案')
    for (const instructions of ['../copy.md', '/copy.md', 'copy.txt', 'missing.md']) assert.ok('problem' in parseSpecAgent(source.replace('instructions: copy.md', `instructions: ${instructions}`), 'AGENT.md', () => null))
    assert.ok('problem' in parseSpecAgent(source.replace('title: {en: Copy, zh: 文案}', 'title: {zh: 文案}'), 'AGENT.md', () => 'x'))
  })
})
