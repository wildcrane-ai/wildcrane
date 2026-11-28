import fs from 'node:fs'
import path from 'node:path'
import { tryLock } from '../lock'
import { git } from './worktree'
import type { DeliveryRecord } from './types'

type Workspace = Pick<DeliveryRecord, 'worktree' | 'branch' | 'base'>

export const PROJECT_CHECKOUT = '.'

export function checkoutAt(dir: string): boolean {
  const root = git(['rev-parse', '--show-toplevel'], dir)?.trimEnd()
  return !!root && fs.realpathSync(root) === fs.realpathSync(dir)
}

export function verifiedWorkspace(project: string, saved: Workspace, runCwd?: string): string | undefined {
  if (!saved.worktree) return
  try {
    const dir = path.resolve(project, saved.worktree)
    if (runCwd && fs.realpathSync(runCwd) !== fs.realpathSync(dir)) return
    if (saved.worktree === PROJECT_CHECKOUT) {
      return saved.branch && checkoutAt(dir)
        && git(['symbolic-ref', '--quiet', 'HEAD'], dir)?.trim() === `refs/heads/${saved.branch}`
        && (!saved.base || containsCommit(dir, saved.base, 'HEAD')) ? dir : undefined
    }
    const root = path.join(project, '.akb', 'worktrees')
    const relative = path.relative(root, dir)
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return
    if (fs.realpathSync(dir) !== path.join(fs.realpathSync(project), '.akb', 'worktrees', relative)) return
    if (!saved.branch && !saved.base) {
      const base = path.join(path.dirname(dir), 'base')
      return fs.statSync(dir).isDirectory() && fs.lstatSync(base).isDirectory() ? dir : undefined
    }
    return saved.branch && saved.base && checkoutAt(dir)
      && git(['symbolic-ref', '--quiet', 'HEAD'], dir)?.trim() === `refs/heads/${saved.branch}`
      && containsCommit(dir, saved.base, 'HEAD') && commonGitDir(dir) === commonGitDir(project) ? dir : undefined
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return
    throw error
  }
}

export function commonGitDir(dir: string): string | undefined {
  const common = git(['rev-parse', '--git-common-dir'], dir)?.trimEnd()
  return common ? fs.realpathSync(path.resolve(dir, common)) : undefined
}

export function containsCommit(project: string, commit: string, ref: string): boolean {
  return /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(commit)
    && git(['merge-base', '--is-ancestor', commit, ref], project) !== null
}

export async function lockDeliveryProject(project: string, stopped: () => boolean, wait = true): Promise<(() => void) | undefined> {
  const lock = path.join(fs.realpathSync(project), '.akb', 'delivery-project.lock')
  while (!stopped()) {
    const release = tryLock(lock)
    if (release || !wait) return release
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
