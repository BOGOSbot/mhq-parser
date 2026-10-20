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
ok('(A) the client and its stylesheet are real files on their stable product paths', page.indexOf('/rules/surface.js') !== -1 && page.indexOf('/rules/surface.css') !== -1);
ok('(A) the dev route serves them as an alias', fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8').indexOf("u.pathname === '/rules/surface.js'") !== -1);

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

// (K) task-36: the landing page's find box enters through the drawer's own door.
// The page types a name and calls find(); the DRAWER owns the field, the search and
// the route, so there is no second pipeline and no second endpoint to keep in step.
ok('(K) the surface exposes find for the landing page', js.body.indexOf('find: function (q)') !== -1);
ok('(K) find opens the drawer', /find: function \(q\)[\s\S]{0,700}drawerOpen\(true\)/.test(js.body));
ok('(K) find fills the drawer own search field', /find: function \(q\)[\s\S]{0,700}\$\('sv-filter'\)/.test(js.body) && /find: function \(q\)[\s\S]{0,700}box\.value = name/.test(js.body));
ok('(K) find runs the drawer own search', /find: function \(q\)[\s\S]{0,900}runSearch\(name\)/.test(js.body));
// The index draw would replace the hits, so the search must wait for it: drawerOpen
// returns openIndex()'s promise and find chains on it. Both halves are pinned.
ok('(K) drawerOpen returns the index promise', /if \(want\) \{ var opened = openIndex\(\); searchLater\(\); return opened; \}/.test(js.body));
ok('(K) and find chains the search on it', /Promise\.resolve\(drawerOpen\(true\)\)\.then/.test(js.body));
// The only route either box uses.
ok('(K) the search route is still the drawer single /rules/find', js.body.indexOf("var FIND = CFG.find || '/rules/find'") !== -1 && js.body.indexOf('FIND + ') !== -1);
ok('(K) and find adds no endpoint of its own', !/find: function \(q\)[\s\S]{0,900}fetch\(/.test(js.body));

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
ok('(G) the filter re-renders from memory, with no fetch in the handler', js.body.indexOf("addEventListener('input', function () { state.filter") !== -1);
ok('(E) a record body comes from the server route that calls recordBody, with the record id', fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8').indexOf("recordBody(raw, { corpora: corpora(), index: cardIdx(), href: wikiFileFor, selfId: raw.id })") !== -1);
ok('(E2) the client never calls recordBody itself', (js.body.match(/recordBody\(/g) || []).length === 0);

// (3) the ask, the tail, the icon and the copy - the slice-3 targets.
const srv = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');

// task-102: the record endpoint looks a record up in corpora(), so every set the drawer lists
// must be in it. The rulings half was missing and every WTC/FEQ record answered 404 - 'The
// record could not be loaded.' - while the drawer listed it. This is the cheap guard for it.
ok('(E3) the server reads all three corpus sets', /corpusCache = \{ rules: readAllCorpus\('rules'\), factions: readAllCorpus\('factions'\), rulings: readAllCorpus\('rulings'\) \}/.test(srv));
ok('(E4) and every id lookup covers them', (srv.match(/for \(const half of \['rules', 'factions', 'rulings'\]\)/g) || []).length === 2);
ok('(3) the client asks the same endpoint the old page uses', js.body.indexOf("CFG.ask || '/rules/ask'") !== -1);
ok('(3) the icon writes BOTH channels through the existing endpoints', js.body.indexOf("CFG.vote || '/rules/vote'") !== -1 && js.body.indexOf("CFG.answered || '/rules/answered'") !== -1 && js.body.indexOf("postJson(VOTE, { id: id, vote: 'up' })") !== -1 && js.body.indexOf("postJson(ANSWERED, { id: id, by: f.id })") !== -1 && js.body.indexOf("postJson(VOTE, { id: id, vote: 'down' })") !== -1 && js.body.indexOf("postJson(ANSWERED, { id: id, none: true })") !== -1);
ok('(3) the tail renders under a heading that says it is unjudged', js.body.indexOf("Also matched, not judged") !== -1);
ok('(7) the refusal copy names what is on screen, not a number the protection layer can move', js.body.indexOf('None of the judged findings states the rule.') !== -1 && js.body.indexOf('top ten') === -1);
ok('(3) none of these is at the foot, not on a finding', js.body.indexOf("el('div', 'sv-foot')") !== -1 && js.body.indexOf("sv-none") !== -1);
ok('(3) the server returns the tail and the trace id, and slugs the findings', srv.indexOf('tail: withSlug(tail)') !== -1 && srv.indexOf('traceId, judge, answer') !== -1 && srv.indexOf('surfaceSlugMap') !== -1);
// (a) the reader never sees a raw record id or a bare source string in the meta.
ok('(a) the row meta is the book, not the record id', js.body.indexOf("[r.source, r.id].join") === -1 && js.body.indexOf('bookLabel(r.slug)') !== -1);
ok('(a) page mode meta is kind + book', js.body.indexOf("[kindLabel(record.kind), bookLabel(record.slug)]") !== -1 && js.body.indexOf('[record.kind, record.source, record.set]') === -1);
ok('(b) the dead empty-expression snippet line is gone', js.body.indexOf("r.snippet ? '' : ''") === -1);
ok('(c) a cold page says Open the wiki, a warm one says Back', js.body.indexOf("cold ? 'Open the wiki'") !== -1 && js.body.indexOf("'sv-back'") !== -1);
ok('(d) the row cap has head-room and a visible overrun line', js.body.indexOf('var ROW_CAP = 500;') !== -1 && js.body.indexOf('more not shown.') !== -1);

// (H) the old surface is untouched by this slice. task-8 mounts it on the page by
// name, so the check is the mount contract, not the absence of the string.
const rulesHtml = fs.readFileSync(path.join(ROOT, 'src', 'rules.html'), 'utf8');
ok('(H) rules.html mounts the surface it owns', rulesHtml.indexOf('window.WIKI_SURFACE') !== -1 && rulesHtml.indexOf('/rules/surface.js') !== -1);
const server = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
ok('(A) the server has the dev route and the payload route', server.indexOf("u.pathname === '/rules/dev'") !== -1 && server.indexOf('handleSurfaceData') !== -1 && server.indexOf("'/rules/data/'") !== -1);
ok('(H) the /wiki route is deleted from the server', fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8').indexOf("u.pathname.indexOf('/wiki/')") === -1);
// --- task-76 polish: honest feedback, distinguishable tail, one meta shape ---
ok('(1) the icon reports what the server answered, and no id means no claim', js.body.indexOf('r.saved === true') !== -1 && js.body.indexOf("'Not kept (traces off)'") !== -1 && js.body.indexOf("'Recorded'") !== -1 && js.body.indexOf('if (!id) { none.textContent') !== -1);
ok('(1) the foot button has both endings, not an unconditional one', js.body.indexOf("none.textContent = (r && r.saved === true) ? 'Recorded: none of these'") !== -1);
ok('(2) tail rows carry the heading chain and a dedupe suffix', js.body.indexOf('chain.slice(1).join') !== -1 && js.body.indexOf("+= ' (' + (f.n || '') + ')'") !== -1);
ok('(3) the meta falls back to the faction then the source, so the shape holds', js.body.indexOf('SOURCE_BOOKS') !== -1 && js.body.indexOf("String(f.faction || '')") !== -1);
ok('(4) a cut snippet is marked', js.body.indexOf('function cut(text, n)') !== -1 && js.body.indexOf(String.fromCharCode(92) + 'u2026') !== -1);
ok('(7) the refusal copy names no number it cannot keep', js.body.indexOf('None of the judged findings states the rule.') !== -1 && js.body.indexOf('the top ten') === -1);
ok('(6) a new answer scrolls under the header, not behind it', js.body.indexOf('window.scrollTo(0, 0);') !== -1);

// --- task-81: the five defects -------------------------------------------------
ok('(81-1) a page is matched by the faction in the node key, not by its name', /function pageFor\(n, key\)/.test(js.body) && /p\.area === area/.test(js.body) && /pageFor\(n, key\)/.test(js.body));
// task-89: the drawer TREE row is the numbered title only. The findings/tail rows keep their
// own meta and snippet - those are different components and different jobs.
const recFn = js.body.slice(js.body.search(/function renderRec\(/), js.body.indexOf('function toggleInline('));
ok('(81-2) the drawer row is the numbered title only - no book label, no preview', recFn.indexOf('sv-rec-title') !== -1 && recFn.indexOf('sv-rec-meta') === -1 && recFn.indexOf('sv-rec-snip') === -1);
ok('(81-F) and the filter still reads the payload snippet', js.body.indexOf('matches(r.snippet)') !== -1);
ok('(81-3) a page or owned id renders through the on-demand rows file', js.body.indexOf('function rowFromBranch(id)') !== -1 && js.body.indexOf("'-rows.json'") !== -1 && /p\.recs\.map\(function \(id\) \{ return rowFromBranch\(id\); \}\)/.test(js.body) && /r\.own\.map\(function \(id\) \{ return rowFromBranch\(id\); \}\)/.test(js.body));
ok('(81-3b) the rows file is fetched once per branch and cached', js.body.indexOf('state.rowsLoading[b]') !== -1 && js.body.indexOf('state.rowsCache[b] =') !== -1);
ok('(81-3) a detachment row lists what it owns', js.body.indexOf("'Its enhancements and stratagems ('") !== -1 && js.body.indexOf('sv-ownlist') !== -1);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
