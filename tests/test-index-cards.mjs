import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOC_CSS, TOC_JS, wikiTree } from '../src/wiki-toc.mjs';
import { readAllCorpus } from '../src/rules-corpus.mjs';

// task-53 + task-54: the index is a card row in the top bar, and reaching a
// cutoff expands the entry's full text in place instead of navigating. The
// record pages and their routes are untouched - direct links, the /rules dialog
// and the offline download still use them; only the index stops navigating.
//
// Deep link: an expanded entry is #wc=<node file>, pushed as a history entry, so
// Back closes the expansion and does not leave the page. A record row still opens
// its record page.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = TOC_JS;

// --- the cards -----------------------------------------------------------------
ok('the index renders as a card row', js.indexOf('wccards') !== -1 && js.indexOf('el("button", "wccard') !== -1);
// task-61: the cards ARE the entries - the row holds the current level's nodes and
// records, and the old .wcrow list is gone from the pane (the pane is the
// expansion surface only).
// The split Mandal asked for: the top bar is the INDEX (path cards only), the
// BODY carries the current level's choices. Task-61 had it the other way round and
// left the body empty at every non-leaf, which is the regression this pins shut.
ok('the top bar carries the path, not the entries', js.indexOf('entryCards(pane, current())') !== -1 && js.indexOf('entryCards(col, current())') === -1);
ok('the body entries are built by the same builders', js.indexOf('function entryCards(') !== -1 && js.indexOf('function nodeCard(') !== -1 && js.indexOf('function recCard(') !== -1);
ok('the body is never blank even when a node has nothing', js.indexOf('Nothing under this node') !== -1);
ok('the body rows are styled apart from the path pills', TOC_CSS.indexOf('#wcpane .wccard{') !== -1);
ok('the old row list is gone', js.indexOf('wcrow') === -1 && js.indexOf('level(current())') === -1);
ok('a 0x chapter is a non-clickable label, not a card', js.indexOf('wclabel') !== -1 && js.indexOf('test(String(k.n))') !== -1 && js.indexOf('nodeCard(k)') !== -1);
ok('the expansion walks the child files', js.indexOf('function collectRecords(') !== -1 && js.indexOf('collectRecords(files[i], acc, seen, fin)') !== -1);
// The exact case that printed '0 record(s)': tree/rulings/wtc.js holds no records
// of its own (they live in per-faction child files). Assert the INVARIANT, never
// the counts: the walk finds records the node itself does not hold, and the two
// documents together add up to the tree's own ruling count. Hard-coded 120/34
// rotted the moment 79 rulings were folded onto their targets.
ok('the walk finds the records a node keeps in child files, and they add up', (function () {
  const DIR = path.join(ROOT, 'workspace', 'wiki-render');
  const load = f => {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    const win = {};
    new Function('window', src)(win);
    return win.WIKI_TREE_NODE;
  };
  const walk = (f, acc, seen) => {
    const n = load(f);
    for (const r of (n.recs || [])) acc.push(r);
    for (const k of (n.kids || [])) if (k.f && !seen[k.f]) { seen[k.f] = 1; walk(k.f, acc, seen); }
    return acc;
  };
  const wtcNode = load('tree/rulings/wtc.js');
  const wtc = walk('tree/rulings/wtc.js', [], {}).length;
  const feq = walk('tree/rulings/feq.js', [], {}).length;
  const expected = wikiTree(readAllCorpus()).stats.rulings;
  return (wtcNode.recs || []).length === 0 && wtc > 0 && feq > 0 && wtc + feq === expected;
})());
ok('and the node itself really holds none (the bug was reading only node.recs)', (function () {
  const src = fs.readFileSync(path.join(ROOT, 'workspace', 'wiki-render', 'tree', 'rulings', 'wtc.js'), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return (win.WIKI_TREE_NODE.recs || []).length === 0 && (win.WIKI_TREE_NODE.kids || []).length > 0;
})());
ok('the CSS carries the card row at full width', TOC_CSS.indexOf('.wccards{') !== -1 && TOC_CSS.indexOf('.wccard{') !== -1 && !/\.wccards\{[^}]*max-width:220px/.test(TOC_CSS));

// --- the cutoff expands in place ----------------------------------------------
ok('a cutoff entry is marked', js.indexOf('data-wc-cut') !== -1 && js.indexOf('if (k.cut) r.setAttribute') !== -1);
ok('clicking a cutoff expands it instead of drilling', /data-wc-cut.*expandInline.*drill/.test(js) || (js.indexOf('expandInline(nf') !== -1 && js.indexOf('drill(nf') !== -1));
ok('the expansion fetches the record route the page already uses', js.indexOf('/rules/record?id=') !== -1 && js.indexOf('format=html') !== -1);
ok('and renders full text, not a link list', js.indexOf('renderExpanded') !== -1 && js.indexOf('details') !== -1);
ok('the CSS carries the expanded record blocks', TOC_CSS.indexOf('.wcrec{') !== -1 && TOC_CSS.indexOf('.wcexpand{') !== -1);

// --- the record pages and routes survive --------------------------------------
ok('a record row still opens its record page', js.indexOf('function openRec') !== -1 && js.indexOf('location.href = BASE + f') !== -1);
t('the index has exactly one navigating path: the record row', (js.match(/location\.href/g) || []).length, 1);
const server = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
ok('the server still serves /rules/record', server.indexOf("'/rules/record'") !== -1 && server.indexOf('handleRulesRecord') !== -1);
ok('and the wiki pages', server.indexOf('handleWiki') !== -1);

// --- the deep link and Back ----------------------------------------------------
ok('the deep link is #wc=<node file>', js.indexOf('#wc=') !== -1 && js.indexOf('history.pushState') !== -1);
ok('a hashchange outside #wc= closes the expansion', /hashchange[\s\S]{0,400}expandedF = null/.test(js.replace(/' \+\n/g, ' ')) || js.indexOf('if (expandedF) { expandedF = null; render(); }') !== -1);
ok('and a #wc= hash opens it on load', js.indexOf('location.hash.slice(4)') !== -1);

// --- the rendered artifacts ----------------------------------------------------
const shell = path.join(ROOT, 'workspace', 'wiki-render', 'shell.js');
if (fs.existsSync(shell)) {
  const sh = fs.readFileSync(shell, 'utf8');
  ok('the rendered shell carries the card row', sh.indexOf('wccards') !== -1 && sh.indexOf('expandInline') !== -1);
  const css = fs.readFileSync(path.join(ROOT, 'workspace', 'wiki-render', 'shell.css'), 'utf8');
  ok('the rendered stylesheet carries the cards', css.indexOf('.wccards{') !== -1);
  const doc = fs.readFileSync(path.join(ROOT, 'workspace', 'wiki-render', 'tree', 'rulings', 'wtc.js'), 'utf8');
  const chapter = fs.readFileSync(path.join(ROOT, 'workspace', 'wiki-render', 'tree', 'rules', 'core-rules', 'core-concepts.js'), 'utf8');
  ok('the rendered tree marks the real cutoffs (a document is one)', doc.indexOf('"cut":true') !== -1);
  ok('and a 0x chapter is not one', chapter.indexOf('"cut":true') === -1);
} else {
  console.log('no rendered shell: skipping the artifact assertions');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
