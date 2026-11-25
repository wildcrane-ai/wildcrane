// The public command tree. The loader still accepts the legacy board routes.

import { declareRuns } from './agent'
import { declareSetup } from './setup'
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

  return program
}
