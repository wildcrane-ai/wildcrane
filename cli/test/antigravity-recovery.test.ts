import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { ANTIGRAVITY } from '../src/lib/agent/harnesses/antigravity'
import { harnessGaps } from '../src/lib/agent/capabilities'
import { startRun } from '../src/lib/agent/start'
import { openResume, patch, readSpec } from '../src/lib/agent/sessions'
import { readRuns } from '../src/lib/agent/store'
import { watchRun } from '../src/lib/agent/watch'
import { setBoardRoot } from '../src/lib/paths'
import { forgetMachineState, move, uiConfigOf } from './helpers/board'

for (const mode of ['init', 'submitted', 'work', 'no-session', 'work-missing']) it(`AGy early-crash recovery after ${mode} (#830)`, { timeout: 20_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-early-'))
  const wrote = mode === 'work' || mode === 'work-missing'
  const submitted = mode === 'submitted' || wrote
  const oldHome = process.env.HOME
  const session = '00000000-0000-4000-8000-000000000830'
  const fresh = '00000000-0000-4000-8000-000000001234'
  let agentPid: number | undefined
  try {
    process.env.HOME = root
    setBoardRoot(root)
    fs.mkdirSync(path.join(root, 'docs/kanban/todo'), { recursive: true })
    fs.writeFileSync(path.join(root, 'docs/kanban/next-id'), '1\n')
    await move(root, ['create', '--title', 'Preserve Cedar830'])
    const db = path.join(root, '.gemini/antigravity-cli/conversations', `${session}.db`)
    const output = path.join(root, 'completed.txt')
    const script = path.join(root, 'agy.mjs')
    fs.writeFileSync(script, `
      import fs from 'node:fs';
      const out = e => console.log(JSON.stringify(e));
      const args = process.argv.slice(2);
      if (args.includes('--conversation')) {
        if (args[args.indexOf('--conversation') + 1] !== ${JSON.stringify(session)}) process.exit(2);
        const prompt = args.at(-1);
        if (prompt.includes('Plan task 1') === ${submitted} || !/verify.*do not repeat/i.test(prompt)) process.exit(3);
        ${wrote ? `if (fs.readFileSync(${JSON.stringify(output)}, 'utf8') !== 'once') process.exit(4);` : ''}
        out({event:'init', conversation_id:${JSON.stringify(session)}});
        out({event:'result', result:{conversation_id:${JSON.stringify(session)}, status:'SUCCESS', response:'Cedar830 preserved.'}});
      } else {
        if (${JSON.stringify(mode)} === 'no-session') process.exit(1);
        ${mode === 'work-missing' ? `if (fs.existsSync(${JSON.stringify(output)})) {
          if (!args.at(-1).includes('Continue work.') || fs.readFileSync(${JSON.stringify(output)}, 'utf8') !== 'once') process.exit(4);
          out({event:'init', conversation_id:${JSON.stringify(fresh)}});
          out({event:'result', result:{conversation_id:${JSON.stringify(fresh)}, status:'SUCCESS', response:'Cedar830 preserved.'}});
          process.exit(0);
        }` : ''}
        fs.mkdirSync(${JSON.stringify(path.dirname(db))}, {recursive:true});
        fs.writeFileSync(${JSON.stringify(db)}, 'native session');
        out({event:'init', conversation_id:${JSON.stringify(session)}});
        ${mode === 'submitted' ? `out({event:'step_update', step_update:{conversation_id:${JSON.stringify(session)}, step_type:'user_input', step_index:0, state:'DONE'}});` : ''}
        ${wrote ? `fs.appendFileSync(${JSON.stringify(output)}, 'once');
        out({event:'step_update', step_update:{conversation_id:${JSON.stringify(session)}, step_type:'tool', step_index:1, state:'DONE', tool_info:{name:'write_file', parameters:{Path:${JSON.stringify(output)}}}}});` : ''}
        setInterval(() => {}, 1000);
      }
    `)
    fs.writeFileSync(uiConfigOf(root, 'docs', 'kanban'), JSON.stringify({ runtimes: [{ id: 'global', name: 'Global', harness: 'antigravity', settings: { command: `node ${script}` } }] }))
    const started = await startRun({ action: 'clarify', id: 1 })
    if ('error' in started) throw Error(started.error)
    const original = readSpec(started.run.sessionId)!.prompt
    patch(started.run.sessionId, r => { r.pid = process.pid })
    fs.writeFileSync(started.run.logPath, '')
    const watching = watchRun(started.run.sessionId, async () => ({ error: 'stop for manual resume check' }), () => 0)
    if (mode !== 'no-session') {
      const until = Date.now() + 5000
      while (true) {
        const run = readRuns().find(r => r.sessionId === started.run.sessionId)!
        agentPid = run.agentPid
        if (run.resumeId === session && (!submitted || run.submitted === true)) break
        assert.ok(Date.now() < until, 'session ID must be saved before any reply completes')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      process.kill(agentPid!, 'SIGKILL')
    }
    await watching
    agentPid = undefined
    const ended = readRuns().find(r => r.sessionId === started.run.sessionId)!
    assert.equal(ended.status, 'error')
    assert.equal(ended.result, undefined)
    if (mode === 'no-session') {
      assert.equal(ended.retryHistory?.at(-1)?.sessionAction, 'reset_replay')
      // When side effects occurred without a recorded session, openResume still refuses with runNoSession.
      patch(ended.sessionId, r => { delete r.unspawned; delete r.retry })
      const next = await openResume(ended.sessionId)
      assert.ok('error' in next)
      assert.equal(next.reason, 'runNoSession')
      assert.match(next.error, /did not record.*cannot be resumed/)
      assert.equal(readRuns().length, 1)
      return
    }
    assert.equal(ended.resumeId, session)
    if (mode === 'init') patch(ended.sessionId, r => { r.status = 'running'; r.pid = 2147483647 })
    fs.renameSync(db, `${db}.saved`)
    await assert.rejects(openResume(ended.sessionId), /session not found/)
    if (mode === 'work-missing') {
      // W-1226's legacy idle record carried unconfirmed writes after its process exited.
      patch(ended.sessionId, r => {
        r.failure = { code: 'idle_timeout', source: 'runtime', summary: 'No verifiable progress for 5 minutes (idle timeout).' }
        r.pendingWrites = true
        r.retryPause = 'unsafe'
        r.cleanup = { status: 'unconfirmed', execution: r.sessionId, kept: [] }
      })
      const missing = await openResume(ended.sessionId, { requireSession: true })
      assert.ok('error' in missing)
      assert.equal(missing.reason, 'runSessionMissing')
    }
    assert.equal(readRuns()[0]!.sessionId, ended.sessionId)
    if (mode !== 'work-missing') fs.renameSync(`${db}.saved`, db)
    const requireSession = mode === 'work'
    const next = await openResume(ended.sessionId, mode === 'work-missing' ? { fresh: true } : requireSession)
    if ('error' in next) throw Error(next.error)
    assert.equal(next.spec.plan.resumeId, mode === 'work-missing' ? null : session)
    if (requireSession) assert.match(next.spec.prompt, /Check the current state.*Do not repeat/s)
    else if (mode === 'work-missing') assert.match(next.spec.prompt, /Continue work/)
    else assert.equal(next.spec.prompt, submitted ? '' : original)
    patch(next.run.sessionId, r => { r.pid = process.pid })
    fs.writeFileSync(next.run.logPath, '')
    await watchRun(next.run.sessionId)
    const resumed = readRuns().find(r => r.sessionId === next.run.sessionId)!
    assert.equal(resumed.ok, true)
    assert.equal(resumed.result, 'Cedar830 preserved.')
    if (wrote) assert.equal(fs.readFileSync(output, 'utf8'), 'once')
    if (mode === 'work-missing') assert.equal(resumed.resumeId, fresh)
    assert.equal(ANTIGRAVITY.savesSessionAtOpen, true)
    assert.ok(!harnessGaps(ANTIGRAVITY).some(g => g.id === 'early-resume'))
  } finally {
    if (agentPid) { try { process.kill(agentPid, 'SIGKILL') } catch {} }
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    forgetMachineState(root)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
