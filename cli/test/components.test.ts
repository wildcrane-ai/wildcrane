import assert from 'node:assert/strict'
import { it } from 'node:test'
import { allComponents, studioComponents, componentDocsText } from '../src/lib/components.ts'
import { buildPrompt } from '../src/lib/agent/prompts.ts'
import { cmdComponents } from '../src/commands/components.ts'

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
  assert.throws(() => cmdComponents({}), /--studio is required/)
  assert.throws(() => cmdComponents({studio:'absent'}), /absent/)
  assert.deepEqual(cmdComponents({studio:'coding'}).components, allComponents().map(d=>d.name))
})
