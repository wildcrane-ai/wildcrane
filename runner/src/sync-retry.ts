import type { Call, Job } from './api'
import { temporaryCloudFailure } from './api'
import { cloudLanguage } from '../../cli/src/lib/agent/language'

export const syncBackoff = (attempt: number) => 1_000 * 2 ** (attempt - 1)

export type SyncStep = 'authorize' | 'renew' | 'prepare' | 'studios' | 'chats' | `chat:${string}` | `decisions:${string}`
  | `reply-image:${string}` | 'reply-history' | 'init' | 'create' | 'create-sync' | 'review' | 'previews' | 'reconcile' | 'repair' | 'publish' | 'confirm' | 'finish'
export type Sync = <T>(step: SyncStep, operation: () => Promise<Call<T>>) => Promise<Call<T>>

export const syncStopped = { ok: false, code: 'stopped', error: 'Task preparation stopped.' } as const

type SyncRefusal = Extract<Call<unknown>, { ok: false }>

export const staleArchiveReceipt = ({ code, error }: SyncRefusal) => code === 'version_conflict'
  || code === 'conflict' && error === 'The current card and attachment archive versions must be synchronized.'

export const landLeaseLost = ({ code, error }: SyncRefusal) => code === 'conflict' && [
  'The Land job no longer holds the project lease.', 'This job has ended or moved to another computer.',
].includes(error)

export const resumeArchive = (job: Job) => cloudLanguage(job) === 'zh'
  ? 'Cloud 未能确认已保存的归档。请在保存交付的运行电脑上继续任务。'
  : 'Cloud could not confirm the saved archive. Resume the task on the Runner computer that holds the delivery.'

export function landArchiveRefusal(job: Job, failure: SyncRefusal): string {
  const zh = cloudLanguage(job) === 'zh'
  if (failure.code === 'conflict' && ['Land no longer has review authorization.', 'The current Land job must synchronize this archive.'].includes(failure.error)) {
    return zh ? 'Land 的审核授权已变化。请确认当前审核后继续任务。'
      : 'Land review authorization changed. Confirm the current review and resume the task.'
  }
  if (failure.code === 'board_content_conflict') {
    return zh ? '归档的看板文件有冲突。请参照 akb guide resolve-conflict 解决后继续任务。'
      : 'The archive has board content conflicts. Follow akb guide resolve-conflict, then resume the task.'
  }
  if (failure.failure?.code === 'land_archive_sync') {
    return zh ? '无法核对本地归档。请检查这台运行电脑上的归档卡片和附件，然后继续任务。'
      : 'The saved archive could not be verified. Check the archived card and attachments on this computer, then resume the task.'
  }
  if (failure.failure?.source === 'validation') return failure.failure.summary
  if (['unauthenticated', 'machine_offline', 'quota_exceeded', 'storage_limit_reached', 'daily_write_budget_reached', 'bad_request'].includes(failure.code ?? '')) {
    return syncRefusal(job, failure)
  }
  return resumeArchive(job)
}

export function syncRefusal(job: Job, failure: Extract<Call<unknown>, { ok: false }>): string {
  const zh = cloudLanguage(job) === 'zh'
  if (retryableSync(failure) || ['retry_exhausted', 'task_recovery_unverified'].includes(failure.code ?? '')) return failure.error
  switch (failure.code) {
    case 'unauthenticated':
      return zh ? '请在运行电脑上重新登录 WildCrane。' : 'Sign in to WildCrane on the Runner computer.'
    case 'machine_offline':
      return zh ? '请连接运行电脑。' : 'Connect the Runner computer.'
    case 'quota_exceeded':
      return /takes files up to/i.test(failure.error)
        ? zh ? '请缩小超出额度的附件。' : 'Reduce the size of the attachment.'
        : zh ? '请释放附件空间或升级额度。' : 'Free up attachment storage or upgrade your plan.'
    case 'storage_limit_reached':
      return zh ? '请释放 Cloud 存储空间。' : 'Free up Cloud storage.'
    case 'daily_write_budget_reached':
      return zh ? '每日写入额度于 UTC 零点恢复。' : 'The daily write allowance resets at midnight UTC.'
    case 'bad_request':
      return failure.failure?.source === 'validation' ? failure.error
        : zh ? '请检查卡片内容和预览附件。' : 'Check the card and its preview attachments.'
    case 'review_outdated':
      return job.chat
        ? zh ? '保存期间预览已被再次修订。请开启一轮新回复。' : 'The Preview was revised while this reply was saving. Start a new reply.'
        : failure.error
    case 'board_content_conflict':
    case 'version_conflict':
      return zh ? '请处理看板同步冲突。' : 'Resolve the board sync conflict.'
    default:
      return failure.error
  }
}

export const retryableSync = (failure: Extract<Call<unknown>, { ok: false }>) => !failure.failure && temporaryCloudFailure(failure)

export function writeBlock(failure: { code?: string; status?: number; error: string }): 'storage' | 'allowance' | undefined {
  if (failure.code === 'daily_write_budget_reached') return 'allowance'
  if (failure.code === 'storage_limit_reached' || failure.code === 'quota_exceeded' && failure.status !== 413 && /free up space/i.test(failure.error)) return 'storage'
}
