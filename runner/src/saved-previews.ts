import fs from 'node:fs'
import path from 'node:path'
import { bodyReferences } from '../../artifact-sdk/src/internal/references'
import { reviewPreviewIds, type ReviewPlan, type SavedPreviewInputs } from '../../cli/src/lib/shared/review-plan'
import type { Call } from './api'
import { syncStopped } from './sync-retry'
import { readAsset } from './task-folder'

export async function stageSavedPreviews(
  directory: string, inputs: SavedPreviewInputs, plan: ReviewPlan, stopped: () => boolean,
  custom: readonly string[] = [], frozen: readonly string[] = [],
): Promise<Call<string | undefined>> {
  const saved = Object.keys(inputs.sections)
  const planned = reviewPreviewIds(plan)
  const ids = (planned.length ? [...new Set([...planned, ...saved.filter(id => custom.includes(id))])] : saved)
    .filter(id => !frozen.includes(id))
  if (!ids.length) return { ok: true, value: undefined }

  const invalid = (name: string) => ({ ok: false as const, code: 'bad_request', error: `Sync the saved Preview and its assets first: ${name}` })
  const files = new Map<string, { artifact: string; version: number; file: string }>()
  const sections: string[] = []
  for (const id of ids) {
    const section = Object.hasOwn(inputs.sections, id) ? inputs.sections[id] : undefined
    if (!section) return invalid(id)
    const required = new Set(bodyReferences(section.body).filter(ref => ref.types.length).map(ref => ref.src))
    const sources = new Set(section.sources)
    const attachments: string[] = []
    for (const source of sources) {
      if (stopped()) return syncStopped
      const asset = Object.hasOwn(inputs.assets, source) ? inputs.assets[source] : undefined
      if (!asset && !required.has(source) && !source.startsWith('.assets/')) continue
      if (!asset || asset.error || asset.status === 'pending' || asset.status === 'failed'
        || !/^art_[a-z0-9]+$/i.test(asset.artifact) || !Number.isSafeInteger(asset.version) || asset.version! < 1) return invalid(source)
      for (const dependency of asset.dependencies ?? []) {
        sources.add(dependency)
        required.add(dependency)
      }

      let savedFile = files.get(source)
      if (!savedFile) {
        const version = asset.version!
        const bytes = await readAsset(asset.artifact, version)
        if (!bytes.ok) return { ...bytes, error: `${source} (saved version ${version}): ${bytes.error}` }
        const extension = path.posix.extname(source).toLowerCase()
        const suffix = extension === '.tsx' && /^\s*(?:<!doctype html|<html)\b/i.test(Buffer.from(bytes.value.subarray(0, 256)).toString())
          ? '.html' : /^\.[a-z0-9]+$/.test(extension) ? extension : ''
        const file = path.join(directory, `${files.size + 1}-${asset.artifact}-${version}${suffix}`)
        fs.writeFileSync(file, bytes.value)
        savedFile = { artifact: asset.artifact, version, file }
        files.set(source, savedFile)
      }
      attachments.push(`- ${JSON.stringify(source)} · ${savedFile.artifact}, version ${savedFile.version} · ${JSON.stringify(savedFile.file)}`)
    }
    sections.push(`## ${id}\n\n${section.body}${attachments.length ? '\n\nPinned files:\n' + attachments.join('\n') : ''}`)
  }
  const manifest = path.join(directory, 'previews.md')
  fs.writeFileSync(manifest, sections.join('\n\n') + '\n')
  return { ok: true, value: manifest }
}
