import { conflictList, conflictShow, pendingConflicts, withSyncLock } from '../../cli/src/lib/shared/board-conflicts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import * as api from '../src/api'
import { readCheckpoint } from '../src/recovery'
import { runnerHome } from '../src/home'
import { type Deps } from '../src/jobs'
import { syncBackoff } from '../src/sync-retry'
import { projectStateDir } from '../../cli/src/lib/machine/project'
import { keptBoard, mergeFile, openTaskFolder, pull, pullChanges, push, pushBoard, readHead, withBoard, taskStudioContext } from '../src/task-folder'
import { watchBoards } from '../src/board-watch'
import { hold, unsent } from '../src/cache'
import { until } from './fake-cloud'
import { cloud, planned, MACHINE, cached, fakeRuntime, gatedScript, start, disconnect, taskFolderFixture } from './runner-harness'

describe('a task’s folder (#2037)', () => {
  const { board, read, commits, CARD, BODY, runTask, prepareBoard } = taskFolderFixture()

  it('logs sync failure phases and status without private request or response data', async () => {
    await prepareBoard()
    const ws = keptBoard(cached())!
    cloud.boardTimeouts = 1
    assert.equal((await pullChanges(ws)).ok, false)
    cloud.boardWritesUnavailable = true
    fs.appendFileSync(path.join(board(), 'memory/readme.md'), '\nprivate-card-text\n')
    assert.equal((await pushBoard(ws, MACHINE)).ok, false)
    cloud.boardWritesUnavailable = false

    const credentials = 'fake-access-token-to-exclude'
    const attachment = 'private-attachment-bytes'
    const signedUrl = '/v1/uploads/upl_diagnostic?signature=private-signature'
    fs.writeFileSync(path.join(board(), 'todo/private-filename.bin'), attachment)
    fs.appendFileSync(path.join(board(), CARD), '\n<Asset src="private-filename.bin" />\n')
    cloud.service = async (method, url) => {
      if (method === 'POST' && url.pathname.startsWith('/v1/artifacts/') && url.pathname.endsWith('/uploads')) {
        return { id: 'upl_diagnostic', url: signedUrl }
      }
      if (method === 'PUT' && url.pathname === '/v1/uploads/upl_diagnostic') {
        assert.equal(url.searchParams.get('signature'), 'private-signature')
        throw new Error(`Bearer ${credentials}: ${signedUrl} at ${board()} with ${attachment}`)
      }
    }
    assert.equal((await pushBoard(ws, MACHINE)).ok, false)
    const diagnostics = fs.readFileSync(path.join(runnerHome(), 'logs/runner.log'), 'utf8')
    const rows = diagnostics.trim().split('\n').map(line => JSON.parse(line))
    for (const [component, stage, status, code] of [
      ['board', 'pull', 408, 'refused'],
      ['board', 'push', 503, 'service_unavailable'],
      ['preview', 'upload', 500, 'unknown_error'],
    ]) assert.ok(rows.some(row => row.event === 'failed' && row.component === component && row.stage === stage
      && row.status === status && row.code === code && (component !== 'preview' || row.task === 1)), diagnostics)
    for (const privateValue of [credentials, signedUrl, 'private-signature', attachment, 'private-filename', 'private-card-text', board(), 'internal']) {
      assert.ok(!diagnostics.includes(privateValue), diagnostics)
    }
  })

  it('reuses a newly created artifact when an upload fails and is retried', async () => {
    await prepareBoard()
    const file = path.join(board(), 'todo/data.bin')
    fs.writeFileSync(file, 'new attachment')
    fs.appendFileSync(path.join(board(), CARD), '\n<Asset src="data.bin" />\n')
    cloud.serviceUnavailableUploads = true
    assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, false)
    const created = cloud.log.filter(line => line === 'POST /v1/tasks/task_1/artifacts').length
    assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, false)
    assert.equal(cloud.log.filter(line => line === 'POST /v1/tasks/task_1/artifacts').length, created)
    cloud.serviceUnavailableUploads = false
    assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
    assert.equal(cloud.log.filter(line => line === 'POST /v1/tasks/task_1/artifacts').length, created)
    const uploads = cloud.log.filter(line => line.endsWith('/uploads')).length
    fs.appendFileSync(path.join(board(), CARD), '\n<Asset src="./data.bin" />\n')
    assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
    assert.equal(cloud.log.filter(line => line.endsWith('/uploads')).length, uploads)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.deepEqual(refs['data.bin'], refs['./data.bin'])
  })

  it('stops after four attachment retries and offers safe manual recovery (#1057)', async () => {
    await prepareBoard()
    planned.length = 0
    fs.writeFileSync(path.join(board(), 'todo/hero.png'), 'local edit')
    cloud.serviceUnavailableUploads = true
    const delays: number[] = []
    start('', { syncBackoff: attempt => { delays.push(syncBackoff(attempt)); return 5 } })
    const input = { task: 'task_1', project: 'prj_1', number: 1, chat: { message: 'm1', body: 'Explain this' } }
    const job = cloud.dispatch({ id: 'sync-before-reply', ...input })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'failed')
    assert.equal(planned.length, 0)
    assert.deepEqual(delays, [1000, 2000, 4000, 8000])
    assert.equal(job.report?.failure?.pauseReason, 'limit')
    assert.equal(job.report?.failure?.attempt, 4)
    assert.equal(job.report?.failure?.history.length, 5)
    assert.match(job.reason!, /Cloud is not answering/)
    assert.equal(job.report?.recovery?.safe, true)
    assert.deepEqual(cloud.task.artifacts.get('art_1')!.map(b => b.toString()), ['hero-1'])

    cloud.serviceUnavailableUploads = false
    const manual = cloud.dispatch({ id: 'manual-sync-before-reply', ...input, recoveryOf: job.id, manualRecovery: true, retryReplay: true })
    await until(() => manual.state === 'finished')
    assert.equal(manual.outcome, 'done', manual.reason)
    assert.equal(planned.length, 1)
    assert.deepEqual(cloud.task.artifacts.get('art_1')!.map(b => b.toString()), ['hero-1', 'local edit'])
  })

  it('shares retry slots across preparation, Runner restart and session continuation (#1057)', async () => {
    let preflight = 0
    let launches = 0
    const plan: Deps['plan'] = (...args) => {
      launches++
      const p = fakeRuntime('process.exit(1)')(...args)
      p.renderer!.events = () => []
      p.renderer!.executionFailure = () => disconnect
      return p
    }
    const first = start('', { authorize: async () => ++preflight <= 2
      ? { ok: false, code: 'service_unavailable', error: 'Cloud returned 503.', status: 503 } : true,
      plan, syncBackoff: attempt => attempt === 1 ? 0 : 250 })
    const job = cloud.dispatch({ id: 'mixed-preparation-and-ai', chat: { message: 'm1', body: 'Continue' } })
    await until(() => readCheckpoint(job.id)?.syncRetries?.authorize?.attempt === 2)
    await first.close()
    assert.equal(launches, 0)
    start('', { authorize: async () => true, plan, syncBackoff: () => 0 })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'failed')
    assert.deepEqual(planned.map(p => p.resume), [null, 'fresh-session', 'fresh-session'])
    assert.equal(job.report?.failure?.attempt, 4)
    assert.equal(job.report?.failure?.pauseReason, 'limit')
    assert.deepEqual(job.report?.failure?.history.map(f => f.source), ['sync', 'sync', 'runtime', 'runtime', 'runtime'])
  })

  it('shares image upload retries with preparation and preserves the completed reply (#1057)', async () => {
    let preflight = 0
    let uploads = 0
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Kp0AAAAASUVORK5CYII='
    start('', {
      authorize: async () => ++preflight === 1 ? { ok: false, status: 503, error: 'Cloud preparation failed.' } : true,
      syncBackoff: () => 0,
      api: { ...api, uploadReplyImage: async () => ++uploads <= 3
        ? { ok: false, status: 503, error: 'Image upload failed.' }
        : { ok: true, value: { status: 'saved', id: 'rim_saved' } } },
      plan: (...args) => {
        const planned = fakeRuntime('')(...args)
        planned.converse = async () => ({ ok: true, result: 'Saved reply.', replyParts: [
          { type: 'text', text: 'Saved reply.' }, { type: 'image', data: png },
        ] })
        return planned
      },
    })
    const job = cloud.dispatch({ id: 'reply-image-shared-budget', chat: { message: 'm1', body: 'Render an image' } })
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(planned.length, 1)
    assert.equal(uploads, 4)
    assert.equal(job.report?.reply, 'Saved reply.')
    assert.deepEqual(job.report?.parts?.find(part => part.type === 'image'), { type: 'image', status: 'saved', id: 'rim_saved', mime: 'image/png' })
  })

  it('only confirms a completed result after losing the finish response (#1057)', async () => {
    let writes = 0
    const job = cloud.dispatch({ id: 'finish-applied-once', chat: { message: 'm1', body: 'Continue' } })
    start('', { api: { ...api, finishJob: async (...args) => {
      if (args[1] !== job.id || args[2] !== 'done') return api.finishJob(...args)
      writes++
      const applied = await api.finishJob(...args)
      assert.ok(applied.ok && applied.value.finished)
      return { ok: false, error: 'Lost the server response.' }
    } } })
    await until(() => job.state === 'finished' && readCheckpoint(job.id) === null)
    assert.equal(job.outcome, 'done')
    assert.equal(writes, 1)
    assert.equal(planned.length, 1)
  })

  it('runs unrelated tasks and cancels a task waiting for attachments on the same board (#892)', async () => {
    await prepareBoard()
    fs.writeFileSync(path.join(board(), 'todo/hero.png'), 'unsent edit')
    cloud.serviceUnavailableUploads = true
    start('', { syncBackoff: () => 90_000 })
    const blocked = cloud.dispatch({ id: 'blocked-sync', task: 'task_1', project: 'prj_1', number: 1 })
    await until(() => !!readCheckpoint(blocked.id)?.syncRetries?.prepare)
    cloud.put({ 'todo/2-other.md': '# Other' })
    const other = cloud.dispatch({ id: 'independent', task: 'task_2', project: 'prj_1', number: 2 })
    await until(() => other.state === 'finished')
    assert.equal(other.outcome, 'done', other.reason)
    assert.equal(blocked.state, 'claimed')
    blocked.stop = true
    await until(() => blocked.state === 'finished')
    assert.equal(blocked.outcome, 'stopped')
    assert.equal(planned.length, 1)
    assert.equal(read('todo/hero.png'), 'unsent edit')
  })

  it('resumes the same publication after Runner restart and reuses its uploaded version (#892)', async () => {
    await prepareBoard()
    cloud.loseVersionReply = true
    const current = start("require('fs').writeFileSync('.akb/kanban/todo/hero.png', 'new image')",
      { syncBackoff: () => 1_000 })
    const job = cloud.dispatch({ id: 'publish-after-restart', task: 'task_1', project: 'prj_1', number: 1 })
    await until(() => !!readCheckpoint(job.id)?.syncRetries?.publish)
    assert.equal(readCheckpoint(job.id)?.completed?.outcome, 'done')
    assert.equal(cloud.task.artifacts.get('art_1')!.length, 2)
    await current.close()
    assert.equal(job.state, 'claimed')
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(job.claims, 2)
    assert.equal(planned.length, 1)
    assert.equal(cloud.log.filter(line => line === 'PUT /v1/uploads/upl_art_1').length, 1)
    assert.equal(cloud.task.artifacts.get('art_1')!.length, 2)
    assert.equal(JSON.parse(cloud.file('assets/task_1.json')!)['hero.png'].version, 2)
    const rows = fs.readFileSync(path.join(runnerHome(), 'logs/runner.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(rows.some(row => row.component === 'preview' && row.stage === 'commit_version'
      && row.code === 'service_unavailable' && row.status === 503 && row.task === 1))
  })

  it('ignores unrelated oversized files while syncing a task reply', async () => {
    const job = await runTask('new-asset', `
      const fs = require('fs')
      fs.mkdirSync('assets/1', { recursive: true })
      fs.writeFileSync('assets/1/large.bin', '')
      fs.truncateSync('assets/1/large.bin', 101 * 1024 ** 2)
      fs.appendFileSync('${CARD}', '\\nSafe new edit.\\n')
    `)
    assert.equal(job.outcome, 'done', job.reason)
    assert.match(cloud.file(CARD)!, /Safe new edit/)
    assert.ok(!JSON.parse(cloud.file('assets/task_1.json')!)['../assets/1/large.bin'])
    assert.equal(unsent(cached()), false)
  })

  for (const code of ['storage_limit_reached', 'unauthenticated']) {
    it(`preserves referenced upload failures: ${code}`, async () => {
      await prepareBoard()
      cloud.refusedUploads.set('art_1', code)
      fs.writeFileSync(path.join(board(), 'todo/hero.png'), 'required edit')
      const job = await runTask('strict')
      assert.equal(job.outcome, 'failed')
      assert.match(job.reason!, code === 'unauthenticated' ? /Sign in|重新登录/ : /Free up|释放/)
      assert.doesNotMatch(job.reason!, /hero.png|上传被拒绝/)
    })
  }

  describe('a board change while a job runs (#300)', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const change = (text: string) => fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), text)
    let watch: ReturnType<typeof watchBoards> | null = null
    let release = () => {}
    afterEach(() => {
      release()
      watch?.close()
    })

    it('goes at most once a spell, the latest change with it', async () => {
      await prepareBoard()
      const before = commits().length
      watch = watchBoards(MACHINE, 20, 60_000, 50, 800)
      await sleep(50)
      release = hold(cached())
      change('first')
      await until(() => cloud.file('memory/readme.md') === 'first')
      for (const text of ['second', 'third', 'fourth']) {
        change(text)
        await sleep(40)
      }
      assert.equal(commits().length, before + 1, 'a job’s changes went more than once a spell')
      await until(() => cloud.file('memory/readme.md') === 'fourth')
      assert.equal(commits().length, before + 2)
    })

    it('goes as the job ends', async () => {
      await prepareBoard()
      watch = watchBoards(MACHINE, 20, 60_000, 50, 60_000)
      await sleep(50)
      release = hold(cached())
      change('first')
      await until(() => cloud.file('memory/readme.md') === 'first')
      change('last')
      await sleep(100)
      assert.equal(cloud.file('memory/readme.md'), 'first')
      release()
      watch.look()
      await until(() => cloud.file('memory/readme.md') === 'last')
    })

    it('leaves the wait behind once no job runs', async () => {
      await prepareBoard()
      watch = watchBoards(MACHINE, 20, 60_000, 50, 60_000)
      await sleep(50)
      release = hold(cached())
      change('first')
      await until(() => cloud.file('memory/readme.md') === 'first')
      release()
      change('by hand')
      await until(() => cloud.file('memory/readme.md') === 'by hand')
    })
  })

  describe('Cloud’s changes between jobs (#103)', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const reads = () => cloud.log.filter((l) => l.startsWith('GET /v1/projects/prj_1/board')).length
    let watch: ReturnType<typeof watchBoards> | null = null
    afterEach(() => watch?.close())

    it('reads once for hints close together, dropping its own push and versions already read', async () => {
      await prepareBoard()
      watch = watchBoards(MACHINE, 60_000, 60_000, 50)
      const before = reads()
      cloud.put({ 'memory/readme.md': 'From the page' })
      watch.hint('prj_1', cloud.head, MACHINE)
      watch.hint('prj_1', readHead(keptBoard(cached())!)!)
      watch.hint('prj_2', cloud.head)
      await sleep(150)
      assert.equal(reads(), before, 'a dropped hint read the board')
      watch.hint('prj_1', cloud.head)
      watch.hint('prj_1', cloud.head)
      await until(() => read('memory/readme.md') === 'From the page')
      await sleep(150)
      assert.equal(reads(), before + 1)
      assert.equal(readHead(keptBoard(cached())!), cloud.head)
    })

    it('saves incremental conflicts without refreshing local work or launching an idle agent (#806)', async () => {
      await prepareBoard()
      watch = watchBoards(MACHINE, 60_000, 60_000, 50)
      fs.writeFileSync(path.join(board(), 'memory/readme.md'), 'mine')
      cloud.put({ 'memory/readme.md': 'theirs' })
      watch.hint('prj_1', cloud.head)
      await until(() => conflictList(board()).length === 1)
      const id = conflictList(board())[0]!.id
      assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, false)
      assert.equal((await pullChanges(keptBoard(cached())!)).ok, false)
      assert.equal(conflictList(board())[0]!.id, id)
      assert.equal(read('memory/readme.md'), 'mine')
      assert.equal(cloud.file('memory/readme.md'), 'theirs')
      assert.equal(planned.length, 0)
      assert.ok(unsent(cached()))
    })

    it('reads a folder a job holds once the job is over', async () => {
      await prepareBoard()
      watch = watchBoards(MACHINE, 60_000, 60_000, 50)
      const release = hold(cached())
      cloud.put({ 'memory/readme.md': 'During the job' })
      watch.hint('prj_1', cloud.head)
      await sleep(150)
      assert.equal(read('memory/readme.md'), 'Shipped', 'a held folder was written')
      release()
      watch.look()
      await until(() => read('memory/readme.md') === 'During the job')
    })

    it('reads on its poll when no hint can arrive', async () => {
      await prepareBoard()
      start('', { watchMs: 50 })
      cloud.put({ 'memory/readme.md': 'Polled' })
      await until(() => read('memory/readme.md') === 'Polled')
    })
  })

  it('sends a .tsx mockup as the page it draws, again when a file beside it changes (#2003)', async () => {
    const edit = (label: string) => `
      const fs = require('fs')
      const dir = '../state/assets/1'
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(dir + '/page.tsx', 'import Plan from "./Plan"\\nimport "./style.css"\\nexport default () => <main className="p-4"><Plan /></main>')
      fs.writeFileSync(dir + '/Plan.tsx', 'export default function Plan() { return <h1 className="plan">${label}</h1> }')
      fs.writeFileSync(dir + '/style.css', '@import "tailwindcss";\\n.plan { color: teal }')
      fs.writeFileSync(dir + '/copy.md', '# Plans')
      const card = '${CARD}'
      const body = fs.readFileSync(card, 'utf8')
      if (!body.includes('page.tsx')) fs.writeFileSync(card, body + '\\n\\n<Asset src=".assets/1/page.tsx" label="Page" />\\n\\n<Asset src=".assets/1/copy.md" label="Copy" />\\n')
    `
    const assets = () => JSON.parse(cloud.file('assets/task_1.json')!)
    assert.equal((await runTask('j1', edit('Free'))).outcome, 'done')
    const ref = assets()['.assets/1/page.tsx']
    assert.equal(cloud.types.get(ref.artifact), 'html')
    assert.equal(cloud.types.get(assets()['.assets/1/copy.md'].artifact), 'markdown')
    const page = cloud.task.artifacts.get(ref.artifact)![0]!.toString()
    assert.match(page, /^<!doctype html>/)
    assert.match(page, /<main class="p-4"><h1 class="plan">Free<\/h1><\/main>/)
    assert.match(page, /\.plan \{\s*color: teal/)
    assert.match(page, /padding:/, 'Tailwind did not style the page')

    assert.equal((await runTask('j2', edit('Plus'))).outcome, 'done')
    assert.deepEqual(assets()['.assets/1/page.tsx'], { artifact: ref.artifact, version: 2, dependencies: [] })
    assert.match(cloud.task.artifacts.get(ref.artifact)![1]!.toString(), />Plus</)
    assert.match(fs.readFileSync(path.join(projectStateDir(board()), 'assets', '1', 'page.tsx'), 'utf8'), /^import Plan/,
      'the drawn page was written over its source')
  })

  it('stores a studio diagram as a studio, also one first pushed as a plain file (#484)', async () => {
    const tag = (name: string) => `
      const fs = require('fs')
      const dir = '../state/assets/1'
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(dir + '/studio.json', JSON.stringify({ version: 1, rounds: [[{ agent: 'a', title: { en: 'A' } }]], land: [], scheduled: [] }))
      const body = fs.readFileSync('${CARD}', 'utf8').replace(/\\n<(Asset|Studio) src="\\.assets\\/1\\/studio\\.json" \\/>\\n/, '')
      fs.writeFileSync('${CARD}', body + '\\n<${name} src=".assets/1/studio.json" />\\n')
    `
    const type = () => cloud.types.get(JSON.parse(cloud.file('assets/task_1.json')!)['.assets/1/studio.json'].artifact)
    assert.equal((await runTask('j1', tag('Asset'))).outcome, 'done')
    assert.equal(type(), 'asset')
    assert.equal((await runTask('j2', tag('Studio'))).outcome, 'done')
    assert.equal(type(), 'studio')
  })

  it('syncs Studio review dependencies, keeps partial results readable and restores frozen snapshots after local removal (#733)', async () => {
    const review = { version: 2, base: null, fingerprint: 'draft', agents: [{ agent: 'writer', title: { en: 'Writer' } }], files: [{ path: 'agents/writer/AGENT.md', before: null, after: 'after.txt', diff: 'change.diff' }], results: [{ agent: 'writer', component: 'Asset', src: 'good.html' }, { agent: 'writer', component: 'Asset', src: 'bad.html' }] }
    const setup = `
      const fs = require('fs')
      fs.mkdirSync('todo/review', { recursive: true })
      fs.writeFileSync('todo/review/review.json', ${JSON.stringify(JSON.stringify(review))})
      fs.writeFileSync('todo/review/after.txt', 'Write real previews.')
      fs.writeFileSync('todo/review/change.diff', '+Write real previews.')
      fs.writeFileSync('todo/review/good.html', '<img src="image.svg"><p>Existing result</p>')
      fs.writeFileSync('todo/review/image.svg', '<svg/>')
      fs.writeFileSync('todo/review/bad.html', '<img src="missing.png">')
      fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Studio src="review/review.json" />\\n')
    `
    const first = await runTask('studio-review-1', setup)
    assert.equal(first.outcome, 'done', first.reason)
    const pins = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.equal(pins['review/review.json'].error, undefined)
    assert.match(pins['review/bad.html'].error, /missing.png/)
    assert.equal(pins['review/good.html'].error, undefined)
    const uploaded = JSON.parse(cloud.task.artifacts.get(pins['review/review.json'].artifact)![0]!.toString())
    assert.equal(uploaded.files[0].after, pins['review/after.txt'].artifact)
    assert.equal(uploaded.results[0].src, pins['review/good.html'].artifact)
    const uploads = cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length
    fs.rmSync(path.join(board(), 'todo/review'), { recursive: true })
    const recordFile = path.join(board(), '.sync/task_1.json')
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    for (const key of Object.keys(record.assets)) if (key.startsWith('review/')) delete record.assets[key]
    fs.writeFileSync(recordFile, JSON.stringify(record))
    const pulled = await runTask('studio-review-2')
    assert.equal(pulled.outcome, 'done', pulled.reason)
    const restored = JSON.parse(read('todo/review/review.json'))
    assert.equal(restored.files[0].after, 'after.txt', JSON.stringify({ restored, pins, types: [...cloud.types], log: cloud.log.slice(-25) }))
    assert.equal(restored.results[0].src, 'good.html')
    assert.equal(read('todo/review/after.txt'), 'Write real previews.')
    assert.match(read('todo/review/good.html'), /image.svg/)
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, uploads)
  })

  it('a preview that cannot be drawn never blocks the push; the list says why until it draws (#456)', async () => {
    const first = await runTask('j1', `
      const fs = require('fs')
      fs.writeFileSync('todo/good.tsx', 'export default () => <main>Good</main>')
      fs.writeFileSync('todo/kept.tsx', 'export default () => <main>Kept</main>')
      fs.writeFileSync('todo/bad.tsx', 'import "./gone.css"; export default () => <main>Bad</main>')
      fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Asset src="good.tsx" />\\n\\n<Asset src="kept.tsx" />\\n\\n<Asset src="bad.tsx" />\\n')
    `)
    assert.equal(first.outcome, 'done', first.reason)
    assert.match(cloud.file(CARD)!, /bad\.tsx/)
    let assets = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.match(assets['bad.tsx'].error, /gone\.css/)
    assert.doesNotMatch(assets['bad.tsx'].error, new RegExp(board()))
    assert.equal(assets['bad.tsx'].version, undefined)
    assert.equal(cloud.task.artifacts.get(assets['bad.tsx'].artifact)?.length ?? 0, 0)
    assert.equal(assets['good.tsx'].error, undefined)
    const kept = assets['kept.tsx']

    fs.writeFileSync(path.join(board(), 'todo/kept.tsx'), 'export default () => { throw new Error("broken later") }')
    const second = await runTask('j2')
    assert.equal(second.outcome, 'done', second.reason)
    assets = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.deepEqual({ ...assets['kept.tsx'], error: undefined }, { ...kept, error: undefined })
    assert.match(assets['kept.tsx'].error, /broken later/)

    for (const name of ['kept', 'bad']) fs.writeFileSync(path.join(board(), 'todo', `${name}.tsx`), 'export default () => <main>Fixed</main>')
    const fixed = await runTask('j3')
    assert.equal(fixed.outcome, 'done', fixed.reason)
    assets = JSON.parse(cloud.file('assets/task_1.json')!)
    for (const name of ['kept', 'bad']) {
      assert.equal(assets[`${name}.tsx`].error, undefined)
      assert.match(cloud.task.artifacts.get(assets[`${name}.tsx`].artifact)!.at(-1)!.toString(), /<main>Fixed<\/main>/)
    }
  })

  it('a missing file or broken storyboard never blocks the push; the body path says why until fixed (#457)', async () => {
    const first = await runTask('j1', `
      const fs = require('fs')
      fs.writeFileSync('todo/bad.json', '{ not json')
      fs.writeFileSync('todo/deck.json', JSON.stringify({ slides: [{ id: 'p1', preview: { src: 'gone.html' } }] }))
      fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Asset src="home.html" />\\n\\n<Storyboard src="bad.json" />\\n\\n<Storyboard src="deck.json" />\\n')
    `)
    assert.equal(first.outcome, 'done', first.reason)
    let assets = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.match(assets['home.html'].error, /^file not found: todo\/home\.html$/)
    assert.match(assets['bad.json'].error, /^not valid JSON: todo\/bad\.json$/)
    assert.match(assets['deck.json'].error, /^file not found: todo\/gone\.html$/)
    assert.equal(cloud.types.get(assets['deck.json'].artifact), 'storyboard')

    fs.writeFileSync(path.join(board(), 'todo/home.html'), '<!doctype html><html><body>Home</body></html>')
    fs.writeFileSync(path.join(board(), 'todo/gone.html'), '<!doctype html><html><body>Gone</body></html>')
    fs.writeFileSync(path.join(board(), 'todo/bad.json'), JSON.stringify({ shots: [{ id: 'S1', frames: [{ src: 'home.html' }] }] }))
    const fixed = await runTask('j2')
    assert.equal(fixed.outcome, 'done', fixed.reason)
    assets = JSON.parse(cloud.file('assets/task_1.json')!)
    for (const name of ['home.html', 'bad.json', 'deck.json']) {
      assert.equal(assets[name].error, undefined, name)
      assert.ok(assets[name].version, name)
    }
  })

  it('reports an invalid required storyboard and an oversized card as content failures (#885)', async () => {
    await prepareBoard()
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cached())
    fs.appendFileSync(path.join(board(), CARD), '\n<Preview id="ui-design">\n\n<Storyboard src="deck.json" />\n\n</Preview>\n')
    fs.writeFileSync(path.join(board(), 'todo/deck.json'), '{ incomplete')
    let result = await push(ws, { id: 'result', machineId: MACHINE })
    assert.ok(!result.ok)
    assert.equal(result.failure?.source, 'validation')
    assert.match(result.error, /deck\.json: not valid JSON/)
    assert.equal(cloud.file(CARD), BODY)

    fs.writeFileSync(path.join(board(), CARD), BODY + 'x'.repeat(10 * 1024 * 1024))
    result = await push(ws, { id: 'result', machineId: MACHINE })
    assert.ok(!result.ok)
    assert.equal(result.failure?.code, 'card_too_large')
    assert.match(result.error, /Move large results to assets/)
    assert.equal(cloud.file(CARD), BODY)
  })

  it('does not rewrite unchanged asset records or reorder their index', async (t) => {
    const first = await runTask('j1', `
      const fs = require('fs')
      fs.mkdirSync('assets/1', { recursive: true })
      for (let n = 0; n < 30; n++) fs.writeFileSync('assets/1/' + n + '.txt', String(n))
      fs.writeFileSync('todo/icon.svg', '<svg/>')
      fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Asset src="icon.svg" />\\n')
    `)
    assert.equal(first.outcome, 'done', first.reason)
    const record = path.join(board(), '.sync', 'task_1.json')
    const index = path.join(board(), 'assets', 'task_1.json')
    const ordered = JSON.parse(fs.readFileSync(index, 'utf8'))
    fs.writeFileSync(index, JSON.stringify(Object.fromEntries(Object.entries(ordered).reverse())))
    const indexBefore = fs.readFileSync(index, 'utf8')
    let writes = 0
    const write = fs.writeFileSync
    t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]) === record) writes++
      return write(...args)
    })
    const uploadsBefore = cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length
    const sent = await pushBoard(keptBoard(cached())!, MACHINE)
    assert.equal(sent.ok, true)
    assert.equal(writes, 0, 'unchanged assets rewrote the entire sync record')
    assert.equal(fs.readFileSync(index, 'utf8'), indexBefore, 'key order alone rewrote the index')
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, uploadsBefore)
  })

  it('同步全部语言、对比分镜和依赖，叶子变化更新固定版本且不覆盖本地 JSON（#321）', async () => {
    const setup = `
      const fs = require('fs')
      fs.writeFileSync('todo/zh.png', '中文')
      fs.writeFileSync('todo/en.png', 'English')
      fs.writeFileSync('todo/page.html', '<!doctype html><html><body>幻灯片</body></html>')
      fs.writeFileSync('todo/deck.json', JSON.stringify({ slides: [{ id: 'p1', preview: { src: './page.html' }, assets: ['zh.png'] }] }, null, 2))
      fs.writeFileSync('todo/board.json', JSON.stringify({ shots: [{ id: 'S1', frames: [{ src: 'zh.png' }] }] }))
      fs.writeFileSync('todo/time.json', '[{"id":"S1","start":0,"end":1,"name":"一"}]')
      fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Asset src="zh.png" variants=\\'{"中文":"zh.png","English":"en.png"}\\' />\\n\\n<Compare a="zh.png" b="board.json" shots="time.json" />\\n\\n<Storyboard src="deck.json" />\\n')
    `
    const first = await runTask('j1', setup)
    assert.equal(first.outcome, 'done', first.reason)
    const refs = () => JSON.parse(cloud.file('assets/task_1.json')!)
    const initial = refs()
    for (const name of ['zh.png', 'en.png', 'page.html', 'deck.json', 'board.json', 'time.json']) assert.equal(initial[name].version, 1, name)
    assert.equal(cloud.types.get(initial['board.json'].artifact), 'storyboard')
    assert.equal(cloud.types.get(initial['time.json'].artifact), 'asset')
    const deck = JSON.parse(cloud.task.artifacts.get(initial['deck.json'].artifact)![0]!.toString())
    assert.equal(deck.slides[0].preview.src, initial['page.html'].artifact)
    assert.equal(deck.slides[0].assets[0], initial['zh.png'].artifact)
    const source = read('todo/deck.json')
    assert.equal(JSON.parse(source).slides[0].preview.src, './page.html')
    const uploads = () => cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length
    const count = uploads()
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal(uploads(), count, '未变化的文件不重传')
    assert.equal(read('todo/deck.json'), source, '分镜源码的路径与排版未被云端展示数据覆盖')
    const changed = await runTask('j3', `const fs = require('fs'); fs.writeFileSync('todo/en.png', 'English 2'); fs.writeFileSync('todo/zh.png', '中文 2')`)
    assert.equal(changed.outcome, 'done', changed.reason)
    assert.equal(refs()['en.png'].version, 2)
    assert.equal(refs()['zh.png'].version, 2)
    assert.equal(refs()['deck.json'].version, 1)
    assert.equal(uploads(), count + 2)
    const removed = await runTask('j4', `const fs = require('fs'); fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)})`)
    assert.equal(removed.outcome, 'done', removed.reason)
    assert.equal(refs()['deck.json'], undefined)
    assert.ok(cloud.task.artifacts.has(initial['deck.json'].artifact))
  })

  it('页面的图片和字体随页面上传：共用文件传一次，缺失的引用只记在该页，拉回后还原路径（#458）', async () => {
    const setup = `
      const fs = require('fs')
      fs.mkdirSync('todo/pages', { recursive: true }); fs.mkdirSync('todo/fonts', { recursive: true })
      fs.writeFileSync('todo/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
      fs.writeFileSync('todo/fonts/a.otf', 'font')
      fs.writeFileSync('todo/pages/deck.css', '@font-face {\\n  src: url("../fonts/a.otf")\\n}')
      for (const n of ['one', 'two']) fs.writeFileSync('todo/pages/' + n + '.html', '<html><head><link rel="stylesheet" href="deck.css"></head><body><img src="../logo.svg"></body></html>')
      fs.writeFileSync('todo/pages/bad.html', '<html><body><img src="../gone.png"></body></html>')
      fs.writeFileSync('todo/deck.json', JSON.stringify({ slides: ['one', 'two', 'bad'].map(id => ({ id, preview: { src: 'pages/' + id + '.html' } })) }))
      fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Storyboard src="deck.json" />\\n')
    `
    const first = await runTask('j1', setup)
    assert.equal(first.outcome, 'done', first.reason)
    const refs = () => JSON.parse(cloud.file('assets/task_1.json')!)
    const initial = refs()
    const page = cloud.task.artifacts.get(initial['pages/one.html'].artifact)!.at(-1)!.toString()
    assert.ok(page.includes(`src="${initial['logo.svg'].artifact}"`), page)
    const sheet = initial['pages/deck.css'].artifact
    assert.ok(page.includes(`href="${sheet}"`), page)
    const css = cloud.task.artifacts.get(sheet)!.at(-1)!.toString()
    assert.ok(css.includes(`url("${initial['fonts/a.otf'].artifact}")`), css)
    assert.equal(cloud.task.artifacts.get(sheet)!.length, 1)
    assert.equal(cloud.task.artifacts.get(initial['fonts/a.otf'].artifact)!.length, 1)
    assert.match(initial['pages/bad.html'].error, /gone\.png/)
    assert.equal(initial['pages/one.html'].error, undefined)
    const uploads = () => cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length
    const count = uploads()
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal(uploads(), count, '未变化的页面和依赖不重传')

    const gone = await runTask('j3', `require('fs').rmSync('todo/pages/one.html')`)
    assert.equal(gone.outcome, 'done', gone.reason)
    const recordFile = path.join(board(), '.sync/task_1.json')
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    delete record.assets['pages/one.html']
    delete record.assets['pages/deck.css']
    fs.rmSync(path.join(board(), 'todo/pages/deck.css'))
    fs.writeFileSync(recordFile, JSON.stringify(record))
    assert.equal((await runTask('j4')).outcome, 'done')
    const pulled = read('todo/pages/one.html')
    assert.ok(pulled.includes('src="../logo.svg"') && pulled.includes('href="deck.css"'), pulled)
    assert.match(read('todo/pages/deck.css'), /url\("\.\.\/fonts\/a\.otf"\)/)
    assert.equal(uploads(), count, '拉回的页面不再上传')
  })

  it('文档里的图片随文档上传，未变化不重传，拉回后还原路径（#497）', async () => {
    const setup = `
      const fs = require('fs')
      fs.mkdirSync('todo/trial/moves', { recursive: true })
      fs.writeFileSync('todo/trial/moves/idle.gif', 'gif')
      fs.writeFileSync('todo/trial/notes.md', '# 试跑\\n\\n![待机](moves/idle.gif)\\n')
      fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Asset src="trial/notes.md" />\\n')
    `
    const first = await runTask('j1', setup)
    assert.equal(first.outcome, 'done', first.reason)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    const gif = refs['trial/moves/idle.gif']?.artifact
    assert.ok(gif, JSON.stringify(refs))
    assert.ok(cloud.task.artifacts.get(refs['trial/notes.md'].artifact)!.at(-1)!.toString().includes(`![待机](${gif})`))
    const uploads = () => cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length
    const count = uploads()
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal(uploads(), count, '未变化的文档不重传')

    // 本机丢了文档、只剩云端时，图片要有别处引用才留在清单里。
    assert.equal((await runTask('j3', `require('fs').appendFileSync('${CARD}', '\\n<Asset src="trial/moves/idle.gif" />\\n')`)).outcome, 'done')
    const count3 = uploads()
    fs.rmSync(path.join(board(), 'todo/trial/notes.md'))
    const recordFile = path.join(board(), '.sync/task_1.json')
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    delete record.assets['trial/notes.md']
    fs.writeFileSync(recordFile, JSON.stringify(record))
    assert.equal((await runTask('j4')).outcome, 'done')
    assert.ok(read('todo/trial/notes.md').includes('![待机](moves/idle.gif)'), read('todo/trial/notes.md'))
    assert.equal((await runTask('j5')).outcome, 'done')
    assert.equal(uploads(), count3, '拉回的文档不再上传')
  })

  it('旧清单重新同步时固定版本，未引用的新版本不影响本机预览（#321）', async () => {
    cloud.put({ 'assets/task_1.json': JSON.stringify({ 'hero.png': { artifact: 'art_1' }, 'shots/a.png': { artifact: 'art_2', version: 1 } }) })
    const first = await runTask('j1')
    assert.equal(first.outcome, 'done', first.reason)
    assert.deepEqual(JSON.parse(cloud.file('assets/task_1.json')!)['hero.png'], { artifact: 'art_1', version: 1 })
    cloud.task.artifacts.get('art_1')!.push(Buffer.from('未引用的新版'))
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal(read('todo/hero.png'), 'hero-1')
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, 0)
  })

  for (const source of ['文件', '字符串', '对象']) it(`普通 JSON ${source}版本保留内容，删除重下、旧记录与真实编辑往返稳定（#364）`, async () => {
    const original = '{\r\n  "big": 9007199254740993, "text": "\\u4e2d", "exponent": 1e+03, "decimal": 1.2300,\r\n  "b": "art_2", "a": "art_1", "shots": [{"frames":[{"src":"art_1"}]}],\r\n  "slides": [{"preview":{"src":"art_2"},"assets":["art_1"]}]\r\n}\r\n'
    const bytes = Buffer.from(source === '对象' ? JSON.stringify(JSON.parse(original)) : original)
    cloud.types.set('art_json', 'asset')
    cloud.task.artifacts.set('art_json', [bytes])
    if (source !== '文件') cloud.versionContent.set('art_json/1', source === '字符串' ? original : JSON.parse(original))
    cloud.put({
      [CARD]: `${BODY}\n<Asset src="data.json" />\n`,
      'assets/task_1.json': JSON.stringify({ ...JSON.parse(cloud.file('assets/task_1.json')!), 'data.json': { artifact: 'art_json' } }),
    })
    const first = await runTask('j1')
    assert.equal(first.outcome, 'done', first.reason)
    const target = path.join(board(), 'todo/data.json')
    assert.deepEqual(fs.readFileSync(target), bytes)
    const manifest = cloud.file('assets/task_1.json')
    const recordFile = path.join(board(), '.sync/task_1.json')
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    delete record.assets['data.json'].kind
    delete record.assets['data.json'].dependencies
    delete record.assets['data.json'].localHash
    fs.writeFileSync(recordFile, JSON.stringify(record))
    assert.equal((await runTask('j2')).outcome, 'done')
    const stale = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
    stale.assets['data.json'].kind = 'storyboard'
    fs.writeFileSync(recordFile, JSON.stringify(stale))
    fs.unlinkSync(target)
    assert.equal((await runTask('j3')).outcome, 'done')
    assert.deepEqual(fs.readFileSync(target), bytes)
    fs.writeFileSync(recordFile, JSON.stringify(stale))
    assert.equal((await runTask('j4')).outcome, 'done')
    assert.equal(cloud.file('assets/task_1.json'), manifest)
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, 0)
    const edited = Buffer.concat([bytes, Buffer.from('  \r\n')])
    fs.writeFileSync(target, edited)
    assert.equal((await runTask('j5')).outcome, 'done')
    assert.equal((await runTask('j6')).outcome, 'done')
    assert.deepEqual(cloud.task.artifacts.get('art_json'), [bytes, edited])
    assert.equal(JSON.parse(cloud.file('assets/task_1.json')!)['data.json'].version, 2)
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, 1)
  })

  it('分镜与对比的未匹配引用和外部地址保持原字节（#364）', async () => {
    const samples = {
      storyboard: '{\r\n "shots": [{"frames":[{"src":"art_missing"}]}], "a": "art_1", "b": "art_2"\r\n}\r\n',
      compare: '{\r\n "a": "art_missing", "b": "https://example.com/b", "slides": [{"preview":{"src":"art_1"}}]\r\n}\r\n',
    }
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    for (const [kind, text] of Object.entries(samples)) {
      cloud.types.set(kind, kind)
      cloud.task.artifacts.set(kind, [Buffer.from(text)])
      refs[`${kind}.json`] = { artifact: kind, version: 1 }
    }
    cloud.put({ 'assets/task_1.json': JSON.stringify(refs) })
    await prepareBoard()
    for (const [kind, text] of Object.entries(samples)) assert.deepEqual(fs.readFileSync(path.join(board(), `todo/${kind}.json`)), Buffer.from(text))
  })

  it('旧预览记录补充类型与哈希时保留源码及待上传修改（#364）', async () => {
    const setup = `const fs = require('fs'); fs.writeFileSync('todo/board.json', JSON.stringify({ shots: [{ frames: [{ src: 'hero.png' }] }] }, null, 2) + '\\n'); fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Storyboard src="board.json" />\\n')`
    const first = await runTask('j1', setup)
    assert.equal(first.outcome, 'done', first.reason)
    const source = read('todo/board.json')
    const recordFile = path.join(board(), '.sync/task_1.json')
    const strip = () => {
      const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
      for (const field of ['kind', 'dependencies', 'localHash']) delete record.assets['board.json'][field]
      delete record.task
      fs.writeFileSync(recordFile, JSON.stringify(record))
    }
    strip()
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal(read('todo/board.json'), source)
    const ref = JSON.parse(cloud.file('assets/task_1.json')!)['board.json']
    assert.equal(ref.version, 1)
    strip()
    const edited = JSON.parse(source)
    edited.title = '新标题'
    fs.writeFileSync(path.join(board(), 'todo/board.json'), JSON.stringify(edited, null, 2))
    assert.equal((await runTask('j3')).outcome, 'done')
    assert.equal(JSON.parse(read('todo/board.json')).title, '新标题')
    assert.equal(cloud.task.artifacts.get(ref.artifact)!.length, 2)
    assert.equal(JSON.parse(cloud.task.artifacts.get(ref.artifact)![1]!.toString()).title, '新标题')
  })

  it('预览无匹配引用时保持原字节和版本，类型读取失败可重试（#364）', async () => {
    const bytes = Buffer.from('{\r\n  "shots": [{"frames":[{"src":"https://example.com/frame.png"}]}], "big": 9007199254740993\r\n}\r\n')
    cloud.types.set('art_json', 'storyboard')
    cloud.task.artifacts.set('art_json', [bytes])
    cloud.put({
      [CARD]: `${BODY}\n<Storyboard src="data.json" />\n`,
      'assets/task_1.json': JSON.stringify({ ...JSON.parse(cloud.file('assets/task_1.json')!), 'data.json': { artifact: 'art_json', version: 1 } }),
    })
    cloud.failArtifactRead = 'art_json'
    const waiting = runTask('j1')
    await until(() => !!readCheckpoint('j1')?.syncRetries?.prepare)
    assert.equal(fs.existsSync(path.join(board(), 'todo/data.json')), false)
    assert.equal(fs.existsSync(path.join(board(), '.sync/task_1.json')), false)
    cloud.failArtifactRead = null
    const retry = await waiting
    assert.equal(retry.outcome, 'done', retry.reason)
    assert.deepEqual(fs.readFileSync(path.join(board(), 'todo/data.json')), bytes)
    cloud.failArtifactRead = 'art_json'
    assert.equal((await runTask('j3')).outcome, 'done')
    assert.equal((await runTask('j4')).outcome, 'done')
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, 0)
    assert.equal(cloud.task.artifacts.get('art_json')!.length, 1)
  })

  it('嵌套对比按类型恢复路径、保留非展示字段与固定版本（#364）', async () => {
    const old = path.join(cached(), '.akb/boards/.akb/kanban')
    fs.mkdirSync(path.join(old, 'assets/1'), { recursive: true })
    fs.writeFileSync(path.join(old, 'assets/1/local.txt'), 'Unsynced')
    const data = {
      'art_compare': { a: 'art_board', b: 'art_1', shots: 'art_time', slides: [{ preview: { src: 'art_2' } }] },
      'art_board': { slides: [{ preview: { src: 'art_page' }, assets: ['art_2', 'https://example.com/file'] }], a: 'art_1' },
      'art_time': [{ id: 'S1', start: 0, end: 1 }],
      'art_page': '<main>幻灯片</main>',
    }
    for (const [id, value] of Object.entries(data)) {
      cloud.task.artifacts.set(id, [Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\r\n')])
      cloud.types.set(id, id === 'art_compare' ? 'compare' : id === 'art_board' ? 'storyboard' : id === 'art_page' ? 'html' : 'asset')
    }
    cloud.put({
      [CARD]: '<Compare a="decks/compare.json" b="hero.png" />\n',
      'assets/task_1.json': JSON.stringify({
        'hero.png': { artifact: 'art_1', version: 1 },
        '.assets/1/a.png': { artifact: 'art_2', version: 1 },
        'decks/compare.json': { artifact: 'art_compare', version: 1 },
        'decks/board.json': { artifact: 'art_board', version: 1 },
        'time.json': { artifact: 'art_time', version: 1 },
        '.assets/1/page.html': { artifact: 'art_page', version: 1 },
      }),
    })
    const first = await runTask('j1')
    assert.equal(first.outcome, 'done', first.reason)
    const assets = path.join(projectStateDir(board()), 'assets/1')
    assert.ok(!fs.existsSync(old))
    assert.equal(fs.readFileSync(path.join(assets, 'local.txt'), 'utf8'), 'Unsynced')
    assert.equal(fs.readFileSync(path.join(assets, 'page.html'), 'utf8'), data.art_page)
    const compare = JSON.parse(read('todo/decks/compare.json'))
    assert.equal(compare.a, 'board.json')
    assert.equal(compare.b, '../hero.png')
    assert.equal(compare.shots, '../time.json')
    assert.equal(compare.slides[0].preview.src, 'art_2')
    const deck = JSON.parse(read('todo/decks/board.json'))
    assert.equal(deck.slides[0].preview.src, '.assets/1/page.html')
    assert.deepEqual(deck.slides[0].assets, ['.assets/1/a.png', 'https://example.com/file'])
    assert.equal(deck.a, 'art_1')
    const manifest = cloud.file('assets/task_1.json')
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal((await runTask('j3')).outcome, 'done')
    assert.equal(cloud.file('assets/task_1.json'), manifest)
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, 0)
    fs.writeFileSync(path.join(board(), 'todo/time.json'), JSON.stringify({ a: 'hero.png', b: 'decks/board.json' }))
    const changed = await runTask('j4')
    assert.equal(changed.outcome, 'done', changed.reason)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.notEqual(refs['time.json'].artifact, 'art_time')
    assert.equal(refs['decks/compare.json'].version, 2)
    assert.equal(JSON.parse(cloud.task.artifacts.get('art_compare')![1]!.toString()).shots, refs['time.json'].artifact)
    assert.equal((await runTask('j5')).outcome, 'done')
    assert.equal(cloud.task.artifacts.get('art_compare')!.length, 2)
  })

  it('下载嵌套分镜后还原相对路径，下一次同步不重传（#321）', async () => {
    cloud.types.set('art_board', 'storyboard')
    cloud.task.artifacts.set('art_board', [Buffer.from(JSON.stringify({ slides: [{ preview: { src: 'art_1' }, assets: ['art_2'] }] }))])
    cloud.put({
      [CARD]: `${BODY}\n<Storyboard src="decks/board.json" />\n`,
      'assets/task_1.json': JSON.stringify({ 'hero.png': { artifact: 'art_1', version: 1 }, 'shots/a.png': { artifact: 'art_2', version: 1 }, 'decks/board.json': { artifact: 'art_board', version: 1 } }),
    })
    const first = await runTask('j1')
    assert.equal(first.outcome, 'done', first.reason)
    const local = JSON.parse(read('todo/decks/board.json'))
    assert.equal(local.slides[0].preview.src, '../hero.png')
    assert.deepEqual(local.slides[0].assets, ['../shots/a.png'])
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, 0)
  })

  for (const code of ['storage_limit', 'offline']) it(`上传中途失败不提交卡片，重试复用已上传文件：${code}（#321）`, async () => {
    const card = cloud.file(CARD)
    const manifest = cloud.file('assets/task_1.json')
    cloud.uploadFailure = { after: 1, code }
    const failed = await runTask('j1', `const fs = require('fs'); fs.writeFileSync('todo/first.png', '先'); fs.writeFileSync('todo/second.png', '后'); fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Compare a="first.png" b="second.png" />\\n')`)
    assert.equal(failed.outcome, code === 'offline' ? 'done' : 'failed')
    const first = [...cloud.task.artifacts].find(([, versions]) => versions[0]?.toString() === '先')!
    assert.ok(first)
    if (code !== 'offline') {
      assert.equal(cloud.file(CARD), card)
      assert.equal(cloud.file('assets/task_1.json'), manifest)
      const retry = await runTask('j2')
      assert.equal(retry.outcome, 'done', retry.reason)
    }
    assert.equal(cloud.log.filter(l => l === `PUT /v1/uploads/upl_${first[0]}`).length, 1)
    assert.equal(JSON.parse(cloud.file('assets/task_1.json')!)['first.png'].artifact, first[0])
  })

  it('资源依赖循环仍阻止推送（#321）', async () => {
    const card = cloud.file(CARD)
    const failed = await runTask('j1', `const fs = require('fs'); fs.writeFileSync('todo/bad.json', '{"a":"bad.json","b":"hero.png"}'); fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Compare a="bad.json" b="hero.png" />\\n')`)
    assert.equal(failed.outcome, 'failed')
    assert.match(failed.reason!, /preview attachments|预览附件/)
    assert.doesNotMatch(failed.reason!, /bad\.json/)
    assert.equal(cloud.file(CARD), card)
  })

  it('首次拉取下载 .assets/ 预览；拉不下来的预览不阻止回复（#516）', async () => {
    cloud.task.artifacts.set('art_a', [Buffer.from('A')])
    cloud.put({
      [CARD]: `${BODY}\n<Compare a=".assets/1/a.png" b=".assets/1/gone.png" />\n`,
      'assets/task_1.json': JSON.stringify({ '.assets/1/a.png': { artifact: 'art_a', version: 1 }, '.assets/1/gone.png': { artifact: 'art_gone', version: 1 } }),
    })
    const first = await runTask('j1')
    assert.equal(first.outcome, 'done', first.reason)
    const state = projectStateDir(board())
    assert.equal(fs.readFileSync(path.join(state, 'assets/1/a.png'), 'utf8'), 'A')
    fs.rmSync(path.join(state, 'assets/1'), { recursive: true })
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
    fs.symlinkSync(outside, path.join(state, 'assets/1'))
    const linked = await runTask('j2')
    assert.equal(linked.outcome, 'done', linked.reason)
    assert.equal(fs.existsSync(path.join(outside, 'a.png')), false)
    assert.match(JSON.parse(cloud.file('assets/task_1.json')!)['.assets/1/a.png'].error, /outside the board/)
  })

  it('越界符号链接只标为损坏、不上传（#321, #457）', async () => {
    const outside = path.join(runnerHome(), 'outside.json')
    const linked = await runTask('j1', `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(outside)}, '{}'); fs.symlinkSync(${JSON.stringify(outside)}, 'todo/bad.json'); fs.writeFileSync('${CARD}', ${JSON.stringify(BODY)} + '\\n<Storyboard src="bad.json" />\\n')`)
    assert.equal(linked.outcome, 'done', linked.reason)
    assert.equal(JSON.parse(cloud.file('assets/task_1.json')!)['bad.json'].error, 'link outside the board: bad.json')
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, 0)
  })

  it('rejects invalid board-state paths and dangling links in preview dependencies', async () => {
    const old = path.join(cached(), '.akb/boards/.akb/kanban/assets/1/old.png')
    const edit = `
      const fs = require('fs')
      fs.symlinkSync(${JSON.stringify(old)}, 'todo/linked.png')
      fs.writeFileSync('todo/page.html', '<img src="linked.png">')
      fs.writeFileSync('${CARD}', ${JSON.stringify(`${BODY}\n<Asset src="${old}" />\n\n<Asset src="page.html" />\n`)})
    `
    const result = await runTask('legacy-refs', edit)
    assert.equal(result.outcome, 'done', result.reason)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    for (const ref of [refs[old], refs['page.html']]) assert.match(ref.error, /Invalid nested board state path.*asset:<path>/)
    assert.equal(cloud.log.filter(l => l.startsWith('PUT /v1/uploads/')).length, 0)
  })

  for (const interruption of ['upload', 'references']) it(`retries reply Preview writeback after a failed ${interruption}`, async () => {
    const screen = '.assets/1/screen.png'
    const page = '.assets/1/page.html'
    const detail = '.assets/1/detail.svg'
    const retained = '.assets/1/approved.png'
    const body = `# Design

<Preview id="ui-design">

Old design

<Asset src="${screen}" />

<Asset src="${page}" />

</Preview>

<Preview id="api-docs">

<Asset src="${retained}" />

</Preview>
`
    const refs = 'assets/task_1.json'
    cloud.types.set('art_page', 'html')
    cloud.types.set('art_detail', 'image')
    cloud.task.artifacts.set('art_2', [Buffer.from('approved image')])
    cloud.task.artifacts.set('art_page', [Buffer.from('<img src="art_detail">')])
    cloud.task.artifacts.set('art_detail', [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><title>Old</title></svg>')])
    const before = { [screen]: { artifact: 'art_1', version: 1 },
      [page]: { artifact: 'art_page', version: 1, dependencies: [detail] }, [detail]: { artifact: 'art_detail', version: 1 },
      [retained]: { artifact: 'art_2', version: 1 } }
    cloud.put({ [CARD]: body, [refs]: JSON.stringify(before) })
    await prepareBoard()
    const assets = path.join(projectStateDir(board()), 'assets/1')
    const next = body.replace('Old design', 'Updated design')
    const pageSource = '<img src="detail.svg"><button>Interactive Preview</button>'
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>Current</title></svg>'
    const gate = path.join(runnerHome(), 'edit-preview')
    const edit = `
      const fs = require('fs')
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(gate)})) return
        clearInterval(timer)
        fs.writeFileSync(${JSON.stringify(path.join(board(), CARD))}, ${JSON.stringify(next)})
        fs.writeFileSync(${JSON.stringify(path.join(assets, 'screen.png'))}, 'new screenshot')
        fs.writeFileSync(${JSON.stringify(path.join(assets, 'page.html'))}, ${JSON.stringify(pageSource)})
        fs.writeFileSync(${JSON.stringify(path.join(assets, 'detail.svg'))}, ${JSON.stringify(svg)})
        fs.rmSync(${JSON.stringify(path.join(assets, 'approved.png'))})
      }, 15)
    `
    const release = () => { cloud.serviceUnavailableUploads = false; cloud.boardWritesUnavailable = false }
    const target = { task: 'task_1', project: 'prj_1', number: 1, chat: { message: 'msg_1117', body: 'Update the Preview' } }
    start(edit, { syncBackoff: () => 0, api: { ...api, finishJob: async (...args) => {
      if (args[2] === 'done' && args[1] === 'preview-retry') {
        const pins = JSON.parse(cloud.file(refs)!)
        assert.equal(cloud.file(CARD), next)
        assert.deepEqual(pins[page].dependencies, [detail])
        assert.deepEqual(pins[retained], before[retained])
        for (const [src, value] of [[screen, 'new screenshot'], [detail, svg]]) {
          const pin = pins[src!]!
          assert.equal(pin.version, 2)
          assert.equal(cloud.task.artifacts.get(pin.artifact)![pin.version - 1]!.toString(), value)
        }
        assert.equal(args[4]?.replyWriteSynced, true)
      }
      return api.finishJob(...args)
    } } })
    try {
      // Fail after preparation so this exercises the reply's result writeback.
      const job = cloud.dispatch({ id: 'preview-init', ...target })
      await until(() => planned.length === 1)
      if (interruption === 'upload') cloud.serviceUnavailableUploads = true
      else cloud.boardWritesUnavailable = true
      fs.writeFileSync(gate, '')
      await until(() => job.state === 'finished')
      assert.equal(job.outcome, 'failed', job.reason)
      assert.deepEqual(job.report?.recovery, { safe: false, stopped: true, resumable: true, writeback: true })
      assert.equal(job.report?.replyWriteSynced, undefined)
      assert.equal(cloud.file(CARD), body)
      assert.deepEqual(JSON.parse(cloud.file(refs)!), before)
      assert.equal(read(CARD), next)
      assert.equal(readCheckpoint(job.id)?.completed?.outcome, 'done')
      release()
      const retry = cloud.dispatch({ id: 'preview-retry', ...target, manualRecovery: true, recoveryOf: job.id })
      await until(() => retry.state === 'finished')
      assert.equal(retry.outcome, 'done', retry.reason)
      assert.equal(planned.length, 1)
      assert.equal(cloud.task.artifacts.get('art_1')!.length, 2)
    } finally { release() }
  })

  it('sends back assets first, then the card and its assets list', async () => {
    const edit = `
      const fs = require('fs')
      fs.writeFileSync('${CARD}', fs.readFileSync('${CARD}', 'utf8') + ' ![](new.png)')
      fs.writeFileSync('todo/new.png', 'new-1')
      fs.writeFileSync('todo/hero.png', 'hero-mine')
    `
    const job = await runTask('j1', edit)
    assert.equal(job.outcome, 'done', job.reason)
    assert.match(cloud.file(CARD)!, /new\.png/)
    const { artifacts } = cloud.task
    const list = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.equal(artifacts.get('art_1')!.at(-1)!.toString(), 'hero-mine')
    assert.deepEqual(list['hero.png'], { artifact: 'art_1', version: 2 })
    assert.deepEqual(list['shots/a.png'], { artifact: 'art_2', version: 1 })
    assert.equal(artifacts.get(list['new.png'].artifact)![list['new.png'].version - 1]!.toString(), 'new-1')
    const uploadAt = cloud.log.findIndex((l) => l.startsWith('PUT /v1/uploads/'))
    assert.ok(uploadAt >= 0 && uploadAt < cloud.log.findIndex((l) => l.endsWith('/board/commits')), 'assets went after the card')
  })

  it('lands two computers’ changes to different files without merging anything', async () => {
    cloud.beforeNextCommit = () => cloud.put({ 'memory/readme.md': 'Shipped, from the other computer' })
    const job = await runTask('j1', `require('fs').writeFileSync('rules/proposer.md', 'mine')`)
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(commits().length, 1, 'a write to another file was merged')
    assert.equal(cloud.file('rules/proposer.md'), 'mine')
    assert.equal(cloud.file('memory/readme.md'), 'Shipped, from the other computer')
  })

  it('merges a file both sides changed here, and writes it once more', async () => {
    cloud.beforeNextCommit = () => cloud.put({ [CARD]: BODY.replace('# Pricing', '# Pricing, two tiers') })
    const job = await runTask('j1', `require('fs').writeFileSync('${CARD}', require('fs').readFileSync('${CARD}', 'utf8').replace('Tiers.', 'Tiers, yearly first.'))`)
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(commits().length, 2)
    assert.equal(cloud.file(CARD), BODY.replace('# Pricing', '# Pricing, two tiers').replace('Tiers.', 'Tiers, yearly first.'))
    assert.equal(read(CARD), cloud.file(CARD))
  })

  it('preserves opposite requirements and the rejected atomic batch when the agent cannot resolve (#806)', async () => {
    cloud.beforeNextCommit = () => cloud.put({ [CARD]: BODY.replace('Tiers.', 'Tiers, monthly first.') })
    const job = await runTask('j1', `
      require('fs').writeFileSync('${CARD}', require('fs').readFileSync('${CARD}', 'utf8').replace('Tiers.', 'Tiers, yearly first.'))
      require('fs').writeFileSync('memory/readme.md', 'Mine')`)
    assert.equal(job.outcome, 'failed')
    assert.match(job.reason!, /unresolved/)
    assert.equal(cloud.file(CARD), BODY.replace('Tiers.', 'Tiers, monthly first.'))
    assert.equal(cloud.file('memory/readme.md'), 'Shipped')
    const conflict = conflictShow(board(), conflictList(board())[0]!.id)
    assert.equal(conflict.files.find(f => f.path === CARD)!.base.content, BODY)
    assert.equal(conflict.files.find(f => f.path === CARD)!.local.content, BODY.replace('Tiers.', 'Tiers, yearly first.'))
    assert.equal(conflict.files.find(f => f.path === 'memory/readme.md')!.conflicted, false)
    assert.equal(read(CARD), BODY.replace('Tiers.', 'Tiers, yearly first.'))
    assert.equal(planned.length, 2)
    assert.equal(planned[1]!.resume, 'fresh-session')
    assert.match(planned[1]!.prompt, /resolve-conflict/)
  })

  it('merges one-sided changes to repetitive files without expensive diffing', () => {
    const base = `head\n${'  },\n'.repeat(2000)}tail\n`
    const changed = `${base}added\n`
    const started = performance.now()
    assert.deepEqual(mergeFile(base, base, changed), { content: changed })
    assert.deepEqual(mergeFile(base, changed, base), { content: changed })
    assert.ok(performance.now() - started < 1000, 'one-sided changes entered the expensive diff')
    assert.deepEqual(mergeFile(base, base, null), { content: null })
    assert.deepEqual(mergeFile(base, null, base), { content: null })
  })

  it('preserves metadata conflicts for an explicit decision (#806)', () => {
    const card = (status: string) => `---\ntitle: A\nstatus: ${status}\n---\n\nBody\n`
    assert.deepEqual(mergeFile(card('ready'), card('planning'), card('done')), { content: card('planning'), conflict: true })
  })

  const resolveScript = `
    const fs = require('fs'), cp = require('child_process'), path = require('path');
    const cli = ${JSON.stringify(path.join(process.env.RUNNER_DIST ?? '', 'akb/bin/ai4kanban.mjs'))};
    const command = (...args) => {
      const ran = cp.spawnSync(process.execPath, [cli, '--board', process.env.AI4KANBAN_BOARD, 'raw', 'conflict', ...args, '--json'], { encoding: 'utf8' });
      if (ran.status !== 0) throw Error(ran.stdout + ran.stderr);
      return JSON.parse(ran.stdout);
    };
    for (const c of command('list').conflicts) {
      const shown = command('show', c.id).conflict;
      const file = path.join(process.env.AI4KANBAN_BOARD, '.sync/resolution.json');
      fs.writeFileSync(file, JSON.stringify({ files: shown.files.filter(f => f.conflicted).map(f => ({ path: f.path, content: 'Settled cadence' })) }));
      command('resolve', c.id, '--expect', shown.revision, '--file', file);
    }
  `

  for (const when of ['preflight', 'running', 'submission']) it(`resolves ${when} conflicts inside the same task and continues automatically (#806)`, async () => {
    cloud.put({ 'config.md': '# Board\n' })
    await prepareBoard()
    const original = `const fs = require('fs'); fs.appendFileSync('original-work.txt', 'once\\n'); fs.writeFileSync('.akb/kanban/memory/readme.md', 'yearly first');`
    if (when === 'preflight') {
      fs.writeFileSync(path.join(board(), 'memory/readme.md'), 'yearly first')
      cloud.put({ 'memory/readme.md': 'monthly first' })
    }
    if (when === 'submission') cloud.beforeNextCommit = () => cloud.put({ 'memory/readme.md': 'monthly first' })
    const gated = gatedScript(original)
    start('', { plan: (r, prompt, cwd, resume) => {
      const resolving = prompt.includes('resolve-conflict')
      const closing = prompt.includes('return the saved result')
      return fakeRuntime(resolving ? resolveScript + (closing ? '' : `; require('fs').appendFileSync('original-work.txt', 'once\\n')`)
        : when === 'running' ? gated.script : original)(r, prompt, cwd, resume)
    } })
    const job = cloud.dispatch({ id: crypto.randomUUID(), task: 'task_1', project: 'prj_1', number: 1, studio: 'wf_own' })
    if (when === 'running') {
      await until(() => fs.existsSync(path.join(cached(), 'original-work.txt')))
      cloud.put({ 'memory/readme.md': 'monthly first' })
      assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, false)
      assert.equal(job.state, 'claimed')
      assert.equal(pendingConflicts(board()).length, 1)
      gated.release()
    }
    await until(() => job.state === 'finished', 10_000)
    assert.equal(job.outcome, 'done', job.reason + '\n' + job.events.map(e => e.text).join(''))
    assert.equal(fs.readFileSync(path.join(cached(), 'original-work.txt'), 'utf8'), 'once\n')
    assert.equal(cloud.file('memory/readme.md'), 'Settled cadence')
    assert.equal(pendingConflicts(board()).length, 0)
    assert.equal(planned.length, when === 'preflight' ? 1 : 2)
    if (planned.length === 2) assert.equal(planned[1]!.resume, planned[0]!.resume ?? 'fresh-session')
    assert.ok(!cloud.log.some(l => l.includes('finish') && l.includes('conflict')))
  })

  it('waits for another task to publish its preparation and stops a queued task cleanly (#882)', async () => {
    await prepareBoard()
    const holder = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cached())
    const next = openTaskFolder({ task: 'task_2', project: 'prj_1', number: 2 }, cached())
    let release!: () => void
    let entered = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = withBoard(holder, async () => {
      fs.writeFileSync(path.join(board(), 'memory/readme.md'), 'temporary preparation')
      entered = true
      await gate
      fs.writeFileSync(path.join(board(), 'memory/readme.md'), 'Shipped')
    })
    await until(() => entered)
    let stopped = false, created = 0
    const cancelled = withBoard(next, async () => { created++ }, () => stopped)
    const ready = pull(next, MACHINE)
    try {
      assert.equal(await Promise.race([ready.then(() => 'early'), new Promise(resolve => setTimeout(resolve, 160, 'waiting'))]), 'waiting')
      stopped = true
      await cancelled
      assert.equal(created, 0)
      assert.equal(cloud.file('memory/readme.md'), 'Shipped')
    } finally { release(); await original }
    assert.ok((await ready).ok)
    await withBoard(next, async () => { created++ })
    assert.equal(created, 1)
    assert.equal(cloud.file('memory/readme.md'), 'Shipped')
  })

  it('repairs a required Preview attachment in the saved task session (#885)', async () => {
    await prepareBoard()
    const output = `
<Preview id="ui-design">

<Asset src="required.txt" label="Result" />

</Preview>
`
    const original = `const fs = require('fs'); fs.appendFileSync('.akb/kanban/${CARD}', ${JSON.stringify(output)}); fs.appendFileSync('original-work.txt', 'once')`
    const repair = "require('fs').writeFileSync('.akb/kanban/todo/required.txt', 'original result')"
    start('', { plan: (r, prompt, cwd, resume) => fakeRuntime(prompt.includes('Correct the diagnostics') ? repair : original)(r, prompt, cwd, resume) })
    const job = cloud.dispatch({ id: 'attachment-repair', task: 'task_1', project: 'prj_1', number: 1, studio: 'wf_own' })
    await until(() => job.state === 'finished', 10_000)
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(planned.length, 2)
    assert.equal(planned[1]!.resume, 'fresh-session')
    assert.match(planned[1]!.prompt, /required\.txt: file not found/)
    assert.equal(fs.readFileSync(path.join(cached(), 'original-work.txt'), 'utf8'), 'once')
    const pin = JSON.parse(cloud.file('assets/task_1.json')!)['required.txt']
    assert.equal(cloud.task.artifacts.get(pin.artifact)?.[pin.version - 1]?.toString(), 'original result')
  })

  it('reconciles an archived Coding Preview copy without hiding a substantive conflict (#874, #842)', async () => {
    const archive = '.archive/842-coding-preview-memory.md'
    const modern = '# Archive\n\n<Preview id="prompts">\n\nOriginal result.\n\n</Preview>\n\n## Scope\n\nArchived.\n'
    const old = '# Archive\n\n## By `prompt-writer` agent\n\nOriginal result.\n\n## Scope\n\nArchived.\n'
    cloud.put({ [archive]: modern })
    await prepareBoard()
    const ws = keptBoard(cached())!
    fs.writeFileSync(path.join(board(), archive), old)
    cloud.put({ [archive]: modern.replace('Original result.', 'Cloud result.') })
    assert.ok((await pull(ws, MACHINE)).ok)
    assert.match(read(archive), /Cloud result./)
    assert.equal(conflictList(board()).length, 0)
    const drafts = fs.readdirSync(path.join(board(), '.sync/legacy-previews'))
    assert.equal(fs.readFileSync(path.join(board(), '.sync/legacy-previews', drafts[0]!, archive), 'utf8'), old)

    fs.writeFileSync(path.join(board(), archive), old.replace('Original result.', 'Local result.'))
    cloud.put({ [archive]: modern.replace('Original result.', 'New remote result.') })
    assert.equal((await pull(ws, MACHINE)).ok, false)
    const record = conflictShow(board(), conflictList(board())[0]!.id)
    const fact = record.files.find(file => file.path === archive)!
    assert.match(fact.base.content!, /Cloud result./)
    assert.match(fact.local.content!, /Local result./)
    assert.match(fact.remote.content!, /New remote result./)
  })

  it('keeps task preparation private while allowing the agent to take the sync lock (#806)', async () => {
    await prepareBoard()
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cached())
    await withBoard(ws, async () => {
      fs.writeFileSync(path.join(ws.board, 'memory/readme.md'), 'temporary context')
      assert.equal((await pushBoard(ws, MACHINE)).ok, false)
      assert.equal(cloud.file('memory/readme.md'), 'Shipped')
      assert.equal(await withSyncLock(ws.board, async () => 'available to the agent'), 'available to the agent')
      fs.writeFileSync(path.join(ws.board, 'memory/readme.md'), 'final context')
    })
    assert.ok((await pushBoard(ws, MACHINE)).ok)
    assert.equal(cloud.file('memory/readme.md'), 'final context')
  })

  it('honors a user stop while a running task has an unresolved conflict (#806)', async () => {
    await prepareBoard()
    const gate = gatedScript(`require('fs').writeFileSync('.akb/kanban/memory/readme.md', 'local cadence')`)
    start('', { plan: fakeRuntime(gate.script) })
    const job = cloud.dispatch({ id: 'stop-conflict', task: 'task_1', project: 'prj_1', number: 1, studio: 'wf_own' })
    await until(() => read('memory/readme.md') === 'local cadence')
    cloud.put({ 'memory/readme.md': 'remote cadence' })
    assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, false)
    job.stop = true
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'stopped', job.reason)
    assert.equal(planned.length, 1)
    assert.equal(pendingConflicts(board()).length, 1)
    assert.equal(read('memory/readme.md'), 'local cadence')
    assert.equal(cloud.file('memory/readme.md'), 'remote cadence')
  })

  it('writes nothing once the job moved to another computer', async () => {
    const job = cloud.dispatch({ id: 'j1', task: 'task_1', project: 'prj_1', number: 1, studio: 'wf_own' })
    const script = `process.chdir('.akb/kanban'); require('fs').writeFileSync('memory/readme.md', 'Late')`
    start('', { plan: (r, p, c) => fakeRuntime(script)(r, p, c), renewMs: 60_000 })
    await until(() => planned.length === 1)
    job.machine = 'elsewhere'
    await until(() => commits().length === 1)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(cloud.file('memory/readme.md'), 'Shipped')
    assert.notEqual(job.outcome, 'done')
  })

  it('runs a job on offline and writes it back once Cloud is reached within the lease', async () => {
    const job = cloud.dispatch({ id: 'j1', task: 'task_1', project: 'prj_1', number: 1, studio: 'wf_own' })
    const script = `process.chdir('.akb/kanban'); setTimeout(() => require('fs').writeFileSync('memory/readme.md', 'Offline work'), 300)`
    start('', { plan: (r, p, c) => fakeRuntime(script)(r, p, c) })
    await until(() => planned.length === 1)
    cloud.offline = true
    await new Promise((r) => setTimeout(r, 600))
    assert.equal(job.state, 'claimed')
    cloud.offline = false
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(cloud.file('memory/readme.md'), 'Offline work')
  })

  it('drops a result still offline when its lease ran out', async () => {
    const job = cloud.dispatch({ id: 'j1', task: 'task_1', project: 'prj_1', number: 1, studio: 'wf_own' })
    const script = `process.chdir('.akb/kanban'); setTimeout(() => require('fs').writeFileSync('memory/readme.md', 'Too late'), 200)`
    start('', { plan: (r, p, c) => fakeRuntime(script)(r, p, c), leaseMs: 300 })
    await until(() => planned.length === 1)
    cloud.offline = true
    await new Promise((r) => setTimeout(r, 700))
    cloud.offline = false
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(commits().length, 0)
    assert.equal(cloud.file('memory/readme.md'), 'Shipped')
    assert.equal(job.state, 'claimed')
  })

  it('loads Studio configuration in replies and recovery, with project defaults and legacy notes (#1043)', async () => {
    const note = 'Use the existing layout.'
    const config = 'rules/studios/wf-own/config.md'
    const defaults = 'rules/config.md'
    cloud.put({ [defaults]: 'Project default.', 'rules/studios/wf-own.md': note, 'rules/studios/coding/config.md': 'Other Studio note' })
    assert.equal((await runTask('notes-1')).outcome, 'done')
    assert.ok(planned.at(-1)!.prompt.includes(note))
    assert.ok(planned.at(-1)!.prompt.includes('Project default.'))
    assert.ok(!planned.at(-1)!.prompt.includes('Other Studio note'))
    cloud.put({ [config]: 'Revised note', 'rules/studios/wf-own.md': null })
    assert.equal((await runTask('notes-2', '', { resume: 'saved-session' })).outcome, 'done')
    assert.ok(planned.at(-1)!.prompt.includes('Revised note'))
    assert.ok(!planned.at(-1)!.prompt.includes(note))
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cloud.folder!('prj_1'))
    assert.ok(!taskStudioContext({ ...ws, board: path.join(cached(), 'other-board') }).includes('Revised note'))
    assert.match(taskStudioContext(ws), /akb studio file wf-own <path>/)
    assert.match(taskStudioContext(ws, { docs: false, canonicalCommands: false }), /akb raw file wf-own <path>/)
    cloud.put({ [config]: '', 'rules/studios/wf-own.md': note })
    assert.equal((await runTask('notes-3')).outcome, 'done')
    assert.ok(!planned.at(-1)!.prompt.includes('Revised note'))
    assert.ok(!planned.at(-1)!.prompt.includes(note))
  })

  it('round-trips Preview scopes and reads them again in a recovered task (#842)', async () => {
    const own = 'memory/previews/coding/prompts/project/style.md'
    const shared = 'memory/previews/coding/prompts/workspace/style.md'
    cloud.put({ [own]: 'Project preference', [shared]: 'Stale project copy', 'memory/agents/planner/skill/decisions.md': 'Module decision' })
    cloud.putShared({ [shared]: 'Workspace preference', 'memory/previews/wf-mine/draft/workspace/rules.md': 'User Studio rule' })
    const first = await runTask('preview-memory-1', `
      const fs = require('fs'), assert = require('assert/strict')
      assert.equal(fs.readFileSync('${own}', 'utf8'), 'Project preference')
      assert.equal(fs.readFileSync('${shared}', 'utf8'), 'Workspace preference')
      assert.equal(fs.readFileSync('memory/agents/planner/skill/decisions.md', 'utf8'), 'Module decision')
    `)
    assert.equal(first.outcome, 'done', first.reason)
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cloud.folder!('prj_1'))
    const hints = taskStudioContext(ws)
    assert.match(hints, /memory\/previews\/coding\/prompts\/project\//)
    assert.match(hints, /memory\/previews\/coding\/prompts\/workspace\//)
    assert.doesNotMatch(hints, /Project preference|Workspace preference|style.md/)
    fs.writeFileSync(path.join(board(), own), 'Revised project preference')
    fs.writeFileSync(path.join(board(), shared), 'Confirmed cross-project preference')
    assert.equal((await pushBoard(ws, MACHINE)).ok, true)
    assert.equal(cloud.file(own), 'Revised project preference')
    assert.equal(cloud.shared(shared), 'Confirmed cross-project preference')
    assert.equal(cloud.file(shared), null)
    fs.rmSync(path.join(board(), 'memory'), { recursive: true })
    fs.rmSync(path.join(cached(), '.akb', 'base.json'))
    const next = await runTask('preview-memory-2', `
      const fs = require('fs'), assert = require('assert/strict')
      assert.equal(fs.readFileSync('${own}', 'utf8'), 'Revised project preference')
      assert.equal(fs.readFileSync('${shared}', 'utf8'), 'Confirmed cross-project preference')
    `)
    assert.equal(next.outcome, 'done', next.reason)
  })

  it('keeps a project’s copy of shared memory edited elsewhere, and writes back the rest (#2099)', async () => {
    const STYLE = 'memory/agents/copywriting/style.md'
    cloud.putShared({ [STYLE]: 'Shared' })
    cloud.put({ [STYLE]: 'Project copy' })
    cloud.beforeNextCommit = () => cloud.put({ [STYLE]: 'Edited elsewhere' })
    const job = await runTask('j1', `require('fs').writeFileSync('memory/readme.md', 'Mine')`)
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(cloud.file('memory/readme.md'), 'Mine')
    assert.equal(cloud.file(STYLE), 'Edited elsewhere')
  })

  it('reads a board whole again after a base from before the workspace’s board (#2114)', async () => {
    const base = path.join(cached(), '.akb', 'base.json')
    fs.mkdirSync(path.dirname(base), { recursive: true })
    fs.writeFileSync(base, JSON.stringify({ head_seq: 99, inbox: false, files: { [CARD]: { seq: 1, content: 'Old' } } }))
    assert.equal((await runTask('j1')).outcome, 'done')
    assert.ok(cloud.log.includes('GET /v1/projects/prj_1/board'), 'an old base was read on from its seq')
    assert.equal(read(CARD), BODY)
    assert.equal(JSON.parse(fs.readFileSync(base, 'utf8')).layout, 'workspace')
  })

  it('keeps a project’s task folder in it, out of git', async () => {
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'site-')))
    spawnSync('git', ['init', '-q', project])
    fs.writeFileSync(path.join(runnerHome(), 'projects.json'), JSON.stringify({ projects: [project] }))
    const job = cloud.dispatch({ id: 'j1', task: 'task_1', project: 'prj_1', number: 1, projectDir: project })
    start()
    await until(() => job.state === 'finished')
    assert.equal(job.outcome, 'done')
    assert.equal(planned[0]!.cwd, project)
    assert.equal(fs.readFileSync(path.join(project, '.akb', 'kanban', CARD), 'utf8'), BODY)
    assert.match(fs.readFileSync(path.join(project, '.git', 'info', 'exclude'), 'utf8'), /^\.akb\/$/m)
    assert.equal(spawnSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '')
  })
})
