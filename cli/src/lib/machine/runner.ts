import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const runnerHome = (): string => process.env.WILDCRANE_HOME || path.join(os.homedir(), '.wildcrane')

export const runnerMachineFile = (home = runnerHome()): string => path.join(home, 'machine.json')

export function readRunnerMachineId(home = runnerHome()): string | undefined {
  try {
    const { id } = JSON.parse(fs.readFileSync(runnerMachineFile(home), 'utf8'))
    if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) return id
  } catch { /* No readable identity. */ }
}

export function runnerSocketPath(home = runnerHome()): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\wildcrane-${createHash('sha256').update(home).digest('hex').slice(0, 16)}`
  return path.join(home, 'runner.sock')
}

export function probeRunner(file: string): Promise<true | string | undefined> {
  return new Promise(resolve => {
    const socket = net.connect(file)
    const finish = (result?: true | string) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(finish, 1_000)
    socket.once('connect', () => finish(true))
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code))
  })
}

export const runnerGrantsFile = (home = runnerHome()): string => path.join(home, 'projects.json')

interface Grants { projects: string[]; accounts?: Record<string, string[]>; legacyOwner?: string }

export function readRunnerGrants(home = runnerHome()): Grants {
  try {
    const held = JSON.parse(fs.readFileSync(runnerGrantsFile(home), 'utf8')) as Grants
    if (!Array.isArray(held.projects)) throw new Error('invalid_projects')
    return held
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { projects: [] }
    throw error
  }
}

export function runnerGrantsFor(held: Grants, subject?: string): string[] {
  if (!held.accounts) return held.projects
  return subject ? held.accounts[subject] ?? [] : []
}

export function allowedRunnerProjects(home: string, subject?: string): string[] {
  return runnerGrantsFor(readRunnerGrants(home), subject).flatMap(dir => {
    try {
      const real = fs.realpathSync(dir)
      return fs.statSync(real).isDirectory() ? [real] : []
    } catch { return [] }
  })
}
