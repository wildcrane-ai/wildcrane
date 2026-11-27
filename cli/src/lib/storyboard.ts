import { isTaskAssetRef, taskAssetPath } from '../../../artifact-sdk/src/internal/task-assets'

// ---- a card's storyboard marker (#963) -----------------------------------------------------------
//
//   <Storyboard src="asset:storyboard.json" label="3:4" />
//
// The tag stands alone in its paragraph and points at a JSON file in the card's asset folder;
// `label` is an optional heading that tells several on one card apart (#1117).
// The file's contract is its owner agent's: scriptwriter, deck-planner and carousel-renderer each
// ship `scripts/validate-storyboard.mjs` (#992). The board only finds the marker and its path.

const TAG = /^<Storyboard\b([^<>]*?)\/>$/
const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
const SRC_ATTR = attr('src')
const LABEL_ATTR = attr('label')

/** The `src` and `label` of a block that is exactly one `<Storyboard … />` tag — `null` for
 *  anything else. */
export function storyboardAttrs(raw: string): { src: string; label?: string } | null {
  const m = TAG.exec(raw.trim())
  if (!m) return null
  const src = SRC_ATTR.exec(m[1]!)
  if (!src) return null
  const label = LABEL_ATTR.exec(m[1]!)
  const text = label ? (label[1] ?? label[2])!.trim() : ''
  return { src: (src[1] ?? src[2])!, ...(text ? { label: text } : {}) }
}

/** The `src` of a block that is exactly one `<Storyboard … />` tag — `null` for anything else. */
export const storyboardTag = (raw: string): string | null => storyboardAttrs(raw)?.src ?? null

/** The `src` of a block that is exactly one `<Studio … />` tag (#451) — `null` for anything else. */
export const studioTag = (raw: string): string | null => {
  const m = /^<Studio\b([^<>]*?)\/>$/.exec(raw.trim())
  const src = m ? SRC_ATTR.exec(m[1]!) : null
  return src ? (src[1] ?? src[2])! : null
}

/** Every tag standing alone in its paragraph, outside fenced blocks, with its 1-based line. */
export function storyboardMarkers(body: string, tagOf: (raw: string) => string | null = storyboardTag): { src: string; line: number }[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const found: { src: string; line: number }[] = []
  let fence: string | null = null
  lines.forEach((line, i) => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (delimiter && delimiter[1]![0] === fence[0] && delimiter[1]!.length >= fence.length) fence = null
      return
    }
    if (delimiter) { fence = delimiter[1]!; return }
    const src = tagOf(line)
    if (src !== null && !lines[i - 1]?.trim() && !lines[i + 1]?.trim()) found.push({ src, line: i + 1 })
  })
  return found
}

/** Check a task reference and the extension the component expects. */
export function assetName(src: string, cardId: number, exts: readonly string[]): { name: string } | { expected: string; actual: string } {
  const expected = `asset:<path>${!exts.length ? '' : `.${exts.length === 1 ? exts[0] : `{${exts.join(',')}}`}`} in this task's asset folder`
  const name = taskAssetPath(src, cardId)
  if (name === null) {
    const actual = !isTaskAssetRef(src) && /^[a-z][\w+.-]*:/i.test(src) ? `an external address ${JSON.stringify(src)}` : JSON.stringify(src)
    return { expected, actual }
  }
  const ext = name.split('.').pop()!.toLowerCase()
  if (exts.length && (!name.includes('.') || !exts.includes(ext))) return { expected, actual: `file type ${JSON.stringify(name.includes('.') ? ext : '')}` }
  return { name }
}
