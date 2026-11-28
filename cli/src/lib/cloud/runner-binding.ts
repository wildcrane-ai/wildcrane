import fs from 'node:fs'
import path from 'node:path'

import { BoardError } from '../io'
import { realPathOf, runnerBoardRoot } from '../machine/project'
import { allowedRunnerProjects, probeRunner, readRunnerMachineId, runnerHome, runnerSocketPath } from '../machine/runner'
import { hasText } from './response'
import { accessToken, readSession } from './session'
import { call, linkedProject } from './tasks'

const MESSAGES = {
  'runner-offline': 'The local Runner is offline. Run wildcrane-runner or reopen the WildCrane plugin, then try again.',
  'runner-signed-out': 'The local Runner needs the project’s account. Sign in to that account in WildCrane settings, then try again.',
  'runner-folder-not-authorized': 'This folder is not authorized for the Runner’s account. Authorize it in WildCrane settings, then try again.',
  'runner-project-not-bound': 'This folder is not bound on this Runner. Link it to the correct project in WildCrane settings, then try again.',
  'runner-project-link-invalid': 'The local board’s project link is invalid. Check and relink the project folder in WildCrane settings, then try again.',
  'runner-binding-unverified': 'Could not verify the Runner’s project binding. Check your Cloud connection and try again.',
}

function refuse(code: keyof typeof MESSAGES): never {
  throw new BoardError(MESSAGES[code], { kind: 'runner-required', code })
}

function authorized(home: string, subject: string, root: string): boolean {
  try { return allowedRunnerProjects(home, subject).includes(root) } catch { return false }
}

function projectOf(board: string, root: string): string | null {
  const file = path.join(root, '.akb', 'base.json')
  try {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false })
    if (!stat) return null
    if (!stat.isFile() && !(stat.isSymbolicLink() && fs.statSync(file).isFile())) refuse('runner-project-link-invalid')
  } catch { refuse('runner-project-link-invalid') }
  const link = linkedProject(board, root)
  if (!link.ok || !link.value) refuse('runner-project-link-invalid')
  return link.value
}

interface FolderBinding { path: string; project: string }

/** Confirm the binding before taking any board lock. Recheck local identity at the write. */
export async function confirmRunnerBinding(board: string): Promise<(() => void) | undefined> {
  const realBoard = realPathOf(board)
  const root = runnerBoardRoot(realBoard)
  if (!root) return
  const project = projectOf(realBoard, root)
  if (!project) return

  const home = runnerHome()
  const socket = runnerSocketPath(home)
  const subject = readSession(home)?.subject
  const machine = readRunnerMachineId(home)
  if (await probeRunner(socket) !== true) refuse('runner-offline')
  if (!subject || readSession(home)?.subject !== subject) refuse('runner-signed-out')
  if (!authorized(home, subject, root)) refuse('runner-folder-not-authorized')
  if (!machine) refuse('runner-project-not-bound')

  const recheck = () => {
    if (readSession(home)?.subject !== subject) refuse('runner-signed-out')
    if (runnerHome() !== home || readRunnerMachineId(home) !== machine) refuse('runner-project-not-bound')
    if (realPathOf(board) !== realBoard || projectOf(realBoard, root) !== project) refuse('runner-project-link-invalid')
    if (!authorized(home, subject, root)) refuse('runner-folder-not-authorized')
  }

  const auth = await accessToken({ home }).catch(() => refuse('runner-binding-unverified'))
  if (!auth.ok) refuse(auth.reason === 'unreachable' ? 'runner-binding-unverified' : 'runner-signed-out')
  if (auth.session.subject !== subject) refuse('runner-signed-out')
  recheck()
  const answer = await call<{ folders: FolderBinding[] }>('GET', `/v1/runner/folders?machine=${encodeURIComponent(machine)}`, undefined, undefined, { auth })
  if (!answer.ok) refuse(answer.status === 401 || answer.code === 'unauthenticated' ? 'runner-signed-out' : 'runner-binding-unverified')
  if (!Array.isArray(answer.value.folders) || answer.value.folders.some(f => !hasText(f?.path) || !path.isAbsolute(f.path) || !hasText(f.project))) {
    refuse('runner-binding-unverified')
  }
  const matches = answer.value.folders.filter(f => {
    try { return fs.realpathSync(f.path) === root } catch { return false }
  })
  if (!matches.length) refuse('runner-project-not-bound')
  if (matches.some(f => f.project !== project)) refuse('runner-project-link-invalid')
  if (await probeRunner(socket) !== true) refuse('runner-offline')
  recheck()
  return recheck
}
