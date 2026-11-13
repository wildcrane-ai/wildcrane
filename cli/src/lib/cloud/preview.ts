export const PREVIEW_BRIDGE_ENV = 'AI4KANBAN_PREVIEW_BRIDGE'
export async function previewBridge(agent: string, operation: string, fields: Record<string, unknown>): Promise<{ progress: import('../preview-stages').PreviewProgress | null; baseline?: import('../preview-stages').PreviewBaseline | null } | null> {
  const raw = process.env[PREVIEW_BRIDGE_ENV]
  if (!raw) return null
  const context = JSON.parse(raw) as { url: string; token: string }
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(context.url) || !/^[a-f0-9]{64}$/.test(context.token)) throw Error('Invalid preview execution context.')
  const response = await fetch(context.url, { method: 'POST', headers: { authorization: `Bearer ${context.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agent, operation, ...fields }), signal: AbortSignal.timeout(120_000) })
  const result = await response.json() as { ok: boolean; error?: string; value?: { progress: import('../preview-stages').PreviewProgress | null; baseline?: import('../preview-stages').PreviewBaseline | null } }
  if (!result.ok || !result.value) throw Error(result.error ?? 'Could not save the preview.')
  return result.value
}
