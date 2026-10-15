import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { harvestFromTraces, questionRecord, validateRecord, normalizeQuestion } from '../src/dataset.mjs';

// task-33: the harvest writer. The reader's 'This one answers it' is the label,
// the rest of the shown findings are mined hard negatives, the answer travels
// with the question - and one normalized question is ONE record with its ask
// count, never one record per ask.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const trace = (o) => Object.assign({
  id: 'x1', at: '2026-10-15T10:00:00Z', edition: 'wh40k11ed', question: 'Can a unit shoot after it Fell Back?',
  answer: 'No, unless it has a special rule [1].', findings: [{ n: 1, id: 'a' }, { n: 2, id: 'b' }, { n: 3, id: 'c' }],
}, o);

const one = harvestFromTraces([trace({ labels: { positive: ['a'], negative: ['c'] } })]);
t('one labelled trace writes one record', one.length, 1);
t('the reader pick is the gold group', one[0].gold, [['a']]);
t('the rest of the shown findings are the hard negatives', one[0].negatives, ['b', 'c']);
t('the answer travels with the question', one[0].answer, 'No, unless it has a special rule [1].');
t('how is vote and the split is train', [one[0].how, one[0].split], ['vote', 'train']);
t('a single ask is recorded as one', one[0].asks, 1);
t('the record validates', validateRecord(one[0]), []);

// The requirement: a question asked six times must not weigh six.
const same = (q) => trace({ labels: { positive: ['a'] }, question: q });
const dupes = harvestFromTraces([same('Can a unit shoot after it Fell Back?'), same('can a unit shoot after it fell back'), same('CAN A UNIT SHOOT AFTER IT FELL BACK?')]);
t('three asks of one question collapse to one record', dupes.length, 1);
t('with the ask count recorded', dupes[0].asks, 3);
ok('and the three traces normalize to the same key', normalizeQuestion('Can a unit shoot after it Fell Back?') === normalizeQuestion('CAN A UNIT SHOOT AFTER IT FELL BACK?'));

t('a trace with no reader pick writes nothing', harvestFromTraces([trace({})]).length, 0);
t('a reader pick of none writes nothing', harvestFromTraces([trace({ labels: { positive: [], negative: ['a'] } })]).length, 0);
t('an empty question is skipped', harvestFromTraces([trace({ question: '   ', labels: { positive: ['a'] } })]).length, 0);
ok('asks must be at least 1', validateRecord({ id: 'x', q: 'q', answer: '', gold: [['a']], negatives: [], how: 'vote', edition: '', date: '', source: '', url: '', split: 'train', asks: 0 }).some(p => /asks/.test(p)));

// --- the CLI writes the same thing ------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-'));
fs.writeFileSync(path.join(dir, '2026-10.ndjson'), [
  JSON.stringify(trace({ labels: { positive: ['a'], negative: ['c'] } })),
  JSON.stringify(trace({ id: 'x2', labels: { positive: ['a'] } })),
  JSON.stringify(trace({ id: 'x3', question: 'anything else' })),
].join('\n') + '\n');
const out = path.join(dir, 'harvest.jsonl');
const run = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'promote-traces.mjs'), '--harvest', '--write', '--dir', dir, '--out', out], { encoding: 'utf8' });
ok('the CLI exits cleanly', run.status === 0);
ok('and reports the one labelled question', /1 labelled question\(s\)/.test(run.stdout || ''));
const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
t('the written dataset holds the deduped record', [lines.length, lines[0].asks], [1, 2]);
ok('and it is a valid train record', validateRecord(lines[0]).length === 0);
fs.rmSync(dir, { recursive: true, force: true });

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
