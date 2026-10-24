// task-108 part A: the client's row reader, driven in Node.
//
// The drawer used to fetch index/<branch>-rows.json per branch; it now reads the ONE
// addressing table (index/rows.json), the same file the server's slug map comes from.
// The reader is a pure block between markers in src/wiki-surface.js, so this test drives
// the shipping function over the shipping table - no browser, no fetch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The addressing table is read from the fresh bake when one is present (part A's own
// acceptance bake, workspace/wiki-data-test), else from the live payload. The live
// payload predates the snippet field until the next deploy re-bakes it; the reader is
// asserted against whichever table is there, and the bridge file below is always live.
const FRESH = path.join(ROOT, 'workspace', 'wiki-data-test');
const DATA = fs.existsSync(path.join(FRESH, 'index', 'rows.json')) ? FRESH : path.join(ROOT, 'workspace', 'wiki-data');
const LIVE = path.join(ROOT, 'workspace', 'wiki-data');
const CLIENT = fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.js'), 'utf8').replace(/\r\n/g, '\n');

// --- the shipping reader, extracted -------------------------------------------
const start = CLIENT.indexOf('// --- task-108 row reader');
const end = CLIENT.indexOf('// --- end task-108 row reader');
ok('the row reader is a pure block the test can drive', start !== -1 && end > start);
const rowFromTable = new Function(CLIENT.slice(start, end) + '; return rowFromTable;')();

// --- the read is the table, and only the table --------------------------------
ok('the client fetches the addressing table', CLIENT.indexOf("DATA + '/index/rows.json'") !== -1);
ok('and no per-branch rows file is fetched any more', CLIENT.indexOf("'-rows.json'") === -1 && CLIENT.indexOf('-rows.json\')') === -1);
ok('and the branch key is only the cache key', CLIENT.indexOf('state.rowsCache[b] = table') !== -1 && CLIENT.indexOf('state.rowsLoading[b]') !== -1);

// --- every row of the table, through the reader -------------------------------
const table = (JSON.parse(fs.readFileSync(path.join(DATA, 'index', 'rows.json'), 'utf8')) || {}).rows || {};
const ids = Object.keys(table);
ok('the table is the one the payload ships', ids.length > 6000);
let badShape = 0, badValue = 0, firstBad = '';
for (const id of ids) {
  const r = rowFromTable(table, id);
  const keys = Object.keys(r).sort().join(',');
  if (keys !== 'id,slug,snippet,source,title') badShape++;
  const want = table[id];
  if (String(r.id) !== id || String(r.slug) !== String(want.slug || '') || String(r.title) !== String(want.title || '') || String(r.source) !== String(want.source || '') || String(r.snippet) !== String(want.snippet || '')) { badValue++; if (!firstBad) firstBad = id; }
}
ok('every row comes back in the drawer shape' + (badShape ? ' (' + badShape + ' wrong)' : ''), badShape === 0);
ok('and with the table\'s own slug, title, source and snippet' + (badValue ? ' (' + badValue + ' wrong, first ' + firstBad + ')' : ''), badValue === 0);

// --- an id the table does not carry keeps the old fallback --------------------
const ghost = rowFromTable(table, 'core-rules#NotARecord');
ok('an unknown id falls back to its own leaf, with no slug', ghost.slug === '' && ghost.title === 'NotARecord' && ghost.id === 'core-rules#NotARecord' && ghost.snippet === '');
ok('a table with nothing in it is the same fallback', rowFromTable(null, 'unitrules#000001446~1').title === '000001446~1');

// --- the ids the drawer actually opens: pages and owned lists -----------------
const index = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
let pageIds = 0, ownIds = 0, unresolved = 0;
for (const b of (index.branches || [])) {
  const payload = JSON.parse(fs.readFileSync(path.join(DATA, 'index', b.b + '.json'), 'utf8'));
  for (const p of (payload.pages || [])) for (const id of (p.recs || [])) { pageIds++; if (!rowFromTable(table, id).slug) unresolved++; }
  const walk = n => {
    for (const r of (n.recs || [])) for (const id of (r.own || [])) { ownIds++; if (!rowFromTable(table, id).slug) unresolved++; }
    for (const k of (n.kids || [])) walk(k);
  };
  walk(payload);
}
ok('every page id the drawer can open resolves to a slug', pageIds > 0 && unresolved === 0);
ok('and every owned id does too', ownIds > 0);

// --- the bridge to the file that used to serve these rows ---------------------
const factionsRows = JSON.parse(fs.readFileSync(path.join(LIVE, 'index', 'factions-rows.json'), 'utf8')).rows || {};
const bridge = Object.keys(factionsRows);
let bridgeDiff = 0, bridgeDiffNoSnip = 0;
for (const id of bridge) {
  const fromTable = rowFromTable(table, id);
  const fromFile = factionsRows[id];
  if (fromTable.slug !== fromFile.slug || fromTable.title !== fromFile.title || fromTable.source !== fromFile.source) bridgeDiffNoSnip++;
  if (fromTable.snippet !== String(fromFile.snippet || '')) bridgeDiff++;
}
// The live payload predates part A's snippet field until the next deploy re-bakes it; the
// fresh bake (workspace/wiki-data-test, written by tests/test-wiki-payload.mjs) carries it.
// Either way the three fields the drawer renders must not move.
const hasSnippet = ids.some(id => typeof table[id].snippet === 'string' && table[id].snippet);
ok('the table serves the per-branch file\'s ' + bridge.length + ' rows identically on slug, title and source', bridge.length > 2000 && bridgeDiffNoSnip === 0);
if (hasSnippet) ok('and the snippet too', bridgeDiff === 0);
else console.log('note: this table has no snippet field (a payload older than part A); the fresh bake carries it');

console.log('reader: ' + ids.length + ' table rows from ' + path.relative(ROOT, DATA) + ' | pages ' + pageIds + ' | owned ' + ownIds + ' | bridged ' + bridge.length);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;