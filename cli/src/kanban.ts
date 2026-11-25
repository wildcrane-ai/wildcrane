// The board's bookkeeping, as the one file every copy of it ships as.
//
// The rules live in this package's `src/`, in TypeScript, and are built into a single
// dependency-free file — `cli/dist/kanban.mjs` — by `scripts/build.mjs`. That one built
// file is what the npm package and the Runner carry. Edit the sources here; never the
// built file, which is not even in git.
//
// 既可直接运行，也可作为模块导入。

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { runAgent } from './lib/agent-cli'
import { commandWord, rawArgv, runBoard } from './lib/board-cli'
import { shellWord } from './lib/paths'
import { SKILL_VERSION } from './version'

// What `bin/ai4kanban.mjs` loads.
export { rawArgv, runAgent, runBoard }

const SELF = fileURLToPath(import.meta.url)

// True when this file IS the program, rather than something another program imported.
// Both sides are resolved through their real path first: this repo installs its own skill
// as a symlink, and the two spellings of the same file must still count as one.
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fs.realpathSync(entry) === fs.realpathSync(SELF)
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const argv = process.argv.slice(2)
  const program = `node ${shellWord(SELF)}`
  const word = commandWord(argv)
  const legacy = new Set(['create', 'update-questions', 'conflict', 'list', 'inspect', 'validate', 'file',
    'agent-file', 'memory-file', 'reject', 'init', 'card', 'previews', 'components', 'reflect',
    'review-dismissals', 'describe-project', 'version'])
  // Older callers also address board moves directly on the bundled rules.
  const result = legacy.has(word)
    ? runBoard(argv, { program, version: `wildcrane ${SKILL_VERSION}` })
    : runAgent(argv, { program })
  void result.then((code) => { process.exitCode = code })
}
