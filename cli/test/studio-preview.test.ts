import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
    write(path.join(dir, 'templates/项目资料/notes.md'), 'Before\n')
    write(path.join(dir, 'templates/项目资料/deleted.md'), 'Remove\n')
  }
  fs.appendFileSync(path.join(draft, 'STUDIO.md'), '\n## Land\n\nCheck and save the requested document.\n')
  write(path.join(draft, 'templates/项目资料/notes.md'), 'After\n')
  write(path.join(draft, 'templates/项目资料/added.md'), 'New\n')
  fs.rmSync(path.join(draft, 'templates/项目资料/deleted.md'))
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); restoreMachineHome() })
it('freezes complete files and prints ungrouped Studio and attachment previews', async () => {
  write(path.join(draft, '#notes.txt'), 'Loose note.')
  const out = await cmdStudioPreview(1, { folder: draft, base })
  const review = JSON.parse(fs.readFileSync(String(out.file), 'utf8')), dir = path.dirname(String(out.file))
  const read = (src: string) => fs.readFileSync(path.join(dir, src), 'utf8')
  assert.equal(review.agents, undefined)
  assert.equal(review.results, undefined)
  assert.equal(review.base.version, 3)
  assert.match(read(review.files.find((f: { path: string }) => f.path === 'STUDIO.md').diff), /\+## Land/)
  assert.equal(review.fingerprint, cmdStudioValidate(draft).fingerprint)
  assert.equal(setItems(setBlock(String(out.files))!.tags).length, 4)
  for (const f of review.files) {
    if (f.path.endsWith('notes.md')) { assert.match(read(f.diff), /-Before\n\+After/); assert.equal(read(f.before), 'Before\n'); assert.equal(read(f.after), 'After\n') }
    if (f.path.endsWith('added.md')) { assert.equal(f.before, null); assert.match(read(f.diff), /^--- \/dev\/null/m) }
    if (f.path.endsWith('deleted.md')) { assert.equal(f.after, null); assert.match(read(f.diff), /^\+\+\+ \/dev\/null/m) }
    if (f.path.endsWith('writer.md')) { assert.equal(f.diff, undefined); assert.match(read(f.after), /Write\./) }
  }
  fs.rmSync(base, { recursive: true }); fs.rmSync(draft, { recursive: true })
  const restore = fileURLToPath(new URL('../../official/studios/studio-builder/scripts/restore-draft.mjs', import.meta.url))
  const restored = spawnSync(process.execPath, [restore, String(out.file), draft], { encoding: 'utf8' })
  assert.equal(restored.status, 0, restored.stderr)
  assert.equal(cmdStudioValidate(draft).fingerprint, review.fingerprint)
  assert.equal(fs.readFileSync(path.join(draft, 'version.json'), 'utf8'), '{"id":"wf_review","version":3}')
  assert.equal(fs.readFileSync(path.join(draft, 'templates/项目资料/notes.md'), 'utf8'), 'After\n')
  assert.equal(fs.existsSync(path.join(draft, 'templates/项目资料/deleted.md')), false)
  const source = review.files.find((f: { path: string }) => f.path.endsWith('notes.md')).after
  fs.writeFileSync(path.join(dir, source), 'Newer than approved\n')
  const mismatch = spawnSync(process.execPath, [restore, String(out.file), path.join(root, 'invalid')], { encoding: 'utf8' })
  assert.equal(mismatch.status, 1)
  assert.match(mismatch.stderr, /does not match the approved fingerprint/)
  assert.equal(fs.existsSync(path.join(root, 'invalid')), false)
  fs.writeFileSync(path.join(dir, source), 'After\n')
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
  const versionFile = '{"id":"wf_review","version":3}\n'
  write(path.join(base, 'version.json'), versionFile)
  write(path.join(draft, 'version.json'), versionFile)
  const found = await cmdStudioPreview(1, { folder: draft, base })
  const historical = JSON.parse(fs.readFileSync(String(found.file), 'utf8'))
  delete historical.versionFile
  write(String(found.file), JSON.stringify(historical))
  const restore = fileURLToPath(new URL('../../official/studios/studio-builder/scripts/restore-draft.mjs', import.meta.url))
  const restored = path.join(root, 'historical')
  fs.mkdirSync(restored)
  const result = spawnSync(process.execPath, [restore, String(found.file), restored], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(cmdStudioValidate(restored).fingerprint, historical.fingerprint)
  fs.rmSync(path.join(draft, 'version.json'))
  fs.rmSync(path.join(draft, 'references'), { recursive: true })
  fs.rmSync(path.join(draft, 'templates'), { recursive: true })
  const fresh = await cmdStudioPreview(1, { folder: draft, base: 'empty' })
  const review = JSON.parse(fs.readFileSync(String(fresh.file), 'utf8'))
  assert.equal(review.base, null)
  assert.equal(review.files.length, 1)
  assert.equal(fresh.files, '')
})


it('validates, freezes and restores a 10 MiB draft without counting version.json', async () => {
  const files = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name !== 'version.json').map(entry => path.join(entry.parentPath, entry.name))
  let remaining = 10 * 1024 * 1024 - files(draft).reduce((size, file) => size + fs.statSync(file).size, 0)
  for (let index = 0; remaining > 0; index++) {
    const size = Math.min(2 * 1024 * 1024, remaining)
    write(path.join(draft, 'references', 'file-' + index + '.txt'), 'x'.repeat(size))
    remaining -= size
  }
  const fingerprint = cmdStudioValidate(draft).fingerprint
  const out = await cmdStudioPreview(1, { folder: draft, base })
  const review = JSON.parse(fs.readFileSync(String(out.file), 'utf8'))
  assert.equal(review.fingerprint, fingerprint)
  assert.equal(review.files.filter((file: { after: string | null }) => file.after !== null).length, files(draft).length)
  const restore = fileURLToPath(new URL('../../official/studios/studio-builder/scripts/restore-draft.mjs', import.meta.url))
  const restored = path.join(root, 'restored')
  const result = spawnSync(process.execPath, [restore, String(out.file), restored], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(cmdStudioValidate(restored).fingerprint, fingerprint)
  write(path.join(draft, 'shared', 'one'), 'x')
  await assert.rejects(cmdStudioPreview(1, { folder: draft, base }), /10 MiB/)
  fs.appendFileSync(path.join(draft, 'references', 'file-0.txt'), 'x')
  await assert.rejects(cmdStudioPreview(1, { folder: draft, base }), /2 MiB/)
})
