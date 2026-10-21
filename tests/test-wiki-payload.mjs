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
// task-33: the faction branch is the indexable count - 5,438 delivered minus the 175
// kind 'index' pages - and the rules branch is 781 with the export's extra core record.
t('(a) the branch names and counts are the tree index (task-13: -1 rule, -9 missions)', index.branches.map(b => b.n + ':' + b.c), ['Rules:781', 'Missions:106', 'Factions:5263']);
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
t('(b) the delivered count is the render rule: pageNamer minus tree.filtered (task-13: -10; task-33: 6,327)', stats.delivered, 6327);
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
// task-44 added exactly three files, and this pin names them rather than absorbing
// them: the Legends branch, its content book, and the ids-only slug map the search
// and the record route read. None of the three is named by index.json, so the default
// reader never fetches one (tests/test-legends.mjs pins that half).
const LEGENDS_FILES = ['index/legends.json', 'content/legends.json', 'index/legends-slugs.json'];
// task-69: the French overlay is baked per book, one file per book plus its index, and
// only for the books that actually carry a translation.
const frIndex = read('i18n/fr/index.json');
const FR_FILES = 1 + Object.keys(frIndex.books).length;
t('(g) the file count is index + one per branch + one per book + the rows file + the Legends three + the French overlay', written.length, 1 + index.branches.length + books.length + 1 + LEGENDS_FILES.length + FR_FILES);
t('(g) and the French files are one per translated book plus its index', written.filter(f => /^i18n\/fr\//.test(f)).length, FR_FILES);
t('(g) and the Legends three are the only files beyond that count', LEGENDS_FILES.filter(f => written.indexOf(f) === -1), []);
t('(g) and it is the count the stats report', written.length, stats.fileCount);

// (h) the branch row carries a drawer line -------------------------------------
const branch = read('index/rules.json');
const findRecs = n => (n.recs || []).concat((n.kids || []).flatMap(findRecs));
const rows = findRecs(branch).concat((branch.pages || []).flatMap(p => []));
ok('(h) the branch carries record rows', rows.length > 0);
if (rows.length) {
  ok('(h) the row fields are id, slug, title, source, snippet and num when there is one', ['id', 'slug', 'snippet', 'source', 'title'].every(k => k in rows[0]) && Object.keys(rows[0]).every(k => ['id', 'num', 'slug', 'snippet', 'source', 'title'].indexOf(k) !== -1));
  t('(h) every snippet is at most 100 characters', rows.filter(r => r.snippet.length > 100).length, 0);
  ok('(h) and every row has a slug and a title', rows.every(r => r.slug && (r.title || r.id)));
}
// --- task-5: one rulebook - the appendix folded into Core Rules ----------------
// The appendix is the same chapters one level deeper, so the drawer read two
// '01 Core Concepts' and two chapter lists. There is ONE book now, and its 0x.0x
// SECTION level survives: the appendix's definitions nest under the section their
// number names, and the core's own 0x.0x record is that section's lead row.
const atBook = (root, name) => (root.kids || []).find(k => k.n === name) || {};
const findNode = (n, name) => { if (!n) return null; if ((n.n || '') === name) return n; for (const k of (n.kids || [])) { const hit = findNode(k, name); if (hit) return hit; } return null; };
const coreBook = atBook(branch, 'Core Rules');
t('(5) the Rules branch has no Rules Appendix book', (branch.kids || []).map(k => k.n), ['Core Rules', 'WTC 11th Edition FAQ', 'FEQ 40K FAQ']);
const coreCC = findNode(coreBook, '01 Core Concepts');
const numsOf = n => (n.recs || []).map(r => r.num || '').filter(Boolean);
const asc = list => list.every((x, i) => i === 0 || list[i - 1] <= list[i]);
ok('(5) the core chapter keeps its one section level', (coreCC.kids || []).length >= 6 && (coreCC.kids || []).every(k => /^\d{2}\.\d{2} /.test(k.n)));
ok('(5) and the sections are in number order', asc((coreCC.kids || []).map(k => k.n)));
const unitsNode = (coreCC.kids || []).find(k => / Units and Models$/.test(k.n));
ok('(5) the section holds the rule and its appendix definitions', !!unitsNode && (unitsNode.recs || []).length >= 12);
const unitsNums = ((unitsNode || {}).recs || []).map(r => r.num || '');
// The section's lead row is the core 0x.0x record; its own number is suppressed
// because the section header already prints it (01.02 Units and Models).
t('(5) the core 0x.0x record leads the section', (((unitsNode || {}).recs || [])[0] || {}).id, 'core-rules#Units-and-Models');
t('(5) then its appendix definitions in number order', unitsNums.filter(Boolean).slice(0, 3), ['01.02.01', '01.02.02', '01.02.03']);
ok('(5) and the rows are in number order', asc(unitsNums.filter(Boolean)));
ok('(5) the chapter lead row stays first', !coreCC.recs[0].num);
// task-14: the parts the drawer interleaves: 01.06 is a row carrying its number
// (a single-record section), and the chapter's own intro row carries none.
ok('(14) the single-record 01.06 row keeps its number', (coreCC.recs || []).some(r => r.num === '01.06'));
ok('(14) and the chapter intro row has none', (coreCC.recs || []).some(r => r.title === 'Core Concepts' && !r.num));
// task-16: a section lead's nested records are rows under the section too, so a
// rule is reachable by reading and not only by search. Reference case: the
// core-rules FALL-BACK MOVE (09.07) sits under 09.05 NORMAL MOVE, beside the
// 09.06 ADVANCE MOVE the same page nests there. The core page's copies of the
// CSV stratagems (15.02..15.12) are the exception: the real row already reads
// the same rule, so they stay attached rather than listed twice.
const moving09 = findNode(coreBook, '09 Movement Phase');
const normalMove = ((moving09 || {}).kids || []).find(k => /NORMAL MOVE$/.test(k.n));
ok('(16) a section lead\'s nested records are rows under the section', !!normalMove && (normalMove.recs || []).some(r => r.num === '09.06') && (normalMove.recs || []).some(r => r.num === '09.07' && /fall-back move/i.test(r.title)));
ok('(16) the nested rows follow the section lead in number order', asc(((normalMove || {}).recs || []).map(r => r.num || '').filter(Boolean).slice(1)));
t('(16) the core book count is unchanged (task-13 moved PULSE JET MOVE to its datasheet; task-33: +1 export record)', coreBook.c, 627);
t('(16) the rules branch count is unchanged (task-13 dropped ten rules-branch records; task-33: +1)', branch.c, 781);
const splitting = ((unitsNode || {}).recs || []).filter(r => /Splitting Units/.test(r.title));
t('(5) the rule and its errata are two rows under the same number', splitting.map(r => r.num).join(','), '01.02.06,01.02.06');
ok('(5) the errata says so, so the pair does not read as a duplicate', /errata$/.test(splitting[1] && splitting[1].title));
t('(5) no row prints its rule number inside the title', rows.filter(r => /^\d{2}\.\d{2}/.test(r.title)).length, 0);
const chapterNames = (n, acc) => { for (const k of (n.kids || [])) { if (k.lvl === 'chapter') acc.push(k.n); chapterNames(k, acc); } return acc; };
t('(5) no chapter header appears twice', chapterNames(coreBook, []).filter((n, i, a) => a.indexOf(n) !== i), []);
t('(5) the branch count is the sum of its books', (branch.kids || []).reduce((n, k) => n + k.c, 0), branch.c);
t('(5) and the book count is the sum of its chapters', (coreBook.kids || []).reduce((n, k) => n + k.c, 0), coreBook.c);
// Every former appendix record is reachable: a row of the book (in a chapter or a
// section), or an annotation attached to one (the duplicate copies of a rule stay
// delivered, findable by their own slug, counted once).
const rulesContent = read('content/rules.json');
const coreRowIds = new Set();
const collectRows = n => { for (const r of (n.recs || [])) coreRowIds.add(r.id); for (const k of (n.kids || [])) collectRows(k); };
collectRows(coreBook);
const appendixIds = Object.keys(seen).filter(id => (byId.get(id) || {}).source === 'rules-appendix');
const lost = appendixIds.filter(id => !coreRowIds.has(id) && !((rulesContent.records[id] || {}).at));
t('(5) every former appendix record is reachable under Core Rules', lost, []);
// task-16: the reference record is now one of those rows, not only a search hit.
ok('(16) the reference record is a drawer row', coreRowIds.has('core-rules#Movement-Phase->-3.-End-of-Movement-Phase->-09.05.01-More-Than-One-Normal-Move-in-a-Phase->-FALL-BACK-MOVE'));

// --- task-4: one [ONE SHOT], under Core Abilities -----------------------------
const core24 = findNode(coreBook, '24 Core Abilities');
const oneShot = (core24.kids || []).filter(k => String(k.n).indexOf('[ONE SHOT]') !== -1);
t('(4) one [ONE SHOT] section, under Core Abilities', oneShot.map(k => k.n), ['24.26 [ONE SHOT]']);
ok('(4) no [ONE SHOT] chapter survives anywhere', [branch.kids, coreBook.kids].flat().filter(k => String(k.n).indexOf('[ONE SHOT]') !== -1), []);
t('(4) one [ONE SHOT] row in it', ((oneShot[0] || {}).recs || []).map(r => r.num + ' ' + r.title), ['24.26.01 Multiple [ONE SHOT] Weapons']);
ok('(4) [EXTRA ATTACKS] is a different ability and keeps its own section', (core24.kids || []).some(k => k.n === '24.11 [EXTRA ATTACKS]'));
ok('(4) the precision clarification is its own section, not one-shot', (core24.kids || []).some(k => k.n === '24.28 [PRECISION]'));
ok('(4) and it keeps its annotations', ((core24.kids || []).find(k => String(k.n).indexOf('24.28 ') === 0) || {}).c === 4);
const uru = findNode(coreBook, '00 Universal Rules Updates');
ok('(4) the Universal Rules Updates block is the book last chapter', !!uru);
t('(4) and carries its six rows', ((uru || {}).recs || []).length, 6);
ok('(4) leading with its own header row', (((uru || {}).recs || [])[0] || {}).title === 'Universal Rules Updates');
t('(4) its annotations ride with it', (uru || {}).c, 74);
const uruIds = ((uru || {}).recs || []).map(r => r.id);
t('(4) the five topics the old local chapter held are rows there',
  ['Modifying-a-Stratagem-s-CP-Cost', 'Stratagems-That-Can-Be-Used-More-Than-Once-Per-Phase-Turn',
    'Stratagems-That-Prevent-Units-From-Being-Targeted', 'Stratagems-That-Add-New-Units-To-Your-Army',
    'Move-Types-For-Disembarking-Units'].filter(s => !uruIds.some(id => id.indexOf(s) !== -1)), []);

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
t('(81-3) the rows file carries the page and owned ids', rowMapIds.length, 2086);
ok('(81-3b) and the branch file is small again', fs.statSync(path.join(ROOT, 'workspace', 'wiki-data', 'index', 'factions.json')).size < 420000);
let ownRows = 0, ownIds = new Set(), biggestOwn = 0;
const walkOwn = n => { for (const r of (n.recs || [])) { if (r.own && r.own.length) { ownRows++; biggestOwn = Math.max(biggestOwn, r.own.length); for (const id of r.own) ownIds.add(id); } } for (const k of (n.kids || [])) walkOwn(k); };
walkOwn(facPayload);
t('(81-3) detachments carrying their owned ids', ownRows, 256);
t('(81-3) the biggest owned list is Lords of Dread (12)', biggestOwn, 12);
t('(81-3) every owned id has a row in the rows file', [...ownIds].filter(id => !(rowsFile.rows || {})[id]).length, 0);
t('(81-3) and a page id does too', (facPayload.pages || []).every(pg => (pg.recs || []).every(id => (rowsFile.rows || {})[id])), true);
ok('(81-3) a row in the map has the drawer shape', ['id', 'slug', 'title', 'source', 'snippet'].every(k => k in ((rowsFile.rows || {})[rowMapIds[0]] || {})));
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
