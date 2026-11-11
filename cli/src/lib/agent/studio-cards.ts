import { die } from '../paths'
import type { Meta } from '../types'
import { heldByDelivery } from './deliveries'
import { readRuns, runIsLive } from './store'
import { knownStudio } from './studios'

/** Move card `id` to studio `asked` by editing `meta` in place; the
 *  caller writes it. Refused while a run or a delivery is on the card (#1849). A switch drops
 *  the old studio's plan: back to `todo`, its previews cleared. Shared by
 *  `akb raw update --studio` and the card page. Answers whether anything changed. */
export function switchStudio(id: number, meta: Meta, asked: string): boolean {
  const wanted = asked.trim()
  const next = knownStudio(wanted)
  if (next === meta.studio) return false
  if (readRuns().some((r) => r.cardId === id && runIsLive(r))) {
    die(`#${id} has a run in progress — stop it before switching its studio.`, { kind: 'card-held', id })
  }
  const held = heldByDelivery(id)
  if (held) die(held, { kind: 'card-held', id })
  meta.studio = next
  meta.status = 'todo'
  delete meta.previews
  meta.stages = 0
  meta.phase = 0
  return true
}
