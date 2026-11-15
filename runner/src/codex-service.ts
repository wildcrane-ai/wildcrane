import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { parse } from 'smol-toml'
import { bounded } from '../../cli/src/lib/shared/conversation'
import { spawnable } from '../../cli/src/lib/agent/spawnable'
import { markEnv, stopMark, type Mark } from '../../cli/src/lib/agent/stop'
import { connect, RpcError, type Message } from '../../cli/src/lib/agent/wire/rpc'
import { obj, str, type Json } from '../../cli/src/lib/agent/wire/json'
import { runnerCwd } from './home'
import { accountGeneration } from './settings-control'

const TIMEOUT = 10_000
interface Peer {
  socket: net.Socket
  cwd: string
  config: Json
  threads: Set<string>
  preparing: Map<string, number>
  pending: Set<Promise<void>>
  wire?: ReturnType<typeof connect>
  service: ReturnType<typeof providerServer>
  closing?: Promise<void>
  lease: string
  settled?: { root: string; execution: string; kept: Json[] }
}

export const CODEX_PROTOCOL = 2
export interface CodexRecord { path: string; token: string; pid: number; instance: string; protocol: number; generation: string; backends: { pid: number; since: number; mark: Mark }[] }
export const codexRecordFile = () => path.join(runnerCwd(), 'codex-service-v2.json')

export async function serveCodex() {
  const token = crypto.randomBytes(32).toString('hex')
  const home = runnerCwd()
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\wildcrane-codex-${token.slice(0, 16)}` : path.join(home, `codex-${process.pid}.sock`)
  const identity: CodexRecord = { path: address, token, pid: process.pid, instance: crypto.randomUUID(), protocol: CODEX_PROTOCOL, generation: accountGeneration(), backends: [] }
  const record = codexRecordFile()
  const publish = () => {
    const temporary = `${record}.${identity.instance}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(identity), { mode: 0o600 })
    fs.renameSync(temporary, record)
  }
  const sockets = new Set<net.Socket>()
  const controls = new Set<net.Socket>()
  const services = new Map<string, ReturnType<typeof providerServer>>()
  let closing = false
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    const lines = createInterface({ input: socket })
    let peer: Peer | undefined
    let failed = false
    const authTimer = setTimeout(() => socket.destroy(), TIMEOUT)
    lines.on('line', line => {
      if (failed) return
      try {
        const msg = JSON.parse(line)
        if (controls.has(socket)) {
          if (msg.method === 'shutdown' && sockets.size === controls.size && ![...services.values()].some(s => s.held())) void close()
        } else if (!peer) {
          if (closing || msg.token !== token) return socket.destroy()
          clearTimeout(authTimer)
          if (msg.control === true) {
            if (msg.protocol !== CODEX_PROTOCOL || msg.generation !== identity.generation) return socket.destroy()
            controls.add(socket)
            socket.write(JSON.stringify(identity) + '\n')
            return
          }
          if (!Array.isArray(msg.argv) || typeof msg.argv[0] !== 'string') return socket.destroy()
          const env = obj(msg.env) as NodeJS.ProcessEnv
          const config = threadConfig(msg.argv, env)
          const provider = Object.fromEntries(Object.entries(config).filter(([key]) => key === 'model_provider' || key.startsWith('model_providers.')))
          // Hash credentials too: endpoint/account changes must never reuse the previous service.
          const key = crypto.createHash('sha256').update(JSON.stringify([msg.argv[0], env.CODEX_HOME ?? '', Object.entries(provider).sort(), providerCredentials(provider, env)])).digest('hex')
          let service = services.get(key)
          if (!service) { service = providerServer(msg.argv[0], provider, env, home, (backend) => { identity.backends.push(backend); publish() }); services.set(key, service) }
          peer = { socket, cwd: str(msg.cwd), config, service, threads: new Set(), preparing: new Map(), pending: new Set(), lease: crypto.randomUUID() }
          service.peers.add(peer)
        } else {
          const p = peer
          const done = p.service.request(p, msg)
          p.pending.add(done)
          void done.finally(() => p.pending.delete(done))
        }
      } catch (e) {
        failed = true
        socket.end(JSON.stringify({ method: 'error', params: { error: { message: e instanceof Error ? e.message : 'Invalid Codex connection.' } } }) + '\n')
      }
    })
    socket.once('close', () => { clearTimeout(authTimer); sockets.delete(socket); controls.delete(socket); if (peer) void peer.service.release(peer) })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address, resolve) })
  if (process.platform !== 'win32') fs.chmodSync(address, 0o600)
  publish()
  let closingWork: Promise<void> | undefined
  let finished!: () => void
  const closed = new Promise<void>(resolve => { finished = resolve })
  const close = (): Promise<void> => closingWork ??= (async () => {
    closing = true
    server.close()
    await Promise.all([...services.values()].map(service => service.close()))
    for (const socket of sockets) socket.destroy()
    if (process.platform !== 'win32') fs.rmSync(address, { force: true })
    try {
      if (JSON.parse(fs.readFileSync(record, 'utf8')).instance === identity.instance) fs.rmSync(record, { force: true })
    } catch {}
    finished()
  })()
  return {
    env: { WILDCRANE_CODEX_SERVER: record, WILDCRANE_CODEX_GENERATION: identity.generation, WILDCRANE_CODEX_PROXY: fileURLToPath(new URL('./codex-proxy.mjs', import.meta.url)) },
    close, closed, idle: () => sockets.size === 0 && ![...services.values()].some(s => s.held()),
  }
}

function providerServer(command: string, provider: Json, environment: NodeJS.ProcessEnv, home: string, remember: (backend: CodexRecord['backends'][number]) => void) {
  const peers = new Set<Peer>()
  const owners = new Map<string, Peer>()
  const active = new Map<string, string>()
  const requests = new Map<string, Peer>()
  const unloading = new Map<string, () => void>()
  const retained = new Map<string, { threads: Set<string>; kept: Json[]; execution: string; peer: Peer; settings: string }>()
  const quarantined = new Set<Peer>()
  let backend = ''
  let child: ChildProcessWithoutNullStreams | undefined
  let rpc: ReturnType<typeof connect> | undefined
  let initializing: Promise<Json> | undefined
  let closing = false
  let exited = Promise.resolve()
  let stopChild: (() => void) | undefined
  const send = (p: Peer, value: unknown) => { if (!p.socket.destroyed) p.socket.write(JSON.stringify(value) + '\n') }
  const claim = (p: Peer, id: string, loaded = true) => {
    if (!id) return
    if (owners.has(id) && owners.get(id) !== p) throw Error('Codex thread is already in use by another run.')
    owners.set(id, p)
    if (loaded) p.threads.add(id)
  }
  // A fork source may be saved but unloaded; reserve it only during preparation.
  const reserve = (p: Peer, id: string) => {
    claim(p, id, false)
    p.preparing.set(id, (p.preparing.get(id) ?? 0) + 1)
    return () => {
      const pending = p.preparing.get(id)! - 1
      if (pending) p.preparing.set(id, pending)
      else {
        p.preparing.delete(id)
        if (!p.threads.has(id) && owners.get(id) === p) owners.delete(id)
      }
    }
  }
  const ensure = (): Promise<Json> => {
    if (closing) return Promise.reject(Error('Runner is stopping.'))
    if (initializing) return initializing
    const env: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: undefined, CODEX_HOME: environment.CODEX_HOME ?? process.env.CODEX_HOME, WILDCRANE_JOB: '1' }
    for (const key of Object.keys(env)) if (/^(KANBAN_|AI4KANBAN_EXECUTION|WILDCRANE_FLOW_WORKER|WILDCRANE_CODEX_)/.test(key)) delete env[key]
    Object.assign(env, providerCredentials(provider, environment))
    backend = crypto.randomUUID()
    const mark = stopMark()
    const start = spawnable(command, ['app-server', '-c', 'thread_unload_delay_secs=0', ...Object.entries(provider).flatMap(([key, value]) => ['-c', `${key}=${tomlValue(value)}`])], { cwd: home, env: markEnv(env, mark), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    const current = child = spawn(start.command, start.args, start.options) as ChildProcessWithoutNullStreams
    const processAt = Date.now()
    const stop = () => {
      current.kill('SIGKILL')
    }
    stopChild = stop
    current.stdin.on('error', () => {})
    // Never mix server-wide diagnostics into another task's log.
    current.stderr.resume()
    exited = new Promise<void>(resolve => current.once('close', resolve))
    const broken = () => {
      if (child !== current) return
      stop()
      child = undefined; rpc = undefined; initializing = undefined
      for (const p of peers) p.socket.destroy()
      retained.clear()
      quarantined.clear()
      owners.clear()
      active.clear()
      requests.clear()
      for (const done of unloading.values()) done()
      unloading.clear()
    }
    current.once('error', broken)
    current.once('exit', broken)
    current.once('close', broken)
    try { if (current.pid) remember({ pid: current.pid, since: processAt, mark }) }
    catch (error) { stop(); throw error }
    const wire = rpc = connect(current.stdout, current.stdin, msg => {
      const params = obj(msg.params)
      const thread = obj(params.thread)
      const id = str(params.threadId) || str(thread.id)
      if (msg.method === 'thread/closed') { unloading.get(id)?.(); unloading.delete(id) }
      if (msg.method === 'turn/started') active.set(id, str(obj(params.turn).id))
      if (msg.method === 'turn/completed') active.delete(id)
      if (msg.method === 'item/completed' && obj(params.item).type === 'commandExecution') {
        for (const [root, group] of retained) {
          group.kept = group.kept.filter(t => t.threadId !== id || t.itemId !== obj(params.item).id)
          if (group.kept.length) continue
          retained.delete(root)
          const p = group.peer
          p.settled = { root, execution: group.execution, kept: [] }
          p.closing = undefined
          for (const thread of group.threads) claim(p, thread)
          void release(p)
        }
      }
      let owner = owners.get(id)
      if (!owner) {
        const parent = str(thread.parentThreadId) || str(thread.forkedFromId)
        owner = owners.get(parent)
        if (owner) claim(owner, id)
      }
      if (owner) {
        if (msg.method === 'thread/started') claim(owner, id)
        const item = obj(params.item)
        if (item.type === 'subAgentActivity' && item.kind === 'started' && str(item.agentThreadId) && !owners.has(str(item.agentThreadId))) claim(owner, str(item.agentThreadId))
        if (item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent') {
          for (const id of (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [])) {
            if (typeof id === 'string' && !owners.has(id)) claim(owner, id)
          }
        }
        if (msg.id !== undefined) requests.set(String(msg.id), owner)
        send(owner, msg)
      } else if (msg.id !== undefined) wire.refuse(msg.id, 'No run owns this request.')
    })
    initializing = bounded(wire.call('initialize', { clientInfo: { name: 'wildcrane', version: '1' }, capabilities: { experimentalApi: true } }), TIMEOUT, 'Codex initialize timed out.')
      .then(result => { wire.notify('initialized'); return result })
    // A failed startup is disposed before another request may start a replacement.
    void initializing.catch(() => { if (child === current) stop() })
    return initializing
  }
  const terminals = async (wire: ReturnType<typeof connect>, threadId: string) => {
    const result: Json[] = []
    const seen = new Set<unknown>()
    let cursor: unknown = null
    do {
      if (seen.has(cursor)) throw Error('Codex repeated a terminal cursor.')
      seen.add(cursor)
      const page = await wire.call('thread/backgroundTerminals/list', { threadId, ...(cursor ? { cursor } : {}) })
      for (const value of Array.isArray(page.data) ? page.data : []) result.push({ ...obj(value), threadId })
      cursor = page.nextCursor
    } while (cursor)
    return result
  }
  const release = (p: Peer): Promise<void> => {
    if (p.closing) return p.closing
    const cleanup = async () => {
      await Promise.allSettled(p.pending)
      const wire = p.wire
      if (wire) {
        for (const [id, owner] of requests) if (owner === p) { wire.refuse(id, 'Run disconnected.'); requests.delete(id) }
        if (p.settled?.kept.length && !closing) {
          retained.set(p.settled.root, { threads: new Set(p.threads), kept: p.settled.kept, execution: p.settled.execution, peer: p, settings: JSON.stringify([p.cwd, p.config]) })
        } else {
          for (const threadId of p.threads) {
            if (owners.get(threadId) !== p || wire !== rpc) continue
            if (!p.settled) {
              const turnId = active.get(threadId)
              if (turnId) await wire.call('turn/interrupt', { threadId, turnId })
              try { await wire.call('thread/backgroundTerminals/clean', { threadId }) }
              catch (e) { if (!(e instanceof RpcError) || e.code !== -32601) throw e }
            }
            const unloaded = new Promise<void>(resolve => unloading.set(threadId, resolve))
            const result = obj(await wire.call('thread/unsubscribe', { threadId }))
            if (result.status === 'unsubscribed') await unloaded
            unloading.delete(threadId)
          }
        }
      }
      for (const id of p.threads) if (owners.get(id) === p) owners.delete(id)
      quarantined.delete(p)
    }
    // Ownership remains reserved until every old RPC finishes, even after caller timeout.
    const work = cleanup()
    p.closing = (async () => {
      try { await bounded(work, TIMEOUT, 'Codex thread cleanup timed out; the thread remains reserved.') }
      catch (e) {
        quarantined.add(p)
        console.error(e instanceof Error ? e.message : String(e))
        send(p, { method: 'wildcrane/cleanup', params: { status: 'unconfirmed', lease: p.lease } })
      }
      peers.delete(p)
      p.socket.end()
    })()
    return p.closing
  }
  const request = async (p: Peer, msg: Message) => {
    if (msg.method === 'wildcrane/release') { void release(p); return }
    if (p.closing || !msg.method) {
      if (msg.id !== undefined && !msg.method) {
        if (requests.get(String(msg.id)) !== p) return
        requests.delete(String(msg.id))
        if (msg.error) rpc?.refuse(msg.id, msg.error.message ?? 'Interaction refused.')
        else rpc?.reply(msg.id, obj(msg.result))
      }
      return
    }
    const id = msg.id
    let releaseSource: (() => void) | undefined
    try {
      const initialized = await ensure()
      p.wire = rpc
      if (msg.method === 'initialize') { send(p, { id, result: { ...initialized, wildcrane: { instance: backend, lease: p.lease } } }); return }
      if (msg.method === 'initialized') return
      const wire = rpc!
      let params = obj(msg.params)
      if (msg.method === 'wildcrane/settled') {
        if (params.instance !== backend || params.lease !== p.lease || !str(params.execution) || owners.get(str(params.threadId)) !== p || params.confirmed !== true) throw Error('Codex cleanup is unconfirmed; the host will perform bounded session recovery.')
        const kept = Array.isArray(params.kept) ? params.kept.map(obj) : []
        await bounded((async () => {
          const actual: Json[] = []
          for (const thread of p.threads) {
            if (active.has(thread)) throw Error('A Codex turn is still active.')
            actual.push(...await terminals(wire, thread))
          }
          const key = (v: Json) => JSON.stringify([v.threadId, v.itemId, v.processId])
          if (new Set(kept.map(key)).size !== kept.length || actual.length !== kept.length || actual.some(t => !kept.some(k => key(k) === key(t)))) throw Error('Codex retained terminal state changed before handoff.')
        })(), TIMEOUT, 'Codex retention verification timed out.')
        if (p.closing || wire !== rpc) throw Error('Codex execution ownership expired.')
        p.settled = { root: str(params.threadId), execution: str(params.execution), kept }
        send(p, { id, result: { confirmed: true, instance: backend, lease: p.lease } })
        return
      }
      let held: { threads: Set<string>; kept: Json[]; execution: string } | undefined
      if (['thread/start', 'thread/resume', 'thread/fork'].includes(msg.method)) {
        if (msg.method !== 'thread/start') {
          const source = str(params.threadId)
          const previous = retained.get(source)
          if (previous && msg.method === 'thread/resume' && previous.settings !== JSON.stringify([p.cwd, p.config])) throw Error('This Codex version cannot change execution settings while retaining a loaded session. Its services and saved results were preserved; no new work was submitted.')
          held = msg.method === 'thread/resume' ? previous : undefined
          if ([...retained.values()].some(group => group.threads.has(source)) && !previous) throw Error('Resume the owning Codex thread to adopt its retained work.')
          if (msg.method === 'thread/resume' || !previous) releaseSource = reserve(p, source)
          if (held) { for (const thread of held.threads) claim(p, thread); retained.delete(source) }
        }
        const cwd = params.cwd ?? p.cwd
        const settings = await wire.call('config/read', { cwd, includeLayers: false })
        const config = { ...p.config, ...obj(params.config), thread_unload_delay_secs: 0 }
        mcpEnvironment(config, obj(obj(settings.config).mcp_servers))
        params = { ...params, cwd, config }
      } else {
        const threadId = str(params.threadId)
        if (!threadId || owners.get(threadId) !== p) throw Error('This run does not own that Codex thread.')
      }
      if (msg.method === 'turn/start') p.settled = undefined
      const result = await wire.call(msg.method, params)
      if (held) result.retainedThreads = [...held.threads].map(id => ({ id }))
      const threadId = str(obj(result.thread).id)
      if (threadId) claim(p, threadId)
      if (id !== undefined) send(p, { id, result })
    } catch (e) {
      if (id !== undefined) send(p, { id, error: { code: e instanceof RpcError ? e.code : -32000, message: e instanceof Error ? e.message : String(e) } })
    } finally {
      releaseSource?.()
    }
  }
  return {
    peers, request, release, held: () => retained.size > 0 || quarantined.size > 0,
    async close() {
      closing = true
      await bounded(Promise.allSettled([...peers].map(release)), TIMEOUT, 'Codex cleanup timed out.').catch(() => {})
      const current = child
      if (current) {
        stopChild?.()
        const timer = setTimeout(() => current.kill('SIGKILL'), 2_000)
        await exited
        clearTimeout(timer)
      }
    },
  }
}

function mcpEnvironment(config: Json, defaults: Json): void {
  const servers = obj(config.mcp_servers)
  const names = new Set([...Object.keys(defaults), ...Object.keys(servers)])
  for (const key of Object.keys(config)) {
    const name = /^mcp_servers\.([^.]+)\./.exec(key)?.[1]
    if (name) names.add(name)
  }
  for (const name of names) {
    const key = `mcp_servers.${name}.env`
    const explicit = Object.fromEntries(Object.entries(config).filter(([k]) => k.startsWith(key + '.')).map(([k, value]) => [k.slice(key.length + 1), value]))
    config[key] = { ...obj(obj(defaults[name]).env), ...obj(obj(servers[name]).env), ...obj(config[key]), ...explicit, ...obj(config['shell_environment_policy.set']) }
  }
}

/** Move command overrides and job-local environment off the shared process. */
export function threadConfig(argv: string[], env: NodeJS.ProcessEnv): Json {
  const config: Json = {}
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--enable' || flag === '--disable') { config[`features.${argv[++i]}`] = flag === '--enable'; continue }
    if (flag !== '-c' && flag !== '--config') throw Error('Unsupported shared Codex option.')
    const pair = argv[++i] ?? ''
    const at = pair.indexOf('=')
    if (at < 1) throw Error('Invalid Codex configuration override.')
    const key = pair.slice(0, at), value = pair.slice(at + 1).trim()
    try { config[key] = parse(`value = ${value}`).value }
    catch { config[key] = value }
  }
  const local = Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined &&
    key !== 'OPENAI_API_KEY' && key !== 'WILDCRANE_FLOW_WORKER' && (process.env[key] !== value || /^(KANBAN_|AI4KANBAN_|WILDCRANE_|PATH$)/.test(key))))
  config['shell_environment_policy.set'] = { ...obj(config['shell_environment_policy.set']), ...local }
  return config
}

function providerCredentials(config: Json, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const credentials: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(config)) if (/^model_providers\..+\.env_key$/.test(key) && typeof value === 'string') {
    if (!env[value]) throw Error('The Codex provider credential is missing.')
    credentials[value] = env[value]
  }
  return credentials
}

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}=${tomlValue(v)}`).join(',')}}`
  return JSON.stringify(value)
}
