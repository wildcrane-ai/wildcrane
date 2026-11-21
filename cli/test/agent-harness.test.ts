// Which runtime each agent runs, and what one runtime carries (#467).
//
// What is asked here is the whole of the promise: a board that picks nothing runs **Global
// default**; a flow, a pass a flow spawns, and a spec agent each come up on their own agent's
// row; two rows on one harness sit on two gateways and two keys; a resume stays on the CLI it
// started on; and a board written the old way is turned into rows once, running exactly what
// it ran.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { agentInfo, agentRun, openPlan, planResume, planRun } from '../src/lib/agent/resolve.ts'
import { agentForRun } from '../src/lib/agent/runner.ts'
import {
  addRuntime,
  EXECUTION_RUNTIMES_ENV,
  readAgentRuntime,
  readRuntimes,
  secretVar,
  setAgentRuntime,
} from '../src/lib/agent/runtimes.ts'
import { readEnvFile } from '../src/lib/agent/settings.ts'
import { specAgentEntries } from '../src/lib/agent/settings.ts'
import { setBoardRoot } from '../src/lib/paths.ts'
import { uiConfigOf } from './helpers/board.ts'

let root = ''

const kanban = (): string => path.join(root, 'docs', 'kanban')

const config = (cfg: Record<string, unknown>): void => {
  fs.mkdirSync(kanban(), { recursive: true })
  fs.writeFileSync(uiConfigOf(kanban()), JSON.stringify(cfg, null, 2))
  setBoardRoot(root)
}

const local = (cfg: Record<string, unknown>): void => {
  fs.mkdirSync(kanban(), { recursive: true })
  fs.writeFileSync(path.join(kanban(), '.local.json'), JSON.stringify(cfg, null, 2))
}

const env = (text: string): void => {
  fs.mkdirSync(kanban(), { recursive: true })
  fs.writeFileSync(path.join(kanban(), '.env'), text)
}

const held = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(uiConfigOf(kanban()), 'utf8'))

const heldLocal = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(kanban(), '.local.json'), 'utf8'))

const runtime = (id: string, harness: string, settings: Record<string, string> = {}) => ({
  id,
  name: id === 'global' ? 'Global default' : id,
  harness,
  settings,
})

// What one flow spawns: the row it ran on, and the argv, so a setting that reached the run
// from the wrong row would show up here rather than pass.
const plan = (ask: Parameters<typeof agentForRun>[0]) => planRun('s1', root, agentForRun(ask))

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-agent-harness-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('a board where no agent picked a runtime', () => {
  it('plans and opens from the execution runtime instead of the saved board settings', () => {
    config({ runtimes: [runtime('global', 'antigravity', { model: 'board-model' })] })
    const credentialsFile = path.join(root, 'credentials.json')
    fs.writeFileSync(credentialsFile, JSON.stringify({ task: { apiKey: 'sk-task' } }))
    const scope = { default: {
      ...runtime('global', 'codex', { model: 'task-model', provider: 'openai-api' }),
      credentialId: 'task',
    }, picks: {}, credentialsFile }
    process.env[EXECUTION_RUNTIMES_ENV] = JSON.stringify(scope)
    try {
      const started = plan({ action: 'implement' })
      assert.equal(started.harness, 'codex')
      assert.ok(started.argv.includes('task-model'))
      assert.equal(openPlan(started).env.OPENAI_API_KEY, 'sk-task')
      assert.ok(!JSON.stringify(started).includes('sk-task'))
      assert.deepEqual(held(), { runtimes: [runtime('global', 'antigravity', { model: 'board-model' })] })
    } finally {
      delete process.env[EXECUTION_RUNTIMES_ENV]
    }
  })

  it('runs every flow on Global default', () => {
    config({ runtimes: [runtime('global', 'codex', { model: 'gpt-5.1-codex' })] })
    for (const action of ['implement', 'clarify', 'prune-memory'] as const) {
      const run = plan({ action })
      assert.equal(run.harness, 'codex')
      assert.equal(run.runtime, 'global')
      assert.equal(run.note, null)
      assert.ok(run.argv.includes('gpt-5.1-codex'))
    }
  })

  it('has Global default even when the file says nothing at all', () => {
    config({})
    assert.deepEqual(
      readRuntimes().map((r) => [r.id, r.name]),
      [['global', 'Global default']],
    )
    assert.deepEqual(readAgentRuntime(), {})
    assert.equal(agentRun('builder').own, false)
    assert.equal(agentRun('builder').runtime, 'global')
  })
})

describe('an agent with a runtime of its own', () => {
  const board = {
    runtimes: [
      runtime('global', 'claude-code', { model: 'claude-opus-5' }),
      runtime('cheap', 'codex', { model: 'gpt-5.1-codex' }),
    ],
    agentRuntime: { builder: 'cheap', 'ui-designer': 'cheap' },
    specAgents: { 'ui-designer': { mockupStyle: 'ascii' } },
  }

  beforeEach(() => config(board))

  it('leaves every other agent on Global default', () => {
    const run = plan({ action: 'clarify', refineRound: 1 })
    assert.equal(run.agent, 'planner')
    assert.equal(run.runtime, 'global')
    assert.equal(run.harness, 'claude-code')
  })

  it('runs the passes a refine spawns as the planner, like refine itself', () => {
    for (const action of ['clarify', 'resolve', 'edit'] as const) {
      assert.equal(agentForRun({ action, refineRound: 1 }), 'planner')
    }
    assert.ok(plan({ action: 'clarify', refineRound: 1 }).argv.includes('claude-opus-5'))
  })

  it('keeps the spec agent’s runtime out of its entry, and its switch a switch', () => {
    // A key the board no longer reads is carried, not acted on (#1003).
    assert.deepEqual(specAgentEntries()['ui-designer'], { enabled: true, extra: { mockupStyle: 'ascii' } })
    assert.equal(agentRun('ui-designer').harness, 'codex')
  })

  it('says which agent runs each flow, for a front end that keeps no list', () => {
    const info = agentInfo()
    const flow = (command: string) => info.flows.find((f) => f.command === command)
    // The build is its studio's first land agent, so no board-wide agent runs it.
    assert.equal(flow('implement')?.agent, '')
    assert.deepEqual([flow('refine')?.agent, flow('refine')?.harness], ['planner', 'claude-code'])
    assert.equal(flow('review'), undefined)
  })
})

describe('two runtimes on one harness', () => {
  beforeEach(() => {
    config({
      runtimes: [
        runtime('global', 'claude-code', { provider: 'endpoint', baseUrl: 'https://one.example', model: 'a' }),
        runtime('gateway', 'claude-code', { provider: 'endpoint', baseUrl: 'https://two.example', model: 'b' }),
      ],
      agentRuntime: { builder: 'gateway' },
    })
    env(`${secretVar('ANTHROPIC_API_KEY', 'global')}=sk-one\n${secretVar('ANTHROPIC_API_KEY', 'gateway')}=sk-two\n`)
  })

  it('each says on its own row which of its keys this computer holds', () => {
    assert.deepEqual(
      agentInfo().runtimes.map((r) => [r.id, r.secretsSet]),
      [
        ['global', ['apiKey']],
        ['gateway', ['apiKey']],
      ],
    )
  })
})

describe('writing the list', () => {
  beforeEach(() => config({ runtimes: [runtime('global', 'claude-code')] }))

  it('adds a row on an id generated to what .env parses', () => {
    const added = addRuntime('My gateway!', 'codex')
    assert.equal(added.id, 'my_gateway')
    assert.equal(secretVar('OPENAI_API_KEY', added.id!), 'OPENAI_API_KEY__MY_GATEWAY')
  })

  it('refuses a second row on the same name', () => {
    addRuntime('Cheap', 'codex')
    assert.match(addRuntime('cheap', 'codex').error ?? '', /already has a runtime/)
  })


  it('drops a pick back to Global default without writing one down', () => {
    const { id } = addRuntime('Cheap', 'codex')
    assert.equal(setAgentRuntime('builder', id!).ok, true)
    assert.deepEqual(held().agentRuntime, { builder: id })
    assert.equal(setAgentRuntime('builder', '').ok, true)
    assert.equal(held().agentRuntime, undefined)
    assert.equal(agentRun('builder').runtime, 'global')
  })

  // A picker lists Global default as a row, so it hands its id back rather than an empty
  // string. Both spellings have to drop the pick, or the row an agent already runs would be
  // written down as a pick of its own and counted against Global default.
  it('drops a pick handed Global default’s own id', () => {
    const { id } = addRuntime('Cheap', 'codex')
    setAgentRuntime('builder', id!)
    assert.equal(setAgentRuntime('builder', 'global').ok, true)
    assert.equal(held().agentRuntime, undefined)
    assert.equal(agentRun('builder').runtime, 'global')
    assert.equal(agentInfo().runtimes.find((r) => r.id === 'global')?.agents, 0)
  })

  // `video-assets` became `hyperframes-assets` (#945), then `hyperframes-editor` (#1057); a pick
  // still under the old name is read, so every write clears it, or it wins again the moment the
  // new one is gone.

})

describe('the raw arguments', () => {
  it('go after the settings’ flags and before the CLI’s own', () => {
    config({ runtimes: [runtime('global', 'claude-code', { model: 'claude-opus-5', args: '--foo --bar=1' })] })
    const { argv } = plan({ action: 'implement', studio: 'coding' })
    const model = argv.indexOf('claude-opus-5')
    const foo = argv.indexOf('--foo')
    const session = argv.indexOf('--session-id')
    assert.ok(model >= 0 && foo > model, `expected --foo after the model flag: ${argv.join(' ')}`)
    assert.deepEqual(argv.slice(foo, foo + 2), ['--foo', '--bar=1'])
    assert.ok(session > foo, `expected the CLI's own arguments last: ${argv.join(' ')}`)
  })
})

describe('a resume', () => {
  it('stays on the CLI the run itself went on', () => {
    config({
      runtimes: [runtime('global', 'claude-code'), runtime('cheap', 'codex')],
      agentRuntime: { builder: 'cheap' },
    })
    // The builder runs Codex now; this run went on Claude Code, and picking it up spawns
    // Claude Code — the conversation belongs to the CLI that opened it.
    const picked = planResume({ harness: 'claude-code', resumeId: 'abc', cwd: root }, 'builder')
    assert.equal(picked?.harness, 'claude-code')
    assert.equal(picked?.runtime, 'global')
    assert.ok(picked?.argv.includes('--resume'))
  })

  it('is refused for a CLI this version doesn’t run', () => {
    config({ runtimes: [runtime('global', 'claude-code')] })
    assert.equal(planResume({ harness: 'some-tool-from-the-future', resumeId: 'abc', cwd: root }, 'builder'), null)
  })

  it('resolves the row the run pinned, inside that CLI', () => {
    config({
      runtimes: [
        runtime('global', 'claude-code', { model: 'a' }),
        runtime('strong', 'claude-code', { model: 'b' }),
      ],
    })
    const picked = planResume({ harness: 'claude-code', resumeId: 'abc', cwd: root }, 'planner', { pin: 'strong' })
    assert.equal(picked?.runtime, 'strong')
    assert.ok(picked?.argv.includes('b'))
  })


})

// The one-time move `akb update` makes (#467): how to reach a CLI was one block per harness and
// the model under it was this computer's, and both become rows.
describe('planning', () => {
  const board = {
    runtimes: [
      runtime('global', 'claude-code', { model: 'claude-opus-5' }),
      runtime('cheap', 'codex', { model: 'gpt-5.1-codex' }),
      runtime('strong', 'claude-code', { model: 'claude-fable-5' }),
    ],
    agentRuntime: {
      'discussion-helper': 'strong',
      builder: 'cheap',
      'ui-designer': 'cheap',
    },
  }

  beforeEach(() => config(board))

  it('runs the discussion’s runtime', () => {
    for (const action of ['clarify', 'resolve'] as const) {
      const run = plan({ action, id: 1 })
      assert.equal(run.agent, 'planner')
      assert.equal(run.runtime, 'strong')
      assert.ok(run.argv.includes('claude-fable-5'))
    }
    assert.equal(agentRun('planner').follows, 'discussion-helper')
    assert.equal(setAgentRuntime('discussion-helper', '').ok, true)
    assert.equal(agentRun('planner').runtime, 'global')
  })

  it('leaves the builder, the previews and the discussion on their own picks', () => {
    for (const name of ['builder', 'ui-designer']) {
      assert.equal(agentRun(name).runtime, 'cheap')
      assert.equal(agentRun(name).follows, undefined)
    }
    assert.equal(agentRun('discussion-helper').follows, undefined)
    assert.equal(agentRun('proposer').runtime, 'global')
  })
})
