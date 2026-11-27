import { deliveryPhase, taskReviewContext } from './env'
import { runnerProject, workspaceTask } from '../cloud/tasks'
import { reviewPreviewIds } from '../shared/review-plan'
import { deliveryStep } from './progress'
// The one place a board action turns into words for an agent.
//
// Every prompt lives here, so a run started in a terminal and the same run started from a
// button say exactly the same thing.

import { studioComponents, componentDocsText } from '../components'
import fs from 'node:fs'
import path from 'node:path'
import { locate, locateArchived } from '../cards'
import { memoryDirectories } from '../memory'
import { globalMemoryBlock } from '../memories'
import { ARCHIVE, boardText, KANBAN, rel, MEMORY, REPO_ROOT } from '../paths'
import { roleSettingsBlock } from '../agents'
import { boardCommand, commandNote } from './command'
import { activeDelivery, deliveryFor, endedDelivery, findDelivery, withStudio } from './deliveries'
import { field } from './facts'
import { recordedOutputs } from './outputs'
import { readArchive } from '../view/archive'
import { agentImages } from './resolve'
import { agentForRun, studioForRun } from './runner'
import { studioFiles, studioSections } from './studio-shared'
import { CARD_TEMPLATE_FILE } from '../shared/studio-files'
import { cardMeta, studioFor } from './studios'
import { contextAction } from './runtime-context'
import { studioConfigContext } from './studio-config'
import { roleNamed } from './roles'
import { ruleBlock, ruleOwner } from './rules'
import { readRuns } from './store'
import type { AgentAction, AgentRequest } from './types'
import { isRetired, notCompletedWhy } from './types'

// What a resumed run says. The coding agent's own session is already there — the card, the
// work done, the error it died on — so this is the "continue" you would type in the
// terminal, not the whole action prompt again.
export const RESUME_PROMPT = [
  `Continue work.`,
].join(' ')

// What a build resumed in its own session says, then why the delivery is still open.
const DELIVERY_RESUME = `Continue delivery %s. %r`

// Where a restarted build's requirements are. A card file can have moved under the delivery,
// so read its approved copy; a cardless build quotes its frozen requirements instead.
const DELIVERY_RESUME_CARD = `Build the card as the delivery holds it, not as the file reads now: \`%c\` prints the approved copy.`

const firstLine = (text?: string) => (text ?? '').split('\n').map((l) => l.trim()).find(Boolean)

/** Why the delivery is still open, as the task page says it: its stop, an ended build that
 *  never recorded completion, or the last build's error. */
function stopReason(deliveryId: string): string | undefined {
  const delivery = findDelivery(deliveryId)
  if (!delivery) return undefined
  const why = firstLine(delivery.review?.stopped?.why)
  if (why) return why
  const ids = new Set(delivery.sessions)
  const last = readRuns().filter((r) => ids.has(r.sessionId) && r.action === 'implement' && r.status !== 'running').at(-1)
  if (!last) return undefined
  if (last.status === 'done' && delivery.status === 'active' && deliveryPhase() !== 'implement') {
    return notCompletedWhy(delivery.cardId, boardCommand())
  }
  if (last.status === 'error' || last.status === 'interrupted') return firstLine(last.error)
  return undefined
}

/** Resume the same action; a build gets only its stop reason, since its session has the rest. */
export function resumePrompt(deliveryId: string | undefined, action: AgentAction, cardId?: number): string {
  if (deliveryId && action === 'implement' && compactTaskPrompt({ action, id: cardId })) {
    return deliveryResumePrompt(deliveryId, cardId!, stopReason(deliveryId))
  }
  if (cardId !== undefined && compactTaskPrompt({ action, id: cardId })) {
    const command = boardCommand()
    return [`Continue task #${cardId}. ${followTaskGuide(action, command)}`, commandAlias(command)].filter(Boolean).join('\n\n')
  }
  if (!deliveryId || action !== 'implement') return RESUME_PROMPT
  return DELIVERY_RESUME.replace('%s', deliveryId).replace('%r', stopReason(deliveryId) ?? '').trim()
}

/** Where a delivery's approved requirements are, for a build that starts a new session. */
function deliveryRequirements(deliveryId: string, cardId: number | null): string {
  if (cardId !== null) {
    return DELIVERY_RESUME_CARD.replace('%c', `${boardCommand()} task implement ${cardId} --print`)
  }
  const delivery = findDelivery(deliveryId)
  const approved = delivery?.approved.trim()
  if (!approved) return ''
  // A plan's approved copy is a whole document (#481), set out in full.
  if (delivery?.plan) {
    return `Build exactly the approved plan below following \`akb guide implement\`; create no card. It came from \`${delivery.plan}\`, and this is the copy to build:\n\n${approved}`
  }
  return `Follow \`akb guide implement\`: create no card and build exactly this approved requirement and nothing more — "${approved}".`
}

// The actions whose ask can be said again from the record alone. A resume drops what the
// user typed on purpose — it was already in the conversation being continued — so an action
// that is mostly those words (a revise's request, a reject's reason, a create's requirement,
// a plan's version) has nothing left to rebuild from, and is not restarted. A `write` run is
// left out for the same reason: the note naming the files it was asked for is its whole job.
const RESTARTABLE: ReadonlySet<AgentAction> = new Set<AgentAction>([
  'implement',
  'clarify',
  'resolve',
  'approve',
  'archive',
])

// What opens a restart. Everything the resume prompt leans on is gone, so the whole ask
// follows this line — the run does the task again rather than finishing a sentence.
const RESTART_LEAD = [
  `Continue work.`,
].join(' ')

/** Restart a lost conversation with its original action. Builds recover approved requirements;
 *  other restartable actions receive their own ask. */
export function restartPrompt(req: AgentRequest, deliveryId?: string, includeStudio = true): string | undefined {
  // A run that names neither a card nor a delivery has no ask to write down again.
  if (req.id === undefined && !req.deliveryId && !deliveryId) return undefined
  if (deliveryId && req.action === 'implement' && compactTaskPrompt(req)) {
    return [deliveryResumePrompt(deliveryId, req.id!, stopReason(deliveryId)), req.notes, pictureNote(req), settingsBlock(req), ruleBlock(req, frozenRules(req))]
      .filter(Boolean).join('\n\n')
  }
  if (deliveryId && req.action === 'implement') return [
    RESTART_LEAD,
    `Continue delivery ${deliveryId}. ${deliveryRequirements(deliveryId, req.id ?? null)}`.trim(),
    commandNote(boardCommand()),
    includeStudio && studioRulesBlock({ ...req, deliveryId }),
  ].filter(Boolean).join('\n\n')
  if (!RESTARTABLE.has(req.action)) return undefined
  return [RESTART_LEAD, buildRun(req, includeStudio).prompt].join('\n\n')
}

// Nothing here asks a run to refine the card afterwards. A command does one job and stops;
// the refinement sessions that follow are started once it ends (`refine.ts`), so each has
// its own log and can be stopped on its own.

// A revision request says what the card should say, not "go build it"; without this line an
// agent takes "make it handle empty input" as the work itself and writes code. Only `edit`
// carries it — create has its own "Create task only" line.
const NO_IMPLEMENT = `(Unless the request explicitly asks for implementation, don't implement it; revising the card's drafts is not implementing.)`

/** The ask and the board command to use, without the flow's rules.
 *  Printed flows append those rules separately (`flow.ts`). */
export function buildAsk(rawReq: AgentRequest, notes: string[] = []): string {
  const req = withStudio(rawReq)
  const command = boardCommand()
  const ask = [actionPrompt(req, command, notes), pictureNote(req), commandNote(command)].filter(Boolean).join(' ')
  // `docs/kanban` in these words is this board's real folder (#407) — the same swap the
  // flows get, so the ask and the flow it names never disagree about where the board is.
  return realPaths(boardText([ask, componentsBlock(req)].filter(Boolean).join('\n\n')), req)
}

function componentsBlock(req: AgentRequest): string {
  const flow = studioFor(studioForRun(req))
  const docs = flow ? studioComponents(flow.id) : []
  const text = componentDocsText(docs)
  return text ? `——— Preview Components ———\n\n${text}` : ''
}

// A sub-run's folder may hold no board (#1352), so it is given the real places. Filled in
// after `boardText`, whose `docs/kanban` swap would rewrite an absolute path.
const BOARD_FOLDER = '<board folder>'
const CARD_FILE = '<card file>'
const PROJECT_FOLDER = '<project folder>'

export function cardFileOf(id: number | undefined): string {
  const found = id === undefined ? null : locate(id)
  return found ? (found.kind === 'group' ? path.join(found.target, 'root.md') : found.target) : ''
}

function realPaths(text: string, req: AgentRequest): string {
  if (req.action !== 'sub') return text
  return text
    .split(BOARD_FOLDER)
    .join(KANBAN)
    .split(CARD_FILE)
    .join(cardFileOf(req.id))
    .split(PROJECT_FOLDER)
    .join(REPO_ROOT)
}

export function studioRulesBlock(req: AgentRequest, includeConfig = true): string {
  const frozen = deliveryFor(req)?.studio
  const flow = studioFor(studioForRun(req))
  if (!flow && !frozen) return ''
  const id = frozen?.id ?? flow!.id
  const meta = req.id !== undefined ? cardMeta(req.id) : null
  const review = taskReviewContext()?.review
  const selected = review ? reviewPreviewIds(review.plan) : meta?.previews
  const previews = frozen?.previews ?? flow?.previews ?? []
  const rules = frozen?.rules ?? flow?.rules ?? ''
  const template = studioFiles(id)?.[CARD_TEMPLATE_FILE]?.trim()
  return [
    '<studio>', rules,
    'Prepare only the outputs requested by this task. Previews describe outputs, not agents or approval stages. Revise saved work in place; keep unrelated outputs unchanged.',
    ...(selected?.length ? [`Selected Preview IDs: ${JSON.stringify(selected)}`] : []),
    ...previews.map(p => `<Preview id="${p.id}">\n${p.instructions}\n</Preview>`),
    'Write task results inside matching Preview tags. The app supplies display metadata. Review the plan and requested outputs together once; after approval, complete and record delivery even without Preview blocks.',
    '</studio>',
    ...(template ? [`<card-template>\n${template}\n</card-template>`] : []),
    includeConfig && studioConfigContext(id, runnerProject(KANBAN), contextAction(req.action), (file) => {
      try { return fs.readFileSync(path.join(KANBAN, file), 'utf8') } catch { return undefined }
    }),
    ...studioSections(id),
    ...memoryDirectories().map(dir => `Memory directory: ${dir}`),
  ].filter(Boolean).join('\n\n')
}

/** The words one run is given, this board's own rule for the flow last (#306). It goes
 *  after everything else the board writes, so nothing of the board's follows the user's. */
export function buildPrompt(rawReq: AgentRequest, notes: string[] = [], includeStudio = true): string {
  const req = withStudio(rawReq)
  return [buildAsk(req, notes), includeStudio && studioRulesBlock(req), settingsBlock(req), ruleBlock(req, frozenRules(req))]
    .filter(Boolean)
    .join('\n\n')
}

/** What the run's role is set to (#1469), before the user's rule. */
export function settingsBlock(req: AgentRequest): string {
  const owner = ruleOwner(req)
  const role = owner?.role ? roleNamed(owner.name) : undefined
  return role ? roleSettingsBlock(role) : ''
}

/** The pictures pasted into the create sheet (#517), as files to open — that is the only
 *  thing an agent can do with a path, and the words the user typed alongside them say what
 *  they are for.
 *
 *  Only for a connector that reads a path out of the words. One with a flag per file is
 *  handed them on its command line and told nothing here (agent/watch.ts), exactly as a
 *  conversation hands them over (agent/chat.ts).
 *
 *  The connector asked is the one THIS run spawns — its agent's, or the runtime it was
 *  started on instead (#518), which is what the spawn hands the files to. */
function pictureNote(req: AgentRequest): string {
  const files = req.pictures ?? []
  if (!files.length || agentImages(agentForRun(req), req.runtime)?.as !== 'message') return ''
  const one = files.length === 1
  return (
    `${one ? 'A picture came' : `${files.length} pictures came`} with this. ` +
    `Read ${one ? 'it' : 'them'} first: ${files.join(', ')}.`
  )
}

/** The rules the delivery in flight on this card froze when it started, or nothing when
 *  this run is not part of one. A delivery's runs work to the rules it started with, the
 *  way they build the card it started with. */
export function frozenRules(req: AgentRequest): Record<string, string> | undefined {
  return deliveryFor(req)?.rules
}

// Where a completed card is now (#534). Named outright: the ordinary card read no longer
// finds it.
function archivedCardFile(id: number): string {
  const found = locateArchived(id)
  if (!found) return `${rel(ARCHIVE)}/`
  return rel(found.kind === 'group' ? path.join(found.target, 'root.md') : found.target)
}

/** The cards one reflection covers (#1467). A run from before batching names one card. */
export const reflectedCards = (req: AgentRequest): number[] => req.cards ?? (req.id !== undefined ? [req.id] : [])

// What a finished card shipped (#1211): its landed commit, the files a `files` delivery
// recorded, or a way to find either.
function shippedLines(cardId: number): string[] {
  const delivery = endedDelivery(`${cardId}`)
  const commit = delivery?.landing?.commit
  if (commit) return [`\`git show ${commit.slice(0, 12)}\` — the change that landed`]
  if (delivery?.commitMode === 'files') {
    const files = recordedOutputs(delivery)
    if (files.length) return ['the files it delivered:', ...files.map((file) => `  ${file}`)]
  }
  return [`nothing on record — \`git log --grep "(#${cardId})"\`, or check the card against the project as it stands`]
}

// One `<card>` block per card a reflection reads.
function reflectBlocks(ids: number[]): string[] {
  return ids.flatMap((id) => [
    `<card id="${id}">`,
    ...field('file', archivedCardFile(id)),
    ...field('shipped', shippedLines(id)),
    '</card>',
  ])
}

const taskGuides: Partial<Record<AgentAction, string>> = {
  clarify: 'refine',
  resolve: 'resolve',
  edit: 'revise',
  approve: 'writing',
  implement: 'implement',
  archive: 'archive',
}

export function compactTaskPrompt(req: Pick<AgentRequest, 'id' | 'action'>): boolean {
  return req.id !== undefined && !!workspaceTask() && !!taskGuides[req.action]
}

function followTaskGuide(action: AgentAction, command: string): string {
  if (action === 'implement' && deliveryPhase() === 'land') {
    return `Land the saved work under the Studio's Land instructions. Check existing results before applying pending changes. Follow \`${command} guide archive\`.`
  }
  if (action === 'implement' && deliveryPhase() === 'implement') {
    return `Follow \`${command} guide implement\`. Build and verify in this delivery workspace. Leave merge, application and archive to Land.`
  }
  return `Follow \`${command} guide ${taskGuides[action]}\`.`
}

function commandAlias(command: string): string {
  return /^akb(?: |$)/.test(command) ? '' : `Use \`${command}\` for \`akb\`.`
}

function deliveryResumePrompt(deliveryId: string, id: number, why?: string): string {
  const command = boardCommand()
  return [
    `Continue delivery ${deliveryId} for task #${id}. ${followTaskGuide('implement', command)}`,
    why,
    commandAlias(command),
  ].filter(Boolean).join('\n\n')
}

function cardTurn(req: AgentRequest): string {
  const command = boardCommand()
  return [
    `Task #${req.id}${req.title ? ` — ${req.title}` : ''}. ${followTaskGuide(req.action, command)}`,
    req.action === 'approve' && 'Prepare the unlocked Previews.',
    req.action === 'edit' && 'Implement only if explicitly requested.',
    req.action === 'resolve' && answeredNote(req.id, command),
    req.session === 'fork' && 'Follow the current task when continuing from the discussion.',
    commandAlias(command),
    pictureNote(req),
    req.notes,
    settingsBlock(req),
    ruleBlock(req, frozenRules(req)),
  ].filter(Boolean).join('\n\n')
}

export function buildRun(rawReq: AgentRequest, includeStudio = true): { prompt: string; notes: string[] } {
  const notes: string[] = []
  const req = withStudio(rawReq)
  return { prompt: compactTaskPrompt(req) ? cardTurn(req) : buildPrompt(req, notes, includeStudio), notes }
}

/** What a conflict run is aimed at, and what its flow is typed with: the card
 *  where there is one, the delivery itself where there is not (#428). */


/** What a pass applying answers is told when a delivery is already building the card (#637).
 *  It is the one thing that can tell a confirmation from a change; the board never compares
 *  the card's text, and reads silence as unchanged (#831). Empty when nothing is building the card. */
function answeredNote(cardId: number | undefined, command: string): string {
  const delivery = cardId === undefined ? undefined : activeDelivery(cardId)
  if (!delivery) return ''
  return (
    `Record how the answers affect delivery ${delivery.deliveryId} before closing the questions. Run \`${command} delivery answered ${delivery.deliveryId} --changed "<why>"\` ` +
    `if the approved requirements changed, or \`${command} delivery answered ${delivery.deliveryId} --unchanged "<why>"\` otherwise.`
  )
}

// What a run is told on a session it carried on (#1304): the ask beside it is the whole task,
// and the card outranks whatever the session remembers of it.
function carriedNote(req: AgentRequest): string {
  if (req.action === 'implement') {
    return req.carry?.transcript
      ? `This card came out of a discussion. The card is the final word; the read-only transcript at \`${req.carry.transcript}\` ` +
          `is background reference only — consult it on demand if the card leaves details out, using keyword search or ` +
          `sectioned reads rather than reading the whole file.`
      : ''
  }
  // Nothing carried on, a Cloud task reads the discussion it came from (#2146).
  if (req.session !== 'resume' && req.session !== 'fork') {
    return req.carry?.transcript
      ? `This card came out of a discussion. The card is the final word: the discussion only fills in the background, ` +
          `and what it dropped stays dropped. Read it for what the card leaves out: ${req.carry.transcript}`
      : ''
  }
  // A discussion's session was told to change no file (#271), so a build must hear that is over.
  const held =
    req.session === 'resume'
      ? 'This session planned this card before.'
      : "This session is a copy of the discussion this card came from, and that discussion's rules ended with it: follow this ask."
  return `${held} The card as it reads now outranks what you remember of it, and what was dropped along the way stays dropped: read it again before you act.`
}

function actionPrompt(req: AgentRequest, command: string, notes: string[]): string {
  const tag = req.id ? `#${req.id}` : ''
  const named = req.title ? `${tag} ("${req.title}")` : tag
  // Retired (#438, #1203): nothing starts these any more, so there is no ask left to write.
  if (isRetired(req.action)) return ''
  switch (req.action) {
    // A cardless build takes its requirement from the sentence or approved plan.
    case 'implement':
      if (req.id === undefined) {
        return [
          req.plan
            ? `Build the approved plan at \`${req.plan}\`.`
            : `Build this: "${req.description?.trim() ?? ''}".`,
          `Follow \`akb guide implement\` — build exactly the approved requirement; create no card.`,
        ]
          .filter(Boolean)
          .join(' ')
      }
      return [
        `Implement task ${req.id} ${named} following \`akb guide implement\`. Read its current card before starting.`,
        carriedNote(req),
        req.notes ? `Extra notes: ${req.notes}` : '',
      ]
        .filter(Boolean)
        .join(' ')
    case 'archive':
      return [
        `Archive task ${req.id} ${named}.`,
        `Follow \`akb guide archive\`.`,
        req.notes ? `Extra notes: ${req.notes}` : '',
        `Don't ask me questions with human-in-the-loop. Leave any questions as open questions.`,
      ]
        .filter(Boolean)
        .join(' ')
    case 'edit':
      return [
        `Revise task ${req.id} ${named}: "${req.notes || ''}" ${NO_IMPLEMENT}`,
        carriedNote(req),
        `Apply the requested change following \`akb guide revise\`.`,
        `Don't ask me questions with human-in-the-loop. Leave any questions as open questions.`,
      ]
        .filter(Boolean)
        .join(' ')
    case 'clarify': {
      return [
        `Plan task ${req.id} ${named} following \`akb guide refine\`. A command with \`--print\` prints its flow for you to follow here, and without it starts a separate session.`,
        carriedNote(req),
        // A refine has no note box of its own, but one SCHEDULED on a blocked card
        // carries whatever was typed when it was scheduled — often the very reason the user
        // wanted it to wait — so it has to reach the run when it finally fires.
        req.notes ? `Extra notes: ${req.notes}` : '',
      ]
        .filter(Boolean)
        .join(' ')
    }
    // Squeeze the memory back down to what helps planning (#514). It names nothing: the
    // memory set IS the whole job, so the run reads the folders off the board itself. It
    // raises nothing for a human either — a prune has no card to leave a question on, so
    // anything it cannot settle stays in the memory file it is rewriting.
    case 'prune-memory':
      return [
        `Prune this board's memory following \`akb guide prune-memory\`.`,
        `Cover project records and all memory folders under \`${rel(MEMORY)}/\`.`,
        `Change nothing but those files: no card, no question for anyone.`,
      ].join(' ')
    // Reading back over the conversations (#748). It names nothing either: which ones have
    // said something new is the flow's answer, and the flow prints them with the memory
    // folder each one's notes belong in. Like a prune it raises nothing for a human — there
    // is no card to leave a question on.
    case 'review-memory':
      return [
        `Review what this board's conversations settled and write it into memory, following \`akb guide review-memory\`.`,
        req.tasks?.length ? `The conversations are the ones \`${command} memory review --task ${req.tasks.join(' ')} --print\` prints.` : '',
      ].filter(Boolean).join(' ')
    // The dismissal review (#929). The flow lists the dismissals and restored ids; the guide
    // holds every rule.
    case 'review-dismissals':
      return `Learn what the user does not want from their rejections and dismissals, following \`akb guide review-rejections\`.`
    case 'describe-project':
      return `Describe this project following \`akb guide describe-project\`.`
    // Reflecting on the cards the board has just completed (#534, #1467). They are off the
    // board, so the ask names the archive: nothing else can find them. It only writes inbox
    // items or starts a revise — it never edits or archives a card itself.
    case 'reflect': {
      const ids = reflectedCards(req)
      const archived = new Map(readArchive().cards.map((card) => [card.id, card.title]))
      const titles = ids.map((id) => (archived.get(id) ? `#${id} ("${archived.get(id)}")` : `#${id}`))
      return [
        [
          `These tasks have just been completed: ${titles.join(', ')}. Propose the work that should follow them, following \`akb guide reflect\`.`,
          `They have left the board — read each in its own <card> block below, with the discussion it came from when the block lists one.`,
          `Don't ask me questions with human-in-the-loop.`,
        ].join(' '),
        ...reflectBlocks(ids),
      ].join('\n')
    }
    case 'sub':
      return `You are a sub-run: run \`${req.parentId ?? ""}\` started you and works beside you in this same folder. Do only this task and report its result:\n\n${req.description ?? ""}`
    // The flow supplies conflict facts; the guide owns the procedure.
    case 'approve':
      return [
        `Prepare the newly unlocked Previews for task ${req.id} following \`${command} guide writing\`.`,
        req.notes ? `Extra notes: ${req.notes}` : '',
        `Don't ask me questions with human-in-the-loop. Leave any questions as open questions.`,
      ]
        .filter(Boolean)
        .join(' ')
    case 'resolve':
      return [
        `Apply my answers to the open questions on task ${req.id} ${named} following \`akb guide resolve\`.`,
        carriedNote(req),
        answeredNote(req.id, command),
        req.notes ? `Extra notes: ${req.notes}` : '',
      ]
        .filter(Boolean)
        .join(' ')
  }
}

export function discardedCardsPrompt(cards: { id: number; path: string }[] = []): string {
  if (!cards.length) return ''
  return 'The user discarded the cards listed below. Their absence is intentional. Do not restore or recreate them, including under new IDs or filenames. Continue the remaining work from the current board, preserving the other cards.\n\n' + cards.map((c) => `- #${c.id}: ${c.path}`).join('\n')
}
