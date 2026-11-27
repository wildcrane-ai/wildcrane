import fs from 'node:fs'
import path from 'node:path'
import { assetRef, decodeFilePath, isAssetRef, isTaskAssetRef, relativeAssetRef, taskAssetPath } from '../../artifact-sdk/src/internal/task-assets'
import { fileManifest, fileNameOf, relativeFileReference, splitFileReference } from '../../artifact-sdk/src/internal/file-references'
import { mapReferences, referencesOf, typeOf } from '../../artifact-sdk/src/internal/manifest'
import { bodyReferences, isObject, kindOf } from '../../artifact-sdk/src/internal/references'
import { parsePreviewBlocks } from '../../cli/src/lib/shared/preview-blocks'
import { makeFailure } from '../../cli/src/lib/agent/retry'
import { isFlatReviewPlan, type SavedPreviewInputs, type TaskReview } from '../../cli/src/lib/shared/review-plan'
import type { Assets, Call } from './api'
import { syncStopped } from './sync-retry'
import { cardAssetsDir, localMaterials, pullMaterials, readAsset, type TaskFolder } from './task-folder'

const remote = /^(?:[a-z][\w+.-]*:|\/|#)/i
const artifactId = /^art_[a-z0-9]+$/i
const object = (value: unknown) => isObject(value) ? value : {}
const own = (record: Record<string, unknown>, key: string) => Object.hasOwn(record, key) ? record[key] : undefined

function sourceOf(pins: Record<string, unknown>, source: string, id: number | undefined, owner?: string): string {
  const [ref] = splitFileReference(source)
  if (artifactId.test(ref)) {
    const pin = object(own(pins, ref))
    const names = Object.keys(pins).filter(key => {
      const alias = object(pins[key])
      return !artifactId.test(key) && alias.artifact === ref && (pin.version === undefined || alias.version === pin.version)
    })
    const first = names[0]
    return first && names.every(key => object(pins[key]).version === object(pins[first]).version) ? first : ref
  }
  const name = decodeFilePath(ref)
  const local = !owner || isTaskAssetRef(ref) ? ref : isTaskAssetRef(owner) ? relativeAssetRef(ref, owner) ?? '' : relativeFileReference(name, owner)
  const taskFile = taskAssetPath(local, id)
  const alias = taskFile === null ? undefined : Object.keys(pins).find(key => taskAssetPath(key, id) === taskFile)
  return [local, path.posix.normalize(local), source].find(key => Object.hasOwn(pins, key)) ?? alias ?? local
}

export async function stageSavedPreviews(
  directory: string, ws: TaskFolder, review: TaskReview, inputs: SavedPreviewInputs | undefined, stopped: () => boolean,
): Promise<Call<string | undefined>> {
  const sections: { title: string; body: string; pins: Record<string, unknown>; sources: unknown }[] = []
  const contexts = new Set<string>()
  const invalid = (name: string) => {
    const error = `Missing or invalid saved review evidence: ${name}`
    return { ok: false as const, code: 'bad_request', error, failure: makeFailure('validation', error) }
  }

  function add(title: string, body: string, pins: Record<string, unknown>, sources: unknown) {
    sections.push({ title, body, pins, sources })
  }

  async function stageSection({ title, body, pins, sources }: typeof sections[number], index: number) {
    const files = new Map<string, { file?: string; note: string }>()
    const folder = path.join(directory, String(index + 1))

    async function stage(source: string, types: string[] = []): Promise<Call<string | undefined>> {
      if (stopped()) return syncStopped
      const known = files.get(source)
      if (known) return { ok: true, value: known.file }
      const { artifact, version, status, error, dependencies } = object(own(pins, source))
      const local = material(source)
      const versionLabel = typeof version === 'number' ? `recorded version ${version}` : ''
      const saved = (reason: string): Call<string | undefined> => {
        const file = local?.file
        files.set(source, { file, note: [file ? `local file: ${JSON.stringify(file)}` : 'unavailable', versionLabel, reason].filter(Boolean).join(' · ') })
        return { ok: true, value: file }
      }
      if (error || status === 'pending' || status === 'failed' || typeof artifact !== 'string' || !artifactId.test(artifact)
        || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
        const missingEvidence = Array.isArray(review.plan) && review.plan.length && types.length && !local
          && (error || status === 'pending' || status === 'failed' || !artifact)
        if (conflicting.has(identity(source)) || missingEvidence) return invalid(`${title} · ${source}`)
        return saved(typeof error === 'string' ? error : artifact ? 'Missing approved asset version.' : 'Missing asset record.')
      }

      const extension = path.posix.extname(splitFileReference(source)[0]).toLowerCase()
      const localPin = local?.pin?.artifact === artifact ? local.pin : undefined
      const detected = kindOf(extension)
      let kind: string = types.includes('tiled') ? 'tiled' : !extension ? localPin?.kind ?? detected : detected
      const matches = local && localPin?.version === version
      const issue = ws.materialIssues?.[source]
      const bytes = matches ? { ok: true as const, value: fs.readFileSync(local.file) }
        : issue && !conflicting.has(identity(source)) ? { ok: false as const, error: issue, code: undefined }
        : await readAsset(artifact, version, kind === 'html' ? 'html' : undefined)
      if (!bytes.ok) {
        if (['unauthenticated', 'forbidden', 'unauthorized', 'permission_denied'].includes(bytes.code ?? '')) return bytes
        if (conflicting.has(identity(source))) return invalid(`${title} · ${source} (version ${version}): ${bytes.error}`)
        return saved(bytes.error)
      }
      const basename = fileNameOf(source).replace(/[^\w. -]/g, '_')
      const name = extension ? basename : basename + (({ html: '.html', storyboard: '.json', spritesheet: '.json', studio: '.json' } as Record<string, string>)[kind] ?? '')
      const copy = path.join(folder, `${files.size + 1}-${name.replace(/\.tsx$/i, kind === 'html' ? '.html' : '.tsx')}`)
      const entry = { file: matches ? local.file : copy, note: '' }
      files.set(source, entry)
      let content: Uint8Array = bytes.value
      const knownManifest = fileManifest(kind, source)
      let data: unknown = knownManifest?.references || extension === '.json' || !extension && types.length
        ? Buffer.from(content).toString() : undefined
      if (extension === '.json' || !extension && types.length) {
        try {
          const parsed: unknown = JSON.parse(data as string)
          const type = typeOf(parsed, types.filter(type => type !== 'asset')).type
          if (type) { kind = type; data = parsed }
        } catch { /* Plain attachments keep their bytes. */ }
      }
      const manifest = kind === 'asset' ? knownManifest : fileManifest(kind, source)
      const refs = referencesOf(manifest, data).filter(({ src }) => !remote.test(src))
      const children = new Map(refs.map(({ src, types }) => [src, { source: sourceOf(pins, src, ws.number ?? undefined, source), types }]))
      if (Array.isArray(dependencies)) for (const dep of dependencies) {
        if (typeof dep === 'string' && !children.has(dep)) children.set(dep, { source: sourceOf(pins, dep, ws.number ?? undefined), types: [] })
      }
      const targets = new Map<string, string>()
      for (const [ref, child] of children) {
        const result = await stage(child.source, child.types)
        if (!result.ok) return result
        if (result.value) targets.set(ref, result.value)
      }
      const relative = (from: string, to: string) => path.relative(path.dirname(from), to).split(path.sep).join('/')
      const changed = refs.some(({ src }) => {
        const file = targets.get(src)
        if (!file) return false
        const [name] = splitFileReference(src)
        try { return decodeURIComponent(name) !== relative(entry.file, file) } catch { return name !== relative(entry.file, file) }
      })
      if (!matches || changed) {
        entry.file = copy
        if (manifest && targets.size) {
          const restored = mapReferences(manifest, data, src => {
            const target = targets.get(src)
            if (!target) return src
            const local = relative(copy, target)
            const url = kind === 'html' || manifest.name === 'css'
              ? local.split('/').map(part => encodeURIComponent(part).replace(/'/g, '%27')).join('/') : local
            return url + splitFileReference(src)[1]
          })
          content = Buffer.from(typeof restored === 'string' ? restored : JSON.stringify(restored))
        }
        fs.mkdirSync(folder, { recursive: true })
        fs.writeFileSync(copy, content)
      }
      entry.note = `${artifact}, version ${version} · ${matches && !changed ? 'local file: ' : ''}${JSON.stringify(entry.file)}`
      return { ok: true, value: entry.file }
    }

    const refs = bodyReferences(body)
    for (const source of Array.isArray(sources) ? sources : []) {
      if (typeof source === 'string' && !refs.some(ref => ref.src === source)) refs.push({ src: source, types: [] })
    }
    for (const { src, types } of refs) {
      if (remote.test(src) && !isAssetRef(src)) continue
      const source = sourceOf(pins, src, ws.number ?? undefined)
      if (!types.length && !isTaskAssetRef(src) && !artifactId.test(src)
        && !Object.hasOwn(pins, source)) continue
      const result = await stage(source, types)
      if (!result.ok) return result
    }
    const attachments = [...files].map(([source, { note }]) => `- ${JSON.stringify(source)} · ${note}`)
    return { ok: true as const, value: `## ${title}\n\n${body}${attachments.length ? '\n\nPinned files:\n' + attachments.join('\n') : ''}` }
  }

  const flat = isFlatReviewPlan(review.plan)
  const plan = Array.isArray(review.plan) ? review.plan : []
  const nodes = flat ? review.stages.flatMap(stage => stage.preview && stage.status === 'approved'
    ? [{ id: stage.id, previews: [stage.preview] }] : []) : plan
  if (nodes.length) {
    const stages = new Map(review.stages.map(stage => [stage.id, stage]))
    for (const node of nodes) {
      const stage = stages.get(node.id)
      if (!stage || !['approved', 'done'].includes(stage.status)) return invalid(node.id)
      const snapshot = stage.snapshot
      if (!snapshot && !node.previews.length) continue
      const evidence = object(snapshot?.evidence)
      const content = object(evidence.content)
      if (typeof evidence.context === 'string' && evidence.context.trim()) contexts.add(evidence.context.trim())
      const body = typeof snapshot?.body === 'string' ? snapshot.body : ''
      const blocks = parsePreviewBlocks(body).blocks
      const frozen = Array.isArray(snapshot?.previews) ? snapshot.previews.filter(isObject) : []
      const title = `${node.id} · ${stage.status}`
      const pins = { ...object(evidence.dependencies), ...object(evidence.assets) }
      if (!node.previews.length) {
        const saved = typeof evidence.content === 'string' ? evidence.content : body
        if (saved) add(title, saved, pins, [])
      }
      for (const id of node.previews) {
        const section = object(own(content, id))
        const saved = typeof section.body === 'string' ? section.body : blocks.find(block => block.id === id)?.instructions
        if (!saved?.trim()) return invalid(`${title} · ${id}`)
        const legacyPins = object(frozen.find(preview => preview.id === id)?.assets)
        add(`${title} · ${id}`, saved, { ...legacyPins, ...pins }, section.sources)
      }
    }
  }
  if ((!nodes.length || flat) && inputs) {
    if (inputs.body) {
      const body = parsePreviewBlocks(inputs.body).blocks.reduceRight((text, block) =>
        text.slice(0, block.start) + text.slice(block.end), inputs.body).trim()
      if (body) add('Task', body, inputs.assets, [])
    }
    for (const [id, section] of Object.entries(inputs.sections)) {
      add(flat && nodes.some(node => node.previews.includes(id)) ? `${id} · current draft` : id, section.body, inputs.assets, section.sources)
    }
  }
  const selected = new Map<string, Assets[string]>()
  const firstPins = new Map<string, Assets[string]>()
  const conflicting = new Set<string>()
  const identity = (source: string) => {
    const file = taskAssetPath(source, ws.number ?? undefined)
    return file === null ? source : assetRef(file)
  }
  for (const { pins } of sections) {
    for (const [source, value] of Object.entries(pins)) {
      const pin = object(value)
      const key = identity(source)
      const previous = firstPins.get(key)
      if (previous && (previous.artifact !== pin.artifact || previous.version !== pin.version)) conflicting.add(key)
      if (typeof pin.artifact !== 'string') continue
      if (!previous) firstPins.set(key, pin as unknown as Assets[string])
      if (!selected.has(source)) selected.set(source, pin as unknown as Assets[string])
    }
  }
  const pulled = await pullMaterials(ws, Object.fromEntries(selected), stopped)
  if (!pulled.ok) return pulled
  const material = localMaterials(ws)
  const output = [...contexts]
  for (const [index, section] of sections.entries()) {
    const result = await stageSection(section, index)
    if (!result.ok) return result
    output.push(result.value)
  }

  const sources = new Set(Object.keys(inputs?.assets ?? {}))
  const local = ws.number && cardAssetsDir(ws, ws.number)
  if (local && fs.existsSync(local)) {
    for (const file of fs.readdirSync(local, { recursive: true, withFileTypes: true })) {
      if (file.isFile()) sources.add(assetRef(path.relative(local, path.join(file.parentPath, file.name)).split(path.sep).join('/')))
    }
  }
  const supplemental = [...sources].filter(source => !firstPins.has(identity(source))).flatMap(source => {
    const local = material(source)
    const problem = ws.materialIssues?.[source]
    return local || problem ? [`- ${JSON.stringify(source)} · ${local ? `local file: ${JSON.stringify(local.file)}` : 'unavailable'}${problem ? ` · ${problem}` : ''}`] : []
  })
  if (supplemental.length) output.push('## Local materials\n\n' + supplemental.join('\n'))
  if (!output.length) return { ok: true, value: undefined }
  const manifest = path.join(directory, 'previews.md')
  fs.writeFileSync(manifest, output.join('\n\n') + '\n')
  return { ok: true, value: manifest }
}
