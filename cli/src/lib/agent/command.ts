import fs from 'node:fs'
import path from 'node:path'

import { pathLookup } from './installed'
import { SELF } from './launch'
import { BOARD_FLAG, REPO_ROOT, shellWord } from '../paths'

/** Use this build when invoked by path, or when an agent has no installed command. */
export function boardCommand(): string {
  const configured = process.env.AI4KANBAN_COMMAND?.trim()
  const entry = path.basename(process.argv[1] ?? '')
  const byPath = entry === 'kanban.mjs' || entry === 'ai4kanban.mjs'
  const bin = path.resolve(path.dirname(SELF), '..', 'bin', 'ai4kanban.mjs')
  const file = fs.existsSync(bin) ? bin : SELF
  const program = configured || (!byPath && pathLookup()('akb') ? 'akb' : `node ${shellWord(file)}`)
  return program + (BOARD_FLAG || ` --dir ${shellWord(REPO_ROOT)}`)
}

/** Map the guides' command to this run's executable and board. */
export function commandNote(command: string): string {
  if (command === 'akb') return 'Find commands with `akb help`, then read the matching subcommand’s `--help`.'
  return `Find commands with \`${command} help\`, then read the matching subcommand’s \`--help\`. In guides, use \`${command}\` for \`akb\`.`
}
