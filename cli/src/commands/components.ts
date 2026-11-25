import { allComponents, componentCapabilitiesText, componentDocsText, componentUsage, studioComponents } from '../lib/components'
import { say } from '../lib/io'
import { die } from '../lib/paths'
import type { MoveResult } from '../lib/types'

export function cmdComponents(names: string[]): MoveResult {
  if (!names.length) {
    say(componentCapabilitiesText())
    return { components: allComponents().map(doc => doc.name) }
  }
  const docs = componentUsage(names)
  say(docs.map(doc => doc.text.trim()).join('\n\n'))
  return { components: docs.map(doc => doc.name), docs }
}

export function cmdStudioComponents(opts: { studio?: string; docs?: boolean }): MoveResult {
  if (!opts.studio) die('--studio is required', { kind: 'invalid-usage' })
  const docs = studioComponents(opts.studio!)
  say(docs.map(doc => doc.name).join('\n'))
  if (opts.docs) say(`\n${componentDocsText(docs)}`)
  return { components: docs.map(doc => doc.name), ...(opts.docs ? { docs } : {}) }
}
