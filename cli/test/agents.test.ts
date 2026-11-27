// The spec agents (#403, #419): read from `AGENT.md` rather than written in TypeScript,
// added by a project as well as shipped, and handed to a run one reference at a time.
//
// What is asked here is the whole of the promise: the built-in agents still say what they
// always said; a project's own agent joins the same catalog, from the old folder as well as
// the new one; an agent nobody can read is reported by name instead of vanishing; the
// catalog a planning session sees carries no instructions; and a spec run is handed its
// agent and only the reference its board setting picked.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { buildPrompt } from '../src/lib/agent/prompts.ts'
import { setBoardRoot } from '../src/lib/paths.ts'
import {
  agentLines,
  findSpecAgent,
  roleSettings,
  specAgentCatalog,
} from '../src/lib/agents/index.ts'
import { runAgent } from '../src/lib/agent-cli.ts'
import { readRuns } from '../src/lib/agent/sessions.ts'
import { parseSpecAgent } from '../src/lib/agents/parse.ts'
import { parseYamlBlock } from '../src/lib/agents/yaml.ts'
import { studioById } from '../src/lib/agent/studios.ts'
import { findGuide } from '../src/lib/guide.ts'
import { roleNamed } from '../src/lib/agent/roles.ts'
import { writeConfig } from '../src/lib/agent/settings.ts'
import { move, refuses, run, uiConfigOf } from './helpers/board.ts'
import { editableOfficial, resetOfficial, switchAgent } from './helpers/official.ts'

let root = ''

const kanban = (): string => path.join(root, 'docs', 'kanban')

const board = (cfg: Record<string, unknown> = {}): void => {
  fs.mkdirSync(path.join(kanban(), 'todo'), { recursive: true })
  fs.writeFileSync(uiConfigOf(kanban()), JSON.stringify(cfg, null, 2))
  setBoardRoot(root)
}

/** Write one project agent: `AGENT.md` plus whatever else it carries, in `agents/` or —
 *  `folder` says which — the `skills/` folder agents used to live in. */
const project = (name: string, files: Record<string, string>, folder = 'agents'): void => {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(kanban(), folder, name, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
}

const AGENT = [
  '---',
  'name: api-contract',
  'description: Use when a card changes an endpoint other software calls.',
  'akb:',
  '  when: A card needs it.',
  '---',
  '',
  'You settle the wire contract a card changes.',
  '',
].join('\n')

/** One card on the board, the shape a spec agent writes into. */
const card = (id: number): string => {
  const file = path.join(kanban(), 'todo', 'skill', `${id}-a-card.md`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    [
      '---',
      'title: A card',
      'priority: med',
      'status: ready',
      'blocked_by: []',
      'related: []',
      'modules: [skill]',
      'studio: coding',
      'questions: []',
      '---',
      '',
      'A card.',
      '',
    ].join('\n'),
  )
  return file
}

/** One file in an agent's memory folder, as it stands on disk. */
const remembered = (name: string, file = 'redesign.md'): string =>
  fs.readFileSync(path.join(kanban(), 'memory', 'agents', name, file), 'utf8')

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-spec-agents-'))
  board()
})

afterEach(() => {
  resetOfficial()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('akb.icon (#455)', () => {
  const read = (icon: string) => parseSpecAgent(`---\nname: x\ndescription: y\nakb:\n${icon}\n---\nbody`, 'x', () => null)
  it('reads a glyph name or drawn parts, and refuses anything off the palette', () => {
    const drawn = read('  icon:\n    - d: M5 3.5h14v17H5z\n      f: y\n      o: true\n    - d: M8 9h8\n      s: g\n      w: 2')
    assert.deepEqual('agent' in drawn && drawn.agent.icon, [{ d: 'M5 3.5h14v17H5z', f: 'y', o: true }, { d: 'M8 9h8', s: 'g', w: 2 }])
    const named = read('  icon: text')
    assert.equal('agent' in named && named.agent.icon, 'text')
    for (const bad of ['  icon: robot', '  icon:\n    - d: M5 3z\n      f: blue', '  icon:\n    - d: M5 3z\n      w: 5']) {
      assert.match((read(bad) as { problem: string }).problem, /akb\.icon.*file, text/)
    }
  })
})

describe("what an agent says to a reader who doesn't read English", () => {
  it('takes each line from `akb.i18n`, falls back per line, and never changes what a run is given', () => {
    project('api-contract', {
      'AGENT.md': [
        '---',
        'name: api-contract',
        'description: Use when a card changes an endpoint other software calls.',
        'akb:',
        '  when: A card needs it.',
        // A file written before `owns` was dropped still reads; the field is ignored.
        '  i18n:',
        '    zh:',
        '      title: 接口契约',
        '      when: 卡片需要时。',
        '      owns: 卡片改动的请求与响应结构',
        '---',
        '',
        'You settle the wire contract a card changes.',
        '',
      ].join('\n'),
    })
    const agent = findSpecAgent('api-contract')!
    assert.ok(agent)

    assert.equal('owns' in agent, false)
    assert.deepEqual(agent.i18n.zh, { title: '接口契约', when: '卡片需要时。' })

    // Only the title was translated, so the description stays the English the file declares
    // rather than going blank.
    const zh = agentLines(agent, 'zh')
    assert.deepEqual(zh, { title: '接口契约', description: agent.description })
    // A name it never said stays empty rather than falling back: the screen drawing it
    // spells the agent's own name out, which is the answer in English too.
    assert.deepEqual(agentLines(agent, 'en'), { title: '', description: agent.description })

    // A title only in English is drawn in every language rather than the screen spelling the
    // name out.
    project('wf-2-executor', {
      'AGENT.md': ['---', 'name: wf-2-executor', 'description: Unwritten.', 'akb:',
        '  i18n:', '    en:', '      title: "视频克隆2 executor"', '---', '', 'Unwritten.', ''].join('\n'),
    })
    assert.equal(agentLines(findSpecAgent('wf-2-executor')!, 'zh').title, '视频克隆2 executor')

    // The block is drawn, never run: what a spec run is handed is the English description and
    // the instructions under the frontmatter.
    assert.equal(agent.body.includes('i18n'), false)
  })

})

describe('the agents this command ships', () => {

  it('does not resolve retired names', () => {
    for (const name of ['recommend-tech-stack', 'technology-selection', 'ui-design', 'video-assets', 'memory-reviewer', 'user-docs']) assert.equal(findSpecAgent(name), null)
  })

})

describe('an agent the project adds', () => {

  it('joins the same catalog', () => {
    project('api-contract', { 'AGENT.md': AGENT })
    const { agents, problems } = specAgentCatalog()
    assert.deepEqual(problems, [])
    assert.ok(agents.some((a) => a.name === 'api-contract'))
  })

  // An `akb.settings:` block is read by nothing (#1003). A board that still carries one keeps
  // its agent rather than losing it over a dead key.
  it('keeps its agent when its file still declares settings, and offers none of them', () => {
    project('api-contract', {
      'AGENT.md': AGENT.replace(
        '  when: A card needs it.\n',
        [
          '  when: A card needs it.',
          '  settings:',
          '    - key: style',
          '      label: Contract style',
          '      default: openapi',
          '      choices:',
          '        - value: openapi',
          '          label: OpenAPI',
          '          cost: a schema fragment per endpoint',
          '          reference: references/openapi.md',
          '',
        ].join('\n'),
      ),
      'references/openapi.md': 'Write an OpenAPI fragment.',
    })
    assert.deepEqual(specAgentCatalog().problems, [])
    const agent = findSpecAgent('api-contract')!
    // The file it named is an ordinary file beside `AGENT.md` now, offered by its path.
    assert.ok(agent.files.includes('references/openapi.md'))
  })
})

// The folder and the filename agents had before #419. Both are read for one release, so a
// board upgrades without its specialists going quiet — and every hit says to move it.
// `write` joined the retired marketing board's writer (#718). A file still declaring it is
// listed as a problem rather than registered as something nothing on the board can call.
describe('the hook an agent declares', () => {
  it('lists a leftover `write` agent as a problem rather than registering it', () => {
    project('api-contract', { 'AGENT.md': AGENT.replace('  when: A card needs it.', '  kind: write') })
    const { agents, problems } = specAgentCatalog()
    assert.ok(!agents.some((a) => a.name === 'api-contract'))
    assert.match(problems.join('\n'), /declares `akb.kind`, which the board no longer reads/)
  })
})

describe('an agent nobody can read', () => {
  const problemFor = (files: Record<string, string>): string => {
    project('broken', files)
    return specAgentCatalog().problems.join('\n')
  }

  it('reports a file with no frontmatter', () => {
    assert.match(problemFor({ 'AGENT.md': 'Just instructions.' }), /no `---` frontmatter/)
  })

  it('reports a missing description', () => {
    assert.match(
      problemFor({ 'AGENT.md': ['---', 'name: broken', 'akb:', '  when: A card needs it.', '---', '', 'Body.'].join('\n') }),
      /has no `description`/,
    )
  })

  // Its studio says its role (#2152): a file still saying it is refused, naming the keys.
  describe('the role it used to declare', () => {
    const read = (...akb: string[]) =>
      parseSpecAgent(['---', 'name: x', 'description: d', ...(akb.length ? ['akb:', ...akb.map((l) => `  ${l}`)] : []), '---', '', 'Body.'].join('\n'), 'x', () => null)

    it('refuses each old key, naming it and where the role went', () => {
      for (const keys of [['lead: plan'], ['hook: plan', 'when: w'], ['stage: plan', 'kind: spec'], ['hook: schedule']]) {
        const got = read(...keys)
        assert.ok('problem' in got, keys.join(' + '))
        for (const key of keys.filter((k) => !k.startsWith('when'))) assert.ok(got.problem.includes(`\`akb.${key.split(':')[0]}\``), key)
        assert.match(got.problem, /Define task Previews in STUDIO\.md/)
      }
    })

    it('reads an agent with no `akb:` at all, and `when`, `after` and `session` on any', () => {
      const bare = read()
      assert.ok('agent' in bare)
      assert.deepEqual([bare.agent.when, bare.agent.after, bare.agent.session], [undefined, [], undefined])
      const got = read('when: w', 'after: ui-designer', 'session: new')
      assert.ok('agent' in got)
      assert.deepEqual([got.agent.when, got.agent.after, got.agent.session], ['w', ['ui-designer'], 'new'])
      const bad = read('session: resume')
      assert.ok('problem' in bad)
      assert.match(bad.problem, /`akb.session: resume` — use `new` to recommend a separate session/)
    })
  })

  it('reports a folder whose AGENT.md calls itself something else', () => {
    assert.match(problemFor({ 'AGENT.md': AGENT }), /make the two match/)
  })
})

describe('what a session is shown', () => {
})

// A preview's trigger and order are their own keys (#2151).
describe('`akb.after`', () => {
  const preview = (name: string, extra: string[] = []): string =>
    ['---', `name: ${name}`, `description: ${name} works.`, 'akb:', `  when: ${name} applies.`, ...extra, '---', '', 'Body.', ''].join('\n')
  const problems = (): string[] => specAgentCatalog().problems
})

describe("the YAML an agent's frontmatter is written in", () => {
  it('reads nested maps, lists of maps and quoted scalars', () => {
    assert.deepEqual(
      parseYamlBlock(
        [
          'name: x',
          'help: "What one is: a screen, or text."',
          'akb:',
          '  kind: spec',
          '  settings:',
          '    - key: style',
          '      choices:',
          '        - value: a',
          '          label: A',
          '        - value: b',
          '          label: B',
        ].join('\n'),
      ),
      {
        name: 'x',
        help: 'What one is: a screen, or text.',
        akb: {
          kind: 'spec',
          settings: [
            {
              key: 'style',
              choices: [
                { value: 'a', label: 'A' },
                { value: 'b', label: 'B' },
              ],
            },
          ],
        },
      },
    )
  })

  it('drops a trailing comment as YAML does, and keeps a `#` that is not one', () => {
    assert.deepEqual(
      parseYamlBlock(
        [
          'name: x  # the folder name',
          'empty: # nothing yet',
          'hash: a#b',
          'lang: C#',
          'double: "a # b"',
          "single: 'a # b'  # quoted",
          'escaped: "say \\"#\\"" # tail',
          'list:',
          '  - one # first',
          '  - "two # kept"',
          '  - key: v\t# tab',
          '    other: "w # kept"',
        ].join('\n'),
      ),
      {
        name: 'x',
        empty: '',
        hash: 'a#b',
        lang: 'C#',
        double: 'a # b',
        single: 'a # b',
        escaped: 'say "#"',
        list: ['one', 'two # kept', { key: 'v', other: 'w # kept' }],
      },
    )
  })

  it('accepts a fixed value with a comment after it', () => {
    project('outliner', {
      'AGENT.md': [
        '---',
        'name: outliner  # me',
        'description: d',
        'akb:',
        '  when: always  # its trigger',
        '---',
        '',
        'Body.',
      ].join('\n'),
    })
    assert.deepEqual(specAgentCatalog().problems, [])
    assert.equal(specAgentCatalog().agents.find((a) => a.name === 'outliner')?.when, 'always')
  })
})

// An agent's memory (#421, #473, #833): a folder the board hands to every run, holding
// whatever files the agent's own prompt says to keep.
describe("an agent's memory folder", () => {
  const wrote = (agent: string, file: string, text: string): void => {
    fs.mkdirSync(path.join(kanban(), 'memory', 'agents', agent), { recursive: true })
    fs.writeFileSync(path.join(kanban(), 'memory', 'agents', agent, file), text)
  }

  it('still reads an AGENT.md that declares `akb.memory`, whatever its value', () => {
    project('api-contract', { 'AGENT.md': AGENT.replace('  when: A card needs it.\n', '  when: A card needs it.\n  memory: user\n') })
    assert.deepEqual(specAgentCatalog().problems, [])
    assert.ok(findSpecAgent('api-contract'))
  })

  for (const [value, says] of [
    ['    workspace: style.md\n', /not a list of paths/],
    ['    workspace: [../planner/decisions.md]\n', /outside its memory folder/],
    ['    workspace: [/etc/style.md]\n', /outside its memory folder/],
    ['    project: [writing.md]\n', /holds only `workspace/],
  ] as const) {
    it(`reports \`memoryFiles\` written as ${value.trim()}`, () => {
      project('api-contract', { 'AGENT.md': AGENT.replace('  when: A card needs it.\n', `  when: A card needs it.\n  memoryFiles:\n${value}`) })
      const [problem] = specAgentCatalog().problems
      assert.match(problem ?? '', says)
      assert.match(problem ?? '', /api-contract/)
    })
  }

})

describe('legacy agent settings', () => {
  it('loads an `AGENT.md` that still declares `akb.output`, and ignores it', () => {
    project('api-contract', { 'AGENT.md': AGENT.replace('  when: A card needs it.', '  when: A card needs it.\n  output: nobody') })
    assert.deepEqual(specAgentCatalog().problems, [])
    assert.ok(findSpecAgent('api-contract'))
  })

  // A role's own settings (#1469): saved under its entry by key, and the picked choice's words
  // reach every run it does, before the user's rule.
  it("reads a role's own settings by key, and tells its runs the pick", () => {
    const pick = (value: string) => writeConfig((cfg) => void (cfg.specAgents = { proposer: { 'small-fixes': value } }))
    const role = roleNamed('proposer')!
    const values = () => roleSettings(role).values
    assert.deepEqual(role.settings!.map((s) => s.key), ['small-fixes'])
    assert.deepEqual(role.settings![0]!.choices.map((c) => c.value), ['auto', 'propose', 'skip'])
    assert.equal(values()['small-fixes'], 'propose')
    const reflect = () => buildPrompt({ action: 'reflect', id: 7, title: 'card 7' })
    assert.doesNotMatch(reflect(), /Your settings on this board/)

    pick('auto')
    assert.equal(values()['small-fixes'], 'auto')
    assert.match(reflect(), /Your settings on this board:\n- A small fix .*--status planned/)
    assert.doesNotMatch(buildPrompt({ action: 'implement', id: 7 }), /Your settings on this board/)

    pick('skip')
    assert.match(reflect(), /Do not propose small fixes/)
  })
})

// A module's planning memory sits under the planner's folder (#1484), and `init` scaffolds
// none of them — the map cannot reach the agents' own files at all.
describe('`agents` as a module name', () => {
  it('gets no memory folder from `init`, whatever the map says', async () => {
    fs.writeFileSync(path.join(kanban(), 'modules.md'), '- **agents** — a module someone named\n- **skill** — the command\n')
    fs.mkdirSync(path.join(kanban(), 'memory', 'agents', 'ui-designer'), { recursive: true })
    fs.writeFileSync(
      path.join(kanban(), 'memory', 'agents', 'ui-designer', 'redesign.md'),
      '# What `ui-designer` was corrected on\n\n- One.\n',
    )
    await move(root, ['init'])
    assert.equal(fs.existsSync(path.join(kanban(), 'memory', 'agents', 'decisions.md')), false)
    assert.equal(remembered('ui-designer'), '# What `ui-designer` was corrected on\n\n- One.\n')
    assert.equal(fs.existsSync(path.join(kanban(), 'memory', 'skill')), false)
    // The planning memory is the planner's, and the board keeps only its own record.
    assert.ok(fs.existsSync(path.join(kanban(), 'memory', 'agents', 'planner', 'decisions.md')))
    assert.ok(fs.existsSync(path.join(kanban(), 'memory', 'readme.md')))
    assert.equal(fs.existsSync(path.join(kanban(), 'memory', 'decisions.md')), false)
  })
})

describe('preview command queries (#397)', () => {
  const query = async (args: string[], json = true): Promise<{ code: number; output: string; data: any }> => {
    let output = ''
    const write = process.stdout.write
    const log = console.log
    process.stdout.write = ((chunk: string) => { output += chunk; return true }) as typeof write
    console.log = (line: unknown) => { output += String(line) + '\n' }
    try {
      const code = await runAgent([...args, ...(json ? ['--json'] : [])], { cwd: root })
      return { code, output, data: json ? JSON.parse(output) : null }
    } finally {
      process.stdout.write = write
      console.log = log
    }
  }
})
