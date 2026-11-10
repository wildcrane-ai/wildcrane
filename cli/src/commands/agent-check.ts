// `akb agent check <agent>`: whether WildCrane can run this agent here, and what is missing.
// Pasted install prompts end on it, so the AI tool installing an agent can tell when it is done.

import { spawnSync } from 'node:child_process'

import { HARNESSES } from '../lib/agent/harnesses'
import { dshFound } from '../lib/agent/harnesses/dsh'
import { binaryOnPath, commandBinary } from '../lib/agent/installed'
import { copyEnv, locate } from '../lib/agent/locate'
import { spawnable } from '../lib/agent/spawnable'
import { say } from '../lib/io'
import { die } from '../lib/paths'

function run(file: string, args: string[]): { out: string; error?: string } {
  const start = spawnable(file, args, { env: copyEnv(file), stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
  const ran = spawnSync(start.command, start.args, { ...start.options, encoding: 'utf8' })
  return { out: `${ran.stdout ?? ''}${ran.stderr ?? ''}`.trim(), error: ran.error?.message }
}

export function cmdAgentCheck(name: string): Record<string, unknown> {
  const wanted = name.trim().toLowerCase()
  const harness = HARNESSES.find((h) => h.name === wanted || h.label.toLowerCase() === wanted || commandBinary(h.command) === wanted)
  if (!harness) die(`unknown agent "${name}" — one of ${HARNESSES.map((h) => h.name).join(', ')}`, { kind: 'bad-args' })
  const binary = commandBinary(harness.command)
  const copy = locate(harness, 0)
  const answer = { agent: harness.name, file: copy?.file ?? null, version: copy?.version ?? null }
  if (!copy) die(`${harness.label} not found: no \`${binary}\` on the PATH or in its usual install folders.`, { kind: 'agent-missing' })
  if (!copy.starts) {
    const said = run(copy.file, ['--version'])
    die(`${harness.label} at ${copy.file} failed to start: ${said.error ?? said.out.split('\n')[0] ?? 'no output'}`, { kind: 'agent-broken' })
  }
  if (harness.name === 'dsh' && !dshFound(copy.file, binaryOnPath)) {
    die(`${harness.label}: dsh-acp is installed, but the dsh it starts is not — install dsh beside it or on the PATH.`, { kind: 'agent-missing' })
  }
  if (harness.login) {
    const said = run(copy.file, harness.login.args).out
    if (!harness.login.ready(said) && harness.login.loggedOut(said)) {
      die(`${harness.label} is signed out: run \`${harness.login.login}\`.`, { kind: 'agent-signed-out' })
    }
  }
  say(`${harness.label} is ready${copy.version ? ` (${copy.version})` : ''}: ${copy.file}`)
  return { ...answer, ready: true }
}
