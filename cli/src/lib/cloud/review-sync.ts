import { die } from '../paths'

export const REVIEW_SYNC_ENV = 'AI4KANBAN_REVIEW_SYNC'

export async function syncPreviewForApproval(task: string): Promise<void> {
  const context = process.env[REVIEW_SYNC_ENV]
  if (!context) return
  const { url, token } = JSON.parse(context) as { url: string; token: string }
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url) || !/^[a-f0-9]{64}$/.test(token)) die('Invalid Preview sync context.')
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ task }),
    signal: AbortSignal.timeout(120_000),
  })
  const result = await response.json() as { ok: boolean; error?: string }
  if (!response.ok || !result.ok) die(result.error ?? 'Preview sync failed.')
}
