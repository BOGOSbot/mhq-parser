import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, isDelivered } from '../src/rules-corpus.mjs';
import { wikiTree } from '../src/wiki-toc.mjs';

// task-64: the rulings fold, safe tier, at the TREE level - the corpus JSON, the
// index and --stats are untouched. The gates the Lead set, all of them:
//   fold 79, placed 6086, rules+missions+factions 6086, rulings 75,
//   annotations 270 / annotated 261 / unattached 9 unchanged.
// And no delivered record may become unreachable: records MOVED, none vanished.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const all = readAllCorpus();
const tree = wikiTree(all);
const s = tree.stats;

t('the fold is the 79 unique-name matches', tree.rulingFold.size, 79);
t('placed is unchanged: records moved, none vanished', s.placed, 6086);
t('and the three branches still account for every placed record', s.rules + s.missions + s.factions, 6086);
t('rulings keeps the other 75', [s.rulings, s.rules, s.missions, s.factions], [75, 740, 107, 5239]);

// The annotation accounting is task-51's and must not have moved at all.
t('annotations are untouched', [s.annotations, s.annotated, s.unattached], [270, 261, 9]);

// The case that forced the tier: a reversed lookup must land on its stratagem,
// and the stratagem's page must carry the ruling.
t('Divine Intervention folds onto the stratagem it names', tree.rulingFold.get('wtc11-adepta-soritas-001'), 'stratagem#000008469002');
t('and the target carries the ruling for the render', (tree.rulingFoldedOn.get('stratagem#000008469002') || []).map(r => r.id), ['wtc11-adepta-soritas-001']);
ok('the render reads both fold maps', fs.readFileSync(path.join(ROOT, 'src', 'wiki-render.mjs'), 'utf8').indexOf('tree.rulingFoldedOn && tree.rulingFoldedOn.get(r.id)') !== -1);

// The 75 stay under the labelled Rulings chapter, and every delivered record has
// a path: the fold moved records between branches, it did not drop any.
const kept = all.filter(r => r.set === 'rulings' && tree.paths.has(r.id) && !tree.rulingFold.has(r.id));
t('the 75 kept rulings all sit under the Rulings chapter', kept.filter(r => (tree.paths.get(r.id) || [])[1] && tree.paths.get(r.id)[1].n === 'Rulings').length, 75);
// The pathless delivered records are exactly the classes the tree excludes on
// purpose - index stubs, unattached annotations, dropped front matter - the same
// count as before the fold. The fold itself moved 79 records, dropped none.
const pathless = all.filter(r => isDelivered(r)).filter(r => !tree.paths.has(r.id) && !tree.mergedOn.has(r.id)).length;
t('only the deliberately excluded classes are pathless', pathless, s.excluded + s.unattached + s.dropped);
t('and placed equals the path count', tree.paths.size, s.placed);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
