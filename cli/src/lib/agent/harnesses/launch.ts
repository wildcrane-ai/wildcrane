import type { Language } from '../../machine/types'
import { quoteArg, splitCommand } from '../argv'
import { commandBinary } from '../installed'
import { brokenEntryNote, chooseCopy, copyEnv, isCopy, spawnName, SPAWN_MS } from '../locate'
import { effectiveValues, settingArgs, settingEnv, withSystemLanguage, type SettingValues } from '../run-settings'
import type { ImageConversation, Harness } from './types'

/** Saved command overrides keep their flags and any explicit binary. */
export function commandOf(block: Record<string, string>, harness: Harness): string {
  const command = ownCommand(block, harness)
  return pinnedBy(block, harness) ? command : locatedCommand(command, harness)
}

function ownCommand(block: Record<string, string>, harness: Harness): string {
  const saved = block.command?.trim()
  return saved && !harness.formerCommands?.includes(saved) ? saved : harness.command
}

export const pinnedBy = (block: Record<string, string>, harness: Harness) =>
  commandBinary(ownCommand(block, harness)) !== commandBinary(harness.command)

// The resolved path goes back QUOTED, because the command string is re-split by every reader
// (agent/argv.ts). Only the first word is rewritten: a hand-written argument is never re-spelt.
function locatedCommand(command: string, harness: Harness): string {
  const binary = commandBinary(command)
  const spawns = spawnName(chooseCopy(harness), binary)
  if (spawns === binary) return command
  return `${quoteArg(spawns)}${command.slice(command.indexOf(binary) + binary.length)}`
}

/** Recheck the binary of a saved plan when it starts. */
export function startableBinary(binary: string, harness: Harness, pinned = false): { binary: string; note?: string } {
  const own = commandBinary(harness.command)
  if (pinned || !binary || (binary !== own && !isCopy(harness, binary))) return { binary }
  const copy = chooseCopy(harness, SPAWN_MS)
  if (!copy) return { binary }
  const note = brokenEntryNote(copy, own, harness)
  return { binary: spawnName(copy, own), ...(note ? { note } : {}) }
}

export function installedCommand(harness: Harness): { argv: [string, ...string[]]; note?: string } {
  const [binary, ...flags] = splitCommand(harness.command)
  const start = startableBinary(binary!, harness)
  return { argv: [start.binary, ...flags], note: start.note }
}

type Session =
  | { id: string; resume?: never; fork?: never }
  | { resume: string; id?: never; fork?: never }
  | { resume: string; id: string; fork: true }

export function sessionArgs(harness: Harness, command: string[], settings: SettingValues, cwd: string, session: Session) {
  const argv = [...command, ...settingArgs(harness, settings)]
  const extra = session.fork ? harness.forkArgs!(argv, session.resume, session.id, cwd)
    : session.resume !== undefined ? harness.resumeArgs(argv, session.resume, cwd)
    : harness.extraArgs(argv, session.id, cwd)
  const resumeId = !session.fork && session.resume !== undefined ? session.resume
    : harness.adoptsSessionId ? session.id : null
  return { argv: [...argv, ...extra], resumeId }
}

interface LaunchOptions {
  settings: SettingValues
  secrets: Record<string, string>
  cwd: string
  language: Language | null
  env?: NodeJS.ProcessEnv
  images?: readonly string[]
  note?: string
}

export function openLaunch(harness: Harness, command: string[], options: LaunchOptions, discussion?: ImageConversation) {
  const { cwd, settings, secrets, language, images = [] } = options
  const [binary, ...commandArgs] = command
  const env = { ...settingEnv(harness, settings, secrets, cwd), ...options.env }
  const imageArgs = !discussion && harness.images?.as === 'args' ? images.flatMap(harness.images.args) : []
  const localized = withSystemLanguage(discussion ?? harness, [binary!, ...commandArgs, ...imageArgs], env, language)
  const { argv } = localized
  const values = effectiveValues(harness, settings)
  const connection = discussion ? { argv: [binary!, ...discussion.args, ...argv.slice(1)], client: discussion.client(values) }
    : harness.connection?.(argv)
  const client = connection?.client ?? harness.client?.(values)
  const renderer = client ? undefined : harness.renderer?.(cwd, argv[0], argv)
  const startNote = [options.note, localized.note, !client && harness.connectionFallbackNote].filter(Boolean).join('\n') || undefined
  return {
    argv: connection?.argv ?? argv,
    env: copyEnv(binary!, localized.env),
    client,
    renderer,
    stdinPrompt: client ? undefined : harness.stdinPrompt?.(argv),
    quietStderr: harness.quietStderr,
    startNote,
  }
}

type Launch = ReturnType<typeof openLaunch> & { resumeId: string | null; nativeDiscussion?: boolean }

export function planLaunch(harness: Harness, command: string[], options: LaunchOptions, session: Session, discussion: boolean): Launch & { fallback?: () => Launch } {
  const standard = (): Launch => {
    const { argv, resumeId } = sessionArgs(harness, command, options.settings, options.cwd, session)
    return { ...openLaunch(harness, argv, options), resumeId }
  }
  const protocol = discussion ? harness.discussionImages : undefined
  if (!protocol) return standard()
  if (protocol === 'client') return { ...standard(), nativeDiscussion: true }
  return {
    ...openLaunch(harness, command.slice(0, 1), options, protocol),
    resumeId: session.fork ? null : session.resume ?? null,
    nativeDiscussion: true,
    fallback: protocol.fallbackToPath ? standard : undefined,
  }
}

export function promptInput(launch: ReturnType<typeof openLaunch>, prompt: string) {
  const [command, ...argv] = launch.argv
  return {
    command: command!,
    args: launch.client || launch.stdinPrompt ? argv : [...argv, prompt],
    stdin: launch.stdinPrompt?.(prompt),
  }
}
