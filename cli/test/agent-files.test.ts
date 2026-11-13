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

  it('names every file, as a path and nothing more, on a helper run', () => {
    const ask = helperAsk('sdk-sample')
    assert.match(ask, /——— your own files ———/)
    assert.match(ask, /docs\/kanban\/agents\/sdk-sample\/style\.md/)
    assert.match(ask, /docs\/kanban\/agents\/sdk-sample\/examples\/client\.md/)
    assert.doesNotMatch(ask, /Name a client after the endpoint|const client = connect/)
    assert.doesNotMatch(ask, /\.notes\.md|\.cache/)
  })

  it('names them on a leading run too', async () => {
    agent('clip-editor', [], { 'style.md': 'Cut on the beat.' })
    writeOfficial('studios/clips/STUDIO.md', '---\nname: Clips\nland: [clip-editor]\n---\n')
    const id = (await move(root, ['create', '--title', 'A clip', '--studio', 'clips'])).id as number
    const prompt = buildPrompt({ action: 'implement', id })
    assert.match(prompt, /——— your own files ———[\s\S]*docs\/kanban\/agents\/clip-editor\/style\.md/)
    assert.doesNotMatch(prompt, /Cut on the beat/)
  })
})

describe("a studio's shared rules, files and memory (#656)", () => {
  it('hands them to every agent of the studio, and reads its files by studio path', async () => {
    const id = (await move(root, ['create', '--title', 'A deck', '--studio', 'slide-deck'])).id as number
    fs.mkdirSync(path.join(kanban(), 'memory', 'studios', 'slide-deck'), { recursive: true })
    fs.writeFileSync(path.join(kanban(), 'memory', 'studios', 'slide-deck', 'feedback.md'), '- Dark covers.\n')
    const ask = buildAsk({ action: 'spec', id, specAgent: 'deck-builder' })
    assert.match(ask, /——— your studio's rules ———[\s\S]*## Pages/)
    assert.match(ask, /raw file slide-deck shared\/scripts\/validate-storyboard\.mjs/)
    assert.match(ask, /——— what your studio remembers ———[\s\S]*Dark covers/)
    assert.match(String((await move(root, ['file', 'slide-deck', 'shared/RULES.md'])).text), /## Pages/)
    assert.ok(sharedMemory(kanban())('studios/slide-deck/feedback.md'))
    assert.ok(!sharedMemory(kanban())('studios/slide-deck/notes.md'))
  })
})

describe('`akb raw agent-file`', () => {
  it("prints a built-in agent's file, which has no path to open", async () => {
    writeOfficial('agents/ui-designer/spacing.md', 'Eight pixels, or a multiple of it.')
    assert.deepEqual(findSpecAgent('ui-designer')!.files, ['references/copywriting.md', 'references/illustration.md', 'references/rendered-screen.md', 'references/ui-draft.md', 'spacing.md'])
    const said = await move(root, ['file', 'coding', 'agents/ui-designer/spacing.md'])
    assert.equal(said.text, 'Eight pixels, or a multiple of it.')
    assert.match(buildAsk({ action: 'spec', id: card, specAgent: 'ui-designer' }), /raw file coding agents\/ui-designer\/spacing\.md/)
    assert.equal((await move(root, ['agent-file', 'ui-designer', 'spacing.md'])).text, said.text)
  })

  it('ships the email planner with its render script, and refuses a board copy of the same name', async () => {
    assert.deepEqual(findSpecAgent('email-planner')!.files, ['scripts/render.mjs'])
    const said = await move(root, ['file', 'coding', 'agents/email-planner/scripts/render.mjs'])
    assert.match(String(said.text), /plainText: true/)
    assert.match(buildAsk({ action: 'spec', id: card, specAgent: 'email-planner' }), /raw file coding agents\/email-planner\/scripts\/render\.mjs/)
    agent('email-planner', ['  when: A card needs it.'])
    assert.match(specAgentCatalog().problems.join('\n'), /an agent named `email-planner` is already on this board/)
    assert.equal(findSpecAgent('email-planner')!.dir, undefined)
  })

  it("prints an agent's own AGENT.md, built-in or project, whole (#1308)", async () => {
    const own = await move(root, ['agent-file', 'api-contract', 'AGENT.md'])
    assert.match(String(own.text), /^---\nname: api-contract\n[\s\S]*You write the api-contract part\./)
    const builtIn = await move(root, ['agent-file', 'prompt-writer', 'AGENT.md'])
    assert.equal(builtIn.text, fs.readFileSync(path.join(process.env.AI4KANBAN_STUDIOS!, 'agents', 'prompt-writer', 'AGENT.md'), 'utf8'))
    assert.ok(!findSpecAgent('prompt-writer')!.files.includes('AGENT.md'))
  })

  it('prints a project agent still on the old SKILL.md name', async () => {
    const dir = path.join(kanban(), 'agents', 'api-contract')
    fs.renameSync(path.join(dir, 'AGENT.md'), path.join(dir, 'SKILL.md'))
    const said = await move(root, ['agent-file', 'api-contract', 'AGENT.md'])
    assert.match(String(said.text), /You write the api-contract part\./)
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
