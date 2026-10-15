import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = path.join(ROOT, 'workspace', 'rules-corpus');
const TMP = path.join(ROOT, 'workspace', 'render-prune-test');
const CORPUS = path.join(TMP, 'corpus');
const OUT = path.join(TMP, 'out');
const ID = 'datasheet#000000882';
const PAGE = /-[a-z0-9]{4,8}\.html$/;

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(CORPUS, 'csv'), { recursive: true });
for (const f of fs.readdirSync(path.join(LIVE, 'csv'))) fs.copyFileSync(path.join(LIVE, 'csv', f), path.join(CORPUS, 'csv', f));
fs.copyFileSync(path.join(LIVE, 'factions-csv.json'), path.join(CORPUS, 'factions-csv.json'));

const render = only => new Promise(resolve => {
  const c = spawn(process.execPath, [path.join(ROOT, 'src', 'wiki-render.mjs')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { RULES_CORPUS_DIR: CORPUS, WIKI_RENDER_DIR: OUT, WIKI_RENDER_ONLY: only }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  c.stdout.on('data', d => { out += String(d); });
  c.stderr.on('data', d => { out += String(d); });
  c.on('exit', code => resolve({ code, out }));
});
const mapOf = () => JSON.parse(fs.readFileSync(path.join(OUT, 'map.json'), 'utf8'));
const pagesIn = () => fs.readdirSync(OUT).filter(f => PAGE.test(f));

let r = await render(ID);
t('the render runs', r.code, 0);
const map1 = mapOf();
const p1 = map1[ID];
ok('the page is named <base>-<hash>.html and exists', !!p1 && PAGE.test(p1) && fs.existsSync(path.join(OUT, p1)));

// The rebuild's own failure mode: an id changes (the positional ~n suffix), so the
// page an earlier pass wrote is a name no record carries any more.
const file = path.join(CORPUS, 'factions-csv.json');
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const rec = j.sections.find(s => s.id === ID);
rec.id = ID + '~9';
for (const s of j.sections) {
  if (s.parent === ID) s.parent = ID + '~9';
  if (Array.isArray(s.children)) s.children = s.children.map(x => (x === ID ? ID + '~9' : x));
}
fs.writeFileSync(file, JSON.stringify(j));
// A hand-authored file the sweep does not own, and a stale tree node it does.
fs.writeFileSync(path.join(OUT, 'keep-me.html'), '<p>mine</p>');
fs.mkdirSync(path.join(OUT, 'tree'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'tree', 'stale-node.js'), 'window.WIKI_TREE_NODE = {};');

r = await render(ID + '~9');
t('the second render runs', r.code, 0);
const map2 = mapOf();
const p2 = map2[ID + '~9'];
ok('the new id gets its own page', !!p2 && p2 !== p1 && fs.existsSync(path.join(OUT, p2)));
ok('MUTATION: the old page is gone', !fs.existsSync(path.join(OUT, p1)));
ok('a hand-authored file without a content hash is not owned and survives', fs.existsSync(path.join(OUT, 'keep-me.html')));
ok('a stale tree node is swept', !fs.existsSync(path.join(OUT, 'tree', 'stale-node.js')));
t('the directory holds no page for an id absent from the corpus', pagesIn(), [p2]);
t('and map.json names exactly the pages written', Object.values(map2), [p2]);
ok('the assets the pass writes are still there', ['shell.css', 'card.css', 'shell.js', 'search.html', 'index.html'].every(f => fs.existsSync(path.join(OUT, f))));
ok('and the tree root it wrote', fs.existsSync(path.join(OUT, 'tree', 'index.js')));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
