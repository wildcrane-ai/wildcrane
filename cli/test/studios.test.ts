import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { parseStudioFile } from '../src/lib/agent/studio-def.ts'
import { studioFileText } from '../src/lib/agent/studio-file.ts'
import { checkStudioFiles, cloneFiles, previewCatalog, hashInput, landsOf } from '../src/lib/shared/studio-files.ts'
import { parsePreviewBlocks } from '../src/lib/shared/preview-blocks.ts'
import { parseReviewFlow, reviewDependencies } from '../src/lib/shared/review-plan.ts'
import { migrateTask } from '../src/lib/shared/studio-migration.ts'
import { packOfficial } from '../../official/pack.ts'
import { cmdStudioValidate } from '../src/commands/studio.ts'
import { studioRulesBlock, buildAsk } from '../src/lib/agent/prompts.ts'

const source = `---
name: Notes
names: {zh: 更新说明}
icon: notebook
previews:
  notes:
    title: {en: Release notes, zh: 更新说明}
    description: {en: Review release notes., zh: 审阅更新说明。}
---

## Work

Write requested notes.

## Land

Save the final notes and record their path.

## Previews

<Preview id="notes">
Write a short document. Read [style](references/style.md) if needed.
</Preview>
`
const files = { 'STUDIO.md': source, 'references/style.md': 'Use plain language.' }

it('shares strict source diagnostics across validation and publication without editing files', () => {
  const cases = [
    ['name: Notes', 'name: Notes\nname: Again', 'yaml-duplicate-key'],
    ['name: Notes', 'name: [Notes', 'yaml-syntax'],
    ['name: Notes', 'name: 12', 'studio-schema'],
    ['name: Notes', 'name: Notes\nland: [writer]', 'studio-schema'],
    ['icon: notebook', 'icon: missing-icon', 'studio-schema'],
    ['title: {en: Release notes, zh: 更新说明}', 'title: {en: 12}', 'studio-schema'],
    ['</Preview>', '', 'preview-unclosed'],
    ['</Preview>', '</Preview>\n</Preview>', 'preview-unexpected-close'],
    ['<Preview id="notes">', '<Preview id="notes" />', 'preview-tag'],
    ['<Preview id="notes">', '<Preview id="notes" icon="file">', 'preview-tag'],
    ['<Preview id="notes">', '<Preview id="notes">\n<Preview id="nested">', 'preview-tag'],
    ['Write a short document. Read [style](references/style.md) if needed.', '', 'preview-empty'],
    ['  notes:', '  other:', 'preview-metadata-missing'],
    ['  notes:', '  other: {}\n  notes:', 'preview-body-missing'],
  ]
  for (const [from, to, code] of cases) {
    const text = source.replace(from!, to!), before = JSON.stringify(text)
    const read = parseStudioFile('notes', text, 'STUDIO.md')
    assert.ok('problems' in read, code)
    assert.ok(read.problems.some(p => p.code === code && p.line > 0 && p.column > 0 && p.hint), JSON.stringify(read))
    assert.equal(JSON.stringify(text), before)
    assert.equal(checkStudioFiles({ ...files, 'STUDIO.md': text }).ok, false)
  }
  assert.ok(parsePreviewBlocks('<Preview id="x">X</Preview>\n<Preview id="x">Y</Preview>').problems.some(p => p.code === 'preview-id'))
})

it('keeps Markdown code examples out of delimiter parsing and retains single-file Studios', () => {
  const code = '\n`<Preview id="example" />`\n\n```md\n<Preview id="example">\n```\n'
  assert.equal(parsePreviewBlocks(code).blocks.length, 0)
  assert.equal(parsePreviewBlocks(code).problems.length, 0)
  assert.ok(checkStudioFiles({ 'STUDIO.md': '---\nname: Plain\n---\n\n## Work\n\nWrite the requested document.\n\n## Land\n\nCheck and save the final copy.\n\n## Previews\n' }).ok)
  assert.ok(checkStudioFiles({ ...files, 'STUDIO.md': source + code }).ok)
})

it('validates Studio sections without counting headings in examples or Preview blocks', () => {
  const headings = '## Land\n## Work\n## Previews'
  const examples = `<!--\n${headings}\n-->\n\n~~~markdown\n${headings}\n~~~\n\n    ## Work\n`
  const preview = `<Preview id="example">\n${headings}\nA Preview example.\n</Preview>\n`
  const front = '---\nname: Notes\npreviews: {example: {}}\n---\n\n'
  const legacy = front + examples + preview
  const read = parseStudioFile('notes', legacy, 'STUDIO.md')
  assert.ok('def' in read)
  assert.equal(read.def.previews[0]?.id, 'example')

  const valid = front + '## Work ##\nWrite notes.\n\n  ## Land ##\n`npm test`\n\n' + examples + '\n## Previews\n\n' + preview
  assert.ok(checkStudioFiles({ 'STUDIO.md': valid.replaceAll('\n', '\r\n') }, true).ok)

  const misplaced = valid.replace('\n' + preview, '\n## Planning\n\n' + preview)
  for (const [body, code, heading, location, column] of [
    [legacy, 'studio-land-missing', 'Land', 'start', 1],
    [legacy, 'studio-work-missing', 'Work', 'start', 1],
    [legacy, 'studio-previews-missing', 'Previews', 'start', 1],
    [valid.replace('`npm test`', '<!-- Check the result. -->').replace(examples, ''), 'studio-land-empty', 'Land', '  ## Land ##', 3],
    [valid.replace('Write notes.', '<!-- Fill this in. -->'), 'studio-work-empty', 'Work', '## Work ##', 1],
    [valid + '\n## Land\nSave it.\n', 'studio-land-duplicate', 'Land', '## Land', 1],
    [valid + '\n## Work\nWrite it.\n', 'studio-work-duplicate', 'Work', '## Work', 1],
    [valid + '\n## Previews\n', 'studio-previews-duplicate', 'Previews', '## Previews', 1],
    [misplaced, 'preview-section', 'previews.example', '<Preview id="example">', 1],
  ] as const) {
    const checked = checkStudioFiles({ 'STUDIO.md': body }, true)
    assert.ok(!checked.ok)
    const problem = checked.problems.find(p => p.code === code)
    const line = location === 'start' ? 5 : body.split('\n').lastIndexOf(location) + 1
    assert.deepEqual([problem?.file, problem?.line, problem?.column, problem?.path], ['STUDIO.md', line, column, heading])
    assert.ok(problem?.hint)
  }
})

it('keeps indented historical examples literal without masking list resources (#873)', () => {
  const example = '\n\n    Sources:\n    - [<page>](<url>)\n\n    <Preview id="example">\n\nNormal prose.\n'
  assert.ok(checkStudioFiles({ ...files, 'STUDIO.md': source + example }).ok)
  assert.equal(parsePreviewBlocks(example).blocks.length, 0)
  assert.equal(parsePreviewBlocks(example).problems.length, 0)
  const nested = source + '\n\n- Resources:\n\n    [Missing](missing.md)\n'
  assert.equal(checkStudioFiles({ ...files, 'STUDIO.md': nested }).ok, false)
})

it('requires localized display text when authoring custom Previews and keeps legacy definitions readable', () => {
  const legacy = source.replace(/    description: .*\n/, '')
  assert.equal(previewCatalog({ ...files, 'STUDIO.md': legacy })[0]?.description, undefined)
  for (const text of [
    legacy,
    source.replace('Review release notes.', '   '),
    source.replace(', zh: 审阅更新说明。', ''),
    source.replace(', zh: 更新说明}', '}'),
  ]) {
    const result = checkStudioFiles({ ...files, 'STUDIO.md': text })
    assert.ok(!result.ok)
    assert.match(result.reason, /notes/)
  }
  assert.ok(checkStudioFiles(files).ok)
})

it('preserves display metadata and resources through full definition round trips', () => {
  const read = checkStudioFiles(files)
  assert.ok(read.ok)
  const again = parseStudioFile('studio', studioFileText(read.def), 'STUDIO.md', { requireSections: true })
  assert.ok('def' in again)
  assert.deepEqual(again.def, read.def)
  const copied = cloneFiles(files, 'My notes')
  assert.ok('files' in copied)
  assert.ok(checkStudioFiles(copied.files).ok)
  assert.deepEqual(previewCatalog(copied.files), read.def.previews)
  assert.deepEqual(landsOf(read.def), { lands: true })
  assert.notEqual(hashInput(files), hashInput({ ...files, 'STUDIO.md': source.replace('Release notes', 'Notes revised') }))
  assert.equal(read.def.rules, '## Work\n\nWrite requested notes.\n\n## Land\n\nSave the final notes and record their path.\n\n## Previews')
})

it('rejects missing resources and safe-path violations without executing scripts', () => {
  for (const link of ['missing.md', '../secret.md', '/tmp/secret', 'file:///tmp/secret', '%2e%2e/secret']) {
    const read = checkStudioFiles({ ...files, 'STUDIO.md': source.replace('references/style.md', link) })
    assert.ok(!read.ok)
    assert.equal(read.problems[0]!.code, 'studio-reference')
  }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-validation-'))
  try {
    fs.writeFileSync(path.join(folder, 'STUDIO.md'), source)
    assert.throws(() => cmdStudioValidate(folder), /Missing resource/)
    fs.mkdirSync(path.join(folder, 'references'))
    fs.writeFileSync(path.join(folder, 'references/style.md'), files['references/style.md'])
    fs.writeFileSync(path.join(folder, 'STUDIO.md'), source.replace('## Previews', '## Planning'))
    assert.throws(() => cmdStudioValidate(folder), /studio-previews-missing/)
    fs.writeFileSync(path.join(folder, 'STUDIO.md'), source)
    assert.equal((cmdStudioValidate(folder).problems as unknown[]).length, 0)
    assert.equal(fs.readFileSync(path.join(folder, 'STUDIO.md'), 'utf8'), source)
  } finally { fs.rmSync(folder, { recursive: true, force: true }) }
})

it('migrates old groups idempotently without losing Sets, file versions or source order', () => {
  const old = 'Intro\n\n## By `api-designer` agent\n\n<Set label="API">\n\n<Asset src=".assets/4/api.diff" label="v2" />\n\n</Set>\n\n## By `orphan` agent\n\nHistory\n\n## By `api-designer` agent\n\nMore\n\n<!-- agent -->\n\n## Scope\nOriginal'
  assert.throws(() => migrateTask(old, [], { 'existing': 'historical-orphan' }), /collides with defined Preview/)
  assert.throws(() => migrateTask('Saved', ['orphan'], { 'existing': 'historical-orphan' }), /collides with defined Preview/)
  const first = migrateTask(old, ['api-designer'], { 'api-designer': 'api-docs' })
  assert.deepEqual(first.previews, ['api-docs'])
  const blocks = parsePreviewBlocks(first.body).blocks
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0]!.id, 'api-docs')
  assert.match(blocks[0]!.instructions, /<Set[^]*More/)
  assert.ok(first.historical['historical-orphan'])
  assert.deepEqual(migrateTask(first.body, first.previews, { 'api-designer': 'api-docs' }, first.historical), first)
  assert.equal(first.body.split('<!-- agent -->')[1], old.split('<!-- agent -->')[1])
})

it('packs all built-ins on the same format and exposes only ID and output instructions to sessions', () => {
  const packed = packOfficial(process.env.AI4KANBAN_STUDIOS!)
  assert.equal(packed.length, 6)
  const builder = packed.find(s => s.id === 'wf_builtin_studio_builder')!
  const definition = checkStudioFiles(builder.files, true)
  assert.ok(definition.ok)
  const previews = definition.def.previews
  assert.deepEqual(previews.map(p => p.id), ['market-research', 'studio', 'dashboard', 'files'])
  assert.deepEqual(previews[0]?.title, { en: 'Market research', zh: '市场调研' })
  const direct = parseReviewFlow('Studio', previews)
  assert.equal(direct[0]?.id, 'studio')
  assert.deepEqual(direct[0]?.after, [])
  assert.deepEqual(reviewDependencies(direct), [])
  const research = parseReviewFlow('Market research -> Studio', previews)
  assert.deepEqual(parseReviewFlow('市场调研 -> 工作台', previews), research)
  assert.deepEqual(reviewDependencies(research), [
    { id: 'market-research', after: [], previews: ['market-research'] },
    { id: 'studio', after: ['market-research'], previews: ['studio'] },
  ])
  const template = /```markdown\n(---\n[^]*?)```/.exec(definition.def.rules)?.[1]
  assert.ok(checkStudioFiles({ 'STUDIO.md': template }).ok)
  assert.match(template!, /^## Work\n[^]+^## Land\n[^]+^## Previews\n\n<Preview id="draft">/m)
  assert.ok(!Object.keys(builder.files).some(p => p.startsWith('agents/') || p === 'shared/RULES.md'))
  const coding = packed.find(s => s.id === 'wf_builtin_coding')!
  assert.equal(coding.lands, true)
  const codingDef = checkStudioFiles(coding.files, true)
  assert.ok(codingDef.ok)
  const bugContext = codingDef.def.previews.find(p => p.id === 'bug-context')
  assert.ok(bugContext)
  assert.deepEqual(
    { id: bugContext.id, icon: bugContext.icon, title: bugContext.title, description: bugContext.description },
    {
      id: 'bug-context',
      icon: 'notebook',
      title: { en: 'Bug context', zh: 'Bug 上下文' },
      description: {
        en: 'Review bug context, visual captures, and reproduction steps before fixing.',
        zh: '在修复前审阅 Bug 上下文、截图录屏或可复现步骤与关键现场。',
      },
    },
  )
  assert.match(bugContext.instructions, /Visual or interaction bugs[\s\S]*Non-visual or uncapturable bugs/)
  const context = studioRulesBlock({ action: 'clarify', studio: 'coding' })
  assert.match(context, /<Preview id="bug-context">/)
  assert.match(context, /<Preview id="api-docs">/)
  assert.doesNotMatch(context, /title:|AGENT\.md|what.*remembers|Preview Agent|preview agents/)
  const ask = buildAsk({ action: 'clarify', studio: 'coding', id: 1 })
  for (const component of ['Asset', 'Compare', 'Storyboard', 'Set', 'Studio']) assert.match(ask, new RegExp(component))
})

it('keeps multiline follow-up rules and disables omitted or blank rules', () => {
  const studio = (field: string) => parseStudioFile('example', `---\nname: Example\n${field}---\n`, 'STUDIO.md')
  const rules = (field: string) => {
    const result = studio(field)
    assert.ok('def' in result)
    return result.def.allowedFollowUps
  }
  assert.equal(rules('allowedFollowUps: |\n  First rule.\n  Second rule.\n'), 'First rule.\nSecond rule.')
  assert.equal(rules('allowedFollowUps: "  "\n'), undefined)
  assert.equal(rules(''), undefined)
  assert.ok('problem' in studio('allowedFollowUps: [First rule.]\n'))
})
