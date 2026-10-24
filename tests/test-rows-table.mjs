// task-108: ONE addressing table, and the invariant stated as one loop.
//
// The defect the architecture walk measured: an id became an address in four different ways,
// three of them partial (surfaceSlugMap 1,926 of the 6,171 delivered records, the per-branch
// -rows.json 2,086, branch.pages 75) and 2,159 delivered records were in none of them, so a
// search hit or a finding on one of them could not become an address the drawer could open.
//
// The table (workspace/wiki-data/index/rows.json, written by src/wiki-payload.mjs and read
// only through src/rows-table.mjs) is the one answer. This test is the assertion that would
// have caught the defect, and it compares the table with the CORPUS's own delivered
// predicate, in both directions. The delivered set is read from the corpus and nowhere else:
// narrowing it is the one way to make the loop below pass without fixing anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, isDelivered } from '../src/rules-corpus.mjs';
import { readRows, slugMap } from '../src/rows-table.mjs';
import { surfaceSlugMap } from '../src/wiki-surface.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'workspace', 'wiki-data');
const readSrc = rel => fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8').replace(/\r\n/g, '\n');

const delivered = readAllCorpus().filter(isDelivered).map(r => String(r.id));
const deliveredSet = new Set(delivered);
const rows = readRows(DATA) || {};
const ids = Object.keys(rows);
ok('the payload carries the addressing table', !!readRows(DATA) && typeof rows === 'object');

// --- the invariant: one loop, both directions --------------------------------
const missing = delivered.filter(id => !Object.prototype.hasOwnProperty.call(rows, id));
const extra = ids.filter(id => !deliveredSet.has(id));
ok('every delivered record has a row in the table' + (missing.length ? ' (' + missing.length + ' missing, first ' + missing[0] + ')' : ''), missing.length === 0);
ok('and the table has no id the corpus does not deliver' + (extra.length ? ' (' + extra.length + ' extra, first ' + extra[0] + ')' : ''), extra.length === 0);
ok('so the two counts are the same', ids.length === delivered.length && ids.length > 6000);

// --- every row is an address the payload can resolve, cold -------------------
let badSlug = 0, badBook = 0, badTitle = 0, unresolved = 0, firstBad = '';
const books = new Map();
for (const id of ids) {
  const r = rows[id] || {};
  const slug = String(r.slug || '');
  const book = String(r.book || '');
  if (slug.indexOf('--') === -1 || !String(r.title || '').length) badSlug++;
  else if (slug.split('--')[0] !== book) badBook++;
  if (!book) badTitle++;
  if (!books.has(book)) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(DATA, 'content', book + '.json'), 'utf8')); } catch (e) { j = null; }
    books.set(book, j);
  }
  const content = books.get(book);
  const rec = content && content.records ? content.records[id] : null;
  if (!rec || String(rec.slug) !== slug) { unresolved++; if (!firstBad) firstBad = id + ' -> ' + book + ' / ' + slug; }
}
ok('every row carries a slug and a title' + (badSlug ? ' (' + badSlug + ' rows without)' : ''), badSlug === 0);
ok('every row names the book its slug lives in' + (badBook ? ' (' + badBook + ' disagree)' : ''), badBook === 0 && badTitle === 0);
ok('and the address resolves to that record in that book' + (unresolved ? ' (' + unresolved + ' unresolved, first ' + firstBad + ')' : ''), unresolved === 0);

// --- one reader, every consumer ----------------------------------------------
const slugs = surfaceSlugMap();
ok('surfaceSlugMap answers from the table', slugs.size === ids.length && ids.every(id => slugs.get(id) === String(rows[id].slug)));
const surface = readSrc('wiki-surface.mjs');
ok('and it is that view, not a tree walk of its own', /export function surfaceSlugMap\(\) \{\n  return slugMap\(DATA_DIR\);\n\}/.test(surface) && surface.indexOf('-rows.json') === -1);
const server = readSrc('server.mjs');
ok('the server takes every address from it', (server.match(/surfaceSlugMap\(\)/g) || []).length >= 3 && server.indexOf('-rows.json') === -1);
const app = readSrc('app-bundle.mjs');
ok('the app bundle builds its titles from the table', /function titlesFromTable\(\)/.test(app) && /readRows\(data\)/.test(app) && app.indexOf('titlesFromIndex') === -1);
ok('and refuses a payload with no table instead of shipping a partial list', /has no ' \+ ROWS_FILE/.test(app));
const web = readSrc('web-bundle.mjs');
ok('the web bundle resolves its internal hrefs through the same view', /const slugs = surfaceSlugMap\(\);/.test(web) && web.indexOf('-rows.json') === -1);
const client = readSrc('wiki-surface.js');
ok('the client still reads the display rows, which phase 1 does not move', client.indexOf('-rows.json') !== -1);

console.log(pass + ' passed, ' + fail + ' failed   table ' + ids.length + ' rows, delivered ' + delivered.length);
process.exitCode = fail ? 1 : 0;
