// The Cloud sign-in, held on the machine (#326).
//
// What is asked here: the session file is one machine's and not one board's, a refresh is
// taken by one process at a time and the loser takes what the winner wrote, and the four
// states the Configuration dialog draws are the four this reports.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { readCloudAccount, signOutOfCloud } from '../src/lib/cloud/account.ts'
import { restoreMachineHome } from './helpers/board.ts'
import {
  accessToken,
  clearSession,
  readSession,
  sessionFile,
  writeSession,
  type CloudSession,
} from '../src/lib/cloud/session.ts'

const SUPABASE = 'https://project.supabase.co'
const API = 'https://api.example.test'
const SUBJECT = '11111111-1111-4111-8111-111111111111'

let home = ''
const realFetch = globalThis.fetch
/** Every request the module made, in order. */
let calls: string[] = []

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-cloud-'))
  process.env.AI4KANBAN_HOME = home
  process.env.AI4KANBAN_SUPABASE_URL = SUPABASE
  process.env.AI4KANBAN_SUPABASE_ANON_KEY = 'anon-key'
  process.env.AI4KANBAN_CLOUD_URL = API
  calls = []
})

afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(home, { recursive: true, force: true })
  restoreMachineHome()
  delete process.env.AI4KANBAN_SUPABASE_URL
  delete process.env.AI4KANBAN_SUPABASE_ANON_KEY
  delete process.env.AI4KANBAN_CLOUD_URL
})

const session = (over: Partial<CloudSession> = {}): CloudSession => ({
  version: 1,
  supabaseUrl: SUPABASE,
  accessToken: 'token-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 60 * 60 * 1000,
  subject: SUBJECT,
  handle: 'neverchanje',
  name: 'Tao Wu',
  ...over,
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('the session file', () => {
  it('is nobody until a sign-in writes one', () => {
    assert.equal(readSession(), null)
  })

  it('lives outside every repository, readable by its owner alone', () => {
    writeSession(session())

    assert.equal(path.dirname(sessionFile()), home)
    assert.equal(fs.statSync(sessionFile()).mode & 0o777, 0o600)
    assert.equal(readSession()?.handle, 'neverchanje')
  })

  it('ignores a session written against another Cloud project', () => {
    writeSession(session())
    process.env.AI4KANBAN_SUPABASE_URL = 'https://elsewhere.supabase.co'

    assert.equal(readSession(), null)
  })

  it('reads a damaged file as signed out rather than refusing to draw', () => {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(sessionFile(), '{ half a file')

    assert.equal(readSession(), null)
  })

  it('is forgotten by signing out, twice over without complaint', () => {
    writeSession(session())
    clearSession()
    clearSession()

    assert.equal(readSession(), null)
  })
})

describe('the token a request carries', () => {
  it('says signed out when there is no session', async () => {
    assert.deepEqual(await accessToken(), { ok: false, reason: 'signed-out' })
  })

  it('hands back the held token while it is still good', async () => {
    writeSession(session())
    globalThis.fetch = async () => {
      throw new Error('nothing should be fetched')
    }

    const token = await accessToken()

    assert.equal(token.ok && token.token, 'token-1')
  })

  it('refreshes one about to run out, and keeps the pair it is given', async () => {
    writeSession(session({ expiresAt: Date.now() + 5_000 }))
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return jsonResponse({ access_token: 'token-2', refresh_token: 'refresh-2', expires_in: 3600 })
    }

    const token = await accessToken()

    assert.equal(token.ok && token.token, 'token-2')
    assert.equal(readSession()?.refreshToken, 'refresh-2')
    assert.equal(calls.length, 1)
    assert.equal(calls[0], `${API}/auth/v1/token?grant_type=refresh_token`)
  })

  it('退出后迟到的刷新不能恢复旧会话', async () => {
    writeSession(session({ expiresAt: Date.now() + 5_000 }))
    globalThis.fetch = async () => {
      clearSession()
      return jsonResponse({ access_token: 'late', refresh_token: 'late-refresh', expires_in: 3600 })
    }
    assert.equal((await accessToken()).ok, false)
    assert.equal(readSession(), null)
  })

  it('换账号后迟到的刷新不能覆盖新账号', async () => {
    writeSession(session({ expiresAt: Date.now() + 5_000 }))
    globalThis.fetch = async () => {
      writeSession(session({ subject: 'another-account', accessToken: 'new-account' }))
      return jsonResponse({ access_token: 'late', refresh_token: 'late-refresh', expires_in: 3600 })
    }
    assert.equal((await accessToken()).ok, false)
    assert.equal(readSession()?.subject, 'another-account')
  })

  it('leaves one working session when two readers refresh at once', async () => {
    writeSession(session({ expiresAt: Date.now() + 5_000 }))
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      // Slow enough that the second reader is certainly waiting on the lock.
      await new Promise((resolve) => setTimeout(resolve, 40))
      return jsonResponse({
        access_token: `token-${calls.length + 1}`,
        refresh_token: `refresh-${calls.length + 1}`,
        expires_in: 3600,
      })
    }

    const [first, second] = await Promise.all([accessToken(), accessToken()])

    // One refresh between them: the loser found the file already moved on and took it.
    assert.equal(calls.length, 1)
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(first.ok && second.ok && first.token, second.ok ? second.token : '')
    assert.equal(readSession()?.accessToken, first.ok ? first.token : '')
  })

  it('reports an expired sign-in rather than throwing into a running delivery', async () => {
    writeSession(session({ expiresAt: Date.now() + 5_000 }))
    globalThis.fetch = async () =>
      jsonResponse({ error: 'invalid_grant', error_description: 'Refresh token not found' }, 400)

    const token = await accessToken()

    assert.deepEqual(token, {
      ok: false,
      reason: 'expired',
      error: 'Refresh token not found',
    })
    // The file is left alone, so nothing else on the machine is signed out by this.
    assert.equal(readSession()?.refreshToken, 'refresh-1')
  })

  it('does not call a laptop off the network signed out', async () => {
    writeSession(session({ expiresAt: Date.now() + 5_000 }))
    globalThis.fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }

    const token = await accessToken()

    assert.equal(token.ok, false)
    assert.equal(token.ok ? '' : token.reason, 'unreachable')
    assert.equal(readSession()?.refreshToken, 'refresh-1')
  })

  it('allows an explicit retry after a transport failure', async () => {
    writeSession(session({ expiresAt: Date.now() - 1 }))
    globalThis.fetch = async (url) => { calls.push(String(url)); throw new TypeError('fetch failed') }
    assert.equal((await accessToken()).ok, false)
    assert.equal((await accessToken()).ok, false)
    assert.equal(calls.length, 1)
    assert.equal(fs.existsSync(path.join(home, 'session-refresh.json')), false)

    globalThis.fetch = async () => jsonResponse({ access_token: 'recovered', refresh_token: 'rotated', expires_in: 3600 })
    const result = await accessToken({ retryTransport: true })
    assert.equal(result.ok && result.token, 'recovered')
  })

  it('ignores a transport failure written by an older process', async () => {
    writeSession(session({ expiresAt: Date.now() - 1 }))
    globalThis.fetch = async () => jsonResponse({ msg: 'Slow down' }, 429)
    await accessToken()
    const file = path.join(home, 'session-refresh.json')
    const retry = JSON.parse(fs.readFileSync(file, 'utf8'))
    delete retry.source
    fs.writeFileSync(file, JSON.stringify({ ...retry, error: 'fetch failed' }))

    globalThis.fetch = async () => jsonResponse({ access_token: 'recovered', refresh_token: 'rotated', expires_in: 3600 })
    const result = await accessToken()
    assert.equal(result.ok && result.token, 'recovered')
  })

  it('shares rate-limit cooldown between concurrent callers and keeps the session', async () => {
    writeSession(session({ expiresAt: Date.now() - 1 }))
    globalThis.fetch = async (url, options) => {
      calls.push(String(url))
      assert.ok(options?.signal)
      return jsonResponse({ error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }, 429)
    }
    const results = await Promise.all(Array.from({ length: 6 }, () => accessToken()))
    assert.equal(calls.length, 1)
    for (const result of results) assert.deepEqual(result, { ok: false, reason: 'unreachable', error: 'Request rate limit reached' })
    writeSession({ ...readSession()!, avatar: { url: 'avatar', data: 'updated' } })
    assert.equal((await accessToken()).ok, false)
    assert.equal((await accessToken({ retryTransport: true })).ok, false)
    assert.equal(calls.length, 1, 'profile updates and manual retries must respect the cloud cooldown')
    assert.equal(readSession()?.refreshToken, 'refresh-1')
    assert.equal(fs.statSync(path.join(home, 'session-refresh.json')).mode & 0o777, 0o600)
  })

  for (const after of ['180', new Date(Date.now() + 180_000).toUTCString()]) {
    it(`honors Retry-After ${after} and clears cooldown on a new sign-in`, async () => {
      writeSession(session({ expiresAt: Date.now() - 1 }))
      globalThis.fetch = async () => new Response(JSON.stringify({ msg: 'Slow down' }), { status: 429, headers: { 'retry-after': after } })
      await accessToken()
      const retry = JSON.parse(fs.readFileSync(path.join(home, 'session-refresh.json'), 'utf8'))
      assert.ok(retry.until >= (after === '180' ? Date.now() + 175_000 : Date.parse(after)))
      writeSession(session({ accessToken: 'new-login' }))
      assert.equal((await accessToken()).ok, true)
      assert.equal(fs.existsSync(path.join(home, 'session-refresh.json')), false)
    })
  }

  it('keeps transport failures local and persists cloud cooldown across processes', () => {
    writeSession(session({ expiresAt: Date.now() - 1 }))
    const module = path.join(home, 'session.mjs')
    const built = spawnSync(process.execPath, ['-e', `require('esbuild').buildSync({entryPoints:['src/lib/cloud/session.ts'],outfile:process.argv[1],bundle:true,platform:'node',format:'esm'})`, module], { encoding: 'utf8' })
    assert.equal(built.status, 0, built.stderr)
    const probe = `
      import fs from 'node:fs'; import { pathToFileURL } from 'node:url';
      const {accessToken}=await import(pathToFileURL(process.argv[1]));
      if(process.argv[3]) Date.now=()=>Number(process.argv[3]);
      globalThis.fetch=async()=>{
        fs.appendFileSync(process.env.AI4KANBAN_HOME+'/requests','1');
        if (process.argv[2]==='offline') throw new TypeError('fetch failed');
        return process.argv[2]==='success'
          ? Response.json({access_token:'recovered',refresh_token:'rotated',expires_in:3600})
          : Response.json({msg:'Rate limited'},{status:429});
      };
      console.log(JSON.stringify(await accessToken()));
    `
    const run = (mode: string, now = '') => {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe, module, mode, now], { encoding: 'utf8', env: process.env })
      assert.equal(child.status, 0, child.stderr)
      return JSON.parse(child.stdout)
    }
    assert.equal(run('offline').reason, 'unreachable')
    assert.equal(fs.existsSync(path.join(home, 'session-refresh.json')), false)
    assert.equal(run('limited').reason, 'unreachable')
    assert.equal(run('success').reason, 'unreachable')
    assert.equal(fs.readFileSync(path.join(home, 'requests'), 'utf8'), '11')
    const retry = JSON.parse(fs.readFileSync(path.join(home, 'session-refresh.json'), 'utf8'))
    assert.equal(run('limited', String(retry.until + 1)).reason, 'unreachable')
    const next = JSON.parse(fs.readFileSync(path.join(home, 'session-refresh.json'), 'utf8'))
    assert.ok(next.until >= retry.until + 120_000)
    assert.equal(run('success', String(next.until + 1)).token, 'recovered')
    assert.equal(fs.readFileSync(path.join(home, 'requests'), 'utf8'), '1111')
    assert.equal(readSession()?.refreshToken, 'rotated')
    assert.equal(fs.existsSync(path.join(home, 'session-refresh.json')), false)
  })

  it('does not bypass a live refresh lock when waiting times out', async () => {
    writeSession(session({ expiresAt: Date.now() - 1 }))
    const dir = path.join(home, 'session.lock')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'owner'), String(process.pid))
    fs.utimesSync(dir, new Date(0), new Date(0))
    let fetched = false
    globalThis.fetch = async () => { fetched = true; throw Error('Must not refresh without the lock') }
    const now = Date.now
    let ticks = 0
    Date.now = () => now() + ticks++ * 21_000
    try {
      const result = await accessToken()
      assert.equal(result.ok ? '' : result.reason, 'unreachable')
      assert.equal(fetched, false)
      assert.equal(fs.readFileSync(path.join(dir, 'owner'), 'utf8'), String(process.pid))
    } finally { Date.now = now }
  })

  it('backs off invalid successful auth responses instead of expiring the session', async () => {
    writeSession(session({ expiresAt: Date.now() - 1 }))
    globalThis.fetch = async url => { calls.push(String(url)); return new Response('not json') }
    const result = await accessToken()
    assert.equal(result.ok ? '' : result.reason, 'unreachable')
    await accessToken()
    assert.equal(calls.length, 1)
    assert.equal(readSession()?.refreshToken, 'refresh-1')
  })
})

describe('what the Cloud section draws', () => {
  it('reports nobody when nobody is signed in', async () => {
    const account = await readCloudAccount()

    assert.equal(account.state, 'signed-out')
    assert.equal(account.sessionFile, sessionFile())
    assert.equal(account.configured, true)
  })

  it('reports the admitted account and the handle the provider attests', async () => {
    writeSession(session())
    globalThis.fetch = async () =>
      jsonResponse({
        session: { admitted: true, handle: 'neverchanje', name: 'Tao Wu', account_id: SUBJECT },
      })

    const account = await readCloudAccount()

    assert.equal(account.state, 'signed-in')
    assert.equal(account.handle, 'neverchanje')
    assert.equal(account.message, null)
  })

  it('names the account Cloud refused, in the service’s own words', async () => {
    writeSession(session())
    globalThis.fetch = async () =>
      jsonResponse({
        session: { admitted: false, handle: 'someone-else', account_id: null },
        refusal: { code: 'not_admitted', message: 'Cloud is an invite-only preview…' },
      })

    const account = await readCloudAccount()

    assert.equal(account.state, 'not-admitted')
    assert.equal(account.handle, 'someone-else')
    assert.equal(account.message, 'Cloud is an invite-only preview…')
  })

  it('reports an expired sign-in when the refresh is refused', async () => {
    writeSession(session({ expiresAt: Date.now() + 5_000 }))
    globalThis.fetch = async () =>
      jsonResponse({ error: 'invalid_grant', error_description: 'Refresh token not found' }, 400)

    const account = await readCloudAccount()

    assert.equal(account.state, 'expired')
    // It still knows whose sign-in ended, so the pane can say so.
    assert.equal(account.handle, 'neverchanje')
    // Cloud answered — it refused. Carrying Auth's words in `error` would have both screens
    // say Cloud could not be reached beside a sign-in they have just called expired.
    assert.equal(account.error, undefined)
  })

  it('says Cloud is unreachable without reporting a sign-in that ended', async () => {
    writeSession(session())
    globalThis.fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }

    const account = await readCloudAccount()

    assert.equal(account.state, 'signed-in')
    assert.match(account.error ?? '', /ENOTFOUND/)
  })

  it('says the same when the refresh itself could not be made', async () => {
    writeSession(session({ expiresAt: Date.now() + 5_000 }))
    globalThis.fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }

    const account = await readCloudAccount()

    assert.equal(account.state, 'signed-in')
    assert.equal(account.handle, 'neverchanje')
  })

  it('stops reaching Cloud when the user signs out', async () => {
    writeSession(session())
    signOutOfCloud()

    assert.equal((await readCloudAccount()).state, 'signed-out')
  })
})
