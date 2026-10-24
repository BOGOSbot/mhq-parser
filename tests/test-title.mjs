// The title module (src/title.mjs): one split, one marker strip, three answers.
//
// Part A is table-driven and builds nothing: no corpus, no disk, no DOM. It pins the
// marker cases the three old regexes disagreed about and the row-name rule the client
// and unit-card carried twice, so a change to the module is visible here first.
//
// Part B is the acceptance measurement: for every record the bake put in
// workspace/wiki-data/index/rows.json, the slug this module produces from the corpus
// record and the row's own book must be the slug the bake wrote. It reads build output,
// it does not build any.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanTitle, displayTitle, hash8, leafOf, pageSlug, pageTitleSlug, rowLabel, shortLabel, splitHeading } from '../src/title.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }

// --- Part A: the heading path, one split -------------------------------------------
const SPLITS = [
  ['A > B > C', ['A', 'B', 'C']],
  ['A', ['A']],
  ['', []],
  ['A >  > B', ['A', 'B']],
  ['A > B (2/2) > C', ['A', 'B (2/2)', 'C']],
  ['  spaced  >  leaf  ', ['  spaced ', ' leaf  ']],
];
for (const [input, want] of SPLITS) t('splitHeading ' + JSON.stringify(input), splitHeading(input), want);

const LEAVES = [['A > B', 'B'], ['A', 'A'], ['', ''], ['A >  > B', 'B']];
for (const [input, want] of LEAVES) t('leafOf ' + JSON.stringify(input), leafOf(input), want);

// --- Part A: the marker strip, one strip -------------------------------------------
const MARKERS = [
  ['Ironstrider (2/2)', 'Ironstrider'],
  ['FALL-BACK MOVE', 'FALL-BACK MOVE'],
  ['Ironstrider - keywords and abilities', 'Ironstrider'],
  ['Ironstrider - keywords and abilities (2/2)', 'Ironstrider'],
  ['Ironstrider - Keywords And Abilities', 'Ironstrider'],
  ['X - datasheet', 'X - datasheet'],
  ['X (2/2) - keywords and abilities', 'X (2/2)'],
  ['(1/2)', ''],
];
for (const [input, want] of MARKERS) t('cleanTitle ' + JSON.stringify(input), cleanTitle(input), want);

// --- Part A: the display label ------------------------------------------------------
const DISPLAY = [
  ['FALL-BACK MOVE', 'Fall-Back Move'],
  ['[ONE SHOT]', 'One Shot'],
  ['Aeldari', 'Aeldari'],
  ['3. RESOLVE ATTACKS', '3. Resolve Attacks'],
  ['', ''],
];
for (const [input, want] of DISPLAY) t('displayTitle ' + JSON.stringify(input), displayTitle(input), want);
t('shortLabel drops the datasheet suffix then title-cases', shortLabel('Ironstrider - datasheet'), 'Ironstrider');
t('shortLabel keeps a trailing part marker out of the kind suffix', shortLabel('Ironstrider - keywords and abilities (2/2)'), 'Ironstrider');

// --- Part A: the page slug ----------------------------------------------------------
t('hash8 is FNV-1a base 36', [hash8('abc'), hash8('datasheet#000004251')], ['7aigaz', '12zi2tv']);
t('a part marker leaves the page slug', pageTitleSlug({ kind: 'datasheet', heading: 'Datasheets > Custodian Guard (1/2)' }), 'datasheet-custodian-guard');
t('an untitled record is named by its kind', pageTitleSlug({ kind: 'rule' }), 'rule');
t('a unitrules half names the unit, not the half', pageTitleSlug({ kind: 'unitrules', heading: 'X > Y - keywords and abilities (2/2)' }), 'unitrules-y');
t('the full address is book, title and id hash', pageSlug({ id: 'datasheet#000004251', kind: 'datasheet', heading: 'Datasheets > Custodian Guard' }, 'faction-adeptus-custodes'), 'faction-adeptus-custodes--datasheet-custodian-guard-12zi2tv');

// --- Part A: the row label (the client's task-23 rule) ------------------------------
const FAQ_Q = 'If a rule says my unit must make a hazard roll does every model in the unit make a hazard roll?';
t('an FAQ row is named by its own question', rowLabel(['Muster Armies', 'Fill Your Army Roster', 'FAQ', FAQ_Q, 'FALL-BACK MOVE']), { name: FAQ_Q, at: 3 });
t('a one-shot FAQ row keeps its question label', rowLabel(['[ONE SHOT]', 'FAQ', 'Q: ' + FAQ_Q, 'FALL-BACK MOVE']), { name: 'Q: ' + FAQ_Q, at: 2 });
t('a nested rule keeps its own name', rowLabel(['Movement Phase', '3. End of Movement Phase', '09.05.01 More Than One Normal Move in a Phase', 'FALL-BACK MOVE']), { name: 'FALL-BACK MOVE', at: 3 });
t('a bare name keeps its own name', rowLabel(['FALL-BACK MOVE']), { name: 'FALL-BACK MOVE', at: 0 });
t('a datasheet row keeps its own name', rowLabel(['Datasheets', 'Tyrannofex']), { name: 'Tyrannofex', at: 1 });
t('a question that IS the name is not a section', rowLabel(['Other Concepts', 'Hazard Rolls', 'Q: I failed hazard rolls?']), { name: 'Q: I failed hazard rolls?', at: 2 });
t('a leaf that restates a segment is not the name', rowLabel(['Muster Armies', 'FAQ', 'Some Rule', 'Some Rule']), { name: 'FAQ', at: 1 });
t('no parts is no name', rowLabel([]), { name: '', at: -1 });

// --- Part B: every baked row's address, from the corpus -----------------------------
import { readAllCorpus } from '../src/rules-corpus.mjs';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rowsFile = path.join(ROOT, 'workspace', 'wiki-data', 'index', 'rows.json');
const rows = JSON.parse(fs.readFileSync(rowsFile, 'utf8')).rows;
const byId = new Map(readAllCorpus().map(r => [String(r.id), r]));
let same = 0;
const diffs = [];
for (const id of Object.keys(rows)) {
  const raw = byId.get(id);
  if (!raw) { diffs.push(id + ': not in the corpus'); continue; }
  if (pageSlug(raw, rows[id].book) === rows[id].slug) same++;
  else diffs.push(id + ': want ' + rows[id].slug + ' got ' + pageSlug(raw, rows[id].book));
}
t('every baked row address is what the module produces', diffs.slice(0, 5), []);
ok('and the table covers the whole delivered corpus', same === Object.keys(rows).length && same > 0);
console.log('markers: ' + (SPLITS.length + LEAVES.length + MARKERS.length + DISPLAY.length) + ' marker cases | slugs: ' + same + '/' + Object.keys(rows).length);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;