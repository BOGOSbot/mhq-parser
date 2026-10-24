// task-109: the record bodies are addressed by content. One body per distinct HTML, keyed
// by its hash; a record id points at the hash; the reader resolves id -> hash -> body and
// returns null when either link is missing - a missing body, never an empty string that
// renders as a blank pane.
//
// The store is two files: records/<book>.json (bodies: hash -> HTML) and
// records/<book>-ids.json (records: id -> hash). They are separate so a reader that still
// expects the old flat shape finds no id and answers 'no such record' instead of rendering
// a hash as HTML.
//
// Part A drives the shape and the resolver with no corpus. Part B renders two real records
// that share one body (the two halves of datasheet#000000016). Part C, when a post-task-109
// bundle is present, resolves every delivered id through the shipping store.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyById, bodyFiles, bodyHash } from '../src/wiki-surface.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got).slice(0, 200) + '\n  want: ' + JSON.stringify(want).slice(0, 200)); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- Part A: the shape and the resolver ---------------------------------------------
const ONE = '<p class="wcard">one</p>';
const TWO = '<p class="wcard">two</p>';
t('the hash is 16 hex characters', /^[0-9a-f]{16}$/.test(bodyHash(ONE)), true);
t('the same body hashes the same', bodyHash(ONE) === bodyHash(ONE), true);
t('two bodies hash apart', bodyHash(ONE) !== bodyHash(TWO), true);

const files = bodyFiles(1, 'factions', { b: TWO, a: ONE, c: ONE });
const bodies = JSON.parse(files.bodies);
const ids = JSON.parse(files.ids);
t('the bodies file is a hash -> HTML map', Object.keys(bodies.bodies).length, 2);
t('and it carries no id map at all, so an old reader finds nothing', 'records' in bodies, false);
t('the ids file is the id -> hash map', Object.keys(ids.records), ['a', 'b', 'c']);
t('and every id points at a hash', ['a', 'b', 'c'].map(id => /^[0-9a-f]{16}$/.test(ids.records[id])), [true, true, true]);
t('the two copies share one body', ids.records.a === ids.records.c, true);
t('two runs write the same bytes', JSON.stringify(bodyFiles(1, 'factions', { b: TWO, a: ONE, c: ONE })), JSON.stringify(files));
t('the id map is written in sorted order', Object.keys(ids.records), ['a', 'b', 'c']);
ok('the bodies keep the encounter order of the records', files.bodies.indexOf(JSON.stringify(bodyHash(TWO))) < files.bodies.indexOf(JSON.stringify(bodyHash(ONE))));

t('a resolves to its body', bodyById(ids, bodies, 'a'), ONE);
t('b resolves to its body', bodyById(ids, bodies, 'b'), TWO);
t('the second copy resolves to the same body', bodyById(ids, bodies, 'c'), ONE);
t('an id the map never carried is null, not an empty body', bodyById(ids, bodies, 'ghost'), null);
t('a hash the bodies file lost is null too', bodyById({ records: { x: 'deadbeefdeadbeef' } }, { bodies: {} }, 'x'), null);
t('a store with no map at all is null', [bodyById(null, bodies, 'a'), bodyById({}, bodies, 'a'), bodyById({ records: null }, bodies, 'a')], [null, null, null]);
t('and the resolver takes the id as a string, as the route does', bodyById(ids, bodies, 'a'), bodyById(ids, bodies, String('a')));

const roundTrip = JSON.parse(files.bodies);
const roundIds = JSON.parse(files.ids);
t('both files round-trip through JSON', bodyById(roundIds, roundTrip, 'a'), ONE);

const BIG = '<p class="wcard">' + 'x'.repeat(4000) + '</p>';
const many = { a: BIG, b: BIG, c: BIG, d: BIG, e: BIG, f: BIG };
ok('a repeated body is stored once, not six times', JSON.parse(bodyFiles(1, 'factions', many).bodies).bodies[bodyHash(BIG)].length === BIG.length);
ok('and the store is far smaller than the flat map', bodyFiles(1, 'factions', many).bodies.length < JSON.stringify({ records: many }).length / 2);

// --- Part B: two real records, one body --------------------------------------------
const { readAllCorpus } = await import('../src/rules-corpus.mjs');
const { cardIndex, chunkLookup, recordBody } = await import('../src/wiki-cards.mjs');
const { renderContext } = await import('../src/render-context.mjs');
const { surfaceSlugMap } = await import('../src/wiki-surface.mjs');
const all = readAllCorpus();
const byId = new Map(all.map(r => [String(r.id), r]));
const halves = { rules: readAllCorpus('rules'), factions: readAllCorpus('factions'), rulings: readAllCorpus('rulings') };
const slugs = surfaceSlugMap();
const parts = {
  corpora: halves,
  chunk: chunkLookup(([]).concat(halves.rules || [], halves.factions || [], halves.rulings || [])),
  index: cardIndex(byId),
  href: id => { const s = slugs.get(String(id || '')); return s ? '#' + s : ''; },
};
const PAIR = ['datasheet#000000016~1', 'datasheet#000000016~2'];
const rendered = PAIR.map(id => recordBody(byId.get(id), renderContext(Object.assign({}, parts, { selfId: id, frText: '' }))));
ok('the fixture pair is in the corpus', PAIR.every(id => byId.has(id)) && rendered.every(h => h && h.length > 100));
t('the two halves render one body', rendered[0] === rendered[1], true);
const pairFiles = bodyFiles(1, 'factions', { [PAIR[0]]: rendered[0], [PAIR[1]]: rendered[1] });
const pairBodies = JSON.parse(pairFiles.bodies);
const pairIds = JSON.parse(pairFiles.ids);
t('so they collapse to one stored body', Object.keys(pairBodies.bodies).length, 1);
t('and both ids resolve to it, byte for byte', [bodyById(pairIds, pairBodies, PAIR[0]), bodyById(pairIds, pairBodies, PAIR[1])], [rendered[0], rendered[1]]);

// --- Part C: the shipping store, when one has been built ---------------------------
const OUT = path.join(ROOT, 'workspace', 'web-bundle', 'records');
let books = null;
try {
  books = {};
  for (const f of fs.readdirSync(OUT)) {
    const parsed = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    const book = books[parsed.book] = books[parsed.book] || { bodies: null, ids: null };
    if (f.endsWith('-ids.json')) book.ids = parsed; else book.bodies = parsed;
  }
  if (Object.keys(books).some(b => !books[b].bodies || !books[b].ids)) books = null;
} catch (e) { books = null; }
if (books) {
  const table = (JSON.parse(fs.readFileSync(path.join(ROOT, 'workspace', 'wiki-data', 'index', 'rows.json'), 'utf8')) || {}).rows || {};
  const delivered = Object.keys(table);
  // The stores split by bundle book (factions/rules/rulings); the reader scans them, as the
  // phone's LocalServer scans the files today. The id is in exactly one of them.
  const resolve = id => { for (const b of Object.keys(books).sort()) { const html = bodyById(books[b].ids, books[b].bodies, id); if (html) return html; } return null; };
  let empty = 0, bodyCount = 0, idCount = 0;
  for (const id of delivered) if (!resolve(id)) empty++;
  for (const b of Object.keys(books)) { bodyCount += Object.keys(books[b].bodies.bodies).length; idCount += Object.keys(books[b].ids.records).length; }
  ok('every delivered id resolves through the shipping store (' + (delivered.length - empty) + '/' + delivered.length + ')', delivered.length > 6000 && empty === 0);
  ok('the store carries fewer bodies than ids (' + bodyCount + ' < ' + idCount + ')', bodyCount > 1000 && bodyCount < idCount);
  t('an id the shipping store never carried is null', resolve('core-rules#NotARecord'), null);
  t('and the bodies file carries no id map an old reader could mistake', Object.keys(books).every(b => !('records' in books[b].bodies)), true);
} else {
  console.log('note: no task-109 store at workspace/web-bundle/records (build the web bundle to assert it)');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;