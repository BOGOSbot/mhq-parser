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
const SECONDARY = 'event-companion#Secondary-Mission-deck';
const SEC = 'core-rules#Battle-shock-Rolls';
const MUSTER = 'core-rules#Muster-Armies';
const PLAIN_Q = 'core-rules#Battle-shock-Rolls->-If-a-unit-becomes-battle-shocked-after-starting-an-action-does-it-stop-performing-that-action-?';
const all = readAllCorpus();
const tree = wikiTree(all);
const names = id => (tree.paths.get(id) || []).map(p => p.n);

// --- the pre-walked path, per record kind ------------------------------------
t('a section deep in Rules walks branch / book / chapter', names(RULES_REC), ['Rules', 'Core Rules', '25 Muster Armies']);
t('a unit inside a faction walks branch / alliance / faction / Units', names(UNIT_REC), ['Factions', 'Imperium', 'Adeptus Custodes', 'Units']);
t('a stratagem walks to its own detachment', names(STRAT), ['Factions', 'Imperium', 'Adeptus Custodes', 'Detachments', 'Auric Champions']);
t('a secondary mission walks Missions / Secondary', names(SECONDARY), ['Missions', 'Secondary', 'Secondary Mission deck']);
t('NAMED: 2. Move Units Step pre-walks to Movement Phase', names('core-rules#2.-Move-Units-Step'), ['Rules', 'Core Rules', '09 Movement Phase']);
t('NAMED: 2. Shoot pre-walks to Shooting Phase', names('core-rules#2.-Shoot'), ['Rules', 'Core Rules', '10 Shooting Phase']);
ok('every placed record has a pre-walked path', tree.paths.size === tree.stats.placed);
ok('every step of every path names a file that exists', [...tree.paths.values()].every(p => p.length && p.every(s => !!tree.files[s.f])));
t('the 163 navigation stubs have no path (they are not in the tree)', (tree.paths.get('faction-index#faction-ac') || []).length, 0);
ok('the path files are the per-node files, not one tree file', [...tree.paths.values()].every(p => new Set(p.map(s => s.f)).size === p.length));

// --- the record page carries that path, and nothing else ---------------------
const outDir = path.join(ROOT, 'workspace', 'wiki-cascade-test');
fs.rmSync(outDir, { recursive: true, force: true });
const ids = [RULES_REC, UNIT_REC, STRAT, SECONDARY, SEC, PLAIN_Q, MUSTER].join(',');
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
  ['stratagem', STRAT, ['Factions', 'Imperium', 'Adeptus Custodes', 'Detachments', 'Auric Champions']],
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
// A rule page's sections and subsections collapse with native <details>.
const musterPage = pageOf(MUSTER);
ok('the rule page renders its sections as collapsible details', musterPage.indexOf('<details class="wsec"') !== -1 && musterPage.indexOf('Sections (') !== -1 && musterPage.indexOf('<summary>') !== -1);
ok('and needs no script for them', musterPage.indexOf('onclick') === -1 && musterPage.indexOf('addEventListener') === -1);
ok('the folded Q&A are collapsible too', secPage.indexOf('<details class="wqa"') !== -1 && secPage.indexOf('<summary>') !== -1);
// The payload before the cascade is opened: the root only, never a node file.
const rootJs = fs.readFileSync(path.join(outDir, 'tree', 'index.js'), 'utf8');
ok('the root the record page loads is the 3-branch index and nothing else', rootJs.indexOf('"branches"') !== -1 && rootJs.indexOf('"lvl":"chapter"') === -1 && rootJs.length < 1024);
const root = JSON.parse(rootJs.replace(/^window\.WIKI_TREE_INDEX = /, '').replace(/;$/, ''));
t('and it names the three branches', root.branches.map(b => b.n), ['Rules', 'Missions', 'Factions']);
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
ok('opening a record navigates and leaves the cascade retracted', /data-wc-rec/.test(tocSrc.TOC_JS) && /location\.href = BASE \+ f/.test(tocSrc.TOC_JS));
ok('the bar is the resting form and opens full screen', /data-wc-open/.test(tocSrc.TOC_JS) && /wcasc/.test(tocSrc.TOC_CSS) && /position:fixed;inset:0/.test(tocSrc.TOC_CSS));
ok('a back press retracts it', /history\.pushState/.test(tocSrc.TOC_JS) && /addEventListener\("popstate"/.test(tocSrc.TOC_JS));
ok('and it pre-walks the record path only when opened', /function prewalk/.test(tocSrc.TOC_JS) && /if \(herePath\.length && !path\.length\) prewalk/.test(tocSrc.TOC_JS));
ok('the state is exposed for the measurement', /window\.WIKI_CASCADE/.test(tocSrc.TOC_JS) && /fetched: Object\.keys\(CACHE\)/.test(tocSrc.TOC_JS));

// --- the mutation check: the path assertions are not vacuous ------------------
const roster = factionRoster(cardTables().factionName, cardTables().factionLink);
const wire = { roster: roster, factionOf: factionAssigner(roster), allianceOf: allianceAssigner(roster, cardTables().datasheets, cardTables().keywords) };
const mutate = fn => { const copy = all.map(r => Object.assign({}, r)); fn(copy); return tocTree(copy, pageNamer(copy), wire); };
const moved = mutate(copy => { const s = copy.find(r => r.id === STRAT); s.text = s.text.replace('Detachment: Auric Champions', 'Detachment: Renamed Host'); });
t('MUTATION: changing the Detachment line moves the stratagem in its path', (moved.paths.get(STRAT) || []).map(p => p.n).slice(-1), ['Renamed Host']);
t('MUTATION: and the old detachment file no longer names it', (moved.paths.get(STRAT) || []).map(p => p.f).indexOf('tree/factions/imperium/adeptus-custodes/detachments/auric-champions.js'), -1);
const promoted = mutate(copy => { copy.find(r => r.id === SECONDARY).heading = 'Primary Mission deck > X'; });
t('MUTATION: moving a secondary record to the primary deck changes its part and chapter', (promoted.paths.get(SECONDARY) || []).map(p => p.n), ['Missions', 'Primary', 'Primary Mission deck']);
const reparented = mutate(copy => { const r = copy.find(x => x.id === RULES_REC); r.heading = 'Floating Question'; r.parent = 'core-rules#1.-Hit-Roll'; });
t('MUTATION: reparenting a record moves it to the parent\u2019s chapter', (reparented.paths.get(RULES_REC) || []).map(p => p.n), ['Rules', 'Core Rules', '05 Attack Sequence']);
fs.rmSync(outDir, { recursive: true, force: true });

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
