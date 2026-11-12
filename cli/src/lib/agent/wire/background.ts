/** Background work is identified by the adapter; the run owns its waiting policy. */
export function createBackgroundTasks() {
  const tasks = new Map<string, { status: 'running' | 'completed' | 'failed'; result: string }>()
  return {
    update(id: string, status: 'running' | 'completed' | 'failed', result = ''): boolean {
      if (!id) return false
      const previous = tasks.get(id)
      if (previous?.status === status && previous.result === result) return false
      tasks.set(id, { status, result })
      return true
    },
    results: () => [...tasks].map(([id, task]) => ({ id, ...task })),
    running: () => [...tasks].filter(([, t]) => t.status === 'running').map(([id]) => id),
    count: () => [...tasks.values()].filter(t => t.status === 'running').length,
    failure: () => [...tasks].filter(([, t]) => t.status === 'failed').map(([id, t]) => t.result || `Background task ${id} failed.`).join('\n') || undefined,
  }
}

/** A reply alone does not close a multi-turn stream. */
export function streamFinished(stream: { result(): string | undefined; background?(): number | undefined; turns?(): { background: number }[] }): boolean {
  if (stream.background?.()) return false
  const turns = stream.turns?.()
  return turns ? !!turns.length && !turns.at(-1)!.background : stream.result() !== undefined
}

/** Polling does not extend this deadline. A final reply or close disposes it. */
export function createBackgroundWait(milliseconds: number, expired: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    pending() {
      if (!timer && milliseconds > 0) timer = setTimeout(expired, milliseconds)
    },
    close() { clearTimeout(timer); timer = undefined },
  }
}

export const backgroundWaitMessage = (minutes: number): string =>
  `the agent's background tasks did not finish within ${minutes / 60} hours, so the run was ended.`
