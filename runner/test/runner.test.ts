import { numberOfCard } from '../../cli/src/lib/shared/board-files'
import { taskPreviewProblems } from '../../cli/src/lib/shared/task-preview-validation'
import { IDLE_TIMEOUT } from '../../cli/src/lib/agent/idle'
import { conflictList, conflictShow, pendingConflicts, withSyncLock } from '../../cli/src/lib/shared/board-conflicts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'

const withoutTime = (raw: Record<string, unknown> | undefined) => { const { eventAt, ...data } = raw ?? {}; assert.equal(typeof eventAt, 'string'); return data }

import * as api from '../src/api'
import type { RuntimeReport } from '../src/api'
import { readCheckpoint, saveCheckpoint } from '../src/recovery'
import { startRunner, type Runner } from '../src/connect'
import { holdMachine } from '../src/lock'
import { keepPresence } from '../src/presence'
import { runnerHome, useRunnerHome } from '../src/home'
import { mcpArgs, spentBy } from '../src/flow'
import { createAcpClient, createStreamRenderer, createCodexStreamRenderer } from '../../cli/src/lib/agent/wire'
import { createCodexClient } from '../../cli/src/lib/agent/wire/codex'
import { CLAUDE_REPLY } from '../../cli/test/claude-reply'
import { stopMark } from '../../cli/src/lib/agent/stop'
import { createAntigravityRenderer } from '../../cli/src/lib/agent/wire/antigravity'
import { readSession, writeSession } from '../../cli/src/lib/cloud/session'
import { HARNESSES } from '../../cli/src/lib/agent/harnesses'
import { SYSTEM_LANGUAGE_EN, SYSTEM_LANGUAGE_ZH } from '../../cli/src/lib/agent/language'
import { plan as runtimePlan } from '../src/runtimes'
import { toWire, type Deps } from '../src/jobs'
import { akbEnv, akbHome, runAkb } from '../src/akb'
import { readAkbState } from '../src/akb-version'
import { AKB_CONTRACT } from '../src/protocol'
import { agentDue, nextHour } from '../src/agents'
import { sharedMemory } from '../src/memory-files'
import { projectStateDir } from '../../cli/src/lib/machine/project'
import { NO_FOLDER, keptBoard, mergeFile, openTaskFolder, pull, pullChanges, push, pushBoard, readHead, withBoard, workspaceOf, taskStudioContext } from '../src/task-folder'
import { watchBoards } from '../src/board-watch'
import { hold, unsent } from '../src/cache'
import { FILE_BYTES, diffOf } from '../src/diff'
import { acpModels, claudeModels, codexModels, opencodeModels, plan, type Plan } from '../src/runtimes'
import { FakeCloud, until, writeFakeSession, type FakeJob } from './fake-cloud'

type FakeFlow = FakeJob['flow']

// The Runner against a stand-in Cloud, with a fake runtime: a node child that prints.

const MACHINE = '44444444-4444-4444-8444-444444444444'

let cloud: FakeCloud
let runner: Runner | null = null
const overload = { code: 'service_overloaded', level: 2, reason: 'Selected model is at capacity' } as const
const validation = { code: 'validation_failed', level: 1, reason: 'Schema check failed' } as const
const disconnect = { code: 'connection_lost', level: 2, reason: 'Temporary network failure' } as const

let planned: { runtime: string; prompt: string; cwd: string; resume?: string | null; model?: string | null; settings?: unknown; line?: 'zh' | 'en' | null }[] = []
let installed: RuntimeReport[] = []
const FAKE_AKB = path.join(process.env.RUNNER_DIST ?? '', '..', 'test', 'fake-akb.mjs')
const cached = (project = 'prj_1') => path.join(fs.realpathSync(runnerHome()), 'cache', project)
const fakeAkb = (version = '0.0.0-test') => ({ command: process.execPath, args: [FAKE_AKB], version, shim: path.join(runnerHome(), 'bin', 'akb', version, 'shim') })

function fakeRuntime(script: string) {
  return (runtime: string, prompt: string, cwd: string, resume?: string | null, model?: string | null, settings?: unknown, _fork?: boolean, line?: 'zh' | 'en' | null): Plan => {
    planned.push({ runtime, prompt, cwd, resume, model, settings, line })
    return {
      command: process.execPath,
      args: ['-e', script],
      env: process.env,
      renderer: { push: (s) => s, flush: () => '', result: () => 'Two tiers.', context: () => ({ used: 38_000, limit: 200_000 }) },
      quiet: () => false,
      session: () => resume ?? 'fresh-session',
    }
  }
}

// 用文件放行真实子进程，避免用固定时长猜测中间状态。
function gatedScript(before: string, after = '') {
  const gate = path.join(runnerHome(), 'runtime-gate')
  return {
    script: `${before}; const gateTimer = setInterval(() => {
      if (require('fs').existsSync(${JSON.stringify(gate)})) { clearInterval(gateTimer); ${after} }
    }, 10)`,
    release: () => fs.writeFileSync(gate, ''),
  }
}

// A node child that answers ACP: one plan, one tool call, one message per prompt.
const ACP_AGENT = `
const rl = require('node:readline').createInterface({ input: process.stdin })
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
const note = (update) => out({ method: 'session/update', params: { sessionId: 's1', update } })
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'session/load' && process.env.ACP_MISSING) return out({ id:m.id, error:{code:-32602,message:'Session not found'} })
  if (m.method === 'session/new' && process.env.ACP_NEW_FAIL) return out({ id:m.id, error:{code:-32603,message:'Cannot open conversation'} })
  if (m.method === 'session/new') return out({ id: m.id, result: { sessionId: 's1', models: { currentModelId: 'known-model' } } })
  if (m.method === 'session/prompt') {
    if (process.env.ACP_HANG) return
    if (process.env.ACP_HALF) return note({ sessionUpdate: 'agent_message_chunk', content: { text: 'Two ' } })
    note({ sessionUpdate: 'plan', entries: [{ content: 'Look', status: 'completed' }] })
    note({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read a.ts', kind: 'read', locations: [{ path: 'a.ts' }] })
    note({ sessionUpdate: 'agent_message_chunk', content: { text: 'Two ' } })
    note({ sessionUpdate: 'agent_message_chunk', content: { text: 'tiers.' } })
    note({ sessionUpdate: 'usage_update', used: 900, ...(process.env.ACP_NO_WINDOW ? {} : { size: 100000 }) })
    return out({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } } })
  }
  if (m.id !== undefined) out({ id: m.id, result: {} })
})`

function acpRuntime(env: NodeJS.ProcessEnv = {}, log = (_text: string) => {}) {
  return (runtime: string, prompt: string, cwd: string, resume?: string | null, model?: string | null): Plan => {
    planned.push({ runtime, prompt, cwd, resume, model })
    const client = createAcpClient()
    return {
      command: process.execPath,
      args: ['-e', ACP_AGENT],
      env: { ...process.env, ...env },
      converse: (child, event) => client.turn({
        stdout: child.stdout!, stdin: child.stdin!, prompt, cwd, resumeId: resume ?? undefined,
        log, gotResumeId: () => {}, gotModel: () => {}, event,
      }),
      quiet: () => false,
      session: () => resume ?? 's1',
    }
  }
}

function start(script = 'console.log("hello from the runtime")', over: Partial<Deps> = {}, machineId = MACHINE, nextLook = (now: number) => now + 100, interval = 100) {
  const deps: Deps = {
    machineId,
    api,
    plan: fakeRuntime(script),
    flushMs: 50,
    logPingMs: 60_000,
    endMs: 200,
    renewMs: 50,
    leaseMs: 60_000,
    retryMs: 50,
    replyBackoff: () => 0,
    testMs: 2_000,
    stopMs: 2_000,
    watchMs: null,
    akb: () => fakeAkb(),
    runtimes: async () => installed,
    ...over,
  }
  runner = startRunner({
    registration: async () => ({ machineId, machineName: 'studio', version: '0.0.0-test', runtimes: [] }),
    kind: 'terminal',
    deps,
    heartbeatMs: interval,
    pollMs: interval,
    nextLook,
  })
  return runner
}

beforeEach(async () => {
  useRunnerHome()
  fs.rmSync(runnerHome(), { recursive: true, force: true })
  writeFakeSession(runnerHome())
  // Fresh, so a chat job pulls no catalogue from the network.
  fs.writeFileSync(path.join(runnerHome(), 'models-dev.json'), JSON.stringify({ fetchedAt: Date.now(), limits: { 'opencode/known-model': 128_000 } }))
  planned = []
  installed = [{ name: 'codex', installed: true }, { name: 'claude-code', installed: true }]
  process.env.FAKE_AKB_LOG = path.join(runnerHome(), 'akb.log')
  process.env.FAKE_AKB = '{}'
  cloud = new FakeCloud()
  // Each project is linked to its folder under the Runner's home (#516).
  fs.mkdirSync(path.join(runnerHome(), 'cache'), { recursive: true })
  fs.writeFileSync(path.join(runnerHome(), 'projects.json'), JSON.stringify({ projects: [path.join(runnerHome(), 'cache')] }))
  cloud.folder = (project) => { fs.mkdirSync(cached(project), { recursive: true }); return cached(project) }
  cloud.others = ['prj_1', 'prj_2'].map((project) => ({ project, name: project, workspace: 'ws_1', workspace_name: 'Mine', personal: true }))
  await cloud.start()
})

afterEach(async () => {
  await runner?.close()
  runner = null
  await cloud.stop()
})

describe('the Runner', () => {
  for (const cancel of [false, true]) {
    it(`Codex 后台工作${cancel ? '可取消' : '完成后在原回复回传'} (#682)`, async () => {
      const gate = path.join(runnerHome(), 'background-done')
      const script = `
const out = m => console.log(JSON.stringify(m)); let starts = 0;
const note = (method, params) => out({ method, params: { threadId: 'main', ...params } });
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line); if (m.id === undefined) return;
 const answer = result => out({ id: m.id, result });
 if (m.method === 'initialize') return answer({});
 if (m.method === 'thread/start') return answer({ thread: { id: 'main' } });
 if (m.method === 'turn/start') {
  starts++; answer({ turn: { id: 't'+starts } });
  if (starts === 1) note('item/completed', { item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } } });
  if (m.params.outputSchema) throw Error('cleanup must use an ordinary turn');
  const text=starts===1?'STARTED':'FINISHED: Background result';
  note('item/completed', { item: { id: 'm'+starts, type: 'agentMessage', text } });
  note('turn/completed', { turn: { id: 't'+starts, status: 'completed', items: [] } }); return;
 }
 if (m.method === 'thread/read') {
  const timer = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(gate)})) {
   clearInterval(timer); answer({ thread: { status: { type: 'idle' }, turns: [{ status: 'completed', items: [{ type: 'agentMessage', text: 'Background result' }] }] } });
  } }, 10); return;
 }
 if (m.method === 'thread/backgroundTerminals/list') return answer({ data: [] });
 answer({});
});`
      const job = cloud.dispatch({ id: 'codex-background', runtime: 'codex' })
      start('', { plan: (...args) => {
        const p = fakeRuntime(script)(...args)
        const client = createCodexClient()
        return { ...p, renderer: undefined, converse: (child, event) => client.turn({
          stdout: child.stdout!, stdin: child.stdin!, cwd: args[2], prompt: args[1],
          log: () => {}, gotResumeId: () => {}, gotModel: () => {}, event,
        }) }
      } })
      await until(() => job.events.some(e => e.kind === 'message' && e.data?.text === 'STARTED')).catch(error => { throw Error(`${error}: ${JSON.stringify({ state: job.state, reason: job.reason, events: job.events })}`) })
      assert.equal(job.state, 'claimed')
      if (cancel) job.stop = true
      else fs.writeFileSync(gate, '')
      await until(() => job.state === 'finished').catch(error => { throw Error(`${error}: ${JSON.stringify({ state: job.state, reason: job.reason, events: job.events })}`) })
      assert.equal(job.outcome, 'done', job.reason)
      if (cancel) assert.equal(job.report?.stopped, true)
      if (!cancel) {
        assert.equal(job.report?.reply, 'FINISHED: Background result')
        assert.equal(job.events.filter(e => e.kind === 'message' && e.data?.text === 'FINISHED: Background result').length, 1)
        assert.equal((job.report?.subagents as api.Subagents | undefined)?.items[0]?.state, 'done')
        assert.equal(planned.length, 1)
      }
    })
  }

  for (const exit of [0, 7]) it(`delivers the result of a command completed during Codex cleanup (exit ${exit}, #757)`, async () => {
    const result = exit ? 'CHECK FAILED: exit 7; diagnostic saved' : 'CHECK PASSED: result 42'
    const script = `
const out=m=>console.log(JSON.stringify(m));let starts=0,running=true;
const note=(method,params)=>out({method,params:{threadId:'main',...params}});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;const answer=result=>out({id:m.id,result});
 if(m.method==='thread/start')return answer({thread:{id:'main'}});
 if(m.method==='thread/backgroundTerminals/list')return answer({data:running?[{itemId:'cmd',processId:'42',command:'check'}]:[]});
 if(m.method==='turn/start'){
  starts++;if(m.params.outputSchema)throw Error('unexpected receipt schema');answer({turn:{id:'t'+starts}});
  if(starts===1)note('item/started',{item:{id:'cmd',type:'commandExecution',processId:'42',command:'check',status:'inProgress'}});
  else {running=false;note('item/completed',{item:{id:'cmd',type:'commandExecution',processId:'42',command:'check',status:'completed',exitCode:${exit},aggregatedOutput:${JSON.stringify(result)}}});}
  note('item/completed',{item:{id:'reply'+starts,type:'agentMessage',phase:'final_answer',text:starts===1?'STARTED':${JSON.stringify(result)}}});
  return note('turn/completed',{turn:{id:'t'+starts,status:'completed',items:[]}});
 }
 answer({});
});`
    const job = cloud.dispatch({ id: 'cleanup-result', runtime: 'codex' })
    start('', { plan: (...args) => {
      const p = fakeRuntime(script)(...args)
      const client = createCodexClient()
      return { ...p, renderer: undefined, converse: (child, event) => client.turn({
        stdout: child.stdout!, stdin: child.stdin!, cwd: args[2], prompt: args[1],
        log: () => {}, gotResumeId: () => {}, gotModel: () => {}, event,
      }) }
    } })
    await until(() => job.state === 'finished')
    assert.equal(job.report?.reply, result, JSON.stringify(job))
    assert.equal(job.events.filter(e => e.kind === 'message' && e.data?.text === result).length, 1)
    assert.equal(job.outcome, exit ? 'failed' : 'done', job.reason)
    assert.equal(planned.length, 1)
  })

  it('Claude Code 首次回复后继续等待后台工作 (#682)', async () => {
    const gate = path.join(runnerHome(), 'claude-background-done')
    const script = `const out = e => console.log(JSON.stringify(e)); let read = false;
process.stdin.on('data', () => { if (read) return; read = true;
 out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg' }] });
 out({ type: 'assistant', message: { content: [{ type: 'text', text: 'STARTED' }] } });
 out({ type: 'result', result: 'STARTED' });
 const timer = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(gate)})) {
  clearInterval(timer); out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'FINISHED' }] } });
  out({ type: 'result', result: 'FINISHED' });
 } }, 10);
}); process.stdin.on('end', () => process.exit(0));`
    const job = cloud.dispatch({ id: 'claude-background', runtime: 'claude-code' })
    start('', { plan: (...args) => ({ ...fakeRuntime(script)(...args), stdin: 'start\n', renderer: createStreamRenderer() }) })
    await until(() => job.events.some(e => e.kind === 'message' && e.data?.text === 'STARTED'))
    assert.equal(job.state, 'claimed')
    fs.writeFileSync(gate, '')
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.report?.reply, 'FINISHED')
  })

  it('retries a temporary registration refusal instead of stopping the Runner', async () => {
    cloud.registrationUnavailable = 1
    const job = cloud.dispatch({ id: 'registration-retry' })
    let stopped = false
    start().stopped.then(() => { stopped = true })
    await until(() => job.state === 'finished')
    assert.equal(stopped, false)
    assert.equal(job.outcome, 'done')
  })

  it('stays alive during auth rate limiting and automatically resumes queued replies', async () => {
    writeSession({ ...readSession()!, expiresAt: Date.now() - 1 })
    const fetch = globalThis.fetch
    let refreshes = 0
    let allow = false
    let stopped = false
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('/auth/v1/token')) {
        refreshes++
        return allow
          ? Response.json({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600 })
          : Response.json({ msg: 'Request rate limit reached' }, { status: 429 })
      }
      return fetch(input, init)
    }
    try {
      const job = cloud.dispatch({ id: 'auth-recovery', chat: { message: 'm1', body: '继续' } })
      const current = start()
      void current.stopped.then(() => { stopped = true })
      await until(() => fs.existsSync(path.join(runnerHome(), 'session-refresh.json')))
      current.renew()
      await new Promise(resolve => setTimeout(resolve, 150))
      assert.equal(refreshes, 1)
      assert.equal(stopped, false)
      assert.equal(job.state, 'waiting')
      allow = true
      const file = path.join(runnerHome(), 'session-refresh.json')
      const retry = JSON.parse(fs.readFileSync(file, 'utf8'))
      fs.writeFileSync(file, JSON.stringify({ ...retry, until: Date.now() - 1 }))
      current.renew()
      await until(() => job.state === 'finished')
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal(refreshes, 2)
      assert.equal(stopped, false)
    } finally {
      await runner?.close()
      runner = null
      globalThis.fetch = fetch
    }
  })
  for (const failed of [false, true]) {
    it(`Codex 重连后${failed ? '最终失败' : '成功'}同步云端并关闭执行`, async () => {
      const events = [
        { type: 'thread.started', thread_id: 'codex-thread' },
        { type: 'error', message: 'Reconnecting... stream disconnected' },
        { type: 'item.completed', item: { id: 'mcp', type: 'mcp_tool_call', server: 'optional', tool: 'read', status: 'failed', error: { message: 'MCP unavailable' } } },
        { type: 'item.completed', item: { type: 'agent_message', text: '已完成' } },
        failed ? { type: 'turn.failed', error: { message: '401 unauthorized' } } : { type: 'turn.completed' },
      ]
      const script = `console.log(${JSON.stringify(events.map((e) => JSON.stringify(e)).join('\n'))})`
      const job = cloud.dispatch({ id: 'codex-recovery', runtime: 'codex' })
      start('', { plan: (...args) => ({ ...fakeRuntime(script)(...args), renderer: createCodexStreamRenderer() }) })
      await until(() => job.state === 'finished')
      assert.equal(job.outcome, failed ? 'failed' : 'done')
      assert.equal(planned.length, 1)
      assert.equal(job.finishedLogEnded, true)
      assert.equal(readCheckpoint(job.id), null)
      if (failed) assert.match(job.reason!, /401 unauthorized/)
    })
  }

  it('撤销目录后旧队列不会启动工具，验证失败也不会按空列表继续', async () => {
    const job = cloud.dispatch({ id: 'revoked', project: 'prj_1', projectDir: '/old/path' })
    let checked = false
    start('', { authorize: async () => { checked = true; return false } })
    await until(() => job.state === 'finished')
    assert.equal(checked, true)
    assert.equal(job.outcome, 'failed')
    assert.equal(planned.length, 0)
    assert.match(job.reason!, /授权已撤销或暂时无法验证/)
  })

  it('退出账号停止真正执行者和候补会话，不再领取新任务', async () => {
    const { signOut } = await import('../src/settings')
    const job = cloud.dispatch({ id: 'active-logout' })
    const active = start('setInterval(() => {}, 1000)')
    await until(() => planned.length === 1)
    const standby = startRunner({ kind: 'codex', registration: async () => ({ machineId: MACHINE, machineName: 'studio', version: '0', runtimes: [] }), onWaiting: () => {} })
    try {
      const result = await signOut()
      assert.equal(result.error, undefined)
      const next = cloud.dispatch({ id: 'after-logout' })
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(next.claims, 0)
      assert.equal(fs.existsSync(path.join(runnerHome(), 'session.json')), false)
    } finally { await active.close(); await standby.close() }
  })

  it('uses the execution retry policy for chat, discussions and other jobs (#869)', async () => {
    const chat = cloud.dispatch({ id: 'j1', chat: { message: 'msg_1', body: 'Why?' } })
    const idea = cloud.dispatch({ id: 'j2', discussion: { id: 'dsc_1', workspace: 'ws_1', ideas: [] } })
    const other = cloud.dispatch({ id: 'j3' })
    const said = fakeRuntime('console.log("retries", process.env.CLAUDE_CODE_MAX_RETRIES)')
    start('', { plan: (...args: Parameters<typeof said>) => { const p = said(...args); return { ...p, env: { ...p.env, CLAUDE_CODE_MAX_RETRIES: '0' } } } })
    await until(() => [chat, idea, other].every((j) => j.state === 'finished'))
    const retries = (job: typeof chat) => job.events.map((e) => e.text).join('')
    assert.match(retries(chat), /retries 0/)
    assert.match(retries(idea), /retries 0/)
    assert.match(retries(other), /retries 0/)
  })

  it('streams the log with the token as a subprotocol, and finishes once the log is stored (#2085)', async () => {
    const job = cloud.dispatch({ id: 'j1' })
    start()
    await until(() => job.state === 'finished')
    assert.equal(cloud.logs[0]!.protocol, 'bearer, t')
    assert.deepEqual(cloud.logs[0]!.sent.at(-1), { type: 'end' })
    assert.equal(job.finishedLogEnded, true)
  })

  it('does not send a pending renewal heartbeat after the log ends', async () => {
    cloud.silentEnd = true
    const gate = gatedScript('console.log("running")')
    const job = cloud.dispatch({ id: 'j1' })
    let release!: () => void
    let returned = false
    start(gate.script, { endMs: 1_000, api: { ...api, renewJob: async (...args) => {
      const result = await api.renewJob(...args)
      await new Promise<void>((resolve) => { release = resolve })
      returned = true
      return result
    } } })
    await until(() => !!release)
    gate.release()
    await until(() => cloud.logs[0]?.sent.some((m: any) => m.type === 'end'))
    release()
    await until(() => returned)
    assert.deepEqual(cloud.logs[0]!.sent.at(-1), { type: 'end' })
    await until(() => job.state === 'finished')
  })

  it('sends only what the log lacks after a reconnect', async () => {
    const job = cloud.dispatch({ id: 'j1' })
    start('let n = 0; const t = setInterval(() => { console.log("tick " + n++); if (n === 40) clearInterval(t) }, 30)')
    await until(() => job.events.length > 0)
    cloud.logs[0]!.socket.destroy()
    await until(() => job.state === 'finished', 8_000)
    assert.ok(cloud.logs.length >= 2)
    const seqs = job.events.map((e) => e.seq)
    assert.deepEqual(seqs, [...seqs.keys()], 'a seq was lost or sent twice')
    const again = cloud.logs[1]!
    const resent = again.sent.flatMap((m: any) => (m.type === 'events' ? m.events.map((e: { seq: number }) => e.seq) : []))
    assert.ok(again.after >= 0 && resent.every((seq: number) => seq > again.after), 'the log was sent again from the start')
    assert.match(job.events.map((e) => e.text).join(''), /tick 39/)
    assert.ok(cloud.logs.some((l) => l.sent.some((m: any) => m.type === 'alive')), 'a renewal did not keep the log alive')
  })

  it('holds output while nobody watches, and sends it from the start when a page starts watching (#228)', async () => {
    const job = cloud.dispatch({ id: 'j1' })
    cloud.watched = false
    let output = ''
    const gated = gatedScript('console.log("first")', 'console.log("second")')
    const runtime = fakeRuntime(gated.script)
    start('', { plan: (...args) => {
      const p = runtime(...args)
      p.renderer!.push = (text) => { output += text; return text }
      return p
    } })
    await until(() => output.includes('first') && cloud.logs.length === 1)
    assert.equal(job.events.length, 0, 'output went out while nobody watched')
    cloud.watch(true)
    await until(() => job.events.length > 0, 500)
    assert.equal(job.state, 'claimed')
    gated.release()
    await until(() => job.state === 'finished')
    assert.match(job.events.map((e) => e.text).join(''), /first[\s\S]*second/)
  })

  it('sends a whole run nobody watched as nothing but its end (#228)', async () => {
    const job = cloud.dispatch({ id: 'j1' })
    cloud.watched = false
    start('for (let n = 0; n < 20; n++) console.log("x".repeat(4096))')
    await until(() => job.state === 'finished')
    assert.deepEqual(cloud.logs[0]!.sent.filter((m: any) => m.type !== 'alive'), [{ type: 'end' }])
    assert.equal(job.finishedLogEnded, true)
  })

  it('reconnects a log that stopped answering its pings, and a page then gets it (#228)', async () => {
    const job = cloud.dispatch({ id: 'j1' })
    cloud.watched = false
    cloud.deafLogs = true
    const gated = gatedScript('console.log("first")')
    start(gated.script, { logPingMs: 40 })
    await until(() => cloud.logs.length === 1)
    cloud.watched = true
    cloud.deafLogs = false
    await until(() => job.events.length > 0, 2_000)
    assert.equal(job.state, 'claimed')
    assert.ok(cloud.logs.length >= 2)
    gated.release()
    await until(() => job.state === 'finished')
  })

  it('sends a structured runtime\'s events, and its stderr as log', async () => {
    const said = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi.' }, { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'a.ts' } }] } })
    const job = cloud.dispatch({ id: 'j1' })
    start('', {
      plan: (runtime, prompt, cwd, resume) => ({
        ...fakeRuntime(`console.log(${JSON.stringify(said)}); console.error("warn")`)(runtime, prompt, cwd, resume),
        renderer: createStreamRenderer(),
      }),
    })
    await until(() => job.state === 'finished')
    const kinds = job.events.map((e) => e.kind)
    assert.ok(kinds.includes('message') && kinds.includes('tool_call'))
    assert.deepEqual(withoutTime(job.events.find((e) => e.kind === 'tool_call')!.data), { toolCallId: 'u1', title: 'Read', kind: 'read', status: 'in_progress', target: 'a.ts' })
    assert.match(job.events.filter((e) => e.kind === 'log').map((e) => e.text).join(''), /warn/)
    assert.doesNotMatch(job.events.map((e) => e.text).join(''), /Hi\./)
  })

  it('holds an ACP runtime\'s turn and sends its events and what it spent', async () => {
    const job = cloud.dispatch({ id: 'j1', runtime: 'opencode' })
    start('', { plan: acpRuntime() })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(job.events.filter(e => e.kind !== 'phase').map((e) => e.kind), ['plan', 'tool_call', 'message'])
    assert.deepEqual(withoutTime(job.events.at(-1)!.data), { text: 'Two tiers.' })
    assert.deepEqual(job.report, {
      reply: 'Two tiers.',
      session: 's1',
      usage: { input: 10, cacheCreation: 0, cacheRead: 0, output: 2 },
      context: { used: 900, limit: 100000 },
    })
  })

  describe('the context ring of a reply (#237)', () => {
    const claude = (runtime: string, prompt: string, cwd: string, resume?: string | null) => ({
      ...fakeRuntime(`process.stdout.write(${JSON.stringify(CLAUDE_REPLY)})`)(runtime, prompt, cwd, resume),
      renderer: createStreamRenderer(),
    })
    // A runtime that counts the prompt and leaves the window out.
    const counting = (named: string) => (runtime: string, prompt: string, cwd: string, resume?: string | null) => {
      const run = fakeRuntime('')(runtime, prompt, cwd, resume)
      return { ...run, renderer: { ...run.renderer!, context: () => ({ used: 900 }) }, model: () => named }
    }
    const used = (job: FakeJob) => (job.report as { context?: unknown } | undefined)?.context

    it('reports the window a real Claude Code reply names, on a task and on an idea', async () => {
      const chat = cloud.dispatch({ id: 'j1', runtime: 'claude-code' })
      const idea = cloud.dispatch({ id: 'j2', runtime: 'claude-code', discussion: { id: 'dsc_1', workspace: 'ws_1', ideas: [] } })
      start('', { plan: claude })
      await until(() => chat.state === 'finished' && idea.state === 'finished')
      assert.deepEqual(used(chat), { used: 23_821, limit: 1_000_000 })
      assert.deepEqual(used(idea), { used: 23_821, limit: 1_000_000 })
    })

    it('looks a counting runtime\'s window up by the model it named, and drops one nobody knows', async () => {
      const known = cloud.dispatch({ id: 'j1', runtime: 'opencode' })
      start('', { plan: counting('known-model') })
      await until(() => known.state === 'finished')
      assert.deepEqual(used(known), { used: 900, limit: 128_000 })
      await runner?.close()
      const unknown = cloud.dispatch({ id: 'j2', runtime: 'opencode' })
      start('', { plan: counting('unknown-model') })
      await until(() => unknown.state === 'finished')
      assert.equal(used(unknown), undefined)
    })

    it('does not give AGy a task or discussion ring from another provider’s window (#824)', async () => {
      const output = fs.readFileSync(path.join(process.cwd(), '../cli/test/fixtures/antigravity/cached.ndjson'), 'utf8')
      const task = cloud.dispatch({ id: 'agy-task-context', runtime: 'antigravity', model: 'known-model' })
      const discussion = cloud.dispatch({ id: 'agy-discussion-context', runtime: 'antigravity', model: 'known-model',
        discussion: { id: 'dsc_1', workspace: 'ws_1', ideas: [] } })
      start('', { plan: (runtime, prompt, cwd, resume) => ({
        ...fakeRuntime(`process.stdout.write(${JSON.stringify(output)})`)(runtime, prompt, cwd, resume),
        renderer: createAntigravityRenderer(), model: () => 'known-model',
      }) })
      await until(() => task.state === 'finished' && discussion.state === 'finished')
      assert.equal(task.outcome, 'done')
      assert.equal(discussion.outcome, 'done')
      assert.equal(used(task), undefined)
      assert.equal(used(discussion), undefined)
    })

    it('takes the model a talking runtime names over its own connection', async () => {
      process.env.ACP_NO_WINDOW = '1'
      try {
        const job = cloud.dispatch({ id: 'j1', runtime: 'opencode' })
        start('', { plan: (runtime, prompt, cwd) => ({ ...plan(runtime, prompt, cwd), command: process.execPath, args: ['-e', ACP_AGENT] }) })
        await until(() => job.state === 'finished')
        assert.deepEqual(used(job), { used: 900, limit: 128_000 })
      } finally {
        delete process.env.ACP_NO_WINDOW
      }
    })
  })

  it('releases limited AGy tasks and discussions with saved replies and sessions (#829)', async () => {
    const output = [
      { event: 'init', conversation_id: 'agy-limited-session' },
      { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Saved work.' } },
      { event: 'result', result: { status: 'ERROR', error: '429 quota exceeded' } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n'
    const task = cloud.dispatch({ id: 'agy-limit-task', runtime: 'antigravity' })
    const discussion = cloud.dispatch({ id: 'agy-limit-discussion', runtime: 'antigravity',
      discussion: { id: 'dsc_1', workspace: 'ws_1', ideas: [] } })
    start('', { plan: (...args) => {
      const renderer = createAntigravityRenderer()
      return { ...fakeRuntime(`process.stdout.write(${JSON.stringify(output)}); setInterval(() => {}, 1000)`)(...args),
        renderer, session: () => renderer.resumeId?.(), }
    } })
    await until(() => task.state === 'finished' && discussion.state === 'finished')
    for (const job of [task, discussion]) {
      assert.equal(job.outcome, 'failed')
      assert.match(job.reason!, /quota exceeded/)
      assert.equal(job.report?.reply, 'Saved work.')
      assert.equal(job.report?.session, 'agy-limited-session')
    }
    assert.equal(planned.length, 2)
  })

  it('joins neighbouring log text and cuts what Cloud would not keep', () => {
    const wire = toWire([
      { kind: 'log', data: { text: 'a' } },
      { kind: 'log', data: { text: 'b' } },
      { kind: 'tool_call_update', data: { toolCallId: 't', status: 'completed', result: 'x'.repeat(70_000) } },
    ], 5)
    assert.deepEqual(wire.map((e) => [e.seq, e.kind, e.text]), [[5, 'log', 'ab'], [6, 'tool_call_update', '']])
    assert.equal((wire[1]!.data!.result as string).length, 64 * 1024)
  })

  it('不解释旧 Cloud 语言字段或改写正文', async () => {
    const prompt = 'go\n\n请用中文回复和写作。'
    const job = cloud.dispatch({ id: 'j1', prompt, languageLine: '请用中文回复和写作。' })
    start()
    await until(() => job.state === 'finished')
    assert.equal(planned[0]!.prompt, prompt)
    assert.equal(planned[0]!.line, null)
  })

  it('新 Cloud 的语言代码和空值独立传递，保留原正文', async () => {
    const prompt = '请生成英文产物。\n\n请用中文回复和写作。'
    start()
    for (const input of [
      { id: 'lang-zh', language: 'zh' as const, prompt },
      { id: 'lang-en', language: 'en' as const, languageLine: '请用中文回复和写作。', prompt },
      { id: 'lang-null', language: null, languageLine: '请用中文回复和写作。', prompt },
    ]) {
      const job = cloud.dispatch(input)
      await until(() => job.state === 'finished')
    }
    assert.deepEqual(planned.map(p => p.line), ['zh', 'en', null])
    assert.ok(planned.every(p => p.prompt === prompt))
  })

  it('子 CLI 环境保留已注入的系统提示词，清除上游语言与运行标记', () => {
    const env = akbEnv(fakeAkb(), 'b', 'task', 'en', {
      DSH_SYSTEM_PROMPT: '用户规则与当前语言',
      OPENCODE_CONFIG_CONTENT: '{"instructions":["/current.md"]}',
      AI4KANBAN_LANGUAGE_LINE: '请用中文回复和写作。',
      KANBAN_RUN: 'old',
    })
    assert.equal(env.AI4KANBAN_LANGUAGE, 'en')
    assert.equal(env.AI4KANBAN_LANGUAGE_LINE, '请用中文回复和写作。')
    assert.equal(env.KANBAN_RUN, undefined)
    assert.equal(env.DSH_SYSTEM_PROMPT, '用户规则与当前语言')
    assert.equal(env.OPENCODE_CONFIG_CONTENT, '{"instructions":["/current.md"]}')
  })

  it('无法注入时把限制写入作业日志，不改变原会话', async () => {
    const job = cloud.dispatch({ id: 'lang-warning', language: 'zh', resume: 'old-session' })
    start('', {
      plan: (...args) => ({ ...fakeRuntime('')(...args), startNote: '语言规则未能更新' }),
    })
    await until(() => job.state === 'finished')
    assert.equal(planned[0]!.resume, 'old-session')
    assert.equal(planned.length, 1)
    assert.ok(job.events.some(e => e.text.includes('语言规则未能更新')))
  })

  it('passes no inherited scheduled list on (#277)', () => {
    const held = process.env.AI4KANBAN_SCHEDULED_AGENTS
    process.env.AI4KANBAN_SCHEDULED_AGENTS = 'qa-manager'
    try {
      const akb = { command: 'akb', args: [], version: '1.0.0', shim: path.join(runnerHome(), 'bin', 'akb', '1.0.0', 'shim') }
      assert.equal(akbEnv(akb, 'b').AI4KANBAN_SCHEDULED_AGENTS, undefined)
    } finally {
      if (held === undefined) delete process.env.AI4KANBAN_SCHEDULED_AGENTS
      else process.env.AI4KANBAN_SCHEDULED_AGENTS = held
    }
  })

  it('stops when a carried discussion session is unavailable (#2146)', async () => {
    const job = cloud.dispatch({ id: 'j1', resume: 'ds1', fork: true, transcript: 'User: Tiers?\n\nAgent: Two.' })
    const forked: (boolean | undefined)[] = []
    let read = ''
    start('', {
      plan: (runtime, prompt, cwd, resume, model, _settings, fork) => {
        planned.push({ runtime, prompt, cwd, resume, model })
        forked.push(fork)
        const file = /leaves out: (\S+)/.exec(prompt)?.[1]
        if (file) read = fs.readFileSync(file, 'utf8')
        // The discussion's session is not on this computer.
        const gone = !!resume
        return {
          command: process.execPath,
          args: ['-e', gone ? 'process.exit(1)' : ''],
          env: process.env,
          renderer: { push: (s) => s, flush: () => '', result: () => (gone ? undefined : 'Two tiers.') },
          quiet: () => false,
          session: () => (gone ? undefined : 'fresh-session'),
        }
      },
    })
    await until(() => job.state === 'finished')
    assert.deepEqual(planned.map((p) => p.resume), ['ds1'])
    assert.deepEqual(forked, [true])
    assert.equal(planned[0]!.prompt, 'go', 'a carried session was pointed at the discussion')
    assert.equal(read, '')
    assert.equal(job.outcome, 'failed')

  })

  for (const reason of ['Session old not found', 'No conversation found with session ID: old', 'Please sign in']) {
    it(`会话恢复失败保留云端上下文且仅重建缺失会话：${reason}`, async () => {
      const job = cloud.dispatch({ id: 'j1', resume: 'old', prompt: '已有云端上下文\n新的问题', chat: { message: 'm1', body: '新的问题' } })
      start('', {
        plan: (runtime, prompt, cwd, resume) => {
          planned.push({ runtime, prompt, cwd, resume })
          return {
            command: process.execPath,
            args: ['-e', resume ? `console.error(${JSON.stringify(reason)}); process.exit(1)` : ''],
            env: process.env,
            renderer: { push: (s) => s, flush: () => '', result: () => resume ? undefined : '接着讨论',
              usage: () => ({ input: 10, cacheCreation: 0, cacheRead: 0, output: 2 }), costUsd: () => 0.25 },
            quiet: () => false,
            session: () => resume ?? 'new',
          }
        },
      })
      await until(() => job.state === 'finished')
      assert.deepEqual(planned.map((p) => p.resume), ['old'])
      assert.ok(planned.every((p) => p.prompt === '已有云端上下文\n新的问题'))
      assert.equal(job.claims, 1)
      assert.equal(job.outcome, 'failed')
      assert.equal((job.report?.usage as api.Usage)?.input, 10)
      assert.equal(job.report?.costUsd, 0.25)
    })
  }

  it('新会话再次失败也不会无限重试', async () => {
    const job = cloud.dispatch({ id: 'j1', resume: 'old', chat: { message: 'm1', body: '继续' } })
    start('', {
      plan: (runtime, prompt, cwd, resume) => {
        planned.push({ runtime, prompt, cwd, resume })
        return {
          command: process.execPath, args: ['-e', 'console.error("Session not found"); process.exit(1)'],
          env: process.env,
          renderer: { push: (s) => s, flush: () => '', result: () => undefined },
          quiet: () => false, session: () => undefined,
        }
      },
    })
    await until(() => job.state === 'finished')
    assert.deepEqual(planned.map((p) => p.resume), ['old'])
    assert.equal(job.outcome, 'failed')
  })

  it('hands an idea conversation its ideas and studios, and reports what the reply left (#2073)', async () => {
    const ideas = [{ id: 'idea_1', title: 'Pricing page', outcome: 'Prices.', acceptance: [], studio: 'wf_builtin_coding', task: null }]
    const job = cloud.dispatch({ id: 'j1', discussion: { id: 'dsc_1', workspace: 'ws_1', ideas } })
    start(`const fs = require('node:fs'); const f = process.env.KANBAN_IDEAS; const held = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (held.studios[0].id !== 'wf_builtin_coding') process.exit(4);
      held.ideas[0].start = true; fs.writeFileSync(f, JSON.stringify(held))`)
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done')
    assert.deepEqual((job.report as { ideas: unknown[] }).ideas, [{ ...ideas[0], start: true }])
    assert.equal(fs.existsSync(path.join(runnerHome(), 'ideas', 'j1.json')), false)
  })

  it('新服务通过 goals 接收旧 CLI 编辑的草稿', async () => {
    const ideas = [{ id: 'idea_1', title: 'Pricing page', outcome: 'Prices.', acceptance: [], studio: 'wf_builtin_coding', task: null }]
    const job = cloud.dispatch({ id: 'j1', discussion: { id: 'dsc_1', workspace: 'ws_1', goals: ideas, ideas } })
    start(`const fs = require('node:fs'); const f = process.env.KANBAN_IDEAS; const held = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (held.studios[0].id !== 'wf_builtin_coding') process.exit(4);
      held.ideas[0].start = true; fs.writeFileSync(f, JSON.stringify(held))`)
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done')
    assert.deepEqual((job.report as { goals: unknown[] }).goals, [{ ...ideas[0], start: true }])
    assert.equal(fs.existsSync(path.join(runnerHome(), 'ideas', 'j1.json')), false)
  })

  it('reports a failing runtime as failed', async () => {
    const job = cloud.dispatch({ id: 'j1' })
    start('process.exit(3)')
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'failed')
    assert.match(job.reason!, /code 3/)
  })

  it('runs a job once however often it is announced', async () => {
    const job = cloud.dispatch({ id: 'j1' })
    start('setTimeout(() => {}, 300)')
    await until(() => job.state === 'finished')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(job.claims, 1)
    assert.equal(planned.length, 1)
  })

  it('refuses a folder the user did not allow, and one that steps out of it by a link', async () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'allowed-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
    fs.symlinkSync(outside, path.join(allowed, 'escape'))
    fs.mkdirSync(path.join(allowed, 'site'))
    fs.writeFileSync(path.join(runnerHome(), 'projects.json'), JSON.stringify({ projects: [allowed] }))

    const elsewhere = cloud.dispatch({ id: 'out', projectDir: outside })
    const linked = cloud.dispatch({ id: 'link', projectDir: path.join(allowed, 'escape') })
    const inside = cloud.dispatch({ id: 'in', projectDir: path.join(allowed, 'site') })
    start()
    await until(() => [elsewhere, linked, inside].every((j) => j.state === 'finished'))
    assert.equal(elsewhere.outcome, 'failed')
    assert.match(elsewhere.reason!, /not allowed/)
    assert.equal(linked.outcome, 'failed')
    assert.equal(inside.outcome, 'done')
    assert.deepEqual(planned.map((p) => p.cwd), [fs.realpathSync(path.join(allowed, 'site'))])
  })

  it('runs every job Cloud lists at once: the plan is the only limit (#17)', async () => {
    const jobs = ['j1', 'j2', 'j3'].map((id) => cloud.dispatch({ id }))
    start('setInterval(() => {}, 1000)')
    await until(() => jobs.every((j) => j.state === 'claimed') && planned.length === 3)
  })

  it('stops the local process when the lease is lost', async () => {
    const job = cloud.dispatch({ id: 'j1' })
    const pidFile = path.join(runnerHome(), 'lost-lease.pid')
    start(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => console.log("tick"), 20)`)
    await until(() => job.state === 'claimed' && job.events.length > 0)
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    job.leaseLost = true
    await until(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    })
    assert.equal(planned.length, 1)
    assert.equal(job.outcome, undefined)
    assert.equal(job.state, 'claimed')
  })

  it('断网且续租请求悬挂时，仍在租约到期后终止执行', async () => {
    const job = cloud.dispatch({ id: 'j1' })
    const pidFile = path.join(runnerHome(), 'lease-child.pid')
    let renewals = 0
    let release!: (value: Awaited<ReturnType<typeof api.renewJob>>) => void
    const pending = new Promise<Awaited<ReturnType<typeof api.renewJob>>>((resolve) => { release = resolve })
    start(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 20)`, {
      leaseMs: 300,
      api: { ...api, renewJob: async () => { renewals++; return pending } },
    })
    try {
      await until(() => fs.existsSync(pidFile))
      const pid = Number(fs.readFileSync(pidFile, 'utf8'))
      await until(() => {
        try { process.kill(pid, 0); return false } catch { return true }
      })
      assert.equal(renewals, 1)
      release({ ok: true, value: { renewed: true } })
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(job.state, 'claimed', '迟到的续租不得恢复已失效执行或回写结果')
      assert.equal(renewals, 1)
    } finally {
      release({ ok: true, value: { renewed: false } })
    }
  })

  it('续租网络失败不会让本地进程越过租约截止时间', async () => {
    const job = cloud.dispatch({ id: 'j1' })
    const pidFile = path.join(runnerHome(), 'offline-child.pid')
    start(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 20)`, {
      leaseMs: 300,
      api: { ...api, renewJob: async () => { throw new Error('离线') } },
    })
    await until(() => fs.existsSync(pidFile))
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    await until(() => {
      try { process.kill(pid, 0); return false } catch { return true }
    })
    assert.equal(job.state, 'claimed')
  })

  it('stops a reply when its log says so, and sends what the agent said by then (#2133)', async () => {
    const job = cloud.dispatch({ id: 'j1', runtime: 'opencode', attachments: [{ name: 'shot.png', content: 'aGk=' }] })
    let output = ''
    start('', { plan: acpRuntime({ ACP_HALF: '1' }, (text) => { output += text }) })
    await until(() => output.includes('Two') && cloud.logs.some((l) => l.job === 'j1'))
    cloud.stopOverLog('j1')
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual([(job.report!.reply as string).trim(), job.report!.stopped], ['Two', true])
    await until(() => !fs.existsSync(path.join(runnerHome(), 'attachments', 'j1')))
  })

  it('stops a reply its renewal asks to stop, as done', async () => {
    const job = cloud.dispatch({ id: 'j1', stop: true })
    start('setInterval(() => console.log("tick"), 20)')
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.report!.stopped, true)
  })

  for (const discussion of [false, true]) it(`AGy receives isolated pictures on fresh and resumed ${discussion ? 'discussion' : 'task chat'} turns (#825)`, async () => {
    const session = '00000000-0000-4000-8000-000000000825'
    const png = fs.readFileSync('test/fixtures/codex-images/reply.png')
    let turn = 0
    start('', { plan: (...args) => {
      assert.equal(args[0], 'antigravity')
      assert.equal(args[3], turn ? session : null)
      assert.match(args[1], /Read the pictures in order/)
      const dir = path.join(runnerHome(), 'attachments', `pictures-${turn}`)
      const files = [...args[1].matchAll(/^- (.+\.png)$/gm)].map(m => m[1]!)
      assert.deepEqual(files, Array.from({ length: turn + 1 }, (_, i) => path.join(dir, `${i}.png`)))
      for (const file of files) assert.deepEqual(fs.readFileSync(file), png)
      const frames = [
        { event: 'init', conversation_id: session, init: {} },
        ...files.map((file, step_index) => ({ event: 'step_update', step_update: { conversation_id: session,
          step_index, state: 'DONE', step_type: 'tool', tool_info: { name: 'read_file', parameters: { Path: file } } } })),
        { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'Pictures read.' } },
      ]
      const p = fakeRuntime(`console.log(${JSON.stringify(frames.map(f => JSON.stringify(f)).join('\n'))})`)(...args)
      p.renderer = createAntigravityRenderer(args[3] ?? undefined)
      p.session = () => p.renderer!.resumeId?.()
      return p
    } })
    for (turn = 0; turn < 2; turn++) {
      const job = cloud.dispatch({ id: `pictures-${turn}`, runtime: 'antigravity', resume: turn ? session : null,
        prompt: 'Read the pictures in order', attachments: Array.from({ length: turn + 1 }, (_, i) => ({ name: `${i}.png`, content: png.toString('base64') })),
        ...(discussion ? { discussion: { id: 'd825', workspace: 'ws_1', ideas: [] } } : { task: 'task_1', project: 'prj_1', number: 1, chat: { message: `m${turn}`, body: 'Read the pictures in order' } }),
      })
      await until(() => job.state === 'finished')
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal(job.report?.session, session)
      await until(() => !fs.existsSync(path.join(runnerHome(), 'attachments', job.id)))
    }
    assert.equal(planned.length, 2)
  })

  for (const discussion of [false, true]) it(`AGy completes recovered image reads once in ${discussion ? 'discussion' : 'task chat'} (#828)`, async () => {
    const session = '00000000-0000-4000-8000-000000000828'
    const png = fs.readFileSync('test/fixtures/codex-images/reply.png').toString('base64')
    start('', { plan: (...args) => {
      const dir = path.join(runnerHome(), 'attachments', 'pictures-recovered')
      const read = (step_index: number, file: string, failed = false) => ({ event: 'step_update', step_update: {
        conversation_id: session, step_index, state: failed ? 'ERROR' : 'DONE', step_type: 'tool',
        tool_info: { name: 'read_file', parameters: { Path: file }, ...(failed ? { error: { message: 'file does not exist' } } : {}) },
      } })
      const frames = [
        { event: 'init', conversation_id: session, init: {} },
        read(1, path.join(dir, 'optional.png'), true),
        read(2, path.join(dir, 'wrong', '0.png'), true),
        read(3, path.join(dir, '0.png')),
        read(4, path.join(dir, '1.png'), true),
        read(5, path.join(dir, '1.png')),
        { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'Both pictures read.' } },
      ]
      const p = fakeRuntime(`console.log(${JSON.stringify(frames.map(f => JSON.stringify(f)).join('\n'))})`)(...args)
      p.renderer = createAntigravityRenderer(args[3] ?? undefined, args[2])
      p.session = () => p.renderer!.resumeId?.()
      return p
    } })
    const job = cloud.dispatch({ id: 'pictures-recovered', runtime: 'antigravity',
      attachments: ['0.png', '1.png'].map(name => ({ name, content: png })),
      ...(discussion ? { discussion: { id: 'd828', workspace: 'ws_1', ideas: [] } }
        : { task: 'task_1', project: 'prj_1', number: 1, chat: { message: 'm828', body: 'Read both pictures' } }),
    })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.report?.reply, 'Both pictures read.')
    assert.equal(planned.length, 1)
    assert.ok(job.events.some(e => e.kind === 'tool_call_update' && e.data?.status === 'failed' && /file does not exist/.test(String(e.data.result))))
    assert.ok(!job.events.some(e => e.kind === 'error'))
  })

  it('records a stopped Antigravity reply without reporting success or retrying (#687)', async () => {
    const job = cloud.dispatch({ id: 'j1', runtime: 'antigravity', stop: true })
    start('setInterval(() => console.log("tick"), 20)')
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'stopped', job.reason)
    assert.equal(job.report!.stopped, true)
    assert.equal(planned.length, 1)
  })

  it('reconnects after Cloud drops away, and picks up what arrived meanwhile', async () => {
    start()
    await until(() => cloud.registrations > 0)
    const port = cloud.port
    await cloud.stop()
    const job = cloud.dispatch({ id: 'late' })
    await new Promise((r) => setTimeout(r, 300))
    await cloud.start(port)
    await until(() => job.state === 'finished', 10_000)
    assert.equal(job.outcome, 'done')
  })

  for (const protocol of [false, true]) it(`five-minute idle recovery uses three retries: ${protocol ? 'protocol' : 'stream'}`, async () => {
    const original = IDLE_TIMEOUT.milliseconds
    IDLE_TIMEOUT.milliseconds = 100
    try {
      const job = cloud.dispatch({ id: 'idle-recovery', chat: { message: 'm1', body: 'Continue' } })
      start('', { plan: (...args) => {
        const p = fakeRuntime('setInterval(() => {}, 1000)')(...args)
        p.renderer!.events = () => []
        if (protocol) p.converse = async (_child, event) => {
          event({ kind: 'message', data: { text: 'Progress before interruption.' } })
          return new Promise(() => {})
        }
        return p
      } })
      await until(() => job.state === 'finished')
      assert.equal(planned.length, 4)
      assert.equal(job.outcome, 'failed')
      assert.match(job.reason!, /idle timeout/)
      assert.equal(readCheckpoint(job.id)?.retry?.attempt, 4)
      if (protocol) assert.match(String(job.report?.reply ?? ''), /Progress before interruption/)
    } finally { IDLE_TIMEOUT.milliseconds = original }
  })

  for (const converse of [false, true]) for (const discussion of [false, true]) {
    it(`有限重试保留原消息与附件 ${converse ? 'ACP' : 'printed'} ${discussion ? 'discussion' : 'task'}`, async () => {
      const job = cloud.dispatch({ id: 'retry-turn', prompt: '原消息与上下文', attachments: [{ name: 'shot.png', content: 'aGk=' }],
        ...(discussion ? { discussion: { id: 'd1', workspace: 'ws_1', ideas: [] } } : { chat: { message: 'm1', body: '原消息' } }) })
      let calls = 0
      start('', { plan: (...args) => {
        const failed = ++calls < 2
        const p = fakeRuntime(failed ? 'process.exit(1)' : 'console.log("完成")')(...args)
        p.renderer!.events = () => []
        p.renderer!.executionFailure = () => failed ? overload : undefined
        p.renderer!.usage = () => ({ input: 10, cacheCreation: 1, cacheRead: 2, output: 3 })
        p.renderer!.costUsd = () => 0.25
        if (converse) p.converse = async (_child, event) => {
          event({ kind: 'message', data: { text: failed ? '' : '完成' } })
          const spent = { usage: p.renderer!.usage!(), costUsd: p.renderer!.costUsd!() }
          return failed ? { ok: false, error: overload.reason, failure: overload, ...spent } : { ok: true, result: '完成', ...spent }
        }
        return p
      } })
      await until(() => job.state === 'finished')
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal(calls, 2)
      assert.deepEqual(job.report?.usage, { input: 20, cacheCreation: 2, cacheRead: 4, output: 6 })
      assert.equal(job.report?.costUsd, 0.5)
      assert.equal(job.claims, 1)
      assert.ok(planned.every(p => p.prompt.includes('shot.png') && p.prompt.includes('原消息与上下文')))
      await until(() => readCheckpoint(job.id) === null)
      assert.equal(readCheckpoint(job.id), null)
      assert.equal(job.report?.recovery && (job.report.recovery as { safe: boolean }).safe, true)
    })
  }

  for (const discussion of [false, true]) it(`AGy preserves a partial reply after an unclassified EOF ${discussion ? 'discussion' : 'task'} (#841)`, async () => {
    const session = '00000000-0000-4000-8000-000000000796'
    const partial = '已完成文件更新，保留用户选择的方案。'
    const job = cloud.dispatch({ id: 'agy-interrupted', runtime: 'antigravity', prompt: '按已确认方案更新文件',
      ...(discussion ? { discussion: { id: 'd1', workspace: 'ws_1', ideas: [] } } : { chat: { message: 'm1', body: '按已确认方案更新文件' } }) })
    start('', { plan: (...args) => {
      const frames = [
        { event: 'init', conversation_id: session },
        { event: 'step_update', step_update: { conversation_id: session, step_index: 1, step_type: 'agent_response', text_delta: partial } },
      ]
      const p = fakeRuntime(`console.log(${JSON.stringify(frames.map(f => JSON.stringify(f)).join('\n'))}); console.error('API error: request failed: EOF'); process.exitCode = 1;`)(...args)
      p.renderer = createAntigravityRenderer()
      p.session = () => p.renderer!.resumeId?.()
      return p
    } })
    await until(() => job.state === 'finished')
    assert.equal(planned.length, 1)
    assert.equal(job.outcome, 'failed', job.reason)
    assert.match(job.reason!, /request failed: EOF/)
    assert.equal(job.report?.reply, partial)
  })

  for (const discussion of [false, true]) it(`AGy 仅收到 init 时保存会话，重启后带原始请求续接 ${discussion ? 'discussion' : 'task'} (#830)`, async () => {
    const session = '00000000-0000-4000-8000-000000000830'
    const job = cloud.dispatch({ id: 'agy-early', runtime: 'antigravity', prompt: '用户决定：保留 Cedar830。',
      ...(discussion ? { discussion: { id: 'd1', workspace: 'ws_1', ideas: [] } } : { chat: { message: 'm1', body: '保留 Cedar830' } }) })
    const plan: NonNullable<Deps['plan']> = (...args) => {
      const resumed = !!args[3]
      const frames = [{ event: 'init', conversation_id: session },
        ...(resumed ? [{ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'Cedar830 preserved.' } }] : [])]
      const p = fakeRuntime(`console.log(${JSON.stringify(frames.map(e => JSON.stringify(e)).join('\n'))}); ${resumed ? '' : 'setInterval(() => {}, 1000);'}`)(...args)
      p.renderer = createAntigravityRenderer(args[3] ?? undefined)
      p.session = () => p.renderer!.resumeId?.()
      return p
    }
    const current = start('', { plan })
    await until(() => readCheckpoint(job.id)?.session === session)
    assert.equal(readCheckpoint(job.id)?.effects, false)
    assert.equal(readCheckpoint(job.id)?.partialReply, undefined)
    await current.update()
    start('', { plan })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(planned.length, 2)
    assert.equal(planned[1]!.resume, session)
    assert.match(planned[1]!.prompt, /用户决定：保留 Cedar830/)
    assert.match(planned[1]!.prompt, /不要重复已经执行的操作/)
    assert.equal(job.report?.session, session)
    assert.equal(job.report?.reply, 'Cedar830 preserved.')
  })

  it('AGy 启动中断未记录会话时明确失败，不创建替代会话 (#830)', async () => {
    saveCheckpoint('agy-no-session', { updating: true, started: true, effects: false, pending: [] })
    const job = cloud.dispatch({ id: 'agy-missing-id', runtime: 'antigravity', recoveryOf: 'agy-no-session', chat: { message: 'm1', body: '继续' } })
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'failed')
    assert.match(job.reason!, /did not record.*cannot be resumed/)
    assert.equal(planned.length, 0)
  })

  for (const resumed of [false, true]) {
    it(`重启保留尝试消耗且不重复累计 ${resumed ? '续接' : '重放'}`, async () => {
      const job = cloud.dispatch({ id: 'restart-spent', runtime: 'claude-code', state: 'claimed', machine: MACHINE,
        chat: { message: 'm1', body: '继续' } })
      const usage = { input: 10, cacheCreation: 1, cacheRead: 2, output: 3 }
      saveCheckpoint(job.id, { updating: true, mark: stopMark(), pending: [], effects: resumed, started: true,
        session: 'kept', retry: { since: Date.now(), attempt: 1, pending: { at: Date.now(), of: 4, failure: overload } },
        attempts: [{ session: 'kept', usage, costUsd: 0.5 }] })
      start('', { plan: (...args) => {
        const p = fakeRuntime('console.log("done")')(...args)
        p.renderer!.events = () => []
        p.renderer!.usage = () => usage
        p.renderer!.costUsd = () => resumed ? 0.75 : 0.25
        return p
      } })
      await until(() => job.state === 'finished')
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal(planned.length, 1)
      assert.equal(planned[0]?.resume, resumed ? 'kept' : null)
      assert.deepEqual(job.report?.usage, { input: 20, cacheCreation: 2, cacheRead: 4, output: 6 })
      assert.deepEqual(job.report?.attemptCosts, [
        { session: 'kept', costUsd: 0.5 },
        { resume: resumed ? 'kept' : null, session: resumed ? 'kept' : 'fresh-session', costUsd: resumed ? 0.75 : 0.25 },
      ])
    })
  }

  for (const discussion of [false, true]) for (const reason of [
    'authentication failed or timed out', 'permission denied: service unavailable',
    'invalid model selection: model is unavailable', '429 rate limit: service unavailable',
    'rpc error: code = ResourceExhausted desc = credits exhausted', 'Antigravity: CANCELED: network error',
  ]) it(`AGy 不重试需要人工处理的错误 ${discussion ? 'discussion' : 'task'} ${reason} (#827)`, async () => {
    const job = cloud.dispatch({ id: 'agy-manual-failure', runtime: 'antigravity',
      ...(discussion ? { discussion: { id: 'd1', workspace: 'ws_1', ideas: [] } } : { chat: { message: 'm1', body: '继续' } }) })
    start('', { plan: (...args) => {
      const p = fakeRuntime('process.exit(1)')(...args)
      p.renderer!.events = () => []
      p.renderer!.failure = () => reason
      return p
    } })
    await until(() => job.state === 'finished')
    assert.equal(planned.length, 1)
    assert.equal(job.outcome, 'failed')
    assert.ok(job.reason?.startsWith(reason))
    assert.equal(readCheckpoint(job.id)?.retry?.attempt, 1)
  })

  for (const reason of ['quota exceeded', 'Please login first', 'unknown model error']) {
    it(`未知或持续模型失败受直接挂起 ${reason}`, async () => {
      const job = cloud.dispatch({ id: 'model-failure', chat: { message: 'm1', body: '原消息' } })
      start('', { plan: (...args) => {
        const p = fakeRuntime('process.exit(1)')(...args)
        p.renderer!.events = () => []
        p.renderer!.failure = () => reason
        return p
      } })
      await until(() => job.state === 'finished')
      assert.equal(planned.length, 1)
      assert.equal(job.outcome, 'failed')
      assert.ok(job.reason?.startsWith(reason))
      assert.equal(readCheckpoint(job.id)?.retry?.attempt, 1)
    })
  }

  for (const state of ['completed', 'pending', 'opaque', 'missing-session']) {
    it(`重试核对副作用 ${state}`, async () => {
      const job = cloud.dispatch({ id: 'effects', chat: { message: 'm1', body: '修改' } })
      let calls = 0
      start('', { plan: (...args) => {
        const p = fakeRuntime(++calls === 1 ? 'process.exit(1)' : 'console.log("已续接")')(...args)
        p.renderer!.executionFailure = () => calls === 1 ? disconnect : undefined
        if (state !== 'opaque') {
          let emitted = false
          p.renderer!.events = () => {
            if (emitted) return []
            emitted = true
            return [{ kind: 'tool_call', data: { toolCallId: 'write', kind: 'edit', title: 'write', status: state === 'pending' ? 'in_progress' : 'completed' } }]
          }
        }
        if (state === 'missing-session') p.session = () => undefined
        return p
      } })
      await until(() => job.state === 'finished')
      assert.equal(planned.length, (state === 'completed') ? 2 : 1)
      if ((state === 'completed')) {
        assert.equal(planned[1]?.resume, 'fresh-session')
        assert.match(planned[1]!.prompt, /不要重复已经执行的操作/)
      } else assert.equal(job.reason, 'recovery_unsafe')
    })
  }

  for (const failures of [[validation, validation], [disconnect, validation], [validation, disconnect, disconnect, disconnect]]) {
    it(`shares cumulative retry slots across tiers (${failures.map(f => f.level).join(',')})`, async () => {
      const job = cloud.dispatch({ id: 'mixed-retry', discussion: { id: 'd1', workspace: 'ws_1', ideas: [] } })
      let calls = 0
      start('', { plan: (...args) => {
        const failure = failures[calls++]
        const p = fakeRuntime('process.exit(1)')(...args)
        p.renderer!.events = () => []
        p.renderer!.executionFailure = () => failure
        return p
      } })
      await until(() => job.state === 'finished')
      assert.equal(job.outcome, 'failed')
      assert.equal(calls, failures.length)
      assert.equal(readCheckpoint(job.id)?.retry?.attempt, failures.length)
      assert.equal(readCheckpoint(job.id)?.retryPause, 'limit')
      if (failures[0]?.level === 1) assert.match(planned[1]!.prompt, /Schema check failed/)
    })
  }

  for (const updating of [false, true]) it(`restores a pending deadline after ${updating ? 'an update' : 'a restart'} without consuming it twice`, async () => {
    const job = cloud.dispatch({ id: 'pending-deadline', state: 'claimed', machine: MACHINE, chat: { message: 'm1', body: 'Continue' } })
    const at = Date.now() + 250
    saveCheckpoint(job.id, { updating, pending: [], started: true, effects: true, session: 'kept',
      retry: { since: 0, attempt: 3, pending: { at, of: 4, failure: disconnect } } })
    let startedAt = 0
    start('', { plan: (...args) => {
      assert.equal(readCheckpoint(job.id)?.retry?.pending?.at, at)
      assert.equal(readCheckpoint(job.id)?.retry?.attempt, 3)
      const p = fakeRuntime('process.exit(1)')(...args)
      startedAt = Date.now()
      p.renderer!.events = () => []
      p.renderer!.executionFailure = () => disconnect
      return p
    } })
    await until(() => job.state === 'finished')
    assert.ok(startedAt >= at)
    assert.equal(planned.length, 1)
    assert.equal(readCheckpoint(job.id)?.retry?.attempt, 4)
    assert.equal(readCheckpoint(job.id)?.retryPause, 'limit')
  })

  it('pauses a legacy pending retry without a structured cause and preserves its budget', async () => {
    const job = cloud.dispatch({ id: 'legacy-retry', state: 'claimed', machine: MACHINE, chat: { message: 'm1', body: 'Continue' } })
    saveCheckpoint(job.id, { updating: true, pending: [], started: true, effects: true, session: 'kept',
      retry: { since: 0, attempt: 2, at: Date.now() } })
    start()
    await until(() => job.state === 'finished')
    assert.equal(planned.length, 0)
    assert.equal(readCheckpoint(job.id)?.retry?.attempt, 2)
    assert.equal(job.reason, 'recovery_unsafe')
  })

  for (const runtime of ['codex', 'antigravity'] as const) it(`等待恢复可停止且不再启动进程 ${runtime}`, async () => {
    const job = cloud.dispatch({ id: 'stop-wait', runtime, chat: { message: 'm1', body: '原消息' } })
    start('', { replyBackoff: () => 500, renewMs: 20, plan: (...args) => {
      const p = fakeRuntime('process.exit(1)')(...args)
      p.renderer!.executionFailure = () => overload
      p.renderer!.events = () => []
      return p
    } })
    await until(() => !!readCheckpoint(job.id)?.retry?.pending)
    job.stop = true
    await until(() => job.state === 'finished')
    assert.equal(planned.length, 1)
    assert.equal(job.report?.stopped, true)
    assert.equal(job.outcome, runtime === 'antigravity' ? 'stopped' : 'done')
  })

  it('恢复等待期间撤销目录授权后不再启动 Agent (#796)', async () => {
    let allowed = true
    const job = cloud.dispatch({ id: 'revoke-wait', chat: { message: 'm1', body: '继续' } })
    start('', { authorize: async () => allowed, replyBackoff: () => 150, plan: (...args) => {
      const p = fakeRuntime('process.exit(1)')(...args)
      p.renderer!.executionFailure = () => overload
      p.renderer!.events = () => []
      return p
    } })
    await until(() => !!readCheckpoint(job.id)?.retry?.pending)
    allowed = false
    await until(() => job.state === 'finished')
    assert.equal(planned.length, 1)
    assert.equal(job.outcome, 'failed')
  })

  it('手动恢复失败不重复发送上一轮已经保存的回复 (#796)', async () => {
    saveCheckpoint('saved-partial', { pending: [], effects: false, started: true, partialReply: 'Already delivered.',
      completed: { outcome: 'failed', report: { reply: 'Already delivered.' } } })
    const job = cloud.dispatch({ id: 'retry-partial', manualRecovery: true, retryReplay: true, recoveryOf: 'saved-partial',
      chat: { message: 'm1', body: '继续' } })
    start('', { plan: (...args) => {
      const p = fakeRuntime('process.exit(1)')(...args)
      p.renderer!.result = () => undefined
      p.renderer!.executionFailure = () => overload
      p.renderer!.events = () => []
      return p
    } })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'failed')
    assert.equal(planned.length, 4)
    assert.equal(job.report?.reply, undefined)
  })

  for (const checkpoint of [null, { pending: ['write'], effects: true, started: true, session: 's1' }, { pending: [], effects: false, started: true }]) {
    it(`手动续跑把缺失或未确认进度交给 Agent 核对 ${JSON.stringify(checkpoint)}`, async () => {
      if (checkpoint) saveCheckpoint('old-turn', checkpoint)
      const job = cloud.dispatch({ id: 'manual-turn', recoveryOf: 'old-turn', manualRecovery: true, chat: { message: 'm1', body: '修改' } })
      start()
      await until(() => job.state === 'finished')
      assert.equal(planned.length, 1)
      assert.equal(job.outcome, 'done', job.reason)
    })
  }

  for (const discussion of [false, true]) {
    it(`长时间正常执行的回复重启后仍可沿用原会话 ${discussion ? 'discussion' : 'task'}`, async () => {
      saveCheckpoint('long-running-original', { mark: stopMark(), pending: [], started: true,
        submitted: true, effects: true, session: 'original-session', retry: { since: Date.now() - 7_200_000, attempt: 1 } })
      const job = cloud.dispatch({ id: 'long-running-recovered', recoveryOf: 'long-running-original',
        ...(discussion ? { discussion: { id: 'd1', workspace: 'ws_1', ideas: [] } } : { chat: { message: 'm1', body: '继续' } }) })
      start('', { plan: (...args) => {
        const p = fakeRuntime('')(...args)
        p.converse = async (_child, event, _stop, deadline) => {
          assert.ok(deadline! > Date.now(), '会话启动期限不能沿用两小时前的时间')
          event({ kind: 'message', data: { text: '恢复完成' } })
          return { ok: true, result: '恢复完成' }
        }
        return p
      } })
      await until(() => job.state === 'finished')
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal(planned.length, 1)
      assert.equal(planned[0]?.resume, 'original-session')
      assert.match(planned[0]!.prompt, /不要重复已经执行的操作/)
    })
  }

  for (const [attempt, elapsed] of [[4, 0], [4, 120_001]]) {
    it(`重启不重置已用预算 ${attempt} ${elapsed}`, async () => {
      const job = cloud.dispatch({ id: 'restart-budget', recoveryOf: 'interrupted-turn', machine: MACHINE, chat: { message: 'm1', body: '继续' } })
      saveCheckpoint(job.id, { mark: stopMark(), pending: [], effects: false, started: true,
        session: 'kept', retry: { since: Date.now() - elapsed, attempt } })
      start()
      await until(() => job.state === 'finished')
      assert.equal(planned.length, 0)
      assert.match(job.reason!, /retry limit/)
      assert.equal(readCheckpoint(job.id)?.retry?.attempt, attempt)
    })
  }

  it('重启后不能安全续跑时仍报告已知消耗', async () => {
    const usage = { input: 10, cacheCreation: 0, cacheRead: 0, output: 2 }
    const job = cloud.dispatch({ id: 'unsafe-spent', state: 'claimed', machine: MACHINE,
      chat: { message: 'm1', body: '继续' } })
    saveCheckpoint(job.id, { updating: true, mark: stopMark(), pending: ['write'], effects: true, started: true,
      attempts: [{ usage, costUsd: 0.25 }] })
    start()
    await until(() => job.state === 'finished')
    assert.equal(planned.length, 0)
    assert.deepEqual(job.report?.usage, usage)
    assert.equal(job.report?.costUsd, 0.25)
  })

  it('手动重试的已完成失败检查点只回报结果，不再执行', async () => {
    const job = cloud.dispatch({ id: 'manual-completed', state: 'claimed', machine: MACHINE, manualRecovery: true,
      recoveryOf: 'previous-turn', retryReplay: true, chat: { message: 'm1', body: '继续' } })
    saveCheckpoint(job.id, { updating: true, mark: stopMark(), pending: [], effects: false, started: true,
      session: 'kept', retry: { since: Date.now(), attempt: 3 }, completed: { outcome: 'failed', reason: 'quota exceeded',
        report: { recovery: { safe: true, stopped: true, resumable: true } } } })
    start()
    await until(() => job.state === 'finished')
    assert.equal(planned.length, 0)
    assert.equal(job.reason, 'quota exceeded')
    assert.equal(readCheckpoint(job.id)?.retry?.attempt, 3)
  })

  it('手动重试不重复计入已上报失败作业的消耗', async () => {
    const usage = { input: 10, cacheCreation: 0, cacheRead: 0, output: 2 }
    saveCheckpoint('charged-turn', { mark: stopMark(), pending: [], effects: false, started: true,
      attempts: [{ usage, costUsd: 0.5 }], completed: { outcome: 'failed', report: { usage, costUsd: 0.5 } } })
    const job = cloud.dispatch({ id: 'manual-spent', recoveryOf: 'charged-turn', manualRecovery: true,
      retryReplay: true, chat: { message: 'm1', body: '继续' } })
    start('', { plan: (...args) => {
      const p = fakeRuntime('console.log("done")')(...args)
      p.renderer!.events = () => []
      p.renderer!.usage = () => usage
      p.renderer!.costUsd = () => 0.25
      return p
    } })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(job.report?.usage, usage)
    assert.equal(job.report?.costUsd, 0.25)
  })

  it('重放后有修改但未取得新会话时不沿用旧工具会话', async () => {
    saveCheckpoint('old-tool', { mark: stopMark(), pending: [], effects: false, started: true, session: 'old-tool-session',
      completed: { outcome: 'failed', reason: 'capacity', report: {} } })
    const job = cloud.dispatch({ id: 'new-tool', manualRecovery: true, retryReplay: true, recoveryOf: 'old-tool',
      chat: { message: 'm1', body: '修改' } })
    start('', { plan: (...args) => {
      const p = fakeRuntime('process.exit(1)')(...args)
      p.session = () => undefined
      p.renderer!.events = () => [{ kind: 'tool_call', data: { toolCallId: 'write', title: 'write', kind: 'edit', status: 'completed' } }]
      return p
    } })
    await until(() => job.state === 'finished')
    assert.equal(planned.length, 1)
    assert.equal(job.reason, 'recovery_unsafe')
    assert.equal(readCheckpoint(job.id)?.session, undefined)
  })

  it('断联恢复沿用原会话和附件，已完成结果直接上报', async () => {
    saveCheckpoint('original', { mark: stopMark(), pending: [], started: true, session: 'original-session', retry: { since: 0, attempt: 1 } })
    const job = cloud.dispatch({ id: 'restored', recoveryOf: 'original', chat: { message: 'm1', body: '继续' }, attachments: [{ name: '图.png', content: 'aGVsbG8=' }] })
    start('', { plan: (...args) => {
      const p = fakeRuntime('console.log("恢复完成")')(...args)
      p.renderer!.events = () => []
      return p
    } })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(planned[0]?.resume, 'original-session')
    assert.match(planned[0]!.prompt, /不要重复已经执行的操作/)
    assert.match(planned[0]!.prompt, /图.png/)
  })

  it('断联恢复不重复执行未确认的写入，完成结果不再启动进程', async () => {
    saveCheckpoint('uncertain-original', { pending: [], started: true, session: 'original-session' })
    saveCheckpoint('unsafe-recovery', { pending: ['write'], started: true, session: 'current-session' })
    const unsafe = cloud.dispatch({ id: 'unsafe-recovery', recoveryOf: 'uncertain-original', chat: { message: 'm1', body: '继续' } })
    start()
    await until(() => unsafe.state === 'finished')
    assert.equal(unsafe.outcome, 'failed', unsafe.reason)
    assert.equal(unsafe.reason, 'recovery_unsafe')
    assert.equal(planned.length, 0)
    const spent = { usage: { input: 10, cacheCreation: 0, cacheRead: 0, output: 2 }, costUsd: 0.25 }
    saveCheckpoint('completed-original', { pending: [], started: true, attempts: [spent],
      completed: { outcome: 'done', report: { reply: '已有结果', ...spent } } })
    const done = cloud.dispatch({ id: 'completed-recovery', recoveryOf: 'completed-original', chat: { message: 'm1', body: '继续' } })
    await until(() => done.state === 'finished')
    assert.equal(done.report?.reply, '已有结果')
    assert.equal(done.report?.costUsd, 0.25)
    assert.deepEqual(done.report?.usage, spent.usage)
    assert.equal(planned.length, 0)
  })

  it('换机原会话缺失时用云端上下文建新会话', async () => {
    const job = cloud.dispatch({ id: 'missing-session', resume: 'absent', chat: { message: 'm1', body: '继续' }, prompt: '云端历史和最新消息' })
    start('', { plan: (...args) => {
      const resumed = !!args[3]
      const p = fakeRuntime(resumed ? 'console.error("Session not found");process.exit(1)' : 'console.log("已续接")')(...args)
      p.renderer!.result = () => resumed ? undefined : '已续接'
      p.renderer!.failure = () => resumed ? 'Session not found' : undefined
      p.renderer!.events = () => []
      return p
    } })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'failed', job.reason)
    assert.deepEqual(planned.map(p => p.resume), ['absent'])
  })

  it('Antigravity 续接失败保留会话且不新建空白会话（#687）', async () => {
    const job = cloud.dispatch({ id: 'antigravity-missing', runtime: 'antigravity', resume: 'absent', chat: { message: 'm1', body: '继续' } })
    start('', { plan: (...args) => {
      const p = fakeRuntime('console.error("Session not found");process.exit(1)')(...args)
      p.renderer!.result = () => undefined
      p.renderer!.events = () => []
      return p
    } })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'failed')
    assert.deepEqual(planned.map(p => p.resume), ['absent'])
    assert.equal(job.report?.session, 'absent')
  })

  it('换机的新会话也失败时返回清空入口所需状态', async () => {
    const job = cloud.dispatch({ id: 'new-session-failed', resume: 'absent', chat: { message: 'm1', body: '继续' } })
    start('', { plan: (...args) => {
      const p = fakeRuntime(args[3] ? 'console.error("Session not found");process.exit(1)' : 'process.exit(1)')(...args)
      p.renderer!.result = () => undefined
      p.renderer!.failure = () => 'Session not found'
      p.renderer!.events = () => []
      return p
    } })
    await until(() => job.state === 'finished')
    assert.equal(planned.length, 1)
    assert.match(job.reason!, /session/i)
  })

  it('换机会话登录失败沿用原会话且受统一预算限制', async () => {
    const job = cloud.dispatch({ id: 'signed-out-session', resume: 'existing', chat: { message: 'm1', body: '继续' } })
    start('', { plan: (...args) => {
      const p = fakeRuntime('console.error("Please login first");process.exit(1)')(...args)
      p.renderer!.result = () => undefined
      p.renderer!.failure = () => 'Please login first'
      p.renderer!.events = () => []
      return p
    } })
    await until(() => job.state === 'finished')
    assert.deepEqual(planned.map(p => p.resume), ['existing'])
    assert.match(job.reason!, /^Please login first/)
  })

  for (const recovery of [false, true]) it(`ACP 会话缺失${recovery ? '不绕过自动恢复边界' : '由 Runner 用云端上下文回退一次'}`, async () => {
    if (recovery) saveCheckpoint('acp-original', { mark: stopMark(), pending: [], started: true, session: 'absent', retry: { since: 0, attempt: 1 } })
    const job = cloud.dispatch({ id: 'acp-resume', runtime: 'cursor', resume: 'absent', recoveryOf: recovery ? 'acp-original' : null, chat: { message: 'm1', body: '继续' }, prompt: '云端文字上下文' })
    start('', { plan: (runtime, prompt, cwd, resume, model, settings, fork, language) => {
      planned.push({ runtime, prompt, cwd, resume })
      const p = runtimePlan(runtime, prompt, cwd, resume, model, settings, fork, language)
      return { ...p, command: process.execPath, args: ['-e', ACP_AGENT], env: { ...p.env, ACP_MISSING: '1' } }
    } })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'failed', job.reason)
    assert.equal(planned.length, 1)
    assert.match(job.reason!, /^Session not found/)
  })

  it('更新保留会话，断网重启后自动续跑且可再次更新', async () => {
    const job = cloud.dispatch({ id: 'update-chat', chat: { message: 'm1', body: '继续' } })
    for (let i = 0; i < 2; i++) {
      const current = start('', { plan: (...args) => {
        const p = fakeRuntime('setInterval(() => {}, 20)')(...args)
        p.renderer!.events = () => []
        return p
      } })
      await until(() => job.claims === i + 1 && readCheckpoint(job.id)?.attempts?.length === i + 1 && !!readCheckpoint(job.id)?.process)
      assert.equal(readCheckpoint(job.id)?.retry?.attempt, 1)
      await current.update()
      assert.equal(job.state, 'claimed')
      assert.equal(readCheckpoint(job.id)?.session, 'fresh-session')
      cloud.offline = true
      start()
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(job.state, 'claimed')
      await runner!.close()
      cloud.offline = false
    }
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.claims, 3)
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(planned.at(-1)?.resume, 'fresh-session')
    assert.match(planned.at(-1)!.prompt, /不要重复/)
    assert.equal(readCheckpoint(job.id), null)
  })

  it('更新时 agent 已退出但协议未结束，仍在截止时间内交接并保留恢复记录', async () => {
    const job = cloud.dispatch({ id: 'update-hung-conversation', chat: { message: 'm1', body: '继续' } })
    let childClosed = false
    let endTurn!: (value: { ok: true }) => void
    const current = start('', { stopMs: 100, plan: (...args) => ({
      ...fakeRuntime('setInterval(() => {}, 20)')(...args),
      converse: (child) => {
        child.once('close', () => { childClosed = true })
        return new Promise((resolve) => { endTurn = resolve })
      },
    }) })
    await until(() => !!readCheckpoint(job.id)?.process)
    try {
      await Promise.race([
        current.update(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('update stuck after child exit')), 3_000).unref()),
      ])
      assert.equal(childClosed, true)
      assert.equal(job.state, 'claimed')
      assert.equal(readCheckpoint(job.id)?.updating, true)
      let tookOver = false
      const next = holdMachine('terminal', () => { tookOver = true })
      try { await until(() => tookOver) } finally { next.release() }
    } finally {
      endTurn({ ok: true })
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })

  it('无法确认云端交接时暂缓更新并继续原任务', async () => {
    const job = cloud.dispatch({ id: 'deferred-update' })
    const current = start('setInterval(() => {}, 20)')
    await until(() => readCheckpoint(job.id)?.started === true)
    cloud.offline = true
    await assert.rejects(current.update(), /更新暂缓/)
    assert.notEqual(readCheckpoint(job.id)?.updating, true)
    assert.equal(job.state, 'claimed')
    cloud.offline = false
    await current.close()
  })

  it('真实执行中的未决写操作只执行一次，重启后要求检查', async () => {
    const effect = path.join(runnerHome(), 'external-effect')
    const job = cloud.dispatch({ id: 'update-effect' })
    const current = start('', { plan: (...args) => {
      const p = fakeRuntime(`require('fs').appendFileSync(${JSON.stringify(effect)}, 'x'); console.log('called'); setInterval(() => {}, 20)`)(...args)
      let emitted = false
      p.renderer!.events = () => {
        if (emitted) return []
        emitted = true
        return [{ kind: 'tool_call', data: { toolCallId: 'write', title: '外部写入', kind: 'execute', status: 'in_progress' } }]
      }
      return p
    } })
    await until(() => readCheckpoint(job.id)?.pending.includes('write') === true)
    await current.update()
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.reason, 'recovery_unsafe')
    assert.equal(fs.readFileSync(effect, 'utf8'), 'x')
    assert.equal(planned.length, 1)
  })

  it('更新停止整个执行进程树，再交接机器锁', async () => {
    const effect = path.join(runnerHome(), 'child-effect')
    const childCode = `setInterval(() => require('fs').appendFileSync(${JSON.stringify(effect)}, 'x'), 20)`
    const job = cloud.dispatch({ id: 'update-tree' })
    const current = start(`require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'inherit' }); setInterval(() => {}, 20)`)
    await until(() => fs.existsSync(effect))
    await current.update()
    const saved = fs.readFileSync(effect, 'utf8')
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(fs.readFileSync(effect, 'utf8'), saved)
    assert.equal(job.state, 'claimed')
  })

  it('更新后重放已保存的完成结果，不再调用 agent', async () => {
    const job = cloud.dispatch({ id: 'update-done', state: 'claimed', machine: MACHINE })
    saveCheckpoint(job.id, { updating: true, pending: [], completed: { outcome: 'done', report: { reply: '已完成' } } })
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.report?.reply, '已完成')
    assert.equal(planned.length, 0)
  })

  it('更新中断了未决操作时显示待检查原因，不自动重复执行', async () => {
    const job = cloud.dispatch({ id: 'update-unknown', state: 'claimed', machine: MACHINE })
    saveCheckpoint(job.id, { updating: true, session: 's1', started: true, pending: ['external-call'] })
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.reason, 'recovery_unsafe')
    assert.equal(planned.length, 0)
  })

  it('fails a job it held before it restarted rather than leaving it hanging', async () => {
    const job = cloud.dispatch({ id: 'j1', state: 'claimed', machine: MACHINE })
    cloud.runner = { machineId: MACHINE, machineName: 'studio', live: true }
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'failed')
    assert.match(job.reason!, /restarted/)
  })

  it('keeps the computer connected when another process takes over', async () => {
    const runner = start()
    await until(() => cloud.runner?.live === true)
    let waiting = false
    const next = holdMachine('claude-code', () => {}, () => (waiting = true))
    await until(() => waiting)
    await runner.close()
    assert.equal(cloud.runner?.live, true)
    next.release()
  })

  it('关闭时等待已发出的认领请求，并停止随后到达的任务（#316）', async () => {
    let claimed = false
    let allow = () => {}
    const gate = new Promise<void>((resolve) => { allow = resolve })
    const job = cloud.dispatch({ id: 'j1' })
    const current = start('setInterval(() => console.log("running"), 50)', { api: {
      ...api,
      claimJob: async (...args) => {
        const answer = await api.claimJob(...args)
        claimed = true
        await gate
        return answer
      },
    } })
    await until(() => claimed)
    let waiting = false
    let taken = false
    const next = holdMachine('codex', () => { taken = true }, () => { waiting = true })
    try {
      await until(() => waiting)
      const closing = current.close()
      assert.equal(taken, false)
      allow()
      await closing
      await until(() => taken)
      assert.equal(job.state, 'claimed')
      assert.equal(planned.length, 0)
      assert.equal(cloud.runner!.live, true)
    } finally {
      allow()
      next.release()
    }
  })

  it('releases the computer when nothing takes over', async () => {
    const runner = start()
    await until(() => cloud.runner?.live === true)
    await runner.close()
    assert.equal(cloud.runner?.live, false)
  })

  it('stops, naming the computer, when another one is the account’s Runner', async () => {
    cloud.runner = { machineId: '55555555-5555-4555-8555-555555555555', machineName: 'laptop', live: true }
    const stop = await start().stopped
    assert.deepEqual(stop, { reason: 'elsewhere', machine: 'laptop' })
  })

  it('registers with protocol 26', async () => {
    start()
    await until(() => cloud.registrations > 0)
    assert.equal(cloud.protocol, 26)
  })

  it('stops as outdated when Cloud no longer takes its protocol', async () => {
    cloud.minProtocol = 99
    assert.deepEqual(await start().stopped, { reason: 'outdated' })
  })

  it('frees the account when it quits', async () => {
    start()
    await until(() => cloud.registrations > 0)
    await runner!.close()
    assert.equal(cloud.runner!.live, false)
  })
})

describe('a task’s folder (#2037)', () => {
  const board = () => path.join(cached(), '.akb', 'kanban')
  const read = (file: string) => fs.readFileSync(path.join(board(), file), 'utf8')
  const downloads = () => cloud.log.filter((l) => l.endsWith('/file'))
  const commits = () => cloud.log.filter((l) => l.endsWith('/board/commits'))
  const CARD = 'todo/1-task-1.md'
  const BODY = '# Pricing\n\n![](hero.png) ![](shots/a.png)\n\nTiers.\n'

  beforeEach(() => {
    cloud.types.set('art_1', 'image')
    cloud.types.set('art_2', 'image')
    cloud.task = {
      artifacts: new Map([['art_1', [Buffer.from('hero-1')]], ['art_2', [Buffer.from('a-1')]]]),
      studio: { studio: 'wf_own', version: 2, files: {
        'STUDIO.md': '---\nname: Coding\n---\n',
        'references/planning.md': 'Plan it.',
        'references/notes.md': 'Notes',
      } },
    }
    cloud.put({
      [CARD]: BODY,
      'assets/task_1.json': JSON.stringify({ 'hero.png': { artifact: 'art_1', version: 1 }, 'shots/a.png': { artifact: 'art_2', version: 1 } }),
      'memory/readme.md': 'Shipped',
      'rules/project-writer.md': 'No',
    })
    cloud.putShared({ 'memory/me.md': 'Mine' })
  })

  let script = ''
  const runTask = async (id: string, edit = '', extra: Partial<FakeJob> = {}) => {
    script = edit && `process.chdir('.akb/kanban'); ${edit}`
    const job = cloud.dispatch({ id, task: 'task_1', project: 'prj_1', number: 1, studio: cloud.task.studio?.studio, ...extra })
    if (!runner) start('', { plan: (r, p, c, resume) => fakeRuntime(script)(r, p, c, resume) })
    await until(() => job.state === 'finished')
    return job
  }

  const prepareBoard = async () => {
    const result = await pull(openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cloud.folder!('prj_1')), MACHINE)
    assert.equal(result.ok, true)
  }

  for (const copy of ['empty', 'existing']) {
    it(`syncs an ${copy} current copy without conversion state (#749)`, async () => {
      if (copy === 'existing') await prepareBoard()
      const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cloud.folder!('prj_1'))
      const marker = path.join(projectStateDir(ws.board, ws.cwd), 'akb-contract.json')
      assert.equal(fs.existsSync(marker), false)
      assert.equal((await runTask('j1', `require('fs').appendFileSync('${CARD}', 'Local result.')`)).outcome, 'done')
      assert.match(cloud.file(CARD)!, /Local result/)
      assert.equal(workspaceOf(ws), 'ws_1')

      fs.writeFileSync(path.join(board(), 'memory/readme.md'), 'Unsent edit')
      cloud.put({ 'memory/readme.md': 'Remote edit' })
      assert.equal((await runTask('j2')).outcome, 'failed')
      assert.equal(read('memory/readme.md'), 'Unsent edit')
      assert.equal(cloud.file('memory/readme.md'), 'Remote edit')
      assert.equal(conflictList(board()).length, 1)
      assert.equal(fs.existsSync(marker), false)
    })
  }

  for (const asset of ['unchanged', 'unreferenced', 'referenced']) {
    it(`reply approval synchronizes ${asset} assets before deciding (#684)`, async () => {
      await prepareBoard()
      const pending = asset === 'referenced'
      cloud.serviceUnavailableUploads = asset !== 'unchanged'
      const script = `
        const fs = require('fs');
        fs.appendFileSync('todo/1-task-1.md', 'Edited before approval.');
        ${pending ? "fs.writeFileSync('todo/hero.png', 'pending edit');" : asset === 'unreferenced' ? "fs.mkdirSync('assets/1', { recursive: true }); fs.writeFileSync('assets/1/pending.json', '{}');" : ''}
        const { url, token } = JSON.parse(process.env.AI4KANBAN_REPLY_APPROVAL);
        fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ task: '1', review_revision: 1 }) })
          .then(r => r.json()).then(r => { fs.writeFileSync('reply-result.json', JSON.stringify(r)); console.log('done'); });
      `
      const job = await runTask('reply-approval', script, { chat: { message: 'm1', body: 'Start' } })
      assert.equal(job.outcome, pending ? 'failed' : 'done', job.reason)
      const answer = JSON.parse(read('reply-result.json'))
      assert.equal(answer.ok, !pending, JSON.stringify(answer))
      assert.equal(cloud.replyApprovals.length, pending ? 0 : 1)
      if (!pending) {
        assert.match(cloud.replyApprovals[0]!.card!, /Edited before approval/)
        assert.equal(cloud.replyApprovals[0]!.fields.card_version, cloud.board.get('projects/prj_1/' + CARD)!.seq)
        assert.equal(job.report?.replyApprovalSynced, true)
      } else assert.notEqual(job.report?.replyApprovalSynced, true)
    })
  }

  it('reads the board in one call, writes the card, its memory and its assets, and runs there', async () => {
    const job = await runTask('j1')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(planned[0]!.cwd, cached())
    assert.match(planned[0]!.prompt, new RegExp(`^Task card: ${path.join(board(), CARD)}`))
    assert.ok(planned[0]!.prompt.endsWith('\n\n---\n\ngo'), "Cloud's prompt was not last")
    assert.equal(read(CARD), BODY)
    assert.equal(read('todo/hero.png'), 'hero-1')
    assert.equal(read('todo/shots/a.png'), 'a-1')
    assert.equal(read('memory/readme.md'), 'Shipped')
    assert.ok(!fs.existsSync(path.join(board(), 'memory', 'me.md')), 'undeclared workspace memory reached the task')
    assert.equal(read('rules/project-writer.md'), 'No')
    assert.deepEqual(cloud.log.filter((l) => l.includes('/board')), ['GET /v1/projects/prj_1/board'])
    assert.equal(commits().length, 0, 'a job that changed nothing wrote back')
  })

  it('refuses a task whose project has no folder here, and runs nothing (#516)', async () => {
    const job = await runTask('j1', '', { project: 'prj_2', projectDir: null })
    assert.equal(job.outcome, 'failed')
    assert.equal(job.reason, NO_FOLDER)
    assert.equal(planned.length, 0)
    assert.equal(fs.existsSync(cached('prj_2')), false)
  })

  it('hands the agent the akb it carries, on the task’s board (#2020)', async () => {
    const job = await runTask('j1', 'const p = require("path"); console.log(process.env.AI4KANBAN_BOARD, require("fs").existsSync(p.join(process.env.PATH.split(p.delimiter)[0], "akb")))')
    assert.equal(job.outcome, 'done', job.reason)
    assert.match(job.events.map((e) => e.text).join(''), new RegExp(`${board()} true`))
  })

  it('runs each step on one akb, and the next on what was chosen by then, on its own shim (#171)', async () => {
    const versions = ['1.1.0', '1.2.0']
    const chosen: string[] = []
    const job = (id: string) => {
      const dispatched = cloud.dispatch({ id, task: 'task_1', project: 'prj_1', number: 1 })
      return until(() => dispatched.state === 'finished').then(() => dispatched)
    }
    start('console.log(process.env.PATH.split(require("path").delimiter)[0])', { akb: () => {
      const version = versions[chosen.length]!
      chosen.push(version)
      return fakeAkb(version)
    } })
    const one = await job('j1')
    const two = await job('j2')
    assert.deepEqual(chosen, ['1.1.0', '1.2.0'])
    assert.match(one.events.map((e) => e.text).join(''), new RegExp(path.join('1.1.0', 'shim')))
    assert.match(two.events.map((e) => e.text).join(''), new RegExp(path.join('1.2.0', 'shim')))
    assert.ok(fs.existsSync(path.join(fakeAkb('1.1.0').shim, 'akb')), 'the shim a started agent uses went')
  })

  it('tells Cloud the contract it keeps, and follows the version Cloud names (#171)', async () => {
    fs.mkdirSync(akbHome(), { recursive: true })
    fs.writeFileSync(path.join(akbHome(), 'state.json'), JSON.stringify({ current: '1.1.0', bad: [] }))
    cloud.akb = { version: null }
    start()
    await until(() => readAkbState().current === null)
    assert.equal(cloud.akbContract, AKB_CONTRACT)
  })

  it('reads the task’s studio version once into this machine’s copy, and places none of its agents (#409)', async () => {
    // Agents a Runner before #409 placed: an untouched one goes, a hand-edited one stays.
    fs.mkdirSync(path.join(board(), 'agents', 'old'), { recursive: true })
    fs.mkdirSync(path.join(board(), '.sync'), { recursive: true })
    fs.writeFileSync(path.join(board(), 'agents', 'old', 'AGENT.md'), 'Placed.')
    fs.writeFileSync(path.join(board(), 'agents', 'old', 'notes.md'), 'Edited.')
    const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex')
    fs.writeFileSync(path.join(board(), '.sync', 'agents.json'), JSON.stringify({ 'agents/old/AGENT.md': hash('Placed.'), 'agents/old/notes.md': hash('Placed.') }))

    const job = await runTask('j1')
    assert.equal(job.outcome, 'done', job.reason)
    const held = path.join(runnerHome(), 'studios')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(held, 'tasks', 'task_1.json'), 'utf8')), { studio: 'wf_own', version: 2 })
    assert.equal(JSON.parse(fs.readFileSync(path.join(held, 'versions', 'wf_own@2.json'), 'utf8')).files['references/planning.md'], 'Plan it.')
    assert.ok(!fs.existsSync(path.join(board(), 'agents', 'software-planner')), 'a studio agent was placed on the board')
    assert.ok(!fs.existsSync(path.join(board(), 'agents', 'old', 'AGENT.md')), 'an agent an earlier Runner placed stayed')
    assert.equal(read('agents/old/notes.md'), 'Edited.')
    assert.doesNotMatch(planned[0]!.prompt, /^Studio:/m)

    await runTask('j2')
    assert.equal(cloud.log.filter((l) => l === 'GET /v1/tasks/task_1/studio').length, 1, 'the pinned version was read again')

    delete cloud.task.studio
    assert.equal((await runTask('j3', '', { studio: null })).outcome, 'done', 'a task with no studio failed')
  })

  it('syncs triage as board files: what another computer sorted comes down, a move here goes up (#2107)', async () => {
    const item = (title: string, extra = '') => `---\nsource_id: derived-${title.length}\ntitle: ${title}\nimported_at: "2026-10-20 09:00"\n${extra}---\n\nWords.\n`
    cloud.put({
      'triage/annual-plan.md': item('Annual plan'),
      'triage/dismissed/sso.md': item('SSO', 'dismissed_at: "2026-10-21 09:00"\ndismissed_by: user\n'),
      'triage/archived/dark-mode.md': item('Dark mode', 'card_id: 4\narchived_at: "2026-10-21 09:00"\n'),
    })
    fs.mkdirSync(path.join(board(), 'triage'), { recursive: true })
    fs.writeFileSync(path.join(board(), 'triage', 'left-over.md'), item('Left over'))
    const edit = `
      const fs = require('fs')
      fs.mkdirSync('triage/dismissed', { recursive: true })
      fs.renameSync('triage/annual-plan.md', 'triage/dismissed/annual-plan.md')
    `
    assert.equal((await runTask('j1', edit)).outcome, 'done')
    assert.ok(!fs.existsSync(path.join(board(), 'triage', 'left-over.md')), 'a file Cloud never held stayed')
    assert.equal(read('triage/dismissed/sso.md'), cloud.file('triage/dismissed/sso.md'))
    assert.equal(read('triage/archived/dark-mode.md'), cloud.file('triage/archived/dark-mode.md'))
    assert.equal(cloud.file('triage/annual-plan.md'), null)
    assert.ok(cloud.file('triage/dismissed/annual-plan.md'))

    // Moved in Cloud meanwhile: the Runner's own move gives way to it.
    cloud.put({ 'triage/new-idea.md': item('New idea') })
    const mine = `
      const fs = require('fs')
      fs.mkdirSync('triage/archived', { recursive: true })
      fs.renameSync('triage/new-idea.md', 'triage/archived/new-idea.md')
      fs.appendFileSync('triage/archived/new-idea.md', 'card_id: 9 here')
    `
    cloud.beforeNextCommit = () => cloud.put({ 'triage/new-idea.md': null, 'triage/archived/new-idea.md': item('New idea', 'card_id: 9\ntask: task_9\n') })
    const job = await runTask('j2', mine)
    assert.equal(job.outcome, 'failed', job.reason)
    assert.match(cloud.file('triage/archived/new-idea.md')!, /task: task_9/)
    assert.match(read('triage/archived/new-idea.md'), /card_id: 9 here/)
    assert.equal(conflictList(board()).length, 1)
  })

  it('keeps the module map, settings and rules in Cloud: the first computer’s go up, and another reads them (#2106)', async () => {
    fs.mkdirSync(path.join(board(), 'rules'), { recursive: true })
    fs.writeFileSync(path.join(board(), 'modules.md'), 'Mine')
    fs.writeFileSync(path.join(board(), 'rules', 'proposer.md'), 'Use pnpm.')
    fs.writeFileSync(path.join(board(), 'rules', 'prompt-writer.md'), 'Preserve for audit.')
    assert.equal((await runTask('j1')).outcome, 'done')
    assert.equal(cloud.file('rules/prompt-writer.md'), null)
    assert.equal(read('rules/prompt-writer.md'), 'Preserve for audit.')
    assert.equal(cloud.file('modules.md'), 'Mine')
    assert.equal(cloud.file('rules/proposer.md'), 'Use pnpm.')

    // Another computer, its own blank template.
    fs.rmSync(path.join(cached(), '.akb', 'base.json'))
    fs.rmSync(board(), { recursive: true })
    fs.mkdirSync(board(), { recursive: true })
    fs.writeFileSync(path.join(board(), 'modules.md'), 'Template')
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal(read('modules.md'), 'Mine')
    assert.equal(read('rules/proposer.md'), 'Use pnpm.')
    assert.equal(cloud.file('modules.md'), 'Mine')

    // Cleared elsewhere, gone here.
    cloud.put({ 'rules/proposer.md': null, 'modules.md': 'Edited' })
    assert.equal((await runTask('j3')).outcome, 'done')
    assert.equal(read('modules.md'), 'Edited')
    assert.ok(!fs.existsSync(path.join(board(), 'rules', 'proposer.md')), 'a cleared rule came back')
    assert.equal(cloud.file('rules/proposer.md'), null)
  })

  it('writes the task index from the cards, another computer’s included (#2106)', async () => {
    cloud.put({ 'todo/2-task-2.md': '---\ntitle: From the other computer\n---\n', 'todo/3-pages/root.md': '---\ntitle: Pages\n---\n', 'todo/README.md': 'Stale' })
    assert.equal((await runTask('j1')).outcome, 'done')
    const index = read('todo/README.md')
    assert.match(index, /^- \[#1 1-task-1\]\(1-task-1\.md\)$/m)
    assert.match(index, /^- \[#2 From the other computer\]\(2-task-2\.md\)$/m)
    assert.match(index, /^- \[#3 Pages\]\(3-pages\/root\.md\)$/m)
    assert.equal(commits().length, 0, 'the index went up')
  })

  it('writes a studio’s skills into the project, only when they changed, and leaves the project’s own (#2030)', async () => {
    const skill = (root: string, file: string) => path.join(cached(), root, 'skills', file)
    fs.mkdirSync(path.dirname(skill('.claude', 'mine/SKILL.md')), { recursive: true })
    fs.writeFileSync(skill('.claude', 'mine/SKILL.md'), 'my own')
    const version = (n: number, skills: Record<string, string>) => {
      cloud.task.studio = { studio: 'wf_builtin_coding', version: n, builtin: true, files: {
        'STUDIO.md': 'x',
        'skills/mine/SKILL.md': 'not yours',
        'skills/kanban/SKILL.md': 'not the board’s',
        ...skills,
      } }
    }
    version(2, { 'skills/deck/SKILL.md': 'Make decks.', 'skills/deck/scripts/run.mjs': 'export {}' })
    await runTask('j1')
    for (const r of ['.claude', '.agents']) {
      assert.equal(fs.readFileSync(skill(r, 'deck/SKILL.md'), 'utf8'), 'Make decks.')
      assert.equal(fs.readFileSync(skill(r, 'deck/scripts/run.mjs'), 'utf8'), 'export {}')
    }
    assert.equal(fs.readFileSync(skill('.claude', 'mine/SKILL.md'), 'utf8'), 'my own')
    assert.ok(!fs.existsSync(skill('.agents', 'mine')), 'a skill the project holds was written beside it')
    assert.ok(!fs.existsSync(skill('.claude', 'kanban')), 'the kanban skill was replaced')
    assert.equal(spawnSync('git', ['-C', cached(), 'status', '--porcelain', '--', '.agents'], { encoding: 'utf8' }).stdout, '', 'a skill reached git')

    const stamp = fs.statSync(skill('.claude', 'deck/SKILL.md')).mtimeMs
    await runTask('j2')
    assert.equal(fs.statSync(skill('.claude', 'deck/SKILL.md')).mtimeMs, stamp, 'an unchanged skill was rewritten')

    // The task moved onto a newer version.
    version(3, { 'skills/slides/SKILL.md': 'Slides.' })
    fs.rmSync(path.join(runnerHome(), 'studios', 'tasks', 'task_1.json'))
    await runTask('j3')
    assert.equal(fs.readFileSync(skill('.agents', 'slides/SKILL.md'), 'utf8'), 'Slides.')
    assert.ok(!fs.existsSync(skill('.claude', 'deck')), 'a skill the version dropped stayed')
    assert.equal(fs.readFileSync(skill('.claude', 'mine/SKILL.md'), 'utf8'), 'my own')
  })

  it('writes back every file the job changed in one call, on the seq each was read at', async () => {
    const edit = `
      const fs = require('fs')
      fs.mkdirSync('rules', { recursive: true })
      fs.writeFileSync('rules/proposer.md', 'Yes')
      fs.mkdirSync('memory/agents/qa-manager', { recursive: true })
      fs.writeFileSync('memory/agents/qa-manager/notes.md', 'Flaky')
      fs.writeFileSync('todo/README.md', 'generated')
      fs.mkdirSync('triage', { recursive: true })
      fs.writeFileSync('triage/idea.md', 'An idea')
      fs.rmSync('memory/readme.md')
    `
    const job = await runTask('j1', edit)
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(commits().length, 1)
    assert.equal(cloud.file('rules/proposer.md'), 'Yes')
    assert.equal(cloud.file('memory/agents/qa-manager/notes.md'), null)
    assert.equal(cloud.file('triage/idea.md'), 'An idea', 'a triage file stayed behind (#2107)')
    assert.equal(cloud.file('memory/readme.md'), null)
    assert.ok(!cloud.board.has('projects/prj_1/todo/README.md'), 'a generated file went up')

    // What was written is now the base: the next job writes nothing.
    await runTask('j2')
    assert.equal(commits().length, 1)
  })

  it('reads only what changed since, sending a hand edit made outside a job first (#59)', async () => {
    await runTask('j1')
    assert.equal(downloads().length, 2)
    const stamp = fs.statSync(path.join(board(), CARD)).mtimeMs
    fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'edited by hand')
    fs.writeFileSync(path.join(board(), 'todo', '9-stray.md'), 'stray')
    await runTask('j2')
    assert.equal(downloads().length, 2, 'an unchanged asset was downloaded again')
    assert.equal(fs.statSync(path.join(board(), CARD)).mtimeMs, stamp, 'an unchanged card was rewritten')
    assert.equal(read('memory/readme.md'), 'edited by hand')
    assert.equal(cloud.file('memory/readme.md'), 'edited by hand')
    assert.equal(cloud.file('todo/9-stray.md'), 'stray')
    assert.equal(commits().length, 1)

    cloud.task.artifacts.get('art_1')!.push(Buffer.from('hero-2'))
    cloud.put({ 'memory/readme.md': 'Shipped again', 'assets/task_1.json': JSON.stringify({ 'hero.png': { artifact: 'art_1', version: 2 }, 'shots/a.png': { artifact: 'art_2', version: 1 } }) })
    await runTask('j3')
    assert.deepEqual(downloads().slice(2), ['GET /v1/artifacts/art_1/versions/2/file'])
    assert.equal(read('todo/hero.png'), 'hero-2')
    assert.equal(read('memory/readme.md'), 'Shipped again')
  })

  for (const protection of ['none', 'card', 'asset', 'running']) {
    it(`cleans Cloud-deleted archive indexes safely (${protection}, #713)`, async () => {
      await prepareBoard()
      const archive = '.archive/1-task-1.md'
      cloud.put({ [CARD]: null, [archive]: BODY })
      const ws = keptBoard(cached())!
      assert.ok((await pullChanges(ws)).ok)
      fs.copyFileSync(path.join(board(), 'todo/hero.png'), path.join(board(), '.archive/hero.png'))
      fs.mkdirSync(path.join(board(), '.archive/shots'), { recursive: true })
      fs.copyFileSync(path.join(board(), 'todo/shots/a.png'), path.join(board(), '.archive/shots/a.png'))
      if (protection === 'card') fs.appendFileSync(path.join(board(), archive), 'Local draft')
      if (protection === 'asset') fs.writeFileSync(path.join(board(), '.archive/hero.png'), 'Local image')
      const release = protection === 'running' ? hold(cached()) : () => {}
      try {
        cloud.put({ [archive]: null })
        assert.equal((await pullChanges(ws)).ok, protection !== 'card')
        assert.equal((await pullChanges(ws)).ok, protection !== 'card', 'repeated delete/reconnect is safe')
        const index = path.join(board(), '.sync/task_1.json')
        assert.equal(fs.existsSync(index), protection !== 'none')
        if (protection === 'card') {
          assert.match(read(archive), /Local draft/)
          assert.equal(conflictList(board()).length, 1)
        }
        if (protection === 'asset') assert.equal(read('.archive/hero.png'), 'Local image')
        assert.equal((await pushBoard(ws, MACHINE)).ok, protection !== 'card')
        assert.equal(cloud.file(archive), null, 'deleted archive must not be recreated')
      } finally { release() }
      if (protection === 'running') {
        assert.ok((await pullChanges(ws)).ok)
        assert.equal(fs.existsSync(path.join(board(), '.sync/task_1.json')), false)
      }
    })
  }

  it('keeps an edited archive through full pulls without reviving Cloud content (#713)', async () => {
    await prepareBoard()
    const archive = '.archive/1-task-1.md'
    cloud.put({ [CARD]: null, [archive]: BODY })
    const ws = keptBoard(cached())!
    assert.ok((await pullChanges(ws)).ok)
    fs.appendFileSync(path.join(board(), archive), 'Unsent draft')
    cloud.put({ [archive]: null })
    for (let i = 0; i < 2; i++) {
      assert.equal((await pull(ws, MACHINE)).ok, false)
      assert.match(read(archive), /Unsent draft/)
      assert.equal(cloud.file(archive), null)
      assert.equal(fs.existsSync(path.join(board(), '.sync/task_1.json')), i === 0)
      assert.equal(conflictList(board()).length, 1)
      if (i === 0) fs.rmSync(path.join(board(), '.sync/task_1.json'))
    }
  })

  it('pulls a restored task over an old local archive move and saves its divergent copy (#807)', async () => {
    await prepareBoard()
    const archive = '.archive/1-task-1.md'
    cloud.put({ [CARD]: null, [archive]: BODY })
    const ws = keptBoard(cached())!
    assert.ok((await pullChanges(ws)).ok)
    fs.appendFileSync(path.join(board(), archive), 'Unsent draft')
    const restored = '---\ntitle: Pricing\nstatus: todo\nrestored: 2026-11-17T01:00:00Z\n---\n' + BODY
    cloud.put({ [archive]: null, [CARD]: restored })
    assert.ok((await pullChanges(ws)).ok)
    assert.equal(read(CARD), restored)
    assert.ok(!fs.existsSync(path.join(board(), archive)))
    const saved = fs.readdirSync(path.join(board(), '.sync/restored'))
    assert.equal(saved.length, 1)
    assert.match(fs.readFileSync(path.join(board(), '.sync/restored', saved[0]!, archive), 'utf8'), /Unsent draft/)
    const record = JSON.parse(fs.readFileSync(path.join(board(), '.sync/task_1.json'), 'utf8'))
    assert.equal(record.deleted, undefined)
    assert.ok((await pushBoard(ws, MACHINE)).ok)
    assert.equal(cloud.file(archive), null)
    assert.equal(cloud.file(CARD), restored)
  })

  it('reclaims old orphan indexes only when Cloud confirms the task is gone (#713)', async () => {
    await prepareBoard()
    const ws = keptBoard(cached())!
    for (const [id, status] of [['old', 'gone'], ['live', 'done'], ['unknown', 'down']]) {
      fs.writeFileSync(path.join(board(), `.sync/task_${id}.json`), JSON.stringify({ task: `task_${id}`, number: 99, assets: {} }))
      cloud.taskStatus[`task_${id}`] = status!
    }
    assert.ok((await pullChanges(ws)).ok)
    assert.equal(fs.existsSync(path.join(board(), '.sync/task_old.json')), false)
    assert.ok(fs.existsSync(path.join(board(), '.sync/task_live.json')))
    assert.ok(fs.existsSync(path.join(board(), '.sync/task_unknown.json')))
  })

  it('keeps a card archived outside a job archived on the next job (#59)', async () => {
    await runTask('j1')
    fs.mkdirSync(path.join(board(), '.archive'), { recursive: true })
    fs.renameSync(path.join(board(), CARD), path.join(board(), '.archive', '1-task-1.md'))
    const job = await runTask('j2')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(cloud.file(CARD), null)
    assert.equal(cloud.file('.archive/1-task-1.md'), BODY)
    assert.ok(!fs.existsSync(path.join(board(), CARD)), 'the next job brought the card back')
    assert.equal(read('.archive/1-task-1.md'), BODY)
  })

  it('hands preflight conflicts to the task and preserves both versions if unresolved (#806)', async () => {
    await runTask('j1')
    fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'edited by hand')
    cloud.put({ 'memory/readme.md': 'Shipped elsewhere' })
    const job = await runTask('j2')
    assert.equal(job.outcome, 'failed', job.reason)
    assert.equal(read('memory/readme.md'), 'edited by hand')
    assert.equal(cloud.file('memory/readme.md'), 'Shipped elsewhere')
    assert.equal(conflictList(board()).length, 1)
  })

  it('retains a removed card draft and refuses the entire conflicting batch (#806)', async () => {
    await runTask('j1')
    fs.writeFileSync(path.join(board(), CARD), 'edited by hand')
    fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'Shipped here')
    cloud.put({ [CARD]: null, '.archive/1-task-1.md': 'archived' })
    const job = await runTask('j2')
    assert.equal(job.outcome, 'failed', job.reason)
    assert.equal(cloud.file(CARD), null)
    assert.equal(cloud.file('.archive/1-task-1.md'), 'archived')
    assert.equal(cloud.file('memory/readme.md'), 'Shipped')
    assert.equal(read(CARD), 'edited by hand')
    assert.equal(conflictList(board()).length, 1)
  })

  it('requires an explicit decision for memory edits against deletion (#806)', async () => {
    await runTask('j1')
    fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'edited by hand')
    cloud.put({ 'memory/readme.md': null })
    const job = await runTask('j2')
    assert.equal(job.outcome, 'failed', job.reason)
    assert.equal(cloud.file('memory/readme.md'), null)
    assert.equal(read('memory/readme.md'), 'edited by hand')
    const facts = conflictShow(board(), conflictList(board())[0]!.id).files[0]!
    assert.equal(facts.reason, 'edit-delete')
    assert.ok(facts.remote.seq > facts.base.seq)
  })

  it('sends a board change as it is made, close ones together, and what waited at the start (#59)', async () => {
    await runTask('j1')
    await runner!.close()
    // Changed while no Runner ran: sent as the next one starts.
    fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'while away')
    start('', { watchMs: 50 })
    await until(() => cloud.file('memory/readme.md') === 'while away')
    assert.equal(commits().length, 1)
    fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'one')
    fs.writeFileSync(path.join(board(), 'rules', 'proposer.md'), 'two')
    fs.writeFileSync(path.join(board(), 'todo', 'README.md'), 'generated')
    await until(() => commits().length === 2)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(commits().length, 2, 'close changes went as more than one write')
    assert.equal(cloud.file('memory/readme.md'), 'one')
    assert.equal(cloud.file('rules/proposer.md'), 'two')
    assert.ok(!cloud.board.has('projects/prj_1/todo/README.md'), 'a generated file went up')
  })

  for (const count of [300, 3000]) {
    it(`checks no historical files for one active edit or idle sync with ${count} archived tasks (#712)`, async (t) => {
      await prepareBoard()
      const ws = keptBoard(cached())!
      const archived: Record<string, string> = {}
      fs.mkdirSync(path.join(board(), '.archive'), { recursive: true })
      for (let n = 10; n < count + 10; n++) {
        const p = `.archive/${n}-done.md`
        archived[p] = `---\ntitle: Done ${n}\n---\n`
        fs.writeFileSync(path.join(board(), p), archived[p]!)
        fs.writeFileSync(path.join(board(), '.sync', `task_history_${n}.json`), JSON.stringify({ task: `task_history_${n}`, number: n, assets: {} }))
      }
      cloud.put(archived)
      assert.ok((await pullChanges(ws)).ok)
      assert.ok((await pushBoard(ws, MACHINE)).ok)
      const history: string[] = []
      const read = fs.readFileSync
      const list = fs.readdirSync
      const track = (file: unknown) => {
        if (String(file).includes('/.archive') || /\.sync\/task_history_/.test(String(file))) history.push(String(file))
      }
      t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof read>) => { track(args[0]); return read(...args) })
      t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof list>) => { track(args[0]); return list(...args) })
      fs.appendFileSync(path.join(board(), CARD), '\nActive edit.\n')
      assert.ok((await pushBoard(ws, MACHINE, [CARD])).ok)
      assert.match(cloud.file(CARD)!, /Active edit/)
      const before = cloud.log.length
      assert.deepEqual(await pushBoard(ws, MACHINE, []), { ok: true, changed: false })
      assert.equal(cloud.log.length, before)
      assert.deepEqual(history, [])
      t.mock.restoreAll()
      const archivedPath = '.archive/10-done.md'
      fs.appendFileSync(path.join(board(), archivedPath), '\nLocal archive edit.\n')
      assert.ok((await pushBoard(ws, MACHINE)).ok)
      assert.match(cloud.file(archivedPath)!, /Local archive edit/)
      cloud.put({ [archivedPath]: 'Cloud archive edit' })
      assert.ok((await pullChanges(ws)).ok)
      assert.equal(readText(archivedPath), 'Cloud archive edit')
      function readText(p: string) { return fs.readFileSync(path.join(board(), p), 'utf8') }
      fs.rmSync(path.join(board(), archivedPath))
      const own = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cached())
      assert.ok((await pull(own, MACHINE)).ok)
      // The local deletion was uploaded; recovery must not resurrect it.
      assert.equal(cloud.file(archivedPath), null)
      const restored = fs.mkdtempSync(path.join(runnerHome(), 'archive-restore-'))
      assert.ok((await pull(openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, restored), MACHINE)).ok)
      assert.equal(fs.readFileSync(path.join(restored, '.akb/kanban/.archive/11-done.md'), 'utf8'), archived['.archive/11-done.md'])
    })
  }

  it('watches asset dependencies outside the board and retries a failed write without another edit (#712)', async () => {
    await prepareBoard()
    const ws = keptBoard(cached())!
    const assets = path.join(projectStateDir(board()), 'assets/1')
    fs.mkdirSync(assets, { recursive: true })
    fs.writeFileSync(path.join(assets, 'page.html'), '<img src="image.png">')
    fs.writeFileSync(path.join(assets, 'image.png'), 'first')
    fs.appendFileSync(path.join(board(), CARD), '\n<Asset src=".assets/1/page.html" />\n')
    assert.ok((await pushBoard(ws, MACHINE)).ok)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    const artifact = refs['.assets/1/image.png'].artifact
    const watch = watchBoards(MACHINE, 20, 100)
    try {
      await new Promise(resolve => setTimeout(resolve, 100))
      cloud.serviceUnavailableUploads = true
      fs.writeFileSync(path.join(assets, 'image.png'), 'retry dependency')
      await until(() => unsent(cached()))
      cloud.serviceUnavailableUploads = false
      await until(() => cloud.task.artifacts.get(artifact)!.at(-1)!.toString() === 'retry dependency')
      await until(() => !unsent(cached()))
      const before = commits().length
      watch.look()
      await new Promise(resolve => setTimeout(resolve, 150))
      assert.equal(commits().length, before)
    } finally { watch.close() }
  })

  it('recovers a missing record, retries pending assets and syncs archive moves and deletes (#712)', async () => {
    await prepareBoard()
    const ws = keptBoard(cached())!
    assert.ok((await pushBoard(ws, MACHINE)).ok)
    fs.rmSync(path.join(board(), '.sync/task_1.json'))
    fs.writeFileSync(path.join(board(), 'todo/hero.png'), 'changed attachment')
    fs.appendFileSync(path.join(board(), CARD), '\nPending draft.\n')
    cloud.serviceUnavailableUploads = true
    assert.equal((await pushBoard(ws, MACHINE, ['todo/hero.png', CARD])).ok, false)
    cloud.serviceUnavailableUploads = false
    assert.ok((await pushBoard(ws, MACHINE, [])).ok)
    assert.match(cloud.file(CARD)!, /Pending draft/)
    assert.equal(cloud.task.artifacts.get('art_1')!.at(-1)!.toString(), 'changed attachment')
    // Move the card and its relative dependencies together.
    fs.renameSync(path.join(board(), 'todo'), path.join(board(), '.archive'))
    assert.ok((await pushBoard(ws, MACHINE, ['todo', '.archive'])).ok)
    assert.equal(cloud.file(CARD), null)
    assert.match(cloud.file('.archive/1-task-1.md')!, /Pending draft/)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    const versions = cloud.task.artifacts.get('art_1')!
    versions.push(Buffer.from('remote archive image'))
    refs['hero.png'].version = versions.length
    cloud.put({ 'assets/task_1.json': JSON.stringify(refs) })
    assert.ok((await pullChanges(ws)).ok)
    assert.ok((await pushBoard(ws, MACHINE, ['assets/task_1.json'])).ok)
    assert.equal(read('.archive/hero.png'), 'remote archive image')
    const remoteCount = versions.length
    fs.writeFileSync(path.join(board(), '.archive/hero.png'), 'unuploaded local image')
    versions.push(Buffer.from('another remote image'))
    refs['hero.png'].version = versions.length
    cloud.put({ 'assets/task_1.json': JSON.stringify(refs) })
    assert.ok((await pullChanges(ws)).ok)
    assert.ok((await pushBoard(ws, MACHINE, ['assets/task_1.json', '.archive/hero.png'])).ok)
    assert.equal(read('.archive/hero.png'), 'unuploaded local image')
    assert.equal(versions.at(-1)!.toString(), 'unuploaded local image')
    assert.equal(versions.length, remoteCount + 2)
    fs.rmSync(path.join(board(), '.archive'), { recursive: true })
    assert.ok((await pushBoard(ws, MACHINE, ['.archive'])).ok)
    assert.equal(cloud.file('.archive/1-task-1.md'), null)
  })

  it('syncs 10 MiB board documents and preserves the remote copy when over the limit (#667)', async () => {
    await prepareBoard()
    const target = path.join(board(), 'memory/readme.md')
    const content = 'x'.repeat(10 * 1024 * 1024)
    fs.writeFileSync(target, content)
    assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, true)
    assert.equal(cloud.file('memory/readme.md'), content)
    fs.appendFileSync(target, 'x')
    const refused = await pushBoard(keptBoard(cached())!, MACHINE)
    assert.equal(refused.ok, false)
    assert.equal(cloud.file('memory/readme.md'), content)
    assert.equal(fs.statSync(target).size, content.length + 1)
  })

  it('uploads multipart assets before publishing their version (#667)', async () => {
    await prepareBoard()
    cloud.multipartSize = 1024 * 1024
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 3, 7)
    fs.writeFileSync(path.join(board(), 'todo/large.png'), bytes)
    fs.appendFileSync(path.join(board(), CARD), '\n<Asset src="large.png" />\n')
    const sent = await pushBoard(keptBoard(cached())!, MACHINE)
    assert.equal(sent.ok, true, JSON.stringify(sent))
    const ref = JSON.parse(cloud.file('assets/task_1.json')!)['large.png']
    assert.deepEqual(cloud.task.artifacts.get(ref.artifact)![ref.version - 1], bytes)
    const complete = cloud.log.findIndex((line) => line.endsWith('/complete'))
    const version = cloud.log.findIndex((line) => line === `POST /v1/artifacts/${ref.artifact}/versions`)
    assert.ok(complete >= 0 && version > complete)
  })

  it('takes a folder’s writes in turn: the same change goes once (#59)', async () => {
    await prepareBoard()
    fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'once')
    const ws = keptBoard(cached())!
    const sent = await Promise.all([pushBoard(ws, MACHINE), pushBoard(ws, MACHINE), pull(openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cloud.folder!('prj_1')), MACHINE)])
    assert.deepEqual(sent.map((s) => s.ok), [true, true, true])
    assert.equal(commits().length, 1)
    assert.equal(cloud.file('memory/readme.md'), 'once')
    assert.equal(read('memory/readme.md'), 'once')
  })

  for (const archived of [false, true]) {
    it(`runs another task when an edited attachment belongs to a closed card (${archived ? 'archived' : 'still in todo'})`, async () => {
      const card = archived ? '.archive/1-task-1.md' : CARD
      if (archived) cloud.put({ [CARD]: null, [card]: BODY })
      await prepareBoard()
      cloud.closedArtifacts.add('art_1')
      fs.writeFileSync(path.join(board(), path.dirname(card), 'hero.png'), 'local draft')
      if (!archived) fs.appendFileSync(path.join(board(), card), '\nLocal card draft.\n')
      fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'unrelated change')

      const job = await runTask('j2', '', { task: 'task_2', number: 2 })
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal(cloud.file('memory/readme.md'), 'unrelated change')
      assert.equal(cloud.task.artifacts.get('art_1')!.length, 1)
      assert.equal(read(path.join(path.dirname(card), 'hero.png')), 'local draft')
      assert.equal(cloud.file(card), BODY)
      if (!archived) assert.match(read(card), /Local card draft/)
      assert.equal(cloud.log.filter(line => line === 'POST /v1/artifacts/art_1/uploads').length, 1)
      if (!archived) {
        cloud.closedArtifacts.clear()
        assert.equal((await runTask('j3', '', { task: 'task_2', number: 2 })).outcome, 'done')
        assert.match(cloud.file(card)!, /Local card draft/)
        assert.equal(cloud.task.artifacts.get('art_1')!.length, 2)
      }
    })
  }

  it('keeps an unreachable attachment pending while other tasks run and publish their own assets', async () => {
    await prepareBoard()
    cloud.unreachableArtifacts.add('art_1')
    fs.writeFileSync(path.join(board(), 'todo/hero.png'), 'pending image')
    fs.appendFileSync(path.join(board(), CARD), '\nPending card draft.\n')
    fs.writeFileSync(path.join(board(), 'memory/readme.md'), 'unrelated change')
    const manifest = cloud.file('assets/task_1.json')

    const sent = await pushBoard(keptBoard(cached())!, MACHINE)
    assert.equal(sent.ok, false)
    if (!sent.ok) assert.match(sent.tasks?.task_1?.error ?? '', /hero.png: fetch failed/)
    assert.equal(cloud.file('memory/readme.md'), 'unrelated change')

    const job = await runTask('j2', `
      const fs = require('fs')
      fs.writeFileSync('todo/new.png', 'new image')
      fs.writeFileSync('todo/2-task-2.md', '# Task 2\\n\\n![](new.png)\\n')
    `, { task: 'task_2', number: 2 })
    assert.equal(job.outcome, 'done', job.reason)
    assert.ok(cloud.file('assets/task_2.json'))
    assert.equal(cloud.file(CARD), BODY)
    assert.equal(cloud.file('assets/task_1.json'), manifest)
    assert.match(read(CARD), /Pending card draft/)
    assert.equal(read('todo/hero.png'), 'pending image')
    assert.ok(unsent(cached()), 'another task cleared the pending upload')

    const own = await pull(openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cloud.folder!('prj_1')), MACHINE)
    assert.equal(own.ok, false)
    if (!own.ok) assert.match(own.error, /hero.png: fetch failed/)

    cloud.unreachableArtifacts.clear()
    const retry = await pushBoard(keptBoard(cached())!, MACHINE)
    assert.ok(retry.ok)
    assert.match(cloud.file(CARD)!, /Pending card draft/)
    assert.equal(cloud.task.artifacts.get('art_1')!.at(-1)!.toString(), 'pending image')
    assert.equal(unsent(cached()), false)
  })

  it('keeps invalid active and archived Preview drafts while a different task creates, resumes and uploads results (#880)', async () => {
    const archived = '.archive/3-old.md'
    const moved = '.archive/1-task-1.md'
    const oldArchive = '# Archived result\n\n## By `prompt-writer` agent\n\nOriginal draft.\n'
    cloud.put({ [archived]: oldArchive })
    await prepareBoard()
    cloud.previewProblems = (file, content) => {
      const relative = file.replace(/^projects\/[^/]+\//, '')
      return numberOfCard(relative) === null ? [] : taskPreviewProblems(content, ['ui-design', 'prompts'], [], relative)
    }

    const retirement = '\n## By `ui-designer` agent\n\nLocal Preview draft.\n'
    const archivedDraft = oldArchive + '\nUnsent archive edit.\n'
    const manifest = cloud.file('assets/task_1.json')
    const localManifest = JSON.stringify({ ...JSON.parse(manifest!), 'manual.png': { artifact: 'art_2', version: 1 } })
    fs.writeFileSync(path.join(board(), CARD), BODY + retirement)
    fs.writeFileSync(path.join(board(), archived), archivedDraft)
    fs.writeFileSync(path.join(board(), 'todo/hero.png'), 'unsent attachment')
    fs.writeFileSync(path.join(board(), 'assets/task_1.json'), localManifest)

    const own = await runTask('j1')
    assert.equal(own.outcome, 'failed')
    assert.match(own.reason!, /#1 todo\/1-task-1.md:7:1.*Role sections are retired.*Use a closed Preview block/)
    assert.doesNotMatch(own.reason!, /3-old/)
    const first = await runTask('j2', `
      const fs = require('fs')
      fs.writeFileSync('todo/2-task-2.md', '# Other task\\n')
    `, { task: 'task_2', number: 2 })
    assert.equal(first.outcome, 'done', first.reason)
    assert.equal(cloud.file('todo/2-task-2.md'), '# Other task\n')

    // A pending archive move must keep the existing Cloud card and its status.
    fs.renameSync(path.join(board(), CARD), path.join(board(), moved))
    fs.renameSync(path.join(board(), 'todo/hero.png'), path.join(board(), '.archive/hero.png'))
    const remoteArchive = oldArchive.replace('# Archived result', '# Updated archive')
    cloud.put({ [archived]: remoteArchive })
    const continued = await runTask('j3', `
      const fs = require('fs')
      fs.writeFileSync('todo/result.png', 'result')
      fs.appendFileSync('todo/2-task-2.md', '\\n<Asset src="result.png" />\\n')
    `, { task: 'task_2', number: 2 })
    assert.equal(continued.outcome, 'done', continued.reason)
    const ref = JSON.parse(cloud.file('assets/task_2.json')!)['result.png']
    assert.equal(cloud.task.artifacts.get(ref.artifact)![ref.version - 1]!.toString(), 'result')
    assert.equal(read(moved), BODY + retirement)
    assert.equal(read(archived), archivedDraft)
    assert.equal(read('.archive/hero.png'), 'unsent attachment')
    assert.equal(read('assets/task_1.json'), localManifest)
    assert.equal(cloud.file('assets/task_1.json'), manifest)
    assert.equal(cloud.file(CARD), BODY)
    assert.equal(cloud.file(moved), null)
    assert.equal(cloud.file(archived), remoteArchive)
    assert.ok(unsent(cached()))

    fs.writeFileSync(path.join(board(), moved), (BODY + retirement).replace('## By `ui-designer` agent', '<Preview id="ui-design">') + '</Preview>\n')
    fs.writeFileSync(path.join(board(), archived), archivedDraft.replace('## By `prompt-writer` agent', '<Preview id="prompts">') + '</Preview>\n')
    const repaired = await pushBoard(keptBoard(cached())!, MACHINE, [moved, archived])
    assert.ok(repaired.ok, JSON.stringify(repaired))
    assert.equal(cloud.file(CARD), null)
    assert.match(cloud.file(moved)!, /Local Preview draft/)
    assert.match(cloud.file(archived)!, /Updated archive[\s\S]*Unsent archive edit/)
    const repairedPin = JSON.parse(cloud.file('assets/task_1.json')!)['hero.png']
    assert.equal(cloud.task.artifacts.get(repairedPin.artifact)![repairedPin.version - 1]!.toString(), 'unsent attachment')
    assert.equal(unsent(cached()), false)
  })

  it('syncs only card assets and their declared dependencies, including multipart recovery', async () => {
    await prepareBoard()
    cloud.multipartSize = 200
    const files = new Map([
      ['../assets/1/guide.md', Buffer.from('# Guide\n\n![](nested/image.png)\n')],
      ['../assets/1/nested/image.png', Buffer.from([0, 255, 128])],
      ['.assets/1/data.bin', Buffer.alloc(600, 127)],
    ])
    for (const [name, bytes] of files) {
      const file = name.startsWith('.assets/')
        ? path.join(projectStateDir(board()), name.slice(1))
        : path.resolve(path.dirname(path.join(board(), CARD)), name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, bytes)
    }
    for (const root of [path.join(board(), 'assets/1'), path.join(projectStateDir(board()), 'assets/1')]) {
      for (const name of ['snap/snapshot.json', 'history/old.png', 'tools/check.mjs', 'build.log', 'source.url', 'node_modules/pkg/index.js']) {
        const file = path.join(root, name)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, 'unreferenced')
      }
    }
    fs.appendFileSync(path.join(board(), CARD), '\n<Asset src="../assets/1/guide.md" />\n\n<Asset src=".assets/1/data.bin" />\n')
    assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    for (const name of files.keys()) assert.ok(refs[name], name)
    assert.ok(!Object.keys(refs).some(key => /snapshot|history|tools|build.log|source.url|node_modules/.test(key)))
    assert.deepEqual(cloud.task.artifacts.get(refs['.assets/1/data.bin'].artifact)!.at(-1), files.get('.assets/1/data.bin'))
    const uploads = cloud.log.filter(line => line.endsWith('/uploads')).length
    assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
    assert.equal(cloud.log.filter(line => line.endsWith('/uploads')).length, uploads)
    const restored = fs.mkdtempSync(path.join(runnerHome(), 'restored-'))
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, restored)
    assert.ok((await pull(ws, MACHINE)).ok)
    for (const [name, bytes] of files) {
      const file = name.startsWith('.assets/')
        ? path.join(projectStateDir(ws.board), name.slice(1))
        : path.resolve(path.dirname(path.join(ws.board, CARD)), name)
      assert.deepEqual(fs.readFileSync(file), bytes, name)
    }
  })

  it('uploads mockup resources but no local checker cache or temporary sources (#719)', async () => {
    await prepareBoard()
    const assets = path.join(projectStateDir(board()), 'assets/1')
    const local = path.join(runnerHome(), '.cache/wildcrane/mockup-check')
    fs.mkdirSync(assets, { recursive: true })
    fs.writeFileSync(path.join(assets, 'page.html'), '<img alt="Preview" src="picture.png">')
    fs.writeFileSync(path.join(assets, 'picture.png'), 'preview image')
    const cacheFiles = ['env/node_modules/pkg/index.js', 'env/browsers/shell', 'work/source.tsx']
    for (const name of cacheFiles) {
      fs.mkdirSync(path.dirname(path.join(local, name)), { recursive: true })
      fs.writeFileSync(path.join(local, name), 'LOCAL_CHECKER_CACHE')
    }
    fs.writeFileSync(path.join(board(), CARD), '# Mockup\n\n<Asset src=".assets/1/page.html" />\n')
    assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.deepEqual(Object.keys(refs).sort(), ['.assets/1/page.html', '.assets/1/picture.png'])
    const uploaded = Object.values(refs as api.Assets).flatMap(ref => cloud.task.artifacts.get(ref.artifact) ?? [])
    assert.equal(uploaded.length, 2)
    assert.match(uploaded.find(bytes => bytes.toString().includes('<img'))!.toString(), new RegExp(refs['.assets/1/picture.png'].artifact))
    assert.ok(uploaded.some(bytes => bytes.toString() === 'preview image'))
    assert.ok(uploaded.every(bytes => !bytes.toString().includes('LOCAL_CHECKER_CACHE')))
    const puts = () => cloud.log.filter(line => line.startsWith('PUT /v1/uploads/')).length
    const storedBytes = () => [...cloud.task.artifacts.values()].flat().reduce((sum, file) => sum + file.byteLength, 0)
    const count = puts(), bytes = storedBytes()
    for (let revision = 0; revision < 2; revision++) {
      fs.writeFileSync(path.join(local, 'work/source.tsx'), `revision ${revision}`)
      assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
      assert.equal(puts(), count)
      assert.equal(storedBytes(), bytes)
    }
    fs.symlinkSync(path.join(local, 'env/browsers/shell'), path.join(assets, 'cache.bin'))
    fs.appendFileSync(path.join(board(), CARD), '\n<Asset src=".assets/1/cache.bin" />\n')
    assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
    assert.match(JSON.parse(cloud.file('assets/task_1.json')!)['.assets/1/cache.bin'].error, /outside the board/)
    assert.equal(puts(), count)
  })

  it('reuses a newly created artifact when an upload fails and is retried', async () => {
    await prepareBoard()
    const file = path.join(board(), 'todo/data.bin')
    fs.writeFileSync(file, 'new attachment')
    fs.appendFileSync(path.join(board(), CARD), '\n<Asset src="data.bin" />\n')
    cloud.serviceUnavailableUploads = true
    assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, false)
    const created = cloud.log.filter(line => line === 'POST /v1/tasks/task_1/artifacts').length
    assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, false)
    assert.equal(cloud.log.filter(line => line === 'POST /v1/tasks/task_1/artifacts').length, created)
    cloud.serviceUnavailableUploads = false
    assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
    assert.equal(cloud.log.filter(line => line === 'POST /v1/tasks/task_1/artifacts').length, created)
    const uploads = cloud.log.filter(line => line.endsWith('/uploads')).length
    fs.appendFileSync(path.join(board(), CARD), '\n<Asset src="./data.bin" />\n')
    assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
    assert.equal(cloud.log.filter(line => line.endsWith('/uploads')).length, uploads)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.deepEqual(refs['data.bin'], refs['./data.bin'])
  })

  it('retains safe retry evidence when required asset sync fails before the reply starts', async () => {
    await prepareBoard()
    fs.writeFileSync(path.join(board(), 'todo/hero.png'), 'local edit')
    cloud.serviceUnavailableUploads = true
    const job = await runTask('sync-before-reply', '', { chat: { message: 'm1', body: 'Explain this' } })
    assert.equal(job.outcome, 'failed')
    assert.match(job.reason!, /board changes could not be sent/)
    assert.equal(planned.length, 0)
    assert.deepEqual(job.report?.recovery, { safe: true, stopped: true, resumable: false })
    assert.equal(readCheckpoint(job.id)?.started, false)
    cloud.serviceUnavailableUploads = false
    const retried = await runTask('retry-sync', '', {
      chat: { message: 'm1', body: 'Explain this' }, recoveryOf: job.id, manualRecovery: true, retryReplay: true,
    })
    assert.equal(retried.outcome, 'done', retried.reason)
    assert.equal(planned.length, 1)
  })

  it('ignores unrelated oversized files while syncing a task reply', async () => {
    const job = await runTask('new-asset', `
      const fs = require('fs')
      fs.mkdirSync('assets/1', { recursive: true })
      fs.writeFileSync('assets/1/large.bin', '')
      fs.truncateSync('assets/1/large.bin', 101 * 1024 ** 2)
      fs.appendFileSync('${CARD}', '\\nSafe new edit.\\n')
    `)
    assert.equal(job.outcome, 'done', job.reason)
    assert.match(cloud.file(CARD)!, /Safe new edit/)
    assert.ok(!JSON.parse(cloud.file('assets/task_1.json')!)['../assets/1/large.bin'])
    assert.equal(unsent(cached()), false)
  })

  for (const code of ['storage_limit_reached', 'unauthenticated']) {
    it(`preserves referenced upload failures: ${code}`, async () => {
      await prepareBoard()
      cloud.refusedUploads.set('art_1', code)
      fs.writeFileSync(path.join(board(), 'todo/hero.png'), 'required edit')
      const job = await runTask('strict')
      assert.equal(job.outcome, 'failed')
      assert.match(job.reason!, /上传被拒绝/)
    })
  }

  describe('a board change while a job runs (#300)', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const change = (text: string) => fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), text)
    let watch: ReturnType<typeof watchBoards> | null = null
    let release = () => {}
    afterEach(() => {
      release()
      watch?.close()
    })

    it('goes at most once a spell, the latest change with it', async () => {
      await prepareBoard()
      const before = commits().length
      watch = watchBoards(MACHINE, 20, 60_000, 50, 800)
      await sleep(50)
      release = hold(cached())
      change('first')
      await until(() => cloud.file('memory/readme.md') === 'first')
      for (const text of ['second', 'third', 'fourth']) {
        change(text)
        await sleep(40)
      }
      assert.equal(commits().length, before + 1, 'a job’s changes went more than once a spell')
      await until(() => cloud.file('memory/readme.md') === 'fourth')
      assert.equal(commits().length, before + 2)
    })

    it('goes as the job ends', async () => {
      await prepareBoard()
      watch = watchBoards(MACHINE, 20, 60_000, 50, 60_000)
      await sleep(50)
      release = hold(cached())
      change('first')
      await until(() => cloud.file('memory/readme.md') === 'first')
      change('last')
      await sleep(100)
      assert.equal(cloud.file('memory/readme.md'), 'first')
      release()
      watch.look()
      await until(() => cloud.file('memory/readme.md') === 'last')
    })

    it('leaves the wait behind once no job runs', async () => {
      await prepareBoard()
      watch = watchBoards(MACHINE, 20, 60_000, 50, 60_000)
      await sleep(50)
      release = hold(cached())
      change('first')
      await until(() => cloud.file('memory/readme.md') === 'first')
      release()
      change('by hand')
      await until(() => cloud.file('memory/readme.md') === 'by hand')
    })
  })

  describe('Cloud’s changes between jobs (#103)', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const reads = () => cloud.log.filter((l) => l.startsWith('GET /v1/projects/prj_1/board')).length
    let watch: ReturnType<typeof watchBoards> | null = null
    afterEach(() => watch?.close())

    it('reads once for hints close together, dropping its own push and versions already read', async () => {
      await prepareBoard()
      watch = watchBoards(MACHINE, 60_000, 60_000, 50)
      const before = reads()
      cloud.put({ 'memory/readme.md': 'From the page' })
      watch.hint('prj_1', cloud.head, MACHINE)
      watch.hint('prj_1', readHead(keptBoard(cached())!)!)
      watch.hint('prj_2', cloud.head)
      await sleep(150)
      assert.equal(reads(), before, 'a dropped hint read the board')
      watch.hint('prj_1', cloud.head)
      watch.hint('prj_1', cloud.head)
      await until(() => read('memory/readme.md') === 'From the page')
      await sleep(150)
      assert.equal(reads(), before + 1)
      assert.equal(readHead(keptBoard(cached())!), cloud.head)
    })

    it('saves incremental conflicts without refreshing local work or launching an idle agent (#806)', async () => {
      await prepareBoard()
      watch = watchBoards(MACHINE, 60_000, 60_000, 50)
      fs.writeFileSync(path.join(board(), 'memory/readme.md'), 'mine')
      cloud.put({ 'memory/readme.md': 'theirs' })
      watch.hint('prj_1', cloud.head)
      await until(() => conflictList(board()).length === 1)
      const id = conflictList(board())[0]!.id
      assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, false)
      assert.equal((await pullChanges(keptBoard(cached())!)).ok, false)
      assert.equal(conflictList(board())[0]!.id, id)
      assert.equal(read('memory/readme.md'), 'mine')
      assert.equal(cloud.file('memory/readme.md'), 'theirs')
      assert.equal(planned.length, 0)
      assert.ok(unsent(cached()))
    })

    it('reads a folder a job holds once the job is over', async () => {
      await prepareBoard()
      watch = watchBoards(MACHINE, 60_000, 60_000, 50)
      const release = hold(cached())
      cloud.put({ 'memory/readme.md': 'During the job' })
      watch.hint('prj_1', cloud.head)
      await sleep(150)
      assert.equal(read('memory/readme.md'), 'Shipped', 'a held folder was written')
      release()
      watch.look()
      await until(() => read('memory/readme.md') === 'During the job')
    })

    it('reads on its poll when no hint can arrive', async () => {
      await prepareBoard()
      start('', { watchMs: 50 })
      cloud.put({ 'memory/readme.md': 'Polled' })
      await until(() => read('memory/readme.md') === 'Polled')
    })
  })

  it('sends a .tsx mockup as the page it draws, again when a file beside it changes (#2003)', async () => {
    const edit = (label: string) => `
      const fs = require('fs')
      const dir = '../boards/.akb/kanban/assets/1'
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(dir + '/page.tsx', 'import Plan from "./Plan"\\nimport "./style.css"\\nexport default () => <main className="p-4"><Plan /></main>')
      fs.writeFileSync(dir + '/Plan.tsx', 'export default function Plan() { return <h1 className="plan">${label}</h1> }')
      fs.writeFileSync(dir + '/style.css', '@import "tailwindcss";\\n.plan { color: teal }')
      fs.writeFileSync(dir + '/copy.md', '# Plans')
      const card = '${CARD}'
      const body = fs.readFileSync(card, 'utf8')
      if (!body.includes('page.tsx')) fs.writeFileSync(card, body + '\\n\\n<Asset src=".assets/1/page.tsx" label="Page" />\\n\\n<Asset src=".assets/1/copy.md" label="Copy" />\\n')
    `
    const assets = () => JSON.parse(cloud.file('assets/task_1.json')!)
    assert.equal((await runTask('j1', edit('Free'))).outcome, 'done')
    const ref = assets()['.assets/1/page.tsx']
    assert.equal(cloud.types.get(ref.artifact), 'html')
    assert.equal(cloud.types.get(assets()['.assets/1/copy.md'].artifact), 'markdown')
    const page = cloud.task.artifacts.get(ref.artifact)![0]!.toString()
    assert.match(page, /^<!doctype html>/)
    assert.match(page, /<main class="p-4"><h1 class="plan">Free<\/h1><\/main>/)
    assert.match(page, /\.plan \{\s*color: teal/)
    assert.match(page, /padding:/, 'Tailwind did not style the page')

    assert.equal((await runTask('j2', edit('Plus'))).outcome, 'done')
    assert.deepEqual(assets()['.assets/1/page.tsx'], { artifact: ref.artifact, version: 2, dependencies: [] })
    assert.match(cloud.task.artifacts.get(ref.artifact)![1]!.toString(), />Plus</)
    assert.match(fs.readFileSync(path.join(cached(), '.akb', 'boards', '.akb', 'kanban', 'assets', '1', 'page.tsx'), 'utf8'), /^import Plan/,
      'the drawn page was written over its source')
  })

  it('stores a studio diagram as a studio, also one first pushed as a plain file (#484)', async () => {
    const tag = (name: string) => `
      const fs = require('fs')
      const dir = '../boards/.akb/kanban/assets/1'
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(dir + '/studio.json', JSON.stringify({ version: 1, rounds: [[{ agent: 'a', title: { en: 'A' } }]], land: [], scheduled: [] }))
      const body = fs.readFileSync('${CARD}', 'utf8').replace(/\\n<(Asset|Studio) src="\\.assets\\/1\\/studio\\.json" \\/>\\n/, '')
      fs.writeFileSync('${CARD}', body + '\\n<${name} src=".assets/1/studio.json" />\\n')
    `
    const type = () => cloud.types.get(JSON.parse(cloud.file('assets/task_1.json')!)['.assets/1/studio.json'].artifact)
    assert.equal((await runTask('j1', tag('Asset'))).outcome, 'done')
    assert.equal(type(), 'asset')
    assert.equal((await runTask('j2', tag('Studio'))).outcome, 'done')
    assert.equal(type(), 'studio')
  })

  it('syncs Studio review dependencies, keeps partial results readable and restores frozen snapshots after local removal (#733)', async () => {
    const review = { version: 2, base: null, fingerprint: 'draft', agents: [{ agent: 'writer', title: { en: 'Writer' } }], files: [{ path: 'agents/writer/AGENT.md', before: null, after: 'after.txt', diff: 'change.diff' }], results: [{ agent: 'writer', component: 'Asset', src: 'good.html' }, { agent: 'writer', component: 'Asset', src: 'bad.html' }] }
    const setup = `
      const fs = require('fs')
      fs.mkdirSync('todo/review', { recursive: true })
      fs.writeFileSync('todo/review/review.json', ${JSON.stringify(JSON.stringify(review))})
      fs.writeFileSync('todo/review/after.txt', 'Write real previews.')
      fs.writeFileSync('todo/review/change.diff', '+Write real previews.')
      fs.writeFileSync('todo/review/good.html', '<img src="image.svg"><p>Existing result</p>')
      fs.writeFileSync('todo/review/image.svg', '<svg/>')
      fs.writeFileSync('todo/review/bad.html', '<img src="missing.png">')
      fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Studio src="review/review.json" />\\n')
    `
    const first = await runTask('studio-review-1', setup)
    assert.equal(first.outcome, 'done', first.reason)
    const pins = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.equal(pins['review/review.json'].error, undefined)
    assert.match(pins['review/bad.html'].error, /missing.png/)
    assert.equal(pins['review/good.html'].error, undefined)
    const uploaded = JSON.parse(cloud.task.artifacts.get(pins['review/review.json'].artifact)![0]!.toString())
    assert.equal(uploaded.files[0].after, pins['review/after.txt'].artifact)
    assert.equal(uploaded.results[0].src, pins['review/good.html'].artifact)
    const uploads = cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length
    fs.rmSync(path.join(board(), 'todo/review'), { recursive: true })
    const recordFile = path.join(board(), '.sync/task_1.json')
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    for (const key of Object.keys(record.assets)) if (key.startsWith('review/')) delete record.assets[key]
    fs.writeFileSync(recordFile, JSON.stringify(record))
    const pulled = await runTask('studio-review-2')
    assert.equal(pulled.outcome, 'done', pulled.reason)
    const restored = JSON.parse(read('todo/review/review.json'))
    assert.equal(restored.files[0].after, 'after.txt', JSON.stringify({ restored, pins, types: [...cloud.types], log: cloud.log.slice(-25) }))
    assert.equal(restored.results[0].src, 'good.html')
    assert.equal(read('todo/review/after.txt'), 'Write real previews.')
    assert.match(read('todo/review/good.html'), /image.svg/)
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, uploads)
  })

  it('a preview that cannot be drawn never blocks the push; the list says why until it draws (#456)', async () => {
    const first = await runTask('j1', `
      const fs = require('fs')
      fs.writeFileSync('todo/good.tsx', 'export default () => <main>Good</main>')
      fs.writeFileSync('todo/kept.tsx', 'export default () => <main>Kept</main>')
      fs.writeFileSync('todo/bad.tsx', 'import "./gone.css"; export default () => <main>Bad</main>')
      fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Asset src="good.tsx" />\\n\\n<Asset src="kept.tsx" />\\n\\n<Asset src="bad.tsx" />\\n')
    `)
    assert.equal(first.outcome, 'done', first.reason)
    assert.match(cloud.file(CARD)!, /bad\.tsx/)
    let assets = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.match(assets['bad.tsx'].error, /gone\.css/)
    assert.doesNotMatch(assets['bad.tsx'].error, new RegExp(board()))
    assert.equal(assets['bad.tsx'].version, undefined)
    assert.equal(cloud.task.artifacts.get(assets['bad.tsx'].artifact)?.length ?? 0, 0)
    assert.equal(assets['good.tsx'].error, undefined)
    const kept = assets['kept.tsx']

    fs.writeFileSync(path.join(board(), 'todo/kept.tsx'), 'export default () => { throw new Error("broken later") }')
    const second = await runTask('j2')
    assert.equal(second.outcome, 'done', second.reason)
    assets = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.deepEqual({ ...assets['kept.tsx'], error: undefined }, { ...kept, error: undefined })
    assert.match(assets['kept.tsx'].error, /broken later/)

    for (const name of ['kept', 'bad']) fs.writeFileSync(path.join(board(), 'todo', `${name}.tsx`), 'export default () => <main>Fixed</main>')
    const fixed = await runTask('j3')
    assert.equal(fixed.outcome, 'done', fixed.reason)
    assets = JSON.parse(cloud.file('assets/task_1.json')!)
    for (const name of ['kept', 'bad']) {
      assert.equal(assets[`${name}.tsx`].error, undefined)
      assert.match(cloud.task.artifacts.get(assets[`${name}.tsx`].artifact)!.at(-1)!.toString(), /<main>Fixed<\/main>/)
    }
  })

  it('a missing file or broken storyboard never blocks the push; the body path says why until fixed (#457)', async () => {
    const first = await runTask('j1', `
      const fs = require('fs')
      fs.writeFileSync('todo/bad.json', '{ not json')
      fs.writeFileSync('todo/deck.json', JSON.stringify({ slides: [{ id: 'p1', preview: { src: 'gone.html' } }] }))
      fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Asset src="home.html" />\\n\\n<Storyboard src="bad.json" />\\n\\n<Storyboard src="deck.json" />\\n')
    `)
    assert.equal(first.outcome, 'done', first.reason)
    let assets = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.match(assets['home.html'].error, /^file not found: todo\/home\.html$/)
    assert.match(assets['bad.json'].error, /^not valid JSON: todo\/bad\.json$/)
    assert.match(assets['deck.json'].error, /^file not found: todo\/gone\.html$/)
    assert.equal(cloud.types.get(assets['deck.json'].artifact), 'storyboard')

    fs.writeFileSync(path.join(board(), 'todo/home.html'), '<!doctype html><html><body>Home</body></html>')
    fs.writeFileSync(path.join(board(), 'todo/gone.html'), '<!doctype html><html><body>Gone</body></html>')
    fs.writeFileSync(path.join(board(), 'todo/bad.json'), JSON.stringify({ shots: [{ id: 'S1', frames: [{ src: 'home.html' }] }] }))
    const fixed = await runTask('j2')
    assert.equal(fixed.outcome, 'done', fixed.reason)
    assets = JSON.parse(cloud.file('assets/task_1.json')!)
    for (const name of ['home.html', 'bad.json', 'deck.json']) {
      assert.equal(assets[name].error, undefined, name)
      assert.ok(assets[name].version, name)
    }
  })

  it('reports an invalid required storyboard and an oversized card as content failures (#885)', async () => {
    await prepareBoard()
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cached())
    fs.appendFileSync(path.join(board(), CARD), '\n<Preview id="ui-design">\n\n<Storyboard src="deck.json" />\n\n</Preview>\n')
    fs.writeFileSync(path.join(board(), 'todo/deck.json'), '{ incomplete')
    let result = await push(ws, { id: 'result', machineId: MACHINE })
    assert.ok(!result.ok)
    assert.equal(result.failure?.source, 'validation')
    assert.match(result.error, /deck\.json: not valid JSON/)
    assert.equal(cloud.file(CARD), BODY)

    fs.writeFileSync(path.join(board(), CARD), BODY + 'x'.repeat(10 * 1024 * 1024))
    result = await push(ws, { id: 'result', machineId: MACHINE })
    assert.ok(!result.ok)
    assert.equal(result.failure?.code, 'card_too_large')
    assert.match(result.error, /Move large results to assets/)
    assert.equal(cloud.file(CARD), BODY)
  })

  it('does not rewrite unchanged asset records or reorder their index', async (t) => {
    const first = await runTask('j1', `
      const fs = require('fs')
      fs.mkdirSync('assets/1', { recursive: true })
      for (let n = 0; n < 30; n++) fs.writeFileSync('assets/1/' + n + '.txt', String(n))
      fs.writeFileSync('todo/icon.svg', '<svg/>')
      fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Asset src="icon.svg" />\\n')
    `)
    assert.equal(first.outcome, 'done', first.reason)
    const record = path.join(board(), '.sync', 'task_1.json')
    const index = path.join(board(), 'assets', 'task_1.json')
    const ordered = JSON.parse(fs.readFileSync(index, 'utf8'))
    fs.writeFileSync(index, JSON.stringify(Object.fromEntries(Object.entries(ordered).reverse())))
    const indexBefore = fs.readFileSync(index, 'utf8')
    let writes = 0
    const write = fs.writeFileSync
    t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]) === record) writes++
      return write(...args)
    })
    const uploadsBefore = cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length
    const sent = await pushBoard(keptBoard(cached())!, MACHINE)
    assert.equal(sent.ok, true)
    assert.equal(writes, 0, 'unchanged assets rewrote the entire sync record')
    assert.equal(fs.readFileSync(index, 'utf8'), indexBefore, 'key order alone rewrote the index')
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, uploadsBefore)
  })

  it('同步全部语言、对比分镜和依赖，叶子变化更新固定版本且不覆盖本地 JSON（#321）', async () => {
    const setup = `
      const fs = require('fs')
      fs.writeFileSync('todo/zh.png', '中文')
      fs.writeFileSync('todo/en.png', 'English')
      fs.writeFileSync('todo/page.html', '<!doctype html><html><body>幻灯片</body></html>')
      fs.writeFileSync('todo/deck.json', JSON.stringify({ slides: [{ id: 'p1', preview: { src: './page.html' }, assets: ['zh.png'] }] }, null, 2))
      fs.writeFileSync('todo/board.json', JSON.stringify({ shots: [{ id: 'S1', frames: [{ src: 'zh.png' }] }] }))
      fs.writeFileSync('todo/time.json', '[{"id":"S1","start":0,"end":1,"name":"一"}]')
      fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Asset src="zh.png" variants=\\'{"中文":"zh.png","English":"en.png"}\\' />\\n\\n<Compare a="zh.png" b="board.json" shots="time.json" />\\n\\n<Storyboard src="deck.json" />\\n')
    `
    const first = await runTask('j1', setup)
    assert.equal(first.outcome, 'done', first.reason)
    const refs = () => JSON.parse(cloud.file('assets/task_1.json')!)
    const initial = refs()
    for (const name of ['zh.png', 'en.png', 'page.html', 'deck.json', 'board.json', 'time.json']) assert.equal(initial[name].version, 1, name)
    assert.equal(cloud.types.get(initial['board.json'].artifact), 'storyboard')
    assert.equal(cloud.types.get(initial['time.json'].artifact), 'asset')
    const deck = JSON.parse(cloud.task.artifacts.get(initial['deck.json'].artifact)![0]!.toString())
    assert.equal(deck.slides[0].preview.src, initial['page.html'].artifact)
    assert.equal(deck.slides[0].assets[0], initial['zh.png'].artifact)
    const source = read('todo/deck.json')
    assert.equal(JSON.parse(source).slides[0].preview.src, './page.html')
    const uploads = () => cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length
    const count = uploads()
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal(uploads(), count, '未变化的文件不重传')
    assert.equal(read('todo/deck.json'), source, '分镜源码的路径与排版未被云端展示数据覆盖')
    const changed = await runTask('j3', `const fs = require('fs'); fs.writeFileSync('todo/en.png', 'English 2'); fs.writeFileSync('todo/zh.png', '中文 2')`)
    assert.equal(changed.outcome, 'done', changed.reason)
    assert.equal(refs()['en.png'].version, 2)
    assert.equal(refs()['zh.png'].version, 2)
    assert.equal(refs()['deck.json'].version, 1)
    assert.equal(uploads(), count + 2)
    const removed = await runTask('j4', `const fs = require('fs'); fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)})`)
    assert.equal(removed.outcome, 'done', removed.reason)
    assert.equal(refs()['deck.json'], undefined)
    assert.ok(cloud.task.artifacts.has(initial['deck.json'].artifact))
  })

  it('页面的图片和字体随页面上传：共用文件传一次，缺失的引用只记在该页，拉回后还原路径（#458）', async () => {
    const setup = `
      const fs = require('fs')
      fs.mkdirSync('todo/pages', { recursive: true }); fs.mkdirSync('todo/fonts', { recursive: true })
      fs.writeFileSync('todo/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
      fs.writeFileSync('todo/fonts/a.otf', 'font')
      fs.writeFileSync('todo/pages/deck.css', '@font-face {\\n  src: url("../fonts/a.otf")\\n}')
      for (const n of ['one', 'two']) fs.writeFileSync('todo/pages/' + n + '.html', '<html><head><link rel="stylesheet" href="deck.css"></head><body><img src="../logo.svg"></body></html>')
      fs.writeFileSync('todo/pages/bad.html', '<html><body><img src="../gone.png"></body></html>')
      fs.writeFileSync('todo/deck.json', JSON.stringify({ slides: ['one', 'two', 'bad'].map(id => ({ id, preview: { src: 'pages/' + id + '.html' } })) }))
      fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Storyboard src="deck.json" />\\n')
    `
    const first = await runTask('j1', setup)
    assert.equal(first.outcome, 'done', first.reason)
    const refs = () => JSON.parse(cloud.file('assets/task_1.json')!)
    const initial = refs()
    const page = cloud.task.artifacts.get(initial['pages/one.html'].artifact)!.at(-1)!.toString()
    assert.ok(page.includes(`src="${initial['logo.svg'].artifact}"`), page)
    assert.ok(page.includes(`url("${initial['fonts/a.otf'].artifact}")`), page)
    assert.equal(cloud.task.artifacts.get(initial['fonts/a.otf'].artifact)!.length, 1)
    assert.match(initial['pages/bad.html'].error, /gone\.png/)
    assert.equal(initial['pages/one.html'].error, undefined)
    const uploads = () => cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length
    const count = uploads()
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal(uploads(), count, '未变化的页面和依赖不重传')

    const gone = await runTask('j3', `require('fs').rmSync('todo/pages/one.html')`)
    assert.equal(gone.outcome, 'done', gone.reason)
    const recordFile = path.join(board(), '.sync/task_1.json')
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    delete record.assets['pages/one.html']
    fs.writeFileSync(recordFile, JSON.stringify(record))
    assert.equal((await runTask('j4')).outcome, 'done')
    const pulled = read('todo/pages/one.html')
    assert.ok(pulled.includes('src="../logo.svg"') && pulled.includes('url("../fonts/a.otf")'), pulled)
    assert.equal(uploads(), count, '拉回的页面不再上传')
  })

  it('文档里的图片随文档上传，未变化不重传，拉回后还原路径（#497）', async () => {
    const setup = `
      const fs = require('fs')
      fs.mkdirSync('todo/trial/moves', { recursive: true })
      fs.writeFileSync('todo/trial/moves/idle.gif', 'gif')
      fs.writeFileSync('todo/trial/notes.md', '# 试跑\\n\\n![待机](moves/idle.gif)\\n')
      fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Asset src="trial/notes.md" />\\n')
    `
    const first = await runTask('j1', setup)
    assert.equal(first.outcome, 'done', first.reason)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    const gif = refs['trial/moves/idle.gif']?.artifact
    assert.ok(gif, JSON.stringify(refs))
    assert.ok(cloud.task.artifacts.get(refs['trial/notes.md'].artifact)!.at(-1)!.toString().includes(`![待机](${gif})`))
    const uploads = () => cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length
    const count = uploads()
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal(uploads(), count, '未变化的文档不重传')

    // 本机丢了文档、只剩云端时，图片要有别处引用才留在清单里。
    assert.equal((await runTask('j3', `require('fs').appendFileSync('${CARD}', '\\n<Asset src="trial/moves/idle.gif" />\\n')`)).outcome, 'done')
    const count3 = uploads()
    fs.rmSync(path.join(board(), 'todo/trial/notes.md'))
    const recordFile = path.join(board(), '.sync/task_1.json')
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    delete record.assets['trial/notes.md']
    fs.writeFileSync(recordFile, JSON.stringify(record))
    assert.equal((await runTask('j4')).outcome, 'done')
    assert.ok(read('todo/trial/notes.md').includes('![待机](moves/idle.gif)'), read('todo/trial/notes.md'))
    assert.equal((await runTask('j5')).outcome, 'done')
    assert.equal(uploads(), count3, '拉回的文档不再上传')
  })

  it('旧清单重新同步时固定版本，未引用的新版本不影响本机预览（#321）', async () => {
    cloud.put({ 'assets/task_1.json': JSON.stringify({ 'hero.png': { artifact: 'art_1' }, 'shots/a.png': { artifact: 'art_2', version: 1 } }) })
    const first = await runTask('j1')
    assert.equal(first.outcome, 'done', first.reason)
    assert.deepEqual(JSON.parse(cloud.file('assets/task_1.json')!)['hero.png'], { artifact: 'art_1', version: 1 })
    cloud.task.artifacts.get('art_1')!.push(Buffer.from('未引用的新版'))
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal(read('todo/hero.png'), 'hero-1')
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, 0)
  })

  for (const source of ['文件', '字符串', '对象']) it(`普通 JSON ${source}版本保留内容，删除重下、旧记录与真实编辑往返稳定（#364）`, async () => {
    const original = '{\r\n  "big": 9007199254740993, "text": "\\u4e2d", "exponent": 1e+03, "decimal": 1.2300,\r\n  "b": "art_2", "a": "art_1", "shots": [{"frames":[{"src":"art_1"}]}],\r\n  "slides": [{"preview":{"src":"art_2"},"assets":["art_1"]}]\r\n}\r\n'
    const bytes = Buffer.from(source === '对象' ? JSON.stringify(JSON.parse(original)) : original)
    cloud.types.set('art_json', 'asset')
    cloud.task.artifacts.set('art_json', [bytes])
    if (source !== '文件') cloud.versionContent.set('art_json/1', source === '字符串' ? original : JSON.parse(original))
    cloud.put({
      [CARD]: `${BODY}\n<Asset src="data.json" />\n`,
      'assets/task_1.json': JSON.stringify({ ...JSON.parse(cloud.file('assets/task_1.json')!), 'data.json': { artifact: 'art_json' } }),
    })
    const first = await runTask('j1')
    assert.equal(first.outcome, 'done', first.reason)
    const target = path.join(board(), 'todo/data.json')
    assert.deepEqual(fs.readFileSync(target), bytes)
    const manifest = cloud.file('assets/task_1.json')
    const recordFile = path.join(board(), '.sync/task_1.json')
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    delete record.assets['data.json'].kind
    delete record.assets['data.json'].dependencies
    delete record.assets['data.json'].localHash
    fs.writeFileSync(recordFile, JSON.stringify(record))
    assert.equal((await runTask('j2')).outcome, 'done')
    const stale = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    stale.assets['data.json'].kind = 'storyboard'
    fs.writeFileSync(recordFile, JSON.stringify(stale))
    fs.unlinkSync(target)
    assert.equal((await runTask('j3')).outcome, 'done')
    assert.deepEqual(fs.readFileSync(target), bytes)
    fs.writeFileSync(recordFile, JSON.stringify(stale))
    assert.equal((await runTask('j4')).outcome, 'done')
    assert.equal(cloud.file('assets/task_1.json'), manifest)
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, 0)
    const edited = Buffer.concat([bytes, Buffer.from('  \r\n')])
    fs.writeFileSync(target, edited)
    assert.equal((await runTask('j5')).outcome, 'done')
    assert.equal((await runTask('j6')).outcome, 'done')
    assert.deepEqual(cloud.task.artifacts.get('art_json'), [bytes, edited])
    assert.equal(JSON.parse(cloud.file('assets/task_1.json')!)['data.json'].version, 2)
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, 1)
  })

  it('分镜与对比的未匹配引用和外部地址保持原字节（#364）', async () => {
    const samples = {
      storyboard: '{\r\n "shots": [{"frames":[{"src":"art_missing"}]}], "a": "art_1", "b": "art_2"\r\n}\r\n',
      compare: '{\r\n "a": "art_missing", "b": "https://example.com/b", "slides": [{"preview":{"src":"art_1"}}]\r\n}\r\n',
    }
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    for (const [kind, text] of Object.entries(samples)) {
      cloud.types.set(kind, kind)
      cloud.task.artifacts.set(kind, [Buffer.from(text)])
      refs[`${kind}.json`] = { artifact: kind, version: 1 }
    }
    cloud.put({ 'assets/task_1.json': JSON.stringify(refs) })
    await prepareBoard()
    for (const [kind, text] of Object.entries(samples)) assert.deepEqual(fs.readFileSync(path.join(board(), `todo/${kind}.json`)), Buffer.from(text))
  })

  it('旧预览记录补充类型与哈希时保留源码及待上传修改（#364）', async () => {
    const setup = `const fs = require('fs'); fs.writeFileSync('todo/board.json', JSON.stringify({ shots: [{ frames: [{ src: 'hero.png' }] }] }, null, 2) + '\\n'); fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Storyboard src="board.json" />\\n')`
    const first = await runTask('j1', setup)
    assert.equal(first.outcome, 'done', first.reason)
    const source = read('todo/board.json')
    const recordFile = path.join(board(), '.sync/task_1.json')
    const strip = () => {
      const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
      for (const field of ['kind', 'dependencies', 'localHash']) delete record.assets['board.json'][field]
      delete record.task
      fs.writeFileSync(recordFile, JSON.stringify(record))
    }
    strip()
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal(read('todo/board.json'), source)
    const ref = JSON.parse(cloud.file('assets/task_1.json')!)['board.json']
    assert.equal(ref.version, 1)
    strip()
    const edited = JSON.parse(source)
    edited.title = '新标题'
    fs.writeFileSync(path.join(board(), 'todo/board.json'), JSON.stringify(edited, null, 2))
    assert.equal((await runTask('j3')).outcome, 'done')
    assert.equal(JSON.parse(read('todo/board.json')).title, '新标题')
    assert.equal(cloud.task.artifacts.get(ref.artifact)!.length, 2)
    assert.equal(JSON.parse(cloud.task.artifacts.get(ref.artifact)![1]!.toString()).title, '新标题')
  })

  it('预览无匹配引用时保持原字节和版本，类型读取失败可重试（#364）', async () => {
    const bytes = Buffer.from('{\r\n  "shots": [{"frames":[{"src":"https://example.com/frame.png"}]}], "big": 9007199254740993\r\n}\r\n')
    cloud.types.set('art_json', 'storyboard')
    cloud.task.artifacts.set('art_json', [bytes])
    cloud.put({
      [CARD]: `${BODY}\n<Storyboard src="data.json" />\n`,
      'assets/task_1.json': JSON.stringify({ ...JSON.parse(cloud.file('assets/task_1.json')!), 'data.json': { artifact: 'art_json', version: 1 } }),
    })
    cloud.failArtifactRead = 'art_json'
    assert.equal((await runTask('j1')).outcome, 'failed')
    assert.equal(fs.existsSync(path.join(board(), 'todo/data.json')), false)
    assert.equal(fs.existsSync(path.join(board(), '.sync/task_1.json')), false)
    cloud.failArtifactRead = null
    const retry = await runTask('j2')
    assert.equal(retry.outcome, 'done', retry.reason)
    assert.deepEqual(fs.readFileSync(path.join(board(), 'todo/data.json')), bytes)
    cloud.failArtifactRead = 'art_json'
    assert.equal((await runTask('j3')).outcome, 'done')
    assert.equal((await runTask('j4')).outcome, 'done')
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, 0)
    assert.equal(cloud.task.artifacts.get('art_json')!.length, 1)
  })

  it('嵌套对比按类型恢复路径、保留非展示字段与固定版本（#364）', async () => {
    for (const folder of ['assets']) fs.mkdirSync(path.join(cached(), '.akb/boards/.akb/kanban', folder, '1'), { recursive: true })
    const data = {
      'art_compare': { a: 'art_board', b: 'art_1', shots: 'art_time', slides: [{ preview: { src: 'art_2' } }] },
      'art_board': { slides: [{ preview: { src: 'art_page' }, assets: ['art_2', 'https://example.com/file'] }], a: 'art_1' },
      'art_time': [{ id: 'S1', start: 0, end: 1 }],
      'art_page': '<main>幻灯片</main>',
    }
    for (const [id, value] of Object.entries(data)) {
      cloud.task.artifacts.set(id, [Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\r\n')])
      cloud.types.set(id, id === 'art_compare' ? 'compare' : id === 'art_board' ? 'storyboard' : id === 'art_page' ? 'html' : 'asset')
    }
    cloud.put({
      [CARD]: '<Compare a="decks/compare.json" b="hero.png" />\n',
      'assets/task_1.json': JSON.stringify({
        'hero.png': { artifact: 'art_1', version: 1 },
        '.assets/1/a.png': { artifact: 'art_2', version: 1 },
        'decks/compare.json': { artifact: 'art_compare', version: 1 },
        'decks/board.json': { artifact: 'art_board', version: 1 },
        'time.json': { artifact: 'art_time', version: 1 },
        '.assets/1/page.html': { artifact: 'art_page', version: 1 },
      }),
    })
    const first = await runTask('j1')
    assert.equal(first.outcome, 'done', first.reason)
    const compare = JSON.parse(read('todo/decks/compare.json'))
    assert.equal(compare.a, 'board.json')
    assert.equal(compare.b, '../hero.png')
    assert.equal(compare.shots, '../time.json')
    assert.equal(compare.slides[0].preview.src, 'art_2')
    const deck = JSON.parse(read('todo/decks/board.json'))
    assert.equal(deck.slides[0].preview.src, '.assets/1/page.html')
    assert.deepEqual(deck.slides[0].assets, ['.assets/1/a.png', 'https://example.com/file'])
    assert.equal(deck.a, 'art_1')
    const manifest = cloud.file('assets/task_1.json')
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal((await runTask('j3')).outcome, 'done')
    assert.equal(cloud.file('assets/task_1.json'), manifest)
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, 0)
    fs.writeFileSync(path.join(board(), 'todo/time.json'), JSON.stringify({ a: 'hero.png', b: 'decks/board.json' }))
    const changed = await runTask('j4')
    assert.equal(changed.outcome, 'done', changed.reason)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.notEqual(refs['time.json'].artifact, 'art_time')
    assert.equal(refs['decks/compare.json'].version, 2)
    assert.equal(JSON.parse(cloud.task.artifacts.get('art_compare')![1]!.toString()).shots, refs['time.json'].artifact)
    assert.equal((await runTask('j5')).outcome, 'done')
    assert.equal(cloud.task.artifacts.get('art_compare')!.length, 2)
  })

  it('下载嵌套分镜后还原相对路径，下一次同步不重传（#321）', async () => {
    cloud.types.set('art_board', 'storyboard')
    cloud.task.artifacts.set('art_board', [Buffer.from(JSON.stringify({ slides: [{ preview: { src: 'art_1' }, assets: ['art_2'] }] }))])
    cloud.put({
      [CARD]: `${BODY}\n<Storyboard src="decks/board.json" />\n`,
      'assets/task_1.json': JSON.stringify({ 'hero.png': { artifact: 'art_1', version: 1 }, 'shots/a.png': { artifact: 'art_2', version: 1 }, 'decks/board.json': { artifact: 'art_board', version: 1 } }),
    })
    const first = await runTask('j1')
    assert.equal(first.outcome, 'done', first.reason)
    const local = JSON.parse(read('todo/decks/board.json'))
    assert.equal(local.slides[0].preview.src, '../hero.png')
    assert.deepEqual(local.slides[0].assets, ['../shots/a.png'])
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, 0)
  })

  for (const code of ['storage_limit', 'offline']) it(`上传中途失败不提交卡片，重试复用已上传文件：${code}（#321）`, async () => {
    const card = cloud.file(CARD)
    const manifest = cloud.file('assets/task_1.json')
    cloud.uploadFailure = { after: 1, code }
    const failed = await runTask('j1', `const fs = require('fs'); fs.writeFileSync('todo/first.png', '先'); fs.writeFileSync('todo/second.png', '后'); fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Compare a="first.png" b="second.png" />\\n')`)
    assert.equal(failed.outcome, 'failed')
    assert.equal(cloud.file(CARD), card)
    assert.equal(cloud.file('assets/task_1.json'), manifest)
    const first = [...cloud.task.artifacts].find(([, versions]) => versions[0]?.toString() === '先')!
    assert.ok(first)
    const count = cloud.log.filter(l => l === `PUT /v1/uploads/upl_${first[0]}`).length
    const retry = await runTask('j2')
    assert.equal(retry.outcome, 'done', retry.reason)
    assert.equal(cloud.log.filter(l => l === `PUT /v1/uploads/upl_${first[0]}`).length, count)
    assert.equal(JSON.parse(cloud.file('assets/task_1.json')!)['first.png'].artifact, first[0])
  })

  it('资源依赖循环仍阻止推送（#321）', async () => {
    const card = cloud.file(CARD)
    const failed = await runTask('j1', `const fs = require('fs'); fs.writeFileSync('todo/bad.json', '{"a":"bad.json","b":"hero.png"}'); fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Compare a="bad.json" b="hero.png" />\\n')`)
    assert.equal(failed.outcome, 'failed')
    assert.match(failed.reason!, /资源依赖循环/)
    assert.equal(cloud.file(CARD), card)
  })

  it('首次拉取下载 .assets/ 预览；拉不下来的预览不阻止回复（#516）', async () => {
    cloud.task.artifacts.set('art_a', [Buffer.from('A')])
    cloud.put({
      [CARD]: `${BODY}\n<Compare a=".assets/1/a.png" b=".assets/1/gone.png" />\n`,
      'assets/task_1.json': JSON.stringify({ '.assets/1/a.png': { artifact: 'art_a', version: 1 }, '.assets/1/gone.png': { artifact: 'art_gone', version: 1 } }),
    })
    const first = await runTask('j1')
    assert.equal(first.outcome, 'done', first.reason)
    const state = projectStateDir(board())
    assert.equal(fs.readFileSync(path.join(state, 'assets/1/a.png'), 'utf8'), 'A')
    fs.rmSync(path.join(state, 'assets/1'), { recursive: true })
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
    fs.symlinkSync(outside, path.join(state, 'assets/1'))
    const linked = await runTask('j2')
    assert.equal(linked.outcome, 'done', linked.reason)
    assert.equal(fs.existsSync(path.join(outside, 'a.png')), false)
    assert.match(JSON.parse(cloud.file('assets/task_1.json')!)['.assets/1/a.png'].error, /outside the board/)
  })

  it('越界符号链接只标为损坏、不上传（#321, #457）', async () => {
    const outside = path.join(runnerHome(), 'outside.json')
    const linked = await runTask('j1', `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(outside)}, '{}'); fs.symlinkSync(${JSON.stringify(outside)}, 'todo/bad.json'); fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Storyboard src="bad.json" />\\n')`)
    assert.equal(linked.outcome, 'done', linked.reason)
    assert.equal(JSON.parse(cloud.file('assets/task_1.json')!)['bad.json'].error, 'link outside the board: bad.json')
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, 0)
  })

  it('sends back assets first, then the card and its assets list', async () => {
    const edit = `
      const fs = require('fs')
      fs.writeFileSync('${CARD}', fs.readFileSync('${CARD}', 'utf8') + ' ![](new.png)')
      fs.writeFileSync('todo/new.png', 'new-1')
      fs.writeFileSync('todo/hero.png', 'hero-mine')
    `
    const job = await runTask('j1', edit)
    assert.equal(job.outcome, 'done', job.reason)
    assert.match(cloud.file(CARD)!, /new\.png/)
    const { artifacts } = cloud.task
    const list = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.equal(artifacts.get('art_1')!.at(-1)!.toString(), 'hero-mine')
    assert.deepEqual(list['hero.png'], { artifact: 'art_1', version: 2 })
    assert.deepEqual(list['shots/a.png'], { artifact: 'art_2', version: 1 })
    assert.equal(artifacts.get(list['new.png'].artifact)![list['new.png'].version - 1]!.toString(), 'new-1')
    const uploadAt = cloud.log.findIndex((l) => l.startsWith('PUT /v1/uploads/'))
    assert.ok(uploadAt >= 0 && uploadAt < cloud.log.findIndex((l) => l.endsWith('/board/commits')), 'assets went after the card')
  })

  it('lands two computers’ changes to different files without merging anything', async () => {
    cloud.beforeNextCommit = () => cloud.put({ 'memory/readme.md': 'Shipped, from the other computer' })
    const job = await runTask('j1', `require('fs').writeFileSync('rules/proposer.md', 'mine')`)
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(commits().length, 1, 'a write to another file was merged')
    assert.equal(cloud.file('rules/proposer.md'), 'mine')
    assert.equal(cloud.file('memory/readme.md'), 'Shipped, from the other computer')
  })

  it('merges a file both sides changed here, and writes it once more', async () => {
    cloud.beforeNextCommit = () => cloud.put({ [CARD]: BODY.replace('# Pricing', '# Pricing, two tiers') })
    const job = await runTask('j1', `require('fs').writeFileSync('${CARD}', require('fs').readFileSync('${CARD}', 'utf8').replace('Tiers.', 'Tiers, yearly first.'))`)
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(commits().length, 2)
    assert.equal(cloud.file(CARD), BODY.replace('# Pricing', '# Pricing, two tiers').replace('Tiers.', 'Tiers, yearly first.'))
    assert.equal(read(CARD), cloud.file(CARD))
  })

  it('preserves opposite requirements and the rejected atomic batch when the agent cannot resolve (#806)', async () => {
    cloud.beforeNextCommit = () => cloud.put({ [CARD]: BODY.replace('Tiers.', 'Tiers, monthly first.') })
    const job = await runTask('j1', `
      require('fs').writeFileSync('${CARD}', require('fs').readFileSync('${CARD}', 'utf8').replace('Tiers.', 'Tiers, yearly first.'))
      require('fs').writeFileSync('memory/readme.md', 'Mine')`)
    assert.equal(job.outcome, 'failed')
    assert.match(job.reason!, /unresolved/)
    assert.equal(cloud.file(CARD), BODY.replace('Tiers.', 'Tiers, monthly first.'))
    assert.equal(cloud.file('memory/readme.md'), 'Shipped')
    const conflict = conflictShow(board(), conflictList(board())[0]!.id)
    assert.equal(conflict.files.find(f => f.path === CARD)!.base.content, BODY)
    assert.equal(conflict.files.find(f => f.path === CARD)!.local.content, BODY.replace('Tiers.', 'Tiers, yearly first.'))
    assert.equal(conflict.files.find(f => f.path === 'memory/readme.md')!.conflicted, false)
    assert.equal(read(CARD), BODY.replace('Tiers.', 'Tiers, yearly first.'))
    assert.equal(planned.length, 2)
    assert.equal(planned[1]!.resume, 'fresh-session')
    assert.match(planned[1]!.prompt, /resolve-conflict/)
  })

  it('merges one-sided changes to repetitive files without expensive diffing', () => {
    const base = `head\n${'  },\n'.repeat(2000)}tail\n`
    const changed = `${base}added\n`
    const started = performance.now()
    assert.deepEqual(mergeFile(base, base, changed), { content: changed })
    assert.deepEqual(mergeFile(base, changed, base), { content: changed })
    assert.ok(performance.now() - started < 1000, 'one-sided changes entered the expensive diff')
    assert.deepEqual(mergeFile(base, base, null), { content: null })
    assert.deepEqual(mergeFile(base, null, base), { content: null })
  })

  it('preserves metadata conflicts for an explicit decision (#806)', () => {
    const card = (status: string) => `---\ntitle: A\nstatus: ${status}\n---\n\nBody\n`
    assert.deepEqual(mergeFile(card('ready'), card('planning'), card('done')), { content: card('planning'), conflict: true })
  })

  const resolveScript = `
    const fs = require('fs'), cp = require('child_process'), path = require('path');
    const cli = ${JSON.stringify(path.join(process.env.RUNNER_DIST ?? '', 'akb/bin/ai4kanban.mjs'))};
    const command = (...args) => {
      const ran = cp.spawnSync(process.execPath, [cli, '--board', process.env.AI4KANBAN_BOARD, 'raw', 'conflict', ...args, '--json'], { encoding: 'utf8' });
      if (ran.status !== 0) throw Error(ran.stdout + ran.stderr);
      return JSON.parse(ran.stdout);
    };
    for (const c of command('list').conflicts) {
      const shown = command('show', c.id).conflict;
      const file = path.join(process.env.AI4KANBAN_BOARD, '.sync/resolution.json');
      fs.writeFileSync(file, JSON.stringify({ files: shown.files.filter(f => f.conflicted).map(f => ({ path: f.path, content: 'Settled cadence' })) }));
      command('resolve', c.id, '--expect', shown.revision, '--file', file);
    }
  `
  for (const when of ['preflight', 'running', 'submission']) it(`resolves ${when} conflicts inside the same task and continues automatically (#806)`, async () => {
    cloud.put({ 'config.md': '# Board\n' })
    await prepareBoard()
    const original = `const fs = require('fs'); fs.appendFileSync('original-work.txt', 'once\\n'); fs.writeFileSync('.akb/kanban/memory/readme.md', 'yearly first');`
    if (when === 'preflight') {
      fs.writeFileSync(path.join(board(), 'memory/readme.md'), 'yearly first')
      cloud.put({ 'memory/readme.md': 'monthly first' })
    }
    if (when === 'submission') cloud.beforeNextCommit = () => cloud.put({ 'memory/readme.md': 'monthly first' })
    const gated = gatedScript(original)
    start('', { plan: (r, prompt, cwd, resume) => {
      const resolving = prompt.includes('resolve-conflict')
      const closing = prompt.includes('return the saved result')
      return fakeRuntime(resolving ? resolveScript + (closing ? '' : `; require('fs').appendFileSync('original-work.txt', 'once\\n')`)
        : when === 'running' ? gated.script : original)(r, prompt, cwd, resume)
    } })
    const job = cloud.dispatch({ id: crypto.randomUUID(), task: 'task_1', project: 'prj_1', number: 1, studio: 'wf_own' })
    if (when === 'running') {
      await until(() => fs.existsSync(path.join(cached(), 'original-work.txt')))
      cloud.put({ 'memory/readme.md': 'monthly first' })
      assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, false)
      assert.equal(job.state, 'claimed')
      assert.equal(pendingConflicts(board()).length, 1)
      gated.release()
    }
    await until(() => job.state === 'finished', 10_000)
    assert.equal(job.outcome, 'done', job.reason + '\n' + job.events.map(e => e.text).join(''))
    assert.equal(fs.readFileSync(path.join(cached(), 'original-work.txt'), 'utf8'), 'once\n')
    assert.equal(cloud.file('memory/readme.md'), 'Settled cadence')
    assert.equal(pendingConflicts(board()).length, 0)
    assert.equal(planned.length, when === 'preflight' ? 1 : 2)
    if (planned.length === 2) assert.equal(planned[1]!.resume, planned[0]!.resume ?? 'fresh-session')
    assert.ok(!cloud.log.some(l => l.includes('finish') && l.includes('conflict')))
  })

  it('waits for another task to publish its preparation and stops a queued task cleanly (#882)', async () => {
    await prepareBoard()
    const holder = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cached())
    const next = openTaskFolder({ task: 'task_2', project: 'prj_1', number: 2 }, cached())
    let release!: () => void
    let entered = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = withBoard(holder, async () => {
      fs.writeFileSync(path.join(board(), 'memory/readme.md'), 'temporary preparation')
      entered = true
      await gate
      fs.writeFileSync(path.join(board(), 'memory/readme.md'), 'Shipped')
    })
    await until(() => entered)
    let stopped = false, created = 0
    const cancelled = withBoard(next, async () => { created++ }, () => stopped)
    const ready = pull(next, MACHINE)
    try {
      assert.equal(await Promise.race([ready.then(() => 'early'), new Promise(resolve => setTimeout(resolve, 160, 'waiting'))]), 'waiting')
      stopped = true
      await cancelled
      assert.equal(created, 0)
      assert.equal(cloud.file('memory/readme.md'), 'Shipped')
    } finally { release(); await original }
    assert.ok((await ready).ok)
    await withBoard(next, async () => { created++ })
    assert.equal(created, 1)
    assert.equal(cloud.file('memory/readme.md'), 'Shipped')
  })

  it('repairs a required Preview attachment in the saved task session (#885)', async () => {
    await prepareBoard()
    const output = `
<Preview id="ui-design">

<Asset src="required.txt" label="Result" />

</Preview>
`
    const original = `const fs = require('fs'); fs.appendFileSync('.akb/kanban/${CARD}', ${JSON.stringify(output)}); fs.appendFileSync('original-work.txt', 'once')`
    const repair = "require('fs').writeFileSync('.akb/kanban/todo/required.txt', 'original result')"
    start('', { plan: (r, prompt, cwd, resume) => fakeRuntime(prompt.includes('Correct the diagnostics') ? repair : original)(r, prompt, cwd, resume) })
    const job = cloud.dispatch({ id: 'attachment-repair', task: 'task_1', project: 'prj_1', number: 1, studio: 'wf_own' })
    await until(() => job.state === 'finished', 10_000)
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(planned.length, 2)
    assert.equal(planned[1]!.resume, 'fresh-session')
    assert.match(planned[1]!.prompt, /required\.txt: file not found/)
    assert.equal(fs.readFileSync(path.join(cached(), 'original-work.txt'), 'utf8'), 'once')
    const pin = JSON.parse(cloud.file('assets/task_1.json')!)['required.txt']
    assert.equal(cloud.task.artifacts.get(pin.artifact)?.[pin.version - 1]?.toString(), 'original result')
  })

  it('reconciles an archived Coding Preview copy without hiding a substantive conflict (#874, #842)', async () => {
    const archive = '.archive/842-coding-preview-memory.md'
    const modern = '# Archive\n\n<Preview id="prompts">\n\nOriginal result.\n\n</Preview>\n\n## Scope\n\nArchived.\n'
    const old = '# Archive\n\n## By `prompt-writer` agent\n\nOriginal result.\n\n## Scope\n\nArchived.\n'
    cloud.put({ [archive]: modern })
    await prepareBoard()
    const ws = keptBoard(cached())!
    fs.writeFileSync(path.join(board(), archive), old)
    cloud.put({ [archive]: modern.replace('Original result.', 'Cloud result.') })
    assert.ok((await pull(ws, MACHINE)).ok)
    assert.match(read(archive), /Cloud result./)
    assert.equal(conflictList(board()).length, 0)
    const drafts = fs.readdirSync(path.join(board(), '.sync/legacy-previews'))
    assert.equal(fs.readFileSync(path.join(board(), '.sync/legacy-previews', drafts[0]!, archive), 'utf8'), old)

    fs.writeFileSync(path.join(board(), archive), old.replace('Original result.', 'Local result.'))
    cloud.put({ [archive]: modern.replace('Original result.', 'New remote result.') })
    assert.equal((await pull(ws, MACHINE)).ok, false)
    const record = conflictShow(board(), conflictList(board())[0]!.id)
    const fact = record.files.find(file => file.path === archive)!
    assert.match(fact.base.content!, /Cloud result./)
    assert.match(fact.local.content!, /Local result./)
    assert.match(fact.remote.content!, /New remote result./)
  })

  it('keeps task preparation private while allowing the agent to take the sync lock (#806)', async () => {
    await prepareBoard()
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cached())
    await withBoard(ws, async () => {
      fs.writeFileSync(path.join(ws.board, 'memory/readme.md'), 'temporary context')
      assert.equal((await pushBoard(ws, MACHINE)).ok, false)
      assert.equal(cloud.file('memory/readme.md'), 'Shipped')
      assert.equal(await withSyncLock(ws.board, async () => 'available to the agent'), 'available to the agent')
      fs.writeFileSync(path.join(ws.board, 'memory/readme.md'), 'final context')
    })
    assert.ok((await pushBoard(ws, MACHINE)).ok)
    assert.equal(cloud.file('memory/readme.md'), 'final context')
  })

  it('honors a user stop while a running task has an unresolved conflict (#806)', async () => {
    await prepareBoard()
    const gate = gatedScript(`require('fs').writeFileSync('.akb/kanban/memory/readme.md', 'local cadence')`)
    start('', { plan: fakeRuntime(gate.script) })
    const job = cloud.dispatch({ id: 'stop-conflict', task: 'task_1', project: 'prj_1', number: 1, studio: 'wf_own' })
    await until(() => read('memory/readme.md') === 'local cadence')
    cloud.put({ 'memory/readme.md': 'remote cadence' })
    assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, false)
    job.stop = true
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'stopped', job.reason)
    assert.equal(planned.length, 1)
    assert.equal(pendingConflicts(board()).length, 1)
    assert.equal(read('memory/readme.md'), 'local cadence')
    assert.equal(cloud.file('memory/readme.md'), 'remote cadence')
  })

  it('writes nothing once the job moved to another computer', async () => {
    const job = cloud.dispatch({ id: 'j1', task: 'task_1', project: 'prj_1', number: 1, studio: 'wf_own' })
    script = `process.chdir('.akb/kanban'); require('fs').writeFileSync('memory/readme.md', 'Late')`
    start('', { plan: (r, p, c) => fakeRuntime(script)(r, p, c), renewMs: 60_000 })
    await until(() => planned.length === 1)
    job.machine = 'elsewhere'
    await until(() => commits().length === 1)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(cloud.file('memory/readme.md'), 'Shipped')
    assert.notEqual(job.outcome, 'done')
  })

  it('runs a job on offline and writes it back once Cloud is reached within the lease', async () => {
    const job = cloud.dispatch({ id: 'j1', task: 'task_1', project: 'prj_1', number: 1, studio: 'wf_own' })
    script = `process.chdir('.akb/kanban'); setTimeout(() => require('fs').writeFileSync('memory/readme.md', 'Offline work'), 300)`
    start('', { plan: (r, p, c) => fakeRuntime(script)(r, p, c) })
    await until(() => planned.length === 1)
    cloud.offline = true
    await new Promise((r) => setTimeout(r, 600))
    assert.equal(job.state, 'claimed')
    cloud.offline = false
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(cloud.file('memory/readme.md'), 'Offline work')
  })

  it('drops a result still offline when its lease ran out', async () => {
    const job = cloud.dispatch({ id: 'j1', task: 'task_1', project: 'prj_1', number: 1, studio: 'wf_own' })
    script = `process.chdir('.akb/kanban'); setTimeout(() => require('fs').writeFileSync('memory/readme.md', 'Too late'), 200)`
    start('', { plan: (r, p, c) => fakeRuntime(script)(r, p, c), leaseMs: 300 })
    await until(() => planned.length === 1)
    cloud.offline = true
    await new Promise((r) => setTimeout(r, 700))
    cloud.offline = false
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(commits().length, 0)
    assert.equal(cloud.file('memory/readme.md'), 'Shipped')
    assert.equal(job.state, 'claimed')
  })

  it('uses current Studio Notes in task replies and recovery, scoped to its board and pinned Studio (#859)', async () => {
    const note = 'Only during Coding task discussion: titles in English, rest in Chinese.'
    cloud.put({ 'rules/studios/wf-own.md': note, 'rules/studios/coding.md': 'Other Studio note' })
    assert.equal((await runTask('notes-1')).outcome, 'done')
    assert.ok(planned.at(-1)!.prompt.includes(`<rules>\n${note}\n</rules>`))
    assert.ok(!planned.at(-1)!.prompt.includes('Other Studio note'))
    cloud.put({ 'rules/studios/wf-own.md': 'Revised note' })
    assert.equal((await runTask('notes-2', '', { resume: 'saved-session' })).outcome, 'done')
    assert.ok(planned.at(-1)!.prompt.includes('Revised note'))
    assert.ok(!planned.at(-1)!.prompt.includes(note))
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cloud.folder!('prj_1'))
    assert.ok(!taskStudioContext({ ...ws, board: path.join(cached(), 'other-board') }).includes('Revised note'))
    cloud.put({ 'rules/studios/wf-own.md': null })
    assert.equal((await runTask('notes-3')).outcome, 'done')
    assert.ok(!planned.at(-1)!.prompt.includes('Revised note'))
  })

  it('round-trips Preview scopes and reads them again in a recovered task (#842)', async () => {
    const own = 'memory/previews/coding/prompts/project/style.md'
    const shared = 'memory/previews/coding/prompts/workspace/style.md'
    cloud.put({ [own]: 'Project preference', [shared]: 'Stale project copy', 'memory/agents/planner/skill/decisions.md': 'Module decision' })
    cloud.putShared({ [shared]: 'Workspace preference', 'memory/previews/wf-mine/draft/workspace/rules.md': 'User Studio rule' })
    const first = await runTask('preview-memory-1', `
      const fs = require('fs'), assert = require('assert/strict')
      assert.equal(fs.readFileSync('${own}', 'utf8'), 'Project preference')
      assert.equal(fs.readFileSync('${shared}', 'utf8'), 'Workspace preference')
      assert.equal(fs.readFileSync('memory/agents/planner/skill/decisions.md', 'utf8'), 'Module decision')
    `)
    assert.equal(first.outcome, 'done', first.reason)
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cloud.folder!('prj_1'))
    const hints = taskStudioContext(ws)
    assert.match(hints, /memory\/previews\/coding\/prompts\/project\//)
    assert.match(hints, /memory\/previews\/coding\/prompts\/workspace\//)
    assert.doesNotMatch(hints, /Project preference|Workspace preference|style.md/)
    fs.writeFileSync(path.join(board(), own), 'Revised project preference')
    fs.writeFileSync(path.join(board(), shared), 'Confirmed cross-project preference')
    assert.equal((await pushBoard(ws, MACHINE)).ok, true)
    assert.equal(cloud.file(own), 'Revised project preference')
    assert.equal(cloud.shared(shared), 'Confirmed cross-project preference')
    assert.equal(cloud.file(shared), null)
    fs.rmSync(path.join(board(), 'memory'), { recursive: true })
    fs.rmSync(path.join(cached(), '.akb', 'base.json'))
    const next = await runTask('preview-memory-2', `
      const fs = require('fs'), assert = require('assert/strict')
      assert.equal(fs.readFileSync('${own}', 'utf8'), 'Revised project preference')
      assert.equal(fs.readFileSync('${shared}', 'utf8'), 'Confirmed cross-project preference')
    `)
    assert.equal(next.outcome, 'done', next.reason)
  })

  it('keeps a project’s copy of shared memory edited elsewhere, and writes back the rest (#2099)', async () => {
    const STYLE = 'memory/agents/copywriting/style.md'
    cloud.putShared({ [STYLE]: 'Shared' })
    cloud.put({ [STYLE]: 'Project copy' })
    cloud.beforeNextCommit = () => cloud.put({ [STYLE]: 'Edited elsewhere' })
    const job = await runTask('j1', `require('fs').writeFileSync('memory/readme.md', 'Mine')`)
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(cloud.file('memory/readme.md'), 'Mine')
    assert.equal(cloud.file(STYLE), 'Edited elsewhere')
  })

  it('reads a board whole again after a base from before the workspace’s board (#2114)', async () => {
    const base = path.join(cached(), '.akb', 'base.json')
    fs.mkdirSync(path.dirname(base), { recursive: true })
    fs.writeFileSync(base, JSON.stringify({ head_seq: 99, inbox: false, files: { [CARD]: { seq: 1, content: 'Old' } } }))
    assert.equal((await runTask('j1')).outcome, 'done')
    assert.ok(cloud.log.includes('GET /v1/projects/prj_1/board'), 'an old base was read on from its seq')
    assert.equal(read(CARD), BODY)
    assert.equal(JSON.parse(fs.readFileSync(base, 'utf8')).layout, 'workspace')
  })

  it('keeps a project’s task folder in it, out of git', async () => {
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'site-')))
    spawnSync('git', ['init', '-q', project])
    fs.writeFileSync(path.join(runnerHome(), 'projects.json'), JSON.stringify({ projects: [project] }))
    const job = cloud.dispatch({ id: 'j1', task: 'task_1', project: 'prj_1', number: 1, projectDir: project })
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done')
    assert.equal(planned[0]!.cwd, project)
    assert.equal(fs.readFileSync(path.join(project, '.akb', 'kanban', CARD), 'utf8'), BODY)
    assert.match(fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8'), /^\.akb\/$/m)
    assert.equal(spawnSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '')
  })
})

describe('the workspace’s memory files (#2093)', () => {
})

function flowReport(job: FakeJob) {
  const { processesStopped, evidence, ...report } = job.report ?? {}
  assert.equal(processesStopped, true, '正常结束须确认本地进程停止')
  return report
}

describe('flow jobs (#2020)', () => {
  const board = () => path.join(cached(), '.akb', 'kanban')
  const typed = () => fs.readFileSync(process.env.FAKE_AKB_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])
  // The calls by the group they act on: `raw card refine` (#551) reads as `card refine`.
  const calls = () => typed().map((c) =>
    c[0] !== 'raw' || c[1] === 'init' || c[1] === 'create' ? c : c[1] === 'memory' ? [`${c[2]}-memory`, ...c.slice(3)] : c.slice(1))
  const cardCalls = () => calls().filter((c) => c[0] === 'card').map((c) => c.join(' '))
  const flowJob = async (id: string, flow: Partial<NonNullable<FakeFlow>> & { verb: string }, extra: Partial<Parameters<FakeCloud['dispatch']>[0]> = {}) => {
    const job = cloud.dispatch({ id, task: 'task_1', project: 'prj_1', number: 2, runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', ...flow }, ...extra })
    if (!runner) start()
    await until(() => job.state === 'finished')
    return job
  }

  beforeEach(() => {
    cloud.task = { artifacts: new Map(), title: 'Pricing page', request: 'Two tiers, monthly and yearly.' }
  })

  it('enters the original refine despite a preflight conflict and continues after explicit synchronization (#806)', async () => {
    cloud.put({ 'config.md': '# Board\n', 'todo/2-pricing.md': '---\ntitle: Pricing\nstudio: coding\nquestions: []\n---\n', 'memory/readme.md': 'base' })
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 2, studio: 'wf_builtin_coding' }, cached())
    assert.ok((await pull(ws, MACHINE)).ok)
    fs.writeFileSync(path.join(ws.board, 'memory/readme.md'), 'local cadence')
    cloud.put({ 'memory/readme.md': 'remote cadence' })
    const gate = path.join(runnerHome(), 'refine-conflict-gate')
    process.env.FAKE_AKB = JSON.stringify({ refine: { gates: [gate], result: 'Original refine completed.' } })
    const job = cloud.dispatch({ id: crypto.randomUUID(), task: 'task_1', project: 'prj_1', number: 2, runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'refine' } })
    start()
    await until(() => fs.existsSync(path.join(ws.board, '.fake/agent-board')))
    assert.equal(job.state, 'claimed')
    assert.equal(cardCalls().filter(c => c.startsWith('card refine')).length, 1)
    const id = conflictList(ws.board)[0]!.id
    const shown = conflictShow(ws.board, id)
    const file = path.join(runnerHome(), 'refine-resolution.json')
    fs.writeFileSync(file, JSON.stringify({ files: [{ path: 'memory/readme.md', content: 'Settled cadence' }] }))
    const cli = { command: process.execPath, args: [path.join(process.env.RUNNER_DIST!, 'akb/bin/ai4kanban.mjs')], version: 'test', shim: path.join(runnerHome(), 'real-shim') }
    const resolved = await runAkb(cli, ['--board', ws.board, 'raw', 'conflict', 'resolve', id, '--expect', shown.revision, '--file', file, '--json'], {
      cwd: ws.cwd, board: ws.board, task: ws.task, env: { AI4KANBAN_EXECUTION: JSON.stringify({ job: job.id, machine: MACHINE }) },
    })
    assert.equal(resolved.code, 0, resolved.out)
    fs.writeFileSync(gate, '')
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.report?.reply, 'Original refine completed.')
    assert.equal(cardCalls().filter(c => c.startsWith('card refine')).length, 1)
    assert.equal(cloud.file('memory/readme.md'), 'Settled cadence')
  })

  const savedConflict = async () => {
    cloud.put({ 'config.md': '# Board\n', 'memory/readme.md': 'base' })
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 2, studio: 'wf_builtin_coding' }, cached())
    assert.ok((await pull(ws, MACHINE)).ok)
    fs.writeFileSync(path.join(ws.board, 'memory/readme.md'), 'local cadence')
    cloud.put({ 'memory/readme.md': 'remote cadence' })
    assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, false)
    fs.mkdirSync(path.join(ws.board, 'todo'), { recursive: true })
    fs.mkdirSync(path.join(ws.board, '.archive'), { recursive: true })
    const saved = conflictList(ws.board)[0]!.id
    return { ws, saved }
  }

  for (const action of ['create', 'refine', 'implement'] as const) it(`starts ${action} with saved conflicts and a missing local card (#846)`, async () => {
    const verb = action === 'implement' ? 'create' : action
    const command = action === 'implement' ? 'implement' : 'refine'
    const { ws, saved } = await savedConflict()
    const original = '---\ntitle: Cloud pricing\nstudio: coding\nstatus: implementing\npreview_approved: true\nquestions: []\n---\n\nActual saved request.\n\n- [x] Shipped work\n'
    const baseBefore = JSON.parse(fs.readFileSync(path.join(cached(), '.akb/base.json'), 'utf8'))
    cloud.put({ 'memory/not-for-this-task.md': 'New remote context' })
    if (verb === 'refine') {
      cloud.put({ 'todo/2-cloud-pricing.md': original, 'assets/task_1.json': JSON.stringify({ '.assets/2/request.txt': { artifact: 'request', version: 1 } }) })
      cloud.task.artifacts.set('request', [Buffer.from('Actual attachment')])
    }
    const gate = path.join(runnerHome(), 'new-task-conflict-gate')
    process.env.FAKE_AKB = JSON.stringify({ [command]: { gates: [gate], status: 'ready', result: 'Original request completed.', landed: 'Original request completed.' } })
    const job = cloud.dispatch({ id: crypto.randomUUID(), task: 'task_1', project: 'prj_1', number: 2, runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb, skip_plan: action === 'implement' } })
    start()
    await until(() => job.state === 'finished' || fs.existsSync(path.join(ws.board, '.fake/runs.json')))
    assert.equal(job.state, 'claimed', job.reason)
    assert.equal(cardCalls().filter(c => c.startsWith(`card ${command}`)).length, 1)
    const file = path.join(ws.board, 'todo', verb === 'create' ? '2-pricing-page.md' : '2-cloud-pricing.md')
    assert.match(fs.readFileSync(file, 'utf8'), verb === 'create' ? /Two tiers, monthly and yearly/ : /Actual saved request.[\s\S]*- \[x\] Shipped work/)
    assert.equal(conflictList(ws.board)[0]!.id, saved)
    assert.equal(readHead(ws), baseBefore.head_seq)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cached(), '.akb/base.json'), 'utf8')).files['projects/prj_1/memory/readme.md'], baseBefore.files['projects/prj_1/memory/readme.md'])
    assert.equal(fs.existsSync(path.join(ws.board, 'memory/not-for-this-task.md')), false)
    if (verb === 'refine') assert.equal(fs.readFileSync(path.join(projectStateDir(ws.board), 'assets/2/request.txt'), 'utf8'), 'Actual attachment')
    const shown = conflictShow(ws.board, saved)
    assert.equal(shown.files.find(f => f.path === 'memory/readme.md')!.local.content, 'local cadence')
    assert.equal(shown.files.find(f => f.path === 'memory/readme.md')!.remote.content, 'remote cadence')
    const resolution = path.join(runnerHome(), 'new-task-resolution.json')
    fs.writeFileSync(resolution, JSON.stringify({ files: [{ path: 'memory/readme.md', content: 'Settled cadence' }] }))
    const cli = { command: process.execPath, args: [path.join(process.env.RUNNER_DIST!, 'akb/bin/ai4kanban.mjs')], version: 'test', shim: path.join(runnerHome(), 'real-shim') }
    const resolved = await runAkb(cli, ['--board', ws.board, 'raw', 'conflict', 'resolve', saved, '--expect', shown.revision, '--file', resolution, '--json'], {
      cwd: ws.cwd, board: ws.board, task: ws.task, env: { AI4KANBAN_EXECUTION: JSON.stringify({ job: job.id, machine: MACHINE }) },
    })
    assert.equal(resolved.code, 0, resolved.out)
    if (verb === 'create') {
      assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, false, 'preparation must remain private after resolution')
      assert.equal((await push({ ...ws, task: 'other', cloudTask: 'other', number: 3 }, { id: 'other', machineId: MACHINE })).ok, false)
      let cancelled = false, entered = false
      const queued = withBoard(ws, async () => { entered = true }, () => cancelled)
      await new Promise(resolve => setTimeout(resolve, 125))
      cancelled = true
      await queued
      assert.equal(entered, false)
      assert.equal(cloud.file('todo/2-pricing-page.md'), null)
    }
    assert.equal(await withSyncLock(ws.board, async () => 'available'), 'available')
    fs.writeFileSync(gate, '')
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.report?.reply, 'Original request completed.')
    assert.equal(cardCalls().filter(c => c.startsWith(`card ${command}`)).length, 1)
    assert.equal(calls().filter(c => c[0] === 'raw' && c[1] === 'create').length, verb === 'create' ? 1 : 0)
    assert.equal(cloud.file('memory/readme.md'), 'Settled cadence')
    assert.equal(pendingConflicts(ws.board).length, 0)
    if (verb === 'refine') assert.match(cloud.file('todo/2-cloud-pricing.md')!, /preview_approved: true[\s\S]*- \[x\] Shipped work/)
    const resumed = await flowJob('resume-saved', { verb, resume: true, skip_plan: action === 'implement' })
    assert.equal(resumed.outcome, 'done', resumed.reason)
    assert.equal(cardCalls().filter(c => c.startsWith(`card ${command}`)).length, 1)
    assert.equal(calls().filter(c => c[0] === 'raw' && c[1] === 'create').length, verb === 'create' ? 1 : 0)
  })

  it('refuses unavailable or ended tasks without preparing or launching a repair (#846)', async () => {
    const { ws, saved } = await savedConflict()
    cloud.put({ 'todo/2-cloud-pricing.md': '---\ntitle: Real request\n---\nSaved work' })
    const base = fs.readFileSync(path.join(cached(), '.akb/base.json'), 'utf8')
    for (const status of ['gone', 'down', 'unauthenticated', 'forbidden', 'done', 'cancelled', 'wrong-project', 'offline']) {
      cloud.taskStatus.task_1 = status
      cloud.task.project = status === 'wrong-project' ? 'prj_other' : 'prj_1'
      cloud.offline = status === 'offline'
      const result = await pull(ws, MACHINE)
      assert.equal(result.ok, false, status)
      assert.notEqual(!result.ok && result.code, 'board_content_conflict', status)
      assert.equal(fs.existsSync(path.join(ws.board, 'todo/2-cloud-pricing.md')), false, status)
      assert.equal(fs.readFileSync(path.join(cached(), '.akb/base.json'), 'utf8'), base)
    }
    cloud.offline = false
    assert.equal(conflictList(ws.board)[0]!.id, saved)
    assert.equal(planned.length, 0)
    assert.equal(cloud.jobs.size, 0)
  })

  for (const stop of [false, true]) it(`preserves a new task when its conflict is ${stop ? 'stopped' : 'unresolved'} (#846)`, async () => {
    const { ws, saved } = await savedConflict()
    const gate = path.join(runnerHome(), 'unfinished-conflict-gate')
    process.env.FAKE_AKB = JSON.stringify({ refine: { ...(stop ? { gates: [gate] } : {}), result: 'Saved draft.' } })
    const job = cloud.dispatch({ id: 'unfinished-new-task', task: 'task_1', project: 'prj_1', number: 2, runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'create' } })
    start()
    if (stop) {
      await until(() => fs.existsSync(path.join(ws.board, '.fake/runs.json')))
      job.stop = true
    }
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, stop ? 'stopped' : 'failed', job.reason)
    if (!stop) assert.match(job.reason!, /conflict.*preserved|unresolved/i)
    assert.match(fs.readFileSync(path.join(ws.board, 'todo/2-pricing-page.md'), 'utf8'), /Two tiers, monthly and yearly/)
    assert.equal(conflictList(ws.board)[0]!.id, saved)
    assert.equal(fs.readFileSync(path.join(ws.board, 'memory/readme.md'), 'utf8'), 'local cadence')
    assert.equal(cloud.file('memory/readme.md'), 'remote cadence')
    assert.equal(cloud.file('todo/2-pricing-page.md'), null)
    assert.equal(calls().filter(c => c[0] === 'raw' && c[1] === 'create').length, 1)
    assert.equal(cardCalls().filter(c => c.startsWith('card refine')).length, 1)
  })

  it('replans a reopened completed task in a new session without replaying its delivery (#807)', async () => {
    cloud.put({ 'todo/2-pricing.md': '---\ntitle: Pricing\nstatus: todo\nquestions: []\nrestored: 2026-11-17T01:00:00Z\n---\n\n- [x] Saved work\n' })
    const job = await flowJob('reopen', { verb: 'revise', card: 2, text: 'Prepare a new plan for review.', replan: true }, { resume: 'old-build-session' })
    assert.equal(job.outcome, 'done', job.reason)
    assert.ok(cardCalls().some(c => c.startsWith('card revise 2 ') && c.includes('--new-session')))
    assert.ok(!cardCalls().some(c => c.includes('--session old-build-session') || c.startsWith('card implement')))
    assert.ok(!calls().some(c => c[0] === 'delivery' && c[1] === 'resume'))
    assert.match(cloud.file('todo/2-pricing.md')!, /- \[x\] Saved work/)
  })

  it('运行时跨机续跑不检查摘要，保留目录并使用目标工具', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: { result: '保留已有进度。' } })
    await flowJob('source', { verb: 'create' })
    const { allow } = await import('../src/folders')
    allow(cached())
    fs.writeFileSync(path.join(cached(), 'existing.txt'), '已有工作')
    installed = [{ name: 'kimi', installed: true, loggedIn: true }]
    const job = await flowJob('target', { verb: 'refine', resume: true }, {
      runtime: 'kimi', projectDir: cached(), resume: 'incompatible-native-session',
      handoff: { kind: 'execution', action: 'runtime' },
    })
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(fs.readFileSync(path.join(cached(), 'existing.txt'), 'utf8'), '已有工作')
    assert.ok(calls().some((c) => c[0] === 'agent' && c[1] === 'use' && c[2] === 'kimi'))
    assert.equal(job.report?.evidence, undefined)
  })

  it('运行时交接实际工具不可用时保留原因，不回退工具', async () => {
    const job = await flowJob('target', { verb: 'refine', resume: true }, {
      runtime: 'kimi', projectDir: cached(), handoff: { kind: 'execution', action: 'runtime' },
    })
    assert.equal(job.outcome, 'failed')
    assert.match(job.reason!, /目标运行工具已不可用/)
    assert.equal(planned.length, 0)
  })

  it('creates the card from the task, refines it, and reports the card, its question and the reply', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: { result: 'Planned two tiers.', question: 'Which billing period leads?' } })
    const job = await flowJob('j1', { verb: 'create' }, { number: 12 })
    assert.equal(job.outcome, 'done', job.reason)
    const create = calls().find((c) => c[0] === 'raw' && c[1] === 'create')!
    assert.deepEqual(create.slice(0, 6), ['raw', 'create', '--title', 'Pricing page', '--studio', 'coding'])
    assert.deepEqual(create.slice(create.indexOf('--id'), create.indexOf('--id') + 2), ['--id', '12'])
    assert.equal(fs.readFileSync(path.join(board(), '.fake', 'task-env'), 'utf8'), 'task_1')
    assert.deepEqual(calls().find((c) => c[0] === 'agent'), ['agent', 'use', 'claude-code', '--board', board()])
    assert.deepEqual(calls().find((c) => c[1] === 'set' && c[2] === 'model'), ['agent', 'set', 'model', '--board', board()])
    assert.deepEqual(cardCalls(), [`card refine 12 --follow --events --json --board ${board()}`])
    assert.deepEqual(flowReport(job), {
      reply: 'Planned two tiers.',
      card: 12,
      review: { question: 'Which billing period leads?', options: ['Monthly', 'Yearly'], position: 2 },
    })
    const file = path.join(board(), 'todo', '12-pricing-page.md')
    assert.equal(cloud.file('todo/12-pricing-page.md'), fs.readFileSync(file, 'utf8'))
    assert.match(cloud.file('todo/12-pricing-page.md')!, /^---\ntitle: Pricing page\n[\s\S]*Two tiers, monthly and yearly\./)
    assert.match(job.events.map((e) => e.text).join(''), /working on #12/)
    assert.doesNotMatch(job.events.map((e) => e.text).join(''), /"ok":/)
    assert.deepEqual(job.events.find((e) => e.kind === 'message')?.data?.text, 'Read #12.')
    assert.equal(fs.readFileSync(path.join(board(), '.fake', 'agent-board'), 'utf8'), board())
    assert.equal(spawnSync('git', ['-C', cached(), 'log', '--oneline'], { encoding: 'utf8' }).stdout.trim().split('\n').length, 1)
  })

  it('sends a new card to Cloud before planning it, so another task’s pull keeps it (#575)', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: { refuse: 'stopped' } })
    const job = await flowJob('j1', { verb: 'create' })
    assert.equal(job.outcome, 'failed')
    assert.match(cloud.file('todo/2-pricing-page.md') ?? '', /^---\ntitle: Pricing page\n/)
  })

  it('cleans managed skills before runs without requiring a replacement', async () => {
    await flowJob('j1', { verb: 'create' })
    const dir = path.join(cached(), '.claude/skills/kanban')
    assert.equal(fs.existsSync(dir), false)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '<!-- ai4kanban managed -->\nOld skill')
    const job = await flowJob('j2', { verb: 'refine' })
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(fs.existsSync(dir), false)
    assert.equal((await flowJob('j3', { verb: 'refine' })).outcome, 'done')
    assert.equal(fs.existsSync(dir), false)
  })

  it('starts tasks with empty or dangling legacy skills and when cleanup is denied', async () => {
    await flowJob('j1', { verb: 'create' })
    const dir = path.join(cached(), '.claude/skills/kanban')
    fs.mkdirSync(dir, { recursive: true })
    assert.equal((await flowJob('j2', { verb: 'refine' })).outcome, 'done')
    fs.rmdirSync(dir)
    fs.symlinkSync(path.join(cached(), 'missing-skill'), dir)
    assert.equal((await flowJob('j3', { verb: 'refine' })).outcome, 'done')
    assert.ok(fs.lstatSync(dir).isSymbolicLink())
    fs.unlinkSync(dir)
    fs.mkdirSync(dir)
    const file = path.join(dir, 'SKILL.md')
    fs.writeFileSync(file, '<!-- ai4kanban managed -->')
    const unlink = fs.unlinkSync
    const denied = mock.method(fs, 'unlinkSync', (target: fs.PathLike) => {
      if (target === file) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      unlink(target)
    })
    try {
      const job = await flowJob('j4', { verb: 'refine' })
      assert.equal(job.outcome, 'done', job.reason)
      assert.ok(fs.existsSync(file))
    } finally { denied.mock.restore() }
  })

  it('implements an explicit empty review plan once and reports delivery (#818)', async () => {
    const taskReview = { plan: [], stages: [], pending_plan: null, revision: 0 }
    cloud.task.review = taskReview
    const job = await flowJob('j818', { verb: 'create', review_stages: [] }, { taskReview })
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.report?.deliveryCompleted, true)
    assert.deepEqual(cardCalls(), [`card implement 2 --follow --events --json --board ${board()}`])
  })

  it('refuses execution when its assigned review stage became locked (#818)', async () => {
    const taskReview = { plan: [{ id: 'a', title: 'A', after: [], previews: [] }], stages: [{ id: 'a', status: 'available' as const, revision: 0, snapshot: null }], pending_plan: null, revision: 0 }
    cloud.task.review = { ...taskReview, stages: [{ ...taskReview.stages[0]!, status: 'blocked' }] }
    const job = await flowJob('j818', { verb: 'create', review_stages: ['a'] }, { taskReview })
    assert.equal(job.outcome, 'failed')
    assert.match(job.reason ?? '', /authorization changed/)
    assert.equal(job.report?.processesStopped, true)
    assert.equal(job.finishedLogEnded, true)
    assert.deepEqual(cardCalls(), [])
  })

  it('builds a card made unplanned straight after writing it (#2139)', async () => {
    cloud.rejections = { tasks: [{ id: 'task_9', number: 9, title: 'Mobile app', request: '', reason: 'never', cancelled_at: '2026-10-20T09:00:00.000Z' }], triage: [] }
    const job = await flowJob('j1', { verb: 'create', skip_plan: true })
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(cardCalls(), [`card implement 2 --follow --events --json --board ${board()}`])
    assert.deepEqual(cloud.reviewed, [], 'an unplanned build ran the rejection review')
  })

  it('sends each item the job added up with the board, from its task, on its studio (#2107)', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: { propose: 'Own idea', studio: 'wf-own1' } })
    assert.equal((await flowJob('j1', { verb: 'create' })).outcome, 'done')
    assert.match(cloud.file('triage/proposed.md')!, /\nstudio: wf-own1\n[\s\S]*source_task: task_1\n/)
    cloud.put({ 'triage/proposed.md': null })
    process.env.FAKE_AKB = JSON.stringify({ refine: { propose: 'Plain idea', studio: '' } })
    assert.equal((await flowJob('j2', { verb: 'create' })).outcome, 'done')
    assert.match(cloud.file('triage/proposed.md')!, /title: Plain idea\n[\s\S]*source_task: task_1\nstudio: coding\n---/)
    assert.ok(!cloud.log.some((l) => l.includes('/v1/triage')), 'triage went to Cloud on its own')
  })

  it('reports what the runs this job started spent, not the card\'s earlier ones', async () => {
    const spent = { usage: { input: 10, cacheCreation: 1, cacheRead: 100, output: 5 }, costUsd: 0.25 }
    process.env.FAKE_AKB = JSON.stringify({ refine: { spent }, implement: { spent } })
    await flowJob('j1', { verb: 'create' })
    await new Promise((r) => setTimeout(r, 5))
    const job = await flowJob('j2', { verb: 'implement', card: 2 })
    assert.deepEqual(job.report?.usage, { input: 20, cacheCreation: 2, cacheRead: 200, output: 10 })
    assert.equal(job.report?.costUsd, 0.5)
  })

  it('marks partial costs without turning a known zero into unknown (#689)', () => {
    const job = { runtime: 'codex' as const }
    assert.equal(spentBy([{ sessionId: 'a', costUsd: 0 }], job).costIncomplete, undefined)
    const partial = spentBy([{ sessionId: 'a', costUsd: 0 }, { sessionId: 'b' }], job)
    assert.equal(partial.costUsd, 0)
    assert.equal(partial.costIncomplete, true)
  })

  it('splits a step\'s cost by the runtime each agent ran on (#629)', () => {
    const pick = { id: 'rt_cx', name: 'Codex', runtime: 'codex', model: null, settings: {}, runner: 'm' }
    const job = { runtime: 'claude-code' as const, runtimeId: 'rt_cc', agentRuntimes: { reviewer: pick } }
    const spent = spentBy([
      { sessionId: 'a', runtime: 'global', costUsd: 0.5 },
      { sessionId: 'b', runtime: 'rt_cx', costUsd: 0.25 },
      { sessionId: 'c', costUsd: 0.25 },
    ], job)
    assert.equal(spent.costUsd, 1)
    assert.deepEqual(spent.runtimeCosts, [
      { runtimeId: 'rt_cc', runtime: 'claude-code', costUsd: 0.75 },
      { runtimeId: 'rt_cx', runtime: 'codex', costUsd: 0.25 },
    ])
  })

  it('reports the context window the latest run counting one left (#52)', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: { spent: { context: { used: 90000, limit: 200000 } } } })
    assert.deepEqual((await flowJob('j1', { verb: 'create' })).report?.context, { used: 90000, limit: 200000 })
    process.env.FAKE_AKB = JSON.stringify({ implement: { spent: { context: { used: 120000 } } } })
    await new Promise((r) => setTimeout(r, 5))
    assert.equal((await flowJob('j2', { verb: 'implement', card: 2 })).report?.context, undefined)
  })

  it('plans anyway when the review fails, leaving the rejections to learn (#2067)', async () => {
    cloud.rejections = { tasks: [{ id: 'task_9', number: 9, title: 'Mobile app', request: '', reason: 'never', cancelled_at: '2026-10-20T09:00:00.000Z' }], triage: [] }
    process.env.FAKE_AKB = JSON.stringify({ 'review-dismissals': { failed: 'Claude Code hit its usage limit.' } })
    const job = await flowJob('j1', { verb: 'create' })
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(cloud.reviewed, [])
    assert.deepEqual(cardCalls(), [`card refine 2 --follow --events --json --board ${board()}`])
    assert.ok(!fs.existsSync(path.join(board(), '.archive', '.sync')))
  })

  it('takes the title and the request a create job carries', async () => {
    await flowJob('j1', { verb: 'create', title: 'Launch page', text: 'One hero, one button.' })
    assert.equal(calls().find((c) => c[1] === 'create')![3], 'Launch page')
    assert.match(fs.readFileSync(path.join(board(), 'todo', '2-launch-page.md'), 'utf8'), /One hero, one button\./)
    assert.ok(!cloud.log.includes('GET /v1/tasks/task_1'))
  })

  it('puts the pictures a create job carries on the card it makes (#2182)', async () => {
    const job = await flowJob('j1', { verb: 'create' }, { attachments: [{ name: 'home "shot".png', content: 'aGk=' }] })
    assert.equal(job.outcome, 'done', job.reason)
    const card = fs.readFileSync(path.join(board(), 'todo', '2-pricing-page.md'), 'utf8')
    assert.match(card, /\n\n<Asset src="\.assets\/2\/1-home-shot-\.png" label="home shot\.png" \/>\n/)
    const ref = JSON.parse(cloud.file('assets/task_1.json')!)['.assets/2/1-home-shot-.png']
    assert.equal(cloud.task.artifacts.get(ref.artifact)![0]!.toString(), 'hi')
  })

  it('reports the landed commit and syncs the archived card after a build', async () => {
    await flowJob('j1', { verb: 'create' })
    const commit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
    process.env.FAKE_AKB = JSON.stringify({ implement: { result: 'Built it.', landed: 'Landed it.', delivery: { commit, branch: 'main' } } })
    const built = await flowJob('j5', { verb: 'implement', card: 2 }, { resume: 'planning-session', transcript: 'Planning history', resumeCostUsd: 2 })
    const b = board()
    assert.deepEqual(cardCalls(), [
      `card refine 2 --follow --events --json --board ${b}`,
      `card implement 2 --follow --events --json --board ${b}`,
    ])
    assert.equal(built.outcome, 'done', built.reason)
    assert.deepEqual(flowReport(built), { reply: 'Landed it.', card: 2, landing: { commit, branch: 'main' } })
    assert.ok(fs.existsSync(path.join(b, '.archive', '2-pricing-page.md')))
    assert.match(cloud.file('.archive/2-pricing-page.md')!, /implement$/m, 'the archived card never reached Cloud')
    assert.equal(cloud.file('todo/2-pricing-page.md'), null, 'the card stayed in todo/ in Cloud')
    assert.equal(calls().filter((c) => c[1] === 'init').length, 1)
  })

  it('hands a discussion task\'s session and discussion to its planning, and reports the session it ended on (#2146)', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: { result: 'Planned.', agentSession: 'ts1' }, resolve: { result: 'Done.', agentSession: 'ts2' } })
    const transcript = 'User: Tiers?\n\nAgent: Two.'
    const planned = await flowJob('j1', { verb: 'create' }, { resume: 'ds1', fork: true, transcript })
    assert.equal(planned.outcome, 'done', planned.reason)
    const b = board()
    const file = path.join(b, '.sync', 'task_1.discussion', 'discussion.md')
    assert.deepEqual(cardCalls(), [`card refine 2 --follow --events --json --session ds1 --fork --transcript ${file} --board ${b}`])
    assert.equal(fs.readFileSync(path.join(b, '.fake', 'transcript'), 'utf8'), `${transcript}\n`)
    assert.ok(!fs.existsSync(file), 'the discussion was left on the board')
    assert.equal((planned.report as { session?: string }).session, 'ts1')
    const answered = await flowJob('j2', { verb: 'resolve', card: 2, text: 'Monthly' }, { resume: 'ts1', transcript })
    assert.equal(cardCalls()[1], `card resolve 2 --follow --events --json --session ts1 --transcript ${file} --board ${b} -- Monthly`)
    assert.equal((answered.report as { session?: string }).session, 'ts2')
    await flowJob('j3', { verb: 'approve', card: 2 }, { resume: 'ts2', transcript })
    assert.equal(cardCalls()[2], `card approve 2 --follow --events --json --board ${b}`)
  })

  it('starts a direct build without discussion context and skips the plan (#768)', async () => {
    process.env.FAKE_AKB = JSON.stringify({ implement: { result: 'Built.', agentSession: 'bs1' } })
    const transcript = 'User: Tiers?\n\nAgent: Two.'
    const built = await flowJob('j1', { verb: 'create', skip_plan: true }, { resume: 'ds1', fork: true, transcript, resumeCostUsd: 2 })
    assert.equal(built.outcome, 'done', built.reason)
    const b = board()
    const file = path.join(b, '.sync', 'task_1.discussion', 'discussion.md')
    assert.deepEqual(cardCalls(), [`card implement 2 --follow --events --json --board ${b}`])
    assert.ok(!fs.existsSync(path.join(b, '.fake', 'transcript')))
    assert.equal(fs.readFileSync(path.join(b, '.fake', 'session-cost'), 'utf8'), '')
    assert.ok(!fs.existsSync(file), 'the discussion was left on the board')
    assert.equal((built.report as { session?: string }).session, 'bs1')
  })

  for (const verb of ['refine', 'create'] as const) {
    it(`待审卡的 ${verb} 作业被拒后正常上报卡片（#210）`, async () => {
      const card = '---\ntitle: Pricing\nstatus: ready\nquestions: []\n---\n\n已批准的计划。\n'
      cloud.put({ 'todo/2-pricing.md': card })
      process.env.FAKE_AKB = JSON.stringify({ refine: { refuse: 'a refine would not move #2' } })
      const job = await flowJob('j1', { verb, card: 2 })
      assert.equal(job.outcome, 'done', job.reason)
      assert.deepEqual(flowReport(job), { card: 2 })
      assert.equal(cloud.file('todo/2-pricing.md'), card)
      assert.ok(!calls().some((c) => c[0] === 'raw' && c[1] === 'create'))
    })
  }

  it('细化写好待审计划后中断仍上报回复和用量（#210）', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: {
      status: 'ready', failed: '运行中断', result: '计划已完成。', spent: { costUsd: 0.25 },
    } })
    const job = await flowJob('j1', { verb: 'create' })
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(flowReport(job), { card: 2, reply: '计划已完成。', costUsd: 0.25, runtimeCosts: [{ runtimeId: null, runtime: 'claude-code', costUsd: 0.25 }] })
    assert.match(cloud.file('todo/2-pricing-page.md')!, /status: ready/)
  })

  it('细化写好选项问题后中断仍上报评审（#210）', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: { failed: '运行中断', question: '选择计费周期？' } })
    const job = await flowJob('j1', { verb: 'create' })
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(flowReport(job), {
      card: 2, review: { question: '选择计费周期？', options: ['Monthly', 'Yearly'], position: 2 },
    })
    assert.match(cloud.file('todo/2-pricing-page.md')!, /选择计费周期？/)
  })

  for (const meta of ['status: implementing\nquestions: []', 'status: planning\nquestions:\n  - 请提供素材']) {
    it(`细化被拒时识别无选项的待审状态：${meta.split('\n')[0]}（#210）`, async () => {
      cloud.put({ 'todo/2-pricing.md': `---\ntitle: Pricing\n${meta}\n---\n` })
      process.env.FAKE_AKB = JSON.stringify({ refine: { refuse: 'a refine would not move #2' } })
      const job = await flowJob('j1', { verb: 'refine', card: 2 })
      assert.equal(job.outcome, 'done', job.reason)
      assert.deepEqual(flowReport(job), { card: 2 })
    })
  }

  for (const [file, how] of [
    ['todo/2-pricing.md', { failed: '运行中断' }],
    ['todo/2-pricing/root.md', { failed: 'Group audit interrupted' }],
  ] as const) {
    it(`非待审卡细化失败仍失败：${file}（#210）`, async () => {
      cloud.put({ [file]: '---\ntitle: Pricing\nstatus: planning\nquestions: []\n---\n' })
      process.env.FAKE_AKB = JSON.stringify({ refine: how })
      const job = await flowJob('j1', { verb: 'refine', card: 2 })
      assert.equal(job.outcome, 'failed')
      assert.equal(job.reason, how.failed)
      assert.deepEqual(flowReport(job), {})
    })
  }

  it('resumes a refused group by actually refining it and preserving its children (#688)', async () => {
    const child = '---\ntitle: Existing child\nstatus: ready\nphase: 1\nstages: 2\nquestions: []\n---\n\nApproved work.\n- [x] Shipped step\n- [ ] Remaining step\n'
    cloud.put({
      'todo/2-pricing/root.md': '---\ntitle: Pricing\nstatus: todo\nquestions: []\n---\n\n## Todo\n- [x] Shipped #3\n- [ ] Existing child #4\n',
      'todo/2-pricing/4-child.md': child,
    })
    process.env.FAKE_AKB = JSON.stringify({ refine: { refuse: 'a refine would not move #2' } })
    assert.equal((await flowJob('j1', { verb: 'refine', card: 2 })).outcome, 'failed')
    process.env.FAKE_AKB = JSON.stringify({ refine: { result: 'Checked existing split; coverage is complete.' } })
    const resumed = await flowJob('j2', { verb: 'refine', card: 2, resume: true })
    assert.equal(resumed.outcome, 'done', resumed.reason)
    assert.equal(cardCalls().filter((call) => call.startsWith('card refine 2 ')).length, 2)
    assert.equal(flowReport(resumed).reply, 'Checked existing split; coverage is complete.')
    assert.equal(cloud.file('todo/2-pricing/4-child.md'), child)
    assert.match(cloud.file('todo/2-pricing/root.md')!, /- \[x\] Shipped #3/)
    process.env.FAKE_AKB = JSON.stringify({ refine: { failed: 'Group audit interrupted' } })
    const failed = await flowJob('j3', { verb: 'refine', card: 2, resume: true })
    assert.equal(failed.outcome, 'failed')
    assert.equal(failed.reason, 'Group audit interrupted')
  })

  it('fails a build that stopped short, and reports one held on a question', async () => {
    await flowJob('j1', { verb: 'create' })
    process.env.FAKE_AKB = JSON.stringify({ implement: { failed: 'Review ran out of rounds.' } })
    const stopped = await flowJob('j2', { verb: 'implement', card: 2 })
    assert.equal(stopped.outcome, 'failed')
    assert.equal(stopped.reason, 'Review ran out of rounds.')
    process.env.FAKE_AKB = JSON.stringify({ implement: { failed: 'waiting on the user', question: 'Keep the old page?', landed: 'Asked one thing.' } })
    const held = await flowJob('j3', { verb: 'implement', card: 2 })
    assert.equal(held.outcome, 'done', held.reason)
    assert.deepEqual(flowReport(held), {
      reply: 'Asked one thing.',
      card: 2,
      review: { question: 'Keep the old page?', options: ['Monthly', 'Yearly'], position: 2 },
    })
    process.env.FAKE_AKB = JSON.stringify({ implement: { result: 'Built it.', landed: 'Landed it.' } })
    const answered = await flowJob('j4', { verb: 'implement', card: 2, text: 'Keep the old page?\n\nNo' })
    assert.equal(answered.outcome, 'done', answered.reason)
    assert.ok(typed().some((c) => c.slice(0, 3).join(' ') === 'raw card resolve'), 'the Runner typed the old path')
    const log = calls().map((c) => c.join(' '))
    const resolveAt = log.findIndex((l) => l.startsWith('card resolve 2 --follow --events --json'))
    assert.ok(resolveAt >= 0 && log.slice(resolveAt).some((l) => l.startsWith('card implement 2 --follow --events --json')),
      'the answer was not resolved before the build carried on')
  })

  for (const failed of [undefined, 'Interrupted after rejecting.']) {
    it(`ends a discard answer without building again, resolve exit ${failed ? 1 : 0} (#241)`, async () => {
      process.env.FAKE_AKB = JSON.stringify({ refine: { question: 'Keep building?' } })
      await flowJob('j1', { verb: 'create' })
      const spent = { costUsd: 0.25, usage: { input: 20, output: 5, cacheCreation: 0, cacheRead: 0 } }
      process.env.FAKE_AKB = JSON.stringify({ resolve: {
        reject: true, failed, result: 'Discarded it.', spent,
        delivery: { id: 'd1', commit: 'must-not-land', branch: 'main' },
        ended: { deliveryId: 'd1', status: 'cancelled' },
      } })
      const job = await flowJob('j2', { verb: 'implement', card: 2, text: 'Discard this card.' })
      assert.equal(job.outcome, 'done', job.reason)
      assert.deepEqual(flowReport(job), { card: 2, reply: 'Discarded it.', ...spent, runtimeCosts: [{ runtimeId: null, runtime: 'claude-code', costUsd: spent.costUsd }] })
      assert.ok(!cardCalls().some((c) => c.startsWith('card implement')))
      assert.match(cloud.file('.archive/2-pricing-page.md')!, /rejected: true/)
      assert.equal(cloud.file('todo/2-pricing-page.md'), null)
    })
  }

  it('passes a failed, non-discard answer to the build as its note (#241)', async () => {
    await flowJob('j1', { verb: 'create' })
    process.env.FAKE_AKB = JSON.stringify({ resolve: { failed: 'Interrupted.' } })
    const job = await flowJob('j2', { verb: 'implement', card: 2, text: 'Keep it.' })
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(cardCalls().at(-1), `card implement 2 --follow --events --json --board ${board()} -- Keep it.`)
  })

  it('stops a build whose delivery was cancelled, and fails one discarded or blocked with its reason (#59)', async () => {
    await flowJob('j1', { verb: 'create' })
    const ended = (record: Record<string, unknown>) =>
      JSON.stringify({ implement: { failed: 'delivery d1 did not land', ended: { deliveryId: 'd1', steps: [{ step: 'implement' }], ...record } } })
    process.env.FAKE_AKB = ended({ status: 'cancelled' })
    const cancelled = await flowJob('j2', { verb: 'implement', card: 2 })
    assert.equal(cancelled.outcome, 'stopped', cancelled.reason)
    process.env.FAKE_AKB = ended({ status: 'cancelled', steps: [{ step: 'implement' }, { step: 'discarded' }] })
    const discarded = await flowJob('j3', { verb: 'implement', card: 2 })
    assert.equal(discarded.outcome, 'failed')
    assert.equal(discarded.reason, 'The build was discarded.')
    process.env.FAKE_AKB = ended({ status: 'active', review: { rounds: [], stopped: { reason: 'landing', why: 'this could not be fitted onto the latest `main`: the API moved', at: 1 } } })
    const blocked = await flowJob('j4', { verb: 'implement', card: 2 })
    assert.equal(blocked.outcome, 'failed')
    assert.equal(blocked.reason, 'this could not be fitted onto the latest `main`: the API moved')
  })

  it('reports a build left active on a card question as waiting, not unfinished (#504)', async () => {
    await flowJob('j1', { verb: 'create' })
    process.env.FAKE_AKB = JSON.stringify({ implement: { failed: 'delivery d1 did not land', question: 'Replace the public main?', ended: { deliveryId: 'd1', status: 'active', steps: [{ step: 'implement' }] } } })
    const job = await flowJob('j2', { verb: 'implement', card: 2 })
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(flowReport(job).review, { question: 'Replace the public main?', options: ['Monthly', 'Yearly'], position: 2 })
  })

  it('fails with akb’s own words when a verb is refused, or the run fails, and saves nothing', async () => {
    await flowJob('j1', { verb: 'create' })
    const saved = cloud.head
    process.env.FAKE_AKB = JSON.stringify({ approve: { refuse: '#2 has no stages, so there is nothing to approve.' } })
    const refused = await flowJob('j2', { verb: 'approve', card: 2 })
    assert.equal(refused.outcome, 'failed')
    assert.equal(refused.reason, '#2 has no stages, so there is nothing to approve.')
    process.env.FAKE_AKB = JSON.stringify({ revise: { failed: 'Claude Code hit its usage limit.\nat …' } })
    const failed = await flowJob('j3', { verb: 'revise', card: 2, text: 'shorter' })
    assert.equal(failed.outcome, 'failed')
    assert.equal(failed.reason, 'Claude Code hit its usage limit.')
    assert.equal(cloud.head, saved)
  })

  describe('stopping the board runs a build started (#2092)', () => {
    type FakeRun = { sessionId: string; status?: string; startedAt: number }
    const runsFile = () => path.join(board(), '.fake', 'runs.json')
    const runs = () => JSON.parse(fs.readFileSync(runsFile(), 'utf8')) as FakeRun[]
    const building = async () => {
      await flowJob('j1', { verb: 'create' })
      process.env.FAKE_AKB = JSON.stringify({ implement: { hang: true, chain: 2 } })
      const before = Date.now()
      const job = cloud.dispatch({ id: 'j2', task: 'task_1', project: 'prj_1', number: 2, runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'implement', card: 2 } })
      await until(() => runs().some((r) => r.sessionId.startsWith('run-implement') && r.status === 'running'))
      // A run on the card the job did not start.
      fs.writeFileSync(runsFile(), JSON.stringify([...runs(), { sessionId: 'run-mine', cardId: 2, status: 'running', startedAt: before - 1 }]))
      return job
    }
    const stopsBuild = () => {
      const built = runs().filter((r) => r.sessionId.startsWith('run-implement'))
      // Each stop starts the delivery's next run until the chain is spent; all are stopped.
      assert.equal(built.length, 3)
      assert.ok(built.every((r) => r.status === 'stopped'))
      assert.equal(runs().find((r) => r.sessionId === 'run-mine')!.status, 'running')
      assert.ok(!calls().some((c) => c[0] === 'run' && c[1] === 'stop' && c[2] === 'run-mine'))
    }

    it('when the Runner closes, before it lets go of the account', async () => {
      const job = await building()
      const at = Date.now()
      await runner!.close()
      runner = null
      assert.ok(Date.now() - at < 3_000, 'closing waited past its limit')
      stopsBuild()
      assert.equal(cloud.runner!.live, false)
      assert.equal(job.state, 'claimed')
    })

    it('交接时等本地运行停止后才释放锁（#316）', async () => {
      await building()
      let waiting = false
      let taken = false
      const next = holdMachine('codex', () => {
        stopsBuild()
        taken = true
      }, () => { waiting = true })
      try {
        await until(() => waiting)
        await runner!.close()
        runner = null
        await until(() => taken)
        assert.equal(cloud.runner!.live, true)
      } finally {
        next.release()
      }
    })

    it('when the job’s lease is lost', async () => {
      const job = await building()
      job.leaseLost = true
      await until(() => runs().filter((r) => r.sessionId.startsWith('run-implement')).every((r) => r.status === 'stopped') && runs().length >= 5)
      stopsBuild()
    })

    it('when the user stops it, ending the job stopped (#2128)', async () => {
      const job = await building()
      cloud.stopOverLog('j2')
      await until(() => job.state === 'finished')
      assert.equal(job.outcome, 'stopped', job.reason)
      stopsBuild()
    })
  })

  describe('resuming a build (#2128)', () => {
    it('恢复已完成的规划时保留评审，不再次执行规划（#316）', async () => {
      process.env.FAKE_AKB = JSON.stringify({ refine: { status: 'planned', question: '请选择计费方式' } })
      await flowJob('j1', { verb: 'create' })
      const before = cardCalls().length
      const job = await flowJob('j2', { verb: 'create', resume: true })
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal((job.report?.review as { question: string }).question, '请选择计费方式')
      assert.equal(cardCalls().length, before)
      assert.equal(calls().filter((c) => c[0] === 'raw' && c[1] === 'create').length, 1)
    })

    const priorBuild = (over: Record<string, unknown> = {}) => {
      const earlier = Date.now() - 1_000
      fs.writeFileSync(path.join(board(), '.fake', 'runs.json'), JSON.stringify([
        { sessionId: 'old-plan', cardId: 2, action: 'refine', status: 'done', startedAt: earlier + 1 },
        { sessionId: 'old-build', cardId: 2, action: 'implement', status: 'stopped', deliveryId: 'd1', resumeId: 'original-thread', startedAt: earlier + 2, ...over },
        { sessionId: 'other-delivery', cardId: 2, action: 'implement', status: 'stopped', deliveryId: 'd2', resumeId: 'other-thread', startedAt: earlier + 3 },
        { sessionId: 'helper', cardId: 2, action: 'sub', status: 'stopped', deliveryId: 'd1', startedAt: earlier + 4 },
      ]))
    }

    it('resumes the original build conversation without implementing or resolving again', async () => {
      await flowJob('j1', { verb: 'create' })
      priorBuild()
      const job = await flowJob('j2', { verb: 'implement', card: 2, text: 'Monthly', resume: true })
      assert.equal(job.outcome, 'done', job.reason)
      const log = calls().map((c) => c.join(' '))
      const at = log.indexOf(`delivery resume 2 --json --board ${board()}`)
      assert.ok(at >= 0 && log.slice(at).includes(`run resume old-build --require-session --follow --events --json --board ${board()}`))
      assert.ok(!cardCalls().some((c) => /card (implement|resolve)/.test(c)))
      assert.equal(job.report?.session, 'original-thread')
      assert.equal((job.report?.landing as { commit?: string })?.commit, 'abc123')
      assert.ok(job.events?.some((e) => e.kind === 'message'))
    })

    it('resumes an active delivery, and returns immediately if it already landed', async () => {
      await flowJob('j1', { verb: 'create' })
      priorBuild({ deliveryId: 'd2', startedAt: Date.now() - 1 })
      process.env.FAKE_AKB = JSON.stringify({ delivery: { refuse: 'delivery d2 has not ended — it is still in flight on #2.', reason: 'deliveryActive', args: { id: 'd2' } } })
      assert.equal((await flowJob('j2', { verb: 'implement', card: 2, resume: true })).outcome, 'done')
      assert.ok(calls().some((c) => c[0] === 'run' && c[1] === 'resume' && c[2] === 'old-build'))
      process.env.FAKE_AKB = JSON.stringify({ delivery: { landed: true } })
      const landed = await flowJob('j4', { verb: 'implement', card: 2, resume: true })
      assert.equal(landed.outcome, 'done', landed.reason)
      assert.deepEqual(flowReport(landed), { card: 2 })
    })

    it('continues a cleanly ended build inside its existing delivery', async () => {
      await flowJob('j1', { verb: 'create' })
      priorBuild({ status: 'done' })
      const job = await flowJob('j2', { verb: 'implement', card: 2, resume: true })
      assert.equal(job.outcome, 'done', job.reason)
      assert.ok(calls().some((c) => c[0] === 'run' && c[1] === 'resume' && c[2] === 'old-build'))
      assert.equal(calls().filter((c) => c[0] === 'run' && c[1] === 'resume').length, 1)
      assert.ok(!cardCalls().some((c) => c.startsWith('card implement')))
    })

    it('builds afresh when there is nothing to carry on (#419)', async () => {
      await flowJob('j1', { verb: 'create' })
      // An approved build a Runner update cut off before it opened a delivery (#407).
      process.env.FAKE_AKB = JSON.stringify({ delivery: { refuse: 'no delivery here answers to "2"', reason: 'deliveryNotFound', args: { id: '2' } } })
      const builds = async (job: string) => {
        const before = cardCalls().length
        assert.equal((await flowJob(job, { verb: 'implement', card: 2, resume: true })).outcome, 'done')
        assert.ok(cardCalls().slice(before).some((c) => c.startsWith('card implement')))
        const file = fs.readdirSync(path.join(board(), '.archive')).find((n) => n.startsWith('2-'))
        if (file) fs.renameSync(path.join(board(), '.archive', file), path.join(board(), 'todo', file))
      }
      await builds('j2')
      // A delivery with no run to rejoin, then one whose conversation cannot be picked up.
      process.env.FAKE_AKB = '{}'
      await builds('j3')
      priorBuild({ resumeId: undefined })
      const missing = await flowJob('j4', { verb: 'implement', card: 2, resume: true })
      assert.equal(missing.outcome, 'failed')
    })

    it('says in a sentence why a resume cannot go on, and reports a finished card as done (#419)', async () => {
      await flowJob('j1', { verb: 'create' })
      process.env.FAKE_AKB = JSON.stringify({ delivery: { refuse: 'delivery d2 is building #2 now', reason: 'deliveryHeld', args: { id: 'd2' } } })
      const held = await flowJob('j2', { verb: 'implement', card: 2, resume: true })
      assert.equal(held.outcome, 'failed')
      assert.match(held.reason ?? '', /「续跑」/)
      const file = fs.readdirSync(path.join(board(), 'todo')).find((n) => n.startsWith('2-'))!
      fs.renameSync(path.join(board(), 'todo', file), path.join(board(), '.archive', file))
      const before = calls().length
      assert.equal((await flowJob('j3', { verb: 'implement', card: 2, resume: true })).outcome, 'done')
      assert.ok(!calls().slice(before).some((c) => c[0] === 'delivery' || c[0] === 'card'))
    })

    it('refuses to complete a resumed task with another delivery’s landing', async () => {
      await flowJob('j1', { verb: 'create' })
      priorBuild({ status: 'done' })
      process.env.FAKE_AKB = JSON.stringify({ resume: { deliveryId: 'd2' } })
      const job = await flowJob('j2', { verb: 'implement', card: 2, resume: true })
      assert.equal(job.outcome, 'failed')
      assert.match(job.reason ?? '', /其他交付/)
      assert.equal(job.report?.landing, undefined)
      assert.ok(!cardCalls().some((c) => c.startsWith('card implement')))
    })

    it('does not fall back to a new implementation when native resume fails', async () => {
      await flowJob('j1', { verb: 'create' })
      priorBuild()
      process.env.FAKE_AKB = JSON.stringify({ resume: { refuse: 'original session not found' } })
      const job = await flowJob('j2', { verb: 'implement', card: 2, resume: true })
      assert.equal(job.outcome, 'failed')
      assert.match(job.reason ?? '', /original session not found/)
      assert.ok(!cardCalls().some((c) => c.startsWith('card implement')))
    })

  })

  describe('discarding a build (#61)', () => {
    it('ends every delivery on the card and preserves its checkout metadata', async () => {
      await flowJob('j1', { verb: 'create' })
      const record = (deliveryId: string, cardId: number, worktree?: string) =>
        fs.writeFileSync(path.join(board(), 'deliveries', `${deliveryId}.json`), JSON.stringify({ deliveryId, cardId, worktree }))
      fs.mkdirSync(path.join(board(), 'deliveries'), { recursive: true })
      record('d1', 2, '.akb/worktrees/2/d1')
      record('d2', 2)
      record('d3', 3, '.akb/worktrees/3/d3')
      const job = await flowJob('j2', { verb: 'discard', card: 2 })
      assert.equal(job.outcome, 'done', job.reason)
      assert.deepEqual(job.report?.card, 2)
      const discarded = calls().filter((c) => c[0] === 'delivery').map((c) => c.join(' '))
      assert.deepEqual(discarded, [`delivery cancel d1 --json --board ${board()}`, `delivery cancel d2 --json --board ${board()}`])
      assert.ok(!cardCalls().some((c) => c.startsWith('card implement')), 'a discard built the card')
    })
  })

  describe('stopping the board runs a force-quit Runner left (#2120)', () => {
    type FakeRun = { sessionId: string; cardId: number; status?: string; startedAt: number }
    const runsFile = () => path.join(board(), '.fake', 'runs.json')
    const runs = () => JSON.parse(fs.readFileSync(runsFile(), 'utf8')) as FakeRun[]
    const leaveRun = () =>
      fs.writeFileSync(runsFile(), JSON.stringify([...runs(), { sessionId: 'run-left', cardId: 2, action: 'refine', status: 'running', startedAt: Date.now() - 1_000 }]))
    const stops = () => calls().filter((c) => c[0] === 'run' && c[1] === 'stop').map((c) => c[2])

    it('when the Runner restarts under a job it held', async () => {
      await flowJob('j1', { verb: 'create' })
      await runner!.close()
      runner = null
      leaveRun()
      const job = cloud.dispatch({ id: 'j2', state: 'claimed', machine: MACHINE, task: 'task_1', project: 'prj_1', number: 2, runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'implement', card: 2 } })
      cloud.runner = { machineId: MACHINE, machineName: 'studio', live: true }
      start()
      await until(() => job.state === 'finished')
      assert.match(job.reason!, /restarted/)
      assert.equal(runs().find((r) => r.sessionId === 'run-left')!.status, 'stopped')
    })

    it('无法确认旧运行已停止时明确失败，不启动新运行（#316）', async () => {
      await flowJob('j1', { verb: 'create' })
      await runner!.close()
      runner = null
      leaveRun()
      const before = cardCalls().length
      const job = cloud.dispatch({ id: 'j2', state: 'claimed', machine: MACHINE, task: 'task_1', project: 'prj_1', number: 2,
        runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'implement', card: 2 } })
      cloud.runner = { machineId: MACHINE, machineName: 'studio', live: true }
      start('', { akb: () => ({ ...fakeAkb(), args: ['-e', 'process.exit(1)', '--'] }) })
      await until(() => job.state === 'finished')
      assert.equal(job.outcome, 'failed')
      assert.match(job.reason!, /未能停止上次运行/)
      assert.equal(cardCalls().length, before)
      assert.equal(runs().find((r) => r.sessionId === 'run-left')!.status, 'running')
    })

    it('before a job works on the card, which then runs as usual', async () => {
      await flowJob('j1', { verb: 'create' })
      leaveRun()
      const job = await flowJob('j2', { verb: 'revise', card: 2, text: 'shorter' })
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal(runs().find((r) => r.sessionId === 'run-left')!.status, 'stopped')
      const log = calls().map((c) => c.slice(0, 2).join(' '))
      assert.ok(log.indexOf('run stop') < log.indexOf('card revise'))
    })

    it('but not one another job here is working on', async () => {
      await flowJob('j1', { verb: 'create' })
      process.env.FAKE_AKB = JSON.stringify({ implement: { hang: true } })
      cloud.dispatch({ id: 'j2', task: 'task_1', project: 'prj_1', number: 2, runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'implement', card: 2 } })
      await until(() => runs().some((r) => r.sessionId.startsWith('run-implement') && r.status === 'running'))
      const job = await flowJob('j3', { verb: 'revise', card: 2, text: 'shorter' })
      assert.equal(job.outcome, 'failed')
      assert.equal(job.reason, '#2 is already being worked on')
      assert.deepEqual(stops(), [])
      assert.ok(runs().some((r) => r.sessionId.startsWith('run-implement') && r.status === 'running'))
    })
  })

  it('runs on the runtime’s connector and model, and fails rather than switch when it is missing (#2074)', async () => {
    const used = await flowJob('j1', { verb: 'create' }, { runtime: 'codex', model: 'gpt-5-codex' })
    assert.equal(used.outcome, 'done', used.reason)
    assert.deepEqual(calls().find((c) => c[0] === 'agent')!.slice(0, 3), ['agent', 'use', 'codex'])
    assert.deepEqual(calls().find((c) => c[1] === 'set' && c[2] === 'model')!.slice(0, 4), ['agent', 'set', 'model', 'gpt-5-codex'])
    installed = [{ name: 'codex', installed: true }, { name: 'claude-code', installed: false }]
    const missing = await flowJob('j2', { verb: 'approve', card: 2 })
    assert.equal(missing.outcome, 'failed')
    assert.equal(missing.reason, 'Claude Code is not installed on this computer.')
    installed = [{ name: 'codex', installed: true }, { name: 'claude-code', installed: true, loggedIn: false }]
    const signedOut = await flowJob('j3', { verb: 'approve', card: 2 })
    assert.equal(signedOut.reason, 'Claude Code is not signed in on this computer.')
    assert.equal(calls().filter((c) => c[0] === 'agent' && c[1] === 'use').length, 1, 'a missing connector was swapped for the other')
  })

  it('names the task’s studio to akb, a built-in and an account’s own, and keeps the version on this machine (#409)', async () => {
    cloud.task.studio = { studio: 'wf_builtin_hyperframes_video', version: 1, files: { 'STUDIO.md': 'x' }, builtin: true }
    await flowJob('j1', { verb: 'create', studio: 'wf_builtin_hyperframes_video' })
    assert.equal(calls().find((c) => c[1] === 'create')![5], 'hyperframes-video')
    assert.ok(!fs.existsSync(path.join(board(), 'agents')), 'a built-in’s agents were written')

    cloud.task = { artifacts: new Map(), studio: { studio: 'wf_7Kx', version: 1, files: { 'STUDIO.md': 'own' } } }
    await flowJob('j2', { verb: 'create', studio: 'wf_7Kx' }, { task: 'task_2', number: 3 })
    assert.equal(calls().filter((c) => c[1] === 'create').at(-1)![5], 'wf-7kx')
    assert.equal(JSON.parse(fs.readFileSync(path.join(runnerHome(), 'studios', 'versions', 'wf_7Kx@1.json'), 'utf8')).files['STUDIO.md'], 'own')
    assert.ok(!fs.existsSync(path.join(board(), 'studios')), 'the version was written to the board')
  })

  it('gives this run alone the MCP servers the studio declares (#2030)', async () => {
    const servers = { mcpServers: { files: { command: 'npx', args: ['-y', '@acme/files'] } } }
    cloud.task.studio = { studio: 'wf_builtin_coding', version: 1, builtin: true, files: { 'STUDIO.md': 'x', 'mcp.json': JSON.stringify(servers) } }
    await flowJob('j1', { verb: 'create' })
    const file = path.join(board(), '.sync', 'task_1.mcp.json')
    assert.deepEqual(calls().find((c) => c[1] === 'set' && c[2] === 'args'), ['agent', 'set', 'args', '--board', board(), '--', `--mcp-config ${file}`])
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), servers)

    assert.equal(
      mcpArgs('codex', servers.mcpServers, file),
      `-c 'mcp_servers.files.command="npx"' -c 'mcp_servers.files.args=["-y","@acme/files"]'`,
    )

    // The task moved onto a newer version.
    cloud.task.studio = { ...cloud.task.studio, version: 2, files: { 'STUDIO.md': 'x' } }
    fs.rmSync(path.join(runnerHome(), 'studios', 'tasks', 'task_1.json'))
    await flowJob('j2', { verb: 'refine', card: 2 })
    assert.deepEqual(calls().filter((c) => c[1] === 'set' && c[2] === 'args').at(-1), ['agent', 'set', 'args', '--board', board()], 'the servers outlived the version')
  })

  it('hands an ACP runtime the MCP servers as its mcpConfig, not as arguments', async () => {
    installed = [{ name: 'opencode', installed: true }]
    const servers = { mcpServers: { files: { command: 'npx', args: ['-y', '@acme/files'] } } }
    cloud.task.studio = { studio: 'wf_builtin_coding', version: 1, builtin: true, files: { 'STUDIO.md': 'x', 'mcp.json': JSON.stringify(servers) } }
    const job = await flowJob('j1', { verb: 'create' }, { runtime: 'opencode' })
    assert.equal(job.outcome, 'done', job.reason)
    const file = path.join(board(), '.sync', 'task_1.mcp.json')
    assert.deepEqual(calls().find((c) => c[1] === 'set' && c[2] === 'args'), ['agent', 'set', 'args', '--board', board()])
    assert.deepEqual(calls().find((c) => c[1] === 'set' && c[2] === 'mcpConfig'), ['agent', 'set', 'mcpConfig', file, '--board', board()])
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), servers)
  })

  it('takes the card holding the task\'s number as its own, whatever its slug (#2108)', async () => {
    cloud.put({ 'todo/2-pricing/root.md': '---\ntitle: Pricing\nquestions: []\n---\n\nSplit.\n' })
    const job = await flowJob('j1', { verb: 'revise', text: 'shorter' })
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.report!.card, 2)
    assert.match(cloud.file('todo/2-pricing/root.md')!, /revise shorter\n$/)
  })

  it('writes a first step\'s card fields, naming only the cards still open here (#2108)', async () => {
    cloud.put({ 'todo/5-open.md': '---\ntitle: Open\nquestions: []\n---\n', '.archive/6-done.md': '---\ntitle: Done\n---\n' })
    const metadata = { priority: 'high', modules: ['web', 'cli'], related: ['WC-5', 'WC-6'], blocked_by: ['WC-5'] }
    const job = await flowJob('j1', { verb: 'create', metadata })
    assert.equal(job.outcome, 'done', job.reason)
    const create = calls().find((c) => c[0] === 'raw' && c[1] === 'create')!
    const flag = (name: string) => create[create.indexOf(name) + 1]
    assert.deepEqual([flag('--priority'), flag('--modules'), flag('--related'), flag('--blocked-by')], ['high', 'web,cli', '5', '5'])
  })

  it('makes no card for a task Cloud has not numbered (#2105)', async () => {
    const job = await flowJob('j1', { verb: 'create' }, { number: null })
    assert.equal(job.outcome, 'failed')
    assert.ok(!calls().some((c) => c[0] === 'raw' && c[1] === 'create'))
  })

  it('works on the card another computer wrote (#2081)', async () => {
    cloud.put({ 'todo/9-task-1.md': '---\ntitle: From elsewhere\nquestions: []\n---\n\nThe plan.\n' })
    const job = await flowJob('j1', { verb: 'revise', card: 9, text: 'shorter' }, { number: 9 })
    assert.equal(job.outcome, 'done', job.reason)
    assert.ok(!calls().some((c) => c[1] === 'create'))
    assert.equal(job.report!.card, 9)
    assert.match(cloud.file('todo/9-task-1.md')!, /The plan\.\n\nrevise shorter\n$/)
  })

  it('works in a project’s own board', async () => {
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'site-')))
    spawnSync('git', ['init', '-q', project])
    fs.writeFileSync(path.join(runnerHome(), 'projects.json'), JSON.stringify({ projects: [project] }))
    const job = await flowJob('j1', { verb: 'create' }, { projectDir: project })
    assert.equal(job.outcome, 'done', job.reason)
    assert.ok(fs.existsSync(path.join(project, '.akb', 'kanban', 'todo', '2-pricing-page.md')))
    assert.ok(!fs.existsSync(cached()))
    assert.equal(fs.existsSync(path.join(project, '.claude', 'skills', 'kanban')), false)
    assert.equal(spawnSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '', 'the skill or board reached git')
  })

  it('runs studio authoring like any other studio, without a hidden draft or publication report', async () => {
    for (const studio of ['wf_builtin_studio_builder', 'wf_own_authoring']) {
      process.env.FAKE_AKB = JSON.stringify({ refine: { result: 'Draft ready.' } })
      const job = await flowJob(`author-${studio}`, { verb: 'create', studio })
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal(job.report?.studio, undefined)
      assert.equal(cloud.file('studios/task-1/STUDIO.md'), null)
      assert.doesNotMatch(cloud.file('todo/2-task.md') ?? '', /studio folder:/)
    }
  })
})

describe('periodic agents on the Runner (#2068)', () => {
  let project = ''
  const board = () => path.join(project, '.akb', 'kanban')
  const periodic = () => JSON.parse(fs.readFileSync(path.join(board(), '.fake', 'periodic'), 'utf8'))
  const agent = (over: Record<string, unknown>) =>
    ({ cadence: 'auto', fallback: '1d', since: null, lastSuccess: null, attempts: [], newWork: true, ...over })

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'periodic-'))
    fs.writeFileSync(path.join(runnerHome(), 'projects.json'), JSON.stringify({ projects: [project] }))
    cloud.folders = [{ project: 'prj_1', name: 'Site', path: project, notify: true, machine: MACHINE }]
    cloud.task = { artifacts: new Map() }
  })
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }))

  it('is due by this computer\'s clock: on its gap, with something new, and never twice at once', () => {
    const now = Date.parse('2026-10-26T10:00:00')
    const at = (h: number) => new Date(now - h * 3_600_000).toISOString()
    const prune = (over: Record<string, unknown>) => agentDue(agent({ name: 'prune-memory', fallback: '7d', ...over }) as never, now)
    assert.equal(prune({}), true, 'one never run was not due')
    assert.equal(prune({ since: at(1) }), false, 'one first seen an hour ago was due')
    assert.equal(prune({ lastSuccess: at(24 * 8) }), true)
    assert.equal(prune({ lastSuccess: at(24 * 8), attempts: [{ startedAt: at(1), status: 'error' }] }), false, 'a failure was retried at once')
    assert.equal(prune({ attempts: [{ startedAt: at(0), status: 'running' }] }), false, 'a second ran beside the first')
    assert.equal(agentDue(agent({ name: 'night-auditor', cadence: '1d at 09:30', lastSuccess: at(25) }) as never, now), true)
    assert.equal(agentDue(agent({ name: 'night-auditor', cadence: '1d at 09:30', lastSuccess: at(25), newWork: false }) as never, now), false)
  })

  it('comes round on the hour, whatever minute Cloud stamped the last pass (#291)', () => {
    const six = (lastSuccess: string, now: string) => agentDue(agent({ name: 'night-auditor', cadence: '6h', lastSuccess }) as never, Date.parse(now))
    assert.equal(six('2026-10-26T12:00:40', '2026-10-26T18:00:00'), true)
    assert.equal(six('2026-10-26T12:01:10', '2026-10-26T18:00:00'), true, 'a pass stamped past the hour lost an hour')
    assert.equal(six('2026-10-26T11:59:50', '2026-10-26T17:00:00'), false, 'a pass stamped before the hour came round early')
    assert.equal(new Date(nextHour(Date.parse('2026-10-26T12:00:00'))).getHours(), 13)
    assert.equal(new Date(nextHour(Date.parse('2026-10-26T12:59:59'))).getHours(), 13)
  })

  it('resolves a scheduled agent’s saved three-way conflict without replaying its work (#885)', async () => {
    const note = 'memory/describe-project.md'
    cloud.put({ 'config.md': '# Board\n', [note]: 'Original description.\n' })
    cloud.beforeNextCommit = () => cloud.put({ [note]: 'Cloud description.\n' })
    const repair = `
      const fs = require('fs'), cp = require('child_process'), path = require('path')
      const board = process.env.AI4KANBAN_BOARD
      const cli = ${JSON.stringify(path.join(process.env.RUNNER_DIST!, 'akb/bin/ai4kanban.mjs'))}
      const call = (...args) => JSON.parse(cp.execFileSync(process.execPath, [cli, '--board', board, 'raw', 'conflict', ...args, '--json']))
      const id = call('list').conflicts[0].id
      const record = call('show', id).conflict
      const found = record.files.find(file => file.path === '${note}')
      if (found.base.content !== 'Original description.\\n' || found.remote.content !== 'Cloud description.\\n') throw Error('Expected three versions')
      const file = path.join(board, '.sync/description-resolution.json')
      fs.writeFileSync(file, JSON.stringify({ files: [{ path: found.path, content: 'Merged description.\\n' }] }))
      call('resolve', id, '--expect', record.revision, '--file', file)
    `
    start('', { plan: fakeRuntime(repair) })
    const job = cloud.dispatch({ id: crypto.randomUUID(), project: 'prj_1', projectDir: project,
      agent: { name: 'describe-project' }, runtime: 'claude-code' })
    await until(() => job.state === 'finished', 10_000)
    assert.equal(job.outcome, 'done', [job.reason, ...job.events.map(event => event.text)].join('\n'))
    assert.equal(cloud.file(note), 'Merged description.\n')
    assert.equal(conflictList(board()).length, 0)
  })

  it('looks only when the hour comes: not on connecting, nor on a heartbeat (#291)', async () => {
    cloud.periodic = [agent({ name: 'prune-memory', fallback: '7d' })]
    start(undefined, {}, MACHINE, (now) => now + 600)
    await until(() => cloud.registrations >= 3)
    assert.equal(cloud.asked.length, 0)
    await until(() => cloud.asked.length > 0)
    assert.equal(cloud.asked[0]!.agent, 'prune-memory')
  })

  it('skips an hour it slept past (#291)', async () => {
    cloud.periodic = [agent({ name: 'prune-memory', fallback: '7d' })]
    start(undefined, {}, MACHINE, (now) => now - 60_001)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(cloud.asked.length, 0)
  })

  it('asks for what is due, runs it on the project\'s board, and sends the memory back', async () => {
    cloud.periodic = [agent({ name: 'prune-memory', fallback: '7d' }), agent({ name: 'describe-project', lastSuccess: new Date().toISOString() })]
    start()
    await until(() => cloud.jobs.get('agent-1')?.state === 'finished')
    const job = cloud.jobs.get('agent-1')!
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(cloud.asked[0], { project: 'prj_1', agent: 'prune-memory', studio: null, seen: null })
    assert.ok(cloud.asked.every((a) => a.agent === 'prune-memory'), 'an agent with nothing new was asked for')
    assert.deepEqual(periodic().args.slice(0, 1), ['prune-memory'])
    assert.equal(cloud.file('memory/prune-memory.md'), 'prune-memory ran.\n')
  })

  it('reflects on the tasks it was handed, proposing from the first', async () => {
    process.env.FAKE_AKB = JSON.stringify({ reflect: { propose: 'Add a pricing FAQ' } })
    cloud.put({ '.archive/7-task-7.md': '---\ntitle: Pricing\n---\n\nTiers.\n' })
    const job = cloud.dispatch({ id: 'r1', project: 'prj_1', projectDir: project, agent: { name: 'reflect', tasks: [{ id: 'task_7', number: 7 }, { id: 'task_8', number: 8 }] } })
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(periodic(), { args: [...periodic().args.slice(0, 1), '--cards', '7', '8', ...periodic().args.slice(4)], task: 'task_7', scheduled: '' })
    assert.match(cloud.file('triage/proposed.md')!, /title: Add a pricing FAQ\n[\s\S]*source_task: task_7\n/)
  })

  it('tells a reflection the studio agents Cloud has on, and no other agent (#277)', async () => {
    const row = (name: string, studio?: string) => agent({ name, studio, newWork: false, reads: 'archived-cards' })
    cloud.periodic = [row('prune-memory'), row('night-auditor', 'coding'), row('night-auditor', 'wf_own'), row('seo-writer', 'wf_own')]
    const job = cloud.dispatch({ id: 'r1', project: 'prj_1', projectDir: project, agent: { name: 'reflect', tasks: [{ id: 'task_7', number: 7 }] } })
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(periodic().scheduled, 'night-auditor,seo-writer')

    const other = cloud.dispatch({ id: 'p1', project: 'prj_1', projectDir: project, agent: { name: 'prune-memory' } })
    await until(() => other.state === 'finished')
    assert.equal(periodic().scheduled, undefined)
  })

  it('reflects without the list when Cloud cannot give it (#277)', async () => {
    cloud.failAgents = true
    const job = cloud.dispatch({ id: 'r1', project: 'prj_1', projectDir: project, agent: { name: 'reflect', tasks: [{ id: 'task_7', number: 7 }] } })
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(periodic().scheduled, undefined)
  })

  it('starts a project discussion without board reads or uploads (#711)', async () => {
    cloud.put({ 'todo/4-pricing.md': '---\ntitle: Pricing\n---\n\nTiers.\n' })
    const boardPath = path.join(fs.realpathSync(project), '.akb', 'kanban')
    const local = path.join(boardPath, 'todo', '4-pricing.md')
    fs.mkdirSync(path.dirname(local), { recursive: true })
    fs.writeFileSync(local, 'Local draft that has not been uploaded.')
    const job = cloud.dispatch({ id: 'd1', project: 'prj_1', projectDir: project, discussion: { id: 'dsc_1', workspace: 'ws_1', ideas: [] } })
    start(`if (process.env.AI4KANBAN_BOARD !== ${JSON.stringify(boardPath)}) process.exit(4);`)
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(fs.readFileSync(local, 'utf8'), 'Local draft that has not been uploaded.')
    assert.ok(!cloud.log.some(line => line.includes('/board') || line.includes('/artifacts')), cloud.log.join('\n'))
  })

  it('runs a studio\'s scheduled agent by its akb name, and fails a project with no folder here', async () => {
    const audit = cloud.dispatch({ id: 'q1', project: 'prj_1', projectDir: project, agent: { name: 'night-auditor', studio: 'wf_builtin_coding' } })
    const away = cloud.dispatch({ id: 'q2', project: 'prj_1', projectDir: null, agent: { name: 'prune-memory' } })
    start()
    await until(() => audit.state === 'finished' && away.state === 'finished')
    assert.equal(audit.outcome, 'done', audit.reason)
    assert.deepEqual(periodic().args.slice(0, 4), ['agent', 'run', 'coding', 'night-auditor'])
    assert.equal(away.outcome, 'failed')
    assert.equal(away.reason, 'This project has no folder on this computer.')
  })
})

describe('chat memory reviewed on the Runner (#2065)', () => {
  const ARCHIVED = '2026-10-30T09:00:00.000Z'
  const board = () => path.join(cached(), '.akb', 'kanban')
  const record = (task = 'task_1') => path.join(runnerHome(), 'chats', `${task}.jsonl`)
  const lines = (task = 'task_1') => fs.readFileSync(record(task), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const reviewed = () => JSON.parse(fs.readFileSync(path.join(runnerHome(), 'chats', 'reviewed.json'), 'utf8'))
  const said = (task: string, ...messages: [string, string, number?][]) => {
    fs.mkdirSync(path.dirname(record(task)), { recursive: true })
    fs.appendFileSync(record(task), messages.map(([id, text, at]) =>
      `${JSON.stringify({ id, role: id.startsWith('msg') ? 'user' : 'agent', text, at: at ?? Date.now(), ...(id.startsWith('msg') ? {} : { runtime: 'codex', model: 'gpt-5' }) })}\n`).join(''))
  }

  beforeEach(() => {
    cloud.task = { artifacts: new Map() }
    cloud.put({ '.archive/1-task-1.md': '---\ntitle: Pricing\n---\n\nTiers.\n' })
  })

  it('keeps a chat’s reply beside the message it answers, and nothing of another job', async () => {
    const job = cloud.dispatch({ id: 'j1', task: 'task_1', project: 'prj_1', model: 'gpt-5', chat: { message: 'msg_1', body: 'Why tiers?' } })
    const other = cloud.dispatch({ id: 'j2', task: 'task_2', project: 'prj_1' })
    start()
    await until(() => job.state === 'finished' && other.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(lines().map(({ at, ...l }) => l), [
      { id: 'msg_1', role: 'user', text: 'Why tiers?' },
      { id: 'j1', role: 'agent', text: 'Two tiers.', runtime: 'codex', model: 'gpt-5' },
    ])
    assert.ok(!fs.existsSync(record('task_2')))
  })

  it('drops what is past 30 days as it starts, and a chat left empty', async () => {
    const old = Date.now() - 31 * 24 * 60 * 60_000
    said('task_1', ['msg_1', 'Old', old], ['j1', 'Older reply', old], ['msg_2', 'New'])
    said('task_2', ['msg_3', 'Gone', old])
    start()
    assert.deepEqual(lines().map((l) => l.text), ['New'])
    assert.ok(!fs.existsSync(record('task_2')))
  })

  const reviewOf = async () => {
    cloud.chats = [{ task: 'task_1', project: 'prj_1', number: 1, archivedAt: ARCHIVED }]
    start()
    await until(() => [...cloud.jobs.values()].some((j) => j.review && j.state === 'finished'))
    const job = [...cloud.jobs.values()].find((j) => j.review)!
    assert.equal(job.outcome, 'done', job.reason)
    await until(() => reviewed().tasks?.task_1?.archivedAt === ARCHIVED)
  }
  for (const failure of ['conversation', 'decisions']) it(`leaves memory review retryable after ${failure} failure (#842)`, async () => {
    cloud.chats = [{ task: 'task_1', project: 'prj_1', number: 1, archivedAt: ARCHIVED }]
    cloud.taskChats.task_1 = [{ id: 'msg_1', role: 'user', body: 'Always use plain labels.', created_at: ARCHIVED }]
    const readChat = async () => ({ ok: false as const, error: 'Unavailable' })
    start('', { api: { ...api,
      ...(failure === 'conversation' ? { readChat } : {}),
      ...(failure === 'decisions' ? { readDecisions: async () => ({ ok: false as const, error: 'Unavailable' }) } : {}),
    } })
    await until(() => [...cloud.jobs.values()].some(j => j.review && j.state === 'finished'))
    const job = [...cloud.jobs.values()].find(j => j.review)!
    assert.equal(job.outcome, 'failed')
    const file = path.join(runnerHome(), 'chats', 'reviewed.json')
    assert.equal(fs.existsSync(file) ? reviewed().tasks.task_1 : undefined, undefined)
  })
  it('marks a review only after Preview memory is synchronized (#842)', async () => {
    await reviewOf()
    assert.match(cloud.shared('memory/previews/coding/prompts/workspace/style.md')!, /Style:/)
    assert.match(cloud.file('memory/previews/coding/prompts/project/rules.md')!, /Writing:/)
  })

  it('does not mark a review whose shared memory has an unresolved conflict (#842)', async () => {
    const shared = 'memory/previews/coding/prompts/workspace/style.md'
    cloud.beforeNextCommit = () => cloud.putShared({ [shared]: 'Changed elsewhere' })
    cloud.chats = [{ task: 'task_1', project: 'prj_1', number: 1, archivedAt: ARCHIVED }]
    start()
    await until(() => [...cloud.jobs.values()].some(j => j.review && j.state === 'finished'))
    const job = [...cloud.jobs.values()].find(j => j.review)!
    assert.equal(job.outcome, 'failed')
    assert.equal(cloud.shared(shared), 'Changed elsewhere')
    const file = path.join(runnerHome(), 'chats', 'reviewed.json')
    assert.equal(fs.existsSync(file) ? reviewed().tasks.task_1 : undefined, undefined)
  })
  const hour = (h: number) => `2026-10-30T0${h}:00:00.000Z`
})

describe('connection tests (#2074)', () => {
  const test = async (id: string, script: string, extra: Partial<FakeJob> = {}, testMs = 2_000) => {
    const job = cloud.dispatch({ id, test: true, runtime: 'claude-code', model: 'haiku', prompt: 'Reply with OK.', ...extra })
    if (!runner) start(script, { testMs })
    await until(() => job.state === 'finished')
    return job
  }

  it('names a connector that is missing or signed out, without starting it', async () => {
    installed = [{ name: 'codex', installed: false }, { name: 'claude-code', installed: true, loggedIn: false }]
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
    installed = [{ name: 'codex', installed: false }, { name: 'claude-code', installed: true }]
    const job = await test('t1', 'console.log("OK")', { runtime: 'codex' })
    assert.equal(job.reason, 'not_installed')
    assert.deepEqual(cloud.runtimes, installed)
  })

  it('holds an ACP runtime\'s turn, and stops one that answers too late', async () => {
    installed = [{ name: 'cursor', installed: true }]
    const ok = cloud.dispatch({ id: 't1', test: true, runtime: 'cursor', prompt: 'Reply with OK.' })
    start('', { plan: acpRuntime() })
    await until(() => ok.state === 'finished')
    assert.equal(ok.outcome, 'done', ok.reason)
    await runner!.close()
    runner = null
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
      installed = [{ name: 'claude-code', installed: true, loggedIn: true }, { name: 'cursor', installed: true, loggedIn: true, models: [{ id: 'c1', name: 'C1' }] }]
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
        ? { discussion: { id: `d760_${i}`, workspace: 'ws_1', ideas: [] } }
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
    runner = null
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
  const job = cloud.dispatch({ id: 'catalog722', discussion: { id: 'd722', workspace: 'ws_1', ideas: [] } })
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
          fs.writeFileSync(proof, fs.readFileSync(path.join(runnerHome(), 'ideas', 'catalog722.json')))
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
          if (attempt === 1) { await until(() => firstPending); return { ok: false, error: disconnect.reason, failure: disconnect } }
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
