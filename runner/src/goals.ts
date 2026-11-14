// 读取新旧协议；临时文件沿用 ideas 字段，供旧 CLI 原地编辑。
import fs from 'node:fs'
import path from 'node:path'
import type * as api from './api'
import type { Goal, Job } from './api'
import { runnerHome } from './home'
import { readSession } from '../../cli/src/lib/cloud/session'
import { accountGeneration } from './settings-control'

export function goalsOf<T>(held: { goals?: T[]; ideas?: T[] }): T[] {
  if (held.goals !== undefined && held.ideas !== undefined && JSON.stringify(held.goals) !== JSON.stringify(held.ideas)) throw new Error('goals and ideas do not match.')
  const goals = held.goals ?? held.ideas
  if (!Array.isArray(goals)) throw new Error('The goals array is missing or invalid.')
  return goals
}

export const goalsFileOf = (job: Pick<Job, 'id'>) => path.join(runnerHome(), 'ideas', `${job.id}.json`)

export async function writeGoals(job: Job & { discussion: NonNullable<Job['discussion']> }, list: typeof api.listStudios, preserveGoals = false): Promise<{ file: string } | { error: string }> {
  let goals: Goal[]
  try { goals = preserveGoals && fs.existsSync(goalsFileOf(job)) ? goalsOf(JSON.parse(fs.readFileSync(goalsFileOf(job), 'utf8'))) : goalsOf(job.discussion) } catch (e) { return { error: String(e) } }
  let studios: api.Studio[]
  try { studios = await studioSnapshot(job.discussion.workspace, job.discussion.catalog, list) }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
  const file = goalsFileOf(job)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ workspace: job.discussion.workspace, studios, ideas: goals }, null, 2)}\n`)
  return { file }
}

export function readGoals(file: string): Goal[] | undefined {
  try { return goalsOf(JSON.parse(fs.readFileSync(file, 'utf8'))) }
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
