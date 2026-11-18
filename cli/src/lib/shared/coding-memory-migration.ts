/** One-time, scope-preserving move. Callers persist and verify targets before deleting sources. */
import { createHash } from 'node:crypto'
import { CODING_PREVIEWS } from './coding-previews.ts'

export interface MemoryMove {
  source: string
  target: string
  scope: 'project' | 'workspace'
  hash: string
  status: 'moved' | 'existing' | 'conflict' | 'blocked'
}

export const memoryHash = (content: string): string => createHash('sha256').update(content).digest('hex')

export function codingMemoryMoves(files: Map<string, string>, project: string): MemoryMove[] {
  const moves: MemoryMove[] = []
  const destinations = new Map(files)
  for (const [root, scope] of [[`projects/${project}/`, 'project'], ['', 'workspace']] as const) {
    for (const [source, preview] of [...Object.entries(CODING_PREVIEWS).map(([agent, id]) => [`agents/${agent}`, id]), ['competitors', 'competitor-research']] as [string, string][]) {
      const from = `${root}memory/${source}/`
      const to = `${root}memory/previews/coding/${preview}/${scope}/`
      const entries = [...files].filter(([p]) => p.startsWith(from)).sort(([a], [b]) => a.localeCompare(b))
      // Move the entire conflicting tree together so relative links remain valid on retry.
      const conflict = entries.some(([p, text]) => destinations.has(to + p.slice(from.length)) && destinations.get(to + p.slice(from.length)) !== text)
        || entries.some(([p]) => destinations.has(`${to}.conflicts/${source.replaceAll('/', '-')}/${p.slice(from.length)}`))
      for (const [p, content] of entries) {
        const target = `${to}${conflict ? `.conflicts/${source.replaceAll('/', '-')}/` : ''}${p.slice(from.length)}`
        const held = destinations.get(target)
        if (held === undefined) destinations.set(target, content)
        moves.push({ source: p, target, scope, hash: memoryHash(content),
          status: held !== undefined && held !== content ? 'blocked' : conflict ? 'conflict' : held === content ? 'existing' : 'moved' })
      }
    }
  }
  return moves
}
