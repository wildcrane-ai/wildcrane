import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, it } from 'node:test'
import { cmdStudioPreview } from '../src/commands/studio-preview'
import { ASSETS, setBoardRoot } from '../src/lib/paths'
import { restoreMachineHome } from './helpers/board'
import { collect } from '../../artifact-sdk/src/internal/collect'

let root = '', base = '', draft = ''
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-review-'))
  process.env.AI4KANBAN_HOME = path.join(root, 'home')
  write(path.join(root, 'docs/kanban/todo/1-card.md'), '---\ntitle: Review\n---\nReview')
  setBoardRoot(root)
  base = path.join(root, 'base'); draft = path.join(root, 'draft')
  for (const dir of [base, draft]) {
    write(path.join(dir, 'STUDIO.md'), '---\nname: Review\npreviews: [writer]\n---\n')
    write(path.join(dir, 'version.json'), '{"id":"wf_review","version":3}')
    write(path.join(dir, 'agents/writer/AGENT.md'), '---\nname: writer\ndescription: Writes previews\nakb:\n  i18n:\n    en:\n      title: Writer\n    zh:\n      title: 写作\n---\nWrite.\n')
    write(path.join(dir, 'agents/writer/notes.md'), 'Before\n')
    write(path.join(dir, 'agents/writer/deleted.md'), 'Remove\n')
  }
  write(path.join(draft, 'agents/writer/notes.md'), 'After\n')
  write(path.join(draft, 'agents/writer/added.md'), 'New\n')
  fs.rmSync(path.join(draft, 'agents/writer/deleted.md'))
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); restoreMachineHome() })
it('freezes actual additions, modifications, deletions, full unchanged files and complete supplied dependencies', async () => {
  const results = path.join(root, 'results/manifest.json')
  write(results, '[{"agent":"writer","component":"Asset","src":"page.html","variants":{"中文":"page.html","English":"en.html"}},{"agent":"writer","component":"Set","label":"Pages","items":[{"src":"page.html"}]}]')
  write(path.join(root, 'results/page.html'), '<img src="image.svg"><p>Existing</p>')
  write(path.join(root, 'results/en.html'), '<p>English</p>')
  write(path.join(root, 'results/page.tsx'), 'import Page from "./part"; export default Page;')
  write(path.join(root, 'results/part.tsx'), 'export default () => <main>Frozen TSX result</main>;')
  write(path.join(root, 'results/image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const entries = JSON.parse(fs.readFileSync(results, 'utf8'))
  entries.push({agent:'writer', component:'Asset', src:'page.tsx'})
  fs.writeFileSync(results, JSON.stringify(entries))
  const out = await cmdStudioPreview(1, { folder: draft, base, results })
  const review = JSON.parse(fs.readFileSync(String(out.file), 'utf8')), dir = path.dirname(String(out.file))
  const read = (src: string) => fs.readFileSync(path.join(dir, src), 'utf8')
  assert.equal(review.agents[0].title.zh, '写作')
  assert.match(read(review.results[2].src), /Frozen TSX result/)
  assert.equal(review.base.version, 3)
  for (const f of review.files) {
    if (f.path.endsWith('notes.md')) { assert.match(read(f.diff), /-Before\n\+After/); assert.equal(read(f.before), 'Before\n'); assert.equal(read(f.after), 'After\n') }
    if (f.path.endsWith('added.md')) { assert.equal(f.before, null); assert.match(read(f.diff), /^--- \/dev\/null/m) }
    if (f.path.endsWith('deleted.md')) { assert.equal(f.after, null); assert.match(read(f.diff), /^\+\+\+ \/dev\/null/m) }
    if (f.path.endsWith('AGENT.md')) { assert.equal(f.diff, undefined); assert.match(read(f.after), /Write\./) }
  }
  fs.rmSync(base, { recursive: true }); fs.rmSync(draft, { recursive: true }); fs.rmSync(path.join(root, 'results'), { recursive: true })
  const graph = collect('<Studio src="review.json" />', path.join(dir, 'card.md'), { resolve: (src, owner) => { const file = path.resolve(path.dirname(owner), src); assert.ok(fs.existsSync(file)); return { key: file, file } }, read: file => fs.readFileSync(file, 'utf8'), retained: () => [] })
  assert.equal(graph.at(-1)?.kind, 'studio')
  assert.ok(graph.some(n => n.file?.endsWith('.svg')))
  assert.ok(graph.every(n => !n.error && !n.problems.length))
  assert.ok(fs.existsSync(path.join(ASSETS, '1/studio-review/review.json')))
})
it('refuses missing/mismatched baselines and escaping, missing or cyclic results without replacing the last snapshot', async () => {
  const out = await cmdStudioPreview(1, { folder: draft, base }), prior = fs.readFileSync(String(out.file), 'utf8')
  await assert.rejects(() => cmdStudioPreview(1, { folder: draft, base: 'empty' }), /version.json/)
  write(path.join(base, 'version.json'), '{"id":"wf_review","version":4}')
  await assert.rejects(() => cmdStudioPreview(1, { folder: draft, base }), /matching baseline/)
  write(path.join(base, 'version.json'), '{"id":"wf_review","version":3}')
  const results = path.join(root, 'results/manifest.json')
  for (const src of ['../base/STUDIO.md', 'missing.html', 'https://example.com/page.html']) {
    write(results, JSON.stringify([{ agent: 'writer', component: 'Asset', src }]))
    await assert.rejects(() => cmdStudioPreview(1, { folder: draft, base, results }))
    assert.equal(fs.readFileSync(String(out.file), 'utf8'), prior)
  }
  write(results, '[{"agent":"writer","component":"Compare","a":"cycle.json","b":"p.html"}]')
  write(path.join(root, 'results/cycle.json'), '{"a":"cycle.json","b":"p.html"}')
  write(path.join(root, 'results/p.html'), '<p>Page</p>')
  await assert.rejects(() => cmdStudioPreview(1, { folder: draft, base, results }), /循环/)
  assert.equal(fs.readFileSync(String(out.file), 'utf8'), prior)
  fs.rmSync(path.join(draft, 'version.json'))
  assert.equal(JSON.parse(fs.readFileSync(String((await cmdStudioPreview(1, { folder: draft, base: 'empty' })).file), 'utf8')).base, null)
})
