import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOC_CSS, TOC_JS } from '../src/wiki-toc.mjs';

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
ok('the left pane is gone', js.indexOf('wccolrow') === -1);
ok('the CSS carries the card row', TOC_CSS.indexOf('.wccards{') !== -1 && TOC_CSS.indexOf('.wccard{') !== -1);

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
  const node = fs.readFileSync(path.join(ROOT, 'workspace', 'wiki-render', 'tree', 'rules', 'core-rules', 'core-concepts.js'), 'utf8');
  ok('the rendered tree data carries the cutoff flags', node.indexOf('"cut":true') !== -1 || node.indexOf('\\"cut\\":true') !== -1);
} else {
  console.log('no rendered shell: skipping the artifact assertions');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
