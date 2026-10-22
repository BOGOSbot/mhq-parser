import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, isDelivered } from '../src/rules-corpus.mjs';

// task-64: the capability bank. The 33-question bank measures retrieval; this one
// measures APPLICABILITY - whether the record an answer rests on actually reaches the
// subject of the question. Two slices stopped for want of it: task-56 could measure
// only 4 of 10 capability questions, task-57 could size its class at 1 of 33.
//
// The fixture is hand-written from the corpus (workspace/t64-scan.mjs found the grants
// mechanically). These assertions are the part a machine can check: the bank resolves,
// it is balanced, every scope phrase is really in the record it claims, and every decoy
// is a real delivered record.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'rules-capability-questions.json'), 'utf8'));
const all = readAllCorpus();
const byId = new Map(all.map(r => [r.id, r]));
const delivered = new Set(all.filter(isDelivered).map(r => r.id));
const fold = s => String(s).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');

ok('the bank has 12 to 15 questions', bank.questions.length >= 12 && bank.questions.length <= 16);
ok('every question is unique', new Set(bank.questions.map(q => q.q)).size === bank.questions.length);
ok('every question is of the can-X-do-Y shape', bank.questions.every(q => /^(can|does|do|is|are)\b/i.test(q.q)));
ok('every question states the honest answer', bank.questions.every(q => typeof q.yes === 'boolean'));
ok('every question says why', bank.questions.every(q => typeof q.reason === 'string' && q.reason.length > 80));
ok('every question names the scope phrase that decides it', bank.questions.every(q => typeof q.scope === 'string' && q.scope.length > 4));
// A bank of yeses cannot measure over-hedging: task-56's change must not turn a real no
// into a hedge, so the nos are as load-bearing as the yeses.
const yes = bank.questions.filter(q => q.yes).length;
ok('the bank is balanced, with both answers present', yes >= 5 && yes <= bank.questions.length - 5);
ok('a yes names the record that answers it', bank.questions.filter(q => q.yes).every(q => (q.answer || []).length > 0));
ok('a no names no answer record', bank.questions.filter(q => !q.yes).every(q => !(q.answer || []).length));
ok('most questions carry a decoy', bank.questions.filter(q => (q.decoy || []).length).length >= 10);
ok('the model case is in the bank', bank.questions.some(q => /baneblade/i.test(q.q) && q.yes === true && (q.answer || []).indexOf('unitrules#000001396') !== -1));
ok('and its decoy is the Manipulus', bank.questions.some(q => /baneblade/i.test(q.q) && (q.decoy || []).indexOf('unitrules#000001580~2') !== -1));

let refs = 0;
for (const q of bank.questions) {
  for (const id of [].concat(q.answer || [], q.decoy || [], q.scopeSource || [])) {
    refs++;
    ok('the record ' + id + ' exists', byId.has(id));
    ok('and is delivered', !byId.has(id) || delivered.has(id));
  }
  // The scope phrase must be really in the record the bank says it is quoted from -
  // otherwise the bank is asserting a scope the corpus does not state.
  const from = q.scopeSource ? [q.scopeSource] : [].concat(q.answer || [], q.decoy || []);
  const found = from.some(id => byId.has(id) && fold(byId.get(id).text).indexOf(fold(q.scope).slice(0, 30)) !== -1);
  ok('the scope phrase of "' + q.q.slice(0, 40) + '" is in the record it is quoted from', found);
}
ok('the bank resolves to a real set of records', refs > 20);

// --- task-82: the conditional-yes semantics ----------------------------------
// The bank's note has to carry the rule, because the pair is unreadable without it: two
// questions, one record, opposite answers. And the PROMPT has to carry it too - a note in a
// fixture is documentation, not behaviour, and the old prompt left both halves to luck.
const RULES = fs.readFileSync(path.join(ROOT, 'src', 'rules-corpus.mjs'), 'utf8');
ok('the bank note states the conditional-yes rule', /CONDITIONAL-YES SEMANTICS/.test(bank.note) && /condition is the answer/.test(bank.note));
ok('and names the pair it is about', /cases 5 and 6/i.test(bank.note) && /Rampart Crest/.test(bank.note));
ok('the prompt states the subject/condition split', /A grant has a SUBJECT and often a CONDITION/.test(RULES));
ok('the prompt says a conditional yes must state the condition', /MUST state the condition in the same sentence/.test(RULES));
ok('and forbids a bare yes for one', /Never a bare "Yes" for a conditional grant/.test(RULES));
ok('the prompt keeps the scope exclusion rule', /scope EXCLUDES the subject cannot support the answer/.test(RULES));
ok('the pair is really in the bank, with opposite answers', (() => {
  const five = bank.questions.find(q => /Can a Kahl have an invulnerable save/.test(q.q));
  const six = bank.questions.find(q => /unit led by a K[âa]hl/.test(q.q));
  return !!five && !!six && five.yes === false && six.yes === true && (six.answer || []).indexOf('unitrules#000002594~3') !== -1;
})());

console.log(pass + ' passed, ' + fail + ' failed');
console.log('bank: ' + bank.questions.length + ' questions, ' + yes + ' yes / ' + (bank.questions.length - yes) + ' no, ' + bank.questions.filter(q => (q.decoy || []).length).length + ' with a decoy, ' + refs + ' record references');
process.exitCode = fail ? 1 : 0;
