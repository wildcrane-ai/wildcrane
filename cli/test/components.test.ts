import assert from 'node:assert/strict'
import { it } from 'node:test'
import { allComponents, studioComponents, componentDocsText } from '../src/lib/components.ts'
import { kindOf, TYPES } from '../../artifact-sdk/src/internal/references.ts'
import { startCollecting, stopCollecting } from '../src/lib/io.ts'
import { buildPrompt } from '../src/lib/agent/prompts.ts'
import { cmdComponents, cmdStudioComponents } from '../src/commands/components.ts'

it('gives every Studio the complete registry and supplies its documentation once in a task prompt', () => {
  const docs = allComponents()
  assert.deepEqual(docs.map(d => d.name), ['Asset','Compare','Storyboard','Set','Studio'])
  assert.deepEqual(studioComponents('coding'), docs)
  for (const action of ['clarify','edit','implement'] as const) {
    const prompt = buildPrompt({action,studio:'coding'})
    for (const doc of docs) assert.equal(prompt.split(`# ${doc.name}\n`).length - 1, 1)
    assert.ok(prompt.includes(componentDocsText(docs)))
  }
})
it('requires a known Studio and never filters by a Preview', () => {
  assert.throws(() => cmdStudioComponents({}), /--studio is required/)
  assert.throws(() => cmdStudioComponents({studio:'absent'}), /absent/)
  assert.deepEqual(cmdStudioComponents({studio:'coding'}).components, allComponents().map(d=>d.name))
})


it('lists renderable formats using the upload classifier', () => {
  const sink = startCollecting()
  try {
    cmdComponents([])
    assert.match(sink.out.join('\n'), /Documents +\.pdf · \.docx \.pptx \(LibreOffice on Runner\)/)
    assert.match(sink.out.join('\n'), /Tables +\.xlsx · \.csv \.tsv \(UTF-8 or BOM-marked UTF-16\)/)
    assert.match(sink.out.at(-1)!, /Other formats: download only\.$/)

    TYPES['.preview-test'] = 'image/png'
    assert.equal(kindOf('.preview-test'), 'image')
    sink.out.length = 0
    cmdComponents([])
    assert.match(sink.out.find(line => line.trimStart().startsWith('Images'))!, /\.preview-test$/)
  } finally {
    delete TYPES['.preview-test']
    stopCollecting()
  }
})

it('prints the requested usage in input order', () => {
  const sink = startCollecting()
  try {
    const docs = allComponents()
    for (const names of [['Set'], ['Set', 'Storyboard', 'Set']]) {
      sink.out.length = 0
      assert.deepEqual(cmdComponents(names).components, names)
      assert.equal(sink.out.join('\n'), names.map(name => docs.find(doc => doc.name === name)!.text.trim()).join('\n\n'))
    }
    assert.throws(() => cmdComponents(['Set', 'Unknown']), /Unknown Preview Component "Unknown"/)
  } finally {
    stopCollecting()
  }
})
