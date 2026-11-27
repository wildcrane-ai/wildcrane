// Delivery identity and execution context. Git belongs to the executing agent.
import fs from 'node:fs'
import path from 'node:path'
import { deliveryPhase } from './env'
import { DELIVERIES, REPO_ROOT } from '../paths'
import { plannedTodos } from './outputs'
import { readStore } from './store'
import type { DeliveryRecord, RunRefusal } from './types'
import { currentBranch, git, headCommit, worktreeDir } from './worktree'

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const ID_LENGTH = 8

/** Every delivery id the permanent record already holds, so a new one can't collide with a
 *  delivery that ended months ago. */
function recordedIds(): Set<string> {
  try {
    return new Set(
      fs
        .readdirSync(DELIVERIES)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length)),
    )
  } catch {
    return new Set()
  }
}

/** A delivery id nothing else answers to — drawn at random and checked against both
 *  records, the live rows and the files, since a delivery leaves the first long before it
 *  leaves the second. */
export function newDeliveryId(live: DeliveryRecord[] = readStore().deliveries): string {
  const taken = recordedIds()
  for (const d of live) taken.add(d.deliveryId)
  for (;;) {
    let id = ''
    for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
    if (!taken.has(id)) return id
  }
}

export interface DeliveryStart {
  deliveryId: string
  base?: string
  targetBranch?: string
  branch?: string
  planned?: string[]
  worktree?: string
}

export const deliveryCwd = (delivery: { worktree?: string }): string =>
  delivery.worktree && fs.existsSync(worktreeDir(delivery.worktree)) ? worktreeDir(delivery.worktree) : REPO_ROOT

export function prepareDelivery(cardId: number | null): { start: DeliveryStart } | RunRefusal {
  const deliveryId = newDeliveryId()
  const base = headCommit() ?? undefined
  const targetBranch = currentBranch() ?? undefined
  const start: DeliveryStart = { deliveryId, base, targetBranch, planned: cardId === null ? [] : plannedTodos(cardId) }
  if (cardId === null || deliveryPhase() !== 'implement') return { start }

  start.worktree = path.join('.akb', 'worktrees', deliveryId, 'work')
  const work = worktreeDir(start.worktree)
  if (base) {
    start.branch = `akb/${deliveryId}`
    fs.mkdirSync(path.dirname(work), { recursive: true })
    if (git(['worktree', 'add', '-b', start.branch, work, base]) === null) {
      return { error: `Could not create the implementation worktree at ${work}.` }
    }
  } else {
    const ignored = new Set(['.akb', '.git', 'node_modules', '.venv', 'dist', 'build'])
    const options: fs.CopySyncOptions = { recursive: true, verbatimSymlinks: true, filter: source => !ignored.has(path.basename(source)) }
    const baseline = path.join(path.dirname(work), 'base')
    fs.mkdirSync(baseline, { recursive: true })
    for (const name of fs.readdirSync(REPO_ROOT).filter(name => !ignored.has(name))) {
      fs.cpSync(path.join(REPO_ROOT, name), path.join(baseline, name), options)
    }
    fs.cpSync(baseline, work, options)
  }
  return { start }
}

export const deliveryName = (delivery: Pick<DeliveryRecord, 'cardId' | 'deliveryId'>): string =>
  delivery.cardId === null ? `delivery ${delivery.deliveryId}` : `#${delivery.cardId}`
