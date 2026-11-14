import { DEFAULT_HARNESS, HARNESSES, MODEL_KEY, harnessByName } from './harnesses'
import { configBlock, safeConfig, setSecret, writeConfig } from './settings'
import { refusal, type RunRefusal, type Saved } from './types'

/** One runtime, as the board holds it. */
export interface Runtime {
  /** Stable, and safe to write into `docs/kanban/.env`'s variable names. Never changes. */
  id: string
  /** The user's own words. Unique on the board, never empty, and nothing is keyed by it. */
  name: string
  /** The CLI it runs — a name out of `HARNESSES`, or one this build doesn't ship. */
  harness: string
  /** That harness's own declared settings, plus the optional `command` override. A `secret`
   *  is never here: its value lives in `docs/kanban/.env` under `secretVar`'s name. */
  settings: Record<string, string>
  /** Explicit environment-variable references; never secret values. */
  secretRefs?: Record<string, string>
  /** Why this computer cannot run it (#625): set by a Runner for a pick bound to another computer. */
  away?: string
}

/** The id of the first row, which every board has. */
export const GLOBAL_ID = 'global'

/** What it is called, everywhere. */
export const GLOBAL_NAME = 'Global default'

// ---- reading ----------------------------------------------------------------

export function readRuntimes(cfg: Record<string, unknown> = safeConfig()): Runtime[] {
  const saved = Array.isArray(cfg.runtimes) ? cfg.runtimes.map(parseRuntime).filter(isRuntime) : null
  const list = saved?.length ? dedupe(saved) : []
  const global = list.find((r) => r.id === GLOBAL_ID)
  const rest = list.filter((r) => r.id !== GLOBAL_ID)
  return [global ?? { id: GLOBAL_ID, name: GLOBAL_NAME, harness: DEFAULT_HARNESS.name, settings: {} }, ...rest]
}

// One entry as the file holds it, or null for a shape we can't read — a hand-edit that put a
// string where a row belongs is dropped rather than run as a row with no harness.
function parseRuntime(value: unknown): Runtime | null {
  const raw = configBlock(value)
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const harness = typeof raw.harness === 'string' ? raw.harness.trim() : ''
  if (!id || !harness) return null
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id
  const settings: Record<string, string> = {}
  for (const [key, v] of Object.entries(configBlock(raw.settings))) {
    if (typeof v === 'string' && v.trim()) settings[key] = v.trim()
  }
  const away = typeof raw.away === 'string' && raw.away.trim() ? { away: raw.away.trim() } : {}
  const secretRefs = Object.fromEntries(Object.entries(configBlock(raw.secretRefs)).filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) as Record<string, string>
  return { id, name: id === GLOBAL_ID ? GLOBAL_NAME : name, harness, settings, ...away, ...(Object.keys(secretRefs).length ? { secretRefs } : {}) }
}

const isRuntime = (r: Runtime | null): r is Runtime => r !== null

// Two rows on one id would make the id mean two things — the first wins, the rest go.
function dedupe(list: Runtime[]): Runtime[] {
  const seen = new Set<string>()
  return list.filter((r) => !seen.has(r.id) && seen.add(r.id))
}

export function pickRuntime(list: Runtime[], pin?: string, harness?: string): Runtime {
  const rows = harness ? list.filter((r) => r.harness === harness) : list
  const want = pin?.trim()
  const found = want && rows.find((r) => r.id === want)
  if (found) return found
  return rows[0] ?? { id: '', name: harness ?? '', harness: harness ?? DEFAULT_HARNESS.name, settings: {} }
}

/** One runtime by id, or nothing. */
export function runtimeById(id: string, list: Runtime[] = readRuntimes()): Runtime | undefined {
  return list.find((r) => r.id === id)
}

// ---- the keys ---------------------------------------------------------------

export function secretVar(env: string, runtimeId: string): string {
  return `${env}__${runtimeId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`
}

export const runtimeSecretVar = (env: string, runtime: Runtime): string => runtime.secretRefs?.[env] ?? secretVar(env, runtime.id)

/** Save one runtime's key, or clear it with an empty value. The value is never read back. */
export function setRuntimeSecret(id: string, settingKey: string, value: string): Saved {
  const runtime = runtimeById(id)
  if (!runtime) return { ok: false, ...noRuntime(id) }
  const setting = harnessByName(runtime.harness)?.settings.find((s) => s.key === settingKey)
  if (!setting?.env || setting.kind !== 'secret') {
    return { ok: false, ...refusal('runtimeKey', `"${settingKey}" is not a key ${runtime.name} takes.`, { key: settingKey, name: runtime.name }) }
  }
  return setSecret(runtimeSecretVar(setting.env, runtime), value)
}

// ---- which runtime each agent runs -------------------------------------------

export function readAgentRuntime(cfg: Record<string, unknown> = safeConfig()): Record<string, string> {
  const block = configBlock(cfg.agentRuntime)
  const out: Record<string, string> = {}
  for (const [agent, value] of Object.entries(block)) {
    const name = typeof value === 'string' ? value.trim() : ''
    if (name) out[agent] = name
  }
  return out
}

/** The runtime bound to this exact agent name. */
export function runtimeOfAgent(
  name: string,
  table: Record<string, string> = readAgentRuntime(),
): string | undefined {
  return table[name]
}

const keepsPick = (id: string): boolean => !!id && id !== GLOBAL_ID

/** Bind an agent to a runtime, or clear its binding. */
export function setAgentRuntime(agent: string, runtime: string): Saved {
  if (runtime && !runtimeById(runtime)) return { ok: false, ...noRuntime(runtime) }
  return writeConfig((cfg) => {
    const block = { ...readAgentRuntime(cfg) }
    delete block[agent]
    if (keepsPick(runtime)) block[agent] = runtime
    else delete block[agent]
    writePicks(cfg, block)
  })
}

/** A Runner's whole set of agent picks (#625): every runtime but **Global default** becomes the
 *  ones these picks name, and each agent named runs its own. */
export function replaceAgentRuntimes(picks: Record<string, Runtime>): Saved {
  return writeConfig((cfg) => {
    const global = readRuntimes(cfg)[0]!
    const rows = new Map<string, Runtime>()
    for (const r of Object.values(picks)) if (r.id !== GLOBAL_ID) rows.set(r.id, r)
    cfg.runtimes = [global, ...rows.values()]

    const block = Object.fromEntries(Object.entries(picks).filter(([, r]) => rows.has(r.id)).map(([agent, r]) => [agent, r.id]))
    if (Object.keys(block).length) cfg.agentRuntime = block
    else delete cfg.agentRuntime
  })
}

/** Drop one agent's pick. Called when the agent itself is deleted. */
export function forgetAgentRuntime(agent: string): Saved {
  return setAgentRuntime(agent, '')
}

// ---- writing the list --------------------------------------------------------

/** Add a runtime, on the harness named. Its id is generated from the name to what
 *  `docs/kanban/.env` parses, and it is what everything keys by from here on. */
export function addRuntime(name: string, harness: string): Saved & { id?: string } {
  const wanted = name.trim()
  const bad = nameError(wanted)
  if (bad) return { ok: false, ...bad }
  if (!harnessByName(harness)) return { ok: false, ...noHarness(harness) }
  const list = readRuntimes()
  const id = freeId(wanted, new Set(list.map((r) => r.id)))
  const res = save([...list, { id, name: wanted, harness, settings: {} }])
  return res.ok ? { ok: true, id } : res
}

export function setRuntimeHarness(id: string, harness: string): Saved {
  const known = harnessByName(harness)
  if (!known) return { ok: false, ...noHarness(harness) }
  return change(id, (runtime) => {
    if (runtime.harness === harness) return runtime
    const keep = new Set([...known.settings.map((s) => s.key), 'command'])
    keep.delete(MODEL_KEY)
    const settings = Object.fromEntries(Object.entries(runtime.settings).filter(([key]) => keep.has(key)))
    return { ...runtime, harness, settings }
  })
}

export function setRuntimeSetting(id: string, key: string, value: string): Saved {
  return change(id, (runtime) => {
    const settings = { ...runtime.settings }
    const next = value.trim()
    if (next) settings[key] = next
    else delete settings[key]
    return { ...runtime, settings }
  })
}

/** Save the harness **Global default** runs — `akb raw agent use`, and the board's own answer to
 *  "what does a run spawn". Every other runtime is untouched. */
export function setHarness(name: string): Saved {
  return setRuntimeHarness(GLOBAL_ID, name)
}

const noRuntime = (id: string): RunRefusal => refusal('runtimeNotFound', `no runtime called "${id}" on this board.`, { id })

const noHarness = (name: string): RunRefusal =>
  refusal('harnessNotFound', `no harness called "${name}" — this version runs: ${HARNESSES.map((h) => h.name).join(', ')}.`, { name })

// Read the list, change one row, write it back. The pre-runtimes keys go with the first write:
// the list is the whole truth now, and leaving them behind would leave two answers on disk.
function change(id: string, edit: (runtime: Runtime) => Runtime): Saved {
  const list = readRuntimes()
  if (!list.some((r) => r.id === id)) return { ok: false, ...noRuntime(id) }
  return save(list.map((r) => (r.id === id ? edit(r) : r)))
}

function save(list: Runtime[]): Saved {
  return writeConfig((cfg) => {
    const picks = readAgentRuntime(cfg)
    cfg.runtimes = list

    writePicks(cfg, picks, list)
  })
}

function writePicks(cfg: Record<string, unknown>, picks: Record<string, string>, list = readRuntimes(cfg)): void {
  const block: Record<string, string> = {}
  for (const [agent, pin] of Object.entries(picks)) {
    const row = pickRuntime(list, pin)
    if (keepsPick(row.id)) block[agent] = row.id
  }

  if (Object.keys(block).length) cfg.agentRuntime = block
  else delete cfg.agentRuntime
}

/** Why this name can't be used, or null when it can. A name is the user's own words and holds
 *  anything — it is unique on the board and not empty, and that is the whole of the rule. */
function nameError(name: string, self?: string): RunRefusal | null {
  if (!name) return refusal('runtimeUnnamed', 'a runtime needs a name.')
  const clash = readRuntimes().find((r) => r.id !== self && r.name.toLowerCase() === name.toLowerCase())
  return clash ? refusal('runtimeTaken', `this board already has a runtime called "${clash.name}".`, { name: clash.name }) : null
}

// An id nothing else on the board has, generated from the name to what `docs/kanban/.env`
// parses: lowercase letters, digits and single underscores, never starting with a digit.
function freeId(name: string, taken: Set<string>): string {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!base || /^[0-9]/.test(base)) base = `rt_${base}`.replace(/_+$/, '')
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const next = `${base}_${n}`
    if (!taken.has(next)) return next
  }
}

// ---- what a screen draws -----------------------------------------------------
