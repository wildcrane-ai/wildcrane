import fs from 'node:fs'
import path from 'node:path'
import type * as api from './api'
import type { Job } from './api'
import type { Goal } from '../../cli/src/lib/shared/goal'
import { readGoalDraft, writeGoalDraft } from '../../cli/src/lib/goal-draft'
import { runnerHome } from './home'
import { readSession } from '../../cli/src/lib/cloud/session'
import { accountGeneration } from './settings-control'

export const goalsFileOf = (job: Pick<Job, 'id'>) => path.join(runnerHome(), 'ideas', `${job.id}.json`)

export async function writeGoals(job: Job & { discussion: NonNullable<Job['discussion']> }, list: typeof api.listStudios, preserveGoals = false): Promise<{ file: string } | { error: string }> {
  const file = goalsFileOf(job)
  try {
    const goals = preserveGoals && fs.existsSync(file) ? readGoalDraft(file).value.goals : job.discussion.goals
    const studios = await studioSnapshot(job.discussion.workspace, job.discussion.catalog, list)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // A Runner can carry an older AKB that only edits the legacy draft format.
    writeGoalDraft(file, { workspace: job.discussion.workspace, studios, goals }, 'ideas')
    return { file }
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
}

export function readGoals(file: string): Goal[] | undefined {
  try { return readGoalDraft(file).value.goals }
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
