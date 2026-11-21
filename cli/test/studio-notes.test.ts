// `akb studio rule` / `instructions` (#585) write through Cloud's own endpoints, the way the web does.

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
      const rule = puts.at(-1)!.rule
      return Response.json(route.endsWith('/rule') ? { id: route.split('/').at(-2), rule } : { agent: route.split('/').at(-1), rule })
    }
    if (route === '/v1/projects/prj_1') return Response.json({ id: 'prj_1', workspace: 'ws_1' })
    if (route === '/v1/projects/prj_1/agents') return Response.json({ board: ['proposer', 'memory-pruner'], data: [{ agent: 'proposer', rule: 'Propose less.' }, { agent: 'memory-pruner', rule: '' }] })
    if (route === '/v1/workspaces/ws_1/studio-rules') {
      return Response.json({ studios: [{ id: 'wf_builtin_coding', rule: '- Titles in English.\n- Tests first.' }, { id: 'wf_01own' }] })
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

it('saves a studio rule from a file and clears it with empty text', async () => {
  const file = path.join(root, 'rule.md')
  fs.writeFileSync(file, 'Titles in English.\nThe rest in Chinese.\n')
  await run(root, ['studio', 'rule', 'coding', '--file', file])
  await run(root, ['studio', 'rule', 'coding', '--text', ''])
  assert.deepEqual(puts, [
    { route: '/v1/workspaces/ws_1/studios/wf_builtin_coding/rule', rule: 'Titles in English.\nThe rest in Chinese.' },
    { route: '/v1/workspaces/ws_1/studios/wf_builtin_coding/rule', rule: '' },
  ])
})

it('writes and clears only project background-task instructions', async () => {
  await run(root, ['studio', 'instructions', 'proposer', '--text', 'Propose less.'])
  await run(root, ['studio', 'instructions', 'proposer', '--text', ''])
  assert.deepEqual(puts, [
    { route: '/v1/projects/prj_1/agents/proposer', rule: 'Propose less.' },
    { route: '/v1/projects/prj_1/agents/proposer', rule: '' },
  ])
})

it('refuses an unknown name with the valid choices', async () => {
  await assert.rejects(() => run(root, ['studio', 'rule', 'blog', '--text', 'x']), /There are: coding, wf-01own\./)
  await assert.rejects(() => run(root, ['studio', 'instructions', 'deployer', '--text', 'x']), /There are: proposer, memory-pruner\./)
  for (const name of ['builder', 'ui-designer', 'coding']) {
    await assert.rejects(() => run(root, ['studio', 'instructions', name, '--text', 'x']), /There are: proposer, memory-pruner\./)
  }
  assert.deepEqual(puts, [])
})

// #592: a bare call reads the current text, so a new rule can keep the old ones.
it('prints the current rules without writing when no text is given', async () => {
  const out: string[] = []
  const write = process.stdout.write
  process.stdout.write = ((chunk: string) => (out.push(String(chunk)), true)) as typeof process.stdout.write
  try {
    await run(root, ['studio', 'rule', 'coding'])
    await run(root, ['studio', 'instructions', 'proposer'])
  } finally {
    process.stdout.write = write
  }
  assert.match(out.join(''), /- Titles in English\.\n- Tests first\.[\s\S]*Propose less\./)
  assert.deepEqual(puts, [])
})

it('reports verification failure, preserves the prior Studio list and rejects missing save receipts', async (t) => {
  const dev = process.env.AI4KANBAN_STUDIOS
  delete process.env.AI4KANBAN_STUDIOS
  t.after(() => { if (dev !== undefined) process.env.AI4KANBAN_STUDIOS = dev })
  const fetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const route = new URL(String(url)).pathname
    if (route === '/v1/studios') return Response.json({ data: [], next: null })
    return fetch(url, init)
  }
  await run(root, ['studio', 'list'])
  globalThis.fetch = async (url, init) => {
    const route = new URL(String(url)).pathname
    if (route === '/v1/studios') return Response.json({ error: { code: 'forbidden', message: 'Studio access was revoked.' } }, { status: 403 })
    if (init?.method === 'PUT') return Response.json({})
    return fetch(url, init)
  }
  await assert.rejects(() => run(root, ['studio', 'list']), /Showing cached Studios.*Studio access was revoked/)
  await assert.rejects(() => run(root, ['studio', 'rule', 'coding', '--text', 'New rule']), /saved Studio rules/)
  await assert.rejects(() => run(root, ['studio', 'instructions', 'proposer', '--text', 'New rule']), /saved instructions/)
})
