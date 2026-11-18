export interface Model { id: string; name: string }
export type ModelSource = (signal: AbortSignal) => Promise<Model[]> | Model[]
export const MODEL_REFRESH_MS = 30_000
export const MODEL_TIMEOUT_MS = 15_000

/** Every source shares one retry, timeout and last-success policy. */
export class ModelLists<Key extends string> {
  private listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private entries = new Map<Key, { models: Model[]; next: number; pending?: Promise<Model[]> }>()

  constructor(private sources: Partial<Record<Key, ModelSource>>, private interval = MODEL_REFRESH_MS, private timeout = MODEL_TIMEOUT_MS) {}

  async read(key: Key, previous: Model[] = [], wait = false): Promise<Model[]> {
    const source = this.sources[key]
    if (!source) return previous
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { models: normalizeModels(previous), next: 0 }
      this.entries.set(key, entry)
    }
    if (!entry.models.length && previous.length) entry.models = normalizeModels(previous)
    if (!entry.pending && Date.now() >= entry.next) {
      const held = entry
      const controller = new AbortController()
      held.next = Date.now() + this.interval
      let changed = false
      held.pending = new Promise<Model[]>((resolve) => {
        let done = false
        const finish = (models: Model[]) => {
          if (done) return
          done = true
          clearTimeout(timer)
          controller.abort()
          const found = normalizeModels(models)
          if (found.length) {
            changed = JSON.stringify(found) !== JSON.stringify(held.models)
            held.models = found
          }
          resolve(held.models)
        }
        const timer = setTimeout(() => finish([]), this.timeout)
        Promise.resolve().then(() => source(controller.signal)).then(finish, () => finish([]))
      }).finally(() => {
        held.pending = undefined
        if (changed) for (const listener of this.listeners) listener()
      })
    }
    return wait && entry.pending ? entry.pending : entry.models
  }
}

export function normalizeModels(models: Model[]): Model[] {
  const seen = new Set<string>()
  return models.flatMap((model) => {
    const id = model.id.trim()
    if (!id || seen.has(id)) return []
    seen.add(id)
    return [{ id, name: model.name.trim() || id }]
  })
}
