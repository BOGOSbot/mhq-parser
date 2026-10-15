import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, deliveredSections } from '../src/rules-corpus.mjs';
import { anchorFor } from '../src/rules.mjs';
import { expectGroups } from './expectation-groups.mjs';
import { resolveExpectation } from './expectations.mjs';

// Every expectation in the authored bank must resolve to at least one id the
// corpus DELIVERS. An entry that cannot match cannot score, whatever retrieval
// does: the harness just prints NOT FOUND and the question is a permanent loss.
// That is how player question 10 named unitrules#000002541, which the part
// splitter had divided into ~1 and ~2.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const all = readAllCorpus();
const ix = { byId: new Set(all.map(s => s.id)), byKey: new Map(), ids: all.map(s => s.id) };
for (const s of all) {
  const key = s.source + '#' + (s.anchor || anchorFor(s.heading) || 'section');
  if (!ix.byKey.has(key)) ix.byKey.set(key, s.id);
}
const delivered = new Set(deliveredSections(all).map(r => r.id));

const bank = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rules-questions.json'), 'utf8'));
const unscoreable = [];
const preSplitUnscoreable = [];
let entries = 0;
for (const item of bank.questions) {
  for (const group of expectGroups(item.expect)) {
    for (const e of group) {
      entries++;
      const r = resolveExpectation(e, ix);
      const ids = r.via === 'split' ? r.parts : [r.resolved];
      if (!ids.some(id => delivered.has(id))) unscoreable.push({ q: item.q, e: e, via: r.via });
      // What the harness could resolve before the split lane existed: exact, or
      // the anchor-remap. The difference is the number this guard catches today.
      const before = ix.byId.has(e) ? e : ix.byKey.get(e);
      if (!before || !delivered.has(before)) preSplitUnscoreable.push({ q: item.q, e: e });
    }
  }
}

t('every bank expectation resolves to at least one delivered id', unscoreable, []);
t('the guard would have caught the entry that was unscoreable by construction', preSplitUnscoreable.map(x => x.e), ['unitrules#000002541']);
ok('and that is the player question about the Harlequin re-embarking', preSplitUnscoreable[0].q.indexOf('Harlequin') !== -1);
t('the corpus has no unsuffixed unitrules#000002541', ix.byId.has('unitrules#000002541'), false);
t('the split lane resolves it to the parts the corpus has', resolveExpectation('unitrules#000002541', ix).parts, ['unitrules#000002541~1', 'unitrules#000002541~2']);
ok('both parts are delivered', resolveExpectation('unitrules#000002541', ix).parts.every(id => delivered.has(id)));
t('the split lane never widens to a fuzzy match', resolveExpectation('unitrules#0000025', ix).via, 'missing');
t('an exact id still resolves to itself', resolveExpectation('core-rules#Battle-shock-Rolls', ix).via, 'exact');

// The resolution is harness-side only: the retrieval path must not import it,
// so commit 1 cannot have changed what a retriever returns.
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'rules-corpus.mjs'), 'utf8');
ok('the retrieval module does not know about the bank resolver', src.indexOf('resolveExpectation') === -1 && src.indexOf('splitParts') === -1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
