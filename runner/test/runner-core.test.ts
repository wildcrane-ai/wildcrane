import { readRuntimeContext, saveRuntimeContext } from '../../cli/src/lib/agent/cloud-studios'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import * as api from '../src/api'
import { readCheckpoint } from '../src/recovery'
import { runnerHome } from '../src/home'
import { createStreamRenderer, createCodexStreamRenderer } from '../../cli/src/lib/agent/wire'
import { createCodexClient } from '../../cli/src/lib/agent/wire/codex'
import { CLAUDE_REPLY } from '../../cli/test/claude-reply'
import { createAntigravityRenderer } from '../../cli/src/lib/agent/wire/antigravity'
import { readSession, writeSession } from '../../cli/src/lib/cloud/session'
import { plan as runtimePlan } from '../src/runtimes'
import { toWire, type Deps } from '../src/jobs'
import { akbEnv } from '../src/akb'
import { plan } from '../src/runtimes'
import { until, type FakeJob } from './fake-cloud'
import { ACP_AGENT, cloud, runner, clearRunner, planned, MACHINE, fakeAkb, fakeRuntime, gatedScript, acpRuntime, start, withoutTime } from './runner-harness'

describe('the Runner', () => {

  it('does not reread the queue in a loop when a waiting job is refused', async () => {
    const stale = cloud.dispatch({ id: 'stale-authorization' })
    let refused = 0
    const connection = start(undefined, { api: { ...api, claimJob: async (...args) => {
      if (args[1] !== stale.id) return api.claimJob(...args)
      refused++
      return { ok: false, status: 409, code: 'conflict', error: 'This execution no longer has review authorization.' }
    } } }, MACHINE, (now) => now + 60_000, 60_000)
    await until(() => refused > 0)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(refused, 1)
    assert.equal(cloud.jobReads, 1)

    const next = cloud.dispatch({ id: 'next-job' })
    connection.renew()
    await until(() => next.state === 'finished')
    assert.equal(next.outcome, 'done')
  })

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
      clearRunner()
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
      await until(() => readCheckpoint(job.id) === null)
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
    assert.match(job.reason!, /目录授权已变化/)
  })

  it('退出账号停止执行者，不再领取新任务', async () => {
    const { signOut } = await import('../src/settings')
    cloud.dispatch({ id: 'active-logout' })
    const active = start('setInterval(() => {}, 1000)')
    await until(() => planned.length === 1)
    try {
      const result = await signOut()
      assert.equal(result.error, undefined)
      const next = cloud.dispatch({ id: 'after-logout' })
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(next.claims, 0)
      assert.equal(fs.existsSync(path.join(runnerHome(), 'session.json')), false)
    } finally { await active.close() }
  })

  it('uses the execution retry policy for chat, discussions and other jobs (#869)', async () => {
    const chat = cloud.dispatch({ id: 'j1', chat: { message: 'msg_1', body: 'Why?' } })
    const idea = cloud.dispatch({ id: 'j2', discussion: { id: 'dsc_1', workspace: 'ws_1', goals: [] } })
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
      const idea = cloud.dispatch({ id: 'j2', runtime: 'claude-code', discussion: { id: 'dsc_1', workspace: 'ws_1', goals: [] } })
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
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-agy-empty-'))
      const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
      const previous = process.env[homeKey]
      process.env[homeKey] = empty
      try {
        const output = fs.readFileSync(path.join(process.cwd(), '../cli/test/fixtures/antigravity/cached.ndjson'), 'utf8')
        const task = cloud.dispatch({ id: 'agy-task-context', runtime: 'antigravity', model: 'known-model' })
        const discussion = cloud.dispatch({ id: 'agy-discussion-context', runtime: 'antigravity', model: 'known-model',
          discussion: { id: 'dsc_1', workspace: 'ws_1', goals: [] } })
        start('', { plan: (runtime, prompt, cwd, resume) => ({
          ...fakeRuntime(`process.stdout.write(${JSON.stringify(output)})`)(runtime, prompt, cwd, resume),
          renderer: createAntigravityRenderer(), model: () => 'known-model',
        }) })
        await until(() => task.state === 'finished' && discussion.state === 'finished')
        assert.equal(task.outcome, 'done')
        assert.equal(discussion.outcome, 'done')
        assert.equal(used(task), undefined)
        assert.equal(used(discussion), undefined)
      } finally {
        if (previous === undefined) delete process.env[homeKey]
        else process.env[homeKey] = previous
        fs.rmSync(empty, { recursive: true, force: true })
      }
    })

    it('reports AGy task and discussion context limits from local session metadata (#956)', async (t) => {
      const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined
      if (!sqlite) return t.skip('Node SQLite is unavailable')
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-agy-ctx-'))
      const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
      const previous = process.env[homeKey]
      process.env[homeKey] = home
      try {
        const session = '61fdb9f9-a7b8-444a-9b9c-ff60acd817c8'
        const folder = path.join(home, '.gemini', 'antigravity-cli', 'conversations')
        fs.mkdirSync(folder, { recursive: true })
        const db = new sqlite.DatabaseSync(path.join(folder, `${session}.db`))
        db.exec('CREATE TABLE steps (idx INTEGER, metadata BLOB); CREATE TABLE gen_metadata (data BLOB)')
        const varint = (value: number) => {
          const bytes: number[] = []
          let n = value
          do {
            let b = n & 0x7f
            n = Math.floor(n / 128)
            if (n > 0) b |= 0x80
            bytes.push(b)
          } while (n > 0)
          return Buffer.from(bytes)
        }
        const field = (tag: number[], value: Buffer) => Buffer.concat([Buffer.from(tag), varint(value.length), value])
        const promptId = Buffer.from('00000000-0000-4000-8000-000000000956')
        db.prepare('INSERT INTO steps VALUES (?, ?)').run(2, field([0x62], promptId))
        const f10 = Buffer.concat([Buffer.from([0x20]), varint(256_000)])
        db.prepare('INSERT INTO gen_metadata VALUES (?)').run(Buffer.concat([
          field([0x12], varint(4)),
          field([0x22], promptId),
          field([0x0a], field([0x4a], field([0x52], f10))),
        ]))
        db.close()

        const output = fs.readFileSync(path.join(process.cwd(), '../cli/test/fixtures/antigravity/cached.ndjson'), 'utf8')
        const task = cloud.dispatch({ id: 'agy-task-local-limit', runtime: 'antigravity', model: 'known-model' })
        const discussion = cloud.dispatch({ id: 'agy-discussion-local-limit', runtime: 'antigravity', model: 'known-model',
          discussion: { id: 'dsc_1', workspace: 'ws_1', goals: [] } })
        start('', { plan: (runtime, prompt, cwd, resume) => ({
          ...fakeRuntime(`process.stdout.write(${JSON.stringify(output)})`)(runtime, prompt, cwd, resume),
          renderer: createAntigravityRenderer(), model: () => 'known-model',
        }) })
        await until(() => task.state === 'finished' && discussion.state === 'finished')
        assert.equal(task.outcome, 'done')
        assert.equal(discussion.outcome, 'done')
        assert.deepEqual(used(task), { used: 11_102, limit: 256_000 })
        assert.deepEqual(used(discussion), { used: 11_102, limit: 256_000 })
      } finally {
        if (previous === undefined) delete process.env[homeKey]
        else process.env[homeKey] = previous
        fs.rmSync(home, { recursive: true, force: true })
      }
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
      discussion: { id: 'dsc_1', workspace: 'ws_1', goals: [] } })
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

  it('hands a discussion its goals and studios, and reports what the reply left (#2073)', async () => {
    const goals = [{ id: 'idea_1', title: 'Pricing page', outcome: 'Prices.', acceptance: [], studio: 'wf_builtin_coding', task: null }]
    const job = cloud.dispatch({ id: 'j1', discussion: { id: 'dsc_1', workspace: 'ws_1', version: 3, goals } })
    start(`const fs = require('node:fs'); const f = process.env.KANBAN_GOALS; const held = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (held.studios[0].id !== 'wf_builtin_coding') process.exit(4);
      held.goals[0].start = true; fs.writeFileSync(f, JSON.stringify(held))`)
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done')
    assert.deepEqual((job.report as { goals: unknown[] }).goals, [{ ...goals[0], start: true }])
    assert.equal(job.report?.goalsVersion, 3)
    assert.equal(fs.existsSync(path.join(runnerHome(), 'goals', 'j1.json')), false)
  })

  for (const failure of ['retry', 'conflict', 'unavailable']) it(`网页讨论目标保存及回复状态 (${failure}, #982)`, async () => {
    const goals = [{ id: 'idea_1', title: 'Existing', outcome: 'Before', acceptance: [], studio: 'wf_builtin_coding', task: null }]
    const job = cloud.dispatch({ id: 'job_web', language: 'zh', discussion: { id: 'dsc_web', workspace: 'ws_1', version: 4, goals } })
    const attempts: { id: string; outcome: string; report?: api.JobReport }[] = []
    const akb = path.join(process.env.RUNNER_DIST!, 'akb', 'bin', 'ai4kanban.mjs')
    const body = path.join(runnerHome(), 'goal-body.md')
    start(`
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const { spawnSync } = require('node:child_process');
      const run = (...args) => spawnSync(process.execPath, [${JSON.stringify(akb)}, 'goal', ...args], {
        encoding: 'utf8', env: { ...process.env, CODEX_THREAD_ID: 'web-codex-thread' },
      });
      const body = ${JSON.stringify(body)};
      const create = () => run('new', '--title', 'New goal', '--body-file', body);
      assert.notEqual(create().status, 0);
      fs.writeFileSync(body, 'Deliver the goal.');
      const saved = create();
      assert.equal(saved.status, 0, saved.stderr);
      assert.match(saved.stdout, /when this turn ends/);
      const edited = run('save', '--id', 'idea_1', '--title', 'Edited');
      assert.equal(edited.status, 0, edited.stderr);
    `, {
      api: { ...api, finishJob: async (...args) => {
        const [, id, outcome, , report] = args
        attempts.push({ id, outcome, report })
        if (attempts.length === 1 || failure === 'unavailable' && outcome === 'done') return { ok: false, code: 'service_unavailable', error: 'Try again.', status: 503 }
        if (failure === 'conflict' && outcome === 'done') return { ok: false, code: 'version_conflict', error: 'The goals changed.', status: 409 }
        return api.finishJob(...args)
      } },
    })
    await until(() => job.state === 'finished')
    const rejected = failure !== 'retry'
    assert.equal(cloud.discussions.length, 0)
    assert.deepEqual(attempts.map(attempt => attempt.outcome), failure === 'unavailable'
      ? ['done', 'done', 'done', 'done', 'done', 'failed'] : rejected ? ['done', 'done', 'failed'] : ['done', 'done'])
    assert.deepEqual(attempts[0]!.report, attempts[1]!.report)
    assert.equal(attempts[1]!.report?.goalsVersion, 4)
    assert.deepEqual(attempts[1]!.report?.goals?.map(goal => [goal.id, goal.title]), [['idea_1', 'Edited'], ['new_1', 'New goal']])
    assert.equal(job.outcome, rejected ? 'failed' : 'done')
    if (rejected) {
      assert.match(String(job.report?.reply), /^目标未能保存到当前讨论。/)
      assert.equal(job.report?.goals, undefined)
    } else {
      assert.deepEqual(job.report?.goals, attempts[1]!.report?.goals)
    }
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

  it('isolates Studio Previews and skills and keeps the original version on continued task chats', async () => {
    const definition = '---\nname: Example\n---\n\nPrepare the requested draft.'
    const studio = (id: string, version: number) => ({
      studio: id, version, files: {
        'STUDIO.md': `---
name: Example
previews:
  caption: {title: {zh: 字幕}}
  draft: {title: {en: Draft v${version}, zh: 草稿 v${version}}}
  appendix: {}
---

<Preview id="draft">
Instructions for v${version}.
</Preview>
<Preview id="caption">
Caption instructions.
</Preview>
<Preview id="appendix">
Appendix instructions.
</Preview>`,
        'skills/draft/SKILL.md': '---\nname: draft\ndescription: Draft v' + version + '.\n---\n\nRead the format and run both scripts.',
        'skills/draft/reference.txt': 'v' + version,
        'skills/draft/scripts/collect.cjs': "process.stdout.write(require('node:fs').readFileSync(__dirname + '/../reference.txt', 'utf8'))",
        'skills/draft/scripts/format.cjs': "process.stdout.write('Draft ' + require('node:fs').readFileSync(0, 'utf8'))",
      },
    })
    const cwd = cloud.folder!('prj_1')
    const projectSkill = path.join(cwd, '.agents/skills/draft/SKILL.md')
    fs.mkdirSync(path.dirname(projectSkill), { recursive: true })
    fs.writeFileSync(projectSkill, 'A project skill.')
    let count = 0
    start('', { plan: (...args) => {
      const p = fakeRuntime('')(...args)
      const session = args[3] ?? 'studio-session-' + ++count
      const file = / \(file: (.+)\)$/m.exec(args[1])?.[1]
      if (!file) return { ...p, session: () => session }
      const script = [
        "const fs = require('node:fs'), path = require('node:path')",
        "const { execFileSync } = require('node:child_process')",
        "const file = " + JSON.stringify(file),
        "if (!fs.readFileSync(file, 'utf8').includes('run both scripts')) throw Error('Missing skill instructions')",
        "const dir = path.dirname(file)",
        "const data = execFileSync(process.execPath, [path.join(dir, 'scripts/collect.cjs')])",
        "const draft = execFileSync(process.execPath, [path.join(dir, 'scripts/format.cjs')], { input: data })",
        "fs.writeFileSync(" + JSON.stringify(path.join(cwd, session + '.txt')) + ", draft)",
      ].join('\n')
      return { ...p, args: ['-e', script], session: () => session }
    } })
    const launch = async (task: string, id: string, resume: string | null = null, firstCardChat = false) => {
      const job = cloud.dispatch({
        id, task, project: 'prj_1', number: 1, runtime: 'codex', chat: { message: id, body: 'Draft' }, resume,
        replyInput: { body: 'Draft', previousReviewRevision: null, firstCardChat },
      })
      await until(() => job.state === 'finished')
      return job
    }
    let version = 1
    cloud.service = async (_method, url) => {
      const task = /^\/v1\/tasks\/task_(\d+)\/studio$/.exec(url.pathname)?.[1]
      if (task === '1' || task === '2') return studio('wf_draft', version)
      if (task === '3') return studio('wf_other', 1)
      if (task === '4') return { studio: 'wf_plain', version: 1, files: { 'STUDIO.md': definition } }
    }
    const first = await launch('task_1', 'first')
    assert.equal(first.outcome, 'done', first.reason)
    const firstPrompt = planned.at(-1)!.prompt
    const catalog = 'Studio Previews:\n- draft · Draft v1 / 草稿 v1\n- caption · 字幕\n- appendix\nAdd any listed Preview to the review plan with `akb task review <id> --add-previews <ids>`.'
    assert.ok(firstPrompt.includes(catalog + '\n\nWhen a skill applies'))
    assert.match(firstPrompt, /- draft: Draft v1\. .*wf_draft@1\/skills\/draft\/SKILL\.md/)
    assert.doesNotMatch(firstPrompt, /Instructions for v1|run both scripts|collect\.cjs/)
    assert.equal(fs.readFileSync(path.join(cwd, first.report!.session + '.txt'), 'utf8'), 'Draft v1')

    version = 2
    const session = String(first.report!.session)
    const sent = readRuntimeContext('task_1', 'codex', session)
    assert.ok(sent?.['studio-previews'])
    delete sent['studio-previews']
    saveRuntimeContext('task_1', 'codex', session, sent)
    const upgradedRunner = await launch('task_1', 'catalog-backfill', session)
    assert.equal(upgradedRunner.outcome, 'done', upgradedRunner.reason)
    assert.equal(planned.at(-1)!.prompt, catalog + '\n\nDraft')

    const resumed = await launch('task_1', 'continued', session, true)
    assert.equal(resumed.outcome, 'done', resumed.reason)
    assert.equal(planned.at(-1)!.prompt, 'Draft')
    const [next, other] = await Promise.all([launch('task_2', 'new-version'), launch('task_3', 'other-studio')])
    assert.equal(next.outcome, 'done', next.reason)
    assert.equal(other.outcome, 'done', other.reason)
    assert.equal(fs.readFileSync(path.join(cwd, next.report!.session + '.txt'), 'utf8'), 'Draft v2')
    assert.equal(fs.readFileSync(path.join(cwd, other.report!.session + '.txt'), 'utf8'), 'Draft v1')
    assert.ok(planned.some(turn => turn.prompt.includes(catalog.replaceAll('v1', 'v2')) && turn.prompt.includes('wf_draft@2/')))
    assert.ok(planned.some(turn => /wf_other@1/.test(turn.prompt)))
    assert.equal(fs.readFileSync(projectSkill, 'utf8'), 'A project skill.')
    assert.equal(fs.existsSync(path.join(cwd, '.claude/skills/draft')), false)

    const plain = await launch('task_4', 'no-skills')
    assert.equal(plain.outcome, 'done', plain.reason)
    assert.match(planned.at(-1)!.prompt, /Studio Previews: none\.\n\nStudio skills: none\./)

    fs.rmSync(path.join(runnerHome(), 'studios/versions/wf_draft@1.json'))
    const lost = await launch('task_1', 'missing-version', String(first.report!.session))
    assert.equal(lost.outcome, 'failed')
    assert.match(lost.reason ?? '', /Cannot recover Studio wf-draft v1/)
  })

  for (const discussion of [true, false]) it(`sends Codex inputs for fresh, resumed, and rebuilt ${discussion ? 'discussions' : 'card chats'} (#1050)`, async () => {
    const body = '  The newest message:\n\nCan you check this?\n'
    const messages: api.ReplyHistoryMessage[] = Array.from({ length: 30 }, (_, i) => ({ role: 'user', body: `Past message ${i + 1}` }))
    messages.push({ role: 'agent', body: 'Past reply', image_names: ['old.png'] })
    const history = [...messages.slice(0, 30).map(m => `User: ${m.body}`), 'Agent: Past reply\n\n[Pictures: old.png]'].join('\n\n')
    const session = 'thread-1050'
    const calls = path.join(runnerHome(), 'codex-inputs.jsonl')
    const script = `
const fs = require('node:fs')
const out = value => console.log(JSON.stringify(value))
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  const answer = result => out({id: m.id, result})
  const params = m.params ?? {}
  if (m.method === 'thread/resume' || m.method === 'thread/start') {
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({method: m.method, thread: params.threadId}) + '\\n')
    if (params.threadId === 'missing') return out({id: m.id, error: {code: -32600, message: 'no rollout found for thread id missing'}})
    return answer({thread: {id: params.threadId ?? '${session}'}})
  }
  if (m.method === 'turn/start') {
    const [text, ...images] = params.input
    const file = text.text.split(String.fromCharCode(96)).find(part => part.endsWith('/history.md'))
    const history = file && fs.readFileSync(file, 'utf8')
    const mode = file && (fs.statSync(file).mode & 0o777)
    const bytes = images.map(image => fs.readFileSync(image.path, 'utf8'))
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({method: m.method, input: params.input, history, mode, bytes}) + '\\n')
    answer({turn: {id: 't'}})
    const notify = (method, data) => out({method, params: {threadId: params.threadId, turnId: 't', ...data}})
    notify('turn/started', {turn: {id: 't'}})
    notify('item/completed', {item: {id: 'm', type: 'agentMessage', text: 'Seen.'}})
    return notify('turn/completed', {turn: {id: 't', status: 'completed'}})
  }
  answer({})
})
`
    const transport: NonNullable<Deps['plan']> = (...args) => ({ ...runtimePlan(...args), command: process.execPath, args: ['-e', script] })
    const akb = () => ({ ...fakeAkb(), canonicalCommands: true })
    start('', { plan: transport, akb })
    if (!discussion) cloud.task.studio = { studio: 'wf_builtin_coding', version: 1, files: {
      'STUDIO.md': `---
name: Coding
previews:
  prompts: {title: {en: Prompts, zh: 提示词}}
  ui-design: {title: {en: UI design}}
---

<Preview id="prompts">
Prompt review instructions.
</Preview>
<Preview id="ui-design">
UI review instructions.
</Preview>`,
      'skills/draft/SKILL.md': '---\nname: draft\ndescription: Prepare a draft.\n---\n\nSkill instructions.',
    } }
    const catalog = 'Studio Previews:\n- prompts · Prompts / 提示词\n- ui-design · UI design\nAdd any listed Preview to the review plan with `akb task review <id> --add-previews <ids>`.'
    const goals = [{ id: 'g1', title: 'Current goal', studio: 'coding', outcome: 'Outcome', acceptance: [], task: null }]
    const reviewAt = (revision: number): NonNullable<FakeJob['taskReview']> => ({
      revision, plan: [{ id: 'prompts', after: [], previews: ['prompts'] }],
      stages: [{ id: 'prompts', status: 'ready', revision: 7, snapshot: { body: 'full review snapshot' } }],
      approvals: [{ stage: 'prompts', revision: 7, starts: [] }],
    })
    let previousContext: NonNullable<FakeJob['replyInput']>['previousContext']
    const turn = async (id: string, resume: string | null, previousReviewRevision: number | null, revision = 7, firstCardChat = false, status: 'ready' | 'running' = 'ready', expectedSession = session) => {
      const review = reviewAt(revision)
      review.stages[0]!.status = status
      if (id !== 'fresh') cloud.replyHistories.set(id, messages)
      const job = cloud.dispatch({
        id, resume, runtime: 'codex', prompt: 'Legacy prompt with Pictures: old.png',
        attachments: ['first', 'second'].map(bytes => ({ name: 'same.png', content: Buffer.from(bytes).toString('base64') })),
        replyInput: { body, historyOnDemand: true, previousReviewRevision, firstCardChat, previousContext },
        ...(discussion ? { discussion: { id: 'd1050', workspace: 'ws_1', goals: id === 'fresh' ? [] : goals } } : {
          task: 'task_1', project: 'prj_1', number: 1, chat: { message: id, body }, taskReview: review,
        }),
      })
      await until(() => job.state === 'finished')
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal(job.report?.reply, 'Seen.')
      assert.equal(job.report?.session, expectedSession)
      if (!discussion) {
        assert.equal(job.report?.replyReviewRevision, revision)
        assert.ok(job.report?.replyContext)
        previousContext = job.report.replyContext
      }
      const dir = path.join(runnerHome(), 'attachments', id)
      await until(() => !fs.existsSync(dir))
    }
    await turn('fresh', null, null)
    await turn('cleared', null, null)
    await turn('resumed', session, 7)
    if (!discussion) {
      await turn('updated-review', session, 7, 8)
      await turn('stale-first-chat-flag', session, null, 8, true)
    }
    await turn('rebuilt', 'missing', 7)
    const entries = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(entries.map(e => e.method), [
      'thread/start', 'turn/start', 'thread/start', 'turn/start', 'thread/resume', 'turn/start',
      ...(discussion ? [] : ['thread/resume', 'turn/start', 'thread/resume', 'turn/start']), 'thread/resume', 'thread/start', 'turn/start',
    ])
    assert.deepEqual(entries.filter(e => e.method === 'thread/resume').map(e => e.thread),
      [session, ...(discussion ? [] : [session, session]), 'missing'])
    const submitted = entries.filter(e => e.method === 'turn/start')
    for (const entry of submitted) {
      assert.deepEqual(entry.input.map((part: { type: string }) => part.type), ['text', 'localImage', 'localImage'])
      assert.deepEqual(entry.bytes, ['first', 'second'])
      assert.ok(entry.input[0].text.endsWith(body))
      assert.doesNotMatch(entry.input[0].text, /Legacy prompt|Attached files:|same\.png|full review snapshot|Past message|Past reply/)
    }
    assert.equal(submitted[2].input[0].text, body)
    const guide = discussion ? 'akb guide discuss-goal' : 'akb guide card-chat'
    assert.equal(submitted[0].input[0].text.split(guide).length, 2)
    assert.equal(submitted[0].history, undefined)
    assert.equal(submitted[1].history, history + '\n')
    assert.doesNotMatch(submitted[0].input[0].text, /Current Goals:/)
    if (!discussion) {
      const text = submitted[0].input[0].text
      assert.match(text, /Task card: .+\n\nStudio: Coding\. Read `akb studio file coding STUDIO.md` before revising a draft\./)
      assert.ok(text.includes('before revising a draft.\n\n' + catalog + '\n\nWhen a skill applies'))
      assert.match(text, /- draft: Prepare a draft\. .*wf_builtin_coding@1\/skills\/draft\/SKILL\.md\)\n\nReview · prompts \(previews: prompts\) waiting for approval/)
      assert.doesNotMatch(text, /Prompt review instructions|UI review instructions|Skill instructions/)
      assert.equal(submitted[3].input[0].text, `Review updated · prompts (previews: prompts) waiting for approval\n\n${body}`)
      assert.equal(submitted[4].input[0].text, body)
      assert.equal(submitted[4].history, undefined)
    }
    const rebuilt = submitted.at(-1)
    assert.equal(rebuilt.input[0].text.split(guide).length, 2)
    assert.equal(rebuilt.history, history + '\n')
    assert.equal(rebuilt.mode, 0o400)
    if (discussion) assert.match(rebuilt.input[0].text, /Current Goals:\n- g1 · Current goal/)
    else {
      assert.ok(rebuilt.input[0].text.includes(catalog + '\n\nWhen a skill applies'))
      assert.match(rebuilt.input[0].text, /- draft: Prepare a draft\./)
      assert.match(rebuilt.input[0].text, /Review · prompts \(previews: prompts\) waiting for approval/)
      cloud.put({ 'rules/config.md': `---
preferences:
  - projects: [prj_1, prj_secret]
    actions: [chat]
    text: New project defaults.
  - actions: [refine]
    text: Planning only preference.
---` })
      const lastPrompt = () => JSON.parse(fs.readFileSync(calls, 'utf8').trim().split('\n').at(-1)!).input[0].text
      await turn('updated-config', session, 7)
      assert.equal(lastPrompt(), `New project defaults.\n\n${body}`)
      assert.doesNotMatch(lastPrompt(), /Review ·|akb guide/)
      await turn('same-config', session, 7)
      assert.equal(lastPrompt(), body)
      await turn('updated-status', session, 7, 7, false, 'running')
      assert.equal(lastPrompt(), `Review updated · prompts (previews: prompts) running\n\n${body}`)
      cloud.put({ 'rules/config.md': '' })
      await turn('removed-config', session, 7, 7, false, 'running')
      assert.equal(lastPrompt(), `Studio configuration cleared.\n\n${body}`)
      assert.doesNotMatch(lastPrompt(), /Review ·|New project defaults/)
      await runner?.close()
      start('', { plan: transport, akb })
      previousContext = undefined
      await turn('no-context-receipt', session, 7, 7, false, 'running')
      assert.equal(lastPrompt(), body)

      const run = cloud.dispatch({
        id: 'execute-before-chat', task: 'task_1', project: 'prj_1', number: 1, runtime: 'codex',
        resume: 'execution-thread', prompt: 'Run the task', taskReview: reviewAt(7),
      })
      await until(() => run.state === 'finished')
      assert.equal(run.outcome, 'done', run.reason)
      assert.match(lastPrompt(), /Task card: .+\n\nStudio: Coding/)
      previousContext = undefined
      await turn('first-chat-on-execution', 'execution-thread', null, 7, true, 'ready', 'execution-thread')
      assert.match(lastPrompt(), /akb guide card-chat[\s\S]*Review/)
      assert.ok(lastPrompt().includes(catalog))
      assert.doesNotMatch(lastPrompt(), /Task card:|Studio:|Available skills|history/)
      await turn('second-chat-on-execution', 'execution-thread', 7, 7, false, 'ready', 'execution-thread')
      assert.equal(lastPrompt(), body)
      // Changing runtime starts a fresh conversation.
      const acp = path.join(runnerHome(), 'switched-runtime.jsonl')
      await runner?.close()
      start('', { akb, plan: (...args) => ({ ...runtimePlan(...args), command: process.execPath, args: ['-e', ACP_AGENT],
        env: { ...process.env, ACP_CAPTURE: acp } }) })
      const switched = cloud.dispatch({
        id: 'switched', task: 'task_1', project: 'prj_1', number: 1, runtime: 'cursor',
        resume: null, chat: { message: 'switched', body }, replyInput: { body, previousReviewRevision: null, previousContext },
      })
      await until(() => switched.state === 'finished')
      assert.equal(switched.outcome, 'done', switched.reason)
      const received = fs.readFileSync(acp, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        .find(call => call.method === 'session/prompt').params.prompt
      assert.match(received[0].text, /akb guide card-chat[\s\S]*Task card:[\s\S]*Studio: Coding/)
      assert.ok(received[0].text.endsWith(body))
    }
    assert.deepEqual(cloud.replyHistoryReads, ['fresh', 'cleared', 'rebuilt'])
  })

  for (const discussion of [true, false]) it(`uses the same context rules through ACP for ${discussion ? 'discussions' : 'card chats'} (#1055)`, async () => {
    const body = '  First line\n\n  Second line\n'
    const history = 'User: Earlier request\n\nAgent: Earlier reply'
    const session = 's1'
    const log = path.join(runnerHome(), 'acp-turns.jsonl')
    const png = fs.readFileSync('test/fixtures/codex-images/reply.png').toString('base64')
    const script = ACP_AGENT.replace("if (m.method === 'session/prompt') {", `if (m.method === 'session/prompt') {
      const fs = require('node:fs')
      const [{text}, nativeImage] = m.params.prompt
      const file = text.split(String.fromCharCode(96)).find(part => part.endsWith('/history.md'))
      const image = text.split('\\n').find(line => line.endsWith('/shot.png'))?.slice(2)
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
        text, session: m.params.sessionId, history: file && fs.readFileSync(file, 'utf8'),
        image: nativeImage?.data ?? (image && fs.readFileSync(image).toString('base64')),
      }) + '\\n')
    `)
    start('', { plan: (...args) => {
      const p = runtimePlan(...args)
      return { ...p, command: process.execPath, args: ['-e', script], env: {
        ...p.env, ACP_CAPTURE: path.join(runnerHome(), 'acp-requests.jsonl'),
        ...(args[3] === 'missing' ? { ACP_MISSING: '1' } : {}),
      } }
    } })

    const goals = [{ id: 'g1', title: 'Current goal', studio: 'coding', outcome: 'Outcome', acceptance: [], task: null }]
    const review: NonNullable<FakeJob['taskReview']> = { revision: 2, plan: [], stages: [] }
    let previousContext: NonNullable<FakeJob['replyInput']>['previousContext']
    for (const [id, resume] of [['fresh', null], ['resumed', session], ['with-image', session], ['rebuilt', 'missing']] as const) {
      const job = cloud.dispatch({
        id, resume, runtime: 'cursor', prompt: 'Legacy prompt',
        attachments: id === 'with-image' || id === 'rebuilt' ? [{ name: 'shot.png', content: png }] : [],
        replyInput: { body, history: id === 'fresh' ? null : history, previousReviewRevision: 2, previousContext },
        ...(discussion ? { discussion: { id: 'd1055', workspace: 'ws_1', goals: goals } } : {
          task: 'task_1', project: 'prj_1', number: 1, chat: { message: id, body }, taskReview: review,
        }),
      })
      await until(() => job.state === 'finished')
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal(job.report?.session, session)
      previousContext = job.report?.replyContext
    }
    const [fresh, resumed, withImage, rebuilt, ...extra] = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(extra, [])
    const guide = discussion ? /akb guide discuss-goal/ : /akb guide card-chat/
    const context = discussion ? /Current Goals:\n- g1 · Current goal/
      : /Task card: .+\n\nStudio: .+\n\nStudio Previews: none\.\n\nStudio skills: none\.\n\n(?:Consult .+\n\n)?Review · no extra review/
    for (const entry of [fresh, rebuilt]) {
      assert.match(entry.text, guide)
      assert.match(entry.text, context)
      assert.ok(entry.text.endsWith(body))
    }
    assert.deepEqual(resumed, { text: body, session })
    if (discussion) assert.equal(withImage.text, body)
    else {
      assert.match(withImage.text, /^Attached files:\n- .+\/shot\.png\n\n/)
      assert.ok(withImage.text.endsWith(body))
    }
    assert.equal(withImage.image, png)
    assert.equal(rebuilt.image, png)
    assert.equal(rebuilt.history, history + '\n')
    assert.ok([fresh, resumed, withImage, rebuilt].every(entry => !entry.text.includes('Legacy prompt')))
  })

  for (const discussion of [true, false]) it(`does not replay an unconfirmed Codex submission when its ${discussion ? 'discussion' : 'card chat'} session is gone (#1050)`, async () => {
    const log = path.join(runnerHome(), 'codex-recovery.log')
    const script = `
const fs = require('node:fs')
const out = value => console.log(JSON.stringify(value))
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  if (m.method === 'thread/start') out({id: m.id, result: {thread: {id: 'unconfirmed'}}})
  else if (m.method === 'turn/start') {
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(m.params.input) + '\\n')
    if (m.params.threadId === 'unconfirmed') return process.exit(0)
    out({id: m.id, result: {turn: {id: 't'}}})
    out({method: 'turn/completed', params: {threadId: m.params.threadId, turn: {id: 't', status: 'completed'}}})
  } else if (m.method === 'thread/resume') {
    const id = m.params.threadId
    fs.appendFileSync(${JSON.stringify(log)}, id + '\\n')
    if (id === 'unconfirmed') out({id: m.id, error: {code: -32600, message: 'no rollout found for thread id unconfirmed'}})
    else out({id: m.id, result: {thread: {id}}})
  } else out({id: m.id, result: {}})
})
`
    start('', { plan: (...args) => ({ ...runtimePlan(...args), command: process.execPath, args: ['-e', script] }) })
    const input = {
      replyInput: { body: 'One request', history: null, previousReviewRevision: null },
      attachments: [{ name: 'one.png', content: 'aGk=' }],
      ...(discussion ? { discussion: { id: 'd1050', workspace: 'ws_1', goals: [] } } : {
        task: 'task_1', project: 'prj_1', number: 1, chat: { message: 'm1', body: 'One request' },
      }),
    }
    const job = cloud.dispatch({ ...input, id: 'uncertain' })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'failed')
    assert.equal(job.report?.failure?.safeToRetry, false)
    const [submitted, resumed, ...other] = fs.readFileSync(log, 'utf8').trim().split('\n')
    assert.equal(resumed, 'unconfirmed')
    assert.deepEqual(other, [])
    assert.ok(JSON.parse(submitted!)[0].text.endsWith('One request'))
    assert.equal(JSON.parse(submitted!)[1].type, 'localImage')

    const recovered = cloud.dispatch({ ...input, id: 'manual-resume', resume: 'resumable',
      manualRecovery: true, recoveryOf: 'no-local-receipt' })
    await until(() => recovered.state === 'finished')
    assert.equal(recovered.outcome, 'done', recovered.reason)
    const [thread, continuation, ...extra] = fs.readFileSync(log, 'utf8').trim().split('\n').slice(2)
    assert.equal(thread, 'resumable')
    const parts = JSON.parse(continuation!)
    assert.equal(parts.length, 1)
    assert.match(parts[0].text, /Continue the interrupted turn/)
    assert.equal(parts[0].text.split('akb guide card-chat').length, discussion ? 1 : 2)
    assert.doesNotMatch(parts[0].text, /One request/)
    assert.deepEqual(extra, [])

    const missing = cloud.dispatch({ ...input, id: 'manual-missing', resume: 'unconfirmed',
      manualRecovery: true, recoveryOf: 'no-local-receipt' })
    await until(() => missing.state === 'finished')
    assert.equal(missing.outcome, 'failed')
    assert.equal(missing.report?.failure?.safeToRetry, false)
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').slice(4), ['unconfirmed'])
  })

  for (const runtime of ['cursor', 'kimi', 'antigravity', 'opencode'] as const) it(`routes Goal discussion images for ${runtime} (#1054)`, async () => {
    const capture = path.join(runnerHome(), 'acp-input.jsonl')
    const png = fs.readFileSync('test/fixtures/codex-images/reply.png').toString('base64')
    const discussion = { id: 'd1054', workspace: 'ws_1', goals: [] }
    start('', { plan: (...args) => {
      const p = runtimePlan(...args)
      assert.ok(p.converse)
      assert.ok(p.args.includes('acp'))
      return { ...p, command: process.execPath, args: ['-e', ACP_AGENT], env: { ...p.env, ACP_CAPTURE: capture,
        ...(args[1].includes('no native capability') ? { ACP_TEXT_ONLY: '1' } : {}),
      } }
    } })
    for (const [i, prompt] of ['fresh pixels', 'resumed pixels', 'no native capability'].entries()) {
      const name = `turn-${i}.png`
      const job = cloud.dispatch({ id: `pixels-1054-${i}`, runtime, discussion, prompt, resume: i ? 's1' : null,
        attachments: [{ name, content: png }] })
      await until(() => job.state === 'finished')
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal(job.report?.session, 's1')
    }
    const calls = fs.readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const turns = calls.filter(call => call.method === 'session/prompt')
    assert.deepEqual(calls.filter(call => call.method === 'session/load').map(call => call.params.sessionId), ['s1', 's1'])
    assert.equal(turns.length, 3)
    for (const [i, { params }] of turns.entries()) {
      const [text, ...images] = params.prompt
      if (runtime === 'opencode' || i === 2) {
        assert.deepEqual(images, [])
        assert.ok(text.text.includes(path.join(runnerHome(), 'attachments', `pixels-1054-${i}`, `turn-${i}.png`)))
      } else {
        assert.doesNotMatch(text.text, /Attached files/)
        assert.deepEqual(images, [{ type: 'image', mimeType: 'image/png', data: png }])
      }
    }
  })

  it('continues a legacy Goal discussion once with its attachment path when ACP cannot load it (#1054)', async () => {
    const capture = path.join(runnerHome(), 'acp-input.jsonl')
    const png = fs.readFileSync('test/fixtures/codex-images/reply.png').toString('base64')
    const job = cloud.dispatch({ id: 'legacy-1054', runtime: 'kimi', resume: 'old-session', prompt: 'read this image',
      discussion: { id: 'd1054', workspace: 'ws_1', goals: [] }, attachments: [{ name: 'new.png', content: png }] })
    let fallbacks = 0
    start('', { plan: (...args) => {
      const p = runtimePlan(...args)
      return { ...p, command: process.execPath, args: ['-e', ACP_AGENT],
        env: { ...p.env, ACP_CAPTURE: capture, ACP_MISSING: '1' },
        fallback: () => {
          fallbacks++
          const legacy = p.fallback!()
          assert.deepEqual(legacy.args.slice(-4, -1), ['--session', 'old-session', '-p'])
          const file = path.join(runnerHome(), 'attachments', job.id, 'new.png')
          assert.ok(legacy.args.at(-1)?.includes(file))
          assert.equal(fs.readFileSync(file).toString('base64'), png)
          return { ...legacy, command: process.execPath, args: ['-e', 'console.log("continued")'] }
        },
      }
    } })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.report?.session, 'old-session')
    assert.equal(fallbacks, 1)
    assert.doesNotMatch(fs.readFileSync(capture, 'utf8'), /session\/(new|prompt)/)
  })

  it('keeps the submitted image turn on ACP and recovers with a continuation only', async () => {
    const capture = path.join(runnerHome(), 'acp-recovery.jsonl')
    const png = fs.readFileSync('test/fixtures/codex-images/reply.png').toString('base64')
    const input = { runtime: 'antigravity' as const, prompt: 'Read the original image',
      discussion: { id: 'd1058', workspace: 'ws_1', goals: [] }, attachments: [{ name: 'original.png', content: png }] }
    const turns = () => fs.readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    let fallbacks = 0
    start('', { plan: (...args) => {
      const p = runtimePlan(...args)
      assert.ok(p.fallback)
      return { ...p, command: process.execPath, args: ['-e', ACP_AGENT],
        env: { ...p.env, ACP_CAPTURE: capture, ...(!args[3] ? { ACP_PROMPT_FAIL: '1' } : {}) },
        fallback: () => { fallbacks++; return p.fallback!() },
      }
    } })

    const job = cloud.dispatch({ ...input, id: 'submitted-image' })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(turns().filter(call => call.method === 'session/load').map(call => call.params.sessionId), ['s1'])
    const prompts = turns().filter(call => call.method === 'session/prompt')
    assert.equal(prompts.length, 2)
    assert.deepEqual(prompts[0]?.params.prompt, [
      { type: 'text', text: input.prompt },
      { type: 'image', mimeType: 'image/png', data: png },
    ])
    const continuation = prompts[1]?.params.prompt
    assert.equal(continuation?.length, 1)
    assert.match(continuation[0].text, /Continue the interrupted turn/)
    assert.doesNotMatch(continuation[0].text, /Read the original image|original\.png/)
    assert.equal(fallbacks, 0)
  })

  for (const discussion of [false, true]) it(`AGy receives isolated pictures on fresh, resumed, and rebuilt ${discussion ? 'discussion' : 'task chat'} turns (#825)`, async () => {
    const session = '00000000-0000-4000-8000-000000000825'
    const png = fs.readFileSync('test/fixtures/codex-images/reply.png')
    const body = '  Read the pictures in order\n'
    let turn = 0
    let previousContext: NonNullable<FakeJob['replyInput']>['previousContext']
    start('', { plan: (...args) => {
      assert.equal(args[0], 'antigravity')
      if (args[3] === 'missing') {
        const p = runtimePlan(...args)
        return { ...p, command: process.execPath, args: ['-e', ACP_AGENT], env: { ...p.env, ACP_MISSING: '1' } }
      }
      assert.equal(args[3], turn === 1 ? session : null)
      assert.ok(args[1].endsWith(body))
      if (turn === 1) assert.doesNotMatch(args[1], /akb guide|history/)
      else assert.match(args[1], /akb guide/)
      if (turn === 2) assert.match(args[1], /Earlier turn|history\.md/)
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
    for (turn = 0; turn < 3; turn++) {
      const job = cloud.dispatch({ id: `pictures-${turn}`, runtime: 'antigravity', resume: turn === 0 ? null : turn === 1 ? session : 'missing',
        prompt: 'Legacy prompt',
        replyInput: { body, history: turn ? 'User: Earlier turn' : null, previousReviewRevision: null, previousContext },
        attachments: Array.from({ length: turn + 1 }, (_, i) => ({ name: `${i}.png`, content: png.toString('base64') })),
        ...(discussion ? { discussion: { id: 'd825', workspace: 'ws_1', goals: [] } } : { task: 'task_1', project: 'prj_1', number: 1, chat: { message: `m${turn}`, body } }),
      })
      await until(() => job.state === 'finished')
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal(job.report?.session, session)
      previousContext = job.report?.replyContext
      await until(() => !fs.existsSync(path.join(runnerHome(), 'attachments', job.id)))
    }
    assert.equal(planned.length, 3)
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
      ...(discussion ? { discussion: { id: 'd828', workspace: 'ws_1', goals: [] } }
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
})
