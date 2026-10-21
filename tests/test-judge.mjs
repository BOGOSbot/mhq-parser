import fs from 'node:fs';
import {
  ASK_MODES, ESCALATION_TOPKS, MAX_PASSES, WIDEN_ADD, answerableFindings, askMode, dontKnowAnswer, entityAnchors, isCapabilityQuestion, judgePrompt, judgeStrength, normalizeConfidence, normalizeVerdict, normalizeWiden, parseJsonObject, reconcileVerdicts, scopeFacts, scopeLines, termCount, termPresent, widenPlan, writerEnabled,
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

// --- the two settings ---------------------------------------------------------
// Fast and deep differ in four measured ways at once: how deep the first pass
// looks, how many times a miss widens it, how wide the reranker's net is, and
// whether the judge reasons. The judge's reasoning is the one that moves the
// clock (79.4% -> 61.8% on the real bank when it is turned off).
// FAST is the default now: every caller that does not say otherwise gets it, and
// deep is reached by asking for it. The measurements in the docs were taken in
// deep mode and stay labelled that way - this changes what runs, not what was
// recorded.
t('fast is a setting', askMode('fast'), 'fast');
t('deep is a setting', askMode('deep'), 'deep');
t('the setting is case-insensitive', askMode('FAST'), 'fast');
t('a missing setting is the default, and the default is FAST', askMode(undefined), 'fast');
t('an unknown setting falls back to the default too, not to an error', askMode('turbo'), 'fast');
t('an empty setting is the default', askMode(''), 'fast');
t('fast turns the judge reasoning off', ASK_MODES.fast.reasoning, 'none');
t('deep lets the judge reason', ASK_MODES.deep.reasoning, 'medium');
t('fast looks shallower', ASK_MODES.fast.first < ASK_MODES.deep.first, true);
t('fast widens fewer times', ASK_MODES.fast.passes < ASK_MODES.deep.passes, true);
t('fast gives the reranker a smaller net', ASK_MODES.fast.jevMax < ASK_MODES.deep.jevMax, true);
// Both judges always run, and they are always two different settings: the one
// the reader picked gates the prose, the other is the second opinion.
t('fast mode pairs its quick judge with the thinking one', ASK_MODES.fast.second, 'medium');
t('deep mode pairs its thinking judge with the quick one', ASK_MODES.deep.second, 'none');
t('the two judges never run the same setting', ASK_MODES.fast.reasoning !== ASK_MODES.fast.second && ASK_MODES.deep.reasoning !== ASK_MODES.deep.second, true);

// --- the writer switch --------------------------------------------------------
// The writer - the "answer" call - is OFF by default: the findings, the judge,
// the citations and the marks are the run's product. The path is kept because the
// format is going into the judge, so the switch has to work in both directions.
t('the writer is off by default', writerEnabled({}), false);
t('a deployment can turn it on', writerEnabled({ RULES_WRITER: '1' }), true);
t('and off again in writing', [writerEnabled({ RULES_WRITER: 'on' }), writerEnabled({ RULES_WRITER: 'no' })], [true, false]);
t('an unknown env value is off, never a surprise call', writerEnabled({ RULES_WRITER: 'maybe' }), false);
t('the request can ask for it', writerEnabled({}, true), true);
t('and the request beats the environment, both ways', [writerEnabled({ RULES_WRITER: '1' }, false), writerEnabled({}, 'true')], [false, true]);

// --- two verdicts on the same findings --------------------------------------
// A refusal downgrades the answer only when it comes from a judge at least as
// reliable as the one that answered. Reasoning off measured 61.8% against
// reasoning on 79.4%, so the quick judge does not hold a veto over the careful
// one - but the careful judge keeps its veto over the quick one.
// task-71: the verdict field, folded to three values. A model reaches for its own language
// and for synonyms, and an unknown value must arrive as NO verdict rather than a wrong one.
t('yes', normalizeVerdict('yes'), 'yes');
t('oui is yes', normalizeVerdict('OUI'), 'yes');
t('true is yes', normalizeVerdict('true'), 'yes');
t('no', normalizeVerdict('no'), 'no');
t('non is no', normalizeVerdict('non'), 'no');
t('false is no', normalizeVerdict('false'), 'no');
t('unclear', normalizeVerdict('unclear'), 'unclear');
t('incertain is unclear', normalizeVerdict('incertain'), 'unclear');
t('anything else is no verdict at all', normalizeVerdict('probably'), '');
t('and an empty field is no verdict', normalizeVerdict(null), '');
t('reasoning off is the weak setting', judgeStrength('none'), 0);
t('reasoning on is the strong setting', judgeStrength('medium'), 1);
t('high is no stronger than medium', judgeStrength('high'), 1);
t('an unknown setting ranks as the equal of anything', judgeStrength(''), 1);

const AGREE = { disagreement: false, conservative: 'binding', downgrade: false, dissenter: '', polar: false };
// task-71: TWO JUDGES THAT BOTH ANSWERED CAN STILL DISAGREE, and that is the case Mandal
// reported - judge 1 'does not have it by default, but can gain it', judge 2 'yes, a
// Baneblade can have one' - which the old answered-only comparison recorded as agreement.
// The verdict field is what they are compared on now, and the stronger judge's answer takes
// the headline: the reasoning judge was the one that found the Enginseer.
const POLAR = { disagreement: true, conservative: 'binding', downgrade: false, dissenter: 'second', polar: true };
t('a yes and a no are a polar disagreement', reconcileVerdicts({ answered: true, verdict: 'yes', reasoning: 'medium' }, { answered: true, verdict: 'no', reasoning: 'none' }), POLAR);
t('and the stronger judge takes the headline', reconcileVerdicts({ answered: true, verdict: 'no', reasoning: 'none' }, { answered: true, verdict: 'yes', reasoning: 'medium' }).conservative, 'second');
t('the weaker judge is the dissenter in that direction', reconcileVerdicts({ answered: true, verdict: 'no', reasoning: 'none' }, { answered: true, verdict: 'yes', reasoning: 'medium' }).dissenter, 'binding');
t('two yeses are still agreement', reconcileVerdicts({ answered: true, verdict: 'yes', reasoning: 'medium' }, { answered: true, verdict: 'yes', reasoning: 'none' }).disagreement, false);
// 'unclear' is the judge saying it cannot commit: it is not a polarity, so it is not a
// polar disagreement. It is not silence either, so it still cannot be read as agreement.
t('an unclear verdict is not a polar disagreement', reconcileVerdicts({ answered: true, verdict: 'yes', reasoning: 'medium' }, { answered: true, verdict: 'unclear', reasoning: 'none' }).polar, false);
t('and it raises no disagreement at all', reconcileVerdicts({ answered: true, verdict: 'yes', reasoning: 'medium' }, { answered: true, verdict: 'unclear', reasoning: 'none' }).disagreement, false);
t('two answers with no verdict are not compared', reconcileVerdicts({ answered: true, reasoning: 'medium' }, { answered: true, reasoning: 'none' }).disagreement, false);
t('a refusal has no polarity to disagree with', reconcileVerdicts({ answered: false, verdict: '', reasoning: 'medium' }, { answered: true, verdict: 'yes', reasoning: 'none' }).polar, false);
t('two yeses agree', reconcileVerdicts({ answered: true, reasoning: 'medium' }, { answered: true, reasoning: 'none' }), AGREE);
t('two nos agree', reconcileVerdicts({ answered: false, reasoning: 'none' }, { answered: false, reasoning: 'medium' }), AGREE);
t('an unparseable verdict raises no disagreement', reconcileVerdicts({ answered: null }, { answered: true }), AGREE);
t('a missing second verdict raises no disagreement', reconcileVerdicts({ answered: true }, null), AGREE);

// FAST MODE: the binding judge is quick, the second is the careful one, so the
// careful refusal downgrades the answer. This is the case the rule was written
// for and it must not regress.
t('fast mode: the careful second judge keeps its veto', reconcileVerdicts({ answered: true, reasoning: 'none' }, { answered: false, reasoning: 'medium' }), { disagreement: true, conservative: 'second', downgrade: true, dissenter: 'second', polar: false });
t('an equal second judge downgrades too', reconcileVerdicts({ answered: true, reasoning: 'medium' }, { answered: false, reasoning: 'medium' }), { disagreement: true, conservative: 'second', downgrade: true, dissenter: 'second', polar: false });
t('an unknown setting can still downgrade', reconcileVerdicts({ answered: true, reasoning: 'medium' }, { answered: false, reasoning: '' }), { disagreement: true, conservative: 'second', downgrade: true, dissenter: 'second', polar: false });

// DEEP MODE, the exact case from the task-13 screenshot: the careful judge
// answered correctly and the quick one refused. It is a dissent, not a verdict:
// the answer is NOT stamped 'not confirmed'.
t('deep mode: the quick judge does not veto the careful one', reconcileVerdicts({ answered: true, reasoning: 'medium' }, { answered: false, reasoning: 'none' }), { disagreement: true, conservative: 'binding', downgrade: false, dissenter: 'second', polar: false });
t('the weaker dissent is still recorded as a disagreement', reconcileVerdicts({ answered: true, reasoning: 'high' }, { answered: false, reasoning: 'none' }).disagreement, true);
t('and the dissenter is named', reconcileVerdicts({ answered: true, reasoning: 'medium' }, { answered: false, reasoning: 'none' }).dissenter, 'second');

// The other direction: the binding judge refused, so the cautious answer already
// stands and there is nothing to downgrade. The second judge's willingness to
// answer is reported, and cannot upgrade a refusal.
t('the first refusing keeps the binding when the second would answer', reconcileVerdicts({ answered: false, reasoning: 'medium' }, { answered: true, reasoning: 'none' }), { disagreement: true, conservative: 'binding', downgrade: false, dissenter: 'binding', polar: false });
t('a careful second cannot upgrade a quick refusal either', reconcileVerdicts({ answered: false, reasoning: 'none' }, { answered: true, reasoning: 'medium' }), { disagreement: true, conservative: 'binding', downgrade: false, dissenter: 'binding', polar: false });

// --- the verdict follows the reader's language ------------------------------
// The passages are the corpus's English and stay that way; the verdict is a
// model call read by the reader, so it is asked in the page's language.
const passages = [{ set: 'rules', heading: 'Fall Back', text: 'Until the end of the turn, unless otherwise stated, your unit is not eligible to shoot.' }];
const promptEn = judgePrompt('a question', passages);
const promptFr = judgePrompt('a question', passages, { lang: 'fr' });
t('the English prompt asks for the verdict in English', /it is shown to the reader in full, so do not trail off\./.test(promptEn), true);
t('the French prompt asks for the verdict in French', /in French/.test(promptFr), true);
t('the French prompt says it in the schema as well', /"why": "la raison/.test(promptFr), true);
t('and gives it its own line', /The "why", "answer", "quote", "exceptions" and "missing" fields are written in French/.test(promptFr), true);
t('the English prompt still carries the English schema', /"why": "the reason, in two or three sentences"/.test(promptEn), true);
t('the French prompt keeps the passages untouched', promptFr.indexOf('Until the end of the turn') !== -1, true);




// --- task-70: the mechanical join --------------------------------------------
// The leg has already computed that the Enginseer's record reaches a VEHICLE and that the
// Baneblade carries VEHICLE. The judge was asked to re-derive that from prose and got it
// wrong even when it wrote the right sentence ('it can only gain one if another rule, such
// as Omnissiah's Blessing from a Tech-Priest Enginseer, grants it to it' -> answered NO).
// The fact is now stated beside the passages.
{
  const q = 'Can a baneblade have an invulnerable save?';
  const eng = { n: 8, id: 'unitrules#000001396', scopeKeys: ['ASTRA', 'MILITARUM', 'VEHICLE'], subjectKeys: ['ASTRA MILITARUM'], carriesQuestion: true, text: 'Omnissiah\u2019s Blessing: that VEHICLE model has a 4+ invulnerable save' };
  const list = { n: 9, id: 'unitrules#000000702', scopeKeys: ['ASTRA', 'MILITARUM'], subjectKeys: ['ASTRA MILITARUM'], carriesQuestion: true, text: 'Baneblade Keywords Astra Militarum Vehicle Save 2+' };
  const unrelated = { n: 3, id: 'core-rules#x', scopeKeys: [], subjectKeys: [], carriesQuestion: false, text: 'nothing' };
  const facts = scopeFacts([eng, list, unrelated], q);
  t('a record the leg matched, that carries the question, is stated', facts.some(f => f.id === 'unitrules#000001396'), true);
  t('a record that does not say the thing is not stated as applying', !facts.some(f => f.id === 'unitrules#000000702'), true);
  t('a record the leg did not match is not stated at all', !facts.some(f => f.id === 'core-rules#x'), true);
  t('a non-capability question gets no facts', scopeFacts([eng], 'What does a Baneblade do?').length, 0);
  const lines = scopeLines(facts).join('\n');
  t('the line names the passage, the record and the keyword', /passage 8 \(unitrules#000001396\) is scoped to ASTRA MILITARUM VEHICLE/.test(lines), true);
  t('and it says the subject carries the keyword', /the subject of the question carries ASTRA MILITARUM/.test(lines), true);
  t('and it leaves what the record grants to the judge', /It is still for you to read what that record grants/.test(lines), true);
  t('no facts means no block at all', scopeLines([]).length, 0);
  const prompt = judgePrompt(q, [eng, list], { scoped: true, scopeFacts: facts });
  t('the fact reaches the judge prompt', /is scoped to ASTRA MILITARUM VEHICLE/.test(prompt), true);
  t('the prompt without facts is the old prompt', /scope check has already been run/.test(judgePrompt(q, [eng, list], { scoped: true })), false);
}

// --- task-59: the applicability check ----------------------------------------
// The judge is given the Enginseer's record (a Vehicle gets a 4+ invulnerable save) and
// the Baneblade's own keyword list (Astra Militarum, Vehicle, Titanic, ...) and answered
// no without joining them - two yes and four no across six runs on the same passages.
// The check makes it state each record's scope and whether the subject is inside it, and
// forbids the hedge that turns a good yes into 'no general answer is given'.
{
  const p = [{ set: 'factions', heading: 'Baneblade', text: 'Keywords: Astra Militarum, Vehicle' }];
  const s = judgePrompt('Can a baneblade have an invulnerable save?', p, {});
  t('the prompt says a record that states a rule may not apply', /A record that states a rule is not yet a record that APPLIES/.test(s), true);
  t('it asks for the scope and the subject\u2019s membership', /state that scope in "why" and say whether the SUBJECT of the question is inside it/.test(s), true);
  t('it names the keyword join', /the record APPLIES and the answer is what it says/.test(s), true);
  t('it says an excluding scope cannot support the answer', /A record whose scope EXCLUDES the subject cannot support the answer/.test(s), true);
  t('and it forbids the hedge the check could become', /Do not answer "no general answer is given" or "it depends" when a record in front of you applies/.test(s), true);
  t('the applicability rule is on every prompt, not only capability ones', /A record that states a rule is not yet a record that APPLIES/.test(judgePrompt('How many points does a Space Marine Captain cost?', p, {})), true);
}

// --- task-56: the scope of a negative ---------------------------------------
// Mandal's first-day warning, measured on the Box: 'Can a baneblade have an
// invulnerable save?' was answered 'No, a Baneblade does not have an invulnerable
// save' from the datasheet's statline. A datasheet cannot show that nothing else
// grants one, and the corpus holds the Tech-Priest Enginseer's Omnissiah's Blessing
// (an ASTRA MILITARUM VEHICLE gets a 4+ invulnerable save, and a Baneblade is one).
// The rule is task-51's absence copy applied to the verdict: a no is a claim about
// the records the judge was shown, never about the corpus.
t('a capability question is recognised', isCapabilityQuestion('Can a baneblade have an invulnerable save?'), true);
t('a permission question is too', isCapabilityQuestion('Can I shoot into a melee that my own unit is in?'), true);
t('and a plain what-does-it-do question is not', isCapabilityQuestion('What does the Advance move do?'), false);
t('nor is a how-many question', isCapabilityQuestion('How many points does a Space Marine Captain cost?'), false);
t('a does-it-have question is one', isCapabilityQuestion('Does armour of contempt have a rule for a 2+ save?'), true);
t('a does-it-work question is one on its verb', isCapabilityQuestion('Does armour of contempt work on a 2+ save in 11th edition?'), false);
t('and the bank question it comes from is caught by can', isCapabilityQuestion('Can a monster or vehicle shoot while it is stuck in combat?'), true);
t('the predicate is case-insensitive', isCapabilityQuestion('CAN A BANEBLADE HAVE AN INVULNERABLE SAVE?'), true);
t('nothing is not a capability question', isCapabilityQuestion(''), false);
const capPassages = [{ set: 'factions', heading: 'Baneblade', text: 'Model Baneblade: M 12" T 13 Sv 2+ W 24 Ld 7+ OC 8' }];
const capPlain = judgePrompt('Can a baneblade have an invulnerable save?', capPassages);
const capScoped = judgePrompt('Can a baneblade have an invulnerable save?', capPassages, { scoped: true });
t('the ordinary prompt does not carry the scope rule', /scoped to what you were shown/.test(capPlain), false);
t('the scoped prompt does', /This question asks whether something is possible or permitted/.test(capScoped), true);
t('and it names the wording to use', /none of the records I was given grants/.test(capScoped), true);
t('it forbids a claim about what the unit has', /must never state what a unit has or does not have/.test(capScoped), true);
t('it says a datasheet is not evidence about the rest', /it is not evidence about what an army rule, a stratagem or another unit can grant/.test(capScoped), true);
t('it still demands a yes when a record grants it', /Answer yes outright when one of the records grants it/.test(capScoped), true);
t('it asks what would settle the question instead of asserting absence', /name the kind of record that would settle it if it exists/.test(capScoped), true);
t('it says the answer usually hangs on a keyword', /usually names a KEYWORD/.test(capScoped), true);
t('and it refuses to soften the scoped no into vagueness', /it is not a hedge and it must not be softened into vagueness/.test(capScoped), true);
t('the scope rule is added, never swapped in: the rest of the prompt is intact', capScoped.indexOf('Judge only what is written above') !== -1 && capScoped.indexOf('"why": "the reason, in two or three sentences"') !== -1, true);
t('the passages are untouched by the scope rule', capScoped.indexOf('Sv 2+') !== -1, true);
// The scope travels with the QUESTION, not with the caller: the page, the CLI and
// the sweep all ask the same question and must all get the same discipline.
{
  const src = fs.readFileSync(new URL('../src/rules-corpus.mjs', import.meta.url), 'utf8');
  t('the judge call reads the question for the scope', /const scoped = o\.scoped === undefined \? isCapabilityQuestion\(question\) : o\.scoped === true;/.test(src), true);
  // task-70: the same call now also carries the scope leg's facts, so the pattern reads
  // for the three things it must pass and not for the exact literal it used to be.
  t('and passes it into the prompt', /judgePrompt\(question, passages, Object\.assign\(\{\}, o, \{ manifest: manifest \|\| \[\], scoped, scopeFacts: facts \}\)\)/.test(src), true);
}

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
