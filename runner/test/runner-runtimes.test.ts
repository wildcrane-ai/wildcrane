import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import * as api from '../src/api'
import type { RuntimeReport } from '../src/api'
import { readCheckpoint } from '../src/recovery'
import { keepPresence } from '../src/presence'
import { runnerHome } from '../src/home'
import { createAcpClient, createStreamRenderer } from '../../cli/src/lib/agent/wire'
import { HARNESSES } from '../../cli/src/lib/agent/harnesses'
import { SYSTEM_LANGUAGE_EN, SYSTEM_LANGUAGE_ZH } from '../../cli/src/lib/agent/language'
import { akbEnv } from '../src/akb'
import { FILE_BYTES, diffOf } from '../src/diff'
import { acpModels, claudeModels, codexModels, opencodeModels, plan } from '../src/runtimes'
import { until, type FakeJob } from './fake-cloud'
import { ACP_AGENT, installed, cloud, runner, clearRunner, setInstalled, planned, MACHINE, fakeAkb, fakeRuntime, gatedScript, acpRuntime, start, disconnect } from './runner-harness'

describe('connection tests (#2074)', () => {
  const test = async (id: string, script: string, extra: Partial<FakeJob> = {}, testMs = 2_000) => {
    const job = cloud.dispatch({ id, test: true, runtime: 'claude-code', model: 'haiku', prompt: 'Reply with OK.', ...extra })
    if (!runner) start(script, { testMs })
    await until(() => job.state === 'finished')
    return job
  }

  it('names a connector that is missing or signed out, without starting it', async () => {
    setInstalled([{ name: 'codex', installed: false }, { name: 'claude-code', installed: true, loggedIn: false }])
    assert.equal((await test('t1', 'console.log("OK")', { runtime: 'codex' })).reason, 'not_installed')
    assert.equal((await test('t2', 'console.log("OK")')).reason, 'signed_out')
    assert.equal(planned.length, 0)
  })

  it('stops one that answers too late', async () => {
    const job = await test('t1', 'setTimeout(() => {}, 10_000)', {}, 200)
    assert.deepEqual([job.outcome, job.reason], ['failed', 'timeout'])
  })

  it('retries a connection test result after a network failure without rerunning the connector', async () => {
    const job = cloud.dispatch({ id: 't1', test: true, runtime: 'codex', model: 'gpt-test', prompt: 'Reply with OK.' })
    let attempts = 0
    start('console.log("OK")', {
      api: {
        ...api,
        finishJob: async (...args) => ++attempts === 1
          ? { ok: false, error: 'Network unavailable.' }
          : api.finishJob(...args),
      },
    })
    await until(() => job.state === 'finished')
    await until(() => readCheckpoint(job.id) === null)
    assert.equal(job.outcome, 'done')
    assert.equal(typeof job.report?.ms, 'number')
    assert.deepEqual(planned.map((p) => [p.runtime, p.model, p.prompt]), [['codex', 'gpt-test', 'Reply with OK.']])
    assert.equal(attempts, 2)
    assert.equal(planned.length, 1)
  })

  it('logs a refused test result without retrying or claiming it was accepted', async (t) => {
    const errors = t.mock.method(console, 'error', () => {})
    const job = cloud.dispatch({ id: 't1', test: true, runtime: 'codex', model: 'gpt-test', prompt: 'Reply with OK.' })
    let attempts = 0
    start('console.log("OK")', {
      api: {
        ...api,
        finishJob: async () => {
          attempts++
          return { ok: false, code: 'refused', error: 'Not accepted.' }
        },
      },
    })
    await until(() => errors.mock.calls.some(call => /connection test t1: Cloud did not accept/.test(String(call.arguments[0]))))
    assert.equal(attempts, 1)
    assert.equal(planned.length, 1)
    assert.equal(job.state, 'claimed')
    assert.ok(readCheckpoint(job.id))
  })

  it('tells Cloud what it found before the test ends, so the page reads it fresh (#2087)', async () => {
    setInstalled([{ name: 'codex', installed: false }, { name: 'claude-code', installed: true }])
    const job = await test('t1', 'console.log("OK")', { runtime: 'codex' })
    assert.equal(job.reason, 'not_installed')
    assert.deepEqual(cloud.runtimes, installed)
  })

  it('holds an ACP runtime\'s turn, and stops one that answers too late', async () => {
    setInstalled([{ name: 'cursor', installed: true }])
    const ok = cloud.dispatch({ id: 't1', test: true, runtime: 'cursor', prompt: 'Reply with OK.' })
    start('', { plan: acpRuntime() })
    await until(() => ok.state === 'finished')
    assert.equal(ok.outcome, 'done', ok.reason)
    await runner!.close()
    clearRunner()
    const late = cloud.dispatch({ id: 't2', test: true, runtime: 'cursor', prompt: 'Reply with OK.' })
    start('', { plan: acpRuntime({ ACP_HANG: '1' }), testMs: 200 })
    await until(() => late.state === 'finished')
    assert.deepEqual([late.outcome, late.reason], ['failed', 'timeout'])
  })

  it('reports what a failing connector said', async () => {
    const job = await test('t1', 'console.error("model haiku not found"); process.exit(1)')
    assert.equal(job.outcome, 'failed')
    assert.equal(job.reason, 'model haiku not found')
  })
})

describe('the real runtimes', () => {
  it('语言注入与子 CLI 环境清理保留代理', (t) => {
    const base = { ...process.env }
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete base[key]
    t.mock.method(HARNESSES.find(h => h.name === 'codex')!, 'env', () => ({ ...base, HTTPS_PROXY: 'http://proxy.example:8443' }))
    for (const language of ['zh', 'en', null] as const) {
      const p = plan('codex', '任务正文', os.tmpdir(), null, null, {}, false, language)
      const env = akbEnv(fakeAkb(), 'board', 'task', language, p.env)
      assert.equal(p.env.HTTPS_PROXY, 'http://proxy.example:8443')
      assert.equal(env.HTTPS_PROXY, p.env.HTTPS_PROXY)
      assert.equal(env.AI4KANBAN_LANGUAGE, language ?? '')
      assert.equal(env.AI4KANBAN_LANGUAGE_LINE, undefined)
      assert.ok(p.converse)
      assert.ok(!p.args.includes('任务正文'))
    }
  })

  it('lists the models Codex shows in its own picker (#2087)', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-')), 'models_cache.json')
    fs.writeFileSync(file, JSON.stringify({ models: [
      { slug: 'gpt-a', display_name: 'GPT-A', visibility: 'list' },
      { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' },
      { slug: 'gpt-b', visibility: 'list' },
    ] }))
    assert.deepEqual(codexModels(file), [{ id: 'gpt-a', name: 'GPT-A' }, { id: 'gpt-b', name: 'gpt-b' }])
    assert.deepEqual(codexModels(path.join(os.tmpdir(), 'no-such-cache.json')), [])
  })

  it("lists the main models of Claude Code's own picker (#85)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-catalog-'))
    const catalog = (surface: string, fetchedAt: number, models: unknown[]) => ({
      version: 2,
      fetchedAt,
      catalog: { surface, config: { models, provider_alias_targets: { opus: { default: 'claude-opus-5-5' }, fable: { default: 'claude-fable-5-1' } } } },
    })
    fs.writeFileSync(path.join(dir, 'a-cc.json'), JSON.stringify(catalog('cc', 2, [
      { id: 'claude-opus-5-5', name: 'Opus 5.5', short_name: 'Opus', section: 'main', runtime: { family: 'opus' } },
      { id: 'claude-fable-5-1', name: 'Fable 5.1', short_name: 'Fable', section: 'main', runtime: { family: 'fable' } },
      { id: 'claude-new-1', name: 'New 1', section: 'main' },
      { id: 'claude-opus-5', name: 'Opus 5', short_name: 'Opus', section: 'overflow', runtime: { family: 'opus' } },
    ])))
    fs.writeFileSync(path.join(dir, 'b-cc.json'), JSON.stringify(catalog('cc', 1, [{ id: 'claude-old', short_name: 'Old', section: 'main' }])))
    fs.writeFileSync(path.join(dir, 'c-ccd.json'), JSON.stringify(catalog('ccd', 3, [{ id: 'claude-desk', short_name: 'Desk', section: 'main' }])))
    fs.writeFileSync(path.join(dir, 'broken.json'), '{')
    assert.deepEqual(claudeModels(dir), [{ id: 'opus', name: 'Opus' }, { id: 'fable', name: 'Fable' }, { id: 'claude-new-1', name: 'New 1' }])
    assert.deepEqual(claudeModels(path.join(dir, 'missing')), [])
  })

  it('refreshes model lists in the background, keeping the sign-in (#86, #791)', async (t) => {
    const now = Date.now.bind(Date)
    let elapsed = 0
    t.mock.method(Date, 'now', () => now() + elapsed)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-'))
    const was = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
    try {
      setInstalled([{ name: 'claude-code', installed: true, loggedIn: true }, { name: 'cursor', installed: true, loggedIn: true, models: [{ id: 'c1', name: 'C1' }] }])
      start()
      const report = (name: string) => ((cloud.runtimes ?? []) as RuntimeReport[]).find((r) => r.name === name)
      const claude = () => report('claude-code')
      await until(() => claude()?.models?.[0]?.id === 'opus')
      fs.mkdirSync(path.join(dir, 'cache', 'model-catalog'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'cache', 'model-catalog', 'cc.json'), JSON.stringify({
        fetchedAt: 1,
        catalog: { surface: 'cc', config: { models: [{ id: 'claude-new-1', short_name: 'New', section: 'main' }] } },
      }))
      elapsed = 31_000
      await until(() => claude()?.models?.[0]?.id === 'claude-new-1')
      assert.equal(claude()!.loggedIn, true)
      assert.deepEqual(report('cursor')!.models, [{ id: 'c1', name: 'C1' }])
    } finally {
      if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = was
    }
  })

  it('lists the models OpenCode and Cursor offer (#2084)', () => {
    assert.deepEqual(opencodeModels('opencode/big-pickle\nanthropic/claude-opus-5\n\nWarning: x\n'), [
      { id: 'opencode/big-pickle', name: 'opencode/big-pickle' },
      { id: 'anthropic/claude-opus-5', name: 'anthropic/claude-opus-5' },
    ])
    assert.deepEqual(acpModels({ models: { availableModels: [
      { modelId: 'default[]', name: 'Auto' },
      { modelId: 'gpt-5.5[context=272k]', name: 'gpt-5.5' },
    ] } }), [{ id: 'gpt-5.5[context=272k]', name: 'gpt-5.5' }])
  })

  it('drives OpenCode and Cursor over ACP, with nothing after the subcommand', () => {
    for (const [runtime, command] of [['opencode', 'opencode'], ['cursor', 'cursor-agent']] as const) {
      const p = plan(runtime, 'Build it', os.tmpdir(), null, 'm1')
      assert.equal(p.command, command)
      assert.equal(p.args.at(-1), 'acp')
      assert.ok(p.converse && !p.renderer)
    }
  })

  it('picks the model the way each connector’s own setting does', () => {
    assert.ok(plan('claude-code', 'x', os.tmpdir(), null, 'haiku').args.join(' ').includes('--model haiku'))
    assert.ok(plan('codex', 'x', os.tmpdir(), null, 'gpt-5-codex').args.includes('model="gpt-5-codex"'))
    assert.ok(!plan('codex', 'x', os.tmpdir()).args.includes('--model'))
  })

  it('runs Kimi Code, DSH, ZCode and Grok Build the way the board does (#2135)', () => {
    const kimi = plan('kimi', 'Build it', os.tmpdir(), null, 'k2')
    assert.equal(kimi.command, 'kimi')
    assert.ok(kimi.renderer && !kimi.converse)
    for (const runtime of ['dsh', 'zcode', 'grok'] as const) assert.ok(plan(runtime, 'Build it', os.tmpdir()).converse, runtime)
  })

  it('turns a runtime\'s settings and key into arguments and environment, by its provider (#2135)', () => {
    const settings = { provider: 'endpoint', baseUrl: 'https://llm.acme.internal/v1', reasoning: 'high', args: '--search' }
    const p = plan('codex', 'x', os.tmpdir(), null, 'gpt-5.1-codex', { settings, secrets: { apiKey: 'sk-test' } })
    const args = p.args.join(' ')
    assert.match(args, /model_provider="?endpoint/)
    assert.match(args, /model_providers\.endpoint\.base_url=https:\/\/llm\.acme\.internal\/v1/)
    assert.match(args, /--model gpt-5\.1-codex/)
    assert.match(args, /--search/)
    assert.ok(!args.includes('sk-test'))
    assert.equal(p.env.OPENAI_API_KEY, 'sk-test')
    // The subscription takes neither the address nor the key.
    const sub = plan('codex', 'x', os.tmpdir(), null, null, { settings: { ...settings, provider: 'subscription' }, secrets: { apiKey: 'sk-test' } })
    assert.ok(!sub.args.join(' ').includes('llm.acme.internal'))
    assert.equal(sub.env.OPENAI_API_KEY, process.env.OPENAI_API_KEY)
  })

  it('reports what each connector takes, never how it reaches a run (#2135)', async () => {
    const { detectRuntimes } = await import('../src/runtimes')
    const found = await detectRuntimes(true)
    assert.deepEqual(found.map((r) => r.name), ['claude-code', 'codex', 'cursor', 'opencode', 'kimi', 'dsh', 'zcode', 'grok', 'antigravity'])
    const codex = found.find((r) => r.name === 'codex')!.settings!
    assert.ok(codex.some((s) => s.key === 'apiKey' && s.kind === 'secret'))
    assert.ok(codex.every((s) => !('env' in s) && !('flags' in s)))
    assert.ok(found.every((r) => r.settings?.some((s) => s.key === 'args')))
  })

  it('reports, signs in and spawns the newest copy, wherever it was installed (#131)', async () => {
    const { detectRuntimes } = await import('../src/runtimes')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-locate-'))
    const held = { PATH: process.env.PATH, HOME: process.env.HOME, NVM_DIR: process.env.NVM_DIR, AI4KANBAN_PATH_ONLY: process.env.AI4KANBAN_PATH_ONLY }
    const claude = path.join(home, '.nvm', 'versions', 'node', 'v24.0.0', 'bin', 'claude')
    fs.mkdirSync(path.dirname(claude), { recursive: true })
    fs.writeFileSync(claude, '#!/bin/sh\n[ "$1" = --version ] && echo "2.1.0 (Claude Code)"\n[ "$1" = auth ] && echo "{\\"loggedIn\\": false}"\nexit 0\n', { mode: 0o755 })
    Object.assign(process.env, { PATH: path.join(home, 'bin'), HOME: home })
    delete process.env.NVM_DIR
    delete process.env.AI4KANBAN_PATH_ONLY
    try {
      const report = (await detectRuntimes(true)).find((r) => r.name === 'claude-code')!
      assert.equal(report.installed, true)
      assert.equal(report.version, '2.1.0')
      assert.equal(report.loggedIn, false)
      const run = plan('claude-code', 'x', os.tmpdir())
      assert.equal(run.command, claude)
      assert.ok(run.env.PATH!.startsWith(path.dirname(claude)))
    } finally {
      for (const [key, value] of Object.entries(held)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps Codex connected and hands Claude Code its prompt on stdin', () => {
    const codex = plan('codex', 'Build it', os.tmpdir())
    assert.equal(path.basename(codex.command), 'codex')
    assert.equal(codex.args[0], 'app-server')
    assert.ok(codex.converse && !codex.renderer)
    assert.ok(!codex.args.includes('Build it'))
    const claude = plan('claude-code', 'Build it', os.tmpdir())
    assert.equal(path.basename(claude.command), 'claude')
    assert.ok(!claude.args.includes('Build it'))
    assert.match(claude.stdin!, /Build it/)
  })

  it("中英文语言仅注入系统提示词", () => {
    const zh = plan('claude-code', 'Build it', os.tmpdir(), null, null, {}, false, 'zh')
    assert.equal(zh.env.AI4KANBAN_LANGUAGE, 'zh')
    assert.equal(zh.env.AI4KANBAN_LANGUAGE_LINE, undefined)
    assert.equal(plan('claude-code', 'Build it', os.tmpdir()).env.AI4KANBAN_LANGUAGE, '')
    assert.equal(zh.args[0], '--append-system-prompt')
    assert.equal(zh.args[1], SYSTEM_LANGUAGE_ZH)
    assert.match(plan('dsh', 'Build it', os.tmpdir(), null, null, {}, false, 'zh').env.DSH_SYSTEM_PROMPT!, /用中文回复/)
    assert.equal(plan('claude-code', 'Build it', os.tmpdir(), null, null, {}, false, 'en').args[1], SYSTEM_LANGUAGE_EN)
  })

  it('Claude Code 快照续跑保留原会话并提示语言限制（#379）', () => {
    const p = plan('claude-code', '任务正文', os.tmpdir(), 'old-session', null, {}, false, 'en')
    assert.ok(p.args.includes('old-session'))
    assert.ok(!p.args.includes('--append-system-prompt'))
    assert.match(p.startNote!, /could not be updated/)
    const supported = plan('claude-code', '任务正文', os.tmpdir(), 'old-session', null, { settings: { args: '--system-prompt-snapshot off' } }, false, 'en')
    assert.equal(supported.args[1], SYSTEM_LANGUAGE_EN)
    assert.equal(supported.startNote, undefined)
  })

  it('Runner 续跑与子 CLI 只识别当前系统段落（#379）', () => {
    const saved = process.env.DSH_SYSTEM_PROMPT
    const old = '无论对话里的卡片、代码和贴进来的内容是什么语言，回复和写下的内容都用中文。代码、命令、文件名和字段名保持原文。'
    try {
      process.env.DSH_SYSTEM_PROMPT = `用户规则\n\n${old}`
      for (const language of ['zh', 'en', null] as const) {
        const p = plan('dsh', '任务正文', os.tmpdir(), 'old-session', null, {}, false, language)
        const expected = language === 'zh' ? SYSTEM_LANGUAGE_ZH : language === 'en' ? SYSTEM_LANGUAGE_EN : ''
        assert.equal(p.env.DSH_SYSTEM_PROMPT, ['用户规则', old, expected].filter(Boolean).join('\n\n'))
        const child = akbEnv(fakeAkb(), 'board', 'task', language, p.env)
        assert.equal(child.DSH_SYSTEM_PROMPT, p.env.DSH_SYSTEM_PROMPT)
        assert.equal(child.AI4KANBAN_LANGUAGE, language ?? '')
        assert.equal(p.stdin, undefined)
        assert.equal(p.startNote, undefined)
      }
    } finally {
      if (saved === undefined) delete process.env.DSH_SYSTEM_PROMPT
      else process.env.DSH_SYSTEM_PROMPT = saved
    }
  })
})

describe('runtime keys (#2135)', () => {
  it('keeps a key job\'s key here alone, reports only that it is set, and runs with it', async () => {
    const job = cloud.dispatch({ id: 'k1', test: true, secret: true, secrets: { apiKey: 'sk-test' }, runtime: 'codex', runtimeId: 'rt_1', prompt: 'Keep it.' })
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    const file = path.join(runnerHome(), 'secrets.json')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { rt_1: { apiKey: 'sk-test' } })
    assert.equal(planned.length, 0)
    await until(() => JSON.stringify(cloud.secrets) === JSON.stringify({ rt_1: ['apiKey'] }))

    const run = cloud.dispatch({ id: 'j1', runtime: 'codex', runtimeId: 'rt_1', settings: { provider: 'openai-api' }, prompt: 'go' })
    await until(() => run.state === 'finished')
    assert.deepEqual(planned.at(-1)!.settings, { settings: { provider: 'openai-api' }, secrets: { apiKey: 'sk-test' } })

    const clear = cloud.dispatch({ id: 'k2', test: true, secret: true, secrets: { apiKey: null }, runtime: 'codex', runtimeId: 'rt_1', prompt: 'Clear it.' })
    await until(() => clear.state === 'finished')
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {})
  })
})

describe('a landed commit\'s diff (#2109)', () => {
  let dir: string
  const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).stdout.trim()
  const commitAll = (message: string) => {
    git('add', '-A', '-f')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-diff-'))
    git('init', '-q')
    fs.writeFileSync(path.join(dir, 'old.txt'), 'one\ntwo\n')
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye\n')
    commitAll('first')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('reads each file against the first parent, leaving the board out', async () => {
    fs.writeFileSync(path.join(dir, 'old.txt'), 'one\n2\n')
    fs.rmSync(path.join(dir, 'gone.txt'))
    fs.writeFileSync(path.join(dir, 'new.txt'), 'hi\n')
    fs.writeFileSync(path.join(dir, 'pic.bin'), Buffer.from([0, 1, 2, 0]))
    fs.mkdirSync(path.join(dir, '.akb', 'kanban'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.akb', 'kanban', 'card.md'), 'card\n')
    const answer = await diffOf(dir, commitAll('second'))
    assert.ok(!('gone' in answer))
    assert.equal(answer.truncated, false)
    assert.deepEqual(answer.files.map(({ patch: _patch, ...f }) => f), [
      { path: 'gone.txt', status: 'deleted', added: 0, removed: 1 },
      { path: 'new.txt', status: 'added', added: 1, removed: 0 },
      { path: 'old.txt', status: 'modified', added: 1, removed: 1 },
      { path: 'pic.bin', status: 'added', added: 0, removed: 0, binary: true },
    ])
    assert.equal(answer.files[2]!.patch, '@@ -1,2 +1,2 @@\n one\n-two\n+2\n')
    assert.equal(answer.files[3]!.patch, undefined)
  })

  it('sends only the file list for a change past the limits', async () => {
    fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(FILE_BYTES))
    const answer = await diffOf(dir, commitAll('big'))
    assert.ok(!('gone' in answer))
    assert.equal(answer.truncated, true)
    assert.deepEqual(answer.files, [{ path: 'big.txt', status: 'added', added: 1, removed: 0 }])
  })

  it('answers gone for a commit this folder does not have', async () => {
    assert.deepEqual(await diffOf(dir, 'f'.repeat(40)), { gone: true })
    assert.deepEqual(await diffOf(null, git('rev-parse', 'HEAD')), { gone: true })
  })
})

describe('the presence connection (#2163)', () => {
  it('claims task chats and discussions from pushed reminders without idle polling (#760)', async (t) => {
    cloud.presence = true
    start('console.log("Reply")', {}, MACHINE, now => now + 3600_000, 60_000)
    await until(() => cloud.presences.some(p => p.socket) && cloud.jobReads > 0)
    const idle = cloud.jobReads
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(cloud.jobReads, idle, 'idle connections polled for jobs')
    const timings: number[] = []
    for (let i = 0; i < 20; i++) {
      const job = cloud.dispatch({ id: crypto.randomUUID(), ...(i % 2
        ? { discussion: { id: `d760_${i}`, workspace: 'ws_1', goals: [] } }
        : { chat: { message: `m760_${i}`, body: 'Reply' } }) })
      const began = performance.now()
      cloud.notifyJob(job.id)
      cloud.notifyJob(job.id)
      await until(() => job.state !== 'waiting')
      timings.push(performance.now() - began)
      await until(() => job.state === 'finished')
      assert.equal(job.claims, 1, 'duplicate notification executed a reply twice')
    }
    timings.sort((a, b) => a - b)
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1]!
    assert.ok(p95 < 2000, `p95 ${p95} exceeded 2 seconds`)
    t.diagnostic(JSON.stringify({ samples: timings.length, p95Ms: Math.round(p95), maxMs: Math.round(timings.at(-1)!), jobListRequests: cloud.jobReads - idle, idleRequests: 0 }))
  })

  it('opens once registered, with the token as a subprotocol, and closes with the Runner', async () => {
    cloud.presence = true
    const r = start()
    await until(() => cloud.presences.some((p) => p.socket))
    assert.equal(cloud.presences[0]!.protocol, 'bearer, t')
    assert.equal(cloud.presences[0]!.machine, MACHINE)
    await r.close()
    clearRunner()
    await until(() => cloud.presences[0]!.socket!.destroyed)
  })

  it('pings, and reconnects when the connection drops', async () => {
    cloud.presence = true
    const presence = keepPresence(MACHINE, 30)
    try {
      await until(() => (cloud.presences[0]?.pings ?? 0) >= 2)
      cloud.presences[0]!.socket!.destroy()
      await until(() => cloud.presences.length === 2 && cloud.presences[1]!.pings >= 1, 8_000)
    } finally {
      presence.close()
    }
  })

  it('keeps backing off when sockets open and close without a reply (#760)', async () => {
    cloud.presence = true
    const presence = keepPresence(MACHINE, 60_000)
    try {
      await until(() => !!cloud.presences[0]?.socket)
      cloud.presences[0]!.socket!.destroy()
      await until(() => !!cloud.presences[1]?.socket, 4_000)
      const began = performance.now()
      cloud.presences[1]!.socket!.destroy()
      await until(() => !!cloud.presences[2]?.socket, 4_000)
      assert.ok(performance.now() - began >= 1_500, 'an unanswered open reset reconnect backoff')
    } finally {
      presence.close()
    }
  })

  it('gives up quietly on a Cloud without it, and the Runner registers and runs jobs all the same', async () => {
    const job = cloud.dispatch({ id: 'j1' })
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done')
    const tried = cloud.presences.length
    assert.equal(tried, 1)
    await new Promise((r) => setTimeout(r, 1_500))
    assert.equal(cloud.presences.length, tried, 'it kept trying a route that is not there')
    assert.ok(cloud.registrations >= 2)
  })
})

it('启动前目录变化重新读取后再提交，关键事件不等普通 flush (#722)', async () => {
  const { readSession } = await import('../../cli/src/lib/cloud/session')
  const { clearStudioSnapshots } = await import('../src/goals')
  clearStudioSnapshots()
  const account = readSession()!.subject
  const job = cloud.dispatch({ id: 'catalog722', discussion: { id: 'd722', workspace: 'ws_1', goals: [] } })
  let version = 'v1'
  let reads = 0
  const proof = path.join(runnerHome(), 'catalog-proof')
  start('', {
    flushMs: 60_000,
    api: { ...api,
      claimJob: async (machine, id) => {
        const result = await api.claimJob(machine, id)
        if (result.ok && result.value.claimed) result.value.job.discussion!.catalog = { account, version }
        return result
      },
      listStudios: async () => { reads++; const current = version; version = 'v2'; return { ok: true, value: { data: [{ id: 'wf1', name: current }], next: null, catalogVersion: current } } },
      renewJob: async (machine, id, progress) => {
        const result = await api.renewJob(machine, id, progress)
        return result.ok ? { ok: true, value: { ...result.value, catalog: { account, version } } } : result
      },
    },
    plan: (runtime, prompt, cwd, resume, model) => {
      const client = createAcpClient()
      return { ...fakeRuntime(ACP_AGENT)(runtime, prompt, cwd, resume, model),
        converse: async (child, event) => {
          fs.writeFileSync(proof, fs.readFileSync(path.join(runnerHome(), 'goals', 'catalog722.json')))
          return client.turn({ stdout: child.stdout!, stdin: child.stdin!, prompt, cwd, log: () => {}, gotResumeId: () => {}, gotModel: () => {}, event })
        },
      }
    },
  })
  await until(() => job.state === 'finished')
  assert.equal(job.outcome, 'done', job.reason)
  assert.equal(reads, 2)
  assert.equal(JSON.parse(fs.readFileSync(proof, 'utf8')).studios[0].name, 'v2')
  assert.ok(job.events.some(event => event.kind === 'phase' && event.data?.phase === 'started'))
  clearStudioSnapshots()
})

it('首次内容在回复完成前立即推送，普通批次仍未到期 (#722)', async () => {
  const said = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Live content' }] } })
  const gated = gatedScript(`console.log(${JSON.stringify(said)})`)
  const job = cloud.dispatch({ id: 'live722', chat: { message: 'm722', body: 'Hello' } })
  start('', { flushMs: 60_000, plan: (runtime, prompt, cwd, resume) => ({ ...fakeRuntime(gated.script)(runtime, prompt, cwd, resume), renderer: createStreamRenderer() }) })
  await until(() => job.events.some(event => event.kind === 'message'), 2000)
  assert.equal(job.state, 'claimed', 'content waited until the final flush')
  const eventAt = job.events.find(event => event.kind === 'message')!.data!.eventAt
  assert.equal(typeof eventAt, 'string')
  gated.release()
  await until(() => job.state === 'finished')
})

it('旧尝试的进度拒绝迟到时不停止新的执行尝试 (#722)', async () => {
  const job = cloud.dispatch({ id: 'attempt722', chat: { message: 'm722', body: 'Hello' } })
  let attempts = 0
  let firstPending = false
  let secondStarted = false
  let oldReturned = false
  start('', {
    api: { ...api, renewJob: async (machine, id, progress) => {
      if (progress?.attempt === 1) {
        firstPending = true
        await until(() => secondStarted)
        oldReturned = true
        return { ok: true, value: { renewed: false } }
      }
      return api.renewJob(machine, id, progress)
    } },
    plan: (runtime, prompt, cwd, resume) => {
      const attempt = ++attempts
      return { ...fakeRuntime('setInterval(() => {}, 1000)')(runtime, prompt, cwd, resume),
        converse: async (_child, event) => {
          event({ kind: 'phase', data: { phase: 'preparing', at: new Date().toISOString() } })
          if (attempt === 1) { await until(() => firstPending); return { ok: false, error: disconnect.summary, failure: disconnect } }
          secondStarted = true
          await until(() => oldReturned)
          await new Promise(resolve => setImmediate(resolve))
          event({ kind: 'message', data: { text: 'Continued' } })
          return { ok: true, result: 'Continued' }
        },
      }
    },
  })
  await until(() => job.state === 'finished')
  assert.equal(job.outcome, 'done', job.reason)
  assert.equal(attempts, 2)
  assert.equal(job.claims, 1)
})
