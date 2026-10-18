import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, writerEnabled } from '../src/rules-corpus.mjs';
import {
  SCHEMA_KEYS, questionRecord, validateRecord, strippedTitle, titleCandidates,
  HOW, normalizeQuestion, labelVote, labelTitle, labelJudge, labelTrace, harvestRow, bankRow, readTraces, yieldReport,
} from '../src/dataset.mjs';

// task-32: one schema for every harvested question, the answer as a field and
// never the label, gold = groups of rule ids where any member satisfies (the
// bank's expect shape), and the labellers in precision order with the judge tier
// marked circular. The bank is the eval split of this schema; traces are train.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus = readAllCorpus();

// --- the schema ---------------------------------------------------------------
const good = questionRecord({ id: 'x/1', q: 'What is a Desperate Escape test?', answer: 'prose', gold: [['a', 'b']], how: 'manual', edition: '11', date: '2026-10-15', source: 'bank', url: '', split: 'eval' });
t('the record carries exactly the schema keys plus provenance', Object.keys(good).sort(), SCHEMA_KEYS.concat(['verifier']).sort());
t('a well-formed record validates', validateRecord(good), []);
ok('a bad how is caught', validateRecord(questionRecord({ how: 'vibes' })).some(p => /bad how/.test(p)));
ok('a bad split is caught', validateRecord({ id: 'x', q: 'q', answer: '', gold: [], how: 'title', edition: '', date: '', source: '', url: '', split: 'test' }).some(p => /bad split/.test(p)));
ok('a judge label cannot be eval', validateRecord(questionRecord({ how: 'judge', split: 'eval', q: 'q' })).some(p => /cannot be eval/.test(p)));
ok('the answer is a field, never the label', 'answer' in good && !SCHEMA_KEYS.includes('label'));

// --- the title tier: suffix stripped, siblings collapsed ----------------------
t('a parenthetical suffix is stripped', strippedTitle('ARMOUR OF CONTEMPT (Imperial Agents)'), 'ARMOUR OF CONTEMPT');
t('a colon suffix is stripped', strippedTitle('Armour of Contempt: the rule'), 'Armour of Contempt');
const sib = titleCandidates([
  { id: 'a#1', heading: 'X > Armour of Contempt (Imperial Agents)', ruleId: '1.1' },
  { id: 'b#2', heading: 'Y > Armour of Contempt (Space Marines)', ruleId: '2.2' },
  { id: 'c#3', heading: 'Z > Movement Phase', ruleId: '' },
]);
t('sibling records collapse into one group', sib.get('Armour of Contempt'), ['a#1', 'b#2']);
ok('a structural heading without a ruleId is not a candidate', !sib.has('Movement Phase'));
t('a name written as the corpus writes it hits', (labelTitle('Use Armour of Contempt in that fight.', sib) || {}).gold, [['a#1', 'b#2']]);
t('lowercase prose does not invent a hit', labelTitle('use armour of contempt there', sib), null);

// --- vote, judge, and the ladder ----------------------------------------------
t('a reader pick becomes gold', (labelVote({ labels: { positive: ['core-rules#X'], negative: [] } }) || {}).gold, [['core-rules#X']]);
t('a thumbs rating is not a passage label', labelVote({ vote: 'up' }), null);
const cited = labelJudge({ answer: 'See [1] and [2].', findings: [{ n: 1, id: 'a' }, { n: 2, id: 'b' }, { n: 3, id: 'c' }] });
t('the answer citations become judge gold', cited.gold, [['a'], ['b']]);
ok('the judge tier is marked circular and not eval-safe', cited.verifier.circular === true && cited.verifier.evalSafe === false);
t('the ladder prefers the reader', (labelTrace({ labels: { positive: ['z'] }, answer: 'ARMOUR OF CONTEMPT (Imperial Agents)' }, sib) || {}).how, 'vote');
const moduleCode = fs.readFileSync(path.join(ROOT, 'src', 'dataset.mjs'), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
ok('no rejected approach was revived', !/shingle|ngram/i.test(moduleCode) && !/function\s+\w*(shingle|ngram)/i.test(moduleCode));

// --- the two splits -----------------------------------------------------------
const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'rules-questions.json'), 'utf8')).questions;
const evalRow = bankRow(bank[0], 0);
t('the bank is the eval split with its expect as gold', [evalRow.split, evalRow.how, evalRow.gold], ['eval', 'manual', bank[0].expect]);
t('a harvest is the train split', harvestRow({ id: 't1', question: 'q', answer: '', findings: [] }, sib).split, 'train');
ok('the bank is curated, not model-labelled', bank.every((q, i) => bankRow(q, i).how === 'manual'));

// --- generated is its own tier, and train-only --------------------------------
ok('generated is a valid tier', HOW.indexOf('generated') !== -1);
const gen = questionRecord({ id: 'g/1', q: 'q', answer: '', gold: [['x']], how: 'generated', split: 'train' });
ok('a generated label validates on train', validateRecord(gen).length === 0);
ok('a generated label cannot be eval', validateRecord(questionRecord({ id: 'g/2', q: 'q', gold: [['x']], how: 'generated', split: 'eval' })).some(p => /generated label cannot be eval/.test(p)));

// --- the yield reports distinct questions, not repeated asks -------------------
t('normalizing collapses case and punctuation', normalizeQuestion('Donne-moi le profil de Fuegan!'), normalizeQuestion('donne moi le profil de fuegan'));
const traces = readTraces();
const rep = yieldReport(traces, corpus);
t('the ladder accounts for every trace', rep.tiers.vote + rep.tiers.title + rep.tiers.judge + rep.tiers.generated + rep.tiers.none, traces.length);
t('the ladder accounts for every distinct question', rep.distinct.vote + rep.distinct.title + rep.distinct.judge + rep.distinct.generated + rep.distinct.none, rep.asks.questions);
ok('distinct questions are fewer than traces here (the duplicates are real)', rep.asks.questions < rep.total && rep.asks.duplicated > 0);
t('every trace is inside a distinct question group', rep.asks.questions + rep.asks.extraTraces, rep.total);
// The live page writes reader labels now, so this is a count, not a fixed zero:
// every trace the reader has labelled must be the vote tier (labelVote reads a
// positive label, never a thumbs rating), and no other trace may claim it.
const readerLabelled = traces.filter(t => t.labels && Array.isArray(t.labels.positive) && t.labels.positive.filter(Boolean).length).length;
t('the reader-labelled traces are the vote tier, and only they', rep.tiers.vote, readerLabelled);
ok('the title tier is the one that scales offline', rep.tiers.title > rep.tiers.vote && rep.tiers.title > 0);
ok('the distinct-level title count is not the trace-level one', rep.distinct.title !== rep.tiers.title);

// --- the none bucket is explained, and it is the writer being off --------------=
ok('the report says why none is large', rep.noneReasons.emptyAnswer > 0 && rep.noneReasons.refusal > 0 && rep.noneReasons.withFindings > 0);
ok('and carries the distinct-level picture', rep.distinctNone.questions > 0 && rep.distinctNone.noAnswerAnywhere > 0 && rep.distinctNone.noAnswerAnywhereWithFindings > 0);
t('the writer is off by default, which is the cause', writerEnabled(undefined, undefined), false);

// --- no dead paths, no unreproducible ratios ----------------------------------
const src = fs.readFileSync(path.join(ROOT, 'src', 'dataset.mjs'), 'utf8');
ok('the comment cites the tracked probe, which exists', src.indexOf('tests/dataset-probe.mjs') !== -1 && fs.existsSync(path.join(ROOT, 'tests', 'dataset-probe.mjs')));
ok('no dead workspace probe path is cited', src.indexOf('workspace/dataset-probe') === -1);
ok('no unreproducible ratio is quoted', src.indexOf('20/68') === -1 && src.indexOf('26/68') === -1);
ok('the stale 50 figure is gone', src.indexOf('fires on 50') === -1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
