import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { cloud } from './task'
import { cloudError, hasText, invalidResponse, requireResponse } from '../lib/cloud/response'
import type { MoveResult } from '../lib/types'
import { die } from '../lib/paths'
import { say } from '../lib/io'
import { editGoal, cmdGoalPreviews, cmdGoalStudios, goalsFile, shortStudioId, type GoalOptions, type GoalStudio, type GoalsFile } from './goal'
import { goalRoute, type Goal, type GoalDraft } from '../lib/shared/goal'

/** The host session the goals belong to; Cursor's and Kimi Code's models pass their session id themselves,
 *  and dsh's model the discussion `wildcrane_draft_read` opened. */
function hostSession(): { id: string; host: 'claude-code' | 'codex' | 'cursor' | 'kimi' | 'discussion' } | null {
  const { CLAUDE_CODE_SESSION_ID: claude, CODEX_THREAD_ID: codex, CURSOR_CONVERSATION_ID: cursor, KIMI_SESSION_ID: kimi, WILDCRANE_DISCUSSION: discussion } = process.env
  if (discussion) return { id: discussion, host: 'discussion' }
  if (claude) return { id: claude, host: 'claude-code' }
  if (codex) return { id: codex, host: 'codex' }
  if (cursor) return { id: cursor, host: 'cursor' }
  return kimi ? { id: kimi, host: 'kimi' } : null
}

export const externalGoalSession = () => !goalsFile() && !process.env.KANBAN_RUN && !process.env.WILDCRANE_JOB && !process.env.AI4KANBAN_BOARD && Boolean(hostSession())

const request = <T>(method: string, route: string, body?: unknown): Promise<T> => cloud<T>(method, route, body)

async function studios(workspace: string): Promise<GoalStudio[]> {
  const all: GoalStudio[] = []
  const cursors = new Set<string>()
  let after: string | null = null
  do {
    const page: { data: GoalStudio[]; next: string | null } = await request('GET', `/v1/studios?workspace=${encodeURIComponent(workspace)}&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`)
    requireResponse(page, 'a valid Studio list', value => Array.isArray(value.data)
      && value.data.every(studio => hasText(studio?.id) && hasText(studio.name))
      && (value.next === null || hasText(value.next) && !cursors.has(value.next)))
    all.push(...page.data)
    after = page.next
    if (after) cursors.add(after)
  } while (after)
  return all
}

interface Discussion { id: string; workspace: string; version: number; goals: Goal[] }

async function discussion(): Promise<Discussion> {
  const session = hostSession()
  if (!session) die('Goals exist only inside a WildCrane goal discussion.')
  const home = process.env.WILDCRANE_HOME || path.join(os.homedir(), '.wildcrane')
  process.env.AI4KANBAN_HOME ??= home
  if (session.host === 'discussion') return request('GET', `/v1/discussions/${encodeURIComponent(session.id)}`)
  const machineFile = path.join(home, 'machine.json')
  let machine: string
  try { machine = JSON.parse(fs.readFileSync(machineFile, 'utf8')).id } catch {
    machine = crypto.randomUUID()
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(machineFile, JSON.stringify({ id: machine }))
  }
  const held = await request<{ folders: { path: string; project: string }[] }>('GET', `/v1/runner/folders?machine=${encodeURIComponent(machine)}`)
  const cwd = fs.realpathSync(process.cwd())
  const folder = held.folders.filter((f) => { try { const dir = fs.realpathSync(f.path); return cwd === dir || cwd.startsWith(dir + path.sep) } catch { return false } }).sort((a, b) => b.path.length - a.path.length)[0]
  return request('POST', '/v1/discussions/external', { requestId: session.id, host: session.host, ...(folder ? { project: folder.project } : {}) })
}

const discussionReceipt = (value: Discussion) => requireResponse(value, 'a valid discussion draft', d =>
  hasText(d.id) && hasText(d.workspace) && Number.isSafeInteger(d.version) && Array.isArray(d.goals))

async function withGoalDiscussion(action: (held: GoalsFile) => MoveResult, save = false): Promise<MoveResult & { discussion: string; url: string }> {
  const d = discussionReceipt(await discussion())
  const held = { workspace: d.workspace, studios: await studios(d.workspace), goals: d.goals.map(goal => ({ ...goal })) }
  const result = action(held)
  if (save) {
    const goals = held.goals.filter(g => !g.dropped && !g.task)
      .map(({ task, start, dropped, ...goal }) => goal) satisfies GoalDraft[]
    const saved = await request<Discussion>('PUT', `/v1/discussions/${encodeURIComponent(d.id)}/draft`, {
      expectedVersion: d.version, goals,
    })
    const latest = discussionReceipt(saved)
    const existing = new Set(d.goals.map(g => g.id))
    const fresh = goals.filter(g => !existing.has(g.id))
    const made = latest.goals.filter(g => !existing.has(g.id))
    const actualId = (id: string) => made[fresh.findIndex(g => g.id === id)]?.id ?? id
    if (typeof result.id === 'string') result.id = actualId(result.id)
    if (result.start) {
      const actual = latest.goals.find(g => g.id === result.id)
      if (!actual) throw cloudError(invalidResponse('the saved goal'))
      const task = actual.task ?? requireResponse(await request<{ id: string }>('POST', `${goalRoute(d.id, actual.id)}/start`,
        { expectedVersion: latest.version }), 'a started task', value => hasText(value.id))
      result.task = task.id
    }
    say(`${result.dropped ? 'Dropped' : result.start ? 'Started' : 'Saved'} goal ${result.id}${result.title ? `: ${result.title}` : ''}.`)
  }
  const url = `${process.env.WILDCRANE_WEB_URL || 'https://app.wildcrane.ai'}/discussions/${d.id}`
  say(url)
  return { ...result, discussion: d.id, url }
}

export const cloudGoal = (args: string[], opts: GoalOptions) => withGoalDiscussion(held => editGoal(args, opts, held), true)
export const cloudGoalStudios = () => withGoalDiscussion(cmdGoalStudios)
export async function queryPreviews(studio: string, workspace?: string) {
  if (!workspace) {
    if (externalGoalSession()) return withGoalDiscussion(held => cmdGoalPreviews(studio, held))
    die('--workspace is required outside a goal discussion.')
  }
  const list = await studios(workspace)
  const flow = list.find((w) => w.id === studio || shortStudioId(w.id) === studio)
  if (!flow) die(`No studio \`${studio}\` here.`)
  if (!flow.previews) die('Preview outputs are unavailable; update Runner and try again.')
  const previews = flow.previews
  say(previews.map(p => `${p.id}\n  ${p.instructions}`).join('\n'))
  return { previews, problems: [] }
}
