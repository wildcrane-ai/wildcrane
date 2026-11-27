import { decodeStudioZip, encodeStudioZip, sha256Bytes, studioFilesSha256 } from '../../cli/src/lib/shared/studio-package'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { SESSIONS_FILE, projectStateDir } from '../../cli/src/lib/machine/project'
import { loadPublishedStudio, readVersion, savePin, saveVersion } from '../../cli/src/lib/agent/cloud-studios'
import { captureConflict } from '../../cli/src/lib/shared/board-conflicts'
import { IDLE_MS, cacheDir, clearAkb, hold, markUnsent, markUsed, removeLegacy, sweepCache, sweepStudios } from '../src/cache'
import { keepOnly } from '../src/folders'
import { runnerHome, useRunnerHome } from '../src/home'
import { FakeCloud, writeFakeSession } from './fake-cloud'

// The cache (#2147): idle or unreachable projects go, unless a job, a paused delivery or an
// unsent write keeps them.

const MACHINE = '55555555-5555-4555-8555-555555555555'
const NOW = Date.now()
const OLD = NOW - IDLE_MS - 60_000

let cloud: FakeCloud

/** A cached project's folder, last used `at`. */
function cached(project: string, at = NOW): string {
  const dir = cacheDir(project)
  fs.mkdirSync(path.join(dir, '.akb', 'kanban'), { recursive: true })
  markUsed(dir, at)
  return dir
}

function linked(at = NOW): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-')))
  spawnSync('git', ['init', '-q', dir])
  fs.writeFileSync(path.join(dir, 'app.ts'), 'mine')
  fs.mkdirSync(path.join(dir, '.akb', 'kanban'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.akb', 'base.json'), '{}')
  markUsed(dir, at)
  fs.writeFileSync(path.join(runnerHome(), 'projects.json'), JSON.stringify({ projects: [dir] }))
  return dir
}

const has = (project: string) => fs.existsSync(cacheDir(project))
const reach = (...projects: string[]) =>
  (cloud.others = projects.map((project) => ({ project, name: project, workspace: 'ws_1', workspace_name: 'Mine', personal: true })))

beforeEach(async () => {
  useRunnerHome()
  fs.rmSync(runnerHome(), { recursive: true, force: true })
  writeFakeSession(runnerHome())
  cloud = new FakeCloud()
  await cloud.start()
})

afterEach(async () => {
  await cloud.stop()
})

describe('the cache (#2147)', () => {
  it('retains unresolved and damaged conflict records even without the unsent marker (#806)', async () => {
    for (const damaged of [false, true]) {
      const dir = cached(damaged ? 'prj_damaged' : 'prj_conflicted', OLD)
      const board = path.join(dir, '.akb/kanban')
      captureConflict(board, 'prj_1', [{ path: 'memory/readme.md', remotePath: 'projects/prj_1/memory/readme.md',
        conflicted: true, reason: 'both-modified', base: { content: 'base', seq: 1 }, local: { content: 'mine' }, remote: { content: 'theirs', seq: 2 } }])
      if (damaged) {
        const record = fs.readdirSync(path.join(projectStateDir(board), 'conflicts'))[0]!
        fs.writeFileSync(path.join(projectStateDir(board), 'conflicts', record), '{')
      }
      markUnsent(dir, false)
      assert.equal(clearAkb(dir), false)
      assert.ok(!(await sweepCache(MACHINE, NOW)).includes(dir))
      assert.ok(fs.existsSync(dir))
    }
  })

  it('drops a project unused for a week, keeps a recent one, and starts counting for one with no record', async () => {
    reach('prj_old', 'prj_new', 'prj_bare')
    cached('prj_old', OLD)
    cached('prj_new')
    fs.mkdirSync(cacheDir('prj_bare'), { recursive: true })
    await sweepCache(MACHINE, NOW)
    assert.deepEqual([has('prj_old'), has('prj_new'), has('prj_bare')], [false, true, true])
    await sweepCache(MACHINE, NOW + IDLE_MS + 60_000)
    assert.equal(has('prj_bare'), false)
  })

  it('drops a project the account no longer reaches', async () => {
    reach('prj_1')
    cached('prj_1')
    cached('prj_gone')
    await sweepCache(MACHINE, NOW)
    assert.deepEqual([has('prj_1'), has('prj_gone')], [true, false])
  })

  it('keeps a project a job runs in, one with a paused delivery, and one whose write to Cloud failed', async () => {
    const running = cached('prj_running', OLD)
    const release = hold(running)
    const paused = cached('prj_paused', OLD)
    const state = projectStateDir(path.join(paused, '.akb', 'kanban'))
    fs.mkdirSync(state, { recursive: true })
    fs.writeFileSync(path.join(state, SESSIONS_FILE), JSON.stringify({ deliveries: [{ deliveryId: 'd1', status: 'active' }] }))
    markUnsent(cached('prj_unsent', OLD), true)
    await sweepCache(MACHINE, NOW)
    assert.deepEqual([has('prj_running'), has('prj_paused'), has('prj_unsent')], [true, true, true])

    release()
    fs.writeFileSync(path.join(state, SESSIONS_FILE), JSON.stringify({ deliveries: [{ deliveryId: 'd1', status: 'finished' }] }))
    markUnsent(cacheDir('prj_unsent'), false)
    await sweepCache(MACHINE, NOW)
    assert.deepEqual([has('prj_running'), has('prj_paused'), has('prj_unsent')], [false, false, false])
  })

  it('keeps legacy board state until the shared initializer can migrate it', async () => {
    const dir = cached('prj_legacy', OLD)
    const file = path.join(dir, '.akb/boards/.akb/kanban/assets/1/saved.txt')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'Unsynced asset')
    assert.equal(clearAkb(dir), false)
    assert.ok(!(await sweepCache(MACHINE, NOW)).includes(dir))
    assert.equal(fs.readFileSync(file, 'utf8'), 'Unsynced asset')
  })

  it('drops by idleness alone when Cloud cannot say who has access', async () => {
    cached('prj_fresh')
    cached('prj_old', OLD)
    await cloud.stop()
    await sweepCache(MACHINE, NOW)
    assert.deepEqual([has('prj_fresh'), has('prj_old')], [true, false])

    fs.rmSync(path.join(runnerHome(), 'session.json'))
    await cloud.start()
    await sweepCache(MACHINE, NOW)
    assert.equal(has('prj_fresh'), true)
  })

  it('empties a linked folder’s .akb/ alone, when idle or no longer this computer’s', async () => {
    const idle = linked(OLD)
    cloud.folders = [{ project: 'prj_1', name: 'Site', path: idle, notify: true, machine: MACHINE }]
    await sweepCache(MACHINE, NOW)
    assert.deepEqual(fs.readdirSync(path.join(idle, '.akb')), [])
    assert.equal(fs.readFileSync(path.join(idle, 'app.ts'), 'utf8'), 'mine')

    const away = linked()
    cloud.folders = []
    await sweepCache(MACHINE, NOW)
    assert.deepEqual(fs.readdirSync(path.join(away, '.akb')), [])

    const kept = linked()
    cloud.folders = [{ project: 'prj_1', name: 'Site', path: kept, notify: true, machine: MACHINE }]
    await sweepCache(MACHINE, NOW)
    assert.ok(fs.existsSync(path.join(kept, '.akb', 'base.json')))
  })

  it('empties the .akb/ of a folder taken off this computer, unless a job holds it', () => {
    const dir = linked()
    const release = hold(dir)
    for (const gone of keepOnly([])) assert.equal(clearAkb(gone), false)
    assert.ok(fs.existsSync(path.join(dir, '.akb', 'base.json')))
    release()
    assert.equal(clearAkb(dir), true)
    assert.deepEqual(fs.readdirSync(path.join(dir, '.akb')), [])
  })

  it('removes the folders from before the cache, and an account folder left empty', () => {
    const home = runnerHome()
    for (const dir of ['boards/prj_1', 'akb-bin', 'acct/unfiled/prj_1/.akb', 'other/unfiled', 'work/j1']) fs.mkdirSync(path.join(home, dir), { recursive: true })
    fs.writeFileSync(path.join(home, 'other', 'keep.json'), '{}')
    removeLegacy()
    for (const gone of ['boards', 'akb-bin', 'acct', 'other/unfiled']) assert.equal(fs.existsSync(path.join(home, gone)), false, gone)
    for (const kept of ['other/keep.json', 'work/j1', 'session.json']) assert.ok(fs.existsSync(path.join(home, kept)), kept)
  })
})

describe('studio versions (#651)', () => {
  const version = (id: string, n: number) => ({ id, version: n, name: id, files: {} })
  const held = () => fs.readdirSync(path.join(runnerHome(), 'studios', 'versions')).sort()

  it('keeps the newest of each studio and what an unfinished or unreachable task runs on', async () => {
    for (const n of [1, 2, 3, 4, 5, 6]) saveVersion(version('wf_blog', n))
    savePin('task_live', version('wf_blog', 1))
    savePin('task_done', version('wf_blog', 2))
    savePin('task_gone', version('wf_blog', 3))
    savePin('task_down', version('wf_blog', 4))
    cloud.taskStatus = { task_done: 'done', task_gone: 'gone', task_down: 'down' }

    await sweepStudios()
    assert.deepEqual(held(), ['wf_blog@1.json', 'wf_blog@4.json', 'wf_blog@6.json'])

    cloud.taskStatus = { task_live: 'cancelled', task_down: 'down' }
    await sweepStudios()
    assert.deepEqual(held(), ['wf_blog@4.json', 'wf_blog@6.json'])
  })
})

it('deduplicates verified package downloads and replaces a corrupt version cache', async () => {
  const id = 'wf_package'
  const files = { 'STUDIO.md': '---\nname: Coding\n---\n', 'references/utf8.txt': '\ufeff中文', 'screenshots/demo.png': 'data:image/png;base64,AAE=' }
  const { zip } = encodeStudioZip(files)
  assert.deepEqual(decodeStudioZip(zip), files)
  const malformed = zip.slice()
  malformed[14] = malformed[14]! ^ 1
  assert.throws(() => decodeStudioZip(malformed), /Invalid Studio ZIP/)
  const version = 1
  const pack = { version, filesSha256: await studioFilesSha256(files), zipSha256: await sha256Bytes(zip),
    zipBytes: zip.length, downloadUrl: '/v1/studios/' + id + '/versions/1/package' }
  const read = async () => ({ ok: true as const, value: { id, version, package: pack } })
  let downloaded = 0
  let body = malformed
  const download = async () => {
    downloaded++
    await new Promise(resolve => setImmediate(resolve))
    return { ok: true as const, value: body }
  }
  const load = () => loadPublishedStudio('/v1/studios/' + id, read, download)
  assert.equal((await load()).ok, false)
  assert.equal(readVersion(id, version), null)
  body = zip
  const concurrent = await Promise.all([load(), load(), load()])
  assert.ok(concurrent.every(result => result.ok))
  assert.equal(downloaded, 2)
  const cache = path.join(runnerHome(), 'studios', 'versions', id + '@1.json')
  const json = JSON.parse(fs.readFileSync(cache, 'utf8'))
  json.files['references/utf8.txt'] = 'corrupt'
  fs.writeFileSync(cache, JSON.stringify(json))
  assert.equal(readVersion(id, version), null)
  assert.equal((await load()).ok, true)
  assert.deepEqual(readVersion(id, version)?.files, files)
  assert.equal(downloaded, 3)
})
