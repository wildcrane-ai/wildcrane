import path from 'node:path'
import { relativeFileReference, splitFileReference } from '../../../../artifact-sdk/src/internal/file-references'
import { bodyComponentTags, bodySources, isObject } from '../../../../artifact-sdk/src/internal/references'
import { variantsOf } from '../../../../artifact-sdk/src/internal/tags'
import { CODING_PREVIEWS } from '../shared/coding-previews'
import { parsePreviewBlocks } from '../shared/preview-blocks'
import { reviewAuthorization, type TaskReview } from '../shared/review-plan'

export const APPROVED_UI_DIR_ENV = 'AI4KANBAN_APPROVED_UI_DIR'
export const APPROVED_UI_RULE = "Open the approved mockups and follow the Coding Studio delivery requirements for matching the task's intended UI changes."

interface Mockup {
  src: string
  source: string
  label: string
  devices: Set<string>
}

interface ApprovedUi {
  id: string
  revision: number
  directory: string
  body: string
  pins: Record<string, unknown>
  files: Mockup[]
}

const UI_PREVIEW = 'ui-design'
const historicalUiIds = Object.keys(CODING_PREVIEWS).filter(id => id !== UI_PREVIEW && CODING_PREVIEWS[id] === UI_PREVIEW)
const object = (value: unknown) => isObject(value) ? value : {}
const artifactId = /^art_[a-z0-9]+$/i
const external = /^(?:[a-z][\w+.-]*:|\/|#)/i

export function approvedUiSource(pins: Record<string, unknown>, src: string, owner?: string): string {
  const [ref] = splitFileReference(src)
  if (artifactId.test(ref)) {
    const version = approvedUiPin(pins, ref).version
    const names = Object.keys(pins).filter(name => {
      const pin = approvedUiPin(pins, name)
      return pin.artifact === ref && (version === undefined || pin.version === version)
    })
    return names.find(name => !artifactId.test(name)) ?? names[0] ?? ref
  }
  const local = owner && !ref.startsWith('.assets/') ? relativeFileReference(ref, owner) : ref
  return [local, src, ref, path.posix.normalize(local)].find(key => Object.hasOwn(pins, key)) ?? local
}

export function approvedUiPin(pins: Record<string, unknown>, source: string) {
  return object(Object.hasOwn(pins, source) ? pins[source] : undefined)
}

export function validUiPin(pin: Record<string, unknown>): pin is { artifact: string; version: number } {
  return !pin.error && pin.status !== 'pending' && pin.status !== 'failed'
    && typeof pin.artifact === 'string' && artifactId.test(pin.artifact)
    && typeof pin.version === 'number' && Number.isSafeInteger(pin.version) && pin.version > 0
}

export function approvedUiPreviews(review: TaskReview): ApprovedUi[] {
  if (reviewAuthorization(review).kind !== 'delivery') return []
  const result: ApprovedUi[] = []
  for (const [index, node] of (review.plan ?? []).entries()) {
    const stage = review.stages.find(stage => stage.id === node.id)
    const snapshot = stage?.snapshot
    if (node.kind === 'work' || !stage || !snapshot) continue
    const evidence = object(snapshot.evidence)
    const content = object(evidence.content)
    const frozenPreviews = Array.isArray(snapshot.previews) ? snapshot.previews.filter(isObject) : []
    for (const id of node.previews.filter(id => id === UI_PREVIEW || historicalUiIds.includes(id))) {
      const preview = object(content[id])
      const body = typeof preview.body === 'string' ? preview.body
        : typeof snapshot.body === 'string' ? parsePreviewBlocks(snapshot.body).blocks.find(block => block.id === id)?.instructions : undefined
      if (!body) continue
      const pins = { ...object(evidence.dependencies), ...object(frozenPreviews.find(preview => preview.id === id)?.assets), ...object(evidence.assets) }
      const files = new Map<string, Mockup>()
      const add = (src: string, label: string, device?: string, required = true) => {
        if (external.test(src)) return
        const source = approvedUiSource(pins, src)
        if (!required && !Object.hasOwn(pins, source) && !/\.(?:html?|tsx)$/i.test(source)) return
        const name = label.trim() || path.posix.basename(src)
        const key = JSON.stringify([src, name])
        let file = files.get(key)
        if (!file) {
          file = { src, source, label: name, devices: new Set() }
          files.set(key, file)
        }
        file.devices.add(device === 'mobile' ? 'Mobile' : device === 'desktop' ? 'Desktop' : 'Device unspecified')
      }
      for (const { name, attrs } of bodyComponentTags(body)) {
        const label = attrs.label ?? ''
        if (name === 'Compare' && attrs.a && attrs.b) {
          add(attrs.a, attrs['a-label'] || label)
          add(attrs.b, attrs['b-label'] || label)
        } else if (attrs.src) {
          const variants = variantsOf(attrs.variants, attrs.src)
          if (variants.length) {
            for (const variant of variants) add(variant.src, label ? `${label} (${variant.label})` : variant.label, attrs.device)
          } else {
            add(attrs.src, label, attrs.device)
          }
        }
      }
      const listed = new Set([...files.values()].map(file => file.src))
      for (const src of bodySources(body)) if (!listed.has(src)) add(src, '', undefined, false)
      if (files.size) result.push({
        id, revision: stage.revision, directory: `review-${stage.revision}-${index}/${id}`, body, pins, files: [...files.values()],
      })
    }
  }
  return result
}

export function approvedUiFile(directory: string, preview: ApprovedUi, source: string): string {
  const parts = path.posix.normalize(splitFileReference(source)[0]).split('/')
  let parents = 0
  while (parts[0] === '..') { parts.shift(); parents++ }
  const rendered = /\.tsx$/i.test(parts.at(-1) ?? '')
  if (rendered) parts[parts.length - 1] = parts.at(-1)!.replace(/\.tsx$/i, '.html')
  const safe = parts.map(part => !part || part === '.' ? '%00' : part.replace(/[\\:*?"<>|%\x00-\x1f]/g, char =>
    `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`))
  return path.join(directory, preview.directory, `${rendered ? 'rendered' : 'files'}-${parents}`, ...safe)
}

export function approvedUiPrompt(review: TaskReview, directory?: string, includeBody = false): string {
  const previews = approvedUiPreviews(review)
  if (!previews.length) return ''
  return [
    'Approved UI previews',
    APPROVED_UI_RULE,
    ...previews.flatMap(preview => [
      ...(includeBody ? [preview.body] : []),
      preview.files.flatMap(file => {
        const pin = approvedUiPin(preview.pins, file.source)
        if (!validUiPin(pin)) return []
        const ref = directory ? `frozen file: \`${approvedUiFile(directory, preview, file.source)}\`` : `artifact ${pin.artifact}, version ${pin.version}`
        return [`- ${file.label} · ${[...file.devices].join(' / ')} · Review revision ${preview.revision} · ${file.src} · ${ref}`]
      }).join('\n'),
    ]),
  ].join('\n\n')
}
