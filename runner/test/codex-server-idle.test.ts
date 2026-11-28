import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { leaseFile, writePrivate } from '../src/codex-native'
import { reconcileCodexLeases } from '../src/codex-ownership'
import { until } from './fake-cloud'
import { projectStateDir } from '../../cli/src/lib/machine/project'
import { IDLE_TIMEOUT } from '../../cli/src/lib/agent/idle'
import { openResume, openRun, patch, peekRun } from '../../cli/src/lib/agent/sessions'
import { setBoardRoot } from '../../cli/src/lib/paths'
import { RETRY_FILE_ENV, retryBudget } from '../../cli/src/lib/agent/retry'
import { watchRun } from '../../cli/src/lib/agent/watch'

import { root, fake, manager, read, backends, peer, openManager } from './codex-server-harness'

for (const scenario of ['recover', 'release-rpc', 'restart', 'budget', 'unknown', 'live', 'stop', 'stop-release']) {
 it(`recovers managed Codex idle after git worktree add (${scenario}, #882)`, { timeout: 25_000 }, async () => {
  const neighbour = await peer()
  const other = strThread(await neighbour.rpc.call('thread/start', {}))
  await neighbour.rpc.call('turn/start', { threadId: other, input: [{ text: 'separate task' }] })
  const offset = read().length
  const workspace = fs.mkdtempSync(path.join(root, 'work-'))
  fs.mkdirSync(path.join(workspace, 'docs', 'kanban', 'todo'), { recursive: true })
  setBoardRoot(workspace)
  writePrivate(path.join(projectStateDir(path.join(workspace, 'docs', 'kanban')), 'ui.config.json'), {
    runtimes: [{ id: 'global', name: 'Global', harness: 'codex', settings: { command: `${fake} exec --json` } }],
  })
  const previousEnv = Object.fromEntries(Object.keys(manager.env).map(key => [key, process.env[key]]))
  Object.assign(process.env, manager.env)
  const oldIdle = IDLE_TIMEOUT.milliseconds
  IDLE_TIMEOUT.milliseconds = 1500
  const request = `Idle regression ${scenario}`
  const releaseGate = path.join(workspace, 'release-gate')
  const started = openRun({ action: 'prune-memory' }, request, [])
  if ('error' in started) throw Error(started.error)
  let latest = started.run.sessionId
  const seen: string[] = []
  const backoff = () => scenario === 'stop' ? 5_000 : 0
  const resume: NonNullable<Parameters<typeof watchRun>[1]> = async (id, options) => {
    const previous = peekRun(id)!
    assert.equal(previous.failure?.code, 'idle_timeout')
    assert.equal(previous.cleanup?.idleStop?.threadId, previous.resumeId)
    assert.equal(previous.cleanup?.status, 'confirmed')
    assert.ok(previous.retry?.pending)
    if (previous.agentPid) assert.throws(() => process.kill(previous.agentPid!, 0), { code: 'ESRCH' })
    const continued = await openResume(id, options)
    if ('error' in continued) throw Error(continued.error)
    assert.equal(continued.run.resumeId, previous.resumeId)
    latest = continued.run.sessionId
    seen.push(previous.resumeId!)
    patch(latest, run => {
      run.pid = process.pid
      if (scenario === 'budget') run.cloudExecution = execution
    })
    await watchRun(latest, resume, backoff)
    return { run: continued.run, spawned: true }
  }
  const budgetFile = path.join(workspace, 'runner-retries')
  const budget = retryBudget(budgetFile)
  if (scenario === 'budget') {
    budget.take()
    budget.take()
    process.env[RETRY_FILE_ENV] = budgetFile
  }
  const execution = { job: crypto.randomUUID(), machine: crypto.randomUUID() }
  patch(latest, run => {
    run.pid = process.pid
    if (scenario === 'budget') run.cloudExecution = execution
  })
  try {
    const watching = watchRun(latest, resume, backoff)
    const submitted = () => read().slice(offset).some(call => call.method === 'turn/start')
    await Promise.race([until(submitted, 8000), watching.then(() => assert.ok(submitted(), peekRun(latest)?.error))])
    if (scenario === 'restart') {
      const instance = backends()[0]!.instance
      await manager.close()
      await openManager()
      assert.equal(backends()[0]!.instance, instance)
    }
    if (scenario === 'stop') {
      await until(() => !!peekRun(latest)?.retry?.pending, 8000)
      patch(latest, run => { run.stopping = true })
      process.emit('SIGTERM', 'SIGTERM')
    }
    if (scenario === 'stop-release') {
      await until(() => read().slice(offset).some(call => call.method === 'thread/unsubscribe'), 8000)
      const backend = backends()[0]!
      const thread = read().slice(offset).find(call => call.method === 'turn/start').params.threadId
      const file = leaseFile(backend, thread)
      const reaping = reconcileCodexLeases(backend)
      patch(latest, run => { run.stopping = true })
      process.emit('SIGTERM', 'SIGTERM')
      await reaping
      assert.ok(fs.existsSync(file))
      fs.writeFileSync(releaseGate, '')
    }
    await watching
    const record = peekRun(latest)!
    const trace = read().slice(offset)
    const starts = trace.filter(call => call.method === 'turn/start')
    const thread = starts[0]?.params.threadId
    const expected = scenario === 'budget' ? 3 : ['recover', 'release-rpc', 'restart'].includes(scenario) ? 2 : 1
    assert.equal(starts.length, expected, record.error)
    assert.equal(starts.filter(call => call.params.input[0].text === request).length, 1)
    assert.ok(starts.every(call => call.params.threadId === thread))
    assert.equal(trace.filter(call => call.method === 'thread/start').length, 1)
    assert.equal(trace.filter(call => call.method === 'turn/interrupt' && call.params.threadId === other).length, 0)
    assert.equal(fs.readFileSync(path.join(workspace, `${thread}.worktree-result`), 'utf8'), 'worktree created\n')
    assert.equal(seen.length, expected - 1)
    if (expected > 1) {
      const find = (method: string, predicate = (_call: any) => true) => trace.findIndex(call => call.method === method && call.params.threadId === thread && predicate(call))
      const interrupt = find('turn/interrupt')
      const confirmation = find(scenario === 'restart' ? 'thread/turns/list' : 'thread/read', call => scenario === 'restart' || call.params.includeTurns)
      const release = find('thread/unsubscribe')
      const resume = find('thread/resume')
      assert.ok(interrupt >= 0 && interrupt < confirmation && confirmation < release && release < resume)
      if (scenario === 'release-rpc') {
        const pages = trace.slice(release, resume).filter(call => call.method === 'thread/loaded/list')
        assert.deepEqual(pages.map(call => call.params.cursor), [undefined, 'page-two'])
      }
    }
    if (scenario === 'budget') {
      assert.equal(record.retry?.attempt, 5)
      assert.equal(retryBudget(budgetFile).take(), undefined)
      assert.equal(record.retryPause, 'limit')
    } else if (scenario === 'unknown' || scenario === 'live') {
      assert.equal(record.retryPause, 'unsafe')
      assert.equal(record.cleanup?.status, 'unconfirmed')
      assert.equal(record.failure?.code, 'idle_timeout')
    } else {
      assert.equal(record.status, scenario.startsWith('stop') ? 'stopped' : 'done')
    }
  } finally {
    if (scenario === 'stop-release') fs.writeFileSync(releaseGate, '')
    if (scenario === 'budget') delete process.env[RETRY_FILE_ENV]
    IDLE_TIMEOUT.milliseconds = oldIdle
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await neighbour.close()
  }
 })
}

const strThread = (value: Record<string, unknown>) => (value.thread as { id: string }).id
