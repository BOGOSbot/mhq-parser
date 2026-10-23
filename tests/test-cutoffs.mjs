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

// task-4 removed the appendix's local [ONE SHOT] chapter: its five rows moved to
// the 00 chapter, outside either book, so the inventory loses one cut chapter.
t('the measured cutoff inventory: 62 unnumbered chapters, 3 parts, 48 groups', (function () {
  const by = {};
  for (const n of Object.values(files)) if (n.cut) by[n.lvl] = (by[n.lvl] || 0) + 1;
  return by;
})(), { chapter: 62, part: 3, group: 48 });
// task-13: one chapter fewer - the nine Challenger records left the corpus, so the
// Missions > Events > Challenger chapter is gone with them.
t('and stats.cuts agrees', tree.stats.cuts, 113);

// Rules: a 0x header is a LABEL, not an entry. It is not cut and its children are
// listed in its place (task-61); the books still do not cut, and the Rulings
// chapter is still a waypoint. task-5: ONE rulebook - the appendix's rows are the
// core chapters' rows now and the 0x.0x section level walks to them, so the entry
// count is every row a chapter or a section lists. task-16: a section lead's
// nested records are rows too (the core page's copies of the CSV stratagems are
// not - they duplicate a visible row), so the count is 343: 314 + 29 (task-13
// moved the core-stratagem PULSE JET MOVE definition to the Wazdakka datasheet).
ok('a 0x chapter is not a cut entry', kids('tree/rules/core-rules.js').filter(x => /^\d{2}\s/.test(x.n)).every(x => !x.cut));
// 2026-10-19 (task-33): the export adds one core-book record, so 343 -> 344.
// task-99: 349. The appendix's entries reach the core book, and the two new ability
// definitions (EXTRA ATTACKS, ONE SHOT) are rows there too.
ok('and its children are the entries: 349 under Core Rules', (function () {
  const entryCount = f => (f.kids || []).reduce((n, k) => n + entryCount(files[k.f] || { recs: [] }), (f.recs || []).length);
  const flat = b => (files[b].kids || []).reduce((n, k) => n + entryCount(files[k.f] || {}), 0);
  return flat('tree/rules/core-rules.js') === 349;
})());
ok('a book is never a cutoff', !files['tree/rules/core-rules.js'].cut);
ok('the two ruling books are waypoints, their chapters are the cutoffs', !files['tree/rulings/wtc.js'].cut && !files['tree/rulings/feq.js'].cut && kids('tree/rulings/wtc.js').every(x => x.cut) && kids('tree/rulings/feq.js').every(x => x.cut));
ok('and the books are siblings of the rulebook, not cut themselves', (function () {
  const books = kids('tree/rules.js').filter(x => x.lvl === 'book');
  // task-101: the rulebook and the two ruling books - the faction abilities are not a
  // book of their own, they live with the faction that owns them. task-5: the Rules
  // Appendix is folded into Core Rules, so the rulebook is one.
  return books.length === 3 && books.every(x => !x.cut);
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
