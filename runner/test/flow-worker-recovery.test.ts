import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { until } from './fake-cloud'
import { cloud, log, folder, calls, commands, launch, reclaimed, recordOf } from './flow-worker-harness'

for (const pendingWrites of [false, true]) it(`preserves W-1198 background verification progress (${pendingWrites ? 'unconfirmed' : 'resumes'})`, async () => {
  const file = 'saved-result.txt'
  const saved = 'Completed work'
  const session = 'original-verification-session'
  const failure = { source: 'runtime', code: 'completed_operation_failed', summary: 'Runner background verification exited with failing tests.' }
  process.env.FAKE_AKB = JSON.stringify({
    implement: { agentSession: session, writes: { [file]: saved }, end: {
      status: 'error', deliveryId: 'original-delivery', failure, retryPause: 'unsafe', pendingWrites,
      cleanup: { status: 'confirmed', kept: [] },
      retryHistory: [{ ...failure, attempt: 1, at: new Date().toISOString(), sessionAction: 'resume' }],
    } },
    resume: { keep: { [file]: saved } },
  })
  // W-1198 used an active delivery and had already saved work before verification failed.
  const dispatch = { task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    runtime: 'codex', flow: { studio: 'wf_builtin_coding', verb: 'implement' } } as const
  const original = cloud.dispatch({ ...dispatch, id: 'job' })
  launch()
  await until(() => original.state === 'finished', 15_000)
  assert.equal(original.outcome, 'failed', log)
  assert.equal(original.report?.failure?.safeToRetry, !pendingWrites, `${original.reason}\n${log}`)
  assert.equal(original.report?.failure?.sessionAction, pendingWrites ? 'pause_unsafe' : 'resume')
  assert.equal(commands('implement').length, 1)
  assert.equal(fs.readFileSync(path.join(folder(), '.akb/kanban', file), 'utf8'), saved)

  const resumed = cloud.dispatch({ ...dispatch, id: 'resumed-job',
    flow: { ...dispatch.flow, resume: true, resume_execution: original.id } })
  await until(() => resumed.state === 'finished', 15_000)
  if (pendingWrites) {
    assert.match(original.report?.failure?.detail ?? '', /操作结果|operation results/i)
    assert.equal(resumed.outcome, 'failed', log)
    assert.equal(resumed.reason, 'task_recovery_unverified')
    assert.ok(!calls().some(args => args[1] === 'run' && args[2] === 'resume'))
  } else {
    assert.equal(resumed.outcome, 'done', `${log}\n${resumed.reason}`)
    assert.equal(resumed.report?.session, session)
    assert.equal(resumed.report?.deliveryId, 'original-delivery')
    assert.ok(calls().some(args => args.slice(0, 4).join(' ') === 'raw run resume run-implement-1' && args.includes('--require-session')))
  }
  assert.equal(commands('implement').length, 1)
  assert.equal(fs.readFileSync(path.join(folder(), '.akb/kanban', file), 'utf8'), saved)
})

for (const mode of ['available', 'preflight', 'runtime', 'no-id']) it(`resumes the W-1226 idle timeout from saved progress (${mode})`, async () => {
  const failure = { code: 'idle_timeout', source: 'runtime', summary: 'No verifiable progress for 5 minutes (idle timeout).' }
  const file = 'saved-result.txt'
  const saved = 'Completed work before the timeout'
  const session = 'original-antigravity-session'
  const deliveryId = 'original-delivery'
  const attempt = 'run-implement-1'
  process.env.FAKE_AKB = JSON.stringify({
    implement: {
      agentSession: mode === 'no-id' ? undefined : session, writes: { [file]: saved },
      end: { status: 'error', deliveryId, failure, retryPause: 'unsafe', pendingWrites: true,
        cleanup: { status: 'unconfirmed', execution: attempt, kept: [] },
        retryHistory: [{ ...failure, attempt: 1, at: new Date().toISOString(), sessionAction: 'pause_unsafe' }],
      },
    },
    resume: { missing: ['preflight', 'runtime'].includes(mode) ? mode : undefined, keep: { [file]: saved } },
  })
  const dispatch = { task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
    runtime: 'antigravity', flow: { studio: 'wf_builtin_coding', verb: 'implement' } } as const
  const original = cloud.dispatch({ ...dispatch, id: 'job' })
  launch()
  await until(() => original.state === 'finished', 15_000)
  assert.equal(original.outcome, 'failed', log)
  assert.equal(original.report?.failure?.safeToRetry, false)
  assert.equal(original.report?.failure?.code, 'idle_timeout')

  const resumed = cloud.dispatch({ ...dispatch, id: `resumed-${mode}`,
    flow: { ...dispatch.flow, resume: true, resume_execution: original.id } })
  await until(() => resumed.state === 'finished', 20_000)
  await reclaimed(recordOf(resumed.id))
  assert.equal(resumed.outcome, 'done', `${log}\n${resumed.reason}`)
  assert.equal(resumed.claims, 1)
  assert.equal(resumed.report?.session, mode === 'available' ? session : 'new-agent-session')
  assert.equal(resumed.report?.deliveryId, deliveryId)
  const resumes = calls().filter(args => args[1] === 'run' && args[2] === 'resume')
  assert.deepEqual(resumes.map(args => args.slice(3, 5)), [
    ...(mode === 'no-id' ? [] : [[attempt, '--require-session']]),
    ...(mode === 'available' ? [] : [[mode === 'runtime' ? `missing-${attempt}` : attempt, '--fresh']]),
  ])
  assert.equal(commands('implement').length, 1)
  assert.equal(fs.readFileSync(path.join(folder(), '.akb/kanban', file), 'utf8'), saved)
})
