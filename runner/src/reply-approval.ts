import http from 'node:http'
import crypto from 'node:crypto'
import type { Call } from './api'
import type { ReviewApproval } from '../../cli/src/lib/shared/review-plan'
import { push, taskAssetsSynced, type TaskFolder } from './task-folder'

export function previewSyncBridge(ws: TaskFolder, job: { id: string; machineId: string }, stopped: () => boolean) {
  return taskBridge(ws.task, ws.number!, async () => {
    const result = await push(ws, job, stopped)
    if (!result.ok) return result
    return taskAssetsSynced(ws) ? { ok: true, value: undefined }
      : { ok: false, error: 'Preview uploads are pending.' }
  })
}

export type ReplyApprovalTarget = Pick<ReviewApproval, 'stage' | 'revision'>

export function replyApprovalBridge(task: string, number: number, targets: readonly ReplyApprovalTarget[],
  approve: (comment: string | undefined, asked: string, target: { stage: string; review_revision: number }) => Promise<Call<unknown>>) {
  return taskBridge(task, number, body => {
    const { task: asked, comment, stage } = body
    if (comment !== undefined && typeof comment !== 'string') throw Error('Invalid comment.')
    if (stage !== undefined && (typeof stage !== 'string' || !stage.trim())) throw Error('Specify a review stage.')
    if (stage === undefined && targets.length > 1) throw Error('Specify a review stage with --stage.')
    const target = stage === undefined ? targets[0] : targets.find(approval => approval.stage === stage)
    if (!target) throw Error('This reply has no matching approval target. Review the task and ask again in a new reply.')
    return approve(comment, asked, { stage: target.stage, review_revision: target.revision })
  })
}

/** A task-scoped loopback capability for a live Runner job. */
async function taskBridge(task: string, number: number, run: (body: Record<string, unknown> & { task: string }) => Promise<Call<unknown>>) {
  const token = crypto.randomBytes(32).toString('hex')
  let serial = Promise.resolve()
  const server = http.createServer((req, res) => {
    const answer = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.method !== 'POST' || req.url !== '/' || req.headers.authorization !== `Bearer ${token}` || req.headers.origin) {
      answer(403, { ok: false, error: 'This request cannot act on that task.' }); return
    }
    let raw = ''
    req.on('data', (data: Buffer) => { raw += data.toString(); if (raw.length > 16000) req.destroy() })
    req.on('end', () => {
      serial = serial.then(async () => {
        try {
          const body = JSON.parse(raw) as Record<string, unknown> & { task: string }
          if (body.task !== task && body.task !== String(number) && !new RegExp(`^[A-Za-z][A-Za-z0-9]{0,9}-${number}$`).test(body.task ?? '')) {
            answer(403, { ok: false, error: 'Only the current task can be updated here.' }); return
          }
          answer(200, await run(body))
        } catch (e) { answer(400, { ok: false, error: e instanceof Error ? e.message : 'Task request failed.' }) }
      })
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as { port: number }
  return { env: JSON.stringify({ url: `http://127.0.0.1:${address.port}/`, token }), close: () => { server.close(); server.closeAllConnections() } }
}
