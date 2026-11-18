import type { Call, Job } from './api'
import { temporaryCloudFailure } from './api'
import { cloudLanguage } from '../../cli/src/lib/agent/language'

export const SYNC_RETRY_MAX_MS = 5 * 60_000
export const syncBackoff = (attempt: number) => Math.min(SYNC_RETRY_MAX_MS, 1_000 * 2 ** Math.min(attempt - 1, 9))

export type SyncStep = 'authorize' | 'prepare' | 'create' | 'review' | 'publish' | 'confirm'
export type Sync = <T>(step: SyncStep, operation: () => Promise<Call<T>>) => Promise<Call<T>>

export const syncStopped = { ok: false, code: 'stopped', error: 'Task preparation stopped.' } as const

export function syncRefusal(job: Job, failure: Extract<Call<unknown>, { ok: false }>): string {
  const zh = cloudLanguage(job) === 'zh'
  switch (failure.code) {
    case 'unauthenticated':
      return zh ? '请在运行电脑上重新登录 WildCrane，再续跑。' : 'Sign in to WildCrane on the Runner computer, then resume.'
    case 'machine_offline':
      return zh ? '请连接运行电脑，再续跑。' : 'Connect the Runner computer, then resume.'
    case 'quota_exceeded':
      return /takes files up to/i.test(failure.error)
        ? zh ? '请缩小超出额度的附件，再续跑。' : 'Reduce the size of the attachment, then resume.'
        : zh ? '请释放附件空间或升级额度，再续跑。' : 'Free up attachment storage or upgrade your plan, then resume.'
    case 'storage_limit_reached':
      return zh ? '请释放 Cloud 存储空间，再续跑。' : 'Free up Cloud storage, then resume.'
    case 'daily_write_budget_reached':
      return zh ? '请在每日写入额度于 UTC 零点恢复后续跑。' : 'Resume after the daily write allowance resets at midnight UTC.'
    case 'bad_request':
      return failure.failure?.level === 1 ? failure.error
        : zh ? '请检查卡片内容和预览附件，再续跑。' : 'Check the card and its preview attachments, then resume.'
    case 'board_content_conflict':
    case 'version_conflict':
      return zh ? '请处理看板同步冲突，再续跑。' : 'Resolve the board sync conflict, then resume.'
    default:
      return failure.failure?.level === 1 ? failure.error
        : zh ? '同步未完成。请检查任务状态后续跑。' : 'Sync could not finish. Check the task status, then resume.'
  }
}

export const retryableSync = (failure: Extract<Call<unknown>, { ok: false }>) => !failure.failure && temporaryCloudFailure(failure)
