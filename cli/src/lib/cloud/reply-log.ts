import LegacyWebSocket from 'ws'
import { accessToken } from './session'
import { cloudEndpoints } from './config'
import { BoardError } from '../io'
import { SAID } from '../../commands/cloud'

interface Event { seq: number; text: string; kind?: string; data?: Record<string, unknown> | null; at?: string }

/** Reconnect the same reply, continuing after the last delivered sequence. */
export function watchReplyLog(id: string, add: (event: Event) => void, fail: (error: BoardError) => void): () => void {
  let socket: WebSocket | LegacyWebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let ping: ReturnType<typeof setInterval> | undefined
  let closed = false
  let after = -1
  let failures = 0
  const clear = () => {
    clearTimeout(timer)
    clearInterval(ping)
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null
      socket.onerror = () => {}
      if (socket instanceof LegacyWebSocket) socket.terminate()
      else socket.close()
    }
    socket = null
  }
  const stop = () => { closed = true; clear() }
  const refuse = (error: BoardError) => { stop(); fail(error) }
  const retry = () => {
    if (closed) return
    clear()
    if (++failures > 5) return refuse(new BoardError('The reply log connection could not be restored.', { kind: 'follow_disconnected' }))
    timer = setTimeout(() => void open(), Math.min(1000 * 2 ** (failures - 1), 8000))
  }
  const open = async () => {
    const token = await accessToken()
    if (closed) return
    if (!token.ok) return refuse(new BoardError(SAID[token.reason].en, { kind: token.reason.replace('-', '_') }))
    const url = `${cloudEndpoints().api.replace(/^http/, 'ws')}/v1/runner/jobs/${encodeURIComponent(id)}/stream?after=${after}`
    let live: WebSocket | LegacyWebSocket
    try {
      // Runner's global client follows its proxy; Node 18 uses the bundled fallback.
      live = globalThis.WebSocket ? new globalThis.WebSocket(url, ['bearer', token.token])
        : new LegacyWebSocket(url, ['bearer', token.token], { handshakeTimeout: 10_000 })
    }
    catch { return retry() }
    socket = live
    timer = setTimeout(retry, 10_000)
    live.onopen = () => {
      clearTimeout(timer)
      let alive = true
      ping = setInterval(() => {
        if (!alive) return retry()
        alive = false
        live.send('ping')
      }, 10_000)
      live.onmessage = (message: { data: unknown }) => {
        const raw = message.data
        if (String(raw) === 'pong') { alive = true; return }
        let value: { type?: string; events?: Event[] }
        try { value = JSON.parse(String(raw)) } catch { return }
        if (value.type === 'ended') return stop()
        if (value.type !== 'events' || !Array.isArray(value.events)) return
        for (const event of value.events) {
          if (!Number.isSafeInteger(event.seq) || event.seq <= after) continue
          after = event.seq
          failures = 0
          add(event)
        }
      }
    }
    live.onerror = () => retry()
    if (live instanceof LegacyWebSocket) live.on('unexpected-response', (_request, response) => {
      response.resume()
      if ([401, 403, 404].includes(response.statusCode ?? 0)) return refuse(new BoardError('The reply log is no longer accessible.', { kind: response.statusCode === 401 ? 'expired' : 'refused' }))
      retry()
    })
    live.onclose = (event: { reason: string }) => { if (event.reason === 'ended') stop(); else retry() }
  }
  void open()
  return stop
}
