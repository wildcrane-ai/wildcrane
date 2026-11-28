import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'

import { cmdGoal, cmdGoalPreviews, cmdGoalStudios, splitBody } from '../src/commands/goal.ts'
import { findGuide } from '../src/lib/guide.ts'

let dir = ''
let file = ''
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))
const draft = (text: string) => {
  const at = path.join(dir, 'draft.md')
  fs.writeFileSync(at, text)
  return at
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-goal-'))
  file = path.join(dir, 'goals.json')
  fs.writeFileSync(file, JSON.stringify({
    studios: [{ id: 'wf_builtin_coding', name: 'Coding' }, { id: 'wf_builtin_slide_deck', name: 'Slide deck' }],
    goals: [{ id: 'idea_a', title: 'Started', outcome: '', acceptance: [], studio: 'wf_builtin_coding', task: { id: 'task_1' } }],
  }))
  process.env.KANBAN_GOALS = file
})
afterEach(() => {
  delete process.env.KANBAN_GOALS
  fs.rmSync(dir, { recursive: true, force: true })
})

it('splits the outcome from what counts as done', () => {
  assert.deepEqual(splitBody('Visitors see prices.\n\n## Done when\n- /pricing shows both\n- [ ] toggling works\n'), {
    outcome: 'Visitors see prices.',
    acceptance: ['/pricing shows both', 'toggling works'],
  })
  assert.deepEqual(splitBody('Just an outcome.'), { outcome: 'Just an outcome.', acceptance: [] })
})

it('drafts, saves, drops and starts goals in the file the Runner reads back', async () => {
  await cmdGoal(['new'], { title: 'Pricing page', bodyFile: draft('Prices.\n\n## Done when\n- shown') })
  assert.deepEqual(read().goals[1], { id: 'new_1', title: 'Pricing page', outcome: 'Prices.', acceptance: ['shown'], studio: 'wf_builtin_coding', review_plan: null, task: null })
  await cmdGoal(['save'], { id: 'new_1', studio: 'slide-deck' })
  assert.equal(read().goals[1].studio, 'wf_builtin_slide_deck')
  assert.equal(read().goals[1].start, undefined)
  await cmdGoal(['new'], { title: 'Blog', bodyFile: draft('A post.') })
  await cmdGoal(['drop'], { id: 'new_2' })
  await cmdGoal(['start'], { id: 'new_1' })
  const goals = read().goals
  assert.equal(goals[2].dropped, true)
  assert.equal(goals[1].start, true)
  await assert.rejects(cmdGoal(['save'], { id: 'idea_a', title: 'x' }), /already a task/)
  await assert.rejects(cmdGoal(['save'], { id: 'new_2', title: 'x' }), /--id must name/)
  await assert.rejects(cmdGoal(['new'], { title: 'x', bodyFile: draft('y'), studio: 'video' }), /No studio `video`/)
})

it('lists the workspace studios by their short ids', () => {
  assert.deepEqual((cmdGoalStudios().studios as { id: string }[]).map((w) => w.id), ['coding', 'slide-deck'])
})

it('refuses outside a goal discussion', async () => {
  delete process.env.KANBAN_GOALS
  await assert.rejects(cmdGoal(['new'], { title: 'x' }), /only inside/)
})

it('requires a Goal array and an installed Studio', async () => {
  for (const held of [{}, { goals: null }, { ideas: [] }]) {
    fs.writeFileSync(file, JSON.stringify(held))
    await assert.rejects(cmdGoal(['save'], { id: 'idea_a' }), { message: 'The goals array is missing or invalid.' })
  }
  fs.writeFileSync(file, JSON.stringify({ goals: [] }))
  await assert.rejects(cmdGoal(['new'], { title: '目标', bodyFile: draft('结果') }), { message: 'Install a studio first.' })
  assert.ok(findGuide('discuss-goal'))
  assert.equal(findGuide('discuss-idea'), null)
})

it('审核安排区分未定与空安排，保留依赖并拒绝静默删除 Preview', async () => {
  const held = read()
  held.studios[0].previews = [{ id: 'ui-design', instructions: 'UI' }]
  held.studios[1].previews = []
  fs.writeFileSync(file, JSON.stringify(held))
  const plan = [{ id: 'ui', after: [], previews: ['ui-design'] }]
  const reviewFile = path.join(dir, 'review.json'); fs.writeFileSync(reviewFile, JSON.stringify(plan))
  await cmdGoal(['new'], { title: 'Review', bodyFile: draft('Deliver.'), reviewFile })
  assert.deepEqual(read().goals[1].review_plan, plan)
  await cmdGoal(['new'], { title: 'Other', bodyFile: draft('Other.') })
  assert.equal(read().goals[2].review_plan, null)
  await cmdGoal(['save'], { id: 'new_1', title: 'Changed' })
  assert.deepEqual(read().goals[1].review_plan, plan)
  const before = fs.readFileSync(file, 'utf8')
  await assert.rejects(cmdGoal(['save'], { id: 'new_1', studio: 'slide-deck' }), /Preview ui-design is not defined/)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  await cmdGoal(['save'], { id: 'new_1', reviewFile: draft('[]') })
  assert.deepEqual(read().goals[1].review_plan, [])
})

it('查询使用当前工作台的完整触发条件，旧 Runner 缺少目录时明确拒绝', () => {
  assert.throws(() => cmdGoalPreviews('coding'), /Preview outputs are unavailable/)
  const held = read()
  held.studios.push({ id: 'wf_custom', name: 'Custom', previews: [{ id: 'custom', instructions: 'First.\nExcept second.' }] })
  fs.writeFileSync(file, JSON.stringify(held))
  assert.deepEqual(cmdGoalPreviews('wf_custom').previews, [{ id: 'custom', instructions: 'First.\nExcept second.' }])
})
