import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, surfaceAsset, surfacePage } from '../src/wiki-surface.mjs';

// task-74 slice 2: the surface. These are the static half of the acceptance - the
// shapes, the assets, the tree's no-empty-pane property and the server wiring;
// the browser half (console, taps, network, deep link) runs against /rules/dev.
let pass = 0, fail = 0;
function t(name, got, want) { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); } }
function ok(name, got) { t(name, !!got, true); }
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// (A) the page mounts the surface and nothing else.
const page = surfacePage();
ok('(A) the page carries the toggle, the drawer, the tree and the viewscreen', ['sv-drawer-toggle', 'sv-drawer', 'sv-tree', 'sv-viewscreen', 'sv-filter', 'sv-ask'].every(id => page.indexOf('id="' + id + '"') !== -1));
ok('(A) the drawer starts closed', page.indexOf('id="sv-drawer" class="sv-drawer" aria-hidden="true"') !== -1 && page.indexOf('sv-open') === -1);
ok('(A) the client and its stylesheet are real files served by the dev route', page.indexOf('/rules/dev/surface.js') !== -1 && page.indexOf('/rules/dev/surface.css') !== -1);

// (J) the assets are files, not a template literal, and the script is whole.
const js = surfaceAsset('surface.js');
const css = surfaceAsset('surface.css');
ok('(J) surface.js is served with a javascript content type', js && /javascript/.test(js.type) && js.body.length > 2000);
ok('(J) surface.css is served with a css content type', css && /css/.test(css.type) && css.body.indexOf('.sv-drawer') !== -1);
ok('(J) the script carries its regex escapes intact (the old failure mode)', js.body.indexOf("replace(/^#/, '')") !== -1 && js.body.indexOf('/rules/data') !== -1);
ok('(J) the script marks a successful load for the browser proof', js.body.indexOf('window.WIKI_SURFACE_LOADED = true') !== -1);
ok('(J) no document.write and no second body renderer', js.body.indexOf('document.write') === -1 && js.body.indexOf("REC + '?id='") !== -1);
try { new Function(js.body); ok('(J) the script compiles in a real JS engine', true); } catch (e) { ok('(J) the script compiles in a real JS engine', false); }
ok('(J) the adapter is not a client: it holds no TOC_JS-style string', fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.mjs'), 'utf8').indexOf('TOC_JS') === -1);

// (C) no tap lands on an empty pane: every leaf node in a branch payload has rows.
const payloadDir = dataDir();
const branches = JSON.parse(fs.readFileSync(path.join(payloadDir, 'index.json'), 'utf8')).branches;
const counts = { nodes: 0, leaves: 0, leavesWithRows: 0, pageResolved: 0, empty: [] };
for (const b of branches) {
  const p = JSON.parse(fs.readFileSync(path.join(payloadDir, 'index', b.b + '.json'), 'utf8'));
  const pages = p.pages || [];
  const walk = n => {
    counts.nodes++;
    const kids = n.kids || [], recs = n.recs || [];
    if (kids.length) { kids.forEach(walk); return; }
    counts.leaves++;
    if (recs.length) { counts.leavesWithRows++; return; }
    const page = pages.filter(x => x.n === n.n && (x.recs || []).length)[0];
    if (page) { counts.pageResolved++; return; }
    counts.empty.push(b.b + ' > ' + n.n + ' (c=' + n.c + ')');
  };
  walk(p);
}
t('(C) EVERY leaf node in the payloads yields at least one row, except the one honest empty node', counts.empty, ['factions > Detachments (c=0)']);
t('(C) and leaves + page-resolved + empty equals all leaves', counts.leavesWithRows + counts.pageResolved + counts.empty.length, counts.leaves);
ok('(C) the client has a row for that node rather than a blank pane', js.body.indexOf('No records under this node.') !== -1);

// (G)(E) the tree and the record component are the payloads and the one body.
ok('(G) the filter re-renders from memory (no fetch in the filter handler)', /sv-filter[\s\S]{0,400}addEventListener\('input'/.test(js.body) && js.body.indexOf('getJson') !== js.body.lastIndexOf('getJson'));
ok('(E) a record body comes from the server route that calls recordBody', fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8').indexOf("recordBody(raw, { corpora: corpora(), index: cardIdx(), href: wikiFileFor })") !== -1);

// (H) the old surface is untouched by this slice.
const rulesHtml = fs.readFileSync(path.join(ROOT, 'src', 'rules.html'), 'utf8');
ok('(H) rules.html does not reference the surface', rulesHtml.indexOf('wiki-surface') === -1 && rulesHtml.indexOf('/rules/dev') === -1);
const server = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
ok('(A) the server has the dev route and the payload route', server.indexOf("u.pathname === '/rules/dev'") !== -1 && server.indexOf('handleSurfaceData') !== -1 && server.indexOf("'/rules/data/'") !== -1);
ok('(H) the old /wiki route is untouched', server.indexOf("u.pathname.indexOf('/wiki/') === 0") !== -1);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
