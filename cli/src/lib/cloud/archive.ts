import fs from 'node:fs'
import path from 'node:path'
import { assetsFile, BOARD_FILE_LIMIT, numberOfCard } from '../shared/board-files'
import { normalizeCardFrontmatter, parseFrontmatter } from '../frontmatter'
import { assetsOf, assetsText, uploadTaskAssets, type AssetApi, type AssetRecord } from './task-assets-upload'
import { call } from './tasks'
import { cloudError, temporaryCloudFailure } from './response'

import type { ArchiveInput } from '../shared/delivery-evidence'

const q = encodeURIComponent
const artifactRoute = (artifact: string) => `/v1/artifacts/${q(artifact)}`
const assetApi: AssetApi = {
  readArtifact: artifact => call('GET', artifactRoute(artifact)),
  createArtifact: (task, name, type, key) => call('POST', `/v1/tasks/${q(task)}/artifacts`, { name, type }, key),
  createUpload: (artifact, content_type, size) => call('POST', artifactRoute(artifact) + '/uploads', { content_type, size }),
  upload: (url, bytes, type) => call('PUT', url, new Blob([Buffer.from(bytes)], { type })),
  completeUpload: url => call('POST', url),
  createVersion: (artifact, upload) => call('POST', artifactRoute(artifact) + '/versions', { upload }, `runner-version-${upload}`),
}

function readOptional(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function prepareLocalArchiveInput(board: string, project: string, task: string, number: number, file: string): () => Promise<ArchiveInput> {
  const refuse = (code: string, message: string): never => { throw cloudError({ code, message, retryable: false }) }
  const base = JSON.parse(fs.readFileSync(path.join(board, '..', 'base.json'), 'utf8')) as {
    files?: Record<string, { seq: number; content: string }>
    deleted?: Record<string, number>
  }
  const root = `projects/${project}/`
  const cardPath = path.relative(board, file).split(path.sep).join('/')
  const original = fs.readFileSync(file, 'utf8')
  const content = normalizeCardFrontmatter(original)
  const meta = parseFrontmatter(content).meta
  if (!meta || meta.rejected || !!meta.archived !== cardPath.startsWith('.archive/')) {
    refuse('conflict', 'The local task card is ineligible. Repair its frontmatter or restore the removed task before archiving.')
  }
  if (meta?.questions.length) refuse('conflict', 'Resolve the open questions before archiving.')
  if (Buffer.byteLength(content) > BOARD_FILE_LIMIT) refuse('payload_too_large', 'The card is too large. Move long results into attachments and retry.')
  const tracked = Object.entries(base.files ?? {}).filter(([name]) => name.startsWith(root)
    && numberOfCard(name.slice(root.length)) === number)
  const card = tracked.find(([name]) => name === root + cardPath) ?? (tracked.length === 1 ? tracked[0] : undefined)
  if (!card) return refuse('version_conflict', 'The local card has no synchronized version. Refresh the linked board and retry archiving.')
  const manifest = root + assetsFile(task)
  const saved = base.files?.[manifest]
  const previous = assetsOf(saved?.content)
  const manifestFile = path.join(board, assetsFile(task))
  const local = readOptional(manifestFile)
  const record: AssetRecord = JSON.parse(readOptional(path.join(board, '.sync', task + '.json')) ?? '{}')
  record.assets ??= {}
  return async () => {
    const uploaded = await uploadTaskAssets({ board, number, cloudTask: task }, file, content, record, { ...previous, ...assetsOf(local) }, assetApi)
    if (!uploaded.ok) {
      throw cloudError({
        code: uploaded.code ?? 'unreachable', status: uploaded.status,
        message: `${uploaded.error} Fix the attachment or reconnect to Cloud, then retry archiving.`,
        retryable: temporaryCloudFailure(uploaded),
      })
    }
    if (readOptional(file) !== original || readOptional(manifestFile) !== local) {
      refuse('version_conflict', 'The local card or attachment list changed during archiving. Read the current files and try again.')
    }
    const assets = assetsText(uploaded.value.refs)
    return {
      card: { path: cardPath, content, base_seq: card[1].seq },
      ...(assets !== assetsText(previous) ? { assets: { content: assets, base_seq: saved?.seq ?? base.deleted?.[manifest] ?? 0 } } : {}),
    }
  }
}
