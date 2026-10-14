import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readAllCorpus } from '../src/rules-corpus.mjs';
import { cardTables } from '../src/unit-card.mjs';
import { wikiTree, tocTree, pageNamer, factionRoster, factionAssigner, allianceAssigner, isAnnotation, headingSegments } from '../src/wiki-toc.mjs';

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
const byId = new Map(all.map(r => [r.id, r]));
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
const rootIds = () => { const s = new Set(); for (const f of Object.values(files)) for (const r of (f.recs || [])) s.add(r.i); return s; };
const chapterNames = () => Object.values(files).filter(f => f.lvl === 'chapter').map(f => f.n);
const idWithHeading = h => (all.find(r => r.heading === h && tree.paths.has(r.id)) || {}).id;

// --- the three branches, and what is not in the tree --------------------------
t('three branches: Rules, Missions, Factions', idx.branches.map(b => b.n), ['Rules', 'Missions', 'Factions']);
t('Rules holds the 621 placed records (444 core-rules + 176 appendix + 00)', idx.branches[0].c, 621);
t('Missions holds the 82 placed records (73 event-companion + 9 Challenger)', idx.branches[1].c, 82);
t('Factions holds 5,828 placed records', idx.branches[2].c, 5828);
t('of which placed', idx.placed, 6531);
t('the 163 index stubs are still counted', idx.excluded, [{ k: 'index', c: 163, why: 'navigation stubs, not corpus content' }]);
t('the annotation total and the attached/unattached split', [tree.stats.annotations, tree.stats.annotated, tree.stats.unattached], [270, 261, 9]);
t('unattached per book', tree.stats.unattachedByBook, { 'core-rules': 0, 'rules-appendix': 1, 'event-companion': 8 });
t('Books is dropped as front matter', [tree.stats.dropped, tree.dropped.slice().sort()], [2, ['core-rules#Introduction', 'core-rules#Introduction#2']]);
t('placed + excluded + unattached + dropped is the whole corpus', idx.placed + idx.excluded[0].c + tree.stats.unattached + tree.stats.dropped, 6705);

// --- Rules -> book -> numbered chapter -> section -----------------------------
const crBook = 'tree/rules/core-rules.js', raBook = 'tree/rules/rules-appendix.js';
t('Rules has the two books and the 00 chapter', kids('tree/rules.js').map(k => k.n), ['Core Rules', 'Rules Appendix', '00 Universal Rules Updates']);
t('Core Rules book count', kids('tree/rules.js')[0].c, 444);
t('Rules Appendix book count', kids('tree/rules.js')[1].c, 176);
t('00 is its own chapter at the end of Rules', kids('tree/rules.js')[2].c, 1);
const CORE_LABELS = ['01 Core Concepts', '02 Datasheets', '03 Moving', '04 Making Attacks', '05 Attack Sequence', '06 Other Concepts', '07 The Battle Round', '08 Command Phase', '09 Movement Phase', '10 Shooting Phase', '11 Charge Phase', '12 Fight Phase', '13 Terrain', '14 Objectives', '15 Stratagems', '16 Actions', '17 Monsters and Vehicles', '18 Transports', '19 Attached Units', '20 Strategic Reserves', '21 Flying and Surging', '22 Other Rules and Abilities', '23 Aircraft', '24 Core Abilities', '25 Muster Armies'];
t('the Rules chapter list is 01..25 in order', kids(crBook).map(k => k.n), CORE_LABELS);
t('with the measured counts', kids(crBook).map(k => k.c), [19, 8, 28, 18, 19, 10, 4, 5, 11, 8, 9, 13, 20, 11, 45, 6, 8, 12, 7, 8, 5, 6, 5, 50, 109]);
const RA_LABELS = ['01 Core Concepts', '02 Datasheets', '03 Moving', '04 Making Attacks', '05 Attack Sequence', '06 Other Concepts', '07 The Battle Round', '08 Command Phase', '09 Movement Phase', '11 Charge Phase', '12 Fight Phase', '13 Terrain', '14 Objectives', '15 Stratagems', '17 Monsters and Vehicles', '18 Transports', '19 Attached Units', '20 Strategic Reserves', '22 Other Rules and Abilities', '24 Core Abilities', '[ONE SHOT]'];
t('the appendix renumbers with the same numbers, [ONE SHOT] last', kids(raBook).map(k => k.n), RA_LABELS);
t('and its measured counts', kids(raBook).map(k => k.c), [27, 15, 7, 14, 5, 2, 2, 2, 3, 1, 1, 4, 2, 3, 1, 2, 2, 2, 1, 5, 75]);
ok('Books is not a chapter at any level', chapterNames().every(n => n !== 'Books'));
ok('NAMED: Universal Rules Updates is the 00 chapter', files['tree/rules/universal-rules-updates.js'].n === '00 Universal Rules Updates' && files['tree/rules/universal-rules-updates.js'].recs.some(r => r.i === 'rules-appendix#Universal-Rules-Updates'));
t('and its path is Rules -> 00', (tree.paths.get('rules-appendix#Universal-Rules-Updates') || []).map(p => p.n), ['Rules', '00 Universal Rules Updates']);
ok('NAMED: 2. Move Units Step is a section under 09 Movement Phase', !!findRec('tree/rules/core-rules/movement-phase.js', 'core-rules#2.-Move-Units-Step'));
ok('NAMED: 2. Shoot is a section under 10 Shooting Phase', !!findRec('tree/rules/core-rules/shooting-phase.js', 'core-rules#2.-Shoot'));
ok('1. Hit Roll is a section under 05 Attack Sequence, not a chapter', (function () { const p = tree.paths.get('core-rules#1.-Hit-Roll') || []; return p.length === 3 && p[2].n === '05 Attack Sequence' && !!findRec(p[2].f, 'core-rules#1.-Hit-Roll'); })());
ok('NAMED: an appendix entry sits under 01 Core Concepts', !!findRec('tree/rules/rules-appendix/core-concepts.js', 'rules-appendix#You'));

// --- no subsection is a sibling of its own parent -----------------------------
const childIds = new Set();
for (const list of tree.childrenOf.values()) for (const id of list) childIds.add(id);
let sibling = 0;
for (const f of Object.values(files)) for (const r of (f.recs || [])) if (childIds.has(r.i)) sibling++;
t('no chapter lists a subsection as a sibling of its parent', sibling, 0);
const visId = idWithHeading('Terrain and Visibility'), visRoot = idWithHeading('Terrain and Visibility > Gone to Ground');
ok('NAMED: Gone to Ground nests under Terrain and Visibility', visId && visRoot && (tree.childrenOf.get(visId) || []).indexOf(visRoot) !== -1 && !recs('tree/rules/core-rules/terrain.js').some(r => r.i === visRoot));
t('Terrain displays its 5 root sections, all 20 records counted', [recs('tree/rules/core-rules/terrain.js').length, files['tree/rules/core-rules/terrain.js'].c], [5, 20]);

// --- the Stratagems chapter holds core stratagems only ------------------------
const strat = 'tree/rules/core-rules/stratagems.js';
const stratTypes = recs(strat).map(r => (/Type:\s*(.+)/.exec(String((byId.get(r.i) || {}).text || '')) || [])[1] || '');
ok('no Movement/Shooting Ability is left under Stratagems', !stratTypes.some(x => /Ability/i.test(x)));
ok('no Challenger is left under Stratagems', !stratTypes.some(x => /Challenger/i.test(x)));
t('the Stratagems chapter is core stratagems plus its own text', [recs(strat).filter(r => r.i.indexOf('core-stratagem#') === 0).length, recs(strat).filter(r => r.i.indexOf('core-rules#') === 0).length], [23, 3]);
ok('NAMED: a Movement Ability moves to 03 Moving', (tree.paths.get('core-stratagem#000010851002') || []).map(p => p.n).join(' > ') === 'Rules > Core Rules > 03 Moving' && !findRec(strat, 'core-stratagem#000010851002'));
ok('NAMED: a Shooting Ability moves to 04 Making Attacks', (tree.paths.get('core-stratagem#000010812002') || []).map(p => p.n).join(' > ') === 'Rules > Core Rules > 04 Making Attacks');
ok('NAMED: the 9 Challenger records move to Missions > Events > Challenger', (tree.paths.get('core-stratagem#000010254002') || []).map(p => p.n).join(' > ') === 'Missions > Events > Challenger' && files['tree/missions/events/challenger.js'].recs.length === 9);

// --- the duplicated abilities fold -------------------------------------------
const caId = 'core-rules#Abilities';
const caRow = recs('tree/rules/core-rules/core-abilities.js').find(r => r.i === caId);
ok('the Duplicated Abilities and [TORRENT] expansions fold into Abilities', caRow && caRow.q === 17);
ok('and none of them is a row', !recs('tree/rules/core-rules/core-abilities.js').some(r => /Duplicated Abilities|\\[TORRENT\\]/.test(String((byId.get(r.i) || {}).heading || ''))));
t('the displayed Core Abilities list is 21 rows for 50 counted records', [recs('tree/rules/core-rules/core-abilities.js').length, files['tree/rules/core-rules/core-abilities.js'].c], [21, 50]);

// --- annotations are folded into their section, never rows --------------------
const annIds = new Set([...tree.attachTarget.keys(), ...tree.unattached]);
let annRows = 0;
for (const f of Object.values(files)) for (const r of (f.recs || [])) if (annIds.has(r.i)) annRows++;
t('no question, FAQ or errata is a row at any level', annRows, 0);
ok('no chapter is a FAQ, an Errata or a question', chapterNames().every(n => !/^(FAQ|Errata)$/i.test(n) && n.indexOf('?') === -1));
const PLAIN_Q = 'core-rules#Battle-shock-Rolls->-If-a-unit-becomes-battle-shocked-after-starting-an-action-does-it-stop-performing-that-action-?';
t('NAMED: a question without the Q: prefix attaches to its section', tree.attachTarget.get(PLAIN_Q), 'core-rules#Battle-shock-Rolls');
ok('and the section carries its seven', (tree.attach.get('core-rules#Battle-shock-Rolls') || []).length === 7);
ok('the section row carries the folded count', (recs('tree/rules/core-rules/core-concepts.js').find(r => r.i === 'core-rules#Battle-shock-Rolls') || {}).q === 7);

// --- Missions -> parts -> chapters -> sections -------------------------------
t('Missions has its three parts', kids('tree/missions.js').map(k => k.n), ['Events', 'Primary', 'Secondary']);
t('Events holds the machinery and the 9 Challenger records', kids('tree/missions.js')[0].c, 45);
t('Primary is the primary deck', kids('tree/missions.js')[1].c, 13);
t('Secondary is the secondary deck', kids('tree/missions.js')[2].c, 24);
ok('the Challenger chapter is under Events', kids('tree/missions/events.js').some(k => k.n === 'Challenger' && k.c === 9));
ok('the deck row carries its 18 folded questions and errata', (recs('tree/missions/secondary/secondary-mission-deck.js').find(r => r.i === 'event-companion#Secondary-Mission-deck') || {}).q === 18);
ok('NAMED: a secondary mission sits under its deck', !!findRec('tree/missions/secondary/secondary-mission-deck.js', 'event-companion#Secondary-Mission-deck'));

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
ok('the rendered 00 chapter exists', fs.existsSync(path.join(outDir, 'tree', 'rules', 'universal-rules-updates.js')));
const oldIndex = JSON.parse(fs.readFileSync(path.join(outDir, 'shell-data.js'), 'utf8').replace(/^window\.WIKI_TOC = /, '').replace(/;$/, ''));
t('the popup index still has its 25 areas', oldIndex.areas.length, 25);
t('and still partitions the corpus', oldIndex.areas.reduce((n, a) => n + a.c, 0), 6705);
fs.rmSync(outDir, { recursive: true, force: true });

// --- the mutation check: the assertions above are not vacuous -----------------
const roster = factionRoster(cardTables().factionName, cardTables().factionLink);
const wire = { roster: roster, factionOf: factionAssigner(roster), allianceOf: allianceAssigner(roster, cardTables().datasheets, cardTables().keywords) };
const mutate = (fn, opts) => { const copy = all.map(r => Object.assign({}, r)); fn(copy); return tocTree(copy, pageNamer(copy), Object.assign({}, wire, opts || {})); };
const noUru = mutate(copy => { const i = copy.findIndex(r => r.id === 'rules-appendix#Universal-Rules-Updates'); copy.splice(i, 1); });
t('MUTATION: dropping Universal Rules Updates drops the 00 chapter', noUru.files['tree/rules.js'].kids.map(k => k.n), ['Core Rules', 'Rules Appendix']);
const backToCore = mutate(copy => { const r = copy.find(x => x.id === 'core-stratagem#000010851002'); r.text = r.text.replace('Type: Movement Ability', 'Type: Core Stratagem'); });
t('MUTATION: a Movement Ability typed as a core stratagem returns to Stratagems', (backToCore.paths.get('core-stratagem#000010851002') || []).map(p => p.n).join(' > '), 'Rules > Core Rules > 15 Stratagems');
const challCore = mutate(copy => { const r = copy.find(x => x.id === 'core-stratagem#000010254002'); r.text = r.text.replace(/Type:\s*[^\n]*/, 'Type: Core Stratagem'); });
t('MUTATION: a Challenger typed as a core stratagem returns to Stratagems', (challCore.paths.get('core-stratagem#000010254002') || []).map(p => p.n).join(' > '), 'Rules > Core Rules > 15 Stratagems');
const flattened = mutate(copy => { copy.find(r => r.id === visRoot).heading = 'Gone to Ground'; });
ok('MUTATION: a subsection that loses its prefix becomes a root', !(flattened.childrenOf.get(visId) || []).includes(visRoot) && (flattened.files['tree/rules/core-rules/terrain.js'].recs || []).some(r => r.i === visRoot));
const unfolded = mutate(copy => { const r = copy.find(x => x.heading === 'Abilities > [TORRENT] > DAMAGED'); r.heading = 'Abilities > DAMAGED'; });
t('MUTATION: a [TORRENT] expansion that loses its marker becomes a row', unfolded.stats.annotations, 269);
const dropped = mutate(copy => { const i = copy.findIndex(r => r.id === 'stratagem#000008931007'); copy.splice(i, 1); });
t('MUTATION: dropping a record drops the Factions count by exactly one', dropped.index.branches[2].c, 5827);
t('MUTATION: and the placed total with it', dropped.index.placed, 6530);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
