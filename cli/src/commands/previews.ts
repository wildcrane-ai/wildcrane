import { studioById, studios } from '../lib/agent/studios'
import { say } from '../lib/io'
import { die } from '../lib/paths'
import type { MoveResult } from '../lib/types'

export function listPreviews(studio?: string): MoveResult {
  const flow = studio ? studioById(studio) : undefined
  if (studio && !flow) die(`No Studio ${studio}`, 'no-such-studio')
  const previews = (flow ? [flow] : studios()).flatMap(
    (item) => item.previews.map(({ id, instructions }) => ({ id, instructions })),
  )
  say(previews.map(({ id, instructions }) => `${id}\n  ${instructions}`).join('\n'))
  return { previews }
}
