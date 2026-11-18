import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'

import { cmdGoal, cmdGoalPreviews } from '../src/commands/goal.ts'
import { findGuide } from '../src/lib/guide.ts'

import { cmdIdea, cmdIdeaStudios, splitBody } from '../src/commands/idea.ts'

let dir = ''
let file = ''
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))
const draft = (text: string) => {
  const at = path.join(dir, 'draft.md')
  fs.writeFileSync(at, text)
  return at
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-idea-'))
  file = path.join(dir, 'ideas.json')
  fs.writeFileSync(file, JSON.stringify({
    studios: [{ id: 'wf_builtin_coding', name: 'Coding' }, { id: 'wf_builtin_slide_deck', name: 'Slide deck' }],
    ideas: [{ id: 'idea_a', title: 'Started', outcome: '', acceptance: [], studio: 'wf_builtin_coding', task: 'task_1' }],
  }))
  process.env.KANBAN_IDEAS = file
})
afterEach(() => {
  delete process.env.KANBAN_IDEAS
  fs.rmSync(dir, { recursive: true, force: true })
})

it('splits the outcome from what counts as done', () => {
  assert.deepEqual(splitBody('Visitors see prices.\n\n## Done when\n- /pricing shows both\n- [ ] toggling works\n'), {
    outcome: 'Visitors see prices.',
    acceptance: ['/pricing shows both', 'toggling works'],
  })
  assert.deepEqual(splitBody('Just an outcome.'), { outcome: 'Just an outcome.', acceptance: [] })
})

it('drafts, saves, drops and starts ideas in the file the Runner reads back', () => {
  cmdIdea(['new'], { title: 'Pricing page', bodyFile: draft('Prices.\n\n## Done when\n- shown') })
  assert.deepEqual(read().ideas[1], { id: 'new_1', title: 'Pricing page', outcome: 'Prices.', acceptance: ['shown'], studio: 'wf_builtin_coding', review_plan: null, task: null })
  cmdIdea(['save'], { id: 'new_1', studio: 'slide-deck' })
  assert.equal(read().ideas[1].studio, 'wf_builtin_slide_deck')
  cmdIdea(['new'], { title: 'Blog', bodyFile: draft('A post.') })
  cmdIdea(['drop'], { id: 'new_2' })
  cmdIdea(['start'], { id: 'new_1' })
  const ideas = read().ideas
  assert.equal(ideas[2].dropped, true)
  assert.equal(ideas[1].start, true)
  assert.throws(() => cmdIdea(['save'], { id: 'idea_a', title: 'x' }), /already a task/)
  assert.throws(() => cmdIdea(['save'], { id: 'new_2', title: 'x' }), /--id must name/)
  assert.throws(() => cmdIdea(['new'], { title: 'x', bodyFile: draft('y'), studio: 'video' }), /No studio `video`/)
})

it('lists the workspace studios by their short ids', () => {
  assert.deepEqual((cmdIdeaStudios().studios as { id: string }[]).map((w) => w.id), ['coding', 'slide-deck'])
})

it('refuses outside an idea conversation', () => {
  delete process.env.KANBAN_IDEAS
  assert.throws(() => cmdIdea(['new'], { title: 'x' }), /only inside/)
})

it('新旧命令共用草稿且保存不会开始任务', () => {
  process.env.KANBAN_GOALS = file
  try {
    cmdGoal(['new'], { title: '目标', bodyFile: draft('结果。\n\n## Done when\n- 验收') })
    assert.equal(read().ideas[1].start, undefined)
    cmdIdea(['save'], { id: 'new_1', title: '更新' })
    cmdGoal(['start'], { id: 'new_1' })
    assert.equal(read().ideas.length, 2)
    assert.equal(read().ideas[1].title, '更新')
    assert.equal(read().ideas[1].start, true)
    assert.ok(findGuide('discuss-goal')); assert.equal(findGuide('discuss-idea'), null)
  } finally { delete process.env.KANBAN_GOALS }
})

it('新旧命令拒绝缺失、无效或不一致的目标数组', () => {
  for (const cmd of [cmdGoal, cmdIdea]) {
    for (const held of [{}, { goals: null }, { ideas: 'invalid' }]) {
      fs.writeFileSync(file, JSON.stringify(held))
      assert.throws(() => cmd(['save'], { id: 'idea_a' }), { message: 'The goals array is missing or invalid.' })
    }
    fs.writeFileSync(file, JSON.stringify({ goals: [], ideas: [{ id: 'idea_a' }] }))
    assert.throws(() => cmd(['save'], { id: 'idea_a' }), { message: 'goals and ideas do not match.' })
    fs.writeFileSync(file, JSON.stringify({ goals: [] }))
    assert.throws(() => cmd(['new'], { title: '目标', bodyFile: draft('结果') }), { message: 'Install a studio first.' })
    const studios = [{ id: 'wf_builtin_blog_post', name: 'Blog post' }]
    for (const held of [{ goals: [], studios }, { goals: [], ideas: [], studios }]) {
      fs.writeFileSync(file, JSON.stringify(held))
      cmd(['new'], { title: '目标', bodyFile: draft('结果') })
      assert.equal(read().ideas.length, 1)
      assert.equal(read().ideas[0].studio, 'wf_builtin_blog_post')
    }
  }
})

it('审核安排区分未定与空安排，保留依赖并拒绝静默删除 Preview', () => {
  const held = read()
  held.studios[0].previews = [{ id: 'ui-design', instructions: 'UI' }]
  held.studios[1].previews = []
  fs.writeFileSync(file, JSON.stringify(held))
  const plan = [{ id: 'ui', after: [], previews: ['ui-design'] }]
  const reviewFile = path.join(dir, 'review.json'); fs.writeFileSync(reviewFile, JSON.stringify(plan))
  cmdGoal(['new'], { title: 'Review', bodyFile: draft('Deliver.'), reviewFile })
  assert.deepEqual(read().ideas[1].review_plan, plan)
  cmdGoal(['new'], { title: 'Other', bodyFile: draft('Other.') })
  assert.equal(read().ideas[2].review_plan, null)
  cmdGoal(['save'], { id: 'new_1', title: 'Changed' })
  assert.deepEqual(read().ideas[1].review_plan, plan)
  const before = fs.readFileSync(file, 'utf8')
  assert.throws(() => cmdGoal(['save'], { id: 'new_1', studio: 'slide-deck' }), /Preview ui-design is not defined/)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  cmdGoal(['save'], { id: 'new_1', reviewFile: draft('[]') })
  assert.deepEqual(read().ideas[1].review_plan, [])
})

it('查询使用当前工作台的完整触发条件，旧 Runner 缺少目录时明确拒绝', () => {
  assert.throws(() => cmdGoalPreviews('coding'), /Preview outputs are unavailable/)
  const held = read()
  held.studios.push({ id: 'wf_custom', name: 'Custom', previews: [{ id: 'custom', instructions: 'First.\nExcept second.' }] })
  fs.writeFileSync(file, JSON.stringify(held))
  assert.deepEqual(cmdGoalPreviews('wf_custom').previews, [{ id: 'custom', instructions: 'First.\nExcept second.' }])
})
