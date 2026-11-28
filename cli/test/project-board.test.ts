// A board the Local Runner keeps at `<project>/.akb/kanban` (#2020): its project root with
// and without git, a build in a folder that is not a repository, and `--follow` reading the
// whole job.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { followRun } from '../src/commands/run.ts'
import { listDeliveries } from '../src/lib/agent/deliveries.ts'
import { closeRun, openRun } from '../src/lib/agent/sessions.ts'
import { eventsPathOf, logPathOf, withStore } from '../src/lib/agent/store.ts'
import { resolveBoard } from '../src/lib/board-cli.ts'
import { projectStateDir, SESSIONS_FILE, stateRootOf } from '../src/lib/machine/project.ts'
import { SESSIONS_DIR, setBoardDir } from '../src/lib/paths.ts'
import { move, refuses } from './helpers/board.ts'

let root = ''
const board = (): string => path.join(root, '.akb', 'kanban')
const state = (): string => path.join(root, '.akb', 'state')
const legacy = (): string => path.join(root, '.akb', 'boards', '.akb', 'kanban')
const previous = (): string => path.join(root, '.akb', 'hidden-boards', 'kanban')

const find = (cwd: string, named: string) =>
  resolveBoard('list', { board: named, dir: null, cwd, installHint: '通过插件连接云端项目' })

const CARD = [
  '---',
  'title: Say hello',
  'priority: med',
  'status: ready',
  'blocked_by: []',
  'related: []',
  'modules: []',
  'questions: []',
  '---',
  '',
  'Add hello.txt.',
  '',
  '## Worth noting',
  '- **Tiny**: one file.',
  '',
  '<!-- agent -->',
  '',
  '## Scope',
  '- **File**: hello.txt says hi.',
  '',
  '## Todo',
  '- [ ] Write hello.txt',
  '',
  '## Decided by the agent',
  '- **Name**: hello.txt.',
  '',
].join('\n')

// Printing is the command's business; these tests read what it returns.
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const was = { log: console.log, write: process.stdout.write }
  console.log = () => {}
  process.stdout.write = (() => true) as typeof process.stdout.write
  try {
    return await work()
  } finally {
    console.log = was.log
    process.stdout.write = was.write
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akb-project-board-')))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('a board under .akb/', () => {
  it('belongs to the folder holding .akb/, with or without git', () => {
    fs.mkdirSync(path.join(board(), 'todo'), { recursive: true })
    fs.writeFileSync(path.join(board(), 'config.md'), '# Configuration\n')
    assert.equal(find(root, '.akb/kanban').root, root)
    assert.equal(stateRootOf(board()), root)
    assert.equal(projectStateDir(board()), state())
    fs.mkdirSync(path.join(root, '.git'))
    assert.equal(find(root, '.akb/kanban').root, root)
    assert.equal(stateRootOf(board()), root)
    assert.equal(projectStateDir(path.join(root, 'docs/kanban')), path.join(root, '.akb/boards/docs/kanban'))
    assert.equal(projectStateDir(path.join(root, 'kanban')), path.join(root, '.akb/boards/kanban'))
  })

  it('is set up in a plain folder without a nested .akb/.akb, writing nothing else there', async () => {
    await move(root, ['init', '--board', '.akb/kanban'])
    assert.ok(fs.existsSync(path.join(board(), 'todo')))
    assert.ok(fs.existsSync(state()))
    assert.ok(!fs.existsSync(legacy()))
    assert.ok(!fs.existsSync(path.join(root, '.gitignore')))
    assert.ok(!fs.existsSync(path.join(root, '.akb', '.akb')))
    assert.ok(!fs.existsSync(path.join(root, '.akb', '.gitignore')))
  })

  it('moves the complete old state on first CLI use and preserves board-relative assets', async () => {
    const files = { 'assets/1/cover.svg': 'canonical', 'sessions/run.log': 'events', [SESSIONS_FILE]: '{"deliveries":[]}', 'conflicts/recovery.json': 'draft' }
    for (const [file, contents] of Object.entries(files)) {
      const old = path.join(legacy(), file)
      fs.mkdirSync(path.dirname(old), { recursive: true })
      fs.writeFileSync(old, contents)
    }
    const copy = path.join(board(), 'assets/1/cover.svg')
    fs.mkdirSync(path.dirname(copy), { recursive: true })
    fs.writeFileSync(copy, 'board copy')
    const command = ['init', '--board', '.akb/kanban']
    await move(root, command)
    await move(root, command)
    assert.ok(!fs.existsSync(legacy()))
    assert.equal(fs.readFileSync(copy, 'utf8'), 'board copy')
    for (const [file, contents] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(state(), file), 'utf8'), contents)
  })

  it('migrates the previous layout when the older directory was recreated empty', async () => {
    for (const dir of [previous(), legacy()]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(previous(), 'saved'), 'saved')
    await move(root, ['init', '--board', '.akb/kanban'])
    assert.equal(fs.readFileSync(path.join(state(), 'saved'), 'utf8'), 'saved')
    assert.ok(!fs.existsSync(previous()))
    assert.ok(!fs.existsSync(legacy()))
  })

  it('reports conflicting legacy data and preserves both directories', async () => {
    for (const dir of [previous(), legacy()]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(legacy(), 'saved'), 'old')
    fs.writeFileSync(path.join(previous(), 'saved'), 'newer')
    await refuses(root, ['init', '--board', '.akb/kanban'], /Board state exists at .*boards\/\.akb\/kanban and .*hidden-boards\/kanban/)
    assert.ok(!fs.existsSync(state()))
    assert.equal(fs.readFileSync(path.join(legacy(), 'saved'), 'utf8'), 'old')
    assert.equal(fs.readFileSync(path.join(previous(), 'saved'), 'utf8'), 'newer')
  })

  it('leaves the previous directory in place while its session watcher is alive', async () => {
    fs.mkdirSync(previous(), { recursive: true })
    const file = path.join(previous(), SESSIONS_FILE)
    fs.writeFileSync(file, JSON.stringify({ runs: [{ status: 'running', pid: process.pid }] }))
    await refuses(root, ['init', '--board', '.akb/kanban'], /waiting for the running tasks/)
    assert.ok(fs.existsSync(file))
    assert.ok(!fs.existsSync(state()))
    fs.writeFileSync(file, JSON.stringify({ runs: [{ status: 'done', pid: process.pid }] }))
    await move(root, ['init', '--board', '.akb/kanban'])
    assert.ok(fs.existsSync(path.join(state(), SESSIONS_FILE)))
  })

  it('rejects a state directory linked to the old layout', () => {
    fs.mkdirSync(path.dirname(state()), { recursive: true })
    fs.symlinkSync(legacy(), state(), 'dir')
    assert.throws(() => projectStateDir(board()), /Invalid nested board state path.*Use .*\.akb\/state/)
  })

  it('leaves the repository’s .gitignore alone when git already ignores .akb/', async () => {
    spawnSync('git', ['init', '-q', root])
    fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), '.akb/\n')
    await move(root, ['init', '--board', '.akb/kanban'])
    assert.ok(fs.existsSync(path.join(board(), 'todo')))
    assert.ok(!fs.existsSync(path.join(root, '.gitignore')))
  })
})

describe('a build in a folder that is not a repository', () => {
  it('keeps unregistered results active in a non-Git folder', async () => {
    fs.mkdirSync(path.join(board(), 'todo'), { recursive: true })
    fs.writeFileSync(path.join(board(), 'config.md'), '# Configuration\n')
    fs.writeFileSync(path.join(board(), 'todo', '1-say-hello.md'), CARD)
    setBoardDir(board())
    const opened = openRun({ action: 'implement', id: 1, title: 'Say hello' }, 'prompt', [])
    if ('error' in opened) throw new Error(opened.error)
    const delivery = listDeliveries().find((d) => d.cardId === 1)!
    assert.equal(delivery.commitMode, undefined)
    assert.match(delivery.worktree!, /worktrees[/\\].+[/\\]work$/)
    assert.equal(opened.run.cwd, path.join(root, delivery.worktree!))
    fs.writeFileSync(path.join(opened.run.cwd!, 'hello.txt'), 'hi\n')
    fs.writeFileSync(opened.run.logPath, 'built\n')
    await closeRun(opened.run.sessionId, { status: 'done', ok: true, code: 0 })

    assert.equal(listDeliveries().find((d) => d.cardId === 1)!.status, 'active')
    assert.ok(fs.existsSync(path.join(board(), 'todo', '1-say-hello.md')))
    assert.ok(fs.existsSync(path.join(opened.run.cwd!, 'hello.txt')))
    assert.ok(!fs.existsSync(path.join(root, 'hello.txt')))
    assert.notEqual(spawnSync('git', ['rev-parse', '--git-dir'], { cwd: root }).status, 0)
  })
})

describe('--follow', () => {
  // Two sessions of one flow, written down the way a watcher leaves them: the first ended and
  // handed on, the second is the job's last word.
  function flow(second: 'done' | 'error'): string {
    fs.mkdirSync(path.join(board(), 'todo'), { recursive: true })
    fs.writeFileSync(path.join(board(), 'config.md'), '# Configuration\n')
    setBoardDir(board())
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
    const run = (sessionId: string, status: string, startedAt: number) => {
      fs.writeFileSync(logPathOf(sessionId), `${sessionId}\n`)
      return { sessionId, cardId: 1, action: 'clarify', status, startedAt, flowId: 'f1', logPath: logPathOf(sessionId) }
    }
    withStore((store) => {
      store.runs.push(run('first', 'done', 1) as never, run('second', second, 2) as never)
    })
    return 'first'
  }

  it('reads the outcome off the last session of the job', async () => {
    const failed = await quietly(() => followRun(flow('error')))
    assert.equal(failed.status, 'error')
    assert.equal(failed.lastSessionId, 'second')
    assert.match(String(failed.failed), /^run second ended error/)
  })

  it('says nothing failed when the last session finished', async () => {
    const done = await quietly(() => followRun(flow('done')))
    assert.equal(done.status, 'done')
    assert.equal(done.failed, undefined)
  })

  it('prints every session\'s whole event lines with --events, and none of the log', async () => {
    const first = flow('done')
    fs.writeFileSync(eventsPathOf('first'), '{"kind":"message","data":{"text":"a"}}\n{"kind":"log"')
    fs.writeFileSync(eventsPathOf('second'), '{"kind":"plan","data":{"entries":[]}}\n')
    const printed: string[] = []
    const done = await quietly(async () => {
      process.stdout.write = ((chunk: string) => printed.push(chunk) > 0) as typeof process.stdout.write
      return followRun(first, '', 'akb', true)
    })
    assert.equal(done.status, 'done')
    assert.deepEqual(printed, ['{"kind":"message","data":{"text":"a"}}\n', '{"kind":"plan","data":{"entries":[]}}\n'])
  })

  it('prints a session\'s context reading with --events once its window is known', async () => {
    const first = flow('done')
    withStore((store) => {
      store.runs[0]!.context = { used: 1200, limit: 200000 }
      store.runs[1]!.context = { used: 900 }
    })
    const printed: string[] = []
    await quietly(async () => {
      process.stdout.write = ((chunk: string) => printed.push(chunk) > 0) as typeof process.stdout.write
      return followRun(first, '', 'akb', true)
    })
    assert.deepEqual(printed.filter((l) => l.includes('"context"')), ['{"kind":"context","data":{"used":1200,"limit":200000}}\n'])
  })

  it('follows the same-task retry through a historical cross-task flow (#1248)', async () => {
    const first = flow('error')
    fs.writeFileSync(logPathOf('own-retry'), 'Retry\n')
    const execution = { job: '11111111-1111-4111-8111-111111111111', machine: '22222222-2222-4222-8222-222222222222' }
    withStore(store => {
      const [own, stray] = store.runs
      Object.assign(own!, { cardId: 1246, cloudExecution: execution })
      Object.assign(stray!, { cardId: 1247, cloudExecution: execution, result: 'Foreign result', resumeId: 'foreign-thread' })
      store.runs.push({ ...own!, sessionId: 'own-retry', resumedFrom: first, startedAt: 3,
        logPath: logPathOf('own-retry'), harness: 'codex', result: 'Own result', resumeId: 'own-thread' })
    })
    for (const [id, value] of [[first, 'first'], ['second', 'foreign'], ['own-retry', 'retry']]) {
      fs.writeFileSync(eventsPathOf(id!), JSON.stringify({ kind: 'message', data: { text: value } }) + '\n')
    }
    const printed: string[] = []
    const result = await quietly(async () => {
      process.stdout.write = ((chunk: string) => printed.push(chunk) > 0) as typeof process.stdout.write
      return followRun(first, '', 'akb', true)
    })
    assert.deepEqual(printed.map(line => JSON.parse(line).data.text), ['first', 'retry'])
    assert.equal(result.lastSessionId, 'own-retry')
    assert.equal(result.status, 'done')
    assert.equal(result.result, 'Own result')
    assert.equal(result.agentSession, 'own-thread')
  })
})
