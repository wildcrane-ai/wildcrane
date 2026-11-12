import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { imageMime, type LocalReplyPart, type ReplyPart } from '../../cli/src/lib/shared/reply-parts'
import { ASSET_FILE_LIMIT } from '../../cli/src/lib/shared/file-limits'

const inside = (root: string, file: string) => { const p = path.relative(root, file); return p !== '..' && !p.startsWith(`..${path.sep}`) && !path.isAbsolute(p) }

/** Only explicit reply references are opened; no directory or rollout is scanned. */
export function collectReplyImages(parts: LocalReplyPart[], cwd: string): { parts: ReplyPart[]; files: Map<string, { read: () => Uint8Array; mime: string }> } {
  const files = new Map<string, { read: () => Uint8Array; mime: string }>()
  const tools: ReplyPart[] = []
  const output: ReplyPart[] = []
  const roots = [cwd, path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'), 'generated_images')].flatMap(p => { try { return [fs.realpathSync(p)] } catch { return [] } })
  const image = (p: Extract<LocalReplyPart, { type: 'image' }>): ReplyPart => {
    const read = (): Uint8Array => {
      let bytes: Uint8Array
      if (p.data !== undefined) {
        if (p.data.length > ASSET_FILE_LIMIT * 4 / 3 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.data)) throw Error()
        bytes = Buffer.from(p.data, 'base64')
      } else {
        if (!p.path) throw Error()
        const source = p.path.startsWith('file:') ? fileURLToPath(p.path) : decodeURIComponent(p.path)
        if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[A-Za-z]:[\\/]/.test(source)) throw Error()
        if (!/\.(png|jpe?g|gif|webp)$/i.test(source)) throw Error()
        const real = fs.realpathSync(path.resolve(cwd, source))
        if (!roots.some(root => inside(root, real))) throw Error()
        const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        try {
          const stat = fs.fstatSync(fd)
          if (!stat.isFile() || stat.size > ASSET_FILE_LIMIT) throw Error()
          bytes = fs.readFileSync(fd)
        } finally { fs.closeSync(fd) }
      }
      return bytes
    }
    try {
      const bytes = read()
      const mime = imageMime(bytes)
      if (!mime || p.mime && p.mime !== mime || bytes.length > ASSET_FILE_LIMIT) throw Error()
      const id = `rim_${createHash('sha256').update(bytes).digest('hex')}`
      if (!files.has(id)) files.set(id, { read, mime })
      return { type: 'image', id, mime, status: 'saved' }
    } catch { return { type: 'image', status: 'unavailable' } }
  }
  for (const part of parts.slice(0, 100)) {
    if (part.type === 'image') { tools.push(image(part)); continue }
    // Fenced and inline examples remain text.
    const tokens = part.text.split(/((?:`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:`{3,}|~{3,})|`+[^`\n]*`+)/g)
    for (const token of tokens) {
      if (token.startsWith('`') || token.startsWith('~~~')) { output.push({ type: 'text', text: token }); continue }
      const re = /!?\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\)/g
      let at = 0
      for (const m of token.matchAll(re)) {
        if (!m[0].startsWith('!') && !/\.(png|jpe?g|gif|webp)$/i.test(m[1] ?? m[2] ?? '')) continue
        if (m.index! > at) output.push({ type: 'text', text: token.slice(at, m.index) })
        const src = m[1] ?? m[2] ?? ''
        const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(src)
        output.push(image(data ? { type: 'image', data: data[2], mime: data[1] } : { type: 'image', path: src }))
        at = m.index! + m[0].length
      }
      if (at < token.length) output.push({ type: 'text', text: token.slice(at) })
    }
  }
  // A final reference owns the position when its tool already returned the same bytes.
  const referenced = new Set(output.flatMap(p => p.type === 'image' && p.id ? [p.id] : []))
  const seen = new Set<string>()
  const merged = [...tools.filter(p => p.type !== 'image' || !p.id || !referenced.has(p.id)), ...output].filter(p => {
    if (p.type !== 'image' || !p.id) return true
    if (seen.has(p.id)) return false
    seen.add(p.id); return true
  })
  const joined: ReplyPart[] = []
  for (const p of merged) {
    const last = joined.at(-1)
    if (last?.type === 'text' && p.type === 'text') last.text += p.text
    else joined.push(p)
  }
  return { parts: joined.slice(0, 100), files }
}

export async function saveReplyImages(parts: LocalReplyPart[], cwd: string,
  upload: (key: string, bytes: Uint8Array, mime: string) => Promise<{ id?: string; status: 'saved' | 'not_saved' }>): Promise<ReplyPart[] | undefined> {
  const read = collectReplyImages(parts, cwd)
  if (!read.parts.some(p => p.type === 'image')) return undefined
  const saved = new Map<string, { id?: string; status: 'saved' | 'not_saved' }>()
  for (const [key, f] of read.files) {
    let bytes: Uint8Array
    try {
      bytes = f.read()
      if (`rim_${createHash('sha256').update(bytes).digest('hex')}` !== key || imageMime(bytes) !== f.mime) continue
    } catch { continue }
    for (let attempt = 0; attempt < 2; attempt++) {
      try { saved.set(key, await upload(key.slice(4), bytes, f.mime)); break } catch { /* Bounded retry; the model is never rerun. */ }
    }
  }
  return read.parts.map(p => {
    if (p.type !== 'image' || !p.id) return p
    const uploaded = saved.get(p.id)
    return { ...p, id: uploaded?.status === 'saved' ? uploaded.id : undefined, status: uploaded?.status ?? 'not_saved' }
  })
}
