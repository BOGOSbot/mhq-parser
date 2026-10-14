import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readAllCorpus } from '../src/rules-corpus.mjs';
import { cardTables } from '../src/unit-card.mjs';
import { wikiTree, tocTree, pageNamer, factionRoster, factionAssigner, allianceAssigner } from '../src/wiki-toc.mjs';

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
const idx = tree.index, files = tree.files;
const kids = f => (files[f] && files[f].kids) || [];
const recs = f => (files[f] && files[f].recs) || [];
const findIn = (fs_, f, id) => {
  const n = fs_[f];
  if (!n) return null;
  for (const r of (n.recs || [])) if (r.i === id) return r;
  for (const k of (n.kids || [])) for (const r of (k.recs || [])) if (r.i === id) return r;
  return null;
};
const findRec = (f, id) => findIn(files, f, id);
const factionNode = name => {
  for (const a of kids('tree/factions.js')) for (const f of kids(a.f)) if (f.n === name) return f;
  return null;
};

// --- the three branches exist, and their counts are stated --------------------
t('three branches: Rules, Missions, Factions', idx.branches.map(b => b.n), ['Rules', 'Missions', 'Factions']);
t('Rules holds 633 records (401 core-rules + 54 core stratagems + 178 appendix)', idx.branches[0].c, 633);
t('Missions holds the 81 event-companion records', idx.branches[1].c, 81);
t('Factions holds 5,828 placed records', idx.branches[2].c, 5828);
t('placed + excluded is the whole corpus', idx.placed + idx.excluded[0].c, 6705);
t('of which placed', idx.placed, 6542);
t('the 163 index stubs are counted, named and not silently dropped', idx.excluded, [{ k: 'index', c: 163, why: 'navigation stubs, not corpus content' }]);

// --- Rules -> book -> chapter -> section --------------------------------------
t('Rules has the two books', kids('tree/rules.js').map(k => k.n), ['Core Rules', 'Rules Appendix']);
t('Core Rules book count folds core-stratagems in, once', kids('tree/rules.js')[0].c, 455);
t('Rules Appendix book is on its own', kids('tree/rules.js')[1].c, 178);
const crBook = 'tree/rules/core-rules.js', raBook = 'tree/rules/rules-appendix.js';
t('the rule records land in chapters', kids(crBook).reduce((n, k) => n + k.c, 0), 455);
t('the appendix records land in chapters', kids(raBook).reduce((n, k) => n + k.c, 0), 178);
const crFallback = kids(crBook).find(k => k.n === 'Core Rules');
ok('a record with no ancestor falls back to its book, as a chapter', crFallback && crFallback.c === 166);
const raFallback = kids(raBook).find(k => k.n === 'Rules Appendix');
ok('the appendix fallback chapter is the book', raFallback && raFallback.c === 139);
const muster = kids(crBook).find(k => k.n === 'Muster Armies');
ok('the nearest ancestor is used, not a fixed depth: Muster Armies holds 57', muster && muster.c === 57);
ok('a record whose middle prefix is not a record still lands under Muster Armies', recs(muster.f).some(r => r.i === 'core-rules#Muster-Armies->-Errata->-01.02.06-Splitting-Units'));
// Named proof: a core-rules record sits under Rules > its book > its chapter.
ok('NAMED: a core-rules record sits under its book and its chapter',
  !!findRec('tree/rules/core-rules/muster-armies.js', 'core-rules#Muster-Armies->-Q:-Can-a-unit-have-both-an-Upgrade-and-an-enhancement-?'));
// The 54 core stratagems are a section of the core-rules page, so they are in its book.
let coreStrat = 0;
for (const k of kids(crBook)) for (const r of recs(k.f)) if (r.i.indexOf('core-stratagem#') === 0) coreStrat++;
t('NAMED: all 54 core stratagems fold into the Core Rules book', coreStrat, 54);

// --- Missions -> Events / Primary / Secondary ---------------------------------
t('Missions has its three parts', kids('tree/missions.js').map(k => k.n), ['Events', 'Primary', 'Secondary']);
t('Primary is the primary deck', kids('tree/missions.js')[1].c, 13);
t('Secondary is the secondary deck', kids('tree/missions.js')[2].c, 24);
t('Events is the tournament machinery and holds the rest', kids('tree/missions.js')[0].c, 44);
ok('the event machinery is under Events, not flattened', recs('tree/missions/events.js').some(r => r.i.indexOf('event-companion#Generating-Command-Points') === 0) && recs('tree/missions/events.js').some(r => r.i.indexOf('event-companion#Ranking-Players') === 0) && recs('tree/missions/events.js').some(r => r.i.indexOf('event-companion#Deployment-Card-Key') === 0));
ok('the mission FAQ (Books) is under Events and named there', recs('tree/missions/events.js').some(r => r.i.indexOf('event-companion#Books->-FAQ->') === 0));
// Named proof: a secondary mission sits under Missions > Secondary.
const sec = findRec('tree/missions/secondary.js', 'event-companion#Secondary-Mission-deck');
const secText = (all.find(r => r.id === 'event-companion#Secondary-Mission-deck') || {}).text || '';
ok('NAMED: a secondary mission sits under Missions > Secondary', !!sec && /NO PRISONERS/.test(secText));
ok('and the primary deck is under Primary', !!findRec('tree/missions/primary.js', 'event-companion#Primary-Mission-deck'));

// --- Factions -> alliance -> faction -> Detachments / Units --------------------
t('Factions has the three alliances', kids('tree/factions.js').map(k => k.n), ['Imperium', 'Chaos', 'Xenos']);
t('alliance counts partition the 5,828 placed records', kids('tree/factions.js').reduce((n, k) => n + k.c, 0), 5828);
const allianceKids = a => kids('tree/factions/' + a.toLowerCase() + '.js').map(k => k.n);
t('Imperium is the measured nine', allianceKids('Imperium'), ['Adepta Sororitas', 'Adeptus Custodes', 'Adeptus Mechanicus', 'Adeptus Titanicus', 'Astra Militarum', 'Grey Knights', 'Imperial Agents', 'Imperial Knights', 'Space Marines']);
t('Chaos is the measured seven', allianceKids('Chaos'), ['Chaos Daemons', 'Chaos Knights', 'Chaos Space Marines', 'Death Guard', "Emperor's Children", 'Thousand Sons', 'World Eaters'].map(s => s === "Emperor's Children" ? 'Emperor\u2019s Children' : s));
t('Xenos is the eight by exclusion', allianceKids('Xenos'), ['Aeldari', 'Drukhari', 'Genestealer Cults', 'Leagues of Votann', 'Necrons', 'Orks', 'T\u2019au Empire', 'Tyranids']);
t('all 24 factions exist', kids('tree/factions/imperium.js').length + kids('tree/factions/chaos.js').length + kids('tree/factions/xenos.js').length, 24);
ok('every faction carries exactly Detachments and Units', ['Imperium', 'Chaos', 'Xenos'].every(a => kids('tree/factions/' + a.toLowerCase() + '.js').every(f => JSON.stringify(kids(f.f).map(k => k.n)) === JSON.stringify(['Detachments', 'Units']))));
const cust = factionNode('Adeptus Custodes');
t('Custodes faction page holds its 1 faction rule plus the two groups', cust.c, 161);
const custDet = 'tree/factions/imperium/adeptus-custodes/detachments.js';
const custUnits = 'tree/factions/imperium/adeptus-custodes/units.js';
t('Custodes Units is the datasheet/unitrules records', (files[custUnits] || {}).c, 62);
t('Custodes Detachments counts its own records, enhancements and stratagems', (files[custDet] || {}).c, 98);
ok('a faction page never carries an enhancement or a stratagem', Object.values(files).filter(f => f.lvl === 'faction').every(f => (f.recs || []).every(r => r.i.indexOf('faction-rule#') === 0)));
// Named proof: a Custodes stratagem sits under its own detachment.
const auric = 'tree/factions/imperium/adeptus-custodes/detachments/auric-champions.js';
const shoulder = findRec(auric, 'stratagem#000008931007');
const shoulderGroup = ((files[auric] || {}).kids || []).find(k => k.n === 'Stratagems' && (k.recs || []).some(r => r.i === 'stratagem#000008931007'));
ok('NAMED: a Custodes stratagem sits under its own detachment', !!shoulder && shoulder.t === 'SHOULDER THE MANTLE (Adeptus Custodes)' && !!shoulderGroup);
ok('and the detachment keeps its own enhancements too', ((files[auric] || {}).kids || []).some(k => k.n === 'Enhancements' && k.c > 0));
// The attachment is total: every enhancement and stratagem is under a detachment.
let enh = 0, strat = 0, detOwn = 0;
for (const f of Object.values(files)) {
  if (f.lvl !== 'detachment') continue;
  detOwn += (f.recs || []).length;
  for (const k of (f.kids || [])) { if (k.n === 'Enhancements') enh += (k.recs || []).length; if (k.n === 'Stratagems') strat += (k.recs || []).length; }
}
t('all 935 enhancements nest under a detachment', enh, 935);
t('all 1,449 faction stratagems nest under a detachment', strat, 1449);
t('the 329 detachment records are the detachment nodes themselves', detOwn, 329);
let units = 0, frules = 0;
for (const f of Object.values(files)) {
  if (f.lvl === 'group' && f.n === 'Units') units += (f.recs || []).length;
  if (f.lvl === 'faction') frules += (f.recs || []).length;
}
t('Units across the factions are the 1,548 datasheet + 1,504 unitrules records', units, 3052);
t('the 63 faction rules sit on their faction page', frules, 63);
ok('Aeldari\'s six Detachment: Army Rules stratagems keep a named, synthetic node', !!findRec('tree/factions/xenos/aeldari/detachments/army-rules.js', 'stratagem#000009895002') && (files['tree/factions/xenos/aeldari/detachments/army-rules.js'] || {}).synthetic === 1);

// --- the render writes these files, and leaves the two-pane popup alone -------
const outDir = path.join(ROOT, 'workspace', 'wiki-tree-test');
fs.rmSync(outDir, { recursive: true, force: true });
const rendered = await new Promise(resolve => {
  const c = spawn(process.execPath, [path.join(ROOT, 'src', 'wiki-render.mjs')], { cwd: ROOT, env: Object.assign({}, process.env, { WIKI_RENDER_DIR: outDir, WIKI_RENDER_ONLY: '__none__' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', d => { out += String(d); });
  c.stderr.on('data', d => { out += String(d); });
  c.on('exit', code => resolve({ code, out }));
});
t('the render runs', rendered.code, 0);
ok('the render writes the tree index', fs.existsSync(path.join(outDir, 'tree', 'index.js')));
const written = JSON.parse(fs.readFileSync(path.join(outDir, 'tree', 'index.js'), 'utf8').replace(/^window\.WIKI_TREE_INDEX = /, '').replace(/;$/, ''));
t('and it is the same three branches', written.branches.map(b => b.n), ['Rules', 'Missions', 'Factions']);
for (const rel of ['tree/rules.js', 'tree/rules/core-rules.js', 'tree/rules/core-rules/muster-armies.js', 'tree/missions/secondary.js', 'tree/factions.js', 'tree/factions/imperium.js', 'tree/factions/imperium/adeptus-custodes.js', 'tree/factions/imperium/adeptus-custodes/detachments/auric-champions.js']) {
  ok('the render writes ' + rel, fs.existsSync(path.join(outDir, rel)));
}
// The popup's own index is untouched: 25 areas, and they still partition 6,705.
const oldIndex = JSON.parse(fs.readFileSync(path.join(outDir, 'shell-data.js'), 'utf8').replace(/^window\.WIKI_TOC = /, '').replace(/;$/, ''));
t('the popup index still has its 25 areas', oldIndex.areas.length, 25);
t('and still partitions the corpus', oldIndex.areas.reduce((n, a) => n + a.c, 0), 6705);
fs.rmSync(outDir, { recursive: true, force: true });

// --- the mutation check: the assertions above are not vacuous -----------------
const roster = factionRoster(cardTables().factionName, cardTables().factionLink);
const wire = { roster: roster, factionOf: factionAssigner(roster), allianceOf: allianceAssigner(roster, cardTables().datasheets, cardTables().keywords) };
const mutate = fn => {
  const copy = all.map(r => Object.assign({}, r));
  fn(copy);
  return tocTree(copy, pageNamer(copy), wire);
};
const moved = mutate(copy => {
  const s = copy.find(r => r.id === 'stratagem#000008931007');
  s.text = s.text.replace('Detachment: Auric Champions', 'Detachment: Renamed Host');
});
t('MUTATION: the stratagem leaves Auric Champions when its Detachment line changes', !!findIn(moved.files, 'tree/factions/imperium/adeptus-custodes/detachments/auric-champions.js', 'stratagem#000008931007'), false);
ok('MUTATION: and lands under the named synthetic node instead', !!findIn(moved.files, 'tree/factions/imperium/adeptus-custodes/detachments/renamed-host.js', 'stratagem#000008931007'));
const dropped = mutate(copy => { const i = copy.findIndex(r => r.id === 'stratagem#000008931007'); copy.splice(i, 1); });
t('MUTATION: dropping a record drops the Factions count by exactly one', dropped.index.branches[2].c, 5827);
t('MUTATION: and the placed total with it', dropped.index.placed, 6541);
const flat = mutate(copy => { copy.find(r => r.id === 'core-rules#Muster-Armies->-Q:-Can-a-unit-have-both-an-Upgrade-and-an-enhancement-?').heading = 'Floating Question'; });
t('MUTATION: a record with no ancestor no longer sits in a chapter', !!findIn(flat.files, 'tree/rules/core-rules/muster-armies.js', 'core-rules#Muster-Armies->-Q:-Can-a-unit-have-both-an-Upgrade-and-an-enhancement-?'), false);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
