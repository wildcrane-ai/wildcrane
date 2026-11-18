import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { it } from 'node:test'
import { antigravityModels } from '../../cli/src/lib/agent/harnesses/antigravity'
import { ModelLists, type Model, type ModelSource } from '../src/model-list'
import { codexModels, cursorModels, output } from '../src/runtimes'

const model = (id: string): Model[] => [{ id, name: `Name ${id}` }]

it('deduplicates background reads, bounds hangs, retries, and isolates agents (#791)', async () => {
  let calls = 0
  let hanging = true
  let aborted = false
  const lists = new ModelLists({
    slow: (signal) => {
      calls++
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      return hanging ? new Promise<Model[]>(() => {}) : model('recovered')
    },
    healthy: () => [{ id: ' a ', name: ' Actual name ' }, { id: 'a', name: 'duplicate' }, { id: '', name: '' }],
  }, 10, 20)
  assert.deepEqual(await lists.read('slow'), [])
  assert.deepEqual(await lists.read('slow'), [])
  assert.equal(calls, 1)
  assert.deepEqual(await lists.read('healthy', [], true), [{ id: 'a', name: 'Actual name' }])
  assert.deepEqual(await lists.read('slow', [], true), [])
  assert.equal(aborted, true)
  hanging = false
  await delay(12)
  assert.deepEqual(await lists.read('slow', [], true), model('recovered'))
  assert.equal(calls, 2)
})

for (const kind of ['file', 'command', 'ACP'] as const) {
  it(`recovers ${kind} discovery and keeps the last list through failures and empty results (#791)`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-models-'))
    const state = path.join(dir, 'state.json')
    const log = path.join(dir, 'requests.jsonl')
    const script = path.join(dir, 'agent.cjs')
    const write = (phase: string) => fs.writeFileSync(state, JSON.stringify({ phase }))
    fs.writeFileSync(script, `
const fs = require('node:fs');
const { phase } = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
if (phase === 'fail') process.exit(1);
if (phase === 'timeout') setInterval(() => {}, 1000);
else if (process.argv[2] === 'models') {
  fs.appendFileSync(${JSON.stringify(log)}, 'models\\n');
  if (phase !== 'empty') console.log(phase + '\\tName ' + phase);
} else {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    fs.appendFileSync(${JSON.stringify(log)}, request.method + '\\n');
    const result = request.method === 'initialize' ? {} : { sessionId: 'discovery', models: { availableModels: phase === 'empty' ? [] : [{ modelId: phase, name: 'Name ' + phase }] } };
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
}
`)
    const source: ModelSource = kind === 'file' ? () => codexModels(state)
      : kind === 'command' ? async signal => antigravityModels(await output(process.execPath, [script, 'models'], signal))
      : signal => cursorModels(signal, [process.execPath, script, 'acp'])
    const lists = new ModelLists({ agent: source }, 0, 500)
    let notifications = 0
    const stop = lists.subscribe(() => notifications++)
    const phase = (value: string) => {
      if (kind !== 'file') write(value)
      else fs.writeFileSync(state, value === 'fail' ? '{' : JSON.stringify({ models: value === 'empty' ? [] : [{ slug: value, display_name: `Name ${value}`, visibility: 'list' }] }))
    }
    try {
      phase('fail')
      assert.deepEqual(await lists.read('agent', [], true), [])
      phase('empty')
      assert.deepEqual(await lists.read('agent', [], true), [])
      if (kind !== 'file') {
        phase('timeout')
        assert.deepEqual(await lists.read('agent', [], true), [])
      }
      phase('first')
      assert.deepEqual(await lists.read('agent', [], true), model('first'))
      for (const bad of ['fail', 'empty', ...(kind === 'file' ? [] : ['timeout'])]) {
        phase(bad)
        assert.deepEqual(await lists.read('agent', [], true), model('first'))
      }
      phase('second')
      assert.deepEqual(await lists.read('agent', [], true), model('second'))
      assert.equal(notifications, 2)
      if (kind !== 'file') {
        const methods = fs.readFileSync(log, 'utf8').trim().split('\n')
        assert.ok(methods.every(method => ['models', 'initialize', 'session/new'].includes(method)))
      }
    } finally {
      stop()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
