import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };

// task-104: a link inside a record stays in the drawer. Before this, a click set the hash
// and fromHash() opened the record as a PAGE under the drawer: the tree was buried and the
// back button said 'Open the wiki'. A link now opens the record it points at inside the
// drawer, on a stack, and the tree keeps its place.
const surface = fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.css'), 'utf8');
const wikilinks = fs.readFileSync(path.join(ROOT, 'src', 'wikilinks.mjs'), 'utf8');

ok('a body link is a wlink carrying a slug', wikilinks.indexOf('class="wlink"') !== -1 && /o\.href\(hit\.id\)/.test(wikilinks));

const at = surface.indexOf('function wireDrawerLinks()');
const wire = at === -1 ? '' : surface.slice(at, surface.indexOf('// --- the ask'));
ok('the drawer wires one delegated link handler', wire.length > 0 && /\.addEventListener\('click'/.test(wire));
ok('the handler catches wlink anchors only', /contains\('wlink'\)/.test(wire));
ok('the click no longer navigates the page', /ev\.preventDefault\(\)/.test(wire) && wire.indexOf('location.hash') === -1);
ok('the link resolves by slug and opens in the drawer', /recordBySlug\(slug\)/.test(wire) && /showInDrawer\(rec, true\)/.test(wire));

ok('the drawer has a record panel', /function drawerPanel\(\)/.test(surface) && /id = 'sv-drawer-record'/.test(surface));
ok('back pops the stack, and the last pop returns to the tree', /function drawerBack\(\)/.test(surface) && /stack\.pop\(\)/.test(surface) && /hideDrawerRecord\(\)/.test(surface));
ok('the tree keeps its place across the chain', /state\.treeScroll = tree\.scrollTop/.test(surface) && /tree\.scrollTop = state\.treeScroll/.test(surface));
ok('the handler is wired at boot', /wireDrawerLinks\(\);/.test(surface));
ok('closing the drawer returns to the tree', /else hideDrawerRecord\(\);/.test(surface));

ok('the panel covers the tree while reading', /\.sv-drawer\.sv-reading \.sv-filter,\.sv-drawer\.sv-reading \.sv-tree\{display:none\}/.test(css));
ok('the panel styles exist', /\.sv-drawer-record\{/.test(css) && /\.sv-drawer-back\{/.test(css));
// The page's own stylesheet makes every h2 a small-caps section label; the record title
// must opt out or 'Ignore Modifiers' renders as 'IGNORE MODIFIERS'.
ok('the record title is not the page small-caps h2', /\.sv-drawer-title\{[^}]*text-transform:none/.test(css));

// Grounded in the shipped payloads: recordBySlug() fetches content/<book>.json, where the
// book is the slug's own prefix. A slug naming a book that is not there would dead-end.
const contentDir = path.join(ROOT, 'workspace', 'wiki-data', 'content');
const files = fs.readdirSync(contentDir).filter(f => /\.json$/.test(f));
const books = new Set(files.map(f => f.replace(/\.json$/, '')));
let checked = 0;
const dangling = [];
for (const b of files) {
  const j = JSON.parse(fs.readFileSync(path.join(contentDir, b), 'utf8'));
  for (const rec of Object.values(j.records || {})) {
    if (!rec.slug) continue;
    checked += 1;
    if (!books.has(String(rec.slug).split('--')[0])) dangling.push(rec.slug);
  }
}
ok('every delivered slug names a book the drawer can fetch', checked > 5000 && dangling.length === 0);

const rulesRecs = Object.values(JSON.parse(fs.readFileSync(path.join(contentDir, 'rules.json'), 'utf8')).records || {});
const tapped = rulesRecs.find(r => r.slug === 'rules--rule-ignore-modifiers-vvglji');
ok('the link the reader taps resolves to a record', !!tapped && tapped.id === 'rules-appendix#Ignore-Modifiers');

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
