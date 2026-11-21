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
      return zh ? '请在运行电脑上重新登录 WildCrane，。' : 'Sign in to WildCrane on the Runner computer.'
    case 'machine_offline':
      return zh ? '请连接运行电脑，。' : 'Connect the Runner computer.'
    case 'quota_exceeded':
      return /takes files up to/i.test(failure.error)
        ? zh ? '请缩小超出额度的附件，。' : 'Reduce the size of the attachment.'
        : zh ? '请释放附件空间或升级额度，。' : 'Free up attachment storage or upgrade your plan.'
    case 'storage_limit_reached':
      return zh ? '请释放 Cloud 存储空间，。' : 'Free up Cloud storage.'
    case 'daily_write_budget_reached':
      return zh ? '每日写入额度于 UTC 零点恢复。' : 'The daily write allowance resets at midnight UTC.'
    case 'bad_request':
      return failure.failure?.source === 'validation' ? failure.error
        : zh ? '请检查卡片内容和预览附件，。' : 'Check the card and its preview attachments.'
    case 'board_content_conflict':
    case 'version_conflict':
      return zh ? '请处理看板同步冲突，。' : 'Resolve the board sync conflict.'
    default:
      return failure.failure?.source === 'validation' ? failure.error
        : zh ? '同步未完成。请检查任务状态后恢复。' : 'Sync could not finish. Check the task status.'
  }
}

export const retryableSync = (failure: Extract<Call<unknown>, { ok: false }>) => !failure.failure && temporaryCloudFailure(failure)

export function syncWaitCode(failure: { code?: string; error: string }): 'storage' | 'allowance' | undefined {
  if (failure.code === 'daily_write_budget_reached') return 'allowance'
  if (failure.code === 'storage_limit_reached' || (failure.code === 'quota_exceeded' && !/takes files up to/i.test(failure.error))) return 'storage'
}
