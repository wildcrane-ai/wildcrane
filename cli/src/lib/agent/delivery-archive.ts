import { activeDelivery, syncAudit } from './deliveries'
import { deliveryPhase, insideRun } from './env'
import { REPO_ROOT } from '../paths'
import { checkoutAt, containsCommit, PROJECT_CHECKOUT, verifiedWorkspace } from './delivery-workspace'
import { withStore } from './store'
import type { DeliveryRecord } from './types'
import { currentBranch, git, headCommit } from './worktree'

export function inPlaceLanding(delivery: DeliveryRecord) {
  const branch = delivery.targetBranch
  if (!branch || branch !== delivery.branch) return
  const commit = delivery.landing?.commit ?? delivery.completions?.slice().reverse().find(c => c.branch === branch)?.commit
  if (commit && checkoutAt(REPO_ROOT) && containsCommit(REPO_ROOT, commit, `refs/heads/${branch}`)) return { branch, commit }
}

export function recordImplementationCommit(deliveryId: string, sessionId: string, before: string | null): boolean {
  return withStore(store => {
    const delivery = store.deliveries.find(d => d.deliveryId === deliveryId && d.status === 'active')
    if (!delivery || !delivery.targetBranch || currentBranch() !== delivery.targetBranch) return false
    const commit = headCommit()
    if (commit && commit !== before && (!before || containsCommit(REPO_ROOT, before, commit))) {
      (delivery.completions ??= []).push({ sessionId, step: delivery.steps.length, at: Date.now(),
        branch: delivery.targetBranch, commit, finished: false })
    }
    return !!inPlaceLanding(delivery)
  })
}

export function hasInPlaceArchiveCommit(card: number): boolean {
  const delivery = activeDelivery(card)
  return delivery?.worktree !== PROJECT_CHECKOUT || !!verifiedWorkspace(REPO_ROOT, delivery) && !!inPlaceLanding(delivery)
}

export function landingOf(delivery: DeliveryRecord) {
  if (delivery.worktree === PROJECT_CHECKOUT) {
    const saved = inPlaceLanding(delivery)
    if (saved || deliveryPhase() === 'land') return saved
    const commit = headCommit()
    const branch = currentBranch()
    if (commit && commit !== delivery.base && branch && branch === delivery.targetBranch) return { commit, branch }
    return
  }
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
