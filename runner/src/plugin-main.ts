// The plugins' local component (plugin.ts), as the host starts it: `codex`, `cursor`, `dsh` or `kimi` from those plugins,
// and the Claude Code plugin from Claude Code or ZCode.

import { hostOf, main } from './plugin'

void main(hostOf(process.argv[2], process.env))
