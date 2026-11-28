import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, it } from 'node:test'

import { markUnsent } from '../src/cache'
import { runnerHome, useRunnerHome } from '../src/home'
import { hostOf, nextOf, noticeOf, type Seen } from '../src/plugin'
import { acquireMachine, lockPath, RunnerAlreadyRunning } from '../src/lock'
import { EXIT_ALREADY_RUNNING } from '../src/protocol'
import { FakeCloud, writeFakeSession } from './fake-cloud'

// The Claude Code and Codex components speak MCP on stdout and end with their host.

const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('one Runner per computer', () => {
  it('reports the duplicate to its launcher and exits before sign-in', async () => {
    const release = await acquireMachine('claude-code')
    try {
      const launched = spawnSync(process.execPath, [path.join(process.env.RUNNER_DIST!, 'launcher.mjs')], {
        env: { ...process.env, AI4KANBAN_CLOUD_URL: 'http://127.0.0.1:9', LC_ALL: 'en_US' },
        encoding: 'utf8', timeout: 8_000,
      })
      assert.equal(launched.error, undefined)
      assert.equal(launched.status, EXIT_ALREADY_RUNNING, launched.stderr)
      assert.match(launched.stderr, /A WildCrane Runner is already running/)
      assert.equal(launched.stdout, '')
    } finally { await release() }
    await (await acquireMachine('terminal'))()
  })

  it('rejects a duplicate while a legacy Runner holds the socket', async () => {
    if (process.platform === 'win32') return
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true })
    fs.rmSync(lockPath(), { force: true })
    const silent = net.createServer((peer) => peer.on('error', () => {})).listen(lockPath())
    await new Promise((r) => silent.once('listening', r))
    try { await assert.rejects(acquireMachine('terminal'), RunnerAlreadyRunning) }
    finally { await new Promise((r) => silent.close(r)) }
  })

  it('takes over from a holder that crashed and left its socket behind', async () => {
    if (process.platform === 'win32') return
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true })
    const crashed = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(lockPath())}, () => console.log('up'))`])
    await new Promise((r) => crashed.stdout.once('data', r))
    crashed.kill('SIGKILL')
    await new Promise((r) => crashed.once('exit', r))
    assert.ok(fs.existsSync(lockPath()))
    await (await acquireMachine('terminal'))()
  })

  it('rejects a duplicate even when the live Runner loses its socket path', async () => {
    if (process.platform === 'win32') return
    const release = await acquireMachine('terminal')
    try {
      fs.unlinkSync(lockPath())
      await assert.rejects(acquireMachine('codex'), RunnerAlreadyRunning)
    } finally { await release() }
    await (await acquireMachine('codex'))()
  })

  it('takes over when a stale owner lock collides with a reused PID and dead socket', async () => {
    if (process.platform === 'win32') return
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true })
    const crashed = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(lockPath())}, () => console.log('up'))`])
    await new Promise((r) => crashed.stdout.once('data', r))
    crashed.kill('SIGKILL')
    await new Promise((r) => crashed.once('exit', r))
    const ownerDir = `${lockPath()}.owner`
    fs.mkdirSync(ownerDir, { recursive: true })
    fs.writeFileSync(path.join(ownerDir, `${process.pid}-00000000-0000-4000-8000-000000000000`), '')
    await (await acquireMachine('terminal'))()
    assert.equal(fs.existsSync(lockPath()), false)
    assert.equal(fs.existsSync(ownerDir), false)
  })

  it('cleans up its socket and owner lock when SIGTERM arrives twice during shutdown', async () => {
    if (process.platform === 'win32') return
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcrane-runner-sigterm-'))
    const cloud = new FakeCloud()
    await cloud.start()
    writeFakeSession(home)
    const sock = path.join(home, 'runner.sock')
    const ownerDir = `${sock}.owner`
    const child = spawn(process.execPath, [path.join(process.env.RUNNER_DIST!, 'runner.mjs')], {
      env: { ...process.env, WILDCRANE_HOME: home, AI4KANBAN_CLOUD_URL: `http://127.0.0.1:${cloud.port}` },
      stdio: 'pipe',
    })
    const exited = once(child, 'exit')
    try {
      await until(() => fs.existsSync(sock) && fs.existsSync(ownerDir) && cloud.registrations > 0, 10_000)
      child.kill('SIGTERM')
      child.kill('SIGTERM')
      assert.equal((await exited)[0], 0)
      assert.equal(fs.existsSync(sock), false, 'runner.sock should be removed on exit')
      assert.equal(fs.existsSync(ownerDir), false, 'runner.sock.owner should be removed on exit')
    } finally {
      child.kill('SIGKILL')
      await cloud.stop()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

const components = new Set<ReturnType<typeof spawn>>()
afterEach(() => { for (const child of components) child.kill('SIGKILL'); components.clear() })

/** The built component of `host`'s plugin, spoken to over stdio. */
function component(host: 'claude-code' | 'codex' | 'dsh' | 'grok' | 'opencode' | 'antigravity', cloud = 'http://127.0.0.1:9', env: Record<string, string> = {}) {
  const server = path.join(process.env.RUNNER_DIST!, '..', '..', 'plugins', host, 'server', 'dist', 'start.mjs')
  const child = spawn(process.execPath, [server, ...(host === 'claude-code' ? [] : [host])], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.resolve(path.dirname(server), '..', '..'), WILDCRANE_RUNNER_DIR: path.resolve(process.env.RUNNER_DIST!, '..'), AI4KANBAN_CLOUD_URL: cloud, HTTPS_PROXY: 'http://127.0.0.1:9', CODEX_HOME: path.join(os.tmpdir(), 'wildcrane-no-codex-home'), ...env },
  })
  components.add(child)
  child.once('close', () => components.delete(child))
  const answers = new Map<number, Record<string, unknown>>()
  let buffer = ''
  child.stdout.on('data', (d) => {
    buffer += d
    for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) {
      const message = JSON.parse(buffer.slice(0, i)) as { id: number }
      answers.set(message.id, message)
    }
  })
  const send = (id: number, method: string, params: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  const ready = (async () => {
    send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    await until(() => answers.has(1))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  })()
  return { child, answers, send, ready }
}

it('persists terminal and both plugin Runner lifecycles in the same log across restarts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcrane-plugin-logs-'))
  const cloud = new FakeCloud()
  await cloud.start()
  writeFakeSession(home)
  const env = { WILDCRANE_HOME: home, AI4KANBAN_CLOUD_URL: `http://127.0.0.1:${cloud.port}` }
  const file = path.join(home, 'logs/runner.log')
  const seen = (source: string, event: string) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim().split('\n')
    .some(line => { const row = JSON.parse(line); return row.component === 'runner' && row.source === source && row.event === event })
  try {
    for (const host of ['terminal', 'codex', 'claude-code'] as const) {
      const plugin = host === 'terminal' ? undefined : component(host, env.AI4KANBAN_CLOUD_URL, env)
      const child = plugin?.child ?? spawn(process.execPath, [path.join(process.env.RUNNER_DIST!, 'launcher.mjs')], {
        env: { ...process.env, ...env }, stdio: 'pipe',
      })
      const exited = once(child, 'exit')
      try {
        await until(() => seen(host, 'connected'), 10_000)
        if (plugin) {
          await plugin.ready
          plugin.send(2, 'tools/list', {})
          await until(() => plugin.answers.has(2))
          assert.ok((plugin.answers.get(2)?.result as { tools: unknown[] })?.tools.length)
        }
      } finally {
        if (plugin) child.stdin.end()
        else child.kill('SIGTERM')
        assert.equal((await exited)[0], 0)
      }
    }
    for (const host of ['terminal', 'codex', 'claude-code']) {
      for (const event of ['starting', 'connected', 'exited']) assert.ok(seen(host, event), `${host} ${event}`)
    }
  } finally {
    await cloud.stop()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

describe('the host the Claude Code plugin runs in (#532)', () => {
  it('is ZCode only when ZCode set both plugin roots', () => {
    assert.equal(hostOf(undefined, { CLAUDE_PLUGIN_ROOT: '/z', ZCODE_PLUGIN_ROOT: '/z' }), 'zcode')
    assert.equal(hostOf(undefined, { CLAUDE_PLUGIN_ROOT: '/c', ZCODE_PLUGIN_ROOT: '/z' }), 'claude-code')
    assert.equal(hostOf(undefined, { CLAUDE_PLUGIN_ROOT: '/c' }), 'claude-code')
    assert.equal(hostOf('opencode', {}), 'opencode')
    assert.equal(hostOf('grok', { CLAUDE_PLUGIN_ROOT: '/c' }), 'grok')
    assert.equal(hostOf('codex', { CLAUDE_PLUGIN_ROOT: '/z', ZCODE_PLUGIN_ROOT: '/z' }), 'codex')
  })
})

describe("the Codex status's next line", () => {
  const newer = { version: '0.1.4', latest: '0.1.5', source: 'git' as const }
  const current = { version: '0.1.5', latest: null, source: 'git' as const }
  const ready = { label: 'Codex', state: 'ready' as const, command: null }
  const out = { label: 'Codex', state: 'signedOut' as const, command: 'codex login' }
  const missing = { label: 'Claude Code', state: 'notInstalled' as const, command: null }
  const seen = (over: Partial<Seen> = {}): Seen => ({ connections: [ready], folder: { project: 'p1' }, refused: null, web: 'https://app.wildcrane.ai', ...over })

  it('tells Codex about a newer release, the outdated Runner first, and leaves Claude Code to its panel', () => {
    const next = nextOf('codex', 'running', newer)
    assert.match(String(next), /0\.1\.5 is out; this computer has 0\.1\.4, and tasks still run/)
    assert.match(String(next), /`codex plugin marketplace upgrade wildcrane`/)
    assert.equal(nextOf('codex', 'running', { version: '0.1.4', latest: null }), null)
    assert.match(String(nextOf('codex', 'outdated', newer)), /tasks no longer run/)
    assert.equal(nextOf('claude-code', 'running', newer), null)
  })

  it('leaves Cursor updates to its marketplace but says what else is unfinished (#530)', () => {
    assert.equal(nextOf('cursor', 'running', newer, seen()), null)
    assert.match(String(nextOf('cursor', 'running', newer, seen({ folder: null }))), /^This folder is not a WildCrane project/)
    assert.match(String(nextOf('cursor', 'outdated', newer)), /restart Cursor/)
  })

  it('routes Grok updates and failures to Grok (#675)', () => {
    assert.match(String(nextOf('grok', 'running', newer, seen())), /`grok plugin update wildcrane`/)
    assert.match(String(nextOf('grok', 'outdated', newer)), /restart Grok Build/)
    assert.doesNotMatch(String(nextOf('grok', 'running', newer, seen())), /codex|Claude/)
  })

  it('tells dsh its own update steps (#531)', () => {
    assert.match(String(nextOf('dsh', 'running', newer, seen())), /`dsh plugin --profile web add wildcrane-dsh@latest`.*restart dsh/)
    assert.match(String(nextOf('dsh', 'outdated', newer)), /restart dsh/)
  })

  it('tells Kimi Code of a newer plugin with its /plugins steps (#533)', () => {
    assert.match(String(nextOf('kimi', 'running', newer, seen())), /`\/plugins` in Kimi Code/)
    assert.match(String(nextOf('kimi', 'outdated', newer)), /restart Kimi Code/)
  })

  it("gives Claude Code's /wildcrane its update line, the outdated Runner first", () => {
    assert.match(String(noticeOf('zh', 'running', newer)), /新版本 0\.1\.5.*claude plugin update wildcrane@wildcrane/)
    assert.match(String(noticeOf('en', 'outdated', newer)), /out of date.*restart Claude Code/)
    assert.equal(noticeOf('en', 'running', current), null)
  })

  it('tells a local-folder install how to switch to the source that updates, first after outdated (#528)', () => {
    const local = { ...current, source: 'local' as const }
    const next = String(nextOf('codex', 'running', local, seen({ connections: [out], folder: null })))
    assert.match(next, /installed from a local folder.*`codex plugin marketplace add wildcrane-ai\/wildcrane --ref codex-plugin`/)
    assert.match(String(nextOf('codex', 'outdated', local)), /tasks no longer run.*restart Codex/)
  })

  it('names every tool not ready with its command, and the web, when none is', () => {
    const next = String(nextOf('codex', 'running', current, seen({ connections: [out, missing] })))
    assert.equal(next, 'No AI tool is ready on this computer: Codex is signed out (run `codex login`), Claude Code is not installed. Tell the user, with the sign-in command for the tool they use; a missing one installs from local settings (wildcrane_open_settings). They can finish setup at https://app.wildcrane.ai.')
    assert.equal(nextOf('codex', 'running', current, seen({ connections: [out, ready] })), null)
    assert.equal(nextOf('claude-code', 'running', current, seen({ connections: [out] })), null)
  })

  it('offers to add the folder when it is not a project and was not refused', () => {
    assert.match(String(nextOf('codex', 'running', current, seen({ folder: null }))), /not a WildCrane project yet.*wildcrane_open_settings/)
    assert.equal(nextOf('codex', 'running', current, seen({ folder: null, refused: 'home' })), null)
    assert.equal(nextOf('codex', 'running', current, seen({ folder: null, refused: undefined })), null)
    assert.equal(nextOf('codex', 'running', current, seen()), null)
  })

  it('gives one line, in order: outdated, no tool ready, folder not added, newer release', () => {
    const all = seen({ connections: [out], folder: null })
    assert.match(String(nextOf('codex', 'outdated', newer, all)), /tasks no longer run/)
    assert.match(String(nextOf('codex', 'running', newer, all)), /^No AI tool is ready/)
    assert.match(String(nextOf('codex', 'running', newer, seen({ folder: null }))), /^This folder is not a WildCrane project/)
    assert.match(String(nextOf('codex', 'running', newer, seen())), /0\.1\.5 is out/)
  })
})

describe('the plugin akb in a session started by hand (#187)', () => {
  const instructionsOf = (answers: Map<number, Record<string, unknown>>) => (answers.get(1)!.result as { instructions?: string }).instructions
  const stop = (child: ReturnType<typeof spawn>) => new Promise((r) => {
    child.on('exit', r)
    child.stdin!.end()
  })

  it('writes the shim signed out, and only Codex is told where it is', async () => {
    const shim = path.join(runnerHome(), 'bin', 'akb', 'akb')
    fs.rmSync(path.dirname(shim), { recursive: true, force: true })
    const claude = component('claude-code')
    await claude.ready
    assert.ok(fs.statSync(shim).mode & 0o111)
    assert.equal(instructionsOf(claude.answers), undefined)
    await stop(claude.child)
    const codex = component('codex')
    await codex.ready
    assert.equal(instructionsOf(codex.answers), `Run \`${shim}\` for every \`akb\` command.`)
    await stop(codex.child)
  })

  it('tells dsh, which reads no instructions, the shim through wildcrane_status (#561)', async () => {
    const dsh = component('dsh')
    await dsh.ready
    dsh.send(2, 'tools/call', { name: 'wildcrane_status', arguments: { path: os.homedir() } })
    await until(() => dsh.answers.has(2), 10_000)
    const status = JSON.parse((dsh.answers.get(2)!.result as { content: { text: string }[] }).content[0]!.text)
    assert.equal(status.akb, path.join(runnerHome(), 'bin', 'akb', 'akb'))
    await stop(dsh.child)
  })

  it('leaves a job session alone', async () => {
    const shim = path.join(runnerHome(), 'bin', 'akb', 'akb')
    fs.rmSync(path.dirname(shim), { recursive: true, force: true })
    const job = component('codex', undefined, { WILDCRANE_JOB: 'job_1' })
    await job.ready
    assert.equal(fs.existsSync(shim), false)
    assert.equal(instructionsOf(job.answers), undefined)
    await stop(job.child)
  })

  const hook = path.join(process.env.RUNNER_DIST!, '..', '..', 'plugins', 'claude-code', 'hooks', 'session.mjs')
  const session = (env: Record<string, string | undefined>) =>
    spawnSync(process.execPath, [hook], { input: '{"session_id":"s1"}', encoding: 'utf8', env: { ...process.env, WILDCRANE_JOB: '', ...env } })

  it('puts a home with a space and a quote first on the PATH through the env file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcrane-hook-'))
    const home = path.join(dir, "it's a home")
    const shims = path.join(home, 'bin', 'akb')
    fs.mkdirSync(shims, { recursive: true })
    fs.writeFileSync(path.join(shims, 'akb'), '#!/bin/sh\n', { mode: 0o755 })
    const env = path.join(dir, 'env')
    assert.match(session({ WILDCRANE_HOME: home, CLAUDE_ENV_FILE: env }).stdout, /s1/)
    const found = spawnSync('/bin/sh', ['-c', `. '${env}'; command -v akb; echo "$AI4KANBAN_COMMAND"`], { encoding: 'utf8' })
    assert.deepEqual(found.stdout.trim().split('\n'), [path.join(shims, 'akb'), 'akb'])
  })

  it('skips with no env file, an unwritable one, and in a job', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcrane-hook-'))
    const env = path.join(dir, 'env')
    assert.match(session({ CLAUDE_ENV_FILE: undefined }).stdout, /s1/)
    const stuck = session({ CLAUDE_ENV_FILE: path.join(dir, 'missing', 'env') })
    assert.equal(stuck.status, 0)
    assert.match(stuck.stdout, /s1/)
    session({ CLAUDE_ENV_FILE: env, WILDCRANE_JOB: 'job_1' })
    assert.equal(fs.existsSync(env), false)
  })
})

describe('the plugin component', () => {
  it('reports an existing Runner to the host without retrying after it exits', async () => {
    useRunnerHome()
    fs.rmSync(runnerHome(), { recursive: true, force: true })
    writeFakeSession(runnerHome())
    const cloud = new FakeCloud()
    await cloud.start()
    const release = await acquireMachine('terminal')
    const plugin = component('codex', `http://127.0.0.1:${cloud.port}`, { PATH: '' })
    const status = async (id: number) => {
      plugin.send(id, 'tools/call', { name: 'wildcrane_status', arguments: { path: os.homedir() } })
      await until(() => plugin.answers.has(id), 10_000)
      const result = plugin.answers.get(id)!.result as { content: { text: string }[] }
      return JSON.parse(result.content[0]!.text) as { runner: string; next?: string }
    }
    try {
      await plugin.ready
      let reported = await status(10)
      for (let id = 11; id <= 30 && reported.runner !== 'already-running'; id++) {
        await new Promise(resolve => setTimeout(resolve, 50))
        reported = await status(id)
      }
      assert.equal(reported.runner, 'already-running')
      assert.match(reported.next ?? '', /A second instance cannot start/)
      await release()
      await new Promise(resolve => setTimeout(resolve, 1_200))
      assert.equal((await status(31)).runner, 'already-running')
      assert.equal(cloud.registrations, 0)
    } finally {
      const exited = new Promise(resolve => plugin.child.once('exit', resolve))
      plugin.child.stdin.end()
      await exited
      await release()
      await cloud.stop()
      fs.rmSync(runnerHome(), { recursive: true, force: true })
    }
  })

  it('两个插件竞争时复用设置服务，宿主退出后另一入口可以重开', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc324-hosts-'))
    const env = { WILDCRANE_HOME: home, PATH: '' }
    const a = component('claude-code', undefined, env), b = component('codex', undefined, env)
    const open = async (plugin: ReturnType<typeof component>, id: number) => {
      await plugin.ready
      plugin.send(id, 'tools/call', { name: 'wildcrane_open_settings', arguments: { path: '/project' } })
      await until(() => plugin.answers.has(id))
      const result = plugin.answers.get(id)!.result as { content: { text: string }[] }
      return JSON.parse(result.content[0]!.text) as { url: string; opened: boolean }
    }
    const stop = async (plugin: ReturnType<typeof component>) => {
      if (plugin.child.exitCode !== null) return
      const ended = new Promise((resolve) => plugin.child.once('exit', resolve)); plugin.child.stdin.end(); await ended
    }
    try {
      const [first, second] = await Promise.all([open(a, 20), open(b, 20)])
      assert.equal(new URL(first.url).origin, new URL(second.url).origin)
      assert.equal(first.opened, false)
      const record = JSON.parse(fs.readFileSync(path.join(home, 'settings-page.json'), 'utf8')) as { pid: number }
      const [owner, standby] = record.pid === a.child.pid ? [a, b] : [b, a]
      await stop(owner)
      await assert.rejects(() => fetch(first.url))
      const reopened = await open(standby, 21)
      assert.equal((await fetch(reopened.url)).status, 200)
      assert.notEqual(new URL(reopened.url).origin, new URL(first.url).origin)
    } finally { await stop(a); await stop(b); fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('answers MCP on stdout, keeps the panel tool behind its key, and ends with its host', async () => {
    const { child, answers, send, ready } = component('claude-code')
    await ready
    send(2, 'tools/list', {})
    send(3, 'tools/call', { name: 'wildcrane_panel', arguments: { key: 'guess', action: 'state' } })
    await until(() => answers.has(2) && answers.has(3))
    const tools = (answers.get(2)!.result as { tools: { name: string }[] }).tools.map((t) => t.name)
    assert.deepEqual(tools, ['wildcrane_open_settings', 'wildcrane_draft_read', 'wildcrane_draft_save', 'wildcrane_panel'])
    assert.equal((answers.get(3)!.result as { isError: boolean }).isError, true)
    const exited = new Promise<number | null>((r) => child.on('exit', r))
    child.stdin.end()
    assert.equal(await exited, 0)
  })

  it('gives Codex its own tools, no panel and no start, and asks it to sign in first', async () => {
    const { child, answers, send, ready } = component('codex')
    await ready
    send(2, 'tools/list', {})
    send(3, 'tools/call', { name: 'wildcrane_draft_read', arguments: { path: process.cwd() }, _meta: { threadId: 'thread-1' } })
    await until(() => answers.has(2) && answers.has(3))
    const tools = (answers.get(2)!.result as { tools: { name: string }[] }).tools.map((t) => t.name)
    assert.deepEqual(tools, ['wildcrane_open_settings', 'wildcrane_draft_read', 'wildcrane_draft_save', 'wildcrane_status', 'wildcrane_sign_in', 'wildcrane_add_folder'])
    const read = answers.get(3)!.result as { isError: boolean; content: { text: string }[] }
    assert.equal(read.isError, true)
    assert.equal(JSON.parse(read.content[0]!.text).error, 'signed_out')
    const exited = new Promise<number | null>((r) => child.on('exit', r))
    child.stdin.end()
    assert.equal(await exited, 0)
  })

  it('binds the folder to an existing project, and refuses one already holding another', async () => {
    useRunnerHome()
    fs.rmSync(runnerHome(), { recursive: true, force: true })
    writeFakeSession(runnerHome())
    const cloud = new FakeCloud()
    await cloud.start()
    cloud.others = [{ project: 'prj_docs', name: '帮助文档', workspace: 'ws_team', workspace_name: 'Northwind', personal: false }]
    const site = fs.mkdtempSync(path.join(os.homedir(), '.wildcrane-test-site-'))
    const docs = fs.mkdtempSync(path.join(os.homedir(), '.wildcrane-test-docs-'))
    const { child, answers, send, ready } = component('claude-code', `http://127.0.0.1:${cloud.port}`)
    let id = 10
    const panel = async (args: Record<string, unknown>) => {
      const n = id++
      const key = fs.readFileSync(path.join(runnerHome(), 'plugin', 'panel.key'), 'utf8').trim()
      send(n, 'tools/call', { name: 'wildcrane_panel', arguments: { key, ...args } })
      await until(() => answers.has(n), 10_000)
      return JSON.parse((answers.get(n)!.result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>
    }
    try {
      await ready
      const before = await panel({ action: 'state', cwd: docs })
      assert.deepEqual(before.elsewhere, [{ project: 'prj_docs', name: '帮助文档', workspace_name: 'Northwind', personal: false, board: `${before.web}/projects/prj_docs` }])

      assert.equal((await panel({ action: 'addFolder', cwd: site })).added, true)
      const siteName = path.basename(fs.realpathSync(site))
      assert.deepEqual(await panel({ action: 'addFolder', cwd: site, project: 'prj_docs' }), { error: 'folder_taken', message: 'taken', name: siteName })

      const legacy = path.join(docs, '.agents/skills/kanban')
      fs.mkdirSync(legacy, { recursive: true })
      fs.writeFileSync(path.join(legacy, 'SKILL.md'), '<!-- ai4kanban 0.1.0 -->')
      const bound = await panel({ action: 'addFolder', cwd: docs, project: 'prj_docs' })
      assert.equal(bound.project, 'prj_docs')
      for (const dir of [site, docs]) for (const folder of ['.claude', '.agents']) {
        assert.equal(fs.existsSync(path.join(dir, folder, 'skills/kanban')), false)
      }
      assert.equal((await panel({ action: 'addFolder', cwd: docs, project: 'prj_docs' })).project, 'prj_docs')
      assert.equal(fs.existsSync(legacy), false)
      const after = await panel({ action: 'state', cwd: docs })
      assert.equal((after.folder as { project: string }).project, 'prj_docs')
      assert.deepEqual(after.elsewhere, [])
    } finally {
      const exited = new Promise((r) => child.on('exit', r))
      child.stdin.end()
      await exited
      await cloud.stop()
      fs.rmSync(site, { recursive: true, force: true })
      fs.rmSync(docs, { recursive: true, force: true })
    }
  })

  it('adds a typed folder, refuses one already added, and unbinds one no job holds', async () => {
    useRunnerHome()
    fs.rmSync(runnerHome(), { recursive: true, force: true })
    writeFakeSession(runnerHome())
    const cloud = new FakeCloud()
    await cloud.start()
    cloud.others = [{ project: 'prj_docs', name: '帮助文档', workspace: 'ws_team', workspace_name: 'Northwind', personal: false }]
    const site = fs.mkdtempSync(path.join(os.homedir(), '.wildcrane-test-site-'))
    const docs = fs.mkdtempSync(path.join(os.homedir(), '.wildcrane-test-docs-'))
    const { child, answers, send, ready } = component('claude-code', `http://127.0.0.1:${cloud.port}`)
    let id = 10
    const panel = async (args: Record<string, unknown>) => {
      const n = id++
      const key = fs.readFileSync(path.join(runnerHome(), 'plugin', 'panel.key'), 'utf8').trim()
      send(n, 'tools/call', { name: 'wildcrane_panel', arguments: { key, cwd: site, ...args } })
      await until(() => answers.has(n), 10_000)
      return JSON.parse((answers.get(n)!.result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>
    }
    try {
      await ready
      assert.equal((await panel({ action: 'addFolder', path: `~/${path.basename(site)}` })).added, true)
      assert.equal((await panel({ action: 'addFolder', path: site })).error, 'folder_taken')
      assert.equal((await panel({ action: 'addFolder', path: '~' })).error, 'home')
      assert.equal((await panel({ action: 'addFolder', path: path.join(site, 'nowhere') })).error, 'missing')
      assert.equal((await panel({ action: 'addFolder', path: docs, project: 'prj_docs' })).project, 'prj_docs')
      const added = await panel({ action: 'state' })
      assert.equal((added.projects as unknown[]).length, 2)
      assert.deepEqual(added.elsewhere, [])

      markUnsent(fs.realpathSync(docs), true)
      assert.deepEqual(await panel({ action: 'removeFolder', project: 'prj_docs' }), { error: 'busy' })
      assert.equal(((await panel({ action: 'state' })).projects as { busy: boolean }[]).find((p) => p.busy) !== undefined, true)
      markUnsent(fs.realpathSync(docs), false)

      const removed = await panel({ action: 'removeFolder', project: 'prj_docs' })
      assert.deepEqual((removed.projects as { project: string }[]).map((p) => p.project), [(removed.folder as { project: string }).project])
      assert.deepEqual((removed.elsewhere as { project: string }[]).map((p) => p.project), ['prj_docs'])
      assert.ok(fs.existsSync(docs))
    } finally {
      const exited = new Promise((r) => child.on('exit', r))
      child.stdin.end()
      await exited
      await cloud.stop()
      fs.rmSync(site, { recursive: true, force: true })
      fs.rmSync(docs, { recursive: true, force: true })
    }
  })

  it("names the account, reads a session's discussion for the model, and signs out", async () => {
    useRunnerHome()
    fs.rmSync(runnerHome(), { recursive: true, force: true })
    writeFakeSession(runnerHome())
    const held = JSON.parse(fs.readFileSync(path.join(runnerHome(), 'session.json'), 'utf8'))
    fs.writeFileSync(path.join(runnerHome(), 'session.json'), JSON.stringify({ ...held, name: 'Lin Chen', email: 'lin@acme.dev' }))
    const cloud = new FakeCloud()
    await cloud.start()
    const { child, answers, send, ready } = component('claude-code', `http://127.0.0.1:${cloud.port}`)
    let id = 10
    const call = async (name: string, args: Record<string, unknown>) => {
      const n = id++
      send(n, 'tools/call', { name, arguments: args })
      await until(() => answers.has(n), 10_000)
      return JSON.parse((answers.get(n)!.result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>
    }
    const panel = (args: Record<string, unknown>) =>
      call('wildcrane_panel', { key: fs.readFileSync(path.join(runnerHome(), 'plugin', 'panel.key'), 'utf8').trim(), cwd: os.homedir(), ...args })
    try {
      await ready
      assert.deepEqual((await panel({ action: 'state' })).account, { name: 'Lin Chen', email: 'lin@acme.dev' })

      const read = await call('wildcrane_draft_read', { sessionId: 'sess-1' })
      assert.equal(read.discussion, 'dsc_1')
      assert.equal((await call('wildcrane_draft_read', { sessionId: 'sess-1' })).discussion, 'dsc_1')
      assert.deepEqual(read.goals, [])
      assert.equal(Object.hasOwn(read, 'ideas'), false)
      assert.equal((read.studios as { when: string }[])[0]!.when, 'Software changes.')
      assert.match(String(read.url), /discussions\/dsc_1$/)
      assert.equal(cloud.discussions.length, 1)

      const review_plan = { rule: 'Approve the design before implementation.', previews: ['ui-design'] }
      const goals = [{ title: '目标', outcome: '结果', acceptance: ['验收'], studio: 'wf_builtin_coding', review_plan }]
      const saved = await call('wildcrane_draft_save', { discussionId: 'dsc_1', expectedVersion: 1, goals })
      assert.equal(saved.saved, true)
      assert.equal(Object.hasOwn(saved, 'ideas'), false)
      assert.match(String((saved.goals as { url: string }[])[0].url), /discussions\/dsc_1$/)
      assert.deepEqual(cloud.draftBodies[0].goals, goals)
      const reopened = await call('wildcrane_draft_read', { sessionId: 'sess-1' })
      assert.deepEqual((reopened.goals as { review_plan: unknown }[])[0]?.review_plan, review_plan)
      const invalid = id++
      send(invalid, 'tools/call', { name: 'wildcrane_draft_save', arguments: { discussionId: 'dsc_1', expectedVersion: 2, ideas: goals } })
      await until(() => answers.has(invalid), 10_000)
      const refusal = answers.get(invalid)!.result as { isError: boolean; content: { text: string }[] }
      assert.equal(refusal.isError, true)
      assert.match(refusal.content[0]!.text, /goals/)
      assert.equal(cloud.draftWrites, 1)
      const conflict = await call('wildcrane_draft_save', { discussionId: 'dsc_1', expectedVersion: 1, goals })
      assert.equal(conflict.saved, false)
      assert.equal(conflict.reason, 'The goals have changed. Merge your changes with the latest goals and save again.')
      assert.equal(cloud.draftWrites, 1)
      assert.deepEqual(conflict.goals, saved.goals)
      assert.equal(conflict.version, 2)
      assert.equal(Object.hasOwn(conflict, 'ideas'), false)
      await call('wildcrane_draft_read', { sessionId: 'sess-1' })
      const current = await call('wildcrane_draft_save', { discussionId: 'dsc_1', expectedVersion: 2, goals })
      assert.equal(current.saved, true)
      assert.deepEqual(cloud.draftBodies.at(-1)?.goals, goals)
      assert.equal(cloud.log.some((line) => /\/ideas\/.*\/start|\/goals\/.*\/start/.test(line)), false, '保存不得开始任务')

      // This computer's tasks (#18): read from Cloud, stopped by the route each names.
      const since = new Date(Date.now() - 12 * 60_000 - 5_000).toISOString()
      cloud.machineTasks = [
        { task: 'task_1', key: 'AKB-1', title: 'Fix sign-in', project: 'ai4kanban', runtime: 'claude-code', state: 'running', since, stop: 'task' },
        { task: 'task_2', key: null, title: 'Release notes', project: null, runtime: 'codex', state: 'queued', since, stop: null },
      ]
      const listed = (await panel({ action: 'tasks' })).tasks as Record<string, unknown>[]
      assert.deepEqual(listed.map((t) => [t.title, t.project, t.agent, t.state, t.minutes, t.stop]), [
        ['Fix sign-in', 'ai4kanban', 'Claude Code', 'running', 12, 'task'],
        ['Release notes', '', 'Codex', 'queued', 12, null],
      ])
      assert.match(String(listed[0]!.url), /\/tasks\/AKB-1$/)
      assert.match(String(listed[1]!.url), /\/tasks\/task_2$/)
      assert.deepEqual(await panel({ action: 'stopTask', task: 'task_1', stop: 'task' }), { stopped: true })
      assert.deepEqual(await panel({ action: 'stopTask', task: 'task_3', stop: 'chat' }), { stopped: true })
      assert.deepEqual(cloud.stops, ['stop task_1', 'chat/stop task_3'])
      assert.equal((await panel({ action: 'stopTask', task: 'refused', stop: 'task' })).error, 'forbidden')

      const out = await panel({ action: 'signOut' })
      assert.equal(out.signedIn, false)
      assert.equal(out.runner, 'off')
      assert.equal(fs.existsSync(path.join(runnerHome(), 'session.json')), false)
      assert.equal((await call('wildcrane_draft_read', { sessionId: 'sess-1' })).error, 'signed_out')
    } finally {
      const exited = new Promise((r) => child.on('exit', r))
      child.stdin.end()
      await exited
      await cloud.stop()
    }
  })

  it('tells both hosts to restart once Cloud refuses their Runner as outdated', async () => {
    useRunnerHome()
    fs.rmSync(runnerHome(), { recursive: true, force: true })
    writeFakeSession(runnerHome())
    const cloud = new FakeCloud()
    cloud.minProtocol = 99
    await cloud.start()
    const children: ReturnType<typeof component>['child'][] = []
    const status = async (as: 'claude-code' | 'codex') => {
      const { child, answers, send, ready } = component(as, `http://127.0.0.1:${cloud.port}`)
      children.push(child)
      await ready
      for (let n = 10; ; n++) {
        if (as === 'codex') send(n, 'tools/call', { name: 'wildcrane_status', arguments: { path: os.homedir() } })
        else {
          const key = fs.readFileSync(path.join(runnerHome(), 'plugin', 'panel.key'), 'utf8').trim()
          send(n, 'tools/call', { name: 'wildcrane_panel', arguments: { key, action: 'state', cwd: os.homedir() } })
        }
        await until(() => answers.has(n), 10_000)
        const now = JSON.parse((answers.get(n)!.result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>
        if (now.runner === 'outdated') return now
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    try {
      const panel = await status('claude-code')
      assert.match(String(panel.next), /restart Claude Code/)
      const own = JSON.parse(fs.readFileSync(path.join(process.env.RUNNER_DIST!, '..', '..', 'plugins', 'claude-code', '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string }
      assert.deepEqual(panel.plugin, { version: own.version, latest: null })
      children[0]!.stdin.end()
      await new Promise((r) => children[0]!.on('exit', r))
      const codex = await status('codex')
      assert.match(String(codex.next), /restart Codex/)
      const ownCodex = JSON.parse(fs.readFileSync(path.join(process.env.RUNNER_DIST!, '..', '..', 'plugins', 'codex', 'plugin.json'), 'utf8')) as { version: string }
      assert.deepEqual(codex.plugin, { version: ownCodex.version, latest: null, source: null })
    } finally {
      for (const child of children) {
        if (child.exitCode !== null) continue
        const exited = new Promise((r) => child.on('exit', r))
        child.stdin.end()
        await exited
      }
      await cloud.stop()
    }
  })

  it('binds OpenCode discussions to real sessions across reconnects (#676)', async () => {
    useRunnerHome()
    fs.rmSync(runnerHome(), { recursive: true, force: true })
    writeFakeSession(runnerHome())
    const cloud = new FakeCloud()
    await cloud.start()
    const children: ReturnType<typeof component>[] = []
    const start = async () => {
      const c = component('opencode', `http://127.0.0.1:${cloud.port}`)
      children.push(c)
      await c.ready
      let id = 10
      return async (thread?: string) => {
        const n = id++
        c.send(n, 'tools/call', { name: 'wildcrane_draft_read', arguments: { path: os.homedir() },
          ...(thread ? { _meta: { threadId: thread } } : {}) })
        await until(() => c.answers.has(n), 10_000)
        return c.answers.get(n)!
      }
    }
    const draft = (answer: Record<string, unknown>) => JSON.parse((answer.result as { content: { text: string }[] }).content[0]!.text).discussion
    try {
      const read = await start()
      assert.equal(((await read()).result as { isError: boolean }).isError, true)
      const [a, b] = await Promise.all([read('ses-a'), read('ses-b')])
      assert.notEqual(draft(a), draft(b))
      assert.equal(draft(await read('ses-a')), draft(a))
      const reconnect = await start()
      assert.equal(draft(await reconnect('ses-a')), draft(a))
      assert.equal(cloud.discussions.length, 2)
    } finally {
      for (const { child } of children) {
        const exited = new Promise((r) => child.on('exit', r))
        child.stdin.end()
        await exited
      }
      await cloud.stop()
    }
  })

  it('keeps web discussions on their draft and lets independent Codex sessions open one (#982)', async () => {
    useRunnerHome()
    fs.rmSync(runnerHome(), { recursive: true, force: true })
    writeFakeSession(runnerHome())
    const cloud = new FakeCloud()
    await cloud.start()
    const url = `http://127.0.0.1:${cloud.port}`
    const web = component('codex', url, { WILDCRANE_JOB: '1' })
    const local = component('codex', url, { WILDCRANE_JOB: '' })
    const call = async (client: typeof web, id: number, name: string, args: Record<string, unknown>) => {
      await client.ready
      client.send(id, 'tools/call', { name, arguments: args, _meta: { threadId: 'test-codex-thread' } })
      await until(() => client.answers.has(id))
      const result = client.answers.get(id)!.result as { isError?: boolean; content: { text: string }[] }
      return { ...JSON.parse(result.content[0]!.text), isError: result.isError }
    }
    try {
      const read = await call(web, 2, 'wildcrane_draft_read', { path: os.homedir() })
      assert.equal(read.isError, true)
      assert.match(read.message, /akb goal/)
      assert.equal(cloud.discussions.length, 0)

      const draft = await call(local, 2, 'wildcrane_draft_read', { path: os.homedir() })
      assert.equal(cloud.discussions.length, 1)
      assert.equal((await call(local, 3, 'wildcrane_draft_read', { path: os.homedir() })).discussion, draft.discussion)
      const save = await call(web, 3, 'wildcrane_draft_save', { discussionId: draft.discussion, expectedVersion: draft.version, goals: [] })
      assert.equal(save.isError, true)
      assert.match(save.message, /akb goal/)
      assert.equal((await call(local, 4, 'wildcrane_draft_read', { discussionId: draft.discussion })).version, draft.version)
      assert.equal(cloud.discussions.length, 1)
    } finally {
      await Promise.all([web, local].map(({ child }) => new Promise(resolve => { child.once('exit', resolve); child.stdin.end() })))
      await cloud.stop()
    }
  })

  for (const sharedHost of ['dsh', 'grok', 'antigravity'] as const) it(`opens a new discussion for each ${sharedHost} chat and keeps it by id`, async () => {
    useRunnerHome()
    fs.rmSync(runnerHome(), { recursive: true, force: true })
    writeFakeSession(runnerHome())
    const cloud = new FakeCloud()
    await cloud.start()
    const { child, answers, send, ready } = component(sharedHost, `http://127.0.0.1:${cloud.port}`)
    let id = 10
    const read = async (args: Record<string, unknown>) => {
      const n = id++
      send(n, 'tools/call', { name: 'wildcrane_draft_read', arguments: args })
      await until(() => answers.has(n), 10_000)
      return JSON.parse((answers.get(n)!.result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>
    }
    try {
      await ready
      const first = await read({ path: os.homedir() })
      assert.equal((await read({ path: os.homedir(), discussionId: first.discussion })).discussion, first.discussion)
      assert.notEqual((await read({ path: os.homedir() })).discussion, first.discussion)
      assert.equal(cloud.discussions.length, 2)
      assert.equal(first.akb, path.join(runnerHome(), 'bin', 'akb', 'akb'))
    } finally {
      const exited = new Promise((r) => child.on('exit', r))
      child.stdin.end()
      await exited
      await cloud.stop()
    }
  })

  it('lets Codex bind the folder to an existing project', async () => {
    useRunnerHome()
    fs.rmSync(runnerHome(), { recursive: true, force: true })
    writeFakeSession(runnerHome())
    const cloud = new FakeCloud()
    await cloud.start()
    cloud.others = [{ project: 'prj_docs', name: '帮助文档', workspace: 'ws_team', workspace_name: 'Northwind', personal: false }]
    const docs = fs.mkdtempSync(path.join(os.homedir(), '.wildcrane-test-docs-'))
    const { child, answers, send, ready } = component('codex', `http://127.0.0.1:${cloud.port}`)
    let id = 10
    const call = async (name: string, args: Record<string, unknown>) => {
      const n = id++
      send(n, 'tools/call', { name, arguments: args })
      await until(() => answers.has(n), 10_000)
      return JSON.parse((answers.get(n)!.result as { content: { text: string }[] }).content[0]!.text) as Record<string, unknown>
    }
    try {
      await ready
      const before = await call('wildcrane_status', { path: docs })
      assert.deepEqual(before.elsewhere, [{ project: 'prj_docs', name: '帮助文档', workspace_name: 'Northwind', personal: false, board: `${before.web}/projects/prj_docs` }])
      assert.equal((await call('wildcrane_add_folder', { path: docs, project: 'prj_docs' })).project, 'prj_docs')
      const after = await call('wildcrane_status', { path: docs })
      assert.equal((after.folder as { project: string }).project, 'prj_docs')
    } finally {
      const exited = new Promise((r) => child.on('exit', r))
      child.stdin.end()
      await exited
      await cloud.stop()
      fs.rmSync(docs, { recursive: true, force: true })
    }
  })
})
