import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, isDelivered } from '../src/rules-corpus.mjs';

// task-82: the conditional-yes rule, pinned where it is BEHAVIOUR rather than documentation.
// A grant has a SUBJECT and often a CONDITION. A grant that reaches the subject of the
// question under a condition is a YES and the answer must state the condition in the same
// sentence, because the condition IS the answer; a grant that reaches a DIFFERENT subject is
// a NO however similar the wording. The prompt carries the rule and a worked pair, the bank
// carries one record with two questions, and the scope decoys carry the honest no.
//
// The prompt is prose, so what a machine can check is narrower and still worth pinning: that
// the rule is stated, that the worked pair names a record whose scope really decides it, that
// the corrected reading of the Kahl pair (the Kahl is a model in the attached unit it leads,
// so its crest reaches it) has not drifted back to the old false one, that the Deathstrike
// instrument error stays fixed, and that every scope decoy names a real record whose scope
// really excludes (or never names) the question's subject.
let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
};
const ok = (name, cond) => t(name, !!cond, true);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES = fs.readFileSync(path.join(ROOT, 'src', 'rules-corpus.mjs'), 'utf8');
const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'rules-capability-questions.json'), 'utf8'));
const all = readAllCorpus();
const byId = new Map(all.map(r => [r.id, r]));
const delivered = new Set(all.filter(isDelivered).map(r => r.id));
const fold = s => String(s).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
const text = id => fold((byId.get(id) || {}).text || '');
const has = (hay, needle) => hay.indexOf(fold(needle).slice(0, 30)) !== -1;

// --- 1. the rule, in the prompt the agent is handed ---------------------------
ok('the prompt states the subject/condition split', /A grant has a SUBJECT and often a CONDITION/.test(RULES));
ok('the prompt says a conditional yes must state the condition', /MUST state the condition in the same sentence/.test(RULES));
ok('and forbids a bare yes for a conditional grant', /Never a bare "Yes" for a conditional grant/.test(RULES));
ok('and refuses a yes whose scope misses the subject', /never a yes when the scope puts the subject outside the grant/.test(RULES));
ok('the prompt keeps the scope-exclusion rule', /scope EXCLUDES the subject cannot support the answer/.test(RULES));
ok('and calls the refusal shape a conditional yes, not a no', /does not turn it into a no/.test(RULES) && /is a conditional YES, and its verdict is "yes", not "no"/.test(RULES));
// The worked pair is what makes the rule concrete. It has to name a record whose scope
// really decides two opposite answers, and it must not be the Kahl, whose crest reaches it.
ok('the prompt carries a worked pair for the different-subject half', /Worked pair for the different-subject half/.test(RULES));
ok('the worked pair names Omnissiah', /Omnissiah/.test(RULES));
ok('and the record it names really carries that scope', has(text('unitrules#000001396'), 'one friendly Astra Militarum Vehicle model'));
// The stale reading that the correction removed: the Kahl was called the bearer and NOT a
// model in the unit it leads. core-rules#Abilities-in-Attached-Units says the opposite.
ok('the old false reading of the Kahl pair is gone', !/not a model in the unit it leads/.test(RULES) && !/Kahl is the bearer, not/.test(RULES));
ok('the prompt still calls the Kahl case a conditional yes', /CONDITIONAL YES/.test(RULES));
ok('and the bank note no longer carries the old reading', !/not a model in the unit it leads/.test(bank.note));
ok('the bank note still states the conditional-yes semantics', /CONDITIONAL-YES SEMANTICS/.test(bank.note) && /condition is the answer/.test(bank.note));

// --- 2. the pair: one record, two questions, both conditional yeses -----------
const five = bank.questions.find(q => /Can a Kahl have an invulnerable save/.test(q.q));
const six = bank.questions.find(q => /unit led by a K[\u00e2a]hl/.test(q.q));
ok('case 5 and case 6 are both in the bank', !!five && !!six);
ok('they rest on the same record', !!six && (six.answer || []).indexOf('unitrules#000002594~3') !== -1);
ok('and both are yes, not the old opposite pair', !!five && !!six && five.yes === true && six.yes === true);
ok('case 5 records its confound (the Kahl datasheet carries inv 4+)', !!five && /CONFOUNDED/.test(five.reason) && /inv 4\+/.test(five.reason));
ok("and the crest record really says 'while this model is leading a unit'", has(text('unitrules#000002594~3'), 'While this model is leading a unit,'));
ok('the attached-units rule that decides it is in the corpus', has(text('core-rules#Abilities-in-Attached-Units'), 'apply to every model in an attached unit'));

// --- 3. the Deathstrike instrument error, both halves -------------------------
const moved = bank.questions.find(q => /Deathstrike fire its Deathstrike missile after it moved/.test(q.q));
const advanced = bank.questions.find(q => /Deathstrike shoot in a turn in which it Advanced/.test(q.q));
ok('the moved-Deathstrike question now names the missile', !!moved && moved.yes === false);
ok('and it records that the older question was a bank error', !!moved && /BANK ERROR/.test(moved.reason));
ok('the Advanced question keeps its no', !!advanced && advanced.yes === false);
ok('and its reason is the shooting-type rule, not the missile restriction', !!advanced && /NORMAL SHOOTING/.test(advanced.reason) && /ASSAULT SHOOTING/.test(advanced.reason));
ok('normal shooting really requires no advance move', has(text('core-rules#Shooting-Phase->-3.-End-of-Shooting-Phase->-NORMAL-SHOOTING'), 'did not make an advance move this turn'));
ok('and the missile restriction is really about the weapon', has(text('unitrules#000000699'), 'only if it Remained Stationary this turn'));

// --- 4. the scope decoys: a real record granting the capability elsewhere -----
// Each entry is one new task-82 decoy: an honest no whose decoy is a real delivered record,
// and a SUBJECT that really sits outside the decoy's grant - the keyword is absent from the
// subject, or the record's own clause excludes it.
const DECOYS = [
  {
    name: 'the Enginseer aura reaches Vehicle models, not an Infantry squad',
    re: /Cadian Shock Troops squad[\s\S]*Enginseer/,
    decoy: 'unitrules#000001396',
    subject: 'unitrules#000002612',
    keyword: 'VEHICLE',
    excluded: false,
  },
  {
    name: 'Abaddon aura excludes DAMNED units, and Accursed Cultists are Damned',
    re: /Accursed Cultists unit[\s\S]*Abaddon/,
    decoy: 'unitrules#000000924~2',
    subject: 'unitrules#000002571~1',
    keyword: 'Damned',
    excluded: true,
  },
  {
    name: 'Firing Deck belongs to the transport that grants it, not a Land Raider',
    re: /embarked within a Land Raider/,
    decoy: 'unitrules#000002541~1',
    subject: 'unitrules#000000065~1',
    keyword: 'Firing Deck',
    excluded: false,
  },
];
for (const d of DECOYS) {
  const q = bank.questions.find(x => d.re.test(x.q));
  ok('the decoy case exists: ' + d.name, !!q);
  if (!q) continue;
  ok('  it is an honest no with no answer record: ' + d.name, q.yes === false && !(q.answer || []).length);
  ok('  it names a real delivered decoy: ' + d.name, (q.decoy || []).indexOf(d.decoy) !== -1 && delivered.has(d.decoy));
  ok('  its scope phrase is in that decoy: ' + d.name, has(text(d.decoy), q.scope));
  ok('  it is labelled a scope split: ' + d.name, /scope split/.test(q.reason || ''));
  const esc = d.keyword.toLowerCase().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const holds = new RegExp('\\b' + esc + '\\b').test(text(d.subject));
  ok((d.excluded ? '  and the subject carries the keyword the scope excludes: ' : '  and the subject lacks the keyword the scope names: ') + d.name, d.excluded ? holds : !holds);
}
ok('the bank keeps at least five scope decoys that reach another subject', bank.questions.filter(q => q.yes === false && (q.decoy || []).length && /scope split/.test(q.reason || '')).length >= 5);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
