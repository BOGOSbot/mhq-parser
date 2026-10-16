import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus } from '../src/rules-corpus.mjs';
import { buildPayloads } from '../src/wiki-payload.mjs';

// task-73 slice 1: the bake. The interface is the test surface - these read the
// three payload shapes, the delivery equality, the book assignment and the cold
// address, with no browser and no rendered HTML.
let pass = 0, fail = 0;
function t(name, got, want) { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); } }
function ok(name, got) { t(name, !!got, true); }
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'workspace', 'wiki-data-test');

const corpus = readAllCorpus();
const stats = buildPayloads(corpus, OUT);
const read = rel => JSON.parse(fs.readFileSync(path.join(OUT, rel), 'utf8'));
const index = read('index.json');

// (a) the three shapes at paths mirroring the URLs -----------------------------
t('(a) index.json is exactly the branches with name, count and key', Object.keys(index), ['branches']);
t('(a) the three branch keys are rules, missions and factions', index.branches.map(b => b.b), ['rules', 'missions', 'factions']);
t('(a) the branch names and counts are the tree index', index.branches.map(b => b.n + ':' + b.c), ['Rules:794', 'Missions:106', 'Factions:5186']);
for (const b of index.branches) {
  const p = read('index/' + b.b + '.json');
  t('(a) index/' + b.b + '.json carries n, lvl, c, kids, recs, pages', ['n', 'lvl', 'c', 'kids', 'recs', 'pages'].every(k => k in p) && p.n === b.n && p.lvl === 'branch', true);
}
const books = stats.books;
for (const book of books) {
  const c = read('content/' + book + '.json');
  ok('(a) content/' + book + '.json carries { book, records }', c.book === book && c.records && typeof c.records === 'object');
}

// (b) every delivered record in exactly one content payload --------------------
const seen = new Map();
const slugBook = new Map();
for (const book of books) {
  const c = read('content/' + book + '.json');
  for (const [id, rec] of Object.entries(c.records)) { if (seen.has(id)) { console.log('DUPLICATE ' + id + ' in ' + seen.get(id) + ' and ' + book); } seen.set(id, book); slugBook.set(id, rec.slug.split('--')[0]); }
}
t('(b) every delivered record appears exactly once', seen.size, stats.delivered);
t('(b) the delivered count is the render rule: pageNamer minus tree.filtered', stats.delivered, 6271);
const mapFile = path.join(ROOT, 'workspace', 'wiki-render', 'map.json');
const mapEntries = fs.existsSync(mapFile) ? Object.keys(JSON.parse(fs.readFileSync(mapFile, 'utf8'))).length : null;
t('(b) HARD EQUALITY: content payloads == map.json entries', seen.size, mapEntries);
t('(b) every payload record is a corpus record', [...seen.keys()].filter(id => !corpus.some(r => r.id === id)).length, 0);
// (d) the slug's book prefix IS the payload it lives in, for every record.
t('(d) every slug carries its payload book', [...seen.keys()].filter(id => slugBook.get(id) !== seen.get(id)).length, 0);

// (c) a cold address resolves with no manifest ---------------------------------
const pick = [...seen.entries()].find(([id, book]) => book !== 'rules' && book.indexOf('faction-') === 0 && id.indexOf('~') === -1);
ok('(c) found a record in a faction book to address cold', !!pick);
if (pick) {
  const [id, book] = pick;
  const rec = read('content/' + book + '.json');
  const slug = rec.records[id].slug;
  const parts = slug.split('--');
  t('(c) the slug splits into a book and a stem', [parts.length, parts[0]], [2, book]);
  t('(c) and the one fetched payload resolves the record', rec.records[id].id, id);
  ok('(c) the book is not the first guess', book !== 'rules' && book !== 'missions');
}

// (d) the book is the tree's placement, not a re-derivation from set or source ---
const byId = new Map(corpus.map(r => [r.id, r]));
const urlSlug = r => { const m = /factions\/([a-z0-9-]+)/i.exec(String((r || {}).url || '')); return m ? m[1].toLowerCase() : ''; };
// The trap the tree comment names: source 'stratagems' with an EMPTY faction field.
const strats = [...seen.keys()].filter(id => { const r = byId.get(id) || {}; return r.source === 'stratagems' && !r.faction && urlSlug(r); });
ok('(d) faction-less stratagems exist (the trap)', strats.length > 100);
t('(d) and they are filed by their faction url, not by their source', strats.filter(id => seen.get(id) === 'faction-' + urlSlug(byId.get(id))).length, strats.length);
// unitrules: 2,314 in the corpus, every one carries a faction url but many an empty
// faction field - the assigner recovers them, and the book must follow.
const urless = [...seen.keys()].filter(id => (byId.get(id) || {}).kind === 'unitrules' && !(byId.get(id) || {}).faction && urlSlug(byId.get(id)));
ok('(d) unitrules with an empty faction field exist', urless.length > 100);
t('(d) and each lands in the faction book of its url', urless.filter(id => seen.get(id) === 'faction-' + urlSlug(byId.get(id))).length, urless.length);
// The source is not the book: event-companion is one source across two branches.
const events = [...seen.keys()].filter(id => (byId.get(id) || {}).source === 'event-companion');
ok('(d) event-companion files under more than one book', new Set(events.map(id => seen.get(id))).size >= 2);
// (e)(f)(g) sizes, no forbidden artifacts, file count --------------------------
ok('(e) bytes are reported and non-zero', stats.bytes > 0 && stats.biggest.bytes > 0);
ok('(e) the biggest payload is named', !!stats.biggest.name);
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
const written = walk(OUT).map(f => path.relative(OUT, f).replace(/\\/g, '/'));
t('(f) no .html, no map.json, no legacy.json', written.filter(f => /\.html$/.test(f) || /(^|\/)map\.json$/.test(f) || /(^|\/)legacy\.json$/.test(f)), []);
t('(g) the file count is index + one per branch + one per book', written.length, 1 + index.branches.length + books.length);
t('(g) and it is the count the stats report', written.length, stats.fileCount);

// (h) the branch row carries a drawer line -------------------------------------
const branch = read('index/rules.json');
const findRecs = n => (n.recs || []).concat((n.kids || []).flatMap(findRecs));
const rows = findRecs(branch).concat((branch.pages || []).flatMap(p => []));
ok('(h) the branch carries record rows', rows.length > 0);
if (rows.length) {
  t('(h) the row fields are exactly id, slug, title, source, snippet', Object.keys(rows[0]).sort(), ['id', 'slug', 'snippet', 'source', 'title']);
  t('(h) every snippet is at most 100 characters', rows.filter(r => r.snippet.length > 100).length, 0);
  ok('(h) and every row has a slug and a title', rows.every(r => r.slug && (r.title || r.id)));
}
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
