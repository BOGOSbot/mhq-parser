import fs from 'node:fs';
import { expectGroups, groupSatisfied, missingGroupLine, missingGroups, partialHeadline, satisfiedGroups } from './expectation-groups.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// --- both shapes are accepted, so the bank migrates one entry at a time ------
t('a plain list is one group per id', expectGroups(['a', 'b']), [['a'], ['b']]);
t('a nested list is the groups as written', expectGroups([['a', 'b'], ['c']]), [['a', 'b'], ['c']]);
t('a mixed entry reads a string as a group of one', expectGroups([['a', 'b'], 'c']), [['a', 'b'], ['c']]);
t('a singleton group stays a group', expectGroups([['a']]), [['a']]);
t('an empty list names nothing', expectGroups([]), []);
t('a missing list names nothing', expectGroups(undefined), []);
t('an empty group is dropped', expectGroups([[]]), []);
t('empty and non-string members are dropped', expectGroups(['', null, [null, 'a']]), [['a']]);

// --- a group is satisfied by any member; separate groups are separate answers -
t('a group is satisfied by one of its members', groupSatisfied(['a', 'b'], ['b']), true);
t('a group is missing when no member appeared', groupSatisfied(['a', 'b'], ['x']), false);
t('a moved id is not an exact hit', groupSatisfied(['a'], ['a->-CHILD']), false);
t('but it satisfies the group on the reachable reading', groupSatisfied(['a'], ['a->-CHILD'], true), true);
t('a legacy pair is two expectations', satisfiedGroups([['a'], ['b']], ['b']).length, 1);
t('a grouped pair is one', satisfiedGroups([['a', 'b']], ['b']), [['a', 'b']]);
t('the missing side names the group not covered', missingGroups([['a', 'b'], ['c']], ['b']), [['c']]);
t('found counts groups, not ids', satisfiedGroups([['a', 'b'], ['c']], ['b', 'c']).length, 2);

// --- the lines the partial block prints --------------------------------------
t('a missing single id is named', missingGroupLine(['unitrules#000002541~2'], []), 'missing: unitrules#000002541~2');
t('a missing group names its alternatives', missingGroupLine(['core-rules#Engagement', 'rules-appendix#What-Is-Engagement'], []), 'missing group: core-rules#Engagement  |  rules-appendix#What-Is-Engagement');
t('a moved alternative is named as reachable', missingGroupLine(['core-rules#Transports->-Disembarking'], ['core-rules#Transports->-Disembarking->-EMERGENCY-DISEMBARK-MOVE']), 'missing: core-rules#Transports->-Disembarking   (reachable as core-rules#Transports->-Disembarking->-EMERGENCY-DISEMBARK-MOVE)');
t('the headline counts groups, not ids', partialHeadline(2, 1, 7, 20), '      expected 2 groups, found 1  (best rank #7)');
t('one group reads in the singular', partialHeadline(1, 0, null, 20), '      expected 1 group, found 0  (nothing in the top 20)');

// --- the bank: the seven merges, and everything else left alone --------------
const BANK = JSON.parse(fs.readFileSync(new URL('./fixtures/rules-questions.json', import.meta.url), 'utf8'));
const entry = q => BANK.questions.find(x => x.q === q);
const merged = [
  ['What is a Desperate Escape test?', ['core-rules#Desperate-Escape-Test', 'core-rules#Desperate-Escape']],
  ['What is Engagement?', ['core-rules#Engagement', 'rules-appendix#What-Is-Engagement']],
  ['When is a unit counted as being in coherency?', ['core-rules#What-Is-Coherency', 'core-rules#Coherency']],
  ['How do I put a unit inside a transport?', ['core-rules#Embarking', 'core-rules#Able-To-Embark']],
  ['Can a monster or vehicle shoot while it is stuck in combat?', ['core-rules#Shooting-at-Engaged-Monsters-and-Vehicles', 'rules-appendix#Shooting-While-Engaged-With-Monsters-Vehicles']],
  ['How close do my models have to stay to each other?', ['core-rules#Coherency', 'core-rules#What-Is-Coherency']],
  ['What happens to units left in strategic reserves when the battle ends?', ['core-rules#Strategic-Reserves-at-the-End-of-the-Battle', 'rules-appendix#Strategic-Reserves-at-the-End-of-the-Battle']],
];
for (const [q, members] of merged) {
  const e = entry(q);
  t('one group: ' + q, e ? expectGroups(e.expect).map(g => g.slice().sort()) : null, [members.slice().sort()]);
}
// A hop is not an alternative: every other multi-id entry stays one group per id.
const separate = BANK.questions.filter(q => (q.expect || []).length > 1 && !merged.some(m => m[0] === q.q));
t('every other multi-id entry stays one group per id', separate.every(q => expectGroups(q.expect).every(g => g.length === 1)), true);
t('and none of them was nested', separate.every(q => q.expect.every(e => typeof e === 'string')), true);
t('the bank still has multi-id entries kept separate', separate.length > 8, true);

// The two false partials the grouping exists for: the record the reader has is
// the alternative, so the group is covered and the entry stops reading as a miss.
t('the transport group is covered by its alternative', missingGroups(expectGroups(entry('How do I put a unit inside a transport?').expect), ['core-rules#Able-To-Embark']).length, 0);
t('the coherency group is covered by its alternative', missingGroups(expectGroups(entry('How close do my models have to stay to each other?').expect), ['core-rules#What-Is-Coherency']).length, 0);
t('a real hop is still partial when one answer is missing', missingGroups(expectGroups(entry('Can I shoot into a melee that my own unit is in?').expect), ['core-rules#Engagement']).length, 1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
