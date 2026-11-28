import { PDFDocument } from 'pdf-lib'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach } from 'node:test'
import * as api from '../src/api'
import { openTaskFolder, pull } from '../src/task-folder'
import type { RuntimeReport } from '../src/api'
import { startRunner, type Runner } from '../src/connect'
import { runnerHome, useRunnerHome } from '../src/home'
import { createAcpClient } from '../../cli/src/lib/agent/wire'
import { type Deps } from '../src/jobs'
import { type Plan } from '../src/runtimes'
import { FakeCloud, until, writeFakeSession, type FakeJob } from './fake-cloud'

export const withoutTime = (raw: Record<string, unknown> | undefined) => { const { eventAt, ...data } = raw ?? {}; assert.equal(typeof eventAt, 'string'); return data }

type FakeFlow = FakeJob['flow']

// The Runner against a stand-in Cloud, with a fake runtime: a node child that prints.

export const MACHINE = '44444444-4444-4444-8444-444444444444'

export let cloud: FakeCloud
export let runner: Runner | null = null
export const overload = { code: 'service_overloaded', source: 'runtime', summary: 'Selected model is at capacity' } as const
export const validation = { code: 'validation_failed', source: 'validation', summary: 'Schema check failed' } as const
export const disconnect = { code: 'connection_lost', source: 'runtime', summary: 'Temporary network failure' } as const

export let planned: { runtime: string; prompt: string; cwd: string; resume?: string | null; model?: string | null; settings?: unknown; line?: 'zh' | 'en' | null }[] = []
export let installed: RuntimeReport[] = []
export const FAKE_AKB = path.join(process.env.RUNNER_DIST ?? '', '..', 'test', 'fake-akb.mjs')
export const cached = (project = 'prj_1') => path.join(fs.realpathSync(runnerHome()), 'cache', project)
export const fakeAkb = (version = '0.0.0-test') => ({ command: process.execPath, args: [FAKE_AKB], version, shim: path.join(runnerHome(), 'bin', 'akb', version, 'shim') })

export function fakeRuntime(script: string) {
  return (runtime: string, prompt: string, cwd: string, resume?: string | null, model?: string | null, settings?: unknown, _fork?: boolean, line?: 'zh' | 'en' | null, _images?: readonly string[], _discussionImages?: Parameters<Deps['plan']>[9]): Plan => {
    planned.push({ runtime, prompt, cwd, resume, model, settings, line })
    return {
      command: process.execPath,
      args: ['-e', script],
      env: process.env,
      renderer: { push: (s) => s, flush: () => '', result: () => 'Two tiers.', context: () => ({ used: 38_000, limit: 200_000 }) },
      quiet: () => false,
      session: () => resume ?? 'fresh-session',
    }
  }
}

export async function mockOffice(t: { after: (clean: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-office-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pdf = await PDFDocument.create()
  pdf.addPage()
  fs.writeFileSync(path.join(dir, 'example.pdf'), await pdf.save())
  fs.writeFileSync(path.join(dir, 'soffice'), '#!/bin/sh\nfor input do :; done\ncp "$(dirname "$0")/example.pdf" "${input%/*}/source.pdf"\n', { mode: 0o755 })
  const previousPath = process.env.PATH
  process.env.PATH = `${dir}${path.delimiter}${previousPath}`
  t.after(() => { process.env.PATH = previousPath })
}

// 用文件放行真实子进程，避免用固定时长猜测中间状态。
export function gatedScript(before: string, after = '') {
  const gate = path.join(runnerHome(), 'runtime-gate')
  return {
    script: `${before}; const gateTimer = setInterval(() => {
      if (require('fs').existsSync(${JSON.stringify(gate)})) { clearInterval(gateTimer); ${after} }
    }, 10)`,
    release: () => fs.writeFileSync(gate, ''),
  }
}

// A node child that answers ACP: one plan, one tool call, one message per prompt.
export const ACP_AGENT = `
const rl = require('node:readline').createInterface({ input: process.stdin })
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
const note = (update) => out({ method: 'session/update', params: { sessionId: 's1', update } })
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (process.env.ACP_CAPTURE) {
    require('node:fs').appendFileSync(process.env.ACP_CAPTURE, line + '\\n')
    if (m.method === 'initialize') return out({ id: m.id, result: {
      agentCapabilities: { promptCapabilities: { image: !process.env.ACP_TEXT_ONLY } },
    } })
  }
  if (m.method === 'session/load' && process.env.ACP_MISSING) return out({ id:m.id, error:{code:-32602,message:'Session not found'} })
  if (m.method === 'session/new' && process.env.ACP_NEW_FAIL) return out({ id:m.id, error:{code:-32603,message:'Cannot open conversation'} })
  if (m.method === 'session/new') return out({ id: m.id, result: { sessionId: 's1', models: { currentModelId: 'known-model' } } })
  if (m.method === 'session/prompt') {
    if (process.env.ACP_PROMPT_FAIL) return out({ id: m.id, error: { code: -32603, message: 'Provider temporarily overloaded', data: { code: 'overloaded_error' } } })
    if (process.env.ACP_HANG) return
    if (process.env.ACP_HALF) return note({ sessionUpdate: 'agent_message_chunk', content: { text: 'Two ' } })
    note({ sessionUpdate: 'plan', entries: [{ content: 'Look', status: 'completed' }] })
    note({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read a.ts', kind: 'read', locations: [{ path: 'a.ts' }] })
    note({ sessionUpdate: 'agent_message_chunk', content: { text: 'Two ' } })
    note({ sessionUpdate: 'agent_message_chunk', content: { text: 'tiers.' } })
    note({ sessionUpdate: 'usage_update', used: 900, ...(process.env.ACP_NO_WINDOW ? {} : { size: 100000 }) })
    return out({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } } })
  }
  if (m.id !== undefined) out({ id: m.id, result: {} })
})`

export function acpRuntime(env: NodeJS.ProcessEnv = {}, log = (_text: string) => {}) {
  return (runtime: string, prompt: string, cwd: string, resume?: string | null, model?: string | null): Plan => {
    planned.push({ runtime, prompt, cwd, resume, model })
    const client = createAcpClient()
    return {
      command: process.execPath,
      args: ['-e', ACP_AGENT],
      env: { ...process.env, ...env },
      converse: (child, event) => client.turn({
        stdout: child.stdout!, stdin: child.stdin!, prompt, cwd, resumeId: resume ?? undefined,
        log, gotResumeId: () => {}, gotModel: () => {}, event,
      }),
      quiet: () => false,
      session: () => resume ?? 's1',
    }
  }
}

export function start(script = 'console.log("hello from the runtime")', over: Partial<Deps> = {}, machineId = MACHINE, nextLook = (now: number) => now + 100, interval = 100) {
  const deps: Deps = {
    machineId,
    api,
    plan: fakeRuntime(script),
    flushMs: 50,
    logPingMs: 60_000,
    endMs: 200,
    renewMs: 50,
    leaseMs: 60_000,
    retryMs: 50,
    replyBackoff: () => 0,
    testMs: 2_000,
    stopMs: 2_000,
    watchMs: null,
    akb: () => fakeAkb(),
    runtimes: async () => installed,
    ...over,
  }
  runner = startRunner({
    registration: async () => ({ machineId, machineName: 'studio', version: '0.0.0-test', runtimes: [] }),
    kind: 'terminal',
    deps,
    heartbeatMs: interval,
    pollMs: interval,
    nextLook,
  })
  return runner
}

beforeEach(async () => {
  useRunnerHome()
  fs.rmSync(runnerHome(), { recursive: true, force: true })
  writeFakeSession(runnerHome())
  // Fresh, so a chat job pulls no catalogue from the network.
  fs.writeFileSync(path.join(runnerHome(), 'models-dev.json'), JSON.stringify({ fetchedAt: Date.now(), limits: { 'opencode/known-model': 128_000 } }))
  planned = []
  installed = [{ name: 'codex', installed: true }, { name: 'claude-code', installed: true }]
  process.env.FAKE_AKB_LOG = path.join(runnerHome(), 'akb.log')
  process.env.FAKE_AKB = '{}'
  cloud = new FakeCloud()
  // Each project is linked to its folder under the Runner's home (#516).
  fs.mkdirSync(path.join(runnerHome(), 'cache'), { recursive: true })
  fs.writeFileSync(path.join(runnerHome(), 'projects.json'), JSON.stringify({ projects: [path.join(runnerHome(), 'cache')] }))
  cloud.folder = (project) => { fs.mkdirSync(cached(project), { recursive: true }); return cached(project) }
  cloud.others = ['prj_1', 'prj_2'].map((project) => ({ project, name: project, workspace: 'ws_1', workspace_name: 'Mine', personal: true }))
  await cloud.start()
})

afterEach(async () => {
  await runner?.close()
  runner = null
  await cloud.stop()
})

export function clearRunner() { runner = null }

export function setInstalled(runtimes: RuntimeReport[]) { installed = runtimes }

export function taskFolderFixture() {
  const board = () => path.join(cached(), '.akb', 'kanban')
  const read = (file: string) => fs.readFileSync(path.join(board(), file), 'utf8')
  const downloads = () => cloud.log.filter((l) => l.endsWith('/file'))
  const commits = () => cloud.log.filter((l) => l.endsWith('/board/commits'))
  const CARD = 'todo/1-task-1.md'
  const BODY = '# Pricing\n\n![](hero.png) ![](shots/a.png)\n\nTiers.\n'

  beforeEach(() => {
    cloud.types.set('art_1', 'image')
    cloud.types.set('art_2', 'image')
    cloud.task = {
      artifacts: new Map([['art_1', [Buffer.from('hero-1')]], ['art_2', [Buffer.from('a-1')]]]),
      studio: { studio: 'wf_own', version: 2, files: {
        'STUDIO.md': '---\nname: Coding\n---\n',
        'references/planning.md': 'Plan it.',
        'references/notes.md': 'Notes',
      } },
    }
    cloud.put({
      [CARD]: BODY,
      'assets/task_1.json': JSON.stringify({ 'hero.png': { artifact: 'art_1', version: 1 }, 'shots/a.png': { artifact: 'art_2', version: 1 } }),
      'memory/readme.md': 'Shipped',
      'rules/project-writer.md': 'No',
    })
    cloud.putShared({ 'memory/me.md': 'Mine' })
  })

  let script = ''

  const runTask = async (id: string, edit = '', extra: Partial<FakeJob> = {}) => {
    script = edit && `process.chdir('.akb/kanban'); ${edit}`
    const job = cloud.dispatch({ id, task: 'task_1', project: 'prj_1', number: 1, studio: cloud.task.studio?.studio, ...extra })
    if (!runner) start('', { plan: (r, p, c, resume) => fakeRuntime(script)(r, p, c, resume) })
    await until(() => job.state === 'finished')
    return job
  }

  const prepareBoard = async () => {
    const result = await pull(openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cloud.folder!('prj_1')), MACHINE)
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  return { board, read, downloads, commits, CARD, BODY, runTask, prepareBoard }
}

export function flowReport(job: FakeJob) {
  const { processesStopped, evidence, ...report } = job.report ?? {}
  assert.equal(processesStopped, true, '正常结束须确认本地进程停止')
  return report
}

export function flowFixture() {
  const board = () => path.join(cached(), '.akb', 'kanban')

  const typed = () => fs.readFileSync(process.env.FAKE_AKB_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[])

  // The calls by the group they act on: `raw card refine` (#551) reads as `card refine`.
  const calls = () => typed().map((c) =>
    c[0] !== 'raw' || c[1] === 'init' || c[1] === 'create' ? c : c[1] === 'memory' ? [`${c[2]}-memory`, ...c.slice(3)] : c.slice(1))

  const runtimeFor = (id = 2) => JSON.parse(fs.readFileSync(path.join(board(), '.fake', `runtime-${id}.json`), 'utf8'))

  const cardCalls = () => calls().filter((c) => c[0] === 'card').map((c) => c.join(' '))

  const flowJob = async (id: string, flow: Partial<NonNullable<FakeFlow>> & { verb: string }, extra: Partial<Parameters<FakeCloud['dispatch']>[0]> = {}) => {
    const job = cloud.dispatch({ id, task: 'task_1', project: 'prj_1', number: 2, runtime: 'claude-code', flow: { studio: 'wf_builtin_coding', ...flow }, ...extra })
    if (!runner) start()
    await until(() => job.state === 'finished')
    return job
  }

  beforeEach(() => {
    cloud.task = { artifacts: new Map(), title: 'Pricing page', request: 'Two tiers, monthly and yearly.' }
  })
  return { board, typed, calls, runtimeFor, cardCalls, flowJob }
}

export function useCustomStudio() {
  const files = { 'STUDIO.md': '---\nname: Custom\n---\n\nDeliver the requested work.' }
  cloud.studios.wf_custom = files
  cloud.task.studio = { studio: 'wf_custom', version: 1, builtin: false, files }
}
