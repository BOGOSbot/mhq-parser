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
// WHY A PROJECTION AND NOT A NEW SOURCE. titles.json is built FROM the payload's addressing
// table (index/rows.json, task-108), which carries one row per DELIVERED record, already
// named and addressed by the bake. Nothing here decides what a record is; the corpus does.
//
// WHY IT IS IDEMPOTENT. The manifest carries NO timestamp: every field is either read from
// the input or derived from it, and the JSON is written with sorted keys and a fixed
// indent, so two runs over the same input produce byte-identical files. A timestamp would
// make 'the bundle changed' mean 'the builder ran', which is the one thing a bundle hash
// must not say.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataStamp, dataDir } from './wiki-surface.mjs';
import { readRows, ROWS_FILE } from './rows-table.mjs';
import { isDelivered, readAllCorpus } from './rules-corpus.mjs';
// task-91: the display artifact. The text and the link spans come from the SAME functions the
// page's record body is built with, so the native reader and the web page cannot drift.
import { linkSpans } from './wikilinks.mjs';
import { stripBuiltBlock, stripSeeAlso, seeAlsoEntries } from './wiki-plan.mjs';
import { markWargearText } from './wargear-marks.mjs';

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

// Every delivered record's row, from the payload's ONE addressing table (index/rows.json).
//
// task-108. This used to REASSEMBLE the same information from three traversals - the branch
// payloads' recs and kids, the per-branch row maps, and the page lists - and between them
// they reached 2,086 of the 6,171 delivered records. A titles list that looks complete while
// a whole offline find cannot be opened is the defect the architecture walk measured, so this
// is now a projection of the table and nothing else: no corpus loop, no fallback for a record
// the tree forgot, because the table IS the delivered set (tests/test-rows-table.mjs asserts
// that against the corpus's own predicate, in both directions).
//
// It is a hard read. A payload with no table is a payload from before the bake that writes
// one, and a titles file built from it would silently lose exactly the records this task is
// about; the message names the command that fixes it instead.
function titlesFromTable() {
  const data = dataDir();
  const rows = readRows(data);
  if (!rows) throw new Error('the payload under ' + data + ' has no ' + ROWS_FILE + ': run node src/wiki-payload.mjs before building the app bundle');
  const out = {};
  let total = 0;
  for (const id of Object.keys(rows)) {
    const r = rows[id] || {};
    const book = String(r.book || 'other');
    if (!out[book]) out[book] = [];
    out[book].push({
      id,
      slug: String(r.slug || ''),
      title: String(r.title || ''),
      book,
      path: String(r.path || ''),
      num: String(r.num || ''),
      source: String(r.source || ''),
    });
    total++;
  }
  for (const book of Object.keys(out)) {
    out[book].sort((x, y) => (x.num || '~').localeCompare(y.num || '~') || x.title.localeCompare(y.title) || x.id.localeCompare(y.id));
  }
  return { titles: out, total };
}

// task-91: THE DISPLAY ARTIFACT, per record.
//
// The native reader renders the record itself, so it needs three things the payloads do not
// carry: the text as the page shows it, WHERE the inline links are (offsets, not HTML), and
// the display flags. The spans come from linkSpans, which parses the output of the same
// linkify the server renders with, so the app never learns a rule name and the two
// presentations cannot drift.
//
// The text is the page's own body path: stripBuiltBlock removes the BUILT/SEE ALSO block that
// the page draws separately, stripSeeAlso removes the see-also tail, and markWargearText marks
// the wargear values the page sets apart. Nothing here decides what a record says; the corpus
// does.
function displayFromCorpus() {
  const out = {};
  let total = 0;
  let spans = 0;
  let wargear = 0;
  for (const rec of readAllCorpus()) {
    if (!isDelivered(rec)) continue;
    const id = String(rec.id || '');
    if (!id) continue;
    const book = String(rec.set || rec.source || 'other');
    const full = stripSeeAlso({ text: stripBuiltBlock(rec), links: rec.links });
    const text = String(full == null ? '' : full);
    const marked = markWargearText(text);
    const markedFlag = marked !== text;
    if (markedFlag) wargear++;
    const sp = linkSpans(text, { selfId: id, href: (target) => String(target), cap: 12 });
    spans += sp.length;
    const kids = seeAlsoEntries(rec).map((e) => ({ num: String(e.num || ''), title: String(e.title || ''), child: !!e.child }));
    if (!out[book]) out[book] = {};
    out[book][id] = {
      title: String(rec.title || rec.heading || ''),
      text,
      spans: sp,
      kids,
      flags: { wargear: markedFlag, fr: false, excluded: false },
    };
    total++;
  }
  return { books: out, total, spans, wargear };
}
// A ZIP with no dependencies. Fixed mtime (1980-01-01, the DOS epoch) so two runs over the same
// input produce the same bytes, and deflate level 9 because the bundle is JSON.
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function writeZip(zipPath, dir, rels) {
  // (zlib is imported at the top of this file)
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
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(0, 12);
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
  const { titles, total } = titlesFromTable();
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

  // 5. task-91: the display artifact, one file per book, under display/.
  const display = displayFromCorpus();
  const displayFiles = [];
  for (const book of Object.keys(display.books).sort()) {
    const rel = 'display/' + book + '.json';
    const buf = Buffer.from(stableJson({ version: VERSION, book, records: display.books[book] }), 'utf8');
    fs.mkdirSync(path.join(OUT, 'display'), { recursive: true });
    fs.writeFileSync(path.join(OUT, rel), buf);
    displayFiles.push(rel);
    addFile(rel, buf, 'display');
  }

  // 6. task-91: index.json in the shape the app reads - the payload's own branch nodes plus the
  //    two stamps, so the app's 'update the rules' is a comparison and not a re-download. It
  //    REPLACES the payload's own index.json, which is why it is registered in the manifest here
  //    rather than copied with the payload.
  const payloadIndex = JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8'));
  const appIndex = {
    version: VERSION,
    branches: payloadIndex.branches || [],
    corpusStamp: manifest.corpusStamp,
    englishStamp: manifest.englishStamp,
    count: total,
  };
  const indexBytes = Buffer.from(stableJson(appIndex), 'utf8');
  fs.writeFileSync(path.join(OUT, 'index.json'), indexBytes);
  addFile('index.json', indexBytes, 'index');

  // 7. the manifest, LAST: every file it lists is already on disk, so no entry can be added
  //    after it is written. That was a real bug: the display files were added afterwards and
  //    the manifest shipped without them.
  const manifestFinal = Object.assign({}, manifest, {
    files,
    display: { records: display.total, spans: display.spans, wargearMarked: display.wargear, files: displayFiles.length },
  });
  const manifestBytes2 = Buffer.from(stableJson(manifestFinal), 'utf8');
  fs.writeFileSync(path.join(OUT, manifestRel), manifestBytes2);

  // 8. task-91: bundle.zip, the one file the app downloads. Deterministic like everything else
  //    here: fixed entry order, fixed timestamps, no compression difference between runs.
  const zipRel = 'app-bundle.zip';
  const zipPath = path.join(ROOT, 'workspace', zipRel);
  writeZip(zipPath, OUT, walk(OUT, OUT).sort());
  const zipBytes = fs.readFileSync(zipPath);

  return { manifest: manifestFinal, manifestBytes: manifestBytes2, titlesBytes, glossaryBytes, payloadFiles, indexBytes, displayFiles, display, zipPath, zipBytes };
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
  // task-91: what the native reader downloads, and what is in it.
  const d = (out.manifest && out.manifest.display) || {};
  console.log('  display        ' + (d.records || 0) + ' records, ' + (d.spans || 0) + ' link spans, ' + (d.wargearMarked || 0) + ' wargear-marked, ' + (d.files || 0) + ' files');
  console.log('  bundle.zip     ' + (out.zipBytes ? out.zipBytes.length : 0) + ' bytes  sha256 ' + (out.zipBytes ? sha256(out.zipBytes) : ''));
  if (check.missing.length) { console.log('MISSING ' + check.missing.slice(0, 10).join(', ')); process.exitCode = 1; }
}

export { build, stableJson, OUT };
