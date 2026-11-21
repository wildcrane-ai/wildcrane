// Explicit step receipts. Pending final receipts keep the card held until archive succeeds.
import { cmdRemove, recoveredArchiveHandoff } from '../../commands/remove'
import fs from 'node:fs'
import { parseFrontmatter } from '../frontmatter'
import { cardFile } from '../board/revision'
import { locate } from '../cards'
import { quietly } from '../io'
import { withBoardLock } from '../lock'
import { withCreationLock } from './creation-lock'
import { endedDelivery, namedDelivery, syncAudit } from './deliveries'
import { deliveryStep } from './progress'
import { answerOutcome } from './answers'
import { insideRun } from './env'
import type { MoveResult } from '../types'
import { readStore, withStore } from './store'
import type { DeliveryCompletion, DeliveryRecord } from './types'

export function completeDelivery(named: string, result: { commit?: string; branch?: string } = {}): MoveResult & { deliveryId: string; finished: boolean } {
  const commit = result.commit?.toLowerCase()
  const branch = result.branch
  if (!!commit !== !!branch || (commit !== undefined && !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(commit)) ||
      (branch !== undefined && (!branch.trim() || branch !== branch.trim() || /[\s\x00-\x1f]/.test(branch)))) {
    throw new Error('Supply a full commit hash and target branch together.')
  }
  const sessionId = insideRun()
  if (!sessionId) throw new Error('Only the current delivery run can complete its step.')
  return withCreationLock(() => withBoardLock(() => {
    const found = namedDelivery(named)
    if (!found) throw new Error(`No delivery answers to "${named}".`)
    const durable = endedDelivery(found.deliveryId)
    const prepared = withStore((store) => {
      const delivery = store.deliveries.find((d) => d.deliveryId === found.deliveryId)
      if (!delivery) throw new Error('The delivery is not available on this computer.')
      if ((durable?.completions?.length ?? 0) > (delivery.completions?.length ?? 0)) {
        delivery.completions = durable!.completions
      }
      const receipts = delivery.completions ??= []
      const run = store.runs.find((r) => r.sessionId === sessionId)
      const current = store.runs.filter((r) => r.deliveryId === delivery.deliveryId && ['implement', 'scheduled'].includes(r.action)).pop()
      const liveCard = delivery.cardId === null ? null : cardFile(delivery.cardId)
      const restored = liveCard && parseFrontmatter(fs.readFileSync(liveCard, 'utf8')).meta?.restored
      if (restored && Date.parse(restored) > (run?.startedAt ?? 0)) throw new Error('This delivery predates task restoration.')
      if (!run || run.deliveryId !== delivery.deliveryId) throw new Error('This run does not own the delivery.')
      const pending = receipts[deliveryStep(delivery)]
      const previous = receipts.find((c) => c.sessionId === sessionId || c.resumedSessions?.includes(sessionId))
      if (previous) {
        if (previous.commit !== commit || previous.branch !== branch) throw new Error('This step already recorded a different result.')
        if (!previous.finished && previous.step === deliveryStep(delivery) &&
            (delivery.status !== 'active' || run !== current || run.status !== 'running')) {
          throw new Error('Only the current owning run can finish pending completion.')
        }
        return { delivery, receipt: previous }
      }
      if (delivery.status !== 'active' || !run || run.status !== 'running' || run !== current || run.deliveryId !== delivery.deliveryId) {
        throw new Error('Only the current owning run can complete this delivery.')
      }
      if (answerOutcome(delivery) === 'changed') throw new Error('The approved requirements were superseded. Continue with the updated delivery.')
      if (pending && run === current) {
        if (pending.commit !== commit || pending.branch !== branch) throw new Error('This step already recorded a different result.')
        pending.resumedSessions = [...(pending.resumedSessions ?? []), sessionId]
        return { delivery, receipt: pending }
      }
      if (deliveryStep(delivery) > 0) throw new Error('The task already recorded completion.')
      if (delivery.cardId !== null && !locate(delivery.cardId)) throw new Error('The card is missing before completion.')
      if (!commit && delivery.base && !delivery.scheduled) throw new Error('Report the merged commit and target branch.')
      const receipt: DeliveryCompletion = { sessionId, step: receipts.length, at: Date.now(), commit, branch, finished: false }
      receipts.push(receipt)
      return { delivery, receipt }
    })
    const { delivery, receipt } = prepared
    syncAudit(delivery.deliveryId)
    const final = true
    if (final && !receipt.finished) {
      let handoff = receipt.handoff
      if (delivery.cardId !== null) {
        const source = locate(delivery.cardId)
        if (source) withStore((store) => {
          store.deliveries.find((d) => d.deliveryId === delivery.deliveryId)!.completions!
            .find((c) => c.step === receipt.step)!.archiveSource = source
        })
        syncAudit(delivery.deliveryId)
        handoff = source
          ? quietly(() => cmdRemove(delivery.cardId!, 'completed', { completing: delivery.deliveryId }))
          : recoveredArchiveHandoff(delivery.cardId, receipt.archiveSource)
      }
      withStore((store) => {
        const live = store.deliveries.find((d) => d.deliveryId === delivery.deliveryId)!
        if (live.status !== 'active') throw new Error('The delivery ended before completion was recorded.')
        const saved = live.completions!.find((c) => c.step === receipt.step)!
        saved.finished = true
        saved.handoff = handoff
        const code = [...live.completions!].reverse().find((c) => c.commit)
        if (code) {
          live.targetBranch = code.branch
          live.landing = { status: 'landed', commit: code.commit, attempts: 0, at: saved.at }
        }
        live.status = 'finished'
        live.endedAt = Date.now()
      })
    }
    syncAudit(delivery.deliveryId)
    const saved = readStore().deliveries.find((d) => d.deliveryId === delivery.deliveryId)!.completions!.find((c) => c.step === receipt.step)!
    return { deliveryId: delivery.deliveryId, finished: final && saved.finished, ...(saved.handoff ?? {}) }
  }))
}
