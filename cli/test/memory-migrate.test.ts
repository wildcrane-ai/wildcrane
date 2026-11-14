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
