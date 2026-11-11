import fs from 'node:fs'
import path from 'node:path'

// Complete files, selected by host. Edit shared/skills, never the generated copies.
export const SKILLS = {
  'claude-code': { 'discuss-goal': '', tasks: '' },
  codex: { 'discuss-goal': '', tasks: '', wildcrane: '' },
  cursor: { 'discuss-goal': 'cursor', tasks: '', wildcrane: '' },
  'kimi-code': { 'discuss-goal': 'kimi-code', tasks: '', wildcrane: '' },
  dsh: { 'discuss-goal': 'mcp', tasks: 'dsh', wildcrane: '' },
  grok: { 'discuss-goal': 'mcp', tasks: 'grok', wildcrane: '' },
}

export function copySkills(plugins) {
  for (const [host, skills] of Object.entries(SKILLS)) {
    for (const [skill, variant] of Object.entries(skills)) {
      const target = path.join(plugins, host, 'skills', skill)
      fs.mkdirSync(target, { recursive: true })
      fs.copyFileSync(path.join(plugins, 'shared', 'skills', skill, variant ? `variants/${variant}/SKILL.md` : 'SKILL.md'), path.join(target, 'SKILL.md'))
    }
  }
}
