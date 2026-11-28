import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import * as api from '../src/api'
import { readCheckpoint, saveCheckpoint } from '../src/recovery'
import { startRunner } from '../src/connect'
import { acquireMachine, RunnerAlreadyRunning } from '../src/lock'
import { runnerHome } from '../src/home'
import { stopMark } from '../../cli/src/lib/agent/stop'
import { plan as runtimePlan } from '../src/runtimes'
import { until } from './fake-cloud'
import { ACP_AGENT, cloud, runner, planned, MACHINE, fakeRuntime, start, disconnect } from './runner-harness'

describe('the Runner', () => {
  for (const checkpoint of [null, { pending: ['write'], effects: true, started: true, session: 's1' }, { pending: [], effects: false, started: true }]) {
    it(`手动续跑验证保留的执行证据 ${JSON.stringify(checkpoint)}`, async () => {
      if (checkpoint) saveCheckpoint('old-turn', checkpoint)
      const job = cloud.dispatch({ id: 'manual-turn', recoveryOf: 'old-turn', manualRecovery: true, chat: { message: 'm1', body: '修改' } })
      start()
      await until(() => job.state === 'finished')
      assert.equal(planned.length, checkpoint ? 1 : 0)
      assert.equal(job.outcome, checkpoint ? 'done' : 'failed', job.reason)
    })
  }

  for (const discussion of [false, true]) {
    it(`长时间正常执行的回复重启后仍可沿用原会话 ${discussion ? 'discussion' : 'task'}`, async () => {
      saveCheckpoint('long-running-original', { mark: stopMark(), pending: [], started: true,
        submitted: true, effects: true, session: 'original-session', retry: { since: Date.now() - 7_200_000, attempt: 1 } })
      const job = cloud.dispatch({ id: 'long-running-recovered', recoveryOf: 'long-running-original',
        ...(discussion ? { discussion: { id: 'd1', workspace: 'ws_1', goals: [] } } : { chat: { message: 'm1', body: '继续' } }) })
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
      assert.match(planned[0]!.prompt, /Do not repeat an operation/)
    })
  }

  for (const [attempt, elapsed] of [[5, 0], [5, 120_001]]) {
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

  it('manual recovery resets an exhausted budget and clears obsolete blockers (#903)', async () => {
    saveCheckpoint('exhausted-turn', { mark: stopMark(), pending: ['write'], started: true, session: 'saved-session',
      effects: true, retry: { since: 0, attempt: 4, at: Date.now() }, failure: disconnect, retryPause: 'limit', launching: true,
      completed: { outcome: 'failed', report: { session: 'saved-session' } } })
    const job = cloud.dispatch({ id: 'manual-after-exhaustion', manualRecovery: true, recoveryOf: 'exhausted-turn',
      chat: { message: 'm1', body: 'Continue' } })
    let launches = 0
    start('', { plan: (...args) => {
      const first = ++launches === 1
      const p = fakeRuntime(first ? 'process.exit(1)' : 'console.log("Recovered")')(...args)
      p.renderer!.events = () => []
      p.renderer!.executionFailure = () => first ? disconnect : undefined
      return p
    } })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(launches, 2)
    assert.equal(planned[0]!.resume, 'saved-session')
    assert.match(planned[0]!.prompt, /Check the current state/)
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
    assert.match(planned[0]!.prompt, /Do not repeat an operation/)
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
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(planned.map(p => p.resume), ['absent', null])
    assert.equal(job.report?.reply, '已续接')
    assert.equal(job.report?.retries?.length, 1)
    assert.equal(job.report?.retries?.[0]?.sessionAction, 'reset_replay')
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
    assert.equal(planned.length, 5)
    assert.match(job.reason!, /session/i)
  })

  it('换机会话登录失败时立即报告原因', async () => {
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
    if (recovery) {
      assert.equal(job.outcome, 'failed', job.reason)
      assert.equal(planned.length, 1)
      assert.equal(job.report?.failure?.pauseReason, 'unsafe')
      assert.equal(job.report?.failure?.safeToRetry, false)
      assert.match(job.report?.failure?.summary ?? '', /^Session not found/)
    } else {
      assert.equal(job.outcome, 'done', job.reason)
      assert.deepEqual(planned.map(p => p.resume), ['absent', null])
      assert.equal(job.report?.retries?.length, 1)
      assert.equal(job.report?.retries?.[0]?.sessionAction, 'reset_replay')
    }
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
    assert.match(planned.at(-1)!.prompt, /Do not repeat an operation/)
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
      await (await acquireMachine('terminal'))()
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

  it('重启后自动回到原会话核对未决写操作且只写入一次', async () => {
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
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(fs.readFileSync(effect, 'utf8'), 'x')
    assert.equal(planned.length, 2)
    assert.equal(planned[1]?.resume, 'fresh-session')
    assert.match(planned[1]!.prompt, /Check the current state/)
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

  it('更新中断且缺少原会话时暂停，不自动重复未决操作', async () => {
    const job = cloud.dispatch({ id: 'update-unknown', state: 'claimed', machine: MACHINE })
    saveCheckpoint(job.id, { updating: true, started: true, pending: ['external-call'] })
    start()
    await until(() => job.state === 'finished')
    assert.match(job.reason!, /previous execution could not be verified/)
    assert.equal(planned.length, 0)
  })

  it('fails a job it held before it restarted rather than leaving it hanging', async () => {
    const job = cloud.dispatch({ id: 'j1', state: 'claimed', machine: MACHINE })
    cloud.runner = { machineId: MACHINE, machineName: 'studio', live: true }
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'failed')
    assert.match(job.reason!, /previous execution could not be verified/)
  })

  it('refuses a duplicate without registering or disconnecting the active Runner', async () => {
    const runner = start()
    await until(() => cloud.runner?.live === true)
    const duplicate = startRunner({
      kind: 'claude-code',
      registration: async () => { assert.fail('duplicate registered') },
    })
    assert.deepEqual(await duplicate.stopped, { reason: 'already-running' })
    assert.equal(cloud.runner?.live, true)
    await runner.close()
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
    try {
      const closing = current.close()
      await assert.rejects(acquireMachine('codex'), RunnerAlreadyRunning)
      allow()
      await closing
      await (await acquireMachine('codex'))()
      assert.equal(job.state, 'claimed')
      assert.equal(planned.length, 0)
      assert.equal(cloud.runner!.live, false)
    } finally { allow() }
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

  it('registers with the task session protocol (#1280)', async () => {
    start()
    await until(() => cloud.registrations > 0)
    assert.equal(cloud.protocol, 34)
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
