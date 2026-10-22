#!/usr/bin/env node
// task-97: THE LOCAL WEB BUNDLE.
//
// The native Android reader was a failure, so the app becomes a WebView holding the data and
// running the SAME client the browser runs. That is the point of this file: no second renderer,
// so the two presentations cannot drift.
//
// WHAT IT WRITES, into workspace/web-bundle/ and a deterministic workspace/web-bundle.zip:
//   index.html              the bytes GET /rules returns today, stamps substituted the same way
//   assets/*                the real client files, copied
//   data/**                 a copy of workspace/wiki-data
//   records/<book>.json     the pre-rendered recordBody() HTML, English
//   records-fr/<book>.json  the same in French, for the records the overlay covers
//   search/index.json       the header index the find route greps
//   search/search.js        the matcher, from src/search-core.mjs
//   search/keywords.json    the keyword vocabulary, the French-to-English table
//   search/glossary.json    the glossary's French-to-English pairs
//   search/vocab.json       every word a heading carries, for the phonetic leg
//   search/search.js        the browser-side matcher, from src/search-core.mjs
//   manifest.json           sizes, sha256, the corpus stamp, counts. No timestamp, so two runs
//                           are byte-identical.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { assetStamp, workerStamp, dataStamp, dataDir, surfaceSlugMap } from './wiki-surface.mjs';
import { recordBody, cardIndex, CARD_CSS } from './wiki-cards.mjs';
import { readAllCorpus, isDelivered } from './rules-corpus.mjs';
import { frUsable } from './i18n-fr.mjs';
import { buildHeaderIndex } from './header-index.mjs';
import { headingVocab } from './search-core.mjs';
import { KEYWORDS, glossaryIndex } from './translate-fr-en.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = process.env.WEB_BUNDLE_DIR || path.join(ROOT, 'workspace', 'web-bundle');
const VERSION = '1';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = stable(value[k]);
    return out;
  }
  return value;
}
function stableJson(value) { return JSON.stringify(stable(value), null, 2) + String.fromCharCode(10); }
function walk(dir, base) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

// The page the route serves, stamps and all. This is the anti-drift anchor for the whole bundle:
// if these bytes differ from GET /rules, the app is running a different client.
export function pageHtml() {
  const v = assetStamp();
  return fs.readFileSync(path.join(__dirname, 'rules.html'), 'utf8')
    .replace('/rules/surface.css"', '/rules/surface.css?v=' + v + '"')
    .replace('/rules/surface.js"', '/rules/surface.js?v=' + v + '"')
    .replace('__WORKER_STAMP__', workerStamp());
}

export function build() {
  const data = dataDir();
  if (!fs.existsSync(data)) throw new Error('no payload at ' + data);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const files = {};
  const add = (rel, buf, group) => {
    files[rel] = { bytes: buf.length, sha256: sha256(buf), group };
  };

  // 1. the page
  const html = Buffer.from(pageHtml(), 'utf8');
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  add('index.html', html, 'shell');

  // 2. the client files, copied byte for byte. The worker's own bytes carry the stamp the route
  //    substitutes, so the app's offline cache name matches the site's.
  // card.css is a STRING in src/wiki-cards.mjs (the record card's own stylesheet, one source for
  // the record page and the ask dialog), so it is written from there rather than copied.
  const cardCss = Buffer.from(CARD_CSS, 'utf8');
  fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'assets', 'card.css'), cardCss);
  add('assets/card.css', cardCss, 'shell');
  for (const pair of [['surface.js', 'wiki-surface.js'], ['surface.css', 'wiki-surface.css'], ['surface-sw.js', 'wiki-surface-sw.js']]) {
    const src = path.join(__dirname, pair[1]);
    if (!fs.existsSync(src)) continue;
    let body = fs.readFileSync(src);
    if (pair[1] === 'wiki-surface-sw.js') body = Buffer.from(body.toString('utf8').split('__STAMP__').join(workerStamp()), 'utf8');
    const rel = 'assets/' + pair[0];
    fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(OUT, rel), body);
    add(rel, body, 'shell');
  }

  // 3. the baked payloads
  const copy = (rel) => {
    const dst = path.join(OUT, 'data', rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(data, rel), dst);
    add('data/' + rel, fs.readFileSync(dst), rel.indexOf('i18n/') === 0 ? 'i18n' : 'data');
  };
  for (const f of fs.readdirSync(data, { withFileTypes: true })) {
    if (f.isFile() && f.name.endsWith('.json')) copy(f.name);
  }
  for (const dir of ['content', 'index', 'i18n']) {
    const full = path.join(data, dir);
    if (!fs.existsSync(full)) continue;
    for (const rel of walk(full, data)) copy(rel);
  }

  // 4. the pre-rendered record bodies, with THE SAME options the /rules/record route uses:
  //    corpora, index, href, selfId, frText.
  const all = readAllCorpus().filter(isDelivered);
  const byId = new Map(all.map((r) => [String(r.id), r]));
  const idx = cardIndex(byId);
  // task-97 FIX: recordBody reads corpora as the THREE-HALF object the server passes
  // ({rules, factions, rulings}), not as a Map. With a Map, o.corpora.rules is undefined, so
  // mergeChunkParts, seeAlsoKids and emptyBodyKids all silently do nothing, and 834 records (37
  // rules, 797 factions) rendered differently from the route. The halves hold the same records
  // the server's own corpora() builds.
  const halves = { rules: [], factions: [], rulings: [] };
  for (const rec of all) { const s = String(rec.set || ''); if (halves[s]) halves[s].push(rec); }
  const slugs = surfaceSlugMap();
  const href = (id) => { const s = slugs.get(String(id || '')); return s ? '#' + s : ''; };
  const books = {};
  const booksFr = {};
  let records = 0, french = 0;
  for (const rec of all) {
    const id = String(rec.id || '');
    if (!id) continue;
    const book = String(rec.set || rec.source || 'other');
    if (!books[book]) books[book] = {};
    books[book][id] = recordBody(rec, { corpora: halves, index: idx, href, selfId: id, frText: '' });
    records++;
    const fr = frUsable(id);
    if (fr) {
      if (!booksFr[book]) booksFr[book] = {};
      booksFr[book][id] = recordBody(rec, { corpora: halves, index: idx, href, selfId: id, frText: fr });
      french++;
    }
  }
  const writeBooks = (dir, source, group) => {
    for (const book of Object.keys(source).sort()) {
      const rel = dir + '/' + book + '.json';
      const buf = Buffer.from(stableJson({ version: VERSION, book, records: source[book] }), 'utf8');
      fs.mkdirSync(path.join(OUT, dir), { recursive: true });
      fs.writeFileSync(path.join(OUT, rel), buf);
      add(rel, buf, group);
    }
  };
  writeBooks('records', books, 'records');
  writeBooks('records-fr', booksFr, 'records-fr');

  // 5. the find index and the matcher. The INDEX is the same structure the server builds, so the
  //    browser and the server grep the same rows.
  // DELIVERED records only: the index the find route greps holds what the reader can open, and
  // a filtered record is not in the product's search at all.
  const headerIndex = buildHeaderIndex(all);
  const indexRel = 'search/index.json';
  const indexBuf = Buffer.from(stableJson({ version: VERSION, entries: headerIndex }), 'utf8');
  fs.mkdirSync(path.join(OUT, 'search'), { recursive: true });
  fs.writeFileSync(path.join(OUT, indexRel), indexBuf);
  add(indexRel, indexBuf, 'search');
  const searchRel = 'search/search.js';
  const searchBuf = fs.readFileSync(path.join(__dirname, 'search-core.mjs'));
  fs.writeFileSync(path.join(OUT, searchRel), searchBuf);
  add(searchRel, searchBuf, 'search');
  // The phonetic leg's own module, copied: it has no node imports, so the browser can run it and
  // the misheard-name rescue works offline instead of being a server-only behaviour.
  const phonRel = 'search/phonetic.js';
  const phonBuf = fs.readFileSync(path.join(__dirname, 'phonetic.mjs'));
  fs.writeFileSync(path.join(OUT, phonRel), phonBuf);
  add(phonRel, phonBuf, 'search');
  // task-97: THE TABLES THE MATCHER NEEDS, as data. Without them the app's offline find cannot do
  // French (the glossary pairs and the keyword vocabulary) and cannot rescue a misheard name (the
  // vocabulary the phonetic leg tests against). The server builds the same three in memory.
  const tables = {
    keywords: KEYWORDS,
    glossary: Array.from(glossaryIndex().frToEn.entries()).map(([fr, e]) => [fr, e && e.en ? e.en : '']),
    vocab: Array.from(headingVocab(headerIndex)).sort(),
  };
  for (const name of ['keywords', 'glossary', 'vocab']) {
    const rel = 'search/' + name + '.json';
    const buf = Buffer.from(stableJson({ version: VERSION, [name]: tables[name] }), 'utf8');
    fs.writeFileSync(path.join(OUT, rel), buf);
    add(rel, buf, 'search');
  }

  // 6. the manifest, last: every file it lists is already on disk.
  const booksCount = {};
  for (const b of Object.keys(books)) booksCount[b] = Object.keys(books[b]).length;
  const manifest = {
    version: VERSION,
    app: 'mhq-rules-web',
    corpusStamp: dataStamp(),
    englishStamp: dataStamp({ skip: ['i18n'] }),
    recordCounts: { total: records, books: booksCount },
    frenchRecords: french,
    files,
  };
  const manifestRel = 'manifest.json';
  const manifestBuf = Buffer.from(stableJson(manifest), 'utf8');
  fs.writeFileSync(path.join(OUT, manifestRel), manifestBuf);

  // 7. the zip, deterministic like the app bundle: fixed entry order, fixed mtimes, level 9.
  const zipPath = path.join(ROOT, 'workspace', 'web-bundle.zip');
  writeZip(zipPath, OUT, walk(OUT, OUT).sort());
  const zipBytes = fs.readFileSync(zipPath);
  return { manifest, manifestBuf, zipPath, zipBytes, records, french };
}

// A ZIP with no dependencies, fixed mtime (the DOS epoch) so two runs are byte-identical.
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
export function writeZip(zipPath, dir, rels) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const rel of rels) {
    const raw = fs.readFileSync(path.join(dir, rel));
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const name = Buffer.from(rel.split(path.sep).join('/'), 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(0x0021, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(rels.length, 8);
  end.writeUInt16LE(rels.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat([Buffer.concat(chunks), cenBuf, end]));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const out = build();
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  const m = out.manifest;
  const sum = (pred) => Object.entries(m.files).filter(pred).reduce((a, [, f]) => a + f.bytes, 0);
  console.log('web bundle ' + OUT);
  console.log('  files        ' + Object.keys(m.files).length);
  console.log('  shell        ' + kb(sum(([, f]) => f.group === 'shell')));
  console.log('  data         ' + kb(sum(([, f]) => f.group === 'data' || f.group === 'i18n')));
  console.log('  records      ' + kb(sum(([, f]) => f.group === 'records')) + '  (' + out.records + ' English, ' + out.french + ' French)');
  console.log('  search       ' + kb(sum(([, f]) => f.group === 'search')));
  console.log('  corpusStamp  ' + m.corpusStamp);
  console.log('  web-bundle.zip ' + out.zipBytes.length + ' bytes  sha256 ' + sha256(out.zipBytes));
}

export { stableJson, OUT };
