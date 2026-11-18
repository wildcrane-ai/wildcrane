import { studioComponents, componentDocsText } from '../lib/components'
import { say } from '../lib/io'
import { die } from '../lib/paths'
import type { MoveResult } from '../lib/types'

export function cmdComponents(opts: { studio?: string; docs?: boolean }): MoveResult {
  if (!opts.studio) die('--studio is required', { kind: 'invalid-usage' })
  const docs = studioComponents(opts.studio!)
  say(docs.map(doc => doc.name).join('\n'))
  if (opts.docs) say(`\n${componentDocsText(docs)}`)
  return { components: docs.map(doc => doc.name), ...(opts.docs ? { docs } : {}) }
}
