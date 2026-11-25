import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { afterEach, before, beforeEach, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { cmdUpdate } from '../src/commands/update'
import { SKILL_VERSION } from '../src/version'
import { runAgent } from '../src/lib/agent-cli'
import { setLanguage } from '../src/lib/machine/settings'
import { buildAkbProgram } from '../src/lib/cli/akb'
import { move } from './helpers/board'

let root: string
let oldPath: string | undefined
const cli = fileURLToPath(new URL('../', import.meta.url))
const loader = path.join(cli, 'bin/ai4kanban.mjs')
before(() => {
  const built = spawnSync(process.execPath, [path.join(cli, 'scripts/build.mjs')], { encoding: 'utf8' })
  assert.equal(built.status, 0, built.stderr)
})

function load(args: string[], cwd: string, program = 'akb') {
  const result = spawnSync(process.execPath, [loader, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, AI4KANBAN_COMMAND: program },
  })
  assert.ifError(result.error)
  return result
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akb-retired-install-')))
  oldPath = process.env.PATH
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`
})
afterEach(() => {
  process.env.PATH = oldPath
  fs.rmSync(root, { recursive: true, force: true })
})

it('真实入口在两棵命令树的无看板错误中保留诊断并提示插件连接', () => {
  setLanguage('zh')
  const project = path.join(root, 'empty')
  fs.mkdirSync(project)
  for (const program of ['akb', '/plugin path/bin/akb']) {
    for (const command of [['raw', 'list'], ['raw', 'run', 'list']]) {
      for (const [options, diagnostic] of [
        [[], `no board here. Looked in ${project} and every folder above it for docs/kanban/.`],
        [['--dir', project], `no board in ${project} — it has no docs/kanban/.`],
        [['--board', project], `${project} is not a board — it has no todo/ and config.md.`],
      ] as const) {
        const message = `${diagnostic} Link this folder to a WildCrane project from the plugin${options.length ? '.' : ', or use --board to select an existing board.'}`
        for (const json of [false, true]) {
          const result = load([...options, ...command, ...(json ? ['--json'] : [])], project, program)
          assert.equal(result.status, 1, result.stdout + result.stderr)
          assert.doesNotMatch(result.stdout + result.stderr, /`[^`\n]+ install`/)
          if (json) {
            assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: { kind: 'no-board', message, dir: project } })
            assert.equal(result.stderr, '')
          } else {
            assert.equal(result.stdout, '')
            assert.ok(result.stderr.includes(message), result.stderr)
          }
          assert.deepEqual(fs.readdirSync(project), [])
        }
      }
    }
  }
})

it('真实入口保留目录不存在错误和调用名，拒绝旧命令且不写入空项目', () => {
  for (const option of ['--dir', '--board']) {
    const missing = path.join(root, 'missing')
    const result = load([option, missing, 'raw', 'list', '--json'], root)
    assert.equal(result.status, 1)
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false, error: { kind: 'no-such-folder', message: `no such folder: ${missing}`, dir: missing },
    })
  }
  for (const args of [['install'], ['skill'], ['skill', 'install'], ['skill', 'refresh']]) {
    for (const json of [false, true]) {
      const result = load([...args, ...(json ? ['--json'] : [])], root)
      assert.equal(result.status, 1)
      if (json) assert.equal(JSON.parse(result.stdout).ok, false)
      else assert.match(result.stderr, /unknown command/)
      assert.deepEqual(fs.readdirSync(root), ['bin'])
    }
  }
  const program = '/plugin path/bin/akb'
  for (const command of [[], ['raw']]) {
    const result = load([...command, '--help'], root, program)
    assert.equal(result.status, 0)
    assert.ok(result.stdout.includes(`Usage: ${program}${command.length ? ' raw' : ''}`), result.stdout)
  }
})

it('真实入口仍可发现或显式读取已有看板，读取不改文件', async () => {
  await move(root, ['init'])
  await move(root, ['create', '--title', '读取回归', '--slug', 'read-regression'])
  const snapshot = () => fs.readdirSync(root, { recursive: true }).map((name) => {
    const file = path.join(root, String(name))
    return [name, fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null]
  })
  const before = snapshot()
  for (const options of [[], ['--dir', root], ['--board', path.join(root, 'docs/kanban')]]) {
    const result = load([...options, 'raw', 'list', '--json'], root)
    assert.equal(result.status, 0, result.stderr)
    const answer = JSON.parse(result.stdout)
    assert.equal(answer.ok, true)
    assert.deepEqual(answer.cards.map((card: { id: number; title: string }) => [card.id, card.title]), [[1, '读取回归']])
    assert.deepEqual(snapshot(), before)
  }
})

it('帮助不再注册 install 或 skill，旧命令报错且不产生文件', async () => {
  const program = buildAkbProgram({ program: 'akb', cwd: root, installHint: '通过插件连接云端项目' })
  assert.doesNotMatch(program.helpInformation(), /^\s+(install|skill)\b/m)
  for (const args of [['install'], ['skill'], ['skill', 'install'], ['skill', 'refresh']]) {
    for (const json of [[], ['--json']]) {
      assert.notEqual(await runAgent([...args, '--dir', root, ...json], { cwd: root }), 0)
      assert.deepEqual(fs.readdirSync(root), ['bin'])
    }
  }
})

it('update 不创建看板、技能或钩子，保留 JSON 字段及目录错误', async () => {
  assert.equal(await runAgent(['update', '--dir', root, '--json'], { cwd: root }), 0)
  assert.deepEqual(fs.readdirSync(root), ['bin'])
  assert.deepEqual(await cmdUpdate({ dir: root, program: 'akb' }), { updated: root, from: null, to: SKILL_VERSION })
  assert.notEqual(await runAgent(['update', '--dir', path.join(root, 'missing'), '--json'], { cwd: root }), 0)
})

it('update 修复已有看板，保留旧技能、配置和钩子', async () => {
  spawnSync('git', ['init', '-q', root])
  await move(root, ['init'])
  const skill = path.join(root, '.agents/skills/kanban')
  fs.mkdirSync(skill, { recursive: true })
  const note = path.join(skill, 'SKILL.md')
  fs.writeFileSync(note, '<!-- ai4kanban 0.0.1 -->\n旧技能')
  fs.writeFileSync(path.join(skill, 'config.md'), '用户配置')
  const hook = path.join(root, '.git/hooks/pre-commit')
  const guard = '#!/bin/sh\n# ai4kanban commit guard 0.0.1\nexit 0\n'
  fs.writeFileSync(hook, guard)
  const hookStamp = fs.statSync(hook).mtimeMs
  const stamp = fs.statSync(note).mtimeMs
  assert.equal(await runAgent(['update', '--dir', root, '--json'], { cwd: root }), 0)
  assert.equal(fs.statSync(note).mtimeMs, stamp)
  assert.equal(fs.readFileSync(path.join(skill, 'config.md'), 'utf8'), '用户配置')
  assert.equal(fs.existsSync(path.join(root, '.claude')), false)
  assert.equal(fs.readFileSync(hook, 'utf8'), guard)
  assert.equal(fs.statSync(hook).mtimeMs, hookStamp)
})

it('显式命名的云端看板得到修复，不创建旧默认看板', async () => {
  const board = path.join(root, '.akb/kanban')
  await move(root, ['init', '--board', board])
  const command = ['update', '--dir', root, '--board', board]
  for (const version of [SKILL_VERSION, '99.0.0']) {
    fs.writeFileSync(path.join(root, 'bin', 'npm'), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`)
    const update = load(command, root)
    assert.equal(update.status, 0, update.stderr)
    assert.equal(update.stdout.match(/Release notes: https:\/\/github\.com\/wildcrane-ai\/wildcrane\/releases/g)?.length, 1)
    assert.equal(update.stdout.match(/This command is /g)?.length, 1)
    assert.ok(update.stdout.includes(path.join(board, 'modules.md')))
    if (version === SKILL_VERSION) assert.match(update.stdout, /the newest published\./)
    else assert.match(update.stdout, /Version 99\.0\.0 is available\.\nRun `npm install -g wildcrane@latest`/)
  }
  assert.equal(fs.existsSync(path.join(root, 'docs/kanban')), false)
  assert.equal(fs.existsSync(path.join(root, '.claude')), false)
})

it('keeps update and guide output in English in either language', () => {
  const outputs = (['en', 'zh'] as const).map(language => {
    setLanguage(language)
    return [
      load(['update', '--help'], root).stdout,
      JSON.parse(load(['update', '--json'], root).stdout),
      load(['guide'], root).stdout,
      load(['guide', 'troubleshoot'], root).stdout,
    ]
  })
  assert.deepEqual(outputs[0], outputs[1])
  const [help, update, index, guide] = outputs[0]!
  assert.match(help, /Repair an existing board and show how to upgrade the CLI/)
  const { output, ...result } = update
  assert.deepEqual(result, { ok: true, updated: root, from: null, to: SKILL_VERSION })
  assert.match(output, /No board found\. Link this folder to a WildCrane project from the plugin\./)
  assert.match(output, /Could not check for updates\.$/)
  assert.match(index, /Find the cause of a software failure and how to fix it\./)
  assert.match(guide, /# Troubleshoot/)
})

it('raw create reports an invalid project link in English without changing the board', async () => {
  const board = path.join(root, '.akb/kanban')
  await move(root, ['init', '--board', board])
  fs.writeFileSync(path.join(root, '.akb', 'base.json'), '{"project":"one","files":{"projects/two/todo/card.md":{}}}')
  const command = ['--board', board, 'raw', 'create', '--title', '中文任务', '--studio', 'coding', '--json']
  const before = fs.readdirSync(path.join(board, 'todo'))
  for (const language of ['en', 'zh'] as const) {
    setLanguage(language)
    const result = load(command, root)
    assert.equal(result.status, 1)
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      error: { kind: 'refused', message: 'The project link is invalid or conflicting. Check this folder’s project link, then try again.' },
    })
    assert.deepEqual(fs.readdirSync(path.join(board, 'todo')), before)
  }
})
