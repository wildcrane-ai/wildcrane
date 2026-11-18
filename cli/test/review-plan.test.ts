import assert from 'node:assert/strict'
import { it } from 'node:test'
import { parseReviewPlan, reviewLayers, reviewBoundary } from '../src/lib/shared/review-plan'

it('validates forward references and parallel joins without using array order', () => {
  const plan = parseReviewPlan([{id:'c',title:'C',after:['a','b']},{id:'b',title:'B'},{id:'a',title:'A'}])!
  assert.deepEqual(reviewLayers(plan).map(l => l.map(n => n.id)), [['b','a'],['c']])
  assert.equal(parseReviewPlan(null), null)
  assert.deepEqual(parseReviewPlan([]), [])
  for (const invalid of [
    [{id:'a',title:'A',after:['b']},{id:'b',title:'B',after:['a']}],
    [{id:'a',title:'A',after:['missing']}], [{id:'a',title:'A',after:['a']}],
    [{id:'a',title:'A'},{id:'a',title:'B'}], [{id:'a',title:'A',after:['b','b']},{id:'b',title:'B'}],
  ]) assert.throws(() => parseReviewPlan(invalid))
  assert.throws(() => parseReviewPlan([{id:'a',title:'A',previews:['unknown']}], []))
  const boundary = reviewBoundary({revision:1,plan,pending_plan:null,stages:[{id:'a',status:'available',revision:1,snapshot:null},{id:'c',status:'blocked',revision:1,snapshot:null}]})
  assert.match(boundary, /Work only on these unlocked stages: a\n/)
})

it('keeps newly unlocked work outside the current execution assignment (#818)', () => {
  const plan = parseReviewPlan([{id:'a',title:'A'},{id:'b',title:'B'}])!
  const boundary = reviewBoundary({revision:2,plan,pending_plan:null,stages:plan.map(n=>({id:n.id,status:'available',revision:2,snapshot:null}))}, ['a'])
  assert.match(boundary, /Work only on these unlocked stages: a\n/)
})
