import { readAllCorpus } from '../src/rules-corpus.mjs';
import { wikiTree } from '../src/wiki-toc.mjs';

// task-55: the cutoff is the level where the index stops and an entry expands
// inline instead of navigating. It was defined from the real tree, measured per
// branch, never asserted from a level nobody had seen:
//
//   Rules     -> the numbered chapter ('0x header'): 109 of them across both books
//   Rulings   -> the WTC/FEQ document (the Rulings chapter itself is a waypoint)
//   Factions  -> a faction's groups: Army rules / Detachments / Units
//   Missions  -> its three parts: Events / Primary / Secondary
//
// The undecided '?' (the rest): proposed by symmetry, measured, and pinned here -
// Primary and Secondary cut like Events, one-page nodes (an Army rules set, a
// detachment page) are endpoints by construction, and a book is never a cutoff
// because a reader looking for a rule starts a level below it.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const tree = wikiTree(readAllCorpus());
const files = tree.files;
const kids = k => (files[k].kids || []);
const cutKids = k => kids(k).filter(x => x.cut);

t('the measured cutoff inventory: 47 unnumbered chapters, 2 documents, 3 parts, 48 groups', (function () {
  const by = {};
  for (const n of Object.values(files)) if (n.cut) by[n.lvl] = (by[n.lvl] || 0) + 1;
  return by;
})(), { chapter: 47, part: 3, group: 48, doc: 2 });
t('and stats.cuts agrees', tree.stats.cuts, 100);

// Rules: a 0x header is a LABEL, not an entry. It is not cut and its children are
// listed in its place (task-61); the books still do not cut, and the Rulings
// chapter is still a waypoint.
ok('a 0x chapter is not a cut entry', kids('tree/rules/core-rules.js').filter(x => /^\d{2}\s/.test(x.n)).every(x => !x.cut));
ok('and its children are the entries: 186 for Core Rules, 105 for the Appendix', (function () {
  const flat = b => (files[b].kids || []).reduce((n, k) => { const f = files[k.f]; return n + (f ? (f.kids || []).length + (f.recs || []).length : 1); }, 0);
  return flat('tree/rules/core-rules.js') === 186 && flat('tree/rules/rules-appendix.js') === 105;
})());
ok('a book is never a cutoff', !files['tree/rules/core-rules.js'].cut && !files['tree/rules/rules-appendix.js'].cut);
ok('the Rulings chapter is a waypoint, its documents are the cutoffs', !files['tree/rulings.js'].cut && files['tree/rulings/wtc.js'].cut && files['tree/rulings/feq.js'].cut);
ok('the Rulings kid under Rules cuts at the document, not at itself', (function () {
  const k = kids('tree/rules.js').find(x => x.n === 'Rulings');
  return k && !k.cut && kids('tree/rulings.js').every(x => x.cut);
})());

// Missions: all three parts cut - the '?' answered by symmetry with Events.
t('Missions cuts at all three parts', kids('tree/missions.js').filter(x => x.cut).map(x => x.n), ['Events', 'Primary', 'Secondary']);
t('and each part is the measured depth 2', kids('tree/missions.js').map(x => (files[x.f] || {}).lvl), ['part', 'part', 'part']);

// Factions: the three groups cut, and an Army rules set is a one-page endpoint.
ok('a faction cuts at Army rules / Detachments / Units', cutKids('tree/factions/xenos/aeldari.js').length === 3);
ok('an Army rules set is an endpoint by construction (one page)', (function () {
  const k = kids('tree/factions/xenos/aeldari.js').find(x => x.n === 'Army rules');
  return k && k.cut && k.pg;
})());
ok('no faction, alliance or branch is itself a cutoff', !files['tree/factions.js'].cut && !files['tree/factions/xenos.js'].cut && !files['tree/factions/xenos/aeldari.js'].cut);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
