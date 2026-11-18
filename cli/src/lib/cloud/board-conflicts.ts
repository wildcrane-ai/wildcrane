import { cloudEndpoints } from './config'
import { accessToken } from './session'
import { executionHeld, executionOf } from './execution'
import { BoardError } from '../io'
import { linkedProject } from './tasks'
import { stateRootOf } from '../machine/project'
import { resolveConflict, type BoardFile, type Receipt } from '../shared/board-conflicts'

export async function submitConflict(board: string, id: string, expect: string, value: unknown) {
  const link = linkedProject(board, stateRootOf(board))
  if (!link.ok || !link.value) throw new BoardError(link.ok ? 'This board is not linked to a Cloud project.' : link.error, { kind: 'cloud-refused', id })
  const execution = executionOf()
  if (!execution) throw new BoardError('Resolve this conflict from a current task execution.', { kind: 'cloud-refused', id })
  async function request<T>(method: string, route: string, body?: unknown): Promise<{ ok: true; value: T } | { ok: false; error: string; code?: string; files?: BoardFile[] }> {
    const auth = await accessToken()
    if (!auth.ok) return { ok: false, code: 'unauthenticated', error: 'Sign in to Cloud before submitting.' }
    try {
      const response = await fetch(`${cloudEndpoints().api}${route}`, {
        method, headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
      })
      const parsed = await response.json() as T & { error?: { code?: string; message?: string }; files?: BoardFile[] }
      return response.ok ? { ok: true, value: parsed } : { ok: false, code: parsed.error?.code ?? 'refused', error: parsed.error?.message ?? `Cloud answered ${response.status}.`, ...(parsed.files ? { files: parsed.files } : {}) }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  }
  const route = (project: string) => `/v1/projects/${encodeURIComponent(project)}/board`
  return resolveConflict(board, link.value, id, expect, value, {
    held: () => executionHeld(execution),
    read: project => request<{ head_seq: number; files: BoardFile[] }>('GET', `${route(project)}?since=0`),
    commit: (project, files) => request<Receipt>('POST', `${route(project)}/commits`, { ...execution, files }),
  })
}
