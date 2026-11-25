import fs from 'node:fs'
import path from 'node:path'
import type * as api from './api'
import type { Job } from './api'
import type { Goal } from '../../cli/src/lib/shared/goal'
import { readGoalDraft, writeGoalDraft } from '../../cli/src/lib/goal-draft'
import { runnerHome } from './home'
import { migrateGoalData, type SavedGoalData } from './goal-migration'
import { readSession } from '../../cli/src/lib/cloud/session'
import { accountGeneration } from './settings-control'

export const goalsFileOf = (job: Pick<Job, 'id'>) => path.join(runnerHome(), 'goals', `${job.id}.json`)

export async function writeGoals(
  job: Job & { discussion: NonNullable<Job['discussion']> }, list: typeof api.listStudios,
  preserveGoals = false, sourceId?: string | null,
): Promise<{ file: string; preserved: boolean } | { error: string }> {
  const file = goalsFileOf(job)
  try {
    const ids = sourceId && sourceId !== job.id ? [job.id, sourceId] : [job.id]
    const saved = preserveGoals ? ids.flatMap(id => [
      { path: goalsFileOf({ id }), legacy: false },
      { path: path.join(runnerHome(), 'ideas', `${id}.json`), legacy: true },
    ]).find(entry => fs.existsSync(entry.path)) : undefined
    const goals = !saved ? job.discussion.goals : saved.legacy ? migrateDraft(saved.path) : readGoalDraft(saved.path).goals
    const studios = await studioSnapshot(job.discussion.workspace, job.discussion.catalog, list)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    writeGoalDraft(file, { workspace: job.discussion.workspace, studios, goals })
    if (saved && saved.path !== file) fs.rmSync(saved.path, { force: true })
    return { file, preserved: !!saved }
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
}

function migrateDraft(file: string): Goal[] {
  const draft = JSON.parse(fs.readFileSync(file, 'utf8')) as SavedGoalData | null
  if (draft) migrateGoalData(draft)
  if (!Array.isArray(draft?.goals)) throw new Error('The goals array is missing or invalid.')
  return draft.goals
}

export function readGoals(file: string): Goal[] | undefined {
  try { return readGoalDraft(file).goals }
  catch { return undefined }
  finally { fs.rmSync(file, { force: true }) }
}

let owner = ''
const snapshots = new Map<string, Promise<api.Studio[]>>()

export function clearStudioSnapshots() { owner = ''; snapshots.clear() }

async function studioSnapshot(workspace: string, catalog: api.StudioCatalog | undefined, list: typeof api.listStudios) {
  const account = `${readSession()?.subject ?? ''}:${accountGeneration()}`
  if (owner !== account) { clearStudioSnapshots(); owner = account }
  const reusable = catalog?.account === readSession()?.subject && !!catalog?.version
  const key = reusable ? JSON.stringify([account, workspace, catalog.version]) : null
  if (key && snapshots.has(key)) return snapshots.get(key)!
  const load = async () => {
    const studios: api.Studio[] = []
    let after: string | null = null
    const seen = new Set<string>()
    do {
      const page = await list(workspace, after)
      if (!page.ok) throw new Error(page.error)
      if (account !== `${readSession()?.subject ?? ''}:${accountGeneration()}`) throw new Error('Account changed while reading studios.')
      if (catalog?.version && page.value.catalogVersion && page.value.catalogVersion !== catalog.version) throw new Error('Studios changed while reading the catalog. Try again.')
      if (key && !page.value.catalogVersion) snapshots.delete(key)
      for (const w of page.value.data) studios.push({ ...w, name: w.names ? `${w.names.en} / ${w.names.zh}` : w.name })
      after = page.value.next
      if (after && seen.has(after)) throw new Error('The studio catalog did not finish.')
      if (after) seen.add(after)
    } while (after)
    return studios
  }
  const loading = load()
  if (key) {
    // Keep only current snapshots; concurrent readers of a version share its promise.
    if (snapshots.size >= 16) snapshots.delete(snapshots.keys().next().value!)
    snapshots.set(key, loading)
    void loading.catch(() => { if (snapshots.get(key) === loading) snapshots.delete(key) })
  }
  return loading
}
