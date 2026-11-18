import { studioById, studios } from '../lib/agent/studios'
import { say } from '../lib/io'
import { die } from '../lib/paths'
import type { MoveResult } from '../lib/types'

export interface SpecOptions {
  agent?: string
  id?: number
  note?: string[]
  notes?: string
  follow?: boolean
  print?: boolean
  stages?: string
  resetStages?: boolean
  reviseFrom?: string
  submit?: boolean
  status?: string
  stage?: string
  continue?: boolean
  events?: boolean
  triggers?: boolean
  studio?: string
  workspace?: string
}

export async function cmdSpec(opts: SpecOptions, _program = 'akb'): Promise<MoveResult> {
  if (opts.agent || opts.id || opts.stage || opts.stages || opts.submit || opts.continue || opts.resetStages || opts.reviseFrom) die('Prepare Preview outputs in the task session using STUDIO.md. Preview role operations are retired.', 'bad-args')
  const flows = opts.studio ? [studioById(opts.studio)].filter(Boolean) : studios()
  if (opts.studio && !flows.length) die(`No Studio ${opts.studio}`, 'no-such-studio')
  const previews = flows.flatMap(f => f!.previews.map(({ id, instructions }) => ({ id, instructions })))
  say(previews.map(p => `${p.id}\n  ${p.instructions}`).join('\n'))
  return { previews }
}
