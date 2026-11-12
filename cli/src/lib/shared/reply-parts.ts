export type ReplyPart = { type: 'text'; text: string } | {
  type: 'image'; id?: string; status: 'saved' | 'not_saved' | 'unavailable' | 'expired'; mime?: string
}

/** Image bytes never belong in reports or events. */
export type LocalReplyPart = { type: 'text'; text: string } | {
  type: 'image'; path?: string; data?: string; mime?: string
}

export function imageMime(bytes: Uint8Array): string | undefined {
  const at = (...v: number[]) => v.every((n, i) => bytes[i] === n)
  const text = (a: number, b: number) => String.fromCharCode(...bytes.slice(a, b))
  if (bytes.length >= 24 && at(137, 80, 78, 71, 13, 10, 26, 10) && text(12, 16) === 'IHDR' && bytes.slice(16, 20).some(Boolean) && bytes.slice(20, 24).some(Boolean)) return 'image/png'
  if (at(255, 216, 255)) return 'image/jpeg'
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(text(0, 6)) && (bytes[6] || bytes[7]) && (bytes[8] || bytes[9])) return 'image/gif'
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

export function replyParts(value: unknown): ReplyPart[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 100) return undefined
  const out: ReplyPart[] = []
  let textBytes = 0
  for (const p of value) {
    if (!p || typeof p !== 'object') return undefined
    if (p.type === 'text' && typeof p.text === 'string') {
      const text = p.text.slice(0, Math.max(0, 60000 - textBytes)); textBytes += text.length
      out.push({ type: 'text', text })
    }
    else if (p.type === 'image' && ['saved', 'not_saved', 'unavailable', 'expired'].includes(p.status)) {
      out.push({ type: 'image', ...(typeof p.id === 'string' && /^rim_[a-z0-9_]{1,64}$/.test(p.id) ? { id: p.id } : {}),
        status: p.status, ...(['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(p.mime) ? { mime: p.mime } : {}) })
    } else return undefined
  }
  return out.some(p => p.type === 'image') ? out : undefined
}
