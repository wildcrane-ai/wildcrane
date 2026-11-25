import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { antigravityModels } from '../../cli/src/lib/agent/harnesses/antigravity'
import { LANGUAGE_ENV } from '../../cli/src/lib/agent/language'
import { splitCommand } from '../../cli/src/lib/agent/argv'
import { HARNESSES as ALL } from '../../cli/src/lib/agent/harnesses'
import { installedCommand, planLaunch, promptInput } from '../../cli/src/lib/agent/harnesses/launch'
import { withSystemProxy } from '../../cli/src/lib/agent/proxy'
import { MODEL_KEY, type Harness } from '../../cli/src/lib/agent/harnesses/types'
import { copyEnv, locate, spawnName, warm } from '../../cli/src/lib/agent/locate'
import { spawnable } from '../../cli/src/lib/agent/spawnable'
import { providerFor, settingArgs, type SettingValues } from '../../cli/src/lib/agent/run-settings'
import type { HarnessSetting } from '../../cli/src/lib/agent/types'
import type { RunEvent, StreamRenderer, TurnEnd } from '../../cli/src/lib/agent/wire'
import { obj, str } from '../../cli/src/lib/agent/wire/json'
import { connect } from '../../cli/src/lib/agent/wire/rpc'
import { ModelLists, type Model, type ModelSource } from './model-list'
import { RUNTIMES, type Job, type RuntimeReport, type SettingDecl } from './api'

const HARNESSES = Object.fromEntries(RUNTIMES.map((name) => [name, ALL.find((h) => h.name === name)!])) as Record<Job['runtime'], Harness>

const LOGIN_PROBE_MS = 5_000

/** What one job spawns. */
export interface Plan {
  command: string
  managedProcess?: boolean
  idleRecovery?: boolean
  startNote?: string
  fallback?: () => Plan
  args: string[]
  env: NodeJS.ProcessEnv
  /** Written to stdin when the runtime reads its prompt there. */
  stdin?: string
  /** Reads a runtime that prints; `converse` drives one that answers back. */
  renderer?: StreamRenderer
  /** The one turn, held over the child's pipes. The turn's end is the job's: the child is a
   *  server and is ended after it. */
  background?: () => number | undefined
  converse?: (child: ChildProcess, event: (e: RunEvent) => void, restart?: boolean, prepareUntil?: number, signal?: AbortSignal, activity?: () => void, idleSignal?: AbortSignal) => Promise<TurnEnd>
  /** True for stderr lines the runtime prints on every run and that say nothing. */
  quiet(line: string): boolean
  /** The id a later job resumes this session by, once known. */
  session(): string | undefined
  /** The model the runtime says it worked with, once known. */
  model?(): string | undefined
}

export const LABELS = Object.fromEntries(RUNTIMES.map((name) => [name, HARNESSES[name].label])) as Record<Job['runtime'], string>

/** The settings a runtime takes, and the ones of them that are keys. */
export const settingKeys = (runtime: Job['runtime']) => HARNESSES[runtime].settings.map((s) => s.key)
export const secretKeys = (runtime: Job['runtime']) => HARNESSES[runtime].settings.filter((s) => s.kind === 'secret').map((s) => s.key)

/** The key of the runtime's provider list, and the provider its settings pick. */
export const providerKey = (runtime: Job['runtime']) => HARNESSES[runtime].settings.find((s) => s.kind === 'provider')?.key
export const providerOf = (runtime: Job['runtime'], model?: string | null, given: Settings = {}) =>
  providerFor(HARNESSES[runtime], held(runtime, model, given))?.id

/** True for a runtime driven over ACP, which takes no arguments after its subcommand. */
export const talks = (runtime: Job['runtime']) => !!HARNESSES[runtime].client

/** A runtime's settings beside its model, and the keys this computer holds for it (#2135). */
export interface Settings {
  settings?: Record<string, string> | null
  secrets?: Record<string, string>
}

function held(runtime: Job['runtime'], model: string | null | undefined, given: Settings): SettingValues {
  const keys = new Set(HARNESSES[runtime].settings.map((s) => s.key))
  const values = Object.fromEntries(Object.entries(given.settings ?? {}).filter(([k, v]) => keys.has(k) && k !== MODEL_KEY && typeof v === 'string' && v))
  if (model) values[MODEL_KEY] = model
  return { values, secretsSet: Object.keys(given.secrets ?? {}).filter((k) => given.secrets![k]) }
}

/** The arguments a runtime's model and settings add, the way the board's own run writes them. */
export const settingsArgs = (runtime: Job['runtime'], model?: string | null, given: Settings = {}): string[] =>
  settingArgs(HARNESSES[runtime], held(runtime, model, given))

/** What a person runs to sign the runtime's CLI in. */
export const hints = (runtime: Job['runtime']) => ({ login: HARNESSES[runtime].login?.login })

/** True when the runtime can open a copy of an earlier session (#2146). */
export const forks = (runtime: Job['runtime']) => !!HARNESSES[runtime].forkArgs

/** This connector reads attachments from command-line image arguments. */
export const takesImageArgs = (runtime: Job['runtime']) => HARNESSES[runtime].images?.as === 'args'

export interface DiscussionImages {
  files: readonly string[]
  prompt: string
}

export function plan(runtime: Job['runtime'], prompt: string, cwd: string, resume?: string | null, model?: string | null, given: Settings = {}, fork = false, language: 'zh' | 'en' | null = null, images: readonly string[] = [], discussionImages?: DiscussionImages): Plan {
  const harness = HARNESSES[runtime]
  const { argv, note } = installedCommand(harness)
  const id = randomUUID()
  const session = fork ? resume && harness.forkArgs ? { id, resume, fork: true as const } : { id }
    : resume ? { resume } : { id }
  const launch = planLaunch(harness, argv, {
    cwd, settings: held(runtime, model, given), secrets: given.secrets ?? {}, language, images, note,
    // Keep the Claude Code plugin from serving jobs inside a job's own session.
    env: { WILDCRANE_JOB: '1', [LANGUAGE_ENV]: language ?? '' },
  }, session, !!discussionImages)
  const adapt = (started: ReturnType<typeof planLaunch>): Plan => {
    const { client, renderer, resumeId, fallback } = started
    const input = promptInput(started, prompt)
    const base = {
      ...input,
      env: started.env,
      startNote: started.startNote,
      quiet: started.quietStderr ?? (() => false),
    }
    if (!client) return {
      ...base,
      renderer,
      session: () => renderer?.resumeId?.() ?? resumeId ?? undefined,
      model: () => renderer?.model?.(),
    }
    const native = started.nativeDiscussion ? discussionImages : undefined
    let currentSession: string | undefined
    let named: string | undefined
    return {
      ...base,
      managedProcess: client.managedProcess,
      idleRecovery: client.idleRecovery,
      background: client.background,
      fallback: fallback && (() => adapt(fallback())),
      converse: (child, event, restart = true, prepareUntil, signal, activity, idleSignal) => client.turn({
        signal,
        idleSignal,
        activity,
        stdout: child.stdout!,
        stdin: child.stdin!,
        prompt: native?.prompt ?? prompt,
        imageFiles: native?.files,
        prepareUntil,
        restartPrompt: restart ? prompt : undefined,
        cwd,
        resumeId: resumeId ?? undefined,
        log: () => {},
        gotResumeId: (got, restarted) => {
          if (restarted || !currentSession) currentSession = got
        },
        gotModel: (got) => (named = got),
        event,
      }),
      session: () => currentSession ?? resumeId ?? undefined,
      model: () => named,
    }
  }
  return adapt(launch)
}

/** What a form needs of one setting: never how it reaches a run. */
export function declOf(setting: HarnessSetting): SettingDecl {
  return {
    key: setting.key,
    label: setting.label,
    kind: setting.kind,
    ...(setting.help ? { help: setting.help } : {}),
    ...(setting.placeholder ? { placeholder: setting.placeholder } : {}),
    ...(setting.choices ? { choices: setting.choices.map(({ value, label }) => ({ value, label })) } : {}),
    ...(setting.providers ? { providers: setting.providers.map(({ id, label, blurb, needs }) => ({ id, label, blurb, needs })) } : {}),
    ...(setting.defaultProvider ? { defaultProvider: setting.defaultProvider } : {}),
  }
}

/** Quick detection starts model discovery in the background. */
export async function detectRuntimes(quick = false, only?: Job['runtime']): Promise<RuntimeReport[]> {
  return Promise.all(
    (Object.keys(HARNESSES) as Job['runtime'][]).filter((name) => !only || name === only).map(async (name) => {
      const harness = HARNESSES[name]
      const settings = harness.settings.map(declOf)
      await warm(harness)
      const copy = locate(harness)
      if (!copy) return { name, installed: false, settings }
      const loggedIn = harness.login ? await probeLogin(spawnName(copy, splitCommand(harness.command)[0]!), harness) : undefined
      const models = await modelLists.read(name, name === 'claude-code' ? CLAUDE_DEFAULTS : [], !quick)
      return { name, installed: true, ...(copy.version ? { version: copy.version } : {}), ...(loggedIn === undefined ? {} : { loggedIn }), ...(models.length ? { models } : {}), settings }
    }),
  )
}

/** Refresh every source without waiting for a CLI or discarding a successful list. */
export function refreshModels(found: RuntimeReport[]): Promise<RuntimeReport[]> {
  return Promise.all(found.map(async (report) => {
    if (!report.installed) return report
    const models = await modelLists.read(report.name, report.models ?? (report.name === 'claude-code' ? CLAUDE_DEFAULTS : []))
    return { ...report, ...(models.length ? { models } : {}) }
  }))
}

const CLAUDE_DEFAULTS = ['opus', 'sonnet', 'haiku'].map(id => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }))

const sources: Partial<Record<Job['runtime'], ModelSource>> = Object.fromEntries(
  Object.entries(HARNESSES).filter(([, harness]) => harness.models).map(([name, harness]) => [
    name, () => (harness.models?.() ?? []).map((id) => ({ id, name: id })),
  ]),
)
Object.assign(sources, {
  'claude-code': () => claudeModels(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'cache', 'model-catalog')),
  codex: () => codexModels(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json')),
  opencode: async (signal: AbortSignal) => opencodeModels(await output(installedCommand(HARNESSES.opencode).argv[0], ['models'], signal)),
  cursor: (signal: AbortSignal) => cursorModels(signal),
  antigravity: async (signal: AbortSignal) => antigravityModels(await output(installedCommand(HARNESSES.antigravity).argv[0], ['models'], signal)),
})
export const modelLists = new ModelLists(sources)

/** `opencode models`: one `provider/model` id a line, the same ids its ACP session takes. */
export function opencodeModels(out: string): Model[] {
  return out.split('\n').map((l) => l.trim()).filter((l) => /^\S+\/\S+$/.test(l)).map((id) => ({ id, name: id }))
}

/** Cursor's ACP ids carry their parameters and are not the ones `cursor-agent models` prints, so
 *  they are read off a session opened for the purpose and closed without a prompt. Auto is the
 *  menu's own default and is left out. */
export function cursorModels(signal: AbortSignal, argv = installedCommand(HARNESSES.cursor).argv): Promise<Model[]> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      const start = spawnable(argv[0]!, argv.slice(1), { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'ignore'], env: copyEnv(argv[0], withSystemProxy({ ...process.env, ...HARNESSES.cursor.env() })) })
      child = spawn(start.command, start.args, start.options)
    } catch {
      return resolve([])
    }
    let finished = false
    const done = (models: Model[]) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', aborted)
      child.kill()
      resolve(models)
    }
    const aborted = () => done([])
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) return done([])
    child.on('error', () => done([]))
    child.on('close', () => done([]))
    const rpc = connect(child.stdout!, child.stdin!, (msg) => msg.id !== undefined && rpc.refuse(msg.id, 'no'), { jsonrpc: true })
    rpc
      .call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
      .then(() => rpc.call('session/new', { cwd: os.tmpdir(), mcpServers: [] }))
      .then((opened) => done(acpModels(opened)))
      .catch(() => done([]))
  })
}

/** A session's `availableModels`, less the Auto entry. */
export function acpModels(opened: Record<string, unknown>): Model[] {
  const list = obj(opened.models).availableModels
  return (Array.isArray(list) ? list : []).map(obj).flatMap((m) => {
    const id = str(m.modelId)
    return id && id !== 'default[]' ? [{ id, name: str(m.name) || id }] : []
  })
}

/** What a command prints, or nothing when it fails or takes too long. */
export function output(command: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    let child: ChildProcess
    try {
      const start = spawnable(command, args, { stdio: ['ignore', 'pipe', 'ignore'], env: copyEnv(command) })
      child = spawn(start.command, start.args, start.options)
    } catch {
      return resolve('')
    }
    let finished = false
    const done = (value: string) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', aborted)
      child.kill()
      resolve(value)
    }
    const aborted = () => done('')
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) return done('')
    child.stdout?.on('data', (d) => (out += d))
    child.on('error', () => done(''))
    child.on('close', (code) => done(code === 0 ? out : ''))
  })
}

/** The models Codex lists in its own picker, from the catalogue it caches. */
export function codexModels(file: string): Model[] {
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8')) as { models?: unknown }
    if (!Array.isArray(cache.models)) return []
    return cache.models.flatMap((m: { slug?: unknown; display_name?: unknown; visibility?: unknown }) =>
      m.visibility === 'list' && typeof m.slug === 'string' && m.slug
        ? [{ id: m.slug, name: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug }]
        : [],
    )
  } catch {
    return []
  }
}

/** The main list of Claude Code's own picker, from the newest catalogue it caches; the CLI's
 *  (`cc`) before the desktop app's. A model its family alias points at goes by that alias, the
 *  way a saved `opus` or `fable` names it. Older versions (`overflow`) are left out. */
export function claudeModels(dir: string): Model[] {
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const catalogs = files.flatMap((f) => {
    try {
      const data = obj(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
      const catalog = obj(data.catalog)
      const surface = str(catalog.surface)
      return surface === 'cc' || surface === 'ccd' ? [{ surface, at: Number(data.fetchedAt) || 0, config: obj(catalog.config) }] : []
    } catch {
      return []
    }
  })
  const newest = catalogs.sort((a, b) => (a.surface === b.surface ? b.at - a.at : a.surface === 'cc' ? -1 : 1))[0]
  if (!newest) return []
  const aliases = obj(newest.config.provider_alias_targets)
  const models = Array.isArray(newest.config.models) ? newest.config.models : []
  return models.map(obj).flatMap((m) => {
    const id = str(m.id)
    if (!id || m.section !== 'main') return []
    const family = str(obj(m.runtime).family)
    const alias = family && str(obj(aliases[family]).default) === id ? family : ''
    return [{ id: alias || id, name: str(m.short_name) || str(m.name) || id }]
  })
}

function probeLogin(binary: string, harness: Harness): Promise<boolean | undefined> {
  const probe = harness.login!
  return new Promise((resolve) => {
    let output = ''
    let child
    try {
      const start = spawnable(binary, probe.args, { stdio: ['ignore', 'pipe', 'pipe'], env: copyEnv(binary) })
      child = spawn(start.command, start.args, start.options)
    } catch {
      return resolve(undefined)
    }
    const timer = setTimeout(() => { child.kill(); resolve(undefined) }, probe.timeoutMs ?? LOGIN_PROBE_MS)
    child.stdout?.on('data', (d) => (output += d))
    child.stderr?.on('data', (d) => (output += d))
    child.on('error', () => resolve(undefined))
    child.on('close', () => {
      clearTimeout(timer)
      resolve(probe.ready(output) ? true : probe.loggedOut(output) ? false : undefined)
    })
  })
}
