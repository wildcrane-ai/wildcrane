// Fetching a package version from npm: the Runner's into ~/.wildcrane/bin/runner/<version>/, akb's
// into ~/.wildcrane/bin/akb/<version>/ (#171).
//
// Nothing here throws: every failure — a proxy, a mirror, no network, a tarball whose
// sha512 does not match what npm published, a Node too old — answers with why, and the
// caller stays on the version it already has.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { runnerHome } from './home'

export const PACKAGE = 'wildcrane-runner'
export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org'
const TIMEOUT_MS = 60_000

export const versionsDir = () => path.join(runnerHome(), 'bin', 'runner')
/** Where versions went before #2147: an older launcher still starts them from there. */
export const legacyVersionsDir = () => path.join(runnerHome(), 'runner')
export const versionDir = (version: string) => path.join(versionsDir(), version)
export const entryOf = (dir: string) => path.join(dir, 'dist', 'runner.mjs')

/** What to fetch, and where its versions go. */
export interface Package {
  name: string
  dirOf: (version: string) => string
  entryOf: (dir: string) => string
}

const RUNNER: Package = { name: PACKAGE, dirOf: versionDir, entryOf }

export type Install = { ok: true; dir: string } | { ok: false; why: 'unreachable' | 'integrity' | 'node'; detail: string }

interface RegistryKey {
  keyid: string
  key: string
  expires: string | null
}

let testRegistryOverride: string | null = null
let cachedKeys: { source: string; keys: Map<string, crypto.KeyObject> } | null = null

/** Test-only override for registry URL; resets cached signing keys. */
export function setTestRegistry(url: string | null): void {
  testRegistryOverride = url ? url.replace(/\/+$/, '') : null
  cachedKeys = null
}

function resolveRegistry(): { ok: true; url: string } | { ok: false; detail: string } {
  if (testRegistryOverride) return { ok: true, url: testRegistryOverride }
  const configured = process.env.npm_config_registry?.trim().replace(/\/+$/, '')
  if (configured && configured !== OFFICIAL_REGISTRY) {
    return { ok: false, detail: `untrusted npm_config_registry: ${configured}` }
  }
  return { ok: true, url: OFFICIAL_REGISTRY }
}

async function registryKeys(registryUrl: string): Promise<Map<string, crypto.KeyObject>> {
  if (cachedKeys?.source === registryUrl) return cachedKeys.keys
  const answer = await fetch(`${registryUrl}/-/npm/v1/keys`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!answer.ok) throw new Error(`keys answered ${answer.status}`)
  const body = (await answer.json()) as { keys?: RegistryKey[] }
  const keys = new Map<string, crypto.KeyObject>()
  for (const entry of body.keys ?? []) {
    if (!entry.keyid || !entry.key) continue
    if (entry.expires && Date.parse(entry.expires) <= Date.now()) continue
    keys.set(entry.keyid, crypto.createPublicKey({ key: Buffer.from(entry.key, 'base64'), format: 'der', type: 'spki' }))
  }
  cachedKeys = { source: registryUrl, keys }
  return keys
}

async function verifySignature(
  registryUrl: string,
  pkgName: string,
  version: string,
  integrity: string,
  signatures: Array<{ keyid?: string; sig?: string }> | undefined,
): Promise<boolean> {
  if (!Array.isArray(signatures) || signatures.length === 0) return false
  const keys = await registryKeys(registryUrl)
  const payload = Buffer.from(`${pkgName}@${version}:${integrity}`)
  for (const entry of signatures) {
    if (!entry.keyid || !entry.sig) continue
    const key = keys.get(entry.keyid)
    if (!key) continue
    try {
      if (crypto.verify('sha256', payload, key, Buffer.from(entry.sig, 'base64'))) return true
    } catch {}
  }
  return false
}

export const install = (version: string, nodeVersion?: string) => installPackage(RUNNER, version, nodeVersion)

/** Download, check and unpack one version. A version already unpacked is reused. */
export async function installPackage(pkg: Package, version: string, nodeVersion = process.versions.node): Promise<Install> {
  const dir = pkg.dirOf(version)
  if (fs.existsSync(pkg.entryOf(dir))) return { ok: true, dir }

  const reg = resolveRegistry()
  if (!reg.ok) return { ok: false, why: 'integrity', detail: reg.detail }
  const registryUrl = reg.url

  let meta: { dist?: { tarball?: string; integrity?: string; signatures?: Array<{ keyid?: string; sig?: string }> }; engines?: { node?: string } }
  let tarball: Buffer
  try {
    const answer = await fetch(`${registryUrl}/${pkg.name}/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!answer.ok) return { ok: false, why: 'unreachable', detail: `registry answered ${answer.status}` }
    meta = (await answer.json()) as typeof meta
    const range = meta.engines?.node
    if (range && !satisfies(nodeVersion, range)) return { ok: false, why: 'node', detail: range }
    if (!meta.dist?.tarball) return { ok: false, why: 'unreachable', detail: 'no tarball' }
    if (!testRegistryOverride && !meta.dist.tarball.startsWith(`${OFFICIAL_REGISTRY}/`)) {
      return { ok: false, why: 'integrity', detail: 'tarball outside official registry' }
    }
    const download = await fetch(meta.dist.tarball, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!download.ok) return { ok: false, why: 'unreachable', detail: `download answered ${download.status}` }
    tarball = Buffer.from(await download.arrayBuffer())
  } catch (e) {
    return { ok: false, why: 'unreachable', detail: e instanceof Error ? e.message : String(e) }
  }

  const expected = /^sha512-(.+)$/.exec(meta.dist.integrity ?? '')?.[1]
  const actual = crypto.createHash('sha512').update(tarball).digest('base64')
  if (!expected || expected !== actual) return { ok: false, why: 'integrity', detail: 'sha512 mismatch' }

  try {
    const signed = await verifySignature(registryUrl, pkg.name, version, meta.dist.integrity!, meta.dist.signatures)
    if (!signed) return { ok: false, why: 'integrity', detail: 'dist.signatures verification failed' }
  } catch (e) {
    return { ok: false, why: 'unreachable', detail: e instanceof Error ? e.message : String(e) }
  }

  const staging = `${dir}.${process.pid}.tmp`
  try {
    fs.rmSync(staging, { recursive: true, force: true })
    extract(zlib.gunzipSync(tarball), staging)
    if (!fs.existsSync(pkg.entryOf(staging))) throw new Error(`the package carries no ${path.relative(staging, pkg.entryOf(staging))}`)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.renameSync(staging, dir)
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true })
    return { ok: false, why: 'integrity', detail: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true, dir }
}

/** Unpack an npm tarball's `package/` into `into`. Refuses any path that leaves it. */
export function extract(tar: Buffer, into: string): void {
  let offset = 0
  let longName: string | null = null
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const field = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1) || '0'
    const body = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512

    if (type === 'x') {
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null
      continue
    }
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '')
      continue
    }
    const prefix = field(345, 155)
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = null
    if (type !== '0' && type !== '5') continue

    const relative = name.replace(/^[^/]+\//, '')
    if (!relative) continue
    const target = path.resolve(into, relative)
    if (!target.startsWith(path.resolve(into) + path.sep)) throw new Error(`refusing ${name}`)
    if (type === '5') fs.mkdirSync(target, { recursive: true })
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, body)
    }
  }
}

// --- semver, as much as an `engines.node` range needs -------------------------

const parse = (v: string): number[] | null => {
  const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]) || 0, Number(m[3]) || 0] : null
}

export function compare(a: string, b: string): number {
  const [x, y] = [parse(a) ?? [0, 0, 0], parse(b) ?? [0, 0, 0]]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  const pre = (v: string) => /^v?\d+\.\d+\.\d+-([^+]+)/.exec(v)?.[1]?.split('.')
  const ap = pre(a), bp = pre(b)
  if (!ap || !bp) return ap ? -1 : bp ? 1 : 0
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const av = ap[i], bv = bp[i]
    if (av === bv) continue
    if (av === undefined) return -1
    if (bv === undefined) return 1
    const an = /^\d+$/.test(av), bn = /^\d+$/.test(bv)
    if (an && bn) return Number(av) - Number(bv)
    if (an !== bn) return an ? -1 : 1
    return av < bv ? -1 : 1
  }
  return 0
}

/** Whether `version` meets a range: `||` alternatives of space-separated `>=`, `>`, `<=`,
 *  `<`, `=`, `^`, `~` or bare comparators. A range it cannot read is not met. */
export function satisfies(version: string, range: string): boolean {
  return range.split('||').some((alternative) => {
    const parts = alternative.trim().split(/\s+/).filter(Boolean)
    return parts.length > 0 && parts.every((part) => meets(version, part))
  })
}

function meets(version: string, comparator: string): boolean {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator)
  const bound = m && parse(m[2]!)
  if (!m || !bound) return false
  const v = parse(version)!
  const c = compare(version, m[2]!)
  switch (m[1]) {
    case '>=': return c >= 0
    case '>': return c > 0
    case '<=': return c <= 0
    case '<': return c < 0
    case '^': return c >= 0 && v[0] === bound[0]
    case '~': return c >= 0 && v[0] === bound[0] && v[1] === bound[1]
    default: {
      // `18`, `18.x` and `18.2` name a family; `18.2.0` names one version.
      const given = m[2]!.split('.').filter((p) => /^\d+$/.test(p)).length
      return [0, 1, 2].slice(0, given).every((i) => v[i] === bound[i])
    }
  }
}
