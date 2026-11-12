import type { TokenUsage } from '../types'

export const ZERO_USAGE: TokenUsage = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 }

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, cacheCreation: a.cacheCreation + b.cacheCreation, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output }
}

/** A cumulative reading without its starting point is unknown. */
export function ownUsage(total: TokenUsage | undefined, before: TokenUsage | undefined): TokenUsage | undefined {
  if (!total || !before) return undefined
  const own = { input: total.input - before.input, cacheCreation: total.cacheCreation - before.cacheCreation, cacheRead: total.cacheRead - before.cacheRead, output: total.output - before.output }
  return Object.values(own).every(n => Number.isFinite(n) && n >= 0) ? own : undefined
}
