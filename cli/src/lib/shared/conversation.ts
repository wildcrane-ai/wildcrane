/** Shared conversation deadlines; refresh and retries keep the original start time. */
export const CONVERSATION_MS = { send: 15_000, claim: 30_000, prepare: 60_000, start: 15_000, startup: 120_000, quiet: 60_000, stop: 10_000 } as const
export const CONVERSATION_PHASES = ['preparing', 'initialized', 'ready', 'submitted', 'started'] as const
export type ConversationPhase = typeof CONVERSATION_PHASES[number]

export function bounded<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), Math.max(0, ms))
    work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
