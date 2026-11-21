import fs from 'node:fs'
import path from 'node:path'
import { fileManifest, splitFileReference } from '../../artifact-sdk/src/internal/file-references'
import { mapReferences } from '../../artifact-sdk/src/internal/manifest'
import { kindOf } from '../../artifact-sdk/src/internal/references'
import { approvedUiFile, approvedUiPin, approvedUiSource, validUiPin, type approvedUiPreviews } from '../../cli/src/lib/agent/approved-ui'
import type { Call } from './api'
import { syncStopped } from './sync-retry'
import { readAsset } from './task-folder'

export async function stageApprovedUi(
  directory: string, previews: ReturnType<typeof approvedUiPreviews>, stopped: () => boolean, chinese = false,
): Promise<Call<void>> {
  for (const preview of previews) {
    const visited = new Set<string>()
    const stage = async (source: string): Promise<Call<void>> => {
      if (stopped()) return syncStopped
      if (visited.has(source)) return { ok: true, value: undefined }
      visited.add(source)
      const pin = approvedUiPin(preview.pins, source)
      const context = [chinese ? `审核修订 ${preview.revision}` : `review revision ${preview.revision}`,
        ...(typeof pin.artifact === 'string' && pin.artifact ? [pin.artifact] : []),
        ...(typeof pin.version === 'number' ? [chinese ? `版本 ${pin.version}` : `version ${pin.version}`] : []),
      ].join(', ')
      const label = `${source} (${context})`
      if (!validUiPin(pin)) {
        const reason = pin.error || (chinese ? '缺少获批的文件版本。' : 'Missing approved asset version.')
        return { ok: false, code: 'bad_request', error: `${label}: ${reason}` }
      }
      const kind = kindOf(path.posix.extname(splitFileReference(source)[0]).toLowerCase())
      const bytes = await readAsset(pin.artifact, pin.version, kind === 'html' ? 'html' : undefined)
      if (!bytes.ok) return { ...bytes, error: `${label}: ${bytes.error}` }
      const target = approvedUiFile(directory, preview, source)
      const manifest = fileManifest(kind, source)
      let content = bytes.value
      if (kind === 'html' || manifest?.name === 'css') {
        const dependencies = new Set<string>()
        const rewritten = mapReferences(manifest, Buffer.from(content).toString(), src => {
          const child = approvedUiSource(preview.pins, src, source)
          dependencies.add(child)
          const local = approvedUiFile(directory, preview, child)
          const relative = path.relative(path.dirname(target), local).split(path.sep)
            .map(part => encodeURIComponent(part).replace(/['()]/g, char => `%${char.charCodeAt(0).toString(16)}`)).join('/')
          return relative + splitFileReference(src)[1]
        }) as string
        for (const child of dependencies) {
          const result = await stage(child)
          if (!result.ok) return result
        }
        content = Buffer.from(rewritten)
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
      return { ok: true, value: undefined }
    }
    for (const file of preview.files) {
      const result = await stage(file.source)
      if (!result.ok) return result
    }
  }
  return { ok: true, value: undefined }
}
