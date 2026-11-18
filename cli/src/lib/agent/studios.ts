import fs from 'node:fs'
import path from 'node:path'
import { locate, locateArchived } from '../cards'
import { parseFrontmatter } from '../frontmatter'
import { die, RULES } from '../paths'
import type { Meta } from '../types'
import { heldStudioName } from './cloud-studios'
import { translating } from './language'
import { boardStudioDefs, builtinDefs, type StudioDef, type StudioPreview } from './studio-file'
import { refusal, type FrozenStudio, type RunRefusal, type StudioScheduled, type StudioHelper } from './types'
export type { StudioHelper }
export interface Studio extends StudioDef { builtIn: boolean }
export const studios = (): Studio[] => [...builtinDefs().map(def => ({ ...def, builtIn: true })), ...boardStudioDefs().defs.map(def => ({ ...def, builtIn: false }))]
export const studioById = (id: string) => studios().find(s => s.id === id)
export const studioFor = (id: string | undefined) => studioById(id ?? '')
export const isBuiltinStudio = (id: string) => builtinDefs().some(s => s.id === id)
export const builtinDescription = (id: string) => builtinDefs().find(s => s.id === id)?.description
export const studioPurpose = (flow: Studio) => flow.description || flow.name
export const studioWhen = (flow: Studio) => flow.description
export const studioFileProblems = () => boardStudioDefs().problems
export const previewMembers = (flow: Studio): StudioPreview[] => flow.previews
export const previewAgents = previewMembers
export const previewStages = (flow: Studio | undefined, chosen: readonly string[]): string[][] => [flow?.previews.filter(p => chosen.includes(p.id)).map(p => p.id) ?? []]
export const archivesOnApproval = (_flow: Studio | undefined) => false
export const agentAfter = (_name: string): string[] => []
export const agentKeyProblems = (): string[] => []
export const agentStudio = (_name: string) => ''
export const landAgents = (_flow: Studio): StudioHelper[] => []
export const scheduledMembers = (_flow: Studio): StudioScheduled[] => []
export const listedScheduled = (_flow: Studio): string[] => []
export const scheduledAgent = (_id: string, _agent: string): StudioScheduled | undefined => undefined
export const stampScheduledRun = (_id: string, _agent: string, _at: Date) => false
export const forgetStudioAgent = (_agent: string) => ({ ok: true })
export const studioIssues = (id: string): RunRefusal[] => studioById(id) ? [] : [refusal('studioNotFound', `No Studio ${id}`, { id })]
export const studioProblems = (id: string) => studioIssues(id).map(i => i.error)
export function noStudioMessage(id: string | undefined): string {
  const name = heldStudioName(id ?? '') || id
  return !id || !studios().length ? (translating() ? '先安装一个工作台' : 'Install a studio first.') : translating() ? `此任务的工作台「${name}」未安装` : `This task's studio "${name}" is not installed.`
}
export function requireStudio(id: string | undefined): Studio {
  const flow = studioFor(id)
  if (!flow) die(noStudioMessage(id), { kind: 'no-studio', studio: id ?? '' })
  return flow!
}
export function knownStudio(id: string): string {
  const flow = studioById(id.trim())
  if (!flow) die(`no studio called "${id.trim()}" here.`, { kind: 'no-such-studio', studio: id.trim() })
  return flow!.id
}
export const studioRuleFile = (id: string) => path.join(RULES, 'studios', `${id}.md`)
export function userStudioRules(flow: Studio): string { try { return fs.readFileSync(studioRuleFile(flow.id), 'utf8').trim() } catch { return '' } }

/** The id a card carries, straight off its file. Empty when the card is not there or carries
 *  no `studio:` key. */
export const cardStudioId = (id: number): string => cardMeta(id)?.studio ?? ''

/** A card's frontmatter, straight off its file, or null when it is not there. */
export function cardMeta(id: number): Meta | null {
  // Best-effort: read on the way into a prompt, and a folder that is not there means the card
  // names no studio, never a run that cannot start.
  try {
    const found = locate(id) ?? locateArchived(id)
    if (!found) return null
    const file = found.kind === 'group' ? path.join(found.target, 'root.md') : found.target
    return parseFrontmatter(fs.readFileSync(file, 'utf8')).meta
  } catch {
    return null
  }
}

/** The studio a card runs on, resolved; undefined when it has none this board knows. */
export const cardStudio = (id: number | null | undefined): Studio | undefined =>
  studioFor(typeof id === 'number' ? cardStudioId(id) : '')

/** A card's approvals (#2154): the previews it chose, staged by their `after`. */
export const cardStages = (meta: Pick<Meta, 'previews'> | null | undefined, flow: Studio | undefined): string[][] =>
  previewStages(flow, meta?.previews ?? [])

/** The approval a card is on, 1-based: its `phase`, kept inside its stages. */
export const cardStage = (meta: Pick<Meta, 'phase' | 'previews'> | null | undefined, flow: Studio | undefined): number =>
  Math.min(Math.max(meta?.phase || 1, 1), cardStages(meta, flow).length)


export function frozenStudio(id: string): FrozenStudio | undefined {
  const flow = studioFor(id)
  return flow ? { id: flow.id, name: flow.name, needsArtifact: flow.needsArtifact, previews: flow.previews, rules: flow.rules } : undefined
}
