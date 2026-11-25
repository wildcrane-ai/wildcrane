import { cmdCreate, cmdUpdate, cmdUpdateQuestions, type CreateOptions, type QuestionOpsInput, type UpdateOptions } from '../../commands/card'
import { cmdInit } from '../../commands/init'
import { cmdList, type ListOptions } from '../../commands/list'
import { cmdRemove, type RemoveOptions } from '../../commands/remove'
import { cmdAgentFile } from '../../commands/agent-file'
import { cmdStudioFile, cmdStudioSkills } from '../../commands/studio-file'
import { cmdMemoryFile } from '../../commands/memory-file'
import { cmdInspect } from '../../commands/inspect'
import { cmdValidate } from '../../commands/validate'
import { quietly } from '../io'
import { withBoardLock } from '../lock'
import type { MoveResult } from '../types'

interface MoveInput {
  args: string[]
  opts: Record<string, unknown>
}

type RunMove = (input: MoveInput) => MoveResult | Promise<MoveResult>

const as = <T,>(opts: Record<string, unknown>): T => opts as T

const MOVES: Record<string, RunMove> = {
  inspect: ({ args }) => cmdInspect(Number(args[0])),
  validate: ({ args }) => cmdValidate(args[0] === undefined ? undefined : Number(args[0])),
  init: () => cmdInit(),
  create: ({ opts }) => cmdCreate(as<CreateOptions>(opts)),
  update: ({ args, opts }) => cmdUpdate(Number(args[0]), as<UpdateOptions>(opts)),
  'update-questions': ({ args, opts }) => cmdUpdateQuestions(Number(args[0]), as<QuestionOpsInput>(opts)),
  list: ({ opts }) => cmdList(as<ListOptions>(opts)),
  reject: ({ args, opts }) => cmdRemove(Number(args[0]), 'rejected', as<RemoveOptions>(opts)),
  'agent-file': ({ args }) => cmdAgentFile(args[0] ?? '', args[1] ?? ''),
  file: ({ args }) => cmdStudioFile(args[0] ?? '', args[1] ?? ''),
  skills: ({ args }) => cmdStudioSkills(args[0] ?? ''),
  'memory-file': ({ args }) => cmdMemoryFile(args[0] ?? ''),
}

export const BOARD_MOVES: ReadonlySet<string> = new Set(Object.keys(MOVES))
const READ_ONLY_MOVES: ReadonlySet<string> = new Set(['inspect', 'list', 'validate', 'file', 'skills', 'agent-file', 'memory-file'])

export function runLocalMove(move: string, input: MoveInput): MoveResult | Promise<MoveResult> {
  if (!Object.hasOwn(MOVES, move)) throw new Error(`unknown command "${move}".`)
  const run = MOVES[move]!
  return READ_ONLY_MOVES.has(move) ? run(input) : withBoardLock(() => run(input))
}

export function setCardStatusOn(id: number, status: string): void {
  withBoardLock(() => quietly(() => cmdUpdate(id, { status })))
}
