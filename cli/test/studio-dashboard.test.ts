import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { cmdStudioDashboardPublish, packDashboardDir } from '../src/commands/studio'
import { writeSession } from '../src/lib/cloud/session'

const tmpDirs: string[] = []
const dashboardFiles = {
  'index.html': '<script src="./assets/app.js" defer></script><img src="./assets/mark.svg" alt="Mark">',
  'assets/app.js': 'document.querySelector("img").title = "Dashboard"',
  'assets/mark.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>',
}

function makeDir(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-dash-'))
  tmpDirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return dir
}

function unpackDashboard(gzip: Uint8Array) {
  const tar = zlib.gunzipSync(gzip)
  const files: Record<string, string> = {}
  for (let offset = 0; offset < tar.length && tar[offset] !== 0;) {
    const name = tar.toString('utf8', offset, offset + 100).split('\0')[0]!
    const size = Number.parseInt(tar.toString('ascii', offset + 124, offset + 136), 8)
    const start = offset + 512
    files[name] = tar.toString('utf8', start, start + size)
    offset = start + Math.ceil(size / 512) * 512
  }
  return files
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('studio dashboard publish (#1131)', () => {
  it('validates index.html presence and packs directory into .tar.gz', () => {
    const missingIndex = makeDir({ 'app.js': 'console.log(1)' })
    assert.throws(() => packDashboardDir(missingIndex), /index\.html/)

    const valid = makeDir(dashboardFiles)
    const packed = packDashboardDir(valid)
    assert.equal(packed.fileCount, Object.keys(dashboardFiles).length)
    assert.ok(packed.sizeBytes > 0)
    assert.deepEqual(unpackDashboard(packed.gzip), dashboardFiles)
  })

  it('creates and publishes a new dashboard when studio has none, and updates existing one', async () => {
    const dir = makeDir(dashboardFiles)
    const home = makeDir({})
    const requests: string[] = []
    const bundleUrl = 'https://d-0123456789abcdef.wildcraneusercontent.com/'
    const realFetch = globalThis.fetch
    const prevEnv = { ...process.env }
    process.env.AI4KANBAN_HOME = home
    process.env.AI4KANBAN_SUPABASE_URL = 'https://project.supabase.co'
    process.env.AI4KANBAN_CLOUD_URL = 'https://api.example.com'
    writeSession({
      version: 1,
      supabaseUrl: 'https://project.supabase.co',
      accessToken: 'tok_test',
      refreshToken: 'ref_test',
      expiresAt: Date.now() + 3600_000,
      subject: '11111111-1111-4111-8111-111111111111',
    })

    let created = false
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? 'GET'
      const { pathname, searchParams } = new URL(url)
      requests.push(`${method} ${pathname}`)
      if (method === 'GET' && url.includes('/v1/dashboards?')) {
        assert.equal(searchParams.get('studio'), 'wf_demo')
        assert.equal(searchParams.get('workspace'), 'ws_1')
        return new Response(JSON.stringify({
          object: 'list',
          data: created ? [{ id: 'dash_1', studio: 'wf_demo', url: 'https://d-0123456789abcdef.wildcraneusercontent.com/', access: 'private', fileCount: 1, sizeBytes: 11 }] : [],
          hasMore: false,
          nextCursor: null,
        }), { status: 200 })
      }
      if (method === 'POST' && url.endsWith('/v1/dashboards')) {
        assert.equal(JSON.parse(String(init?.body)).studio, 'wf_demo')
        created = true
        return new Response(JSON.stringify({ id: 'dash_1', studio: 'wf_demo', url: 'https://d-0123456789abcdef.wildcraneusercontent.com/', access: 'public', fileCount: 0, sizeBytes: 0 }), { status: 201 })
      }
      if (method === 'PATCH' && url.endsWith('/v1/dashboards/dash_1')) {
        return new Response(JSON.stringify({ id: 'dash_1', studio: 'wf_demo', url: 'https://d-0123456789abcdef.wildcraneusercontent.com/', access: 'private', fileCount: 1, sizeBytes: 11 }), { status: 200 })
      }
      if (method === 'PUT' && url.endsWith('/v1/dashboards/dash_1/bundle')) {
        const bundle = init?.body
        assert.ok(bundle instanceof Blob)
        assert.deepEqual(unpackDashboard(new Uint8Array(await bundle.arrayBuffer())), dashboardFiles)
        return new Response(JSON.stringify({ id: 'dash_1', studio: 'wf_demo', url: bundleUrl, access: 'public', fileCount: 3, sizeBytes: 11 }), { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    }) as typeof fetch

    try {
      const first = await cmdStudioDashboardPublish('wf_demo', dir, { workspace: 'ws_1', access: 'public', name: 'Demo' })
      assert.equal(first.id, 'dash_1')
      assert.equal(first.access, 'public')
      assert.equal(first.studio, 'wf_demo')
      assert.equal(first.url, bundleUrl)
      assert.deepEqual(requests, ['GET /v1/dashboards', 'POST /v1/dashboards', 'PUT /v1/dashboards/dash_1/bundle'])

      requests.length = 0
      await cmdStudioDashboardPublish('wf_demo', dir, { workspace: 'ws_1', access: 'private' })
      assert.deepEqual(requests, ['GET /v1/dashboards', 'PATCH /v1/dashboards/dash_1', 'PUT /v1/dashboards/dash_1/bundle'])
    } finally {
      globalThis.fetch = realFetch
      process.env = prevEnv
    }
  })
})
