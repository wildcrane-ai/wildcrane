// What of a board lives in its project's `Board` (#2081), shared by the Worker and the Runner:
// both filter by the same rule. No imports, so either side can take it as it is.

import { parseFrontmatter } from '../frontmatter.ts'

/** The board folders kept in Cloud; anything else on a board is this computer's own. */
const ROOTS = ['todo/', '.archive/', 'memory/', 'studios/', 'triage/', 'assets/', 'rules/']

/** The board's settings at its root (#2106): the module map and the project's settings. */
export const SETTINGS = ['modules.md', 'config.md']

/** A settings file: one of those, an agent's rule, or the rule for a studio's cards. */
export const isSettingsPath = (path: string) => SETTINGS.includes(path) || path === projectConfigFile
  || isStudioConfigPath(path) || /^rules\/(?:proposer|project-writer|dismissal-reviewer|memory-pruner)\.md$/.test(path)

/** A file over this goes up as an asset, not on the board. */
export { BOARD_FILE_LIMIT } from './file-limits.ts'

/** A board path Cloud keeps: relative, inside one of its folders, not a generated file. */
export function isBoardPath(path: string): boolean {
  if (!path || path.length > 500 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  if (path.split('/').some((part) => !part || part === '.' || part === '..')) return false
  // Rebuilt on every board, never kept: the index and the sync records. `next-id` and
  // `metrics.csv` sit outside every folder kept.
  if (path === 'todo/README.md' || path.split('/').includes('.sync')) return false
  if (path.startsWith('studios/')) return true
  if (SETTINGS.includes(path)) return true
  if (path.startsWith('rules/')) return isSettingsPath(path)
  // An asset a card names sits beside it as an artifact's file, never a board file.
  if (path.startsWith('assets/')) return taskOfAssets(path) !== null
  return ROOTS.some((root) => path.startsWith(root)) && path.endsWith('.md')
}

/** A card is named by its task's number in the project (#2105): `todo/12-pricing.md`, or a group's
 *  `todo/12-pricing/root.md`, anywhere under `todo/` or `.archive/`. */
const CARD = /^(?:todo|\.archive)\/(?:[^/]+\/)*(\d+)-[^/]*\.md$/
const ROOT = /^(?:todo|\.archive)\/(?:[^/]+\/)*(\d+)-[^/]+\/root\.md$/

export function numberOfCard(path: string): number | null {
  const n = ROOT.exec(path)?.[1] ?? CARD.exec(path)?.[1]
  return n ? Number(n) : null
}

/** A subtask's group: the number its group folder starts with. */
export function groupOfCard(path: string): number | null {
  if (ROOT.test(path) || !CARD.test(path)) return null
  const folder = /(?:^|\/)(\d+)-[^/]+\/[^/]+$/.exec(path)?.[1]
  return folder ? Number(folder) : null
}

/** A task id as a file or folder name. */
export const cardSlug = (task: string) => task.toLowerCase().replace(/_/g, '-')

/** Where a task's assets are listed: a path its card names → the artifact version it shows. */
export const assetsFile = (task: string) => `assets/${task}.json`

export const taskOfAssets = (path: string): string | null => /^assets\/(task_[0-9a-f]+)\.json$/.exec(path)?.[1] ?? null

/** The board folder a studio is written to: its id as a board names one (`wf_builtin_coding` →
 *  `wf-builtin-coding`), so it never takes the place of a studio akb ships. */
export const studioFolder = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** An account's own studio's folder on a board, a built-in's and a builder draft's aside. */
export const OWN_FOLDER = /^wf-(?!builtin-)[a-z0-9-]+$/

/** akb's name for a Cloud studio: a built-in's own (`wf_builtin_coding` → `coding`), an
 *  account's own its folder. */
export const studioName = (id: string) =>
  id.startsWith('wf_builtin_') ? id.slice('wf_builtin_'.length).replace(/_/g, '-') : studioFolder(id)

export const projectConfigFile = 'rules/config.md'
export const studioConfigFile = (id: string) => `rules/studios/${studioName(id)}/config.md`
export const legacyStudioRuleFile = (id: string) => `rules/studios/${studioName(id)}.md`
export const isStudioConfigPath = (path: string) => /^rules\/studios\/[^/]+(?:\/config)?\.md$/.test(path)

export const studioConfigConflict = (config: string | undefined, legacy: string | undefined) =>
  !!config?.trim() && !!legacy?.trim() && config.trim() !== legacy.trim()

export function studioConfigText(config: string | undefined, legacy: string | undefined): string {
  return ((studioConfigConflict(config, legacy) ? legacy : config ?? legacy) ?? '').trim()
}

export interface CardFront {
  title?: string
  status?: string
  previews?: string[]
}

/** The frontmatter fields indexed by Cloud. */
export function cardFront(body: string): CardFront {
  const { meta } = parseFrontmatter(body)
  if (!meta) return {}
  return {
    ...(typeof meta.title === 'string' && meta.title.trim() ? { title: meta.title } : {}),
    ...(typeof meta.status === 'string' && meta.status ? { status: meta.status } : {}),
    ...(meta.previews ? { previews: meta.previews } : {}),
  }
}
