// An agent installed as a Windows `.cmd` starts without a shell re-reading its arguments (#602).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { cmdArg, cmdLine, shimTarget, spawnable } from '../src/lib/agent/spawnable.ts'

/** What cmd.exe leaves of a line after one read: each caret takes the next character literally. */
const read = (line: string) => line.replace(/\^(.)/g, '$1')

describe('cmd.exe escaping', () => {
  for (const [arg, quoted] of [
    ['two words', '"two words"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['%PATH%', '"%PATH%"'],
    ['a^b & c|d', '"a^b & c|d"'],
    ['C:\\dir\\', '"C:\\dir\\\\"'],
    ['line one\nline two', '"line one line two"'],
  ]) {
    it(`carries ${JSON.stringify(arg)} through cmd.exe and the batch file`, () => {
      const escaped = cmdArg(arg!)
      assert.equal(read(read(escaped)), quoted)
      // Nothing cmd.exe acts on is left bare for the first read.
      assert.doesNotMatch(escaped.replace(/\^./g, ''), /[%"&|<>^]/)
    })
  }

  it('quotes the whole /c line once', () => {
    assert.equal(cmdLine('C:\\x.cmd', ['a']), '"C:\\x.cmd ^^^"a^^^""')
  })
})

describe('Windows shims', () => {
  const npm = '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'
  const pnpm = '@SETLOCAL\r\n@IF NOT DEFINED NODE_PATH (\r\n  @SET "NODE_PATH=C:\\pnpm\\global\\5\\node_modules"\r\n) ELSE (\r\n  @SET "NODE_PATH=C:\\x;%NODE_PATH%"\r\n)\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*\r\n)\r\n'

  it('follows an npm shim to its script', () => {
    const shim = shimTarget(npm, 'C:\\npm\\codex.cmd')
    assert.equal(shim?.script, 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js')
    assert.equal(shim?.node, 'node')
  })

  it('follows a pnpm shim and keeps its NODE_PATH', () => {
    const shim = shimTarget(pnpm, 'C:\\pnpm\\bin\\claude.cmd')
    assert.equal(shim?.script, 'C:\\pnpm\\@anthropic-ai\\claude-code\\cli.js')
    assert.deepEqual(shim?.env, { NODE_PATH: 'C:\\pnpm\\global\\5\\node_modules' })
  })

  it('runs a shim with node, and any other batch file through cmd.exe', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnable-'))
    fs.writeFileSync(path.join(dir, 'codex.cmd'), npm)
    fs.writeFileSync(path.join(dir, 'other.bat'), '@echo %*\r\n')
    const viaNode = spawnable(path.join(dir, 'codex.cmd'), ['exec', 'a "b"'], {}, 'win32')
    assert.equal(viaNode.command, 'node')
    assert.deepEqual(viaNode.args.slice(1), ['exec', 'a "b"'])
    const viaCmd = spawnable(path.join(dir, 'other.bat'), ['x'], { env: { ComSpec: 'C:\\cmd.exe' } }, 'win32')
    assert.equal(viaCmd.command, 'C:\\cmd.exe')
    assert.deepEqual(viaCmd.args.slice(0, 3), ['/d', '/s', '/c'])
    assert.equal(viaCmd.options.windowsVerbatimArguments, true)
    assert.equal(spawnable('claude', ['-p'], {}, 'darwin').command, 'claude')
  })
})
