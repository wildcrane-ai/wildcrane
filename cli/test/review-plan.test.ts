import assert from 'node:assert/strict'
import { it } from 'node:test'
import { parseReviewPlan, readReviewPlan, reviewLayers, reviewBoundary, reviewAuthorization, reviewAllows, type TaskReview } from '../src/lib/shared/review-plan'

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
  assert.throws(() => parseReviewPlan([{ id: 'a', previews: ['ui-desgin'] }], ['ui-design']), /Preview ui-desgin/)
  const legacy = { id: 'a', title: 'Old title', after: [], previews: ['ui-design'] }
  assert.throws(() => parseReviewPlan([legacy]), /title/)
  assert.throws(() => parseReviewPlan([{ id: 'a', description: 'Override' }]), /description/)
  assert.deepEqual(readReviewPlan([legacy]), [{ id: 'a', after: [], previews: ['ui-design'] }])
})

it('distinguishes planning, pending approval and delivery', () => {
  const base: TaskReview = { revision: 0, plan: null, stages: [], pending_plan: null }
  const pending: TaskReview['pending_plan'] = { revision: 1, snapshot: { kind: 'plan', plan: [] } }
  const plan = parseReviewPlan([{ id: 'draft' }])!
  const approved: TaskReview = {
    ...base, plan, stages: [{ id: 'draft', status: 'approved', revision: 1, snapshot: {} }],
  }
  const cases: [TaskReview, RegExp, boolean, boolean][] = [
    [base, /Planning only/, true, false],
    [{ ...base, pending_plan: pending }, /Wait for the proposed plan decision/, false, false],
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
    revision: 2, plan, pending_plan: null,
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
