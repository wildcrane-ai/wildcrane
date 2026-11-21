import { parseDocument } from 'yaml'
import { sharedMemory } from '../agents/shared-memory'

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BoardError } from '../io'
import { tryLock } from '../lock'
import { projectStateDir, stateRootOf } from '../machine/project'
import { BOARD_FILE_LIMIT, isBoardPath, numberOfCard } from './board-files'
import { linkedProject } from '../cloud/tasks'
import { parseFrontmatter } from '../frontmatter'

export interface Version { content: string | null; seq: number }
export interface BoardWrite { path: string; content: string | null; base_seq: number }
export interface BoardFile extends Version { path: string }
export interface Receipt { head_seq: number; files: { path: string; seq: number }[] }
export interface ConflictFile {
  path: string
  remotePath: string
  conflicted: boolean
  reason: string | null
  base: Version
  local: { content: string | null }
  remote: Version
  automatic?: { content: string | null }
}
interface Draft {
  revision: string
  files: { path: string; content: string | null }[]
  working: (string | null)[]
  writes: BoardWrite[]
}
export interface ConflictRecord {
  id: string
  project: string
  state: 'open' | 'unconfirmed' | 'resolved'
  files: ConflictFile[]
  receipt: Receipt | null
  draft?: Draft
  history?: { files: ConflictFile[]; draft?: Draft }[]
  error?: string
}
export interface ConflictTransport {
  read(project: string): Promise<{ ok: true; value: { head_seq: number; files: BoardFile[] } } | { ok: false; error: string; code?: string }>
  commit(project: string, files: BoardWrite[]): Promise<{ ok: true; value: Receipt } | { ok: false; error: string; code?: string; files?: BoardFile[] }>
  held(): Promise<boolean>
}
const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const folder = (board: string) => path.join(projectStateDir(board), 'conflicts')
const fileOf = (board: string, id: string) => {
  if (!/^c_[a-f0-9]{32}$/.test(id)) throw new BoardError('Unknown board conflict.', { kind: 'conflict-not-found', id })
  return path.join(folder(board), `${id}.json`)
}
export function atomicJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  const fd = fs.openSync(temp, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(temp, file)
}
export function boardTextAt(board: string, name: string): string | null {
  if (!isBoardPath(name)) throw new BoardError(`Invalid board path: ${name}`, { kind: 'invalid-usage' })
  const file = path.join(board, name)
  let ancestor = file
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor)
  const real = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, file))
  if (!real.startsWith(fs.realpathSync(board) + path.sep)) throw new BoardError(`Link outside the board: ${name}`, { kind: 'invalid-usage' })
  if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > BOARD_FILE_LIMIT) throw new BoardError(`${name} exceeds the board file limit.`, { kind: 'cloud-refused' })
  try { return fs.readFileSync(file, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}
function save(board: string, record: ConflictRecord): void { atomicJson(fileOf(board, record.id), record) }
function read(board: string, id: string): ConflictRecord {
  const file = fileOf(board, id)
  if (!fs.existsSync(file)) throw new BoardError('Unknown board conflict.', { kind: 'conflict-not-found', id })
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as ConflictRecord
    if (r.id !== id || !r.project || !['open', 'unconfirmed', 'resolved'].includes(r.state) || !Array.isArray(r.files) || !r.files.length) throw Error()
    const names = new Set<string>()
    for (const f of r.files) {
      if (!isBoardPath(f.path) || names.has(f.path) || (f.remotePath !== `projects/${r.project}/${f.path}` && !(f.path.startsWith('memory/') && f.remotePath === f.path))) throw Error()
      names.add(f.path)
      if (typeof f.conflicted !== 'boolean' || !f.local || !(f.local.content === null || typeof f.local.content === 'string')) throw Error()
      if (f.automatic && !(f.automatic.content === null || typeof f.automatic.content === 'string')) throw Error()
      for (const v of [f.base, f.remote]) if (!v || !Number.isSafeInteger(v.seq) || v.seq < 0 || !(v.content === null || typeof v.content === 'string')) throw Error()
    }
    if (r.state !== 'open' && (!r.draft || !Array.isArray(r.draft.writes) || r.draft.writes.length !== r.files.length || !Array.isArray(r.draft.working) || r.draft.working.length !== r.files.length)) throw Error()
    if (r.state !== 'open' && (!r.draft!.writes.every(w => w && r.files.some(f => f.remotePath === w.path) && Number.isSafeInteger(w.base_seq) && w.base_seq >= 0 && (w.content === null || typeof w.content === 'string'))
      || new Set(r.draft!.writes.map(w => w.path)).size !== r.files.length || r.draft!.working.some(c => c !== null && typeof c !== 'string') || !Array.isArray(r.draft!.files) || typeof r.draft!.revision !== 'string')) throw Error()
    if (r.receipt && (!Number.isSafeInteger(r.receipt.head_seq) || !Array.isArray(r.receipt.files) || !r.files.every(f => r.receipt!.files.some(v => v.path === f.remotePath && Number.isSafeInteger(v.seq) && v.seq >= 0)))) throw Error()
    if (r.state === 'resolved' && !r.receipt) throw Error()
    return r
  } catch { throw new BoardError(`Cannot read board conflict ${id}. Preserve its record for recovery.`, { kind: 'cloud-refused', id }) }
}
export function conflictRecords(board: string): ConflictRecord[] {
  let names: string[]
  try { names = fs.readdirSync(folder(board)) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  return names.filter(n => n.endsWith('.json')).sort().map(n => read(board, n.slice(0, -5)))
}
export const pendingConflicts = (board: string) => conflictRecords(board).filter(r => r.state !== 'resolved')
export const conflictList = (board: string) => pendingConflicts(board).map(({ id, state, files }) => ({ id, state, paths: files.filter(f => f.conflicted).map(f => f.path) }))
export function conflictShow(board: string, id: string) {
  const record = read(board, id)
  const files = record.files.map(({ remotePath: _, automatic: _automatic, ...f }) => ({ ...f, working: { content: boardTextAt(board, f.path) } }))
  return { id: record.id, state: record.state, files, receipt: record.receipt,
    revision: digest({ record, working: files.map(f => f.working) }),
    ...(record.draft ? { draft: { revision: record.draft.revision, record: fileOf(board, id), field: 'draft.files' } } : {}),
    ...(record.error ? { error: record.error } : {}),
  }
}
export function conflictPrompt(board: string, work = 'Continue the original work from its saved position; preserve completed work.'): string {
  const records = conflictList(board)
  return records.length ? ['Resolve these saved board content conflicts using `akb guide resolve-conflict` before continuing.',
    ...records.map(r => `${r.id}: ${r.paths.join(', ')}; read with akb raw conflict show ${r.id}.`), work].join('\n') : ''
}
export function captureConflict(board: string, project: string, files: ConflictFile[]): ConflictRecord {
  const pending = pendingConflicts(board)[0]
  if (pending) return pending
  const record: ConflictRecord = { id: `c_${crypto.randomUUID().replaceAll('-', '')}`, project, state: 'open', files, receipt: null }
  save(board, record)
  return record
}

/** Shared by synchronization and explicit resolution, never held across an agent process. */
export async function withSyncLock<T>(board: string, work: () => Promise<T>): Promise<T> {
  const lock = path.join(projectStateDir(board), 'board-sync.lock')
  const until = Date.now() + 60_000
  let release: (() => void) | undefined
  while (!(release = tryLock(lock))) {
    if (Date.now() >= until) throw new BoardError('Another process is synchronizing this board. Try again.', { kind: 'board-busy' })
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  try { return await work() } finally { release() }
}
function refuse(record: ConflictRecord, message: string, kind = 'conflict'): never {
  throw new BoardError(message, { kind, id: record.id, read: `akb raw conflict show ${record.id}` })
}
function resolutionOf(record: ConflictRecord, value: unknown): { path: string; content: string | null }[] {
  if (!value || typeof value !== 'object' || Object.keys(value).join() !== 'files' || !Array.isArray((value as { files?: unknown }).files)) refuse(record, 'Expected {"files":[{"path":"...","content":"..."}]} .', 'invalid-usage')
  const files = (value as { files: { path: string; content: string | null }[] }).files
  const required = new Set(record.files.filter(f => f.conflicted).map(f => f.path))
  if (files.length !== required.size) refuse(record, 'Resolve each conflicting path exactly once.', 'invalid-usage')
  for (const f of files) {
    if (!f || Object.keys(f).sort().join() !== 'content,path' || !required.delete(f.path) || !(f.content === null || typeof f.content === 'string')) refuse(record, 'Invalid or repeated resolution path or content.', 'invalid-usage')
    if (f.content !== null && Buffer.byteLength(f.content) > BOARD_FILE_LIMIT) refuse(record, `${f.path} exceeds the board file limit.`, 'cloud-refused')
    if (f.content && /^(?:<{7}|={7}|>{7})(?:\s|$)/m.test(f.content)) refuse(record, 'Remove Git conflict markers before submitting.', 'invalid-usage')
    const saved = record.files.find(x => x.path === f.path)!
    if (saved.remote.content === null && saved.base.content !== null && f.content !== null && (numberOfCard(f.path) !== null || f.path.startsWith('triage/'))) refuse(record, `This path was removed or moved: ${f.path}. Preserve the local draft outside the board.`, 'cloud-refused')
    if (numberOfCard(f.path) !== null && f.content !== null) {
      const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(f.content)?.[1]
      const parsed = parseDocument(front ?? '')
      const fields = parsed.toJS() as Record<string, unknown> | null
      if (!front || parsed.errors.length || !fields || typeof fields.title !== 'string' || ['title', 'priority', 'status', 'blocked_by', 'related', 'modules', 'questions'].some(key => !(key in fields))
        || ['blocked_by', 'related', 'modules', 'questions'].some(key => !Array.isArray(fields[key]))
        || (fields.modules as unknown[]).some(v => typeof v !== 'string')
        || ['blocked_by', 'related'].some(key => (fields[key] as unknown[]).some(v => !Number.isSafeInteger(v) || Number(v) < 1))) refuse(record, `Invalid card metadata: ${f.path}`, 'invalid-usage')
      const meta = parseFrontmatter(f.content).meta
      if (!meta?.title?.trim() || !['todo', 'ready', 'implementing'].includes(meta.status) || !['high', 'med', 'low'].includes(meta.priority)) refuse(record, `Invalid card metadata: ${f.path}`, 'invalid-usage')
      if (meta.status === 'ready' && meta.questions.length) refuse(record, 'A ready card cannot have open questions.', 'invalid-usage')
      const remote = parseFrontmatter(record.files.find(x => x.path === f.path)!.remote.content ?? '').meta
      for (const key of ['preview_approved', 'restored', 'archived', 'rejected'] as const) {
        const supplied = meta[key]
        const local = parseFrontmatter(record.files.find(x => x.path === f.path)!.local.content ?? '').meta
        if (supplied !== remote?.[key] && supplied !== local?.[key]) refuse(record, `Use the card operation to change ${key}.`, 'cloud-refused')
      }
    }
  }
  return record.files.filter(f => f.conflicted).map(f => files.find(v => v.path === f.path)!)
}
function updateFacts(board: string, r: ConflictRecord, remote: BoardFile[]): void {
  r.history ??= []
  r.history.push({ files: r.files, draft: r.draft })
  r.files = r.files.map(f => {
    const next = remote.find(v => v.path === f.remotePath)
    if (!next || next.seq === f.remote.seq && next.content === f.remote.content) return f
    return { ...f, remote: { seq: next.seq, content: next.content }, conflicted: true, reason: next.content === null || f.local.content === null ? 'edit-delete' : 'both-modified' }
  })
  r.state = 'open'
  save(board, r)
}
function confirmLocal(board: string, r: ConflictRecord): void {
  const draft = r.draft!
  const root = stateRootOf(board)
  const file = path.join(root, '.akb', 'base.json')
  const base = JSON.parse(fs.readFileSync(file, 'utf8')) as { project?: string; files: Record<string, Version>; deleted?: Record<string, number> }
  if (base.project && base.project !== r.project) refuse(r, 'The project binding changed.', 'cloud-refused')
  base.deleted ??= {}
  for (const [i, f] of r.files.entries()) {
    const sent = draft.writes.find(w => w.path === f.remotePath)!
    const seq = r.receipt!.files.find(v => v.path === f.remotePath)!.seq
    const current = base.files[f.remotePath]
    if ((current?.seq ?? base.deleted[f.remotePath] ?? 0) > seq) continue
    if (sent.content === null) { delete base.files[f.remotePath]; base.deleted[f.remotePath] = seq }
    else { base.files[f.remotePath] = { seq, content: sent.content }; delete base.deleted[f.remotePath] }
    if (boardTextAt(board, f.path) !== draft.working[i]) continue
    const local = path.join(board, f.path)
    if (sent.content === null) fs.rmSync(local, { force: true })
    else { fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, sent.content) }
  }
  atomicJson(file, base)
  r.state = 'resolved'
  save(board, r)
}
export async function resolveConflict(board: string, project: string, id: string, expect: string, value: unknown, transport: ConflictTransport) {
  return withSyncLock(board, async () => {
    const r = read(board, id)
    const binding = () => {
      const current = linkedProject(board, stateRootOf(board))
      if (!current.ok || current.value !== project || r.project !== project) refuse(r, 'The current project binding does not match this conflict.', 'cloud-refused')
    }
    binding()
    const shared = sharedMemory(board)
    if (r.files.some(f => f.remotePath !== (f.path.startsWith('memory/') && shared(f.path.slice('memory/'.length)) ? f.path : `projects/${project}/${f.path}`))) refuse(r, 'File ownership changed. Preserve this batch and check the current binding.', 'cloud-refused')
    const files = resolutionOf(r, value)
    if (r.state === 'resolved') {
      if (!r.receipt || digest(files) !== digest(r.draft?.files) || expect !== r.draft?.revision) refuse(r, 'This conflict is already resolved. Read the current board before changing it.')
      return { id, state: r.state, receipt: r.receipt }
    }
    if (!await transport.held()) refuse(r, 'The current execution no longer owns this work.', 'cloud-refused')
    if (r.state === 'unconfirmed' && (digest(files) !== digest(r.draft?.files) || expect !== r.draft?.revision && expect !== conflictShow(board, id).revision)) refuse(r, 'Confirm the saved submission before changing its resolution.', 'unconfirmed')
    // A recorded receipt wins over an interrupted local writeback.
    if (r.receipt) { confirmLocal(board, r); return { id, state: r.state, receipt: r.receipt } }
    if (r.state === 'unconfirmed') {
      const remote = await transport.read(project)
      if (!remote.ok) refuse(r, `Cannot confirm the previous submission: ${remote.error}`, 'unconfirmed')
      const matches = r.draft!.writes.every(w => (remote.value.files.find(f => f.path === w.path)?.content ?? null) === w.content)
      if (matches) {
        r.receipt = { head_seq: remote.value.head_seq, files: r.draft!.writes.map(w => ({ path: w.path, seq: remote.value.files.find(f => f.path === w.path)?.seq ?? w.base_seq })) }
        save(board, r)
        confirmLocal(board, r)
        return { id, state: r.state, receipt: r.receipt }
      }
      // No blind resend after an ambiguous request: a later edit could hide an accepted write.
      refuse(r, 'The previous submission cannot be confirmed against the current board. Preserve the draft and inspect its versions.', 'unconfirmed')
    }
    const shown = conflictShow(board, id)
    const working = r.files.map(f => boardTextAt(board, f.path))
    if (shown.revision !== expect) {
      r.history ??= []; r.history.push({ files: r.files, draft: { revision: expect, files, working, writes: [] } }); save(board, r)
      refuse(r, 'The conflict or local files changed. Read it again before resolving.')
    }
    if (r.files.some((f, i) => !f.conflicted && working[i] !== f.local.content)) {
      r.history ??= []; r.history.push({ files: r.files, draft: r.draft })
      r.files = r.files.map((f, i) => !f.conflicted && working[i] !== f.local.content ? { ...f, conflicted: true, reason: 'local-changed' } : f)
      r.draft = { revision: expect, files, working, writes: [] }; save(board, r)
      refuse(r, 'Another batch member changed locally. Read the conflict again.')
    }
    const writes = r.files.map(f => ({ path: f.remotePath, content: files.some(v => v.path === f.path) ? files.find(v => v.path === f.path)!.content : f.automatic ? f.automatic.content : f.local.content, base_seq: f.remote.seq }))
    r.draft = { revision: expect, files, working, writes }
    save(board, r)
    // Validate every member, including unchanged members, before the atomic commit.
    const remote = await transport.read(project)
    if (!remote.ok) refuse(r, remote.error, 'cloud-refused')
    const versions = r.files.map(f => remote.value.files.find(v => v.path === f.remotePath) ?? { path: f.remotePath, seq: 0, content: null })
    if (versions.some((v, i) => v.seq !== r.files[i]!.remote.seq || v.content !== r.files[i]!.remote.content)) {
      updateFacts(board, r, versions)
      refuse(r, 'Cloud versions changed. Read the saved conflict again.')
    }
    if (working.some((text, i) => boardTextAt(board, r.files[i]!.path) !== text)) refuse(r, 'Local files changed during validation. Read the conflict again.')
    if (!await transport.held()) refuse(r, 'The current execution no longer owns this work.', 'cloud-refused')
    binding()
    if (working.some((text, i) => boardTextAt(board, r.files[i]!.path) !== text)) refuse(r, 'Local files changed before submission. Read the conflict again.')
    r.state = 'unconfirmed'; save(board, r)
    const sent = await transport.commit(project, writes)
    if (!sent.ok) {
      r.error = sent.error
      if (sent.files) { updateFacts(board, r, sent.files); refuse(r, sent.error) }
      if (sent.code) { r.state = 'open'; save(board, r); refuse(r, sent.error, 'cloud-refused') }
      save(board, r); refuse(r, sent.error, 'unconfirmed')
    }
    if (!writes.every(w => sent.value.files.some(f => f.path === w.path && Number.isSafeInteger(f.seq)))) refuse(r, 'The commit receipt is incomplete.', 'unconfirmed')
    r.receipt = sent.value
    save(board, r)
    confirmLocal(board, r)
    return { id, state: r.state, receipt: r.receipt }
  })
}
