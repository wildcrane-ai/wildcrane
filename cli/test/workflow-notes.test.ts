// `akb workflow rule` / `instructions` (#585) write through Cloud's own endpoints, the way the web does.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'

import { writeSession } from '../src/lib/cloud/session.ts'
import { restoreMachineHome, run } from './helpers/board.ts'

const SUPABASE = 'https://project.supabase.co'
const API = 'https://api.example.test'
const realFetch = globalThis.fetch

let root = ''
let puts: { route: string; rule: unknown }[] = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-notes-'))
  const board = path.join(root, '.akb', 'kanban')
  fs.mkdirSync(path.join(board, 'todo'), { recursive: true })
  fs.writeFileSync(path.join(board, 'config.md'), '# Config\n')
  fs.writeFileSync(path.join(root, '.akb', 'base.json'), JSON.stringify({ project: 'prj_1', files: {} }))
  process.env.AI4KANBAN_HOME = path.join(root, 'home')
  process.env.AI4KANBAN_SUPABASE_URL = SUPABASE
  process.env.AI4KANBAN_CLOUD_URL = API
  writeSession({
    version: 1, supabaseUrl: SUPABASE, accessToken: 't', refreshToken: 'r',
    expiresAt: Date.now() + 3600_000, subject: '11111111-1111-4111-8111-111111111111',
  })
  puts = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const route = String(url).slice(API.length)
    if (init?.method === 'PUT') {
      puts.push({ route, rule: JSON.parse(String(init.body)).rule })
      return Response.json({})
    }
    if (route === '/v1/projects/prj_1') return Response.json({ id: 'prj_1', workspace: 'ws_1' })
    if (route === '/v1/projects/prj_1/agents') return Response.json({ board: ['proposer', 'memory-pruner'] })
    if (route === '/v1/workspaces/ws_1/workflow-rules') {
      return Response.json({ workflows: [{ id: 'wf_builtin_coding' }, { id: 'wf_01own' }], data: [{ agent: 'ui-designer' }, { agent: 'builder' }] })
    }
    return Response.json({ error: { code: 'not_found', message: 'Not found.' } }, { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  fs.rmSync(root, { recursive: true, force: true })
  restoreMachineHome()
  delete process.env.AI4KANBAN_SUPABASE_URL
  delete process.env.AI4KANBAN_CLOUD_URL
})

it('saves a workflow rule from a file and clears it with empty text', async () => {
  const file = path.join(root, 'rule.md')
  fs.writeFileSync(file, 'Titles in English.\nThe rest in Chinese.\n')
  await run(root, ['workflow', 'rule', 'coding', '--file', file])
  await run(root, ['workflow', 'rule', 'coding', '--text', ''])
  assert.deepEqual(puts, [
    { route: '/v1/workspaces/ws_1/workflows/wf_builtin_coding/rule', rule: 'Titles in English.\nThe rest in Chinese.' },
    { route: '/v1/workspaces/ws_1/workflows/wf_builtin_coding/rule', rule: '' },
  ])
})

it("saves a workflow agent's instructions on the workspace and a board agent's on the project", async () => {
  await run(root, ['workflow', 'instructions', 'builder', '--text', 'Install first.'])
  await run(root, ['workflow', 'instructions', 'proposer', '--text', 'Propose less.'])
  assert.deepEqual(puts, [
    { route: '/v1/workspaces/ws_1/agents/builder', rule: 'Install first.' },
    { route: '/v1/projects/prj_1/agents/proposer', rule: 'Propose less.' },
  ])
})

it('refuses an unknown name with the valid choices', async () => {
  await assert.rejects(() => run(root, ['workflow', 'rule', 'blog', '--text', 'x']), /There are: coding, wf-01own\./)
  await assert.rejects(() => run(root, ['workflow', 'instructions', 'deployer', '--text', 'x']), /There are: ui-designer, builder, proposer, memory-pruner\./)
  await assert.rejects(() => run(root, ['workflow', 'rule', 'coding']), /--text or --file/)
  assert.deepEqual(puts, [])
})
