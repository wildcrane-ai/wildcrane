import { boardCommandFor } from '../lib/agent/command'
import { resetPreviewScope } from './preview-confirm'
import { choosePreviewRevision, previewBaseline } from '../lib/preview-stages'
import { PREVIEW_BRIDGE_ENV, previewBridge } from '../lib/cloud/preview'
import { freezePreviewProgress, previewRun, selectLocalPreview, submitLocalPreview, previewStagePrompt, updatePreviewProgress, savePreviewBaseline, readPreviewBaseline } from '../lib/agent/preview-progress'
// Print specialist instructions here, or request a separate run.

import { insideRun, printFlow } from '../lib/agent/flow'
import { agentHarness } from '../lib/agent/resolve'
import { askForSpec, readRuns } from '../lib/agent/sessions'
import { startRun } from '../lib/agent/start'
import { titleOf } from '../lib/agent/sessions'
import type { AgentRequest } from '../lib/agent/types'
import { locate } from '../lib/cards'
import { say } from '../lib/io'
import { die, rel, BOARD_FLAG, TODO } from '../lib/paths'
import {
  findSpecAgent,
  notAnAgent,
  specAgentAssigned,
  specAgentList,
  specAgents,
  specAgentNamesOnBoard,
  specAgentProblems,
  SPEC_ASSIGN_HOME,
} from '../lib/agents'
import { cardStudioId } from '../lib/agent/studios'
import type { MoveResult } from '../lib/types'
import { followStarted, short } from './run'

/** `akb raw previews`, as its command declares it (lib/cli/agent.ts). */
export interface SpecOptions {
  agent?: string
  id?: number
  note?: string[]
  notes?: string
  follow?: boolean
  print?: boolean
  stages?: string
  resetStages?: boolean
  reviseFrom?: string
  submit?: boolean
  stage?: string
  continue?: boolean
  events?: boolean
  triggers?: boolean
  studio?: string
  workspace?: string
}

export async function cmdSpec(opts: SpecOptions, program = 'akb'): Promise<MoveResult> {
  if ((opts.studio || opts.workspace) && !opts.triggers) die('--studio and --workspace require --triggers', { kind: 'invalid-usage' })
  if (opts.workspace && !opts.studio) die('--workspace requires --studio', { kind: 'invalid-usage' })
  if (opts.triggers) {
    if (opts.agent !== undefined || opts.id !== undefined || opts.note?.length || opts.print || opts.follow || opts.notes !== undefined) {
      die('--triggers cannot be combined with positional arguments, --print, --follow or --notes', { kind: 'invalid-usage' })
    }
    const agents = specAgents().map((agent) => ({ name: agent.name, when: agent.when ?? null }))
    const problems = specAgentProblems()
    say([
      ...(agents.length
        ? agents.map((agent) => `${agent.name}\n  ${agent.when ?? 'Always'}`)
        : ['This board has no preview agent. Ask for none.']),
      ...(problems.length ? ['', 'Problems on this board:', ...problems.map((problem) => `  ${problem}`)] : []),
    ].join('\n'))
    return { agents, problems }
  }

  // No agent named: say which ones there are. Every agent on the board, because this is
  // typed with no card in hand — which of them a card may actually ask for is its own
  // studio's answer, and the ask below is where that is checked.
  if (!opts.agent) {
    say(specAgentList(program, !insideRun()))
    return { agents: specAgentNamesOnBoard(), problems: specAgentProblems() }
  }

  if ([opts.submit, opts.stages !== undefined, opts.reviseFrom, opts.resetStages].filter(Boolean).length > 1) die('Choose one stage operation.', { kind: 'invalid-usage' })
  if ((opts.submit && !opts.stage) || (opts.stage && !opts.submit) || (opts.stages !== undefined && opts.submit)) die('Use --stages <ids> or --submit --stage <id>.', { kind: 'invalid-usage' })

  const askedName = opts.agent.trim()
  const agent = findSpecAgent(askedName)
  if (!agent) die(notAnAgent(askedName), { kind: 'no-such-spec-agent', specAgent: askedName })
  const name = agent.name

  const id = opts.id
  if (id === undefined) {
    die(`say which card: ${program} raw previews ${name} <id> [note]`, { kind: 'needs-input' })
  }
  if (!locate(id)) die(`no task with id ${id} under ${rel(TODO)}`, { kind: 'card-not-found', id })

  if (opts.stages !== undefined || opts.submit || opts.reviseFrom) {
    try {
      const run = previewRun(id, name)
      const ids = opts.stages?.split(',').map((id) => id.trim())
      const result = await previewBridge(name, ids ? 'select' : opts.reviseFrom ? 'revise' : 'submit', { run: run.sessionId, ...(ids ? { stages: ids } : opts.reviseFrom ? { stageId: opts.reviseFrom } : { baseline: readPreviewBaseline(run.sessionId), stageId: opts.stage }) })
      if (result?.progress) {
        updatePreviewProgress(id, (all) => { all[name] = result.progress! })
        if (result.baseline) savePreviewBaseline(run.sessionId, result.baseline)
      } else if (opts.reviseFrom) {
        updatePreviewProgress(id, (all) => {
          const progress = all[name]!
          choosePreviewRevision(progress, opts.reviseFrom!, run.sessionId)
          savePreviewBaseline(run.sessionId, previewBaseline(progress, opts.reviseFrom!, run.sessionId))
        })
      } else if (ids) {
        const selected = selectLocalPreview(id, name, ids)
        savePreviewBaseline(run.sessionId, selected.baseline)
      } else submitLocalPreview(id, name, opts.stage!, readPreviewBaseline(run.sessionId))
      if (ids || opts.reviseFrom) say(previewStagePrompt(id, name, boardCommandFor(id)))
      else say('Preview stage submitted. Stop here; the program controls confirmation and continuation.')
      return { specAgent: name, cardId: id, submitted: !!opts.submit }
    } catch (error) { die(error instanceof Error ? error.message : 'Preview submission failed.', { kind: 'preview-refused' }) }
  }

  if (opts.resetStages) return resetPreviewScope(id, name, opts.notes ?? opts.note?.join(' '))

  // Off, or in another studio (#749): refused, with what to do instead.
  if (!specAgentAssigned(name, cardStudioId(id))) {
    die(
      `the \`${name}\` agent is off or no preview of the studio of #${id}, so it isn't running. Plan that part of the card yourself and carry on. It joins when ${SPEC_ASSIGN_HOME}.`,
      { kind: 'spec-agent-off', specAgent: name },
    )
  }

  const notes = noteOf(opts.note ?? [], opts.notes)
  const req: AgentRequest = { action: 'spec', id, title: titleOf(id), specAgent: name, notes }

  const inside = insideRun()
  if (!inside && process.env[PREVIEW_BRIDGE_ENV]) opts.follow = true
  if (inside && readRuns().find((r) => r.sessionId === inside)?.action === 'spec') {
    die(
      'a preview agent does not ask for another preview agent — answer the part you own and leave the rest of the card to the session planning it.',
      { kind: 'spec-agent-recursion', specAgent: name },
    )
  }

  // One agent on one card at a time. A flow that asks while that agent is still working the
  // card would get its section written twice from the same plan, and the second run would
  // land on whatever the first one left — so the ask is dropped, not queued behind it.
  const live = readRuns().find(
    (r) => r.status === 'running' && r.action === 'spec' && r.cardId === id && r.specAgent === name,
  )
  if (live) {
    say(`${name} is already working on #${id} — run ${short(live.sessionId)}. One ask is enough; don't wait for it.`)
    return { specAgent: name, cardId: id, queued: false, pending: true }
  }

  // An agent set to another runtime than the caller's runs on its own (#1598), and so does one
  // that asks for a session of its own (#2152).
  const caller = inside ? readRuns().find((r) => r.sessionId === inside)?.runtime : undefined
  const ownRuntime = opts.print === true && !!caller && caller !== agentHarness(name).runtime
  const ownSession = opts.print === true && (agent.session === 'new' || !!freezePreviewProgress(id, name))
  const print = opts.print === true && !ownRuntime && !ownSession

  if (print) return printFlow(req, program)

  // Separate requests from a board run start after its parent finishes.
  if (inside) {
    const queued = askForSpec(inside, { specAgent: name, cardId: id, notes })
    if (queued === 'no-run') {
      die(`run ${short(inside)} is not on this board's list, so the ask has nowhere to be written down`, {
        kind: 'no-such-run',
        run: inside,
      })
    }
    say(
      queued === 'already'
        ? `${name} was already asked for on #${id} — one ask is enough; it starts when this run ends.`
        : `asked for the ${name} preview agent on #${id}. The board starts it when this run ends — don't wait for it, and don't write its section yourself.`,
    )
    return { specAgent: name, cardId: id, queued: queued === 'queued', pending: true }
  }

  const started = await startRun(req)
  if ('error' in started) die(started.error, { kind: 'run-refused', action: 'spec' })
  const { run, spawned } = started
  if (!spawned) die(`couldn't start a process to run ${run.sessionId}`, { kind: 'spawn-failed' })
  if (ownRuntime || ownSession) {
    say(`${name} runs in ${ownRuntime ? 'its own runtime' : 'a session of its own'}, so it started as a separate run — don't write its section yourself.`)
  }
  say(`previews ${name} #${id} — run ${run.sessionId}`)
  say(`  follow it: ${program} raw run log ${short(run.sessionId)} --follow${BOARD_FLAG}`)
  say(`  stop it:   ${program} raw run stop ${short(run.sessionId)}${BOARD_FLAG}`)
  if (opts.follow === true) return await followStarted(run.sessionId, program, opts.events === true)
  return { sessionId: run.sessionId, action: 'spec', specAgent: name, cardId: id }
}

// What the flow wants looked at. Everything after the id is the note, so it can be typed
// without quoting; `--notes` is the same thing spelled for a caller building a command.
function noteOf(words: string[], flag: string | undefined): string | undefined {
  const typed = words.join(' ').trim()
  if (typed) return typed
  return flag?.trim() || undefined
}
