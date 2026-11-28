import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach } from 'node:test'
import { stopFlowWorker } from '../src/flow-worker'
import { runnerHome } from '../src/home'
import { FakeCloud, until, writeFakeSession } from './fake-cloud'

const machine = '44444444-4444-4444-8444-444444444444'
const entry = process.env.RUNNER_TEST_FLOW_HOST!
let cloud: FakeCloud
let host: ChildProcess | undefined
let log = ''
const folder = () => path.join(runnerHome(), 'project')
const gate = (n: number) => path.join(runnerHome(), `gate-${n}`)
const calls = () => fs.existsSync(process.env.FAKE_AKB_LOG!)
  ? fs.readFileSync(process.env.FAKE_AKB_LOG!, 'utf8').split('\n').slice(0, -1).map((line) => JSON.parse(line) as string[])
  : []
const commands = (verb: string) => calls().filter((c) => c[0] === 'raw' && (verb === 'preview' ? c[1] === 'previews' && c[2] === 'designer' : c[1] === 'card' && c[2] === verb))
const launch = () => {
  host = spawn(process.execPath, [entry], { env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  host.stderr!.on('data', (s) => { log += s })
  host.stdout!.on('data', (s) => { log += s })
  return host
}
const exit = async (signal: 'SIGKILL' | 'SIGTERM' | 'update') => {
  const child = host!
  const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  if (signal === 'update') child.send('update')
  else child.kill(signal)
  await ended
  host = undefined
}

beforeEach(async () => {
  fs.rmSync(runnerHome(), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  writeFakeSession(runnerHome())
  fs.mkdirSync(folder(), { recursive: true })
  fs.writeFileSync(path.join(runnerHome(), 'projects.json'), JSON.stringify({ projects: [folder()] }))
  process.env.FAKE_AKB_LOG = path.join(runnerHome(), 'calls.jsonl')
  process.env.FAKE_AKB_ENTRY = path.join(process.env.RUNNER_DIST!, '../test/fake-akb.mjs')
  log = ''
  cloud = new FakeCloud()
  cloud.folders = [{ project: 'prj_1', name: 'Project', path: folder(), notify: false, machine }]
  cloud.task = { artifacts: new Map(), title: 'Test', request: 'Build it' }
  cloud.put({ 'config.md': '# Configuration\n', 'todo/2-test.md': '---\ntitle: Test\nstudio: coding\nquestions: []\n---\n\nBuild it.\n' })
  await cloud.start()
})
afterEach(async () => {
  await stopFlowWorker('job', 4000).catch(() => {})
  if (host && host.exitCode === null) await exit('SIGTERM')
  await cloud.stop()
})

const reclaimed = (file: string) => until(() => !fs.existsSync(file), 10_000)

const recordOf = (id: string) => path.join(runnerHome(), 'flow-workers', `${encodeURIComponent(id)}.json`)

export { recordOf, machine, cloud, host, log, folder, gate, calls, commands, launch, exit, reclaimed }
