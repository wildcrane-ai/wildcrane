// Suggestions follow local CLI data and never restrict manual model IDs.

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** A path under the user's home folder. */
export function home(...parts: string[]): string {
  return join(homedir(), ...parts)
}

export function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function num(value: unknown): number {
  return typeof value === 'number' ? value : Number.MAX_SAFE_INTEGER
}

/** The ids given, in the order given, without blanks or repeats. */
export function uniqueIds(list: string[]): string[] {
  return [...new Set(list.map((id) => id.trim()).filter(Boolean))]
}

const cached = new Map<string, { stamp: string; found: string[] }>()

/** The ids `pick` finds in a JSON file. `salt` belongs to a read whose answer depends on
 *  something outside the file — OpenCode's catalogue is cut down to the providers a second
 *  file names — so the cache turns over when that changes too. */
export function modelsIn(
  file: string,
  pick: (data: unknown) => string[],
  salt = '',
): string[] {
  let stamp: string
  try {
    const stat = statSync(file)
    stamp = `${stat.mtimeMs}:${stat.size}:${salt}`
  } catch {
    return cached.get(file)?.found ?? []
  }
  const hit = cached.get(file)
  if (hit?.stamp === stamp) return hit.found
  let found: string[] = []
  try {
    found = uniqueIds(pick(JSON.parse(readFileSync(file, 'utf8'))))
  } catch {
    found = []
  }
  if (found.length) cached.set(file, { stamp, found })
  return found.length ? found : hit?.found ?? []
}
