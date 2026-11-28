import { savePin, STUDIO_SNAPSHOT_ENV } from '../src/lib/agent/cloud-studios.ts'
import { boardCommand } from '../src/lib/agent/command.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { openResume, openRun, patch, readSpec, listRuns } from '../src/lib/agent/sessions.ts'
import { endDelivery, findDelivery, syncAudit } from '../src/lib/agent/deliveries.ts'
import { lockDeliveryProject } from '../src/lib/agent/delivery-workspace.ts'
import { startRun } from '../src/lib/agent/start.ts'
import { approvalRequest } from '../src/lib/agent/approve.ts'
import { cmdResumeDelivery, cmdStartRun } from '../src/commands/run.ts'
import { BoardError, startCollecting, stopCollecting } from '../src/lib/io.ts'
import { eventsPathOf, readStore, withStore } from '../src/lib/agent/store.ts'
import { watchRun } from '../src/lib/agent/watch.ts'
import { DELIVERY_PHASE_ENV, LAND_IMPLEMENT_RUN_ENV } from '../src/lib/agent/env.ts'
import type { RunRecord, RunStatus } from '../src/lib/agent/types.ts'
import { cardFile } from '../src/lib/cards.ts'
import { DELIVERIES, SESSIONS, setBoardRoot } from '../src/lib/paths.ts'
import { forgetMachineState, move, uiConfigOf } from './helpers/board.ts'

let root = ''

function runtime(harness: string): void {
  fs.writeFileSync(uiConfigOf(root, 'docs', 'kanban'), JSON.stringify({
    runtimes: [{ id: 'global', name: 'Global', harness, settings: { command: 'node unused-agent.mjs' } }],
  }))
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-build-session-'))
  const todo = path.join(root, 'docs', 'kanban', 'todo')
  fs.mkdirSync(todo, { recursive: true })
  fs.writeFileSync(path.join(todo, 'README.md'), '# Tasks\n')
  setBoardRoot(root)
  runtime('claude-code')
  await move(root, ['create', '--title', '继续构建'])
})

afterEach(() => {
  forgetMachineState(root)
  fs.rmSync(root, { recursive: true, force: true })
})

function build(status: RunStatus = 'stopped', resumeId?: string): RunRecord {
  const opened = openRun({ action: 'implement', id: 1 }, '原构建', [])
  if ('error' in opened) throw new Error(opened.error)
  fs.writeFileSync(opened.run.logPath, '旧构建日志\n')
  patch(opened.run.sessionId, (r) => {
    r.status = status
    r.endedAt = Date.now()
    if (resumeId) r.resumeId = resumeId
  })
  return { ...opened.run, status, ...(resumeId ? { resumeId } : {}) }
}

it('implements Git tasks in parallel and waits for the project lock before Land', async (t) => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-qb', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('commit', '--allow-empty', '-qm', 'Initial')
  const base = git('rev-parse', 'HEAD')
  await move(root, ['create', '--title', 'Another task'])
  const landed = path.join(root, 'land-prompt.txt')
  const agent = path.join(root, 'fake-implement.mjs')
  fs.writeFileSync(agent, `
    import { execFileSync } from 'node:child_process'
    import fs from 'node:fs'
    import { createInterface } from 'node:readline'
    const git = (args, cwd = process.cwd()) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    for await (const line of createInterface({ input: process.stdin })) {
      const branch = git(['branch', '--show-current'])
      if (process.env.AI4KANBAN_DELIVERY_PHASE === 'implement') {
        const file = branch.split('/').at(-1) + '.txt'
        fs.writeFileSync(file, branch)
        git(['add', file])
        git(['commit', '-qm', 'Implement'])
      } else {
        fs.writeFileSync(${JSON.stringify(landed)}, JSON.parse(line).message.content)
        git(['merge', '--ff-only', branch], ${JSON.stringify(root)})
      }
      break
    }
    console.log(JSON.stringify({ type: 'result', result: 'Saved' }))
  `)
  fs.writeFileSync(uiConfigOf(root, 'docs', 'kanban'), JSON.stringify({
    runtimes: [{ id: 'global', name: 'Global', harness: 'claude-code', settings: { command: `${process.execPath} ${agent}` } }],
  }))
  t.after(() => {
    delete process.env[DELIVERY_PHASE_ENV]
    delete process.env[LAND_IMPLEMENT_RUN_ENV]
  })
  process.env[DELIVERY_PHASE_ENV] = 'implement'
  const start = (id: number) => {
    const opened = openRun({ action: 'implement', id }, 'Work on the task.', [])
    if ('error' in opened) assert.fail(opened.error)
    return opened.run
  }
  const first = start(1)
  const second = start(2)
  const firstBranch = `akb/${first.deliveryId}`
  const secondBranch = `akb/${second.deliveryId}`
  assert.notEqual(first.cwd, second.cwd)
  assert.equal(findDelivery(first.deliveryId!)?.base, base)
  assert.equal(findDelivery(second.deliveryId!)?.base, base)
  const release = await lockDeliveryProject(root, () => false)
  assert.ok(release)
  try {
    assert.deepEqual(await Promise.race([
      Promise.all([watchRun(first.sessionId), watchRun(second.sessionId)]),
      delay(8_000, 'blocked by the project lock', { ref: false }),
    ]), [0, 0])
    assert.equal(git('rev-parse', 'main'), base)
    assert.equal(git('show', `--format=%s`, '--name-only', firstBranch), `Implement\n\n${first.deliveryId}.txt`)
    assert.equal(git('show', `--format=%s`, '--name-only', secondBranch), `Implement\n\n${second.deliveryId}.txt`)

    process.env[DELIVERY_PHASE_ENV] = 'land'
    process.env[LAND_IMPLEMENT_RUN_ENV] = first.sessionId
    const land = start(1)
    assert.equal(land.cwd, first.cwd)
    const pending = watchRun(land.sessionId)
    await delay(150)
    assert.equal(fs.existsSync(landed), false)
    release()
    assert.equal(await pending, 0, fs.readFileSync(land.logPath, 'utf8'))
    assert.equal(git('rev-parse', 'main'), git('rev-parse', firstBranch))
    const prompt = fs.readFileSync(landed, 'utf8')
    assert.ok(prompt.includes(`Task branch: ${firstBranch} (base ${base}).`))
    assert.ok(prompt.includes(`run log ${first.sessionId}`))
  } finally {
    release()
  }
})

describe('交付的构建会话续接（#368）', () => {
  it('carries the bound Land session into the existing delivery workspace (#1280)', async () => {
    const machine = '12800000-0000-4000-8000-000000000002'
    try {
      process.env[DELIVERY_PHASE_ENV] = 'implement'
      const old = build('done', 'build-thread')
      process.env.AI4KANBAN_EXECUTION = JSON.stringify({
        job: '12800000-0000-4000-8000-000000000004', machine, card: 1, sessionKind: 'land',
      })
      process.env[DELIVERY_PHASE_ENV] = 'land'
      await assert.rejects(cmdStartRun('implement', [1, []], { session: 'land-thread' }), { kind: 'spawn-failed' })
      const land = readStore().runs.at(-1)!
      assert.equal(land.sessionKind, 'land')
      assert.equal(land.deliveryId, old.deliveryId)
      assert.equal(land.cwd, old.cwd)
      assert.equal(land.continues?.resumeId, 'land-thread')
      assert.ok(land.argv?.includes('land-thread'))
    } finally {
      delete process.env.AI4KANBAN_EXECUTION
      delete process.env[DELIVERY_PHASE_ENV]
    }
  })

  it('normalizes older local build records and refuses to resume them as Land once bound (#1280)', async () => {
    const old = build('stopped', 'build-thread')
    const read = JSON.parse(fs.readFileSync(SESSIONS, 'utf8'))
    delete read.runs[0].sessionKind
    fs.writeFileSync(SESSIONS, JSON.stringify(read))
    assert.equal(readStore().runs[0].sessionKind, 'implement')
    const machine = '12800000-0000-4000-8000-000000000002'
    withStore(store => {
      store.runs[0].cloudExecution = { job: '12800000-0000-4000-8000-000000000003', machine, card: 1, sessionKind: 'implement' }
    })
    const saved = process.env.AI4KANBAN_EXECUTION
    process.env.AI4KANBAN_EXECUTION = JSON.stringify({
      job: '12800000-0000-4000-8000-000000000004', machine, card: 1, sessionKind: 'land',
    })
    try {
      const result = await openResume(old.sessionId, { fresh: true })
      assert.ok('error' in result)
      assert.match(result.error, /different task step/)
    } finally {
      if (saved === undefined) delete process.env.AI4KANBAN_EXECUTION
      else process.env.AI4KANBAN_EXECUTION = saved
    }
  })

  it('starts and resumes an ordinary task with no Preview role progress', async () => {
    await move(root, ['update', '1', '--previews', 'ui-design', '--status', 'ready'])
    assert.equal((approvalRequest({ action: 'approve', id: 1 }) as {action: string}).action, 'implement')
    const old = build()
    const next = await startRun({ action: 'implement', id: 1 })
    assert.ok(!('error' in next))
    assert.equal(next.run.resumedFrom, old.sessionId)
    assert.equal(next.run.deliveryId, old.deliveryId)
  })

  for (const harness of ['claude-code', 'codex', 'kimi', 'opencode', 'cursor', 'dsh', 'grok', 'zcode']) {
    it(`${harness} 使用原构建的真实会话，而非讨论会话或新运行 ID`, async () => {
      runtime(harness)
      const old = build('stopped', harness === 'claude-code' ? undefined : `${harness}-conversation`)
      const started = await startRun({ action: 'implement', id: 1, carry: { resumeId: 'discussion', fork: true, transcript: '/tmp/discussion.md', costFrom: 100 } })
      if ('error' in started) throw new Error(started.error)
      assert.equal(started.run.resumeId, old.resumeId ?? old.sessionId)
      assert.equal(started.run.resumedFrom, old.sessionId)
      assert.equal(started.run.deliveryId, old.deliveryId)
      assert.equal(started.run.cwd, old.cwd)
      assert.equal(started.run.harness, harness)
      assert.notEqual(started.run.sessionId, old.sessionId)
      if (harness === 'claude-code') assert.ok(started.run.argv?.includes('--resume'))
      if (harness === 'codex') assert.deepEqual(started.run.argv?.slice(-2), ['resume', old.resumeId])
      assert.equal(readStore().deliveries.length, 1)
    })
  }

  it('恢复已停止的交付后，继续原构建而不创建第二个交付', async () => {
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'test'], ['add', '.'], ['commit', '-qm', 'initial']]) {
      execFileSync('git', args, { cwd: root })
    }
    const old = build()
    endDelivery(old.deliveryId!, 'failed')
    // The CLI test bundle cannot spawn a watcher, so inspect the run it prepared.
    await assert.rejects(cmdResumeDelivery(old.deliveryId!), { kind: 'spawn-failed' })
    const { runs: [run], deliveries: [delivery] } = readStore()
    assert.equal(run?.resumeId, old.sessionId)
    assert.equal(run?.resumedFrom, old.sessionId)
    assert.equal(run?.deliveryId, old.deliveryId)
    assert.equal(run?.runtime, old.runtime)
    assert.equal(run?.cwd, old.cwd)
    assert.equal(delivery?.status, 'active')
    assert.equal(delivery?.endedAt, undefined)
    assert.deepEqual(delivery?.sessions, [old.sessionId, run?.sessionId])
    assert.deepEqual(delivery?.steps.map(s => s.step), ['implement', 'resume'])
    assert.match(fs.readFileSync(cardFile(1)!, 'utf8'), /^status: implementing$/m)
    const audit = JSON.parse(fs.readFileSync(path.join(DELIVERIES, `${old.deliveryId}.json`), 'utf8'))
    assert.deepEqual(audit.sessions.map((s: RunRecord) => s.sessionId), [old.sessionId, run?.sessionId])
  })

  for (const [name, evidence, diagnostic] of [
    ['pending operation results', { pendingWrites: true }, /The operation results could not be confirmed complete/],
    ['unconfirmed cleanup', { cleanup: { status: 'unconfirmed', execution: 'original', kept: ['background'] } }, /The operation results could not be confirmed complete/],
    ['a live original process', { managedProcess: true, agentPid: process.pid }, /The previous execution could not be confirmed stopped/],
    ['a session mismatch', { failure: { source: 'runtime', code: 'session_mismatch', summary: 'Session mismatch' } }, /The original session is unavailable/],
  ] satisfies [string, Partial<RunRecord>, RegExp][]) {
    for (const command of ['task implement', 'delivery resume'] as const) {
      it(`${command} preserves the delivery and all saved work with ${name}`, async () => {
        const old = build('error')
        patch(old.sessionId, run => Object.assign(run, evidence))
        if (command === 'delivery resume') endDelivery(old.deliveryId!, 'failed')
        syncAudit(old.deliveryId!)
        const output = path.join(old.cwd!, 'saved.txt')
        fs.writeFileSync(output, 'saved work')
        const files = [cardFile(1)!, old.logPath, path.join(DELIVERIES, `${old.deliveryId}.json`), output]
        const saved = () => ({ store: readStore(), files: files.map(file => fs.readFileSync(file, 'utf8')), spec: readSpec(old.sessionId) })
        const before = saved()
        const resumed = command === 'delivery resume' ? cmdResumeDelivery(old.deliveryId!) : cmdStartRun('implement', [1, ['Keep the work']], {})
        await assert.rejects(resumed, (error: unknown) => {
          assert.ok(error instanceof BoardError)
          assert.equal(error.kind, 'run-refused')
          assert.equal(error.details.reason, 'runNoSession')
          assert.match(error.message, diagnostic)
          return true
        })
        assert.deepEqual(saved(), before)
      })
    }
  }

  for (const state of ['active', 'released', 'missing_workspace'] as const) {
    it(`takes over a delivery with a confirmed missing session (${state})`, async () => {
      process.env[DELIVERY_PHASE_ENV] = 'implement'
      try {
        const old = build('error', 'gone')
        const work = path.join(old.cwd!, 'saved.txt')
        fs.writeFileSync(work, 'saved work')
        patch(old.sessionId, run => { run.failure = { source: 'runtime', code: 'session_not_found', summary: 'Session not found' } })
        if (state === 'released') endDelivery(old.deliveryId!, 'failed')
        if (state === 'missing_workspace') {
          fs.renameSync(old.cwd!, path.join(root, 'saved-work'))
          const before = readStore()
          await assert.rejects(cmdResumeDelivery(old.deliveryId!), /saved delivery workspace is unavailable/)
          assert.deepEqual(readStore(), before)
          assert.equal(fs.readFileSync(path.join(root, 'saved-work', 'saved.txt'), 'utf8'), 'saved work')
          return
        }
        const next = await openResume(old.sessionId, state === 'released'
          ? { fresh: true, exact: true }
          : { deliveryId: old.deliveryId!, exact: true })
        if ('error' in next) throw Error(next.error)
        assert.equal(next.run.deliveryId, old.deliveryId)
        assert.equal(next.run.cwd, old.cwd)
        assert.equal(next.run.flowId, old.flowId)
        assert.equal(next.run.resumeId, undefined)
        assert.ok(!next.run.argv?.includes('--resume'))
        assert.equal(readStore().deliveries[0]?.status, 'active')
        assert.match(next.spec.prompt, new RegExp(old.deliveryId!))
        assert.equal(fs.readFileSync(work, 'utf8'), 'saved work')
      } finally {
        delete process.env[DELIVERY_PHASE_ENV]
      }
    })
  }

  it('resumes a stopped Codex run with legacy stopped cleanup when terminal, and blocks running work or foreign sessions', async () => {
    runtime('codex')
    const old = build('stopped', 'codex-thread-1261')
    const detail = 'Execution stopped; no further cleanup turn was submitted.'
    patch(old.sessionId, run => {
      run.cleanup = { status: 'unconfirmed', execution: 'orig', kept: [], detail, items: [{ id: 'terminal:main:c1', threadId: 'main', status: 'running' }] }
    })
    await assert.rejects(cmdStartRun('implement', [1, ['Keep the work']], {}), /The operation results could not be confirmed complete/)
    patch(old.sessionId, run => {
      run.cleanup = { status: 'unconfirmed', execution: 'orig', kept: [], detail, items: [{ id: 'terminal:main:c1', threadId: 'main', status: 'completed' }] }
    })
    withStore(store => store.runs.push({ ...old, sessionId: 'foreign-run', cardId: 99, deliveryId: undefined, resumeId: 'codex-thread-1261' }))
    await assert.rejects(cmdStartRun('implement', [1, ['Keep the work']], {}), /The session belongs to another task/)
    withStore(store => { const i = store.runs.findIndex(r => r.sessionId === 'foreign-run'); if (i >= 0) store.runs.splice(i, 1) })
    await assert.rejects(cmdStartRun('implement', [1, ['Keep the work']], {}), { kind: 'spawn-failed' })
    const { runs } = readStore()
    assert.equal(runs.at(-1)?.resumedFrom, old.sessionId)
    assert.equal(runs.at(-1)?.resumeId, 'codex-thread-1261')
    assert.equal(runs.at(-1)?.cwd, old.cwd)
  })

  it('rechecks recovery evidence under the delivery write lock', async () => {
    const old = build()
    const started = cmdStartRun('implement', [1], {})
    patch(old.sessionId, run => { run.pendingWrites = true })
    const before = readStore()
    await assert.rejects(started, /The operation results could not be confirmed complete/)
    assert.deepEqual(readStore(), before)
  })

  it('preserves a build still recorded as running until its stop is recorded', async () => {
    const old = build('running')
    patch(old.sessionId, run => { run.startedAt = 1; run.endedAt = undefined })
    const before = readStore()
    await assert.rejects(cmdResumeDelivery(old.deliveryId!), /that run is still going/)
    await assert.rejects(cmdStartRun('implement', [1], {}), /that run is still going/)
    assert.deepEqual(readStore(), before)
    assert.equal(fs.readFileSync(old.logPath, 'utf8'), '旧构建日志\n')
    assert.ok(readSpec(old.sessionId))
  })

  it('continues the remaining delivery steps when the last build has a completion receipt', async () => {
    const old = build('done')
    withStore(store => {
      store.deliveries[0]!.completions = [{ sessionId: 'completion', resumedSessions: [old.sessionId], step: 1, at: Date.now(), finished: false }]
    })
    await assert.rejects(cmdResumeDelivery(old.deliveryId!), { kind: 'spawn-failed' })
    const { runs, deliveries } = readStore()
    assert.equal(deliveries.length, 1)
    assert.equal(runs.length, 2)
    const next = runs.find(run => run.sessionId !== old.sessionId)
    assert.ok(next)
    assert.equal(next.deliveryId, old.deliveryId)
    assert.equal(next.resumedFrom, undefined)
  })

  it('已完成但尚未落地的构建继续原会话', async () => {
    const old = build('done')
    const started = await openResume(old.sessionId)
    if ('error' in started) throw new Error(started.error)
    assert.equal(started.run.resumeId, old.sessionId)
    assert.equal(started.run.resumedFrom, old.sessionId)
  })

  it('继续构建时只给停下原因，并保留用户补充', async () => {
    const old = build('done')
    const opened = await openResume(old.sessionId, { deliveryId: old.deliveryId!, notes: '保留已完成的修改' })
    if ('error' in opened) throw new Error(opened.error)
    const prompt = readSpec(opened.run.sessionId)!.prompt
    assert.match(prompt, /Check the current state.*Do not repeat an operation/)
    assert.ok(prompt.endsWith(`Continue delivery ${old.deliveryId}. The delivery has not recorded completion. Finish the delivery and run ${boardCommand()} task archive ${old.cardId}.\n\n保留已完成的修改`))
  })

  it('缺失真实会话 ID 时在原交付目录接续', async () => {
    runtime('codex')
    const old = build()
    const result = await openResume(old.sessionId, { deliveryId: old.deliveryId!, fresh: true })
    assert.ok(!('error' in result))
    assert.equal(result.run.deliveryId, old.deliveryId)
    assert.equal(result.run.cwd, old.cwd)
    assert.equal(result.run.resumeId, undefined)
    const prompt = result.spec.prompt
    assert.match(prompt, /task implement 1 --print/)
    assert.doesNotMatch(prompt, /discussion/)
  })

  it('reintroduces the bound Studio on an explicit fresh delivery session', async (t) => {
    const captured = path.join(root, 'prompt.txt')
    fs.writeFileSync(path.join(root, 'unused-agent.mjs'), `
      import fs from 'node:fs';
      import { createInterface } from 'node:readline';
      for await (const line of createInterface({ input: process.stdin })) {
        fs.writeFileSync(${JSON.stringify(captured)}, JSON.parse(line).message.content);
        break;
      }
      console.log(JSON.stringify({ type: 'result', result: 'Saved' }));
    `)
    const studio = (version: number) => ({
      id: 'wf_builtin_coding', name: 'Coding', version,
      files: {
        'STUDIO.md': '---\nname: Coding\n---\nBound Studio text.',
        'skills/check/SKILL.md': `---\nname: check\ndescription: Check v${version}.\n---\nReusable checks.`,
      },
    })
    for (const [key, value] of Object.entries({ AI4KANBAN_TASK: 'task_build_1121',
      [STUDIO_SNAPSHOT_ENV]: JSON.stringify({ studio: 'wf_builtin_coding', version: 11210 }),
    })) {
      const old = process.env[key]
      process.env[key] = value
      t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old })
    }
    savePin('task_build_1121', studio(11210))
    const old = build()
    savePin('task_build_1121', studio(11211))
    process.env[STUDIO_SNAPSHOT_ENV] = JSON.stringify({ studio: 'wf_builtin_coding', version: 11211 })
    const fresh = await openResume(old.sessionId, { deliveryId: old.deliveryId!, fresh: true })
    if ('error' in fresh) assert.fail(fresh.error)
    assert.equal(await watchRun(fresh.run.sessionId), 0)
    const input = fs.readFileSync(captured, 'utf8')
    assert.match(input, /Task card: .+\n\nStudio: Coding\./)
    const skill = /Check v11210\. \(file: (.+)\)$/.exec(input.split('\n').find(line => line.includes('Check v11210.')) ?? '')?.[1]
    assert.ok(skill && path.isAbsolute(skill))
    assert.match(fs.readFileSync(skill, 'utf8'), /Reusable checks/)
    assert.doesNotMatch(input, /Check v11211|Bound Studio text/)
  })

  it('原会话不存在时保留交付并提供原任务', async () => {
    const agent = path.join(root, 'missing.mjs')
    fs.writeFileSync(agent, `console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,errors:['No conversation found with session ID: old']}));process.exit(1)`)
    fs.writeFileSync(uiConfigOf(root, 'docs', 'kanban'), JSON.stringify({
      runtimes: [{ id: 'global', name: 'Global', harness: 'claude-code', settings: { command: `node ${agent}` } }],
    }))
    const old = build()
    const opened = await openResume(old.sessionId, { deliveryId: old.deliveryId! })
    if ('error' in opened) throw new Error(opened.error)
    patch(opened.run.sessionId, (r) => { r.pid = process.pid })
    await watchRun(opened.run.sessionId, async () => ({ error: '不应启动新会话' }))
    const rows = readStore().runs
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.sessionId, opened.run.sessionId)
    assert.equal(rows[0]!.deliveryId, old.deliveryId)
    assert.ok(rows[0]!.argv?.includes('--resume'))
    const rebuilt = await openResume(rows[0]!.sessionId, { deliveryId: old.deliveryId!, fresh: true })
    assert.ok(!('error' in rebuilt))
    assert.match(rebuilt.spec.prompt, /task implement 1 --print/)
    assert.doesNotMatch(rebuilt.spec.prompt, /discussion/)
  })

  it('修改默认 Agent 后仍使用原构建的 Agent 和运行环境', async () => {
    const old = build()
    const config = uiConfigOf(root, 'docs', 'kanban')
    const cfg = JSON.parse(fs.readFileSync(config, 'utf8'))
    cfg.runtimes.push({ id: 'other', name: 'Other', harness: 'codex', settings: { command: 'node other.mjs' } })
    cfg.agentRuntime = { builder: 'other' }
    fs.writeFileSync(config, JSON.stringify(cfg))
    const started = await startRun({ action: 'implement', id: 1 })
    if ('error' in started) throw new Error(started.error)
    assert.equal(started.run.harness, 'claude-code')
    assert.equal(started.run.runtime, old.runtime)
    assert.equal(started.run.resumeId, old.sessionId)
  })

  for (const scenario of ['repair', 'mixed', 'exhausted', 'unconfirmed', 'unknown']) {
    it(`applies the shared retry policy to a task: ${scenario}`, async () => {
      const agent = path.join(root, 'retry-agent.mjs')
      const attempts = path.join(root, 'attempts.jsonl')
      fs.writeFileSync(agent, `
        import fs from 'node:fs';
        const file = ${JSON.stringify(attempts)};
        const count = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\\n').length : 0;
        fs.appendFileSync(file, JSON.stringify(process.argv.slice(2)) + '\\n');
        const mode = ${JSON.stringify(scenario)};
        const send = frame => console.log(JSON.stringify(frame));
        if (mode === 'unconfirmed') send({ type:'assistant',message:{content:[{ type:'tool_use',name:'Write',id:'write' }]} });
        const error = mode === 'unknown' || mode === 'repair' || mode === 'mixed' && count > 0 ? undefined
          : { type:'overloaded_error', headers:{ 'Retry-After':'0' } };
        send({ type:'result', is_error:true, error,
          subtype: mode === 'repair' || mode === 'mixed' && count > 0 ? 'error_max_structured_output_retries' : 'error_during_execution',
          errors:['503 retry-after: 1'] });
      `)
      fs.writeFileSync(uiConfigOf(root, 'docs', 'kanban'), JSON.stringify({
        runtimes: [{ id: 'global', name: 'Global', harness: 'claude-code', settings: { command: `node ${agent}` } }],
      }))
      const opened = openRun({ action: 'implement', id: 1 }, 'Complete the task.', [])
      if ('error' in opened) throw Error(opened.error)
      const total = scenario === 'unconfirmed' ? 1 : 5
      const resume: NonNullable<Parameters<typeof watchRun>[1]> = async (id, options) => {
        const previous = readStore().runs.find(r => r.sessionId === id)!
        assert.ok(previous.retry?.pending)
        const next = await openResume(id, options)
        if ('error' in next) return next
        assert.equal(next.run.retry?.attempt, previous.retry.attempt)
        assert.equal(next.run.retry?.launching, true)
        patch(next.run.sessionId, r => { r.pid = process.pid })
        await watchRun(next.run.sessionId, resume, () => 0)
        return { run: next.run, spawned: true }
      }
      patch(opened.run.sessionId, r => { r.pid = process.pid })
      await watchRun(opened.run.sessionId, resume, () => 0)
      const saved = readStore().runs.find(r => r.deliveryId === opened.run.deliveryId)!
      assert.equal((fs.readFileSync(attempts, 'utf8').trim().split('\n')).length, total)
      assert.equal(saved.retry?.attempt ?? 1, total)
      assert.equal(saved.retryPause, scenario === 'unconfirmed' ? 'unsafe' : 'limit')
      assert.match(saved.error!, /503 retry-after: 1/)
    })
  }

  for (const requireSession of [true, false]) it(`honors the ACP session requirement when the saved session is missing (${requireSession})`, async () => {
    const agent = path.join(root, 'acp.mjs')
    const trace = path.join(root, 'methods.jsonl')
    fs.writeFileSync(agent, `import fs from 'node:fs';import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(m)+'\\n');
 if(m.id===undefined)return;
 const result=m.method==='initialize'?{protocolVersion:1,agentCapabilities:{loadSession:true}}:m.method==='session/new'?{sessionId:'new-session'}:{stopReason:'end_turn'};
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,...(m.method==='session/load'?{error:{code:-32602,message:'session not found: original'}}:{result})}));
});`)
    fs.writeFileSync(uiConfigOf(root, 'docs', 'kanban'), JSON.stringify({
      runtimes: [{ id: 'global', name: 'Global', harness: 'opencode', settings: { command: `node ${agent}` } }],
    }))
    const old = build('stopped', 'original')
    const opened = await openResume(old.sessionId, { deliveryId: old.deliveryId!, requireSession, notes: 'Keep the draft' })
    if ('error' in opened) throw new Error(opened.error)
    patch(opened.run.sessionId, (r) => { r.pid = process.pid })
    let resumed: Awaited<ReturnType<typeof openResume>> | undefined
    await watchRun(opened.run.sessionId, async (id, opts) => {
      assert.equal(requireSession, false)
      const next = resumed = await openResume(id, opts)
      if ('error' in next) return next
      return { run: next.run, spawned: true }
    })
    const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map((s) => JSON.parse(s))
    assert.deepEqual(calls.map((m) => m.method), ['initialize', 'session/load'])
    assert.equal(calls[1].params.sessionId, 'original')
    const rows = readStore().runs
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.status, requireSession ? 'error' : 'running')
    assert.equal(rows[0]!.resumeId, requireSession ? 'original' : undefined)
    if (!requireSession) {
      assert.ok(resumed && 'spec' in resumed)
      assert.match(resumed.spec.prompt, /Keep the draft/)
      assert.equal(resumed.run.deliveryId, old.deliveryId)
    }
  })

  it('同卡片的旧交付不会被新交付当作续跑来源', async () => {
    const old = build()
    withStore((s) => { s.deliveries[0]!.status = 'cancelled' })
    const started = await startRun({ action: 'implement', id: 1 })
    if ('error' in started) throw new Error(started.error)
    assert.equal(started.run.resumedFrom, undefined)
    assert.notEqual(started.run.deliveryId, old.deliveryId)
  })

  it('re-verifies real Codex stop state, command results, and ownership instead of deadlocking on static markers (#1258, #1263, #1270)', async (t) => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-codex-home-'))
    const prevCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    t.after(() => {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prevCodexHome
      fs.rmSync(codexHome, { recursive: true, force: true })
    })
    const writeRollout = (threadId: string, lines: Record<string, unknown>[]) => {
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const dir = path.join(codexHome, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `rollout-2026-11-27T12-00-00-${threadId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    }

    runtime('codex')
    const threadId = '019d7482-0000-7000-8000-000000001258'
    const old = build('stopped', threadId)
    const savedWork = path.join(old.cwd!, 'feature-1258.ts')
    fs.writeFileSync(savedWork, 'export const preserved = true\n')
    fs.mkdirSync(path.dirname(eventsPathOf(old.sessionId)), { recursive: true })
    fs.writeFileSync(
      eventsPathOf(old.sessionId),
      `${JSON.stringify({ kind: 'tool_call', data: { toolCallId: 'exec-1', title: 'Command', kind: 'execute', status: 'in_progress' } })}\n`,
    )
    patch(old.sessionId, (r) => {
      r.managedProcess = true
      r.pendingWrites = true
      r.retryPause = 'unsafe'
      r.retryHistory = [{ attempt: 1, source: 'runtime', summary: 'Stopped mid-turn', sessionAction: 'pause_unsafe', at: new Date().toISOString() }]
      r.cleanup = {
        status: 'unconfirmed',
        execution: 'exec_1258',
        detail: 'Execution stopped; no further cleanup turn was submitted.',
        kept: [],
        items: [{ id: `terminal:${threadId}:exec-1`, threadId, processId: '70879', status: 'running' }],
      }
    })

    // Before exec-1 has a final result in rollout, keep paused and preserve saved work.
    writeRollout(threadId, [
      { type: 'session_meta', payload: { id: threadId, cwd: old.cwd } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"rg pattern"}' } },
      { type: 'event_msg', payload: { type: 'item_started', item: { type: 'CommandExecution', id: 'exec-1', status: 'inProgress' } } },
    ])
    assert.equal((await listRuns()).find((r) => r.sessionId === old.sessionId)?.canResume, false)
    const refusedUnsettled = await openResume(old.sessionId, { deliveryId: old.deliveryId! })
    assert.ok('error' in refusedUnsettled)
    assert.match(refusedUnsettled.error, /The operation results could not be confirmed complete/)
    assert.equal(fs.readFileSync(savedWork, 'utf8'), 'export const preserved = true\n')

    // Unified-exec background session still running without exit also stays paused.
    writeRollout(threadId, [
      { type: 'session_meta', payload: { id: threadId, cwd: old.cwd } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"sleep 30"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'Process running with session ID 70879' } },
      { type: 'event_msg', payload: { type: 'item_started', item: { type: 'CommandExecution', id: 'exec-1', process_id: '70879', status: 'inProgress' } } },
      { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } },
    ])
    const refusedBg = await openResume(old.sessionId, { deliveryId: old.deliveryId! })
    assert.ok('error' in refusedBg)
    assert.match(refusedBg.error, /The operation results could not be confirmed complete/)

    // Once rollout records final command completion + output, Stop -> Resume succeeds in original session & worktree (#1258).
    writeRollout(threadId, [
      { type: 'session_meta', payload: { id: threadId, cwd: old.cwd } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"rg pattern"}' } },
      { type: 'event_msg', payload: { type: 'item_started', item: { type: 'CommandExecution', id: 'exec-1', process_id: '70879', status: 'inProgress' } } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-1', process_id: '70879', status: 'completed', exit_code: 0 } } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'Process exited with code 0' } },
      { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } },
    ])

    // Live native lease still blocks until the native proxy exits.
    const nativeLeaseDir = path.join(process.env.AI4KANBAN_HOME!, 'codex-native', 'threads', 'inst-1')
    fs.mkdirSync(nativeLeaseDir, { recursive: true })
    const crypto = await import('node:crypto')
    const leasePath = path.join(nativeLeaseDir, `${crypto.createHash('sha256').update(threadId).digest('hex')}.json`)
    fs.writeFileSync(leasePath, JSON.stringify({ pid: process.pid, lease: 'l1', instance: 'inst-1', threads: [threadId] }))
    const refusedLive = await openResume(old.sessionId, { deliveryId: old.deliveryId! })
    assert.ok('error' in refusedLive)
    assert.match(refusedLive.error, /The previous execution could not be confirmed stopped/)
    fs.rmSync(leasePath, { force: true })

    // Foreign worktree cwd blocks ownership check.
    writeRollout(threadId, [
      { type: 'session_meta', payload: { id: threadId, cwd: path.join(root, '.akb', 'worktrees', 'other-delivery', 'work') } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-1', process_id: '70879', status: 'completed', exit_code: 0 } } },
    ])
    const refusedForeign = await openResume(old.sessionId, { deliveryId: old.deliveryId! })
    assert.ok('error' in refusedForeign)
    assert.match(refusedForeign.error, /The session belongs to another task/)

    // Restore matching cwd: listRuns, manual resume, and planning carry all verify cleanly and preserve work.
    writeRollout(threadId, [
      { type: 'session_meta', payload: { id: threadId, cwd: old.cwd } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"rg pattern"}' } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-1', process_id: '70879', status: 'completed', exit_code: 0 } } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'Process exited with code 0' } },
      { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } },
    ])
    assert.equal((await listRuns()).find((r) => r.sessionId === old.sessionId)?.canResume, true)
    const resumed = await openResume(old.sessionId, { deliveryId: old.deliveryId! })
    if ('error' in resumed) assert.fail(resumed.error)
    assert.equal(resumed.run.resumeId, threadId)
    assert.equal(resumed.run.cwd, old.cwd)
    assert.equal(resumed.run.deliveryId, old.deliveryId)
    assert.equal(fs.readFileSync(savedWork, 'utf8'), 'export const preserved = true\n')

    // #1263 planning session stopped mid-rg with static pendingWrites/unconfirmed cleanup carries original session once rollout settles.
    await move(root, ['create', '--title', '规划恢复'])
    const planThread = '019d7482-0000-7000-8000-000000001263'
    const clarify = openRun({ action: 'clarify', id: 2 }, 'clarify', [])
    if ('error' in clarify) assert.fail(clarify.error)
    fs.writeFileSync(clarify.run.logPath, 'clarify log\n')
    patch(clarify.run.sessionId, (r) => {
      r.status = 'stopped'
      r.endedAt = Date.now()
      r.resumeId = planThread
      r.managedProcess = true
      r.pendingWrites = true
      r.cleanup = {
        status: 'unconfirmed',
        execution: 'exec_1263',
        detail: 'Execution stopped; no further cleanup turn was submitted.',
        kept: [],
        items: [{ id: `terminal:${planThread}:exec-rg`, threadId: planThread, processId: '8812', status: 'running' }],
      }
    })
    writeRollout(planThread, [
      { type: 'session_meta', payload: { id: planThread, cwd: clarify.run.cwd } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-rg', process_id: '8812', status: 'failed', exit_code: 1 } } },
      { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } },
    ])
    const carried = await startRun({ action: 'resolve', id: 2 })
    if ('error' in carried) assert.fail(carried.error)
    assert.deepEqual(carried.run.continues, { resumeId: planThread })
    assert.equal(carried.run.resumeId, planThread)
  })
})
