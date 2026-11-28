import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { acquireMachine, RunnerAlreadyRunning } from '../src/lock'
import { runnerHome } from '../src/home'
import { mcpArgs } from '../src/flow'
import { until } from './fake-cloud'
import { cloud, runner, clearRunner, setInstalled, MACHINE, cached, fakeAkb, start, flowReport, flowFixture } from './runner-harness'

describe('flow jobs (#2020)', () => {
  const { board, typed, calls, runtimeFor, cardCalls, flowJob } = flowFixture()

  describe('stopping the board runs a build started (#2092)', () => {
    type FakeRun = { sessionId: string; status?: string; startedAt: number }
    const runsFile = () => path.join(board(), '.fake', 'runs.json')
    const runs = () => JSON.parse(fs.readFileSync(runsFile(), 'utf8')) as FakeRun[]
    const building = async (stopMs?: number) => {
      if (stopMs) start('', { stopMs })
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
      clearRunner()
      assert.ok(Date.now() - at < 3_000, 'closing waited past its limit')
      stopsBuild()
      assert.equal(cloud.runner!.live, false)
      assert.equal(job.state, 'claimed')
    })

    it('等本地运行停止后才接受新实例（#316）', async () => {
      await building()
      const closing = runner!.close()
      await assert.rejects(acquireMachine('codex'), RunnerAlreadyRunning)
      await closing
      clearRunner()
      await (await acquireMachine('codex'))()
      stopsBuild()
      assert.equal(cloud.runner!.live, false)
    })

    it('when the job’s lease is lost', async () => {
      const job = await building()
      job.leaseLost = true
      await until(() => runs().filter((r) => r.sessionId.startsWith('run-implement')).every((r) => r.status === 'stopped') && runs().length >= 5)
      stopsBuild()
    })

    it('when the user stops it, ending the job stopped (#2128)', async () => {
      const job = await building(10_000)
      await until(() => cloud.logs.some(log => log.job === job.id && !log.socket.destroyed))
      cloud.stopOverLog(job.id)
      await until(() => job.state === 'finished', 20_000)
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
        { sessionId: 'old-build', cardId: 2, action: 'implement', status: 'stopped', deliveryId: 'd1', resumeId: 'original-thread', startedAt: earlier + 2, endedAt: Date.now(), ...over },
        { sessionId: 'other-delivery', cardId: 2, action: 'implement', status: 'stopped', deliveryId: 'd2', resumeId: 'other-thread', startedAt: earlier + 3, endedAt: Date.now() },
        { sessionId: 'helper', cardId: 2, action: 'sub', status: 'stopped', deliveryId: 'd1', startedAt: earlier + 4 },
      ]))
    }

    it('resumes the original build conversation without implementing or resolving again', async () => {
      await flowJob('j1', { verb: 'create' })
      priorBuild()
      const job = await flowJob('j2', { verb: 'implement', card: 2, text: 'Monthly', resume: true })
      assert.equal(job.outcome, 'done', job.reason)
      const log = calls().map((c) => c.join(' '))
      const at = log.indexOf(`delivery resume 2 --follow --events --json --board ${board()}`)
      assert.ok(at >= 0 && log.slice(at).includes(`run resume old-build --require-session --follow --events --json --board ${board()}`))
      assert.equal(typed().filter(c => c.slice(0, 3).join(' ') === 'raw delivery resume').length, 1)
      assert.equal(calls().filter(c => c[0] === 'run' && c[1] === 'resume').length, 1)
      assert.ok(!cloud.log.some(request => /^POST \/v1\/tasks\/[^/]+\/resume$/.test(request)))
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
      process.env.FAKE_AKB = JSON.stringify({ delivery: { landed: true, result: { commit: 'a'.repeat(40), branch: 'main' } } })
      const before = calls().length
      const landed = await flowJob('j4', { verb: 'implement', card: 2, resume: true })
      assert.equal(landed.outcome, 'done', landed.reason)
      assert.deepEqual(flowReport(landed), { card: 2, deliveryCompleted: true, deliveryId: 'd1', landing: { commit: 'a'.repeat(40), branch: 'main' } })
      assert.ok(!calls().slice(before).some(c => c[0] === 'run' && c[1] === 'resume'))
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

    it('follows the exact reconciled delivery through fresh-session recovery', async () => {
      await flowJob('j1', { verb: 'create' })
      priorBuild()
      process.env.FAKE_AKB = JSON.stringify({
        reconcile: { kind: 'resumable', deliveryId: 'd2', status: 'active' },
        delivery: { follow: true },
      })
      const job = await flowJob('j2', { verb: 'implement', card: 2, resume: true })
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal(job.report?.deliveryId, 'd2')
      assert.equal(job.report?.session, 'fresh-delivery-session')
      assert.ok(calls().some(args => args.slice(0, 5).join(' ') === 'delivery resume d2 --follow --events'))
      assert.ok(!calls().some(args => args[0] === 'run' && ['resume', 'log'].includes(args[1]!)))
    })

    it('stops a delivery resume on a structured recovery refusal', async () => {
      await flowJob('j1', { verb: 'create' })
      priorBuild()
      const message = 'The operation results could not be confirmed complete.'
      process.env.FAKE_AKB = JSON.stringify({ delivery: { refuse: message, reason: 'runNoSession' } })
      const before = calls().length
      const job = await flowJob('j2', { verb: 'implement', card: 2, resume: true })
      assert.equal(job.outcome, 'failed')
      assert.equal(job.reason, message)
      const attempted = calls().slice(before).map(c => c.slice(0, 2).join(' '))
      assert.ok(attempted.includes('delivery resume'))
      assert.ok(attempted.every(action => !['task implement', 'card implement', 'run resume'].includes(action)))
    })

    it('reuses the saved delivery and pauses when no session ID was recorded (#1234, #419)', async () => {
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
      const before = calls().length
      const missing = await flowJob('j4', { verb: 'implement', card: 2, resume: true })
      assert.equal(missing.outcome, 'failed')
      assert.match(missing.reason ?? '', /original conversation cannot be resumed/)
      assert.ok(calls().slice(before).some(c => c.slice(0, 4).join(' ') === 'run resume old-build --require-session'))
      assert.ok(!calls().slice(before).some(c => c.includes('--fresh')))
      assert.ok(!calls().slice(before).some(c => c.slice(0, 2).join(' ') === 'card implement'))
    })

    it('explains a held resume and checks the delivery even for an archived card (#419, #918)', async () => {
      await flowJob('j1', { verb: 'create' })
      process.env.FAKE_AKB = JSON.stringify({ delivery: { refuse: 'delivery d2 is building #2 now', reason: 'deliveryHeld', args: { id: 'd2' } } })
      const held = await flowJob('j2', { verb: 'implement', card: 2, resume: true })
      assert.equal(held.outcome, 'failed')
      assert.match(held.reason ?? '', /「续跑」/)
      const file = fs.readdirSync(path.join(board(), 'todo')).find((n) => n.startsWith('2-'))!
      fs.renameSync(path.join(board(), 'todo', file), path.join(board(), '.archive', file))
      process.env.FAKE_AKB = JSON.stringify({ delivery: { refuse: 'no delivery here answers to "2"', reason: 'deliveryNotFound' } })
      const before = cardCalls().length
      const archived = await flowJob('j3', { verb: 'implement', card: 2, resume: true })
      assert.equal(archived.outcome, 'done', archived.reason)
      assert.equal(archived.report?.deliveryCompleted, false)
      assert.equal(cardCalls().length, before)
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
    const leaveRun = (job?: string) =>
      fs.writeFileSync(runsFile(), JSON.stringify([...runs(), {
        sessionId: 'run-left', cardId: 2, action: 'refine', status: 'running', startedAt: Date.now() - 1_000,
        ...(job ? { cloudExecution: { job, machine: MACHINE } } : {}),
      }]))
    const stops = () => calls().filter((c) => c[0] === 'run' && c[1] === 'stop').map((c) => c[2])

    it('when the Runner restarts under a job it held', async () => {
      await flowJob('j1', { verb: 'create' })
      await runner!.close()
      clearRunner()
      leaveRun('j2')
      const job = cloud.dispatch({ id: 'j2', state: 'claimed', machine: MACHINE, task: 'task_1', project: 'prj_1', number: 2, runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'implement', card: 2 } })
      cloud.runner = { machineId: MACHINE, machineName: 'studio', live: true }
      start()
      await until(() => job.state === 'finished')
      assert.match(job.reason!, /previous execution could not be verified/)
      assert.equal(runs().find((r) => r.sessionId === 'run-left')!.status, 'stopped')
    })

    it('keeps the claim pending while the previous processes cannot be checked (#1248)', async () => {
      await flowJob('j1', { verb: 'create' })
      await runner!.close()
      clearRunner()
      leaveRun('j2')
      const before = cardCalls().length
      const job = cloud.dispatch({ id: 'j2', state: 'claimed', machine: MACHINE, task: 'task_1', project: 'prj_1', number: 2,
        runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', verb: 'implement', card: 2 } })
      cloud.runner = { machineId: MACHINE, machineName: 'studio', live: true }
      const probe = path.join(runnerHome(), 'probe-failed')
      start('', { akb: () => ({ ...fakeAkb(), args: ['-e',
        `require('node:fs').writeFileSync(${JSON.stringify(probe)}, ''); process.exit(1)`, '--'] }) })
      job.stop = true
      await until(() => fs.existsSync(probe))
      assert.equal(job.state, 'claimed')
      assert.equal(cardCalls().length, before)
      assert.equal(runs().find((r) => r.sessionId === 'run-left')!.status, 'running')
    })

    it('leaves an unowned legacy run alone and resumes after it exits (#1248)', async () => {
      await flowJob('j1', { verb: 'create' })
      leaveRun()
      const job = await flowJob('j2', { verb: 'revise', card: 2, text: 'shorter' })
      assert.equal(job.outcome, 'failed')
      assert.equal(runs().find((r) => r.sessionId === 'run-left')!.status, 'running')
      assert.deepEqual(stops(), [])
      fs.writeFileSync(runsFile(), JSON.stringify(runs().map(run => run.sessionId === 'run-left' ? { ...run, status: 'stopped' } : run)))
      const resumed = await flowJob('j3', { verb: 'revise', card: 2, text: 'shorter' })
      assert.equal(resumed.outcome, 'done', resumed.reason)
      assert.equal(cardCalls().filter(call => call.startsWith('card revise')).length, 1)
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
    assert.equal(runtimeFor().harness, 'codex')
    assert.equal(runtimeFor().settings.model, 'gpt-5-codex')
    setInstalled([{ name: 'codex', installed: true }, { name: 'claude-code', installed: false }])
    const missing = await flowJob('j2', { verb: 'approve', card: 2 })
    assert.equal(missing.outcome, 'failed')
    assert.equal(missing.reason, 'Claude Code is not installed on this computer.')
    setInstalled([{ name: 'codex', installed: true }, { name: 'claude-code', installed: true, loggedIn: false }])
    await runner!.close()
    clearRunner()
    start('', { syncBackoff: () => 100 })
    const signedOut = cloud.dispatch({ id: 'j3', task: 'task_1', project: 'prj_1', number: 2,
      runtime: 'claude-code', flow: { verb: 'approve', studio: 'wf_builtin_coding', card: 2 } })
    await until(() => signedOut.state === 'finished')
    assert.equal(signedOut.outcome, 'failed')
    assert.equal(signedOut.reason, 'Claude Code is not signed in on this computer.')
    assert.equal(runtimeFor().harness, 'codex')
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
    const file = path.join(board(), '.sync', 'task_1.j1.mcp.json')
    assert.equal(runtimeFor().settings.args, `--mcp-config ${file}`)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), servers)

    assert.equal(
      mcpArgs('codex', servers.mcpServers, file),
      `-c 'mcp_servers.files.command="npx"' -c 'mcp_servers.files.args=["-y","@acme/files"]'`,
    )

    // The task moved onto a newer version.
    cloud.task.studio = { ...cloud.task.studio, version: 2, files: { 'STUDIO.md': 'x' } }
    fs.rmSync(path.join(runnerHome(), 'studios', 'tasks', 'task_1.json'))
    await flowJob('j2', { verb: 'refine', card: 2 })
    assert.equal(runtimeFor().settings.args, undefined, 'the servers outlived the version')
  })

  it('hands an ACP runtime the MCP servers as its mcpConfig, not as arguments', async () => {
    setInstalled([{ name: 'opencode', installed: true }])
    const servers = { mcpServers: { files: { command: 'npx', args: ['-y', '@acme/files'] } } }
    cloud.task.studio = { studio: 'wf_builtin_coding', version: 1, builtin: true, files: { 'STUDIO.md': 'x', 'mcp.json': JSON.stringify(servers) } }
    const job = await flowJob('j1', { verb: 'create' }, { runtime: 'opencode' })
    assert.equal(job.outcome, 'done', job.reason)
    const file = path.join(board(), '.sync', 'task_1.j1.mcp.json')
    assert.equal(runtimeFor().settings.args, undefined)
    assert.equal(runtimeFor().settings.mcpConfig, file)
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
    assert.ok(!create.includes('--priority'))
    assert.deepEqual([flag('--modules'), flag('--related'), flag('--blocked-by')], ['web,cli', '5', '5'])
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
