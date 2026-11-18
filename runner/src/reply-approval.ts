import http from 'node:http'
import crypto from 'node:crypto'
import type { Call } from './api'

/** A reply-scoped loopback capability: no account credential enters the agent environment. */
export async function replyApprovalBridge(task: string, number: number, approve: (comment: string | undefined, asked: string | undefined, target: { stage?: string; review_revision: number }) => Promise<Call<unknown>>) {
  const token = crypto.randomBytes(32).toString('hex')
  let serial = Promise.resolve()
  const server = http.createServer((req, res) => {
    const answer = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.method !== 'POST' || req.url !== '/' || req.headers.authorization !== `Bearer ${token}` || req.headers.origin) {
      answer(403, { ok: false, error: 'This reply cannot approve that task.' }); return
    }
    let raw = ''
    req.on('data', (data: Buffer) => { raw += data.toString(); if (raw.length > 16000) req.destroy() })
    req.on('end', () => {
      serial = serial.then(async () => {
        try {
          const body = JSON.parse(raw) as { task?: string; comment?: string; stage?: string; review_revision?: number }
          if (body.task !== task && body.task !== String(number) && !new RegExp(`^[A-Za-z][A-Za-z0-9]{0,9}-${number}$`).test(body.task ?? '')) {
            answer(403, { ok: false, error: 'Only the current task can be approved from this reply.' }); return
          }
          if (body.comment !== undefined && typeof body.comment !== 'string') throw Error('Invalid comment.')
          if (!Number.isSafeInteger(body.review_revision) || body.review_revision! < 0 || body.stage !== undefined && typeof body.stage !== 'string') throw Error('Name the review version you read.')
          answer(200, await approve(body.comment, body.task, { stage: body.stage, review_revision: body.review_revision! }))
        } catch (e) { answer(400, { ok: false, error: e instanceof Error ? e.message : 'Approval failed.' }) }
      })
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as { port: number }
  return { env: JSON.stringify({ url: `http://127.0.0.1:${address.port}/`, token }), close: () => { server.close(); server.closeAllConnections() } }
}
