import { IDLE_TIMEOUT } from '../../cli/src/lib/agent/idle'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { readCheckpoint, saveCheckpoint } from '../src/recovery'
import { runnerHome } from '../src/home'
import { stopMark } from '../../cli/src/lib/agent/stop'
import { createAntigravityRenderer } from '../../cli/src/lib/agent/wire/antigravity'
import { type Deps } from '../src/jobs'
import { until } from './fake-cloud'
import { cloud, runner, planned, MACHINE, fakeRuntime, start, overload, validation, disconnect } from './runner-harness'

describe('the Runner', () => {
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
    const events = fs.readFileSync(path.join(runnerHome(), 'logs/runner.log'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line)).filter(row => row.component === 'runner' && row.stage === 'registration')
      .map(row => row.event)
    assert.equal(events[0], 'connected')
    assert.ok(events.includes('reconnecting'))
    assert.equal(events.at(-1), 'connected')
  })

  it('connects and completes a task when the logs directory is unusable', async () => {
    const logs = path.join(runnerHome(), 'logs')
    fs.writeFileSync(logs, 'blocked')
    const job = cloud.dispatch({ id: 'log-unavailable' })
    start()
    await until(() => job.state === 'finished')
    assert.ok(cloud.registrations > 0)
    assert.equal(job.outcome, 'done')
    assert.equal(fs.readFileSync(logs, 'utf8'), 'blocked')
  })

  for (const discussion of [false, true]) for (const protocol of [false, true]) it(
    `five-minute idle recovery uses four retries: ${protocol ? 'protocol' : 'stream'} ${discussion ? 'discussion' : 'task chat'}`, async () => {
    const original = IDLE_TIMEOUT.milliseconds
    IDLE_TIMEOUT.milliseconds = 300
    try {
      const job = cloud.dispatch({ id: 'idle-recovery', ...(discussion
        ? { discussion: { id: 'idle-discussion', workspace: 'ws_1', goals: [] } }
        : { chat: { message: 'm1', body: 'Continue' } }) })
      start('', { plan: (...args) => {
        const p = fakeRuntime('setInterval(() => console.log("Heartbeat"), 25)')(...args)
        p.renderer!.events = () => [{ kind: 'status', data: { state: 'running', source: 'sync' } }]
        p.renderer!.background = () => 2
        if (protocol) p.converse = async (child, event) => {
          event({ kind: 'message', data: { text: 'Progress before interruption.' } })
          child.stdout?.on('data', () => event({ kind: 'status', data: { state: 'running', source: 'acp' } }))
          return new Promise(() => {})
        }
        return p
      } })
      await until(() => job.state === 'finished', 20_000)
      assert.deepEqual(planned.map(p => p.resume), [null, ...Array(4).fill('fresh-session')])
      assert.equal(job.outcome, 'failed')
      assert.match(job.reason!, /idle timeout/)
      assert.equal(readCheckpoint(job.id)?.retry?.attempt, 5)
      if (protocol) assert.match(String(job.report?.reply ?? ''), /Progress before interruption/)
    } finally { IDLE_TIMEOUT.milliseconds = original }
  })

  for (const converse of [false, true]) for (const discussion of [false, true]) {
    it(`有限重试保留原消息与附件 ${converse ? 'ACP' : 'printed'} ${discussion ? 'discussion' : 'task'}`, async () => {
      const job = cloud.dispatch({ id: 'retry-turn', prompt: '原消息与上下文', attachments: [{ name: 'shot.png', content: 'aGk=' }],
        ...(discussion ? { discussion: { id: 'd1', workspace: 'ws_1', goals: [] } } : { chat: { message: 'm1', body: '原消息' } }) })
      let calls = 0
      start('', { plan: (...args) => {
        const failed = ++calls < 2
        const p = fakeRuntime(failed
          ? 'console.log("first stdout"); console.error("first stderr"); process.exitCode = 1'
          : 'console.log("完成"); console.error("retry stderr")')(...args)
        p.renderer!.events = () => []
        p.renderer!.executionFailure = () => failed ? overload : undefined
        p.renderer!.usage = () => ({ input: 10, cacheCreation: 1, cacheRead: 2, output: 3 })
        p.renderer!.costUsd = () => 0.25
        if (converse) p.converse = async (child, event) => {
          await once(child, 'close')
          event({ kind: 'message', data: { text: failed ? '' : '完成' } })
          const spent = { usage: p.renderer!.usage!(), costUsd: p.renderer!.costUsd!() }
          return failed ? { ok: false, error: overload.summary, failure: overload, ...spent } : { ok: true, result: '完成', ...spent }
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
      assert.deepEqual(planned.map(p => p.resume), [null, 'fresh-session'])
      const entries = fs.readFileSync(path.join(runnerHome(), 'logs', 'runner.log'), 'utf8').trimEnd().split('\n')
        .map(line => JSON.parse(line)).filter(row => row.component === 'task' && row.job === job.id)
      const [first, retry] = entries.filter(row => row.event === 'exited')
      assert.deepEqual([first.exitCode, retry.exitCode], [1, 0])
      for (const [attempt, stdout, stderr] of [[first, 'first stdout\n', 'first stderr\n'], [retry, '完成\n', 'retry stderr\n']] as const) {
        const output = (stream: string) => entries.filter(row => row.pid === attempt.pid && row.stream === stream).map(row => row.text).join('')
        assert.equal(output('stdout'), stdout)
        assert.equal(output('stderr'), stderr)
      }
    })
  }

  for (const discussion of [false, true]) it(`AGy preserves a partial reply after an unclassified EOF ${discussion ? 'discussion' : 'task'} (#841)`, async () => {
    const session = '00000000-0000-4000-8000-000000000796'
    const partial = '已完成文件更新，保留用户选择的方案。'
    const job = cloud.dispatch({ id: 'agy-interrupted', runtime: 'antigravity', prompt: '按已确认方案更新文件',
      ...(discussion ? { discussion: { id: 'd1', workspace: 'ws_1', goals: [] } } : { chat: { message: 'm1', body: '按已确认方案更新文件' } }) })
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
    assert.equal(planned.length, 5)
    assert.equal(job.outcome, 'failed', job.reason)
    assert.match(job.reason!, /request failed: EOF/)
    assert.equal(job.report?.reply, partial)
  })

  for (const discussion of [false, true]) it(`AGy 仅收到 init 时保存会话，重启后带原始请求续接 ${discussion ? 'discussion' : 'task'} (#830)`, async () => {
    const session = '00000000-0000-4000-8000-000000000830'
    const job = cloud.dispatch({ id: 'agy-early', runtime: 'antigravity', prompt: '用户决定：保留 Cedar830。',
      ...(discussion ? { discussion: { id: 'd1', workspace: 'ws_1', goals: [] } } : { chat: { message: 'm1', body: '保留 Cedar830' } }) })
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
    assert.match(planned[1]!.prompt, /Do not repeat an operation/)
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
        session: resumed ? 'kept' : undefined, retry: { since: Date.now(), attempt: 1, pending: { at: Date.now(), of: 4, failure: overload } },
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
  ]) it(`AGy 按失败原因恢复或请用户处理 ${discussion ? 'discussion' : 'task'} ${reason} (#827)`, async () => {
    const job = cloud.dispatch({ id: 'agy-manual-failure', runtime: 'antigravity',
      ...(discussion ? { discussion: { id: 'd1', workspace: 'ws_1', goals: [] } } : { chat: { message: 'm1', body: '继续' } }) })
    start('', { plan: (...args) => {
      const p = fakeRuntime('process.exit(1)')(...args)
      p.renderer!.events = () => []
      p.renderer!.failure = () => reason
      return p
    } })
    await until(() => job.state === 'finished')
    const needsUser = !/^(429|Antigravity)/.test(reason)
    assert.equal(planned.length, needsUser ? 1 : 5)
    assert.equal(job.outcome, 'failed')
    assert.ok(job.reason?.startsWith(reason))
    assert.equal(readCheckpoint(job.id)?.retry?.attempt, needsUser ? 1 : 5)
    assert.equal(job.report?.failure?.pauseReason, needsUser ? 'authorization' : 'limit')
  })

  for (const reason of ['quota exceeded', 'Please login first', 'unknown model error']) {
    it(`根据运行失败原因决定是否自动重试 ${reason}`, async () => {
      const job = cloud.dispatch({ id: 'model-failure', chat: { message: 'm1', body: '原消息' } })
      start('', { plan: (...args) => {
        const p = fakeRuntime('process.exit(1)')(...args)
        p.renderer!.events = () => []
        p.renderer!.failure = () => reason
        return p
      } })
      await until(() => job.state === 'finished')
      const needsUser = reason !== 'unknown model error'
      assert.equal(planned.length, needsUser ? 1 : 5)
      assert.equal(job.outcome, 'failed')
      assert.ok(job.reason?.startsWith(reason))
      assert.equal(readCheckpoint(job.id)?.retry?.attempt, needsUser ? 1 : 5)
      assert.equal(job.report?.failure?.pauseReason, needsUser ? 'authorization' : 'limit')
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
      const resumable = state === 'completed' || state === 'pending'
      assert.equal(planned.length, resumable ? 2 : 1)
      if (resumable) {
        assert.equal(planned[1]?.resume, 'fresh-session')
        assert.match(planned[1]!.prompt, /Do not repeat an operation/)
      } else assert.equal(job.reason, 'recovery_unsafe')
    })
  }

  for (const failures of [[validation, validation, validation, validation, validation], [disconnect, validation, disconnect, validation, disconnect], [validation, disconnect, disconnect, disconnect, disconnect]]) {
    it(`shares four retry slots across sources (${failures.map(f => f.source).join(',')})`, async () => {
      const job = cloud.dispatch({ id: 'mixed-retry', discussion: { id: 'd1', workspace: 'ws_1', goals: [] } })
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
      if (failures[0]?.source === 'validation') assert.match(planned[1]!.prompt, /Schema check failed/)
      assert.equal(job.report?.failure?.pauseReason, 'limit')
      assert.equal(job.report?.failure?.history.length, failures.length)
    })
  }

  for (const updating of [false, true]) it(`restores a pending deadline after ${updating ? 'an update' : 'a restart'} without consuming it twice`, async () => {
    const job = cloud.dispatch({ id: 'pending-deadline', state: 'claimed', machine: MACHINE, chat: { message: 'm1', body: 'Continue' } })
    const at = Date.now() + 250
    saveCheckpoint(job.id, { updating, pending: [], started: true, effects: true, session: 'kept',
      retry: { since: 0, attempt: 4, pending: { at, of: 4, failure: disconnect } } })
    let startedAt = 0
    start('', { plan: (...args) => {
      assert.equal(readCheckpoint(job.id)?.retry?.pending?.at, at)
      assert.equal(readCheckpoint(job.id)?.retry?.attempt, 4)
      const p = fakeRuntime('process.exit(1)')(...args)
      startedAt = Date.now()
      p.renderer!.events = () => []
      p.renderer!.executionFailure = () => disconnect
      return p
    } })
    await until(() => job.state === 'finished')
    assert.ok(startedAt >= at)
    assert.equal(planned.length, 1)
    assert.equal(readCheckpoint(job.id)?.retry?.attempt, 5)
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
    assert.equal(planned.length, 5)
    assert.equal(job.report?.reply, undefined)
  })
})
