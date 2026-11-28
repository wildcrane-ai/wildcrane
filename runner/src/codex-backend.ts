import { spawn } from 'node:child_process'
import { spawnable } from '../../cli/src/lib/agent/spawnable'
import { captureRunnerOutput, logChildOutput } from './runner-log'

// Keep the pipes open for the native backend across Runner restarts.
captureRunnerOutput('worker', { source: 'codex' })
const [command, ...args] = process.argv.slice(2)
const start = spawnable(command!, args, { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
const child = spawn(start.command, start.args, start.options)
logChildOutput(child, 'task', { source: 'codex' })

const reply = (message: { pid?: number; error?: string }) => {
  if (process.connected) process.send?.(message, () => {})
}
child.once('spawn', () => reply({ pid: child.pid }))
child.once('error', error => reply({ error: error.message }))
process.on('message', message => { if (message === 'stop') child.kill('SIGKILL') })
