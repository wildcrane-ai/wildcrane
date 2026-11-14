
import fs from 'node:fs'
import path from 'node:path'

import { ROLE_NAMES } from '../agent/roles'
import { AGENTS, rel } from '../paths'
import { officialAgent, shippedAgentFiles } from './bundled'
import { cloudStudioSources } from '../agent/cloud-studios'
import { memoByFiles } from '../file-memo'
import { parseSpecAgent } from './parse'
import type { AgentProblem, SpecAgent } from './parse'

/** The board's agents, and every reason one is missing from them. */
export interface SpecAgentCatalog {
  agents: SpecAgent[]
  /** One line per agent that could not be used, saying which and why. */
  problems: string[]
  /** The project agents left out, each with why — for a caller that says it its own way (#1342). */
  refused: RefusedAgent[]
}

export type RefusedCause = 'oldKeys' | 'noFile' | 'nameTaken' | 'folderName' | 'file'

/** One project agent the board does not use. */
export interface RefusedAgent {
  folder: string
  /** What its file calls itself, when it reads that far. */
  name?: string
  /** Its `AGENT.md`, from the project root. */
  file: string
  cause: RefusedCause
  /** `oldKeys`: the keys to take out. */
  keys?: string[]
}

type ReadProblem = AgentProblem & { file?: string; missing?: boolean }

/** Read the catalog — again whenever an agent file changes, so an agent added, edited or
 *  switched off takes effect on the next read. */
export const specAgentCatalog = memoByFiles(() => [AGENTS, ...cloudStudioSources()], readCatalog)

function readCatalog(): SpecAgentCatalog {
  const agents: SpecAgent[] = []
  const problems: string[] = []
  const refused: RefusedAgent[] = []
  const take = (read: { agent: SpecAgent } | ReadProblem, folder: string): void => {
    if ('problem' in read) {
      // A folder with no agent file is somebody's working folder (#1414), not a broken agent:
      // it is said only where a studio names it.
      if (!read.missing) problems.push(read.problem)
      if (!read.file) return
      const { file, name, old } = read
      const cause = read.missing ? 'noFile' : old ? 'oldKeys' : 'file'
      refused.push({ folder, file, cause, ...(name ? { name } : {}), ...(old ? { keys: old.keys } : {}) })
      return
    }
    const { name, from, builtIn } = read.agent
    const refuse = (cause: RefusedCause, problem: string): void => {
      problems.push(problem)
      if (!builtIn) refused.push({ folder, name, file: from, cause })
    }
    if (!builtIn && ROLE_NAMES.includes(name)) {
      return refuse(
        'nameTaken',
        `${from}: \`${name}\` is one of the roles the board ships, whose rule ` +
          'this agent would then share, so this one is not used. Rename it.',
      )
    }
    const clash = agents.find((a) => a.name === name)
    if (clash) {
      return refuse(
        'nameTaken',
        `${from}: an agent named \`${name}\` is already on this board ` +
          `(${clash.from}), so this one is not used. Rename one of them.`,
      )
    }
    if (name !== folder) {
      return refuse(
        'folderName',
        `${from}: its folder is \`${folder}\` but it calls itself \`${name}\`. ` +
          'An agent is asked for by its folder name — make the two match.',
      )
    }
    agents.push(read.agent)
  }

  for (const folder of bundledFolders()) take(readBundled(folder), folder)
  for (const folder of projectFolders(AGENTS)) take(readProject(AGENTS, folder), folder)
  return { agents, problems, refused }
}

/** Where each agent sits in this board's studios (#2152): `<studio>#preview`, `land` or
 *  `scheduled`. Agents in no studio are absent. */
export type AgentPlaces = Map<string, string>

/** Check what only one group reads (#2152): `when`, `after` and `session` belong to a
 *  preview, `reads` to a scheduled agent, and `after` names a preview of the same studio and
 *  never loops back (#2154). One line per key ignored, and each preview's `after` as it is used. */
export function checkAgentKeys(agents: SpecAgent[], places: AgentPlaces): { problems: string[]; after: Map<string, string[]> } {
  const problems: string[] = []
  const preview = (name: string) => places.get(name)?.includes('#') ?? false
  for (const agent of agents) {
    const where = places.get(agent.name)
    if (!where) continue
    const ignored = [
      ...(!preview(agent.name) && agent.when ? ['when'] : []),
      ...(!preview(agent.name) && agent.after.length ? ['after'] : []),
      ...(!preview(agent.name) && agent.session ? ['session'] : []),
      ...(!preview(agent.name) && agent.stages ? ['stages'] : []),
      ...(where !== 'scheduled' && agent.reads ? ['reads'] : []),
    ]
    for (const key of ignored) problems.push(`${agent.from}: \`akb.${key}\` is read only on ${key === 'reads' ? 'a scheduled agent' : 'a preview'} — ignoring it`)
  }
  const byName = new Map(agents.map((a) => [a.name, a]))
  const after = new Map<string, string[]>()
  for (const agent of agents.filter((a) => preview(a.name))) {
    after.set(
      agent.name,
      agent.after.filter((other) => {
        if (places.get(other) === places.get(agent.name)) return true
        const what = byName.has(other) ? 'is not a preview of the same studio' : 'is not an agent on this board'
        problems.push(`${agent.from}: \`akb.after\` names \`${other}\`, which ${what} — ignoring it`)
        return false
      }),
    )
  }
  // Drop the edge that closes each loop, walking in board order.
  const state = new Map<string, 'open' | 'done'>()
  const visit = (name: string): void => {
    state.set(name, 'open')
    after.set(
      name,
      after.get(name)!.filter((other) => {
        const seen = state.get(other)
        if (seen === 'open') {
          problems.push(`${byName.get(name)!.from}: \`akb.after\` names \`${other}\`, which waits on \`${name}\` already, so the two make a loop — ignoring it`)
          return false
        }
        if (!seen) visit(other)
        return true
      }),
    )
    state.set(name, 'done')
  }
  for (const name of after.keys()) if (!state.has(name)) visit(name)
  return { problems, after }
}

// ---- the agents the command ships ------------------------------------------

const bundledFolders = (): string[] =>
  [...new Set(Object.keys(shippedAgentFiles()).map((key) => key.split('/')[0]!))].sort()

function readBundled(folder: string): { agent: SpecAgent } | { problem: string } {
  const shipped = shippedAgentFiles()
  const official = officialAgent(folder)
  const label = official ? `the built-in \`${folder}\` agent` : `the studio agent \`${folder}\``
  const file = (relative: string): string | null => shipped[`${folder}/${relative}`] ?? null
  const text = file('AGENT.md')
  if (text === null) return { problem: `${label} has no AGENT.md` }
  const list = (): string[] =>
    ownFiles(Object.keys(shipped).filter((k) => k.startsWith(`${folder}/`)).map((k) => k.slice(folder.length + 1)))
  return parseSpecAgent(text, label, file, official, list)
}

// ---- the agents the project adds -------------------------------------------

function projectFolders(root: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
}

/** Read through one agent's own folder and no further. A reference is agent-relative by
 *  contract (./parse.ts refuses an absolute or climbing one); this is the second lock on it,
 *  so a path that slipped through still cannot reach the rest of the repo. */
export function agentFileReader(dir: string): (relative: string) => string | null {
  return (relative) => {
    const target = path.resolve(dir, relative)
    if (target !== dir && !target.startsWith(dir + path.sep)) return null
    try {
      const real = fs.realpathSync(target)
      if (!real.startsWith(fs.realpathSync(dir) + path.sep)) return null
      return fs.readFileSync(real, 'utf8')
    } catch {
      return null
    }
  }
}

/** What an agent offers a run to read (#860): everything in its folder but its own
 *  `AGENT.md`. Dot files and dot folders are housekeeping — an editor's leftovers, a cache —
 *  and are never named. */
const ownFiles = (paths: string[]): string[] =>
  paths.filter((p) => p !== 'AGENT.md' && !p.split('/').some((part) => part.startsWith('.'))).sort()

// One agent's folder, all the way down, as agent-relative paths. No layout is imposed: a
// file sits wherever its agent put it.
function walkFolder(dir: string, prefix: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((e) => {
    const here = prefix ? `${prefix}/${e.name}` : e.name
    return e.isDirectory() ? walkFolder(path.join(dir, e.name), here) : [here]
  })
}

function readProject(root: string, folder: string): { agent: SpecAgent } | ReadProblem {
  const dir = path.join(root, folder)
  const file = agentFileReader(dir)
  const text = file('AGENT.md')
  const missing = rel(path.join(dir, 'AGENT.md'))
  if (text === null) return { problem: `${missing} is missing`, file: missing, missing: true }
  const from = missing
  const read = parseSpecAgent(text, from, file, false, () => ownFiles(walkFolder(dir, '')))
  if ('problem' in read) return { ...read, file: from }
  // Where it lives and what it says, whole — a project agent's file is the box the Agents
  // pane writes it through (#422), and only an agent read off disk has one.
  if ('agent' in read) Object.assign(read.agent, { dir, text })
  return read
}
