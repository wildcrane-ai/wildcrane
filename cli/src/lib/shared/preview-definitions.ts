import { z } from 'zod'
import { previewComponentNames as previewComponents } from '../../../../artifact-sdk/src/internal/references.ts'
import { PREVIEW_ID } from './preview-blocks.ts'

const language = /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/
export const previewDefinitionSchema = z.object({
  id: z.string().max(100).regex(PREVIEW_ID),
  title: z.record(z.string().regex(language), z.string().trim().min(1).max(100))
    .refine(names => Boolean(names.en && names.zh), 'A Preview needs English and Chinese titles.'),
  instructions: z.string().trim().min(1).max(10_000),
  components: z.array(z.enum(previewComponents)).max(previewComponents.length)
    .refine(items => new Set(items).size === items.length, 'Preview Components must be unique.').transform(items => [...items].sort()).optional(),
}).strict()
export const previewDefinitionsSchema = z.array(previewDefinitionSchema).max(50).superRefine((definitions, ctx) => {
  const seen = new Set<string>()
  for (const { id } of definitions) {
    if (seen.has(id)) ctx.addIssue({ code: 'custom', message: `Duplicate Preview ID "${id}".` })
    seen.add(id)
  }
})
export type PreviewDefinition = z.infer<typeof previewDefinitionSchema>

export function taskOnlyPreviews<T extends { id: string }>(studio: readonly { id: string }[], definitions: readonly T[]): T[] {
  const ids = new Set(studio.map(p => p.id))
  return definitions.filter(p => !ids.has(p.id))
}

export function effectivePreviewCatalog<S extends { id: string }, D extends { id: string }>(
  studio: readonly S[], definitions: readonly D[],
): (S | D)[] {
  return [...studio, ...taskOnlyPreviews(studio, definitions)]
}
