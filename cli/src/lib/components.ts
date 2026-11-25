import { assetCapabilities, TEXT_LIMIT } from '../../../artifact-sdk/src/internal/asset-formats'
import { previewComponents, previewComponentNames, type PreviewComponent } from '../../../artifact-sdk/src/internal/references'
import asset from '../components/Asset.md'
import compare from '../components/Compare.md'
import set from '../components/Set.md'
import storyboard from '../components/Storyboard.md'
import studio from '../components/Studio.md'
import shared from '../components/shared.md'
import { findSpecAgent } from './agents'
import { BoardError } from './io'
import { boardText } from './paths'
import { studioById } from './agent/studios'

const DOCUMENTS: Record<PreviewComponent, string> = { Asset: asset, Compare: compare, Storyboard: storyboard, Set: set, Studio: studio }

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

export const allComponents = (): PreviewComponentDoc[] => previewComponentNames.map(name => ({
  name,
  text: boardText(DOCUMENTS[name]),
}))

export function componentUsage(names: string[]): PreviewComponentDoc[] {
  const docs = allComponents()
  return names.map(name => {
    const doc = docs.find(doc => doc.name === name)
    if (!doc) throw new BoardError(`Unknown Preview Component "${name}". Choose from ${previewComponentNames.join(', ')}.`, {
      kind: 'unknown-component', component: name,
    })
    return doc
  })
}

export function componentCapabilitiesText(): string {
  const { asset, ...components } = previewComponents
  return [
    asset.name,
    ...assetCapabilities().map(([name, formats]) => `  ${name.padEnd(11)}${formats}`),
    ...Object.values(components).map(({ name, summary }) => `${name.padEnd(13)}${summary}`),
    `Text and CSV/TSV: up to ${TEXT_LIMIT.toLocaleString('en-US')} characters. Originals are downloadable. Other formats: download only.`,
  ].join('\n')
}

export function studioComponents(id: string): PreviewComponentDoc[] {
  const flow = studioById(id)
  if (!flow) throw new BoardError(`no studio called "${id}"`, { kind: 'unknown-studio', studio: id })
  return allComponents()
}

export const componentDocsText = (docs: PreviewComponentDoc[]): string =>
  docs.length ? [shared, ...docs.map((doc) => doc.text)].map((text) => text.trim()).join('\n\n') : ''
