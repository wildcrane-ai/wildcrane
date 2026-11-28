import { stampLeavingIn } from '../../cli/src/lib/leaving'
import { encodeStudioZip, sha256Bytes, studioFilesSha256 } from '../../cli/src/lib/shared/studio-package'
import { zipSync, strToU8 } from 'fflate'
import { documentPreviewKey, PDF } from '../../artifact-sdk/src/internal/document'
import { numberOfCard } from '../../cli/src/lib/shared/board-files'
import { newCardWriteProblems } from '../../cli/src/lib/shared/card-structure'
import { taskPreviewProblems } from '../../cli/src/lib/shared/task-preview-validation'
import { conflictList, conflictShow, pendingConflicts } from '../../cli/src/lib/shared/board-conflicts'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import * as api from '../src/api'
import { runnerHome } from '../src/home'
import { acquireMachine } from '../src/lock'
import { akbHome, bundledAkb, runAkb } from '../src/akb'
import { readAkbState } from '../src/akb-version'
import { AKB_CONTRACT } from '../src/protocol'
import { projectStateDir } from '../../cli/src/lib/machine/project'
import { NO_FOLDER, keptBoard, openTaskFolder, pull, pullChanges, push, pushBoard, readHead, workspaceOf } from '../src/task-folder'
import { watchBoards } from '../src/board-watch'
import { hold, unsent } from '../src/cache'
import { until } from './fake-cloud'
import { cloud, runner, planned, MACHINE, cached, fakeAkb, fakeRuntime, mockOffice, start, taskFolderFixture } from './runner-harness'

describe('a task’s folder (#2037)', () => {
  const { board, read, downloads, commits, CARD, BODY, runTask, prepareBoard } = taskFolderFixture()

  for (const legacy of [false, true]) it(`pulls a direct Cloud archive ${legacy ? 'over a quarantined local archive' : 'during task writeback'}`, async () => {
    const archive = '.archive/1-task-1.md'
    const list = 'assets/task_1.json'
    const marker = path.join(board(), '.sync/land-archives/task_1')
    const original = '---\ntitle: Pricing\nstatus: planned\n---\n\nOriginal.\n'
    cloud.put({ [CARD]: original, [list]: '{}' })
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cached())
    assert.ok((await pull(ws, MACHINE)).ok)
    const edited = original + '\nEdited in the session.\n'
    const content = stampLeavingIn(edited, '2026-11-27', null)
    if (legacy) {
      fs.mkdirSync(path.dirname(marker), { recursive: true })
      fs.writeFileSync(marker, JSON.stringify({ job: null, number: 1 }))
      fs.mkdirSync(path.dirname(path.join(board(), archive)), { recursive: true })
      fs.writeFileSync(path.join(board(), archive), stampLeavingIn(edited, '2026-11-20', null))
      fs.rmSync(path.join(board(), CARD))
    } else {
      fs.writeFileSync(path.join(board(), CARD), edited)
    }
    const manifest = JSON.stringify({ 'asset:result.txt': { artifact: 'art_result', version: 2 } })
    cloud.put({ [CARD]: null, [archive]: content, [list]: manifest })
    cloud.taskStatus.task_1 = 'done'
    const discussion = cloud.dispatch({ id: 'discussion', task: 'task_1', project: 'prj_1', machine: MACHINE })
    discussion.state = 'claimed'
    const synced = legacy ? await pullChanges(ws) : await push(ws, { id: discussion.id, machineId: MACHINE })
    assert.equal(synced.ok, true, !synced.ok ? synced.error : '')
    assert.equal(read(archive), content)
    assert.equal(read(list), manifest)
    assert.equal(fs.existsSync(path.join(board(), CARD)), false)
    assert.equal(fs.existsSync(marker), false)
    assert.equal(conflictList(board()).length, 0)
    const base = JSON.parse(fs.readFileSync(path.join(cached(), '.akb/base.json'), 'utf8'))
    assert.equal(base.files['projects/prj_1/' + archive].content, content)
    assert.equal(base.files['projects/prj_1/' + CARD], undefined)
    assert.equal(base.archiveReceipts.task_1.status, 'confirmed')
    assert.equal(cloud.log.filter(route => route.endsWith('archive-completions')).length, 0)
  })

  it('runs with the complete checked package and downloads once per published version', async () => {
    const studio = 'wf_own'
    const route = '/v1/tasks/task_1/studio'
    const files: Record<string, string> = { 'STUDIO.md': '---\nname: Coding\n---\n\nRead the approved files.\n' }
    let remaining = 10 * 1024 * 1024 - Buffer.byteLength(files['STUDIO.md']!)
    for (let index = 0; remaining > 0; index++) {
      const size = Math.min(2 * 1024 * 1024, remaining)
      files['references/full-' + index + '.txt'] = 'x'.repeat(size)
      remaining -= size
    }
    const versions = new Map()
    for (const version of [2, 3]) {
      const versionFiles = version === 2 ? files : { ...files, 'references/full-0.txt': 'next version' }
      const { zip } = encodeStudioZip(versionFiles)
      versions.set(version, {
        zip: Buffer.from(zip), package: {
          version, filesSha256: await studioFilesSha256(versionFiles), zipSha256: await sha256Bytes(zip),
          zipBytes: zip.length, downloadUrl: route + '/versions/' + version + '/package',
        },
      })
    }
    let latest = 2
    const downloads: number[] = []
    const selected: number[] = []
    cloud.service = (_method, url) => {
      if (url.pathname === route) {
        assert.equal(url.searchParams.get('view'), 'metadata')
        const version = Number(url.searchParams.get('version') ?? latest)
        selected.push(version)
        return { studio, version, package: versions.get(version).package }
      }
      for (const [version, saved] of versions) {
        if (url.pathname === saved.package.downloadUrl) {
          downloads.push(version)
          return saved.zip
        }
      }
    }
    const check = (version: number, size: number) => {
      const file = path.join(runnerHome(), 'studios', 'versions', studio + '@' + version + '.json')
      return 'const assert = require("node:assert/strict"); const fs = require("node:fs");' +
        'assert.equal(JSON.parse(process.env.AI4KANBAN_STUDIO_SNAPSHOT).version,' + version + ');' +
        'const held = JSON.parse(fs.readFileSync(' + JSON.stringify(file) + ', "utf8"));' +
        'assert.equal(Buffer.byteLength(held.files["references/full-0.txt"]),' + size + ');'
    }
    assert.equal((await runTask('package-first', check(2, 2 * 1024 * 1024))).outcome, 'done')
    assert.equal((await runTask('package-second', check(2, 2 * 1024 * 1024))).outcome, 'done')
    latest = 3
    assert.equal((await runTask('package-next', check(3, 'next version'.length))).outcome, 'done')
    const resumed = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1, studio }, cached())
    resumed.studioSnapshot = { studio, version: 2 }
    fs.rmSync(path.join(runnerHome(), 'studios', 'versions', studio + '@2.json'))
    assert.deepEqual(await pull(resumed, MACHINE), { ok: true, value: undefined })
    assert.deepEqual(downloads, [2, 3, 2])
    assert.deepEqual(selected, [2, 2, 3, 2])
  })

  for (const entry of ['background', 'task'] as const) it(`reconciles board changes through ${entry} sync (#1062)`, async () => {
    const archive = '.archive/12-restored.md'
    const restoredCard = 'todo/12-restored.md'
    const restored = '---\ntitle: Restored\nrestored: 2026-11-23\n---\nCloud copy\n'
    const removed = '.archive/13-removed.md'
    const note = 'memory/readme.md'
    const noteBase = 'First\n\nMiddle\n\nLast\n'
    cloud.put({ [archive]: 'Archived copy\n', [removed]: 'Removed\n', [note]: noteBase })
    await prepareBoard()
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cached())
    const sync = () => entry === 'background' ? pullChanges(keptBoard(cached())!) : pull(ws, MACHINE)
    const base = () => JSON.parse(fs.readFileSync(path.join(cached(), '.akb/base.json'), 'utf8'))
    const local = (file: string, text: string) => fs.writeFileSync(path.join(board(), file), text)
    local(archive, 'Unsent archive draft\n')
    cloud.put({ [archive]: null, [restoredCard]: restored, [removed]: null })
    const restoredAt = cloud.head
    assert.deepEqual(await sync(), { ok: true, value: undefined })
    assert.equal(read(restoredCard), restored)
    assert.equal(read(`.sync/restored/${restoredAt}/${archive}`), 'Unsent archive draft\n')
    assert.ok(!fs.existsSync(path.join(board(), archive)))
    assert.ok(!fs.existsSync(path.join(board(), removed)))
    assert.equal(base().deleted[`projects/prj_1/${removed}`], restoredAt)
    assert.equal(readHead(ws), restoredAt)

    const remote = noteBase.replace('Last', 'Cloud edit')
    const draft = noteBase.replace('First', 'Local edit')
    cloud.task.artifacts.get('art_1')!.push(Buffer.from('hero-2'))
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    refs['hero.png'].version = 2
    cloud.put({ [note]: remote, [CARD]: BODY + 'New board copy\n', 'assets/task_1.json': JSON.stringify(refs) })
    // Exercise the inbound rules even when the task has already sent its edits.
    cloud.beforeNextBoardRead = () => local(note, draft)
    const calls = cloud.log.length
    assert.deepEqual(await sync(), { ok: true, value: undefined })
    assert.equal(read(note), draft)
    assert.equal(base().files[`projects/prj_1/${note}`].content, noteBase)
    assert.equal(read(CARD), BODY + 'New board copy\n')
    assert.equal(readHead(ws), restoredAt)
    assert.equal(read('todo/hero.png'), entry === 'background' ? 'hero-1' : 'hero-2')
    assert.equal(cloud.log.slice(calls).includes('GET /v1/tasks/task_1/studio'), entry === 'task')

    // An identical local copy is acknowledged, and a draft outside the delta cannot hold the cursor.
    local(note, noteBase)
    cloud.beforeNextBoardRead = () => {
      local(note, remote)
      local('memory/scratch.md', 'Unsent draft\n')
    }
    assert.deepEqual(await sync(), { ok: true, value: undefined })
    assert.equal(readHead(ws), cloud.head)
    assert.equal(read(note), remote)
    assert.equal(read('memory/scratch.md'), 'Unsent draft\n')
    assert.equal(cloud.file('memory/scratch.md'), null)

    const beforeConflict = readHead(ws)
    const cloudEdit = remote.replace('First', 'Cloud conflict')
    const localEdit = remote.replace('First', 'Local conflict')
    fs.rmSync(path.join(board(), 'memory/scratch.md'))
    cloud.put({ [note]: cloudEdit, [CARD]: BODY + 'Held until resolution\n' })
    cloud.beforeNextBoardRead = () => local(note, localEdit)
    const conflict = await sync()
    assert.equal(!conflict.ok && conflict.code, 'board_content_conflict')
    assert.equal(readHead(ws), beforeConflict)
    assert.equal(read(note), localEdit)
    assert.equal(read(CARD), BODY + 'New board copy\n')
    const [saved] = pendingConflicts(board())
    assert.ok(saved)
    assert.deepEqual(saved.files.map(file => [file.path, file.base.content, file.local.content, file.remote.content, file.reason]),
      [[note, remote, localEdit, cloudEdit, 'both-modified']])
  })

  it('pairs Office previews with the uploaded source version and preserves failed originals (#907)', { skip: process.platform === 'win32' }, async (t) => {
    await mockOffice(t)
    const source = (text: string) => Buffer.from(zipSync({
      'word/document.xml': strToU8(text),
      '_rels/.rels': strToU8('<Relationships/>'),
    }))
    const file = 'report.docx'
    const writeDoc = (bytes: Buffer) => `require('fs').writeFileSync('todo/${file}', Buffer.from('${bytes.toString('base64')}', 'base64'));`
    const index = () => JSON.parse(cloud.file('assets/task_1.json')!) as api.Assets
    const tag = JSON.stringify(`\n<Asset src="${file}" />\n`)
    const first = await runTask('office-1', writeDoc(source('one')) + `require('fs').appendFileSync('${CARD}', ${tag})`)
    assert.equal(first.outcome, 'done', first.reason)
    const original = index()[file]!
    const firstKey = documentPreviewKey(original.artifact, 1)
    const firstPdf = index()[firstKey]!
    assert.deepEqual(original.dependencies, [firstKey])
    assert.equal(cloud.task.artifacts.get(firstPdf.artifact)![0]!.subarray(0, 5).toString(), '%PDF-')

    const second = await runTask('office-2', writeDoc(source('two')))
    assert.equal(second.outcome, 'done', second.reason)
    const secondKey = documentPreviewKey(original.artifact, 2)
    assert.deepEqual(index()[file], { artifact: original.artifact, version: 2, dependencies: [secondKey] })
    assert.equal(index()[firstKey], undefined)
    assert.notEqual(index()[secondKey]!.artifact, firstPdf.artifact)

    const broken = Buffer.from('invalid Office file')
    const failed = await runTask('office-3', writeDoc(broken))
    assert.equal(failed.outcome, 'done', failed.reason)
    assert.deepEqual(index()[file], { artifact: original.artifact, version: 3 })
    assert.equal(index()[secondKey], undefined)
    assert.deepEqual(cloud.task.artifacts.get(original.artifact)![2], broken)
  })

  it('publishes Office originals while PDF uploads return 503 and fills in previews on later syncs (#943)', { skip: process.platform === 'win32' }, async (t) => {
    await mockOffice(t)
    await prepareBoard()
    const ws = keptBoard(cached())!
    const files = { 'report.docx': 'word/document.xml', 'slides.pptx': 'ppt/presentation.xml' }
    const source = (part: string, version: number) => Buffer.from(zipSync({
      [part]: strToU8(`version ${version}`),
      '_rels/.rels': strToU8('<Relationships/>'),
    }, { mtime: new Date(2020, 0, 1) }))
    const writeSources = (version: number) => {
      for (const [name, part] of Object.entries(files)) fs.writeFileSync(path.join(board(), 'todo', name), source(part, version))
    }
    const body = BODY + Object.keys(files).map(name => `\n<Asset src="${name}" />\n`).join('')
    fs.writeFileSync(path.join(board(), CARD), body)
    writeSources(1)
    cloud.unavailableUploadTypes.add(PDF)
    assert.deepEqual(await pushBoard(ws, MACHINE), { ok: true, changed: true })
    assert.equal(cloud.file(CARD), body)

    const index = () => JSON.parse(cloud.file('assets/task_1.json')!) as api.Assets
    const ids = Object.fromEntries(Object.keys(files).map(name => [name, index()[name]!.artifact]))
    const expectPins = (version: number, hasPreview: boolean) => {
      const refs = index()
      for (const [name, part] of Object.entries(files)) {
        const artifact = ids[name]!
        const key = documentPreviewKey(artifact, version)
        assert.deepEqual(refs[name], hasPreview ? { artifact, version, dependencies: [key] } : { artifact, version })
        assert.deepEqual(cloud.task.artifacts.get(artifact), Array.from({ length: version }, (_, i) => source(part, i + 1)))
        assert.equal(cloud.log.filter(line => line === `PUT /v1/uploads/upl_${artifact}`).length, version)
        if (hasPreview) {
          const pdf = refs[key]!
          assert.equal(pdf.version, 1)
          assert.match(cloud.task.artifacts.get(pdf.artifact)![0]!.toString(), /^%PDF-/)
        } else {
          assert.equal(refs[key], undefined)
        }
        if (version > 1) assert.equal(refs[documentPreviewKey(artifact, version - 1)], undefined)
      }
    }
    expectPins(1, false)
    assert.ok(unsent(cached()))
    const puts = () => cloud.log.filter(line => line.startsWith('PUT /v1/uploads/')).length
    const beforeRetry = puts()
    assert.deepEqual(await pushBoard(ws, MACHINE, []), { ok: true, changed: false })
    assert.equal(puts() - beforeRetry, Object.keys(files).length)
    expectPins(1, false)
    assert.ok(unsent(cached()))
    cloud.unavailableUploadTypes.clear()
    assert.deepEqual(await pushBoard(ws, MACHINE, []), { ok: true, changed: true })
    expectPins(1, true)
    assert.equal(unsent(cached()), false)

    writeSources(2)
    cloud.unavailableUploadTypes.add(PDF)
    assert.deepEqual(await pushBoard(ws, MACHINE, Object.keys(files).map(name => `todo/${name}`)), { ok: true, changed: true })
    expectPins(2, false)
    cloud.unavailableUploadTypes.clear()
    assert.deepEqual(await pushBoard(ws, MACHINE, []), { ok: true, changed: true })
    expectPins(2, true)
    assert.equal(unsent(cached()), false)
  })

  for (const copy of ['empty', 'existing']) {
    it(`syncs an ${copy} current copy without conversion state (#749)`, async () => {
      if (copy === 'existing') await prepareBoard()
      const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cloud.folder!('prj_1'))
      const marker = path.join(projectStateDir(ws.board, ws.cwd), 'akb-contract.json')
      assert.equal(fs.existsSync(marker), false)
      assert.equal((await runTask('j1', `require('fs').appendFileSync('${CARD}', 'Local result.')`)).outcome, 'done')
      assert.match(cloud.file(CARD)!, /Local result/)
      assert.equal(workspaceOf(ws), 'ws_1')

      fs.writeFileSync(path.join(board(), 'memory/readme.md'), 'Unsent edit')
      cloud.put({ 'memory/readme.md': 'Remote edit' })
      assert.equal((await runTask('j2')).outcome, 'failed')
      assert.equal(read('memory/readme.md'), 'Unsent edit')
      assert.equal(cloud.file('memory/readme.md'), 'Remote edit')
      assert.equal(conflictList(board()).length, 1)
      assert.equal(fs.existsSync(marker), false)
    })
  }

  for (const asset of ['unchanged', 'unreferenced', 'referenced']) {
    it(`reply approval synchronizes ${asset} assets before deciding (#684)`, async () => {
      await prepareBoard()
      const pending = asset === 'referenced'
      cloud.serviceUnavailableUploads = asset !== 'unchanged'
      const script = `
        const fs = require('fs');
        if (!process.env.AI4KANBAN_REVIEW_SYNC) throw new Error('Preview sync is unavailable.');
        fs.appendFileSync('todo/1-task-1.md', 'Edited before approval.');
        ${pending ? "fs.writeFileSync('todo/hero.png', 'pending edit');" : asset === 'unreferenced' ? "fs.mkdirSync('assets/1', { recursive: true }); fs.writeFileSync('assets/1/pending.json', '{}');" : ''}
        const { url, token } = JSON.parse(process.env.AI4KANBAN_REPLY_APPROVAL);
        fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ task: '1' }) })
          .then(r => r.json()).then(r => { fs.writeFileSync('reply-result.json', JSON.stringify(r)); console.log('done'); });
      `
      const running = runTask('reply-approval', script, {
        chat: { message: 'm1', body: 'Start' },
        taskReview: { revision: 3, plan: null, stages: [], approvals: [{ stage: 'draft', revision: 1, starts: [] }] },
      })
      if (pending) {
        await until(() => fs.existsSync(path.join(board(), 'reply-result.json')))
        assert.equal(cloud.replyApprovals.length, 0)
        cloud.serviceUnavailableUploads = false
      }
      const job = await running
      assert.equal(job.outcome, 'done', job.reason)
      const answer = JSON.parse(read('reply-result.json'))
      assert.equal(answer.ok, !pending, JSON.stringify(answer))
      assert.equal(cloud.replyApprovals.length, pending ? 0 : 1)
      if (!pending) {
        assert.match(cloud.replyApprovals[0]!.card!, /Edited before approval/)
        assert.equal(cloud.replyApprovals[0]!.fields.card_version, cloud.board.get('projects/prj_1/' + CARD)!.seq)
        assert.equal(cloud.replyApprovals[0]!.fields.stage, 'draft')
        assert.equal(cloud.replyApprovals[0]!.fields.review_revision, 1)
        assert.equal(job.report?.replyApprovalSynced, true)
      } else assert.notEqual(job.report?.replyApprovalSynced, true)
    })
  }

  it('reads the board in one call, writes the card, its memory and its assets, and runs there', async () => {
    const job = await runTask('j1')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(planned[0]!.cwd, cached())
    assert.match(planned[0]!.prompt, new RegExp(`^Task card: ${path.join(board(), CARD)}`))
    assert.ok(planned[0]!.prompt.endsWith('\n\n---\n\ngo'), "Cloud's prompt was not last")
    assert.equal(read(CARD), BODY)
    assert.equal(read('todo/hero.png'), 'hero-1')
    assert.equal(read('todo/shots/a.png'), 'a-1')
    assert.equal(read('memory/readme.md'), 'Shipped')
    assert.ok(!fs.existsSync(path.join(board(), 'memory', 'me.md')), 'undeclared workspace memory reached the task')
    assert.equal(read('rules/project-writer.md'), 'No')
    assert.deepEqual(cloud.log.filter((l) => l.includes('/board')), ['GET /v1/projects/prj_1/board'])
    assert.equal(commits().length, 0, 'a job that changed nothing wrote back')
  })

  it('refuses a task whose project has no folder here, and runs nothing (#516)', async () => {
    const job = await runTask('j1', '', { project: 'prj_2', projectDir: null })
    assert.equal(job.outcome, 'failed')
    assert.equal(job.reason, NO_FOLDER)
    assert.equal(planned.length, 0)
    assert.equal(fs.existsSync(cached('prj_2')), false)
  })

  it('hands the agent the akb it carries, on the task’s board (#2020)', async () => {
    const job = await runTask('j1', 'const p = require("path"); console.log(process.env.AI4KANBAN_BOARD, require("fs").existsSync(p.join(process.env.PATH.split(p.delimiter)[0], "akb")))')
    assert.equal(job.outcome, 'done', job.reason)
    assert.match(job.events.map((e) => e.text).join(''), new RegExp(`${board()} true`))
  })

  it('runs each step on one akb, and the next on what was chosen by then, on its own shim (#171)', async () => {
    const versions = ['1.1.0', '1.2.0']
    const chosen: string[] = []
    const job = (id: string) => {
      const dispatched = cloud.dispatch({ id, task: 'task_1', project: 'prj_1', number: 1 })
      return until(() => dispatched.state === 'finished').then(() => dispatched)
    }
    start('console.log(process.env.PATH.split(require("path").delimiter)[0])', { akb: () => {
      const version = versions[chosen.length]!
      chosen.push(version)
      return fakeAkb(version)
    } })
    const one = await job('j1')
    const two = await job('j2')
    assert.deepEqual(chosen, ['1.1.0', '1.2.0'])
    assert.match(one.events.map((e) => e.text).join(''), new RegExp(path.join('1.1.0', 'shim')))
    assert.match(two.events.map((e) => e.text).join(''), new RegExp(path.join('1.2.0', 'shim')))
    assert.ok(fs.existsSync(path.join(fakeAkb('1.1.0').shim, 'akb')), 'the shim a started agent uses went')
  })

  it('tells Cloud the contract it keeps, and follows the version Cloud names (#171)', async () => {
    fs.mkdirSync(akbHome(), { recursive: true })
    fs.writeFileSync(path.join(akbHome(), 'state.json'), JSON.stringify({ current: '1.1.0', bad: [] }))
    cloud.akb = { version: null }
    start()
    await until(() => readAkbState().current === null)
    assert.equal(cloud.akbContract, AKB_CONTRACT)
  })

  it('reads the latest Studio for each task run and leaves its agents off the board (#1039)', async () => {
    // Agents a Runner before #409 placed: an untouched one goes, a hand-edited one stays.
    fs.mkdirSync(path.join(board(), 'agents', 'old'), { recursive: true })
    fs.mkdirSync(path.join(board(), '.sync'), { recursive: true })
    fs.writeFileSync(path.join(board(), 'agents', 'old', 'AGENT.md'), 'Placed.')
    fs.writeFileSync(path.join(board(), 'agents', 'old', 'notes.md'), 'Edited.')
    const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex')
    fs.writeFileSync(path.join(board(), '.sync', 'agents.json'), JSON.stringify({ 'agents/old/AGENT.md': hash('Placed.'), 'agents/old/notes.md': hash('Placed.') }))

    const job = await runTask('j1')
    assert.equal(job.outcome, 'done', job.reason)
    const held = path.join(runnerHome(), 'studios')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(held, 'tasks', 'task_1.json'), 'utf8')), { studio: 'wf_own', version: 2 })
    assert.equal(JSON.parse(fs.readFileSync(path.join(held, 'versions', 'wf_own@2.json'), 'utf8')).files['references/planning.md'], 'Plan it.')
    assert.ok(!fs.existsSync(path.join(board(), 'agents', 'software-planner')), 'a studio agent was placed on the board')
    assert.ok(!fs.existsSync(path.join(board(), 'agents', 'old', 'AGENT.md')), 'an agent an earlier Runner placed stayed')
    assert.equal(read('agents/old/notes.md'), 'Edited.')
    assert.match(planned[0]!.prompt, /^Studio: .+\. Read `akb raw file wf-own STUDIO.md`/m)

    const studio = cloud.task.studio!
    cloud.task.studio = { ...studio, version: 3, files: { ...studio.files, 'references/planning.md': 'Plan the update.' } }
    const next = await runTask('j2')
    assert.equal(next.outcome, 'done', next.reason)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(held, 'tasks', 'task_1.json'), 'utf8')), { studio: 'wf_own', version: 3 })
    fs.mkdirSync(path.join(board(), 'todo'), { recursive: true })
    fs.writeFileSync(path.join(board(), 'config.md'), '# Configuration\n')
    const studioFile = await runAkb(bundledAkb(process.env.RUNNER_DIST!), ['studio', 'file', 'wf-own', 'references/planning.md'], {
      cwd: cached(), board: board(), task: 'task_1', env: { AI4KANBAN_STUDIOS: '' },
    })
    assert.equal(studioFile.code, 0, studioFile.last)
    assert.equal(studioFile.out.trim(), 'Plan the update.')

    delete cloud.task.studio
    assert.equal((await runTask('j3', '', { studio: null })).outcome, 'done', 'a task with no studio failed')
  })

  it('syncs triage as board files: what another computer sorted comes down, a move here goes up (#2107)', async () => {
    const item = (title: string, extra = '') => `---\nsource_id: derived-${title.length}\ntitle: ${title}\nimported_at: "2026-10-20 09:00"\n${extra}---\n\nWords.\n`
    cloud.put({
      'triage/annual-plan.md': item('Annual plan'),
      'triage/dismissed/sso.md': item('SSO', 'dismissed_at: "2026-10-21 09:00"\ndismissed_by: user\n'),
      'triage/archived/dark-mode.md': item('Dark mode', 'card_id: 4\narchived_at: "2026-10-21 09:00"\n'),
    })
    fs.mkdirSync(path.join(board(), 'triage'), { recursive: true })
    fs.writeFileSync(path.join(board(), 'triage', 'left-over.md'), item('Left over'))
    const edit = `
      const fs = require('fs')
      fs.mkdirSync('triage/dismissed', { recursive: true })
      fs.renameSync('triage/annual-plan.md', 'triage/dismissed/annual-plan.md')
    `
    assert.equal((await runTask('j1', edit)).outcome, 'done')
    assert.ok(!fs.existsSync(path.join(board(), 'triage', 'left-over.md')), 'a file Cloud never held stayed')
    assert.equal(read('triage/dismissed/sso.md'), cloud.file('triage/dismissed/sso.md'))
    assert.equal(read('triage/archived/dark-mode.md'), cloud.file('triage/archived/dark-mode.md'))
    assert.equal(cloud.file('triage/annual-plan.md'), null)
    assert.ok(cloud.file('triage/dismissed/annual-plan.md'))

    // Moved in Cloud meanwhile: the Runner's own move gives way to it.
    cloud.put({ 'triage/new-idea.md': item('New idea') })
    const mine = `
      const fs = require('fs')
      fs.mkdirSync('triage/archived', { recursive: true })
      fs.renameSync('triage/new-idea.md', 'triage/archived/new-idea.md')
      fs.appendFileSync('triage/archived/new-idea.md', 'card_id: 9 here')
    `
    cloud.beforeNextCommit = () => cloud.put({ 'triage/new-idea.md': null, 'triage/archived/new-idea.md': item('New idea', 'card_id: 9\ntask: task_9\n') })
    const job = await runTask('j2', mine)
    assert.equal(job.outcome, 'failed', job.reason)
    assert.match(cloud.file('triage/archived/new-idea.md')!, /task: task_9/)
    assert.match(read('triage/archived/new-idea.md'), /card_id: 9 here/)
    assert.equal(conflictList(board()).length, 1)
  })

  it('keeps the module map, settings and rules in Cloud: the first computer’s go up, and another reads them (#2106)', async () => {
    fs.mkdirSync(path.join(board(), 'rules'), { recursive: true })
    fs.writeFileSync(path.join(board(), 'modules.md'), 'Mine')
    fs.writeFileSync(path.join(board(), 'rules', 'proposer.md'), 'Use pnpm.')
    fs.writeFileSync(path.join(board(), 'rules', 'prompt-writer.md'), 'Preserve for audit.')
    assert.equal((await runTask('j1')).outcome, 'done')
    assert.equal(cloud.file('rules/prompt-writer.md'), null)
    assert.equal(read('rules/prompt-writer.md'), 'Preserve for audit.')
    assert.equal(cloud.file('modules.md'), 'Mine')
    assert.equal(cloud.file('rules/proposer.md'), 'Use pnpm.')

    // Another computer, its own blank template.
    fs.rmSync(path.join(cached(), '.akb', 'base.json'))
    fs.rmSync(board(), { recursive: true })
    fs.mkdirSync(board(), { recursive: true })
    fs.writeFileSync(path.join(board(), 'modules.md'), 'Template')
    assert.equal((await runTask('j2')).outcome, 'done')
    assert.equal(read('modules.md'), 'Mine')
    assert.equal(read('rules/proposer.md'), 'Use pnpm.')
    assert.equal(cloud.file('modules.md'), 'Mine')

    // Cleared elsewhere, gone here.
    cloud.put({ 'rules/proposer.md': null, 'modules.md': 'Edited' })
    assert.equal((await runTask('j3')).outcome, 'done')
    assert.equal(read('modules.md'), 'Edited')
    assert.ok(!fs.existsSync(path.join(board(), 'rules', 'proposer.md')), 'a cleared rule came back')
    assert.equal(cloud.file('rules/proposer.md'), null)
  })

  it('writes the task index from the cards, another computer’s included (#2106)', async () => {
    cloud.put({ 'todo/2-task-2.md': '---\ntitle: From the other computer\n---\n', 'todo/3-pages/root.md': '---\ntitle: Pages\n---\n', 'todo/README.md': 'Stale' })
    assert.equal((await runTask('j1')).outcome, 'done')
    const index = read('todo/README.md')
    assert.match(index, /^- \[#1 1-task-1\]\(1-task-1\.md\)$/m)
    assert.match(index, /^- \[#2 From the other computer\]\(2-task-2\.md\)$/m)
    assert.match(index, /^- \[#3 Pages\]\(3-pages\/root\.md\)$/m)
    assert.equal(commits().length, 0, 'the index went up')
  })

  it('clears only unchanged files recorded by legacy Studio skill placement', async () => {
    const skills = (root: string, file: string) => path.join(cached(), root, 'skills', file)
    const placed = [
      ['.claude', 'deck/SKILL.md', 'Legacy skill'],
      ['.agents', 'deck/SKILL.md', 'User-edited skill'],
      ['.agents', 'deck/notes.md', 'User-added notes'],
      ['.claude', 'mine/SKILL.md', 'Project skill'],
    ]
    for (const [root, file, text] of placed) {
      const target = skills(root!, file!)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, text!)
    }
    const sync = path.join(board(), '.sync')
    fs.mkdirSync(sync, { recursive: true })
    fs.writeFileSync(path.join(sync, 'task_1.json'), JSON.stringify({
      assets: {},
      tools: { skills: { 'skills/deck/SKILL.md': crypto.createHash('sha256').update('Legacy skill').digest('hex') } },
    }))
    cloud.task.studio = { studio: 'wf_builtin_coding', version: 2, builtin: true, files: {
      'STUDIO.md': '---\nname: Coding\n---\n\nWork on the task.',
      'skills/deck/SKILL.md': '---\nname: deck\ndescription: Make decks.\n---\n\nPrepare a deck.',
    } }
    const job = await runTask('j1')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(fs.existsSync(skills('.claude', 'deck')), false)
    for (const [root, file, text] of placed.slice(1)) {
      assert.equal(fs.readFileSync(skills(root!, file!), 'utf8'), text)
    }
  })

  it('writes back every file the job changed in one call, on the seq each was read at', async () => {
    const edit = `
      const fs = require('fs')
      fs.mkdirSync('rules', { recursive: true })
      fs.writeFileSync('rules/proposer.md', 'Yes')
      fs.mkdirSync('memory/agents/qa-manager', { recursive: true })
      fs.writeFileSync('memory/agents/qa-manager/notes.md', 'Flaky')
      fs.writeFileSync('todo/README.md', 'generated')
      fs.mkdirSync('triage', { recursive: true })
      fs.writeFileSync('triage/idea.md', 'An idea')
      fs.rmSync('memory/readme.md')
    `
    const job = await runTask('j1', edit)
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(commits().length, 1)
    assert.equal(cloud.file('rules/proposer.md'), 'Yes')
    assert.equal(cloud.file('memory/agents/qa-manager/notes.md'), null)
    assert.equal(cloud.file('triage/idea.md'), 'An idea', 'a triage file stayed behind (#2107)')
    assert.equal(cloud.file('memory/readme.md'), null)
    assert.ok(!cloud.board.has('projects/prj_1/todo/README.md'), 'a generated file went up')

    // What was written is now the base: the next job writes nothing.
    await runTask('j2')
    assert.equal(commits().length, 1)
  })

  it('reads only what changed since, sending a hand edit made outside a job first (#59)', async () => {
    await runTask('j1')
    assert.equal(downloads().length, 2)
    const stamp = fs.statSync(path.join(board(), CARD)).mtimeMs
    fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'edited by hand')
    fs.writeFileSync(path.join(board(), 'todo', '9-stray.md'), 'stray')
    await runTask('j2')
    assert.equal(downloads().length, 2, 'an unchanged asset was downloaded again')
    assert.equal(fs.statSync(path.join(board(), CARD)).mtimeMs, stamp, 'an unchanged card was rewritten')
    assert.equal(read('memory/readme.md'), 'edited by hand')
    assert.equal(cloud.file('memory/readme.md'), 'edited by hand')
    assert.equal(cloud.file('todo/9-stray.md'), 'stray')
    assert.equal(commits().length, 1)

    cloud.task.artifacts.get('art_1')!.push(Buffer.from('hero-2'))
    cloud.put({ 'memory/readme.md': 'Shipped again', 'assets/task_1.json': JSON.stringify({ 'hero.png': { artifact: 'art_1', version: 2 }, 'shots/a.png': { artifact: 'art_2', version: 1 } }) })
    await runTask('j3')
    assert.deepEqual(downloads().slice(2), ['GET /v1/artifacts/art_1/versions/2/file'])
    assert.equal(read('todo/hero.png'), 'hero-2')
    assert.equal(read('memory/readme.md'), 'Shipped again')
  })

  for (const protection of ['none', 'card', 'asset', 'running']) {
    it(`cleans Cloud-deleted archive indexes safely (${protection}, #713)`, async () => {
      await prepareBoard()
      const archive = '.archive/1-task-1.md'
      cloud.put({ [CARD]: null, [archive]: BODY })
      const ws = keptBoard(cached())!
      assert.ok((await pullChanges(ws)).ok)
      fs.copyFileSync(path.join(board(), 'todo/hero.png'), path.join(board(), '.archive/hero.png'))
      fs.mkdirSync(path.join(board(), '.archive/shots'), { recursive: true })
      fs.copyFileSync(path.join(board(), 'todo/shots/a.png'), path.join(board(), '.archive/shots/a.png'))
      if (protection === 'card') fs.appendFileSync(path.join(board(), archive), 'Local draft')
      if (protection === 'asset') fs.writeFileSync(path.join(board(), '.archive/hero.png'), 'Local image')
      const release = protection === 'running' ? hold(cached()) : () => {}
      try {
        cloud.put({ [archive]: null })
        assert.equal((await pullChanges(ws)).ok, protection !== 'card')
        assert.equal((await pullChanges(ws)).ok, protection !== 'card', 'repeated delete/reconnect is safe')
        const index = path.join(board(), '.sync/task_1.json')
        assert.equal(fs.existsSync(index), protection !== 'none')
        if (protection === 'card') {
          assert.match(read(archive), /Local draft/)
          assert.equal(conflictList(board()).length, 1)
        }
        if (protection === 'asset') assert.equal(read('.archive/hero.png'), 'Local image')
        assert.equal((await pushBoard(ws, MACHINE)).ok, protection !== 'card')
        assert.equal(cloud.file(archive), null, 'deleted archive must not be recreated')
      } finally { release() }
      if (protection === 'running') {
        assert.ok((await pullChanges(ws)).ok)
        assert.equal(fs.existsSync(path.join(board(), '.sync/task_1.json')), false)
      }
    })
  }

  it('keeps an edited archive through full pulls without reviving Cloud content (#713)', async () => {
    await prepareBoard()
    const archive = '.archive/1-task-1.md'
    cloud.put({ [CARD]: null, [archive]: BODY })
    const ws = keptBoard(cached())!
    assert.ok((await pullChanges(ws)).ok)
    fs.appendFileSync(path.join(board(), archive), 'Unsent draft')
    cloud.put({ [archive]: null })
    for (let i = 0; i < 2; i++) {
      assert.equal((await pull(ws, MACHINE)).ok, false)
      assert.match(read(archive), /Unsent draft/)
      assert.equal(cloud.file(archive), null)
      assert.equal(fs.existsSync(path.join(board(), '.sync/task_1.json')), i === 0)
      assert.equal(conflictList(board()).length, 1)
      if (i === 0) fs.rmSync(path.join(board(), '.sync/task_1.json'))
    }
  })

  it('pulls a restored task over an old local archive move and saves its divergent copy (#807)', async () => {
    await prepareBoard()
    const archive = '.archive/1-task-1.md'
    cloud.put({ [CARD]: null, [archive]: BODY })
    const ws = keptBoard(cached())!
    assert.ok((await pullChanges(ws)).ok)
    fs.appendFileSync(path.join(board(), archive), 'Unsent draft')
    const restored = '---\ntitle: Pricing\nstatus: todo\nrestored: 2026-11-17T01:00:00Z\n---\n' + BODY
    cloud.put({ [archive]: null, [CARD]: restored })
    assert.ok((await pullChanges(ws)).ok)
    assert.equal(read(CARD), restored)
    assert.ok(!fs.existsSync(path.join(board(), archive)))
    const saved = fs.readdirSync(path.join(board(), '.sync/restored'))
    assert.equal(saved.length, 1)
    assert.match(fs.readFileSync(path.join(board(), '.sync/restored', saved[0]!, archive), 'utf8'), /Unsent draft/)
    const record = JSON.parse(fs.readFileSync(path.join(board(), '.sync/task_1.json'), 'utf8'))
    assert.equal(record.deleted, undefined)
    assert.ok((await pushBoard(ws, MACHINE)).ok)
    assert.equal(cloud.file(archive), null)
    assert.equal(cloud.file(CARD), restored)
  })

  it('reclaims old orphan indexes only when Cloud confirms the task is gone (#713)', async () => {
    await prepareBoard()
    const ws = keptBoard(cached())!
    for (const [id, status] of [['old', 'gone'], ['live', 'done'], ['unknown', 'down']]) {
      fs.writeFileSync(path.join(board(), `.sync/task_${id}.json`), JSON.stringify({ task: `task_${id}`, number: 99, assets: {} }))
      cloud.taskStatus[`task_${id}`] = status!
    }
    assert.ok((await pullChanges(ws)).ok)
    assert.equal(fs.existsSync(path.join(board(), '.sync/task_old.json')), false)
    assert.ok(fs.existsSync(path.join(board(), '.sync/task_live.json')))
    assert.ok(fs.existsSync(path.join(board(), '.sync/task_unknown.json')))
  })

  it('starts a task chat with fresh content before checking unrelated orphan records (#928)', async () => {
    await prepareBoard()
    const orphan = path.join(board(), '.sync/task_orphan.json')
    fs.writeFileSync(orphan, JSON.stringify({ task: 'task_orphan', number: 99, assets: {} }))
    cloud.taskStatus.task_orphan = 'done'
    fs.writeFileSync(path.join(board(), 'rules/project-writer.md'), 'Unsent board edit')
    cloud.task.artifacts.get('art_1')!.push(Buffer.from('hero-2'))
    cloud.put({
      [CARD]: BODY + 'Updated task.',
      'assets/task_1.json': JSON.stringify({ 'hero.png': { artifact: 'art_1', version: 2 }, 'shots/a.png': { artifact: 'art_2', version: 1 } }),
      'memory/readme.md': 'Updated board context',
    })

    start('', { plan: (...args) => {
      assert.ok(!cloud.log.includes('GET /v1/tasks/task_orphan'))
      assert.match(read(CARD), /Updated task/)
      assert.equal(read('memory/readme.md'), 'Updated board context')
      assert.equal(read('todo/hero.png'), 'hero-2')
      assert.equal(cloud.file('rules/project-writer.md'), 'Unsent board edit')
      return fakeRuntime('')(...args)
    } })
    const job = await runTask('fresh-chat', '', { chat: { message: 'm1', body: 'What changed?' } })
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(fs.existsSync(orphan), true)
  })

  it('keeps a card archived outside a job archived on the next job (#59)', async () => {
    await runTask('j1')
    fs.mkdirSync(path.join(board(), '.archive'), { recursive: true })
    fs.renameSync(path.join(board(), CARD), path.join(board(), '.archive', '1-task-1.md'))
    const job = await runTask('j2')
    assert.equal(job.outcome, 'done', job.reason)
    assert.equal(cloud.file(CARD), null)
    assert.equal(cloud.file('.archive/1-task-1.md'), BODY)
    assert.ok(!fs.existsSync(path.join(board(), CARD)), 'the next job brought the card back')
    assert.equal(read('.archive/1-task-1.md'), BODY)
  })

  it('hands preflight conflicts to the task and preserves both versions if unresolved (#806)', async () => {
    await runTask('j1')
    fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'edited by hand')
    cloud.put({ 'memory/readme.md': 'Shipped elsewhere' })
    const job = await runTask('j2')
    assert.equal(job.outcome, 'failed', job.reason)
    assert.equal(read('memory/readme.md'), 'edited by hand')
    assert.equal(cloud.file('memory/readme.md'), 'Shipped elsewhere')
    assert.equal(conflictList(board()).length, 1)
  })

  it('retains a removed card draft and refuses the entire conflicting batch (#806)', async () => {
    await runTask('j1')
    fs.writeFileSync(path.join(board(), CARD), 'edited by hand')
    fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'Shipped here')
    cloud.put({ [CARD]: null, '.archive/1-task-1.md': 'archived' })
    const job = await runTask('j2')
    assert.equal(job.outcome, 'failed', job.reason)
    assert.equal(cloud.file(CARD), null)
    assert.equal(cloud.file('.archive/1-task-1.md'), 'archived')
    assert.equal(cloud.file('memory/readme.md'), 'Shipped')
    assert.equal(read(CARD), 'edited by hand')
    assert.equal(conflictList(board()).length, 1)
  })

  it('requires an explicit decision for memory edits against deletion (#806)', async () => {
    await runTask('j1')
    fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'edited by hand')
    cloud.put({ 'memory/readme.md': null })
    const job = await runTask('j2')
    assert.equal(job.outcome, 'failed', job.reason)
    assert.equal(cloud.file('memory/readme.md'), null)
    assert.equal(read('memory/readme.md'), 'edited by hand')
    const facts = conflictShow(board(), conflictList(board())[0]!.id).files[0]!
    assert.equal(facts.reason, 'edit-delete')
    assert.ok(facts.remote.seq > facts.base.seq)
  })

  it('sends a board change as it is made, close ones together, and what waited at the start (#59)', async () => {
    await runTask('j1')
    await runner!.close()
    // Changed while no Runner ran: sent as the next one starts.
    fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'while away')
    start('', { watchMs: 50 })
    await until(() => cloud.file('memory/readme.md') === 'while away')
    assert.equal(commits().length, 1)
    fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'one')
    fs.writeFileSync(path.join(board(), 'rules', 'proposer.md'), 'two')
    fs.writeFileSync(path.join(board(), 'todo', 'README.md'), 'generated')
    await until(() => commits().length === 2)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(commits().length, 2, 'close changes went as more than one write')
    assert.equal(cloud.file('memory/readme.md'), 'one')
    assert.equal(cloud.file('rules/proposer.md'), 'two')
    assert.ok(!cloud.board.has('projects/prj_1/todo/README.md'), 'a generated file went up')
  })

  it('reconciles an already synced archive and retries without rewriting the board (#971)', async () => {
    await prepareBoard()
    const ws = keptBoard(cached())!
    const archive = '.archive/1-task-1.md'
    const card = '---\ntitle: Pricing\narchived: 2026-11-19\n---\n\nTiers.\n'
    const manifest = 'assets/task_1.json'
    cloud.put({ [CARD]: null, [archive]: card, [manifest]: '{}' })
    assert.ok((await pullChanges(ws)).ok)
    cloud.taskStatus.task_1 = 'waiting_review'
    let attempts = 0
    cloud.completeArchives = ({ cards }) => {
      attempts++
      assert.deepEqual(cards, [{ task: 'task_1', path: archive,
        seq: cloud.board.get('projects/prj_1/' + archive)!.seq,
        assets_seq: cloud.board.get('projects/prj_1/' + manifest)!.seq }])
      if (attempts === 1) return null
      cloud.taskStatus.task_1 = 'done'
      return { receipts: [{ task: 'task_1', status: 'confirmed' }] }
    }
    const unavailable = await pushBoard(ws, MACHINE)
    assert.equal(unavailable.ok, false)
    if (!unavailable.ok) assert.equal(unavailable.code, 'service_unavailable')
    assert.equal(cloud.taskStatus.task_1, 'waiting_review')
    assert.ok(unsent(cached()))
    const before = commits().length
    assert.ok((await pushBoard(ws, MACHINE, [])).ok)
    assert.equal(cloud.taskStatus.task_1, 'done')
    assert.equal(commits().length, before)
    assert.ok((await pushBoard(ws, MACHINE, [])).ok)
    assert.equal(attempts, 2)
    assert.equal(unsent(cached()), false)
  })

  it('sends a new archive after its assets and drops the pending check on restore or rejection (#971)', async () => {
    await prepareBoard()
    const ws = keptBoard(cached())!
    const archive = '.archive/1-task-1.md'
    const archived = '---\ntitle: Pricing\narchived: 2026-11-19\n---\n\n![](hero.png)\n'
    fs.mkdirSync(path.join(board(), '.archive'), { recursive: true })
    fs.renameSync(path.join(board(), CARD), path.join(board(), archive))
    fs.writeFileSync(path.join(board(), archive), archived)
    fs.writeFileSync(path.join(board(), '.archive/hero.png'), 'archived image')
    let attempts = 0
    cloud.completeArchives = ({ cards }) => {
      attempts++
      assert.equal(cards.length, 1)
      assert.equal(cloud.file(archive), archived)
      assert.equal(cloud.file(CARD), null)
      const pin = JSON.parse(cloud.file('assets/task_1.json')!)['hero.png']
      assert.equal(cloud.task.artifacts.get(pin.artifact)![pin.version - 1]!.toString(), 'archived image')
      return { receipts: [{ task: 'task_1', status: 'pending', code: 'conflict', message: 'Finish the active job before archiving.' }] }
    }
    cloud.serviceUnavailableUploads = true
    assert.equal((await pushBoard(ws, MACHINE, [CARD, archive])).ok, false)
    assert.equal(attempts, 0)
    assert.equal(cloud.file(archive), null)
    cloud.serviceUnavailableUploads = false
    assert.ok((await pushBoard(ws, MACHINE, [CARD, archive])).ok)
    assert.equal(attempts, 1)
    assert.ok(unsent(cached()))

    fs.renameSync(path.join(board(), archive), path.join(board(), CARD))
    fs.writeFileSync(path.join(board(), CARD), '---\ntitle: Pricing\nrestored: 2026-11-20\n---\n\nTiers.\n')
    assert.ok((await pushBoard(ws, MACHINE, [CARD, archive])).ok)
    assert.equal(attempts, 1)
    assert.equal(unsent(cached()), false)

    fs.renameSync(path.join(board(), CARD), path.join(board(), archive))
    fs.writeFileSync(path.join(board(), archive), archived.replace('archived:', 'rejected: true\narchived:'))
    assert.ok((await pushBoard(ws, MACHINE, [CARD, archive])).ok)
    assert.equal(attempts, 1)
    assert.match(cloud.file(archive)!, /rejected: true/)
  })

  for (const count of [300, 3000]) {
    it(`checks no historical files for one active edit or idle sync with ${count} archived tasks (#712)`, async (t) => {
      await prepareBoard()
      const ws = keptBoard(cached())!
      const archived: Record<string, string> = {}
      fs.mkdirSync(path.join(board(), '.archive'), { recursive: true })
      for (let n = 10; n < count + 10; n++) {
        const p = `.archive/${n}-done.md`
        archived[p] = `---\ntitle: Done ${n}\n---\n`
        fs.writeFileSync(path.join(board(), p), archived[p]!)
        fs.writeFileSync(path.join(board(), '.sync', `task_history_${n}.json`), JSON.stringify({ task: `task_history_${n}`, number: n, assets: {} }))
      }
      cloud.put(archived)
      assert.ok((await pullChanges(ws)).ok)
      assert.ok((await pushBoard(ws, MACHINE)).ok)
      const history: string[] = []
      const read = fs.readFileSync
      const list = fs.readdirSync
      const track = (file: unknown) => {
        if (String(file).includes('/.archive') || /\.sync\/task_history_/.test(String(file))) history.push(String(file))
      }
      t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof read>) => { track(args[0]); return read(...args) })
      t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof list>) => { track(args[0]); return list(...args) })
      fs.appendFileSync(path.join(board(), CARD), '\nActive edit.\n')
      assert.ok((await pushBoard(ws, MACHINE, [CARD])).ok)
      assert.match(cloud.file(CARD)!, /Active edit/)
      const before = cloud.log.length
      assert.deepEqual(await pushBoard(ws, MACHINE, []), { ok: true, changed: false })
      assert.equal(cloud.log.length, before)
      assert.deepEqual(history, [])
      t.mock.restoreAll()
      const archivedPath = '.archive/10-done.md'
      fs.appendFileSync(path.join(board(), archivedPath), '\nLocal archive edit.\n')
      assert.ok((await pushBoard(ws, MACHINE)).ok)
      assert.match(cloud.file(archivedPath)!, /Local archive edit/)
      cloud.put({ [archivedPath]: 'Cloud archive edit' })
      assert.ok((await pullChanges(ws)).ok)
      assert.equal(readText(archivedPath), 'Cloud archive edit')
      function readText(p: string) { return fs.readFileSync(path.join(board(), p), 'utf8') }
      fs.rmSync(path.join(board(), archivedPath))
      const own = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cached())
      assert.ok((await pull(own, MACHINE)).ok)
      // The local deletion was uploaded; recovery must not resurrect it.
      assert.equal(cloud.file(archivedPath), null)
      const restored = fs.mkdtempSync(path.join(runnerHome(), 'archive-restore-'))
      assert.ok((await pull(openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, restored), MACHINE)).ok)
      assert.equal(fs.readFileSync(path.join(restored, '.akb/kanban/.archive/11-done.md'), 'utf8'), archived['.archive/11-done.md'])
    })
  }

  it('watches asset dependencies outside the board and retries a failed write without another edit (#712)', async () => {
    await prepareBoard()
    const ws = keptBoard(cached())!
    const assets = path.join(projectStateDir(board()), 'assets/1')
    fs.mkdirSync(assets, { recursive: true })
    fs.writeFileSync(path.join(assets, 'page.html'), '<img src="image.png">')
    fs.writeFileSync(path.join(assets, 'image.png'), 'first')
    fs.appendFileSync(path.join(board(), CARD), '\n<Asset src=".assets/1/page.html" />\n')
    assert.ok((await pushBoard(ws, MACHINE)).ok)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    const artifact = refs['.assets/1/image.png'].artifact
    const watch = watchBoards(MACHINE, 20, 100)
    try {
      await new Promise(resolve => setTimeout(resolve, 100))
      cloud.serviceUnavailableUploads = true
      fs.writeFileSync(path.join(assets, 'image.png'), 'retry dependency')
      await until(() => unsent(cached()))
      cloud.serviceUnavailableUploads = false
      await until(() => cloud.task.artifacts.get(artifact)!.at(-1)!.toString() === 'retry dependency')
      await until(() => !unsent(cached()))
      const before = commits().length
      watch.look()
      await new Promise(resolve => setTimeout(resolve, 150))
      assert.equal(commits().length, before)
    } finally { watch.close() }
  })

  it('waits for the previous Runner before moving state and syncs CLI assets from the new path', async () => {
    await prepareBoard()
    const ws = keptBoard(cached())!
    fs.writeFileSync(path.join(ws.board, 'config.md'), '# Configuration\n')
    const state = projectStateDir(board())
    const old = path.join(cached(), '.akb/boards/.akb/kanban')
    fs.mkdirSync(path.dirname(old), { recursive: true })
    fs.renameSync(state, old)
    const akb = { ...fakeAkb(), args: [path.join(process.env.RUNNER_DIST!, 'akb/bin/ai4kanban.mjs')] }
    const cli = (...args: string[]) => runAkb(akb, args, { cwd: ws.cwd, board: ws.board, task: 'task_1' })
    const release = hold(ws.cwd)
    try {
      const blocked = await cli('guide', 'board')
      assert.equal(blocked.code, 1)
      assert.match(blocked.last, /waiting for the running tasks/)
      assert.throws(() => openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, ws.cwd), /waiting for the running tasks/)
      assert.ok(fs.existsSync(old))
    } finally { release() }
    openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, ws.cwd)
    assert.ok(fs.existsSync(path.join(state, 'board.json')))
    assert.ok(!fs.existsSync(old))
    const guides = await Promise.all([cli('guide', 'board'), cli('guide', 'board')])
    for (const guide of guides) {
      assert.equal(guide.code, 0, guide.out || guide.last)
      assert.match(guide.out, /Save task assets in the `Asset folder` shown by `akb task show <id>`/)
    }
    const src = 'asset:studio-review/review.json'
    const draft = path.join(ws.cwd, 'draft')
    fs.mkdirSync(draft)
    const file = path.join(draft, 'STUDIO.md')
    const freeze = async (text: string) => {
      fs.writeFileSync(file, `---\nname: Demo\n---\n\n## Work\n\nWrite the document.\n\n## Land\n\n${text}\n\n## Previews\n`)
      const result = await cli('studio', 'preview', '1', '--folder', draft, '--base', 'empty')
      assert.equal(result.code, 0, result.out || result.last)
    }
    await freeze('First version.')
    fs.appendFileSync(path.join(board(), CARD), `\n\n<Studio src="${src}" />\n`)
    assert.ok((await pushBoard(ws, MACHINE)).ok)
    const pin = () => JSON.parse(cloud.file('assets/task_1.json')!)[src]
    const initial = pin()
    assert.equal(initial.version, 1)
    const watch = watchBoards(MACHINE, 20)
    try {
      await freeze('Second version.')
      await until(() => pin()?.version === 2)
      const after = JSON.parse(cloud.file('assets/task_1.json')!)['asset:studio-review/files/0/after.txt']
      assert.match(cloud.task.artifacts.get(after.artifact)![after.version - 1]!.toString(), /Second version/)
    } finally { watch.close() }
  })

  it('recovers a missing record, retries pending assets and syncs archive moves and deletes (#712)', async () => {
    await prepareBoard()
    const ws = keptBoard(cached())!
    assert.ok((await pushBoard(ws, MACHINE)).ok)
    fs.rmSync(path.join(board(), '.sync/task_1.json'))
    fs.writeFileSync(path.join(board(), 'todo/hero.png'), 'changed attachment')
    fs.appendFileSync(path.join(board(), CARD), '\nPending draft.\n')
    cloud.serviceUnavailableUploads = true
    assert.equal((await pushBoard(ws, MACHINE, ['todo/hero.png', CARD])).ok, false)
    cloud.serviceUnavailableUploads = false
    assert.ok((await pushBoard(ws, MACHINE, [])).ok)
    assert.match(cloud.file(CARD)!, /Pending draft/)
    assert.equal(cloud.task.artifacts.get('art_1')!.at(-1)!.toString(), 'changed attachment')
    // Move the card and its relative dependencies together.
    fs.renameSync(path.join(board(), 'todo'), path.join(board(), '.archive'))
    assert.ok((await pushBoard(ws, MACHINE, ['todo', '.archive'])).ok)
    assert.equal(cloud.file(CARD), null)
    assert.match(cloud.file('.archive/1-task-1.md')!, /Pending draft/)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    const versions = cloud.task.artifacts.get('art_1')!
    versions.push(Buffer.from('remote archive image'))
    refs['hero.png'].version = versions.length
    cloud.put({ 'assets/task_1.json': JSON.stringify(refs) })
    assert.ok((await pullChanges(ws)).ok)
    assert.ok((await pushBoard(ws, MACHINE, ['assets/task_1.json'])).ok)
    assert.equal(read('.archive/hero.png'), 'remote archive image')
    const remoteCount = versions.length
    fs.writeFileSync(path.join(board(), '.archive/hero.png'), 'unuploaded local image')
    versions.push(Buffer.from('another remote image'))
    refs['hero.png'].version = versions.length
    cloud.put({ 'assets/task_1.json': JSON.stringify(refs) })
    assert.ok((await pullChanges(ws)).ok)
    assert.ok((await pushBoard(ws, MACHINE, ['assets/task_1.json', '.archive/hero.png'])).ok)
    assert.equal(read('.archive/hero.png'), 'unuploaded local image')
    assert.equal(versions.at(-1)!.toString(), 'unuploaded local image')
    assert.equal(versions.length, remoteCount + 2)
    fs.rmSync(path.join(board(), '.archive'), { recursive: true })
    assert.ok((await pushBoard(ws, MACHINE, ['.archive'])).ok)
    assert.equal(cloud.file('.archive/1-task-1.md'), null)
  })

  it('syncs 10 MiB board documents and preserves the remote copy when over the limit (#667)', async () => {
    await prepareBoard()
    const target = path.join(board(), 'memory/readme.md')
    const content = 'x'.repeat(10 * 1024 * 1024)
    fs.writeFileSync(target, content)
    assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, true)
    assert.equal(cloud.file('memory/readme.md'), content)
    fs.appendFileSync(target, 'x')
    const refused = await pushBoard(keptBoard(cached())!, MACHINE)
    assert.equal(refused.ok, false)
    assert.equal(cloud.file('memory/readme.md'), content)
    assert.equal(fs.statSync(target).size, content.length + 1)
  })

  it('uploads multipart assets before publishing their version (#667)', async () => {
    await prepareBoard()
    cloud.multipartSize = 1024 * 1024
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 3, 7)
    fs.writeFileSync(path.join(board(), 'todo/large.png'), bytes)
    fs.appendFileSync(path.join(board(), CARD), '\n<Asset src="large.png" />\n')
    const sent = await pushBoard(keptBoard(cached())!, MACHINE)
    assert.equal(sent.ok, true, JSON.stringify(sent))
    const ref = JSON.parse(cloud.file('assets/task_1.json')!)['large.png']
    assert.deepEqual(cloud.task.artifacts.get(ref.artifact)![ref.version - 1], bytes)
    const complete = cloud.log.findIndex((line) => line.endsWith('/complete'))
    const version = cloud.log.findIndex((line) => line === `POST /v1/artifacts/${ref.artifact}/versions`)
    assert.ok(complete >= 0 && version > complete)
  })

  it('publishes the applied answer and closed question in the same Runner card write', async t => {
    const content = '---\ntitle: Pricing\nstudio: coding\nstatus: implementing\nquestions: []\n---\n\nTwo tiers.\n'
    cloud.put({ [CARD]: content, 'assets/task_1.json': null, 'config.md': '# Board\n' })
    await prepareBoard()
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cloud.folder!('prj_1'))
    fs.writeFileSync(path.join(runnerHome(), 'machine.json'), JSON.stringify({ id: MACHINE }))
    fs.writeFileSync(path.join(runnerHome(), 'projects.json'), JSON.stringify({ projects: [ws.cwd] }))
    cloud.folders.push({ machine: MACHINE, project: 'prj_1', path: ws.cwd, name: 'Pricing', notify: true })
    t.after(await acquireMachine('terminal'))
    const job = { id: '00000000-0000-4000-8000-000000000001', machineId: MACHINE }
    const claimed = cloud.dispatch({ id: job.id, task: 'task_1', project: 'prj_1', number: 1 })
    claimed.state = 'claimed'
    claimed.machine = MACHINE
    const akb = { ...fakeAkb(), args: [path.join(process.env.RUNNER_DIST!, 'akb/bin/ai4kanban.mjs')] }
    const edit = async (...args: string[]) => {
      const out = await runAkb(akb, ['task', 'update-questions', 'task_1', ...args, '--json'], {
        cwd: ws.cwd, board: ws.board, task: 'task_1',
        env: { AI4KANBAN_EXECUTION: JSON.stringify({ job: job.id, machine: MACHINE }) },
      })
      assert.equal(out.code, 0, out.out || out.last)
      return JSON.parse(out.out)
    }
    assert.equal((await edit('--append', 'Which tier?', '--recommended-option', 'Pro', '--option', 'Free')).open, 1)
    assert.equal(cloud.file(CARD), content)
    const sent = await push(ws, job)
    assert.equal(sent.ok, true, JSON.stringify(sent))
    const asked = cloud.file(CARD)!
    assert.match(asked, /question: Which tier\?/)
    const before = commits().length
    fs.appendFileSync(path.join(ws.board, CARD), '\nUse the Pro tier.\n')
    assert.equal((await edit('--drop', '1')).open, 0)
    const answered = read(CARD)
    assert.equal(cloud.file(CARD), asked)
    const closed = await push(ws, job)
    assert.equal(closed.ok, true, JSON.stringify(closed))
    assert.equal(commits().length, before + 1)
    assert.equal(cloud.file(CARD), answered)
    assert.match(answered, /questions: \[\]/)
    assert.match(answered, /Use the Pro tier\./)

    const watch = watchBoards(MACHINE, 20)
    try {
      const updated = await runAkb(akb, ['task', 'update', '1', '--title', 'Updated pricing', '--json'], { cwd: ws.cwd, board: ws.board })
      assert.equal(updated.code, 0, updated.out || updated.last)
      await until(() => cloud.file(CARD)?.includes('title: Updated pricing') === true)
    } finally { watch.close() }
  })

  it('takes a folder’s writes in turn: the same change goes once (#59)', async () => {
    await prepareBoard()
    fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'once')
    const ws = keptBoard(cached())!
    const sent = await Promise.all([pushBoard(ws, MACHINE), pushBoard(ws, MACHINE), pull(openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cloud.folder!('prj_1')), MACHINE)])
    assert.deepEqual(sent.map((s) => s.ok), [true, true, true])
    assert.equal(commits().length, 1)
    assert.equal(cloud.file('memory/readme.md'), 'once')
    assert.equal(read('memory/readme.md'), 'once')
  })

  for (const archived of [false, true]) {
    it(`runs another task when an edited attachment belongs to a closed card (${archived ? 'archived' : 'still in todo'})`, async () => {
      const card = archived ? '.archive/1-task-1.md' : CARD
      if (archived) cloud.put({ [CARD]: null, [card]: BODY })
      await prepareBoard()
      cloud.taskStatus.task_1 = archived ? 'done' : 'cancelled'
      cloud.closedArtifacts.add('art_1')
      fs.writeFileSync(path.join(board(), path.dirname(card), 'hero.png'), 'local draft')
      if (!archived) fs.appendFileSync(path.join(board(), card), '\nLocal card draft.\n')
      fs.writeFileSync(path.join(board(), 'memory', 'readme.md'), 'unrelated change')

      const job = await runTask('j2', '', { task: 'task_2', number: 2 })
      assert.equal(job.outcome, 'done', job.reason)
      assert.equal(cloud.file('memory/readme.md'), 'unrelated change')
      assert.equal(cloud.task.artifacts.get('art_1')!.length, 1)
      assert.equal(read(path.join(path.dirname(card), 'hero.png')), 'local draft')
      assert.equal(cloud.file(card), BODY)
      if (!archived) assert.match(read(card), /Local card draft/)
      const uploads = () => cloud.log.filter(line => line === 'POST /v1/artifacts/art_1/uploads').length
      const ws = keptBoard(cached())!
      assert.ok((await pushBoard(ws, MACHINE)).ok)
      assert.ok((await pushBoard(ws, MACHINE)).ok)
      assert.equal(uploads(), 1)

      cloud.closedArtifacts.clear()
      cloud.taskStatus.task_1 = 'stopped'
      cloud.put({ ...(archived ? { [card]: null } : {}), [CARD]: `---\ntitle: Pricing\nrestored: 2026-11-27T06:45:00Z\n---\n\n${BODY}` })
      assert.ok((await pullChanges(ws)).ok)
      fs.writeFileSync(path.join(board(), 'todo', 'hero.png'), 'restored preview')
      assert.ok((await pushBoard(ws, MACHINE)).ok)
      assert.equal(uploads(), 2)
      assert.equal(cloud.task.artifacts.get('art_1')!.length, 2)
    })
  }

  it('keeps an unreachable attachment pending while other tasks run and publish their own assets', async () => {
    await prepareBoard()
    cloud.unreachableArtifacts.add('art_1')
    fs.writeFileSync(path.join(board(), 'todo/hero.png'), 'pending image')
    fs.appendFileSync(path.join(board(), CARD), '\nPending card draft.\n')
    fs.writeFileSync(path.join(board(), 'memory/readme.md'), 'unrelated change')
    const manifest = cloud.file('assets/task_1.json')

    const sent = await pushBoard(keptBoard(cached())!, MACHINE)
    assert.equal(sent.ok, false)
    if (!sent.ok) assert.match(sent.tasks?.task_1?.error ?? '', /hero.png: fetch failed/)
    assert.equal(cloud.file('memory/readme.md'), 'unrelated change')

    const job = await runTask('j2', `
      const fs = require('fs')
      fs.writeFileSync('todo/new.png', 'new image')
      fs.writeFileSync('todo/2-task-2.md', '# Task 2\\n\\n![](new.png)\\n')
    `, { task: 'task_2', number: 2 })
    assert.equal(job.outcome, 'done', job.reason)
    assert.ok(cloud.file('assets/task_2.json'))
    assert.equal(cloud.file(CARD), BODY)
    assert.equal(cloud.file('assets/task_1.json'), manifest)
    assert.match(read(CARD), /Pending card draft/)
    assert.equal(read('todo/hero.png'), 'pending image')
    assert.ok(unsent(cached()), 'another task cleared the pending upload')

    const own = await pull(openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cloud.folder!('prj_1')), MACHINE)
    assert.equal(own.ok, false)
    if (!own.ok) assert.match(own.error, /hero.png: fetch failed/)

    cloud.unreachableArtifacts.clear()
    const retry = await pushBoard(keptBoard(cached())!, MACHINE)
    assert.ok(retry.ok)
    assert.match(cloud.file(CARD)!, /Pending card draft/)
    assert.equal(cloud.task.artifacts.get('art_1')!.at(-1)!.toString(), 'pending image')
    assert.equal(unsent(cached()), false)
  })

  it('holds a malformed card draft while the rest of the board syncs', async () => {
    const other = 'todo/2-task-2.md'
    const header = '---\ntitle: Example\nstudio: coding\nstatus: ready\n---\n'
    const valid = header + '\n## Todo\n- [ ] Build\n'
    cloud.put({ [CARD]: valid, [other]: valid })
    await prepareBoard()
    cloud.previewProblems = (file, content) => {
      const relative = file.replace(/^projects\/[^/]+\//, '')
      return numberOfCard(relative) === null ? [] : newCardWriteProblems(relative, content, cloud.file(relative), { studio: 'coding' })
    }
    const draft = valid.replace('studio: coding\n', '')
    fs.writeFileSync(path.join(board(), CARD), draft)
    fs.writeFileSync(path.join(board(), other), valid + '\nAnother change.\n')
    const refused = await pushBoard(keptBoard(cached())!, MACHINE)
    assert.equal(refused.ok, false)
    if (!refused.ok) assert.match(refused.error, /Expected studio: coding/)
    assert.equal(cloud.file(CARD), valid)
    assert.equal(read(CARD), draft)
    assert.match(cloud.file(other)!, /Another change/)
    assert.ok(unsent(cached()))

    fs.writeFileSync(path.join(board(), CARD), valid + '\nRepaired.\n')
    assert.equal((await pushBoard(keptBoard(cached())!, MACHINE)).ok, true)
    assert.match(cloud.file(CARD)!, /Repaired/)
    assert.equal(unsent(cached()), false)
  })

  it('keeps invalid active and archived Preview drafts while a different task creates, resumes and uploads results (#880)', async () => {
    const archived = '.archive/3-old.md'
    const moved = '.archive/1-task-1.md'
    const oldArchive = '# Archived result\n\n## By `prompt-writer` agent\n\nOriginal draft.\n'
    cloud.put({ [archived]: oldArchive })
    await prepareBoard()
    cloud.previewProblems = (file, content) => {
      const relative = file.replace(/^projects\/[^/]+\//, '')
      return numberOfCard(relative) === null ? [] : taskPreviewProblems(content, ['ui-design', 'prompts'], [], relative)
    }

    const retirement = '\n## By `ui-designer` agent\n\nLocal Preview draft.\n'
    const archivedDraft = oldArchive + '\nUnsent archive edit.\n'
    const manifest = cloud.file('assets/task_1.json')
    const localManifest = JSON.stringify({ ...JSON.parse(manifest!), 'manual.png': { artifact: 'art_2', version: 1 } })
    fs.writeFileSync(path.join(board(), CARD), BODY + retirement)
    fs.writeFileSync(path.join(board(), archived), archivedDraft)
    fs.writeFileSync(path.join(board(), 'todo/hero.png'), 'unsent attachment')
    fs.writeFileSync(path.join(board(), 'assets/task_1.json'), localManifest)

    const own = await runTask('j1')
    assert.equal(own.outcome, 'failed')
    assert.match(own.reason!, /#1 todo\/1-task-1.md:7:1.*Role sections are retired.*Use a closed Preview block/)
    assert.doesNotMatch(own.reason!, /3-old/)
    const first = await runTask('j2', `
      const fs = require('fs')
      fs.writeFileSync('todo/2-task-2.md', '# Other task\\n')
    `, { task: 'task_2', number: 2 })
    assert.equal(first.outcome, 'done', first.reason)
    assert.equal(cloud.file('todo/2-task-2.md'), '# Other task\n')

    // A pending archive move must keep the existing Cloud card and its status.
    fs.renameSync(path.join(board(), CARD), path.join(board(), moved))
    fs.renameSync(path.join(board(), 'todo/hero.png'), path.join(board(), '.archive/hero.png'))
    const remoteArchive = oldArchive.replace('# Archived result', '# Updated archive')
    cloud.put({ [archived]: remoteArchive })
    const continued = await runTask('j3', `
      const fs = require('fs')
      fs.writeFileSync('todo/result.png', 'result')
      fs.appendFileSync('todo/2-task-2.md', '\\n<Asset src="result.png" />\\n')
    `, { task: 'task_2', number: 2 })
    assert.equal(continued.outcome, 'done', continued.reason)
    const ref = JSON.parse(cloud.file('assets/task_2.json')!)['result.png']
    assert.equal(cloud.task.artifacts.get(ref.artifact)![ref.version - 1]!.toString(), 'result')
    assert.equal(read(moved), BODY + retirement)
    assert.equal(read(archived), archivedDraft)
    assert.equal(read('.archive/hero.png'), 'unsent attachment')
    assert.equal(read('assets/task_1.json'), localManifest)
    assert.equal(cloud.file('assets/task_1.json'), manifest)
    assert.equal(cloud.file(CARD), BODY)
    assert.equal(cloud.file(moved), null)
    assert.equal(cloud.file(archived), remoteArchive)
    assert.ok(unsent(cached()))

    fs.writeFileSync(path.join(board(), moved), (BODY + retirement).replace('## By `ui-designer` agent', '<Preview id="ui-design">') + '</Preview>\n')
    fs.writeFileSync(path.join(board(), archived), archivedDraft.replace('## By `prompt-writer` agent', '<Preview id="prompts">') + '</Preview>\n')
    const repaired = await pushBoard(keptBoard(cached())!, MACHINE, [moved, archived])
    assert.ok(repaired.ok, JSON.stringify(repaired))
    assert.equal(cloud.file(CARD), null)
    assert.match(cloud.file(moved)!, /Local Preview draft/)
    assert.match(cloud.file(archived)!, /Updated archive[\s\S]*Unsent archive edit/)
    const repairedPin = JSON.parse(cloud.file('assets/task_1.json')!)['hero.png']
    assert.equal(cloud.task.artifacts.get(repairedPin.artifact)![repairedPin.version - 1]!.toString(), 'unsent attachment')
    assert.equal(unsent(cached()), false)
  })

  it('syncs only card assets and their declared dependencies, including multipart recovery', async () => {
    await prepareBoard()
    cloud.multipartSize = 200
    const files = new Map([
      ['../assets/1/guide.md', Buffer.from('# Guide\n\n![](nested/image.png)\n')],
      ['../assets/1/nested/image.png', Buffer.from([0, 255, 128])],
      ['.assets/1/data.bin', Buffer.alloc(600, 127)],
    ])
    for (const [name, bytes] of files) {
      const file = name.startsWith('.assets/')
        ? path.join(projectStateDir(board()), name.slice(1))
        : path.resolve(path.dirname(path.join(board(), CARD)), name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, bytes)
    }
    for (const root of [path.join(board(), 'assets/1'), path.join(projectStateDir(board()), 'assets/1')]) {
      for (const name of ['snap/snapshot.json', 'history/old.png', 'tools/check.mjs', 'build.log', 'source.url', 'node_modules/pkg/index.js']) {
        const file = path.join(root, name)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, 'unreferenced')
      }
    }
    fs.appendFileSync(path.join(board(), CARD), '\n<Asset src="../assets/1/guide.md" />\n\n<Asset src=".assets/1/data.bin" />\n')
    assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    for (const name of files.keys()) assert.ok(refs[name], name)
    assert.ok(!Object.keys(refs).some(key => /snapshot|history|tools|build.log|source.url|node_modules/.test(key)))
    assert.deepEqual(cloud.task.artifacts.get(refs['.assets/1/data.bin'].artifact)!.at(-1), files.get('.assets/1/data.bin'))
    const uploads = cloud.log.filter(line => line.endsWith('/uploads')).length
    assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
    assert.equal(cloud.log.filter(line => line.endsWith('/uploads')).length, uploads)
    const restored = fs.mkdtempSync(path.join(runnerHome(), 'restored-'))
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, restored)
    assert.ok((await pull(ws, MACHINE)).ok)
    for (const [name, bytes] of files) {
      const file = name.startsWith('.assets/')
        ? path.join(projectStateDir(ws.board), name.slice(1))
        : path.resolve(path.dirname(path.join(ws.board, CARD)), name)
      assert.deepEqual(fs.readFileSync(file), bytes, name)
    }
  })

  it('resyncs mixed task asset references and restores relative storyboard files', async () => {
    await prepareBoard()
    const here = keptBoard(cached())!
    const home = path.join(projectStateDir(board()), 'assets/1')
    const save = (name: string, value: string) => {
      const file = path.join(home, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, value)
    }
    save('images/picture.svg', '<svg/>')
    fs.appendFileSync(path.join(board(), CARD), '\n\n<Asset src=".assets/1/images/picture.svg" label="Legacy" />\n')
    assert.ok((await pushBoard(here, MACHINE)).ok)
    const legacy = JSON.parse(cloud.file('assets/task_1.json')!)['.assets/1/images/picture.svg']
    const original = cloud.file(CARD)
    save('pages/cover.html', '<img src="../images/picture.svg">')
    save('decks/deck.json', JSON.stringify({ slides: [{ id: 'cover', title: 'Cover', preview: { src: '../pages/cover.html' }, assets: ['../images/picture.svg'] }] }))
    fs.appendFileSync(path.join(board(), CARD), '\n\n<Storyboard src="asset:decks/deck.json" />\n\n![Picture](asset:images/picture.svg)\n')
    assert.ok((await pushBoard(here, MACHINE)).ok)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.equal(refs['asset:images/picture.svg'].artifact, legacy.artifact)
    assert.equal(refs['asset:images/picture.svg'].version, legacy.version)
    assert.deepEqual(refs['asset:decks/deck.json'].dependencies, ['asset:pages/cover.html', 'asset:images/picture.svg'])
    assert.ok(cloud.file(CARD)?.startsWith(original!))
    const restored = fs.mkdtempSync(path.join(runnerHome(), 'asset-ref-restore-'))
    const other = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, restored)
    const pulled = await pull(other, MACHINE)
    assert.ok(pulled.ok, !pulled.ok ? pulled.error : '')
    const asset = (name: string) => fs.readFileSync(path.join(projectStateDir(other.board), 'assets/1', name), 'utf8')
    assert.match(asset('pages/cover.html'), /src="\.\.\/images\/picture\.svg"/)
    const restoredDeck = JSON.parse(asset('decks/deck.json'))
    assert.equal(restoredDeck.slides[0].preview.src, '../pages/cover.html')
    assert.deepEqual(restoredDeck.slides[0].assets, ['../images/picture.svg'])
    const uploads = cloud.log.filter(line => line.startsWith('PUT /v1/uploads/')).length
    assert.ok((await pushBoard(keptBoard(restored)!, MACHINE)).ok)
    assert.equal(cloud.log.filter(line => line.startsWith('PUT /v1/uploads/')).length, uploads)
  })

  it('syncs Markdown attachments with full parenthesized paths and versions', async () => {
    await prepareBoard()
    const here = keptBoard(cached())!
    const files = path.join(projectStateDir(board()), 'assets/1')
    const report = 'asset:reports/Release%20notes%20(final).txt'
    const cover = 'asset:images/cover(draft(v2)).svg'
    const sample = 'reports/Release notes (final).txt'
    fs.mkdirSync(path.join(files, 'reports'), { recursive: true })
    fs.mkdirSync(path.join(files, 'images'), { recursive: true })
    fs.writeFileSync(path.join(files, sample), 'First report')
    fs.writeFileSync(path.join(files, 'images/cover(draft(v2)).svg'), '<svg/>')
    fs.appendFileSync(path.join(board(), CARD), `\n<Preview id="draft">\n\n[Download](${report})\n\n![Cover](${cover} "Draft")\n\n</Preview>\n`)
    const manifest = () => JSON.parse(cloud.file('assets/task_1.json')!)
    assert.deepEqual(await pushBoard(here, MACHINE), { ok: true, changed: true })
    const first = manifest()
    assert.equal(first[report].version, 1)
    assert.equal(first[cover].version, 1)

    fs.writeFileSync(path.join(files, sample), 'Revised report')
    assert.deepEqual(await pushBoard(here, MACHINE), { ok: true, changed: true })
    const updated = manifest()
    assert.deepEqual(updated[report], { ...first[report], version: 2 })
    assert.deepEqual(updated[cover], first[cover])
  })

  it('uploads and restores Markdown document images while preserving code examples', async () => {
    cloud.put({ 'config.md': '# Board\n' })
    await prepareBoard()
    const assets = path.join(projectStateDir(board()), 'assets/1')
    const cover = 'images/cover(final).svg'
    const detail = 'images/detail (draft(v2)).svg'
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="12" fill="teal"/></svg>'
    const coverRef = '![Cover](../images/cover(final).svg "Final cover")'
    const detailRef = "![Detail](<../images/detail%20(draft(v2)).svg> 'Draft (v2)')"
    const example = '![Example](<../images/example (unavailable).svg>)'
    const files = new Map([
      ['docs/guide.md', ['# Guide', '', '```markdown', coverRef, '```', '', '`' + example + '` and ' + coverRef + ' After the cover.', ''].join('\n')],
      ['docs/guide.mdx', ['# Details', '', '~~~md', example, '~~~', '', '``' + detailRef + ' with `tick``', '', detailRef + ' After the detail.', ''].join('\r\n')],
      ['docs/examples.md', ['# Examples', '', '```markdown', example, ''].join('\n')],
      [cover, svg],
      [detail, svg.replace('teal', 'navy')],
    ])
    for (const [name, text] of files) {
      const file = path.join(assets, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
    }
    fs.writeFileSync(path.join(board(), CARD), `---
title: Markdown images
priority: med
status: todo
blocked_by: []
related: []
modules: []
studio: wf-own
questions: []
---

<Asset src="asset:docs/guide.md" label="Guide" />

<Asset src="asset:docs/guide.mdx" label="Details" />

<Asset src="asset:docs/examples.md" label="Examples" />

## Worth noting

<!-- agent -->

## Scope

Show both images.

## Todo

- [ ] Check both images.

## Decided by the agent

### Overruled by the user
`)
    const pushed = await pushBoard(keptBoard(cached())!, MACHINE)
    assert.ok(pushed.ok, JSON.stringify(pushed))
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.deepEqual(Object.keys(refs).sort(), [...files.keys()].map(name => 'asset:' + encodeURI(name)).sort())
    assert.equal(refs['asset:docs/examples.md'].dependencies, undefined)
    const images = new Map([['docs/guide.md', cover], ['docs/guide.mdx', detail]])
    for (const [name, text] of files) {
      const pin = refs['asset:' + encodeURI(name)]
      const image = images.get(name)
      let expected = text
      if (image) {
        const encoded = encodeURI(image)
        assert.deepEqual(pin.dependencies, ['asset:' + encoded])
        const target = '../' + encoded
        const start = text.lastIndexOf(target)
        expected = text.slice(0, start) + refs['asset:' + encoded].artifact + text.slice(start + target.length)
      }
      assert.equal(pin.version, 1)
      assert.deepEqual(cloud.task.artifacts.get(pin.artifact)![pin.version - 1], Buffer.from(expected))
    }

    const restored = fs.mkdtempSync(path.join(runnerHome(), 'markdown-images-'))
    const other = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, restored)
    const pulled = await pull(other, MACHINE)
    assert.ok(pulled.ok, JSON.stringify(pulled))
    const folder = path.join(projectStateDir(other.board), 'assets/1')
    for (const [name, text] of files) assert.equal(fs.readFileSync(path.join(folder, name), 'utf8'), text)
    const validated = await runAkb(bundledAkb(process.env.RUNNER_DIST!), ['task', 'validate', '1', '--json'], { cwd: other.cwd, board: other.board })
    assert.equal(validated.code, 0, validated.last)
    assert.equal(JSON.parse(validated.out).valid, true)
  })

  it('uploads mockup resources but no local checker cache or temporary sources (#719)', async () => {
    await prepareBoard()
    const assets = path.join(projectStateDir(board()), 'assets/1')
    const local = path.join(runnerHome(), '.cache/wildcrane/mockup-check')
    fs.mkdirSync(assets, { recursive: true })
    const page = `<link rel="stylesheet" href="style.css">
<img alt="Preview" src="picture.svg">
<button>Open preview</button>
<script>
  const button = document.querySelector('button');
  button.addEventListener('click', () => { button.textContent = 'Preview opened'; });
  const unreferenced = 'unreferenced.png';
</script>`
    for (const name of ['page.htm', 'page.html']) fs.writeFileSync(path.join(assets, name), page)
    fs.writeFileSync(path.join(assets, 'style.css'), 'body { color: rgb(9, 80, 110); background-image: url("picture.svg") }')
    const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="12" fill="teal"/></svg>'
    fs.writeFileSync(path.join(assets, 'picture.svg'), picture)
    const cacheFiles = ['env/node_modules/pkg/index.js', 'env/browsers/shell', 'work/source.tsx']
    for (const name of cacheFiles) {
      fs.mkdirSync(path.dirname(path.join(local, name)), { recursive: true })
      fs.writeFileSync(path.join(local, name), 'LOCAL_CHECKER_CACHE')
    }
    fs.writeFileSync(path.join(board(), CARD), '# Mockup\n\n<Asset src=".assets/1/page.html" />\n\n<Asset src=".assets/1/page.htm" />\n')
    assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
    const refs = JSON.parse(cloud.file('assets/task_1.json')!)
    assert.deepEqual(Object.keys(refs).sort(), ['.assets/1/page.htm', '.assets/1/page.html', '.assets/1/picture.svg', '.assets/1/style.css'])
    const html = (name: string) => {
      const { artifact, version } = refs[`.assets/1/${name}`]
      assert.equal(cloud.types.get(artifact), 'html')
      return cloud.task.artifacts.get(artifact)![version - 1]!.toString()
    }
    assert.equal(html('page.htm'), html('page.html'))
    const style = refs['.assets/1/style.css']
    assert.ok(html('page.htm').includes(`rel="stylesheet" href="${style.artifact}"`))
    assert.match(cloud.task.artifacts.get(style.artifact)![style.version - 1]!.toString(), /body \{ color: rgb\(9, 80, 110\); background-image: url\("art_/)
    const uploaded = Object.values(refs as api.Assets).flatMap(ref => cloud.task.artifacts.get(ref.artifact) ?? [])
    assert.equal(uploaded.length, 4)
    assert.match(html('page.htm'), new RegExp(`src="${refs['.assets/1/picture.svg'].artifact}"`))
    assert.ok(uploaded.some(bytes => bytes.toString() === picture))
    assert.ok(uploaded.every(bytes => !bytes.toString().includes('LOCAL_CHECKER_CACHE')))
    const puts = () => cloud.log.filter(line => line.startsWith('PUT /v1/uploads/')).length
    const storedBytes = () => [...cloud.task.artifacts.values()].flat().reduce((sum, file) => sum + file.byteLength, 0)
    const count = puts(), bytes = storedBytes()
    for (let revision = 0; revision < 2; revision++) {
      fs.writeFileSync(path.join(local, 'work/source.tsx'), `revision ${revision}`)
      assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
      assert.equal(puts(), count)
      assert.equal(storedBytes(), bytes)
    }
    fs.symlinkSync(path.join(local, 'env/browsers/shell'), path.join(assets, 'cache.bin'))
    fs.appendFileSync(path.join(board(), CARD), '\n<Asset src=".assets/1/cache.bin" />\n')
    assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
    assert.match(JSON.parse(cloud.file('assets/task_1.json')!)['.assets/1/cache.bin'].error, /outside the board/)
    assert.equal(puts(), count)
  })

  it('syncs rendered web preview references and reports missing local files', async () => {
    await prepareBoard()
    const ws = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, cloud.folder!('prj_1'))
    fs.writeFileSync(path.join(ws.board, 'config.md'), '')
    const folder = path.join(projectStateDir(ws.board), 'assets/1')
    const write = (name: string, content: string) => {
      const file = path.join(folder, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    }
    const imageSet = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7 1x, '
    const hero = 'media/Hero (1).svg'
    const heroKey = 'asset:media/Hero%20(1).svg'
    const heroUrl = 'media/Hero%20%281%29.svg?variant=preview#cover'
    const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="37" height="23"><view id="cover" viewBox="0 0 37 23"/><rect width="37" height="23" fill="teal"/></svg>'
    write('page.tsx', 'import Preview from "./parts/Preview"; import "./styles/main.css"; import "./extra/extra.css"; export default Preview')
    write('parts/Preview.tsx', `export default function Preview() {
      const src = (name: string, ext: string) => ['media', name + '.' + ext].join('/');
      const sources = ${JSON.stringify(imageSet)} + src('responsive', 'webp') + ' 2x';
      return <main style={{ backgroundImage: 'url("' + src('inline & image', 'webp') + '")' }}>
        <div className="cover">Cover</div>
        <link rel="preload" as="image" imageSrcSet={sources} />
        <img src={src('screenshot', 'webp')} />
        <picture><source srcSet={sources} /><img src={src('fallback', 'webp')} /></picture>
        <svg><use href={src('icons', 'svg') + '#star'} /></svg>
        <video poster={src('poster', 'webp')}><source src={src('clip', 'webm')} /><track src={src('captions', 'vtt')} /></video>
        <audio src={src('sound', 'wav')} />
        <script>{'let ignored = "url(ignored.png)";'}</script>
      </main>
    }`)
    write('page.html', '<link rel=stylesheet href=styles/main.css><main class="cover">Cover</main>')
    const sheets = {
      'styles/main.css': '@import url("theme/skin.css") screen; .cover { color: teal }',
      'styles/theme/skin.css': `
      /* url(ignored.png) */
      @font-face { font-family: Local; src: url(font.woff2) }
      .cover { font-family: Local; background-image: url(../../${heroUrl});
        border-image-source: image-set("../../media/retina.webp" 1x, url("../../media/retina-2.webp") 2x) }
      `,
    }
    for (const [file, css] of Object.entries(sheets)) write(file, css)
    write('extra/extra.css', '.extra { background: url(extra.webp) }')
    write('unused.webp', 'unused')
    const files = [
      'media/screenshot.webp', 'media/responsive.webp', 'media/fallback.webp', 'media/inline & image.webp',
      'media/icons.svg', 'media/poster.webp', 'media/clip.webm', 'media/captions.vtt', 'media/sound.wav',
      'styles/theme/font.woff2', hero, 'media/retina.webp', 'media/retina-2.webp', 'extra/extra.webp',
    ]
    const body = `---
title: Rendered previews
priority: med
status: ready
blocked_by: []
related: []
modules: []
studio: wf-own
questions: []
---

Web preview resources.

## Worth noting

<Preview id="ui-design">

<Asset src="asset:page.tsx" label="TSX" />

<Asset src="asset:page.html" label="HTML" />

</Preview>

<!-- agent -->

## Scope

Verify local assets.

## Todo

- [ ] Verify previews.

## Decided by the agent
`
    fs.writeFileSync(path.join(ws.board, CARD), body)
    const validate = () => runAkb(bundledAkb(process.env.RUNNER_DIST!), ['task', 'validate', '1', '--json'], { cwd: ws.cwd, board: ws.board })
    const missing = await validate()
    assert.notEqual(missing.code, 0)
    for (const file of files) assert.ok(missing.out.includes(file === hero ? heroUrl : path.basename(file)), missing.out)
    assert.doesNotMatch(missing.out, /ignored\.png|base64/)
    const rejected = await push(ws, { id: 'preview-dependencies', machineId: MACHINE })
    assert.equal(rejected.ok, false)
    assert.match(rejected.error!, /screenshot\.webp|font\.woff2/)
    for (const file of files) write(file, file === hero ? picture : file)
    for (const [file, css] of Object.entries(sheets)) {
      fs.rmSync(path.join(folder, file))
      const missingSheet = await validate()
      assert.notEqual(missingSheet.code, 0)
      assert.ok(missingSheet.out.includes(path.basename(file)), missingSheet.out)
      write(file, css)
    }
    const escaped = path.join(folder, 'media/icons.svg')
    fs.rmSync(escaped)
    fs.symlinkSync(path.join(folder, '../outside.svg'), escaped)
    fs.writeFileSync(path.join(folder, '../outside.svg'), '<svg/>')
    const outside = await validate()
    assert.notEqual(outside.code, 0)
    assert.match(outside.out, /icons\.svg.*outside this card/)
    fs.unlinkSync(escaped)
    write('media/icons.svg', 'media/icons.svg')
    const valid = await validate()
    assert.equal(valid.code, 0, valid.out + valid.last)

    assert.ok((await pushBoard(keptBoard(cached())!, MACHINE)).ok)
    const pins = JSON.parse(cloud.file('assets/task_1.json')!) as api.Assets
    const artifact = (name: string) => pins['asset:' + name.split('/').map(encodeURIComponent).join('/')]!.artifact
    const uploaded = (name: string) => cloud.task.artifacts.get(artifact(name))!.at(-1)!.toString()
    const names = Object.keys(pins).filter(key => key.startsWith('asset:')).map(key => decodeURIComponent(key.slice(6)))
    assert.deepEqual(names.sort(), [...files, 'page.tsx', 'page.html', 'styles/main.css', 'styles/theme/skin.css'].sort())
    const tsx = uploaded('page.tsx')
    const candidates = `${imageSet}${artifact('media/responsive.webp')} 2x`
    assert.equal(/\bimagesrcset="([^"]*)"/i.exec(tsx)?.[1], candidates)
    assert.equal(/\bsrcset="([^"]*)"/i.exec(tsx)?.[1], candidates)
    assert.ok(tsx.includes(`href="${artifact('media/icons.svg')}#star"`))
    assert.ok(tsx.includes(`poster="${artifact('media/poster.webp')}"`))
    for (const file of files) {
      assert.ok(tsx.includes(artifact(file)), file)
      assert.equal(uploaded(file), file === hero ? picture : file)
    }
    assert.ok(tsx.includes(`url(${artifact(hero)}?variant=preview#cover)`))
    assert.ok(uploaded('page.html').includes(artifact('styles/main.css')))
    assert.ok(uploaded('styles/main.css').includes(artifact('styles/theme/skin.css')))
    for (const file of ['styles/theme/font.woff2', hero, 'media/retina.webp', 'media/retina-2.webp']) {
      assert.ok(uploaded('styles/theme/skin.css').includes(artifact(file)), file)
    }
    assert.deepEqual(pins['asset:page.html']!.dependencies, ['asset:styles/main.css'])
    assert.deepEqual(pins['asset:styles/main.css']!.dependencies, ['asset:styles/theme/skin.css'])
    assert.ok(pins['asset:styles/theme/skin.css']!.dependencies?.includes(heroKey))
    assert.ok(pins['asset:page.tsx']!.dependencies?.includes(heroKey))
    assert.equal(pins[heroKey]!.version, 1)

    const restored = openTaskFolder({ task: 'task_1', project: 'prj_1', number: 1 }, fs.mkdtempSync(path.join(runnerHome(), 'web-previews-')))
    assert.ok((await pull(restored, MACHINE)).ok)
    const restoredFile = (name: string) => path.join(projectStateDir(restored.board), 'assets/1', name)
    assert.ok(fs.readFileSync(restoredFile('styles/theme/skin.css'), 'utf8').includes(`url(../../${heroUrl})`))
    assert.ok(fs.readFileSync(restoredFile('page.tsx'), 'utf8').includes(`url(${heroUrl})`))
    assert.deepEqual(fs.readFileSync(restoredFile(hero)), Buffer.from(picture))
    const pulled = await runAkb(bundledAkb(process.env.RUNNER_DIST!), ['task', 'validate', '1', '--json'], { cwd: restored.cwd, board: restored.board })
    assert.equal(pulled.code, 0, pulled.out + pulled.last)

    const card = path.join(restored.board, CARD)
    const edited = 'Web preview resources were restored.'
    fs.writeFileSync(card, fs.readFileSync(card, 'utf8').replace('Web preview resources.', edited))
    const pushed = await pushBoard(keptBoard(restored.cwd)!, MACHINE)
    assert.ok(pushed.ok, JSON.stringify(pushed))
    assert.ok(cloud.file(CARD)?.includes(edited))
    assert.deepEqual(JSON.parse(cloud.file('assets/task_1.json')!), pins)
  })
})
