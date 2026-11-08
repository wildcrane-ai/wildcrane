// `akb` — the whole command, in one tree.
//
// Setting a project up and starting runs on it used to be two dispatchers, because they
// lived in two files that could not see each other: `bin/ai4kanban.mjs` had no way to reach
// the built rules' own parsing, so it kept a second one. They are one program now, so
// `akb help` is every word the command answers to rather than half of them.
//
// `akb` is Cloud and a few tools (./agent.ts `declareRuns`, ./setup.ts). The local board and
// in-run commands are `akb raw` (./board.ts), a tree of its own: its moves take options that
// collide with these, so the loader hands that whole command line over and this one never sees it.

import { declareRuns } from './agent'
import { declareSetup } from './setup'
import { BoardError } from '../io'
import { newCommand, withShared, type Command } from './shared'

export interface AkbCliOptions {
  /** How this command was reached, spelled so what it prints can be pasted straight back. */
  program: string
  cwd: string
  installHint: string
}

export function buildAkbProgram(cli: AkbCliOptions): Command {
  const program = withShared(newCommand(cli.program))
  program
    .description('set up a board, and put an agent to work on it.')
    .helpCommand('help [command]', 'this list, or one command in full')

  declareSetup(program, cli)
  declareRuns(program, cli)

  // Named so it is in the list and `akb help raw` says what it is. The loader routes the
  // word to the board's own tree before this one is asked, so the action is only ever
  // reached when that routing has gone wrong.
  program
    .command('raw')
    .argument('[move...]')
    .summary('the local board, and the commands an agent uses inside a run')
    .description(`Every move: \`${cli.program} raw help\`. A person never has to type one.`)
    .action(function () {
      throw new BoardError(`\`${cli.program} raw\` is a tree of its own — this command line never reached it.`, {
        kind: 'unreachable',
      })
    })

  return program
}
