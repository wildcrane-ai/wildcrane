import asset from '../components/Asset.md'
import compare from '../components/Compare.md'
import set from '../components/Set.md'
import storyboard from '../components/Storyboard.md'
import studio from '../components/Studio.md'
import shared from '../components/shared.md'
import { findSpecAgent } from './agents'
import { BoardError } from './io'
import { boardText } from './paths'
import { studioById, previewMembers, scheduledMembers } from './agent/studios'

const DOCUMENTS: Record<string, string> = { Asset: asset, Compare: compare, Storyboard: storyboard, Set: set, Studio: studio }

export interface PreviewComponentDoc {
  name: string
  text: string
}

export function agentComponents(
  names: string[],
  documents: Readonly<Record<string, string>> = DOCUMENTS,
): PreviewComponentDoc[] {
  const docs = new Map<string, PreviewComponentDoc>()
  for (const name of new Set(names)) {
    const agent = findSpecAgent(name)
    if (!agent) throw new BoardError(`no agent called "${name}"`, { kind: 'unknown-agent', agent: name })
    for (const component of agent.components) {
      const text = Object.hasOwn(documents, component) ? documents[component] : undefined
      if (!text?.trim()) {
        throw new BoardError(`agent "${name}": unknown component or missing documentation for "${component}"`, {
          kind: 'component-documentation-missing', agent: name, component,
        })
      }
      docs.set(component, { name: component, text: boardText(text) })
    }
  }
  return [...docs.values()]
}

export function studioComponents(id: string): PreviewComponentDoc[] {
  const flow = studioById(id)
  if (!flow) throw new BoardError(`no studio called "${id}"`, { kind: 'unknown-studio', studio: id })
  const members = [...previewMembers(flow), ...flow.land, ...scheduledMembers(flow)].map((row) => row.agent)
  return agentComponents(members)
}

export const componentDocsText = (docs: PreviewComponentDoc[]): string =>
  docs.length ? [shared, ...docs.map((doc) => doc.text)].map((text) => text.trim()).join('\n\n') : ''
