import { queryPreviews, externalGoalSession, cloudGoal, cloudGoalStudios } from '../../commands/goal-cloud'
import { Option } from 'commander'

import { BoardError } from '../io'
import { die, KANBAN } from '../paths'
import { resolveBoard, useBoard } from '../board-cli'
import { syncStudios } from '../agent/cloud-studios'
import { FLOWS, flowVerb, type Flow, type FlowGroup, type FlowOption } from '../agent/flows'
import { namedDelivery } from '../agent/deliveries'
import type { DeliveryRecord } from '../agent/types'
import { HELP_AFTER, PRINT_FLOW_HELP } from '../agent/manual'
import { cmdAgent } from '../../commands/agent'
import { cloudImage, cloudMusic, cloudTts, cmdCloud } from '../../commands/cloud'
import { cmdTranscribe } from '../../commands/transcribe'
import {
  templateDelete,
  templateGet,
  templatePreview,
  templatePublish,
  templateShowcase,
  templateSearch,
  templateSource,
  templateTags,
} from '../../commands/cloud-template'
import { cmdComponents, cmdStudioComponents } from '../../commands/components'
import { cmdGoal } from '../../commands/goal'
import {
  type TaskLocation,
  projectList,
  runnerList,
  taskApprove,
  taskReview,
  taskUpdateQuestions,
  taskChat,
  taskComment,
  taskCreate,
  taskList,
  taskArchive, taskRemove, taskRestore,
  taskResume,
  taskRuntime,
  taskShow,
  taskStop,
  workspaceList,
} from '../../commands/task'
import { taskChatRead, taskChatFollow, validateChatOptions } from '../../commands/task-chat'
import { cmdGuide } from '../../commands/guide'
import { cmdStudioDiagram, cmdStudioInstructions, cmdStudioList, cmdStudioRule, cmdStudioPull, cmdStudioClone, cmdStudioPush, cmdStudioCreate, cmdStudioValidate } from '../../commands/studio'
import {
  cmdAnswered,
  cmdCancel,
  cmdCompleteDelivery,
  cmdReconcileDelivery,
  cmdReleaseDelivery,
  cmdResumeDelivery,
  cmdLog,
  cmdResume,
  cmdRuns,
  cmdStartRun,
  cmdStop,
  cmdSubStart,
  cmdSubWait,
  cmdWatch,
} from '../../commands/run'
import { cmdTriageAdd, cmdTriageCheck } from '../../commands/triage'
import { cmdGoalStudios, cmdGoalPreviews, goalsFile } from '../../commands/goal'
import { listPreviews } from '../../commands/previews'
import { cmdStudioPreview } from '../../commands/studio-preview'
import { cmdTelemetry } from '../../commands/telemetry'
import { cmdAgentCheck } from '../../commands/agent-check'
import { HARNESSES } from '../agent/harnesses'
import { createBoardCard, declareBoardMoves, withCreateOptions } from './board'
import { withQuestionOptions } from './question-options'
import { cardId, ctxOf, intInRange, oneOf, runAction, withShared, type Command, type Typed } from './shared'
import type { AkbCliOptions } from './akb'

/** What the door hands in — see `runAgent`. */
export type AgentCliOptions = AkbCliOptions

const REVIEW_FLOW_HELP = `
Review examples
  --review 'UI design'                        One Preview approval
  --review 'UI design -> Prompts'             Approve in order
  --review 'UI design + API docs -> Prompts'  Both approvals unlock Prompts
  --review ''                                 No extra review`

// Every command here works on one board, so finding it is done once rather than in each.
// The account half of `cloud` is the exception: the Cloud sign-in belongs to the machine
// rather than to any one project (#326).
//
// `guide` is a half-exception (#407). Its text is the board's — the solution picks which
// words, and the board's own path is written into them — so it opens one when there is one,
// and answers from the shipped text when there isn't. A flow has to be readable in a folder
// that holds no board at all: that is how someone reads one before installing anything.
async function onBoard(
  cmd: Command,
  cli: AgentCliOptions,
  work: (program: string) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void,
  refreshStudios = false,
): Promise<void> {
  const ctx = ctxOf(cmd, cli.program)
  // `board:` is read INSIDE the work: which board this is is only settled by `useBoard`
  // below, and a field read beside `runAction` names whichever board came before (#407).
  await runAction(ctx, {}, async () => {
    const found = resolveBoard('runs', { board: ctx.board, dir: ctx.dir, cwd: cli.cwd, installHint: cli.installHint })
    useBoard(found, ctx.dir !== null)

    await syncStudios(refreshStudios)
    return { board: KANBAN, ...((await work(cli.program)) ?? {}) }
  })
}

// Inside an idea conversation (#2073) the studios are the workspace's, and there is no board.
const studioList = (cmd: Command, cli: AgentCliOptions) =>
  !cmd.optsWithGlobals().board && externalGoalSession() ? boardless(cmd, cli, cloudGoalStudios) : goalsFile() ? boardless(cmd, cli, () => cmdGoalStudios()) : onBoard(cmd, cli, cmdStudioList, true)

async function boardless(
  cmd: Command,
  cli: AgentCliOptions,
  work: (program: string, location: TaskLocation) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void,
): Promise<void> {
  const ctx = ctxOf(cmd, cli.program)
  await runAction(ctx, {}, async () => (await work(cli.program, { board: ctx.board, dir: ctx.dir, cwd: cli.cwd })) ?? {})
}

// What Commander hands an action handler: the declared arguments, then the options, then
// the command. The two on the end are read off `this`, so only the arguments are wanted.
const positional = (vals: unknown[]): unknown[] => vals.slice(0, -2)

/** A noun on its own is a question: answer it with its own verbs. */
function nounOf(program: Command, name: string, summary: string, description?: string): Command {
  const cmd = withShared(program.command(name)).summary(summary)
  if (description) cmd.description(description)
  return cmd.allowExcessArguments().allowUnknownOption().action(function (this: Command) {
    if (this.args.length) this.error(`unknown command '${this.args[0]}'`, { code: 'commander.unknownCommand' })
    this.help()
  })
}

/** Declare the local board and in-run commands on `akb raw` (./board.ts). `cli.program` is the
 *  `akb` the line was typed with, without `raw`. */
export function declareRaw(program: Command, cli: AgentCliOptions): void {
  declareLocalRuns(program, cli)
}

function declareLocalRuns(program: Command, cli: AgentCliOptions, canonical?: { task: Command; studio: Command }): void {
  const command = canonical ? cli.program : `${cli.program} raw`
  const noun = (name: string, summary: string, description?: string): Command => nounOf(program, name, summary, description)

  const groups: Record<FlowGroup | 'run', Command> = {
    card: canonical?.task ?? noun(
      'card',
      'one card: build it, sharpen it, change it, finish it',
      'Every verb here takes the card’s id. A card with a delivery in flight refuses all of them but ' +
        `\`implement\` — \`${command} delivery cancel\` is what hands it back.`,
    ),
    delivery: noun(
      'delivery',
      'the build in flight on a card',
      'Each verb takes the delivery, or the card it is on. The ' +
        'current run records its step with `complete`.',
    ),
    run: noun(
      'run',
      'the agent processes — what is going, and what went',
      'A run is one agent working once. A delivery is made of several, so ending a run leaves the ' +
        `delivery in flight — \`${command} delivery cancel\` is what ends that.`,
    ),
    memory: noun('memory', 'read and maintain project memory'),
    // What is waiting to be sorted (#453, #499).
    triage: noun(
      'triage',
      'what is waiting to be sorted',
      'What is in triage is not a task: it never enters the card list, is never scheduled, ' +
        'and counts towards nothing. Triage is `docs/kanban/triage/`, one file each, with ' +
        '`archived/` for what became a card and `dismissed/` for what was ignored. The board UI is where items are read, made into cards, ignored and ' +
        'restored.',
    ),
  }

  for (const flow of FLOWS) {
    if (flow.internal) continue
    if (canonical && flow.action === 'describe-project') {
      declareFlow(groups.memory, flow, cli, true)
    } else if (!canonical || flow.group === 'card' && flow.action !== 'approve' || flow.action === 'review-memory' || flow.action === 'prune-memory') {
      declareFlow(flow.group ? groups[flow.group] : program, flow, cli, !!canonical)
    }
  }

  declareRunning(groups.run, cli, !!canonical)
  declareDelivery(groups.delivery, cli, !!canonical)

  // What a delivery is belongs under the noun it is about, not on the root list.
  groups.delivery.addHelpText('after', HELP_AFTER.deliveries(cli.program))

  withShared((canonical?.studio ?? program).command('previews'))
    .allowExcessArguments()
    .summary('list Preview output IDs and instructions')
    .addOption(new Option('-f, --follow').hideHelp())
    .addOption(new Option('--notes <text>').hideHelp())
    .addOption(new Option('--print').hideHelp())
    .addOption(new Option('--triggers', 'query Studio Previews for a Goal').hideHelp(!!canonical))
    .option('--studio <id>', 'Preview outputs of this Studio')
    .addOption(new Option('--workspace <id>', 'the workspace whose studios to query').hideHelp(!!canonical))
    .action(async function (this: Command) {
      const opts = this.opts()
      if (this.args.length || opts.follow || opts.notes !== undefined) {
        return boardless(this, cli, () => die('Prepare Preview outputs in the task session using STUDIO.md.', 'bad-args'))
      }
      if (opts.triggers && opts.studio && !opts.print) {
        await boardless(this, cli, async () => {
          if (goalsFile() && !opts.workspace) return cmdGoalPreviews(opts.studio)
          return queryPreviews(opts.studio, opts.workspace)
        })
      } else await onBoard(this, cli, () => listPreviews(opts.studio))
    })

  // ---- what is waiting to be sorted (#453, #499) ----------------------------
  //

  const triage = groups.triage

  withShared(triage.command('add'))
    .summary('write one item into triage')
    .description(
      'One item, from words you already have — no endpoint, and nothing is pulled. The body is ' +
        '`--text` for a line or two, `--file <path>` when it is longer. `--source` says where it came ' +
        'from, and a reflection puts the card that prompted it there. It is not a task: it waits in ' +
        'triage until somebody sorts it. One already waiting, or already made into a card, is refused ' +
        'and told where it is; one only ignored is taken, and its `dismissed/` record is left alone.',
    )
    .requiredOption('--title <text>', 'what it is, in one line')
    .option('--text <text>', 'its own words')
    .option('--file <path>', 'its own words, written to a file first')
    .option('--source <text>', 'where it came from')
    .requiredOption('--studio <id>', 'the studio that does it (`akb studio list`); the card made of it runs on it')
    .option('--slug <slug>', 'a short English name for its file, and for the card it becomes (default: from the title)')
    .action(async function (this: Command) {
      await onBoard(this, cli, () => cmdTriageAdd(this.opts()))
    })

  withShared(triage.command('check'))
    .summary('where triage already holds one source id')
    .description(
      'Scans triage, `archived/` and `dismissed/` for the id and answers `pending`, `archived`, ' +
        '`dismissed` or `unseen`, with the file that says so. Hit in more than one place, the first ' +
        'of those wins. This is the rule the pull and both ways of adding read — a pull is held off ' +
        'by all three, an add by everything but a dismissal.',
    )
    .argument('<source-id>', 'the id to look for')
    .action(async function (this: Command, sourceId: string) {
      await onBoard(this, cli, () => cmdTriageCheck(sourceId))
    })

  const studio = canonical?.studio ?? noun('studio', 'check a Studio folder')
  withShared(studio.command('validate'))
    .argument('<folder>', 'a studio folder containing STUDIO.md')
    .summary('validate the complete Studio definition and its references')
    .action(async function (this: Command, folder: string) {
      await onBoard(this, cli, () => cmdStudioValidate(folder))
    })
  withShared(studio.command('preview'))
    .argument('<card>', 'the card to review the Studio on', cardId)
    .requiredOption('--folder <draft>', 'the complete draft Studio folder')
    .requiredOption('--base <baseline>', 'the baseline folder, or empty for a new Studio')
    .summary('freeze Studio files and print Studio and attachment previews')
    .action(async function (this: Command, card: number) {
      await onBoard(this, cli, () => cmdStudioPreview(card, this.opts()))
    })
  if (canonical) {
    const board = noun('board', 'list local cards and resolve board conflicts')
    declareBoardMoves(program, cli, { ...canonical, board, memory: groups.memory })
    return
  }

  declareAgent(program, cli)
  withShared(program.command('components'))
    .summary('list an agent or studio’s Preview Components and their usage')
    .option('--studio <id>', 'all components used by a studio')
    .option('--docs', 'include component usage documentation')
    .action(async function (this: Command) {
      const ctx = ctxOf(this, cli.program)
      useBoard(resolveBoard('components', { board: ctx.board, dir: ctx.dir, cwd: cli.cwd, installHint: cli.installHint }), ctx.dir !== null)
      await boardless(this, cli, () => cmdStudioComponents(this.opts()))
    })

  withShared(studio.command('diagram', { hidden: true }))
    .argument('<id-or-card>', 'studio id, or card number with --folder')
    .argument('[card]', 'the card whose asset folder gets studio.json')
    .option('--folder <folder>', 'read a local studio folder')
    .summary('write the studio\'s diagram to .assets/<card>/studio.json and print the <Studio> tag that shows it')
    .action(async function (this: Command, id: string, card: string) {
      await onBoard(this, cli, () => cmdStudioDiagram(id, this.opts().folder ? id : card, this.opts().folder))
    })
}

/** Declare the Cloud commands and the guides on `akb` (./akb.ts). */
export function declareRuns(program: Command, cli: AgentCliOptions): void {
  withShared(program.command('components'))
    .argument('[component...]', 'component names in output order')
    .summary('list supported Preview formats or show component usage')
    .action(async function (this: Command, names: string[]) {
      await boardless(this, cli, () => cmdComponents(names))
    })

  // ---- WildCrane tasks and goals, in Cloud (#550) -----------------------------

  const task = withShared(program.command('task'))
    .summary('manage Cloud tasks and work on local cards')
    .description('Manage tasks. Check subcommand help for whether it works on this board or in Cloud.')
    .action(function (this: Command) {
      this.help()
    })
  withShared(task.command('list'))
    .summary('list tasks')
    .option('--project <id>', 'the project; default: this folder’s linked one')
    .option('--workspace <id>', 'every project of a workspace')
    .option('--status <status>', 'queued, running, waiting_review, done, failed, cancelled or stopped')
    .action(async function (this: Command) {
      await boardless(this, cli, (_, location) => taskList(this.opts(), location))
    })
  withShared(task.command('show'))
    .argument('<task>')
    .summary('read the card, review stages, Previews and task files')
    .action(async function (this: Command, id: string) {
      await boardless(this, cli, (_, location) => taskShow(id, location))
    })
  withCreateOptions(withShared(task.command('create')))
    .argument('[request...]', 'what the task should do')
    .summary('prepare a task from a request or write a local card from a title')
    .description('Pass a request to prepare a Cloud task asynchronously. ' +
      'Use --title to allocate a number in Cloud and immediately write a card and its index entry to this board. ' +
      'Use --studio with a request. Card fields apply to --title and --project applies to a request. Edit the saved body separately.')
    .option('--project <id>', 'for a request: the project; default: this folder’s linked one')
    .option('--review <flow>', 'set a review flow using Studio Preview names')
    .option('--review-file <path>', 'JSON review nodes with after dependencies; [] needs no extra review')
    .option('--preview-definitions-file <path>', 'propose a JSON list of task Preview definitions')
    .action(async function (this: Command, request: string[]) {
      const opts = this.opts()
      if (opts.title !== undefined) {
        if (request.length || opts.project !== undefined || opts.review !== undefined || opts.reviewFile !== undefined || opts.previewDefinitionsFile !== undefined) {
          die('Use --title with the local board, or pass a request with --project, --review, --review-file, and --preview-definitions-file.', 'bad-args')
        }
        return createBoardCard(this, cli)
      }
      if (['priority', 'blockedBy', 'related', 'modules', 'slug', 'triage', 'source'].some((key) => opts[key] !== undefined)) {
        die('Card fields require --title.', 'bad-args')
      }
      if (!request.length) this.error("missing required argument 'request' or option '--title'", { code: 'commander.missingArgument' })
      await boardless(this, cli, (_, location) => taskCreate(request.join(' '), opts, location))
    })
  withShared(task.command('approve'))
    .argument('<task>')
    .summary('approve the current review point')
    .option('--stage <id>', 'the reviewed node')
    .requiredOption('--revision <n>', 'the stage version you reviewed')
    .option('--comment <text>', 'a note with the approval')
    .action(async function (this: Command, id: string) {
      await boardless(this, cli, (_, location) => taskApprove(id, this.opts().comment, this.opts(), location))
    })
  withShared(task.command('review'))
    .argument('<task>')
    .summary('read the task review, set the plan or report a stage')
    .option('--review <flow>', 'set a review flow using Studio Preview names')
    .addHelpText('after', REVIEW_FLOW_HELP)
    .option('--file <path>', 'set a JSON review plan')
    .option('--stage <id>', 'the node to report')
    .option('--status <status>', 'running or done')
    .option('--preview-definitions-file <path>', 'propose a JSON list of task Preview definitions')
    .option('--revise-from <id>', 'revise this node and its dependents')
    .option('--revision <n>', 'the task review version read before this write')
    .action(async function (this: Command, id: string) {
      await boardless(this, cli, (_, location) => taskReview(id, this.opts(), location))
    })
  const questionOps: Typed[] = []
  withQuestionOptions(withShared(task.command('update-questions'))
    .argument('<task>')
    .summary('append, rewrite, or remove open questions')
    .description('Edit the current Runner task locally for synchronization, or save another task in Cloud. ' +
      'Edits apply in order at 1-based positions. Choices and mode apply to the preceding --append or --update.\n' +
      'See akb guide update-questions.'), questionOps)
    .action(async function (this: Command, id: string) {
      await boardless(this, cli, (_, location) => taskUpdateQuestions(id, questionOps, location))
    })
  withShared(task.command('chat'))
    .argument('<task>')
    .argument('[message...]')
    .summary('read task chat history, follow or stop its reply, or send a message')
    .description('Without a message, read the last 20 messages and the chat reply state separately from task execution. --follow tracks only the reply present at the start; Ctrl+C disconnects locally. --stop stops only that reply. --follow --json emits JSON Lines; other modes return one JSON object.')
    .option('--limit <n>', 'show the last n messages, oldest first (default: 20)', intInRange(1, Number.MAX_SAFE_INTEGER))
    .option('--all', 'show all retained messages')
    .option('--follow', 'follow this reply to its result, then exit')
    .option('--stop', 'request stopping only the current chat reply')
    .addHelpText('after', '\nExamples:\n  akb task chat WC-12\n  akb task chat 12 --all --json\n  akb task chat 12 --follow --json\n  akb task chat 12 --stop\n  akb task chat 12 "Revise the draft"')
    .action(async function (this: Command, id: string, message: string[]) {
      const opts = this.opts()
      validateChatOptions(message, opts)
      if (opts.follow) return taskChatFollow(id, { ...opts, ...ctxOf(this, cli.program), cwd: cli.cwd })
      await boardless(this, cli, (_, location) => message.length ? taskChat(id, message.join(' '), location) : taskChatRead(id, { ...opts, ...location }))
    })
  withShared(task.command('archive'))
    .argument('<task>')
    .summary('archive an eligible task')
    .description('Archive the current Runner task locally for sync, or wait for Cloud to confirm the archive of another task.')
    .action(async function (this: Command, id: string) {
      await boardless(this, cli, (_, location) => taskArchive(id, location))
    })
  withShared(task.command('remove'))
    .argument('<task>')
    .argument('[reason...]')
    .summary('remove a task; bring it back with task restore')
    .description('Remove the current local task for the Runner to sync, or confirm removal in Cloud. An agent’s removal skips rejection learning.')
    .option('--discard', 'skip rejection learning and keep the reason')
    .addOption(new Option('--reason <text>').hideHelp())
    .action(async function (this: Command, id: string, reason: string[]) {
      const opts = this.opts()
      await boardless(this, cli, (_, location) => taskRemove(id, opts.reason ?? reason.join(' '), location, opts.discard))
    })
  withShared(task.command('restore'))
    .argument('<task>')
    .summary('restore a removed or completed task without starting it')
    .action(async function (this: Command, id: string) {
      await boardless(this, cli, (_, location) => taskRestore(id, location))
    })
  withShared(task.command('resume'))
    .argument('<task>')
    .summary('continue its stopped run')
    .action(async function (this: Command, id: string) {
      await boardless(this, cli, (_, location) => taskResume(id, location))
    })
  withShared(task.command('runtime'))
    .argument('<task>')
    .argument('<runtime>')
    .summary('change a task’s runtime')
    .action(async function (this: Command, id: string, runtime: string) {
      await boardless(this, cli, (_, location) => taskRuntime(id, runtime, location))
    })
  withShared(task.command('stop'))
    .argument('<task>')
    .summary('stop its current run')
    .action(async function (this: Command, id: string) {
      await boardless(this, cli, (_, location) => taskStop(id, location))
    })
  withShared(task.command('comment'))
    .argument('<task>')
    .argument('<text...>')
    .summary('comment on a task')
    .action(async function (this: Command, id: string, text: string[]) {
      await boardless(this, cli, (_, location) => taskComment(id, text.join(' '), location))
    })

  const goal = withShared(program.command('goal'))
    .argument('<move>', 'new, save, drop or start')
    .summary('save, drop and start goals of this conversation')
    .description('Write a temporary draft, then goal new --title "…" --body-file <file> [--studio <id>] [--review <flow>]; update with goal save --id <goal> and any of --title, --body-file, --studio, --review. goal drop --id <goal> withdraws one; goal start --id <goal> turns it into a task. A `## Done when` list in the body is what counts as done. Studios are the ones `akb studio list` shows.')
    .option('--id <goal>', 'the goal to save, drop or start')
    .option('--title <title>', 'what the goal is called')
    .option('--body-file <path>', 'the outcome, then a `## Done when` list')
    .option('--studio <id>', 'the studio that does the work, from `akb studio list`')
    .option('--review <flow>', 'save a review flow using Studio Preview names')
    .option('--preview-definitions-file <path>', 'save a JSON list of Goal Preview definitions')
    .option('--review-file <path>', 'JSON review nodes with after dependencies; [] needs no extra review')
    .addHelpText('after', REVIEW_FLOW_HELP)
  goal.action(async function (this: Command, sub: string) {
    await boardless(this, cli, () => (externalGoalSession() ? cloudGoal([sub], this.opts()) : cmdGoal([sub], this.opts())))
  })

  withShared(withShared(program.command('workspace')).summary('your WildCrane workspaces').command('list'))
    .summary('list workspaces')
    .action(async function (this: Command) {
      await boardless(this, cli, () => workspaceList())
    })
  withShared(withShared(program.command('project')).summary('your WildCrane projects').command('list'))
    .summary('list projects')
    .option('--workspace <id>', 'only this workspace’s')
    .action(async function (this: Command) {
      await boardless(this, cli, () => projectList(this.opts()))
    })
  withShared(withShared(program.command('runner')).summary('the computers that run a workspace’s tasks').command('list'))
    .summary('list Runners')
    .option('--workspace <id>', 'default: the linked project’s')
    .action(async function (this: Command) {
      await boardless(this, cli, (_, location) => runnerList(this.opts(), location))
    })

  // ---- Cloud ----------------------------------------------------------------

  const account = withShared(program.command('account'))
    .summary('the account this MACHINE acts as')
    .description(
      'A sign-in is started in the WildCrane app, under Configuration → Cloud, and nowhere else: ' +
        'the consent screen opens in your own browser and comes back to the app. Once per machine — every ' +
        `\`${cli.program}\` on it then acts as that account, because they read the one session the app ` +
        'wrote, outside every repository. Cloud is an invite-only preview.',
    )
    .allowExcessArguments()
    .action(async function (this: Command) {
      if (this.args.length) this.error(`unknown command '${this.args[0]}'`, { code: 'commander.unknownCommand' })
      await boardless(this, cli, (p) => cmdCloud([], p))
    })

  withShared(account.command('sign-out'))
    .summary('forget it: this machine stops reaching Cloud, and nothing on any board changes')
    .action(async function (this: Command) {
      await boardless(this, cli, (p) => cmdCloud(['sign-out'], p))
    })

  // Options are read in the handler, not required by Commander, so a missing one exits 2.
  withShared(program.command('image'))
    .argument('[prompt...]', 'what to draw')
    .summary('generate an image through Cloud, spending Pro credits')
    .option('--aspect <ratio>', 'the aspect ratio, e.g. 16:9')
    .option('--tier <tier>', 'economy, standard (default) or premium; a higher tier costs more credits')
    .option('--ref <file>', 'a PNG, JPEG or WebP to draw from; repeat for more', (v: string, all: string[]) => [...all, v], [])
    .option('--out <file>', 'where to write the image')
    .action(async function (this: Command, prompt: string[]) {
      const o = this.opts() as { aspect?: string; tier?: string; ref: string[]; out?: string }
      await boardless(this, cli, (p) =>
        cloudImage({ aspect: o.aspect, tier: o.tier, refs: o.ref, out: o.out, prompt: prompt.join(' ') }, p),
      )
    })

  withShared(program.command('tts'))
    .argument('[text...]', 'what to say')
    .summary('generate narration in a hosted voice, spending Pro credits')
    .option('--voice <name>', 'a hosted voice')
    .option('--tier <tier>', 'standard (default) for drafts and samples, premium for the final video')
    .option('--out <file>', 'where to write the audio; a Chinese voice writes .mp3')
    .action(async function (this: Command, text: string[]) {
      const o = this.opts() as { voice?: string; tier?: string; out?: string }
      await boardless(this, cli, (p) => cloudTts({ voice: o.voice, tier: o.tier, out: o.out, text: text.join(' ') }, p))
    })

  withShared(program.command('music'))
    .argument('[prompt...]', 'the music to make')
    .summary('generate an instrumental track through Cloud, spending Pro credits')
    .option('--seconds <n>', 'how long the track runs')
    .option('--out <file>', 'where to write the audio')
    .action(async function (this: Command, prompt: string[]) {
      const o = this.opts() as { seconds?: string; out?: string }
      await boardless(this, cli, (p) =>
        cloudMusic({ seconds: o.seconds, out: o.out, prompt: prompt.join(' ') }, p),
      )
    })

  withShared(program.command('transcribe'))
    .argument('<media>', 'the local video or audio file')
    .summary('transcribe an audio stream in a Runner task')
    .option('--audio-stream <index>', 'zero-based audio stream index, required when there are multiple streams')
    .option('--language <code>', 'language hint or auto (default)')
    .requiredOption('--out <file>', 'where to write the JSON transcript')
    .requiredOption('--vtt <file>', 'where to write the WebVTT captions')
    .action(async function (this: Command, media: string) {
      const options = this.opts() as Parameters<typeof cmdTranscribe>[1]
      await boardless(this, cli, () => cmdTranscribe(media, options, cli.cwd))
    })

  // The shared template catalog (#1708). Options are read in the handlers, so a missing one exits 2.
  const template = withShared(program.command('template'))
    .summary('the shared UI and video template catalog')
    .action(function (this: Command) {
      this.help()
    })

  withShared(template.command('list-tags'))
    .summary("a category's tags, with how many templates carry each")
    .option('--category <category>', 'ui, video, …')
    .action(async function (this: Command) {
      await boardless(this, cli, (p) => templateTags(this.opts() as { category?: string }, p))
    })

  withShared(template.command('search'))
    .argument('[words...]', 'topic words that rank the matches')
    .summary('templates carrying a tag: metadata only, 5 by default, at most 10')
    .option('--category <category>', 'ui, video, …')
    .option('--tags <tags>', 'comma-separated tags')
    .option('--limit <n>', 'how many, at most 10')
    .action(async function (this: Command, words: string[]) {
      const o = this.opts() as { category?: string; tags?: string; limit?: string }
      await boardless(this, cli, (p) => templateSearch({ ...o, words }, p))
    })

  withShared(template.command('preview'))
    .argument('<name>', 'the template')
    .summary("download a template's catalog previews, as <name>-<file> unless already so named")
    .option('--to <dir>', 'the folder to write them into')
    .action(async function (this: Command, name: string) {
      await boardless(this, cli, (p) => templatePreview(name, this.opts() as { to?: string }, p))
    })

  withShared(template.command('get'))
    .argument('<name>', 'the template')
    .summary('download every file of a template, checked against the catalog')
    .option('--to <dir>', 'the folder to write it into; existing files are never overwritten')
    .action(async function (this: Command, name: string) {
      await boardless(this, cli, (p) => templateGet(name, this.opts() as { to?: string }, p))
    })

  withShared(template.command('source'))
    .argument('<name>', 'the template')
    .summary("where a template came from, and the evidence captured at the time")
    .option('--to <dir>', 'download the evidence into this folder')
    .action(async function (this: Command, name: string) {
      await boardless(this, cli, () => templateSource(name, this.opts() as { to?: string }))
    })

  withShared(template.command('publish'))
    .argument('<dir>', "the template's folder, holding template.md")
    .summary('publish a template (maintainers only)')
    .option('--preview <file>', 'a catalog preview image, kept outside the folder; repeat for more', (v: string, all: string[]) => [...all, v], [])
    .option('--evidence <file>', "a capture of the reference, kept outside the folder; repeat for more", (v: string, all: string[]) => [...all, v], [])
    .option('--replace', 'replace the template already published under this name')
    .action(async function (this: Command, dir: string) {
      const o = this.opts() as { preview: string[]; evidence: string[]; replace?: boolean }
      await boardless(this, cli, () => templatePublish(dir, o))
    })

  withShared(template.command('showcase'))
    .argument('<name>', 'the published template')
    .argument('<dir>', 'a folder holding showcase.json and the files it names')
    .summary("set what wildcrane.ai/templates shows for a template (maintainers only)")
    .action(async function (this: Command, name: string, dir: string) {
      await boardless(this, cli, () => templateShowcase(name, dir))
    })

  withShared(template.command('delete'))
    .argument('<name>', 'the template')
    .summary('take a template out of the catalog (maintainers only)')
    .action(async function (this: Command, name: string) {
      await boardless(this, cli, () => templateDelete(name))
    })

  const tools = withShared(program.command('agent')).summary('the AI tools on this MACHINE')
  // `check` is the only word here; the rest of `agent` moved under `raw` (#551).
  tools.allowExcessArguments().allowUnknownOption().action(function (this: Command) {
    if (!this.args.length) this.help()
    this.error(`unknown command '${this.args[0]}'`, { code: 'commander.unknownCommand' })
  })
  withShared(tools.command('check'))
    .summary('whether WildCrane can run an agent here, and what is missing; exits 1 until it can')
    .argument('<agent>', HARNESSES.map((h) => h.name).join(', '))
    .action(async function (this: Command, agent: string) {
      await boardless(this, cli, () => cmdAgentCheck(agent))
    })

  // ---- optional usage reporting ---------------------------------------------

  const telemetry = withShared(program.command('telemetry'))
    .summary('whether this MACHINE reports anonymous usage')
    .description(
      'On unless it is turned off, for the app and for every `akb` on this machine — one answer, held ' +
        'outside every repository like the Cloud sign-in. The app asks once in an onboarding step; this ' +
        'never prompts, so a terminal-only user turns it off here. What is sent, and how to have it ' +
        'deleted: https://wildcrane.ai/privacy',
    )
    .action(async function (this: Command) {
      await boardless(this, cli, (p) => cmdTelemetry([], p))
    })

  for (const move of ['status', 'on', 'off'] as const) {
    withShared(telemetry.command(move))
      .summary(
        move === 'status'
          ? 'what this machine reports, and the install id its reports carry'
          : `turn reporting ${move}`,
      )
      .action(async function (this: Command) {
        await boardless(this, cli, (p) => cmdTelemetry([move], p))
      })
  }

  // ---- the studios a card runs through (#715) -----------------------------

  const studio = withShared(program.command('studio'))
    .summary('the Studios this board can use')
    .description(
      'Every card runs through one studio, kept in Cloud: the built-ins and the studios this ' +
        'workspace installed or made. To change one of this workspace\'s own: `pull` it into a folder, ' +
        'edit, `push`. New tasks take the new version; a task already started keeps its own. ' +
        '`akb guide update-studio` has the whole flow.',
    )
    .allowExcessArguments()
    .allowUnknownOption()
    .action(async function (this: Command) {
      const word = this.args[0]
      if (word === 'diagram') {
        this.error(`Freeze a Studio draft with \`${cli.program} studio preview <card> --folder <draft> --base <baseline>\`.`, { code: 'commander.unknownCommand' })
      }
      if (word) this.error(`unknown command '${word}'`, { code: 'commander.unknownCommand' })
      await studioList(this, cli)
    })

  const flowWord = (name: string) => withShared(studio.command(name))

  flowWord('list')
    .summary('every Studio this workspace can run and its Preview outputs. Offline, the ones downloaded before, marked (offline).')
    .action(async function (this: Command) {
      await studioList(this, cli)
    })

  flowWord('pull')
    .argument('<id>', 'the studio, from `studio list`')
    .argument('[folder]', 'where to write it, empty or new; default ./<id>')
    .summary('write the studio\'s current version into a folder to edit')
    .action(async function (this: Command, id: string, folder?: string) {
      await onBoard(this, cli, () => cmdStudioPull(id, folder), true)
    })

  flowWord('clone')
    .argument('<id>', 'the studio, from `studio list`')
    .argument('<folder>', 'where to write the draft, empty or new')
    .option('--name <name>', 'the draft name; defaults to the source name with a copy suffix')
    .summary('write an independent local draft from a Studio')
    .action(async function (this: Command, id: string, folder: string) {
      await onBoard(this, cli, () => cmdStudioClone(id, folder, this.opts().name), true)
    })

  flowWord('create')
    .argument('<folder>', 'the studio files to create')
    .requiredOption('--request-id <id>', 'the publication request, reused on retry')
    .option('--workspace <id>', 'the target workspace; otherwise use the linked project')
    .summary('create a workspace studio from a local folder')
    .action(async function (this: Command, folder: string) {
      if (this.opts().workspace) await boardless(this, cli, () => cmdStudioCreate(folder, this.opts()))
      else await onBoard(this, cli, () => cmdStudioCreate(folder, this.opts()))
    })

  flowWord('push')
    .argument('<folder>', 'a folder `studio pull` wrote')
    .option('--request-id <id>', 'reuse this publication request after a timeout')
    .option('--dry-run', 'check the folder and print what would happen, saving nothing')
    .summary('save the edited folder as the studio\'s next version, which new tasks take')
    .action(async function (this: Command, folder: string) {
      await boardless(this, cli, () => cmdStudioPush(folder, this.opts()))
    })

  flowWord('rule')
    .argument('<studio>', 'a studio id from `akb studio list`')
    .option('--text <text>', 'configuration for a one-liner; empty clears it')
    .option('--file <path>', 'configuration as Markdown')
    .option('--revision <n>', 'the revision read before editing')
    .summary("read or save a studio's shared configuration")
    .description(
      "Without --text or --file, reads the Studio configuration. With them, saves it for all projects " +
        'in the workspace. Pass the revision from the read with --revision when editing.',
    )
    .action(async function (this: Command, id: string) {
      await onBoard(this, cli, () => cmdStudioRule(id, this.opts()))
    })

  flowWord('instructions')
    .argument('<agent>', 'a project background task; invalid names list the choices')
    .option('--text <text>', 'the instructions, for a one-liner; empty clears them')
    .option('--file <path>', 'the instructions, as markdown written to a file first')
    .summary("read or set a project background task's instructions")
    .description(
      "Without --text or --file, prints the agent's current instructions. With them, replaces all of them. " +
        "Saved to Cloud for this project; empty clears them. Studio and Preview names are not background tasks.",
    )
    .action(async function (this: Command, agent: string) {
      await onBoard(this, cli, () => cmdStudioInstructions(agent, this.opts()))
    })

  withShared(program.command('guide'))
    .argument('[topic]', 'one flow in full; left off, every flow is listed one line each')
    .summary('the flows the board works by, shipped with this command')
    .description(
      'A printed flow already carries the flows its action is done by, so this is for the rest: how the ' +
        'board works at all, the module map, updating, the local UI. `guide board` is the card ' +
        'format, the layout and the memory set.',
    )
    .action(async function (this: Command, ...vals: unknown[]) {
      const [topic] = positional(vals) as [string | undefined]
      const ctx = ctxOf(this, cli.program)
      try {
        useBoard(resolveBoard('guide', { board: ctx.board, dir: ctx.dir, cwd: cli.cwd, installHint: cli.installHint }), ctx.dir !== null)
      } catch {
        // No board here, or a half-made one. The shipped text still reads.
      }
      await boardless(this, cli, (p) => cmdGuide(topic, p))
    })

  declareLocalRuns(program, cli, { task, studio })

  // The watcher's own door. Not a command anyone types — `akb raw card implement 12` spawns it — and
  // spelled so it can never be mistaken for one.
  program
    .command('__watch', { hidden: true })
    .argument('<sessionId>')
    .action(async function (this: Command, sessionId: string) {
      const ctx = ctxOf(this, cli.program)
      const found = resolveBoard('runs', { board: ctx.board, dir: ctx.dir, cwd: cli.cwd, installHint: cli.installHint })
      useBoard(found, ctx.dir !== null)
      // The watcher runs for as long as the agent does, writes its own log, and says nothing
      // to anyone. It never collects prose and never answers in JSON.
      const code = await cmdWatch(sessionId)
      if (code !== 0) throw new BoardError(`the watcher for ${sessionId} ended with ${code}`, { kind: 'watch-failed' })
    })
}

const RUN_ID = "a run's id, any prefix of one that names only one run, or `last`. Left out, it means the newest run"
const DELIVERY = 'the delivery, or the card it is on'

// ---- akb raw card run <verb> -------------------------------------------------------------------

/** The agent processes: what is going, what went, and steering one. */
function declareRunning(run: Command, cli: AgentCliOptions, canonical: boolean): void {
  const verb = (name: string) => withShared(run.command(name))

  verb('list')
    .summary('what is running, and what ran lately')
    .description('A creation run with no card fails even if the agent exits with code 0. Failure reason, triage source and cost are kept. In JSON the run reports status: error and ok: false; the outer ok describes this query. A successful query exits with code 0.')
    .option('-c, --card <id>', 'only the runs on that card', cardId)
    .option('-a, --all', 'every run this board has kept, not just the last ten')
    .action(async function (this: Command) {
      await onBoard(this, cli, (p) => cmdRuns(this.opts(), p))
    })

  verb('start')
    .argument('[prompt...]', 'what the sub-run should do')
    .summary('start a sub-run of the run you are inside, and return its id')
    .description(
      'Only an agent inside a run can, and a sub-run cannot start its own. It works in the same folder as the ' +
        'same agent, has its own log and cost, and is stopped when its parent ends.',
    )
    .option('--runtime <id>', "the runtime it runs on (default: the parent's)")
    .option('--file <path>', 'read the prompt from this file')
    .action(async function (this: Command, ...vals: unknown[]) {
      const [words] = positional(vals) as [string[]]
      await onBoard(this, cli, () => cmdSubStart(words ?? [], this.opts()))
    })

  verb('wait')
    .argument('[id...]', "sub-runs of the run you are inside; left out, all of them")
    .summary("wait up to 90 seconds for this run's sub-runs to end")
    .description('Each one that ended is given with its status and last message; the ones still running are listed. Call it again until none are.')
    .action(async function (this: Command, ...vals: unknown[]) {
      const [ids] = positional(vals) as [string[]]
      await onBoard(this, cli, () => cmdSubWait(ids ?? []))
    })

  verb('log')
    .argument('[id]', RUN_ID, String)
    .summary("one run's log")
    .description('Shows the failure reason, any triage source and recorded cost. A creation run with no card fails even if the agent exits with code 0. Non-following queries exit with code 0; following a failed run exits with code 1. Example: akb run log abc12345 --follow')
    .option('-f, --follow', 'keep printing it until the run ends')
    .option('--events', 'with --follow: print its structured events, one JSON object per line')
    .option('--full', 'all of it, rather than the tail')
    .action(async function (this: Command, ...vals: unknown[]) {
      const [id] = positional(vals) as [string | undefined]
      await onBoard(this, cli, (p) => cmdLog(id, this.opts(), p))
    })

  verb('stop')
    .argument('[id]', RUN_ID, String)
    .summary('end a run')
    .description('Its half-finished edits are left in the working tree — the board never undoes work.')
    .action(async function (this: Command, ...vals: unknown[]) {
      const [id] = positional(vals) as [string | undefined]
      await onBoard(this, cli, () => cmdStop(id))
    })

  verb('resume')
    .argument('[id]', RUN_ID, String)
    .summary('continue a run from its saved work')
    .description('Continue the saved session. Use --fresh to explicitly take over saved work when the original session is unavailable.')
    .option('-f, --follow', 'watch its log instead of returning')
    .option('--events', 'with --follow: print its structured events, one JSON object per line')
    .option('--fresh', 'explicitly take over saved work in a new session')
    .addOption(new Option('--require-session', 'require the original session').hideHelp(canonical))
    .action(async function (this: Command, ...vals: unknown[]) {
      const [id] = positional(vals) as [string | undefined]
      await onBoard(this, cli, () => cmdResume(id, this.opts()))
    })
}

// ---- akb raw delivery <verb> --------------------------------------------------------------

/** What you do to a build in flight, or to one that stopped. `conflict` is a flow and is
 *  declared with the rest of them; these start nothing. */
function declareDelivery(delivery: Command, cli: AgentCliOptions, canonical: boolean): void {
  const verb = (name: string, internal = false) => withShared(delivery.command(name, { hidden: canonical && internal }))

  verb('complete')
    .argument('<delivery>', DELIVERY)
    .summary('record the current step result and finish its handoff')
    .option('--commit <sha>', 'the full landed commit hash')
    .option('--branch <name>', 'the target branch containing that commit')
    .action(async function (this: Command, named: string) {
      await onBoard(this, cli, () => cmdCompleteDelivery(named, this.opts()))
    })

  verb('answered')
    .argument('<delivery>', DELIVERY)
    .summary('say what a round of applied answers did to its requirements')
    .description(
      'Written by the run that put the answers on the card, before it drops the questions — it read both the ' +
        'question and what it wrote, so it is the one thing that can tell a confirmation from a change. The ' +
        'delivery reads this and never the card’s text. Exactly one of ' +
        'the two flags, each with its own one-line reason.',
    )
    .addOption(
      new Option('--unchanged <why>', 'nothing it was approved to build moved — the delivery carries on').conflicts(
        'changed',
      ),
    )
    .option('--changed <why>', 'a requirement was added, dropped or changed — the board reopens it on the new card')
    .action(async function (this: Command, ...vals: unknown[]) {
      const [named] = positional(vals) as [string]
      await onBoard(this, cli, () => cmdAnswered(named, this.opts()))
    })

  verb('cancel')
    .argument('<delivery>', DELIVERY)
    .summary('end it and hand the card back')
    .description(
      'Cancelling ends the delivery and preserves its files, branch and directory. To pause, stop its ' +
        'run — the delivery stays, and `resume` carries it on.',
    )
    .action(async function (this: Command, ...vals: unknown[]) {
      const [named] = positional(vals) as [string]
      await onBoard(this, cli, () => cmdCancel(named))
    })

  verb('resume')
    .argument('<delivery>', DELIVERY)
    .summary('carry one on that stopped short, from where it stopped')
    .description(
      'Its worktree, branch and approved requirements all stay as they are — finished steps are ' +
        'never redone. The executing agent inspects existing results and completes the ' +
        'remaining steps.',
    )
    .action(async function (this: Command, ...vals: unknown[]) {
      const [named] = positional(vals) as [string]
      await onBoard(this, cli, () => cmdResumeDelivery(named))
    })

  verb('reconcile', true)
    .argument('<card>', 'card number', cardId)
    .summary('reconcile local delivery state for a card before recovery')
    .action(async function (this: Command, ...vals: unknown[]) {
      const [id] = positional(vals) as [number]
      await onBoard(this, cli, () => cmdReconcileDelivery(id))
    })

  verb('release', true)
    .argument('<card>', 'card number', cardId)
    .summary('safely release an active delivery write lock while preserving saved work')
    .action(async function (this: Command, ...vals: unknown[]) {
      const [id] = positional(vals) as [number]
      await onBoard(this, cli, () => cmdReleaseDelivery(id))
    })


}

// ---- one flow -----------------------------------------------------------------------

// Every flow is the same command with a different name: what it takes comes off the flow's
// own entry, and `--print` and `--follow` are added to all of them. It is declared onto the
// noun it acts on (`parent`), or onto `akb` itself when it acts on nothing yet.
function declareFlow(parent: Command, flow: Flow, cli: AgentCliOptions, canonical: boolean): void {
  // A `delivery` verb answers to the delivery as well as to the card it is on, so the id is
  // taken as written and read once the board is open — before that there is no record to
  // look a delivery up in. What it is read INTO is the delivery itself (#428): a build with
  // no card has no id to be resolved to, and a carded one is found by its delivery just the
  // same.
  const byDelivery = flow.group === 'delivery'
  const cmd = withShared(parent.command(flowVerb(flow), { hidden: canonical && flow.action === 'prune-memory' }))
  for (const arg of splitArgs(flow.argument)) {
    cmd.argument(arg, argNote(arg, flow), arg.startsWith('<id') ? (byDelivery ? String : cardId) : undefined)
  }
  cmd.summary(flow.gloss)
  if (flow.more?.length) cmd.description(`${sentence(flow.gloss)} ${flow.more.join(' ')}`)
  for (const option of flow.options ?? []) addFlowOption(cmd, option, canonical && option.internal === true)
  const showPrint = !canonical || flow.group === 'card'
  cmd
    .addOption(new Option('-p, --print', 'say what to do and start nothing').conflicts('follow').hideHelp(!showPrint))
    .addOption(new Option('-f, --follow', 'watch the log instead of returning').hideHelp(canonical))
    .addOption(new Option('--events', 'with --follow: print its structured events, one JSON object per line').hideHelp(canonical))
    .addHelpText('after', showPrint ? PRINT_FLOW_HELP : '')
    .action(async function (this: Command, ...vals: unknown[]) {
      const args = positional(vals)
      await onBoard(this, cli, (p) =>
        cmdStartRun(flow.action, byDelivery ? [deliveryOf(args[0] as string), ...args.slice(1)] : args, this.opts(), p),
      )
    })
}

/** The delivery a `delivery` verb was aimed at — named by its own id, by a prefix of one, or
 *  by the card it is on. The run carries the delivery from here, so a build with no card
 *  (#428) reaches its conflict run exactly as a carded one does. */
function deliveryOf(named: string): DeliveryRecord {
  const delivery = namedDelivery(named)
  if (!delivery) throw new BoardError(`no delivery here answers to "${named}"`, { kind: 'unknown-delivery' })
  return delivery
}

function addFlowOption(cmd: Command, option: FlowOption, hidden: boolean): void {
  const declared = new Option(option.flags, option.description).hideHelp(hidden)
  if (option.choices) declared.argParser(oneOf(option.choices))
  if (option.range) declared.argParser(intInRange(option.range[0], option.range[1]))
  cmd.addOption(declared)
}

// `<id> [note...]` → `['<id>', '[note...]']`. A flow's argument line is written in
// Commander's own notation, so this only has to split it.
const splitArgs = (argument: string): string[] => (argument ? argument.split(/\s+/) : [])

function argNote(arg: string, flow: Flow): string {
  if (arg.startsWith('<id')) return flow.group === 'delivery' ? DELIVERY : "the card's id"
  return flow.argumentNote ?? ''
}

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`)

// ---- the connectors, and which one each agent runs -------------------------------------

function declareAgent(program: Command, cli: AgentCliOptions): void {
  const agent = withShared(program.command('agent'))
    .summary('what runs the board, and how it is set up')
    .description(
      'A RUNTIME is the whole answer to what a run runs as — harness, provider, endpoint, key, model id, ' +
        "reasoning and extra arguments. Every runtime's shape is YOURS, in the board's ui.config.json under " +
        ".akb/boards/; its key is one line per runtime in docs/kanban/.env. git carries neither. A run never " +
        "reads the terminal's environment for any of it.",
    )
    .allowExcessArguments()
    .action(async function (this: Command) {
      if (this.args.length) this.error(`unknown command '${this.args[0]}'`, { code: 'commander.unknownCommand' })
      await onBoard(this, cli, () => cmdAgent(['show']))
    })

  const word = (name: string) => withShared(agent.command(name))

  word('use')
    .argument('<name>', 'a harness, e.g. claude-code')
    .summary('the harness Global default runs')
    .description(
      'Global default is the first runtime, and what an agent naming none runs. Every other runtime is ' +
        'untouched.',
    )
    .action(async function (this: Command, name: string) {
      await onBoard(this, cli, () => cmdAgent(['use', name]))
    })

  word('set')
    .argument('<key>', 'a setting the runtime’s harness takes — `agent` lists them')
    .argument('[value...]', 'the value; left off, the setting is cleared and the CLI’s own default runs')
    .option('--runtime <id>', 'which runtime to write; left off, Global default')
    .option('--agent <name>', 'the runtime that agent runs, instead of naming an id')
    .summary('one runtime setting, or its key')
    .description(
      'A key goes to docs/kanban/.env under that runtime’s own line, and is never echoed back: give the ' +
        'user the line and let them type it — a key an agent types lands in its transcript and in the ' +
        'shell history. Everything else is the board’s, on the row.',
    )
    .action(async function (this: Command, key: string, value: string[]) {
      const { agent: named, runtime: id } = this.opts<{ agent?: string; runtime?: string }>()
      await onBoard(this, cli, () =>
        cmdAgent([
          'set',
          ...(id ? ['--runtime', id] : []),
          ...(named ? ['--agent', named] : []),
          key,
          ...value,
        ]),
      )
    })

  withShared(agent.command('picks', { hidden: true }))
    .argument('<json>', 'runtime picks by studio agent')
    .action(async function (this: Command, json: string) {
      await onBoard(this, cli, () => cmdAgent(['picks', json]))
    })

  // Accept commands from older callers without starting a Studio role.
  withShared(agent.command('run', { hidden: true }))
    .argument('<studio>')
    .argument('<agent>')
    .option('-p, --print')
    .option('-f, --follow')
    .option('--events')
    .action(async function (this: Command) {
      await boardless(this, cli, () => die('Studio roles no longer run on their own.', 'run-refused'))
    })
}
