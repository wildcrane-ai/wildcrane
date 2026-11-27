import { activeDelivery, syncAudit } from './deliveries'
import { insideRun } from './env'
import { withStore } from './store'
import type { DeliveryRecord } from './types'
import { git } from './worktree'

function landingOf(delivery: DeliveryRecord) {
  const recorded = delivery.completions?.slice().reverse().find(receipt => receipt.commit && receipt.branch)
  const branch = recorded?.branch ?? delivery.targetBranch
  if (!branch) return
  const target = `refs/heads/${branch}`
  const contains = (commit: string, ref: string) => git(['merge-base', '--is-ancestor', commit, ref]) !== null
  if (recorded?.commit && contains(recorded.commit, target)) return { branch, commit: recorded.commit }
  if (!delivery.branch || !delivery.base) return
  const source = git(['rev-parse', '--verify', `refs/heads/${delivery.branch}`])?.trim()
  if (!source || source === delivery.base || !contains(source, target)) return
  const commits = git(['rev-list', '--first-parent', '--reverse', `${delivery.base}..${target}`])
  const commit = commits?.trim().split('\n').find(candidate => candidate && contains(source, candidate))
  if (commit) return { branch, commit }
}

export function recordDeliveryArchive(card: number | null, session = insideRun()) {
  const id = card === null ? undefined : activeDelivery(card)?.deliveryId
  if (!id && !session) return
  const saved = withStore(store => {
    const run = session ? store.runs.find(row => row.sessionId === session) : undefined
    const delivery = store.deliveries.find(row => row.deliveryId === (id ?? run?.deliveryId)
      && row.status === 'active' && row.cardId === card)
    if (!delivery) return
    const result = landingOf(delivery)
    const now = Date.now()
    if (result) {
      delivery.targetBranch = result.branch
      delivery.landing = { status: 'landed', commit: result.commit, attempts: 0, at: now }
    }
    delivery.status = 'finished'
    delivery.endedAt = now
    return delivery.deliveryId
  })
  if (saved) syncAudit(saved)
}
