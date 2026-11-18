import { insideRun } from '../lib/agent/env'
import { patch } from '../lib/agent/sessions'
import { say } from '../lib/io'
import { die } from '../lib/paths'
import { formatContractErrors, snapshotSpecs, validateSpec } from '../lib/spec-contract'
import type { MoveResult } from '../lib/types'

export function cmdValidate(id?: number): MoveResult {
  const cards = [...snapshotSpecs()].filter(([, card]) => id === undefined || card.id === id)
  if (id !== undefined && !cards.length) die(`no task with id ${id}`, { kind: 'card-not-found', id })
  const errors = cards.flatMap(([file, card]) => validateSpec(file, card.text, card.id))
  const reason = errors.length ? formatContractErrors(errors) : undefined
  const session = insideRun()
  if (session) patch(session, run => {
    run.validationFailure = reason ? { code: 'validation_failed', level: 1, source: 'validation', reason } : undefined
  })
  if (reason) die(reason, { kind: 'spec-contract', errors })
  say(`Spec format valid (${cards.length} card${cards.length === 1 ? '' : 's'}).`)
  return { valid: true, checked: cards.length, errors: [] }
}
