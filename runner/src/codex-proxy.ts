// Each run owns this small pipe adapter; the Runner owns the actual Codex process.
import net from 'node:net'
import fs from 'node:fs'
import { createInterface } from 'node:readline'

const endpoint = JSON.parse(fs.readFileSync(process.env.WILDCRANE_CODEX_SERVER!, 'utf8')) as { path: string; token: string }
const socket = net.connect(endpoint.path)
const input = createInterface({ input: process.stdin })
const queued: string[] = []
let ready = false
let closing = false
const send = (line: string) => socket.write(line + '\n')
input.on('line', line => ready ? send(line) : queued.push(line))
socket.once('connect', () => {
  send(JSON.stringify({ token: endpoint.token, argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }))
  ready = true
  for (const line of queued) send(line)
})
socket.pipe(process.stdout)
socket.on('error', () => { console.error('Runner Codex connection failed.'); process.exitCode = 1; input.close(); process.stdin.destroy() })
socket.on('close', () => { input.close(); process.stdin.destroy() })
const close = () => {
  if (closing) return
  closing = true
  // The Runner acknowledges only after this run's threads and commands have stopped.
  if (ready) send(JSON.stringify({ method: 'wildcrane/release' }))
  else socket.destroy()
  input.close()
  process.stdin.destroy()
}
input.on('close', close)
process.on('SIGTERM', close)
process.on('SIGINT', close)
