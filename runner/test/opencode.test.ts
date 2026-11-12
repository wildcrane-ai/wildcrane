import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import { FakeCloud, writeFakeSession } from './fake-cloud'

it('loads both native adapters, preserves config and permissions, and disposes connections (#676)', async () => {
  const root = path.resolve(process.env.RUNNER_DIST!, '../..')
  const home = process.env.WILDCRANE_HOME!
  writeFakeSession(home)
  const cloud = new FakeCloud()
  await cloud.start()
  process.env.AI4KANBAN_CLOUD_URL = `http://127.0.0.1:${cloud.port}`
  process.env.WILDCRANE_RUNNER_DIR = path.join(root, 'runner')
  const { default: plugin } = await import(pathToFileURL(path.join(root, 'plugins/opencode/dist/index.mjs')).href)
  const v1 = await plugin.server()
  let disposeV2: (() => Promise<void>) | undefined
  const permissions: string[] = []
  try {
    const config = { skills: { paths: ['/existing'], urls: ['https://example.com/skills'] }, permission: { edit: 'deny' } }
    v1.config(config)
    v1.config(config)
    const paths = [...config.skills.paths]
    v1.config(config)
    assert.deepEqual(config.skills.paths, paths)
    assert.ok(config.skills.paths.includes('/existing'))
    assert.deepEqual(config.permission, { edit: 'deny' })
    assert.deepEqual(config.skills.urls, ['https://example.com/skills'])
    const read = v1.tool.wildcrane_draft_read
    const context = { sessionID: 'ses-v1', directory: os.homedir(), abort: new AbortController().signal,
      ask: async ({ permission }: { permission: string }) => { permissions.push(permission) } }
    const a = JSON.parse(await read.execute({}, context))
    assert.equal(JSON.parse(await read.execute({}, context)).discussion, a.discussion)
    await assert.rejects(read.execute({}, { ...context, sessionID: '' }), /identity/)
    await assert.rejects(read.execute({}, { ...context, ask: async () => { throw new Error('denied') } }), /denied/)
    const tools = new Map<string, any>()
    const skills = new Map<string, any>([['wildcrane-tasks', { content: 'user skill' }]])
    disposeV2 = await plugin.setup({
      tool: { transform: async (f: any) => f({ get: (id: string) => tools.get(id), add: (x: any) => tools.set(x.name, x) }) },
      skill: { transform: async (f: any) => f({ get: (id: string) => skills.get(id), add: (x: any) => skills.set(x.id, x) }) },
      session: { get: async () => ({ location: { directory: os.homedir() } }) },
      permission: { assert: async ({ action }: { action: string }) => { permissions.push(action) } },
    })
    assert.equal(tools.size, 6)
    assert.equal(skills.size, 3)
    assert.equal(skills.get('wildcrane-tasks').content, 'user skill')
    const native = tools.get('wildcrane_draft_read')
    const ctx = { sessionID: 'ses-v2', signal: new AbortController().signal }
    const b = JSON.parse((await native.execute({}, ctx)).content)
    assert.notEqual(b.discussion, a.discussion)
    assert.equal(JSON.parse((await native.execute({}, ctx)).content).discussion, b.discussion)
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(native.execute({}, { ...ctx, signal: abort.signal }), /abort/i)
    assert.ok(permissions.includes('wildcrane_draft_read'))
    const source = fs.readFileSync(path.join(root, 'plugins/opencode/skills/tasks/SKILL.md'), 'utf8')
    assert.equal(source, fs.readFileSync(path.join(root, 'plugins/shared/skills/tasks/variants/grok/SKILL.md'), 'utf8'))
    await v1.dispose()
    await assert.rejects(read.execute({}, context), /unloaded/)
  } finally {
    await v1.dispose()
    await disposeV2?.()
    await cloud.stop()
  }
})
