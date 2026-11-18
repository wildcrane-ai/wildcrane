import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it, mock } from 'node:test'
import { removeLegacyKanbanSkill } from '../src/kanban-skill'
let root: string
const skill = (folder = '.claude') => path.join(root, folder, 'skills/kanban')
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-skill-')) })
afterEach(() => { mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }) })
it('retires current and historical managed copies without installing or restoring them', () => {
  removeLegacyKanbanSkill(root)
  assert.deepEqual(fs.readdirSync(root), [])
  for (const [folder, marker] of [['.claude', 'managed'], ['.agents', '0.1.0']]) {
    fs.mkdirSync(skill(folder), { recursive: true })
    fs.writeFileSync(path.join(skill(folder), 'SKILL.md'), `Old\n<!-- ai4kanban ${marker} -->\n`)
  }
  removeLegacyKanbanSkill(root)
  removeLegacyKanbanSkill(root)
  for (const folder of ['.claude', '.agents']) assert.equal(fs.existsSync(skill(folder)), false)
})
it('preserves user content, empty directories, configuration and nonordinary files', () => {
  fs.mkdirSync(skill(), { recursive: true })
  removeLegacyKanbanSkill(root)
  assert.ok(fs.existsSync(skill()))
  const file = path.join(skill(), 'SKILL.md')
  fs.writeFileSync(file, 'User skill')
  removeLegacyKanbanSkill(root)
  assert.equal(fs.readFileSync(file, 'utf8'), 'User skill')
  fs.writeFileSync(file, '<!-- ai4kanban managed -->')
  fs.writeFileSync(path.join(skill(), 'config.md'), 'User config')
  removeLegacyKanbanSkill(root)
  assert.equal(fs.existsSync(file), false)
  assert.equal(fs.readFileSync(path.join(skill(), 'config.md'), 'utf8'), 'User config')
  fs.mkdirSync(file)
  removeLegacyKanbanSkill(root)
  assert.ok(fs.statSync(file).isDirectory())
})
it('never follows links at any component, even dangling links', () => {
  for (const part of ['.claude', '.claude/skills', '.claude/skills/kanban', '.claude/skills/kanban/SKILL.md']) {
    const target = fs.mkdtempSync(path.join(root, 'target-'))
    const suffix = '.claude/skills/kanban/SKILL.md'.slice(part.length + 1)
    const held = suffix ? path.join(target, suffix) : path.join(target, 'file')
    fs.mkdirSync(path.dirname(held), { recursive: true })
    fs.writeFileSync(held, '<!-- ai4kanban managed -->')
    const link = path.join(root, part)
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(suffix ? target : held, link)
    removeLegacyKanbanSkill(root)
    assert.equal(fs.readFileSync(held, 'utf8'), '<!-- ai4kanban managed -->')
    fs.unlinkSync(link)
    fs.symlinkSync(path.join(root, 'missing'), link)
    removeLegacyKanbanSkill(root)
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    fs.rmSync(path.join(root, '.claude'), { recursive: true, force: true })
  }
})
it('preserves a linked project root and a non-directory parent', () => {
  fs.mkdirSync(skill(), { recursive: true })
  const file = path.join(skill(), 'SKILL.md')
  fs.writeFileSync(file, '<!-- ai4kanban managed -->')
  const link = `${root}-link`
  fs.symlinkSync(root, link)
  try {
    removeLegacyKanbanSkill(link)
    assert.ok(fs.existsSync(file))
  } finally { fs.unlinkSync(link) }
  fs.rmSync(path.join(root, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(root, '.claude'), 'User file')
  removeLegacyKanbanSkill(root)
  assert.equal(fs.readFileSync(path.join(root, '.claude'), 'utf8'), 'User file')
})
it('reports cleanup permission failures internally and continues with other folders', () => {
  fs.mkdirSync(skill(), { recursive: true })
  fs.writeFileSync(path.join(skill(), 'SKILL.md'), '<!-- ai4kanban managed -->')
  fs.mkdirSync(skill('.agents'), { recursive: true })
  fs.writeFileSync(path.join(skill('.agents'), 'SKILL.md'), '<!-- ai4kanban managed -->')
  const unlink = fs.unlinkSync
  mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
    if (file === path.join(skill(), 'SKILL.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    unlink(file)
  })
  const log = mock.method(process.stderr, 'write', () => true)
  assert.doesNotThrow(() => removeLegacyKanbanSkill(root))
  assert.match(String(log.mock.calls[0].arguments[0]), /无法清理.*denied/)
  assert.ok(fs.existsSync(path.join(skill(), 'SKILL.md')))
  assert.equal(fs.existsSync(skill('.agents')), false)
})
it('keeps plugin skills without kanban', () => {
  for (const host of ['claude-code', 'codex', 'cursor', 'dsh']) {
    const skills = path.resolve(process.env.RUNNER_DIST!, '../../plugins', host, 'skills')
    assert.match(fs.readFileSync(path.join(skills, 'discuss-goal/SKILL.md'), 'utf8'), /`akb guide discuss-goal`/)
    assert.equal(fs.existsSync(path.join(skills, 'kanban')), false)
  }
})
