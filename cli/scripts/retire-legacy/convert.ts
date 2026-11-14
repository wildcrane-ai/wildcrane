import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parseYamlBlock, splitFrontmatter } from '../../src/lib/agents/yaml.ts'
import { yamlScalar } from '../../src/lib/yaml.ts'
import { harnessByName } from '../../src/lib/agent/harnesses/index.ts'
import { matchSourceType } from '../../src/lib/signals/sources.ts'

const names: Record<string, string> = {
  'recommend-tech-stack': 'tech-stack-advisor', 'technology-selection': 'tech-stack-advisor',
  'ui-design': 'ui-designer', 'video-assets': 'hyperframes-editor', 'memory-reviewer': 'chat-reviewer',
  'user-docs': 'copywriting', 'product-writer': 'project-writer',
}
const flows: Record<string, string> = { implement: 'builder', conflict: 'builder', run: 'builder',
  'prune-memory': 'memory-pruner', 'review-memory': 'chat-reviewer', 'review-rejections': 'dismissal-reviewer',
  'describe-project': 'project-writer', reflect: 'proposer', chat: 'discussion-helper' }
export const canonicalName = (name: string): string => names[name] ?? name
const rename = canonicalName
const hash = (data: Buffer | null): string | null => data === null ? null : createHash('sha256').update(data).digest('hex')
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
const block = (value: any): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const refsFor = (harness: string, id: string, keys = new Set<string>()) => Object.fromEntries((harnessByName(harness)?.settings ?? []).filter(setting => setting.kind === 'secret' && setting.env).map(setting => {
  const scoped = `${setting.env}__${id.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`
  return [setting.env!, keys.has(scoped) || !keys.has(setting.env!) ? scoped : setting.env!]
}))
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const assets = (text: string) => text.replace(/memory\/agents\/video-assets\//g, 'memory/agents/hyperframes-editor/').replace(/\.mockups\/(?=\d+\/)/g, '.assets/').replace(/\/mockups\/(\d+)\//g, '/assets/$1/')
const oldLanguage: Record<string, string> = { '请用中文回复和写作。': 'zh', 'Reply and write in English.': 'en' }
const oldSystemLanguages = new Set([
  '无论对话里的卡片、代码和贴进来的内容是什么语言，回复和写下的内容都用中文。代码、命令、文件名和字段名保持原文。',
  '对话和解释使用中文；产物使用用户明确指定的语言，否则使用所属 agent 明确指定的语言，均未指定时使用中文。代码、命令、文件名和字段名保持原文。',
  'Use English for conversation and explanations. For artifacts, use the language explicitly specified by the user, otherwise the responsible agent, otherwise English. Keep code, commands, filenames, and field names unchanged.',
])

function renamedKeys(input: unknown, owner = 'names'): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [was, value] of Object.entries(block(input))) {
    const name = rename(was)
    if (name in out && !equal(out[name], value)) throw Error(`${owner}: conflicting ${name} entries`)
    out[name] = value
  }
  return out
}

/** Only platform fields are translated; user prose and historical log strings stay verbatim. */
export function convertRecord(value: any, key = '', runtimes: any[] = []): any {
  if (typeof value === 'string') {
    if (['agent', 'specAgent', 'lead'].includes(key)) return rename(value)
    if (['approved', 'body', 'content'].includes(key)) return convertCard(value)
    if (['src', 'folder', 'path', 'plan', 'artifact', 'displayedArtifact', 'pictures', 'dependencies'].includes(key)) return assets(value)
    return value
  }
  if (Array.isArray(value)) return ['previews', 'after', 'land'].includes(key)
    ? [...new Set(value.map(v => typeof v === 'string' ? rename(v) : convertRecord(v, key, runtimes))) ]
    : value.map(v => convertRecord(v, key, runtimes))
  if (!value || typeof value !== 'object') return value
  const out: Record<string, any> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (name === 'agent' && entry && typeof entry === 'object' && !Array.isArray(entry) && 'name' in entry) { out[name] = { ...convertRecord(entry, name, runtimes), name: rename(String(entry.name)) }; continue }
    if (['flow', 'held_flow'].includes(name) && block(entry).verb === 'preview') { out[name] = { ...convertRecord(entry, name, runtimes), text: rename(String(block(entry).text ?? '')) }; continue }
    if (name === 'languageLine' || name === 'language_line') continue
    if (name === 'rules' && entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const rules: Record<string, any> = {}
      for (const [owner, rule] of Object.entries(block(entry))) {
        const target = rename(flows[owner] ?? owner)
        if (target in rules && rules[target] !== rule) throw Error(`frozen rules: conflicting ${target}`)
        rules[target] = rule
      }
      out[name] = rules
    } else if (['specAgents', 'agentRuntime'].includes(name)) out[name] = renamedKeys(entry, name)
    else if (name === 'files' && entry && typeof entry === 'object' && !Array.isArray(entry)) out[name] = Object.fromEntries(Object.entries(block(entry)).map(([file, text]) => [file.replace(/agents\/([^/]+)\//, (_, n) => `agents/${rename(n)}/`), typeof text === 'string' ? convertDefinition(text) : text]))
    else if (name === 'assets' && entry && typeof entry === 'object' && !Array.isArray(entry)) out[name] = Object.fromEntries(Object.entries(block(entry)).map(([src, ref]) => [assets(src), convertRecord(ref, '', runtimes)]))
    else out[name] = convertRecord(entry, name, runtimes)
  }
  if (typeof out.runtime === 'string' && ('action' in out || 'harness' in out || 'argv' in out) && !runtimes.some(row => row.id === out.runtime)) {
    const target = runtimes.find(row => row.harness === out.runtime)
    if (target) out.runtime = target.id
  }
  if (Array.isArray(out.argv) && out.harness) {
    const args: string[] = []
    for (let i = 0; i < out.argv.length; i++) {
      if (['--append-system-prompt', '--rules'].includes(out.argv[i]) && oldSystemLanguages.has(out.argv[i + 1])) { i++; continue }
      if (out.argv[i] === '-c' && typeof out.argv[i + 1] === 'string' && out.argv[i + 1].startsWith('developer_instructions=')) {
        try { if (oldSystemLanguages.has(JSON.parse(out.argv[i + 1].slice('developer_instructions='.length)))) { i++; continue } } catch {}
      }
      args.push(out.argv[i])
    }
    out.argv = args
  }
  const line = value.languageLine ?? value.language_line
  if (line !== undefined && !('language' in out)) {
    if (line && !oldLanguage[line]) throw Error('unknown platform language line')
    out.language = oldLanguage[line] ?? null
    if (typeof out.prompt === 'string' && !value.test && !value.flow && !value.review && !value.agent && oldLanguage[line]) {
      const suffix = `\n\n${line}`
      if (out.prompt === line) out.prompt = ''
      else if (out.prompt.endsWith(suffix)) out.prompt = out.prompt.slice(0, -suffix.length)
    }
  }
  return out
}

export const convertProgress = (value: unknown) => convertRecord(renamedKeys(value, 'preview progress'))
export const convertAssetIndex = (value: unknown) => Object.fromEntries(Object.entries(block(value)).map(([src, ref]) => [assets(src), convertRecord(ref)]))

export function convertPlatformPrompt(prompt: string): string {
  return prompt.replace(/`akb guide (discuss-idea|spec-skill|spec-agent)`/g, (_, topic) => `\`akb guide ${topic === 'discuss-idea' ? 'discuss-goal' : 'preview-agent'}\``)
    .split('\n\n').filter(p => !oldSystemLanguages.has(p)).join('\n\n')
}

export function convertDefinition(text: string): string {
  const { meta, body } = splitFrontmatter(text)
  if (meta === null) return text
  let front = meta.replace(/^(\s*(?:-\s+)?(?:name|agent|lead):\s*)([^\n]+)$/gm, (_, head, name) => head + yamlScalar(rename(String(parseYamlBlock(`name: ${name}`).name ?? name))))
    .replace(/^(\s*(?:after|previews|land):\s*)\[([^\]]*)\]/gm, (_, head, list) => head + '[' + [...new Set(list.split(',').map((n: string) => rename(n.trim())).filter(Boolean))].join(', ') + ']')
    .replace(/^(\s+reads:\s*)commits\s*$/gm, '$1archived-cards')
  let groupIndent = -1
  front = front.split('\n').map(line => {
    const group = /^(\s*)(?:previews|land|after):[ \t]*$/.exec(line)
    if (group) { groupIndent = group[1]!.length; return line }
    const indent = /^\s*/.exec(line)![0].length
    if (line.trim() && indent <= groupIndent) groupIndent = -1
    return groupIndent >= 0 ? line.replace(/^(\s*-\s+)([a-z0-9-]+)[ \t]*$/, (_, head, name) => head + rename(name)) : line
  }).join('\n')
  if (front === meta && assets(body) === body) return text
  return `---\n${front.trim()}\n---\n${assets(body)}`
}

export function convertCard(text: string): string {
  let fence = ''
  return assets(text).split('\n').map(line => {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (mark) { if (!fence) fence = mark; else if (mark[0] === fence[0] && mark.length >= fence.length) fence = ''; return line }
    if (fence) return line
    return line.replace(/^(##\s+By\s+`)([^`]+)(`\s+)(?:skill|agent)\s*$/, (_, a, name, b) => a + rename(name) + b + 'agent')
      .replace(/^(previews:\s*)\[([^\]]*)\]/, (_, head, list) => head + '[' + [...new Set(list.split(',').map((n: string) => rename(n.trim())).filter(Boolean))].join(', ') + ']')
  }).join('\n')
}

export function convertSourceCard(text: string, item: (file: string) => { id: string; source?: string } | undefined): string {
  const { meta, body } = splitFrontmatter(text)
  if (meta === null || /^(?:source|triage):\s*\S/m.test(meta)) return text
  const section = /^## Source[ \t]*\n([\s\S]*?)(?=^## |^<!--\s*agent\s*-->|$(?![\s\S]))/m.exec(body)
  if (!section) return text
  const refs = new Set<string>(), triage = new Set<string>()
  for (const line of section[1]!.split('\n')) {
    const plan = /plans\/(?:archive\/)?(\d+)-[^\s/`]+\.md/.exec(line)
    if (plan) { refs.add(`plan:${plan[1]}`); continue }
    const file = /triage\/(?:(?:archived|dismissed)\/)?([^/\s`]+\.md)/.exec(line)
    if (file) {
      const found = item(file[1]!)
      if (!found) throw Error(`source item unavailable: ${file[1]}`)
      if (found.source) refs.add(found.source); else triage.add(found.id)
      continue
    }
    const alone = line.trim().replace(/^[-*]\s+/, '').replace(/^[`<]|[`>]$/g, '')
    if (/^#\d+$|^https?:\/\/\S+$/.test(alone)) refs.add(alone)
  }
  if (triage.size > 1) throw Error('multiple triage origins need review before conversion')
  if (!refs.size && !triage.size) return text
  return `---\n${meta.trim()}\n${refs.size ? `source: [${[...refs].map(yamlScalar).join(', ')}]\n` : ''}${triage.size ? `triage: ${yamlScalar([...triage][0])}\n` : ''}---\n${body}`
}

export function convertTriage(text: string): string {
  const { meta, body } = splitFrontmatter(text)
  if (meta === null) return text
  const parsed = parseYamlBlock(meta)
  if (parsed.source_type || (!parsed.source && !parsed.platform)) return text
  const was = String(parsed.source || parsed.platform), type = matchSourceType(was)
  let front = meta.replace(/^(?:source|platform):[^\n]*\n?/gm, '')
  if (type) front += `\nsource_type: ${type}`
  else if (/^meta:/m.test(front)) front = front.replace(/^meta:[ \t]*$/m, `meta:\n  source: ${yamlScalar(was)}`)
  else front += `\nmeta:\n  source: ${yamlScalar(was)}`
  return `---\n${front.trim()}\n---\n${body}`
}

export function convertConfig(cfg: Record<string, any>, local: Record<string, any> = {}, keyNames = new Set<string>()): Record<string, any> {
  const out = structuredClone(cfg)
  if ('productDescription' in out) {
    if ('projectDescription' in out && !equal(out.projectDescription, out.productDescription)) throw Error('conflicting projectDescription')
    out.projectDescription = out.productDescription; delete out.productDescription
  }
  let rows = Array.isArray(out.runtimes) ? out.runtimes : []
  if (!rows.length && ('harness' in out || 'harnessSettings' in out || 'agentHarness' in out || Object.keys(block(local.agents)).length)) {
    const harness = out.harness || 'claude-code'
    const settings = block(out.harnessSettings)
    rows = [{ id: 'global', name: 'Global default', harness, settings: block(settings[harness]), secretRefs: refsFor(harness, 'global', keyNames) }]
    for (const [name, values] of Object.entries(settings)) if (name !== harness) rows.push({ id: name, name, harness: name, settings: values, secretRefs: refsFor(name, name, keyNames) })
    out.runtimes = rows
  }
  if (Object.keys(block(out.agentHarness)).length && Object.keys(block(out.agentRuntime)).length) throw Error('both agentHarness and agentRuntime are set')
  if (Array.isArray(cfg.runtimes) && cfg.runtimes.length) {
    if (cfg.harness && rows.find((r: any) => r.id === 'global')?.harness !== cfg.harness) throw Error('conflicting global harness')
    for (const [harness, settings] of Object.entries(block(cfg.harnessSettings))) {
      if (!rows.some((r: any) => r.harness === harness && Object.entries(block(settings)).every(([k,v]) => r.settings?.[k] === v))) throw Error('conflicting harness settings')
    }
  }
  const picks = { ...block(out.agentRuntime ?? out.agentHarness) }
  for (const [agent, pin] of Object.entries(picks)) {
    const matches = rows.filter((r: any) => r.id === pin)
    const fallback = matches.length ? matches : rows.filter((r: any) => r.harness === pin)
    if (fallback.length !== 1) throw Error(`ambiguous runtime for ${agent}`)
    picks[agent] = fallback[0].id
  }
  for (const [agent, byHarness] of Object.entries(block(local.agents))) {
    const base = rows.find((r: any) => r.id === (picks[agent] || 'global'))
    if (!base) throw Error(`missing runtime for ${agent}`)
    const model = block(block(byHarness)[base.harness])
    if (!Object.keys(model).length || Object.entries(model).every(([k, v]) => base.settings[k] === v)) continue
    const id = `${rename(agent).replace(/-/g, '_')}_model`
    if (rows.some((r: any) => r.id === id)) throw Error(`runtime already exists: ${id}`)
    rows.push({ ...base, id, name: agent, settings: { ...base.settings, ...model }, secretRefs: base.secretRefs ?? refsFor(base.harness, base.id) })
    picks[agent] = id
  }
  if (rows.length) out.runtimes = rows
  if (Object.keys(picks).length) out.agentRuntime = renamedKeys(picks, 'agentRuntime')
  if (out.specAgents) out.specAgents = renamedKeys(out.specAgents, 'specAgents')
  if (out.studios) out.studios = convertRecord(out.studios)
  delete out.harness; delete out.harnessSettings; delete out.agentHarness
  return out
}

export class Conversion {
  root: string
  board: string
  state: string
  changes = new Map<string, Buffer | null>()
  before = new Map<string, Buffer | null>()
  beforeModes = new Map<string, number>()
  modes = new Map<string, number>()
  runtimeRows: any[] = []
  conflicts: string[] = []
  constructor(root: string, board: string, public legacyState?: string) {
    this.root = fs.realpathSync(root); this.board = fs.existsSync(board) ? fs.realpathSync(board) : path.resolve(board)
    if (!this.board.startsWith(this.root + path.sep)) throw Error('board is outside the authorized project')
    this.state = path.join(this.root, '.akb/boards', path.relative(this.root, this.board))
  }
  read(file: string): Buffer | null {
    if (this.changes.has(file)) return this.changes.get(file)!
    let data: Buffer | null = null
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw Error(`symlink: ${file}`)
      data = fs.readFileSync(file)
      if (!this.beforeModes.has(file)) this.beforeModes.set(file, fs.statSync(file).mode)
    } catch (e: any) { if (e.code !== 'ENOENT') throw e }
    if (!this.before.has(file)) this.before.set(file, data)
    return data
  }
  put(file: string, data: string | Buffer | null, mode?: number) {
    if (!file.startsWith(this.root + path.sep)) throw Error('write outside authorized project')
    for (let at = path.dirname(file); at !== this.root; at = path.dirname(at)) {
      if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) throw Error('symlink in output path')
    }
    this.read(file)
    const bytes = typeof data === 'string' ? Buffer.from(data) : data
    if (hash(bytes) === hash(this.before.get(file)!)) this.changes.delete(file)
    else { this.changes.set(file, bytes); this.modes.set(file, mode ?? this.beforeModes.get(file) ?? 0o600) }
  }
  files(dir: string): string[] {
    const walk = (at: string): string[] => {
      if (!fs.existsSync(at)) return []
      const real = fs.realpathSync(at)
      if (!(real === this.root || real.startsWith(this.root + path.sep) || (this.legacyState && (real === this.legacyState || real.startsWith(this.legacyState + path.sep))))) throw Error('directory is outside authorized sources')
      return fs.readdirSync(at, { withFileTypes: true }).flatMap(e => {
        if (e.name === '.env' && /\/(?:mockups|\.mockups|video-assets)(?:\/|$)/.test(at)) this.conflicts.push('protected .env in an asset tree; original retained')
        if (e.name === '.env' || e.name.endsWith('.lock') || e.name.endsWith('.answering')) return []
        if (e.isSymbolicLink()) throw Error(`symlink: ${path.join(at, e.name)}`)
        return e.isDirectory() ? walk(path.join(at, e.name)) : [path.join(at, e.name)]
      })
    }
    return [...new Set([...walk(dir), ...[...this.changes.keys()].filter(file => file.startsWith(dir + path.sep))])]
      .filter(file => !this.changes.has(file) || this.changes.get(file) !== null).sort()
  }
  move(from: string, to: string, transform = (v: Buffer) => v) {
    const value = this.read(from)
    if (value === null) return
    const next = transform(value), held = this.read(to)
    if (held !== null && !held.equals(next)) { this.conflicts.push(`${path.relative(this.root, from)} -> ${path.relative(this.root, to)}`); return }
    this.put(to, next, this.beforeModes.get(from) ?? this.modes.get(from))
    // An explicitly supplied machine-home original is retained.
    if (from.startsWith(this.root + path.sep)) this.put(from, null)
  }
  tree(from: string, to: string, transform = (_file: string, data: Buffer) => data) {
    for (const file of this.files(from)) this.move(file, path.join(to, path.relative(from, file)), data => transform(file, data))
  }
  merge(from: string, to: string, heading = '') {
    const value = this.read(from)
    if (!value) return
    const old = this.read(to)?.toString().trim() ?? '', carried = value.toString().trim()
    if (!old.includes(carried)) this.put(to, `${[old, heading, carried].filter(Boolean).join('\n\n')}\n`)
    this.put(from, null)
  }
  plan() {
    try { this.prepare() } catch (e: any) { this.conflicts.push(e.message) }
    for (const file of [path.join(this.state, 'sessions.json'), ...(this.legacyState ? [path.join(this.legacyState, 'sessions.json')] : [])]) {
      const saved = this.before.get(file) ?? this.read(file)
      const runs = saved ? JSON.parse(saved.toString()).runs ?? [] : []
      for (const run of runs.filter((r: any) => r.status === 'running')) {
        const owner = rename(run.specAgent ?? run.agent ?? '')
        const id = run.cardId ?? run.id
        const affected = [...this.changes.keys()].some(changed => {
          if (path.basename(changed) === 'akb-contract.json') return false
          if (/\/memory\/agents\//.test(changed)) return !owner || ['memory-pruner', 'chat-reviewer'].includes(owner) || changed.includes(`/agents/${owner}/`) || (owner === 'ui-designer' && /\/(?:copywriting|illustrator)\//.test(changed))
          if (changed === file) return !equal(run, convertRecord(run, '', this.runtimeRows))
          if (id && /\/(?:assets|mockups|todo|previews)\//.test(changed)) return new RegExp(`/(${id})(?:[-/.]|$)`).test(changed)
          if (changed.includes('/deliveries/')) return path.basename(changed, '.json') === run.deliveryId
          return true
        })
        if (affected) this.conflicts.push(`active runs: ${id ?? run.sessionId ?? 'unknown'} needs a saved checkpoint before conversion`)
      }
    }
    return this.report()
  }
  prepare() {
    if (this.legacyState) {
      if (this.legacyState.startsWith(this.root + path.sep)) throw Error('legacyState must be an explicit machine-home source')
      const record = JSON.parse(this.read(path.join(this.legacyState, 'board.json'))?.toString() ?? '{}')
      if (!record.board || path.resolve(record.board) !== this.board) throw Error('legacy state belongs to a different board')
      this.tree(this.legacyState, this.state)
    }
    this.tree(path.join(this.board, 'skills'), path.join(this.board, 'agents'), (file, data) => /\/(?:SKILL|AGENT)\.md$/.test(file) ? Buffer.from(convertDefinition(data.toString())) : data)
    for (const base of [this.board, this.state]) this.tree(path.join(base, '.mockups'), path.join(this.state, 'assets'), this.assetFile)
    this.tree(path.join(this.state, 'mockups'), path.join(this.state, 'assets'), this.assetFile)
    const config = path.join(this.state, 'ui.config.json')
    this.move(path.join(this.board, 'ui.config.json'), config)
    const cfg = JSON.parse(this.read(config)?.toString() ?? '{}')
    const localFile = path.join(this.board, '.local.json')
    const local = JSON.parse(this.read(localFile)?.toString() ?? '{}')
    const env = path.join(this.board, '.env')
    const needsNames = !Array.isArray(cfg.runtimes) && ('harness' in cfg || 'harnessSettings' in cfg)
    const keyNames = needsNames && fs.existsSync(env) ? new Set([...fs.readFileSync(env, 'utf8').matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(match => match[1]!)) : new Set<string>()
    const next = convertConfig(cfg, local, keyNames)
    this.runtimeRows = next.runtimes ?? []
    if (!equal(cfg, next)) this.put(config, json(next))
    if (local.agents) { delete local.agents; this.put(localFile, json(local)) }
    const memory = path.join(this.board, 'memory'), agents = path.join(memory, 'agents')
    for (const name of ['readme.md', 'goal.md', 'decisions.md', 'rejected.md', 'redesign.md']) this.move(path.join(this.board, name), path.join(memory, name))
    for (const name of ['decisions.md', 'rejected.md', 'redesign.md']) this.move(path.join(memory, name), path.join(agents, 'planner', name))
    this.move(path.join(memory, 'product.md'), path.join(memory, 'project.md'))
    this.merge(path.join(memory, 'goal.md'), path.join(agents, 'planner/decisions.md'), '## Direction')
    for (const entry of fs.existsSync(memory) ? fs.readdirSync(memory, { withFileTypes: true }) : []) {
      if (!entry.isDirectory() || ['agents', 'studios', 'competitors'].includes(entry.name) || fs.existsSync(path.join(memory, entry.name, 'MEMORY.md'))) continue
      for (const name of ['decisions.md', 'rejected.md', 'redesign.md', 'goal.md', 'readme.md']) {
        const target = name === 'readme.md' ? path.join(memory, name) : path.join(agents, 'planner', entry.name, name === 'goal.md' ? 'decisions.md' : name)
        this.merge(path.join(memory, entry.name, name), target, name === 'readme.md' ? `## ${entry.name}` : '')
      }
    }
    for (const file of this.files(agents)) if (path.dirname(file) === agents && file.endsWith('.md')) this.move(file, path.join(agents, rename(path.basename(file, '.md')), 'redesign.md'))
    for (const [was, name] of Object.entries(names)) {
      this.tree(path.join(agents, was), path.join(agents, name), (file, data) => this.assetFile(file, data))
      this.tree(path.join(this.board, 'agents', was), path.join(this.board, 'agents', name), (file, data) => /\/(?:AGENT|SKILL|STUDIO)\.md$/.test(file) ? Buffer.from(convertDefinition(data.toString())) : this.assetFile(file, data))
      this.move(path.join(this.board, 'rules', `${was}.md`), path.join(this.board, 'rules', `${name}.md`))
    }
    for (const was of ['copywriting', 'illustrator']) for (const file of this.files(path.join(agents, was))) {
      if (!file.endsWith('.md')) continue
      const name = path.basename(file) === 'redesign.md' ? 'redesign.md' : was === 'copywriting' ? 'writing.md' : 'style.md'
      this.merge(file, path.join(agents, 'ui-designer', name), `## ${was === 'copywriting' ? 'Writing' : 'Illustration'}`)
    }
    for (const file of this.files(path.join(agents, 'planner'))) {
      if (!['decisions.md', 'rejected.md', 'redesign.md'].includes(path.basename(file)) || path.dirname(file) !== path.join(agents, 'planner')) continue
      const text = this.read(file)!.toString(), known = this.read(path.join(this.board, 'modules.md'))?.toString() ?? ''
      const modules = [...known.matchAll(/^- \*\*([^*]+)\*\*/gm)].map(m => m[1]!)
      let kept = text
      for (const module of modules) {
        const escaped = module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const re = new RegExp(`^## ${escaped}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm')
        const found = re.exec(kept)
        if (!found) continue
        const target = path.join(agents, 'planner', module, path.basename(file)), current = this.read(target)?.toString().trim() ?? ''
        const carried = found[1]!.trim().replace(/^#(#{2,5}) /gm, '$1 ')
        if (carried && !current.includes(carried)) this.put(target, `${[current, carried].filter(Boolean).join('\n\n')}\n`)
        kept = kept.replace(re, '')
      }
      if (kept !== text) this.put(file, kept)
    }
    for (const lead of ['software-planner', 'planner']) this.merge(path.join(this.board, 'rules', `${lead}.md`), path.join(this.board, 'rules/studios/coding.md'))
    for (const [flow, agent] of Object.entries(flows)) this.merge(path.join(this.board, 'rules', `${flow}.md`), path.join(this.board, 'rules', `${agent}.md`))
    for (const file of this.files(path.join(agents, 'planner'))) if (path.basename(file) === 'dismissed.md') this.merge(file, path.join(path.dirname(file), 'rejected.md'))
    const all = new Set([...this.files(this.board), ...this.files(this.state), ...this.changes.keys()])
    for (const file of all) {
      if (!/\.(?:json|md)$/.test(file)) continue
      if (file.endsWith('/.env') || (/\/(?:sessions|logs|chats)\//.test(file) && !file.endsWith('.plan.json')) || /\.lock(?:\/|$)/.test(file)) continue
      const value = this.read(file)
      if (!value) continue
      const relative = path.relative(this.board, file)
      if (file.startsWith(path.join(this.state, 'assets') + path.sep) || file.startsWith(path.join(this.state, 'previews/assets') + path.sep) || /^assets\/\d+\//.test(relative)) {
        const changed = this.assetFile(file, value)
        if (!changed.equals(value)) this.put(file, changed)
        continue
      }
      if (/\.(?:json)$/.test(file) && (file.startsWith(this.state + path.sep) || /^(?:deliveries\/[^/]+|assets\/task_[^/]+|\.sync\/[^/]+)\.json$/.test(relative))) {
        const parsed = JSON.parse(value.toString())
        const changed = this.relocate(/^assets\/task_[^/]+\.json$/.test(relative)
          ? Object.fromEntries(Object.entries(parsed).map(([src, ref]) => [assets(src), convertRecord(ref)]))
          : convertRecord(/\/previews\/\d+\.json$/.test(file) ? renamedKeys(parsed, 'preview progress') : parsed, '', next.runtimes ?? []))
        if (!equal(parsed, changed)) this.put(file, json(changed))
      } else if (/\.(?:md)$/.test(file)) {
        const text = value.toString(), converted = /\/(?:AGENT|SKILL|STUDIO)\.md$/.test(file) ? convertDefinition(text) : convertCard(text)
        let changed = converted
        if (/^todo\/.*\.md$|^\.archive\/.*\.md$/.test(relative)) changed = convertSourceCard(changed, name => {
          const at = this.files(path.join(this.board, 'triage')).find(p => path.basename(p) === name)
          if (!at) return undefined
          const front = splitFrontmatter(this.read(at)!.toString()).meta
          const item = parseYamlBlock(front ?? '')
          return { id: String(item.source_id ?? ''), ...(item.url ? { source: String(item.url) } : /^#\d+$/.test(String(block(item.meta).source ?? '')) ? { source: String(block(item.meta).source) } : {}) }
        })
        if (/^triage\//.test(relative)) changed = convertTriage(changed)
        if (changed !== text) this.put(file, changed)
        if (/\/agents\/[^/]+\/SKILL\.md$/.test(file)) this.move(file, path.join(path.dirname(file), 'AGENT.md'))
      }
    }
    this.recurring()
    this.put(path.join(this.state, 'akb-contract.json'), json({ contract: 17 }))
  }
  relocate(value: any, key = ''): any {
    if (!this.legacyState) return value
    if (typeof value === 'string' && ['plan', 'path', 'logPath', 'folder', 'pictures', 'transcript'].includes(key) && value.startsWith(this.legacyState + path.sep)) {
      const relative = path.relative(this.legacyState, value)
      return key === 'plan' ? relative.split(path.sep).join('/') : path.join(this.state, relative)
    }
    if (Array.isArray(value)) return value.map(item => this.relocate(item, key))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, this.relocate(item, name)]))
    return value
  }
  assetFile = (file: string, data: Buffer): Buffer => /\.(?:md|html|css|js|mjs|json|svg|tmj|tsj|tmx|tsx|txt)$/.test(file) ? Buffer.from(assets(data.toString())) : data
  recurring() {
    const dir = path.join(this.board, 'todo/recurring')
    for (const file of this.files(dir)) {
      if (!/^\d+.*\.md$/.test(path.basename(file)) && path.basename(file) !== 'root.md') continue
      const value = this.read(file); if (!value) continue
      const { meta, body } = splitFrontmatter(value.toString()); if (!meta) throw Error('recurring card has invalid metadata')
      const parsed = parseYamlBlock(meta)
      if ((Array.isArray(parsed.questions) && parsed.questions.length) || (Array.isArray(parsed.blocked_by) && parsed.blocked_by.length)) throw Error('recurring card has unresolved questions or dependencies; retain it for review')
      const base = path.basename(file) === 'root.md' ? path.basename(path.dirname(file)) : path.basename(file, '.md')
      const name = base.replace(/^\d+-/, ''), studio = String(parsed.studio || 'coding')
      if (!/^\w[\w-]*$/.test(name)) throw Error('recurring agent has invalid name')
      const target = path.join(this.board, 'agents', name, 'AGENT.md')
      const instructions = `---\nname: ${name}\ndescription: ${yamlScalar(parsed.title || name)}\n---\n${body}`
      if (this.read(target) && this.read(target)!.toString() !== instructions) throw Error(`recurring agent conflict: ${name}`)
      this.put(target, instructions)
      const cfgFile = path.join(this.state, 'ui.config.json'), cfg = JSON.parse(this.read(cfgFile)?.toString() ?? '{}')
      cfg.studios ??= {}; cfg.studios[studio] ??= {}; cfg.studios[studio].scheduled ??= []
      if (!cfg.studios[studio].scheduled.some((v: any) => v.agent === name)) cfg.studios[studio].scheduled.push({ agent: name, cadence: parsed.cadence || '1d at 09:30', lastRun: parsed.last_run || '', ...(parsed.cadence ? {} : { off: true }) })
      this.put(cfgFile, json(cfg))
      // Preserve the complete original, including unanswered questions and dependencies, as a plan.
      this.move(file, path.join(this.state, 'plans/archive', `${base}.md`))
      if (path.basename(file) === 'root.md') this.tree(path.dirname(file), path.dirname(target))
    }
  }
  report() { return { board: this.board, changes: [...this.changes].map(([file, data]) => ({ path: path.relative(this.root, file), before: hash(this.before.get(file)!), after: hash(data), beforeMode: this.beforeModes.get(file) ?? null, afterMode: data === null ? null : this.modes.get(file) })), conflicts: this.conflicts } }
  apply(receipt: string) {
    if (this.conflicts.length) throw Error('conversion blocked; originals retained')
    if (fs.existsSync(receipt)) throw Error('receipt already exists; choose a new receipt for a new conversion')
    for (const [file, before] of this.before) {
      if (file.endsWith('/.env')) throw Error('secret files cannot be converted')
      const actual = fs.existsSync(file) ? fs.readFileSync(file) : null
      if (hash(actual) !== hash(before)) throw Error(`changed since dry-run: ${path.relative(this.root, file)}`)
    }
    const backup = `${receipt}.files`; fs.mkdirSync(path.dirname(receipt), { recursive: true, mode: 0o700 }); fs.mkdirSync(backup, { mode: 0o700 })
    const result = { ...this.report(), root: this.root, backup, status: 'prepared' }
    for (const [file] of this.changes) {
      const original = this.before.get(file)
      if (original) { const to = path.join(backup, path.relative(this.root, file)); fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); fs.writeFileSync(to, original, { mode: 0o600 }) }
    }
    fs.writeFileSync(receipt, json(result), { mode: 0o600, flag: 'wx' })
    for (const [file, data] of this.changes) {
      if (data === null) fs.rmSync(file, { force: true })
      else { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${randomUUID()}.tmp`; fs.writeFileSync(tmp, data, { mode: this.modes.get(file), flag: 'wx' }); fs.renameSync(tmp, file) }
    }
    for (const [file, data] of this.changes) if (hash(fs.existsSync(file) ? fs.readFileSync(file) : null) !== hash(data)) throw Error('verification failed; retain receipt and stop rollout')
    result.status = 'verified'; fs.writeFileSync(receipt, json(result), { mode: 0o600 })
    return result
  }
}

export function rollback(receipt: string) {
  const saved = JSON.parse(fs.readFileSync(receipt, 'utf8'))
  for (const entry of saved.changes) {
    const file = path.resolve(saved.root, entry.path)
    if (!file.startsWith(saved.root + path.sep)) throw Error('receipt path outside project')
    if (![entry.before, entry.after].includes(hash(fs.existsSync(file) ? fs.readFileSync(file) : null))) throw Error(`changed after conversion: ${entry.path}`)
  }
  for (const entry of saved.changes) {
    const file = path.join(saved.root, entry.path)
    if (entry.before === null) fs.rmSync(file, { force: true })
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); const original = path.join(saved.backup, entry.path); if (hash(fs.readFileSync(original)) !== entry.before) throw Error('damaged backup'); fs.copyFileSync(original, file); if (entry.beforeMode !== null) fs.chmodSync(file, entry.beforeMode) }
  }
  return { restored: saved.changes.length }
}
