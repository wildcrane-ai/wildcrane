import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'

it('starts the published Runner and plugin after the host directory was removed', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-startup-'))
  try {
    const home = path.join(root, 'home')
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, 'session.json'), JSON.stringify({
      accessToken: 'test', refreshToken: 'test', subject: 'test', expiresAt: Date.now() + 60_000,
      supabaseUrl: 'http://127.0.0.1:1',
    }))
    const dist = process.env.RUNNER_DIST!
    const entries = ['runner.mjs', 'launcher.mjs', 'plugin.mjs', 'settings.mjs'].map(entry => path.join(dist, entry))
    for (const host of ['claude-code', 'codex', 'cursor', 'dsh', 'kimi-code', 'grok']) {
      entries.push(path.resolve(dist, '../../plugins', host, 'server/dist/start.mjs'))
    }
    for (const entry of entries) {
      for (const removed of [false, true]) {
        const cwd = fs.mkdtempSync(path.join(root, 'cwd-'))
        const expected = removed ? os.homedir() : fs.realpathSync(cwd)
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
          import fs from 'node:fs';
          import { pathToFileURL } from 'node:url';
          process.chdir(process.env.STARTUP_CWD);
          if (${removed}) fs.rmdirSync(process.env.STARTUP_CWD);
          await import(pathToFileURL(process.env.STARTUP_ENTRY).href);
          fs.writeFileSync(process.env.STARTUP_RESULT, process.cwd());
          process.exit(0);
        `], {
          cwd, encoding: 'utf8', timeout: 15_000,
          env: { ...process.env, WILDCRANE_HOME: home, AI4KANBAN_HOME: home,
            AI4KANBAN_SUPABASE_URL: 'http://127.0.0.1:1',
            WILDCRANE_RUNNER_DIR: path.dirname(dist),
            STARTUP_CWD: cwd, STARTUP_ENTRY: entry,
            STARTUP_RESULT: path.join(root, 'result') },
        })
        assert.equal(run.status, 0, `${entry}: ${run.stderr || run.error}`)
        assert.equal(fs.readFileSync(path.join(root, 'result'), 'utf8'), expected, `${entry}, removed=${removed}`)
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
