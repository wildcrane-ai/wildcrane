
/** One place a card came from. `item` is only ever read off an old `## Source`: the file of
 *  a triage item, which a new card names through `triage:` instead. */
export type SourceRef = { kind: 'plan'; id: number } | { kind: 'card'; id: number } | { kind: 'url'; url: string }

const URL = /^https?:\/\/\S+$/
const PLAN_PATH = /(?:^|\/)plans\/(?:archive\/)?(\d+)-[^/\\\s]*\.md$/

/** A ref as `source:` stores it — `plan:<id>`, `#<id>` or an address — or null. */
export function parseSourceRef(raw: string): SourceRef | null {
  const text = raw.trim()
  const plan = /^plan:(\d+)$/.exec(text)
  if (plan) return { kind: 'plan', id: Number(plan[1]) }
  const card = /^#(\d+)$/.exec(text)
  if (card) return { kind: 'card', id: Number(card[1]) }
  return URL.test(text) ? { kind: 'url', url: text } : null
}

/** What `--source` takes: a stored ref, or a plan's path. Answers the stored spelling. */
export function sourceRefFrom(said: string): string | null {
  const text = said.trim()
  const plan = PLAN_PATH.exec(text)
  if (plan) return `plan:${plan[1]}`
  return parseSourceRef(text) ? text : null
}
