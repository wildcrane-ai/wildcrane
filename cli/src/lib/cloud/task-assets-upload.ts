import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { collect } from '../../../../artifact-sdk/src/internal/collect'
import { documentPreviewKey, isDocumentPreview, officeExtension, OFFICE_TYPES, type OfficeExtension } from '../../../../artifact-sdk/src/internal/document'
import { bodyReferences, kindOf, TYPES, type Kind } from '../../../../artifact-sdk/src/internal/references'
import { fileManifest, splitFileReference } from '../../../../artifact-sdk/src/internal/file-references'
import { mapReferences } from '../../../../artifact-sdk/src/internal/manifest'
import { assetRef, isAssetRef, isLegacyAssetRef, isTaskAssetRef, taskAssetPath } from '../../../../artifact-sdk/src/internal/task-assets'
import { resolveBoardAsset } from '../machine/asset-path'
import { projectStateDir, realPathOf } from '../machine/project'
import { referenceText } from '../draw-mockup'
import { renderError } from '../preview-validation'
import { ASSET_FILE_LIMIT } from '../shared/file-limits'
import { parsePreviewBlocks, sourcePosition } from '../shared/preview-blocks'
import { makeFailure, type ExecutionFailure } from '../agent/retry'
import { temporaryCloudFailure } from './response'

export type Assets = Record<string, { artifact: string; version?: number; dependencies?: string[]; error?: string }>
type AssetProblem = { ok: false; error: string; code?: string; status?: number; failure?: ExecutionFailure }
type AssetCall<T> = { ok: true; value: T } | AssetProblem
type PendingVersion = { artifact: string; hash: string; upload: string }

export interface AssetRecord {
  assets: Record<string, { artifact: string; version: number; hash: string; localHash?: string; kind?: Kind; dependencies?: string[] }>
  pendingVersions?: Record<string, PendingVersion>
}

export interface AssetApi {
  readArtifact(artifact: string): Promise<AssetCall<{ latest_version: number | null; type: Kind }>>
  createArtifact(task: string, name: string, type: string, key: string): Promise<AssetCall<{ id: string }>>
  createUpload(artifact: string, type: string, size: number): Promise<AssetCall<{ id: string; url?: string; parts?: { count: number; size: number; url: string } }>>
  upload(url: string, bytes: Uint8Array, type: string): Promise<AssetCall<unknown>>
  completeUpload(url: string): Promise<AssetCall<unknown>>
  createVersion(artifact: string, upload: string): Promise<AssetCall<{ version: number }>>
}

interface AssetHooks {
  save?(): void
  failed?(stage: 'create_artifact' | 'create_upload' | 'upload' | 'complete_upload' | 'commit_version', error: AssetProblem): void
  document?(key: string, ext: OfficeExtension, bytes: Uint8Array): Promise<AssetCall<Assets[string] | undefined>>
  documentUnavailable?(error: string): void
}

const hashOf = (bytes: Uint8Array | string) => crypto.createHash('sha256').update(bytes).digest('hex')
const hashFile = (file: string) => {
  try { return hashOf(fs.readFileSync(file)) } catch { return null }
}

export function assetsOf(text: string | null | undefined): Assets {
  try {
    const held = JSON.parse(text ?? '{}') as unknown
    return held && typeof held === 'object' && !Array.isArray(held) ? (held as Assets) : {}
  } catch {
    return {}
  }
}

export const assetsText = (assets: Assets) => `${JSON.stringify(Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), null, 2)}\n`

interface Sent {
  bytes: Uint8Array
  type: string
  kind: Kind
}

/** What goes up for a file: a mockup as the page it draws, anything else as it is. */
function sentOf(file: string, kind: Kind, data: unknown): Sent {
  if (kind === 'html' && typeof data === 'string') return { bytes: Buffer.from(data), type: 'text/html', kind }
  const ext = path.extname(file).toLowerCase()
  const office = officeExtension(file)
  const type = office ? OFFICE_TYPES[office] : kind === 'tiled' && ext === '.tsx' ? 'application/xml' : TYPES[ext]
  return { bytes: fs.readFileSync(file), type: type ?? 'application/octet-stream', kind }
}

/** Why a preview cannot be drawn, with its paths as the card names them. */
function undrawn(ws: { board: string; number: number | null }, reason: string): string {
  for (const [root, prefix] of [[path.join(projectStateDir(ws.board), 'assets', String(ws.number)), 'asset:'], [ws.board, '']]) {
    reason = reason.split(`file://${root}${path.sep}`).join(prefix).split(`${root}${path.sep}`).join(prefix)
  }
  return reason.replace(/ \(at [^)]*file:\/\/[^)]*\)$/, '').slice(0, 500)
}

export async function uploadAsset(api: AssetApi, artifact: string, { bytes, type }: Pick<Sent, 'bytes' | 'type'>, failed?: AssetHooks['failed']): Promise<AssetCall<string>> {
  const upload = await api.createUpload(artifact, type, Math.max(bytes.length, 1))
  if (!upload.ok) { failed?.('create_upload', upload); return upload }
  const { id, url, parts } = upload.value
  if (parts) {
    for (let part = 1; part <= parts.count; part++) {
      const put = await api.upload(parts.url.replace('{part}', String(part)), bytes.subarray((part - 1) * parts.size, part * parts.size), type)
      if (!put.ok) { failed?.('upload', put); return put }
    }
    const done = await api.completeUpload(url ?? `/v1/uploads/${encodeURIComponent(id)}/complete`)
    if (!done.ok) { failed?.('complete_upload', done); return done }
  } else {
    const put = await api.upload(url ?? `/v1/uploads/${encodeURIComponent(id)}`, bytes, type)
    if (!put.ok) { failed?.('upload', put); return put }
  }
  return { ok: true, value: id }
}

export const artifactKey = (task: string, file: string, kind: Kind, previous?: string) =>
  'runner-artifact-' + hashOf(JSON.stringify([task, file, kind, previous]))

export async function finishAssetVersion(api: AssetApi, record: AssetRecord, key: string, pending: PendingVersion, hooks: AssetHooks): Promise<AssetCall<number>> {
  const made = await api.createVersion(pending.artifact, pending.upload)
  if (!made.ok) {
    hooks.failed?.('commit_version', made)
    if (made.code === 'conflict' && made.error === 'That upload is unfinished, or already used.') {
      delete record.pendingVersions![key]
      hooks.save?.()
      return { ok: false, error: `${key}: ${made.error}` }
    }
    return { ...made, error: `${key}: ${made.error}` }
  }
  delete record.pendingVersions![key]
  return { ok: true, value: made.value.version }
}

export async function uploadTaskAssets(
  ws: { board: string; number: number | null; cloudTask: string | null }, file: string, body: string,
  record: AssetRecord, before: Assets, api: AssetApi, hooks: AssetHooks = {},
): Promise<AssetCall<{ refs: Assets; retryPreviews: boolean }>> {
  const failed = (stage: 'create_artifact', error: AssetProblem) => {
    hooks.failed?.(stage, error)
    return error
  }
  const finishedPreviewWrite = (problem: AssetProblem) =>
    problem.code === 'conflict' && /(?:^|: )This task has finished\.$/.test(problem.error)
  const refs: Assets = {}
  const currentDocumentPreviews = new Set<string>()
  let retryPreviews = false
  const sources = bodyReferences(body)
  // Keep the existing index of cards that still use only legacy task references.
  const legacy = !sources.some(ref => isAssetRef(ref.src))
    && (sources.some(ref => isLegacyAssetRef(ref.src)) || Object.keys(before).some(isLegacyAssetRef))
  const folder = ws.number === null ? null : realPathOf(path.join(projectStateDir(ws.board), 'assets', String(ws.number)))
  const canonical = (target: string) => {
    const real = realPathOf(target)
    if (folder && real.startsWith(folder + path.sep)) {
      const local = path.relative(folder, real).split(path.sep).join('/')
      return legacy ? `.assets/${ws.number}/${local}` : assetRef(local)
    }
    return path.relative(realPathOf(path.dirname(file)), real).split(path.sep).join('/')
  }
  const equivalent = new Map<string, string[]>()
  for (const source of new Set([...Object.keys(before), ...Object.keys(record.assets)])) {
    const name = taskAssetPath(source, ws.number ?? undefined)
    if (name !== null) equivalent.set(name, [...(equivalent.get(name) ?? []), source])
  }
  const keysOf = (source: string) => [source, ...(equivalent.get(taskAssetPath(source, ws.number ?? undefined) ?? '') ?? [])]
  const required = new Map<string, number>()
  for (const block of parsePreviewBlocks(body).blocks) {
    const contentStart = body.indexOf('>', block.start) + 1
    const content = body.slice(contentStart, body.lastIndexOf('</Preview', block.end - 1))
    const start = sourcePosition(body, contentStart).line
    const locations = new Map<string, number>()
    for (const ref of bodyReferences(content, (src, line) => {
      if (!locations.has(src)) locations.set(src, start + line - 1)
    })) {
      if (ref.types.length || isTaskAssetRef(ref.src) || /^file:/i.test(ref.src) || path.win32.isAbsolute(ref.src)) required.set(ref.src, locations.get(ref.src)!)
    }
  }
  try {
    let recoveredReferences = false
    const graph = await collect(body, file, {
      resolve: (src, owner) => {
        // 已有 artifact ID 只允许来自本任务清单。
        const id = Object.entries(before).find(([, ref]) => ref.artifact === src)
        if (id) return { key: id[0], file: null }
        const target = resolveBoardAsset(ws.board, projectStateDir(ws.board), ws.number, src, owner, owner !== file)
        if (!target) return null
        const key = canonical(target)
        if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) {
          const saved = (owner === file ? [src, ...keysOf(key)] : keysOf(key)).find(name => before[name]?.artifact)
          if (saved) return { key: saved, file: null }
          throw new Error(`file not found: ${target}`)
        }
        return { key, file: target }
      },
      read: (target, kind) => {
        if (fs.statSync(target).size > ASSET_FILE_LIMIT) throw new Error('This asset is over 100 MiB.')
        return referenceText(target, kind)
      },
      retained: (key, types) => {
        let dependencies = record.assets[key]?.dependencies ?? before[key]?.dependencies
        if (!dependencies && types.length === 1 && types[0] === 'studio' && before[key] && !recoveredReferences) {
          recoveredReferences = true
          dependencies = Object.keys(before).filter(src => src !== key)
        }
        return (dependencies ?? []).map(src => {
          const kind = record.assets[src]?.kind
          return { src, types: kind ? [kind] : [] }
        })
      },
    })
    for (const node of graph) {
      const aliases = [...node.aliases]
      const previous = [...aliases, ...keysOf(node.key)].map(key => record.assets[key]).find(Boolean)
      const old = [...aliases, ...keysOf(node.key)].map(key => before[key]).find(Boolean)
      const kind = node.kind as Kind
      let out: Sent | undefined
      const partialStudio = node.kind === 'studio' && (node.data as { version?: number })?.version === 2
      let why = node.error ?? (partialStudio ? undefined : [...node.dependencies.values()].map(key => refs[key]?.error).find(Boolean))
      if (!why && node.file) {
        try {
          if (fs.statSync(node.file).size > ASSET_FILE_LIMIT) throw new Error('This asset is over 100 MiB.')
          out = sentOf(node.file, kind, node.data)
        }
        catch (error) { why = renderError(error) }
      }
      if (!why && !node.file && old?.error && !old.version) why = old.error
      if (why) {
        const key = [...node.aliases].find(alias => required.has(alias))
        if (key) {
          const error = `${path.relative(ws.board, file)}:${required.get(key)} — ${key}: ${undrawn(ws, why)}`
          return { ok: false, code: 'bad_request', error, failure: makeFailure('validation', error, { code: 'preview_attachment', detail: error }) }
        }
        let pin: Assets[string] | null = old ? { ...old }
          : previous?.version ? { artifact: previous.artifact, version: previous.version, ...(previous.dependencies ? { dependencies: previous.dependencies } : {}) } : null
        if (!pin) {
          if (!ws.cloudTask) continue
          let artifact = previous?.artifact
          if (!artifact) {
            const made = await api.createArtifact(ws.cloudTask, node.key.slice(0, 200), kind, artifactKey(ws.cloudTask, node.key, kind))
            if (!made.ok) return { ...failed('create_artifact', made), error: `${node.key}: ${made.error}` }
            artifact = made.value.id
            for (const alias of node.aliases) record.assets[alias] = { artifact, kind, version: 0, hash: '' }
            hooks.save?.()
          }
          pin = { artifact }
        }
        for (const alias of node.aliases) refs[alias] = { ...pin, error: undrawn(ws, why) }
        continue
      }
      if (!node.file || !out) {
        if (old?.error && !old.version) for (const alias of node.aliases) refs[alias] = old
        else if (old) {
          let version = old.version ?? (previous?.artifact === old.artifact ? previous.version : undefined)
          if (version === undefined) {
            const art = await api.readArtifact(old.artifact)
            if (!art.ok) return art
            version = art.value.latest_version ?? 0
          }
          for (const alias of node.aliases) refs[alias] = { artifact: old.artifact, version, ...(old.dependencies ? { dependencies: old.dependencies } : {}) }
          const previewKey = documentPreviewKey(old.artifact, version)
          currentDocumentPreviews.add(previewKey)
          if (before[previewKey]) refs[previewKey] = before[previewKey]
        }
        continue
      }
      if (previous && previous.kind !== kind) {
        const artifact = await api.readArtifact(previous.artifact)
        if (!artifact.ok) return artifact
        if (!artifact.value.type) return { ok: false, code: 'bad_request', error: `${node.key}: The artifact type is missing.` }
        previous.kind = artifact.value.type
      }
      const manifest = fileManifest(kind, node.file)
      const json = !!manifest?.references && node.data !== undefined && typeof node.data !== 'string'
      if (manifest?.references && node.data !== undefined) {
        const map = (src: string) => {
          const key = node.dependencies.get(src)
          const artifact = key && refs[key]?.artifact
          return artifact ? artifact + (json ? '' : splitFileReference(src)[1]) : src
        }
        out = json
          ? { kind, type: 'application/json', bytes: Buffer.from(JSON.stringify(mapReferences(manifest, node.data, map))) }
          : { ...out, bytes: Buffer.from(mapReferences(manifest, node.data, map) as string) }
      }
      const hash = hashOf(out.bytes)
      let entry = previous
      const localHash = hashFile(node.file)
      const restored = json || (typeof node.data === 'string' && previous?.hash === localHash)
      const unchanged = restored && previous && (previous.kind ?? out.kind) === out.kind
        && localHash === (previous.localHash ?? previous.hash)
        && [...node.dependencies.values()].every(key => refs[key]?.artifact === before[key]?.artifact)
      if (!entry || (!unchanged && entry.hash !== hash) || (entry.kind && entry.kind !== out.kind)) {
        if (!ws.cloudTask) continue
        let artifact = previous && (previous.kind ?? kindOf(path.extname(node.file).toLowerCase())) === out.kind ? previous.artifact : undefined
        if (!artifact) {
          const made = await api.createArtifact(ws.cloudTask, node.key.slice(0, 200), out.kind, artifactKey(ws.cloudTask, node.key, out.kind, previous?.artifact))
          if (!made.ok) return { ...failed('create_artifact', made), error: `${node.key}: ${made.error}` }
          artifact = made.value.id
          for (const alias of node.aliases) record.assets[alias] = { artifact, kind: out.kind, version: 0, hash: '' }
          hooks.save?.()
        }
        record.pendingVersions ??= {}
        let pending = record.pendingVersions[node.key]
        if (pending?.artifact !== artifact || pending.hash !== hash) {
          const sent = await uploadAsset(api, artifact, out, hooks.failed)
          if (!sent.ok) return { ...sent, error: `${node.key}: ${sent.error}` }
          pending = record.pendingVersions[node.key] = { artifact, hash, upload: sent.value }
          hooks.save?.()
        }
        const version = await finishAssetVersion(api, record, node.key, pending, hooks)
        if (!version.ok) return version
        entry = { artifact, version: version.value, hash, kind: out.kind }
      }
      entry = { ...entry, localHash: localHash ?? undefined, dependencies: [...node.dependencies.values()] }
      let changed = false
      for (const alias of node.aliases) {
        if (!isDeepStrictEqual(record.assets[alias], entry)) {
          record.assets[alias] = entry
          changed = true
        }
        refs[alias] = { artifact: entry.artifact, version: entry.version, ...(entry.dependencies?.length || /\.(html?|css|json|tsx|tmx|tmj|tsj)$/i.test(alias) ? { dependencies: entry.dependencies ?? [] } : {}) }
      }
      if (changed) hooks.save?.()
      const office = out.kind === 'asset' && officeExtension(node.file)
      if (office && entry.version > 0) {
        const key = documentPreviewKey(entry.artifact, entry.version)
        currentDocumentPreviews.add(key)
        const preview = before[key]?.version ? { ok: true as const, value: before[key] } : await hooks.document?.(key, office, out.bytes) ?? { ok: true as const, value: undefined }
        if (!preview.ok) {
          if (finishedPreviewWrite(preview)) return preview
          retryPreviews ||= temporaryCloudFailure(preview)
          hooks.documentUnavailable?.(preview.error)
          continue
        }
        if (preview.value) {
          refs[key] = preview.value
          for (const alias of node.aliases) {
            const ref = refs[alias]!
            ref.dependencies = [...(ref.dependencies ?? []), key]
          }
        }
      }
    }
    for (const name of Object.keys(record.assets)) {
      if (isDocumentPreview(name) && !refs[name]) delete record.assets[name]
    }
    for (const name of Object.keys(record.pendingVersions ?? {})) {
      if (isDocumentPreview(name) && !currentDocumentPreviews.has(name)) delete record.pendingVersions![name]
    }
  } catch (error) {
    return { ok: false, code: 'bad_request', error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, value: { refs, retryPreviews } }
}
