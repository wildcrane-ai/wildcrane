import { mkdtempSync } from 'node:fs'
import path from 'node:path'

const root = process.env.WILDCRANE_TEST_HOME_ROOT
if (root && !process.env.WILDCRANE_HOME && process.env.NODE_TEST_CONTEXT === 'child-v8') {
  // Node preloads before the test imports modules that read these directories.
  const home = mkdtempSync(path.join(root, 'home-'))
  process.env.WILDCRANE_HOME = home
  process.env.AI4KANBAN_HOME = home
}
