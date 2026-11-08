// The plugins' local component (plugin.ts), as the host starts it: `codex` or `cursor` from those plugins.

import { main } from './plugin'

const as = process.argv[2]
void main(as === 'codex' || as === 'cursor' ? as : 'claude-code')
