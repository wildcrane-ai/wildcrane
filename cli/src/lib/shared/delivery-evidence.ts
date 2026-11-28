import { parseFrontmatter } from '../frontmatter.ts'

// What a delivery is approved to build. Everything else on the card — `## Todo` and its
// ticks, status, questions, the notes a delivery leaves as it works — sits
// outside, so a delivery writing to its own card is never a change to its requirements.
const APPROVED = [
  /^##\s+Worth noting\s*$/i,
  /^##\s+Scope\s*$/i,
  /^##\s+Scope out\s*$/i,
  // `skill` is the word a spec section carries now; `agent` is the word it carried before
  // #403, and a card written by an older release still has to travel whole.
  /^##\s+By\s+`[^`]+`\s+(skill|agent)\s*$/i,
]

const isApproved = (heading: string): boolean => APPROVED.some((re) => re.test(heading))

export function approvedCardRequirements(text: string): string {
  const { meta, body } = parseFrontmatter(text)
  const out: string[] = []
  if (meta?.title) out.push(`# ${meta.title}`, '')
  // The opening paragraph is everything before the first heading. The `<!-- agent -->`
  // boundary is a marker, not content, so it never travels.
  const opening: string[] = []
  const sections: string[] = []
  let keeping = false
  let started = false
  for (const line of body.split('\n')) {
    if (/^##(?!#)\s/.test(line)) {
      started = true
      keeping = isApproved(line)
      if (keeping) sections.push('', line)
      continue
    }
    if (line.trim() === '<!-- agent -->') continue
    if (!started) opening.push(line)
    else if (keeping) sections.push(line)
  }
  out.push(opening.join('\n').trim())
  out.push(sections.join('\n').trim())
  // A dropped section leaves the blank lines that framed it, so the copy is squeezed back
  // to one blank line between blocks — it is read by a person as well as by an agent.
  return out.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export interface ArchiveCompletion {
  task: string
  path: string
  seq: number
  assets_seq: number
}

export type ArchiveCompletionReceipt = { task: string } & (
  { status: 'confirmed' } |
  { status: 'pending' | 'rejected'; code: string; message: string }
)

export const ARCHIVE_COMPLETION_BATCH = 100

interface ArchiveFile { content: string; base_seq: number }
export interface ArchiveInput {
  card?: ArchiveFile & { path: string }
  assets?: ArchiveFile
  delivery_id?: string
  landing?: { commit: string; branch: string }
}
