import { parse } from 'yaml'

import { legacyStudioRuleFile, projectConfigFile, studioConfigFile, studioConfigText } from '../shared/board-files'

interface Preference {
  key?: string
  projects?: string[]
  actions?: string[]
  text: string
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function preferences(text: string): Preference[] {
  const front = /^---[ \t]*\r?\n([^]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!front) {
    // Older Studio configuration stored the project scope in a prose heading.
    const scope = /^The following existing preferences apply only to tasks in these projects in this workspace: (.+)\. They do not apply to other projects\.\r?\n\s*((?:- [^\n]+(?:\n|$))+)/m.exec(text)
    if (!scope) return text ? [{ text }] : []
    const projects = [...scope[1]!.matchAll(/`(prj_[^`]+)`/g)].map(match => match[1]!)
    const rest = text.replace(scope[0], '').trim()
    return [...(rest ? [{ text: rest }] : []), { projects, text: scope[2]!.trim() }]
  }
  try {
    const config = parse(front[1]!)
    if (!config || !Object.hasOwn(config, 'preferences')) return [{ text }]
    const body = text.slice(front[0].length).trim()
    return [
      ...(body ? [{ text: body }] : []),
      ...(Array.isArray(config.preferences) ? config.preferences : []).flatMap((rule: Partial<Preference> | null) =>
        rule && typeof rule.text === 'string' && (rule.key === undefined || typeof rule.key === 'string')
        && (rule.projects === undefined || strings(rule.projects)) && (rule.actions === undefined || strings(rule.actions))
          ? [{ ...rule, text: rule.text.trim() }] : []),
    ]
  } catch {
    return /^preferences\s*:/m.test(front[1]!) ? [] : [{ text }]
  }
}

export function studioConfigContext(
  id: string, project: string | null, action: string, read: (file: string) => string | undefined,
): string {
  const defaults = preferences(read(projectConfigFile)?.trim() ?? '')
  const studio = preferences(studioConfigText(read(studioConfigFile(id)), read(legacyStudioRuleFile(id))))
  const effective = new Map<string | Preference, string>()
  for (const rule of [...defaults, ...studio]) {
    if (rule.projects && (!project || !rule.projects.includes(project))) continue
    if (rule.actions && !rule.actions.includes(action)) continue
    if (rule.key || rule.text) effective.set(rule.key ?? rule, rule.text)
  }
  return [...new Set(effective.values())].filter(Boolean).join('\n\n')
}
