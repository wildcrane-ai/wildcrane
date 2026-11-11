// Reading one `STUDIO.md`, with no file access: the board (./studio-file.ts) and the
// Cloud Worker (#2040) read it with the same code. Imports keep their `.ts` so Node can load
// this file as it is.
//
// The frontmatter lists the studio's agents in three groups (#2152): `previews`, the agents
// whose work a person approves, each waiting on the approval of those its `after` names
// (#2154); `land`, run in order once the last approval is in; and `scheduled`. The body is how
// a card on this studio is written.

import { ICON_COLORS, ICON_NAMES, readIcon, type AgentIcon } from '../agents/icon.ts'
import { memoryPaths } from '../agents/parse.ts'
import { parseYamlBlock, splitFrontmatter, type YamlValue } from '../agents/yaml.ts'
import { canonicalSpecAgent } from '../spec-agent-names.ts'
import type { StudioHelper } from './types.ts'
import { yamlScalar } from '../yaml.ts'

export interface StudioDef {
  id: string
  name: string
  /** Its name by language (`names: { zh: … }`); English is `name`. */
  names?: Record<string, string>
  /** What it is for. Optional on a board's own. */
  description: string
  /** Which requests it is for, read by an agent choosing a studio. Optional. */
  when: string
  needsArtifact: boolean
  /** Its deliverable sticker (#461), as an agent's `akb.icon` is. */
  icon?: AgentIcon
  /** Its preview agents, in order. */
  previews: StudioHelper[]
  /** What runs, in order, once the last approval is in. Empty: approving it archives the card. */
  land: StudioHelper[]
  /** The scheduled agents it starts with; their run state lives in the board's settings. */
  scheduled: { agent: string; cadence?: string }[]
  /** Its memory files shared by all the user's projects, relative to `memory/studios/<id>/` (#656). */
  memoryFiles?: { workspace: string[] }
  /** Its body: the rules a card on this studio is written by. */
  rules: string
}

// A ` #` would read back as a comment.
export const scalar = (value: string): string => (/\s#/.test(value) ? JSON.stringify(value) : yamlScalar(value))

const plain = (agents: StudioHelper[]): boolean => agents.every((h) => !h.extra && !h.off)

// One group's agents as list items at `indent`: a bare name, or a map carrying what the
// studio asks of it and whether it is off.
function agentLines(agents: StudioHelper[], indent: string): string[] {
  return agents.flatMap((h) =>
    !h.extra && !h.off
      ? [`${indent}- ${scalar(h.agent)}`]
      : [
          `${indent}- agent: ${scalar(h.agent)}`,
          ...(h.extra ? [`${indent}  extra: ${JSON.stringify(h.extra)}`] : []),
          ...(h.off ? [`${indent}  off: true`] : []),
        ],
  )
}

const flowList = (agents: StudioHelper[]): string => `[${agents.map((h) => scalar(h.agent)).join(', ')}]`

/** One group of agents as `STUDIO.md` writes it; nothing when empty. */
export const groupLines = (key: string, agents: StudioHelper[]): string[] =>
  !agents.length ? [] : plain(agents) ? [`${key}: ${flowList(agents)}`] : [`${key}:`, ...agentLines(agents, '  ')]

/** What a studio may be called on disk: the same shape an agent's name takes. */
export const STUDIO_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Keys a `STUDIO.md` written before #2152 has. */
const OLD_KEYS = ['stages', 'delivers', 'helpers', 'every']

const box = (value: YamlValue | undefined): Record<string, YamlValue> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const text = (value: YamlValue | undefined): string => (typeof value === 'string' ? value.trim() : '')

function readAgent(item: YamlValue): StudioHelper | null {
  const row = typeof item === 'string' ? { agent: item } : box(item)
  const agent = canonicalSpecAgent(text(row.agent))
  if (!agent) return null
  return { agent, extra: typeof row.extra === 'string' ? row.extra : '', ...(text(row.off) === 'true' ? { off: true } : {}) }
}

const readGroup = (value: YamlValue | undefined): StudioHelper[] =>
  (Array.isArray(value) ? value : []).map(readAgent).filter((h): h is StudioHelper => !!h)

// Rounds, a list of lists (#2152), are gone: an agent's `after` makes a later approval (#2154).
function readPreviews(value: YamlValue | undefined): StudioHelper[] | string {
  if (value === undefined || value === '') return []
  if (!Array.isArray(value)) return '`previews` is a list of agents'
  if (value.some(Array.isArray)) {
    return '`previews` is one list of agents, not a list of lists — flatten it, and give an agent `after` to make it wait on another\'s approval'
  }
  return readGroup(value)
}

/** The approvals a card's chosen previews make (#2154), in studio order: an agent is one past
 *  the latest of those its `after` names that were chosen too, or first when none. Shared with
 *  Cloud, which reads `after` from the studio's own files. */
export function stagesOf(chosen: string[], after: (name: string) => string[]): string[][] {
  const at = new Map<string, number>()
  const stageOf = (name: string): number => {
    if (!at.has(name)) {
      at.set(name, 0)
      const before = after(name).filter((other) => other !== name && chosen.includes(other))
      at.set(name, Math.max(-1, ...before.map(stageOf)) + 1)
    }
    return at.get(name)!
  }
  const stages: string[][] = []
  for (const name of chosen) (stages[stageOf(name)] ??= []).push(name)
  return stages.filter(Boolean)
}

/** Read one `STUDIO.md`. Lenient past the name and the groups: a field it cannot read takes
 *  its default. */
export function parseStudioFile(id: string, source: string, from: string): { def: StudioDef } | { problem: string } {
  if (!STUDIO_ID.test(id)) return { problem: `${from}: \`${id}\` is not a studio id — use lowercase letters, digits and dashes` }
  const { meta, body } = splitFrontmatter(source)
  if (meta === null) return { problem: `${from}: no \`---\` frontmatter` }
  const raw = parseYamlBlock(meta)
  const name = text(raw.name).replace(/\s+/g, ' ')
  if (!name) return { problem: `${from}: its frontmatter has no \`name\`` }
  const old = OLD_KEYS.filter((key) => key in raw)
  if (old.length) {
    return {
      problem:
        `${from}: \`${old.join('`, `')}\` ${old.length > 1 ? 'are' : 'is'} no longer read — list the agents under ` +
        '`previews`, `land` and `scheduled` instead (`akb guide write-agent`), or ask the Studio builder to rewrite it',
    }
  }
  const icon = readIcon(raw.icon)
  if (icon && typeof icon === 'object' && 'problem' in icon) {
    return {
      problem:
        `${from}: its \`icon\` is wrong — ${icon.problem}; use one of ${ICON_NAMES.join(', ')}, or 1 to 12 parts ` +
        `\`{ d, f?, o?: true, s?, w? }\` coloured with ${ICON_COLORS.join(', ')}`,
    }
  }
  const previews = readPreviews(raw.previews)
  if (typeof previews === 'string') return { problem: `${from}: ${previews}` }
  const land = readGroup(raw.land)
  const seen = new Set<string>()
  for (const { agent } of [...previews, ...land]) {
    if (seen.has(agent)) return { problem: `${from}: \`${agent}\` is listed more than once — list an agent once` }
    seen.add(agent)
  }
  const scheduled: StudioDef['scheduled'] = []
  for (const item of Array.isArray(raw.scheduled) ? raw.scheduled : []) {
    const row = typeof item === 'string' ? { agent: item } : box(item)
    const agent = canonicalSpecAgent(text(row.agent))
    if (!agent || scheduled.some((s) => s.agent === agent)) continue
    scheduled.push({ agent, ...(text(row.cadence) ? { cadence: text(row.cadence) } : {}) })
  }
  const workspace = memoryPaths(raw.memoryFiles, `memory/studios/${id}/`)
  if (typeof workspace === 'string') return { problem: `${from}: declares ${workspace}` }
  const names = Object.fromEntries(Object.entries(box(raw.names)).map(([lang, said]) => [lang, text(said)]).filter(([, said]) => said))
  return {
    def: {
      id,
      name,
      ...(Object.keys(names).length ? { names } : {}),
      description: text(raw.description),
      when: text(raw.when),
      needsArtifact: text(raw.needsArtifact) === 'true',
      ...(icon ? { icon: icon as AgentIcon } : {}),
      previews,
      land,
      scheduled,
      ...(workspace.length ? { memoryFiles: { workspace } } : {}),
      rules: body.trim(),
    },
  }
}
