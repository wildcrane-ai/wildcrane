export const isHtmlFile = (file: string): boolean => /\.html?$/i.test(file)

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' blob:; img-src data: blob:; " +
  "media-src data: blob:; font-src data: blob:; worker-src 'none'; base-uri 'none'; form-action 'none'"

export const head = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><meta charset="utf-8">` +
  '<meta name="viewport" content="width=device-width, initial-scale=1"><style>html{overflow-x:hidden;overscroll-behavior:contain}</style>'

export function dressPage(html: string): string {
  const at = /^\uFEFF?\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\b[^>]*>)?/i.exec(html)![0].length
  return /<!doctype\b|<html[\s>]|<head[\s>]/i.test(html) ? html.slice(0, at) + head + html.slice(at) : `<!doctype html><html><head>${head}</head><body>${html}</body></html>`
}
