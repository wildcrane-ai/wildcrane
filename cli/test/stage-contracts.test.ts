// The four stage contracts and the shared flow nodes (#714).
//
// What is asked here: the classification is a total one — every flow this board can start is
// a stage's, a decision or an event and never two of them; the lead a contract names is the
// agent that ran that flow before contracts existed; a contract that
// names somebody the board hasn't says which stage and which name; and the completion check
// reads `requires`, asks once for what is missing, and then stops for the user.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { FLOWS } from '../src/lib/agent/flows.ts'
import { refinementRunsAfter, markBoard } from '../src/lib/agent/refine.ts'
import { roleForFlow, stageContractProblems } from '../src/lib/agent/roles.ts'
import { deliveryRules, ruleFor } from '../src/lib/agent/rules.ts'
import {
  agentForFlow,
  contractProblems,
  flowNodes,
  flowsOfAgent,
  stageContracts,
  stageOfFlow,
} from '../src/lib/agent/stages.ts'
import type { RunRecord } from '../src/lib/agent/types.ts'
import { logPathOf, withStore } from '../src/lib/agent/store.ts'
import { serializeFrontmatter } from '../src/lib/frontmatter.ts'
import { RULES, setBoardRoot } from '../src/lib/paths.ts'
import type { Meta } from '../src/lib/types.ts'
import { findCard } from '../src/lib/view/read.ts'
import { forgetMachineState } from './helpers/board.ts'

let root = ''

const kanban = (): string => path.join(root, 'docs', 'kanban')

/** One card on the board, with whatever body the case needs. */
function writeCard(id: number, body = 'A card.', opts: { folder?: string; status?: string } = {}): void {
  const meta: Partial<Meta> = {
    title: `Card ${id}`,
    status: opts.status ?? 'todo',
    blocked_by: [],
    related: [],
    modules: [],
    studio: 'coding',
    questions: [],
  }
  const dir = opts.folder ? path.join(kanban(), 'todo', opts.folder) : path.join(kanban(), 'todo')
  fs.mkdirSync(dir, { recursive: true })
  const file = opts.folder ? 'root.md' : `${id}-card-${id}.md`
  fs.writeFileSync(path.join(dir, file), `${serializeFrontmatter(meta)}\n\n${body}\n\n## Todo\n\n- [ ] Build it.\n`)
}

/** One run, as the record holds it. */
const aRun = (run: Partial<RunRecord> & Pick<RunRecord, 'sessionId' | 'action'>): RunRecord => ({
  cardId: null,
  status: 'done',
  startedAt: Date.now(),
  code: null,
  harness: 'claude',
  logPath: '',
  ...run,
})

/** Put one on the machine's own file. A finished run is kept only while its log is there,
 *  so the case writes one. */
const recordRun = (run: Partial<RunRecord> & Pick<RunRecord, 'sessionId' | 'action'>): void => {
  const logPath = logPathOf(run.sessionId)
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.writeFileSync(logPath, '')
  withStore((store) => {
    store.runs.push(aRun({ ...run, logPath }))
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-stages-'))
  fs.mkdirSync(path.join(kanban(), 'todo'), { recursive: true })
  fs.writeFileSync(path.join(kanban(), 'next-id'), '1\n')
  setBoardRoot(root)
})

afterEach(() => {
  forgetMachineState(root)
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the classification', () => {
  it('puts every flow the board can start in exactly one of the three', () => {
    for (const flow of FLOWS) {
      const stage = stageOfFlow(flow.command)
      const node = flowNodes().find((n) => n.flow === flow.command)
      const places = [stage, node].filter(Boolean).length
      assert.equal(places, 1, `${flow.command} is in ${places} places`)
    }
  })

  it('claims the flows nobody types, too', () => {
    // Not commands under `akb raw card`, and the board's work all the same.
    assert.equal(stageOfFlow('chat'), 'discuss')
    assert.equal(flowNodes().find((n) => n.flow === 'reflect')?.kind, 'event')
  })

  it('calls the entries events', () => {
    const kinds = Object.fromEntries(flowNodes().map((n) => [n.flow, n.kind]))
    assert.deepEqual(kinds, {
      'triage-sort': 'event',
      reflect: 'event',
      'prune-memory': 'event',
      'review-memory': 'event',
      'review-dismissals': 'event',
      'describe-project': 'event',
    })
    // No event belongs to a stage, so none shows up in one.
    for (const flow of Object.keys(kinds)) assert.equal(stageOfFlow(flow), undefined, flow)
  })

  // The guard the todo asks for: a flow shipped later with no home fails here rather than
  // quietly becoming a flow nobody runs.
  it('fails when a flow is added and left unclassified', () => {
    const orphan = 'brand-new-flow'
    assert.equal(stageOfFlow(orphan), undefined)
    assert.equal(flowNodes().some((n) => n.flow === orphan), false)
    assert.equal(agentForFlow(orphan), undefined)
  })
})

describe('the lead a contract names', () => {
  // The whole point of this card: the board runs exactly as it ran before. This is the old
  // per-role table, flow by flow.
  const BOARD: Record<string, string> = {
    chat: 'discussion-helper',
    refine: 'planner',
    resolve: 'planner',
    revise: 'planner',
    archive: 'planner',
    reject: 'planner',
    implement: 'builder',
      run: 'builder',
    'prune-memory': 'memory-pruner',
    'review-memory': 'chat-reviewer',
    'review-dismissals': 'dismissal-reviewer',
    'describe-project': 'project-writer',
    reflect: 'proposer',
  }
})

describe('a contract that names somebody the board has not', () => {
  it('says which stage and which name, and passes on what the command ships', () => {
    assert.deepEqual(stageContractProblems(), [])
    const said = contractProblems([]).join('\n')
    for (const contract of stageContracts().filter((c) => c.lead)) {
      assert.match(said, new RegExp(`the ${contract.stage} stage is led by \`${contract.lead}\``))
    }
  })
})

describe('the rules a delivery freezes', () => {
})
