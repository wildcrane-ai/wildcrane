import { z } from 'zod'
import { PREVIEW_ID } from './preview-blocks.ts'

export const previewComponents = ['Asset', 'Compare', 'Storyboard', 'Set', 'Studio'] as const
const language = /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/
export const previewDefinitionSchema = z.object({
  id: z.string().max(100).regex(PREVIEW_ID),
  title: z.record(z.string().regex(language), z.string().trim().min(1).max(100))
    .refine(names => Boolean(names.en && names.zh), 'A Preview needs English and Chinese titles.'),
  instructions: z.string().trim().min(1).max(10_000),
  components: z.array(z.enum(previewComponents)).max(previewComponents.length)
    .refine(items => new Set(items).size === items.length, 'Preview Components must be unique.').transform(items => [...items].sort()).optional(),
}).strict()
export const previewDefinitionsSchema = z.array(previewDefinitionSchema).max(50)
export type PreviewDefinition = z.infer<typeof previewDefinitionSchema>

export function effectivePreviewCatalog<T extends { id: string; title?: Record<string, string> }>(
  studio: readonly T[], definitions: readonly PreviewDefinition[],
): (T | PreviewDefinition)[] {
  const seen = new Set(studio.map(p => p.id))
  for (const p of definitions) {
    if (seen.has(p.id)) throw new Error(`Duplicate Preview ID "${p.id}".`)
    seen.add(p.id)
  }
  return [...studio, ...definitions]
}
