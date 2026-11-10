// The web's "Install locally" link answers only its own Host (#602).

import assert from 'node:assert/strict'
import http from 'node:http'
import { describe, it } from 'node:test'

import { serveSettingsLink } from '../src/settings-link'

const get = (port: number, host: string) =>
  new Promise<http.IncomingMessage>((resolve, reject) =>
    http.get({ host: '127.0.0.1', port, path: '/settings', headers: { host } }, resolve).on('error', reject))

describe('settings link', () => {
  it('redirects to local settings, and refuses a rebound name', async () => {
    const port = 47000 + Math.floor(Math.random() * 800)
    const server = serveSettingsLink(async () => ({ url: 'http://127.0.0.1:1/#ticket' }), port)
    await new Promise((resolve) => server.once('listening', resolve))
    try {
      const ok = await get(port, `127.0.0.1:${port}`)
      assert.equal(ok.statusCode, 302)
      assert.equal(ok.headers.location, 'http://127.0.0.1:1/#ticket')
      assert.equal((await get(port, `evil.example:${port}`)).statusCode, 403)
    } finally {
      server.close()
    }
  })
})
