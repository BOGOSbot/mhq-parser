import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTrace, appendTrace, labelsTrace } from '../src/rules-traces.mjs';
import { loadTraces } from './promote-traces.mjs';
import { harvestFromTraces, validateRecord } from '../src/dataset.mjs';

// task-40's acceptance criterion: the reader's caret and x land in the SAME trace
// as the question - a caret as a positive record id, an x as a negative - and the
// harvest turns that trace into exactly one train record with its asks and its
// mined hard negatives. This is the only loop that grows the dataset without a
// reader typing a question into a CLI, so it is tested end to end on the real
// functions (buildTrace, appendTrace, labelsTrace, harvestFromTraces), not stubs.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-loop-'));
const traceInput = (id, q) => ({
  id: id, at: '2026-10-15T12:00:00Z', edition: 'wh40k11ed', corpusAt: '2026-10-15T11:00:00Z',
  mode: 'fast', lang: 'en', question: q,
  counts: { rules: 2, factions: 1 },
  findings: [{ n: 1, id: 'core-rules#A' }, { n: 2, id: 'core-rules#B' }, { n: 3, id: 'faction-ae#C' }],
  agent: { answered: true, confidence: 'high' }, answer: 'No, unless it has a special rule [1].',
});

// The reader asks, the trace lands, then the reader carets one and x-es another.
appendTrace(buildTrace(traceInput('loop1', 'Can a unit shoot after it Fell Back?')), dir);
t('the caret and the x land on one trace', labelsTrace('loop1', { positive: ['core-rules#A'], negative: ['faction-ae#C'] }, dir), true);
const rows = loadTraces(dir);
t('one trace holds the question', rows.length, 1);
t('the trace carries exactly one positive and one negative', [rows[0].labels.positive, rows[0].labels.negative], [['core-rules#A'], ['faction-ae#C']]);
t('and the question is the same trace', rows[0].question, 'Can a unit shoot after it Fell Back?');

// The acceptance: one train record, asks at least 1, negatives present.
const recs = harvestFromTraces(rows);
t('the harvest writes exactly one train record', [recs.length, recs[0].split, recs[0].how], [1, 'train', 'vote']);
ok('with asks >= 1', recs[0].asks >= 1);
t('the caret is the gold group', recs[0].gold, [['core-rules#A']]);
t('the x and the un-picked shown findings are the hard negatives', recs[0].negatives, ['core-rules#B', 'faction-ae#C']);
ok('the record validates', validateRecord(recs[0]).length === 0);

// An id the trace never showed cannot be labelled: the reader can only mark what
// they were shown.
t('an unseen id is refused', labelsTrace('loop1', { positive: ['core-rules#ZZZ'], negative: [] }, dir), false);
t('and the trace is unchanged', loadTraces(dir)[0].labels.positive, ['core-rules#A']);

// The 'None of these' rejection is a real example: gold stays empty, the
// rejected passage is the negative, and the record says how it was made.
appendTrace(buildTrace(traceInput('loop2', 'What is a Desperate Escape test?')), dir);
t('a rejection lands as a zero-positive label', labelsTrace('loop2', { positive: [], negative: ['core-rules#B'] }, dir), true);
const rejected = harvestFromTraces(loadTraces(dir)).find(r => r.q === 'What is a Desperate Escape test?');
t('the rejection is recorded, not dropped', [rejected.gold, rejected.negatives, rejected.verifier.noneOfThese], [[], ['core-rules#B'], true]);
ok('and it validates with empty gold', validateRecord(rejected).length === 0);

// The same question asked again is one record with asks 2.
appendTrace(buildTrace(traceInput('loop3', 'can a unit shoot after it fell back?')), dir);
t('a repeat ask grows asks, not records', harvestFromTraces(loadTraces(dir)).filter(r => r.gold.length).map(r => r.asks), [2]);

fs.rmSync(dir, { recursive: true, force: true });
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
