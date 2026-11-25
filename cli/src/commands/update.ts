import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { BOARD_LINK_HINT, runBoard } from '../lib/board-cli'
import { missingConfigKeys } from '../lib/config-template'
import { BoardError, say } from '../lib/io'
import type { MoveResult } from '../lib/types'
import { SKILL_VERSION } from '../version'

const NAME = 'wildcrane'
const REPO = 'https://github.com/wildcrane-ai/wildcrane'

export const NEWER_LINE = `npm install -g ${NAME}@latest`
const UNFILLED = '_(not filled in yet'

export interface SetupContext {
  dir: string
  program: string
  board?: string | null
}

class Report {
  did: string[] = []
  notes: string[] = []
  private reported = 0

  sayDid(): void {
    for (const line of this.did.slice(this.reported)) say(`  · ${line}`)
    this.reported = this.did.length
  }

  sayNotes(): void {
    if (!this.notes.length) return
    say('')
    say('Needs your attention:')
    for (const line of this.notes) say(`  ! ${line}`)
  }
}

const read = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)

async function boardMove(root: string, args: string[], board?: string | null): Promise<void> {
  const where = board ? ['--board', board] : ['--dir', root]
  const code = await runBoard([...args, ...where], { program: 'akb raw', cwd: root })
  if (code !== 0) throw new BoardError(`\`board ${args.join(' ')}\` failed — nothing else was changed`, { kind: 'board-move-failed' })
}

export async function cmdUpdate(ctx: SetupContext): Promise<MoveResult> {
  const report = new Report()
  say(`Updating board at ${ctx.dir}.`)
  const from = null
  say('')
  const repaired = await repairBoard(ctx.dir, report, ctx.board)
  report.sayDid()
  report.sayNotes()
  say('')
  if (repaired) say(`Release notes: ${REPO}/releases`)
  sayCommandVersion()
  return { updated: ctx.dir, from, to: SKILL_VERSION }
}

async function repairBoard(root: string, report: Report, named?: string | null): Promise<boolean> {
  const legacy = path.join(root, 'docs', 'kanban')
  const kept = path.join(root, '.akb', 'kanban')
  const board = named ?? (fs.existsSync(legacy) ? legacy : kept)
  if (!fs.existsSync(board)) {
    report.notes.push(`No board found. ${BOARD_LINK_HINT}.`)
    return false
  }
  report.sayDid()
  await boardMove(root, ['init'], board)
  checkConfig(board, report)
  checkModules(board, report)
  return true
}
function checkConfig(board: string, report: Report): void {
  const file = path.join(board, 'config.md')
  const current = read(file)
  if (!current) return
  const added = missingConfigKeys(current)
  if (added.length) {
    report.notes.push(
      `Fill in ${added.join(', ')} in ${file}.`,
    )
  }
}

function checkModules(board: string, report: Report): void {
  const file = path.join(board, 'modules.md')
  const map = read(file)
  if (map && map.includes(UNFILLED)) {
    report.notes.push(
      `${file} is still blank. Run \`akb guide module-map\` from the project.`,
    )
  }
}
function sayCommandVersion(): void {
  const latest = latestVersion()
  say('')
  if (latest && isOlder(SKILL_VERSION, latest)) {
    say(`This command is ${SKILL_VERSION}. Version ${latest} is available.`)
    say(`Run \`${NEWER_LINE}\`, then \`akb update\`.`)
  } else if (latest) {
    say(`This command is ${SKILL_VERSION} — the newest published.`)
  } else {
    say(`This command is ${SKILL_VERSION}. Could not check for updates.`)
  }
}
function latestVersion(): string | null {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['view', NAME, 'version'], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
  })
  if (result.status !== 0 || !result.stdout) return null
  const value = result.stdout.trim()
  return /^\d+\.\d+\.\d+/.test(value) ? value : null
}
function isOlder(a: string, b: string): boolean {
  const parts = (v: string): number[] => v.split('-')[0]!.split('.').map((n) => Number(n) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0)
  }
  return a.includes('-') && !b.includes('-')
}
