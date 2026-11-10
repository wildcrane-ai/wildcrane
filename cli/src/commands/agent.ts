// The board's runtimes, which one each agent runs, and everything they are set to.
//
// A run never reads the terminal's environment for any of this — it reads these settings, so a
// run started in a shell with an old export in it goes exactly where the board says. The same
// commands change them, so nothing has to open a browser to set a runtime up, and a front end
// can offer the runtimes and their settings without keeping a list of its own.
//
// Two files, and the split is the whole idea (#467):
//
//   <board-state>/ui.config.json  every runtime's shape, and which one each agent runs —
//                                 this person's, never committed (#1271).
//   docs/kanban/.env              one key line per runtime, named after that runtime's id.
//                                 git never carries it.
//
// `akb raw agent set` writes one row's settings and its key; `akb raw agent use` moves **Global
// default** to another harness.

import { providerSetting } from '../lib/agent/providers'
import {
  activeSettings,
  agentHarness,
  agentInfo,
  agentRun,
  settingSaveError,
  type HarnessAsk,
} from '../lib/agent/resolve'
import { agentNames, agentRoster } from '../lib/agent/roles'
import { readRuntimes, replaceAgentRuntimes, secretVar, setHarness, setRuntimeSecret, setRuntimeSetting, type Runtime } from '../lib/agent/runtimes'
import { setSecret } from '../lib/agent/settings'
import { HARNESSES, RAW_ARGS_KEY, harnessByName } from '../lib/agent/harnesses'
import type { HarnessSetting } from '../lib/agent/types'
import { say } from '../lib/io'
import { die } from '../lib/paths'
import type { MoveResult } from '../lib/types'

/** `akb raw agent` and its words. Split here rather than in the dispatcher so the whole of the
 *  agent setting is one file. */
export function cmdAgent(args: string[]): MoveResult {
  const [word, ...rest] = args
  switch (word) {
    case undefined:
    case 'show':
      return showAgent()
    case 'use':
      return useAgent(rest)
    case 'set':
      return setSetting(rest)
    case 'picks':
      return setPicks(rest)
    default:
      die(`unknown agent command "${word}" — try \`akb raw agent\`, or one of use, set, picks`, {
        kind: 'unknown-move',
        move: word,
      })
  }
}

// What runs, and how it is set up — the whole of the answer in one screen: every runtime the
// board holds, then every agent and the row it runs.
function showAgent(): MoveResult {
  const info = agentInfo()
  say('Runtimes')
  for (const row of info.runtimes) {
    const gone = row.unknownHarness ? `   (${row.unknownHarness} — this version doesn't run it)` : ''
    say(`  ${row.name.padEnd(20)} ${row.label}${row.model ? ` · ${row.model}` : ''}${gone}`)
    say(`    id ${row.id}${row.runs === row.command ? '' : `   command ${row.runs}`}`)
    for (const setting of row.settings) {
      const value = valueOf(setting, row.values, row.secretsSet)
      if (value === UNSET) continue
      say(`    ${setting.key.padEnd(10)} ${value}${
        row.ignored.includes(setting.key) ? '   (not in effect — the command already names it)' : ''
      }`)
    }
  }
  say('')
  say(`The first row is ${'Global default'} — what an agent naming no runtime runs, and the one row`)
  say('that can be neither renamed nor deleted.')
  say(`\`${RAW_ARGS_KEY}\` goes after the settings' flags and before the CLI's own, and a "command"`)
  say('override never turns it off.')
  const agents = sayAgents()
  if (info.staleCommand) {
    say('')
    say(`Your ui.config.json still holds a top-level "command". Nothing reads it — each runtime`)
    say(`carries its own command now.`)
  }
  return { agent: info, agents }
}

// Every agent on this board and the runtime it runs. A row in brackets is **Global default**
// rather than that agent's own pick.
function sayAgents(): { name: string; runtime: string; own: boolean; follows?: string; harness: string; model: string }[] {
  const rows = agentRoster().map((entry) => {
    const runs = agentRun(entry.name)
    return {
      name: entry.name,
      runtime: runs.runtimeName,
      own: runs.own,
      ...(runs.follows ? { follows: runs.follows } : {}),
      harness: runs.harness,
      model: runs.model,
    }
  })
  say('')
  say('Agents')
  for (const row of rows) {
    const what = row.own ? row.runtime : `(${row.runtime})`
    const follows = row.follows ? ` — follows ${row.follows}` : ''
    say(`  ${row.name.padEnd(22)} ${what.padEnd(20)} ${row.harness}${row.model ? ` · ${row.model}` : ''}${follows}`)
  }
  say('')
  say("A runtime in brackets is Global default — that agent picked none.")
  return rows
}

// What a screen says about a setting nobody has touched — left off a runtime's own lines, so
// a row reads as what it is rather than as a list of blanks.
const UNSET = "(the CLI's own default)"

// How one setting reads on the screen. A key is never read back — set or not set is the
// whole of what is said about one.
function valueOf(
  setting: HarnessSetting,
  values: Record<string, string>,
  secretsSet: string[],
): string {
  if (setting.kind === 'secret') return secretsSet.includes(setting.key) ? 'set' : 'not set'
  const value = values[setting.key]
  if (!value) return UNSET
  if (setting.kind !== 'provider') return value
  const provider = setting.providers?.find((p) => p.id === value)
  return provider ? `${provider.id} — ${provider.label}` : value
}

// The harness **Global default** runs. Every other runtime is untouched — this is the one row
// it moves, and a setting the new harness doesn't declare goes with the old one.
function useAgent(args: string[]): MoveResult {
  const name = args[0]?.trim()
  if (!name) die('name a harness: akb raw agent use claude-code', { kind: 'needs-input' })
  const harness = knownHarness(name)
  const res = setHarness(harness.name)
  if (!res.ok) die(res.error ?? 'the setting could not be saved', { kind: 'save-failed' })
  say(`Global default runs ${harness.label} — every agent that named no runtime runs it.`)
  return showAgent()
}

// A Runner's agent picks (#625), as one JSON argument: `{ <agent>: { id, harness, settings,
// secrets?, away? } }`. Replaces every runtime but Global default, and saves each one's keys.
function setPicks(args: string[]): MoveResult {
  let given: Record<string, Runtime & { secrets?: Record<string, string> }>
  try {
    given = JSON.parse(args[0] ?? '')
  } catch {
    die('give the picks as one JSON argument', { kind: 'needs-input' })
  }
  const picks: Record<string, Runtime> = {}
  for (const [agent, { secrets, ...row }] of Object.entries(given)) {
    if (!row.id || !harnessByName(row.harness)) die(`"${agent}" names no runtime this version runs`, { kind: 'bad-value' })
    picks[agent] = { ...row, name: row.name || row.id, settings: row.settings ?? {} }
    for (const setting of harnessByName(row.harness)!.settings) {
      if (setting.kind !== 'secret' || !setting.env) continue
      const res = setSecret(secretVar(setting.env, row.id), secrets?.[setting.key] ?? '')
      if (!res.ok) die(res.error ?? 'the key could not be saved', { kind: 'save-failed' })
    }
  }
  const res = replaceAgentRuntimes(picks)
  if (!res.ok) die(res.error ?? 'the picks could not be saved', { kind: 'save-failed' })
  return { picks: Object.fromEntries(Object.entries(picks).map(([agent, r]) => [agent, r.id])) }
}

// The runtime a `--runtime <id>` flag names, checked against this board's list. With none it is
// the one the named agent runs, and with neither it is **Global default**.
function namedRuntime(args: string[]): { runtime?: string; rest: string[] } {
  const at = args.indexOf('--runtime')
  if (at < 0) return { rest: args }
  const id = args[at + 1]?.trim() ?? ''
  const known = readRuntimes()
  if (!id) die(`name a runtime: ${known.map((r) => r.id).join(', ')}`, { kind: 'needs-input' })
  if (!known.some((r) => r.id === id)) {
    die(`"${id}" is not a runtime on this board. It has: ${known.map((r) => r.id).join(', ')}.`, {
      kind: 'unknown-runtime',
      runtime: id,
    })
  }
  return { runtime: id, rest: [...args.slice(0, at), ...args.slice(at + 2)] }
}

function knownHarness(name: string) {
  const harness = HARNESSES.find((h) => h.name === name)
  if (!harness) {
    die(`no agent called "${name}". This version runs: ${HARNESSES.map((h) => h.name).join(', ')}.`, {
      kind: 'unknown-agent',
      agent: name,
    })
  }
  return harness
}

// The agent a `--agent <name>` flag names, checked against this board's roster.
function namedAgent(args: string[]): { agent?: string; rest: string[] } {
  const at = args.indexOf('--agent')
  if (at < 0) return { rest: args }
  const name = args[at + 1]?.trim() ?? ''
  if (!name) die(`name an agent: ${agentNames().join(', ')}`, { kind: 'needs-input' })
  if (!agentNames().includes(name)) {
    die(`"${name}" is not an agent on this board. It has: ${agentNames().join(', ')}.`, {
      kind: 'unknown-agent',
      agent: name,
    })
  }
  return { agent: name, rest: [...args.slice(0, at), ...args.slice(at + 2)] }
}

// One of a runtime's settings, or its key. Which of the two it is comes from the harness's own
// declaration: a key goes to docs/kanban/.env under that runtime's own line and is never echoed
// back, and everything else lands on the row in ui.config.json.
//
// Which row is written: `--runtime <id>`, or the row `--agent <name>` runs, or **Global
// default**. With no value the setting is cleared and the CLI's own default runs. Reading a key
// back is never offered: a user who forgot theirs makes a new one.
function setSetting(args: string[]): MoveResult {
  const { runtime: named, rest: left } = namedRuntime(args)
  const { agent, rest } = namedAgent(left)
  const ask = named ? { pin: named } : agent ? { agent } : undefined
  const runtime = named ?? agentHarness(agent).runtime
  const settings = activeSettings(ask)
  const key = rest[0]?.trim() ?? ''
  const setting = settings.find((s) => s.key === key)
  if (!setting) {
    const keys = settings.map((s) => s.key)
    die(`that runtime's harness has no "${key}" setting. It takes: ${keys.join(', ') || '(none)'}`, {
      kind: 'unknown-setting',
      setting: key,
    })
  }
  const value = rest.slice(1).join(' ').trim()

  if (setting.kind === 'secret') {
    // One key line per runtime, named after its id — two rows on one harness sign with two
    // keys, and a rename moves neither.
    const res = setRuntimeSecret(runtime, key, value)
    if (!res.ok) die(res.error ?? 'the key could not be saved', { kind: 'save-failed' })
    say(value ? `${setting.label} saved to docs/kanban/.env, for \`${runtime}\`.` : `${setting.label} cleared for \`${runtime}\`.`)
    return { runtime, setting: key, set: Boolean(value) }
  }

  const wrong = checkSetting(setting, value, ask)
  if (wrong) die(wrong, { kind: 'bad-value' })

  const res = setRuntimeSetting(runtime, key, value)
  if (!res.ok) die(res.error ?? 'the setting could not be saved', { kind: 'save-failed' })
  say(
    value
      ? `\`${runtime}\` runs with ${setting.label} "${value}".`
      : `${setting.label} cleared on \`${runtime}\` — the CLI's own default runs.`,
  )
  return { runtime, setting: key, value }
}

// Why this value can't be saved for this setting, or null when it can. `ask` names whose
// runtime the rules are read against: **Global default** with none.
function checkSetting(setting: HarnessSetting, value: string, ask?: HarnessAsk): string | null {
  // A list must be given one of its own choices; a box takes free text, because model ids
  // change between agent releases and the agent is the only validator worth having.
  if (setting.kind === 'select' && value && !setting.choices?.some((c) => c.value === value)) {
    const choices = setting.choices?.map((c) => c.value || '(empty)').join(', ')
    return `"${value}" isn't one of the ${setting.label} choices: ${choices}`
  }
  if (setting.kind === 'provider' && !value) {
    const list = providerSetting(activeSettings(ask))
    return `a run always goes through a provider, so this one can't be cleared. Pick one: ${
      list?.providers?.map((p) => p.id).join(', ') ?? ''
    }`
  }
  // The provider pick, and the boxes it can't do without: a pick that names no provider we
  // ship, one whose base URL is still empty, and a base URL emptied while that pick is
  // live are all refused — so the file never says a run goes somewhere it can't go.
  return settingSaveError(setting.key, value, ask)
}
