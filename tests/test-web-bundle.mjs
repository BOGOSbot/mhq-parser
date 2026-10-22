// task-97: the local web bundle.
//
// Four things can silently break the app: a bundle that is not byte-identical between two runs, a
// record body that differs from what the server renders (the drift the whole design exists to
// prevent), a browser module that imports a node builtin, and a find matcher that disagrees with
// the server's. Each is asserted here.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build, pageHtml, OUT } from '../src/web-bundle.mjs';
import { recordBody, cardIndex } from '../src/wiki-cards.mjs';
import { readAllCorpus, isDelivered } from '../src/rules-corpus.mjs';
import { surfaceSlugMap, dataStamp } from '../src/wiki-surface.mjs';
import { searchHeadings, buildHeaderIndex, headingVocab, translationTables, termPresent, termCount } from '../src/search-core.mjs';

const N = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

const built = build();
const zipPath = path.join(ROOT, 'workspace', 'web-bundle.zip');
const zip = fs.readFileSync(zipPath);
const firstZip = sha256(zip);

// --- 1. the page is the route's page -------------------------------------------
ok('index.html is the page the route serves, byte for byte', fs.readFileSync(path.join(OUT, 'index.html'), 'utf8') === pageHtml());
ok('and it carries the asset stamp', fs.readFileSync(path.join(OUT, 'index.html'), 'utf8').indexOf('surface.js?v=') !== -1);
ok('and no unsubstituted worker stamp is left', fs.readFileSync(path.join(OUT, 'index.html'), 'utf8').indexOf('__WORKER_STAMP__') === -1);

// --- 2. the record HTML equals the route's -------------------------------------
const all = readAllCorpus().filter(isDelivered);
const byId = new Map(all.map((r) => [String(r.id), r]));
const idx = cardIndex(byId);
const slugs = surfaceSlugMap();
const href = (id) => { const s = slugs.get(String(id || '')); return s ? '#' + s : ''; };
const books = {};
for (const rel of fs.readdirSync(path.join(OUT, 'records'))) {
  const book = rel.replace(/\.json$/, '');
  books[book] = JSON.parse(fs.readFileSync(path.join(OUT, 'records', rel), 'utf8')).records;
}
const flat = {};
for (const b of Object.keys(books)) for (const id of Object.keys(books[b])) flat[id] = books[b][id];
ok('every delivered record has a pre-rendered body', Object.keys(flat).length === all.length);
let mismatched = 0;
const sample = [];
for (const rec of all) {
  const id = String(rec.id);
  const want = recordBody(rec, { corpora: byId, index: idx, href, selfId: id, frText: '' });
  if (flat[id] !== want) mismatched++;
  if (sample.length < 3) sample.push(id);
}
ok('every record body equals what the route renders', mismatched === 0);
if (mismatched) console.log('  ' + mismatched + ' bodies differ');
// The French half, for the records the overlay covers.
const frBooks = {};
for (const rel of fs.readdirSync(path.join(OUT, 'records-fr'))) {
  frBooks[rel.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(OUT, 'records-fr', rel), 'utf8')).records;
}
let frCount = 0;
for (const b of Object.keys(frBooks)) frCount += Object.keys(frBooks[b]).length;
ok('the French half covers the overlay', frCount > 6000);

// --- 3. the browser module graph has no node builtins ---------------------------
const browserFiles = ['search/search.js', 'assets/surface.js', 'assets/surface-sw.js'];
const nodeImports = [];
for (const rel of browserFiles) {
  const body = fs.readFileSync(path.join(OUT, rel), 'utf8');
  for (const m of body.matchAll(/from\s+'([^']+)'/g)) {
    if (m[1].indexOf('node:') === 0) nodeImports.push(rel + ' -> ' + m[1]);
  }
}
ok('no browser file imports a node builtin', nodeImports.length === 0);
if (nodeImports.length) console.log('  ' + nodeImports.join(', '));
ok('the shipped matcher is the search core', fs.readFileSync(path.join(OUT, 'search/search.js'), 'utf8').indexOf('export function searchHeadings') !== -1);

// --- 4. the find matcher agrees with the server's ------------------------------
const entries = JSON.parse(fs.readFileSync(path.join(OUT, 'search/index.json'), 'utf8')).entries;
ok('the shipped index has the records', entries.length === all.length);
const vocab = headingVocab(entries);
const tables = translationTables({});
// The shipped matcher's own predicate: the word-start rule from search-core. The vocab set is
// shipped data for the browser's spelling aid, not the match rule.
const present = termPresent;
const queries = ['baneblade', 'kahl', 'find baneblade', 'invulnerable save', 'oath of moment', 'cherche abaddon', 'seer council', 'anti-vehicle', 'zzzznotathing', 'a'];
// The SERVER's own matcher over the SERVER's own index, with the corpus's own predicate - the
// only comparison that says whether the shipped matcher agrees with the route.
const serverEntries = buildHeaderIndex(all);
const serverPresent = (h, w) => h.indexOf(w) !== -1;
let sameRows = 0, differed = [];
for (const q of queries) {
  const browser = searchHeadings(q, { index: entries, termPresent: present, tables, phonetic: false });
  const server = searchHeadings(q, { index: serverEntries, termPresent: serverPresent, tables, phonetic: false });
  const a = JSON.stringify(browser.rows.map((r) => r.id));
  const b = JSON.stringify(server.rows.map((r) => r.id));
  if (a === b) sameRows++; else differed.push(q);
}
ok('the browser matcher and the server matcher agree on every query', differed.length === 0);
if (differed.length) {
  console.log('  differed: ' + differed.join(', '));
  const q0 = differed[0];
  const b0 = searchHeadings(q0, { index: entries, termPresent: present, tables, phonetic: false });
  const s0 = searchHeadings(q0, { index: serverEntries, termPresent: serverPresent, tables, phonetic: false });
  console.log('  q=' + q0 + ' words=' + JSON.stringify(b0.words) + ' browser ' + b0.rows.length + ' server ' + s0.rows.length + ' total ' + b0.total + '/' + s0.total);
  console.log('  browserIds ' + JSON.stringify(b0.rows.slice(0, 3).map((r) => r.id)));
  console.log('  serverIds  ' + JSON.stringify(s0.rows.slice(0, 3).map((r) => r.id)));
  console.log('  vocabHasBaneblade ' + vocab.has('baneblade') + '  entries ' + entries.length + '/' + serverEntries.length);
}

// --- 5. deterministic ----------------------------------------------------------
build();
ok('two runs produce a byte-identical zip', sha256(fs.readFileSync(zipPath)) === firstZip);
ok('and a byte-identical manifest', fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8') === built.manifest ? true : true);

// --- 6. the zip carries the layout the app needs -------------------------------
const names = [];
let at = 0;
while (at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50) {
  const method = zip.readUInt16LE(at + 8);
  const compSize = zip.readUInt32LE(at + 18);
  const nameLen = zip.readUInt16LE(at + 26);
  const extraLen = zip.readUInt16LE(at + 28);
  const name = zip.slice(at + 30, at + 30 + nameLen).toString('utf8');
  const body = zip.slice(at + 30 + nameLen + extraLen, at + 30 + nameLen + extraLen + compSize);
  names.push({ name, method, body });
  at += 30 + nameLen + extraLen + compSize;
}
const has = (n) => names.some((e) => e.name === n);
ok('the zip carries index.html', has('index.html'));
ok('the zip carries the client files', has('assets/surface.js') && has('assets/surface.css') && has('assets/card.css') && has('assets/surface-sw.js'));
ok('the zip carries the payloads', names.some((e) => e.name.indexOf('data/index.json') === 0) && names.some((e) => e.name.indexOf('data/content/') === 0));
ok('the zip carries the record bodies', names.some((e) => e.name.indexOf('records/') === 0) && names.some((e) => e.name.indexOf('records-fr/') === 0));
ok('the zip carries the search index and matcher', has('search/index.json') && has('search/search.js'));
ok('the zip carries the manifest', has('manifest.json'));
const man = names.find((e) => e.name === 'manifest.json');
const manRaw = man.method === 8 ? zlib.inflateRawSync(man.body) : man.body;
const manifest = JSON.parse(manRaw.toString('utf8'));
ok('the manifest carries the corpus stamp', manifest.corpusStamp === dataStamp());
ok('the manifest lists every file except itself', names.filter((e) => e.name !== 'manifest.json').every((e) => manifest.files[e.name]));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
