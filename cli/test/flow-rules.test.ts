import { editableOfficial, resetOfficial } from './helpers/official.ts'
// 验证规则传递、流程路由和交付期间的规则冻结。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { cmdSpec } from '../src/commands/spec.ts'
import { readRuns } from '../src/lib/agent/sessions.ts'
import { cmdStartRun } from '../src/commands/run.ts'
import { activeDelivery } from '../src/lib/agent/deliveries.ts'
import { RUN_ENV } from '../src/lib/agent/env.ts'
import { printFlow } from '../src/lib/agent/flow.ts'
import { studioRulesBlock, buildPrompt } from '../src/lib/agent/prompts.ts'
import { openPlan, planRun } from '../src/lib/agent/resolve.ts'
import { addRuntime, setAgentRuntime } from '../src/lib/agent/runtimes.ts'
import { readRule, ruleFor } from '../src/lib/agent/rules.ts'
import { setLanguage } from '../src/lib/machine/settings.ts'
import { runLanguage, LANGUAGE_ENV, translating } from '../src/lib/agent/language.ts'
import { startCollecting, stopCollecting } from '../src/lib/io.ts'
import { closeRun, openRun } from '../src/lib/agent/sessions.ts'
import { withStore } from '../src/lib/agent/store.ts'
import { RULES, setBoardRoot } from '../src/lib/paths.ts'
import { restoreMachineHome, run as akb } from './helpers/board.ts'

let root = ''

const setRule = (agent: string, text: string): void => {
  fs.mkdirSync(RULES, { recursive: true })
  fs.writeFileSync(path.join(RULES, `${agent}.md`), `${text}\n`)
}
// This machine, for the tests that read the language off it (#337). Pinned for every test
// here, so the developer's own pick can never change what a prompt says.
let home = ''

const card = (id: number, title: string): string =>
  [
    '---',
    `title: ${title}`,
    'priority: med',
    'status: ready',
    'blocked_by: []',
    'related: []',
    'modules: []',
    'studio: coding',
    'questions: []',
    '---',
    '',
    'What this card is for.',
    '',
    '<!-- agent -->',
    '',
    '## Scope',
    '- **A requirement**: build it.',
    '',
  ].join('\n')

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-rules-'))
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-rules-home-'))
  process.env.AI4KANBAN_HOME = home
  fs.mkdirSync(path.join(root, 'docs', 'kanban', 'todo', 'features'), { recursive: true })
  setBoardRoot(root)
  fs.writeFileSync(path.join(root, 'docs', 'kanban', 'todo', 'features', '1-card.md'), card(1, 'card one'))
  delete process.env[RUN_ENV]
})

afterEach(() => {
  delete process.env[RUN_ENV]
  restoreMachineHome()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

// One session, opened and closed the way the command and the watcher do.
// The user's rule for the Coding studio's cards (#2152).
const studioRule = (text: string): void => {
  fs.mkdirSync(path.join(RULES, 'studios'), { recursive: true })
  fs.writeFileSync(path.join(RULES, 'studios', 'coding.md'), `${text}\n`)
}

function run(action: 'implement' | 'clarify', id: number): string {
  const opened = openRun({ action, id, title: 'card one' }, 'prompt', [])
  if ('error' in opened) throw new Error(opened.error)
  return opened.run.sessionId
}

async function end(sessionId: string): Promise<void> {
  const record = withStore((store) => store.runs.find((r) => r.sessionId === sessionId))
  fs.writeFileSync(record!.logPath, 'log\n')
  await closeRun(sessionId, { status: 'done', ok: true, code: 0 })
}

describe('in-session spec work', () => {
  beforeEach(() => {
    const cardFile = path.join(root, 'docs/kanban/todo/features/1-card.md')
    fs.writeFileSync(cardFile, fs.readFileSync(cardFile, 'utf8').replace('questions: []', 'previews: [tech-stack-advisor]\nquestions: []'))
    const official = editableOfficial()
    const file = path.join(official, 'studios/coding/agents/ui-designer/AGENT.md')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/  stages:\n[\s\S]*?(?=  memoryFiles:)/, ''))
  })
  afterEach(() => resetOfficial())
})

describe('the files', () => {
})

describe('the prompt', () => {
  it('takes no effort on the refine command', async () => {
    fs.writeFileSync(
      path.join(root, 'docs', 'kanban', 'todo', 'features', '1-card.md'),
      card(1, 'card one').replace('status: ready', 'status: todo'),
    )
    startCollecting()
    try {
      const flow = await cmdStartRun('refine', [1], { print: true })
      assert.deepEqual(flow.guides, ['refine', 'writing', 'update-questions'])
    } finally {
      stopCollecting()
    }
    await assert.rejects(() => akb(root, ['raw', 'card', 'refine', '1', '--effort', 'standard', '--print']))
  })

  it('leaves planning memory out of a resolve: the memory review writes it (#212)', () => {
    const sink = startCollecting()
    try {
      const printed = printFlow({ action: 'resolve', id: 1 })
      assert.deepEqual(printed.guides, ['writing', 'resolve', 'update-questions'])
      assert.doesNotMatch(sink.out.join('\n'), /decisions\.md/)
    } finally {
      stopCollecting()
    }
  })

  it("reads only its own agent's rule", async () => {
    setRule('ui-designer', 'Keep to the existing palette.')
    assert.doesNotMatch(buildPrompt({ action: 'implement', id: 1 }), /existing palette/)
  })

  it('reaches every flow its agent runs, the refinement passes included', async () => {
    studioRule('Ask about the data model.')
    setRule('builder', 'Install dependencies first.')
    // One planner, so the composite refine and the standalone resolve read the same words.
    for (const req of [
      { action: 'clarify' as const, id: 1, refineRound: 2 },
      { action: 'resolve' as const, id: 1 },
      { action: 'edit' as const, id: 1, notes: 'Use A.' },
    ]) {
      const prompt = buildPrompt(req)
      assert.match(prompt, /data model/, req.action)
      assert.doesNotMatch(prompt, /Install dependencies/, req.action)
    }
  })
})

describe('a delivery', () => {

  it('does not read frozen rules under retired flow keys', async () => {
    const built = run('implement', 1)
    // What a build in flight across the upgrade holds: the flow's name, not the agent's.
    const delivery = activeDelivery(1)!
    const frozen = { implement: 'Install dependencies first.' }
    assert.equal(ruleFor({ action: 'implement', id: delivery.cardId ?? undefined }, frozen), '')
    await end(built)
  })

  it('leaves a flow that is not one of its own reading the file', async () => {
    const built = run('implement', 1)
    studioRule('Ask about the data model.')
    assert.match(buildPrompt({ action: 'clarify', id: 1, refineRound: 1 }), /data model/)
    await end(built)
  })
})

describe("the board's language", () => {
  it('打印流程与正文不再追加语言要求', () => {
    setLanguage('zh')
    assert.doesNotMatch(buildPrompt({ action: 'implement', id: 1, title: 'card one' }), /请用中文/)
    const sink = startCollecting()
    try {
      printFlow({ action: 'clarify', id: 1 })
    } finally {
      stopCollecting()
    }
    assert.doesNotMatch(sink.out.join('\n'), /请用中文回复和写作|对话和解释使用中文/)
  })

  it("Cloud 语言代码及空值优先于本机设置", () => {
    setLanguage('zh')
    try {
      process.env[LANGUAGE_ENV] = 'en'
      assert.equal(runLanguage(), 'en')
      assert.equal(translating(), false)
      process.env[LANGUAGE_ENV] = ''
      assert.equal(runLanguage(), null)
    } finally {
      delete process.env[LANGUAGE_ENV]
    }
    assert.equal(runLanguage(), 'zh')
  })

  it("中英文均通过系统提示词注入", () => {
    assert.ok(openPlan(planRun('s1')).argv.includes('--append-system-prompt'))
    setLanguage('zh')
    assert.equal(openPlan(planRun('s1')).argv[1], '--append-system-prompt')
  })
})

// Studio Notes are read from the current board, never from another Studio or workspace.
it('applies Studio Notes only to the current board and matching Studio (#859)', () => {
  const note = 'Only when preparing prompts: guide,prompt,agent都需要用英文来写'
  fs.mkdirSync(path.join(RULES, 'studios'), { recursive: true })
  fs.writeFileSync(path.join(RULES, 'studios', 'coding.md'), note)
  assert.ok(studioRulesBlock({ action: 'implement', id: 1 }).includes(note))
  assert.ok(!studioRulesBlock({ action: 'resolve', studio: 'blog-post' }).includes(note))
  const other = path.join(root, 'other')
  fs.mkdirSync(path.join(other, 'docs', 'kanban'), { recursive: true })
  setBoardRoot(other)
  assert.ok(!studioRulesBlock({ action: 'resolve', studio: 'coding' }).includes(note))
})
