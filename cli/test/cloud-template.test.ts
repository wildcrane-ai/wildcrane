// `akb template` (#1708): bounded search, previews apart from the template, a hashed
// download that never overwrites, and a publish that keeps previews and evidence out of the
// template's own files.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { readTemplateMeta } from '../src/commands/cloud-template.ts'
import { runAgent } from '../src/lib/agent-cli.ts'
import { writeSession } from '../src/lib/cloud/session.ts'
import { setLanguage } from '../src/lib/machine/settings.ts'
import { restoreMachineHome } from './helpers/board.ts'

const SUPABASE = 'https://project.supabase.co'
const API = 'https://api.example.test'
const TEMPLATE_MD = `---
name: hero-tilted-screen
category: ui
tags: [hero, saas]
title: Hero over a tilted product screen
summary: A dark SaaS hero.
description: |
  Layout and motion from Linear's hero.
  Every word is a placeholder.
access: free
source:
  site: https://linear.app/
  references:
    - https://supahero.io/hero/linear
  captured: 2026-10-16T09:00:00+08:00
  note: 维护者采集的截图。
---

# Hero
`

let home = ''
const realFetch = globalThis.fetch
let sent: { url: string; method: string; body: unknown }[] = []

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-template-'))
  process.env.AI4KANBAN_HOME = home
  process.env.AI4KANBAN_SUPABASE_URL = SUPABASE
  process.env.AI4KANBAN_CLOUD_URL = API
  sent = []
})

afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(home, { recursive: true, force: true })
  restoreMachineHome()
  delete process.env.AI4KANBAN_SUPABASE_URL
  delete process.env.AI4KANBAN_CLOUD_URL
})

function signIn(): void {
  writeSession({
    version: 1,
    supabaseUrl: SUPABASE,
    accessToken: 'token-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + 60 * 60 * 1000,
    subject: '11111111-1111-4111-8111-111111111111',
  })
}

/** Answer each request by its path under /v1/templates. */
function serve(routes: Record<string, () => Response>): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = String(url).slice(`${API}/v1/templates`.length)
    sent.push({ url: route, method: init?.method ?? 'GET', body: init?.body })
    const answer = routes[route.split('?')[0] ?? '']
    if (!answer) throw new Error(`unexpected ${route}`)
    return answer()
  }) as typeof fetch
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const refusal = (status: number, code: string, message?: string) => json({ error: { code, message } }, status)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

async function akb(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const [log, error] = [console.log, console.error]
  const write = process.stdout.write
  console.log = (line: unknown) => void out.push(String(line))
  console.error = (line: unknown) => void err.push(String(line))
  if (argv.includes('--json')) process.stdout.write = ((chunk: string) => { out.push(chunk); return true }) as typeof write
  try {
    const code = await runAgent(argv, { program: 'akb', cwd: home })
    return { code, out: out.join('\n'), err: err.join('\n') }
  } finally {
    console.log = log
    console.error = error
    process.stdout.write = write
  }
}

describe('akb template', () => {
  it('offers to carry on without a template when signed out', async () => {
    serve({})
    const { code, err } = await akb(['template', 'list-tags', '--category', 'ui'])
    assert.equal(code, 1)
    assert.match(err, /^Not signed in to WildCrane Cloud\.[^\n]+\nYou can continue without a template\. \[signed_out\]$/)
    assert.equal(sent.length, 0)
  })

  it('searches within a tag and says plainly when nothing matches', async () => {
    signIn()
    serve({
      '': json({
        templates: [{
          name: 'hero-tilted-screen', title: '中文标题', summary: '中文摘要', description: '中文说明',
          tags: ['hero'], access: 'free', previews: [{ path: 'cover.png', size: 3 }],
        }],
      }),
    })
    const found = await akb(['template', 'search', '--category', 'ui', '--tags', 'hero', 'dark', 'saas'])
    assert.equal(found.code, 0)
    assert.equal(sent[0]?.url, '?category=ui&tags=hero&q=dark+saas')
    assert.match(found.out, /^hero-tilted-screen — 中文标题 \[free\]\n {2}中文摘要\n {2}tags: hero · previews: cover\.png\n {2}中文说明$/)

    serve({ '': json({ templates: [] }), '/tags': json({ tags: [] }), '/hero-tilted-screen/previews': json({ previews: [] }) })
    for (const language of ['en', 'zh'] as const) {
      setLanguage(language)
      const none = await akb(['template', 'search', '--category', 'ui', '--tags', 'hero', '--json'])
      assert.equal(none.code, 0)
      assert.deepEqual(JSON.parse(none.out), { ok: true, templates: [], output: 'No template matches.' })
      const empty = await akb(['template', 'list-tags', '--category', 'ui'])
      assert.deepEqual(empty, { code: 0, out: 'No templates in this category yet.', err: '' })
      const preview = await akb(['template', 'preview', 'hero-tilted-screen', '--to', home])
      assert.deepEqual(preview, { code: 0, out: 'This template has no preview.', err: '' })
    }

    const missing = await akb(['template', 'search', '--category', 'ui'])
    assert.equal(missing.code, 2)
  })

  it('reads a 404 on tags as the catalog being unavailable, not as a missing template', async () => {
    signIn()
    serve({ '/tags': refusal(404, 'not_found') })
    const tags = await akb(['template', 'list-tags', '--category', 'ui'])
    assert.equal(tags.code, 1)
    assert.match(tags.err, /^Templates are not available right now\. Try again later\./)
    assert.match(tags.err, /\nYou can continue without a template\. \[not_found\]$/)
    assert.doesNotMatch(tags.err, /no template with this name/)

    serve({ '/hero-tilted-screen': refusal(404, 'not_found') })
    const named = await akb(['template', 'get', 'hero-tilted-screen', '--to', path.join(home, 'x')])
    assert.equal(named.code, 1)
    assert.equal(named.err, 'There is no template with this name.\nYou can continue without a template. [not_found]')
  })

  it('fetches previews under the template’s name, apart from the template', async () => {
    signIn()
    serve({
      '/hero-tilted-screen/previews': json({ previews: [{ path: 'cover.png', size: 3 }] }),
      '/hero-tilted-screen/previews/cover.png': () => new Response('png'),
    })
    const to = path.join(home, 'assets')
    const { code } = await akb(['template', 'preview', 'hero-tilted-screen', '--to', to])
    assert.equal(code, 0)
    assert.deepEqual(fs.readdirSync(to), ['hero-tilted-screen-cover.png'])
  })

  it('keeps a preview already named after the template as it is', async () => {
    signIn()
    serve({
      '/hero-tilted-screen/previews': json({ previews: [{ path: 'hero-tilted-screen-cover.png', size: 3 }] }),
      '/hero-tilted-screen/previews/hero-tilted-screen-cover.png': () => new Response('png'),
    })
    const to = path.join(home, 'assets')
    const { code } = await akb(['template', 'preview', 'hero-tilted-screen', '--to', to])
    assert.equal(code, 0)
    assert.deepEqual(fs.readdirSync(to), ['hero-tilted-screen-cover.png'])
  })

  it('writes a template only when every file matches its hash, and never over a file', async () => {
    signIn()
    const files = { 'template.md': '# Hero', 'src/hero.tsx': 'export {}' }
    const manifest = json({
      template: { files: Object.entries(files).map(([p, t]) => ({ path: p, size: t.length, sha256: sha(t) })) },
    })
    serve({
      '/hero-tilted-screen': manifest,
      '/hero-tilted-screen/files/template.md': () => new Response(files['template.md']),
      '/hero-tilted-screen/files/src/hero.tsx': () => new Response('tampered'),
    })
    const to = path.join(home, 'out')
    const bad = await akb(['template', 'get', 'hero-tilted-screen', '--to', to])
    assert.equal(bad.code, 1)
    assert.match(bad.err, /nothing was written/)
    assert.equal(fs.existsSync(to), false)

    serve({
      '/hero-tilted-screen': manifest,
      '/hero-tilted-screen/files/template.md': () => new Response(files['template.md']),
      '/hero-tilted-screen/files/src/hero.tsx': () => new Response(files['src/hero.tsx']),
    })
    const good = await akb(['template', 'get', 'hero-tilted-screen', '--to', to])
    assert.equal(good.code, 0)
    assert.equal(fs.readFileSync(path.join(to, 'src', 'hero.tsx'), 'utf8'), 'export {}')

    fs.writeFileSync(path.join(to, 'template.md'), 'mine')
    fs.rmSync(path.join(to, 'src'), { recursive: true })
    const taken = await akb(['template', 'get', 'hero-tilted-screen', '--to', to])
    assert.equal(taken.code, 1)
    assert.match(taken.err, /The folder already has template\.md\. Use another folder/)
    assert.equal(fs.readFileSync(path.join(to, 'template.md'), 'utf8'), 'mine')
    assert.equal(fs.existsSync(path.join(to, 'src')), false)
  })

  it('names Pro when a Pro template is refused', async () => {
    signIn()
    serve({ '/pro-hero': refusal(403, 'pro_required', 'This needs Pro.') })
    const { code, err } = await akb(['template', 'get', 'pro-hero', '--to', path.join(home, 'x')])
    assert.equal(code, 1)
    assert.equal(err, 'This template requires Pro.\nYou can continue without a template. [pro_required]')
  })

  it('publishes the folder’s files apart from previews and evidence, leaving dotfiles home', async () => {
    signIn()
    const dir = path.join(home, 'hero')
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'template.md'), TEMPLATE_MD)
    fs.writeFileSync(path.join(dir, 'src', 'hero.tsx'), 'export {}')
    fs.writeFileSync(path.join(dir, '.DS_Store'), '')
    fs.writeFileSync(path.join(home, 'cover.png'), 'png')
    fs.writeFileSync(path.join(home, 'linear.webp'), 'shot')
    serve({ '': json({ name: 'hero-tilted-screen', replaced: false }) })
    const { code, out } = await akb([
      'template', 'publish', dir,
      '--preview', path.join(home, 'cover.png'), '--evidence', path.join(home, 'linear.webp'),
    ])
    assert.equal(code, 0, out)
    assert.equal(out, 'Published hero-tilted-screen: 2 files.')
    const form = sent[0]?.body as FormData
    const fields: string[] = []
    form.forEach((_, k) => void fields.push(k))
    assert.deepEqual(fields, ['meta', 'files:src/hero.tsx', 'files:template.md', 'previews:cover.png', 'evidence:linear.webp'])
    const meta = JSON.parse(String(form.get('meta')))
    assert.equal(meta.replace, false)
    assert.equal(meta.source.note, '维护者采集的截图。')
    assert.deepEqual(meta.tags, ['hero', 'saas'])
    assert.equal(meta.description, "Layout and motion from Linear's hero.\nEvery word is a placeholder.")
  })

  it('refuses a preview kept inside the template, and a clone with no evidence, before sending', async () => {
    signIn()
    serve({})
    const dir = path.join(home, 'hero')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'template.md'), TEMPLATE_MD)
    fs.writeFileSync(path.join(dir, 'cover.png'), 'png')
    const inside = await akb(['template', 'publish', dir, '--preview', path.join(dir, 'cover.png'), '--evidence', path.join(dir, 'cover.png')])
    assert.equal(inside.code, 1)
    assert.match(inside.err, /Move the previews and evidence outside it/)
    const bare = await akb(['template', 'publish', dir])
    assert.match(bare.err, /--evidence/)
    assert.equal(sent.length, 0)
  })

  it('says how to replace a template with a taken name', async () => {
    signIn()
    const dir = path.join(home, 'hero')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'template.md'), TEMPLATE_MD.replace(/source:[\s\S]*?---/, 'source:\n  original: true\n---'))
    serve({ '': refusal(409, 'template_exists') })
    const { code, err } = await akb(['template', 'publish', dir])
    assert.equal(code, 1)
    assert.equal(err, 'A template with this name already exists.\nPublish again with --replace to replace it. [template_exists]')
  })

  it('sends a carousel showcase with its pages in order, a live page with its video', async () => {
    signIn()
    const dir = path.join(home, 'pages')
    fs.mkdirSync(dir)
    const pages = ['01.png', { image: '02.png', video: '02.mp4' }]
    fs.writeFileSync(path.join(dir, 'showcase.json'), JSON.stringify({ cover: '01.png', pages }))
    for (const f of ['01.png', '02.png', '02.mp4']) fs.writeFileSync(path.join(dir, f), f)
    serve({ '/long-read/showcase': json({ name: 'long-read', files: 3 }) })
    const { code, out } = await akb(['template', 'showcase', 'long-read', dir])
    assert.equal(code, 0, out)
    const fields: string[] = []
    ;(sent[0]?.body as FormData).forEach((_, k) => void fields.push(k))
    assert.deepEqual(fields, ['meta', 'media:01.png', 'media:02.png', 'media:02.mp4'])

    fs.writeFileSync(path.join(dir, 'showcase.json'), '{')
    const invalid = await akb(['template', 'showcase', 'long-read', dir, '--json'])
    assert.equal(invalid.code, 1)
    assert.deepEqual(JSON.parse(invalid.out), { ok: false, error: { kind: 'cloud-refused', message: 'showcase.json is not valid JSON.' } })
    assert.equal(sent.length, 1)
  })

  it('sends a showcase with exactly the files showcase.json names', async () => {
    signIn()
    const dir = path.join(home, 'show')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'showcase.json'), JSON.stringify({
      cover: 'cover.jpg',
      original: { image: 'original.jpg', youtube: 'https://youtu.be/UAmKyyZ-b9E' },
      recreation: { image: 'cover.jpg', video: 'clone.mp4' },
    }))
    for (const f of ['cover.jpg', 'original.jpg', 'clone.mp4', 'notes.txt']) fs.writeFileSync(path.join(dir, f), f)
    serve({ '/ui-walkthrough-launch/showcase': json({ name: 'ui-walkthrough-launch', files: 3 }) })
    const { code, out } = await akb(['template', 'showcase', 'ui-walkthrough-launch', dir])
    assert.equal(code, 0, out)
    assert.equal(sent[0]?.method, 'PUT')
    const fields: string[] = []
    ;(sent[0]?.body as FormData).forEach((_, k) => void fields.push(k))
    assert.deepEqual(fields, ['meta', 'media:cover.jpg', 'media:original.jpg', 'media:clone.mp4'])
    assert.match(out, /Updated ui-walkthrough-launch's showcase: 3 files\./)
  })
})

describe('template.md frontmatter', () => {
  const fails = (text: string, words: RegExp) => assert.throws(() => readTemplateMeta(text), words)

  it('reads the fields the catalog keeps', () => {
    const meta = readTemplateMeta(TEMPLATE_MD)
    assert.equal(meta.name, 'hero-tilted-screen')
    assert.deepEqual(meta.source.references, ['https://supahero.io/hero/linear'])
    assert.equal(meta.source.captured, '2026-10-16T09:00:00+08:00')
  })

  it('refuses a brand name, a bad tag, a missing description and a capture date with no time', () => {
    fails(TEMPLATE_MD.replace('name: hero-tilted-screen', 'name: Linear Hero'), /name/)
    fails(TEMPLATE_MD.replace('[hero, saas]', '[Hero]'), /Hero/)
    fails(TEMPLATE_MD.replace(/description: \|\n.*\n.*\n/, ''), /description/)
    fails(TEMPLATE_MD.replace('2026-10-16T09:00:00+08:00', '2026-10-16'), /time zone/)
    fails(TEMPLATE_MD.replace('access: free', 'access: paid'), /access/)
    fails(TEMPLATE_MD.replace(/source:[\s\S]*?---/, 'source: [a]\n---'), /source/)
  })

  it('reads a missing access as pro and a missing source as original', () => {
    const meta = readTemplateMeta(TEMPLATE_MD.replace('access: free\n', '').replace(/source:[\s\S]*?---/, '---'))
    assert.equal(meta.access, 'pro')
    assert.deepEqual(meta.source, { original: true })
  })
})

it('refuses incomplete downloads and missing template receipts', async () => {
  signIn()
  const name = 'hero-tilted-screen'
  const to = path.join(home, 'absent')
  const entries = [{ path: 'first.png', size: 3 }, { path: 'second.png', size: 4 }]
  serve({
    [`/${name}/previews`]: json({ previews: entries }),
    [`/${name}/previews/first.png`]: () => new Response('png'),
    [`/${name}/previews/second.png`]: () => new Response('png'),
    [`/${name}/source`]: json({ source: { original: true }, evidence: entries }),
    [`/${name}/evidence/first.png`]: () => new Response('png'),
    [`/${name}/evidence/second.png`]: () => new Response('png'),
    [`/${name}/showcase`]: json({ name }),
    [`/${name}`]: json({ name, deleted: false }),
    '': json({ name }),
  })
  for (const command of ['preview', 'source']) {
    const failed = await akb(['template', command, name, '--to', to])
    assert.equal(failed.code, 1)
    assert.match(failed.err, /invalid_response/)
    assert.equal(fs.existsSync(to), false)
  }
  const dir = path.join(home, 'showcase')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'showcase.json'), '{}')
  fs.writeFileSync(path.join(dir, 'template.md'), TEMPLATE_MD.replace(/source:[\s\S]*?---/, 'source:\n  original: true\n---'))
  for (const args of [['delete', name], ['showcase', name, dir], ['publish', dir]]) {
    const failed = await akb(['template', ...args])
    assert.equal(failed.code, 1)
    assert.match(failed.err, /invalid_response/)
  }
  serve({ [`/${name}`]: json({ name, deleted: true }) })
  assert.equal((await akb(['template', 'delete', name])).code, 0)
})
