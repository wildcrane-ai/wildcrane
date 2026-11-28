import { zipSync, strToU8 } from 'fflate'
import { documentPreviewKey, PDF } from '../../artifact-sdk/src/internal/document'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import * as api from '../src/api'
import { readCheckpoint } from '../src/recovery'
import { runnerHome } from '../src/home'
import { spentBy } from '../src/flow'
import { plan as runtimePlan } from '../src/runtimes'
import { type Deps } from '../src/jobs'
import { projectStateDir } from '../../cli/src/lib/machine/project'
import { keptBoard, pushBoard } from '../src/task-folder'
import { unsent } from '../src/cache'
import { until } from './fake-cloud'
import { cloud, setInstalled, MACHINE, cached, fakeAkb, mockOffice, start, flowReport, flowFixture, useCustomStudio } from './runner-harness'

describe('flow jobs (#2020)', () => {
  const { board, typed, calls, runtimeFor, cardCalls, flowJob } = flowFixture()

  it('splits a step\'s cost by the runtime each agent ran on (#629)', () => {
    const pick = { id: 'rt_cx', name: 'Codex', runtime: 'codex', model: null, settings: {}, runner: 'm' }
    const job = { runtime: 'claude-code' as const, runtimeId: 'rt_cc', agentRuntimes: { reviewer: pick } }
    const spent = spentBy([
      { sessionId: 'a', runtime: 'global', costUsd: 0.5 },
      { sessionId: 'b', runtime: 'rt_cx', costUsd: 0.25 },
      { sessionId: 'c', costUsd: 0.25 },
    ], job)
    assert.equal(spent.costUsd, 1)
    assert.deepEqual(spent.runtimeCosts, [
      { runtimeId: 'rt_cc', runtime: 'claude-code', costUsd: 0.75 },
      { runtimeId: 'rt_cx', runtime: 'codex', costUsd: 0.25 },
    ])
  })

  it('reports the context window the latest run counting one left (#52)', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: { spent: { context: { used: 90000, limit: 200000 } } } })
    assert.deepEqual((await flowJob('j1', { verb: 'create' })).report?.context, { used: 90000, limit: 200000 })
    process.env.FAKE_AKB = JSON.stringify({ implement: { spent: { context: { used: 120000 } } } })
    await new Promise((r) => setTimeout(r, 5))
    assert.equal((await flowJob('j2', { verb: 'implement', card: 2 })).report?.context, undefined)
  })

  it('plans anyway when the review fails, leaving the rejections to learn (#2067)', async () => {
    cloud.rejections = { tasks: [{ id: 'task_9', number: 9, title: 'Mobile app', request: '', reason: 'never', cancelled_at: '2026-10-20T09:00:00.000Z' }], triage: [] }
    process.env.FAKE_AKB = JSON.stringify({ 'review-dismissals': { failed: 'Claude Code hit its usage limit.' } })
    const job = await flowJob('j1', { verb: 'create' })
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(cloud.reviewed, [])
    assert.deepEqual(cardCalls(), [`card refine 2 --follow --events --json --board ${board()}`])
    assert.ok(!fs.existsSync(path.join(board(), '.archive', '.sync')))
  })

  it('takes the title and the request a create job carries', async () => {
    await flowJob('j1', { verb: 'create', title: 'Launch page', text: 'One hero, one button.' })
    assert.equal(calls().find((c) => c[1] === 'create')![3], 'Launch page')
    assert.match(fs.readFileSync(path.join(board(), 'todo', '2-launch-page.md'), 'utf8'), /One hero, one button\./)
    assert.ok(!cloud.log.includes('GET /v1/tasks/task_1'))
  })

  it('puts the pictures a create job carries on the card it makes (#2182)', async () => {
    const job = await flowJob('j1', { verb: 'create' }, { attachments: [{ name: 'home "shot".png', content: 'aGk=' }] })
    assert.equal(job.outcome, 'done', job.reason)
    const card = fs.readFileSync(path.join(board(), 'todo', '2-pricing-page.md'), 'utf8')
    assert.match(card, /\n\n<Asset src="asset:1-home-shot-\.png" label="home shot\.png" \/>\n/)
    const ref = JSON.parse(cloud.file('assets/task_1.json')!)['asset:1-home-shot-.png']
    assert.equal(cloud.task.artifacts.get(ref.artifact)![0]!.toString(), 'hi')
  })

  it('reports the landed commit and syncs the archived card after a build', async () => {
    await flowJob('j1', { verb: 'create' })
    const commit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
    process.env.FAKE_AKB = JSON.stringify({ implement: { result: 'Built it.', landed: 'Landed it.', delivery: { commit, branch: 'main' } } })
    const built = await flowJob('j5', { verb: 'implement', card: 2 }, { resume: 'planning-session', transcript: 'Planning history', resumeCostUsd: 2 })
    const b = board()
    assert.deepEqual(cardCalls(), [
      `card refine 2 --follow --events --json --board ${b}`,
      `card implement 2 --follow --events --json --board ${b}`,
    ])
    assert.equal(built.outcome, 'done', built.reason)
    assert.deepEqual(flowReport(built), { reply: 'Landed it.', card: 2, deliveryCompleted: true, deliveryId: 'd1', landing: { commit, branch: 'main' } })
    assert.ok(fs.existsSync(path.join(b, '.archive', '2-pricing-page.md')))
    assert.match(cloud.file('.archive/2-pricing-page.md')!, /implement$/m, 'the archived card never reached Cloud')
    assert.equal(cloud.file('todo/2-pricing-page.md'), null, 'the card stayed in todo/ in Cloud')
    assert.equal(calls().filter((c) => c[1] === 'init').length, 1)
  })

  it('starts another task after a restart and leaves the pending archive to the next Land lease (#1234)', async () => {
    const todo = 'todo/1-pending.md'
    const archive = '.archive/1-pending.md'
    const manifest = 'assets/task_a.json'
    const memory = 'memory/readme.md'
    const dependent = 'todo/8-dependent.md'
    const unrelated = 'todo/9-unrelated.md'
    const body = '---\ntitle: Pending Land\nquestions: []\n---\n'
    const dependentCard = '---\ntitle: Dependent\nblocked_by: [1, 9]\nquestions: []\n---\n'
    const unrelatedCard = '---\ntitle: Unrelated\nblocked_by: []\nquestions: []\n---\n'
    const remote = { [todo]: body, [memory]: 'Before\n', 'config.md': '# Board\n', [dependent]: dependentCard, [unrelated]: unrelatedCard }
    cloud.put(remote)
    const save = (file: string, contents: string) => {
      const target = path.join(board(), file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, contents)
    }
    fs.mkdirSync(path.join(board(), 'todo'), { recursive: true })
    save('config.md', remote['config.md'])
    save(archive, body.replace('questions:', 'archived: 2026-11-26\nquestions:'))
    save(memory, 'Independent edit\n')
    save(dependent, dependentCard.replace('[1, 9]', '[9]') + '\nLocal notes.\n')
    save(unrelated, unrelatedCard + '\nIndependent changes.\n')
    save(manifest, '{}\n')
    save('.sync/task_a.json', JSON.stringify({ task: 'task_a', number: 1, assets: {} }))
    save('.sync/land-archives/task_a', 'land-before-restart')
    fs.writeFileSync(path.join(cached(), '.akb/base.json'), JSON.stringify({
      layout: 'workspace', project: 'prj_1', workspace: 'ws_1', head_seq: cloud.head,
      files: Object.fromEntries(Object.entries(remote).map(([p, content]) => [`projects/prj_1/${p}`, { content, seq: cloud.head }])),
      pendingArchives: { task_a: archive },
    }))
    const bytes = 'Saved delivery attachment.'
    const asset = path.join(projectStateDir(board()), 'assets/1/result.txt')
    fs.mkdirSync(path.dirname(asset), { recursive: true })
    fs.writeFileSync(asset, bytes)
    fs.appendFileSync(path.join(board(), archive), '\n<Asset src="asset:result.txt" />\n')
    const protectedPaths = new Set([todo, archive, manifest].map(p => `projects/prj_1/${p}`))
    const attempted: string[] = []
    const synchronized: string[] = []
    const land = 'land-after-restart'
    cloud.refuseBoardWrite = (job, files) => {
      if (files.some(f => protectedPaths.has(f.path))) {
        if (job === land) { synchronized.push(...files.map(f => f.path)); return }
        attempted.push(job ?? 'background')
        return 'The current Land job must synchronize this archive.'
      }
    }
    const completions: string[] = []
    cloud.completeArchives = ({ cards }) => {
      if (cloud.jobs.get(land)?.state !== 'finished') completions.push(...cards.map((card: { task: string }) => card.task))
      return { receipts: cards.map(({ task }: { task: string }) => ({ task, status: 'confirmed' })) }
    }
    const result = await flowJob('new-task', { verb: 'create', skip_plan: true, title: 'New task' }, { task: 'task_b' })
    assert.equal(result.outcome, 'done', result.reason)
    assert.ok(calls().some(c => c[0] === 'raw' && c[1] === 'create'))
    assert.ok(cardCalls().some(c => c.startsWith('card implement 2')))
    assert.deepEqual(attempted, [])
    assert.equal(cloud.file(todo), body)
    assert.equal(cloud.file(archive), null)
    assert.equal(cloud.file(manifest), null)
    assert.equal(cloud.file(memory), 'Independent edit\n')
    assert.match(fs.readFileSync(path.join(board(), dependent), 'utf8'), /blocked_by: \[(?:1, 9|9, 1)\][\s\S]*Local notes/)
    assert.match(cloud.file(dependent)!, /blocked_by: \[(?:1, 9|9, 1)\][\s\S]*Local notes/)
    assert.equal(cloud.file(unrelated), unrelatedCard + '\nIndependent changes.\n')
    assert.ok(fs.existsSync(path.join(board(), archive)))
    assert.ok(unsent(cached()))
    assert.equal(cloud.task.artifacts.size, 0)

    const expired = cloud.dispatch({ id: 'land-before-restart', state: 'finished', machine: MACHINE, leaseLost: true })
    const stale = await api.commitBoard('prj_1', expired.id, MACHINE, [{ path: `projects/prj_1/${archive}`, content: body, base_seq: 0 }])
    assert.equal(stale.ok, false)
    assert.equal(cloud.file(archive), null)
    const review = { revision: 1, plan: [], stages: [] }
    cloud.task.review = review
    process.env.FAKE_AKB = JSON.stringify({ reconcile: { kind: 'completed', deliveryId: 'delivery-a' } })
    const launches = cardCalls().length
    const resumed = await flowJob(land, { verb: 'implement', phase: 'land', land_from: 'implement-a', delivery_id: 'delivery-a',
      review_revision: 1, review_stages: [] }, { task: 'task_a', number: 1, taskReview: review })
    assert.equal(resumed.outcome, 'done', resumed.reason)
    assert.equal(resumed.report?.archive?.path, archive)
    assert.equal(cardCalls().length, launches)
    assert.deepEqual(new Set(synchronized), protectedPaths)
    assert.deepEqual(attempted, [])
    assert.ok(!completions.includes('task_a'))
    assert.equal(cloud.file(todo), null)
    const attachment = JSON.parse(cloud.file(manifest)!)['asset:result.txt']
    assert.equal(cloud.task.artifacts.get(attachment.artifact)?.[attachment.version - 1]?.toString(), bytes)
    assert.ok(!fs.existsSync(path.join(board(), '.sync/land-archives/task_a')))
  })

  it('scopes single-task writes and isolates unowned archives until Land takes over (#1269)', async () => {
    const todoA = 'todo/1-unowned.md'
    const archiveA = '.archive/1-unowned.md'
    const manifestA = 'assets/task_a.json'
    const cardB = 'todo/2-release.md'
    const brokenOther = 'todo/8-broken.md'
    const otherDirty = 'todo/9-dirty.md'
    const confirmedArchive = '.archive/10-confirmed.md'
    const confirmedManifest = 'assets/task_confirmed.json'
    const finishedArchive = '.archive/11-finished.md'
    const finishedManifest = 'assets/task_finished.json'
    const bodyA = '---\ntitle: Unowned Archive\nquestions: []\n---\n'
    const bodyB = '---\ntitle: Release\nquestions: []\n---\n\nInitial.\n'
    const bodyDirty = '---\ntitle: Dirty\nquestions: []\n---\n'
    const bodyConfirmed = '---\ntitle: Confirmed\narchived: 2026-11-25\nquestions: []\n---\n\n<Preview id="prompts">\n\nSee [SKILL.md](file:///outside/SKILL.md).\n\n</Preview>\n'
    const bodyFinished = '---\ntitle: Finished\narchived: 2026-11-20\nquestions: []\n---\n\n<Asset src=".assets/11/doc.md" />\n'
    cloud.task.artifacts.set('art_closed', [Buffer.from('old')])
    cloud.closedArtifacts.add('art_closed')
    cloud.previewProblems = (p) => p.endsWith(brokenOther)
      ? [{ file: brokenOther, line: 1, column: 1, code: 'bad_preview', path: '', message: 'Broken preview', hint: '' }] : []
    const remote = {
      [todoA]: bodyA, [cardB]: bodyB, [otherDirty]: bodyDirty, 'config.md': '# Board\n',
      [confirmedArchive]: bodyConfirmed, [confirmedManifest]: '{}',
      [finishedArchive]: bodyFinished, [finishedManifest]: JSON.stringify({ '.assets/11/doc.md': { artifact: 'art_closed', version: 1 } }),
    }
    cloud.put(remote)
    const save = (file: string, contents: string) => {
      const target = path.join(board(), file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, contents)
    }
    fs.mkdirSync(path.join(board(), 'todo'), { recursive: true })
    save('config.md', remote['config.md'])
    save(archiveA, bodyA.replace('questions:', 'archived: 2026-11-26\nquestions:') + '\nMerged in 4bb2afaaf.\n')
    save(cardB, bodyB)
    save(brokenOther, '---\ntitle: Broken\nquestions: []\n---\n\n<Preview id="bad" />\n')
    save(otherDirty, bodyDirty + '\nUnrelated local edit.\n')
    save(confirmedArchive, bodyConfirmed)
    save(confirmedManifest, '{}')
    save(finishedArchive, bodyFinished)
    save(finishedManifest, remote[finishedManifest])
    const closedAsset = path.join(projectStateDir(board()), 'assets/11/doc.md')
    fs.mkdirSync(path.dirname(closedAsset), { recursive: true })
    fs.writeFileSync(closedAsset, 'locally modified after close')
    // Intentionally omit `.sync/task_a.json` and `.sync/land-archives/task_a` to test unowned-<number> isolation and Land takeover.
    save('.sync/task_b.json', JSON.stringify({ task: 'task_b', number: 2, assets: {} }))
    save('.sync/task_confirmed.json', JSON.stringify({ task: 'task_confirmed', number: 10, assets: {} }))
    save('.sync/task_finished.json', JSON.stringify({
      task: 'task_finished', number: 11,
      assets: { '.assets/11/doc.md': { artifact: 'art_closed', version: 1, hash: 'stale', kind: 'markdown' } },
    }))
    fs.writeFileSync(path.join(cached(), '.akb/base.json'), JSON.stringify({
      layout: 'workspace', project: 'prj_1', workspace: 'ws_1', head_seq: cloud.head,
      pendingAssets: ['task_confirmed'],
      archiveReceipts: {
        task_confirmed: { path: confirmedArchive, seq: cloud.head, assets_seq: cloud.head, task: 'task_confirmed', status: 'confirmed' },
      },
      files: Object.fromEntries(Object.entries(remote).map(([p, content]) => [`projects/prj_1/${p}`, { content, seq: cloud.head }])),
    }))
    const protectedPaths = new Set([todoA, archiveA, manifestA].map(p => `projects/prj_1/${p}`))
    const land = 'land-unowned'
    const refusedJobs: string[] = []
    cloud.refuseBoardWrite = (job, files) => {
      if (files.some(f => protectedPaths.has(f.path))) {
        if (job === land) return
        refusedJobs.push(job ?? 'background')
        return 'The current Land job must synchronize this archive.'
      }
    }

    // 1. Retrying a failed Card Chat on task_b with a cold sync index commits only task_b's own changes and never hits Cloud refusal.
    const chatScript = `require("fs").appendFileSync(${JSON.stringify(path.join(board(), cardB))}, "\\nChat update.\\n"); console.log("Answered.");`
    start(chatScript)
    const chatReply = cloud.dispatch({
      id: 'chat-b-retry', task: 'task_b', project: 'prj_1', number: 2,
      manualRecovery: true, recoveryOf: 'chat-b-failed', retryReplay: true,
      chat: { message: 'm1', body: 'Reply on 1257' },
    })
    await until(() => chatReply.state === 'finished')
    assert.equal(chatReply.outcome, 'done', chatReply.reason)
    assert.deepEqual(refusedJobs, [])
    assert.match(cloud.file(cardB)!, /Chat update\./)
    assert.equal(cloud.file(otherDirty), bodyDirty)
    assert.equal(cloud.file(brokenOther), null)
    assert.equal(cloud.file(archiveA), null)

    // 2. Pre-run setUp failure stays safeToRetry=true; board-wide pull isolates unowned-1, holds brokenOther, clears confirmed pendingAssets, and records assetsClosed.
    const missingRuntime = await flowJob('missing-rt', { verb: 'create', title: 'Missing runtime' },
      { task: 'task_m', number: 9, runtime: 'nonexistent' as never })
    assert.equal(missingRuntime.outcome, 'failed')
    assert.equal(missingRuntime.report?.failure?.safeToRetry, true)

    const closedUploads = () => cloud.log.filter(line => line === 'POST /v1/artifacts/art_closed/uploads').length
    const created = await flowJob('create-c', { verb: 'create', title: 'Bugfix task' }, { task: 'task_c', number: 3 })
    assert.equal(created.outcome, 'done', created.reason)
    assert.equal(cloud.file(otherDirty), bodyDirty + '\nUnrelated local edit.\n')
    assert.equal(cloud.file(brokenOther), null)
    assert.ok(fs.existsSync(path.join(board(), '.sync/land-archives/unowned-1')))
    assert.equal(cloud.file(archiveA), null)
    const baseAfterBoardSync = JSON.parse(fs.readFileSync(path.join(cached(), '.akb/base.json'), 'utf8'))
    assert.deepEqual(baseAfterBoardSync.pendingAssets ?? [], [])
    assert.equal(baseAfterBoardSync.pendingArchives?.task_a, undefined)
    assert.equal(closedUploads(), 1)
    fs.rmSync(path.join(board(), brokenOther), { force: true })
    assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
    assert.equal(closedUploads(), 1)

    // 3. Implement + Land for task_a takes over from unowned-1, reuses the existing local archive without re-running delivery, and Cloud confirms done.
    const review = { revision: 1, plan: [], stages: [] }
    cloud.task.review = review
    process.env.FAKE_AKB = JSON.stringify({ reconcile: { kind: 'none' } })
    const beforeCalls = cardCalls().length
    const impl = await flowJob('impl-a', { verb: 'implement', phase: 'implement', card: 1, review_revision: 1, review_stages: [] },
      { task: 'task_a', number: 1, taskReview: review })
    assert.equal(impl.outcome, 'done', impl.reason)
    assert.deepEqual(impl.report?.landReady, {})
    assert.equal(cardCalls().length, beforeCalls)

    const landed = await flowJob(land, { verb: 'implement', phase: 'land', land_from: impl.id, card: 1, review_revision: 1, review_stages: [] },
      { task: 'task_a', number: 1, taskReview: review })
    assert.equal(landed.outcome, 'done', landed.reason)
    assert.equal(landed.report?.archive?.path, archiveA)
    assert.equal(cardCalls().length, beforeCalls)
    assert.equal(cloud.file(todoA), null)
    assert.match(cloud.file(archiveA)!, /Merged in 4bb2afaaf/)
    await until(() => !fs.existsSync(path.join(board(), '.sync/land-archives/task_a')) &&
      !fs.existsSync(path.join(board(), '.sync/land-archives/unowned-1')))

    // 4. A resumed release delivery on task_b recovers cleanly if board-sync.lock was transiently busy.
    const worktree = '.akb/worktrees/rel1/work'
    fs.mkdirSync(path.join(cached(), worktree), { recursive: true })
    fs.mkdirSync(path.join(cached(), worktree, '../base'))
    process.env.FAKE_AKB = JSON.stringify({
      reconcile: [{ error: { kind: 'board-busy', message: 'Another process is synchronizing this board. Try again.' } },
        { kind: 'resumable', deliveryId: 'rel1', status: 'active', worktree }],
      delivery: { deliveryId: 'rel1' },
      implement: { trackExecution: true, agentSession: 'release-session', result: 'Resumed release.', delivery: { id: 'rel1', status: 'active' } },
    })
    const resumedRelease = await flowJob('resume-b', { verb: 'implement', phase: 'implement', resume: true, card: 2, review_revision: 1, review_stages: [] },
      { task: 'task_b', number: 2, taskReview: review })
    assert.equal(resumedRelease.outcome, 'done', resumedRelease.reason)
    assert.deepEqual(resumedRelease.report?.landReady, { deliveryId: 'rel1' })
  })

  it('syncs Office originals before waiting to finish a delivery with a temporarily unavailable PDF (#943)', { skip: process.platform === 'win32' }, async (t) => {
    await mockOffice(t)
    assert.equal((await flowJob('plan-office', { verb: 'create' })).outcome, 'done')
    const asset = '.assets/2/report.docx'
    const target = path.join(projectStateDir(board(), cached()), 'assets/2/report.docx')
    const original = Buffer.from(zipSync({ 'word/document.xml': strToU8('Report'), '_rels/.rels': strToU8('<Relationships/>') }))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, original)
    fs.appendFileSync(path.join(board(), 'todo/2-pricing-page.md'), '\n<Asset src=".assets/2/report.docx" />\n')
    cloud.unavailableUploadTypes.add(PDF)
    const id = 'finish-office'
    const finished = flowJob(id, { verb: 'implement', card: 2 })
    await until(() => cloud.jobs.get(id)?.state === 'finished' || !!readCheckpoint(id)?.syncRetries?.publish)
    const index = () => JSON.parse(cloud.file('assets/task_1.json')!) as api.Assets
    const pin = index()[asset]!
    const key = documentPreviewKey(pin.artifact, pin.version!)
    assert.match(cloud.file('.archive/2-pricing-page.md')!, /report\.docx/)
    assert.deepEqual(cloud.task.artifacts.get(pin.artifact), [original])
    assert.deepEqual(pin, { artifact: pin.artifact, version: 1 })
    assert.equal(index()[key], undefined)
    assert.equal(cloud.jobs.get(id)?.state, 'claimed')
    cloud.unavailableUploadTypes.clear()
    assert.equal((await finished).outcome, 'done')
    assert.deepEqual(index()[asset], { ...pin, dependencies: [key] })
    assert.equal(index()[key]?.version, 1)
    assert.equal(cloud.log.filter(line => line === 'PUT /v1/uploads/upl_' + pin.artifact).length, 1)
    assert.equal(cardCalls().filter(call => call.startsWith('card implement')).length, 1)
  })

  it('hands a discussion task\'s session and discussion to its planning, and reports the session it ended on (#2146)', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: { result: 'Planned.', agentSession: 'ts1' }, resolve: { result: 'Done.', agentSession: 'ts2' } })
    const transcript = 'User: Tiers?\n\nAgent: Two.'
    const planned = await flowJob('j1', { verb: 'create' }, { resume: 'ds1', fork: true, transcript })
    assert.equal(planned.outcome, 'done', planned.reason)
    const b = board()
    const file = path.join(b, '.sync', 'task_1.discussion', 'discussion.md')
    assert.deepEqual(cardCalls(), [`card refine 2 --follow --events --json --session ds1 --fork --transcript ${file} --board ${b}`])
    assert.equal(fs.readFileSync(path.join(b, '.fake', 'transcript'), 'utf8'), `${transcript}\n`)
    assert.ok(!fs.existsSync(file), 'the discussion was left on the board')
    assert.equal((planned.report as { session?: string }).session, 'ts1')
    const answered = await flowJob('j2', { verb: 'resolve', card: 2, text: 'Monthly' }, { resume: 'ts1', transcript })
    assert.equal(cardCalls()[1], `card resolve 2 --follow --events --json --session ts1 --transcript ${file} --board ${b} -- Monthly`)
    assert.equal((answered.report as { session?: string }).session, 'ts2')
    await flowJob('j3', { verb: 'approve', card: 2 }, { resume: 'ts2', transcript })
    assert.equal(cardCalls()[2], `card approve 2 --follow --events --json --board ${b}`)
  })

  it('keeps concurrent Codex and Antigravity tasks on their own runtime and carries only compatible sessions (#1014)', async () => {
    setInstalled([{ name: 'codex', installed: true }, { name: 'antigravity', installed: true }])
    const gate = path.join(runnerHome(), 'runtime-gate')
    process.env.FAKE_AKB = JSON.stringify({ refine: { gates: [gate] } })
    const codex = cloud.dispatch({
      id: 'codex-task', task: 'task_1', project: 'prj_1', number: 2, runtime: 'codex', model: 'gpt-6.2-sol',
      settings: { reasoning: 'high' }, resume: 'codex-thread', fork: true, transcript: 'Codex discussion',
      flow: { verb: 'create', studio: 'wf_builtin_coding' },
    })
    start()
    const codexSettings = () => path.join(board(), '.fake', 'runtime-2.json')
    try {
      await until(() => fs.existsSync(codexSettings()))
      process.env.FAKE_AKB = JSON.stringify({ revise: { result: 'Saved.' } })
      cloud.put({ 'todo/3-other.md': '---\ntitle: Other task\nstatus: todo\nquestions: []\n---\n' })
      const agy = await flowJob('antigravity-task', { verb: 'revise', card: 3, text: 'Continue' }, {
        task: 'task_2', number: 3, runtime: 'antigravity', model: 'gemini-4-carbon', settings: { reasoning: 'low' },
        resume: 'agy-thread', fork: true, transcript: 'Antigravity discussion',
      })
      assert.equal(agy.outcome, 'done', agy.reason)
      assert.notEqual(codex.state, 'finished')
      assert.equal(runtimeFor(2).harness, 'codex')
      assert.equal(runtimeFor(2).settings.model, 'gpt-6.2-sol')
      assert.equal(runtimeFor(2).settings.reasoning, 'high')
      assert.equal(runtimeFor(3).harness, 'antigravity')
      assert.deepEqual(runtimeFor(3).settings, { model: 'gemini-4-carbon', reasoning: 'low' })
      assert.ok(cardCalls().some(line => line.includes('--session codex-thread --fork')))
      assert.ok(cardCalls().some(line => line.startsWith('card revise 3 ') && line.includes('--new-session --transcript') && !line.includes('--session')))
      assert.ok(!calls().some(call => call[0] === 'agent' && ['use', 'set', 'picks'].includes(call[1]!)))
    } finally {
      fs.writeFileSync(gate, '')
    }
    await until(() => codex.state === 'finished')
    assert.equal(codex.outcome, 'done', codex.reason)
  })

  it('starts a direct build without discussion session, passing only the transcript (#768, #896)', async () => {
    process.env.FAKE_AKB = JSON.stringify({ implement: { result: 'Built.', agentSession: 'bs1' } })
    const transcript = 'User: Tiers?\n\nAgent: Two.'
    const built = await flowJob('j1', { verb: 'create', skip_plan: true }, { resume: 'ds1', fork: true, transcript, resumeCostUsd: 2 })
    assert.equal(built.outcome, 'done', built.reason)
    const b = board()
    const file = path.join(b, '.sync', 'task_1.discussion', 'discussion.md')
    assert.deepEqual(cardCalls(), [`card implement 2 --follow --events --json --transcript ${file} --board ${b}`])
    assert.equal(fs.readFileSync(path.join(b, '.fake', 'transcript'), 'utf8'), `${transcript}\n`)
    assert.equal(fs.readFileSync(path.join(b, '.fake', 'session-cost'), 'utf8'), '')
    assert.ok(!fs.existsSync(file), 'the discussion was left on the board')
    assert.equal((built.report as { session?: string }).session, 'bs1')
  })

  it('keeps native Codex thread/fork when source rollout exists and falls back cleanly when paginated fork source rollout is missing (#1288)', async () => {
    const calls = path.join(runnerHome(), 'codex-fork-1288.jsonl')
    const script = `
const fs = require('node:fs')
const out = value => console.log(JSON.stringify(value))
const counterFile = ${JSON.stringify(calls + '.fresh')}
const nextFresh = () => {
  const n = (fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0) + 1
  fs.writeFileSync(counterFile, String(n))
  return n
}
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  const answer = result => out({id: m.id, result})
  const params = m.params ?? {}
  if (m.method === 'thread/fork' || m.method === 'thread/start') {
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({method: m.method, thread: params.threadId}) + '\\n')
    if (m.method === 'thread/fork' && params.threadId === 'missing-paginated') {
      return out({id: m.id, error: {code: -32600, message: 'invalid paginated history lineage for missing-paginated: missing source rollout'}})
    }
    if (m.method === 'thread/start') {
      const attempt = nextFresh()
      if (attempt === 1) return out({id: m.id, error: {code: -32000, message: 'HTTP 503 Service Unavailable', data: {status: 503}}})
      return answer({thread: {id: 'fresh-thread-1288'}})
    }
    return answer({thread: {id: 'forked-thread-1288'}})
  }
  if (m.method === 'turn/start') {
    const [text] = params.input
    const file = text.text.split(String.fromCharCode(96)).find(part => part.endsWith('/history.md'))
    const history = file && fs.readFileSync(file, 'utf8')
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({method: m.method, thread: params.threadId, text: text.text, history}) + '\\n')
    answer({turn: {id: 't'}})
    const notify = (method, data) => out({method, params: {threadId: params.threadId, turnId: 't', ...data}})
    notify('turn/started', {turn: {id: 't'}})
    notify('item/completed', {item: {id: 'm', type: 'agentMessage', text: 'Continued.'}})
    return notify('turn/completed', {turn: {id: 't', status: 'completed'}})
  }
  answer({})
})
`
    const transport: NonNullable<Deps['plan']> = (...args) => ({ ...runtimePlan(...args), command: process.execPath, args: ['-e', script] })
    const akb = () => ({ ...fakeAkb(), canonicalCommands: true })
    start('', { plan: transport, akb, replyBackoff: () => 0 })
    const historyMessages: api.ReplyHistoryMessage[] = [
      { role: 'user', body: 'Original goal discussion' },
      { role: 'agent', body: 'Original goal reply' },
    ]

    cloud.replyHistories.set('fork-ok', historyMessages)
    const okJob = cloud.dispatch({
      id: 'fork-ok', runtime: 'codex', resume: 'valid-source', fork: true, sessionKind: 'card_chat',
      task: 'task_1', project: 'prj_1', number: 1, prompt: 'Discuss',
      chat: { message: 'm-ok', body: 'Follow up on valid fork' },
      replyInput: { body: 'Follow up on valid fork', historyOnDemand: true, previousReviewRevision: null, firstCardChat: true },
    })
    await until(() => okJob.state === 'finished')
    assert.equal(okJob.outcome, 'done', okJob.reason)
    assert.equal(okJob.report?.session, 'forked-thread-1288')

    cloud.replyHistories.set('fork-missing', historyMessages)
    const fallbackJob = cloud.dispatch({
      id: 'fork-missing', runtime: 'codex', resume: 'missing-paginated', fork: true, sessionKind: 'card_chat',
      task: 'task_1', project: 'prj_1', number: 1, prompt: 'Discuss',
      chat: { message: 'm-miss', body: 'Continue after missing rollout' },
      replyInput: { body: 'Continue after missing rollout', historyOnDemand: true, previousReviewRevision: null, firstCardChat: true },
    })
    await until(() => fallbackJob.state === 'finished')
    assert.equal(fallbackJob.outcome, 'done', fallbackJob.reason)
    assert.equal(fallbackJob.report?.session, 'fresh-thread-1288')
    assert.equal(fallbackJob.report?.reply, 'Continued.')

    const entries = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(entries.map(e => [e.method, e.thread]), [
      ['thread/fork', 'valid-source'],
      ['turn/start', 'forked-thread-1288'],
      ['thread/fork', 'missing-paginated'],
      ['thread/start', undefined],
      ['thread/start', undefined],
      ['turn/start', 'fresh-thread-1288'],
    ])
    const fallbackTurn = entries.at(-1)
    assert.match(fallbackTurn.text, /akb guide card-chat/)
    assert.match(fallbackTurn.text, /Continue after missing rollout/)
    assert.match(fallbackTurn.history ?? '', /Original goal discussion/)
  })

  it('starts a fresh planning session from the transcript when Codex cannot copy the original (#1014)', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: { missingFork: true, result: 'Planned.', agentSession: 'fresh-thread' } })
    const transcript = 'Messages from the original discussion'
    const job = await flowJob('missing-source', { verb: 'create' }, { runtime: 'codex', resume: 'missing-thread', fork: true, transcript })
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(cardCalls().length, 2)
    assert.ok(cardCalls()[0]?.includes('--session missing-thread --fork'))
    assert.ok(cardCalls()[1]?.includes('--new-session --transcript'))
    assert.ok(!cardCalls()[1]?.includes('--session'))
    assert.equal(runtimeFor().harness, 'codex')
    assert.equal(fs.readFileSync(path.join(board(), '.fake', 'transcript'), 'utf8'), transcript + '\n')
    assert.equal(job.report?.session, 'fresh-thread')
  })

  for (const sessionKind of [undefined, 'refine'] as const) {
    it(`falls back to a fresh planning session when Codex paginated fork source rollout is missing (${sessionKind ?? 'legacy'}, #1288)`, async () => {
      process.env.FAKE_AKB = JSON.stringify({
        refine: { missingFork: 'paginated', result: 'Planned.', agentSession: 'fresh-paginated-thread' },
      })
      const transcript = 'Paginated goal discussion context'
      const job = await flowJob(
        `missing-paginated-${sessionKind ?? 'legacy'}`,
        { verb: 'create' },
        { runtime: 'codex', resume: 'missing-paginated', fork: true, transcript, ...(sessionKind ? { sessionKind } : {}) },
      )
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal(cardCalls().length, 2)
      assert.ok(cardCalls()[0]?.includes('--session missing-paginated --fork'))
      assert.ok(cardCalls()[1]?.includes('--new-session --transcript'))
      assert.ok(!cardCalls()[1]?.includes('--session'))
      assert.equal(fs.readFileSync(path.join(board(), '.fake', 'transcript'), 'utf8'), transcript + '\n')
      assert.equal(job.report?.session, 'fresh-paginated-thread')
    })
  }

  for (const verb of ['refine', 'create'] as const) {
    it(`待审卡的 ${verb} 作业被拒后正常上报卡片（#210）`, async () => {
      const card = '---\ntitle: Pricing\nstatus: ready\nquestions: []\n---\n\n已批准的计划。\n'
      cloud.put({ 'todo/2-pricing.md': card })
      process.env.FAKE_AKB = JSON.stringify({ refine: { refuse: 'a refine would not move #2' } })
      const job = await flowJob('j1', { verb, card: 2 })
      assert.equal(job.outcome, 'done', job.reason)
      assert.deepEqual(flowReport(job), { card: 2 })
      assert.equal(cloud.file('todo/2-pricing.md'), card)
      assert.ok(!calls().some((c) => c[0] === 'raw' && c[1] === 'create'))
    })
  }

  it('细化写好待审计划后中断仍上报回复和用量（#210）', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: {
      status: 'ready', failed: '运行中断', result: '计划已完成。', spent: { costUsd: 0.25 },
    } })
    const job = await flowJob('j1', { verb: 'create' })
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(flowReport(job), { card: 2, reply: '计划已完成。', costUsd: 0.25, runtimeCosts: [{ runtimeId: null, runtime: 'claude-code', costUsd: 0.25 }] })
    assert.match(cloud.file('todo/2-pricing-page.md')!, /status: planned/)
  })

  it('细化写好选项问题后中断仍上报评审（#210）', async () => {
    process.env.FAKE_AKB = JSON.stringify({ refine: { failed: '运行中断', question: '选择计费周期？' } })
    const job = await flowJob('j1', { verb: 'create' })
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(flowReport(job), {
      card: 2, review: { question: '选择计费周期？', options: ['Monthly', 'Yearly'], position: 2 },
    })
    assert.match(cloud.file('todo/2-pricing-page.md')!, /选择计费周期？/)
  })

  for (const meta of ['status: implementing\nquestions: []', 'status: planning\nquestions:\n  - 请提供素材']) {
    it(`细化被拒时识别无选项的待审状态：${meta.split('\n')[0]}（#210）`, async () => {
      cloud.put({ 'todo/2-pricing.md': `---\ntitle: Pricing\n${meta}\n---\n` })
      process.env.FAKE_AKB = JSON.stringify({ refine: { refuse: 'a refine would not move #2' } })
      const job = await flowJob('j1', { verb: 'refine', card: 2 })
      assert.equal(job.outcome, 'done', job.reason)
      assert.deepEqual(flowReport(job), { card: 2 })
    })
  }

  for (const [file, how] of [
    ['todo/2-pricing.md', { failed: '运行中断' }],
    ['todo/2-pricing/root.md', { failed: 'Group audit interrupted' }],
  ] as const) {
    it(`非待审卡细化失败仍失败：${file}（#210）`, async () => {
      cloud.put({ [file]: '---\ntitle: Pricing\nstatus: planning\nquestions: []\n---\n' })
      process.env.FAKE_AKB = JSON.stringify({ refine: how })
      const job = await flowJob('j1', { verb: 'refine', card: 2 })
      assert.equal(job.outcome, 'failed')
      assert.equal(job.reason, how.failed)
      const { failure: structuredFailure, ...rest } = flowReport(job)
      assert.deepEqual(rest, {})
      assert.equal(structuredFailure?.summary, how.failed)
    })
  }

  it('resumes a refused group by actually refining it and preserving its children (#688)', async () => {
    const child = '---\ntitle: Existing child\nstatus: ready\nphase: 1\nstages: 2\nquestions: []\n---\n\nApproved work.\n- [x] Shipped step\n- [ ] Remaining step\n'
    cloud.put({
      'todo/2-pricing/root.md': '---\ntitle: Pricing\nstatus: todo\nquestions: []\n---\n\n## Todo\n- [x] Shipped #3\n- [ ] Existing child #4\n',
      'todo/2-pricing/4-child.md': child,
    })
    process.env.FAKE_AKB = JSON.stringify({ refine: { refuse: 'a refine would not move #2' } })
    assert.equal((await flowJob('j1', { verb: 'refine', card: 2 })).outcome, 'failed')
    process.env.FAKE_AKB = JSON.stringify({ refine: { result: 'Checked existing split; coverage is complete.' } })
    const resumed = await flowJob('j2', { verb: 'refine', card: 2, resume: true })
    assert.equal(resumed.outcome, 'done', resumed.reason)
    assert.equal(cardCalls().filter((call) => call.startsWith('card refine 2 ')).length, 2)
    assert.equal(flowReport(resumed).reply, 'Checked existing split; coverage is complete.')
    assert.equal(cloud.file('todo/2-pricing/4-child.md'), child)
    assert.match(cloud.file('todo/2-pricing/root.md')!, /- \[x\] Shipped #3/)
    process.env.FAKE_AKB = JSON.stringify({ refine: { failed: 'Group audit interrupted' } })
    const failed = await flowJob('j3', { verb: 'refine', card: 2, resume: true })
    assert.equal(failed.outcome, 'failed')
    assert.equal(failed.reason, 'Group audit interrupted')
  })

  it('fails a build that stopped short, and reports one held on a question', async () => {
    await flowJob('j1', { verb: 'create' })
    process.env.FAKE_AKB = JSON.stringify({ implement: { failed: 'Review ran out of rounds.' } })
    const stopped = await flowJob('j2', { verb: 'implement', card: 2 })
    assert.equal(stopped.outcome, 'failed')
    assert.equal(stopped.reason, 'Review ran out of rounds.')
    process.env.FAKE_AKB = JSON.stringify({ implement: { failed: 'waiting on the user', question: 'Keep the old page?', landed: 'Asked one thing.' } })
    const held = await flowJob('j3', { verb: 'implement', card: 2 })
    assert.equal(held.outcome, 'done', held.reason)
    assert.deepEqual(flowReport(held), {
      reply: 'Asked one thing.',
      card: 2,
      deliveryCompleted: false,
      review: { question: 'Keep the old page?', options: ['Monthly', 'Yearly'], position: 2 },
    })
    process.env.FAKE_AKB = JSON.stringify({ implement: { result: 'Built it.', landed: 'Landed it.' } })
    const answered = await flowJob('j4', { verb: 'implement', card: 2, text: 'Keep the old page?\n\nNo' })
    assert.equal(answered.outcome, 'done', answered.reason)
    assert.ok(typed().some((c) => c.slice(0, 3).join(' ') === 'raw card resolve'), 'the Runner typed the old path')
    const log = calls().map((c) => c.join(' '))
    const resolveAt = log.findIndex((l) => l.startsWith('card resolve 2 --follow --events --json'))
    assert.ok(resolveAt >= 0 && log.slice(resolveAt).some((l) => l.startsWith('card implement 2 --follow --events --json')),
      'the answer was not resolved before the build carried on')
  })

  for (const failed of [undefined, 'Interrupted after rejecting.']) {
    it(`ends a discard answer without building again, resolve exit ${failed ? 1 : 0} (#241)`, async () => {
      process.env.FAKE_AKB = JSON.stringify({ refine: { question: 'Keep building?' } })
      await flowJob('j1', { verb: 'create' })
      const spent = { costUsd: 0.25, usage: { input: 20, output: 5, cacheCreation: 0, cacheRead: 0 } }
      process.env.FAKE_AKB = JSON.stringify({ resolve: {
        reject: true, failed, result: 'Discarded it.', spent,
        delivery: { id: 'd1', commit: 'must-not-land', branch: 'main' },
      } })
      const job = await flowJob('j2', { verb: 'implement', card: 2, text: 'Discard this card.' })
      assert.equal(job.outcome, 'done', job.reason)
      assert.deepEqual(flowReport(job), { card: 2, deliveryCompleted: false, reply: 'Discarded it.', ...spent, runtimeCosts: [{ runtimeId: null, runtime: 'claude-code', costUsd: spent.costUsd }] })
      assert.ok(!cardCalls().some((c) => c.startsWith('card implement')))
      assert.match(cloud.file('.archive/2-pricing-page.md')!, /rejected: true/)
      assert.equal(cloud.file('todo/2-pricing-page.md'), null)
    })
  }

  it('passes a failed, non-discard answer to the build as its note (#241)', async () => {
    await flowJob('j1', { verb: 'create' })
    process.env.FAKE_AKB = JSON.stringify({ resolve: { failed: 'Interrupted.' } })
    const job = await flowJob('j2', { verb: 'implement', card: 2, text: 'Keep it.' })
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(cardCalls().at(-1), `card implement 2 --follow --events --json --board ${board()} -- Keep it.`)
  })

  it('stays waiting when resolve leaves open questions before implement (#894)', async () => {
    await flowJob('j1', { verb: 'create' })
    process.env.FAKE_AKB = JSON.stringify({ resolve: { question: 'Still open?' } })
    const job = await flowJob('j2', { verb: 'implement', card: 2, text: 'Answered one.' })
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(flowReport(job), {
      card: 2,
      deliveryCompleted: false,
      review: { question: 'Still open?', options: ['Monthly', 'Yearly'], position: 2 },
    })
    assert.ok(!cardCalls().some((c) => c.startsWith('card implement')))
  })

  it('stops a build whose delivery was cancelled, and fails one discarded or blocked with its reason (#59)', async () => {
    await flowJob('j1', { verb: 'create' })
    const ended = (status: string, ending: Record<string, unknown>, failed?: string) =>
      JSON.stringify({ implement: { failed, delivery: { id: 'd1', status, ending } } })
    process.env.FAKE_AKB = ended('cancelled', { kind: 'stopped' }, 'delivery d1 did not land')
    const cancelled = await flowJob('j2', { verb: 'implement', card: 2 })
    assert.equal(cancelled.outcome, 'stopped', cancelled.reason)
    process.env.FAKE_AKB = ended('cancelled', { kind: 'discarded' }, 'delivery d1 did not land')
    const discarded = await flowJob('j3', { verb: 'implement', card: 2 })
    assert.equal(discarded.outcome, 'failed')
    assert.equal(discarded.reason, 'The build was discarded.')
    const reason = 'this could not be fitted onto the latest `main`:\nthe API moved'
    process.env.FAKE_AKB = ended('active', { kind: 'blocked', reason })
    const blocked = await flowJob('j4', { verb: 'implement', card: 2 })
    assert.equal(blocked.outcome, 'failed')
    assert.equal(blocked.reason, reason)
    assert.ok(!fs.existsSync(path.join(board(), 'deliveries', 'd1.json')))
  })

  it('continues the original custom Studio session once when a clean exit has no delivery receipt (#947)', async () => {
    useCustomStudio()
    await flowJob('j1', { verb: 'create', studio: 'wf_custom' })
    process.env.FAKE_AKB = JSON.stringify({
      implement: { trackExecution: true, agentSession: 'original', spent: { costUsd: 0.25 }, delivery: { id: 'd1', status: 'active' } },
      resume: { spent: { costUsd: 0.5 } },
    })
    const job = await flowJob('j2', { verb: 'implement', card: 2, studio: 'wf_custom' })
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.report?.deliveryId, 'd1')
    assert.equal(job.report?.costUsd, 0.75)
    assert.equal(cardCalls().filter(c => c.startsWith('card implement')).length, 1)
    assert.equal(calls().filter(c => c[0] === 'run' && c[1] === 'resume' && c.includes('--require-session')).length, 1)
  })

  it('reports a build left active on a card question as waiting, not unfinished (#504)', async () => {
    await flowJob('j1', { verb: 'create' })
    process.env.FAKE_AKB = JSON.stringify({ implement: { failed: 'delivery d1 did not land', question: 'Replace the public main?', delivery: { id: 'd1', status: 'active', stage: 'held' } } })
    const job = await flowJob('j2', { verb: 'implement', card: 2 })
    assert.equal(job.outcome, 'done', job.reason)
    assert.deepEqual(flowReport(job).review, { question: 'Replace the public main?', options: ['Monthly', 'Yearly'], position: 2 })
  })

  it('fails with akb’s own words when a verb is refused, or the run fails, and saves nothing', async () => {
    await flowJob('j1', { verb: 'create' })
    const saved = cloud.head
    process.env.FAKE_AKB = JSON.stringify({ approve: { refuse: '#2 has no stages, so there is nothing to approve.' } })
    const refused = await flowJob('j2', { verb: 'approve', card: 2 })
    assert.equal(refused.outcome, 'failed')
    assert.equal(refused.reason, '#2 has no stages, so there is nothing to approve.')
    process.env.FAKE_AKB = JSON.stringify({ revise: { failed: 'Claude Code hit its usage limit.\nat …' } })
    const failed = await flowJob('j3', { verb: 'revise', card: 2, text: 'shorter' })
    assert.equal(failed.outcome, 'failed')
    assert.equal(failed.reason, 'Claude Code hit its usage limit.')
    assert.equal(cloud.head, saved)
  })
})
