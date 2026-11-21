
import { specAgentEntries } from '../agent/settings'
import { stageContractProblems, type AgentRole } from '../agent/roles'
import type { SpecAgentEntry } from '../agent/settings'
import type { SpecAgentSetting } from '../agent/types'
import { readLanguage } from '../machine/settings'
import type { Language } from '../machine/types'
import { specAgentCatalog } from './catalog'
import { studioFileProblems } from '../agent/studios'
import type { SpecAgent } from './parse'

export { specAgentCatalog } from './catalog'
export type { SpecAgent } from './parse'

/** Every agent on this board, in the board's order. */
export const specAgents = (): SpecAgent[] => specAgentCatalog().agents

export function agentLines(
  agent: SpecAgent,
  language: Language = readLanguage(),
): { title: string; description: string } {
  const said = agent.i18n[language]
  return {
    title: said?.title || agent.i18n.en?.title || '',
    description: said?.description || agent.description,
  }
}

/** Catalog, studio membership and stage-contract diagnostics. */
export const specAgentProblems = (): string[] => [
  ...specAgentCatalog().problems,
  ...studioFileProblems(),
  ...stageContractProblems(),
]

/** The names this board answers to, for a message that has to say what there is. */
export const specAgentNamesOnBoard = (): string[] => specAgents().map((a) => a.name)

export const findSpecAgent = (name: string): SpecAgent | null => {
  return specAgents().find((a) => a.name === name) ?? null
}

/** What one of the board's roles is set to (#1469): every setting on its page, carrying the
 *  saved value or its own default. `notes` holds a line for each value that had to fall back —
 *  a choice renamed or dropped between releases is worse to meet silently than to be told. */
export const roleSettings = (
  role: AgentRole,
  entries = specAgentEntries(),
): { values: Record<string, string>; notes: string[] } => settingValues(role.name, role.settings ?? [], entries)

function settingValues(
  name: string,
  settings: SpecAgentSetting[],
  entries: Record<string, SpecAgentEntry>,
): { values: Record<string, string>; notes: string[] } {
  const entry = entries[name]
  const values: Record<string, string> = {}
  const notes: string[] = []
  for (const setting of settings) {
    const raw = entry?.extra[setting.key]
    const picked = typeof raw === 'string' ? raw : undefined
    if (picked !== undefined && setting.choices.some((c) => c.value === picked)) {
      values[setting.key] = picked
      continue
    }
    if (picked !== undefined) {
      notes.push(
        `the \`${name}\` agent's ${setting.label} is saved as "${picked}", which it no longer offers — ` +
          `running it at its default, "${setting.default}".`,
      )
    }
    values[setting.key] = setting.default
  }
  return { values, notes }
}

/** What a role's run is told by the settings it is set to (#1469): the `prompt` of each
 *  picked choice that has one. Empty when none does. */
export function roleSettingsBlock(role: AgentRole, entries = specAgentEntries()): string {
  const { values } = roleSettings(role, entries)
  const lines = (role.settings ?? [])
    .map((setting) => setting.choices.find((c) => c.value === values[setting.key])?.prompt)
    .filter((line): line is string => Boolean(line))
  return lines.length ? ['Your settings on this board:', ...lines.map((line) => `- ${line}`)].join('\n') : ''
}
