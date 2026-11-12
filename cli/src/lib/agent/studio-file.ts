// Studio definitions read from Cloud.

import { cloudFlows } from './cloud-studios'
import { groupLines, scalar, type StudioDef } from './studio-def'

export { STUDIO_ID, parseStudioFile, stagesOf, type StudioDef } from './studio-def'

/** One `STUDIO.md`, written the way the built-ins are; each group left out when empty. */
export function studioFileText(def: StudioDef): string {
  const lines = ['---', `name: ${scalar(def.name)}`]
  const names = Object.entries(def.names ?? {})
  if (names.length) lines.push('names:', ...names.map(([lang, said]) => `  ${lang}: ${scalar(said)}`))
  if (def.description) lines.push(`description: ${scalar(def.description)}`)
  if (def.when) lines.push(`when: ${scalar(def.when)}`)
  lines.push(`needsArtifact: ${def.needsArtifact}`)
  lines.push(...groupLines('previews', def.previews), ...groupLines('land', def.land))
  if (def.memoryFiles?.workspace.length) lines.push('memoryFiles:', `  workspace: [${def.memoryFiles.workspace.map(scalar).join(', ')}]`)
  if (def.scheduled.length) {
    lines.push('scheduled:')
    for (const s of def.scheduled) {
      lines.push(`  - agent: ${scalar(s.agent)}`)
      if (s.cadence) lines.push(`    cadence: ${scalar(s.cadence)}`)
    }
  }
  lines.push('---')
  return `${lines.join('\n')}\n${def.rules ? `\n${def.rules}\n` : ''}`
}

// ---- Cloud's -----------------------------------------------------------------

/** The official studios this board runs, read-only. */
export const builtinDefs = (): StudioDef[] => cloudFlows().filter((f) => f.builtIn).map((f) => f.def)

/** Workspace studios are read from Cloud. Drafts are ordinary local folders. */
export function boardStudioDefs(): { defs: StudioDef[]; problems: string[] } {
  return { defs: cloudFlows().filter((f) => !f.builtIn).map((f) => f.def), problems: [] }
}
