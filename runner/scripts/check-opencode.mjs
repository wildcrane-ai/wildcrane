// Exercise the installed package through both real hosts, with disposable configuration.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const option = (key) => process.argv[process.argv.indexOf(key) + 1]
const pkg = path.resolve(option('--package'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcrane-opencode-'))
try {
  for (const version of ['v1', 'v2']) {
    const executable = path.resolve(option(`--${version}`))
    const dir = path.join(root, version)
    fs.mkdirSync(dir, { recursive: true })
    const config = path.join(dir, 'opencode.json')
    const entry = version === 'v1' ? path.join(pkg, 'dist/index.mjs') : pkg
    fs.writeFileSync(config, JSON.stringify({ [version === 'v1' ? 'plugin' : 'plugins']: [pathToFileURL(entry).href] }))
    const socket = net.createServer()
    await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
    const port = socket.address().port
    await new Promise((resolve) => socket.close(resolve))
    const env = { ...process.env, OPENCODE_CONFIG: config, OPENCODE_SERVER_PASSWORD: 'disposable-test',
      WILDCRANE_HOME: path.join(dir, 'wildcrane'),
      XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data'),
      XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_STATE_HOME: path.join(dir, 'state') }
    const command = fs.readFileSync(executable).subarray(0, 80).toString().includes('/env node')
      ? [process.execPath, [executable]] : [executable, []]
    const child = spawn(command[0], [...command[1], 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let logs = ''
    child.stdout.on('data', (x) => { logs += x })
    child.stderr.on('data', (x) => { logs += x })
    const exit = new Promise((resolve) => child.on('exit', resolve))
    const get = async (endpoint) => {
      const url = new URL(`http://127.0.0.1:${port}${endpoint}`)
      if (version === 'v2') url.searchParams.set('location[directory]', dir)
      const response = await fetch(url, { headers: { authorization: `Basic ${Buffer.from('opencode:disposable-test').toString('base64')}` }, signal: AbortSignal.timeout(15_000) })
      assert.equal(response.status, 200)
      return response.json()
    }
    try {
      let ready = false
      for (let attempt = 0; attempt < 120; attempt++) {
        try { await get(version === 'v1' ? '/global/health' : '/openapi.json'); ready = true; break } catch {}
        if (child.exitCode !== null) break
        await new Promise((r) => setTimeout(r, 500))
      }
      assert.ok(ready, `OpenCode ${version} did not start: ${logs.replace(/server password .+/g, 'server password [redacted]')}`)
      if (version === 'v2') {
        let active = false
        for (let attempt = 0; attempt < 60; attempt++) {
          const plugins = await get('/api/plugin')
          if (plugins.data.find((p) => p.id === 'wildcrane')?.state.status === 'active') { active = true; break }
          await new Promise((r) => setTimeout(r, 500))
        }
        assert.ok(active, `V2 plugin did not activate: ${logs.replace(/server password .+/g, '[redacted]')}`)
      }
      const skills = await get(version === 'v1' ? '/skill' : '/api/skill')
      const found = version === 'v1' ? skills : skills.data
      for (const name of ['wildcrane', 'wildcrane-discuss-goal', 'wildcrane-tasks']) assert.ok(found.some((s) => s.name === name), `${version}: missing ${name}; skills=${JSON.stringify(found.map((s) => s.name))}; logs=${logs.replace(/server password .+/g, '[redacted]')}`)
      if (version === 'v1') {
        const tools = await get('/experimental/tool/ids')
        assert.equal(tools.filter((id) => id.startsWith('wildcrane_')).length, 6)
      } else {
        const plugins = await get('/api/plugin')
        assert.equal(plugins.data.find((p) => p.id === 'wildcrane')?.state.status, 'active')
      }
      console.log(`OpenCode ${version}: installed package, native registration and skills passed (${process.platform}).`)
    } finally {
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await exit
      clearTimeout(timer)
    }
  }
} finally { fs.rmSync(root, { recursive: true, force: true }) }
