import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { canKeepFlow, reclaimFlowWorkers } from '../src/flow-worker'
import { runnerHome } from '../src/home'
import { until } from './fake-cloud'
import { machine, cloud, log, folder, gate, calls, commands, launch, exit, reclaimed } from './flow-worker-harness'

for (const scenario of ['confirmed', 'legacy_terminal', 'running_item', 'foreign_session'] as const) {
  it(`handles manual resume after a stopped Codex run (${scenario})`, async () => {
    const file = 'todo/0002-saved.md'
    const saved = '# Saved work\n\nKeep me.\n'
    const session = 'codex-thread-stopped'
    const detail = 'Execution stopped; no further cleanup turn was submitted.'
    const cleanup = scenario === 'confirmed' || scenario === 'foreign_session'
      ? { status: 'confirmed', kept: [], items: [] }
      : { status: 'unconfirmed', detail, kept: [], items: [{ id: 'terminal:t:1', threadId: session, status: scenario === 'running_item' ? 'running' : 'completed' }] }
    process.env.FAKE_AKB = JSON.stringify({
      implement: { agentSession: session, writes: { [file]: saved }, end: { status: 'stopped', deliveryId: 'original-delivery', cleanup } },
      resume: { keep: { [file]: saved } },
    })
    const dispatch = { task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
      runtime: 'codex', flow: { studio: 'wf_builtin_coding', verb: 'implement' } } as const
    const original = cloud.dispatch({ ...dispatch, id: 'job-stopped' })
    launch()
    await until(() => original.state === 'finished', 15_000)
    if (scenario === 'foreign_session') {
      const runsFile = path.join(folder(), '.akb/kanban/.fake/runs.json')
      const runs = JSON.parse(fs.readFileSync(runsFile, 'utf8'))
      runs.push({ sessionId: 'foreign-session', cardId: 999, action: 'implement', status: 'done', resumeId: session })
      fs.writeFileSync(runsFile, JSON.stringify(runs))
    }

    const resumed = cloud.dispatch({ ...dispatch, id: 'job-resumed',
      flow: { ...dispatch.flow, resume: true, resume_execution: original.id } })
    await until(() => resumed.state === 'finished', 15_000)
    if (scenario === 'running_item' || scenario === 'foreign_session') {
      assert.equal(resumed.outcome, 'failed', log)
      assert.equal(resumed.reason, 'task_recovery_unverified')
      assert.ok(!calls().some(args => args[1] === 'run' && args[2] === 'resume'))
    } else {
      assert.equal(resumed.outcome, 'done', `${log}\n${resumed.reason}`)
      assert.equal(resumed.report?.session, session)
      assert.equal(resumed.report?.deliveryId, 'original-delivery')
      assert.ok(calls().some(args => args.slice(0, 4).join(' ') === 'raw run resume run-implement-1' && args.includes('--require-session')))
    }
    assert.equal(fs.readFileSync(path.join(folder(), '.akb/kanban', file), 'utf8'), saved)
  })
}

for (const workerExited of [false, true]) it(`retains a completed result while its upload is offline (${workerExited ? 'worker exit, #903' : 'Runner restart, #693'})`, async () => {
  process.env.FAKE_AKB = JSON.stringify({ refine: { gates: [gate(1)], result: 'Pending upload', spent: { costUsd: 0.25 } } })
  const job = cloud.dispatch({ id: 'job', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'refine' } })
  launch()
  await until(() => commands('refine').length === 1, 15_000)
  await exit('SIGKILL')
  cloud.offline = true
  fs.writeFileSync(gate(1), '')
  await until(() => {
    try { return !!JSON.parse(fs.readFileSync(path.join(runnerHome(), 'checkpoints/job.json'), 'utf8')).completed } catch { return false }
  }, 10_000)
  const record = path.join(runnerHome(), 'flow-workers/job.json')
  assert.ok(fs.existsSync(record))
  if (workerExited) process.kill(JSON.parse(fs.readFileSync(record, 'utf8')).pid, 'SIGKILL')
  await reclaimFlowWorkers(machine)
  assert.ok(fs.existsSync(record))
  launch()
  cloud.offline = false
  await until(() => job.state === 'finished', 15_000)
  assert.equal(job.outcome, 'done', log)
  await reclaimed(record)
  assert.equal(job.report?.reply, 'Pending upload')
  assert.equal(job.report?.costUsd, 0.25)
  assert.equal(commands('refine').length, 1)
  assert.equal(job.claims, workerExited ? 2 : 1)
})

for (const reason of ['stop', 'account', 'transfer', 'runner-transfer', 'crash'] as const) {
  it(`does not continue or replay after ${reason} (#693)`, async () => {
    process.env.FAKE_AKB = JSON.stringify({ implement: { gates: [gate(1)], result: 'Must not land' } })
    const job = cloud.dispatch({ id: 'job', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
      runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'implement' } })
    launch()
    const record = path.join(runnerHome(), 'flow-workers/job.json')
    await until(() => commands('implement').length === 1, 15_000)
    const worker = JSON.parse(fs.readFileSync(record, 'utf8'))
    if (reason !== 'crash') await exit('SIGKILL')
    if (reason === 'stop') job.stop = true
    if (reason === 'transfer') job.leaseLost = true
    if (reason === 'runner-transfer') cloud.runner = { machineId: 'another-machine', machineName: 'Elsewhere', live: true }
    if (reason === 'account') fs.writeFileSync(path.join(runnerHome(), 'account-generation'), 'signed-out')
    if (reason === 'crash') process.kill(worker.pid, 'SIGKILL')
    if (reason === 'stop' || reason === 'crash') {
      await until(() => job.state === 'finished', 15_000).catch(e => {
        throw new Error(`${e}: ${log}\n${fs.existsSync(record + '.log') ? fs.readFileSync(record + '.log', 'utf8') : ''}\n${fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : ''}`)
      })
      await reclaimed(record)
      assert.equal(job.outcome, reason === 'stop' ? 'stopped' : 'failed', `${log}\n${job.reason}`)
    } else {
      await until(() => JSON.parse(fs.readFileSync(record, 'utf8')).ended === true, 15_000)
    }
    assert.equal(commands('implement').length, 1)
    assert.equal(job.claims, 1)
    assert.notEqual(job.outcome, 'done')
    assert.ok(!fs.existsSync(path.join(folder(), '.akb/kanban/.archive/2-test.md')))
  })
}

it('refuses a recorded launch whose execution cannot be identified (#693)', async () => {
  process.env.FAKE_AKB = '{}'
  const directory = path.join(runnerHome(), 'flow-workers')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'job.json'), JSON.stringify({ id: 'job', token: 'old', account: 'acct',
    machine, generation: '', at: 0 }))
  const job = cloud.dispatch({ id: 'job', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'refine' } })
  launch()
  await until(() => job.state === 'finished', 10_000)
  assert.equal(job.outcome, 'failed', log)
  assert.equal(commands('refine').length, 0)
  assert.match(job.reason ?? '', /Saved work was preserved/)
})

it('keeps replies and other flow types outside detached execution (#693)', () => {
  const base = { task: 'task_1', flow: { verb: 'implement' } }
  assert.ok(canKeepFlow(base as never))
  for (const other of [{ chat: {} }, { discussion: {} }, { flow: { verb: 'resolve' } }, { flow: { verb: 'discard' } }, { review: {} }, { agent: {} }]) {
    assert.equal(canKeepFlow({ ...base, flow: null, ...other } as never), false)
  }
})
