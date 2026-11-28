// Where the Runner keeps its files: the sign-in, this computer's id, the versions the
// launcher downloaded, the allowed project folders and the Runner's own working folder.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { readRunnerMachineId, runnerHome, runnerMachineFile } from '../../cli/src/lib/machine/runner'
import { followProxy } from './proxy'

export { runnerHome }

/** Background children must not inherit a project or version directory an updater can remove. */
export function runnerCwd(): string {
  const dir = runnerHome()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** The CLI's session code reads its folder from `AI4KANBAN_HOME`; point it here. Every entry calls this, so the proxy is re-read here too. */
export function useRunnerHome(): void {
  process.env.AI4KANBAN_HOME = runnerHome()
  followProxy()
  setInterval(followProxy, 60_000).unref()
}

/** This computer's id, minted once. Opaque to Cloud: only equality is read. */
export function machineId(): string {
  const held = readRunnerMachineId()
  if (held) return held
  const id = crypto.randomUUID()
  fs.mkdirSync(runnerHome(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(runnerMachineFile(), `${JSON.stringify({ id })}\n`)
  return id
}

export const machineName = (): string => os.hostname().replace(/\.local$/, '')
