import { existsSync } from 'node:fs'
import { home } from '../harnesses/models'

export function antigravityConversationFile(session: string): string | undefined {
  if (/^[a-f0-9-]{36}$/i.test(session)) return home('.gemini', 'antigravity-cli', 'conversations', `${session}.db`)
}

function varint(bytes: Uint8Array, offset: { value: number }): number {
  let value = 0
  for (let shift = 0; shift < 70 && offset.value < bytes.length; shift += 7) {
    const byte = bytes[offset.value++]!
    value += (byte & 127) * 2 ** shift
    if (byte < 128) return value
  }
  throw new Error('Invalid Antigravity conversation metadata')
}

export function* fields(bytes: Uint8Array): Generator<[number, number | Uint8Array]> {
  const offset = { value: 0 }
  while (offset.value < bytes.length) {
    const tag = varint(bytes, offset)
    const number = Math.floor(tag / 8)
    const wire = tag % 8
    if (number < 1 || number >= 2 ** 29) throw new Error('Invalid Antigravity conversation metadata')
    if (wire === 0) {
      yield [number, varint(bytes, offset)]
      continue
    }
    const size = wire === 2 ? varint(bytes, offset) : wire === 1 ? 8 : wire === 5 ? 4 : -1
    const end = offset.value + size
    if (size < 0 || end > bytes.length) throw new Error('Invalid Antigravity conversation metadata')
    if (wire === 2) yield [number, bytes.subarray(offset.value, end)]
    offset.value = end
  }
}

function bytesField(data: unknown, field: number): Uint8Array | undefined {
  if (!(data instanceof Uint8Array)) return
  for (const [number, value] of fields(data)) {
    if (number === field && value instanceof Uint8Array) return value
  }
}

function varintField(data: unknown, field: number): number | undefined {
  if (!(data instanceof Uint8Array)) return
  for (const [number, value] of fields(data)) {
    if (number === field && typeof value === 'number') return value
  }
}

export function stepIndices(data: Uint8Array): number[] {
  const out: number[] = []
  for (const [field, value] of fields(data)) {
    if (field !== 2) continue
    if (typeof value === 'number') out.push(value)
    else {
      const offset = { value: 0 }
      while (offset.value < value.length) out.push(varint(value, offset))
    }
  }
  return out
}

function recordedContextLimit(data: Uint8Array): number | undefined {
  const limit = varintField(bytesField(bytesField(bytesField(data, 1), 9), 10), 4)
  return limit !== undefined && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined
}

const utf8 = (bytes: Uint8Array | undefined) => bytes && Buffer.from(bytes).toString('utf8')

type StepLookup = { get(index: number): Record<string, unknown> | undefined }

function stepUuid(stepRow: StepLookup, index: number): Uint8Array | undefined {
  if (!Number.isSafeInteger(index) || index < 0) return
  const id = bytesField(stepRow.get(index)?.metadata, 12)
  return id?.length === 36 ? id : undefined
}

/** agy records each generation's invocation UUID, step indices and returned model in gen_metadata. */
export function antigravityRecordedModels(session: string, steps: ReadonlyMap<number, { prompt: number }>): Map<number, string | undefined> {
  const found = new Map<number, string | undefined>()
  if (!steps.size) return found
  const file = antigravityConversationFile(session)
  if (!file || !existsSync(file)) return found
  try {
    // The standalone CLI can also run on Node versions without SQLite.
    const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined
    if (!sqlite) return found
    const db = new sqlite.DatabaseSync(file, { readOnly: true })
    try {
      const stepRow = db.prepare('SELECT metadata FROM steps WHERE idx = ?')
      const promptIds = new Map<number, Uint8Array | undefined>()
      const promptUuid = (prompt: number) => {
        if (!promptIds.has(prompt)) promptIds.set(prompt, stepUuid(stepRow, prompt))
        return promptIds.get(prompt)
      }
      const groups = new Map<string, { id: Uint8Array; steps: Set<number> }>()
      for (const [index, { prompt }] of steps) {
        if (!Number.isSafeInteger(index) || index < 0) continue
        const id = stepUuid(stepRow, index) ?? promptUuid(prompt)
        if (!id) continue
        const uuid = utf8(id)!
        let group = groups.get(uuid)
        if (!group) groups.set(uuid, group = { id, steps: new Set() })
        group.steps.add(index)
      }
      const generations = db.prepare('SELECT data FROM gen_metadata WHERE instr(data, ?) > 0')
      for (const [uuid, { id, steps: groupSteps }] of groups) {
        // Field 4 is the invocation UUID. Filter the blobs in SQLite before decoding them.
        const key = Buffer.concat([Buffer.from([0x22, 36]), id])
        for (const { data } of generations.iterate(key)) {
          if (!(data instanceof Uint8Array) || utf8(bytesField(data, 4)) !== uuid) continue
          const model = utf8(bytesField(bytesField(data, 1), 19)) || undefined
          for (const step of stepIndices(data)) {
            if (!groupSteps.has(step)) continue
            found.set(step, found.has(step) && found.get(step) !== model ? undefined : model)
          }
        }
      }
    } finally {
      db.close()
    }
    return found
  } catch {
    return new Map()
  }
}

/** agy records each generation's effective context window limit in gen_metadata (1.9.10.4). */
export function antigravityRecordedContextLimit(session: string, step: number, prompt: number): number | undefined {
  if (!Number.isSafeInteger(step) || step < 0) return
  const file = antigravityConversationFile(session)
  if (!file || !existsSync(file)) return
  try {
    const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined
    if (!sqlite) return
    const db = new sqlite.DatabaseSync(file, { readOnly: true })
    try {
      const stepRow = db.prepare('SELECT metadata FROM steps WHERE idx = ?')
      const id = stepUuid(stepRow, step) ?? stepUuid(stepRow, prompt)
      if (!id) return
      const key = Buffer.concat([Buffer.from([0x22, 36]), id])
      const generations = db.prepare('SELECT data FROM gen_metadata WHERE instr(data, ?) > 0')
      let found: number | undefined
      let matched = false
      for (const { data } of generations.iterate(key)) {
        if (!(data instanceof Uint8Array) || utf8(bytesField(data, 4)) !== utf8(id)) continue
        if (!stepIndices(data).includes(step)) continue
        const limit = recordedContextLimit(data)
        if (matched && found !== limit) return
        found = limit
        matched = true
      }
      return found
    } finally {
      db.close()
    }
  } catch {
    return
  }
}
