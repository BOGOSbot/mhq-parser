#!/usr/bin/env node
// task-83: the app bundle, the data half of a native browserless reader.
//
// WHAT IT WRITES. workspace/app-bundle/ holds the payloads the page already serves
// (workspace/wiki-data: content, index, i18n) plus three artifacts:
//   manifest.json      every file's size and sha256, the corpus stamp, the per-book record
//                      counts, the glossary's own version, and the French overlay listed
//                      SEPARATELY so a reader can take English first and French later.
//   index/titles.json  every delivered record's slug, title, book and chapter path, sorted
//                      per book, for an offline find.
//   glossary/fr-en.json  src/glossary-fr-en.json copied as-is, for transcript correction.
//
// WHY A PROJECTION AND NOT A NEW SOURCE. titles.json is built FROM the index payloads,
// which already carry recs[{id, slug, title, source, snippet, num}] - the same records the
// page's tree is drawn from. Nothing here decides what a record is; the corpus does.
//
// WHY IT IS IDEMPOTENT. The manifest carries NO timestamp: every field is either read from
// the input or derived from it, and the JSON is written with sorted keys and a fixed
// indent, so two runs over the same input produce byte-identical files. A timestamp would
// make 'the bundle changed' mean 'the builder ran', which is the one thing a bundle hash
// must not say.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataStamp, dataDir } from './wiki-surface.mjs';
import { isDelivered, readAllCorpus } from './rules-corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = process.env.APP_BUNDLE_DIR || path.join(ROOT, 'workspace', 'app-bundle');
const GLOSSARY = path.join(__dirname, 'glossary-fr-en.json');
const VERSION = '1';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Deterministic JSON: sorted keys at every level, two-space indent, one trailing newline.
// JSON.stringify's own key order is insertion order, which makes a hash of the output a
// hash of the code path rather than of the data.
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

// Every DELIVERED record, projected from the corpus, enriched with the navigation the index
// payloads carry.
//
// WHY THE CORPUS IS THE SOURCE. The first version of this walked the index tree alone and
// found 1,923 records where the corpus delivers 6,327: a faction book's tree names its army
// rules and detachments as tree rows and its datasheets only as PAGE records, and a page's
// own rows live in index/<book>-rows.json. A titles list built from the tree is therefore a
// list of what the tree happens to name, not of what the corpus has, and an offline find
// over it would be missing four thousand records while looking complete. The corpus decides
// what a record is; the index and the rows payloads decide what PATH it hangs under.
function titlesFromIndex() {
  const data = dataDir();
  const index = JSON.parse(fs.readFileSync(path.join(data, 'index.json'), 'utf8'));
  // id -> { book, path, slug, num } from the tree and the per-book row maps.
  const where = new Map();
  for (const b of index.branches || []) {
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(path.join(data, 'index', b.b + '.json'), 'utf8')); } catch (e) { payload = null; }
    if (!payload) continue;
    const visit = (node, chain) => {
      const here = node.n ? chain.concat([node.n]) : chain;
      for (const r of node.recs || []) {
        if (r && r.id && !where.has(String(r.id))) where.set(String(r.id), { book: String(b.b), path: here.slice(1).join(' > '), slug: String(r.slug || ''), num: String(r.num || '') });
      }
      for (const kid of node.kids || []) visit(kid, here);
    };
    visit(payload, [payload.n || b.n || b.b]);
    // A page's rows: the tree names the page, the row map names the records under it.
    let rows = null;
    try { rows = JSON.parse(fs.readFileSync(path.join(data, 'index', b.b + '-rows.json'), 'utf8')).rows || null; } catch (e) { rows = null; }
    const pages = payload.pages || [];
    for (const p of pages) {
      for (const id of p.recs || []) {
        const key = String(id);
        const row = (rows && rows[key]) || null;
        const area = p.area ? String(p.area) : '';
        const path = area ? area + ' > ' + String(p.n || '') : String(p.n || '');
        if (!where.has(key)) where.set(key, { book: String(b.b), path, slug: row ? String(row.slug || '') : '', num: row ? String(row.num || '') : '' });
      }
    }
    if (rows) {
      for (const key of Object.keys(rows)) {
        if (where.has(key)) continue;
        where.set(key, { book: String(b.b), path: '', slug: String(rows[key].slug || ''), num: String(rows[key].num || '') });
      }
    }
  }
  const out = {};
  let total = 0;
  for (const rec of readAllCorpus()) {
    if (!isDelivered(rec)) continue;
    const id = String(rec.id || '');
    if (!id) continue;
    const nav = where.get(id) || null;
    const book = nav ? nav.book : String(rec.set || rec.source || 'other');
    if (!out[book]) out[book] = [];
    out[book].push({
      id,
      slug: nav && nav.slug ? nav.slug : String(rec.slug || ''),
      title: String(rec.title || rec.heading || ''),
      book,
      path: nav ? nav.path : '',
      num: nav ? nav.num : '',
      source: String(rec.source || ''),
    });
    total++;
  }
  for (const book of Object.keys(out)) {
    out[book].sort((x, y) => (x.num || '~').localeCompare(y.num || '~') || x.title.localeCompare(y.title) || x.id.localeCompare(y.id));
  }
  return { titles: out, total };
}

function build() {
  const data = dataDir();
  if (!fs.existsSync(data)) throw new Error('no payload at ' + data);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // 1. the payload, copied file for file
  const payloadFiles = [];
  const copy = (rel) => {
    const src = path.join(data, rel);
    const dst = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    payloadFiles.push(rel);
  };
  for (const f of fs.readdirSync(data, { withFileTypes: true })) {
    if (f.isFile() && f.name.endsWith('.json')) copy(f.name);
  }
  for (const dir of ['content', 'index', 'i18n']) {
    const full = path.join(data, dir);
    if (!fs.existsSync(full)) continue;
    for (const rel of walk(full, data)) copy(rel);
  }

  // 2. index/titles.json
  const { titles, total } = titlesFromIndex();
  const titlesRel = 'index/titles.json';
  const titlesBytes = Buffer.from(stableJson({ version: VERSION, generated: null, count: total, books: Object.keys(titles).sort(), records: titles }), 'utf8');
  fs.mkdirSync(path.join(OUT, 'index'), { recursive: true });
  fs.writeFileSync(path.join(OUT, titlesRel), titlesBytes);

  // 3. glossary/fr-en.json, copied as-is
  const glossaryRel = 'glossary/fr-en.json';
  const glossaryBytes = fs.readFileSync(GLOSSARY);
  fs.mkdirSync(path.join(OUT, 'glossary'), { recursive: true });
  fs.writeFileSync(path.join(OUT, glossaryRel), glossaryBytes);
  const glossary = JSON.parse(glossaryBytes.toString('utf8'));

  // 4. the manifest. English and French are listed separately so a reader can take the
  //    English payload first and the overlay later, and so a size report can say which is
  //    which without re-deriving it from paths.
  const files = {};
  const addFile = (rel, buf, group) => {
    files[rel] = { bytes: buf.length, sha256: sha256(buf), group };
  };
  for (const rel of payloadFiles.slice().sort()) {
    const group = rel.indexOf('i18n/') === 0 ? 'i18n' : rel.indexOf('index/') === 0 ? 'index' : rel.indexOf('content/') === 0 ? 'content' : 'root';
    addFile(rel, fs.readFileSync(path.join(OUT, rel)), group);
  }
  addFile(titlesRel, titlesBytes, 'titles');
  addFile(glossaryRel, glossaryBytes, 'glossary');

  const books = {};
  for (const [b, list] of Object.entries(titles)) books[b] = list.length;
  const manifest = {
    version: VERSION,
    app: 'mhq-rules',
    // The payload's own stamp, from the same function the server uses, so a bundle can be
    // matched against a deploy without a second definition of 'the same corpus'.
    corpusStamp: dataStamp(),
    // The stamp WITHOUT the overlay, so a reader that took English only can still say
    // which English it has.
    englishStamp: dataStamp({ skip: ['i18n'] }),
    recordCounts: { total, books },
    deliveredRecords: total,
    glossary: { file: glossaryRel, version: String(glossary.generated || ''), entries: (glossary.entries || []).length, pairs: (glossary.pairs || []).length, counts: glossary.counts || null },
    groups: { english: ['root', 'index', 'content', 'titles'], i18n: ['i18n'], glossary: ['glossary'] },
    files,
  };
  const manifestRel = 'manifest.json';
  const manifestBytes = Buffer.from(stableJson(manifest), 'utf8');
  fs.writeFileSync(path.join(OUT, manifestRel), manifestBytes);

  return { manifest, manifestBytes, titlesBytes, glossaryBytes, payloadFiles };
}

// The corpus check the test and a reader both want: every delivered record is in the bundle.
export function corpusAgainstBundle(bundleDir) {
  const dir = bundleDir || OUT;
  const t = JSON.parse(fs.readFileSync(path.join(dir, 'index', 'titles.json'), 'utf8'));
  const inBundle = new Set();
  for (const list of Object.values(t.records || {})) for (const r of list) inBundle.add(r.id);
  const all = readAllCorpus();
  const delivered = all.filter(isDelivered);
  const missing = delivered.filter(r => !inBundle.has(String(r.id))).map(r => String(r.id));
  return { delivered: delivered.length, inBundle: inBundle.size, missing };
}

function report(out) {
  const m = out.manifest;
  const sum = (pred) => Object.entries(m.files).filter(pred).reduce((a, [, f]) => a + f.bytes, 0);
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log('bundle ' + OUT);
  console.log('  files          ' + Object.keys(m.files).length);
  console.log('  english        ' + kb(sum(([, f]) => f.group !== 'i18n')));
  console.log('  i18n overlay   ' + kb(sum(([, f]) => f.group === 'i18n')));
  console.log('  total          ' + kb(sum(() => true)));
  console.log('  records        ' + m.recordCounts.total + '  ' + JSON.stringify(m.recordCounts.books));
  console.log('  corpusStamp    ' + m.corpusStamp + '   englishStamp ' + m.englishStamp);
  console.log('  glossary       ' + kb(out.glossaryBytes.length) + '  version ' + m.glossary.version);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const out = build();
  report(out);
  const check = corpusAgainstBundle();
  console.log('  delivered      ' + check.delivered + ' records, ' + check.missing.length + ' missing from the bundle');
  if (check.missing.length) { console.log('MISSING ' + check.missing.slice(0, 10).join(', ')); process.exitCode = 1; }
}

export { build, stableJson, OUT };
