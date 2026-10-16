import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDelivered, readAllCorpus } from '../src/rules-corpus.mjs';
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
// Carry-over (a): a stale file from an earlier layout must not survive the bake.
fs.mkdirSync(path.join(OUT, 'index'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'content'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'index', 'stale-branch.json'), '{"stale":true}');
fs.writeFileSync(path.join(OUT, 'content', 'faction-zzz-stale.json'), '{"stale":true}');
const stats = buildPayloads(corpus, OUT);
ok('(a) the bake sweeps a stale branch file', !fs.existsSync(path.join(OUT, 'index', 'stale-branch.json')));
ok('(a) the bake sweeps a stale content file', !fs.existsSync(path.join(OUT, 'content', 'faction-zzz-stale.json')));
const read = rel => JSON.parse(fs.readFileSync(path.join(OUT, rel), 'utf8'));
const index = read('index.json');

// (a) the three shapes at paths mirroring the URLs -----------------------------
t('(a) index.json is exactly the branches with name, count and key', Object.keys(index), ['branches']);
t('(a) the three branch keys are rules, missions and factions', index.branches.map(b => b.b), ['rules', 'missions', 'factions']);
t('(a) the branch names and counts are the tree index', index.branches.map(b => b.n + ':' + b.c), ['Rules:769', 'Missions:115', 'Factions:5185']);
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
t('(b) the delivered count is the render rule: pageNamer minus tree.filtered', stats.delivered, 6245);
// task-77: map.json is deleted. The witness is the corpus's own delivery rule
// (rules-corpus isDelivered), computed here without the payload builder.
const modelDelivered = readAllCorpus().filter(isDelivered).length;
t('(b) HARD EQUALITY: content payloads == the corpus delivery rule', seen.size, modelDelivered);
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
t('(g) the file count is index + one per branch + one per book + the rows file', written.length, 1 + index.branches.length + books.length + 1);
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
// Carry-over (b): 'at' is the annotation target, exactly what productPage's
// WIKI_HERE carries - 261 of the 270 annotations have one.
const annotated = [...seen.keys()].filter(id => { const c = read('content/' + seen.get(id) + '.json'); return c.records[id] && c.records[id].at; });
ok('(b) some content records carry an annotation target in at', annotated.length > 200);

// --- task-81: the rows only reachable through a page or a detachment ----------
const facPayload = read('index/factions.json');
// step 3b: the rows live in their own on-demand file, not in the branch payload.
ok('(81-3b) the branch payload carries no rows map', facPayload.rows === undefined);
const rowsFile = read('index/factions-rows.json');
const rowMapIds = Object.keys(rowsFile.rows || {});
t('(81-3) the rows file carries the page and owned ids', rowMapIds.length, 2082);
ok('(81-3b) and the branch file is small again', fs.statSync(path.join(ROOT, 'workspace', 'wiki-data', 'index', 'factions.json')).size < 420000);
let ownRows = 0, ownIds = new Set(), biggestOwn = 0;
const walkOwn = n => { for (const r of (n.recs || [])) { if (r.own && r.own.length) { ownRows++; biggestOwn = Math.max(biggestOwn, r.own.length); for (const id of r.own) ownIds.add(id); } } for (const k of (n.kids || [])) walkOwn(k); };
walkOwn(facPayload);
t('(81-3) detachments carrying their owned ids', ownRows, 252);
t('(81-3) the biggest owned list is Lords of Dread (12)', biggestOwn, 12);
t('(81-3) every owned id has a row in the rows file', [...ownIds].filter(id => !(rowsFile.rows || {})[id]).length, 0);
t('(81-3) and a page id does too', (facPayload.pages || []).every(pg => (pg.recs || []).every(id => (rowsFile.rows || {})[id])), true);
ok('(81-3) a row in the map has the drawer shape', ['id', 'slug', 'title', 'source', 'snippet'].every(k => k in ((rowsFile.rows || {})[rowMapIds[0]] || {})));
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
