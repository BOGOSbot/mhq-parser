// task-83: the app bundle. The test checks the four things the card names, and it checks
// them against the FILES, not against the builder's own report.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, corpusAgainstBundle, OUT, stableJson } from '../src/app-bundle.mjs';
import { dataDir } from '../src/wiki-surface.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const DATA = dataDir();

// The builder runs here rather than being assumed: the acceptance is that it writes the
// bundle, so the test does that and then inspects what landed.
const first = build();
const manifestBytes1 = fs.readFileSync(path.join(OUT, 'manifest.json'));
const manifest = JSON.parse(manifestBytes1.toString('utf8'));

// --- 1. every manifest hash matches the file --------------------------------
let hashed = 0, badHash = [], badSize = [];
for (const [rel, meta] of Object.entries(manifest.files)) {
  const p = path.join(OUT, rel);
  if (!fs.existsSync(p)) { badHash.push(rel + ' (missing)'); continue; }
  const buf = fs.readFileSync(p);
  hashed++;
  if (buf.length !== meta.bytes) badSize.push(rel);
  if (crypto.createHash('sha256').update(buf).digest('hex') !== meta.sha256) badHash.push(rel);
}
ok('the manifest lists files', hashed > 50);
ok('every listed file exists and hashes as the manifest says', badHash.length === 0);
if (badHash.length) console.log('  bad: ' + badHash.slice(0, 5).join(', '));
ok('and every listed size matches', badSize.length === 0);
if (badSize.length) console.log('  size: ' + badSize.slice(0, 5).join(', '));

// --- 2. every delivered record is present -----------------------------------
const check = corpusAgainstBundle(OUT);
ok('the corpus delivers records', check.delivered > 6000);
ok('every delivered record is in the bundle', check.missing.length === 0);
if (check.missing.length) console.log('  missing: ' + check.missing.slice(0, 5).join(', '));
ok('the bundle holds no record the corpus does not deliver', check.inBundle === check.delivered);
const titles = JSON.parse(fs.readFileSync(path.join(OUT, 'index', 'titles.json'), 'utf8'));
ok('the titles file says how many it holds', titles.count === check.delivered);
ok('the record counts per book add up', Object.values(manifest.recordCounts.books).reduce((a, b) => a + b, 0) === manifest.recordCounts.total);
ok('every title carries a slug or an id', Object.values(titles.records).flat().every(r => r.id && (r.slug || r.id)));
ok('every title names its book', Object.entries(titles.records).every(([b, list]) => list.every(r => r.book === b)));
ok('the titles are sorted per book', Object.values(titles.records).every(list => list.every((r, i) => i === 0 || (list[i - 1].num || '~').localeCompare(r.num || '~') <= 0)));

// --- 3. the file list is the payload's list plus the three artifacts ---------
const walk = (dir, base) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
};
const payloadFiles = walk(DATA, DATA).sort();
const ARTIFACTS = ['manifest.json', 'index/titles.json', 'glossary/fr-en.json'];
const bundleFiles = walk(OUT, OUT).sort();
const expected = payloadFiles.concat(ARTIFACTS).sort();
ok('the bundle is the payload plus exactly three artifacts', JSON.stringify(bundleFiles) === JSON.stringify(expected));
if (JSON.stringify(bundleFiles) !== JSON.stringify(expected)) {
  const extra = bundleFiles.filter(f => expected.indexOf(f) === -1);
  const gone = expected.filter(f => bundleFiles.indexOf(f) === -1);
  console.log('  extra: ' + extra.slice(0, 5).join(', ') + '  gone: ' + gone.slice(0, 5).join(', '));
}
ok('the manifest lists every file in the bundle except itself', bundleFiles.filter(f => f !== 'manifest.json').every(f => manifest.files[f]));
ok('the glossary is copied as-is', fs.readFileSync(path.join(OUT, 'glossary', 'fr-en.json')).equals(fs.readFileSync(path.join(ROOT, 'src', 'glossary-fr-en.json'))));
ok('the manifest names the glossary version', !!manifest.glossary.version && manifest.glossary.file === 'glossary/fr-en.json');
ok('the manifest carries the corpus stamp', /^[0-9a-f]{8}$/.test(manifest.corpusStamp));
ok('and an English-only stamp that differs from it', /^[0-9a-f]{8}$/.test(manifest.englishStamp) && manifest.englishStamp !== manifest.corpusStamp);
ok('the overlay is listed separately from English', manifest.groups.i18n.length === 1 && manifest.groups.english.indexOf('i18n') === -1 && Object.entries(manifest.files).every(([rel, f]) => f.group === (rel.indexOf('i18n/') === 0 ? 'i18n' : f.group)));
ok('the English half has no i18n file in it', Object.entries(manifest.files).every(([rel, f]) => f.group !== 'i18n' || rel.indexOf('i18n/') === 0));

// --- 4. idempotent: same input, same manifest bytes -------------------------
const second = build();
const manifestBytes2 = fs.readFileSync(path.join(OUT, 'manifest.json'));
ok('a second run writes byte-identical manifest bytes', manifestBytes1.equals(manifestBytes2));
ok('and the same titles bytes', fs.readFileSync(path.join(OUT, 'index', 'titles.json')).equals(Buffer.from(stableJson({ version: '1', generated: null, count: titles.count, books: titles.books, records: titles.records }), 'utf8')));
ok('the builder reports the same totals twice', second.manifest.recordCounts.total === first.manifest.recordCounts.total);
ok('the manifest carries no timestamp that would break the hash', manifestBytes1.toString('utf8').indexOf('generated') === -1 || JSON.parse(manifestBytes1.toString('utf8')).generated === undefined);

console.log(pass + ' passed, ' + fail + ' failed');
console.log('bundle: ' + Object.keys(manifest.files).length + ' files, ' + manifest.recordCounts.total + ' records, stamp ' + manifest.corpusStamp + ', english ' + manifest.englishStamp);
process.exitCode = fail ? 1 : 0;
