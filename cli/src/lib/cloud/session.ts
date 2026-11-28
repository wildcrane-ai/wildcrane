// The Cloud sign-in, held on the machine.
//
// One file, in the user's own home directory and outside every repository, so the board UI
// server the app starts and an `akb` typed in a terminal act as the same account without a
// second sign-in (#326). It is a fact about the machine, not about a board: the app's
// Electron `settings.json` cannot serve — `akb` has no access to it and it is documented as
// hand-editable and holding nothing secret — and Electron's `safeStorage` would bind the
// session to the app alone, which #319 needs it not to be.
//
// Only one process may refresh at a time. Two racing refreshes would each spend the one
// refresh token, and the loser would be signed out for good — so a refresh takes the lock
// beside the file, and a process that finds the file already moved on takes what is there
// rather than refreshing again.

import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

import { machineHome } from '../machine/home'
import { cloudEndpoints } from './config'

/** What a signed-in machine holds. Nothing here decides anything: admission is the
 *  service's answer, asked for every time (see account.ts). The profile fields are a copy
 *  of what the service last attested, kept only so a terminal can name the account offline. */
export interface CloudSession {
  version: 1
  /** The project this session belongs to. A session from another project is not ours. */
  supabaseUrl: string
  accessToken: string
  refreshToken: string
  /** When the access token runs out, in milliseconds. */
  expiresAt: number
  /** The Supabase user id — the subject every row's owner is keyed on. */
  subject: string
  email?: string
  handle?: string
  name?: string
  avatarUrl?: string
  /** The picture itself, as a `data:` URL, keyed on the address it came from (avatar.ts).
   *  Kept so no screen fetches from the provider to draw the account. */
  avatar?: { url: string; data: string }
}

/** Refresh this long before the token actually runs out, so a request never carries one
 *  that expires in flight. */
const REFRESH_MARGIN_MS = 60_000
/** Fallback age for a lock without a readable owner. */
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 20_000
const LOCK_RETRY_MS = 50
const REFRESH_TIMEOUT_MS = 15_000
const REFRESH_BACKOFF_MS = 60_000

export const sessionFile = (home = machineHome()): string => path.join(home, 'session.json')
const retryFile = (home: string): string => path.join(home, 'session-refresh.json')
interface RefreshRetry { key: string; until: number; attempt: number; error: string; source?: 'cloud' }
let transportRetry: (RefreshRetry & { file: string }) | undefined
const refreshKey = (session: CloudSession) => createHash('sha256')
  .update(JSON.stringify([cloudEndpoints().api, session.subject, session.refreshToken])).digest('hex')

function readRetry(home: string, session: CloudSession): RefreshRetry | undefined {
  try {
    const retry = JSON.parse(fs.readFileSync(retryFile(home), 'utf8')) as RefreshRetry
    // Older processes write local connection failures to this shared file.
    if (!retry.source && ['fetch failed', 'The operation was aborted due to timeout'].includes(retry.error)) return
    if (retry.key === refreshKey(session) && Number.isFinite(retry.until)
        && Number.isInteger(retry.attempt) && retry.attempt > 0 && typeof retry.error === 'string') return retry
  } catch {}
}

function readTransportRetry(home: string, session: CloudSession): RefreshRetry | undefined {
  if (transportRetry?.file === retryFile(home) && transportRetry.key === refreshKey(session)) return transportRetry
}

function deferRefresh(home: string, session: CloudSession, error: string, { after, transport = false }: { after?: string | null; transport?: boolean } = {}): TokenResult {
  const current = readSession(home)
  if (current?.subject === session.subject && current.refreshToken === session.refreshToken) {
    const previous = transport ? readTransportRetry(home, session) : readRetry(home, session)
    const attempt = Math.min((previous?.attempt ?? 0) + 1, 4)
    const seconds = after?.trim() ? Number(after) : NaN
    const serverDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(after ?? '') - Date.now()
    const backoff = (transport ? 5_000 : REFRESH_BACKOFF_MS) * 2 ** (attempt - 1)
    const delay = Math.max(Math.min(backoff, transport ? 30_000 : 300_000), Number.isFinite(serverDelay) ? serverDelay : 0)
    const retry: RefreshRetry = { key: refreshKey(session), until: Date.now() + delay, attempt, error }
    const file = retryFile(home)
    if (transport) transportRetry = { ...retry, file }
    else {
      const temporary = `${file}.${process.pid}.tmp`
      fs.writeFileSync(temporary, JSON.stringify({ ...retry, source: 'cloud' }), { mode: 0o600 })
      fs.renameSync(temporary, file)
    }
  }
  return { ok: false, reason: 'unreachable', error }
}

/** The session on this machine, or null when nobody is signed in. Unreadable or damaged
 *  reads as signed out: a half-written file is not a session, and refusing to draw the
 *  screen over one would leave no way to sign in again. */
export function readSession(home = machineHome()): CloudSession | null {
  let raw: string
  try {
    raw = fs.readFileSync(sessionFile(home), 'utf8')
  } catch {
    return null
  }
  try {
    const held = JSON.parse(raw) as Partial<CloudSession>
    if (!held.accessToken || !held.refreshToken || !held.subject) return null
    if (held.supabaseUrl !== cloudEndpoints().supabaseUrl) return null
    return { ...held, version: 1, expiresAt: Number(held.expiresAt) || 0 } as CloudSession
  } catch {
    return null
  }
}

/** Write it, readable by its owner alone. Through a temporary file, so a reader never sees
 *  half of one. */
export function writeSession(session: CloudSession, home = machineHome()): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const tmp = `${sessionFile(home)}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, sessionFile(home))
  if (!expiringSoon(session) || !readRetry(home, session)) fs.rmSync(retryFile(home), { force: true })
  if (transportRetry?.file === retryFile(home) && (!expiringSoon(session) || !readTransportRetry(home, session))) transportRetry = undefined
}

/** Forget the sign-in. This machine stops reaching Cloud; nothing on any board is touched. */
export function clearSession(): void {
  const home = machineHome()
  if (transportRetry?.file === retryFile(home)) transportRetry = undefined
  try {
    fs.rmSync(sessionFile(home))
    fs.rmSync(retryFile(home), { force: true })
  } catch {
    // Already gone — signing out twice is not a failure.
  }
}

/** What a caller gets when it asks for a token to send. The three are kept apart because a
 *  screen answers each of them differently: sign in, sign in AGAIN, or wait — a laptop off
 *  the network must never be told its sign-in ended. */
export type TokenResult =
  | { ok: true; token: string; session: CloudSession }
  | { ok: false; reason: 'signed-out' }
  | { ok: false; reason: 'expired'; error?: string }
  | { ok: false; reason: 'unreachable'; error: string }

export const CLOUD_ACCESS_HINTS = {
  'signed-out': 'Not signed in to WildCrane Cloud. Sign in from Configuration → Cloud in the WildCrane app, then try again.',
  expired: 'Your WildCrane Cloud sign-in has expired. Sign in again from Configuration → Cloud in the WildCrane app, then try again.',
  unreachable: 'Could not reach WildCrane Cloud. Check your connection and try again.',
}

/**
 * A token good to send right now, refreshing it first when it is about to run out.
 *
 * Cloud responses share a cooldown across processes. A transport failure only delays its caller.
 */
export async function accessToken({ retryTransport = false, home = machineHome() }: { retryTransport?: boolean; home?: string } = {}): Promise<TokenResult> {
  const held = readSession(home)
  if (!held) return { ok: false, reason: 'signed-out' }
  if (!expiringSoon(held)) return { ok: true, token: held.accessToken, session: held }
  return refresh(home, retryTransport)
}

const expiringSoon = (session: CloudSession): boolean =>
  session.expiresAt - REFRESH_MARGIN_MS <= Date.now()

/**
 * Trade the refresh token for a new pair, under the lock beside the file.
 *
 * Whoever gets the lock re-reads the file first — that re-read is the whole point. Another
 * process may have refreshed while we waited, and its answer is as good as one of our own;
 * taking it is what keeps two readers from spending the same refresh token and signing the
 * user out between them.
 */
async function refresh(home: string, retryTransport: boolean): Promise<TokenResult> {
  const lock = await takeLock(home)
  if (!lock) return { ok: false, reason: 'unreachable', error: 'Cloud sign-in refresh is busy. Try again shortly.' }
  try {
    const now = readSession(home)
    if (!now) return { ok: false, reason: 'signed-out' }
    if (!expiringSoon(now)) return { ok: true, token: now.accessToken, session: now }
    const retry = readRetry(home, now)
    if (retry && retry.until > Date.now()) return { ok: false, reason: 'unreachable', error: retry.error }
    const localRetry = retryTransport ? undefined : readTransportRetry(home, now)
    if (localRetry && localRetry.until > Date.now()) return { ok: false, reason: 'unreachable', error: localRetry.error }
    const { api, anonKey } = cloudEndpoints()
    let response: Response
    try {
      // Through Cloud's relay, so a refresh works where supabase.co is blocked (#632).
      response = await fetch(`${api}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: now.refreshToken }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      })
    } catch (e) {
      // Unreachable is not expired. The file is left exactly as it is, so the sign-in is
      // still there when the network comes back.
      return deferRefresh(home, now, e instanceof Error ? e.message : String(e), { transport: true })
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error_description?: string; msg?: string; message?: string } | null
      const error = body?.error_description ?? body?.msg ?? body?.message
      if (![400, 401, 403].includes(response.status)) return deferRefresh(home, now, error ?? `Cloud answered ${response.status}`, { after: response.headers.get('retry-after') })
      return { ok: false, reason: 'expired', error }
    }
    const fresh = sessionFrom(await response.json().catch(() => null), now)
    if (!fresh) return deferRefresh(home, now, 'Cloud returned an invalid sign-in refresh response.')
    // 退出或换账号期间返回的刷新结果不能复活旧会话。
    const current = readSession(home)
    if (!current || current.subject !== now.subject) return { ok: false, reason: 'expired' }
    if (current.refreshToken !== now.refreshToken) return { ok: true, token: current.accessToken, session: current }
    writeSession(fresh, home)
    return { ok: true, token: fresh.accessToken, session: fresh }
  } finally {
    lock()
  }
}

/** A Supabase token response, turned into the session we hold. Keeps the profile the
 *  previous one carried, since a refresh answers with tokens and not with a profile. */
export function sessionFrom(body: unknown, previous?: CloudSession | null): CloudSession | null {
  if (!body || typeof body !== 'object') return null
  const token = body as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    expires_at?: number
    user?: { id?: string; email?: string }
  }
  const subject = token.user?.id ?? previous?.subject
  if (!token.access_token || !token.refresh_token || !subject) return null
  const expiresAt = token.expires_at
    ? token.expires_at * 1000
    : Date.now() + (token.expires_in ?? 3600) * 1000
  return {
    version: 1,
    supabaseUrl: cloudEndpoints().supabaseUrl,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt,
    subject,
    email: token.user?.email ?? previous?.email,
    handle: previous?.handle,
    name: previous?.name,
    avatarUrl: previous?.avatarUrl,
    avatar: previous?.avatar,
  }
}

// --- the lock -----------------------------------------------------------------
// A directory, because making one is atomic on every filesystem we run on, and the holder's
// pid inside it so a waiter can tell a live refresh from one a killed process left behind.
// The board's own lock (lib/lock.ts) cannot serve: it is per board and it blocks the event
// loop while it waits, and a refresh is a network call the whole board server waits on.

/** Never refresh without the lock: a concurrent request can revoke a rotated token. */
async function takeLock(home: string): Promise<(() => void) | null> {
  const dir = path.join(home, 'session.lock')
  const owner = path.join(dir, 'owner')
  const until = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 })
      fs.mkdirSync(dir)
      try {
        fs.writeFileSync(owner, `${process.pid}\n`)
      } catch {
        // A lock naming nobody is what the age rule below is for.
      }
      return () => {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch {
          // Somebody judged us dead and took it — theirs to release now.
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      if (stale(dir, owner)) {
        fs.rmSync(dir, { recursive: true, force: true })
        continue
      }
      if (Date.now() > until) return null
      await sleep(LOCK_RETRY_MS)
    }
  }
}

function stale(dir: string, owner: string): boolean {
  let held: number | undefined
  try {
    const pid = Number(fs.readFileSync(owner, 'utf8').trim())
    held = Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    held = undefined
  }
  if (held !== undefined) return !alive(held)
  try {
    return Date.now() - fs.statSync(dir).mtimeMs > LOCK_STALE_MS
  } catch {
    return false
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
