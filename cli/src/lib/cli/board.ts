import { insideRun } from '../agent/env'
import { recordCards } from '../agent/created-cards'
import { runAgent } from '../agent/project-agent'
import { BOARD_MOVES, runLocalMove } from '../board/local'
import { BoardError, say } from '../io'
import crypto from 'node:crypto'
import { creationReceipt, readCreation, saveCreation, archiveCreation, creationError, triageFile } from '../agent/creation'
import { peekRun } from '../agent/sessions'
import { KANBAN, REPO_ROOT } from '../paths'
import { resolveBoard, useBoard } from '../board-cli'
import { syncStudios } from '../agent/cloud-studios'
import { LEVELS, STATUSES } from '../validate'
import {
  cardId,
  collect,
  collectList,
  ctxOf,
  newCommand,
  oneOf,
  ordered,
  runAction,
  withShared,
  type Command,
  type Typed,
} from './shared'
import { Option } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
import { creationProject, createProjectTask, linkedProject, createTask, workspaceTask } from '../cloud/tasks'
import { validateCreate, type CreateOptions } from '../../commands/card'
import { declareRaw } from './agent'
import { conflictList, conflictShow } from '../shared/board-conflicts'
import { submitConflict } from '../cloud/board-conflicts'
import { withQuestionOptions } from './question-options'

/** What the door hands in — see `runBoard`. */
export interface BoardCliOptions {
  program: string
  cwd: string
  installHint: string
  version?: string | null
  /** The move's own fields, handed over as it finishes. `--json` already carries them; this
   *  is for a caller that ran the move in-process and wants the value rather than the text. */
  onAnswer?: (data: Record<string, unknown>) => void
}

// Open the board and dispatch the command.
async function dispatch(
  move: string,
  cmd: Command,
  args: string[],
  opts: Record<string, unknown>,
  cli: BoardCliOptions,
): Promise<void> {
  const ctx = ctxOf(cmd, cli.program)
  // `board:` is read INSIDE the work, not beside it: which board this is is only settled by
  // `useBoard` a line below, and a field read before that names the last board this process
  // had open (#407).
  const data = await runAction(ctx, {}, async () => {
    const found = resolveBoard(move, { board: ctx.board, dir: ctx.dir, cwd: cli.cwd, installHint: cli.installHint })
    const conflict = move.startsWith('conflict-')
    useBoard(found, ctx.dir !== null, move === 'inspect' || conflict)
    if (conflict) {
      if (move === 'conflict-list') {
        const conflicts = conflictList(found.board)
        say(conflicts.map(r => `${r.id} ${r.state}: ${r.paths.join(', ')}`).join('\n') || 'No board content conflicts.')
        return { board: found.board, conflicts }
      }
      if (move === 'conflict-show') {
        const conflict = conflictShow(found.board, args[0]!)
        if (!ctx.json) say(JSON.stringify(conflict, null, 2))
        return { board: found.board, conflict }
      }
      let resolution: unknown
      try { resolution = JSON.parse(fs.readFileSync(String(opts.file), 'utf8')) }
      catch { throw new BoardError('Cannot read the UTF-8 JSON resolution file.', { kind: 'invalid-usage' }) }
      const result = await submitConflict(found.board, args[0]!, String(opts.expect), resolution)
      say(`Board conflict ${result.id}: ${result.state}.`)
      return { board: found.board, ...result }
    }
    if (move !== 'inspect') await syncStudios(!workspaceTask() && (move === 'file' || move === 'skills'))
    const root = found.root

    const creating = move === 'create' && insideRun() ? peekRun(insideRun()!) : undefined
    if (creating?.triage) {
      if (opts.triage && opts.triage !== creating.triage) throw new BoardError('Creation must keep its original triage source.', { kind: 'refused' })
      opts = { ...opts, triage: creating.triage }
    }
    const input = { args, opts }
    const inRun = move === 'create' && insideRun() !== null
    const task = move === 'create' && opts.id === undefined ? workspaceTask() : null
    if (move === 'create' && opts.id === undefined) {
      const { studio } = validateCreate(opts as unknown as CreateOptions)
      input.opts = (await cloudCard(task, task ? opts : { ...opts, studio })).opts
    }
    const data = await runLocalMove(move, input)
    const created = move === 'create' && Array.isArray(data.ids) ? data.ids.filter((id): id is number => Number.isInteger(id)) : []
    if (inRun) await recordCards(insideRun()!, created)
    if (move === 'create' && typeof input.opts.triage === 'string' && created[0] !== undefined) archiveCreation(input.opts.triage, created[0])
    return { board: KANBAN, ...data }
  })
  cli.onAnswer?.(data)
}

/** A card made in a Runner workspace is a Cloud task first (#2063): written here under the
 *  task's number, so the board's next push files it as that task's card, and Cloud moves it on
 *  from there (#170). */
async function cloudCard(task: string | null, opts: Record<string, unknown>): Promise<{ opts: Record<string, unknown> }> {
  const run = insideRun() ? peekRun(insideRun()!) : undefined
  const triage = typeof opts.triage === 'string' ? opts.triage : run?.triage
  opts = { ...opts, ...(triage ? { triage } : {}) }
  const sourceFile = triage ? triageFile(triage) : undefined
  let request: string | undefined
  if (typeof opts.bodyFile === 'string') {
    try {
      request = fs.readFileSync(opts.bodyFile, 'utf8')
    } catch {
      // cmdCreate says so below.
    }
  }
  const said = {
    title: String(opts.title ?? '').trim(),
    request,
    studio: typeof opts.studio === 'string' && opts.studio.trim() ? opts.studio.trim() : undefined,
    slug: typeof opts.slug === 'string' ? opts.slug : undefined,
    triage: sourceFile,
    agent: runAgent() ?? undefined,
  }
  if (task) {
    const link = linkedProject(KANBAN, REPO_ROOT)
    if (!link.ok) throw new BoardError(creationError(link.error, triage), { kind: 'refused' })
    if (link.value) {
      const checked = await creationProject(KANBAN, REPO_ROOT, task)
      if (!checked.ok) throw new BoardError(creationError(checked.error, triage), { kind: 'refused' })
    }
    const made = await createTask(task, said)
    if (!made.ok) throw new BoardError(creationError(`Cloud did not make the task: ${made.error}`, triage), { kind: 'refused' })
    return { opts: { ...opts, id: made.value.number, fromTask: made.value.from.key } }
  }
  const checked = await creationProject(KANBAN, REPO_ROOT)
  if (!checked.ok) throw new BoardError(creationError(checked.error, triage), { kind: 'refused' })
  const requestId = triage ? `triage:${triage}` : run?.sessionId ?? crypto.randomUUID()
  const slot = triage ? triage : String(opts.slug ?? opts.title)
  const file = creationReceipt(`${checked.value}:${requestId}`, slot)
  const journal = readCreation(file, said)
  if (!journal.made) {
    const key = `akb-${path.basename(file, '.json').slice(0, 40)}`
    const made = await createProjectTask(checked.value, journal.said, key)
    if (!made.ok) throw new BoardError(creationError(`Cloud did not make the task: ${made.error}`, triage), { kind: 'refused' })
    journal.made = made.value
    saveCreation(file, journal)
  }
  const held = journal.made
  return { opts: { ...opts, title: journal.said.title, slug: journal.said.slug, id: held.number } }
}

// `--recurring` and `--cadence` are retired with the recurring card (#1414).
function refuseRecurring(command: Command): void {
  const { recurring, cadence } = command.opts()
  if (recurring === undefined && cadence === undefined) return
  command.error(
    `error: ${recurring !== undefined ? '--recurring' : '--cadence'} is no longer supported. Configure recurring work in the project’s background task settings.`,
  )
}

const ID = "the card's id"

export function withCreateOptions(command: Command, legacy = false): Command {
  return command
    .addOption(new Option('--title <title>', 'write a local card with a Cloud-assigned number').makeOptionMandatory(legacy))
    .option('--studio <id>', "the Studio from `akb studio list`")
    .option('--priority <level>', `how much it matters: ${LEVELS.join(' | ')} (default: med)`, oneOf(LEVELS))
    .option('--blocked-by <ids>', 'ids of open cards this one waits on', collectList)
    .option('--related <ids>', 'ids of open cards this one relates to', collectList)
    .option('--modules <names>', 'the parts of the project it touches, validated against modules.md', collectList)
    .option('--slug <slug>', 'the filename to write it under (default: from the title)')
    .option('--triage <source-id>', 'the triage item this card is made of')
    .option('--source <ref>', "where it came from: a plan's path, plan:<id>, #<id> or a URL. Repeatable", collect)
}

export async function createBoardCard(command: Command, cli: BoardCliOptions, asked: Typed[] = []): Promise<void> {
  refuseRecurring(command)
  await dispatch('create', command, [], { ...command.opts(), asked }, cli)
}

interface BoardGroups {
  task: Command
  board: Command
  studio: Command
  memory: Command
}

export function declareBoardMoves(program: Command, cli: BoardCliOptions, groups?: BoardGroups): void {
  const move = (name: string, parent = program) => withShared(parent.command(name))
  const conflict = move('conflict', groups?.board).summary('read and explicitly resolve saved board content conflicts')
  withShared(conflict.command('list')).summary('list pending local conflicts without contacting Cloud')
    .action(async function (this: Command) { await dispatch('conflict-list', this, [], this.opts(), cli) })
  withShared(conflict.command('show <id>')).summary('read saved versions and a current read credential')
    .action(async function (this: Command, id: string) { await dispatch('conflict-show', this, [id], this.opts(), cli) })
  withShared(conflict.command('resolve <id>')).summary('submit explicit results for the entire original batch')
    .requiredOption('--expect <revision>', 'the credential just returned by conflict show')
    .requiredOption('--file <path>', 'UTF-8 JSON with each conflicting path and final content; null deletes')
    .action(async function (this: Command, id: string) { await dispatch('conflict-resolve', this, [id], this.opts(), cli) })

  // ---- cards ---------------------------------------------------------------

  const update = move('update', groups?.task)
    .argument('<id>', ID, cardId)
    .summary("rewrite a card's fields")
    .description(
      "Rewrite a card's frontmatter fields. --slug renames it. Body and questions are left " +
        'untouched — those have their own moves.',
    )
    .option('--title <title>', 'what the card is called')
    .option('--priority <level>', LEVELS.join(' | '), oneOf(LEVELS))
    .option('--status <status>', STATUSES.join(' | '), oneOf(STATUSES))
    .option('--blocked-by <ids>', 'ids of open cards this one waits on', collectList)
    .option('--related <ids>', 'ids of open cards this one relates to', collectList)
    .option('--add-blocked-by <ids>', 'append ids to blocked_by, keeping the ids already there', collectList)
    .option('--add-related <ids>', 'append ids to related, keeping the ids already there', collectList)
    .option('--modules <names>', 'the parts of the project it touches', collectList)
    .option('--source <ref>', "where it came from: a plan's path, plan:<id>, #<id> or a URL. Repeatable; \"\" clears the list", collect)
    .option('--add-source <ref>', 'append one source, keeping the ones already there. Repeatable', collect)
    .option('--slug <slug>', 'rename the file')
    .option('--studio <id>', 'the studio it runs through. The card goes back to todo and is re-planned')
    .addOption(new Option('--cadence <cadence>').hideHelp())
    .action(async function (this: Command, id: number) {
      refuseRecurring(this)
      await dispatch('update', this, [String(id)], this.opts(), cli)
    })

  if (!groups) update.option('--previews <ids>', 'the Preview IDs chosen from its Studio; "" chooses none', collectList)

  move('inspect', groups?.task)
    .argument('<id>', ID, cardId)
    .summary('read task facts, saved work and execution references')
    .action(async function (this: Command, id: number) {
      await dispatch('inspect', this, [String(id)], this.opts(), cli)
    })

  move('validate', groups?.task)
    .argument('[id]', ID, cardId)
    .summary('validate card format and report file, line, and repair instructions')
    .description('Check every open card, or all copies of a card when an id is given. Reads only; exits non-zero with detailed errors until the format is valid.')
    .action(async function (this: Command, id?: number) {
      await dispatch('validate', this, id === undefined ? [] : [String(id)], this.opts(), cli)
    })

  move('file', groups?.studio)
    .argument('<studio>', 'the studio, e.g. blog-post')
    .argument('<path>', 'the path inside the Studio folder')
    .summary('print one file of a studio')
    .description("In a task's run, reads the version the task is pinned to; otherwise the current one.")
    .action(async function (this: Command, studio: string, file: string) {
      await dispatch('file', this, [studio, file], this.opts(), cli)
    })

  move('skills', groups?.studio)
    .argument('<studio>', 'the Studio, e.g. blog-post')
    .summary('list the Studio’s skill names and descriptions')
    .description("In a task's run, reads the execution's Studio version.")
    .action(async function (this: Command, studio: string) {
      await dispatch('skills', this, [studio], this.opts(), cli)
    })

  move(groups ? 'file' : 'memory-file', groups?.memory)
    .argument('<name>', 'the global memory')
    .summary("print one global memory's rules, its MEMORY.md")
    .description(
      "A run is told which global memories its agent keeps and reads one's rules when the work calls for it. " +
        "A built-in memory's rules ship inside the command, so this is the only way to open them.",
    )
    .action(async function (this: Command, name: string) {
      await dispatch('memory-file', this, [name], this.opts(), cli)
    })

  move('list', groups?.board)
    .summary('the open cards: id, title, meta, summary, path — or, with --archived, the cards that landed')
    .description(
      'The open cards at a glance — one block per card with its id, title, meta (status, priority, ' +
        'blockers, open questions), summary line and file path.\n\n' +
        "`--stale` asks the other question: which cards have sat untouched past the board's **Stale after** " +
        'setting (config.md, 30 days by default), stalest first, each with the days it has sat and what is ' +
        'holding it — a blocker, an unanswered question, or a build. Age is the date git last saw ' +
        "the card's file; group roots and cards git cannot date are left out.\n\n" +
        '`--archived` answers "which cards landed in this period": one block per landing, oldest first, with ' +
        'the card id, title, studio, landing time, landed commit and the archived card file (blank when ' +
        "the file is no longer in .archive/, e.g. deleted by hand; a card the daily cleanup deletes goes " +
        'with its finished delivery and is not listed). Only cards the board landed are listed — a card archived by hand, ' +
        'committed by hand, or built by a studio that leaves files instead of a commit is not among them.',
    )
    .option('-m, --module <name>', 'only the cards tagged with that module, validated against modules.md')
    .option('--stale', 'only the cards untouched past the threshold, stalest first, with the days each has sat')
    .option('--archived', 'the cards that landed and were archived, oldest first, each with its landed commit')
    .option(
      '--since <time>',
      'with --archived: only landings after this time, written "YYYY-MM-DD HH:MM"',
    )
    .option('--studio <id>', 'with --archived: only the cards of that studio')
    .action(async function (this: Command) {
      await dispatch('list', this, [], this.opts(), cli)
    })
}

/** Build the whole tree. Fresh per call: the ordered-option accumulators below belong to
 *  one command line, not to the process. */
export function buildBoardProgram(cli: BoardCliOptions): Command {
  const program = withShared(newCommand(cli.program))
  program
    .description(
      "the local board and the commands an agent uses inside a run; a person never has to type one. " +
        "They own a card's frontmatter — write and edit only a card's body.",
    )
    .helpCommand('help [move]', 'this list, or one move in full')

  const move = (name: string) => withShared(program.command(name))

  declareBoardMoves(program, cli)

  const asked: Typed[] = []
  const inOrder = ordered(asked)
  withCreateOptions(move('create'), true)
    .summary('write exactly one card — its fields, its body template and its index entry')
    .description(
      'Write exactly ONE card: allocate its id, write its frontmatter and a body template, and index it. ' +
        'There is no separate id-reservation mode. --blocked-by and --related take ids of existing open ' +
        'cards; for a group, create the root first, then create each subtask related to its id (see ' +
        '"Group tasks" in `akb guide add-task`). The script owns the frontmatter and writes the body ' +
        'scaffold; fill only the body by hand. ' +
        'Without --id, Cloud assigns the number in the linked project (no source task required). ' +
        'A failed local write can resume the same creation without making another Cloud task. ' +
        'Missing or invalid project links and denied access exit with code 1 using the existing error envelope. ' +
        '--body-file accepts a short draft or full card body. Invalid bodies fail before allocating a task or writing a card, with repair instructions. Cloud moves the card on by itself once ' +
        'it reaches the board: do not refine it here. ' +
        'Example: akb raw create --title "Add a delete command" --studio coding --body-file /tmp/delete-command.md',
    )
    .addOption(new Option('--recurring').hideHelp())
    .addOption(new Option('--cadence <cadence>').hideHelp())
    .option('--question <text>', 'an open question; needs its --option choices', inOrder('question'))
    .option('--option <text>', 'a choice for the preceding --question', inOrder('option'))
    .option('--recommended-option <text>', 'a choice ticked to start', inOrder('recommended-option'))
    .option('--mode <mode>', 'single or multi', inOrder('mode'))
    .option('--no-body', 'write only the frontmatter')
    .option('--body-file <path>', 'read a draft or full card body from a file')
    .option('--previews <ids>', 'the Preview IDs from its Studio', collectList)
    .addOption(new Option('--id <n>', "the number Cloud gave this card's task; for the Runner").argParser(cardId).hideHelp())
    .action(async function (this: Command) { await createBoardCard(this, cli, asked) })

  const questionOps: Typed[] = []
  withQuestionOptions(withShared(program.command('update-questions', { hidden: true }))
    .argument('<id>', ID, cardId)
    .summary('edit open questions on a local card (compatibility)')
    .description('For older Runner instructions. Use akb task update-questions.\nSee akb guide update-questions.'), questionOps)
    .action(async function (this: Command, id: number) {
      await dispatch('update-questions', this, [String(id)], { ops: questionOps }, cli)
    })

  // Before #656; a project agent's files are still read through it.
  withShared(program.command('agent-file', { hidden: true }))
    .argument('<agent>')
    .argument('<path>')
    .action(async function (this: Command, agent: string, file: string) {
      await dispatch('agent-file', this, [agent, file], this.opts(), cli)
    })

  move('reject')
    .argument('<id>', ID, cardId)
    .summary('legacy local removal; use task remove')
    .description('Use akb task remove to remove the current task or a Cloud task. This compatibility command always removes a card from the local board.')
    .option('--discard', 'just drop it: nothing learns from it')
    .option('--reason <text>', 'why, kept on the archived card as `rejected_reason` and shown on its page')
    .action(async function (this: Command, id: number) {
      await dispatch('reject', this, [String(id)], this.opts(), cli)
    })

  // ---- the board itself ----------------------------------------------------

  move('init')
    .summary('scaffold docs/kanban/; on an existing board add only what is missing')
    .description(
      "Scaffold the board — the folders, the board's own memory in memory/ with the planner's beside it, and a blank config.md. " +
        'On an existing board it only adds the files that are missing, so it is safe to ' +
        're-run and is the repair step for a board written by an older version.',
    )
    .action(async function (this: Command) {
      await dispatch('init', this, [], this.opts(), cli)
    })

  // `version` answers without a board, because it is about the command rather than a
  // project. The skill folder's door carries no version of its own and says so.
  program
    .command('version')
    .summary('print the installed version')
    .action(function () {
      if (!cli.version) {
        throw new BoardError(`\`${cli.program}\` has no version move — \`akb --version\` prints it.`, {
          kind: 'unknown-move',
          move: 'version',
        })
      }
      say(cli.version)
    })
  if (cli.version) program.version(cli.version, '-v, --version', 'print the installed version')

  declareRaw(program, { program: cli.program.replace(/ raw$/, ''), cwd: cli.cwd, installHint: cli.installHint })

  assertEveryMoveDeclared(program)
  return program
}

// Every move the board answers to has a command above. A name that does not is a bug here
// rather than a command line someone typed, so it fails on the first build that has one.
function assertEveryMoveDeclared(program: Command): void {
  const declared = new Set(program.commands.flatMap((c) => [c.name(), ...c.aliases()]))
  const missing = [...BOARD_MOVES].filter((name) => !declared.has(name))
  if (missing.length) throw new Error(`board moves with no command declared: ${missing.join(', ')}`)
}
