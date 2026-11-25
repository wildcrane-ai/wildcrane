import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { withCreationLock } from './creation-lock'
import type { NewTask } from '../cloud/tasks'
import { CLOUD_ACCESS_HINTS } from '../cloud/session'
import { BoardError } from '../io'
import { KANBAN, REPO_ROOT } from '../paths'
import { projectStateDir } from '../machine/project'
import { archiveInboxItem, readArchived, readAllDismissed, readInbox } from '../signals/inbox'

export function creationError(error: string, triage?: string): string {
  const messages: Record<string, string> = {
    'The run ended without creating a card.': 'No cards were created.',
    'This machine is not signed in to Cloud.': CLOUD_ACCESS_HINTS['signed-out'],
    'Cloud sign-in has expired. Sign in again.': CLOUD_ACCESS_HINTS.expired,
    'This board is not linked to a Cloud project.': 'This folder is not linked to a WildCrane project. Link it to a project, then try again.',
    'The project link is invalid or names multiple projects.': 'The project link is invalid or conflicting. Check this folder’s project link, then try again.',
    'The source task conflicts with this board’s project link.': 'The project link is invalid or conflicting. Check this folder’s project link, then try again.',
    'This build of WildCrane carries no Cloud project to sign in against.': 'WildCrane is not configured here. Complete the connection setup, then try again.',
  }
  const networkPrefix = 'Cloud could not be reached:'
  const unreachable = error.startsWith(networkPrefix)
  const message = unreachable && !triage
    ? `${CLOUD_ACCESS_HINTS.unreachable} ${error.slice(networkPrefix.length).trimStart()}`.trimEnd()
    : messages[error] ?? error
  if (!triage || message.includes(`Original item remains in triage: ${triage}.`) || message.includes(`原条目仍在 triage：${triage}。`)) return message
  return `${message}\n\nOriginal item remains in triage: ${triage}. ${unreachable ? 'Retry when connected.' : 'Fix the cause and retry.'}`
}

/** 固定请求内容和幂等键，Cloud 返回后先记账，再落卡。 */
export function creationReceipt(request: string, slot: string): string {
  const hash = crypto.createHash('sha256').update(`${request}\n${slot}`).digest('hex')
  return path.join(projectStateDir(KANBAN, REPO_ROOT), 'creations', `${hash}.json`)
}

export type CreationJournal = { said: NewTask; made?: { task: { id: string; key: string; project: string }; number: number } }

export function readCreation(file: string, said: NewTask): CreationJournal {
  return withCreationLock(() => {
    try {
      const held = JSON.parse(fs.readFileSync(file, 'utf8')) as CreationJournal
      if (!held.said || typeof held.said.title !== 'string') throw new Error('Invalid creation journal')
      return held
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const held = { said }
      saveCreation(file, held)
      return held
    }
  })
}

export function saveCreation(file: string, journal: CreationJournal): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(journal))
  fs.renameSync(temp, file)
}

export function archiveCreation(source: string, id: number): void {
  if (readArchived().some((s) => s.sourceId === source && s.cardId === id)) return
  try {
    const archived = archiveInboxItem(source, id)
    if (!archived.ok) throw new Error(archived.error)
  } catch (error) {
    throw new BoardError(creationError(error instanceof Error ? error.message : String(error), source), { kind: 'refused' })
  }
}

export function triageFile(sourceId: string): string {
  const found = [...readInbox(), ...readAllDismissed(), ...readArchived()].find((s) => s.sourceId === sourceId.trim())
  if (!found) throw new BoardError(`nothing in triage is ${sourceId}`, { kind: 'refused' })
  return path.basename(found.relPath, '.md')
}
