// The runtimes' keys (#2135), kept on this computer only: Cloud hands one over in a job and keeps
// nothing but whether it is set. One file, readable by this user alone, by runtime id.

import fs from 'node:fs'
import path from 'node:path'
import { readRuntimeCredentials } from '../../cli/src/lib/agent/runtimes'

import { runnerHome } from './home'

export const runtimeCredentialsFile = () => path.join(runnerHome(), 'secrets.json')

const readAll = () => readRuntimeCredentials(runtimeCredentialsFile())

/** One runtime's keys, by setting key. */
export const secretsOf = (runtime: string | null | undefined): Record<string, string> => (runtime ? readAll()[runtime] ?? {} : {})

/** Sets each key given, and clears each given null. */
export function keepSecrets(runtime: string, given: Record<string, string | null>): void {
  const all = readAll()
  const held = { ...all[runtime] }
  for (const [key, value] of Object.entries(given)) {
    if (value) held[key] = value
    else delete held[key]
  }
  if (Object.keys(held).length) all[runtime] = held
  else delete all[runtime]
  fs.mkdirSync(runnerHome(), { recursive: true, mode: 0o700 })
  const file = runtimeCredentialsFile()
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(all)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

/** Which keys each runtime holds here — what the Runner reports, never the keys. */
export const secretsSet = (): Record<string, string[]> =>
  Object.fromEntries(Object.entries(readAll()).map(([id, keys]) => [id, Object.keys(keys)]))
