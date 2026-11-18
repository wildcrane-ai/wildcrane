import assert from 'node:assert/strict'
import { it } from 'node:test'
import { parseReviewPlan, readReviewPlan, reviewLayers, reviewBoundary } from '../src/lib/shared/review-plan'

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
  const boundary = reviewBoundary({revision:1,plan,pending_plan:null,stages:[{id:'a',status:'available',revision:1,snapshot:null},{id:'c',status:'blocked',revision:1,snapshot:null}]})
  assert.match(boundary, /Work only on these unlocked stages: a\n/)
})

it('keeps newly unlocked work outside the current execution assignment (#818)', () => {
  const plan = parseReviewPlan([{id:'a'},{id:'b'}])!
  const boundary = reviewBoundary({revision:2,plan,pending_plan:null,stages:plan.map(n=>({id:n.id,status:'available',revision:2,snapshot:null}))}, ['a'])
  assert.match(boundary, /Work only on these unlocked stages: a\n/)
})
