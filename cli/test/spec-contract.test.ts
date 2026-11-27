import { uiConfigOf } from './helpers/board.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { ASSETS, setBoardDir, setBoardRoot, SESSIONS_DIR } from '../src/lib/paths'
import { parseFrontmatter, serializeFrontmatter } from '../src/lib/frontmatter'
import { runBoard } from '../src/lib/board-cli'
import { byDispatchOrder } from '../src/lib/view/rules'
import type { Card } from '../src/lib/view/types'
import { formatContractErrors, snapshotSpecs, validateSpec } from '../src/lib/spec-contract'
import { newCardWriteProblems } from '../src/lib/shared/card-structure'
import { setBlock, setItems } from '../../artifact-sdk/src/internal/tags'
import { bodySources } from '../../artifact-sdk/src/internal/references'
import { openRun, openResume, patch, peekRun } from '../src/lib/agent/sessions'
import type { AgentAction } from '../src/lib/agent/types'
import { watchRun } from '../src/lib/agent/watch'
import { move, refuses } from './helpers/board'
import { PROMPT_OF } from './helpers/fake-agent'

let root: string
let file: string
const valid = `---
title: A feature
priority: med
status: todo
blocked_by: []
related: []
modules: []
studio: coding
questions: []
---

An observable feature.

## Worth noting

<!-- agent -->

## Scope
A requirement.

## Todo
- [ ] Implement it.

## Decided by the agent

### Overruled by the user
`

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-contract-'))
  setBoardRoot(root)
  file = path.join(root, 'docs/kanban/todo/1-feature.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, valid)
  fs.writeFileSync(path.join(root, 'docs/kanban/next-id'), '3\n')
  fs.writeFileSync(path.join(path.dirname(file), 'README.md'), '# Tasks\n\n- [ ] #1 [A feature](1-feature.md)\n')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('the card format contract', () => {
  it('ignores the roi an old card still carries, whatever it says, and drops it on a rewrite (#206)', async () => {
    const old = valid.replace('priority: med\n', 'priority: med\nroi: nonsense\n')
    assert.deepEqual(await validateSpec(file, old), [])
    const { meta } = parseFrontmatter(old)
    assert.ok(!('roi' in meta!))
    assert.doesNotMatch(serializeFrontmatter(meta!), /roi/)
  })

  it('starts cards by priority, then by number (#206)', () => {
    const cards = [{ id: 2, priority: 'med' }, { id: 3, priority: 'high' }, { id: 1, priority: 'med' }] as Card[]
    assert.deepEqual(cards.sort(byDispatchOrder).map((c) => c.id), [3, 1, 2])
  })

  it('accepts ordinary cards and group roots', async () => {
    assert.deepEqual(await validateSpec(file, valid), [])
    assert.deepEqual(await validateSpec(path.join(path.dirname(file), '1-group/root.md'), valid), [])
  })

  it('reports the structure that would be lost by the readers', async () => {
    const context = { studio: 'coding', historicalPreviews: ['historical-registered'], previewIds: [] }
    const cases = [
      [parseFrontmatter(valid).body, 'frontmatter', 'frontmatter', 1],
      [valid.replace('studio: coding\n', ''), 'studio', 'studio', 1],
      [valid.replace('studio: coding', 'studio: another'), 'studio', 'studio', 8],
      [valid.replace('status: todo', 'status: "todo'), 'status', 'status', 4],
      [valid.replace('status: todo', 'status: "todo\''), 'status', 'status', 4],
      [valid.replace('blocked_by: []', 'blocked_by:\n  - 12\n  - bad-id'), 'task-ids', 'blocked_by', 7],
      [valid.replace('questions: []', 'questions:\n  - question: Choose\n    options: [A, B]'), 'questions', 'questions.options', 11],
      [valid.replace('questions: []', 'questions:\n  - question: Choose\n    skipped: true'), 'questions', 'questions.skipped', 11],
      [valid.replace('questions: []', 'questions:\n  - question: Choose\n    mode: multiple\n    options:\n      - A'), 'questions', 'questions.mode', 11],
      [valid.replace('questions: []', 'questions:\n  - question: Choose\n    options:\n      - A\n    recommend: [2]'), 'questions', 'questions.recommend', 13],
      [valid.replace('- [ ] Implement it.', '+ [] Implement it.'), 'todo-item', 'Todo', 22],
    ] as const
    for (const [source, rule, path, line] of cases) {
      assert.ok((await validateSpec(file, source, 1, context)).some(e => e.rule === rule && e.line === line), rule)
      assert.ok(newCardWriteProblems(file, source, valid, context).some(e => e.path === path && e.line === line), path)
    }
    const legacy = valid.replace('status: todo', 'status: "todo')
    assert.deepEqual(newCardWriteProblems(file, legacy.replace('A requirement.', 'Updated requirement.'), legacy, context), [])
    assert.deepEqual(newCardWriteProblems(file, valid, legacy, context), [])
    const history = valid.replace('<!-- agent -->', '<Preview id="historical-registered">\nSaved result.\n</Preview>\n\n<!-- agent -->')
    assert.deepEqual(await validateSpec(file, history, 1, context), [])
    assert.ok((await validateSpec(file, history, 1, { previewIds: [] })).some(e => e.rule === 'preview-id'))
  })

  it('reports exact lines and repair instructions without modifying the card', async () => {
    const broken = valid.replace('## Scope', '## Scpoe').replace('status: todo', 'status: invented')
    fs.writeFileSync(file, broken)
    const errors = await validateSpec(file, broken)
    const section = errors.find((e) => e.rule === 'section-name')!
    assert.equal(section.line, broken.split('\n').indexOf('## Scpoe') + 1)
    assert.match(formatContractErrors(errors), /1-feature.md:\d+ \[section-name\] Unknown ## Scpoe/)
    assert.ok(errors.some((e) => e.rule === 'status'))
    await refuses(root, ['validate', '1'], /Spec format validation failed/)
    assert.equal(fs.readFileSync(file, 'utf8'), broken)
  })

  it('reports a card blocked by a group it is in', async () => {
    const dir = path.join(path.dirname(file), '5-outer')
    fs.mkdirSync(path.join(dir, '6-inner'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'root.md'), valid)
    fs.writeFileSync(path.join(dir, '6-inner/root.md'), valid)
    const blocked = valid.replace('blocked_by: []', 'blocked_by: [1, 5]')
    const errors = await validateSpec(path.join(dir, '6-inner/7-part.md'), blocked)
    assert.deepEqual(errors.map((e) => [e.rule, e.line]), [['dependency-cycle', 5]])
    assert.match(errors[0]!.message, /#5, a group this card is in/)
    assert.deepEqual(await validateSpec(path.join(dir, 'root.md'), valid.replace('blocked_by: []', 'blocked_by: [6]')), [])
  })

  it('reports a cycle a group member closes through other cards', async () => {
    const todo = path.dirname(file)
    const card = (at: string, blockedBy: string) => {
      const text = valid.replace('blocked_by: []', `blocked_by: [${blockedBy}]`)
      fs.mkdirSync(path.dirname(path.join(todo, at)), { recursive: true })
      fs.writeFileSync(path.join(todo, at), text)
      return text
    }
    card('5-outer/root.md', '')
    card('8-x.md', '5')
    const member = card('5-outer/7-m.md', '8')
    const errors = await validateSpec(path.join(todo, '5-outer/7-m.md'), member, 7)
    assert.deepEqual(errors.map((e) => [e.rule, e.line]), [['dependency-cycle', 5]])
    assert.match(errors[0]!.message, /#7 → #8 → #5 → #7/)

    const inner = card('5-outer/6-inner/root.md', '8')
    assert.match((await validateSpec(path.join(todo, '5-outer/6-inner/root.md'), inner, 6))[0]!.message, /#6 → #8 → #5 → #6/)

    const direct = card('5-outer/7-m.md', '5')
    assert.equal((await validateSpec(path.join(todo, '5-outer/7-m.md'), direct, 7)).length, 1)

    card('8-x.md', '')
    fs.rmSync(path.join(todo, '5-outer/6-inner'), { recursive: true })
    assert.deepEqual(await validateSpec(path.join(todo, '5-outer/7-m.md'), member, 7), [])
  })

  it('checks all requested cards through the CLI', async () => {
    assert.equal((await move(root, ['validate', '1'])).valid, true)
    fs.writeFileSync(path.join(path.dirname(file), '2-feature.md'), valid.replace('<!-- agent -->', ''))
    await refuses(root, ['validate'], /2-feature.md.*\[boundary\]/)
    await refuses(root, ['validate', '999'], /no task with id 999/)
  })

  it('reads, validates and rewrites a card still carrying the retired decided: block', async () => {
    const old = valid.replace('questions: []\n', 'questions: []\ndecided:\n  - question: "Which region?"\n    chose: "eu"\n    from: memory/goal.md\n')
    fs.writeFileSync(file, old)
    const { meta } = parseFrontmatter(old)
    assert.equal(meta!.title, 'A feature')
    assert.equal(meta!.status, 'todo')
    assert.deepEqual(meta!.questions, [])
    assert.ok(!('decided' in meta!))
    assert.equal((await move(root, ['validate', '1'])).valid, true)
    await move(root, ['update', '1', '--priority', 'high'])
    const written = fs.readFileSync(file, 'utf8')
    assert.match(written, /priority: high/)
    assert.doesNotMatch(written, /decided:|chose:/)
  })

  it('detects duplicate sections, misplaced sections, missing todos and mockup formatting', async () => {
    const bad = valid.replace('<!-- agent -->', '<!-- agent -->\n\n## Worth noting')
      .replace('- [ ] Implement it.', 'Implement it.\n\n<Mockup src=".mockups/1/a.tsx" label="A" /> caption')
    const rules = (await validateSpec(file, bad)).map((e) => e.rule)
    for (const rule of ['duplicate-section', 'section-half', 'todos', 'mockup-block']) assert.ok(rules.includes(rule), rule)
  })

  it('rejects retired sections and keeps every preview above the boundary', async () => {
    for (const title of ['Today', 'Scope out', 'Source']) {
      const old = valid.replace('## Scope', `## ${title}\nOld text.\n\n## Scope`)
      assert.ok((await validateSpec(file, old)).some((e) => e.rule === 'section-name'), title)
    }
    const preview = '<Preview id="ui-design">\nSaved output.\n</Preview>\n\n'
    const human = valid.replace('<!-- agent -->', '## Worth noting after implementation\n\n' + preview + '<!-- agent -->')
    assert.deepEqual(await validateSpec(file, human), [])
    assert.ok((await validateSpec(file, valid.replace('## Todo', preview + '## Todo'))).some((e) => e.rule === 'section-half'))
    assert.ok((await validateSpec(file, human.replace('## Worth noting after implementation', '## Worth noting after implementation\n\n' + preview))).some((e) => e.rule === 'preview-id'))
  })

  it('allows one optional acceptance subsection inside Scope', async () => {
    const checklist = '### Done when\n- [ ] Observable result.\n\n'
    assert.deepEqual(await validateSpec(file, valid.replace('## Todo', checklist + '## Todo')), [])
    assert.ok((await validateSpec(file, valid.replace('## Todo', checklist + checklist + '## Todo'))).some((e) => e.rule === 'duplicate-section'))
    for (const heading of ['## Worth noting', '## Todo', '## Decided by the agent']) {
      assert.ok((await validateSpec(file, valid.replace(heading, heading + '\n' + checklist))).some((e) => e.rule === 'acceptance-section'), heading)
    }
    assert.ok((await validateSpec(file, valid.replace('## Todo', checklist.replace('###', '##') + '## Todo'))).some((e) => e.rule === 'acceptance-section'))
  })

  it('checks a Set and draws its Assets as one item per label (#587)', async () => {
    const set = '<Set label="States">\n<Asset src="a.tsx" label="A" device="desktop" />\n<Asset src="a.m.tsx" label="A" device="mobile" />\n<Asset src="b.ts.diff" label="b.ts" />\n</Set>'
    const card = (body: string) => valid.replace('An observable feature.', `An observable feature.\n\n${body}\n\nMore.`)
    assert.deepEqual(await validateSpec(file, card(set)), [])
    assert.deepEqual(await validateSpec(file, card(set.replaceAll('\n', '\n\n'))), [])
    for (const broken of [set.replace(' label="States"', ''), set.replace('\n</Set>', ''), set.replace('<Asset src="b', 'Prose\n<Asset src="b'), `Prose\n${set}`, set.replace('<Set label="States">\n', '')]) {
      assert.ok((await validateSpec(file, card(broken))).some((e) => e.rule.startsWith('set-')), broken)
    }
    const parsed = setBlock(set)!
    assert.equal(parsed.label, 'States')
    assert.deepEqual(setItems(parsed.tags).map((i) => [i.label, i.tags.length]), [['A', 2], ['b.ts', 1]])
    assert.equal(setBlock(set.replace(' label="States"', '')), null)
    assert.deepEqual(bodySources(card(set)), ['a.tsx', 'a.m.tsx', 'b.ts.diff'])
  })

  it('accepts only mobile or desktop as a mockup device', async () => {
    const tag = (device: string) => valid.replace('- [ ] Implement it.', `- [ ] Implement it.\n\n<Asset src=".assets/1/a.tsx" label="A" ${device}/>\n`)
    const rules = async (device: string) => (await validateSpec(file, tag(device))).map((e) => e.rule)
    for (const ok of ['', 'device="mobile" ', 'device="desktop" ']) assert.ok(!(await rules(ok)).includes('mockup-device'), ok)
    assert.ok((await rules('device="phone" ')).includes('mockup-device'))
  })

  it('checks an Asset tag\'s variants (#1663)', async () => {
    const tag = (attrs: string) => valid.replace('- [ ] Implement it.', `- [ ] Implement it.\n\n<Asset src=".assets/1/a.zh.md" label="A" ${attrs} />\n`)
    const rules = async (attrs: string) => (await validateSpec(file, tag(attrs), 1)).map((e) => e.rule)
    fs.mkdirSync(path.join(ASSETS, '1'), { recursive: true })
    for (const name of ['a.zh.md', 'a.en.md']) fs.writeFileSync(path.join(ASSETS, '1', name), '# A\n')
    const ok = `variants='{"中文": ".assets/1/a.zh.md", "English": ".assets/1/a.en.md"}'`
    assert.deepEqual(await rules(ok), [])
    assert.deepEqual(await rules(''), [])
    for (const bad of [
      `variants='{bad'`,
      `variants='[".assets/1/a.zh.md", ".assets/1/a.en.md"]'`,
      `variants='{"中文": ".assets/1/a.zh.md"}'`,
      `variants='{"English": ".assets/1/a.en.md", "日本語": ".assets/1/a.en.md"}'`,
      `variants='{"中文": ".assets/1/a.zh.md", "日本語": ".assets/1/a.ja.md"}'`,
      `variants='{"中文": ".assets/1/a.zh.md", "English": ".assets/2/a.en.md"}'`,
    ]) assert.deepEqual(await rules(bad), ['mockup-variants'], bad)
  })

  // An agent wrote one beside the card, where nothing reads it, and the review showed no preview.
  it('names where an Asset tag\'s missing file belongs', async () => {
    const card = valid.replace('- [ ] Implement it.', '- [ ] Implement it.\n\n<Asset src=".assets/1/copy.md" label="Copy" />\n')
    const errors = await validateSpec(file, card, 1)
    assert.deepEqual(errors.map((e) => e.rule), ['asset-src'])
    assert.match(errors[0]!.message, /asset folder.*Fix the reference/)
    fs.mkdirSync(path.join(ASSETS, '1'), { recursive: true })
    fs.writeFileSync(path.join(ASSETS, '1', 'copy.md'), '# Copy\n')
    assert.deepEqual(await validateSpec(file, card, 1), [])
  })

  it('names the page line of an image the page cannot reach (#458)', async () => {
    const card = valid.replace('- [ ] Implement it.', '- [ ] Implement it.\n\n<Asset src=".assets/1/page.html" label="Page" />\n')
    fs.mkdirSync(path.join(ASSETS, '1'), { recursive: true })
    fs.writeFileSync(path.join(ASSETS, '1', 'page.html'), '<main>\n<img src="logo.svg">\n</main>\n')
    const errors = await validateSpec(file, card, 1)
    assert.deepEqual(errors.map((e) => [e.rule, e.line]), [['preview-file', 2]])
    assert.match(errors[0]!.file, /assets\/1\/page\.html$/)
    assert.match(errors[0]!.message, /^logo\.svg: no such file/)
    fs.writeFileSync(path.join(ASSETS, '1', 'logo.svg'), '<svg/>')
    assert.deepEqual(await validateSpec(file, card, 1), [])
  })

  it('ignores Markdown image examples and locates missing rendered images in the owning document', async () => {
    const assets = path.join(ASSETS, '1')
    const docs = path.join(assets, 'docs')
    const images = path.join(assets, 'images')
    fs.mkdirSync(docs, { recursive: true })
    fs.mkdirSync(images, { recursive: true })
    fs.writeFileSync(file, valid.replace('An observable feature.', '<Asset src="asset:docs/guide.md" label="Guide" />\n\n<Asset src="asset:docs/guide.mdx" label="Details" />'))
    const guide = path.join(docs, 'guide.md')
    const details = path.join(docs, 'guide.mdx')
    const coverRef = '![Cover](../images/cover(final).svg)'
    const detailRef = '![Details](<../images/cover%20(final(v2)).svg> "Draft")'
    fs.writeFileSync(guide, ['~~~md', coverRef, '~~~', '', '`' + coverRef + '`', ''].join('\n'))
    fs.writeFileSync(details, ['```md', detailRef, '```', '', '``' + detailRef + ' with `tick``', ''].join('\r\n'))
    assert.equal((await move(root, ['validate', '1'])).valid, true)

    fs.appendFileSync(guide, '\nUnclosed ` example: ' + coverRef + '\n')
    fs.appendFileSync(details, '\r\n![Details](\r\n<../images/cover%20(final(v2)).svg> "Draft") after\r\n')
    const cover = path.join(images, 'cover(final).svg')
    const nested = path.join(images, 'cover (final(v2)).svg')
    fs.writeFileSync(cover, '<svg/>')
    fs.writeFileSync(nested, '<svg/>')
    assert.equal((await move(root, ['validate', '1'])).valid, true)

    fs.rmSync(cover)
    fs.rmSync(nested)
    const errors = await validateSpec(file, fs.readFileSync(file, 'utf8'), 1)
    assert.deepEqual(errors.map(e => [e.file, e.line, e.rule, e.message]), [
      [guide, 7, 'preview-file', '../images/cover(final).svg: no such file. Fix the reference or add the file.'],
      [details, 7, 'preview-file', '../images/cover%20(final(v2)).svg: no such file. Fix the reference or add the file.'],
    ])
    await refuses(root, ['validate', '1'], /docs\/guide\.mdx:7 \[preview-file\] \.\.\/images\/cover%20\(final\(v2\)\)\.svg: no such file/)
  })

  it('rejects old state references in cards and preview dependencies while allowing examples', async () => {
    const board = path.join(root, '.akb/kanban')
    setBoardDir(board)
    file = path.join(board, 'todo/1-feature.md')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const assets = path.join(ASSETS, '1')
    fs.mkdirSync(assets, { recursive: true })
    const old = '.akb/boards/.akb/kanban/assets/1/old.png'
    fs.symlinkSync(path.join(root, old), path.join(assets, 'link.png'))
    fs.writeFileSync(path.join(assets, 'page.html'), '<main>\n<img src="link.png">\n</main>')
    fs.writeFileSync(path.join(board, 'todo/normal.png'), 'board file')
    const examples = `Old layout: \`${old}\`.\n\n\`\`\`md\n[Example](${old})\n\`\`\`\n\n[Board asset](normal.png)`
    const body = valid.replace('An observable feature.', examples)
    assert.deepEqual(await validateSpec(file, body, 1), [])
    const tag = `<Asset src="${old}" label="Old" />`
    const text = body.replace('<!-- agent -->', `${tag}\n\n[Old](file://${root}/${old})\n\n<!-- agent -->`)
    const direct = await validateSpec(file, text, 1)
    assert.deepEqual(direct.map(e => [e.rule, e.line]), [
      ['board-state-path', text.split('\n').indexOf(tag) + 1],
      ['board-state-path', text.split('\n').findIndex(line => line.startsWith('[Old](')) + 1],
    ])
    assert.ok(direct.every(e => e.message.includes('asset:<path>')))
    const preview = body.replace('<!-- agent -->', '<Asset src=".assets/1/page.html" label="Page" />\n\n<!-- agent -->')
    const dependency = await validateSpec(file, preview, 1)
    assert.deepEqual(dependency.map(e => [e.rule, e.line]), [['preview-file', 2]])
    assert.match(dependency[0]!.message, /Invalid nested board state path.*Use .*\.akb\/state/)
  })

  it('validates task-relative references on a custom board and warns about valid legacy links', async t => {
    const custom = path.join(root, 'marketing/kanban')
    setBoardDir(custom)
    const grouped = path.join(custom, 'todo/7-group/1-feature.md')
    const folder = path.join(ASSETS, '1')
    const report = 'asset:reports/Release%20notes%20(final).pdf'
    const cover = 'asset:pages/cover(draft(v2)).svg'
    const reportFile = path.join(folder, 'reports/Release notes (final).pdf')
    const coverFile = path.join(folder, 'pages/cover(draft(v2)).svg')
    fs.mkdirSync(path.dirname(grouped), { recursive: true })
    fs.writeFileSync(path.join(custom, 'config.md'), '# Board')
    fs.mkdirSync(path.join(folder, 'pages'), { recursive: true })
    fs.mkdirSync(path.dirname(reportFile), { recursive: true })
    fs.writeFileSync(path.join(folder, 'pages/cover.html'), '<img src="../logo.svg">')
    fs.writeFileSync(path.join(folder, 'logo.svg'), '<svg/>')
    fs.writeFileSync(reportFile, 'report')
    fs.writeFileSync(coverFile, '<svg/>')
    const body = valid.replace('An observable feature.', [
      '<Asset src="asset:pages/cover.html" label="Cover" />',
      `[Report](${report})`,
      `![Cover](${cover} "Draft")`,
      '![Logo](.assets/1/logo.svg)',
    ].join('\n\n'))
    fs.writeFileSync(grouped, body)
    let output = ''
    const write = t.mock.method(process.stdout, 'write', (chunk: string) => { output += chunk; return true })
    const code = await runBoard(['validate', '1', '--board', custom, '--json'], { cwd: root })
    write.mock.restore()
    assert.equal(code, 0, output)
    const answer = JSON.parse(output)
    assert.equal(answer.valid, true)
    assert.equal(answer.warnings.length, 1)
    const line = body.split('\n').findIndex(line => line.startsWith('![Logo]')) + 1
    assert.ok(answer.warnings[0].endsWith(`kanban/todo/7-group/1-feature.md:${line} [legacy-asset-reference] .assets/1/logo.svg is deprecated. Use asset:<path>.`), output)
    for (const bad of ['asset:missing.pdf', 'asset:../report.pdf', '.assets/2/report.pdf', 'asset:/report.pdf', 'asset:%2E%2E/report.pdf']) {
      const errors = await validateSpec(grouped, body.replace(report, bad), 1)
      assert.deepEqual(errors.map(e => [e.rule, e.line]), [['asset-reference', body.split('\n').findIndex(line => line.startsWith('[Report]')) + 1]], bad)
    }
    fs.writeFileSync(path.join(folder, 'pages/cover.html'), '<img src="asset:logo.svg">')
    assert.match((await validateSpec(grouped, body, 1))[0]!.message, /relative to the preview file/)
    fs.writeFileSync(path.join(folder, 'pages/cover.html'), '<img src="../logo.svg">')
    fs.rmSync(reportFile)
    fs.rmSync(coverFile)
    const missing = await validateSpec(grouped, body, 1)
    assert.deepEqual(missing.map(e => [e.rule, e.line, e.message.split(': no such file')[0]]), [report, cover].map(source => [
      'asset-reference', body.split('\n').findIndex(line => line.includes(source)) + 1, source,
    ]))
  })

  it('checks a Compare tag (#1740)', async () => {
    const tag = (attrs: string, around = '\n') => valid.replace('- [ ] Implement it.', `- [ ] Implement it.\n${around}<Compare ${attrs} />\n`)
    const rules = async (attrs: string, around?: string) => (await validateSpec(file, tag(attrs, around), 1)).map((e) => e.rule)
    const dir = path.join(ASSETS, '1')
    fs.mkdirSync(dir, { recursive: true })
    for (const name of ['a.mp4', 'b.mp4', 'a.png', 'b.png']) fs.writeFileSync(path.join(dir, name), '')
    const shots = (list: unknown) => fs.writeFileSync(path.join(dir, 'shots.json'), JSON.stringify(list))
    shots([{ id: 'S1', start: 0, end: 2.25, name: 'Open' }, { id: 'S2', start: 2.25, end: 4, name: 'Close' }])
    const videos = 'a=".assets/1/a.mp4" b=".assets/1/b.mp4" label="Source vs clone"'
    assert.deepEqual(await rules(`${videos} a-label="Source" b-label="Clone" shots=".assets/1/shots.json"`), [])
    assert.deepEqual(await rules('a=".assets/1/a.png" b=".assets/1/b.png" label="A"'), [])
    assert.deepEqual(await rules(videos, ''), ['compare-block'])
    assert.deepEqual(await rules('a=".assets/1/a.mp4" b=".assets/1/b.mp4"'), ['compare-attributes'])
    assert.deepEqual(await rules('a=".assets/1/a.mp4" b=".assets/1/c.mp4" label="A"'), ['compare-src'])
    assert.deepEqual(await rules('a=".assets/1/a.mp4" b=".assets/2/b.mp4" label="A"'), ['compare-src'])
    assert.deepEqual(await rules('a=".assets/1/a.mp4" b=".assets/1/b.png" label="A"'), [])
    assert.deepEqual(await rules('a=".assets/1/a.png" b=".assets/1/b.png" label="A" shots=".assets/1/shots.json"'), ['compare-shots'])
    for (const bad of [[], [{ id: 'S1', start: 0, end: 2, name: 'A' }, { id: 'S1', start: 2, end: 3, name: 'B' }], [{ id: 'S1', start: 0, end: 2, name: 'A' }, { id: 'S2', start: 2.5, end: 3, name: 'B' }]]) {
      shots(bad)
      assert.deepEqual(await rules(`${videos} shots=".assets/1/shots.json"`), ['compare-shots'], JSON.stringify(bad))
    }
  })

  it('checks a Compare tag whose b is a storyboard (#1803)', async () => {
    const tag = (attrs: string) => valid.replace('- [ ] Implement it.', `- [ ] Implement it.\n\n<Compare ${attrs} />\n`)
    const rules = async (attrs: string) => (await validateSpec(file, tag(attrs), 1)).map((e) => e.rule)
    const dir = path.join(ASSETS, '1')
    fs.mkdirSync(dir, { recursive: true })
    for (const name of ['a.mp4', 'a.png']) fs.writeFileSync(path.join(dir, name), '')
    const shot = (id: string, start: number, end: number) => ({ id, start, end, voiceover: { mode: 'none' }, action: 'A move.', captions: [], details: 'Cut.', frames: [] })
    const board = (name: string, ids: string[]) => fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, shots: ids.map((id, i) => shot(id, i, i + 1)) }))
    board('breakdown.json', ['S1', 'S2', 'S3'])
    board('clone.json', ['S1', 'S3'])
    fs.writeFileSync(path.join(dir, 'shots.json'), JSON.stringify([{ id: 'S1', start: 0, end: 1, name: 'Open' }]))
    const ok = 'a=".assets/1/a.mp4" b=".assets/1/clone.json" label="Source vs clone" shots=".assets/1/breakdown.json"'
    assert.deepEqual(await rules(ok), [])
    assert.deepEqual(await rules('a=".assets/1/a.mp4" b=".assets/1/clone.json" label="A"'), ['compare-shots'])
    assert.deepEqual(await rules('a=".assets/1/a.png" b=".assets/1/clone.json" label="A" shots=".assets/1/breakdown.json"'), ['compare-shots'])
    assert.deepEqual(await rules('a=".assets/1/a.png" b=".assets/1/clone.json" label="A"'), [])
    assert.deepEqual(await rules('a=".assets/1/a.mp4" b=".assets/1/clone.json" label="A" shots=".assets/1/shots.json"'), ['compare-shots'])
    board('clone.json', ['S1', 'S4'])
    assert.match((await validateSpec(file, tag(ok), 1))[0]!.message, /Add S4 to/)
    fs.writeFileSync(path.join(dir, 'clone.json'), JSON.stringify({ version: 1, shots: [] }))
    assert.deepEqual(await rules(ok), ['compare-src'])
  })

  it('takes any file on either side of a Compare or in a storyboard frame, but no nesting (#526)', async () => {
    const dir = path.join(ASSETS, '1')
    fs.mkdirSync(dir, { recursive: true })
    for (const name of ['a.png', 'page.html', 'notes.md']) fs.writeFileSync(path.join(dir, name), '')
    fs.writeFileSync(path.join(dir, 'pair.json'), JSON.stringify({ a: 'a.png', b: 'page.html' }))
    fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ version: 1, shots: [{ id: 'S1', start: 0, end: 1, frames: [{ src: 'notes.md' }, { src: 'pair.json' }] }] }))
    const body = (tag: string) => valid.replace('- [ ] Implement it.', `- [ ] Implement it.\n\n${tag}\n`)
    const rules = async (tag: string) => (await validateSpec(file, body(tag), 1)).map((e) => e.rule)
    assert.deepEqual(await rules('<Compare a=".assets/1/page.html" b=".assets/1/notes.md" label="A" />'), [])
    assert.deepEqual(await rules('<Compare a=".assets/1/a.png" b=".assets/1/pair.json" label="A" />'), ['compare-src'])
    assert.deepEqual(await rules('<Storyboard src=".assets/1/board.json" />'), ['preview-nesting'])
  })

  it('validates Preview blocks while ignoring examples inside code fences', async () => {
    const example = '\n<Preview id="ui-design">\n\n### Layout\n\n````md\n```\n## Scope\n<!-- agent -->\n<Mockup broken>\n```\n````\n</Preview>\n'
    assert.deepEqual(await validateSpec(file, valid.replace('<!-- agent -->', example + '\n<!-- agent -->')), [])
    assert.ok((await validateSpec(file, valid + '\n```md\ntext')).some((e) => e.rule === 'code-fence'))
  })
})

// `lose`: delete the card, and put it back when asked; `repairable: false` never does.
async function fakeRun(repairable: boolean, action: AgentAction = 'clarify', lose = true) {
  const script = path.join(root, 'fake-agent.cjs')
  fs.writeFileSync(script, `${PROMPT_OF}
    (async () => {
    const fs = require('node:fs');
    const file = ${JSON.stringify(file)};
    const prompt = await promptOf();
    fs.appendFileSync(${JSON.stringify(path.join(root, 'prompts.log'))}, JSON.stringify(prompt) + '\\n');
    fs.appendFileSync(${JSON.stringify(path.join(root, 'args.log'))}, JSON.stringify(process.argv) + '\\n');
    if (!${lose}) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Scope', '## Scpoe'));
    else if (prompt.includes('disappeared') && ${repairable}) {
      fs.writeFileSync(file, ${JSON.stringify(valid)});
      fs.writeFileSync(${JSON.stringify(path.join(path.dirname(file), 'README.md'))}, '# Tasks\\n\\n- [ ] [#1 A feature](1-feature.md)\\n');
    }
    else fs.rmSync(file, { force: true });
    const turns = fs.readFileSync(${JSON.stringify(path.join(root, 'prompts.log'))}, 'utf8').trim().split('\\n').length;
    console.log(JSON.stringify({type: 'result', result: 'Done', total_cost_usd: turns * 0.1, usage: {input_tokens: 10, output_tokens: 5}}));
    })();
  `)
  fs.writeFileSync(uiConfigOf(root, 'docs/kanban'), JSON.stringify({ runtimes: [{ id: 'global', name: 'Global default', harness: 'claude-code', settings: { command: `${process.execPath} ${script}` } }] }))
  const opened = openRun({ action, id: 1 }, 'Write the spec.', [])
  if ('error' in opened) throw new Error(opened.error)
  opened.spec.plan.argv = [process.execPath, script]
  opened.spec.plan.harness = 'claude-code'
  fs.writeFileSync(path.join(SESSIONS_DIR, `${opened.run.sessionId}.plan.json`), JSON.stringify(opened.spec))
  patch(opened.run.sessionId, (r) => { r.pid = process.pid })
  return opened.run.sessionId
}

async function watchWithResume(id: string): Promise<string> {
  let last = id
  await watchRun(id, async (previous) => {
    assert.equal(peekRun(previous)?.status, 'error')
    assert.doesNotMatch(peekRun(previous)?.error ?? '', /Board problems/)
    assert.ok(!peekRun(previous)?.errorWhy?.some((why) => why.kind === 'format'))
    const opened = await openResume(previous)
    if ('error' in opened) return opened
    assert.equal(peekRun(previous), undefined)
    patch(opened.run.sessionId, (r) => { r.pid = process.pid })
    last = await watchWithResume(opened.run.sessionId)
    return { run: opened.run, spawned: true }
  })
  return last
}

describe('run completion validation', () => {
  // #566: the card format is the agent's own check; it never fails a run.
  it('finishes a run that leaves a malformed card', async () => {
    for (const action of ['clarify', 'edit'] as const) {
      fs.writeFileSync(file, valid)
      fs.rmSync(path.join(root, 'prompts.log'), { force: true })
      const last = await watchWithResume(await fakeRun(false, action, false))
      assert.equal(peekRun(last)?.status, 'done', action)
      assert.match(fs.readFileSync(file, 'utf8'), /## Scpoe/)
      assert.equal(fs.readFileSync(path.join(root, 'prompts.log'), 'utf8').trim().split('\n').length, 1)
    }
  })

  it('leaves deleted cards for the agent to diagnose without a repair run', async () => {
    const id = await fakeRun(true)
    await watchRun(id, async () => { throw Error('No automatic repair') })
    assert.equal(peekRun(id)?.status, 'done')
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.readFileSync(path.join(root, 'prompts.log'), 'utf8').trim().split('\n').length, 1)
  })
})
