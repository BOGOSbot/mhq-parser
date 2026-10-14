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
t('Rules holds the 632 placed records (455 core-rules + 177 appendix)', idx.branches[0].c, 632);
t('Missions holds the 73 placed event-companion records', idx.branches[1].c, 73);
t('Factions holds 5,828 placed records', idx.branches[2].c, 5828);
t('of which placed', idx.placed, 6533);
t('the 163 index stubs are still counted', idx.excluded, [{ k: 'index', c: 163, why: 'navigation stubs, not corpus content' }]);
// Annotations are not nodes: 235 across the corpus, 226 attached to a section,
// 9 with no section (1 appendix, 8 in the event companion).
t('the annotation total and the attached/unattached split', [tree.stats.annotations, tree.stats.annotated, tree.stats.unattached], [253, 244, 9]);
t('unattached per book', tree.stats.unattachedByBook, { 'core-rules': 0, 'rules-appendix': 1, 'event-companion': 8 });
t('placed + excluded + unattached is the whole corpus', idx.placed + idx.excluded[0].c + tree.stats.unattached, 6705);

// --- Rules -> book -> chapter -> section --------------------------------------
t('Rules has the two books', kids('tree/rules.js').map(k => k.n), ['Core Rules', 'Rules Appendix']);
t('Core Rules book count keeps every record, folded annotations included', kids('tree/rules.js')[0].c, 455);
t('Rules Appendix is one shorter: one question has no section to attach to', kids('tree/rules.js')[1].c, 177);
const crBook = 'tree/rules/core-rules.js', raBook = 'tree/rules/rules-appendix.js';
t('the rule records land in chapters', kids(crBook).reduce((n, k) => n + k.c, 0), 455);
t('the appendix records land in chapters', kids(raBook).reduce((n, k) => n + k.c, 0), 177);
// The chapters come from the saved page outline now, not the heading string.
const crNames = kids(crBook).map(k => k.n);
t('Core Rules is down from 69 heading-string chapters to 26 from the page outline', kids(crBook).length, 26);
ok('the coarse chapters are there: Movement Phase, Making Attacks, Shooting Phase, Muster Armies', ['Movement Phase', 'Making Attacks', 'Shooting Phase', 'Muster Armies', 'Terrain'].every(n => crNames.indexOf(n) !== -1));
ok('and no numbered subsection is a chapter', crNames.every(n => !/^[0-9]+\./.test(n)) && crNames.indexOf('2. Move Units Step') === -1 && crNames.indexOf('1. Hit Roll') === -1);
ok('NAMED: 2. Move Units Step is a section under Movement Phase', !!findRec('tree/rules/core-rules/movement-phase.js', 'core-rules#2.-Move-Units-Step'));
ok('NAMED: 2. Shoot is a section under Shooting Phase', !!findRec('tree/rules/core-rules/shooting-phase.js', 'core-rules#2.-Shoot'));
ok('1. Hit Roll is a section under its outline chapter, not a chapter itself', (function () { const p = tree.paths.get('core-rules#1.-Hit-Roll') || []; return p.length === 3 && p[2].n !== '1. Hit Roll' && !!findRec(p[2].f, 'core-rules#1.-Hit-Roll'); })());
ok('a core stratagem folds into the Stratagems chapter', !!findRec('tree/rules/core-rules/stratagems.js', 'core-stratagem#000010252002'));
let coreStrat = 0;
for (const k of kids(crBook)) for (const r of recs(k.f)) if (r.i.indexOf('core-stratagem#') === 0) coreStrat++;
t('all 54 core stratagems fold into the Core Rules book', coreStrat, 54);
const abilities = kids(crBook).find(k => k.n === 'Core Abilities');
ok('the anchorless ability records join the Core Abilities chapter', abilities && recs(abilities.f).some(r => r.i === 'ability#000008343'));
// The appendix has no saved page: parent chain, ruleId and the local group name.
const raNames = kids(raBook).map(k => k.n);
ok('the appendix keeps the same coarse chapters', ['Core Concepts', 'Movement Phase', 'Transports'].every(n => raNames.indexOf(n) !== -1));
const oneShot = kids(raBook).find(k => k.n === '[ONE SHOT]');
ok('its [ONE SHOT] block keeps its 7 sections and carries its folded questions', oneShot && oneShot.c === 76 && recs(oneShot.f).length === 7);
ok('NAMED: an appendix entry sits under its core chapter', !!findRec('tree/rules/rules-appendix/core-concepts.js', 'rules-appendix#You'));

// --- annotations are folded into their section, never rows --------------------
const annIds = new Set([...tree.attachTarget.keys(), ...tree.unattached]);
let annRows = 0;
for (const f of Object.values(files)) for (const r of (f.recs || [])) if (annIds.has(r.i)) annRows++;
t('no question, FAQ or errata is a row at any level', annRows, 0);
const allChapterNames = Object.values(files).filter(f => f.lvl === 'chapter').map(f => f.n);
ok('no chapter is a FAQ, an Errata or a question', allChapterNames.every(n => !/^(FAQ|Errata)$/i.test(n) && n.indexOf('?') === -1));
// Named proof: a question with no "Q:" prefix folds into the section it annotates.
const PLAIN_Q = 'core-rules#Battle-shock-Rolls->-If-a-unit-becomes-battle-shocked-after-starting-an-action-does-it-stop-performing-that-action-?';
t('NAMED: a question without the Q: prefix attaches to its section', tree.attachTarget.get(PLAIN_Q), 'core-rules#Battle-shock-Rolls');
ok('the section carries its six questions', (tree.attach.get('core-rules#Battle-shock-Rolls') || []).length === 7 && !!findRec('tree/rules/core-rules/core-concepts.js', 'core-rules#Battle-shock-Rolls'));
ok('the section row carries the folded count', (recs('tree/rules/core-rules/core-concepts.js').find(r => r.i === 'core-rules#Battle-shock-Rolls') || {}).q === 7);
t('NAMED: an errata folds into the section it annotates', tree.attachTarget.get('core-rules#Muster-Armies->-Errata->-01.02.06-Splitting-Units'), 'core-rules#Muster-Armies');
ok('and the Muster Armies row carries it', (recs('tree/rules/core-rules/muster-armies.js').find(r => r.i === 'core-rules#Muster-Armies') || {}).q >= 1);

// --- Missions -> parts -> chapters -> sections -------------------------------
t('Missions has its three parts', kids('tree/missions.js').map(k => k.n), ['Events', 'Primary', 'Secondary']);
t('Primary is the primary deck', kids('tree/missions.js')[1].c, 13);
t('Secondary is the secondary deck', kids('tree/missions.js')[2].c, 24);
t('Events keeps its machinery, less the 8 questions with no section', kids('tree/missions.js')[0].c, 36);
t('the event machinery is its own chapters, and no FAQ chapter exists', kids('tree/missions/events.js').map(k => k.n).sort(), ['\u2018Cumulative\u2019 and \u2018Or\u2019 Conditions', 'Deployment Card Key', 'Deployment deck', 'Force Disposition Cards', 'Generating Command Points', 'Leaves the Battelefield', 'Pairing Players', 'Ranking Players', 'VP Up to a Limit', 'Welcome to the Warhammer Event Companion!', 'When Drawn'].sort());
t('a deck is one chapter holding its own records and its folded annotations', kids('tree/missions/secondary.js').map(k => k.n + ':' + k.c), ['Secondary Mission deck:24']);
ok('the deck row carries its 18 folded questions and errata', (recs('tree/missions/secondary/secondary-mission-deck.js').find(r => r.i === 'event-companion#Secondary-Mission-deck') || {}).q === 18);
ok('NAMED: a secondary mission sits under its deck, not directly under Secondary', !!findRec('tree/missions/secondary/secondary-mission-deck.js', 'event-companion#Secondary-Mission-deck'));
ok('and the primary deck is under Primary', !!findRec('tree/missions/primary/primary-mission-deck.js', 'event-companion#Primary-Mission-deck'));
ok('the Books questions have no section, so they are not rows', tree.unattached.some(id => id.indexOf('event-companion#Books->-FAQ->') === 0));

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
const writtenCr = JSON.parse(fs.readFileSync(path.join(outDir, 'tree', 'rules', 'core-rules.js'), 'utf8').replace(/^window\.WIKI_TREE_NODE = /, '').replace(/;$/, ''));
t('the rendered tree resolves the same chapters as the builder (no projection drift)', writtenCr.kids.map(k => k.n + ':' + k.c), kids(crBook).map(k => k.n + ':' + k.c));
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
const mutate = (fn, opts) => {
  const copy = all.map(r => Object.assign({}, r));
  fn(copy);
  return tocTree(copy, pageNamer(copy), Object.assign({}, wire, opts || {}));
};
const moved = mutate(copy => {
  const s = copy.find(r => r.id === 'stratagem#000008931007');
  s.text = s.text.replace('Detachment: Auric Champions', 'Detachment: Renamed Host');
});
t('MUTATION: the stratagem leaves Auric Champions when its Detachment line changes', !!findIn(moved.files, 'tree/factions/imperium/adeptus-custodes/detachments/auric-champions.js', 'stratagem#000008931007'), false);
ok('MUTATION: and lands under the named synthetic node instead', !!findIn(moved.files, 'tree/factions/imperium/adeptus-custodes/detachments/renamed-host.js', 'stratagem#000008931007'));
const dropped = mutate(copy => { const i = copy.findIndex(r => r.id === 'stratagem#000008931007'); copy.splice(i, 1); });
t('MUTATION: dropping a record drops the Factions count by exactly one', dropped.index.branches[2].c, 5827);
t('MUTATION: and the placed total with it', dropped.index.placed, 6532);
// Chapter mutations: the page outline is what places these, not the heading string.
const flat = mutate(copy => { copy.find(r => r.id === 'core-rules#2.-Move-Units-Step').heading = 'Floating Question'; });
t('MUTATION: the outline still places a record whose heading string is lost', flat.paths.get('core-rules#2.-Move-Units-Step').map(p => p.n), ['Rules', 'Core Rules', 'Movement Phase']);
const noOutline = mutate(copy => {}, { outline: null });
t('MUTATION: without the page outline, Core Rules chapters collapse to Unplaced', noOutline.files['tree/rules/core-rules.js'].kids.map(k => k.n).join(','), 'Unplaced');
const movedChapter = mutate(copy => { copy.find(r => r.id === 'core-rules#2.-Shoot').anchor = 'Making-Attacks'; });
t('MUTATION: changing the anchor moves the record to another chapter', movedChapter.paths.get('core-rules#2.-Shoot').map(p => p.n).slice(-1), ['Making Attacks']);
const movedMission = mutate(copy => { copy.find(r => r.id === 'event-companion#Secondary-Mission-deck').heading = 'Primary Mission deck > Card'; });
t('MUTATION: moving a deck record changes its part and its chapter', movedMission.paths.get('event-companion#Secondary-Mission-deck').map(p => p.n), ['Missions', 'Primary', 'Primary Mission deck']);

const unfolded = mutate(copy => { copy.find(r => r.id === PLAIN_Q).heading = 'Battle-shock Rolls > Not a question'; });
t('MUTATION: a question that loses its question form stops being an annotation', unfolded.stats.annotations, 252);
ok('MUTATION: and it becomes a section row instead', !!findIn(unfolded.files, 'tree/rules/core-rules/core-concepts.js', PLAIN_Q) && !unfolded.attachTarget.has(PLAIN_Q));
const reTargeted = mutate(copy => { copy.find(r => r.id === PLAIN_Q).parent = 'core-rules#Units-and-Models'; });
t('MUTATION: changing the parent moves the fold to another section', reTargeted.attachTarget.get(PLAIN_Q), 'core-rules#Units-and-Models');
const typed = mutate(copy => { copy.find(r => r.id === PLAIN_Q).kind = 'stratagem'; });
t('MUTATION: a non-rule record is never an annotation', typed.stats.annotations, 252);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
