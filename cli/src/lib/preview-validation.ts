export function renderError(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const { message, stack } = error as { message?: string; stack?: string }
  const location = stack?.split('\n').find(line => /^\s*at /.test(line) && /\.(?:tsx?|jsx?|mjs):\d+/.test(line))?.trim()
  const reason = message ?? String(error)
  return location && !reason.includes(location) ? `${reason} (${location})` : reason
}
