import { conflictList } from '../../cli/src/lib/shared/board-conflicts'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import * as api from '../src/api'
import { saveCheckpoint } from '../src/recovery'
import { runnerHome } from '../src/home'
import { agentDue, nextHour } from '../src/agents'
import { openAgentFolder, pull } from '../src/task-folder'
import { until } from './fake-cloud'
import { cloud, MACHINE, cached, fakeRuntime, start } from './runner-harness'

describe('periodic agents on the Runner (#2068)', () => {
  let project = ''
  const board = () => path.join(project, '.akb', 'kanban')
  const periodic = () => JSON.parse(fs.readFileSync(path.join(board(), '.fake', 'periodic'), 'utf8'))
  const agent = (over: Record<string, unknown>) =>
    ({ cadence: 'auto', fallback: '1d', since: null, lastSuccess: null, attempts: [], newWork: true, ...over })

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'periodic-'))
    fs.writeFileSync(path.join(runnerHome(), 'projects.json'), JSON.stringify({ projects: [project] }))
    cloud.folders = [{ project: 'prj_1', name: 'Site', path: project, notify: true, machine: MACHINE }]
    cloud.task = { artifacts: new Map() }
  })
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }))

  it('is due by this computer\'s clock: on its gap, with something new, and never twice at once', () => {
    const now = Date.parse('2026-10-26T10:00:00')
    const at = (h: number) => new Date(now - h * 3_600_000).toISOString()
    const prune = (over: Record<string, unknown>) => agentDue(agent({ name: 'prune-memory', fallback: '7d', ...over }) as never, now)
    assert.equal(prune({}), true, 'one never run was not due')
    assert.equal(prune({ since: at(1) }), false, 'one first seen an hour ago was due')
    assert.equal(prune({ lastSuccess: at(24 * 8) }), true)
    assert.equal(prune({ lastSuccess: at(24 * 8), attempts: [{ startedAt: at(1), status: 'error' }] }), false, 'a failure was retried at once')
    assert.equal(prune({ attempts: [{ startedAt: at(0), status: 'running' }] }), false, 'a second ran beside the first')
    assert.equal(agentDue(agent({ name: 'night-auditor', cadence: '1d at 09:30', lastSuccess: at(25) }) as never, now), true)
    assert.equal(agentDue(agent({ name: 'night-auditor', cadence: '1d at 09:30', lastSuccess: at(25), newWork: false }) as never, now), false)
  })

  it('comes round on the hour, whatever minute Cloud stamped the last pass (#291)', () => {
    const six = (lastSuccess: string, now: string) => agentDue(agent({ name: 'night-auditor', cadence: '6h', lastSuccess }) as never, Date.parse(now))
    assert.equal(six('2026-10-26T12:00:40', '2026-10-26T18:00:00'), true)
    assert.equal(six('2026-10-26T12:01:10', '2026-10-26T18:00:00'), true, 'a pass stamped past the hour lost an hour')
    assert.equal(six('2026-10-26T11:59:50', '2026-10-26T17:00:00'), false, 'a pass stamped before the hour came round early')
    assert.equal(new Date(nextHour(Date.parse('2026-10-26T12:00:00'))).getHours(), 13)
    assert.equal(new Date(nextHour(Date.parse('2026-10-26T12:59:59'))).getHours(), 13)
  })

  it('publishes a scheduled agent result after its lease lapses and honors a pending stop', async () => {
    const note = 'memory/describe-project.md'
    cloud.put({ 'config.md': '# Board\n', [note]: 'Before.\n' })
    const scope = { project: 'prj_1', projectDir: project, agent: { name: 'describe-project' } }
    const prior = cloud.dispatch({ ...scope, id: 'lapsed-agent', state: 'finished' })
    assert.ok((await pull(openAgentFolder(prior, project), MACHINE)).ok)
    fs.writeFileSync(path.join(board(), note), 'Saved by the original agent.\n')
    saveCheckpoint(prior.id, { pending: ['write'], started: true,
      completed: { outcome: 'done', report: { reply: 'Original result', costUsd: 0.25 } } })
    const resumed = cloud.dispatch({ ...scope, id: 'recover-agent', syncRecoveryOf: prior.id })
    const stopped = cloud.dispatch({ ...scope, id: 'stop-agent', syncRecoveryOf: prior.id, stop: true })
    start()
    await until(() => resumed.state === 'finished' && stopped.state === 'finished')
    assert.equal(resumed.outcome, 'done', resumed.reason)
    assert.equal(resumed.report?.costUsd, 0.25)
    assert.equal(resumed.report?.reply, 'Original result')
    assert.equal(stopped.outcome, 'stopped', stopped.reason)
    assert.equal(cloud.file(note), 'Saved by the original agent.\n')
    assert.equal(fs.existsSync(path.join(board(), '.fake/periodic')), false)
  })

  it('resolves a scheduled agent’s saved three-way conflict without replaying its work (#885)', async () => {
    const note = 'memory/describe-project.md'
    cloud.put({ 'config.md': '# Board\n', [note]: 'Original description.\n' })
    cloud.beforeNextCommit = () => cloud.put({ [note]: 'Cloud description.\n' })
    const repair = `
      const fs = require('fs'), cp = require('child_process'), path = require('path')
      const board = process.env.AI4KANBAN_BOARD
      const cli = ${JSON.stringify(path.join(process.env.RUNNER_DIST!, 'akb/bin/ai4kanban.mjs'))}
      const call = (...args) => JSON.parse(cp.execFileSync(process.execPath, [cli, '--board', board, 'raw', 'conflict', ...args, '--json']))
      const id = call('list').conflicts[0].id
      const record = call('show', id).conflict
      const found = record.files.find(file => file.path === '${note}')
      if (found.base.content !== 'Original description.\\n' || found.remote.content !== 'Cloud description.\\n') throw Error('Expected three versions')
      const file = path.join(board, '.sync/description-resolution.json')
      fs.writeFileSync(file, JSON.stringify({ files: [{ path: found.path, content: 'Merged description.\\n' }] }))
      call('resolve', id, '--expect', record.revision, '--file', file)
    `
    start('', { plan: fakeRuntime(repair) })
    const job = cloud.dispatch({ id: crypto.randomUUID(), project: 'prj_1', projectDir: project,
      agent: { name: 'describe-project' }, runtime: 'claude-code' })
    await until(() => job.state === 'finished', 10_000)
    assert.equal(job.outcome, 'done', [job.reason, ...job.events.map(event => event.text)].join('\n'))
    assert.equal(cloud.file(note), 'Merged description.\n')
    assert.equal(conflictList(board()).length, 0)
  })

  it('looks only when the hour comes: not on connecting, nor on a heartbeat (#291)', async () => {
    cloud.periodic = [agent({ name: 'prune-memory', fallback: '7d' })]
    start(undefined, {}, MACHINE, (now) => now + 600)
    await until(() => cloud.registrations >= 3)
    assert.equal(cloud.asked.length, 0)
    await until(() => cloud.asked.length > 0)
    assert.equal(cloud.asked[0]!.agent, 'prune-memory')
  })

  it('skips an hour it slept past (#291)', async () => {
    cloud.periodic = [agent({ name: 'prune-memory', fallback: '7d' })]
    start(undefined, {}, MACHINE, (now) => now - 60_001)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(cloud.asked.length, 0)
  })

  it('asks for what is due, runs it on the project\'s board, and sends the memory back', async () => {
    cloud.periodic = [
      agent({ name: 'prune-memory', fallback: '7d' }),
      agent({ name: 'describe-project', lastSuccess: new Date().toISOString() }),
      agent({ name: 'qa-manager', studio: 'wf_builtin_coding' }),
    ]
    start()
    await until(() => cloud.jobs.get('agent-1')?.state === 'finished')
    const job = cloud.jobs.get('agent-1')!
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(cloud.asked[0], { project: 'prj_1', agent: 'prune-memory', studio: null, seen: null })
    assert.ok(cloud.asked.every((a) => a.agent === 'prune-memory'), 'an agent with nothing new was asked for')
    assert.deepEqual(periodic().args.slice(0, 1), ['prune-memory'])
    assert.equal(cloud.file('memory/prune-memory.md'), 'prune-memory ran.\n')
  })

  it('reflects on the tasks it was handed, proposing from the first', async () => {
    process.env.FAKE_AKB = JSON.stringify({ reflect: { propose: 'Add a pricing FAQ' } })
    cloud.put({ '.archive/7-task-7.md': '---\ntitle: Pricing\n---\n\nTiers.\n' })
    const job = cloud.dispatch({ id: 'r1', project: 'prj_1', projectDir: project, agent: { name: 'reflect', tasks: [{ id: 'task_7', number: 7 }, { id: 'task_8', number: 8 }] } })
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(periodic(), { args: [...periodic().args.slice(0, 1), '--cards', '7', '8', ...periodic().args.slice(4)], task: 'task_7' })
    assert.match(cloud.file('triage/proposed.md')!, /title: Add a pricing FAQ\n[\s\S]*source_task: task_7\n/)
  })

  it('refuses an old Studio job without dispatching a local run', async () => {
    const job = cloud.dispatch({
      id: 'old-studio-job', project: 'prj_1', projectDir: project,
      agent: { name: 'qa-manager', studio: 'wf_builtin_coding' },
    })
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'failed')
    assert.match(job.reason ?? '', /Studio roles no longer run on their own/)
    assert.equal(fs.existsSync(path.join(board(), '.fake/periodic')), false)
  })

  it('starts a project discussion without board reads or uploads (#711)', async () => {
    cloud.put({ 'todo/4-pricing.md': '---\ntitle: Pricing\n---\n\nTiers.\n' })
    const boardPath = path.join(fs.realpathSync(project), '.akb', 'kanban')
    const local = path.join(boardPath, 'todo', '4-pricing.md')
    fs.mkdirSync(path.dirname(local), { recursive: true })
    fs.writeFileSync(local, 'Local draft that has not been uploaded.')
    const job = cloud.dispatch({ id: 'd1', project: 'prj_1', projectDir: project, discussion: { id: 'dsc_1', workspace: 'ws_1', goals: [] } })
    start(`if (process.env.AI4KANBAN_BOARD !== ${JSON.stringify(boardPath)}) process.exit(4);`)
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(fs.readFileSync(local, 'utf8'), 'Local draft that has not been uploaded.')
    assert.ok(!cloud.log.some(line => line.includes('/board') || line.includes('/artifacts')), cloud.log.join('\n'))
  })

  it('refuses a project background job when the computer has no project folder', async () => {
    const away = cloud.dispatch({ id: 'q2', project: 'prj_1', projectDir: null, agent: { name: 'prune-memory' } })
    start()
    await until(() => away.state === 'finished')
    assert.equal(away.outcome, 'failed')
    assert.equal(away.reason, 'This project has no folder on this computer.')
  })
})

describe('chat memory reviewed on the Runner (#2065)', () => {
  const ARCHIVED = '2026-10-30T09:00:00.000Z'
  const board = () => path.join(cached(), '.akb', 'kanban')
  const record = (task = 'task_1') => path.join(runnerHome(), 'chats', `${task}.jsonl`)
  const lines = (task = 'task_1') => fs.readFileSync(record(task), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const reviewed = () => JSON.parse(fs.readFileSync(path.join(runnerHome(), 'chats', 'reviewed.json'), 'utf8'))
  const said = (task: string, ...messages: [string, string, number?][]) => {
    fs.mkdirSync(path.dirname(record(task)), { recursive: true })
    fs.appendFileSync(record(task), messages.map(([id, text, at]) =>
      `${JSON.stringify({ id, role: id.startsWith('msg') ? 'user' : 'agent', text, at: at ?? Date.now(), ...(id.startsWith('msg') ? {} : { runtime: 'codex', model: 'gpt-5' }) })}\n`).join(''))
  }

  beforeEach(() => {
    cloud.task = { artifacts: new Map() }
    cloud.put({ '.archive/1-task-1.md': '---\ntitle: Pricing\n---\n\nTiers.\n' })
  })

  it('keeps a chat’s reply beside the message it answers, and nothing of another job', async () => {
    const job = cloud.dispatch({ id: 'j1', task: 'task_1', project: 'prj_1', model: 'gpt-5', chat: { message: 'msg_1', body: 'Why tiers?' } })
    const other = cloud.dispatch({ id: 'j2', task: 'task_2', project: 'prj_1' })
    start()
    await until(() => job.state === 'finished' && other.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(lines().map(({ at, ...l }) => l), [
      { id: 'msg_1', role: 'user', text: 'Why tiers?' },
      { id: 'j1', role: 'agent', text: 'Two tiers.', runtime: 'codex', model: 'gpt-5' },
    ])
    assert.ok(!fs.existsSync(record('task_2')))
  })

  it('drops what is past 30 days as it starts, and a chat left empty', async () => {
    const old = Date.now() - 31 * 24 * 60 * 60_000
    said('task_1', ['msg_1', 'Old', old], ['j1', 'Older reply', old], ['msg_2', 'New'])
    said('task_2', ['msg_3', 'Gone', old])
    start()
    await until(() => cloud.runner?.live === true)
    assert.deepEqual(lines().map((l) => l.text), ['New'])
    assert.ok(!fs.existsSync(record('task_2')))
  })

  const reviewOf = async () => {
    cloud.chats = [{ task: 'task_1', project: 'prj_1', number: 1, archivedAt: ARCHIVED }]
    start()
    await until(() => [...cloud.jobs.values()].some((j) => j.review && j.state === 'finished'))
    const job = [...cloud.jobs.values()].find((j) => j.review)!
    assert.equal(job.outcome, 'done', job.reason)
    await until(() => reviewed().tasks?.task_1?.archivedAt === ARCHIVED)
  }
  for (const failure of ['conversation', 'decisions']) it(`leaves memory review retryable after ${failure} failure (#842)`, async () => {
    cloud.chats = [{ task: 'task_1', project: 'prj_1', number: 1, archivedAt: ARCHIVED }]
    cloud.taskChats.task_1 = [{ id: 'msg_1', role: 'user', body: 'Always use plain labels.', created_at: ARCHIVED }]
    const readChat = async () => ({ ok: false as const, code: 'forbidden', error: 'Permission changed' })
    start('', { api: { ...api,
      ...(failure === 'conversation' ? { readChat } : {}),
      ...(failure === 'decisions' ? { readDecisions: async () => ({ ok: false as const, code: 'forbidden', error: 'Permission changed' }) } : {}),
    } })
    await until(() => [...cloud.jobs.values()].some(j => j.review && j.state === 'finished'))
    const job = [...cloud.jobs.values()].find(j => j.review)!
    assert.equal(job.outcome, 'failed')
    const file = path.join(runnerHome(), 'chats', 'reviewed.json')
    assert.equal(fs.existsSync(file) ? reviewed().tasks.task_1 : undefined, undefined)
  })
  it('recovers a temporary conversation read before memory review starts (#903)', async () => {
    cloud.chats = [{ task: 'task_1', project: 'prj_1', number: 1, archivedAt: ARCHIVED }]
    let reads = 0
    start('', { syncBackoff: () => 10, api: { ...api, readChat: async (task) => ++reads === 1
      ? { ok: false, status: 503, error: 'Temporarily unavailable' } : api.readChat(task) } })
    await until(() => [...cloud.jobs.values()].some(j => j.review && j.state === 'finished'))
    const job = [...cloud.jobs.values()].find(j => j.review)!
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(reads, 2)
  })
  it('marks a review only after Preview memory is synchronized (#842)', async () => {
    await reviewOf()
    assert.match(cloud.shared('memory/previews/coding/prompts/workspace/style.md')!, /Style:/)
    assert.match(cloud.file('memory/previews/coding/prompts/project/rules.md')!, /Writing:/)
  })

  it('does not mark a review whose shared memory has an unresolved conflict (#842)', async () => {
    const shared = 'memory/previews/coding/prompts/workspace/style.md'
    cloud.beforeNextCommit = () => cloud.putShared({ [shared]: 'Changed elsewhere' })
    cloud.chats = [{ task: 'task_1', project: 'prj_1', number: 1, archivedAt: ARCHIVED }]
    start()
    await until(() => [...cloud.jobs.values()].some(j => j.review && j.state === 'finished'))
    const job = [...cloud.jobs.values()].find(j => j.review)!
    assert.equal(job.outcome, 'failed')
    assert.equal(cloud.shared(shared), 'Changed elsewhere')
    const file = path.join(runnerHome(), 'chats', 'reviewed.json')
    assert.equal(fs.existsSync(file) ? reviewed().tasks.task_1 : undefined, undefined)
  })
  const hour = (h: number) => `2026-10-30T0${h}:00:00.000Z`
})
