import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAllCorpus } from '../src/rules-corpus.mjs';
import { KIND_UNKNOWN, TRACE_RETENTION_MONTHS, appendTrace, buildTrace, firstPerson, newTraceId, sweepTraces, termMatch, traceCutoff, traceSignals, tracesEnabled } from '../src/rules-traces.mjs';

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
t('the verdict keeps its answer and confidence', trace.judge, { answered: true, confidence: 'high' });
t('the answer is kept - the bank grades on it', trace.answer, 'Oui [1].');
t('the corpus build travels with it', trace.corpusAt, '2026-10-13T00:55:31.597Z');
t('kind is unknown, not a guess', trace.kind, KIND_UNKNOWN);
t('the signals travel', trace.signals, { firstPerson: false, termMatch: false, sources: ['core-rules'], halves: ['rules'], rules: 1 });
const plain = buildTrace({ id: 'x', at: '2026-10-13T09:00:00.000Z', question: 'What is Engagement?', signals: traceSignals('What is Engagement?', []), answer: '' });
t('an English question carries no asked', 'asked' in plain, false);

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
  const recs = item.expect.map(e => byId.get(e)).filter(Boolean);
  const term = item.expect.length ? termMatch(item.q, recs.map(r => r.heading)) : false;
  const first = firstPerson(item.q);
  const nonCore = recs.some(r => r.source !== 'core-rules');
  let guess = 'unknown';
  if (!item.expect.length) guess = 'out-of-corpus';
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

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
