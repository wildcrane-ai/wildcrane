import assert from 'node:assert/strict'
import { test } from 'node:test'
import { previewBridge } from '../src/preview-bridge'

test('preview bridge scopes and serializes synchronization, preserving upload failures', async () => {
  let active = 0
  const calls: string[] = []
  const bridge = await previewBridge(async (agent, fields) => {
    assert.equal(active++, 0)
    calls.push(`${agent}:${fields.operation}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    active--
    return fields.operation === 'submit' ? { ok: false, error: 'Upload is pending.' } : { ok: true, value: { saved: true } }
  })
  const { url, token } = JSON.parse(bridge.env)
  const send = (fields: object, credential = token) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(fields) })
  try {
    assert.equal((await send({ agent: 'designer', operation: 'submit' }, 'other-run')).status, 403)
    assert.equal((await send({ agent: '../designer', operation: 'submit' })).status, 400)
    const responses = await Promise.all([send({ agent: 'designer', operation: 'select' }), send({ agent: 'designer', operation: 'submit' })])
    assert.deepEqual(calls, ['designer:select', 'designer:submit'])
    assert.deepEqual(await responses[1].json(), { ok: false, error: 'Upload is pending.' })
  } finally { bridge.close() }
})
