import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, it } from 'node:test'
import { cmdStudioValidate } from '../src/commands/studio'
import { cmdStudioPreview } from '../src/commands/studio-preview'
import { ASSETS, setBoardRoot } from '../src/lib/paths'
import { restoreMachineHome } from './helpers/board'
import { setBlock, setItems } from '../../artifact-sdk/src/internal/tags'
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
    write(path.join(dir, 'STUDIO.md'), '---\nname: Review\npreviews: {writer: {title: {en: Writer, zh: 写作}, description: {en: Read the document., zh: 审阅文档。}}}\n---\n\n<Preview id="writer">\nWrite the requested document.\n</Preview>\n')
    write(path.join(dir, 'version.json'), '{"id":"wf_review","version":3}')
    write(path.join(dir, 'references/writer.md'), '---\nname: writer\ndescription: Writes previews\nakb:\n  i18n:\n    en:\n      title: Writer\n    zh:\n      title: 写作\n---\nWrite.\n')
    write(path.join(dir, 'references/writer/notes.md'), 'Before\n')
    write(path.join(dir, 'references/writer/deleted.md'), 'Remove\n')
  }
  fs.appendFileSync(path.join(draft, 'STUDIO.md'), '\n## Land\n\nCheck and save the requested document.\n')
  write(path.join(draft, 'references/writer/notes.md'), 'After\n')
  write(path.join(draft, 'references/writer/added.md'), 'New\n')
  fs.rmSync(path.join(draft, 'references/writer/deleted.md'))
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); restoreMachineHome() })
it('freezes complete files and prints ungrouped Studio and attachment previews', async () => {
  const out = await cmdStudioPreview(1, { folder: draft, base })
  const review = JSON.parse(fs.readFileSync(String(out.file), 'utf8')), dir = path.dirname(String(out.file))
  const read = (src: string) => fs.readFileSync(path.join(dir, src), 'utf8')
  assert.equal(review.agents, undefined)
  assert.equal(review.results, undefined)
  assert.equal(review.base.version, 3)
  assert.match(read(review.files.find((f: { path: string }) => f.path === 'STUDIO.md').diff), /\+## Land/)
  assert.equal(review.fingerprint, cmdStudioValidate(draft).fingerprint)
  assert.equal(setItems(setBlock(String(out.files))!.tags).length, 3)
  for (const f of review.files) {
    if (f.path.endsWith('notes.md')) { assert.match(read(f.diff), /-Before\n\+After/); assert.equal(read(f.before), 'Before\n'); assert.equal(read(f.after), 'After\n') }
    if (f.path.endsWith('added.md')) { assert.equal(f.before, null); assert.match(read(f.diff), /^--- \/dev\/null/m) }
    if (f.path.endsWith('deleted.md')) { assert.equal(f.after, null); assert.match(read(f.diff), /^\+\+\+ \/dev\/null/m) }
    if (f.path.endsWith('writer.md')) { assert.equal(f.diff, undefined); assert.match(read(f.after), /Write\./) }
  }
  fs.rmSync(base, { recursive: true }); fs.rmSync(draft, { recursive: true })
  const graph = collect('<Studio src="review.json" />', path.join(dir, 'card.md'), { resolve: (src, owner) => { const file = path.resolve(path.dirname(owner), src); assert.ok(fs.existsSync(file)); return { key: file, file } }, read: file => fs.readFileSync(file, 'utf8'), retained: () => [] })
  assert.equal(graph.at(-1)?.kind, 'studio')
  assert.ok(graph.every(n => !n.error && !n.problems.length))
  assert.ok(fs.existsSync(path.join(ASSETS, '1/studio-review/review.json')))
})
it('preserves the last snapshot on baseline failure and accepts a minimal new Studio', async () => {
  const out = await cmdStudioPreview(1, { folder: draft, base }), prior = fs.readFileSync(String(out.file), 'utf8')
  await assert.rejects(() => cmdStudioPreview(1, { folder: draft, base: 'empty' }), /version.json/)
  write(path.join(base, 'version.json'), '{"id":"wf_review","version":4}')
  await assert.rejects(() => cmdStudioPreview(1, { folder: draft, base }), /matching baseline/)
  assert.equal(fs.readFileSync(String(out.file), 'utf8'), prior)
  fs.rmSync(path.join(draft, 'version.json'))
  fs.rmSync(path.join(draft, 'references'), { recursive: true })
  const fresh = await cmdStudioPreview(1, { folder: draft, base: 'empty' })
  const review = JSON.parse(fs.readFileSync(String(fresh.file), 'utf8'))
  assert.equal(review.base, null)
  assert.equal(review.files.length, 1)
  assert.equal(fresh.files, '')
})
