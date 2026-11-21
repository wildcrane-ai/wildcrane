import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { parseReview, type StudioReview } from '../../../artifact-sdk/src/internal/format/studio'
import { readStudioFolder } from '../lib/agent/studio-folder'
import { checkStudioFiles, hashInput, VERSION_FILE, FILE_LIMITS, formatStudioProblem, type StudioFiles } from '../lib/shared/studio-files'
import { locate } from '../lib/cards'
import { ASSETS, die } from '../lib/paths'
import { translating } from '../lib/agent/language'
import { say } from '../lib/io'
import type { MoveResult } from '../lib/types'

const readVersion = (files: StudioFiles) => {
  if (files[VERSION_FILE] === undefined) return null
  try {
    const v = JSON.parse(files[VERSION_FILE]!)
    if (typeof v.id === 'string' && v.id && Number.isInteger(v.version) && v.version > 0) return { id: v.id as string, version: v.version as number }
  } catch {}
  throw Error('version.json: invalid Studio version')
}
function readFolder(folder: string, baseline = false) {
  const root = fs.realpathSync(folder)
  let count = 0, total = 0
  const scan = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const file = path.join(dir, e.name)
      if (e.isSymbolicLink()) throw Error(`${file}: symbolic links are not allowed`)
      if (e.isDirectory()) scan(file)
      else {
        const size = fs.statSync(file).size
        total += size
        if (++count > FILE_LIMITS.count || size > FILE_LIMITS.file || total > FILE_LIMITS.total) throw Error(`${file}: Studio file limit exceeded`)
      }
    }
  }
  scan(root)
  const files = readStudioFolder(root), checked = checkStudioFiles(files, readVersion(files)?.id.startsWith('wf_builtin_') === true, { allowLegacyLand: baseline })
  if (!checked.ok) die(`${folder}/${formatStudioProblem(checked)}`, 'studio-problems')
  const fingerprint = createHash('sha256').update(hashInput({ ...checked.files, ...(files[VERSION_FILE] ? { [VERSION_FILE]: files[VERSION_FILE]! } : {}) })).digest('hex')
  return { files, def: checked.def, fingerprint }
}
function unified(before: string | null, after: string | null, file: string, folder: string): string {
  const a = path.join(folder, 'a'), b = path.join(folder, 'b')
  fs.writeFileSync(a, before ?? ''); fs.writeFileSync(b, after ?? '')
  const result = spawnSync('git', ['diff', '--no-index', '--text', '--no-ext-diff', '--no-color', '--unified=3', before === null ? '/dev/null' : a, after === null ? '/dev/null' : b], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error || (result.status !== 0 && result.status !== 1)) throw Error(`${file}: ${result.error?.message ?? result.stderr}`)
  const lines = result.stdout.split('\n'), start = lines.findIndex(l => l.startsWith('--- '))
  return `--- ${before === null ? '/dev/null' : 'a/' + file}\n+++ ${after === null ? '/dev/null' : 'b/' + file}\n${start < 0 ? '' : lines.slice(start + 2).join('\n')}`
}
export async function cmdStudioPreview(id: number, opts: { folder: string; base: string }): Promise<MoveResult> {
  if (!locate(id)) die(`no card ${id}`, 'no-such-card')
  const destination = path.join(ASSETS, String(id), 'studio-review'), staging = `${destination}.${randomUUID()}.tmp`, backup = `${destination}.${randomUUID()}.previous`
  let moved = false
  try {
    const draft = readFolder(path.resolve(opts.folder)), base = opts.base === 'empty' ? null : readFolder(path.resolve(opts.base), true)
    const version = readVersion(draft.files), baseVersion = base && readVersion(base.files)
    if (base ? !version || !baseVersion || JSON.stringify(version) !== JSON.stringify(baseVersion) : version !== null) throw Error('version.json: existing Studios need matching baseline and draft versions; use --base empty only for a new Studio without version.json')
    fs.mkdirSync(staging, { recursive: true })
    const review: StudioReview = { version: 2, base: base && baseVersion ? { ...baseVersion, fingerprint: base.fingerprint } : null, fingerprint: draft.fingerprint, files: [] }
    const save = (file: string, bytes: string | Buffer) => {
      const target = path.join(staging, file)
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes)
      return file
    }
    const paths = [...new Set([...Object.keys(base?.files ?? {}), ...Object.keys(draft.files)])].filter(p => p !== VERSION_FILE).sort()
    for (const [i, file] of paths.entries()) {
      const before = base?.files[file] ?? null, after = draft.files[file] ?? null
      review.files.push({ path: file, before: before === null ? null : save(`files/${i}/before.txt`, before), after: after === null ? null : save(`files/${i}/after.txt`, after), ...(before !== after ? { diff: save(`files/${i}/change.diff`, unified(before, after, file, staging)) } : {}) })
    }
    for (const p of ['a', 'b']) fs.rmSync(path.join(staging, p), { force: true })
    if (!parseReview(review)) throw Error('generated review is invalid')
    save('review.json', JSON.stringify(review, null, 2) + '\n')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    if (fs.existsSync(destination)) { fs.renameSync(destination, backup); moved = true }
    fs.renameSync(staging, destination); fs.rmSync(backup, { recursive: true, force: true })
    const tag = `<Studio src=".assets/${id}/studio-review/review.json" />`
    const prefix = `.assets/${id}/studio-review/`
    const attachments = review.files.filter(f => f.path !== 'STUDIO.md' && f.diff)
    const asset = (src: string, label: string) => `<Asset src="${prefix}${src}" label="${label.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}" />`
    const items = attachments.flatMap(f => [asset(f.diff!, f.path), ...(f.after ? [asset(f.after, f.path)] : [])]).join('\n\n')
    const files = attachments.length >= 3 ? `<Set label="${translating() ? '附属文件' : 'Files'}">\n\n${items}\n\n</Set>` : items
    say([tag, files].filter(Boolean).join('\n\n'))
    return { file: path.join(destination, 'review.json'), tag, files }
  } catch (error) {
    if (moved && !fs.existsSync(destination)) fs.renameSync(backup, destination)
    if (error && typeof error === 'object' && 'kind' in error) throw error
    die(error instanceof Error ? error.message : String(error), 'bad-args')
  } finally { fs.rmSync(staging, { recursive: true, force: true }) }
}
