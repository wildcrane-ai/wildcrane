import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { collectSources } from '../../../artifact-sdk/src/internal/collect'
import { manifestOf, mapReferences, referencesOf } from '../../../artifact-sdk/src/internal/manifest'
import { parseReview, resultProblem, type StudioAgent, type StudioReview, type StudioResult } from '../../../artifact-sdk/src/internal/format/studio'
import { parseSpecAgent } from '../lib/agents/parse'
import { readStudioFolder } from '../lib/agent/studio-folder'
import { checkStudioFiles, hashInput, VERSION_FILE, FILE_LIMITS, type StudioFiles } from '../lib/shared/studio-files'
import { ASSET_FILE_LIMIT } from '../lib/shared/file-limits'
import { referenceText } from '../lib/dress-page'
import { drawMockup } from '../lib/draw-mockup'
import { locate } from '../lib/cards'
import { ASSETS, die } from '../lib/paths'
import { say } from '../lib/io'
import type { MoveResult } from '../lib/types'

const within = (root: string, file: string) => file.startsWith(root + path.sep)
const readVersion = (files: StudioFiles) => {
  if (files[VERSION_FILE] === undefined) return null
  try {
    const v = JSON.parse(files[VERSION_FILE]!)
    if (typeof v.id === 'string' && v.id && Number.isInteger(v.version) && v.version > 0) return { id: v.id as string, version: v.version as number }
  } catch {}
  throw Error('version.json: invalid Studio version')
}
function readFolder(folder: string) {
  const root = fs.realpathSync(folder)
  let count = 0, total = 0
  const scan = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const file = path.join(dir, e.name)
      if (e.isSymbolicLink()) throw Error(`${file}: symbolic links are not allowed`)
      if (e.isDirectory()) scan(file)
      else {
        const size = fs.statSync(file).size
        total += size
        if (++count > FILE_LIMITS.count || size > FILE_LIMITS.file || total > FILE_LIMITS.total) throw Error(`${file}: Studio file limit exceeded`)
      }
    }
  }
  scan(root)
  const files = readStudioFolder(root), checked = checkStudioFiles(files, readVersion(files)?.id.startsWith('wf_builtin_') === true)
  if (!checked.ok) die(`${folder}/${checked.file}: ${checked.reason}`, 'studio-problems')
  const fingerprint = createHash('sha256').update(hashInput({ ...checked.files, ...(files[VERSION_FILE] ? { [VERSION_FILE]: files[VERSION_FILE]! } : {}) })).digest('hex')
  return { files, def: checked.def, fingerprint }
}
function agentsOf(held: ReturnType<typeof readFolder>): StudioAgent[] {
  const names = [...new Set([...held.def.previews, ...held.def.land, ...held.def.scheduled].map(a => a.agent).concat(Object.keys(held.files).flatMap(f => /^agents\/([^/]+)\/AGENT.md$/.exec(f)?.[1] ?? [])))]
  return names.map(agent => {
    const parsed = parseSpecAgent(held.files[`agents/${agent}/AGENT.md`] ?? '', agent, p => held.files[`agents/${agent}/${p}`] ?? null, false)
    if (!('agent' in parsed)) die(`agents/${agent}/AGENT.md: invalid Agent metadata`, 'studio-problems')
    const a = parsed.agent
    return { agent, title: { en: a.i18n.en?.title || agent, ...(a.i18n.zh?.title ? { zh: a.i18n.zh.title } : {}) }, ...(a.icon ? { icon: a.icon } : {}) }
  })
}
function unified(before: string | null, after: string | null, file: string, folder: string): string {
  const a = path.join(folder, 'a'), b = path.join(folder, 'b')
  fs.writeFileSync(a, before ?? ''); fs.writeFileSync(b, after ?? '')
  const result = spawnSync('git', ['diff', '--no-index', '--text', '--no-ext-diff', '--no-color', '--unified=3', before === null ? '/dev/null' : a, after === null ? '/dev/null' : b], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error || (result.status !== 0 && result.status !== 1)) throw Error(`${file}: ${result.error?.message ?? result.stderr}`)
  const lines = result.stdout.split('\n'), start = lines.findIndex(l => l.startsWith('--- '))
  return `--- ${before === null ? '/dev/null' : 'a/' + file}\n+++ ${after === null ? '/dev/null' : 'b/' + file}\n${start < 0 ? '' : lines.slice(start + 2).join('\n')}`
}
export async function cmdStudioPreview(id: number, opts: { folder: string; base: string; results?: string }): Promise<MoveResult> {
  if (!locate(id)) die(`no card ${id}`, 'no-such-card')
  const destination = path.join(ASSETS, String(id), 'studio-review'), staging = `${destination}.${randomUUID()}.tmp`, backup = `${destination}.${randomUUID()}.previous`
  let moved = false
  try {
    const draft = readFolder(path.resolve(opts.folder)), base = opts.base === 'empty' ? null : readFolder(path.resolve(opts.base))
    const version = readVersion(draft.files), baseVersion = base && readVersion(base.files)
    if (base ? !version || !baseVersion || JSON.stringify(version) !== JSON.stringify(baseVersion) : version !== null) throw Error('version.json: existing Studios need matching baseline and draft versions; use --base empty only for a new Studio without version.json')
    const agents = [...agentsOf(draft)]
    for (const a of base ? agentsOf(base) : []) if (!agents.some(b => b.agent === a.agent)) agents.push(a)
    fs.mkdirSync(staging, { recursive: true })
    const review: StudioReview = { version: 2, base: base && baseVersion ? { ...baseVersion, fingerprint: base.fingerprint } : null, fingerprint: draft.fingerprint, agents, files: [], results: [] }
    const save = (file: string, bytes: string | Buffer) => {
      const target = path.join(staging, file)
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes)
      return file
    }
    const paths = [...new Set([...Object.keys(base?.files ?? {}), ...Object.keys(draft.files)])].filter(p => p !== VERSION_FILE).sort()
    for (const [i, file] of paths.entries()) {
      const before = base?.files[file] ?? null, after = draft.files[file] ?? null
      review.files.push({ path: file, before: before === null ? null : save(`files/${i}/before.txt`, before), after: after === null ? null : save(`files/${i}/after.txt`, after), ...(before !== after ? { diff: save(`files/${i}/change.diff`, unified(before, after, file, staging)) } : {}) })
    }
    for (const p of ['a', 'b']) fs.rmSync(path.join(staging, p), { force: true })
    if (opts.results) {
      const manifest = fs.realpathSync(opts.results), root = path.dirname(manifest)
      const results: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8')), bad = resultProblem(results, new Set(agents.map(a => a.agent)))
      if (bad) throw Error(`${opts.results}: invalid ${bad}`)
      const rendered = new Map<string, string>()
      const textOf = (file: string) => {
        const raw = rendered.get(file) ?? fs.readFileSync(file, 'utf8')
        if (/\.(html|tsx)$/i.test(file)) for (const ref of referencesOf(manifestOf('html'), raw, true)) {
          if (/^(?:data:|#)/i.test(ref.src)) continue
          if (/^(?:[a-z][\w+.-]*:|\/)/i.test(ref.src)) throw Error(`${file}: external result dependency ${ref.src}`)
          const target = path.resolve(path.dirname(file), ref.src.replace(/[?#].*$/, ''))
          if (!within(root, target) || (fs.existsSync(target) && !within(root, fs.realpathSync(target)))) throw Error(`${file}: outside result folder: ${ref.src}`)
        }
        return rendered.get(file) ?? referenceText(file)
      }
      const collectResults = () => collectSources(referencesOf(manifestOf('studio'), { results }), manifest, {
        resolve: (src, owner) => {
          if (/^(?:[a-z][\w+.-]*:|\/|#)/i.test(src)) throw Error(`${src}: only local result files are allowed`)
          const target = path.resolve(path.dirname(owner), src)
          if (!within(root, target)) throw Error(`${src}: outside result folder`)
          const real = fs.realpathSync(target)
          if (!within(root, real) || !fs.statSync(real).isFile()) throw Error(`${src}: outside result folder or not a file`)
          if (fs.statSync(real).size > ASSET_FILE_LIMIT) throw Error(`${src}: over 100 MiB`)
          return { key: real, file: real }
        }, read: textOf, retained: () => [],
      })
      let graph = collectResults()
      for (let pass = 0; ; pass++) {
        const entries = graph.filter(n => n.file?.endsWith('.tsx') && !rendered.has(n.file))
        if (!entries.length) break
        if (pass >= 10) throw Error(`${opts.results}: too many nested result levels`)
        for (const n of entries) rendered.set(n.file!, await drawMockup(n.file!))
        graph = collectResults()
      }
      if (graph.length > 2000) throw Error(`${opts.results}: too many result dependencies`)
      for (const node of graph) if (node.error || node.problems.length) throw Error(`${node.file}: ${node.error ?? node.problems[0]!.message}`)
      const names = new Map(graph.map((n, i) => [n.key, `results/${i}${rendered.has(n.file!) ? '.html' : path.extname(n.file!)}`]))
      const resolve = (src: string, owner: string) => names.get(fs.realpathSync(path.resolve(path.dirname(owner), src.replace(/[?#].*$/, ''))))!
      for (const node of graph) {
        const own = names.get(node.key)!
        const content = node.data === undefined ? fs.readFileSync(node.file!) : mapReferences(manifestOf(node.kind), node.data, src => path.posix.relative(path.posix.dirname(own), resolve(src, node.file!)))
        save(own, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content))
      }
      review.results = (mapReferences(manifestOf('studio'), { results }, src => resolve(src, manifest)) as { results: StudioResult[] }).results
    }
    if (!parseReview(review)) throw Error('generated review is invalid')
    save('review.json', JSON.stringify(review, null, 2) + '\n')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    if (fs.existsSync(destination)) { fs.renameSync(destination, backup); moved = true }
    fs.renameSync(staging, destination); fs.rmSync(backup, { recursive: true, force: true })
    const tag = `<Studio src=".assets/${id}/studio-review/review.json" />`
    say(tag)
    return { file: path.join(destination, 'review.json'), tag }
  } catch (error) {
    if (moved && !fs.existsSync(destination)) fs.renameSync(backup, destination)
    if (error && typeof error === 'object' && 'kind' in error) throw error
    die(error instanceof Error ? error.message : String(error), 'bad-args')
  } finally { fs.rmSync(staging, { recursive: true, force: true }) }
}
