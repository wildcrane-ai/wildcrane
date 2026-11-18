// Bringing an older board's memory over to who owns it (#805, #1484).
//
// Before this the same four files sat at the board root and again under every module. What
// is asked here: the board's planning files land in the planner's folder, a module's in the
// planner's folder for that module, a `## <module>` topic in a planner file moves into that
// module's folder, each module's `readme.md` lands in the board's own, nothing is
// overwritten, no module folder is left behind, and a second upgrade finds nothing to move.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { memoryTarget } from '../src/lib/memory.ts'
import { setBoardRoot } from '../src/lib/paths.ts'

let root = ''

const board = (): string => path.join(root, 'docs', 'kanban')
const memory = (...parts: string[]): string => path.join(board(), 'memory', ...parts)

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-memory-'))
  fs.mkdirSync(path.join(board(), 'todo'), { recursive: true })
  fs.writeFileSync(path.join(board(), 'next-id'), '1\n')
  setBoardRoot(root)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('where a note goes', () => {
  it('names the module’s copy, made with its starter, and its topics', () => {
    write(path.join(board(), 'modules.md'), '- **skill** — the command\n')
    const target = memoryTarget('rejected.md', 'skill')
    assert.equal(target.file, memory('agents', 'planner', 'skill', 'rejected.md'))
    assert.match(read(target.file), /^# Rejected\n/)
    assert.deepEqual(target.topics, [])

    write(target.file, '# Rejected\n\n## Runs\n\n- No.\n')
    assert.deepEqual(memoryTarget('rejected.md', 'skill').topics, [{ name: 'Runs', entries: 1 }])
  })

  it('names the planner’s own for a card with no module, or a reserved one', () => {
    assert.equal(memoryTarget('decisions.md').file, memory('agents', 'planner', 'decisions.md'))
    assert.equal(memoryTarget('decisions.md', 'redesign').file, memory('agents', 'planner', 'decisions.md'))
    assert.equal(memoryTarget('readme.md', 'skill').file, memory('readme.md'))
  })
})

import { codingMemoryMoves, memoryHash } from '../src/lib/shared/coding-memory-migration.ts'
import { CODING_PREVIEWS } from '../src/lib/shared/coding-previews.ts'
import { memoryDirectories } from '../src/lib/memory.ts'
import { sharedMemory } from '../src/lib/agents/shared-memory.ts'

describe('Coding Preview memory recovery (#842)', () => {
  it('maps all seven IDs, retains both scopes, links and exact content, and retries without duplicates', () => {
    const files = new Map<string, string>()
    for (const role of Object.keys(CODING_PREVIEWS)) for (const prefix of ['', 'projects/p1/']) {
      files.set(`${prefix}memory/agents/${role}/style.md`, `${prefix}# 原文\n[Details](nested/details.md)\n`)
      files.set(`${prefix}memory/agents/${role}/nested/details.md`, 'Details\n')
    }
    files.set('projects/p2/memory/agents/ui-designer/style.md', 'Other project')
    const moves = codingMemoryMoves(files, 'p1')
    assert.equal(moves.length, 28)
    const shared = sharedMemory(board())
    for (const m of moves) {
      assert.equal(shared(m.target.replace(/^projects\/p1\//, '').slice('memory/'.length)), m.scope === 'workspace')
      files.set(m.target, files.get(m.source)!)
      assert.equal(memoryHash(files.get(m.target)!), m.hash)
    }
    assert.ok(codingMemoryMoves(files, 'p1').every(m => m.status === 'existing'))
    for (const m of moves) files.delete(m.source)
    assert.deepEqual(codingMemoryMoves(files, 'p1'), [])
    assert.equal(files.get('projects/p2/memory/agents/ui-designer/style.md'), 'Other project')
    assert.deepEqual(codingMemoryMoves(new Map(), 'p1'), [])
  })

  it('preserves an entire conflicting source tree and relative links across interrupted cleanup', () => {
    const from = 'projects/p1/memory/agents/prompt-writer/'
    const to = 'projects/p1/memory/previews/coding/prompts/project/'
    const files = new Map([[from + 'style.md', '[Rule](nested/rule.md)'], [from + 'nested/rule.md', 'Original'], [to + 'style.md', 'Current']])
    const moves = codingMemoryMoves(files, 'p1')
    assert.ok(moves.every(m => m.status === 'conflict'))
    for (const m of moves) files.set(m.target, files.get(m.source)!)
    files.delete(moves[0]!.source)
    assert.equal(codingMemoryMoves(files, 'p1')[0]!.target, moves[1]!.target)
    assert.equal(files.get(to + 'style.md'), 'Current')
    files.set(moves[1]!.target, 'Changed by another writer')
    assert.equal(codingMemoryMoves(files, 'p1')[0]!.status, 'blocked')
  })

  it('keeps distinct sources that converge on one Preview filename', () => {
    const files = new Map([
      ['projects/p1/memory/agents/competitor-research/README.md', 'Agent research'],
      ['projects/p1/memory/competitors/README.md', 'Shared research index'],
    ])
    const moves = codingMemoryMoves(files, 'p1')
    assert.equal(new Set(moves.map(m => m.target)).size, 2)
    assert.equal(moves.filter(m => m.status === 'conflict').length, 1)
    for (const m of moves) files.set(m.target, files.get(m.source)!)
    assert.deepEqual(moves.map(m => files.get(m.target)), ['Agent research', 'Shared research index'])
  })

  it('lists directory hints without file names or bodies, including user Studios', () => {
    write(memory('previews/coding/prompts/project/rules.md'), 'Private rule')
    write(memory('previews/coding/prompts/workspace/style.md'), 'Shared rule')
    write(memory('previews/wf-mine/draft/project/nested/file.md'), 'My rule')
    const hints = memoryDirectories()
    assert.ok(hints.includes(memory('previews/coding/prompts/project') + '/'))
    assert.ok(hints.includes(memory('previews/coding/prompts/workspace') + '/'))
    assert.ok(hints.includes(memory('previews/wf-mine/draft/project') + '/'))
    assert.doesNotMatch(hints.join('\n'), /rules.md|style.md|nested|Private rule|Shared rule|My rule/)
  })
})
