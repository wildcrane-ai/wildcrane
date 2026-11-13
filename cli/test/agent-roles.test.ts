// Flow ownership, role name collisions and lossless rule migration.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { FLOWS } from '../src/lib/agent/flows.ts'
import { buildRun } from '../src/lib/agent/prompts.ts'
import { agentNames, agentRoster, roleNamed } from '../src/lib/agent/roles.ts'
import { agentForFlow } from '../src/lib/agent/stages.ts'
import { migrateFlowRules, readRule } from '../src/lib/agent/rules.ts'
import { specAgentProblems } from '../src/lib/agents/index.ts'
import { RULES, setBoardRoot, UI_CONFIG } from '../src/lib/paths.ts'

let root = ''

const kanban = (): string => path.join(root, 'docs', 'kanban')

/** A rule file as a board written before #420 had it: named by the flow. */
const rule = (name: string, text: string): void => {
  fs.mkdirSync(RULES, { recursive: true })
  fs.writeFileSync(path.join(RULES, `${name}.md`), `${text}\n`)
}

const ruleText = (name: string): string => fs.readFileSync(path.join(RULES, `${name}.md`), 'utf8').trim()

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-roles-'))
  fs.mkdirSync(path.join(kanban(), 'todo'), { recursive: true })
  fs.writeFileSync(path.join(kanban(), 'next-id'), '1\n')
  setBoardRoot(root)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the roles', () => {
  it('gives every flow the board can start exactly one agent', () => {
    for (const flow of FLOWS) {
      const owners = agentRoster().filter((agent) => agent.name === agentForFlow(flow.command, 'coding'))
      const hidden = roleNamed(agentForFlow(flow.command, 'coding') ?? '') && !owners.length ? 1 : 0
      assert.equal(owners.length + hidden, 1, `${flow.command} is run by ${owners.length} agents`)
    }
  })

  it("refuses a project agent that takes a role's name, so no two share a rule", () => {
    const home = path.join(kanban(), 'agents', 'proposer')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(
      path.join(home, 'AGENT.md'),
      ['---', 'name: proposer', 'description: Use when.', 'akb:', '  when: A card needs it.', '---', '', 'You propose.']
        .join('\n')
        .concat('\n'),
    )
    assert.equal(agentNames().filter((name) => name === 'proposer').length, 1)
    assert.match(specAgentProblems().join('\n'), /`proposer` is one of the roles the board ships/)
  })
})

// The proposer and the chat reviewer used to have switches (#534, #748).
describe('the board helpers are always on (#1208)', () => {
  const on = (name: string): boolean => agentRoster().some((a) => a.name === name)

  it('reads a key an earlier release wrote to switch one off as on', () => {
    fs.mkdirSync(path.dirname(UI_CONFIG), { recursive: true })
    fs.writeFileSync(UI_CONFIG, JSON.stringify({ proposer: false, autoTriage: false, memoryReviewer: false }))
    for (const name of ['proposer', 'chat-reviewer', 'discussion-helper', 'builder']) {
      assert.equal(on(name), true, name)
    }
  })
})

describe("the one-time move onto the agents", () => {
  it('folds a per-flow rule file into its agent, in flow order, and deletes it', () => {
    rule('implement', 'Install dependencies first.')
    rule('conflict', 'Keep the target branch.')

    const notes = migrateFlowRules()
    assert.equal(ruleText('builder'), 'Install dependencies first.\n\nKeep the target branch.')
    for (const gone of ['implement', 'conflict']) {
      assert.equal(fs.existsSync(path.join(RULES, `${gone}.md`)), false, gone)
    }
    // Said out loud: what the user wrote for one flow now reaches two more.
    assert.equal(notes.length, 1)
    assert.match(notes.join('\n'), /implement\.md, conflict\.md/)
    assert.match(notes.join('\n'), /builder\.md/)
  })

  it('runs once — the second read finds nothing to move and says nothing', () => {
    rule('implement', 'Install dependencies first.')
    assert.equal(readRule('builder'), 'Install dependencies first.')
    assert.deepEqual(migrateFlowRules(), [])
    assert.deepEqual(buildRun({ action: 'clarify', id: 1 }).notes, [])
  })

  it("keeps a rule the agent already had in front of the flows'", () => {
    rule('builder', 'The board rule.')
    rule('run', 'The recurring rule.')
    migrateFlowRules()
    assert.equal(ruleText('builder'), 'The board rule.\n\nThe recurring rule.')
  })

  it('reports the move in the run log the first time a run is built', () => {
    rule('implement', 'Run the smoke tests.')
    const { notes, prompt } = buildRun({ action: 'implement', id: 1, title: 'card one', studio: 'coding' })
    assert.match(notes.join('\n'), /a rule is one per agent now/)
    assert.match(prompt, /smoke tests/)
  })

  // The agent was renamed, and a rule is saved under the agent's name.
  it('moves a spec agent’s rule off the name it had before, once', () => {
    fs.mkdirSync(RULES, { recursive: true })
    fs.writeFileSync(path.join(RULES, 'ui-design.md'), 'Keep to the existing palette.\n')
    assert.equal(readRule('ui-designer'), 'Keep to the existing palette.')
    assert.equal(ruleText('ui-designer'), 'Keep to the existing palette.')
    assert.equal(fs.existsSync(path.join(RULES, 'ui-design.md')), false)
  })
})

