import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import { FakeCloud, writeFakeSession } from './fake-cloud'

it('registers native tools and preserves user skills and permissions (#676)', async () => {
  const root = path.resolve(process.env.RUNNER_DIST!, '../..')
  const home = process.env.WILDCRANE_HOME!
  writeFakeSession(home)
  const cloud = new FakeCloud()
  await cloud.start()
  process.env.AI4KANBAN_CLOUD_URL = `http://127.0.0.1:${cloud.port}`
  process.env.WILDCRANE_RUNNER_DIR = path.join(root, 'runner')
  const { default: plugin } = await import(pathToFileURL(path.join(root, 'plugins/opencode/dist/index.mjs')).href)
  let dispose: (() => Promise<void>) | undefined
  const permissions: string[] = []
  try {
    const tools = new Map<string, any>()
    const skills = new Map<string, any>([['wildcrane-tasks', { content: 'user skill' }]])
    dispose = await plugin.setup({
      tool: { transform: async (f: any) => f({ get: (id: string) => tools.get(id), add: (x: any) => tools.set(x.name, x) }) },
      skill: { transform: async (f: any) => f({ get: (id: string) => skills.get(id), add: (x: any) => skills.set(x.id, x) }) },
      session: { get: async () => ({ location: { directory: os.homedir() } }) },
      permission: { assert: async ({ action }: { action: string }) => { permissions.push(action) } },
    })
    assert.equal(tools.size, 6)
    assert.equal(skills.size, 3)
    assert.equal(skills.get('wildcrane-tasks').content, 'user skill')
    const native = tools.get('wildcrane_draft_read')
    const ctx = { sessionID: 'ses-native', signal: new AbortController().signal }
    const b = JSON.parse((await native.execute({}, ctx)).content)
    assert.equal(JSON.parse((await native.execute({}, ctx)).content).discussion, b.discussion)
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(native.execute({}, { ...ctx, signal: abort.signal }), /abort/i)
    assert.ok(permissions.includes('wildcrane_draft_read'))
    await assert.rejects(native.execute({}, { ...ctx, sessionID: '' }), /identity/)
    await dispose?.()
    dispose = undefined
    await assert.rejects(native.execute({}, ctx), /unloaded/)
    const source = fs.readFileSync(path.join(root, 'plugins/opencode/skills/tasks/SKILL.md'), 'utf8')
    assert.equal(source, fs.readFileSync(path.join(root, 'plugins/shared/skills/tasks/variants/grok/SKILL.md'), 'utf8'))
  } finally {
    await dispose?.()
    await cloud.stop()
  }
})

it('updates immediately from config, replaces pins, and preserves JSONC (#699)', async () => {
  const { manage } = await import(pathToFileURL(path.resolve(process.env.RUNNER_DIST!, '../../plugins/opencode/dist/manage.mjs')).href)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-'))
  const file = path.join(directory, 'opencode.jsonc')
  const original = '// Keep comment\n{ "instructions": ["guide.md"], "permissions": {"edit":"deny"}, "plugins": ["other-plugin", {"package":"wildcrane-opencode", "options":{"keep":true}}] }\n'
  const options = { directory, execute: () => 'opencode v2.2.7', registry: (...args: string[]) => {
    if (args[0] === 'view') return '0.1.22'
    const stage = args[args.indexOf('--prefix') + 1]
    const version = args.at(-1)!.split('@')[1]
    const pkg = path.join(stage, 'node_modules/wildcrane-opencode')
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'wildcrane-opencode', version }))
    fs.writeFileSync(path.join(pkg, 'dist/index.mjs'), 'export default {}')
    return ''
  } }
  try {
    fs.writeFileSync(file, original)
    assert.match(manage('update', undefined, options), /installed/)
    assert.match(manage('update', undefined, options), /up to date/)
    assert.match(manage('install', '0.1.21', options), /pinned/)
    const pinned = fs.readFileSync(file, 'utf8')
    assert.match(pinned, /pinned\/0.1.21/)
    assert.match(pinned, /"keep":true/)
    assert.match(manage('update', undefined, { ...options, registry: () => { throw new Error('must not download') } }), /pinned/)
    assert.equal(fs.readFileSync(file, 'utf8'), pinned)
    manage('install', undefined, options)
    const beforeFailure = fs.readFileSync(file, 'utf8')
    assert.throws(() => manage('install', '9.9.9', { ...options, registry: () => { throw new Error('npm download failed') } }), /npm download failed/)
    assert.equal(fs.readFileSync(file, 'utf8'), beforeFailure)
    manage('remove', undefined, options)
    const result = fs.readFileSync(file, 'utf8')
    assert.match(result, /Keep comment/)
    const config = JSON.parse(result.replace('// Keep comment\n', ''))
    assert.deepEqual(config, { instructions: ['guide.md'], permissions: { edit: 'deny' }, plugins: ['other-plugin'] })
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
