import http from 'node:http'
import crypto from 'node:crypto'
import type { Call } from './api'

export async function previewBridge(work: (agent: string, fields: Record<string, unknown>) => Promise<Call<unknown>>) {
  const token = crypto.randomBytes(32).toString('hex')
  let serial = Promise.resolve()
  const server = http.createServer((req, res) => {
    const answer = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.method !== 'POST' || req.url !== '/' || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) return answer(403, { ok: false, error: 'Invalid preview execution.' })
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); if (raw.length > 16000) req.destroy() })
    req.on('end', () => {
      serial = serial.then(async () => {
        try {
          const fields = JSON.parse(raw)
          if (typeof fields.agent !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fields.agent)) throw Error('Invalid preview agent.')
          answer(200, await work(fields.agent, fields))
        } catch (error) { answer(400, { ok: false, error: error instanceof Error ? error.message : 'Preview submission failed.' }) }
      })
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { env: JSON.stringify({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, token }), close() { server.close(); server.closeAllConnections() } }
}
