import assert from 'node:assert/strict'
import http from 'node:http'
import { describe, it } from 'node:test'

import { signIn } from '../src/signin'

function rawRequest(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

describe('local sign-in server', () => {
  it('rejects untrusted Host, Origin, Sec-Fetch-Site, and invalid OAuth state', async () => {
    const controller = new AbortController()
    let baseUrl = ''
    const wait = signIn({
      noBrowser: true,
      signal: controller.signal,
      onUrl: (u) => { baseUrl = u },
    })
    while (!baseUrl) await new Promise((r) => setTimeout(r, 10))

    assert.equal(await rawRequest(baseUrl, { host: 'evil.example:1234' }), 403)
    assert.equal(await rawRequest(baseUrl, { origin: 'https://evil.example' }), 403)
    assert.equal(await rawRequest(baseUrl, { 'sec-fetch-site': 'cross-site' }), 403)

    const badPostOrigin = await fetch(`${baseUrl}send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com' }),
    })
    assert.equal(badPostOrigin.status, 403)

    const chooseHtml = await (await fetch(baseUrl)).text()
    assert.match(chooseHtml, /state=/)

    const badState = await fetch(`${baseUrl}signed-in?code=abc&state=wrong-state`)
    assert.equal(badState.status, 200)
    const failure = await wait
    assert.deepEqual(failure, { why: 'other', detail: 'invalid oauth state' })
  })
})
