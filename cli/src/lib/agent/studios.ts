import fs from 'node:fs'
import path from 'node:path'
import { locate, locateArchived } from '../cards'
import { parseFrontmatter } from '../frontmatter'
import { die, RULES } from '../paths'
import type { Meta } from '../types'
import { heldStudioName } from './cloud-studios'
import { translating } from './language'
import { boardStudioDefs, builtinDefs, type StudioDef } from './studio-file'
import { refusal, type FrozenStudio, type RunRefusal } from './types'
export interface Studio extends StudioDef { builtIn: boolean }
export const studios = (): Studio[] => [...builtinDefs().map(def => ({ ...def, builtIn: true })), ...boardStudioDefs().defs.map(def => ({ ...def, builtIn: false }))]
export const studioById = (id: string) => studios().find(s => s.id === id)
export const studioFor = (id: string | undefined) => studioById(id ?? '')
export const isBuiltinStudio = (id: string) => builtinDefs().some(s => s.id === id)
export const builtinDescription = (id: string) => builtinDefs().find(s => s.id === id)?.description
export const studioPurpose = (flow: Studio) => flow.description || flow.name
export const studioWhen = (flow: Studio) => flow.description
export const studioFileProblems = () => boardStudioDefs().problems
export const archivesOnApproval = (_flow: Studio | undefined) => false
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

export function frozenStudio(id: string): FrozenStudio | undefined {
  const flow = studioFor(id)
  return flow ? { id: flow.id, name: flow.name, needsArtifact: flow.needsArtifact, previews: flow.previews, rules: flow.rules } : undefined
}
