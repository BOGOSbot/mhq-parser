import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAllCorpus } from '../src/rules-corpus.mjs';
import { KIND_UNKNOWN, PENDING_LABEL_MAX, PENDING_LABEL_MS, TRACE_RETENTION_MONTHS, answeredTrace, appendTrace, buildTrace, firstPerson, labelsTrace, newTraceId, pendingLabelCount, resetPendingLabels, sweepTraces, takePendingLabels, termMatch, traceCutoff, traceSignals, tracesEnabled, voteTrace, writerMode } from '../src/rules-traces.mjs';
import { classifyTrace, harvestOrder, loadTraces, promotedQuestion, rerankLabels, tracePriority } from './promote-traces.mjs';
import { expectGroups } from './expectation-groups.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// --- the switch --------------------------------------------------------------
// A retention feature that is on by accident is the failure this whole file
// exists to prevent: the reader is owed the line on the page before anything is
// written, so anything that is not an explicit yes is a no.
t('off by default', tracesEnabled({}), false);
t('off for 0', tracesEnabled({ RULES_TRACES: '0' }), false);
t('off for off', tracesEnabled({ RULES_TRACES: 'off' }), false);
t('off for an empty value', tracesEnabled({ RULES_TRACES: '' }), false);
t('off for a stray value', tracesEnabled({ RULES_TRACES: 'maybe' }), false);
t('on for 1', tracesEnabled({ RULES_TRACES: '1' }), true);
t('on for on', tracesEnabled({ RULES_TRACES: 'on' }), true);
t('on for true', tracesEnabled({ RULES_TRACES: 'true' }), true);
t('on for yes', tracesEnabled({ RULES_TRACES: 'yes' }), true);

// --- the id ------------------------------------------------------------------
t('a random 16-hex id', /^[0-9a-f]{16}$/.test(newTraceId()), true);
t('two ids are not the same', newTraceId() === newTraceId(), false);

// --- the shape: a pointer, not the reader ------------------------------------
const finding = {
  n: 1, set: 'rules', source: 'core-rules', ruleId: '18.02', id: 'core-rules#Embarking',
  heading: 'Embarking', excerpt: 'A unit can embark within a TRANSPORT.', text: 'full passage',
};
const trace = buildTrace({
  id: 'deadbeefdeadbeef', at: '2026-10-13T09:00:00.000Z', edition: 'wh40k11ed', corpusAt: '2026-10-13T00:55:31.597Z',
  mode: 'deep', lang: 'fr', question: 'Est-ce que Asurmen peut réembarquer après avoir tiré ?',
  asked: 'Can Asurmen re-embark after shooting?', terms: ['embark', 'shoot'],
  signals: traceSignals('Est-ce que Asurmen peut réembarquer après avoir tiré ?', [finding]),
  counts: { rules: 1, factions: 0 }, findings: [finding],
  judge: { answered: true, confidence: 'high', why: 'Passage [1] says a unit can embark.' },
  answer: 'Oui [1].', steps: [{ name: 'retrieve', ms: 900 }], elapsedMs: 1200,
  unresolved: false, escalated: false, attempts: 1,
});
const keys = [];
(function walk(v) {
  if (Array.isArray(v)) return v.forEach(walk);
  if (v && typeof v === 'object') for (const k of Object.keys(v)) { keys.push(k); walk(v[k]); }
})(trace);
const bad = keys.filter(k => /^(ip|useragent|user_agent|cookie|session|sessionid|account|accountid|address|remoteaddress|headers)$/i.test(k));
t('no identifying key anywhere in the trace', bad, []);
t('the question is kept', trace.question, 'Est-ce que Asurmen peut réembarquer après avoir tiré ?');
t('the English actually searched travels with it', trace.asked, 'Can Asurmen re-embark after shooting?');
t('a finding is a pointer', trace.findings[0], { n: 1, set: 'rules', source: 'core-rules', ruleId: '18.02', id: 'core-rules#Embarking' });
t('no passage text in the trace', JSON.stringify(trace).includes('A unit can embark'), false);
t('no judge why in the trace', JSON.stringify(trace).includes('Passage [1] says'), false);
t('the verdict keeps its answer, confidence and reasoning setting', trace.judge, { answered: true, confidence: 'high', reasoning: '', cited: [] });
t('the answer is kept - the bank grades on it', trace.answer, 'Oui [1].');
t('the corpus build travels with it', trace.corpusAt, '2026-10-13T00:55:31.597Z');
t('kind is unknown, not a guess', trace.kind, KIND_UNKNOWN);
t('the signals travel', trace.signals, { firstPerson: false, termMatch: false, sources: ['core-rules'], halves: ['rules'], rules: 1 });
const plain = buildTrace({ id: 'x', at: '2026-10-13T09:00:00.000Z', question: 'What is Engagement?', signals: traceSignals('What is Engagement?', []), answer: '' });
t('an English question carries no asked', 'asked' in plain, false);

// --- how the writer ended ----------------------------------------------------
// Empty and timeout read the same to a reader and are covered by one sentence on
// the page, but they are different defects: the trace has to say which one, or
// the page's real failure rate is invisible in the data.
t('a real answer is ok', writerMode({ answer: 'A rule [1].' }), 'ok');
t('an empty answer is empty', writerMode({ answer: '' }), 'empty');
t('whitespace is empty too', writerMode({ answer: '   ' }), 'empty');
t('a cut call is a timeout', writerMode({ answer: '', failed: 'timeout' }), 'timeout');
t('a refusal is a decline', writerMode({ answer: 'The findings do not answer this question.', declined: true }), 'declined');
t('the trace carries the mode', buildTrace({ id: 'x', at: '2026-10-01T00:00:00.000Z', question: 'q', signals: traceSignals('q', []), answer: '', failed: 'timeout' }).writer, 'timeout');

// --- two judges, and the disagreement rate they exist to measure -------------
// The second verdict and the flag are the whole measurement: without both in the
// trace, the rate would need the benchmark Mandal does not want yet.
const twoJudges = buildTrace({
  id: 'x', at: '2026-10-01T00:00:00.000Z', question: 'q', signals: traceSignals('q', []),
  answer: 'A rule [1].', judge: { answered: true, confidence: 'high' }, judgeReasoning: 'none',
  judge2: { answered: false, confidence: 'med', reasoning: 'medium' }, judgeDisagreement: true,
  judgeDowngrade: true, judgeDissentFrom: 'second',
});
t('the trace carries the second verdict', twoJudges.judge2, { answered: false, confidence: 'med', reasoning: 'medium' });
t('the trace carries the disagreement flag', twoJudges.judgeDisagreement, true);
t('the binding verdict is unchanged beside it', twoJudges.judge, { answered: true, confidence: 'high', reasoning: 'none', cited: [] });
// Which judge dissented and whether it was allowed to downgrade: the two fields
// task-16's rule is measured from.
t('the dissent and its effect are recorded', [twoJudges.judgeDissentFrom, twoJudges.judgeDowngrade], ['second', true]);
t('a stronger binding makes the quick dissent a non-downgrade', buildTrace({ id: 'x', at: '2026-10-01T00:00:00.000Z', question: 'q', answer: 'a', judge: { answered: true }, judgeReasoning: 'medium', judge2: { answered: false, reasoning: 'none' }, judgeDisagreement: true, judgeDowngrade: false, judgeDissentFrom: 'second' }).judgeDowngrade, false);
t('the reasoning setting of the binding judge is recorded', buildTrace({ id: 'x', at: '2026-10-01T00:00:00.000Z', question: 'q', answer: 'a', judge: { answered: true }, judgeReasoning: 'medium' }).judge.reasoning, 'medium');
const oneJudge = buildTrace({ id: 'x', at: '2026-10-01T00:00:00.000Z', question: 'q', signals: traceSignals('q', []), answer: 'A rule [1].', judge: { answered: true, confidence: 'high' } });
t('a single-judge trace has no second verdict', oneJudge.judge2 === undefined, true);
t('and no disagreement', oneJudge.judgeDisagreement, false);
t('an answered trace is ok', buildTrace({ id: 'x', at: '2026-10-01T00:00:00.000Z', question: 'q', signals: traceSignals('q', []), answer: 'A rule [1].' }).writer, 'ok');

// --- where it is written -----------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-traces-'));
try {
  const file = appendTrace(trace, dir);
  t('one file per month', path.basename(file), '2026-10.ndjson');
  t('one line per question', fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
  t('the line is the trace', JSON.parse(fs.readFileSync(file, 'utf8').trim()).id, 'deadbeefdeadbeef');
  appendTrace(trace, dir);
  t('a second question appends', fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

// --- retention ---------------------------------------------------------------
// Raw traces expire; the bank does not. A promoted question lives in
// tests/fixtures, which is tracked and never swept, so the raw line can go.
t('the window is 12 months', TRACE_RETENTION_MONTHS, 12);
t('the cutoff is 12 months back', new Date(traceCutoff(12, '2026-10-13T00:00:00.000Z')).toISOString().slice(0, 10), '2025-10-13');

const sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-sweep-'));
try {
  appendTrace(buildTrace({ id: 'old', at: '2025-09-01T00:00:00.000Z', question: 'q', signals: traceSignals('q', []), answer: 'a' }), sweepDir);
  appendTrace(buildTrace({ id: 'fresh', at: '2026-10-01T00:00:00.000Z', question: 'q', signals: traceSignals('q', []), answer: 'a' }), sweepDir);
  const dry = sweepTraces({ dir: sweepDir, now: '2026-10-13T00:00:00.000Z', dryRun: true });
  t('a dry run reports the expired line', dry.removed, 1);
  t('a dry run deletes nothing', fs.readdirSync(sweepDir).length, 2);
  const done = sweepTraces({ dir: sweepDir, now: '2026-10-13T00:00:00.000Z' });
  t('the expired line goes', done.removed, 1);
  t('the fresh line stays', done.kept, 1);
  t('the emptied file is removed', fs.existsSync(path.join(sweepDir, '2025-09.ndjson')), false);
  t('the surviving line is the fresh one', JSON.parse(fs.readFileSync(path.join(sweepDir, '2026-10.ndjson'), 'utf8').trim()).id, 'fresh');
} finally { fs.rmSync(sweepDir, { recursive: true, force: true }); }

const undated = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-undated-'));
try {
  fs.writeFileSync(path.join(undated, '2025-01.ndjson'), '{not json at all\n');
  sweepTraces({ dir: undated, now: '2026-10-13T00:00:00.000Z' });
  t('a line that cannot be dated is kept, not deleted', fs.existsSync(path.join(undated, '2025-01.ndjson')), true);
} finally { fs.rmSync(undated, { recursive: true, force: true }); }

// --- the taxonomy, measured rather than assumed ------------------------------
// The bank's labels name the failure mode a question was put IN THE BANK to
// catch, so they are a curation decision, not a property of a question. This
// measures the best derivation available to the server against the bank's own 29
// hand labels; it is why a trace records the signals and leaves kind unknown
// instead of writing a label that would not be comparable to the bank.
const bank = JSON.parse(fs.readFileSync(new URL('./fixtures/rules-questions.json', import.meta.url), 'utf8'));
const all = readAllCorpus();
const byId = new Map(all.map(s => [s.id, s]));
const namedRule = q => /^(what (is|are)|how (does|do))\b/i.test(String(q).trim());
let agree = 0, total = 0, crossCaught = 0, crossHand = 0;
for (const item of bank.questions) {
  // An expectation may be a group of alternatives (same answer in two records);
  // the derivation reads the records the entry names, whichever shape it uses.
  const expIds = expectGroups(item.expect).flat();
  const recs = expIds.map(e => byId.get(e)).filter(Boolean);
  const term = expIds.length ? termMatch(item.q, recs.map(r => r.heading)) : false;
  const first = firstPerson(item.q);
  const nonCore = recs.some(r => r.source !== 'core-rules');
  let guess = 'unknown';
  if (!expIds.length) guess = 'out-of-corpus';
  else if (namedRule(item.q) && term && !first) guess = 'literal';
  else if (first) guess = 'player';
  else if (nonCore && !term) guess = 'cross-source';
  else guess = 'paraphrase';
  total++;
  if (guess === item.kind) agree++;
  if (item.kind === 'cross-source') { crossHand++; if (guess === 'cross-source') crossCaught++; }
}
console.log('taxonomy: best derivation agrees ' + agree + '/' + total + ' with the bank (' + Math.round(agree / total * 1000) / 10 + '%)');
t('the derivation catches none of the bank cross-source questions', crossCaught, 0);
t('the bank has cross-source questions to catch', crossHand > 0, true);
t('the derivation is not good enough to store as the bank label', agree / total < 0.8, true);


// --- the thumb: one vote per trace, written into the record ------------------
const voteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-vote-'));
appendTrace(buildTrace({ id: 'abc12345', at: '2026-10-13T10:00:00.000Z', question: 'q', answer: 'a', judge: { answered: true } }), voteDir);
appendTrace(buildTrace({ id: 'other999', at: '2026-10-13T10:01:00.000Z', question: 'q2', answer: 'a2', judge: { answered: true } }), voteDir);
const reload = () => loadTraces(voteDir).find(x => x.id === 'abc12345');
t('no vote before anyone clicks', reload().vote, undefined);
t('a vote lands in the record it is about', voteTrace('abc12345', 'up', voteDir), true);
t('the record carries it', reload().vote, 'up');
t('a second vote replaces the first', [voteTrace('abc12345', 'down', voteDir), reload().vote], [true, 'down']);
t('one id, one vote', loadTraces(voteDir).filter(x => x.id === 'abc12345').length, 1);
t('the other record is untouched by the vote', loadTraces(voteDir).find(x => x.id === 'other999').vote, undefined);
t('a vote for a swept or unknown question is dropped', voteTrace('nope', 'up', voteDir), false);
t('an invented vote value is refused', voteTrace('abc12345', 'maybe', voteDir), false);
t('and it does not overwrite the real one', reload().vote, 'down');
t('the trace holds no identifier but its random id', Object.keys(reload()).filter(k => /^(ip|useragent|cookie|session|account|address)$/i.test(k)).length, 0);

// --- the pick: an assertion, not the rerank's preference ---------------------
// The reader's explicit 'this passage answered it', or 'none of these', written
// into the trace it names. It is checked against the findings that trace actually
// holds, so it can only name something the reader was shown; one pick per
// question, a second replaces the first; and it is a CANDIDATE, never a label -
// kind stays unknown until a human promotes the trace.
const pickDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-pick-'));
try {
  appendTrace(buildTrace({
    id: 'pickpickpickpick', at: '2026-10-13T11:00:00.000Z', question: 'Can a unit shoot after it Fell Back?',
    answer: 'Yes [1].', judge: { answered: true, passages: [1] },
    findings: [finding, { n: 2, set: 'rules', source: 'core-rules', ruleId: '18.03', id: 'core-rules#Shooting', heading: 'Shooting', excerpt: 'A unit can shoot.' }],
  }), pickDir);
  appendTrace(buildTrace({ id: 'other999', at: '2026-10-13T11:01:00.000Z', question: 'q2', answer: 'a2' }), pickDir);
  const picked = () => loadTraces(pickDir).find(x => x.id === 'pickpickpickpick');
  t('no pick before anyone picks', [picked().answeredBy, picked().answeredNone], [undefined, undefined]);
  t('a pick lands in the record it is about', answeredTrace('pickpickpickpick', { by: 'core-rules#Shooting' }, pickDir), true);
  t('and names the record the reader chose', picked().answeredBy, 'core-rules#Shooting');
  t('the pick is a candidate, never a label', picked().kind, KIND_UNKNOWN);
  t('a second pick replaces the first', [answeredTrace('pickpickpickpick', { by: 'core-rules#Embarking' }, pickDir), picked().answeredBy], [true, 'core-rules#Embarking']);
  t('one pick per question: the replaced one is gone', picked().answeredBy === 'core-rules#Shooting', false);
  t('none of these is its own candidate', [answeredTrace('pickpickpickpick', { none: true }, pickDir), picked().answeredNone, picked().answeredBy], [true, true, undefined]);
  t('a record pick replaces the none', [answeredTrace('pickpickpickpick', { by: 'core-rules#Embarking' }, pickDir), picked().answeredBy, picked().answeredNone], [true, 'core-rules#Embarking', undefined]);
  t('an id that is not one of the findings is refused', answeredTrace('pickpickpickpick', { by: 'core-rules#NotShown' }, pickDir), false);
  t('and the refused pick changes nothing', picked().answeredBy, 'core-rules#Embarking');
  t('an empty pick is refused', answeredTrace('pickpickpickpick', {}, pickDir), false);
  t('a pick for an unknown question is refused', answeredTrace('nope', { none: true }, pickDir), false);
  t('the other record is untouched by the pick', loadTraces(pickDir).find(x => x.id === 'other999').answeredBy, undefined);
  t('the pick adds no identifier either', Object.keys(picked()).filter(k => /^(ip|useragent|cookie|session|account|address)$/i.test(k)).length, 0);
} finally { fs.rmSync(pickDir, { recursive: true, force: true }); }

// --- the rerank labels: the caret a positive, the x a negative ---------------
// The findings are a surface the reader reranks: the green caret says 'this
// record is the answer' (a positive example) and the x says 'not this one' (a
// negative). Both are labelled examples for a record id the reader was actually
// shown, and both go into the SAME trace as the question - the dataset's gold
// slice - which is why the write is the same find-by-id patch as the thumb and
// the pick, and why there is no second store to keep in step.
const labelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-labels-'));
try {
  appendTrace(buildTrace({
    id: 'labellabellabel1', at: '2026-10-13T12:00:00.000Z', question: 'Can a unit shoot after it Fell Back?',
    answer: 'Yes [1].', judge: { answered: true, passages: [1] },
    findings: [finding, { n: 2, set: 'rules', source: 'core-rules', ruleId: '18.03', id: 'core-rules#Shooting', heading: 'Shooting', excerpt: 'A unit can shoot.' }],
  }), labelsDir);
  appendTrace(buildTrace({ id: 'other999', at: '2026-10-13T12:01:00.000Z', question: 'q2', answer: 'a2' }), labelsDir);
  const marked = () => loadTraces(labelsDir).find(x => x.id === 'labellabellabel1');
  t('nothing is marked before the reader taps', marked().labels, undefined);
  t('a caret lands as a positive in the record it is about', labelsTrace('labellabellabel1', { positive: ['core-rules#Shooting'], negative: [] }, labelsDir), true);
  t('and names the record the reader ranked', marked().labels, { positive: ['core-rules#Shooting'], negative: [] });
  t('an x lands as a negative beside the positive', [labelsTrace('labellabellabel1', { positive: ['core-rules#Shooting'], negative: ['core-rules#Embarking'] }, labelsDir), marked().labels], [true, { positive: ['core-rules#Shooting'], negative: ['core-rules#Embarking'] }]);
  t('a second tap replaces the first, like the thumb', [labelsTrace('labellabellabel1', { positive: ['core-rules#Embarking'], negative: [] }, labelsDir), marked().labels], [true, { positive: ['core-rules#Embarking'], negative: [] }]);
  t('a record cannot be both: the caret wins', [labelsTrace('labellabellabel1', { positive: ['core-rules#Shooting'], negative: ['core-rules#Shooting'] }, labelsDir), marked().labels], [true, { positive: ['core-rules#Shooting'], negative: [] }]);
  t('taking every mark back clears the field', [labelsTrace('labellabellabel1', { positive: [], negative: [] }, labelsDir), marked().labels], [true, undefined]);
  t('a record the trace never showed is refused', labelsTrace('labellabellabel1', { positive: ['core-rules#NotShown'], negative: [] }, labelsDir), false);
  t('and the refusal changes nothing', marked().labels, undefined);
  // The trace is not on disk YET: the mark is held for when it lands, not refused.
  t('a mark for a question whose trace has not landed is held', labelsTrace('nope', { positive: ['core-rules#Embarking'], negative: [] }, labelsDir), true);
  resetPendingLabels();
  t('a request that is not a pair of sets is refused', labelsTrace('labellabellabel1', { positive: ['core-rules#Embarking'] }, labelsDir), false);
  t('the other record is untouched', loadTraces(labelsDir).find(x => x.id === 'other999').labels, undefined);
  t('the labels add no identifier either', Object.keys(marked()).filter(k => /^(ip|useragent|cookie|session|account|address)$/i.test(k)).length, 0);
} finally { fs.rmSync(labelsDir, { recursive: true, force: true }); }
t('the harvest shows the marks as + and -', [rerankLabels({ labels: { positive: ['a'], negative: ['b', 'c'] } }), rerankLabels({})], ['+a  -b  -c', '']);

// --- the harvest order, for the promotion path -------------------------------
// The listing a human labels from is ordered by what already carries a signal:
// a thumb down is a reader saying the answer was wrong, a verdict that cited a
// passage is one whose evidence can be checked. The tracing of a cited verdict
// keeps the numbers only - pointers, never the reasoning.
t('a thumbs-down is labelled first', tracePriority({ vote: 'down' }), 0);
t('a cited verdict comes next', tracePriority({ judge: { cited: [1, 2] } }), 1);
t('an older answer with writer markers counts as cited', tracePriority({ answer: 'A rule [1].' }), 1);
t('everything else waits', tracePriority({ answer: 'A rule.' }), 2);
t('the harvest order is down, cited, then the rest',
  harvestOrder([
    { id: 'a', at: '2026-10-01T00:00:00.000Z', answer: 'x' },
    { id: 'b', at: '2026-10-02T00:00:00.000Z', answer: 'x [1]' },
    { id: 'c', at: '2026-10-03T00:00:00.000Z', vote: 'down' },
  ]).map(x => x.id), ['c', 'b', 'a']);
t('the promoted question defaults to the trace\'s own', promotedQuestion({ question: 'Can a unit shoot?' }, null), 'Can a unit shoot?');
t('--q overrides it, trimmed', promotedQuestion({ question: 'Une unite peut-elle tirer ?' }, '  Can a unit shoot?  '), 'Can a unit shoot?');
t('an empty override leaves nothing to promote', promotedQuestion({ question: 'FR ?' }, '   '), '');
t('a cited verdict stores the numbers, not the prose',
  buildTrace({ id: 'x', at: '2026-10-01T00:00:00.000Z', question: 'q', answer: 'a', judge: { answered: true, passages: [2, 5], why: 'Passage [2] says so.' } }).judge.cited, [2, 5]);

// --- the taxonomy label, for the promotion path -----------------------------
t('the taxonomy labels a player question', classifyTrace({ question: 'can I shoot with my unit', findings: [{ id: 'x' }], signals: { firstPerson: true, termMatch: true, sources: ['core-rules'] } }), 'player');
t('and a literal one', classifyTrace({ question: 'What is the Melta rule?', findings: [{ id: 'x' }], signals: { firstPerson: false, termMatch: true, sources: ['core-rules'] } }), 'literal');
t('and a cross-source one', classifyTrace({ question: 'how does that detachment work', findings: [{ id: 'x' }], signals: { firstPerson: false, termMatch: false, sources: ['faction-sm'] } }), 'cross-source');
t('and an out-of-corpus one', classifyTrace({ question: 'q', findings: [], signals: {} }), 'out-of-corpus');

// --- the dataset: one record per trace, the bank as the eval split -----------
// The schema is the vault note's (notes/mhq-dataset.md). The tests here pin the
// two things that would quietly poison a training set: where each label came from
// (gold_how) and that an id the corpus no longer holds is REPORTED, never kept.
import { bankRecord, buildDataset, citedIds, goldFor, negativesFor, rankStats, resolveGroups, scoreRanks, sha8, traceRecord } from './build-dataset.mjs';

const LIVE = new Set(['core#A', 'core#B', 'fact#C']);
t('the cited numbers resolve to the shown findings', citedIds({ findings: [{ n: 1, id: 'core#A' }, { n: 3, id: 'fact#C' }], judge: { cited: [3, 1, 3] } }), ['fact#C', 'core#A']);
t('an older trace falls back to the answer markers', citedIds({ findings: [{ n: 2, id: 'core#B' }], judge: {}, answer: 'see [2], and [9] does not exist' }), ['core#B']);

// A group is 'any member satisfies'. The reader marked BOTH records, and the judge
// rested the answer on every passage it cited, so each is its own group of one -
// folding them into one group would read as 'any one of them answers it'.
t('every caret is a required record, not an alternative', goldFor({ labels: { positive: ['core#A', 'core#B'], negative: [] } }), { gold: [['core#A'], ['core#B']], gold_how: 'caret' });
t('the answeredBy button is the same reader pick', goldFor({ answeredBy: 'core#A' }), { gold: [['core#A']], gold_how: 'caret' });
t('and a caret outranks it', goldFor({ answeredBy: 'core#B', labels: { positive: ['core#A'] } }).gold, [['core#A']]);
t('an up-vote takes every passage the answer rested on, each required', goldFor({ vote: 'up', findings: [{ n: 1, id: 'core#A' }, { n: 2, id: 'core#B' }], judge: { cited: [1, 2] } }), { gold: [['core#A'], ['core#B']], gold_how: 'vote' });
t('an unmarked judge citation is marked judge', goldFor({ findings: [{ n: 1, id: 'core#A' }], judge: { cited: [1] } }).gold_how, 'judge');
t('and every citation it rested on is required', goldFor({ findings: [{ n: 1, id: 'core#A' }, { n: 2, id: 'core#B' }], judge: { cited: [1, 2] } }).gold, [['core#A'], ['core#B']]);
t('and no label at all is no gold', goldFor({ findings: [], judge: {} }), { gold: [], gold_how: '' });

t('a dead id leaves its group and is reported', resolveGroups([['core#A', 'gone#D']], LIVE), { groups: [['core#A']], missing: ['gone#D'] });
t('a group that loses every member is dropped', resolveGroups([['gone#D'], ['core#B']], LIVE), { groups: [['core#B']], missing: ['gone#D'] });

const neg = negativesFor({ labels: { negative: ['fact#C'] }, findings: [{ n: 1, id: 'core#A' }, { n: 2, id: 'core#B' }, { n: 3, id: 'fact#C' }, { n: 4, id: 'gone#D' }] }, ['core#A'], LIVE);
t('the x comes first, then the rest of what was shown, gold excluded', neg.negatives, ['fact#C', 'core#B']);
t('a dead finding is reported, never kept', neg.missing, ['gone#D']);

const shaped = traceRecord({ id: 't1', at: '2026-10-14T06:00:00.000Z', lang: 'fr', question: 'Ou est A ?', asked: 'Where is A?', terms: ['A'], answer: 'la reponse', findings: [{ n: 1, id: 'core#A' }], labels: { positive: ['core#A'] } }, LIVE).record;
t('the record carries the schema', [shaped.id, shaped.lang, shaped.translation, shaped.answer, shaped.gold, shaped.gold_how, shaped.negatives, shaped.source, shaped.at, shaped.split], ['trace/t1', 'fr', 'Where is A?', 'la reponse', [['core#A']], 'caret', [], 'trace', '2026-10-14T06:00:00.000Z', 'train']);
t('an English question has no translation', traceRecord({ id: 't2', question: 'What is A?', asked: 'What is A?', findings: [] }, LIVE).record.translation, null);
t('an empty answer is null', traceRecord({ id: 't3', question: 'q', answer: '   ', findings: [] }, LIVE).record.answer, null);
t('und is read as English', traceRecord({ id: 't4', lang: 'und', question: 'q', findings: [] }, LIVE).record.lang, 'en');

const bankRec = bankRecord({ q: 'What is A?', expect: [['core#A', 'gone#D'], 'core#B'] }, LIVE).record;
t('a bank entry keeps its groups, through the bank shape', bankRec.gold, [['core#A'], ['core#B']]);
t('the bank is the eval split, manual, with no answer and no translation', [bankRec.source, bankRec.split, bankRec.gold_how, bankRec.answer, bankRec.translation], ['bank', 'eval', 'manual', null, null]);
t('an out-of-corpus bank entry has no gold', bankRecord({ q: 'Who is the emperor?', expect: [] }, LIVE).record.gold_how, '');
t('and a bank id is stable', bankRecord({ q: 'What is A?', expect: ['core#A'] }, LIVE).record.id, 'bank/' + sha8('What is A?'));

const built = buildDataset(
  [
    { id: 'g1', at: '2026-10-01T00:00:00.000Z', question: 'What answers A?', findings: [{ n: 1, id: 'core#A' }], labels: { positive: ['core#A'] } },
    { id: 'q1', at: '2026-10-02T00:00:00.000Z', question: 'a question with no label', findings: [{ n: 1, id: 'core#B' }] },
  ],
  [{ q: 'b1', expect: [['core#A']] }, { q: 'b2', expect: [] }],
  LIVE);
t('the stats count what the report claims', [built.stats.records, built.stats.with_gold, built.stats.query_only, built.stats.by_split.train, built.stats.by_split.eval], [4, 2, 2, 2, 2]);
t('and the provenance', built.stats.by_gold_how, { caret: 1, none: 2, manual: 1 });
t('a negative is not a positive', built.records[1].negatives, ['core#B']);
t('a gold id the corpus lost turns the record query-only, and is counted', (function () {
  const b = buildDataset([{ id: 'g2', question: 'lost', findings: [], labels: { positive: ['gone#D'] } }], [], LIVE);
  return [b.records[0].gold, b.stats.gold_lost_records, b.stats.ids_missing];
})(), [[], 1, 1]);
t('the negatives count includes what was shown', buildDataset([{ id: 'n1', question: 'q', findings: [{ n: 1, id: 'core#A' }, { n: 2, id: 'core#B' }], judge: { cited: [1] } }], [], LIVE).stats.negatives, 1);
t('the generated lane goes through the same resolution', (function () {
  const b = buildDataset([], [], LIVE, [{ id: 'gen/core#A/1', q: 'q', gold: [['core#A']], gold_how: 'generated', source: 'generated', split: 'train', negatives: [] }]);
  return [b.records[0].gold, b.records[0].gold_how, b.stats.generated, b.stats.by_source.generated];
})(), [[['core#A']], 'generated', 1, 1]);
t('and a generated question whose target is gone loses its gold', (function () {
  const b = buildDataset([], [], LIVE, [{ id: 'gen/gone/1', q: 'q', gold: [['gone#Z']], gold_how: 'generated', source: 'generated', split: 'train', negatives: [] }]);
  return [b.records[0].gold, b.records[0].gold_how, b.stats.ids_missing];
})(), [[], '', 1]);

t('a group is satisfied by any member, and every group is required', scoreRanks([['a'], ['b']], ['x', 'b', 'a']), { rank: 2, rank_all: 3 });
t('and a group none of whose members came back leaves the question unanswered', scoreRanks([['a'], ['z']], ['x', 'a']).rank_all, null);

const stats = rankStats([{ rank: 1, rank_all: 1 }, { rank: 3, rank_all: 5 }, { rank: null, rank_all: null }, { rank: 25, rank_all: 30 }]);
t('the rank stats read like the bank eval', [stats.n, stats.hit1, stats.hit5, stats.hit20, stats.found], [4, 1, 2, 2, 3]);
t('and MRR averages the reciprocal', stats.mrr, (1 + 1 / 3 + 1 / 25) / 4);
t('the strict reading counts only questions whose every group is in the cut', [stats.all1, stats.all5, stats.all20, stats.all], [1, 2, 2, 3]);

// --- the label that arrives before its trace --------------------------------
// The reader's mark is posted when it is clicked and the trace is written when
// the answer lands: the hold is what keeps a reader who leaves early from leaving
// nothing, and what keeps that mark off another question's record.
function readTraceLine(dir, id) {
  for (const name of fs.readdirSync(dir)) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const trace = JSON.parse(line);
      if (trace.id === id) return trace;
    }
  }
  return null;
}
const holdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-hold-'));
const holdShown = [{ n: 1, id: 'core#A' }, { n: 2, id: 'core#B' }];
resetPendingLabels();
t('a mark posted before its trace counts as saved', labelsTrace('held1', { positive: ['core#A'], negative: ['core#B'] }, holdDir), true);
t('and is held against that question id', pendingLabelCount(), 1);
appendTrace({ id: 'held1', at: '2026-10-14T09:00:00.000Z', question: 'q', findings: holdShown }, holdDir);
t('and lands with the trace it belongs to', readTraceLine(holdDir, 'held1').labels, { positive: ['core#A'], negative: ['core#B'] });
t('and the hold is consumed, not left behind', pendingLabelCount(), 0);
t('a held mark the trace never showed is dropped with the hold', (function () {
  resetPendingLabels();
  labelsTrace('held2', { positive: ['core#A'], negative: [] }, holdDir);
  appendTrace({ id: 'held2', at: '2026-10-14T09:00:00.000Z', question: 'q', findings: [{ n: 1, id: 'core#B' }] }, holdDir);
  return readTraceLine(holdDir, 'held2').labels;
})(), undefined);
t('a hold cannot land on another question', (function () {
  resetPendingLabels();
  labelsTrace('held3', { positive: ['core#A'], negative: [] }, holdDir);
  appendTrace({ id: 'held4', at: '2026-10-14T09:00:00.000Z', question: 'q', findings: holdShown }, holdDir);
  return readTraceLine(holdDir, 'held4').labels;
})(), undefined);
t('a hold for a run that never lands expires instead of waiting for ever', (function () {
  resetPendingLabels();
  labelsTrace('never', { positive: ['core#A'], negative: [] }, holdDir);
  const later = Date.now() + PENDING_LABEL_MS + 1;
  return [takePendingLabels('never', later), pendingLabelCount(later)];
})(), [null, 0]);
t('a mark a trace that exists refuses is not held', (function () {
  resetPendingLabels();
  appendTrace({ id: 'held5', at: '2026-10-14T09:00:00.000Z', question: 'q', findings: holdShown }, holdDir);
  return [labelsTrace('held5', { positive: ['core#Z'], negative: [] }, holdDir), pendingLabelCount()];
})(), [false, 0]);
t('the hold is capped rather than unbounded', (function () {
  resetPendingLabels();
  for (let i = 0; i < PENDING_LABEL_MAX + 20; i++) labelsTrace('cap' + i, { positive: ['core#A'], negative: [] }, holdDir);
  return pendingLabelCount();
})(), PENDING_LABEL_MAX);
resetPendingLabels();

// --- the generation lane ----------------------------------------------------
// Questions written FROM a record: what can be asked about at all, the prompt's
// constraints, the leak and run measurements, and the record it emits. The model
// is not called here - the parse, the filter and the metrics are what the sample's
// numbers rest on.
import { exclusionReason, generatedRecord, generationPrompt, headingLeaf, isRuleRecord, longestSharedRun, median, namePresence, parseGenerated, sampleRecords, sampleStats, words } from './generate-questions.mjs';

t('the leaf is the last segment without its faction', headingLeaf({ heading: 'Using Stratagems > RAPID INGRESS (Adeptus Custodes)' }), 'RAPID INGRESS');
// The bank names the rule: 24% of its graded questions carry the leaf phrase word
// for word, and nearly all the rest a variant ('Battle-shock' against 'battle-shock
// rolls'). These are the two readings of naming.
t('a question that names the rule word for word is exact', namePresence('what is coherency', { heading: 'Coherency' }), { exact: true, any: true });
t('a plural of the whole phrase is still exact', namePresence('what is a hazard roll', { heading: 'Hazard Rolls' }), { exact: true, any: true });
t('a plural or partial form is a variant', namePresence('how does battle-shock work', { heading: 'Battle-shock Rolls' }), { exact: false, any: true });
t('and talking around the name is neither', namePresence('can my models be spread out too far', { heading: 'Coherency' }), { exact: false, any: false });

t('the run is the longest consecutive overlap', longestSharedRun('the quick brown fox jumps', 'a quick brown fox sleeps'), 3);
t('a single shared word is one', longestSharedRun('what is coherency', 'A unit is in coherency while every model is close'), 1);
t('and no overlap is zero', longestSharedRun('can my tank explode', 'Models within range of a marker'), 0);
t('words are folded to plain lowercase tokens', words("The unit's 2\" range"), ['the', "unit's", '2', 'range']);

const goodRule = { id: 'core-rules#Coherency', kind: 'rule', heading: 'Coherency', text: 'A unit is in coherency if every model in the unit is within 2 inches of at least one other model in that unit. '.padEnd(220, 'If a unit is not in coherency it cannot be selected to shoot or fight. ') };
t('a real rule can be asked about', [isRuleRecord(goodRule), exclusionReason(goodRule)], [true, '']);
t('an index page is not a rule', exclusionReason({ id: 'core-rules#Datasheets', kind: 'index', heading: 'Datasheets', text: 'x'.repeat(300) }), 'not a rule record (index)');
t('a stat block is not a rule', exclusionReason({ id: 'datasheet#1', kind: 'datasheet', heading: 'Tyrannofex', text: 'x'.repeat(300) }), 'not a rule record (datasheet)');
t('a bare container heading is not a rule', exclusionReason({ id: 'core-rules#Abilities', kind: 'rule', heading: 'Abilities', text: 'x'.repeat(300) }), 'a bare container heading');
t('a fragment is not a rule', exclusionReason({ id: 'core-rules#X', kind: 'rule', heading: 'X > Y', text: 'too short' }), 'a fragment, not a rule');
t('a points line is not a rule', exclusionReason({ id: 'datasheet#2', kind: 'rule', heading: 'Havocs', text: 'Points: 5 models 135 pts; 5 models 145 pts - ' + 'x'.repeat(240) }), 'a points fragment');
t('a keyword list is not a rule', exclusionReason({ id: 'unitrules#1', kind: 'rule', heading: 'X > Tactical Profile', text: 'IMPERIUM ADEPTUS ASTARTES INFANTRY BATTLELINE GRENADES SMOKE TACTICAL WALKER VEHICLE ' + 'x'.repeat(200) }), 'a keyword list');

const prompt = generationPrompt(goodRule);
t('the prompt asks for the name', prompt.indexOf('NAME THE RULE') !== -1 && prompt.indexOf('Coherency') !== -1, true);
t('and no longer forbids it', prompt.indexOf('NEVER write the rule') === -1, true);
t('what it protects is the passage body', prompt.indexOf('three or more words in a row') !== -1, true);
t('and asks for the three shapes', prompt.indexOf('YES/NO') !== -1 && prompt.indexOf('tabletop scenario') !== -1, true);

t('the asked-for JSON parses', parseGenerated('{"questions":[{"q":"Can my models be spread out too far?","shape":"yesno"},{"q":"When does that matter?","shape":"when"}]}'),
  [{ q: 'Can my models be spread out too far?', shape: 'yesno' }, { q: 'When does that matter?', shape: 'when' }]);
t('a bare array parses too', parseGenerated('[{"q":"Can my models be spread out too far?"},{"q":"When does that matter at all?"}]').length, 2);
t('and the shapes default in order', parseGenerated('[{"q":"Can my models be spread out too far?"},{"q":"When does that matter at all?"}]').map(x => x.shape), ['yesno', 'when']);
t('a refusal is no questions', parseGenerated('I am sorry, I cannot help with that.'), []);
t('a fragment question is dropped', parseGenerated('{"questions":[{"q":"hi"}]}'), []);

t('the record is the dataset schema, one required group', generatedRecord(goodRule, { q: 'Can my models be spread out too far?', shape: 'yesno' }, '2026-10-14T00:00:00.000Z', 2),
  { id: 'gen/core-rules#Coherency/2', q: 'Can my models be spread out too far?', lang: 'en', translation: null, answer: null, gold: [['core-rules#Coherency']], gold_how: 'generated', negatives: [], source: 'generated', at: '2026-10-14T00:00:00.000Z', split: 'train' });

const many = [];
for (const kind of ['rule', 'stratagem', 'detachment', 'enhancement']) for (let i = 0; i < 3; i++) many.push({ id: kind + '#' + i, kind, heading: 'R' + i, text: 'x'.repeat(200) });
const picked = sampleRecords(many, 6);
t('the sample takes the limit', picked.length, 6);
t('and spreads the kinds rather than draining the first', new Set(picked.map(r => r.kind)).size, 4);
t('and never takes the same record twice', new Set(picked.map(r => r.id)).size, 6);
t('it is deterministic', sampleRecords(many, 6).map(r => r.id).join(','), picked.map(r => r.id).join(','));
t('--ids picks exactly those', sampleRecords(many, 6, { ids: ['stratagem#2'] }).map(r => r.id), ['stratagem#2']);
t('--only picks one kind', sampleRecords(many, 6, { only: 'detachment' }).every(r => r.kind === 'detachment'), true);

t('the median of an odd list is the middle', median([1, 5, 2]), 2);
t('and of an even list the midpoint', median([1, 2]), 1.5);
t('the sample stats read names, bodies and runs', sampleStats([
  { run: 1, run_body: 1, name: { exact: true, any: true }, shape: 'yesno' },
  { run: 3, run_body: 2, name: { exact: false, any: true }, shape: 'when' },
  { run: 3, run_body: 2, name: { exact: false, any: false }, shape: 'scenario' },
  { run: 6, run_body: 4, name: { exact: false, any: true }, shape: 'yesno' },
]),
  { questions: 4, median_run: 3, within3: 3, within3_pct: 75, max_run: 6, median_body: 2, body_max: 4, body_within2: 3, body_within2_pct: 75, name_exact: 1, name_exact_pct: 25, name_any: 3, name_any_pct: 75, shapes: { yesno: 2, when: 1, scenario: 1 } });

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
