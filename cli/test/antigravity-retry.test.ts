import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { it } from 'node:test'
import { createAntigravityRenderer } from '../src/lib/agent/wire/antigravity'
import { IDLE_TIMEOUT } from '../src/lib/agent/idle'
import { startRun } from '../src/lib/agent/start'
import { openResume, patch } from '../src/lib/agent/sessions'
import { readRuns } from '../src/lib/agent/store'
import { watchRun } from '../src/lib/agent/watch'
import { setBoardRoot } from '../src/lib/paths'
import { forgetMachineState, move, uiConfigOf } from './helpers/board'

it('preserves Antigravity failures that only carry diagnostic text for manual recovery', () => {
  for (const error of ['503 Service Unavailable (retry-after: 1)', 'network error: ECONNRESET', 'validation failed']) {
    const renderer = createAntigravityRenderer()
    renderer.push(JSON.stringify({ event: 'result', result: { status: 'ERROR', error, response: '' } }) + '\n')
    renderer.flush()
    assert.equal(renderer.executionFailure?.()?.source, 'runtime')
    assert.ok(renderer.failure?.()?.includes(error))
  }
  const tool = createAntigravityRenderer()
  tool.push(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', state: 'ERROR',
    tool_info: { name: 'run_command', error: { message: 'network error' } } } }) + '\n')
  tool.push(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Handled the tool failure.' } }) + '\n')
  tool.flush()
  assert.equal(tool.executionFailure?.(), undefined)
})

it('preserves an Antigravity task and its result after an unclassified EOF (#841)', { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-retry-'))
  const oldHome = process.env.HOME
  const session = '00000000-0000-4000-8000-000000000827'
  const partial = 'Saved the approved work.'
  let requests = 0
  const server = http.createServer((_req, res) => {
    requests++
    res.destroy()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    process.env.HOME = root
    setBoardRoot(root)
    fs.mkdirSync(path.join(root, 'docs/kanban/todo'), { recursive: true })
    fs.writeFileSync(path.join(root, 'docs/kanban/next-id'), '1\n')
    await move(root, ['create', '--title', 'Retry provider failure'])
    const db = path.join(root, '.gemini/antigravity-cli/conversations', `${session}.db`)
    fs.mkdirSync(path.dirname(db), { recursive: true })
    fs.writeFileSync(db, '')
    const script = path.join(root, 'agy.mjs')
    const output = path.join(root, 'output.txt')
    const calls = path.join(root, 'calls.jsonl')
    const port = (server.address() as import('node:net').AddressInfo).port
    fs.writeFileSync(script, `
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      const resumed = args.includes('--conversation');
      const session = ${JSON.stringify(session)};
      fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+${JSON.stringify('\n')});
      const out = e => console.log(JSON.stringify(e));
      out({event:'init',conversation_id:session});
      if (!resumed) {
        fs.appendFileSync(${JSON.stringify(output)}, 'written once');
        out({event:'step_update',step_update:{conversation_id:session,step_index:1,step_type:'tool',state:'DONE',tool_info:{name:'write_file',parameters:{Path:${JSON.stringify(output)}}}}});
        out({event:'step_update',step_update:{conversation_id:session,step_index:2,step_type:'agent_response',state:'ACTIVE',text_delta:${JSON.stringify(partial)}}});
      } else if (args[args.indexOf('--conversation')+1] !== session || fs.readFileSync(${JSON.stringify(output)},'utf8') !== 'written once') process.exit(2);
      try {
        const res = await fetch('http://127.0.0.1:${port}');
        const body = await res.text();
        out({event:'result',result:{conversation_id:session,status:'SUCCESS',response:body}});
      } catch {
        console.error('API error (attempt 1): request failed: Post https://example.test/generate: EOF (retry-after: 1)');
        process.exitCode = 1;
      }
    `)
    fs.writeFileSync(uiConfigOf(root, 'docs', 'kanban'), JSON.stringify({ runtimes: [{ id: 'global', name: 'Global', harness: 'antigravity', settings: { command: `node ${script}` } }] }))
    const started = await startRun({ action: 'clarify', id: 1 })
    if ('error' in started) throw Error(started.error)
    patch(started.run.sessionId, r => { r.pid = process.pid })
    fs.writeFileSync(started.run.logPath, '')
    let retryAttempts = 0
    await watchRun(started.run.sessionId, async () => { retryAttempts++; return { error: 'stopped in test' } }, () => 0)
    const ended = readRuns().find(r => r.cardId === 1)!
    assert.equal(requests, 1)
    assert.equal(retryAttempts, 1)
    assert.equal(ended.status, 'error')
    assert.equal(ended.failure?.source, 'runtime')
    assert.equal(ended.retryHistory?.length, 1)
    assert.equal(fs.readFileSync(output, 'utf8'), 'written once')
    assert.equal(ended.result, partial)
    assert.match(ended.error!, /request failed: Post.*EOF/)
    const next = await openResume(ended.sessionId)
    if ('error' in next) throw Error(next.error)
    assert.equal(next.spec.plan.resumeId, session)
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    forgetMachineState(root)
    fs.rmSync(root, { recursive: true, force: true })
  }
})


it('stops a stalled Antigravity task, keeps its saved work and pauses when a command result is unknown', { timeout: 15_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-idle-'))
  const oldHome = process.env.HOME
  const originalIdle = IDLE_TIMEOUT.milliseconds
  const session = '00000000-0000-4000-8000-000000001200'
  try {
    process.env.HOME = root
    IDLE_TIMEOUT.milliseconds = 600
    setBoardRoot(root)
    fs.mkdirSync(path.join(root, 'docs/kanban/todo'), { recursive: true })
    fs.writeFileSync(path.join(root, 'docs/kanban/next-id'), '1\n')
    await move(root, ['create', '--title', 'Confirm idle stop'])
    const script = path.join(root, 'agy.mjs')
    const output = path.join(root, 'saved.txt')
    fs.writeFileSync(script, `
      import fs from 'node:fs'
      fs.writeFileSync(${JSON.stringify(output)}, 'saved once');
      const out = e => console.log(JSON.stringify(e));
      out({event: 'init', conversation_id: '${session}'});
      const command = {conversation_id: '${session}', step_index: 79, step_type: 'tool', state: 'ACTIVE',
        tool_info: {name: 'run_command', parameters: {CommandLine: 'node --test'}}};
      out({event: 'step_update', step_update: command});
      setInterval(() => {
        out({event: 'step_update', step_update: command});
        console.error('root agent idle; waiting for 2 background task(s) to finish');
      }, 40);
    `)
    fs.writeFileSync(uiConfigOf(root, 'docs', 'kanban'), JSON.stringify({ runtimes: [{ id: 'global', name: 'Global', harness: 'antigravity', settings: { command: `node ${script}` } }] }))
    const started = await startRun({ action: 'clarify', id: 1 })
    if ('error' in started) throw Error(started.error)
    patch(started.run.sessionId, r => { r.pid = process.pid })
    fs.writeFileSync(started.run.logPath, '')
    await watchRun(started.run.sessionId, async () => { throw Error('Unconfirmed operations cannot be retried') }, () => 0)
    const ended = readRuns().find(r => r.sessionId === started.run.sessionId)!
    assert.equal(ended.resumeId, session)
    assert.equal(ended.failure?.code, 'idle_timeout')
    assert.equal(ended.retryPause, 'unsafe')
    assert.equal(ended.cleanup?.status, 'unconfirmed')
    assert.throws(() => process.kill(ended.agentPid!, 0), { code: 'ESRCH' })
    assert.equal(fs.readFileSync(output, 'utf8'), 'saved once')
  } finally {
    IDLE_TIMEOUT.milliseconds = originalIdle
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    forgetMachineState(root)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
