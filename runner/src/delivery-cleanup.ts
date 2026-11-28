import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { connectionStopped } from '../../cli/src/lib/agent/connection-process'
import { deliveryCleanupDir, managedDeliveryId, saveDeliveryCleanupReceipt, type DeliveryCleanupReceipt } from '../../cli/src/lib/agent/delivery-cleanup-receipt'
import { checkoutAt, commonGitDir, containsCommit, lockDeliveryProject, verifiedWorkspace } from '../../cli/src/lib/agent/delivery-workspace'
import { processesStopped, runMark, runWatchersStopped } from '../../cli/src/lib/agent/stop'
import { readDeliveryRow } from '../../cli/src/lib/agent/store'
import type { DeliveryRecord, RunRecord } from '../../cli/src/lib/agent/types'
import { stoppedCleanupConfirmed } from '../../cli/src/lib/agent/wire/codex-background-types'
import { verifyCodexStopStateSync } from '../../cli/src/lib/agent/wire/codex-verify'
import { git } from '../../cli/src/lib/agent/worktree'
import { linkedProject, numberOf } from '../../cli/src/lib/cloud/tasks'
import { pidAlive, withLock } from '../../cli/src/lib/lock'
import { projectStateDir, SESSIONS_FILE, SESSIONS_LOCK } from '../../cli/src/lib/machine/project'
import * as api from './api'
import { syncedDeliveryArchive } from './task-folder'

const worktrees = (cwd: string) => path.join(cwd, '.akb', 'worktrees')
const boardOf = (cwd: string) => path.join(cwd, '.akb', 'kanban')
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const entryAt = (file: string) => fs.lstatSync(file, { throwIfNoEntry: false })

function requireCleanup(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason)
}

function readJson<T>(file: string): T | undefined {
  try {
    const stat = entryAt(file)
    if (!stat) return
    requireCleanup(stat.isFile() && fs.realpathSync(file) === file, 'The cleanup record path is invalid.')
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch (error) {
    if (!missing(error)) throw error
  }
}

function directory(dir: string): boolean {
  const stat = entryAt(dir)
  if (!stat) return false
  requireCleanup(stat.isDirectory() && fs.realpathSync(dir) === dir, 'The delivery directory is not at its recorded path.')
  return true
}

function names(dir: string): string[] {
  return directory(dir) ? fs.readdirSync(dir) : []
}

function removeEmpty(dir: string): void {
  if (!directory(dir)) return
  try { fs.rmdirSync(dir) }
  catch (error) {
    if (!missing(error) && !['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
}

const inside = (dir: string, file: string) => file === dir || file.startsWith(dir + path.sep)

function processFiles(pid: string): string[] {
  const proc = `/proc/${pid}`
  const files = [`${proc}/cwd`, `${proc}/root`, `${proc}/exe`]
  try {
    files.push(...fs.readdirSync(`${proc}/fd`).map(fd => `${proc}/fd/${fd}`))
    return files.flatMap(file => {
      try { return [fs.readlinkSync(file)] }
      catch (error) { if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; return [] }
    })
  } catch (error) {
    if (missing(error) || (error as NodeJS.ErrnoException).code === 'ESRCH') return []
    const stat = fs.statSync(proc, { throwIfNoEntry: false })
    if (stat && stat.uid === process.getuid?.()) throw error
    return []
  }
}

function workspaceUnoccupied(dir: string): boolean {
  const occupied = (file: string) => inside(dir, file.replace(/ \(deleted\)$/, ''))
  if (process.platform === 'linux') {
    return !fs.readdirSync('/proc').some(pid => /^\d+$/.test(pid) && processFiles(pid).some(occupied))
  }
  requireCleanup(process.platform === 'darwin', 'Workspace occupancy could not be verified on this platform.')
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-F0fn'], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 * 1024,
  })
  requireCleanup(result.status === 0 && result.stdout && !result.stderr, 'Workspace occupancy could not be verified.')
  return !result.stdout.split('\0').some(field => {
    const name = field.replace(/^\n/, '')
    return name.startsWith('n') && occupied(name.slice(1))
  })
}

type Registry = { runs: RunRecord[]; deliveries: DeliveryRecord[] }

function registry(state: string): Registry {
  const current = readJson<Registry>(path.join(state, SESSIONS_FILE))
  requireCleanup(Array.isArray(current?.runs) && Array.isArray(current.deliveries), 'The local run registry could not be verified.')
  return current
}

function deliveryOf(current: Registry, cwd: string, id: string): DeliveryRecord | undefined {
  const live = current.deliveries.find(row => row.deliveryId === id)
  if (live) return readDeliveryRow(live) ?? undefined
  const audit = readJson<Omit<DeliveryRecord, 'sessions'> & { sessions: { sessionId: string }[] }>(
    path.join(boardOf(cwd), 'deliveries', `${id}.json`))
  if (audit?.deliveryId === id && Array.isArray(audit.sessions)) {
    return readDeliveryRow({ ...audit, sessions: audit.sessions.map(run => run.sessionId) }) ?? undefined
  }
}

function stopped(run: RunRecord, delivery: DeliveryRecord, task: string): boolean {
  if (!run.sessionId || !Number.isFinite(run.startedAt) || !Number.isFinite(run.endedAt) || run.endedAt! < run.startedAt ||
      !['done', 'error', 'stopped', 'interrupted'].includes(run.status) || pidAlive(run.pid) || run.blocker) return false
  const since = run.agentStartedAt ?? run.startedAt
  const root = run.agentPid ? { pid: run.agentPid, since, identity: run.agentIdentity } : undefined
  if (!connectionStopped(root) || !processesStopped(runMark(run.sessionId, since), root)) return false
  if (run.cleanup?.kept?.length || run.cleanup && !stoppedCleanupConfirmed(run.cleanup)) return false
  if (run.harness !== 'codex' && !run.managedProcess) return true
  const session = run.resumeId ?? (run.continues?.fork ? undefined : run.continues?.resumeId)
  if (!session) return run.unspawned === true
  const result = verifyCodexStopStateSync({
    session, cwd: run.cwd, deliveryId: delivery.deliveryId, cardId: run.cardId, taskId: task,
    cleanup: run.cleanup, selfSessionId: run.sessionId, needsBackendProbe: !!run.pendingWrites,
  })
  return result.stopped && (!result.found || result.ownershipOk) && (!run.pendingWrites || result.settled)
}

function verifyRuns(current: Registry, delivery: DeliveryRecord, cwd: string, dir: string, task: string): void {
  const expected = new Set(delivery.sessions)
  for (const run of current.runs) {
    if (run.deliveryId === delivery.deliveryId || run.cwd && inside(dir, path.resolve(run.cwd))) expected.add(run.sessionId)
  }
  let added = true
  while (added) {
    const size = expected.size
    for (const run of current.runs) if (run.parentId && expected.has(run.parentId)) expected.add(run.sessionId)
    added = expected.size > size
  }
  const related = current.runs.filter(run => expected.has(run.sessionId))
  requireCleanup(related.length && new Set(related.map(run => run.sessionId)).size === expected.size &&
    related.some(run => run.deliveryId === delivery.deliveryId && run.cwd === path.join(dir, 'work') &&
      (run.cardId === delivery.cardId || run.cloudExecution?.card === delivery.cardId)) &&
    related.every(run => !run.cwd || run.cwd === cwd || inside(dir, run.cwd)) &&
    runWatchersStopped(expected) && related.every(run => stopped(run, delivery, task)),
  'The delivery processes could not be confirmed stopped.')
}

function gitOutput(args: string[], cwd: string): string {
  const result = git(args, cwd)
  requireCleanup(result !== null, `Git ${args[0]} failed.`)
  return result
}

function gitRefs(cwd: string) {
  return new Map(gitOutput(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/heads/'], cwd)
    .trimEnd().split('\n').filter(Boolean).map(line => {
      const [ref, commit, alias] = line.split('\0')
      return [ref!, { commit: commit!, alias }]
    }))
}

function gitWorktrees(cwd: string) {
  return gitOutput(['worktree', 'list', '--porcelain', '-z'], cwd).split('\0\0').filter(Boolean).map(block => {
    const [tree, head, branch] = block.split('\0')
    return {
      dir: tree?.slice('worktree '.length),
      commit: head?.startsWith('HEAD ') ? head.slice(5) : undefined,
      branch: branch?.startsWith('branch ') ? branch.slice(7) : undefined,
    }
  })
}

function gitCleanup(cwd: string, delivery: DeliveryRecord, verify: () => void): void {
  const source = `refs/heads/${delivery.branch}`
  const target = `refs/heads/${delivery.targetBranch}`
  const commit = delivery.landing?.commit
  const work = path.join(cwd, delivery.worktree!)
  requireCleanup(delivery.branch === `akb/${delivery.deliveryId}` && delivery.base && delivery.targetBranch &&
    source !== target && delivery.landing?.status === 'landed' && commit && checkoutAt(cwd),
  'The recorded Git delivery or landing could not be verified.')

  const refs = () => {
    const names = gitRefs(cwd)
    const tip = names.get(source)
    const landed = names.get(target)
    requireCleanup(!tip?.alias && landed && !landed.alias && containsCommit(cwd, commit, landed.commit) &&
      (!tip || containsCommit(cwd, tip.commit, landed.commit)), 'The target branch does not contain the landing and task branch tip.')
    return { tip, landed }
  }

  const { tip, landed } = refs()
  const trees = gitWorktrees(cwd)
  const registered = trees.find(tree => tree.dir === work)
  if (directory(work)) {
    const common = commonGitDir(cwd)
    requireCleanup(registered && common && common === commonGitDir(work) &&
      (verifiedWorkspace(cwd, delivery) === work || !tip && !registered.branch && checkoutAt(work) &&
        registered.commit && containsCommit(cwd, registered.commit, landed.commit)),
    'The delivery worktree could not be verified.')
  } else if (registered) {
    requireCleanup(registered.branch === source || !tip && !registered.branch && registered.commit &&
      containsCommit(cwd, registered.commit, landed.commit), 'The missing worktree has a different Git registration.')
  }
  if (registered) {
    verify()
    refs()
    requireCleanup(git(['worktree', 'remove', '--', work], cwd) !== null, 'Git could not remove the worktree. It may be locked or have local changes.')
  }

  verify()
  const current = refs()
  const remaining = gitWorktrees(cwd)
  requireCleanup(!directory(work) && !remaining.some(tree => tree.dir === work || tree.branch === source),
    'A worktree still holds the delivery workspace or task branch.')
  if (current.tip) {
    const updates = `verify ${target} ${current.landed.commit}\ndelete ${source} ${current.tip.commit}\n`
    requireCleanup(git(['update-ref', '--no-deref', '--stdin'], cwd, updates) !== null, 'Git could not delete the task branch at its verified tip.')
  }
}

const receiptFile = (cwd: string, id: string) => path.join(deliveryCleanupDir(cwd), `${id}.json`)

function warn(cwd: string, id: string, error: unknown): void {
  console.warn('runner: delivery workspace cleanup deferred', { cwd, delivery: id, reason: error instanceof Error ? error.message : String(error) })
}

export function noteLandArchive(cwd: string, job: Pick<api.Job, 'flow' | 'project' | 'task' | 'number'>, report: api.JobReport | undefined): void {
  if (job.flow?.phase !== 'land' || !job.project || !job.task || !report?.deliveryId ||
      job.flow.delivery_id !== report.deliveryId || !report.archive || !report.card || report.card !== job.number) return
  try {
    if (!managedDeliveryId(report.deliveryId) || !directory(path.join(worktrees(cwd), report.deliveryId))) return
    saveDeliveryCleanupReceipt(cwd, {
      project: job.project, task: job.task, card: report.card, deliveryId: report.deliveryId, seq: report.archive.seq, synced: true,
    })
  } catch (error) { warn(cwd, report.deliveryId, error) }
}

async function archiveReceipt(cwd: string, project: string, delivery: DeliveryRecord, current: Registry): Promise<DeliveryCleanupReceipt> {
  const { deliveryId, cardId } = delivery
  requireCleanup(cardId && cardId > 0, 'The delivery has no Cloud card.')
  const saved = readJson<DeliveryCleanupReceipt>(receiptFile(cwd, deliveryId))
  requireCleanup(!saved || saved.deliveryId === deliveryId && saved.project === project && saved.card === cardId &&
    typeof saved.task === 'string' && saved.task && Number.isSafeInteger(saved.seq) && saved.seq > 0,
    'The saved archive receipt belongs to another delivery.')
  if (saved?.synced === true) return saved
  let archive = syncedDeliveryArchive(cwd, project, cardId, saved?.task)
  if (!archive && !saved && delivery.cloudExecution) {
    const job = await api.readJob(delivery.cloudExecution.job)
    if (job.ok && job.value.job.id === delivery.cloudExecution.job && job.value.job.project === project &&
        job.value.job.number === cardId && job.value.job.task) {
      archive = syncedDeliveryArchive(cwd, project, cardId, job.value.job.task)
    }
  }
  requireCleanup(archive && archive.archive.seq > 0, 'The successful archive has not synchronized.')
  const { task } = archive
  if (saved?.seq === archive.archive.seq) return saved

  const remote = await api.readTask(task)
  requireCleanup(remote.ok && remote.value.project === project && remote.value.status === 'done' &&
    remote.value.key && numberOf(remote.value.key) === cardId && remote.value.card_version === archive.archive.seq,
  'Cloud did not confirm this archive version.')
  const jobId = remote.value.last_job
  const read = jobId ? await api.readJob(jobId) : undefined
  const job = read?.ok ? read.value.job : undefined
  const exactLand = job && job.id === jobId && job.task === task && job.project === project && job.number === cardId &&
    job.state === 'finished' && job.outcome === 'done' && job.flow?.phase === 'land' && job.flow.delivery_id === deliveryId &&
    (!job.projectDir || job.projectDir === cwd)
  const commit = delivery.landing?.commit
  const matchingLanding = archive.confirmed && commit && remote.value.landing?.commit === commit &&
    remote.value.landing.branch === delivery.targetBranch &&
    (!job?.flow?.delivery_id || job.flow.delivery_id === deliveryId) &&
    !current.deliveries.some(row => row.deliveryId !== deliveryId && row.cardId === cardId && row.landing?.commit === commit)
  requireCleanup(exactLand || matchingLanding, 'The confirmed archive could not be tied to this delivery.')
  return { project, task, card: cardId, deliveryId, seq: archive.archive.seq }
}

export async function cleanDeliveryWorkspaces(cwd: string): Promise<void> {
  try {
    const root = worktrees(cwd)
    const hasGit = entryAt(path.join(cwd, '.git'))
    if (!entryAt(root) && !entryAt(deliveryCleanupDir(cwd)) &&
        !(hasGit && entryAt(path.join(cwd, '.akb', 'state', SESSIONS_FILE)))) return
    if (!directory(cwd) || !directory(path.join(cwd, '.akb'))) return
    const ids = new Set(names(root).filter(managedDeliveryId))
    for (const file of names(deliveryCleanupDir(cwd))) {
      if (file.endsWith('.json') && managedDeliveryId(file.slice(0, -5))) ids.add(file.slice(0, -5))
    }
    if (hasGit && checkoutAt(cwd)) {
      for (const ref of gitRefs(cwd).keys()) {
        const id = ref.slice('refs/heads/akb/'.length)
        if (ref.startsWith('refs/heads/akb/') && managedDeliveryId(id)) ids.add(id)
      }
    }
    if (!ids.size) {
      if (!directory(root)) return
      const release = await lockDeliveryProject(cwd, () => false, false)
      try { if (release) removeEmpty(root) } finally { release?.() }
      return
    }
    const link = linkedProject(boardOf(cwd), cwd)
    if (!link.ok || !link.value || !directory(boardOf(cwd))) return
    const project = link.value
    const state = projectStateDir(boardOf(cwd), cwd)
    if (!directory(state)) return

    for (const id of ids) {
      try {
        const current = registry(state)
        const delivery = deliveryOf(current, cwd, id)
        if (delivery?.status !== 'finished') continue
        const dir = path.join(root, id)
        const worktree = path.relative(cwd, path.join(dir, 'work'))
        requireCleanup(delivery.worktree === worktree && delivery.endedAt, 'The delivery does not have a managed workspace.')
        const receipt = await archiveReceipt(cwd, project, delivery, current)
        const release = await lockDeliveryProject(cwd, () => false, false)
        if (!release) { warn(cwd, id, 'The delivery project is locked.'); continue }
        try {
          withLock(path.join(state, SESSIONS_LOCK), 'checking finished delivery workspaces', () => {
            const verify = () => {
              const current = registry(state)
              const fresh = deliveryOf(current, cwd, id)
              requireCleanup(fresh?.status === 'finished' && fresh.cardId === receipt.card && fresh.worktree === worktree &&
                fresh.endedAt === delivery.endedAt && fresh.branch === delivery.branch && fresh.base === delivery.base &&
                fresh.targetBranch === delivery.targetBranch && fresh.landing?.commit === delivery.landing?.commit,
              'The delivery changed during cleanup.')
              directory(root)
              directory(dir)
            }
            verify()
            requireCleanup(receipt.synced || syncedDeliveryArchive(cwd, project, receipt.card, receipt.task)?.archive.seq === receipt.seq,
              'The archive version changed during cleanup.')
            if (!receipt.synced) saveDeliveryCleanupReceipt(cwd, { ...receipt, synced: true })
            verifyRuns(registry(state), delivery, cwd, dir, receipt.task)
            if (directory(dir)) requireCleanup(workspaceUnoccupied(dir), 'A process is still using the delivery workspace.')
            if (delivery.branch || delivery.targetBranch || delivery.base) gitCleanup(cwd, delivery, verify)
            else {
              requireCleanup(!entryAt(path.join(cwd, '.git')) && !checkoutAt(cwd),
                'The directory delivery belongs to a Git checkout now.')
              const copies = ['work', 'base'].map(name => path.join(dir, name))
              for (const copy of copies) {
                if (directory(copy)) requireCleanup(!entryAt(path.join(copy, '.git')),
                  'A delivery copy contains a Git checkout.')
              }
              for (const copy of copies) {
                verify()
                if (directory(copy)) fs.rmSync(copy, { recursive: true })
              }
            }
            verify()
            removeEmpty(dir)
            requireCleanup(!directory(dir), 'The delivery directory contains files outside the managed copies.')
            fs.rmSync(receiptFile(cwd, id), { force: true })
            removeEmpty(root)
          })
        } finally { release() }
      } catch (error) { warn(cwd, id, error) }
    }
  } catch (error) { warn(cwd, '(project)', error) }
}

const queued = new Set<string>()

export function queueDeliveryCleanup(cwd: string): void {
  if (queued.has(cwd)) return
  queued.add(cwd)
  setTimeout(() => {
    void cleanDeliveryWorkspaces(cwd).finally(() => queued.delete(cwd))
  }, 1_000).unref()
}
