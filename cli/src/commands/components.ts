import { agentComponents, studioComponents, componentDocsText } from '../lib/components'
import { say } from '../lib/io'
import { die } from '../lib/paths'
import type { MoveResult } from '../lib/types'

export function cmdComponents(opts: { agent?: string; studio?: string; docs?: boolean }): MoveResult {
  if (!!opts.agent === !!opts.studio) die('choose exactly one of --agent or --studio', { kind: 'invalid-usage' })
  const docs = opts.agent ? agentComponents([opts.agent]) : studioComponents(opts.studio!)
  say(docs.map((doc) => doc.name).join('\n') || '(none)')
  if (opts.docs && docs.length) say(`\n${componentDocsText(docs)}`)
  return { components: docs.map((doc) => doc.name), ...(opts.docs ? { docs } : {}) }
}
