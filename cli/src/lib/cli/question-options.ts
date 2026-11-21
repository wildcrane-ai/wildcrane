import { Option } from 'commander'
import { ordered, type Command, type Typed } from './shared'

export function withQuestionOptions(command: Command, ops: Typed[]): Command {
  const inOrder = ordered(ops)
  return command
    .option('--append <text>', 'append a new question', inOrder('append'))
    .option('--update <n> <text...>', 'rewrite question <n>', inOrder('update'))
    .option('--drop <positions>', 'remove questions, e.g. 1 or 1,3', inOrder('drop'))
    .option('--clear', 'remove every open question', inOrder('clear'))
    .option('--option <text>', 'a choice for the preceding append or update', inOrder('option'))
    .option('--recommended-option <text>', 'a choice selected by default', inOrder('recommended-option'))
    .option('--mode <mode>', 'single (default) or multi', inOrder('mode'))
    .addOption(new Option('--agent <name>').hideHelp().argParser(inOrder('agent')))
}
