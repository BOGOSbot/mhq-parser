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
const RULES_REC = 'core-rules#Muster-Armies->-Q:-Can-a-unit-have-both-an-Upgrade-and-an-enhancement-?';
const UNIT_REC = 'datasheet#000000882';
const STRAT = 'stratagem#000008931007';
const SECONDARY = 'event-companion#Secondary-Mission-deck->-no-prisoners';
const SEC = 'core-rules#Battle-shock-Rolls';
const MUSTER = 'core-rules#Muster-Armies';
const PLAIN_Q = 'core-rules#Battle-shock-Rolls->-If-a-unit-becomes-battle-shocked-after-starting-an-action-does-it-stop-performing-that-action-?';
const all = readAllCorpus();
const tree = wikiTree(all);
const names = id => (tree.paths.get(id) || []).map(p => p.n);

// --- the pre-walked path, per record kind ------------------------------------
t('a section deep in Rules walks branch / book / chapter', names(RULES_REC), ['Rules', 'Core Rules', '25 Muster Armies']);
t('a unit inside a faction walks branch / alliance / faction / Units', names(UNIT_REC), ['Factions', 'Imperium', 'Adeptus Custodes', 'Units']);
t('a stratagem walks to the Detachments level, where its detachment is a row', names(STRAT), ['Factions', 'Imperium', 'Adeptus Custodes', 'Detachments']);
t('a secondary mission walks Missions / Secondary', names(SECONDARY), ['Missions', 'Secondary', 'Secondary Mission deck']);
t('NAMED: 2. Move Units Step pre-walks to Movement Phase', names('core-rules#2.-Move-Units-Step'), ['Rules', 'Core Rules', '09 Movement Phase']);
t('NAMED: 2. Shoot pre-walks to Shooting Phase', names('core-rules#2.-Shoot'), ['Rules', 'Core Rules', '10 Shooting Phase']);
ok('every placed record has a pre-walked path', tree.paths.size === tree.stats.placed);
ok('every step of every path names a file that exists', [...tree.paths.values()].every(p => p.length && p.every(s => !!tree.files[s.f])));
t('the 163 navigation stubs have no path (they are not in the tree)', (tree.paths.get('faction-index#faction-ac') || []).length, 0);
ok('the path files are the per-node files, not one tree file', [...tree.paths.values()].every(p => new Set(p.map(s => s.f)).size === p.length));
// A merged twin is the same rule split into parts: it pre-walks where its primary
// does. Before this was pinned, every twin was handed the path of whichever
// faction the walk reached last - measured, all 1,774 of them, core-rules twins
// included, pre-walked to Tyranids.
t('a core-rules twin pre-walks in Core Rules, not inside a faction', names('core-rules#Battle-shock-Rolls~2').slice(0, 2), ['Rules', 'Core Rules']);
ok('every merged twin pre-walks exactly where its primary does', [...tree.mergedOn].every(([primary, list]) => list.every(id => JSON.stringify(names(id)) === JSON.stringify(names(primary)))));

// --- the record page carries that path, and nothing else ---------------------
const outDir = path.join(ROOT, 'workspace', 'wiki-cascade-test');
fs.rmSync(outDir, { recursive: true, force: true });
const SEER = 'detachment#000001023';
const AURIC = [...tree.owned.entries()].find(pair => pair[1].strat.indexOf(STRAT) !== -1)[0];
const ids = [RULES_REC, UNIT_REC, STRAT, SECONDARY, SEC, PLAIN_Q, MUSTER, AURIC, SEER].join(',');
const rendered = await new Promise(resolve => {
  const c = spawn(process.execPath, [path.join(ROOT, 'src', 'wiki-render.mjs')], { cwd: ROOT, env: Object.assign({}, process.env, { WIKI_RENDER_DIR: outDir, WIKI_RENDER_ONLY: ids }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', d => { out += String(d); });
  c.stderr.on('data', d => { out += String(d); });
  c.on('exit', code => resolve({ code, out }));
});
t('the render runs', rendered.code, 0);
const map = JSON.parse(fs.readFileSync(path.join(outDir, 'map.json'), 'utf8'));
const pageOf = id => fs.readFileSync(path.join(outDir, map[id]), 'utf8');
const hereOf = id => JSON.parse(/window\.WIKI_HERE = (\{.*?\});<\/script>/.exec(pageOf(id).replace(/\n/g, ''))[1]);
for (const [label, id, want] of [
  ['rules section', RULES_REC, ['Rules', 'Core Rules', '25 Muster Armies']],
  ['unit', UNIT_REC, ['Factions', 'Imperium', 'Adeptus Custodes', 'Units']],
  ['stratagem', STRAT, ['Factions', 'Imperium', 'Adeptus Custodes', 'Detachments']],
  ['secondary mission', SECONDARY, ['Missions', 'Secondary', 'Secondary Mission deck']],
]) {
  const here = hereOf(id);
  t('the ' + label + ' page carries its own path for the cascade', here.path.map(p => p.n), want);
  t('and a leaf title, not the whole heading', here.title.indexOf(' > '), -1);
  const page = pageOf(id);
  ok('the ' + label + ' page loads the cascade root, not the retired index', page.indexOf('src="tree/index.js"') !== -1 && page.indexOf('src="shell-data.js"') === -1);
  ok('the ' + label + ' page inlines no node file (the cascade fetches on open)', page.indexOf('WIKI_TREE_NODE') === -1 && page.indexOf('"kids"') === -1 && page.indexOf('"recs"') === -1);
  ok('the ' + label + ' page stays small enough to load on a phone', page.length < 70000);
}
// The annotations are folded into their section's page, and point back to it.
const secPage = pageOf(SEC);
ok('the annotated section page renders its folded Q&A', secPage.indexOf('Questions and errata (7)') !== -1 && secPage.indexOf('href="' + map[PLAIN_Q] + '"') !== -1);
t('and its WIKI_HERE still walks to its chapter', hereOf(SEC).path.map(p => p.n), ['Rules', 'Core Rules', '01 Core Concepts']);
const qPage = pageOf(PLAIN_Q);
ok('a folded question keeps its own page and points back to its section', qPage.indexOf('Folded into') !== -1 && qPage.indexOf(map[SEC]) !== -1);
t('and its WIKI_HERE opens the cascade on its section', hereOf(PLAIN_Q).at, SEC);
ok('with the section path, not its own', hereOf(PLAIN_Q).path.map(p => p.n).join(' > '), ['Rules', 'Core Rules', '01 Core Concepts'].join(' > '));
// One page per detachment: its own enhancements and stratagems, no subsection row.
const detPage = pageOf(AURIC);
ok('the detachment page holds its enhancements and stratagems', detPage.indexOf('Enhancements (') !== -1 && detPage.indexOf('Stratagems (') !== -1 && detPage.indexOf(map[STRAT]) !== -1);
ok('the detachment is a row in the Detachments level, with its owned count and no kids', (function () { const f = tree.files['tree/factions/imperium/adeptus-custodes/detachments.js']; const row = f.recs.find(r => r.i === AURIC); return !!(row && row.q > 0 && !('kids' in f)); })());
// task-72: the card IS the merge - the twin's keywords and abilities are already
// printed on it - so the page no longer repeats them under a 'Merged records' head.
ok('the card is the merge: the page does not repeat the unitrules twin', pageOf(UNIT_REC).indexOf('Merged records (') === -1 && tree.mergedOn.has(UNIT_REC));
ok('and that content is on the card instead', /Core abilities and army rules/.test(pageOf(UNIT_REC)));
// Mandal's guard rail: the name is never the filter. The Seer Council detachment
// still renders its Strands of Fate ability after the edition filters run.
const seerPage = pageOf(SEER);
ok('the Seer Council page still renders its Strands of Fate ability', seerPage.indexOf('Strands of Fate') !== -1);
ok('and the page still owns its enhancements and stratagems', seerPage.indexOf('Enhancements (') !== -1 && seerPage.indexOf('Stratagems (') !== -1);
// A rule page's sections and subsections collapse with native <details>.
const musterPage = pageOf(MUSTER);
ok('the rule page renders its sections as collapsible details', musterPage.indexOf('<details class="wsec"') !== -1 && musterPage.indexOf('Sections (') !== -1 && musterPage.indexOf('<summary>') !== -1);
ok('and needs no script for them', musterPage.indexOf('onclick') === -1 && musterPage.indexOf('addEventListener') === -1);
ok('the folded Q&A are collapsible too', secPage.indexOf('<details class="wqa"') !== -1 && secPage.indexOf('<summary>') !== -1);
// The payload before the cascade is opened: the root only, never a node file.
const rootJs = fs.readFileSync(path.join(outDir, 'tree', 'index.js'), 'utf8');
ok('the root the record page loads is the 4-branch index and nothing else', rootJs.indexOf('"branches"') !== -1 && rootJs.indexOf('"lvl":"chapter"') === -1 && rootJs.length < 1024);
const root = JSON.parse(rootJs.replace(/^window\.WIKI_TREE_INDEX = /, '').replace(/;$/, ''));
t('and it names the three branches, Rulings inside Rules', root.branches.map(b => b.n), ['Rules', 'Missions', 'Factions']);
// One level costs one node file: the unit page's own level is its Units file.
const unitsFile = tree.paths.get(UNIT_REC).slice(-1)[0].f;
ok('one level is one file, fetched by name', root.branches.length === 3 && unitsFile.indexOf('tree/factions/imperium/adeptus-custodes/units.js') === 0);
// The cold /wiki/: no record, so the cascade rests at the root.
const home = fs.readFileSync(path.join(outDir, 'home.html'), 'utf8');
ok('the cold /wiki/ carries no WIKI_HERE', home.indexOf('WIKI_HERE') === -1);
ok('and it loads the cascade root', home.indexOf('src="tree/index.js"') !== -1);
ok('with the top bar, so the resting bar has its mount', home.indexOf('class="wtop"') !== -1);
// The retired two-pane data is still written, so nothing that read it breaks.
ok('the retired index is still written', fs.existsSync(path.join(outDir, 'shell-data.js')));
ok('and the retired area file', fs.existsSync(path.join(outDir, 'toc-core-rules.js')));

// --- the cascade behaviour, one implementation -------------------------------
const tocSrc = await import('../src/wiki-toc.mjs');
ok('the root variable is the three-branch index', /window\.WIKI_TREE_INDEX/.test(tocSrc.TOC_JS));
ok('a node is fetched by name, on demand', /function loadNode/.test(tocSrc.TOC_JS) && /s\.src = BASE \+ f/.test(tocSrc.TOC_JS));
ok('the left column jumps back to any level', /data-wc-jump/.test(tocSrc.TOC_JS) && /wccol/.test(tocSrc.TOC_CSS));
ok('the pane opens the next level down', /data-wc-node/.test(tocSrc.TOC_JS) && /wcpane/.test(tocSrc.TOC_CSS));
// task-73: a record opens IN the page (its <main class="wrec"> moved in); navigation
// to the rendered page stays the fallback when the fetch or the parse fails.
ok('opening a record renders it in the page, and leaves the cascade retracted',
  /data-wc-rec/.test(tocSrc.TOC_JS) && /function showRec/.test(tocSrc.TOC_JS)
  && /data-wc-back/.test(tocSrc.TOC_JS) && /#wcr=/.test(tocSrc.TOC_JS)
  && /location\.href = BASE \+ f/.test(tocSrc.TOC_JS));
// task-72: the index opens in the page, under the top bar - never over the banner.
ok('the bar is the resting form and opens the index under the banner',
  /data-wc-open/.test(tocSrc.TOC_JS) && /wcasc/.test(tocSrc.TOC_CSS)
  && /TOP\.parentNode\.insertBefore\(o, TOP\.nextSibling\)/.test(tocSrc.TOC_JS)
  && /calc\(100vh - var\(--wcasc-top/.test(tocSrc.TOC_CSS)
  && !/\.wcasc\{position:fixed/.test(tocSrc.TOC_CSS));
ok('a back press retracts it', /history\.pushState/.test(tocSrc.TOC_JS) && /addEventListener\("popstate"/.test(tocSrc.TOC_JS));
ok('and it pre-walks the record path only when opened', /function prewalk/.test(tocSrc.TOC_JS) && /if \(herePath\.length && !path\.length\) prewalk/.test(tocSrc.TOC_JS));
ok('the state is exposed for the measurement', /window\.WIKI_CASCADE/.test(tocSrc.TOC_JS) && /fetched: Object\.keys\(CACHE\)/.test(tocSrc.TOC_JS));

// --- the mutation check: the path assertions are not vacuous ------------------
const roster = factionRoster(cardTables().factionName, cardTables().factionLink);
const wire = { roster: roster, factionOf: factionAssigner(roster), allianceOf: allianceAssigner(roster, cardTables().datasheets, cardTables().keywords) };
const mutate = fn => { const copy = all.map(r => Object.assign({}, r)); fn(copy); return tocTree(copy, pageNamer(copy), wire); };
const moved = mutate(copy => { const s = copy.find(r => r.id === STRAT); s.text = s.text.replace('Detachment: Auric Champions', 'Detachment: Renamed Host'); });
ok('MUTATION: changing the Detachment line takes the stratagem off its old detachment', ((moved.owned.get(AURIC) || {}).strat || []).indexOf(STRAT) === -1);
ok('MUTATION: and a page for the new detachment now owns it', moved.pages.some(pg => pg.n === 'Renamed Host' && pg.recs.indexOf(STRAT) !== -1));
t('MUTATION: the path still lands on the Detachments level', (moved.paths.get(STRAT) || []).map(p => p.n).join(' > '), 'Factions > Imperium > Adeptus Custodes > Detachments');
const promoted = mutate(copy => { copy.find(r => r.id === SECONDARY).heading = 'Primary Mission deck > X'; });
t('MUTATION: moving a secondary record to the primary deck changes its part and chapter', (promoted.paths.get(SECONDARY) || []).map(p => p.n), ['Missions', 'Primary', 'Primary Mission deck']);
const reparented = mutate(copy => { const r = copy.find(x => x.id === RULES_REC); r.heading = 'Floating Question'; r.parent = 'core-rules#1.-Hit-Roll'; });
t('MUTATION: reparenting a record moves it to the parent\u2019s chapter', (reparented.paths.get(RULES_REC) || []).map(p => p.n), ['Rules', 'Core Rules', '05 Attack Sequence']);
// The filtered set is the single source of truth for every surface a reader can
// reach: no search row, no tree node, no delivered page, no fragment.
const EXCLUDED = 'faction-rule#000008445';
const walkFiles = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walkFiles(path.join(d, e.name)) : [path.join(d, e.name)]);
const searchHtml = fs.readFileSync(path.join(outDir, 'search.html'), 'utf8');
ok('search.html does not index the filtered rule', searchHtml.indexOf('Strands of Fate') === -1);
ok('and does not name its id', searchHtml.indexOf(EXCLUDED) === -1);
ok('map.json delivers no page for it', !Object.prototype.hasOwnProperty.call(map, EXCLUDED));
ok('no rendered page names it', walkFiles(outDir).filter(f => f.endsWith('.html')).every(f => fs.readFileSync(f, 'utf8').indexOf(EXCLUDED) === -1));
ok('no tree node file names it', walkFiles(path.join(outDir, 'tree')).every(f => fs.readFileSync(f, 'utf8').indexOf(EXCLUDED) === -1));
ok('and no rendered page links it', walkFiles(outDir).filter(f => f.endsWith('.html')).every(f => fs.readFileSync(f, 'utf8').indexOf('faction-rule_000008445') === -1));

fs.rmSync(outDir, { recursive: true, force: true });

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
