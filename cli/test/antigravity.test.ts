import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { createAntigravityRenderer } from '../src/lib/agent/wire/antigravity'
import { ANTIGRAVITY, antigravityModels } from '../src/lib/agent/harnesses/antigravity'

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'test/fixtures/antigravity', name), 'utf8')
const render = (name: string, resume?: string) => {
  const r = createAntigravityRenderer(resume)
  const text = fixture(`${name}.ndjson`)
  let log = ''
  for (let i = 0; i < text.length; i += 13) log += r.push(text.slice(i, i + 13))
  log += r.flush()
  return { r, log }
}
it('reads real agy output, tool progress and per-prompt usage on a resumed session (#687)', () => {
  const { r, log } = render('tool')
  assert.match(log, /run_command pwd/)
  assert.equal(r.model?.(), 'model-from-agy')
  assert.equal(r.failure?.(), undefined)
  assert.equal(r.usage?.()?.input, 28950)
  const calls = r.events?.().filter(e => e.kind === 'tool_call') ?? []
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0]!.data.toolCallId, calls[1]!.data.toolCallId)
  const a = render('first').r
  const b = render('resume', a.resumeId?.()).r
  assert.equal(b.resumeId?.(), a.resumeId?.())
  assert.equal(b.usage?.()?.input, 10691)
  assert.match(b.result()!, /ANTIGRAVITY_OK/)
})
it('rejects soft denial, invalid models, timeouts, missing results and mismatched sessions (#687)', () => {
  for (const name of ['denied', 'invalid', 'timeout', 'signedout']) assert.ok(render(name).r.failure?.(), name)
  const r = createAntigravityRenderer()
  r.push(fixture('first.ndjson').split('\n').filter(l => !l.includes('"event":"result"')).join('\n'))
  r.flush()
  assert.match(r.failure!()!, /final result|最终结果/)
  for (const status of ['ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING']) {
    const r = createAntigravityRenderer()
    r.push(JSON.stringify({ event: 'result', result: { status, response: '' } }) + '\n')
    r.flush()
    assert.ok(r.failure?.(), status)
  }
  const requested = '00000000-0000-0000-0000-000000000687'
  const wrong = render('missing', requested).r
  assert.ok(wrong.failure?.())
  assert.equal(wrong.resumeId?.(), requested)
  const stderr = createAntigravityRenderer()
  stderr.push(fixture('first.ndjson'))
  stderr.stderr?.(fixture('denied.stderr'))
  stderr.flush()
  assert.ok(stderr.failure?.())
})
it('keeps explicit session selection and model errors; parses only actual model rows (#687)', () => {
  assert.throws(() => ANTIGRAVITY.resumeArgs([], 'missing', '/project'), /session not found/)
  for (const flag of ['--continue', '-c', '--conversation=x', '--remote-agent']) assert.throws(() => ANTIGRAVITY.extraArgs([flag], 'new', '/project'))
  assert.deepEqual(antigravityModels('Fetching available models...\nmodel-id\tModel title\n'), [{ id: 'model-id', name: 'Model title' }])
  assert.equal(ANTIGRAVITY.login?.loggedOut('network connection failed'), false)
  assert.equal(ANTIGRAVITY.login?.loggedOut('authentication required'), true)
})
