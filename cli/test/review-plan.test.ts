import assert from 'node:assert/strict'
import { it } from 'node:test'
import { addPreviewsToPlan, parseReviewFlow, parseReviewPlan, readReviewPlan, validateReviewPreviews, reviewLayers, reviewBoundary, reviewAuthorization, reviewAllows, taskReviewBoundary, type TaskReview } from '../src/lib/shared/review-plan'
import { mergePreviewDefinitions, type PreviewDefinition } from '../src/lib/shared/preview-definitions'
import { compactReview } from '../src/lib/agent/runtime-context'

it('validates forward references and parallel joins without using array order', () => {
  const plan = parseReviewPlan([{id:'c',after:['a','b']},{id:'b'},{id:'a'}])!
  assert.deepEqual(reviewLayers(plan).map(l => l.map(n => n.id)), [['b','a'],['c']])
  assert.equal(parseReviewPlan(null), null)
  assert.deepEqual(parseReviewPlan([]), [])
  for (const invalid of [
    [{id:'a',after:['b']},{id:'b',after:['a']}],
    [{id:'a',after:['missing']}], [{id:'a',after:['a']}],
    [{id:'a'},{id:'a'}], [{id:'a',after:['b','b']},{id:'b'}],
  ]) assert.throws(() => parseReviewPlan(invalid))
  const legacy = { id: 'a', title: 'Old title', after: [], previews: ['ui-design'] }
  assert.throws(() => parseReviewPlan([legacy]), /title/)
  assert.throws(() => parseReviewPlan([{ id: 'a', description: 'Override' }]), /description/)
  assert.deepEqual(readReviewPlan([legacy]), [{ id: 'a', after: [], previews: ['ui-design'] }])
})

it('parses Studio names into separate approval gates, including the last group', () => {
  const catalog: { id: string; title: Record<string, string> }[] = [
    { id: 'ui-design', title: { en: 'UI design', zh: '界面设计' } },
    { id: 'api-docs', title: { en: 'API docs', zh: '接口文档' } },
    { id: 'prompts', title: { en: 'Prompts' } },
  ]
  for (const [flow, layers] of [
    ['UI design', [['ui-design'], ['delivery-handoff']]],
    ['UI design -> Prompts', [['ui-design'], ['prompts'], ['delivery-handoff']]],
    ['UI design + API docs -> Prompts', [['ui-design', 'api-docs'], ['prompts'], ['delivery-handoff']]],
    ['界面设计 -> API docs + Prompts', [['ui-design'], ['api-docs', 'prompts'], ['delivery-handoff']]],
  ] as const) {
    const plan = parseReviewFlow(flow, catalog)
    assert.deepEqual(validateReviewPreviews(plan, catalog), layers.flatMap((ids, index) => ids.map(id => ({
      id, after: layers[index - 1] ?? [], previews: id === 'delivery-handoff' ? [] : [id],
    }))))
  }
  assert.deepEqual(parseReviewFlow(''), [])
  for (const flow of [' ', 'UI design +', 'UI design -> -> Prompts', 'UI design ++ API docs']) {
    assert.throws(() => parseReviewFlow(flow, catalog), /empty Preview name/)
  }
  assert.throws(() => parseReviewFlow('UI design -> 界面设计', catalog), /Repeated Preview.*Available Previews/)
  assert.throws(() => parseReviewFlow('UI design -> ui-design', catalog),
    /Unknown Preview "ui-design" in review flow group 2.*Available Previews: UI design \/ 界面设计 \(ui-design\).*Define custom Previews.*draft or result for review.*card body/)
  assert.throws(() => parseReviewFlow('UI design', [...catalog, { id: 'design', title: { en: 'UI design' } }]), /Ambiguous Preview.*Available Previews/)
  const collision = parseReviewFlow('Handoff', [{ id: 'delivery-handoff', title: { en: 'Handoff' } }])
  assert.deepEqual(validateReviewPreviews(collision, [{ id: 'delivery-handoff' }]), collision)
  assert.deepEqual(collision[1]!.after, [collision[0]!.id])
  assert.notEqual(collision[1]!.id, collision[0]!.id)
})

it('requires defined Previews on review nodes and accepts ordinary work and terminal handoff', () => {
  const catalog = [{ id: 'ui-design', title: { en: 'UI design', zh: '界面设计' } }]
  const legacy = parseReviewPlan([{ id: 'plan-review' }, { id: 'handoff', after: ['plan-review'] }])
  assert.throws(() => validateReviewPreviews(legacy, catalog),
    /Review node "plan-review" needs at least one Preview.*empty plan.*UI design \/ 界面设计 \(ui-design\).*card body/)
  assert.deepEqual(validateReviewPreviews(legacy, catalog, { saved: true }), legacy)
  assert.deepEqual(validateReviewPreviews([], catalog), [])
  const plan = parseReviewPlan([
    { id: 'prepare', kind: 'work' },
    { id: 'review', previews: ['ui-design'], after: ['prepare'] },
    { id: 'delivery-handoff', after: ['review'] },
  ])!
  assert.deepEqual(validateReviewPreviews(plan, catalog), plan)
  assert.throws(() => validateReviewPreviews([...plan, { id: 'extra', kind: 'work', previews: [], after: ['delivery-handoff'] }], catalog), /Review node "delivery-handoff"/)
  assert.throws(() => validateReviewPreviews(parseReviewPlan([{ id: 'delivery-handoff' }]), catalog), /Review node "delivery-handoff"/)
  assert.throws(() => validateReviewPreviews([{ ...plan[0]!, previews: ['unknown'] }], catalog), /Preview unknown is not defined for review node "prepare"/)
})

it('distinguishes planning, stage review and delivery', () => {
  const base: TaskReview = { revision: 0, plan: null, stages: [] }
  const plan = parseReviewPlan([{ id: 'draft' }])!
  const approved: TaskReview = {
    ...base, plan, stages: [{ id: 'draft', status: 'approved', revision: 1, snapshot: {} }],
  }
  const cases: [TaskReview, RegExp, boolean, boolean][] = [
    [base, /Planning only/, true, false],
    [{ ...base, plan: [] }, /No extra review/, false, true],
    [approved, /Stages complete/, false, true],
    [{ ...approved, stages: [] }, /Wait for review/, false, false],
  ]
  for (const [review, message, refine, implement] of cases) {
    const authorization = reviewAuthorization(review, [])
    assert.equal(reviewAllows(authorization, 'refine'), refine)
    assert.equal(reviewAllows(authorization, 'implement'), implement)
    assert.match(reviewBoundary(review, []), message)
  }
})

it('limits the work and Preview instructions to the dispatched runnable stages', () => {
  const plan = parseReviewPlan([
    { id: 'approved' }, { id: 'assigned', previews: ['ui-design'] }, { id: 'unassigned', previews: ['api-docs'] },
  ])!
  const review: TaskReview = {
    revision: 2, plan,
    stages: plan.map(({ id }) => ({ id, status: id === 'approved' ? 'approved' : 'available', revision: 2, snapshot: null })),
  }
  const authorization = reviewAuthorization(review, ['assigned'])
  assert.deepEqual(authorization, { kind: 'stages', nodes: [plan[1]] })
  assert.equal(reviewAllows(authorization, 'refine'), true)
  assert.equal(reviewAllows(authorization, 'implement'), false)
  assert.match(reviewBoundary(review, ['assigned']), /Work only on these unlocked stages: assigned\n- assigned: ui-design\nRead/)
  assert.match(reviewBoundary(review, ['assigned', 'approved']), /Review authorization changed/)
  assert.match(reviewBoundary(review, []), /Wait for review/)
})

it('uses the Studio instructions for adopted Preview IDs while keeping other task instructions', () => {
  const review: TaskReview = {
    revision: 29, plan: null, stages: [],
    preview_definitions: [
      { id: 'market-research', title: { en: 'Old research', zh: '旧调研' }, instructions: 'Old instructions.', components: ['Asset'] },
      { id: 'custom', title: { en: 'Custom', zh: '自定义' }, instructions: 'Task instructions.', components: ['Set'] },
    ],
  }
  const prompt = reviewBoundary(review, undefined, [{ id: 'market-research' }])
  assert.doesNotMatch(prompt, /market-research|Old instructions|Allowed Preview Components: Asset/)
  assert.match(prompt, /<Preview id="custom">\nTask instructions\.\nAllowed Preview Components: Set\./)
})

it('appends Previews to flat, legacy, and empty plans without dropping existing stages or definitions', () => {
  assert.deepEqual(
    addPreviewsToPlan({ rule: 'Ask before landing.', previews: ['ui-design'] }, ['api-docs', 'ui-design']),
    { rule: 'Ask before landing.', previews: ['ui-design', 'api-docs'] },
  )
  assert.deepEqual(
    addPreviewsToPlan(null, ['api-docs']),
    [{ id: 'api-docs', after: [], previews: ['api-docs'] }, { id: 'delivery-handoff', after: ['api-docs'], previews: [] }],
  )
  const legacy = parseReviewPlan([
    { id: 'api-docs', after: [], previews: ['api-docs'] },
    { id: 'delivery-handoff', after: ['api-docs'], previews: [] },
  ])!
  assert.deepEqual(
    addPreviewsToPlan(legacy, ['api-docs', 'schema']),
    [
      { id: 'api-docs', after: [], previews: ['api-docs'] },
      { id: 'schema', after: [], previews: ['schema'] },
      { id: 'delivery-handoff', after: ['api-docs', 'schema'], previews: [] },
    ],
  )
  const existing: PreviewDefinition[] = [
    { id: 'a', title: { en: 'A', zh: '甲' }, instructions: 'Keep A.' },
    { id: 'b', title: { en: 'B', zh: '乙' }, instructions: 'Old B.' },
  ]
  const merged = mergePreviewDefinitions(existing, [
    { id: 'b', title: { en: 'B2', zh: '乙2' }, instructions: 'New B.' },
    { id: 'c', title: { en: 'C', zh: '丙' }, instructions: 'Add C.' },
  ])
  assert.deepEqual(merged.map(d => [d.id, d.instructions]), [['a', 'Keep A.'], ['b', 'New B.'], ['c', 'Add C.']])
})

it('includes stage preview mappings and custom Preview IDs in compactReview', () => {
  const review: TaskReview = {
    revision: 4,
    plan: [
      { id: 'api-docs', after: [], previews: ['api-docs'] },
      { id: 'delivery-handoff', after: ['api-docs'], previews: [] },
    ],
    stages: [
      { id: 'api-docs', status: 'approved', revision: 3, snapshot: {} },
      { id: 'delivery-handoff', status: 'available', revision: 4, snapshot: null },
    ],
    preview_definitions: [{ id: 'custom-check', title: { en: 'Check', zh: '检查' }, instructions: 'Run check.' }],
  }
  assert.equal(
    compactReview(review),
    'Review r4 · api-docs (previews: api-docs) approved · delivery-handoff available to start\nCustom Previews: custom-check',
  )
})

it('keeps flat review rules visible in Card Chat while background work waits for approval', () => {
  const review: TaskReview = {
    revision: 8,
    plan: { previews: ['api-docs', 'ui-design'], rule: 'Ask for approval when\na public interface signature changes.' },
    stages: [
      { id: 'approval-6', revision: 6, preview: 'api-docs', status: 'approved', snapshot: {} },
      { id: 'approval-7', revision: 7, preview: 'ui-design', status: 'waiting_review', snapshot: {} },
    ],
    approvals: [{ preview: 'ui-design', stage: 'approval-7', revision: 7, question: '这个界面稿可以确认吗？' }],
  }
  assert.equal(compactReview(review), [
    'Review r8 · flat plan',
    'Selected Previews: api-docs, ui-design',
    'Review rule: Ask for approval when a public interface signature changes.',
    'Pending approvals:',
    '- ui-design · approval-7 · r7: 这个界面稿可以确认吗？',
  ].join('\n'))
  assert.equal(compactReview({
    revision: 0, plan: { previews: [], rule: '' }, stages: [],
  }), 'Review r0 · flat plan\nSelected Previews: none\nReview rule: No extra approval.')
  assert.match(taskReviewBoundary(review), /Wait for an explicit decision/)
  assert.equal(reviewAllows(reviewAuthorization(review), 'implement'), false)
})
