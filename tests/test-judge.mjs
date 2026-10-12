import {
  ESCALATION_TOPKS, MAX_PASSES, WIDEN_ADD, answerableFindings, dontKnowAnswer, entityAnchors, normalizeConfidence, normalizeWiden, parseJsonObject, termCount, termPresent, widenPlan,
} from '../src/rules-corpus.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// --- the judge's confidence, which the caller shows and may act on ----------
// The model is asked for one of three words and does not always comply, so the
// spellings it reaches for instead are folded in. An unparseable answer must
// never arrive as certainty.
t('high', normalizeConfidence('high'), 'high');
t('High is case-insensitive', normalizeConfidence('High'), 'high');
t('strong reads as high', normalizeConfidence('strong'), 'high');
t('medium folds to med', normalizeConfidence('medium'), 'med');
t('moderate folds to med', normalizeConfidence('moderate'), 'med');
t('moyen folds to med', normalizeConfidence('moyen'), 'med');
t('low', normalizeConfidence('low'), 'low');
t('unsure reads as low', normalizeConfidence('unsure'), 'low');
t('faible folds to low', normalizeConfidence('faible'), 'low');
t('nonsense is empty, not a level', normalizeConfidence('quite sure actually'), '');
t('missing is empty', normalizeConfidence(undefined), '');
t('null is empty', normalizeConfidence(null), '');

// --- JSON that a small model wrote -------------------------------------------
// The verdict is read out of JSON, and a model that writes a paragraph into a
// string does not always escape the line break in it. That is a parse error, not
// a verdict, so the escaping is repaired instead of the answer discarded.
const LF = String.fromCharCode(10), TAB = String.fromCharCode(9), FENCE = String.fromCharCode(96).repeat(3);
const messy = '{"answered": true, "why": "first line' + LF + 'second line' + TAB + 'and a tab"}';
t('a raw line break inside a string is repaired', parseJsonObject(messy), { answered: true, why: 'first line' + LF + 'second line' + TAB + 'and a tab' });
t('a fenced object is still read', parseJsonObject(FENCE + 'json' + LF + '{"a": 1}' + LF + FENCE), { a: 1 });
t('an unescaped quote is still a failure, not a guess', parseJsonObject('{"why": "a "quoted" word"}'), null);
t('plain text is not an object', parseJsonObject('no object here'), null);

// --- how a search term is matched --------------------------------------------
// At the start of a word, never inside one. The question this exists for is
// 'can Asurmen re-embark after shooting': its terms include both 'embark' and
// 'disembark', and a substring test reads 'embark' inside 'disembark', so the
// Disembarking rule - twice the length of Embarking and full of the longer word
// - outranked the rule the question was asking about. Recall inside a word is
// kept ('move' still matches 'movement' and 'moves').
t('embark is not found inside disembark', termCount('disembark', 'embark'), 0);
t('embark is found at the start of embarked', termCount('once embarked, the unit', 'embark'), 1);
t('every word-start occurrence counts', termCount('embark or embark', 'embark'), 2);
t('a word-start prefix still matches', termCount('movement and moves', 'move'), 2);
t('a mid-word match is not a match', termCount('removes', 'move'), 0);
t('presence reads the same way', termPresent('take a normal move', 'move'), true);
t('presence is false inside another word', termPresent('disembarking', 'embark'), false);

// --- anchoring the rule the question names -----------------------------------
// The reranker is a preference, not a guarantee. Four measured Jev calls put the
// Embarking rule 10th-12th out of eighty candidates for 'can Asurmen re-embark
// after shooting?', so a top-ten cut included it only sometimes - and when it did
// not, the judge was asked to rule on a retrieval that did not contain the rule
// the question is about. Anchoring takes the words the question and its
// translation name, matches them against the first word of a heading, and puts
// those records in front of the judge whatever the reranker thinks. Rarity
// decides: 'embark' anchors before 'shoot', so a common word cannot choose the
// anchor a specific one asked for.
{
  const corpus = [
    { id: 'emb', heading: 'Embarking', text: 'a unit can embark after a normal move' },
    { id: 'emb-child', heading: 'Embarking > Able To Embark', text: 'embark conditions' },
    { id: 'asur', heading: 'Asurmen', text: 'a datasheet for Asurmen' },
    { id: 'normalmove', heading: 'NORMAL MOVE', text: 'normal move rules' },
    { id: 'shoot', heading: 'Shooting', text: 'shooting rules' },
    { id: 'shoot2', heading: 'SNAP SHOOTING', text: 'shooting again' },
    { id: 'using', heading: 'Using Stratagems', text: 'using a stratagem' },
  ];
  t('the rule the question names is anchored', entityAnchors('can asurmen re-embark after shooting', corpus, 2).map(s => s.id), ['asur', 'emb']);
  t('the translation vocabulary anchors too', entityAnchors('can the model do it', corpus, 1, ['embark']).map(s => s.id), ['emb']);
  t('a one-word rule title ranks above a heading that starts with the word', entityAnchors('normal and embark', corpus, 3).map(s => s.id), ['emb', 'emb-child', 'normalmove']);
  t('the question word beats a term the translation added', entityAnchors('can he re-embark', corpus, 1, ['disembark']).map(s => s.id), ['emb']);
  t('a heading whose first word extends the term anchors', entityAnchors('embark rules', corpus, 1).map(s => s.id), ['emb']);
  t('a word inside another word does not anchor', entityAnchors('disembark rules', corpus, 2).map(s => s.id), []);
  t('an anchor word shorter than five letters is ignored', entityAnchors('move rules', corpus, 2).map(s => s.id), []);
  t('nothing to anchor is an empty list', entityAnchors('', corpus, 2), []);
}

// --- which half to widen, and by how much --------------------------------
// The judge names the half that is short. Widening both halves always spends
// half the extra budget on the half that was never going to help.
t('rules is recognised', normalizeWiden('rules'), 'rules');
t('Core Rules is recognised', normalizeWiden('Core Rules'), 'rules');
t('faction is recognised', normalizeWiden('faction'), 'faction');
t('a datasheet answer means the faction half', normalizeWiden('datasheet'), 'faction');
t('both is recognised', normalizeWiden('both'), 'both');
t('an unusable answer widens both', normalizeWiden('banana'), 'both');
t('a missing answer widens both', normalizeWiden(undefined), 'both');

t('naming rules puts all twenty there', widenPlan('rules', 5), { rules: 25, factions: 5, target: 'rules' });
t('naming the faction half puts all twenty there', widenPlan('faction', 5), { rules: 5, factions: 25, target: 'faction' });
t('naming both splits them', widenPlan('both', 5), { rules: 15, factions: 15, target: 'both' });
t('the first pass is ten a side', ESCALATION_TOPKS, [10]);
t('the widening adds twenty', WIDEN_ADD, 20);

// --- the escalation policy --------------------------------------------------
const at = n => ({
  all: Array.from({ length: n }, (_, i) => ({ id: 's' + i, heading: 'H' + i, url: 'u', set: i % 2 ? 'rules' : 'factions', text: 't' })),
  rules: [], factions: [],
});

async function run(judgeFor, opts) {
  const calls = [];
  const plans = [];
  const out = await answerableFindings('a question', {
    retrieve: async (q, plan) => { plans.push(plan); const n = plan.rules + plan.factions; calls.push('retrieve:' + plan.rules + '/' + plan.factions); return at(n); },
    judge: async (q, findings) => { calls.push('judge:' + findings.length); return judgeFor(findings.length); },
    ...(opts || {}),
  });
  return { calls, out, plans };
}

// A verdict on the first pass stops there: widening a search that already
// answered only adds latency and noise.
{
  const r = await run(() => ({ answered: true, confidence: 'high', why: 'stated' }));
  t('a first-pass hit does not widen', r.calls, ['retrieve:10/10', 'judge:20']);
  t('a first-pass hit is resolved', r.out.unresolved, false);
  t('a first-pass hit is not escalated', r.out.escalated, false);
  t('the first-pass confidence survives', r.out.judge.confidence, 'high');
  t('one pass was made', r.plans.length, 1);
}

// A miss widens once, aimed where the judge said, and can still be answered.
{
  const r = await run(n => (n > 20
    ? { answered: true, confidence: 'med', why: 'found wider' }
    : { answered: false, confidence: 'low', widen: 'faction', why: 'no datasheet' }));
  t('the second pass follows the judge', r.plans[1], { rules: 10, factions: 30, target: 'faction' });
  t('twenty more records were searched', (r.plans[1].rules + r.plans[1].factions) - (r.plans[0].rules + r.plans[0].factions), 20);
  t('the widened pass resolves it', r.out.unresolved, false);
  t('the widening is reported', r.out.escalated, true);
  t('the target is recorded', r.out.attempts[0].widen, 'faction');
  t('both attempts are recorded', r.out.attempts.length, 2);
  t('the first attempt is not final', r.out.attempts[0].final, false);
  t('the second attempt is final', r.out.attempts[1].final, true);
  t('the wider findings are the ones kept', r.out.findings.length, 40);
}

// A judge that names the core rules gets the budget there instead.
{
  const r = await run(n => (n > 20 ? { answered: true, confidence: 'med', widen: 'rules' } : { answered: false, confidence: 'low', widen: 'rules' }));
  t('a rules answer widens the rules half', r.plans[1], { rules: 30, factions: 10, target: 'rules' });
}

// A judge that keeps saying no is widened again, not stopped at the second
// look: the third pass is the one that found Embarking on the real question.
// MAX_PASSES is the ceiling, and the last pass is final, so a corpus that really
// does not hold the rule still ends in a refusal rather than prose.
{
  const r = await run(() => ({ answered: false, confidence: 'low', why: 'nothing relevant' }));
  t('each miss widens once more, up to the ceiling', r.calls.length, 6);
  t('three passes were made', r.plans.length, 3);
  t('the second pass deepens both halves', r.plans[1], { rules: 20, factions: 20, target: 'both' });
  t('the third pass deepens again', r.plans[2], { rules: 30, factions: 30, target: 'both' });
  t('the last pass is the last word', r.out.unresolved, true);
  t('the last findings are still returned for display', r.out.findings.length, 60);
  t('the judge says why', r.out.judge.why, 'nothing relevant');
  t('the judge gives a confidence even on a miss', r.out.judge.confidence, 'low');
  t('an unparseable target widens both', r.plans[1].target, 'both');
}

// A number still reads as a depth, so the first plan and the widening agree.
// The widening is cumulative: a second round adds to what the first one asked
// for, it does not restart from the base - a search that widened to 30 and then
// dropped back to 20 would lose the passages it had just reached.
{
  t('a numeric depth widens the named half', widenPlan('rules', 5), { rules: 25, factions: 5, target: 'rules' });
  t('a plan object widens the named half from where it stood', widenPlan('faction', { rules: 10, factions: 30 }), { rules: 10, factions: 50, target: 'faction' });
  t('both from a plan splits the twenty', widenPlan('both', { rules: 30, factions: 30 }), { rules: 40, factions: 40, target: 'both' });
}

// --- what is said when there is no answer -----------------------------------
// It must read as a statement of absence, not as a hedged answer, and it must
// not pretend the search did not happen.
{
  const fr = dontKnowAnswer({ why: 'aucun passage' }, 'fr');
  t('french says it does not know', fr.indexOf('Je ne sais pas') !== -1, true);
  t('french quotes the judge', fr.indexOf('aucun passage') !== -1, true);
  t('french says the search happened', fr.indexOf('cherchée') !== -1, true);
  const en = dontKnowAnswer({ why: 'nothing stated' }, 'en');
  t('english says it does not know', en.indexOf('I do not know') !== -1, true);
  t('english quotes the judge', en.indexOf('nothing stated') !== -1, true);
  t('a missing judge reason is still readable', dontKnowAnswer(null, 'en').indexOf('undefined') === -1, true);
}



console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
