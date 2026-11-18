import { cloudFlows } from './cloud-studios'
import { scalar, type StudioDef } from './studio-def'
export { STUDIO_ID, parseStudioFile, type StudioDef, type StudioPreview } from './studio-def'

export function studioFileText(def: StudioDef): string {
  const { id, rules, previews, ...meta } = def
  const map = Object.fromEntries(previews.map(({ id, instructions, ...display }) => [id, display]))
  return `---\n${Object.entries({ ...meta, previews: map }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${rules}\n${previews.map(p => `\n<Preview id="${p.id}">\n\n${p.instructions}\n\n</Preview>\n`).join('')}`
}

// ---- Cloud's -----------------------------------------------------------------

/** The official studios this board runs, read-only. */
export const builtinDefs = (): StudioDef[] => cloudFlows().filter((f) => f.builtIn).map((f) => f.def)

/** Workspace studios are read from Cloud. Drafts are ordinary local folders. */
export function boardStudioDefs(): { defs: StudioDef[]; problems: string[] } {
  return { defs: cloudFlows().filter((f) => !f.builtIn).map((f) => f.def), problems: [] }
}
