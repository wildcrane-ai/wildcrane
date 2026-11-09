import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { runnerHome } from './home'
import { provenNewer } from './launcher'
import { VERSION } from './protocol'
import { openBrowser } from './settings-browser'
import { compare, versionDir } from './update'
import page from './settings.html'
import client from 'virtual:settings-client'

export interface SettingsContext { path?: string; project?: string }
export type SettingsAction = (action: string, body: Record<string, unknown>, context: SettingsContext) => Promise<unknown>
interface RecordFile { port: number; secret: string; pid: number }
const recordFile = () => path.join(runnerHome(), 'settings-page.json')
/** Tickets and sessions, so a page restarted on the same port keeps its open tabs. */
const sessionsFile = () => path.join(runnerHome(), 'settings-sessions.json')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const random = () => crypto.randomBytes(32).toString('hex')
/** A page started from a newer Runner's folder is that version. */
const PAGE_VERSION = process.env.WILDCRANE_SETTINGS_VERSION ?? VERSION
let own: { port: number; close(): Promise<void> } | null = null
/** 由本机更新的 Runner 提供设置页时，随宿主存活的子进程。 */
let helper: ChildProcess | null = null
/** What the page this process owns runs, followed to each newer Runner. */
let served: { version: string; port: number; action: SettingsAction } | null = null
let follower: ReturnType<typeof setInterval> | null = null
let swapping = false
let refused: string | null = null

async function control(record: RecordFile, action: string, body = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${record.port}/control/${action}`, {
    method: 'POST', headers: { authorization: `Bearer ${record.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
  })
}

function discover(): RecordFile | null {
  try { return JSON.parse(fs.readFileSync(recordFile(), 'utf8')) as RecordFile } catch { return null }
}

/** 同一配置目录只建一个服务；发现记录永远不传给网页。 */
export async function openSettings(action: SettingsAction, context: SettingsContext = {}, open = true): Promise<{ url: string; opened: boolean }> {
  if (process.env.WILDCRANE_JOB) throw new Error('nested_session')
  fs.mkdirSync(runnerHome(), { recursive: true, mode: 0o700 })
  const lock = `${recordFile()}.lock`
  for (let attempt = 0; attempt < 100; attempt++) {
    const held = discover()
    if (held) {
      try {
        const result = await control(held, 'open', context)
        if (result.ok) {
          const entry = await result.json() as { url: string }
          return { ...entry, opened: open ? await openBrowser(entry.url) : false }
        }
      } catch {}
    }
    if (attempt === 0 && await startNewer(action)) continue
    try {
      const fd = fs.openSync(lock, 'wx', 0o600)
      fs.writeFileSync(fd, String(process.pid))
      fs.closeSync(fd)
    } catch {
      try {
        const pid = Number(fs.readFileSync(lock, 'utf8'))
        try { process.kill(pid, 0) } catch { fs.rmSync(lock, { force: true }) }
      } catch {}
      await sleep(50)
      continue
    }
    try {
      // 锁内再次发现，避免同时启动者覆盖服务记录。
      const current = discover()
      if (current) {
        try { if ((await control(current, 'ping')).ok) continue } catch {}
      }
      own = await startSettingsServer(action, Number(process.env.WILDCRANE_SETTINGS_PORT) || 0)
      follow({ version: PAGE_VERSION, port: own.port, action })
    } finally { fs.rmSync(lock, { force: true }) }
  }
  throw new Error('settings_unavailable')
}

/** The newest Runner that ran here and carries a settings page, when newer than this one. */
const newerPage = () => {
  const version = process.env.WILDCRANE_SETTINGS_CHILD ? null : provenNewer(VERSION)
  return version && fs.existsSync(path.join(versionDir(version), 'dist', 'settings.mjs')) ? version : null
}

/** 本机已运行过更新的 Runner 且它带设置页时，由它提供；旧版或启动失败时用自带的。 */
async function startNewer(action: SettingsAction, port = 0): Promise<boolean> {
  const version = helper ? null : newerPage()
  if (!version || version === refused) return false
  const entry = path.join(versionDir(version), 'dist', 'settings.mjs')
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, WILDCRANE_SETTINGS_CHILD: '1', WILDCRANE_SETTINGS_VERSION: version, WILDCRANE_SETTINGS_PORT: String(port) } })
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000)
    child.once('message', (m: { type?: string }) => { clearTimeout(timer); resolve(m?.type === 'settings-ready') })
    child.once('exit', () => { clearTimeout(timer); resolve(false) })
    child.once('error', () => { clearTimeout(timer); resolve(false) })
  })
  if (ready && child.exitCode === null) {
    helper = child
    child.once('exit', () => { if (helper === child) helper = null })
    follow({ version, port: discover()?.port ?? port, action })
  } else { child.kill(); refused = version }
  return ready
}

/** The owner swaps its page to each newer Runner on the same port, so open tabs carry on. */
function follow(next: typeof served): void {
  served = next
  if (follower || process.env.WILDCRANE_SETTINGS_CHILD) return
  follower = setInterval(() => void followNewest(), 5000)
  follower.unref()
}

export async function followNewest(): Promise<void> {
  const version = newerPage()
  if (!served || swapping || !version || version === refused || compare(version, served.version) <= 0) return
  swapping = true
  const { port, action } = served
  try {
    await stopPage()
    if (!await startNewer(action, port)) {
      own = await startSettingsServer(action, port)
      served = { version: PAGE_VERSION, port: own.port, action }
    }
  } finally { swapping = false }
}

export const ownsSettings = () => own !== null || helper !== null

async function stopPage(): Promise<void> {
  await own?.close(); own = null
  const child = helper
  helper = null
  if (!child || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.disconnect()
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))])
  if (child.exitCode === null) child.kill()
}

export async function closeSettings(): Promise<void> {
  if (follower) clearInterval(follower)
  follower = null; served = null; refused = null
  await stopPage()
}

export async function startSettingsServer(action: SettingsAction, port = 0) {
  const secret = random()
  const tickets = new Map<string, { context: SettingsContext; until: number }>()
  const sessions = new Map<string, { browser: string; context: SettingsContext; until: number }>()
  try {
    const held = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8')) as { tickets?: [string, never][]; sessions?: [string, never][] }
    for (const [key, value] of held.tickets ?? []) tickets.set(key, value)
    for (const [key, value] of held.sessions ?? []) sessions.set(key, value)
  } catch {}
  const keep = () => {
    for (const map of [tickets, sessions]) for (const [key, value] of map) if (value.until < Date.now()) map.delete(key)
    const tmp = `${sessionsFile()}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ tickets: [...tickets], sessions: [...sessions] }), { mode: 0o600 })
    fs.renameSync(tmp, sessionsFile())
  }
  let origin = ''
  let record: RecordFile
  const json = (res: http.ServerResponse, code: number, value: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value))
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-settings-version', PAGE_VERSION)
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    if (req.headers.host !== origin.slice(7) || (req.headers.origin && req.headers.origin !== origin)
      || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))) return json(res, 403, { error: 'forbidden' })
    const route = req.url
    try {
      if (req.method === 'GET' && (route === '/' || route === '/settings-client.js')) {
        res.writeHead(200, { 'content-type': route === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' })
        return void res.end(route === '/' ? page : client)
      }
      if (req.method !== 'POST') return json(res, 404, { error: 'not_found' })
      let raw = ''
      for await (const data of req) { raw += data; if (raw.length > 16_384) return json(res, 413, { error: 'too_large' }) }
      const body = JSON.parse(raw || '{}') as Record<string, unknown>
      if (route === '/control/ping' || route === '/control/open') {
        if (req.headers.authorization !== `Bearer ${secret}`) return json(res, 403, { error: 'forbidden' })
        if (route === '/control/ping') return json(res, 200, { ready: true })
        const ticket = random()
        tickets.set(ticket, { context: { path: typeof body.path === 'string' ? body.path : undefined, project: typeof body.project === 'string' ? body.project : undefined }, until: Date.now() + 12 * 3600_000 })
        keep()
        return json(res, 200, { url: `${origin}/#${ticket}` })
      }
      if (req.headers.origin !== origin) return json(res, 403, { error: 'forbidden' })
      if (route === '/session') {
        // Reusable until it expires: a copied link must still open after the browser already did.
        const entry = tickets.get(String(body.ticket))
        if (!entry || entry.until < Date.now()) return json(res, 403, { error: 'expired' })
        const browser = /(?:^|;\s*)wc_settings=([a-f0-9]{64})/.exec(req.headers.cookie ?? '')?.[1] ?? random()
        const csrf = random()
        sessions.set(csrf, { browser, context: entry.context, until: Date.now() + 12 * 3600_000 })
        keep()
        res.setHeader('set-cookie', `wc_settings=${browser}; HttpOnly; SameSite=Strict; Path=/`)
        return json(res, 200, { csrf })
      }
      const cookie = /(?:^|;\s*)wc_settings=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1]
      const session = sessions.get(String(req.headers['x-settings-csrf'] ?? ''))
      if (!session || session.until < Date.now() || cookie !== session.browser) return json(res, 403, { error: 'expired' })
      const name = /^\/api\/([a-zA-Z]+)$/.exec(route ?? '')?.[1]
      if (!name) return json(res, 404, { error: 'not_found' })
      return json(res, 200, await action(name, body, session.context))
    } catch { return json(res, 500, { error: 'failed' }) }
  })
  const listen = (at: number) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(at, '127.0.0.1', resolve) })
  await listen(port).catch(() => listen(0))
  const bound = (server.address() as { port: number }).port
  origin = `http://127.0.0.1:${bound}`
  record = { port: bound, secret, pid: process.pid }
  const tmp = `${recordFile()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 })
  fs.renameSync(tmp, recordFile())
  return {
    origin,
    port: bound,
    async close() {
      if (discover()?.secret === secret) fs.rmSync(recordFile(), { force: true })
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
