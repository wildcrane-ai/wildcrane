// A bare `akb` or `akb raw` prints its help and succeeds, like `--help` (#1491).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { runAgent } from '../src/lib/agent-cli.ts'
import { runBoard } from '../src/lib/board-cli.ts'

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-bare-help-'))
after(() => fs.rmSync(cwd, { recursive: true, force: true }))

async function captured(work: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const wasLog = console.log
  const wasError = console.error
  console.log = (line: unknown) => void out.push(String(line))
  console.error = (line: unknown) => void err.push(String(line))
  try {
    return { code: await work(), out: out.join('\n'), err: err.join('\n') }
  } finally {
    console.log = wasLog
    console.error = wasError
  }
}

describe('a command with no subcommand', () => {
  it('bare akb prints its help and exits 0', async () => {
    const { code, out, err } = await captured(() => runAgent([], { program: 'akb', cwd }))
    assert.equal(code, 0)
    assert.match(out, /Usage:/)
    assert.match(out, /Commands:/)
    assert.equal(err, '')
  })

  it('bare akb raw prints its help and exits 0', async () => {
    const { code, out, err } = await captured(() => runBoard([], { program: 'akb raw', cwd }))
    assert.equal(code, 0)
    assert.match(out, /Usage:/)
    assert.match(out, /create/)
    assert.equal(err, '')
  })

  it('an unknown command still refuses', async () => {
    const { code, err } = await captured(() => runAgent(['nosuch'], { program: 'akb', cwd }))
    assert.notEqual(code, 0)
    assert.match(err, /unknown command/)
  })
})

describe('canonical command discovery and legacy routes', () => {
  const words = (help: string) => [...help.split('Commands:')[1]!.matchAll(/^ {2}(\S+)/gm)].map((m) => m[1])

  it('lists the public command groups and keeps explicit raw help available', async () => {
    const top = await captured(() => runAgent(['help'], { program: 'akb', cwd }))
    assert.deepEqual(words(top.out).sort(), [
      'account', 'agent', 'board', 'components', 'delivery', 'goal', 'guide', 'help', 'image', 'memory', 'music',
      'project', 'run', 'runner', 'studio', 'task', 'telemetry', 'template', 'transcribe', 'triage', 'tts', 'update', 'workspace',
    ])
    const raw = words((await captured(() => runAgent(['raw', 'help'], { program: 'akb', cwd }))).out)
    for (const word of ['card', 'delivery', 'run', 'triage', 'memory', 'previews', 'components', 'agent', 'studio', 'create']) {
      assert.ok(raw.includes(word), word)
    }
  })

  it('shows public options and keeps scheduler flags out of help', async () => {
    for (const [argv, visible, hidden] of [
      [['task', 'create'], '--previews', /--body-file|--no-body|--question/],
      [['task', 'implement'], '--print', /--(?:new-session|session|fork|transcript|follow|events)\b/],
      [['run', 'resume'], '--fresh', /--require-session/],
      [['memory', 'review'], '--task', /--(?:print|follow|events)\b/],
      [['studio', 'previews'], '--studio', /--triggers/],
    ] as const) {
      const help = await captured(() => runAgent([...argv, '--help'], { cwd }))
      assert.equal(help.code, 0)
      assert.ok(help.out.includes(visible), help.out)
      assert.doesNotMatch(help.out, hidden)
    }
  })

  it('an old name refuses and names the new path', async () => {
    for (const [argv, said] of [
      [['create'], '`akb create` is now `akb task create`.'],
      [['resume'], '`akb resume` is now `akb run resume`.'],
      [['studio', 'diagram', 'coding', '1'], 'Freeze a Studio draft with `akb studio preview <card> --folder <draft> --base <baseline>`.'],
      [['cloud', 'image'], '`akb cloud` is gone: use `akb account`, `akb image`, `akb tts`, `akb music` or `akb template`.'],
    ] as const) {
      const { code, err } = await captured(() => runAgent([...argv], { program: 'akb', cwd }))
      assert.equal(code, 1, argv.join(' '))
      assert.ok(err.includes(said), err)
    }
  })
})
