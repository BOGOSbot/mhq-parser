import { readAllCorpus } from '../src/rules-corpus.mjs';
import { updateRuleNumber, wikiTree } from '../src/wiki-toc.mjs';

// task-51: an update names the rule it updates by number ('12.08 - Consolidation
// Move…'), and that number is the join key - the same fold a Q&A gets into the
// section it annotates. A number with no target leaves the update as a visible
// row labelled by the number it names: never dropped, never tucked into a rule
// it does not update.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

// --- the join key --------------------------------------------------------------
t('a numbered update yields its number', updateRuleNumber({ kind: 'rule', heading: '3. End of Charge Phase > FAQ / Errata > 12.08 - Consolidation Move, After Moving Section' }), '12.08');
t('a dotted number is kept whole', updateRuleNumber({ kind: 'rule', heading: 'Muster Armies > Errata > 01.02.06 Splitting Units' }), '01.02.06');
t('a question yields nothing', updateRuleNumber({ kind: 'rule', heading: 'Muster Armies > Errata > Q: can I do this?' }), '');
t('a number that is not at the front yields nothing', updateRuleNumber({ kind: 'rule', heading: 'See also 12.08 for the rule' }), '');

// --- the fold ------------------------------------------------------------------
const all = readAllCorpus();
const tree = wikiTree(all);
const updates = all.filter(r => updateRuleNumber(r));
t('the corpus carries 22 numbered updates', updates.length, 22);
const resolved = updates.filter(u => tree.attachTarget.has(u.id));
const visible = updates.filter(u => !tree.attachTarget.has(u.id));
// task-90: the heading hierarchy is the number's depth now, so one more update's
// heading carries the number its target does. 17 resolve, 5 stay visible.
t('17 of them resolve to the rule they name', resolved.length, 17);
t('and 5 do not, and stay visible', visible.length, 5);
ok('no update is silently unattached', !updates.some(u => tree.unattached.indexOf(u.id) !== -1));
ok('every unresolved update is a row of the tree, labelled by its number', visible.every(u => tree.paths.has(u.id) && /^\d{2}(\.\d{2}){1,2}\b/.test(String(u.heading).split(' > ').pop().trim())));

// The target is the rule with that number, not a neighbour.
// NOTE: the tree TITLES a folded update by its content, not by its number. The
// 13.09 errata shows up as "Change to: 'That model has the INFANTRY/BEASTS/SWARM
// keyword and is within a terrain...'", so a search for '13.09' in the tree finds
// nothing and that is correct - the number lives in the record's ruleId and in
// this test, not in the rendered title. Do not go looking for it.
const sample = updates.find(u => u.id.indexOf('01.02.06') !== -1 && tree.attachTarget.has(u.id));
ok('the 01.02.06 update folds into a rule carrying 01.02.06', !!sample && String((all.find(r => r.id === tree.attachTarget.get(sample.id)) || {}).ruleId) === '01.02.06');
ok('and it is listed on that rule page', !!sample && (tree.attach.get(tree.attachTarget.get(sample.id)) || []).some(a => a.id === sample.id));
t('a Q&A annotation still folds the old way', (function () {
  const ann = all.filter(r => /^Q:/i.test(String(r.heading).split(' > ').pop() || '')).filter(r => tree.attachTarget.has(r.id));
  return ann.length > 0;
})(), true);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
