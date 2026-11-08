// Tells the model this session's id, which discuss-goal keeps its goals under, and puts the plugin's
// `akb` first on the PATH of a session started by hand. ZCode runs this plugin too, with no
// CLAUDE_ENV_FILE: there the model passes the id and finds `akb` itself, as in Cursor.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`
const akbDir = path.join(process.env.WILDCRANE_HOME || path.join(os.homedir(), '.wildcrane'), 'bin', 'akb')

let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  if (process.env.WILDCRANE_JOB) return
  const file = process.env.CLAUDE_ENV_FILE
  const session = JSON.parse(input || '{}').session_id
  if (file) {
    // The name the flows print: the running copy's own path otherwise, and "no `akb` on this machine".
    let env = `export PATH=${quote(akbDir)}:"$PATH"\nexport AI4KANBAN_COMMAND=akb\n`
    if (session) env += `export CLAUDE_CODE_SESSION_ID=${quote(session)}\n`
    try { fs.appendFileSync(file, env) } catch {}
  }
  if (!session) return
  const additionalContext = process.env.ZCODE_PLUGIN_ROOT && !file
    ? `WildCrane: this ZCode session's id is ${session}. Run every akb command for discuss-goal as \`CLAUDE_CODE_SESSION_ID=${session} akb ...\`. When \`akb\` is not on PATH, run \`${path.join(akbDir, 'akb')}\` in its place.`
    : `WildCrane: this Claude Code session's id is ${session}. Use akb for discuss-goal.`
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }))
})
