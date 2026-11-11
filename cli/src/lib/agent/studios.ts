// The studios a board runs, and the one place a card's own is read (#715).
//
// A studio lists its agents in three groups (#2152): `previews`, whose work a person approves,
// each waiting on the approvals its `after` names (#2154); `land`, run in order once the last
// approval is in; and `scheduled`. Cards
// are written by the board's own planning, to the studio's rules (its file's body and the
// user's rule for it); no agent leads a studio.
//
// Every studio is a `STUDIO.md` (./studio-file.ts, #1890) kept in Cloud (#409): the
// official ones, read-only, and the workspace's own, changed with `akb studio pull`/`push` (#544). The run state of each
// scheduled agent stays in `ui.config.json` under `studios`.
//
// The id is what a card carries and what a delivery freezes. It never changes: renaming a
// studio rewrites its name and nothing else, so no card and no finished delivery is
// orphaned by it.

import fs from 'node:fs'
import path from 'node:path'

import { locate, locateArchived } from '../cards'
import { parseFrontmatter } from '../frontmatter'
import { AGENTS, die, LEGACY_AGENTS, LEGACY_UI_CONFIG, RULES, UI_CONFIG, STUDIOS } from '../paths'
import { memoByFiles } from '../file-memo'
import type { Meta } from '../types'
import { AUTO_CADENCE, formatStamp, isAuto, parseCadence } from '../cadence'
import { safeConfig, configBlock, writeConfig } from './settings'
import { checkAgentKeys, specAgentCatalog, type AgentPlaces, type RefusedAgent } from '../agents/catalog'
import { canonicalSpecAgent } from '../spec-agent-names'
import { cloudStudioSources, heldStudioName } from './cloud-studios'
import { translating } from './language'
import { boardStudioDefs, builtinDefs, draftId, stagesOf, writeStudioDef, type StudioDef } from './studio-file'
import { refusal, type FrozenStudio, type RunRefusal, type StudioHelper, type StudioScheduled } from './types'

export type { StudioHelper }

/** One studio, resolved: the board's own changes over its file. */
export interface Studio {
  /** What a card carries and a delivery freezes. Never changes. */
  id: string
  /** What it is called. A built-in's is its English name, which the screen drawing it
   *  translates; a board's own is the user's own words and is drawn as written. */
  name: string
  /** Whether it is an official one, read-only. */
  builtIn: boolean
  /** Whether completion requires recorded output files. */
  needsArtifact: boolean
  /** Its preview agents, in order, disabled ones included. Read through `previewMembers`. */
  previews: StudioHelper[]
  /** What runs, in order, after the last approval. Read through `landAgents`. */
  land: StudioHelper[]
  /** Its scheduled agents (#1401), as written down. Read through `scheduledMembers`. */
  scheduled: StudioScheduled[]
  /** Its file's body: how a card on it is written. The user's own rule is `userStudioRules`. */
  rules: string
}

// ---- the official ones --------------------------------------------------------

/** Whether a studio is an official one. */
export const isBuiltinStudio = (id: string): boolean => builtinDefs().some((w) => w.id === id)

/** What an official one is for. */
export const builtinDescription = (id: string): string | undefined => builtinDefs().find((w) => w.id === id)?.description

/** What a studio is for: its own line, else its name. */
export function studioPurpose(flow: Studio): string {
  if (flow.builtIn) return builtinDescription(flow.id) || flow.name
  return boardStudioDefs().defs.find((d) => d.id === flow.id)?.description || flow.name
}

/** Which requests a studio is for; empty when its file has none. */
export function studioWhen(flow: Studio): string {
  const defs = flow.builtIn ? builtinDefs() : boardStudioDefs().defs
  return defs.find((d) => d.id === flow.id)?.when ?? ''
}

// ---- reading ---------------------------------------------------------------

// `ui.config.json`:
//
//   "studios": { "stages": { "coding": { "schedule": { "helpers": [...] } } } }
//
// Every studio's scheduled agents with their run state.

const studiosBlock = (cfg: Record<string, unknown>): Record<string, unknown> => configBlock(cfg.studios)

const storedStages = (cfg: Record<string, unknown>, id: string): Record<string, unknown> =>
  configBlock(configBlock(studiosBlock(cfg).stages)[id])

const SCHEDULE = 'schedule'

function readRows(raw: unknown): StudioHelper[] | undefined {
  const rows = configBlock(raw).helpers
  if (!Array.isArray(rows)) return undefined
  const out: StudioHelper[] = []
  for (const entry of rows) {
    const row = configBlock(entry)
    const agent = typeof row.agent === 'string' ? canonicalSpecAgent(row.agent) : ''
    if (!agent || out.some((h) => h.agent === agent)) continue
    out.push({ agent, extra: typeof row.extra === 'string' ? row.extra : '', ...(row.off === true ? { off: true } : {}) })
  }
  return out
}

function readScheduled(raw: unknown): StudioScheduled[] | undefined {
  const rows = configBlock(raw).helpers
  if (!Array.isArray(rows)) return undefined
  const out: StudioScheduled[] = []
  for (const entry of rows) {
    const row = configBlock(entry)
    const agent = typeof row.agent === 'string' ? canonicalSpecAgent(row.agent) : ''
    if (!agent || out.some((h) => h.agent === agent)) continue
    const text = (key: string): string => (typeof row[key] === 'string' ? (row[key] as string).trim() : '')
    out.push({
      agent,
      extra: typeof row.extra === 'string' ? row.extra : '',
      ...(row.off === true ? { off: true } : {}),
      cadence: parseCadence(text('cadence')) ? text('cadence') : AUTO_CADENCE,
      lastRun: text('lastRun'),
      ...(text('since') ? { since: text('since') } : {}),
    })
  }
  return out
}

const toRow = (h: StudioHelper) => ({ agent: h.agent, extra: h.extra, ...(h.off ? { off: true } : {}) })

const scheduledRow = (h: StudioScheduled) => ({
  ...toRow(h),
  ...(!isAuto(h.cadence) ? { cadence: h.cadence } : {}),
  ...(h.lastRun ? { lastRun: h.lastRun } : {}),
  ...(h.since ? { since: h.since } : {}),
})

// A studio is its file, with the run state of its scheduled agents.
function resolveOne(cfg: Record<string, unknown>, def: StudioDef, builtIn: boolean): Studio {
  const stored = storedStages(cfg, def.id)
  return {
    id: def.id,
    name: def.name,
    builtIn,
    needsArtifact: def.needsArtifact,
    previews: def.previews.map((h) => ({ ...h })),
    land: def.land.map((h) => ({ ...h })),
    scheduled:
      readScheduled(stored[SCHEDULE]) ??
      def.scheduled.map((one) => ({ agent: one.agent, extra: '', cadence: one.cadence ?? AUTO_CADENCE, lastRun: '' })),
    rules: def.rules,
  }
}

// The studios as written down, with the file each came from.
function writtenStudios(): Studio[] {
  const cfg = safeConfig()
  return [...builtinDefs().map((def) => resolveOne(cfg, def, true)), ...boardStudioDefs().defs.map((def) => resolveOne(cfg, def, false))]
}

/** Why a board's own studio file is not used, one line each. */
export const studioFileProblems = (): string[] => boardStudioDefs().problems

const allListed = (flow: Studio): StudioHelper[] => [...flow.previews, ...flow.land, ...flow.scheduled]

interface Resolved {
  flows: Studio[]
  owners: Map<string, string>
  /** Each preview's `after`, as it is used, and the lines saying what was ignored. */
  keys: { problems: string[]; after: Map<string, string[]> }
}

// Every studio, and which one each listed agent belongs to. An agent no studio lists sits
// in the first studio, off and nobody's, both among its previews and its scheduled agents:
// switching it on as a preview makes it that studio's.
const resolved = memoByFiles(
  () => [UI_CONFIG, LEGACY_UI_CONFIG, STUDIOS, AGENTS, LEGACY_AGENTS, ...cloudStudioSources()],
  (): Resolved => {
    const flows = writtenStudios()
    const catalog = specAgentCatalog().agents
    const known = new Set(catalog.map((a) => a.name))
    const owners = new Map<string, string>()
    for (const flow of flows) {
      for (const { agent } of allListed(flow)) if (known.has(agent) && !owners.has(agent)) owners.set(agent, flow.id)
    }
    const first = flows[0]
    if (first) {
      const idle = catalog.filter((a) => !owners.has(a.name))
      if (idle.length) {
        const previews = idle.map((a) => ({ agent: a.name, extra: '', off: true }))
        first.previews = [...first.previews, ...previews]
        first.scheduled = [...first.scheduled, ...idle.map((a) => ({ agent: a.name, extra: '', off: true, cadence: AUTO_CADENCE, lastRun: '' }))]
      }
    }
    const places: AgentPlaces = new Map()
    for (const flow of flows) {
      const mark = (agent: string, where: string) => {
        if (!places.has(agent) && owners.get(agent) === flow.id) places.set(agent, where)
      }
      flow.previews.forEach((h) => mark(h.agent, `${flow.id}#preview`))
      flow.land.forEach((h) => mark(h.agent, 'land'))
      flow.scheduled.forEach((h) => mark(h.agent, 'scheduled'))
    }
    return { flows, owners, keys: checkAgentKeys(catalog, places) }
  },
)

/** The previews whose approval one agent waits on (#2151, #2154), with every name its studio
 *  cannot use dropped. */
export const agentAfter = (name: string): string[] => resolved().keys.after.get(name) ?? []

/** One line for each `akb.*` key an agent declares and its place in a studio does not read. */
export const agentKeyProblems = (): string[] => resolved().keys.problems

/** The studio an agent belongs to, or empty when none lists it. */
export const agentStudio = (name: string): string => resolved().owners.get(name) ?? ''

/** Every studio this board has, built-ins first and then its own in the order they were
 *  made. */
export const studios = (): Studio[] => resolved().flows

/** One studio by id, or undefined when this board has no such studio. */
export const studioById = (id: string): Studio | undefined => studios().find((w) => w.id === id)

/** The studio id a command line named, refused when this board has no such studio. */
export function knownStudio(asked: string): string {
  const flow = studioById(asked.trim())
  if (!flow) {
    die(`no studio called "${asked.trim()}" on this board. It has: ${studios().map((w) => w.id).join(', ')}.`, {
      kind: 'no-such-studio',
      studio: asked.trim(),
    })
  }
  return flow!.id
}

/** The studio a card runs on, from the id it carries; undefined when it carries none or this
 *  board has no such studio. */
export function studioFor(id: string | undefined): Studio | undefined {
  const wanted = (id ?? '').trim()
  return wanted ? studioById(wanted) : undefined
}

/** Why a card has no studio to run on. */
export function noStudioMessage(id: string | undefined): string {
  const wanted = (id ?? '').trim()
  const zh = translating()
  if (!wanted || !studios().length) return zh ? '先安装一个工作台' : 'Install a studio first.'
  const name = heldStudioName(wanted) || wanted
  return zh ? `此任务的工作台「${name}」未安装` : `This task's studio "${name}" is not installed.`
}

/** `studioFor`, refused with `noStudioMessage` when there is none. */
export function requireStudio(id: string | undefined): Studio {
  const flow = studioFor(id)
  if (!flow) die(noStudioMessage(id), { kind: 'no-studio', studio: (id ?? '').trim() })
  return flow!
}

// ---- the groups, as the board runs them -------------------------------------

const onBoard = (): Set<string> => new Set(specAgentCatalog().agents.map((a) => a.name))

/** Its preview agents, disabled ones included, minus any this board no longer has. */
export const previewMembers = (flow: Studio): StudioHelper[] => {
  const known = onBoard()
  return flow.previews.filter((h) => known.has(h.agent))
}

/** Every preview agent this studio runs. */
export const previewAgents = (flow: Studio): StudioHelper[] => previewMembers(flow).filter((h) => !h.off)

/** The approvals a card goes through (#2154), each the previews made for it: an agent is one
 *  past the latest of those its `after` names that the card also chose, or first when none.
 *  `chosen` are the card's previews; one its studio does not run is dropped. Never empty. */
export function previewStages(flow: Studio | undefined, chosen: readonly string[]): string[][] {
  const names = flow ? previewAgents(flow).map((h) => h.agent).filter((name) => chosen.includes(name)) : []
  const stages = stagesOf(names, agentAfter)
  return stages.length ? stages : [[]]
}

/** What lands the work, in order — its enabled agents. Roles stay; a missing agent is a
 *  problem `studioIssues` reports, never one dropped in silence. */
export const landAgents = (flow: Studio): StudioHelper[] => flow.land.filter((h) => !h.off)

/** Whether the last approval archives the card: nothing lands it (#2152). */
export const archivesOnApproval = (flow: Studio | undefined): boolean => !!flow && !landAgents(flow).length

/** The rules a card on this studio is written by: its file's body, then the user's own. */
export function userStudioRules(flow: Studio): string {
  try {
    return fs.readFileSync(studioRuleFile(flow.id), 'utf8').trim()
  } catch {
    return ''
  }
}

/** Where the user's own rule for one studio's cards lives. */
export const studioRuleFile = (id: string): string => path.join(RULES, 'studios', `${id}.md`)

/** Every reason one studio cannot start a card: a land agent this board cannot run. A
 *  preview that no longer resolves is NOT a reason: it is dropped instead. */
export function studioProblems(id: string): string[] {
  return studioIssues(id).map((issue) => issue.error)
}

/** The same, each with its kind. */
export function studioIssues(id: string): RunRefusal[] {
  const flow = studioById(id)
  if (!flow) return [refusal('studioNotFound', `this board has no \`${id}\` studio.`, { id })]
  const known = onBoard()
  const problems: RunRefusal[] = []
  for (const { agent } of landAgents(flow)) {
    if (known.has(agent)) continue
    const refused = specAgentCatalog().refused
    const mine = refused.find((r) => r.folder === agent) ?? refused.find((r) => r.name === agent)
    if (mine) {
      problems.push(landRefused(flow, agent, mine))
      continue
    }
    problems.push(
      refusal('studioLandMissing', `\`${flow.name}\` lands with \`${agent}\`, and this board has no such agent.`, {
        name: flow.name,
        agent,
        studio: flow.id,
      }),
    )
  }
  return problems
}

// A land agent whose file is there but refused (#1342): the one line that brings it back.
function landRefused(flow: Studio, agent: string, found: RefusedAgent): RunRefusal {
  const keys = found.keys ?? []
  const declared = found.name ?? ''
  const fix: Record<RefusedAgent['cause'], string> = {
    oldKeys: `in ${found.file}, remove ${keys.map((key) => `\`${key}\``).join(', ')}`,
    noFile: `${found.file} is missing — add it`,
    nameTaken: `${found.file} takes a name already in use — rename one of the two`,
    folderName: `its folder is \`${found.folder}\` but ${found.file} names it \`${declared}\` — make the two match`,
    file: `${found.file} has an error — \`akb raw previews\` says which`,
  }
  return refusal('studioLandRefused', `\`${agent}\`, which lands \`${flow.name}\`, can't be used: ${fix[found.cause]}.`, {
    name: flow.name,
    agent,
    studio: flow.id,
    cause: found.cause,
    file: found.file,
    folder: found.folder,
    declared,
    keys: keys.join(','),
  })
}

// ---- writing: a Studio builder draft ----------------------------------------
//
// Outside `pull`/`push` (#544), inside a Studio builder task's run, the draft it
// writes on the board takes a name, a copy of another studio, or a new name; approving the
// task saves it.

type Write = { ok: boolean } & Partial<RunRefusal>

const save = (change: (block: Record<string, unknown>) => void): Write =>
  writeConfig((cfg) => {
    const block = configBlock(cfg.studios)
    change(block)
    if (Object.keys(block).length === 0) delete cfg.studios
    else cfg.studios = block
  })

function writeDraft(def: StudioDef, settings?: (block: Record<string, unknown>) => void): Write {
  try {
    writeStudioDef(def)
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return { ok: false, ...refusal('fileWrite', `couldn't write the "${def.name}" studio: ${why}`, { path: def.id, details: why }) }
  }
  return settings ? save(settings) : { ok: true }
}

const draftDef = (id: string): StudioDef | undefined => boardStudioDefs().defs.find((d) => d.id === id)

const notFound = (id: string): Write => ({ ok: false, ...refusal('studioNotFound', `this board has no \`${id}\` studio`, { id }) })

const readOnly = (): Write => ({ ok: false, ...refusal('studioReadOnly', 'Only a Studio builder draft is renamed here; change a studio with `akb studio pull` and `push`.') })

const trimmedName = (name: string): string => name.replace(/\s+/g, ' ').trim()

// A number written onto the end of a name. No space after a Han, Kana or Hangul character:
// "软件开发2" is how that name is written and "Coding 2" is how this one is.
const nameTaken = (name: string, except = ''): boolean =>
  studios().some((w) => w.id !== except && trimmedName(w.name).toLowerCase() === trimmedName(name).toLowerCase())

/** Rename the draft. */
export function renameStudio(id: string, name: string): Write {
  const draft = draftId()
  if (!draft) return readOnly()
  if (id !== draft) return { ok: false, ...refusal('studioReadOnly', `only the draft, \`${draft}\`, is renamed here`, { id }) }
  const wanted = trimmedName(name)
  if (!wanted) return { ok: false, ...refusal('studioUnnamed', 'a studio needs a name') }
  if (nameTaken(wanted, id)) return { ok: false, ...refusal('studioTaken', `this workspace already has a studio called "${wanted}"`, { name: wanted }) }
  const def = draftDef(id)
  return def ? writeDraft({ ...def, name: wanted }) : notFound(id)
}

// Refused when the agent belongs to another studio (#1095).
function elsewhere(agent: string, id: string): Write | null {
  const owner = agentStudio(agent)
  if (!owner || owner === id) return null
  const name = studioById(owner)?.name ?? owner
  return {
    ok: false,
    ...refusal('agentOtherStudio', `\`${agent}\` belongs to the "${name}" studio — create a new agent here instead`, {
      agent,
      name,
      studio: owner,
    }),
  }
}

/** Drop a deleted agent from the draft and the saved run state, so a later agent of the same
 *  name starts in no studio. */
export function forgetStudioAgent(agent: string): Write {
  const id = draftId()
  const def = id ? draftDef(id) : undefined
  if (def) {
    const keep = (rows: StudioHelper[]) => rows.filter((h) => h.agent !== agent)
    try {
      writeStudioDef({ ...def, previews: keep(def.previews), land: keep(def.land), scheduled: def.scheduled.filter((s) => s.agent !== agent) })
    } catch {
      // Left listing it: an agent no board has drops out of every studio it is read into.
    }
  }
  return save((block) => {
    const all = configBlock(block.stages)
    for (const [id, flow] of Object.entries(all)) {
      const mine = configBlock(flow)
      for (const [key, value] of Object.entries(mine)) {
        const one = configBlock(value)
        if (Array.isArray(one.helpers)) one.helpers = one.helpers.filter((h) => configBlock(h).agent !== agent)
        mine[key] = one
      }
      all[id] = mine
    }
    if (Object.keys(all).length) block.stages = all
  })
}

// ---- scheduled agents (#1401) -------------------------------------------------
//
// A studio's scheduled agents run by themselves on a cadence, on no card. A Runner judges
// them by what Cloud keeps; the project's Agents page is where they are switched and timed.
// The rows here hold each one's extra requirements and when it last passed.

/** Every scheduled agent one studio has, disabled ones included, minus any this board no
 *  longer has. */
export function scheduledMembers(flow: Studio): StudioScheduled[] {
  const known = onBoard()
  return flow.scheduled.filter((h) => known.has(h.agent))
}

/** The agents a studio's `STUDIO.md` lists as scheduled, minus any this board no longer
 *  has. What the board saved about them plays no part. */
export function listedScheduled(flow: Studio): string[] {
  const def = (flow.builtIn ? builtinDefs() : boardStudioDefs().defs).find((d) => d.id === flow.id)
  const known = onBoard()
  return (def?.scheduled ?? []).map((s) => s.agent).filter((agent) => known.has(agent))
}

/** One scheduled agent of one studio, or undefined when it has no such agent. */
export const scheduledAgent = (id: string, agent: string): StudioScheduled | undefined => {
  const flow = studioById(id)
  return flow ? scheduledMembers(flow).find((h) => h.agent === canonicalSpecAgent(agent.trim())) : undefined
}

// The rows written are the ones this studio owns, and `claim`, an agent only sitting here.
function setScheduled(id: string, change: (rows: StudioScheduled[]) => Write | void, claim = ''): Write {
  const flow = studioById(id)
  if (!flow) return notFound(id)
  const rows = scheduledMembers(flow)
    .filter((h) => agentStudio(h.agent) === id || h.agent === claim)
    .map((h) => ({ ...h }))
  const refused = change(rows)
  if (refused) return refused
  return save((block) => {
    const stages = configBlock(block.stages)
    stages[id] = { ...configBlock(stages[id]), [SCHEDULE]: { helpers: rows.map(scheduledRow) } }
    block.stages = stages
  })
}

/** Record a pass that PASSED, by when it began. A failed or stopped one records nothing, so
 *  the agent is tried again a cadence later. */
export function stampScheduledRun(id: string, agent: string, startedAt: Date): boolean {
  return setScheduled(
    id,
    (rows) => {
      const one = rows.find((h) => h.agent === agent)
      if (!one) return { ok: false, error: '' }
      one.lastRun = formatStamp(startedAt)
    },
    agentStudio(agent) ? '' : agent,
  ).ok
}

/** Take in the agent a retired recurring card became (#1414), with the cadence and last pass
 *  the card carried. On only with a cadence; no `since`, so the cadence counts from that pass. */
export function adoptStudioScheduled(id: string, agent: string, from: { cadence: string; lastRun: string }): Write {
  const refused = elsewhere(agent, id)
  if (refused) return refused
  return setScheduled(id, (rows) => {
    const at = rows.findIndex((h) => h.agent === agent)
    if (at >= 0) rows.splice(at, 1)
    rows.push({
      agent,
      extra: '',
      ...(from.cadence ? {} : { off: true }),
      cadence: from.cadence || AUTO_CADENCE,
      lastRun: from.lastRun,
    })
  })
}

// ---- the studio one card runs on -----------------------------------------

/** The id a card carries, straight off its file. Empty when the card is not there or carries
 *  no `studio:` key. */
export const cardStudioId = (id: number): string => cardMeta(id)?.studio ?? ''

/** A card's frontmatter, straight off its file, or null when it is not there. */
export function cardMeta(id: number): Meta | null {
  // Best-effort: read on the way into a prompt, and a folder that is not there means the card
  // names no studio, never a run that cannot start.
  try {
    const found = locate(id) ?? locateArchived(id)
    if (!found) return null
    const file = found.kind === 'group' ? path.join(found.target, 'root.md') : found.target
    return parseFrontmatter(fs.readFileSync(file, 'utf8')).meta
  } catch {
    return null
  }
}

/** The studio a card runs on, resolved; undefined when it has none this board knows. */
export const cardStudio = (id: number | null | undefined): Studio | undefined =>
  studioFor(typeof id === 'number' ? cardStudioId(id) : '')

/** A card's approvals (#2154): the previews it chose, staged by their `after`. */
export const cardStages = (meta: Pick<Meta, 'previews'> | null | undefined, flow: Studio | undefined): string[][] =>
  previewStages(flow, meta?.previews ?? [])

/** The approval a card is on, 1-based: its `phase`, kept inside its stages. */
export const cardStage = (meta: Pick<Meta, 'phase' | 'previews'> | null | undefined, flow: Studio | undefined): number =>
  Math.min(Math.max(meta?.phase || 1, 1), cardStages(meta, flow).length)

// ---- what a delivery freezes -----------------------------------------------

/** One studio as a delivery keeps it: its id, its name right now, and its enabled previews
 *  and land agents with the extra requirements their assignments carry. Read once, when the
 *  delivery opens, so every run in it works to the same answer however the board's settings
 *  move underneath. Undefined for an id this board has no studio for. */
export function frozenStudio(id: string): FrozenStudio | undefined {
  const flow = studioFor(id)
  if (!flow) return undefined
  const row = (h: StudioHelper) => ({ agent: h.agent, extra: h.extra })
  return {
    id: flow.id,
    name: flow.name,
    needsArtifact: flow.needsArtifact,
    previews: previewAgents(flow).map(row),
    land: landAgents(flow).map(row),
  }
}
