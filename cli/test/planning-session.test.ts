import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { savePin, STUDIO_SNAPSHOT_ENV } from '../src/lib/agent/cloud-studios.ts'
import { harnessLabel } from '../src/lib/agent/resolve.ts'
import { closeRun, openResume, openRun, patch, peekRun, readSpec, resumeSessionId } from '../src/lib/agent/sessions.ts'
import { startRun } from '../src/lib/agent/start.ts'
import { readRuns } from '../src/lib/agent/store.ts'
import type { AgentRequest, RunRecord } from '../src/lib/agent/types.ts'
import { watchRun } from '../src/lib/agent/watch.ts'
import type { TaskReview } from '../src/lib/shared/review-plan.ts'
import { setBoardDir, setBoardRoot } from '../src/lib/paths.ts'
import { forgetMachineState, move, uiConfigOf } from './helpers/board.ts'

let root = ''

// A stand-in CLI: it finishes cleanly, or — told to — answers a resume the way Claude Code
// answers one for a session it no longer holds.
function board(harness = 'claude-code', lost = false): void {
  const file = path.join(root, 'agent.mjs')
  fs.writeFileSync(
    file,
    `const args = process.argv.slice(2)
if (${lost} && args.includes('--resume')) {
  console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: x'] }))
  process.exit(1)
}
console.log(JSON.stringify({ type: 'result', result: 'Done' }))
`,
  )
  fs.writeFileSync(
    uiConfigOf(root, 'docs', 'kanban'),
    JSON.stringify({ runtimes: [{ id: 'global', name: 'Global default', harness, settings: { command: `node ${file}` } }] }),
  )
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-planning-session-'))
  forgetMachineState(root)
  setBoardRoot(root)
  fs.mkdirSync(path.join(root, 'docs', 'kanban', 'todo'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs', 'kanban', 'next-id'), '1\n')
  fs.writeFileSync(path.join(root, 'docs', 'kanban', 'todo', 'README.md'), '# Tasks\n')
  board()
  await move(root, ['create', '--title', 'Card one'])
  await move(root, ['create', '--title', 'Card two'])
})

afterEach(() => {
  forgetMachineState(root)
  fs.rmSync(root, { recursive: true, force: true })
})

async function end(sessionId: string): Promise<void> {
  // A finished record with no log is pruned out of the store.
  fs.writeFileSync(peekRun(sessionId)!.logPath, 'log\n')
  await closeRun(sessionId, { status: 'done', ok: true, code: 0 })
}

/** A finished planning run on card 1. */
async function planned1(): Promise<string> {
  const opened = openRun({ action: 'clarify', id: 1 }, 'prompt', [])
  if ('error' in opened) throw new Error(opened.error)
  await end(opened.run.sessionId)
  return opened.run.sessionId
}

async function start(req: AgentRequest): Promise<RunRecord> {
  const started = await startRun(req)
  if ('error' in started) throw new Error(started.error)
  return started.run
}

/** The lines the run's log opens with, as `[board] <note>`. */
const notes = (run: RunRecord): string[] => readSpec(run.sessionId)!.notes ?? []

const after = (argv: string[] | undefined, flag: string): string | undefined => argv?.[(argv?.indexOf(flag) ?? -1) + 1]

describe('the planning after a revise (#1661)', () => {
  it('resumes the planning session, and the next step carries on from the revise', async () => {
    const planned = await start({ action: 'clarify', id: 1 })
    await end(planned.sessionId)
    const revise = await start({ action: 'edit', id: 1, notes: 'x' })
    assert.deepEqual(revise.continues, { resumeId: planned.sessionId })
    assert.match(readSpec(revise.sessionId)!.prompt, /Revise task 1.*planned this card before/)
    await end(revise.sessionId)
    const answered = await start({ action: 'resolve', id: 1 })
    assert.equal(after(answered.argv, '--resume'), planned.sessionId)
  })
})

describe('the planning after an answer', () => {
  it('resumes the session that asked, round after round', async () => {
    const planned = await start({ action: 'clarify', id: 1 })
    await end(planned.sessionId)
    const first = await start({ action: 'resolve', id: 1, title: 'Card one' })
    assert.equal(after(first.argv, '--resume'), planned.sessionId)
    assert.ok(!first.argv?.includes('--fork-session') && !first.argv?.includes('--session-id'))
    assert.deepEqual(first.continues, { resumeId: planned.sessionId })
    assert.equal(resumeSessionId(first), planned.sessionId)
    assert.deepEqual(notes(first), ['continuing the session this card was last planned in'])
    assert.match(readSpec(first.sessionId)!.prompt, /Apply my answers.*planned this card before.*outranks what you remember/)
    await end(first.sessionId)
    const second = await start({ action: 'resolve', id: 1 })
    assert.equal(after(second.argv, '--resume'), planned.sessionId)
  })

  it('resumes an interrupted or stopped planning session when old process is stopped and resumeId is valid', async () => {
    const planned = await start({ action: 'clarify', id: 1 })
    fs.writeFileSync(peekRun(planned.sessionId)!.logPath, 'log\n')
    await closeRun(planned.sessionId, { status: 'stopped', code: null })
    const continued = await start({ action: 'resolve', id: 1 })
    assert.deepEqual(continued.continues, { resumeId: planned.sessionId })

    fs.writeFileSync(peekRun(continued.sessionId)!.logPath, 'log\n')
    await closeRun(continued.sessionId, { status: 'error', ok: false, code: 1, failure: { source: 'runtime', code: 'connection_lost', summary: 'EOF' } })
    const afterError = await start({ action: 'resolve', id: 1 })
    assert.deepEqual(afterError.continues, { resumeId: planned.sessionId })
  })

  it('refuses to carry a planning session that has pendingWrites or session_not_found', async () => {
    const planned = await start({ action: 'clarify', id: 1 })
    fs.writeFileSync(peekRun(planned.sessionId)!.logPath, 'log\n')
    patch(planned.sessionId, (r) => { r.pendingWrites = true })
    await closeRun(planned.sessionId, { status: 'error', ok: false, code: 1 })
    const fresh = await start({ action: 'resolve', id: 1 })
    assert.equal(fresh.continues, undefined)
  })
})

// The discussion, which planning follows, on `other` (`harness`).
function leadPicks(harness: string): void {
  const cfg = JSON.parse(fs.readFileSync(uiConfigOf(root, 'docs', 'kanban'), 'utf8'))
  const [global] = cfg.runtimes
  cfg.runtimes = [global, { ...global, id: 'other', name: 'Other', harness }]
  cfg.agentRuntime = { 'discussion-helper': 'other' }
  fs.writeFileSync(uiConfigOf(root, 'docs', 'kanban'), JSON.stringify(cfg))
}

describe('a new session, as before', () => {
  it('when the card has no session to carry on', async () => {
    const run = await start({ action: 'clarify', id: 1 })
    assert.equal(run.continues, undefined)
    assert.equal(after(run.argv, '--session-id'), run.sessionId)
    assert.deepEqual(notes(run), ['new session — no earlier session of this card is on record'])
    assert.doesNotMatch(readSpec(run.sessionId)!.prompt, /outranks/)
  })

  it('when this step runs on another CLI than the session', async () => {
    await planned1()
    board('codex')
    const run = await start({ action: 'clarify', id: 1 })
    assert.equal(run.harness, 'codex')
    assert.equal(run.continues, undefined)
    assert.ok(!run.argv?.includes('fork'))
    assert.deepEqual(notes(run), ['new session — the earlier session was held by Claude Code, and this step runs on Codex'])
  })

  // Planning runs the discussion's pick, and a pick on another CLI starts fresh.
  it('for a discussion that picked another CLI than the session', async () => {
    await planned1()
    leadPicks('codex')
    const run = await start({ action: 'clarify', id: 1 })
    assert.equal(run.runtime, 'other')
    assert.equal(run.harness, 'codex')
    assert.equal(run.continues, undefined)
    assert.deepEqual(notes(run), ['new session — the earlier session was held by Claude Code, and this step runs on Codex'])
  })

  it('when the CLI cannot fork', async () => {
    board('kimi')
    const run = await start({ action: 'clarify', id: 1, carry: { resumeId: 'kimi-session', fork: true } })
    assert.equal(run.harness, 'kimi')
    assert.equal(run.continues, undefined)
    assert.deepEqual(notes(run), [`new session — ${harnessLabel('kimi')} cannot copy a session`])
    // It still resumes: the planning after an answer carries on.
    await end(run.sessionId)
    patch(run.sessionId, (r) => { r.resumeId = 'kimi-planning' })
    const answered = await start({ action: 'resolve', id: 1 })
    assert.deepEqual(answered.continues, { resumeId: 'kimi-planning' })
    assert.equal(resumeSessionId(answered), 'kimi-planning')
  })

  it('starts ordinary implementation independently', async () => {
    const planned = await start({ action: 'clarify', id: 1 })
    await end(planned.sessionId)
    for (const req of [{ action: 'implement', id: 1 }] as AgentRequest[]) {
      const run = await start(req)
      assert.equal(run.continues, undefined)
      assert.ok(!run.argv?.includes('--resume'))
      assert.deepEqual(notes(run), [])
      await end(run.sessionId)
    }
  })
})

describe('a session that turns out to be gone', () => {
  it('stays failed until an explicit takeover', async () => {
    board('claude-code', true)
    const planned = await start({ action: 'clarify', id: 1 })
    await end(planned.sessionId)
    const lost = await start({ action: 'resolve', id: 1 })
    patch(lost.sessionId, (r) => { r.pid = process.pid })
    fs.writeFileSync(lost.logPath, '')
    await watchRun(lost.sessionId, async () => ({ error: 'no resume' }))
    assert.equal(peekRun(lost.sessionId)?.status, 'error')
    assert.equal(readRuns().filter((r) => r.cardId === 1 && r.action === 'resolve').length, 1)
  })

  it('stays a failure when the agent had started working', async () => {
    const planned = await start({ action: 'clarify', id: 1 })
    await end(planned.sessionId)
    fs.writeFileSync(
      path.join(root, 'agent.mjs'),
      `console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], usage: { input_tokens: 10, output_tokens: 5 } }))
process.exit(1)
`,
    )
    const failed = await start({ action: 'resolve', id: 1 })
    patch(failed.sessionId, (r) => { r.pid = process.pid })
    fs.writeFileSync(failed.logPath, '')
    await watchRun(failed.sessionId, async () => ({ error: 'no resume' }))
    assert.equal(peekRun(failed.sessionId)?.status, 'error')
    assert.equal(readRuns().filter((r) => r.cardId === 1 && r.status === 'running').length, 0)
  })
})

describe("a Cloud task's session (#2146)", () => {
  const TRANSCRIPT = '/tmp/task_1.discussion/discussion.md'

  it('resumes the one named, over the card’s own', async () => {
    const run = await start({ action: 'resolve', id: 1, carry: { resumeId: 'ts1', transcript: TRANSCRIPT } })
    assert.equal(after(run.argv, '--resume'), 'ts1')
    assert.ok(!run.argv?.includes('--fork-session'))
    assert.deepEqual(run.continues, { resumeId: 'ts1' })
    assert.deepEqual(notes(run), ["continuing the task's session"])
    assert.doesNotMatch(readSpec(run.sessionId)!.prompt, /came out of a discussion/)
  })

  it('copies the discussion’s', async () => {
    const run = await start({ action: 'clarify', id: 2, carry: { resumeId: 'ds1', fork: true, transcript: TRANSCRIPT } })
    assert.ok(run.argv?.includes('--fork-session'))
    assert.equal(after(run.argv, '--resume'), 'ds1')
    assert.deepEqual(run.continues, { resumeId: 'ds1', fork: true })
    assert.deepEqual(notes(run), ["started from a copy of the discussion's session"])
  })

  it('reads the discussion with none to carry', async () => {
    const run = await start({ action: 'clarify', id: 2, carry: { transcript: TRANSCRIPT } })
    assert.equal(run.continues, undefined)
    assert.match(readSpec(run.sessionId)!.prompt, new RegExp(`came out of a discussion.*${TRANSCRIPT}`))
  })


})

describe('a new implementation session (#768, #896)', () => {
  const TRANSCRIPT = '/tmp/task_1.discussion/discussion.md'

  for (const carry of [
    { resumeId: 'ds1', fork: true, transcript: TRANSCRIPT, costFrom: 2 },
    { resumeId: 'ts1', transcript: TRANSCRIPT, costFrom: 2 },
    { transcript: TRANSCRIPT },
  ]) {
    it(`ignores discussion session while passing lazy transcript guidance: ${JSON.stringify(carry)}`, async () => {
      await planned1()
      const run = await start({ action: 'implement', id: 1, carry, notes: 'Keep the approved preview' })
      assert.equal(run.continues, undefined)
      assert.equal(run.sessionCostFrom, undefined)
      assert.equal(after(run.argv, '--session-id'), run.sessionId)
      assert.ok(!run.argv?.includes('--resume') && !run.argv?.includes('--fork-session'))
      assert.ok(run.deliveryId)
      const spec = readSpec(run.sessionId)!
      assert.equal(spec.again, undefined)
      assert.deepEqual(notes(run), [])
      assert.match(spec.prompt, /Implement task 1.*Read its current card before starting/)
      assert.match(spec.prompt, /Keep the approved preview/)
      assert.match(spec.prompt, new RegExp(`read-only transcript at \`${TRANSCRIPT}\``))
      assert.match(spec.prompt, /background reference only.*keyword search or sectioned reads rather than reading the whole file/)
      assert.doesNotMatch(spec.prompt, /planned this card|ds1|ts1/)
    })
  }

  it('still skips session inheritance without transcript on a normal implementation run', async () => {
    await planned1()
    const run = await start({ action: 'implement', id: 1, carry: { resumeId: 'ts1', costFrom: 2 } })
    assert.equal(run.continues, undefined)
    assert.equal(run.sessionCostFrom, undefined)
    assert.deepEqual(notes(run), [])
    assert.doesNotMatch(readSpec(run.sessionId)!.prompt, /discussion|planned this card|ts1|discussion\.md/)
  })

  it('passes transcript without forking on a connector that cannot fork', async () => {
    board('kimi')
    const run = await start({ action: 'implement', id: 1, carry: { resumeId: 'ds1', fork: true, transcript: TRANSCRIPT } })
    assert.equal(run.continues, undefined)
    assert.deepEqual(notes(run), [])
    assert.match(readSpec(run.sessionId)!.prompt, new RegExp(`read-only transcript at \`${TRANSCRIPT}\``))
  })
})

it('passes the delivery manifest and current review revision to implementation and resume', async (t) => {
  const previewId = 'custom-output'
  const plan = [{ id: 'design', after: [], previews: [previewId] }]
  const review = (revision: number): TaskReview => ({
    plan, revision, stages: [{ id: 'design', status: 'approved', revision, snapshot: { body: 'Frozen content in the manifest' } }],
  })
  const prompt = path.join(root, 'captured.txt')
  fs.writeFileSync(path.join(root, 'agent.mjs'), `
    import fs from 'node:fs';
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      fs.writeFileSync(${JSON.stringify(prompt)}, JSON.parse(line).message.content);
      break;
    }
    console.log(JSON.stringify({ type: 'result', result: 'Stopped short' }));
  `)
  const draft = path.join(root, 'draft.md')
  fs.writeFileSync(draft, 'Current draft page')
  await move(root, ['create', '--title', 'Saved task inputs', '--studio', 'coding', '--body-file', draft])
  for (const key of ['AI4KANBAN_TASK_REVIEW', 'AI4KANBAN_SAVED_PREVIEW_FILE']) {
    const saved = process.env[key]
    t.after(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved })
  }
  const manifest = path.join(root, 'inputs.md')
  fs.writeFileSync(manifest, '# Saved inputs')
  process.env.AI4KANBAN_TASK_REVIEW = JSON.stringify(review(4))
  process.env.AI4KANBAN_SAVED_PREVIEW_FILE = manifest
  const first = openRun({ action: 'implement', id: 3 }, 'Build the task.', [])
  if ('error' in first) assert.fail(first.error)
  await watchRun(first.run.sessionId)
  const captured = fs.readFileSync(prompt, 'utf8')
  assert.ok(captured.includes(`Use the task inputs and pinned files listed in \`${manifest}\`. Follow the task's delivery instructions.`))
  assert.match(captured, /"revision":4,"snapshot":null/)
  assert.doesNotMatch(captured, /Frozen content in the manifest/)

  const updated = path.join(root, 'revised-inputs.md')
  fs.writeFileSync(updated, '# Revised inputs')
  process.env.AI4KANBAN_TASK_REVIEW = JSON.stringify(review(8))
  process.env.AI4KANBAN_SAVED_PREVIEW_FILE = updated
  const resumed = await openResume(first.run.sessionId)
  if ('error' in resumed) assert.fail(resumed.error)
  assert.equal(resumed.run.resumedFrom, first.run.sessionId)
  await watchRun(resumed.run.sessionId)
  const resumedPrompt = fs.readFileSync(prompt, 'utf8')
  assert.match(resumedPrompt, /"revision":8,"snapshot":null/)
  assert.ok(resumedPrompt.includes(updated))
})

it('sends compact task turns on new, carried and resumed Cloud sessions', async (t) => {
  const board = path.join(root, 'docs', 'kanban')
  const captured = path.join(root, 'prompt.txt')
  const request = path.join(root, 'request.md')
  fs.writeFileSync(request, 'Keep the existing export format.\n')
  await move(root, ['create', '--title', 'Clarify the CSV export button', '--id', '42', '--body-file', request])
  setBoardDir(board, root)
  fs.writeFileSync(path.join(root, 'agent.mjs'), `
    import fs from 'node:fs';
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      fs.writeFileSync(${JSON.stringify(captured)}, JSON.parse(line).message.content);
      break;
    }
    console.log(JSON.stringify({ type: 'result', result: 'Saved' }));
  `)
  const manifest = path.join(root, 'approved-inputs.md')
  fs.writeFileSync(manifest, 'Pinned approved asset v2\n')
  const vars = {
    AI4KANBAN_TASK: 'task_42', AI4KANBAN_TASK_REVIEW: '', AI4KANBAN_REVIEW_STAGES: '',
    [STUDIO_SNAPSHOT_ENV]: JSON.stringify({ studio: 'wf_builtin_coding', version: 1 }),
    AI4KANBAN_SAVED_PREVIEW_FILE: manifest, AI4KANBAN_COMMAND: 'akb',
  }
  for (const [key, value] of Object.entries(vars)) {
    const before = process.env[key]
    process.env[key] = value
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before })
  }
  const studio = (version: number) => ({
    id: 'wf_builtin_coding', name: 'Coding', version,
    files: {
      'STUDIO.md': '---\nname: Coding\n---\n\nCheck the project.',
      'skills/export/SKILL.md': '---\nname: export\ndescription: Export v' + version + '.\n---\n\nRead schema.txt after selecting the skill.',
      'skills/export/schema.txt': 'schema v' + version,
    },
  })
  savePin('task_42', studio(1))
  delete process.env.AI4KANBAN_REVIEW_STAGES
  const design = { id: 'design', after: [], previews: ['ui-design'] }
  const review = (revision: number, status: 'available' | 'approved', body?: string) => {
    process.env.AI4KANBAN_TASK_REVIEW = JSON.stringify({ plan: [design], revision,
      stages: [{ id: 'design', status, revision, snapshot: body ? { body } : null }],
    } satisfies TaskReview)
  }
  const task = (req: Omit<AgentRequest, 'id' | 'title'>) => start({ ...req, id: 42, title: 'Clarify the CSV export button' })
  const sent = async (run: RunRecord, guide: string) => {
    assert.equal(await watchRun(run.sessionId), 0)
    const prompt = fs.readFileSync(captured, 'utf8')
    const command = `${process.env.AI4KANBAN_COMMAND} --board ${board}`
    assert.deepEqual(prompt.match(/Follow `[^`\n]+ guide [^`]+`\./g), [`Follow \`${command} guide ${guide}\`.`])
    assert.doesNotMatch(prompt, /Preview Components|<studio>|<Preview |Frozen draft text|approved-inputs\.md|task show 42/)
    return prompt
  }

  const configDir = path.join(board, 'rules', 'studios', 'coding')
  fs.mkdirSync(configDir, { recursive: true })
  const config = path.join(configDir, 'config.md')
  fs.writeFileSync(config, `---
preferences:
  - actions: [refine]
    text: Use English for plan titles.
  - actions: [chat]
    text: Discussion preference.
---`)
  delete process.env.AI4KANBAN_TASK_REVIEW
  process.env.AI4KANBAN_TASK_REVIEW = JSON.stringify({ plan: null, stages: [], revision: 2 } satisfies TaskReview)
  const initial = await task({ action: 'clarify', session: 'new' })
  const planning = await sent(initial, 'refine')
  assert.match(planning, /Task #42 .+guide refine`\.\n\nTask card: .+\n\nStudio: Coding\. Read `akb studio file coding STUDIO.md` before planning\./)
  assert.match(planning, /Review · planning only\n\nUse English for plan titles/)
  assert.doesNotMatch(planning, /Discussion preference|projects:|Reread the current configuration/)
  review(3, 'available')
  const fresh = await task({ action: 'clarify', session: 'new' })
  const introduced = await sent(fresh, 'refine')
  assert.doesNotMatch(introduced, /Plan the task|Read schema\.txt|schema v1/)
  assert.match(introduced, /### Available skills\n- export: Export v1\./)
  const skill = / \(file: (.+)\)$/m.exec(introduced)?.[1]
  assert.ok(skill)
  assert.equal(fs.readFileSync(path.join(path.dirname(skill), 'schema.txt'), 'utf8'), 'schema v1')
  const carried = await task({ action: 'clarify' })
  assert.equal(carried.continues?.resumeId, fresh.sessionId)
  const carriedPrompt = await sent(carried, 'refine')
  assert.match(introduced, /Work only on these unlocked stages: design[\s\S]*design: ui-design/)
  assert.doesNotMatch(carriedPrompt, /unlocked stages|Available skills|Studio:|Task card:|Use English for plan titles/)
  fs.writeFileSync(config, '')
  const cleared = await sent(await task({ action: 'clarify' }), 'refine')
  assert.match(cleared, /Studio configuration cleared/)
  process.env.AI4KANBAN_REVIEW_STAGES = '["other"]'
  const restricted = await sent(await task({ action: 'clarify' }), 'refine')
  assert.match(restricted, /Review authorization changed/)
  assert.doesNotMatch(restricted, /Work only on these unlocked stages: design/)
  delete process.env.AI4KANBAN_REVIEW_STAGES
  const answer = '  Keep the existing export format.\nUse the same delimiter.  '
  const resolve = await task({ action: 'resolve', notes: answer })
  assert.equal(resolve.continues?.resumeId, fresh.sessionId)
  assert.ok((await sent(resolve, 'resolve')).endsWith(answer))
  const revise = await task({ action: 'edit', notes: 'Use “Export CSV” as the button label.' })
  assert.equal(revise.continues?.resumeId, fresh.sessionId)
  assert.match(await sent(revise, 'revise'), /Implement only if explicitly requested\.[\s\S]*Use “Export CSV”/)
  review(4, 'available')
  const approval = await task({ action: 'approve' })
  assert.match(await sent(approval, 'writing'), /Work only on these unlocked stages: design[\s\S]*Prepare the unlocked Previews\./)
  const drafting = await openResume(approval.sessionId, true)
  if ('error' in drafting) assert.fail(drafting.error)
  assert.match(await sent(drafting.run, 'writing'), /Continue the interrupted turn[\s\S]*Continue task #42\./)

  review(7, 'approved', 'Frozen draft text')
  process.env.AI4KANBAN_COMMAND = 'custom-akb'
  const first = await task({ action: 'implement' })
  const built = await sent(first, 'implement')
  assert.match(built, /Stages complete[\s\S]*Only stage approval accepts reviewable outputs/)
  assert.ok(built.includes(`Use \`custom-akb --board ${board}\` for \`akb\`.`))
  review(8, 'approved', 'Frozen draft text')
  savePin('task_42', studio(2))
  process.env[STUDIO_SNAPSHOT_ENV] = JSON.stringify({ studio: 'wf_builtin_coding', version: 2 })
  const resumed = await openResume(first.sessionId)
  if ('error' in resumed) assert.fail(resumed.error)
  assert.equal(resumed.run.resumedFrom, first.sessionId)
  assert.equal(resumed.run.studioPin?.version, 1)
  const continued = await sent(resumed.run, 'implement')
  assert.match(continued, /^Continue delivery[\s\S]*Stages complete/)
  assert.doesNotMatch(continued, /Available skills/)
  assert.match(await sent(await task({ action: 'archive' }), 'archive'), /Task #42/)
})
