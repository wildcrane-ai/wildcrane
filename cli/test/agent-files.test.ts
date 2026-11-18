// An agent's own files (#860). Everything beside its `AGENT.md` is NAMED in every run it
// does and never pasted in. A built-in agent's files ship inside the command, so
// `akb raw agent-file` prints those, its `AGENT.md` included.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { buildAsk, buildPrompt } from '../src/lib/agent/prompts.ts'
import { findSpecAgent, specAgentCatalog } from '../src/lib/agents/index.ts'
import { sharedMemory } from '../src/lib/agents/shared-memory.ts'
import { setBoardRoot } from '../src/lib/paths.ts'
import { forgetMachineState, move, refuses } from './helpers/board.ts'
import { resetOfficial, writeOfficial } from './helpers/official.ts'

let root = ''
const kanban = (): string => path.join(root, 'docs', 'kanban')

/** Write one project agent, and whatever else it keeps in its folder. */
function agent(name: string, akb: string[], files: Record<string, string> = {}): void {
  const dir = path.join(kanban(), 'agents', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'AGENT.md'),
    ['---', `name: ${name}`, `description: Use when a card needs ${name}.`, 'akb:', ...akb, '---', '', `You write the ${name} part.`, ''].join('\n'),
  )
  for (const [where, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, where)), { recursive: true })
    fs.writeFileSync(path.join(dir, where), text)
  }
}

const SAMPLE_FILES = {
  'style.md': 'Name a client after the endpoint it calls.',
  'examples/client.md': 'const client = connect()',
  '.notes.md': 'scratch',
  '.cache/old.md': 'stale',
}

let card = 0

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akb-agent-files-')))
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.mkdirSync(path.join(kanban(), 'todo'), { recursive: true })
  fs.writeFileSync(path.join(kanban(), 'next-id'), '1\n')
  fs.writeFileSync(path.join(kanban(), 'todo', 'README.md'), '# Tasks\n\n## Tasks\n')
  fs.writeFileSync(path.join(kanban(), 'config.md'), '# Configuration\n\n- **Project** — a project.\n')
  setBoardRoot(root)
  agent('sdk-sample', ['  when: A card needs it.'], SAMPLE_FILES)
  agent('api-contract', ['  when: A card needs it.'])
  card = (await move(root, ['create', '--title', 'Change an endpoint'])).id as number
})

afterEach(() => {
  resetOfficial()
  forgetMachineState(root)
  fs.rmSync(root, { recursive: true, force: true })
})

describe('what an agent offers', () => {
  it('lists its whole folder, at any depth, but its own AGENT.md and anything hidden', () => {
    assert.deepEqual(findSpecAgent('sdk-sample')!.files, ['examples/client.md', 'style.md'])
    assert.deepEqual(findSpecAgent('api-contract')!.files, [])
  })
})

describe('what a run is told', () => {
  const helperAsk = (name: string): string => buildAsk({ action: 'spec', id: card, title: 'Change an endpoint', specAgent: name })
})

describe("a studio's shared rules, files and memory (#656)", () => {
})

describe('`akb raw agent-file`', () => {

  it('refuses a project agent with only SKILL.md', async () => {
    const dir = path.join(kanban(), 'agents', 'api-contract')
    fs.renameSync(path.join(dir, 'AGENT.md'), path.join(dir, 'SKILL.md'))
    await refuses(root, ['agent-file', 'api-contract', 'AGENT.md'], /not an agent/)
  })

  it('refuses a path that climbs out of the folder, and one the agent does not offer', async () => {
    await refuses(root, ['agent-file', 'sdk-sample', '../api-contract/AGENT.md'], /has no `\.\.\/api-contract\/AGENT\.md`/)
    await refuses(root, ['agent-file', 'api-contract', 'style.md'], /Its files are: AGENT\.md\./)
    await refuses(root, ['agent-file', 'nobody', 'style.md'], /is not an agent on this board/)
  })
})

describe('an agent that still declares `akb.dependencies`', () => {
  it('loads as usual, even naming an agent this board does not have', () => {
    agent('release-page', ['  when: A card needs it.', '  dependencies:', '    - agent: api-contract', '    - agent: nobody'])
    assert.ok(findSpecAgent('release-page'))
    assert.deepEqual(specAgentCatalog().problems, [])
  })
})
