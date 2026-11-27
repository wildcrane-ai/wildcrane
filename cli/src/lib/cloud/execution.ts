import { cloudEndpoints } from './config'
import { accessToken } from './session'

export interface CloudExecution { job: string; machine: string; card?: number }
export const WRONG_TASK = 'This execution belongs to a different task. Start the other task through Cloud.'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function executionOf(value: unknown = process.env.AI4KANBAN_EXECUTION): CloudExecution | undefined {
  try {
    const held = typeof value === 'string' ? JSON.parse(value) : value
    if (held && UUID.test(held.job) && UUID.test(held.machine)) {
      const card = Number.isSafeInteger(held.card) && held.card > 0 ? held.card as number : undefined
      return { job: held.job, machine: held.machine, ...(card === undefined ? {} : { card }) }
    }
  } catch {}
  return undefined
}

/** 落地前向服务端确认执行权；断网、停止或换机均保留本地交付。 */
export async function executionHeld(execution?: CloudExecution): Promise<boolean> {
  if (!execution) return true
  try {
    const auth = await accessToken()
    if (!auth.ok) return false
    const response = await fetch(`${cloudEndpoints().api}/v1/runner/jobs/${execution.job}/renew`, {
      method: 'POST', headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ machineId: execution.machine }), signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) return false
    const held = await response.json() as { renewed?: boolean; stop?: boolean }
    return held.renewed === true && held.stop !== true
  } catch { return false }
}
