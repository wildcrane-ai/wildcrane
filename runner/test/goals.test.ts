import assert from 'node:assert/strict'
import { it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shimDir } from '../src/akb'
import { cardFlags } from '../src/flow'
import { writeGoals, readGoals } from '../src/goals'
import { readCheckpoint, saveCheckpoint } from '../src/recovery'

it('讨论元数据跨分页保留目录与已选要点，落卡显式传递空列表', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-previews-'))
  const before = process.env.WILDCRANE_HOME
  process.env.WILDCRANE_HOME = home
  try {
    const review_plan = [{ id: 'custom', after: [], previews: ['custom'] }]
    const goal = { id: 'idea_1', title: 'Goal', outcome: 'Result', acceptance: [], studio: 'wf_custom', review_plan, task: null }
    const catalog = [{ id: 'custom', title: { zh: '审阅' }, instructions: 'The requested output.' }]
    const pages: (string | null | undefined)[] = []
    const result = await writeGoals({ id: 'job_1', discussion: { id: 'dsc_1', workspace: 'ws_1', goals: [goal] } } as never, async (_workspace, after) => {
      pages.push(after)
      return { ok: true, value: { data: [{ id: after ? 'wf_custom' : 'wf_first', name: 'Custom', previews: catalog }], next: after ? null : 'wf_first' } }
    })
    assert.ok('file' in result)
    const data = JSON.parse(fs.readFileSync(result.file, 'utf8'))
    assert.equal(data.workspace, 'ws_1')
    assert.deepEqual(data.studios[1].previews, [{ id: "custom", title: { zh: "审阅" }, instructions: "The requested output." }])
    assert.deepEqual(pages, [null, 'wf_first'])
    const revised = { ...goal, title: 'Unsaved local goal' }
    fs.rmSync(result.file)
    const legacy = path.join(home, 'ideas', 'job_1.json')
    fs.mkdirSync(path.dirname(legacy))
    fs.writeFileSync(legacy, JSON.stringify({ workspace: 'ws_1', studios: [], ideas: [revised] }))
    const recovered = await writeGoals({ id: 'job_2', discussion: { id: 'dsc_1', workspace: 'ws_1', goals: [goal] } } as never, async () => ({ ok: true, value: { data: [], next: null } }), true, 'job_1')
    assert.ok('file' in recovered && recovered.preserved)
    assert.equal(fs.existsSync(legacy), false)
    assert.deepEqual(JSON.parse(fs.readFileSync(recovered.file, 'utf8')).goals, [revised])
    assert.deepEqual(readGoals(recovered.file), [revised])

    const oldGoal = { id: 'idea_1', title: 'Goal', outcome: 'Result', acceptance: ['Check'], workflow: 'wf_custom', previews: ['custom'], task: 'task_1' }
    const report = { reply: 'Saved reply', ideas_version: 5, ideas: [oldGoal] }
    saveCheckpoint('job_1', { pending: [], completed: { outcome: 'done', report: report as never } })
    const resumed = readCheckpoint('job_1')?.completed?.report
    const migrated = { ...goal, acceptance: ['Check'], review_plan: [{ id: 'review', after: [], previews: ['custom'] }], task: { id: 'task_1' } }
    assert.deepEqual(resumed, { reply: 'Saved reply', goalsVersion: 5, goals: [migrated] })
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'checkpoints', 'job_1.json'), 'utf8')).completed.report, resumed)
    assert.equal(fs.existsSync(recovered.file), false)
    assert.deepEqual(cardFlags({ number: 1 } as never, { previews: [] }), ['--previews', ''])
    assert.deepEqual(cardFlags({ number: 1 } as never, { previews: ['custom'] }), ['--previews', 'custom'])
  } finally {
    if (before === undefined) delete process.env.WILDCRANE_HOME
    else process.env.WILDCRANE_HOME = before
    fs.rmSync(home, { recursive: true, force: true })
  }
})

it('Windows 插件同时提供 cmd 和 shell 的 akb 入口', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-akb-'))
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    shimDir({ command: 'C:\\Program Files\\node.exe', args: ['C:\\WildCrane\\akb.mjs'], version: 'test', shim: dir })
    assert.match(fs.readFileSync(path.join(dir, 'akb.cmd'), 'utf8'), /%\*\r\n$/)
    assert.match(fs.readFileSync(path.join(dir, 'akb'), 'utf8'), /exec 'C:\/Program Files\/node.exe' 'C:\/WildCrane\/akb.mjs' "\$@"/)
  } finally {
    Object.defineProperty(process, 'platform', platform)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('同版本并发目录只读一次，跨账号、版本或缺失版本均不复用，分页变化拒绝启动 (#722)', async () => {
  const { clearStudioSnapshots } = await import('../src/goals')
  const { readSession } = await import('../../cli/src/lib/cloud/session')
  const { writeFakeSession } = await import('./fake-cloud')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-722-'))
  const before = process.env.WILDCRANE_HOME
  const beforeCliHome = process.env.AI4KANBAN_HOME
  process.env.WILDCRANE_HOME = home
  process.env.AI4KANBAN_HOME = home
  try {
    writeFakeSession(home)
    clearStudioSnapshots()
    const account = readSession()!.subject
    const job = { id: 'j1', discussion: { id: 'd1', workspace: 'ws1', goals: [], catalog: { account, version: 'v1' } } } as never
    let reads = 0
    const list = async () => { reads++; return { ok: true as const, value: { data: [{ id: 'wf1', name: 'One' }], next: null, catalogVersion: 'v1' } } }
    await Promise.all([writeGoals(job, list), writeGoals(job, list)])
    assert.equal(reads, 1)
    await writeGoals(job, list)
    assert.equal(reads, 1)
    const other = { id: 'j2', discussion: { id: 'd2', workspace: 'ws1', goals: [], catalog: { account: 'other', version: 'v1' } } } as never
    await writeGoals(other, list)
    assert.equal(reads, 2)
    clearStudioSnapshots()
    const changed = await writeGoals(job, async (_ws, after) => ({ ok: true, value: { data: [], next: after ? null : 'page2', catalogVersion: after ? 'v2' : 'v1' } }))
    assert.ok('error' in changed)
    const missing = async () => { reads++; return { ok: true as const, value: { data: [], next: null } } }
    await writeGoals(job, missing)
    await writeGoals(job, missing)
    assert.equal(reads, 4)
  } finally {
    clearStudioSnapshots()
    if (beforeCliHome === undefined) delete process.env.AI4KANBAN_HOME
    else process.env.AI4KANBAN_HOME = beforeCliHome
    if (before === undefined) delete process.env.WILDCRANE_HOME
    else process.env.WILDCRANE_HOME = before
    fs.rmSync(home, { recursive: true, force: true })
  }
})
