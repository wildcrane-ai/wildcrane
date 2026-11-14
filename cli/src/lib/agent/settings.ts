import fs from 'node:fs'
import path from 'node:path'
import { forgetFileMemos } from '../file-memo'

import { AUTO_CADENCE, formatStamp, parseCadence } from '../cadence'
import { ENV_FILE, KANBAN_GITIGNORE, UI_CONFIG } from '../paths'
import { refusal, type CadenceSchedule, type Saved } from './types'

// ---- ui.config.json --------------------------------------------------------

/** One block out of the config file — a runtime's settings, or one spec agent's entry.
 *  Anything that isn't a plain object reads as empty, so a hand-edit that put a string or a
 *  list where a block belongs is ignored rather than spread into a run. */
export function configBlock(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/** Read and parse the whole config object. Throws on a malformed file so a writer never
 *  clobbers a user's settings; a missing file is an empty object. */
export function readConfigRaw(): Record<string, unknown> {
  if (!fs.existsSync(UI_CONFIG)) return {}
  return JSON.parse(fs.readFileSync(UI_CONFIG, 'utf8'))
}

/** The config as a reader takes it: an unreadable or malformed file holds nothing, so a
 *  hand-edit that broke the JSON runs the defaults rather than stopping the board. Writers
 *  use `readConfigRaw` instead — a save that overwrote a file it couldn't read would lose
 *  the user's settings. */
export function safeConfig(): Record<string, unknown> {
  try {
    return readConfigRaw()
  } catch {
    return {}
  }
}

/** The limit a board that hasn't said otherwise runs on, in minutes. */
export const SILENCE_MINUTES = 10

/** How long a run or a chat waits, saying nothing, on the agent's background tasks (#1540).
 *  An object so a test can shorten it. */
export const BACKGROUND_WAIT = { minutes: 120 }

/** How long a run may produce nothing before the board ends it, in minutes. `0` never ends
 *  one. A missing, negative or unreadable value is the default: a file nobody can parse is
 *  not a reason to leave hung runs holding their cards forever. */
export function silenceMinutes(): number {
  try {
    const raw = readConfigRaw().silenceMinutes
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : SILENCE_MINUTES
  } catch {
    return SILENCE_MINUTES
  }
}

/** Save it, in whole minutes. Back at the default drops the key rather than writing 10. */
export function setSilenceMinutes(minutes: number): Saved {
  if (!Number.isInteger(minutes) || minutes < 0) {
    return { ok: false, ...refusal('minutes', 'that setting is a whole number of minutes, or 0 to switch it off') }
  }
  return writeConfig((cfg) => {
    if (minutes === SILENCE_MINUTES) delete cfg.silenceMinutes
    else cfg.silenceMinutes = minutes
  })
}

/** One spec agent's entry, read. */
export interface SpecAgentEntry {
  enabled: boolean
  /** Every other key the file carries for this agent, exactly as it holds them: a role's own
   *  settings (#1469), and keys a release used to read, kept only so a write puts them back. */
  extra: Record<string, unknown>
}

const BOARD_SPEC_KEYS = ['enabled', 'runtime']

function parseSpecEntry(value: unknown): SpecAgentEntry | null {
  if (typeof value === 'boolean') return { enabled: value, extra: {} }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const extra: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(raw)) {
    if (!BOARD_SPEC_KEYS.includes(key)) extra[key] = v
  }
  return { enabled: raw.enabled !== false, extra }
}

/** Which spec agents the file says something about, and what it says. A malformed file
 *  reads as nothing saved at all: an agent nobody can decide about is an agent that runs. */
export function specAgentEntries(): Record<string, SpecAgentEntry> {
  let cfg: Record<string, unknown>
  try {
    cfg = readConfigRaw()
  } catch {
    return {}
  }
  const saved: Record<string, SpecAgentEntry> = {}
  for (const [name, value] of Object.entries(configBlock(cfg.specAgents))) {
    const entry = parseSpecEntry(value)
    if (entry) saved[name] = entry
  }
  return saved
}

/** Drop one spec agent's entry entirely — its switch and whatever
 *  else it carried. Called when the agent itself is deleted: a settings block for an agent
 *  nobody has is a line the user can neither read nor reach. */
export function forgetSpecAgent(name: string): Saved {
  return writeConfig((cfg) => {
    const block = { ...configBlock(cfg.specAgents) }
    delete block[name]
    if (Object.keys(block).length) cfg.specAgents = block
    else delete cfg.specAgents
  })
}

/** Read the config, apply one change, write it back — the shared body of every setter,
 *  here and in ./runtimes.ts. A file that won't parse fails the save instead of overwriting
 *  it: losing the user's settings is worse than a failed save. */
export function writeConfig(change: (cfg: Record<string, unknown>) => void): Saved {
  let cfg: Record<string, unknown>
  try {
    cfg = readConfigRaw()
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      ...refusal('fileParse', `couldn't save: ${UI_CONFIG} won't parse (${why}). Fix the file, then try again.`, {
        path: UI_CONFIG,
        details: why,
      }),
    }
  }
  change(cfg)
  try {
    fs.mkdirSync(path.dirname(UI_CONFIG), { recursive: true })
    fs.writeFileSync(UI_CONFIG, JSON.stringify(cfg, null, 2) + '\n')
    forgetFileMemos()
    return { ok: true }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return { ok: false, ...refusal('fileWrite', `couldn't write ${UI_CONFIG}: ${why}`, { path: UI_CONFIG, details: why }) }
  }
}

function parseLine(line: string): { name: string; value: string } | null {
  const text = line.trim()
  if (!text || text.startsWith('#')) return null
  const eq = text.indexOf('=')
  if (eq <= 0) return null
  const name = text.slice(0, eq).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null
  return { name, value: unquote(text.slice(eq + 1).trim()) }
}

function unquote(value: string): string {
  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
    return value.slice(1, -1)
  }
  return value
}

/** Every variable the file sets, by name. A missing or unreadable file holds nothing — a
 *  board with no keys is the normal case, not a failure. A line with an empty value is
 *  left out: an empty key and a missing one mean the same thing. */
export function readEnvFile(): Record<string, string> {
  let text: string
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8')
  } catch {
    return {}
  }
  const values: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const pair = parseLine(line)
    if (pair && pair.value) values[pair.name] = pair.value
  }
  return values
}

const IGNORE_BLOCK = "# The board's API keys — never commit them.\n.env\n"

function ensureIgnored(): Saved {
  try {
    if (!fs.existsSync(KANBAN_GITIGNORE)) {
      fs.mkdirSync(path.dirname(KANBAN_GITIGNORE), { recursive: true })
      fs.writeFileSync(KANBAN_GITIGNORE, IGNORE_BLOCK)
      return { ok: true }
    }
    const text = fs.readFileSync(KANBAN_GITIGNORE, 'utf8')
    if (text.split('\n').some((line) => line.trim() === '.env')) return { ok: true }
    const separator = !text || text.endsWith('\n') ? '' : '\n'
    fs.writeFileSync(KANBAN_GITIGNORE, `${text}${separator}${IGNORE_BLOCK}`)
    return { ok: true }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      ...refusal('gitignoreWrite', `couldn't write ${KANBAN_GITIGNORE} to keep the key out of git: ${why}`, {
        path: KANBAN_GITIGNORE,
        details: why,
      }),
    }
  }
}

export function setSecret(name: string, value: string): Saved {
  const ignored = ensureIgnored()
  if (!ignored.ok) return ignored

  let lines: string[]
  try {
    lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split('\n') : []
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return { ok: false, ...refusal('fileRead', `couldn't read ${ENV_FILE}: ${why}`, { path: ENV_FILE, details: why }) }
  }

  const next = value.trim()
  const kept: string[] = []
  let written = false
  for (const line of lines) {
    const pair = parseLine(line)
    if (!pair || pair.name !== name) {
      kept.push(line)
      continue
    }
    if (!next || written) continue // cleared, or a duplicate of the line we just rewrote
    kept.push(`${name}=${next}`)
    written = true
  }
  let text = kept.join('\n')
  if (text && !text.endsWith('\n')) text += '\n'
  if (next && !written) text += `${name}=${next}\n`

  try {
    fs.writeFileSync(ENV_FILE, text, { mode: 0o600 })
    return { ok: true }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return { ok: false, ...refusal('fileWrite', `couldn't write ${ENV_FILE}: ${why}`, { path: ENV_FILE, details: why }) }
  }
}

export type ScheduleKey = 'memoryPrune' | 'projectDescription'

const stringIn = (block: Record<string, unknown>, key: string): string =>
  typeof block[key] === 'string' ? (block[key] as string).trim() : ''

/** What the file says about one schedule. A cadence nothing parses, or a file that won't,
 *  reads as the default. */
function readSchedule(key: ScheduleKey): CadenceSchedule {
  const block = configBlock(safeConfig()[key])
  const saved = stringIn(block, 'cadence')
  return {
    enabled: block.off !== true,
    cadence: saved && parseCadence(saved) ? saved : AUTO_CADENCE,
    lastRun: stringIn(block, 'lastRun'),
    ...(stringIn(block, 'since') ? { since: stringIn(block, 'since') } : {}),
  }
}

function stampSchedule(key: ScheduleKey, when: Date): boolean {
  return writeConfig((cfg) => {
    cfg[key] = { ...configBlock(cfg[key]), lastRun: formatStamp(when) }
  }).ok
}

export const stampMemoryPrune = (when: Date = new Date()): void => void stampSchedule('memoryPrune', when)

// The block with `reviewedBefore` pinned: until something writes it, it is `lastRun`.
function pinned(block: Record<string, unknown>): Record<string, unknown> {
  return typeof block.reviewedBefore === 'string' ? block : { ...block, reviewedBefore: stringIn(block, 'lastRun') }
}

/** Record a review that passed, stamped with when that review STARTED. */
export function stampMemoryReview(when: Date): void {
  writeConfig((cfg) => {
    cfg.memoryReview = { ...pinned(configBlock(cfg.memoryReview)), lastRun: formatStamp(when) }
  })
}

const queueIn = (cfg: Record<string, unknown>): number[] =>
  Array.isArray(cfg.reflectQueue) ? cfg.reflectQueue.filter((id): id is number => Number.isInteger(id) && id > 0) : []

export const reflectQueue = (): number[] => queueIn(safeConfig())

export function queueReflect(ids: number[]): void {
  writeConfig((cfg) => {
    const queue = queueIn(cfg)
    cfg.reflectQueue = [...queue, ...ids.filter((id) => !queue.includes(id))]
  })
}

export function dropReflected(ids: number[]): void {
  writeConfig((cfg) => {
    cfg.reflectQueue = queueIn(cfg).filter((id) => !ids.includes(id))
  })
}

export const stampProjectDescription = (when: Date): void => void stampSchedule('projectDescription', when)
