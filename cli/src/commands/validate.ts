import fs from 'node:fs'
import path from 'node:path'

import { boardProject, readPin, readVersion } from '../lib/agent/cloud-studios'
import { call } from '../lib/cloud/tasks'
import { hasText, isRecord } from '../lib/cloud/response'
import { studioName } from '../lib/shared/board-files'
import type { CardStudioContext } from '../lib/shared/card-structure'
import { previewCatalog } from '../lib/shared/studio-files'
import { makeFailure } from '../lib/agent/retry'
import { insideRun } from '../lib/agent/env'
import { patch } from '../lib/agent/sessions'
import { say } from '../lib/io'
import { die, KANBAN } from '../lib/paths'
import { formatContractErrors, snapshotSpecs, validateSpec } from '../lib/spec-contract'
import type { MoveResult } from '../lib/types'

function linkedTasks(ids: Set<number>): [number, string][] {
  if (!boardProject()) return []
  const dir = path.join(KANBAN, '.sync')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).flatMap(file => {
    if (!/^task_[0-9a-f]+\.json$/.test(file)) return []
    try {
      const { number, task } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      return ids.has(number) && task + '.json' === file ? [[number, task] as [number, string]] : []
    } catch { return [] }
  })
}

async function readCardStudio(task: string): Promise<CardStudioContext | undefined> {
  const found = await call<{
    studio?: string; deleted?: boolean; previews?: { id: string }[]; historicalPreviews?: Record<string, unknown>
  }>('GET', `/v1/tasks/${encodeURIComponent(task)}/studio`)
  if (found.ok && isRecord(found.value)) {
    return {
      studio: hasText(found.value.studio) && !found.value.deleted ? studioName(found.value.studio) : undefined,
      previewIds: Array.isArray(found.value.previews) ? found.value.previews.map(p => p.id) : undefined,
      historicalPreviews: Object.keys(found.value.historicalPreviews ?? {}),
    }
  }
  const pin = readPin(task)
  if (!pin) return undefined
  const files = readVersion(pin.studio, pin.version)?.files
  return { studio: studioName(pin.studio), previewIds: files && previewCatalog(files).map(p => p.id), historicalPreviews: Object.keys(pin.historicalPreviews ?? {}) }
}

export async function cmdValidate(id?: number): Promise<MoveResult> {
  const cards = [...snapshotSpecs(id)]
  if (id !== undefined && !cards.length) die(`no task with id ${id}`, { kind: 'card-not-found', id })
  const tasks = linkedTasks(new Set(cards.map(([, card]) => card.id)))
  const contexts = new Map<number, CardStudioContext | undefined>()
  for (let i = 0; i < tasks.length; i += 8) {
    const batch = await Promise.all(tasks.slice(i, i + 8).map(async ([number, task]) => [number, await readCardStudio(task)] as const))
    for (const [number, context] of batch) contexts.set(number, context)
  }
  const errors = cards.flatMap(([file, card]) => validateSpec(file, card.text, card.id, contexts.get(card.id)))
  const reason = errors.length ? formatContractErrors(errors) : undefined
  const session = insideRun()
  if (session) patch(session, run => {
    run.validationFailure = reason ? makeFailure('validation', reason, { code: 'validation_failed', detail: reason }) : undefined
  })
  if (reason) die(reason, { kind: 'spec-contract', errors })
  say(`Spec format valid (${cards.length} card${cards.length === 1 ? '' : 's'}).`)
  return { valid: true, checked: cards.length, errors: [] }
}
