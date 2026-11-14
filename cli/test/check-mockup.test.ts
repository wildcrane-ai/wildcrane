import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
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
      env: {...process.env, TMPDIR: root, TMP: root, TEMP: root, PATH: path.join(root, 'bin')}, encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /page.html[\s\S]*intentional install failure/)
    assert.deepEqual(fs.readdirSync(root).sort(), ['bin', 'page.html'])
    assert.equal(fs.readFileSync(path.join(root, 'page.html'), 'utf8'), '<p>Original</p>')
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
