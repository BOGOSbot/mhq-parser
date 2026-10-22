// task-91: the display artifact and the bundle the native reader downloads.
//
// The three things that can silently break the app: a span that does not line up with the text
// it points at, an index.json whose shape the app does not read, and a served zip that is not
// the one that was built. Each is asserted here against the real bundle.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { linkSpans } from '../src/wikilinks.mjs';
import { stripBuiltBlock, stripSeeAlso } from '../src/wiki-plan.mjs';
import { readAllCorpus, isDelivered } from '../src/rules-corpus.mjs';
import { build, stableJson } from '../src/app-bundle.mjs';

const N = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const OUT = path.join(ROOT, 'workspace', 'app-bundle');

// The bundle is built here rather than assumed: a test that reads yesterday's artifact is a
// test of yesterday's code.
const built = build();

// --- 1. the artifact's text is the page's own body path ------------------------
const byId = new Map();
for (const rec of readAllCorpus()) { if (isDelivered(rec)) byId.set(String(rec.id), rec); }
const rules = JSON.parse(fs.readFileSync(path.join(OUT, 'display', 'rules.json'), 'utf8'));
const ids = Object.keys(rules.records);
ok('the display artifact carries records', ids.length > 500);

let checked = 0, mismatched = 0, badSpan = 0, badId = 0, spansSeen = 0;
for (const id of ids) {
  const d = rules.records[id];
  const rec = byId.get(id);
  if (!rec) continue;
  const want = String(stripSeeAlso({ text: stripBuiltBlock(rec), links: rec.links }) || '');
  if (d.text !== want) mismatched++;
  checked++;
  for (const s of d.spans) {
    spansSeen++;
    if (d.text.slice(s.start, s.end) !== s.text) badSpan++;
    if (!s.id || s.id === 'undefined') badId++;
  }
}
ok('every record in the artifact was checked', checked === ids.length);
ok('the text is the page body path, byte for byte', mismatched === 0);
ok('every span points at the text it names', badSpan === 0);
ok('every span carries a record id', badId === 0);
ok('and there are spans to check', spansSeen > 1000);

// --- 2. the spans are the ones the server renders with -------------------------
const one = ids.find((id) => (rules.records[id].spans || []).length > 0);
const rec = rules.records[one];
const fresh = linkSpans(rec.text, { selfId: one, href: (t) => String(t), cap: 12 });
// Compared through stableJson: the artifact is written with sorted keys, so a plain
// JSON.stringify would compare key ORDER and fail on identical values.
ok('the artifact spans are the linkifier\'s own output', stableJson(fresh) === stableJson(rec.spans));
ok('and they are not empty for the record that has one', fresh.length > 0);

// --- 3. index.json is the shape the app reads ---------------------------------
const index = JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8'));
ok('index.json carries branches', Array.isArray(index.branches) && index.branches.length > 0);
ok('a branch has the b / n / c the app reads', index.branches.every((b) => typeof b.b === 'string' && typeof b.n === 'string' && typeof b.c === 'number'));
ok('index.json carries the corpus stamp', typeof index.corpusStamp === 'string' && index.corpusStamp.length > 0);
ok('index.json carries the english stamp', typeof index.englishStamp === 'string' && index.englishStamp.length > 0);
ok('the two stamps are the manifest\'s', index.corpusStamp === built.manifest.corpusStamp && index.englishStamp === built.manifest.englishStamp);
ok('and the count matches the records delivered', index.count === 6327 || index.count > 6000);

// --- 4. the zip the app downloads ---------------------------------------------
const zipPath = path.join(ROOT, 'workspace', 'app-bundle.zip');
const zip = fs.readFileSync(zipPath);
ok('bundle.zip was written', zip.length > 1000000);
ok('it starts with a local file header', zip.readUInt32LE(0) === 0x04034b50);
// Read the central directory the way an unzip does, and check the entries the app needs.
const entries = [];
let at = 0;
while (at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50) {
  const method = zip.readUInt16LE(at + 8);
  const compSize = zip.readUInt32LE(at + 18);
  const rawSize = zip.readUInt32LE(at + 22);
  const nameLen = zip.readUInt16LE(at + 26);
  const extraLen = zip.readUInt16LE(at + 28);
  const name = zip.slice(at + 30, at + 30 + nameLen).toString('utf8');
  const body = zip.slice(at + 30 + nameLen + extraLen, at + 30 + nameLen + extraLen + compSize);
  entries.push({ name, method, rawSize, body });
  at += 30 + nameLen + extraLen + compSize;
}
ok('the zip has the app\'s layout', entries.length > 10);
const names = entries.map((e) => e.name);
ok('it carries index.json', names.indexOf('index.json') !== -1);
ok('it carries manifest.json', names.indexOf('manifest.json') !== -1);
ok('it carries index/titles.json', names.indexOf('index/titles.json') !== -1);
ok('it carries the per-branch trees', names.some((n) => /^index\/[a-z0-9-]+\.json$/.test(n) && n.indexOf('titles') === -1));
ok('it carries content/<book>.json', names.some((n) => /^content\/[a-z0-9-]+\.json$/.test(n)));
ok('it carries the display artifact', names.filter((n) => n.indexOf('display/') === 0).length === 3);
const idxEntry = entries.find((e) => e.name === 'index.json');
const idxRaw = idxEntry.method === 8 ? zlib.inflateRawSync(idxEntry.body) : idxEntry.body;
ok('the zipped index.json is the one on disk', idxRaw.toString('utf8') === fs.readFileSync(path.join(OUT, 'index.json'), 'utf8'));

// --- 5. the manifest and the zip agree ----------------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
ok('the manifest lists the display files', !!manifest.files['display/rules.json']);
ok('the manifest reports the display counts', manifest.display.records > 6000 && manifest.display.spans > 1000);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mEntry = entries.find((e) => e.name === 'manifest.json');
const mRaw = mEntry.method === 8 ? zlib.inflateRawSync(mEntry.body) : mEntry.body;
ok('the zipped manifest matches its own hash entry', sha(mRaw) === sha(fs.readFileSync(path.join(OUT, 'manifest.json'))));
let fileMismatch = 0;
for (const e of entries) {
  // manifest.json is not listed in itself, by design: a file cannot carry its own hash.
  if (e.name === 'manifest.json') continue;
  const f = manifest.files[e.name];
  if (!f) { fileMismatch++; console.log('  UNLISTED ' + e.name); continue; }
  const raw = e.method === 8 ? zlib.inflateRawSync(e.body) : e.body;
  if (raw.length !== f.bytes || sha(raw) !== f.sha256) { fileMismatch++; console.log('  MISMATCH ' + e.name + ' zip=' + raw.length + '/' + sha(raw).slice(0, 8) + ' manifest=' + f.bytes + '/' + String(f.sha256).slice(0, 8)); }
}
ok('every zipped file matches the manifest\'s size and sha256', fileMismatch === 0);

// --- 6. deterministic: two builds, the same zip --------------------------------
const first = sha(zip);
build();
const second = sha(fs.readFileSync(zipPath));
ok('two builds over the same input produce the same zip', first === second);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
