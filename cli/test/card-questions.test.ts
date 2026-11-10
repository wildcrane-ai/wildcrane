// A question an agent hands to the user always carries choices to tick, exclusive unless it
// says otherwise. `update-questions` is that handoff, so it enforces the shape rather than
// quietly writing a bare line.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

import { buildBoardProgram } from '../src/lib/cli/board.ts'
import { parseFrontmatter } from '../src/lib/frontmatter.ts'
import { setBoardRoot } from '../src/lib/paths.ts'
import { forgetMachineState, move, refuses } from './helpers/board.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-card-questions-'))
const kanban = path.join(root, 'docs', 'kanban')
const todo = path.join(kanban, 'todo')

beforeEach(async () => {
  fs.rmSync(path.join(root, 'docs'), { recursive: true, force: true })
  forgetMachineState(root)
  fs.mkdirSync(todo, { recursive: true })
  fs.writeFileSync(path.join(kanban, 'next-id'), '1\n')
  setBoardRoot(root)
  await move(root, ['create', '--title', 'A card'])
})

const file = (): string => path.join(todo, fs.readdirSync(todo)[0]!)

const questions = (argv: string[]): Promise<Record<string, unknown>> =>
  move(root, ['update-questions', '1', ...argv])

after(() => fs.rmSync(root, { recursive: true, force: true }))

const card = (): string =>
  fs.readFileSync(path.join(todo, fs.readdirSync(todo).find((f) => f.endsWith('.md'))!), 'utf8')

describe('a question handed to the user carries choices', () => {
  it('shows the operations and points to the canonical format guide', () => {
    const program = buildBoardProgram({ program: 'akb raw', cwd: root, installHint: '通过插件连接云端项目', version: null })
    const declared = program.commands.find((c) => c.name() === 'update-questions')
    assert.ok(declared)
    const help = declared.helpInformation()
    assert.match(help, /--append <text>/)
    assert.match(help, /--update <n> <text\.\.\.>/)
    assert.match(help, /--recommended-option <text>/)
    assert.match(help, /--drop <positions>/)
    assert.doesNotMatch(help, /--to-verify/)
    assert.match(help, /--clear/)
    assert.match(help, /akb guide update-questions/)
    assert.equal(
      program.commands.find((c) => c.name() === 'review-verdict'),
      undefined,
    )
  })

  it('refuses a question with no options', async () => {
    await refuses(root, ['update-questions', '1', '--append', 'which region?'], /needs choices to tick/)
  })

  it('refuses a bare question during create', async () => {
    await refuses(root, ['create', '--title', 'Another card', '--question', 'Which region?'], /needs choices to tick/)
  })

  it('refuses the [user] prefix on every write', async () => {
    const choices = ['--option', 'a — why', '--option', 'b — why']
    await refuses(root, ['create', '--title', 'Another', '--question', '[user] Which?', ...choices], /drop the prefix/)
    await refuses(root, ['update-questions', '1', '--append', '[user] Which?', ...choices], /drop the prefix/)
    await questions(['--append', 'Which?', ...choices])
    await refuses(root, ['update-questions', '1', '--update', '1', '[user] Which?', ...choices], /drop the prefix/)
  })

  it('has no tag move left', async () => {
    await assert.rejects(move(root, ['tag', '1', '1', 'user']))
  })

  it('drops the prefix an old card still carries, and the next write stores it without', async () => {
    fs.writeFileSync(file(), card().replace('questions: []', [
      'questions:',
      '  - "[user] Plain?"',
      '  - question: "[user] Which?"',
      '    mode: single',
      '    options:',
      '      - a',
      '      - b',
    ].join('\n')))
    const { meta } = parseFrontmatter(card())
    assert.deepEqual(meta!.questions.map((q) => q.text), ['Plain?', 'Which?'])
    await questions(['--append', 'New?', '--option', 'a', '--option', 'b'])
    assert.doesNotMatch(card(), /\[user\]/)
  })

  it('refuses a question with only one option', async () => {
    await refuses(
      root,
      ['update-questions', '1', '--append', 'which region?', '--option', 'eu-central-1 — nearest'],
      /needs at least 2/,
    )
  })

  it('writes an exclusive question unless told otherwise', async () => {
    await questions([
      '--append',
      'Which region?',
      '--recommended-option',
      'eu-central-1 — nearest to the users',
      '--option',
      'us-east-1 — cheapest',
    ])
    const written = card()
    assert.match(written, /- question: Which region\?/)
    assert.match(written, /mode: single/)
    assert.match(written, /- eu-central-1 — nearest to the users/)
    assert.match(written, /recommend: \[1\]/)
  })

  it('takes --mode multi when the picks may be combined', async () => {
    await questions([
      '--append',
      'Which regions?',
      '--mode',
      'multi',
      '--recommended-option',
      'eu-central-1 — nearest to the users',
      '--recommended-option',
      'us-east-1 — cheapest',
    ])
    const written = card()
    assert.match(written, /mode: multi/)
    assert.match(written, /recommend: \[1, ?2\]/)
  })

  it('refuses two recommendations on an exclusive question', async () => {
    await refuses(
      root,
      ['update-questions', '1', '--append', 'which region?', '--recommended-option', 'a — why', '--recommended-option', 'b — why'],
      /at most one --recommended-option/,
    )
  })

  it('leaves the ops that only remove questions alone', async () => {
    await questions(['--append', 'Which region?', '--option', 'a — why', '--option', 'b — why'])
    await questions(['--append', 'Which zone?', '--option', 'a — why', '--option', 'b — why'])
    await questions(['--drop', '1'])
    assert.doesNotMatch(card(), /Which region\?/)
    await questions(['--clear'])
    assert.match(card(), /questions: \[\]/)
  })
})

// `--skip` is retired (#626): a question an old akb marked skipped drops out on read.
describe('a question an old akb marked skipped', () => {
  it('is not open, and is gone from the card on the next write', async () => {
    await questions(['--append', 'Which region?', '--option', 'a — why', '--option', 'b — why'])
    const file = path.join(todo, fs.readdirSync(todo).find((f) => f.endsWith('.md'))!)
    fs.writeFileSync(file, card().replace('recommend: []', 'recommend: []\n    skipped: true'))
    await move(root, ['update', '1', '--status', 'ready'])
    assert.match(card(), /status: ready/)
    assert.match(card(), /questions: \[\]/)
    await refuses(root, ['update-questions', '1', '--skip', '1'], /unknown option/)
  })
})

// `verify:` is retired (#1329): a card written before then still opens and still takes edits.
describe('a card still carrying verify lines', () => {
  it('reads and rewrites as an ordinary card, and the retired move is gone', async () => {
    const file = path.join(todo, fs.readdirSync(todo).find((f) => f.endsWith('.md'))!)
    fs.writeFileSync(file, card().replace(/\n---\n/, '\nverify:\n  - "check the shade by hand"\n---\n'))
    assert.match(card(), /verify:\n {2}- "check the shade by hand"/)
    await move(root, ['list'])
    await move(root, ['update', '1', '--priority', 'high'])
    assert.match(card(), /priority: high/)
    assert.doesNotMatch(card(), /verify:/)
    await refuses(root, ['update-verify', '1', '--append', 'x'], /unknown command|update-verify/)
  })
})
