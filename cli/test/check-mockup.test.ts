import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const cli = process.cwd()
const shipped = path.resolve(cli, '../official/agents/ui-designer/scripts/check-mockup.mjs')

test('the standalone checker freezes the current preview renderer and dependency lock', async () => {
  const generator = pathToFileURL(path.join(cli, 'scripts/build-mockup-check.mjs')).href
  const { buildMockupCheck } = await import(generator)
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  assert.equal(hash(fs.readFileSync(shipped, 'utf8')), hash(await buildMockupCheck()), 'regenerate the shipped checker')
})

test('failed isolated installation fails the check and removes its environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-install-test-'))
  try {
    fs.mkdirSync(path.join(root, 'bin'))
    fs.writeFileSync(path.join(root, 'bin/npm'), '#!/bin/sh\necho "intentional install failure" >&2\nexit 7\n', {mode: 0o755})
    fs.writeFileSync(path.join(root, 'page.html'), '<p>Original</p>')
    const result = spawnSync(process.execPath, [shipped, path.join(root, 'page.html')], {
      env: {...process.env, HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root, PATH: path.join(root, 'bin')}, encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /page.html[\s\S]*intentional install failure/)
    const cache = path.join(root, '.cache/wildcrane/mockup-check')
    for (const name of fs.readdirSync(cache)) assert.deepEqual(fs.readdirSync(path.join(cache, name)), [])
    assert.equal(fs.readFileSync(path.join(root, 'page.html'), 'utf8'), '<p>Original</p>')
  } finally { fs.rmSync(root, {recursive: true, force: true}) }
})

test('checks reuse an offline cache across tasks, serialize preparation and rebuild damaged or changed versions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-cache-test-'))
  const home = path.join(root, 'home'), project = path.join(root, 'project'), bin = path.join(root, 'bin')
  for (const dir of [home, project, bin]) fs.mkdirSync(dir)
  const log = path.join(root, 'install.log')
  const runtime = `import fs from 'node:fs'; import path from 'node:path';
export async function checkMockups(entries, work) {
  fs.writeFileSync(path.join(work, 'source.ts'), entries.join('\\n'));
  await new Promise(resolve => setTimeout(resolve, 50));
  console.log(JSON.stringify({work, environment: fs.realpathSync(path.join(work, 'node_modules')), entries}));
  return fs.readFileSync(path.join(work, 'source.ts'), 'utf8') === entries.join('\\n');
}`
  const script = fs.readFileSync(shipped, 'utf8')
  const payload = Buffer.from(JSON.stringify({ 'runtime.mjs': runtime, 'package.json': '{"type":"module"}', 'package-lock.json': '{}' })).toString('base64')
  const checker = path.join(root, 'check.mjs')
  fs.writeFileSync(checker, script.replace(/const PAYLOAD = '[^']+'/, `const PAYLOAD = '${payload}'`))
  const browser = `const fs=require('node:fs'),path=require('node:path');
fs.appendFileSync(process.env.MOCKUP_INSTALL_LOG,'browser\\n');
fs.mkdirSync(process.env.PLAYWRIGHT_BROWSERS_PATH,{recursive:true});
fs.writeFileSync(path.join(process.env.PLAYWRIGHT_BROWSERS_PATH,'shell'),'browser binary');`
  fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}
const fs=require('node:fs');
fs.appendFileSync(process.env.MOCKUP_INSTALL_LOG,'npm\\n');
fs.mkdirSync('node_modules/playwright',{recursive:true});
fs.writeFileSync('node_modules/playwright/cli.js',${JSON.stringify(browser)});
`, {mode: 0o755})
  const env = {...process.env, HOME: home, USERPROFILE: home, TMPDIR: project, TMP: project, TEMP: project, PATH: bin, MOCKUP_INSTALL_LOG: log}
  const run = (entry: string, online = true) => new Promise<{code: number | null; output: string}>((resolve, reject) => {
    const child = spawn(process.execPath, [checker, entry], {cwd: project, env: {...env, PATH: online ? bin : ''}})
    let output = ''
    child.stdout.on('data', data => {output += data})
    child.stderr.on('data', data => {output += data})
    child.on('error', reject)
    child.on('close', code => resolve({code, output}))
  })
  const details = (result: {code: number | null; output: string}) => {
    assert.equal(result.code, 0, result.output)
    return JSON.parse(result.output.trim().split('\n').at(-1)!) as {work: string; environment: string; entries: string[]}
  }
  const installs = () => fs.readFileSync(log, 'utf8').trim().split('\n')
  try {
    const key = createHash('sha256').update([payload, process.platform, process.arch, process.versions.modules].join('\0')).digest('hex')
    const abandoned = path.join(home, '.cache/wildcrane/mockup-check', `${key}.lock`)
    fs.mkdirSync(abandoned, {recursive: true})
    const dead = spawnSync(process.execPath, ['-p', 'process.pid'], {encoding: 'utf8'}).stdout.trim()
    fs.writeFileSync(path.join(abandoned, `${dead}-${randomUUID()}`), '')
    const cold = (await Promise.all([run('task-1.tsx'), run('task-2.tsx')])).map(details)
    const first = cold[0]!
    assert.notEqual(first.work, cold[1]!.work)
    assert.deepEqual(installs(), ['npm', 'browser'])
    const warm = details(await run('revised.tsx', false))
    assert.equal(warm.environment, first.environment)
    assert.notEqual(warm.work, first.work)
    assert.equal(fs.existsSync(warm.work), false)
    assert.deepEqual(fs.readdirSync(project), [])
    assert.deepEqual(installs(), ['npm', 'browser'])

    fs.unlinkSync(path.join(first.environment, '../browsers/shell'))
    assert.equal((await run('cannot-repair-offline.tsx', false)).code, 1)
    const repaired = details(await run('repaired.tsx'))
    assert.notEqual(repaired.environment, first.environment)
    assert.deepEqual(installs(), ['npm', 'browser', 'npm', 'browser'])

    fs.writeFileSync(checker, fs.readFileSync(checker, 'utf8').replace(payload, Buffer.from(JSON.stringify({ 'runtime.mjs': runtime + '\n// next version', 'package.json': '{"type":"module"}', 'package-lock.json': '{}' })).toString('base64')))
    const changed = details(await run('new-version.tsx'))
    assert.notEqual(changed.environment, repaired.environment)
    assert.deepEqual(installs(), ['npm', 'browser', 'npm', 'browser', 'npm', 'browser'])
  } finally { fs.rmSync(root, {recursive: true, force: true}) }
})

test('type checking through a symlink keeps shared files inside the isolated mirror', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-symlink-test-'))
  try {
    const source = path.join(root, 'original'), work = path.join(root, 'work'), alias = path.join(root, 'alias')
    fs.mkdirSync(source); fs.mkdirSync(work)
    fs.symlinkSync(source, alias, 'dir')
    fs.symlinkSync(path.join(cli, 'node_modules'), path.join(work, 'node_modules'), 'dir')
    const script = fs.readFileSync(shipped, 'utf8')
    const payload = JSON.parse(Buffer.from(/const PAYLOAD = '([^']+)'/.exec(script)![1]!, 'base64').toString())
    const runtime = path.join(work, 'runtime.mjs')
    fs.writeFileSync(runtime, payload['runtime.mjs'])
    const { checkMockupTypes, checkStaticMockupCode } = await import(pathToFileURL(runtime).href)
    assert.throws(() => checkStaticMockupCode('hook.tsx', 'import {useState as state} from "react"; state(0)'), /hook.tsx:1:\d+: remove React hooks/)
    const screen = 'import {title} from "./shared"; export default function Screen(){return <p>{title}</p>}'
    fs.writeFileSync(path.join(source, 'screen.tsx'), screen)
    fs.writeFileSync(path.join(source, 'shared.ts'), 'export const title: string = "Review"')
    const files = [path.join(alias, 'screen.tsx'), path.join(alias, 'shared.ts')]
    checkMockupTypes(files, alias, work)
    assert.equal(fs.readFileSync(path.join(work, 'source/screen.tsx'), 'utf8'), screen)
    assert.equal(fs.readFileSync(path.join(source, 'screen.tsx'), 'utf8'), screen)
    fs.writeFileSync(path.join(source, 'shared.ts'), 'export const title: string = 42')
    assert.throws(() => checkMockupTypes(files, alias, work), /shared.ts:1:\d+: Type 'number' is not assignable to type 'string'/)
  } finally { fs.rmSync(root, {recursive: true, force: true}) }
})
