import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { runnerHome } from '../src/home'
import { until } from './fake-cloud'
import { cloud, log, folder, gate, calls, commands, launch, exit, reclaimed } from './flow-worker-harness'

for (const verb of ['create', 'refine', 'implement']) for (const signal of ['SIGTERM', 'SIGKILL', 'update'] as const) {
  it(`${verb} survives Runner ${signal} without a second execution (#693)`, async () => {
    const action = verb === 'create' ? 'refine' : verb
    if (verb === 'create') cloud.put({ 'todo/2-test.md': null })
    process.env.FAKE_AKB = JSON.stringify({ [action]: { gates: [gate(1), gate(2)], result: 'Original result',
      spent: { costUsd: 0.25, usage: { input: 10, output: 2 } }, ...(verb === 'refine' ? { status: 'planned' } : {}) } })
    const job = cloud.dispatch({ id: 'job', task: 'task_1', project: 'prj_1', projectDir: folder(), number: 2,
      runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb,  } })
    launch()
    await until(() => commands(action).length === 1, 15_000)
    const record = path.join(runnerHome(), 'flow-workers/job.json')
    fs.writeFileSync(`${record}.log`, 'output from an earlier version')
    const pid = JSON.parse(fs.readFileSync(record, 'utf8')).pid
    await exit(signal)
    process.kill(pid, 0)
    assert.equal(job.state, 'claimed', log)
    fs.writeFileSync(gate(1), '')
    launch()
    await until(() => cloud.registrations >= 2, 10_000)
    fs.writeFileSync(gate(2), '')
    await until(() => job.state === 'finished', 15_000)
    await reclaimed(record)
    assert.equal(fs.readFileSync(`${record}.log`, 'utf8'), 'output from an earlier version')
    const entries = fs.readFileSync(path.join(runnerHome(), 'logs', 'runner.log'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
    assert.ok(entries.some(row => row.component === 'task' && row.job === job.id && row.stream === 'stdout' && row.text.includes('Original result')))
    assert.ok(!fs.existsSync(`${record}.stop`))
    assert.equal(job.outcome, 'done', `${log}\n${job.reason}`)
    assert.equal(job.claims, 1)
    assert.equal(commands(action).length, 1)
    assert.equal(job.report?.costUsd, verb === 'implement' ? 0.5 : 0.25)
    assert.equal((job.report?.usage as { input?: number } | undefined)?.input, verb === 'implement' ? 20 : 10)
    assert.equal(job.report?.reply, verb === 'implement' ? 'Landed it.' : 'Original result')
    assert.ok(!calls().some((c) => c[1] === 'run' && c[2] === 'stop'))
  })
}
