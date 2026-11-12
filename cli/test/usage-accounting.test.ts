import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { createZcodeClient } from '../src/lib/agent/wire/zcode.ts'
import { it } from 'node:test'
import { createKimiStreamRenderer } from '../src/lib/agent/wire/kimi-stream.ts'
import { ownCost } from '../src/lib/agent/own-cost.ts'
import { createStreamRenderer } from '../src/lib/agent/wire/claude-stream.ts'
import { splitLog, costLine } from '../src/lib/agent/log.ts'

it('Kimi resume counts only new calls across the main and child agents (#689)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-689-'))
  const before = process.env.KIMI_CODE_HOME
  process.env.KIMI_CODE_HOME = dir
  const session = path.join(dir, 'session')
  const wire = (name: string) => path.join(session, 'agents', name, 'wire.jsonl')
  const row = (input: number) => JSON.stringify({ type: 'usage.record', model: 'kimi-test', usage: { inputOther: input, inputCacheRead: 4, output: 2 } }) + '\n'
  try {
    for (const name of ['main', 'child']) { fs.mkdirSync(path.dirname(wire(name)), { recursive: true }); fs.writeFileSync(wire(name), row(100)) }
    fs.writeFileSync(path.join(dir, 'session_index.jsonl'), JSON.stringify({ sessionId: 'saved', sessionDir: session, workDir: dir }) + '\n')
    const renderer = createKimiStreamRenderer(dir, 'saved')
    for (const name of ['main', 'child']) fs.appendFileSync(wire(name), row(10))
    renderer.flush()
    assert.deepEqual(renderer.usage?.(), { input: 20, cacheRead: 8, cacheCreation: 0, output: 4 })
    const again = createKimiStreamRenderer(dir, 'saved')
    again.flush()
    assert.deepEqual(again.usage?.(), { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 })
    assert.equal(renderer.costUsd, undefined)
  } finally { if (before === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = before; fs.rmSync(dir, { recursive: true, force: true }) }
})

it('preserves a reported zero price while missing prices stay unknown (#689)', () => {
  const renderer = createStreamRenderer()
  renderer.push(JSON.stringify({ type: 'result', total_cost_usd: 0 }) + '\n')
  assert.equal(renderer.costUsd?.(), 0)
  assert.equal(ownCost(2, 2), 0)
  assert.equal(ownCost(2, null), undefined)
  assert.equal(splitLog(costLine(0)).costUsd, 0)
})

it('ZCode subtracts session fallback totals but leaves per-turn counts alone (#689)', async () => {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  let reads = 0
  stdin.on('data', chunk => {
    for (const line of String(chunk).trim().split('\n')) {
      const m = JSON.parse(line)
      const result = m.method === 'session/resume' ? { session: { sessionId: 'z', model: { providerId: 'zai', modelId: 'glm' } } }
        : m.method === 'session/usage' ? { inputTokens: ++reads === 1 ? 100 : 125, outputTokens: reads === 1 ? 10 : 15 }
        : {}
      stdout.write(JSON.stringify({ id: m.id, result }) + '\n')
      if (m.method === 'session/send') queueMicrotask(() => stdout.write(JSON.stringify({ method: 'session/event', params: { sessionId: 'z', type: 'turn.completed', payload: { resultType: 'success', response: 'done' } } }) + '\n'))
    }
  })
  const end = await createZcodeClient().turn({ stdout, stdin, cwd: '/tmp', resumeId: 'z', prompt: 'go', log: () => {}, gotModel: () => {}, gotResumeId: () => {} })
  assert.deepEqual(end.usage, { input: 25, cacheRead: 0, cacheCreation: 0, output: 5 })
  assert.equal(end.costUsd, undefined)
})
