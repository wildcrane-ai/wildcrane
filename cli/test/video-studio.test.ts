// Studio preview routing and board-state path regressions.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { useBoard, resolveBoard } from '../src/lib/board-cli.ts'
import { findSpecAgent } from '../src/lib/agents/index.ts'
import { printFlow } from '../src/lib/agent/flow.ts'
import { buildAsk, buildPrompt } from '../src/lib/agent/prompts.ts'
import { refinementRequest } from '../src/lib/agent/refine.ts'
import { agentForRun } from '../src/lib/agent/runner.ts'
import { startCollecting, stopCollecting } from '../src/lib/io.ts'
import { boardText, setBoardRoot } from '../src/lib/paths.ts'
import type { AgentRequest } from '../src/lib/agent/types.ts'
import { move } from './helpers/board.ts'

let root = ''
const kanban = (): string => path.join(root, 'docs', 'kanban')

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akb-video-')))
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.mkdirSync(path.join(kanban(), 'todo'), { recursive: true })
  fs.writeFileSync(path.join(kanban(), 'next-id'), '1\n')
  fs.writeFileSync(path.join(kanban(), 'todo', 'README.md'), '# Tasks\n\n## Tasks\n')
  fs.writeFileSync(path.join(kanban(), 'config.md'), '# Configuration\n\n- **Project** — a project.\n')
  setBoardRoot(root)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

// What `akb raw card <action> --print` prints; a refine prints the pass it would start.
const printed = (action: 'refine' | 'implement', id: number): string => {
  const req: AgentRequest | { error: string } = action === 'refine' ? refinementRequest({ action: 'refine', id }) : { action, id }
  if ('error' in req) throw new Error(req.error)
  const sink = startCollecting()
  try {
    printFlow(req)
    return sink.out.join('\n')
  } finally {
    stopCollecting()
  }
}

const videoCard = async (): Promise<number> =>
  (await move(root, ['create', '--title', 'Show the board', '--studio', 'hyperframes-video'])).id as number

describe('the hyperframes-video studio', () => {
  it('is planned by the board’s planner, which asks the scriptwriter for the script', async () => {
    const id = await videoCard()
    assert.equal(agentForRun({ action: 'clarify', id, refineRound: 1 }), 'planner')
    const first = printed('refine', id)
    assert.match(first, /<preview-agents>[\s\S]*akb raw previews --triggers --studio hyperframes-video/)
    await move(root, ['update', String(id), '--previews', 'scriptwriter,hyperframes-editor'])
    const refine = printed('refine', id)
    assert.doesNotMatch(refine, /`hyperframes-editor`/)
    assert.match(refine, /stage\s+1 of 2/)
  })

  it('takes its previews when the card is created', async () => {
    const id = (await move(root, ['create', '--title', 'Show the board', '--studio', 'hyperframes-video', '--previews', 'scriptwriter,hyperframes-editor'])).id as number
    const refine = printed('refine', id)
    assert.doesNotMatch(refine, /`hyperframes-editor`/)
    assert.match(refine, /stage\s+1 of 2/)
    await assert.rejects(move(root, ['create', '--title', 'X', '--studio', 'hyperframes-video', '--previews', 'ui-designer']), /not a preview/)
  })

  it('keeps its agents off a coding card', async () => {
    const coding = (await move(root, ['create', '--title', 'Fix the header'])).id as number
    for (const action of ['refine', 'implement'] as const) assert.doesNotMatch(printed(action, coding), /scriptwriter|hyperframes-editor/)
    assert.doesNotMatch(buildPrompt({ action: 'implement', id: coding }), /hyperframes-editor/)
  })
})

describe('the <board-state> path constant', () => {
  it('spells the asset folder in the video editor’s prompt', async () => {
    const id = await videoCard()
    const editor = buildAsk({ action: 'spec', id, specAgent: 'hyperframes-editor' })
    assert.match(editor, /`\.akb\/boards\/docs\/kanban\/assets\/<card id>\/`/)
    assert.doesNotMatch(editor, /<board-state>/)
  })

  it("keeps the rendering contract in board-state assets", () => {
    const body = findSpecAgent('ui-designer')!.file('references/rendered-screen.md')!
    assert.match(body, /<board-state>\/assets/)
    const before = body.split('<board-state>/assets').join('docs/kanban/.assets')
    assert.equal(boardText(body), boardText(before))
    assert.match(boardText(body), /`\.akb\/boards\/docs\/kanban\/assets\/<card id>\/`/)
  })

  it("names another board's own state folder", () => {
    const marketing = path.join(root, 'marketing', 'kanban')
    fs.mkdirSync(path.join(marketing, 'todo'), { recursive: true })
    fs.writeFileSync(path.join(marketing, 'config.md'), '# Configuration\n')
    useBoard(resolveBoard('list', { board: marketing, dir: null, cwd: root, installHint: '' }), false)
    assert.equal(
      boardText('<board-state>/assets and docs/kanban/memory and docs/kanban/.assets'),
      '.akb/boards/marketing/kanban/assets and marketing/kanban/memory and .akb/boards/marketing/kanban/assets',
    )
  })
})
