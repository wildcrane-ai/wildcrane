import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, it } from 'node:test'
import { cloudGoal, cloudGoalStudios, queryPreviews } from '../src/commands/goal-cloud'
import { taskReview } from '../src/commands/task'
import { parseReviewFlow } from '../src/lib/shared/review-plan'
import type { PreviewDefinition } from '../src/lib/shared/preview-definitions'
import { writeSession } from '../src/lib/cloud/session'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
let root: string
let goals: Record<string, unknown>[]
let version: number
let started: unknown
let conflict: boolean
let legacy: boolean
let calls: { url: URL; method: string; body: Record<string, unknown> }[]
const catalog = [{ id: 'ui-design', title: { en: 'UI design' }, instructions: 'A full condition.\nWith exceptions.' }, { id: 'api-docs', title: { en: 'API docs' }, instructions: '' }]
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-cloud-'))
  process.env.AI4KANBAN_HOME = root
  process.env.WILDCRANE_HOME = root
  process.env.AI4KANBAN_SUPABASE_URL = 'https://project.test'
  process.env.AI4KANBAN_CLOUD_URL = 'https://api.test'
  process.env.CODEX_THREAD_ID = 'test-thread'
  process.env.CLAUDE_CODE_SESSION_ID = ''
  writeSession({ version: 1, supabaseUrl: 'https://project.test', subject: 'test-account', accessToken: 'test-token', refreshToken: 'test-refresh', expiresAt: Date.now() + 3600_000 })
  started = { id: 'task_1' }; goals = []; version = 1; conflict = false; legacy = false; calls = []
  const draft = () => legacy ? { ideas: goals } : { goals, ideas: goals }
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const body = JSON.parse(String(init?.body || '{}'))
    calls.push({ url, method: init?.method || 'GET', body })
    let result: unknown
    if (url.pathname.endsWith('/folders')) result = { folders: [{ path: process.cwd(), project: 'prj_test' }] }
    else if (url.pathname.endsWith('/studios')) {
      if (url.searchParams.get('workspace') === 'missing') return new Response(JSON.stringify({ error: { message: 'No workspace has this id.' } }), { status: 404 })
      result = { data: [{ id: 'wf_builtin_coding', name: 'Coding', previews: catalog }], next: null }
    } else if (url.pathname.endsWith('/external')) result = { id: 'dsc_test', workspace: 'ws_test', version, ...draft() }
    else if (url.pathname === '/v1/discussions/dsc_dsh') result = { id: 'dsc_dsh', workspace: 'ws_test', version, ...draft() }
    else if (url.pathname.endsWith('/draft')) {
      if (conflict) return new Response(JSON.stringify({ error: { message: 'The goals have changed.' } }), { status: 409 })
      goals = ((legacy ? body.ideas : body.goals) as Record<string, unknown>[]).map((g, i) => ({ ...g, id: String(g.id).startsWith('new_') ? `idea_${i + 1}` : g.id }))
      result = { id: 'dsc_test', workspace: 'ws_test', version: ++version, ...draft() }
    } else if (url.pathname.endsWith('/start')) result = started
    else if (url.pathname === '/v1/tasks/W-1/studio') result = { previews: catalog }
    else if (url.pathname === '/v1/tasks/W-1/review') {
      try {
        const plan = typeof body.review_flow === 'string'
          ? parseReviewFlow(body.review_flow, [...catalog, ...((body.preview_definitions ?? []) as PreviewDefinition[])])
          : body.review_plan
        result = { review: { plan, revision: 3 } }
      } catch (e) {
        return Response.json({ error: { code: 'bad_request', message: (e as Error).message } }, { status: 400 })
      }
    }
    else throw new Error(`Unexpected route ${url.pathname}`)
    return new Response(JSON.stringify(result), { status: 200 })
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of ['AI4KANBAN_HOME', 'WILDCRANE_HOME', 'AI4KANBAN_SUPABASE_URL', 'AI4KANBAN_CLOUD_URL', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'WILDCRANE_DISCUSSION']) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  fs.rmSync(root, { recursive: true, force: true })
})
it('外部会话按会话与项目保存，返回 Cloud 目标 id；后续编辑与开始使用同一讨论', async () => {
  const body = path.join(root, 'body.md'); fs.writeFileSync(body, 'Deliver.\n\n## Done when\n- Done')
  const reviewFile = path.join(root, 'review.json'); fs.writeFileSync(reviewFile, JSON.stringify([{ id: 'design', after: [], previews: ['ui-design', 'api-docs'] }]))
  const created = await cloudGoal(['new'], { title: 'Goal', bodyFile: body, studio: 'coding', reviewFile })
  assert.equal(created.id, 'idea_1')
  assert.equal(created.url, 'https://app.wildcrane.ai/discussions/dsc_test')
  assert.deepEqual(goals[0].review_plan, [{ id: 'design', after: [], previews: ['ui-design', 'api-docs'] }])
  assert.deepEqual(calls.find((c) => c.url.pathname.endsWith('/external'))?.body, { requestId: 'test-thread', host: 'codex', project: 'prj_test' })
  await cloudGoal(['save'], { id: String(created.id), title: 'Updated' })
  assert.deepEqual(goals[0].review_plan, [{ id: 'design', after: [], previews: ['ui-design', 'api-docs'] }])
  await cloudGoal(['start'], { id: String(created.id) })
  assert.equal(calls.at(-1)?.url.pathname, '/v1/discussions/dsc_test/goals/idea_1/start')
  assert.equal(calls.at(-1)?.body.expectedVersion, version)
  assert.equal(process.env.KANBAN_GOALS, originalEnv.KANBAN_GOALS)
})
it('旧云端以 ideas 保存和开始，已开始的目标仍不可编辑', async () => {
  legacy = true
  goals = [
    { id: 'idea_1', title: 'Started', studio: 'wf_builtin_coding', task: { id: 'task_1', key: 'W-1' } },
    { id: 'idea_2', title: 'Open', studio: 'wf_builtin_coding', task: null },
  ]
  await assert.rejects(cloudGoal(['save'], { id: 'idea_1', title: 'Changed' }), /already a task/)
  assert.ok(!calls.some(call => call.url.pathname.endsWith('/draft')))
  await cloudGoal(['start'], { id: 'idea_2' })
  assert.equal(calls.at(-1)?.url.pathname, '/v1/discussions/dsc_test/ideas/idea_2/start')
  assert.deepEqual(calls.at(-1)?.body, { expectedVersion: version })
  assert.deepEqual(goals[0].task, { id: 'task_1', key: 'W-1' })
})
it('目标与任务使用同一套 Preview 名称，输入无效时不提交计划', async () => {
  const bodyFile = path.join(root, 'body.md')
  fs.writeFileSync(bodyFile, 'Review the design before delivery.')
  const review = 'UI design + API docs'
  const { id, review_plan } = await cloudGoal(['new'], { title: 'Goal', bodyFile, review })
  assert.deepEqual((await taskReview('W-1', { review, revision: '2' })).review, { plan: review_plan, revision: 3 })
  assert.deepEqual(calls.at(-1)?.body, { operation: 'plan', review_flow: review, review_revision: 2 })
  assert.deepEqual(goals[0].review_plan, review_plan)

  const before = calls.length
  await assert.rejects(cloudGoal(['save'], { id: String(id), review: 'Unknown' }), /Available Previews/)
  const reviewFile = path.join(root, 'legacy-review.json')
  fs.writeFileSync(reviewFile, JSON.stringify([{ id: 'plan-review' }, { id: 'handoff', after: ['plan-review'] }]))
  await assert.rejects(cloudGoal(['save'], { id: String(id), reviewFile }), /Review node "plan-review".*\(ui-design\).*card body/)
  await assert.rejects(taskReview('W-1', { review: 'UI design ->', revision: '3' }), /empty Preview/)
  await assert.rejects(taskReview('W-1', { review: '', file: bodyFile, revision: '3' }), /Use one of/)
  assert.deepEqual(calls.slice(before).filter(c => c.url.pathname.endsWith('/draft') || c.url.pathname.endsWith('/review')).map(c => c.body.review_flow), ['UI design ->'])

  await cloudGoal(['save'], { id: String(id), review: '' })
  assert.deepEqual((await taskReview('W-1', { review: '', revision: '3' })).review, { plan: [], revision: 3 })
  assert.deepEqual(goals[0].review_plan, [])
})
it('外部查询包含完整触发条件，错误不继续写入，支持 Claude Code 的同一入口', async () => {
  assert.equal((await cloudGoalStudios()).discussion, 'dsc_test')
  assert.deepEqual((await queryPreviews('coding', 'ws_test')).previews, catalog)
  await assert.rejects(queryPreviews('coding', 'missing'), /No workspace/)
  process.env.CLAUDE_CODE_SESSION_ID = 'test-claude'
  await cloudGoalStudios()
  assert.deepEqual([...calls].reverse().find((c) => c.url.pathname.endsWith('/external'))?.body, { requestId: 'test-claude', host: 'claude-code', project: 'prj_test' })
  goals = [{ id: 'idea_1', title: 'Goal', studio: 'wf_builtin_coding', previews: [], task: null }]
  conflict = true
  await assert.rejects(cloudGoal(['save'], { id: 'idea_1', title: 'Changed' }), /goals have changed/)
  assert.equal(goals[0].title, 'Goal')
  assert.equal(process.env.KANBAN_GOALS, originalEnv.KANBAN_GOALS)
})
it('dsh 会话使用模型传入的讨论编号，不再开新讨论 (#531)', async () => {
  delete process.env.CODEX_THREAD_ID
  process.env.WILDCRANE_DISCUSSION = 'dsc_dsh'
  assert.equal((await cloudGoalStudios()).discussion, 'dsc_dsh')
  assert.equal(calls.some((c) => c.url.pathname.endsWith('/external')), false)
})

it('混合 Studio 和自定义 Preview 名称，保留定义并拒绝带悬空引用的清除', async () => {
  const bodyFile = path.join(root, 'goal.md')
  const previewDefinitionsFile = path.join(root, 'previews.json')
  const definition = { id: 'accessibility-report', title: { en: 'Accessibility report', zh: '无障碍检查报告' },
    instructions: 'Check the checkout with Tab and report missing focus.' }
  fs.writeFileSync(bodyFile, 'Check keyboard navigation on checkout.')
  fs.writeFileSync(previewDefinitionsFile, JSON.stringify([definition]))
  const review = 'UI design + API docs -> 无障碍检查报告'
  const goal = await cloudGoal(['new'], { title: 'Review checkout', bodyFile, review, previewDefinitionsFile })
  const id = String(goal.id)
  assert.deepEqual(goals[0].preview_definitions, [definition])
  await cloudGoal(['save'], { id, title: 'Review checkout with Tab' })
  assert.deepEqual(goals[0].preview_definitions, [definition])
  const task = await taskReview('W-1', { review, previewDefinitionsFile, revision: '2' })
  assert.deepEqual((task.review as { plan: unknown }).plan, goals[0].review_plan)
  assert.deepEqual(calls.at(-1)?.body.preview_definitions, [definition])
  fs.writeFileSync(previewDefinitionsFile, '[]')
  await assert.rejects(cloudGoal(['save'], { id, previewDefinitionsFile }), /accessibility-report/)
  await cloudGoal(['save'], { id, previewDefinitionsFile, review: '' })
  assert.deepEqual(goals[0].preview_definitions, [])
})

it('requires a task receipt before reporting an external goal started', async () => {
  goals = [{ id: 'idea_1', title: 'Goal', studio: 'wf_builtin_coding', task: null }]
  started = {}
  await assert.rejects(cloudGoal(['start'], { id: 'idea_1' }), /Cloud did not return a started task/)
  started = { id: 'task_2' }
  assert.equal((await cloudGoal(['start'], { id: 'idea_1' })).task, 'task_2')
})
