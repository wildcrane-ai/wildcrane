import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, it, type TestContext } from 'node:test'

import { readSession } from '../../cli/src/lib/cloud/session'
import { signIn } from '../src/signin'

const SUPABASE = 'https://supabase.example'
const TOKEN = { access_token: 'access', refresh_token: 'refresh', expires_at: 2_000_000_000, user: { id: 'test-user' } }

async function startSignIn(t: TestContext) {
  const exchanges: { method: string | undefined; url: string | undefined; body: string }[] = []
  const relay = http.createServer(async (req, res) => {
    req.setEncoding('utf8')
    let body = ''
    for await (const chunk of req) body += chunk
    exchanges.push({ method: req.method, url: req.url, body })
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(TOKEN))
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcrane-signin-'))
  const env = process.env
  const controller = new AbortController()
  t.after(() => {
    controller.abort()
    relay.close()
    process.env = env
    fs.rmSync(home, { recursive: true, force: true })
  })
  relay.listen(0, '127.0.0.1')
  await once(relay, 'listening')
  const { port } = relay.address() as AddressInfo
  process.env = {
    ...env,
    WILDCRANE_HOME: home,
    AI4KANBAN_HOME: home,
    AI4KANBAN_SUPABASE_URL: SUPABASE,
    AI4KANBAN_CLOUD_URL: `http://127.0.0.1:${port}`,
  }

  let onUrl!: (url: string) => void
  const url = new Promise<string>((resolve) => { onUrl = resolve })
  const wait = signIn({ noBrowser: true, signal: controller.signal, onUrl })
  const baseUrl = await url
  const page = await fetch(baseUrl)
  assert.equal(page.status, 200)
  const links = Array.from((await page.text()).matchAll(/<a href="([^"]+)"/g), ([, href]) => new URL(href!.replaceAll('&amp;', '&')))
  assert.deepEqual(links.map((link) => link.searchParams.get('provider')).sort(), ['github', 'google'])
  const authorize = (provider: 'github' | 'google') => links.find((link) => link.searchParams.get('provider') === provider)!
  const callback = (provider: 'github' | 'google') => new URL(authorize(provider).searchParams.get('redirect_to')!)
  const assertNoSession = () => {
    assert.deepEqual(exchanges, [])
    assert.equal(fs.existsSync(path.join(home, 'session.json')), false)
  }
  return { baseUrl, authorize, callback, wait, exchanges, assertNoSession }
}

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
  for (const provider of ['github', 'google'] as const) {
    it(`exchanges the ${provider} callback with its PKCE verifier and saves the session`, async (t) => {
      const { baseUrl, authorize, callback, wait, exchanges } = await startSignIn(t)
      const link = authorize(provider)
      const redirect = callback(provider)
      const code = `${provider}-auth-code`
      redirect.searchParams.set('code', code)
      const res = await fetch(redirect, { headers: { 'sec-fetch-site': 'cross-site' } })
      assert.equal(res.status, 200)
      assert.equal(await wait, null)
      assert.match(await res.text(), /Signed in to WildCrane/)

      assert.equal(link.origin + link.pathname, `${SUPABASE}/auth/v1/authorize`)
      assert.equal(link.searchParams.get('scopes'), provider === 'github' ? 'user:email' : null)
      assert.equal(link.searchParams.get('code_challenge_method'), 's256')
      assert.equal(link.searchParams.has('state'), false)
      assert.equal(redirect.origin, new URL(baseUrl).origin)
      assert.equal(redirect.pathname, '/signed-in')
      assert.match(redirect.searchParams.get('state') ?? '', /^[\w-]{32}$/)

      assert.equal(exchanges.length, 1)
      const [exchange] = exchanges
      assert.ok(exchange)
      assert.equal(exchange.method, 'POST')
      assert.equal(exchange.url, '/auth/v1/token?grant_type=pkce')
      const { auth_code, code_verifier } = JSON.parse(exchange.body)
      assert.equal(auth_code, code)
      assert.equal(createHash('sha256').update(code_verifier).digest('base64url'), link.searchParams.get('code_challenge'))
      assert.equal(readSession()?.subject, TOKEN.user.id)
      assert.equal(readSession()?.accessToken, TOKEN.access_token)
      assert.equal(readSession()?.refreshToken, TOKEN.refresh_token)
    })
  }

  for (const [language, copy] of [['en', 'Access was cancelled'], ['zh', '你取消了授权']] as const) {
    it(`shows the ${language} cancellation page when the provider returns access_denied`, async (t) => {
      const { callback, wait, assertNoSession } = await startSignIn(t)
      const redirect = callback('github')
      redirect.searchParams.set('error', 'access_denied')
      redirect.searchParams.set('error_description', 'Consent was declined')
      const res = await fetch(redirect, { headers: { 'accept-language': language, 'sec-fetch-site': 'cross-site' } })
      assert.equal(res.status, 200)
      assert.ok((await res.text()).includes(copy))
      assert.deepEqual(await wait, { why: 'denied', detail: 'Consent was declined' })
      assertNoSession()
    })
  }

  it('shows a failure when Supabase returns an error_code with access_denied', async (t) => {
    const { callback, wait, assertNoSession } = await startSignIn(t)
    const redirect = callback('google')
    redirect.searchParams.set('error', 'access_denied')
    redirect.searchParams.set('error_code', 'signup_disabled')
    const res = await fetch(redirect)
    assert.equal(res.status, 200)
    assert.match(await res.text(), /Something went wrong while signing in/)
    assert.deepEqual(await wait, { why: 'other', detail: 'signup_disabled' })
    assertNoSession()
  })

  it('rejects untrusted Host, Origin and Sec-Fetch-Site before exchanging a code', async (t) => {
    const { baseUrl, callback, assertNoSession } = await startSignIn(t)

    assert.equal(await rawRequest(baseUrl, { host: 'evil.example:1234' }), 403)
    assert.equal(await rawRequest(baseUrl, { origin: 'https://evil.example' }), 403)
    assert.equal(await rawRequest(baseUrl, { 'sec-fetch-site': 'cross-site' }), 403)

    const badPostOrigin = await fetch(`${baseUrl}send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com' }),
    })
    assert.equal(badPostOrigin.status, 403)

    const redirect = callback('github')
    redirect.searchParams.set('code', 'unused')
    assert.equal(await rawRequest(redirect.href, { host: 'evil.example:1234' }), 403)
    assert.equal(await rawRequest(redirect.href, { origin: 'https://evil.example' }), 403)
    assert.equal(await rawRequest(redirect.href, { 'sec-fetch-site': 'same-site' }), 403)
    assertNoSession()
  })

  for (const [name, state] of [['missing', null], ['wrong', '0'.repeat(32)], ['multibyte', '中'.repeat(32)]] as const) {
    it(`rejects a callback with ${name} state`, async (t) => {
      const { callback, wait, assertNoSession } = await startSignIn(t)
      const redirect = callback('github')
      redirect.searchParams.set('code', 'unused')
      if (state === null) redirect.searchParams.delete('state')
      else redirect.searchParams.set('state', state)
      const res = await fetch(redirect)
      assert.equal(res.status, 200)
      assert.match(await res.text(), /Something went wrong while signing in/)
      assert.deepEqual(await wait, { why: 'other', detail: 'invalid oauth state' })
      assertNoSession()
    })
  }
})
