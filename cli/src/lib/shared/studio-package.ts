import { FILE_LIMITS, hashInput, isAboutFile, studioFileBody, studioScreenshotPrefix, safeStudioPath, VERSION_FILE, type StudioFiles } from './studio-files.ts'

export interface StudioPackage {
  version: number
  filesSha256: string
  zipSha256: string
  zipBytes: number
  downloadUrl: string
}

const LOCAL = 30
const CENTRAL = 46
const END = 22
const UTF8 = 0x800
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) byte = (byte >>> 1) ^ (byte & 1 ? 0xedb88320 : 0)
  return byte
})

function crc32(bytes: Uint8Array): number {
  let crc = -1
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!
  return (crc ^ -1) >>> 0
}

export const STUDIO_ZIP_LIMIT = FILE_LIMITS.total + FILE_LIMITS.count * (LOCAL + CENTRAL + 2 * FILE_LIMITS.path) + END
export const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const sha256Bytes = async (input: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', input)), byte => byte.toString(16).padStart(2, '0')).join('')
export const studioFilesSha256 = (files: StudioFiles) => sha256Bytes(encoder.encode(hashInput(files)))

const validPath = (name: string) => name !== VERSION_FILE && safeStudioPath(name)

/** Store UTF-8 paths and raw file bytes in a deterministic ZIP with no compression or timestamps. */
export function encodeStudioZip(files: StudioFiles) {
  const names = Object.keys(files).sort()
  if (!names.length || names.length > FILE_LIMITS.count || names.some(name => !validPath(name))) throw Error('Invalid Studio ZIP paths.')
  const entries = names.map(name => ({ name: encoder.encode(name), ...studioFileBody(name, files[name]!) }))
  let expandedBytes = 0, localBytes = 0, directoryBytes = 0
  for (const { name, bytes } of entries) {
    expandedBytes += bytes.length
    localBytes += LOCAL + name.length + bytes.length
    directoryBytes += CENTRAL + name.length
    if (bytes.length > FILE_LIMITS.file) throw Error('A Studio file exceeds 2 MiB.')
  }
  if (!expandedBytes || expandedBytes > FILE_LIMITS.total) throw Error('Invalid Studio size. The package limit is 10 MiB.')
  const zip = new Uint8Array(localBytes + directoryBytes + END)
  const view = new DataView(zip.buffer)
  const u16 = (at: number, value: number) => view.setUint16(at, value, true)
  const u32 = (at: number, value: number) => view.setUint32(at, value, true)
  let local = 0, central = localBytes
  for (const { name, bytes, binary } of entries) {
    const sum = crc32(bytes)
    u32(local, 0x04034b50); u16(local + 4, 20); u16(local + 6, UTF8); u16(local + 12, 33)
    u32(local + 14, sum); u32(local + 18, bytes.length); u32(local + 22, bytes.length); u16(local + 26, name.length)
    zip.set(name, local + LOCAL)
    zip.set(bytes, local + LOCAL + name.length)
    u32(central, 0x02014b50); u16(central + 4, 20); u16(central + 6, 20); u16(central + 8, UTF8); u16(central + 14, 33)
    u32(central + 16, sum); u32(central + 20, bytes.length); u32(central + 24, bytes.length); u16(central + 28, name.length)
    u16(central + 36, binary ? 0 : 1); u32(central + 42, local)
    zip.set(name, central + CENTRAL)
    local += LOCAL + name.length + bytes.length
    central += CENTRAL + name.length
  }
  u32(central, 0x06054b50); u16(central + 8, entries.length); u16(central + 10, entries.length)
  u32(central + 12, directoryBytes); u32(central + 16, localBytes)
  return { zip, expandedBytes }
}

/** Only accept the package format we write, including both sets of headers, paths and CRCs. */
export function decodeStudioZip(zip: Uint8Array): StudioFiles {
  const invalid = () => Error('Invalid Studio ZIP.')
  if (zip.length < END || zip.length > STUDIO_ZIP_LIMIT) throw invalid()
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const u16 = (at: number) => view.getUint16(at, true)
  const u32 = (at: number) => view.getUint32(at, true)
  const end = zip.length - END
  const count = u16(end + 10)
  let central = u32(end + 16), local = 0, total = 0, previous = ''
  const start = central
  if (u32(end) !== 0x06054b50 || !count || count > FILE_LIMITS.count || start > end) throw invalid()
  const files: [string, string][] = []
  for (let index = 0; index < count; index++) {
    if (central + CENTRAL > end || local + LOCAL > start) throw invalid()
    const length = u16(central + 28), size = u32(central + 24)
    const from = local + LOCAL + length
    total += size
    if (central + CENTRAL + length > end || from + size > start || size > FILE_LIMITS.file || total > FILE_LIMITS.total) throw invalid()
    const name = decoder.decode(zip.subarray(central + CENTRAL, central + CENTRAL + length))
    if (!validPath(name) || name <= previous) throw invalid()
    const bytes = zip.subarray(from, from + size)
    const binary = u16(central + 36) === 0
    if (binary && !(name.startsWith('screenshots/') && isAboutFile(name))) throw invalid()
    let text = ''
    if (binary) {
      for (let at = 0; at < bytes.length; at += 32768) text += String.fromCharCode(...bytes.subarray(at, at + 32768))
      text = studioScreenshotPrefix(name) + btoa(text)
    } else {
      text = decoder.decode(bytes)
      if (text.includes('\u0000')) throw invalid()
    }
    files.push([name, text])
    previous = name
    central += CENTRAL + length
    local = from + size
  }
  const result = Object.fromEntries(files)
  const canonical = encodeStudioZip(result).zip
  if (canonical.length !== zip.length || !canonical.every((byte, i) => zip[i] === byte)) throw invalid()
  return result
}

export async function readStudioDownload(response: Response, size: number): Promise<Uint8Array> {
  if (!response.body || Number(response.headers.get('content-length')) !== size) throw Error('Invalid Studio package length.')
  const reader = response.body.getReader()
  const bytes = new Uint8Array(size)
  let offset = 0
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      if (offset + chunk.value.length > size) throw Error('Invalid Studio package length.')
      bytes.set(chunk.value, offset)
      offset += chunk.value.length
    }
    if (offset !== size) throw Error('Incomplete Studio package.')
    return bytes
  } finally {
    await reader.cancel().catch(() => {})
  }
}
