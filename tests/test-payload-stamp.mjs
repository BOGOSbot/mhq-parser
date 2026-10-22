// task-95: the payload stamp is a CONTENT hash, because the app compares it and tells the reader
// whether the rules have moved.
//
// The defect it fixes: the stamp hashed (name, mtime, size), so the same corpus baked here and
// deployed on the Box produced two different stamps - the bundle said a7ef17e1, the Box said
// b6d8424a - and 'check for newer rules' told the reader to download a bundle that was already
// current, forever.
//
// The test builds two copies of a payload with DIFFERENT mtimes and asserts one stamp, then
// changes one byte and asserts a different one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const N = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-stamp-'));
const a = path.join(tmp, 'a');
const b = path.join(tmp, 'b');
for (const dir of [a, b]) {
  fs.mkdirSync(path.join(dir, 'index'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'content'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ branches: [{ b: 'rules', n: 'Rules', c: 2 }] }));
  fs.writeFileSync(path.join(dir, 'index', 'rules.json'), JSON.stringify({ kids: [] }));
  fs.writeFileSync(path.join(dir, 'content', 'rules.json'), JSON.stringify({ records: { 'core-rules#A': { text: 'hello' } } }));
}

// The SAME bytes, with the mtimes moved a year apart, and the files touched in a different order.
const old = new Date('2020-01-01T00:00:00Z');
const now = new Date('2026-01-01T00:00:00Z');
for (const f of ['index.json', 'index/rules.json', 'content/rules.json']) fs.utimesSync(path.join(a, f), old, old);
for (const f of ['index.json', 'index/rules.json', 'content/rules.json']) fs.utimesSync(path.join(b, f), now, now);

const modA = await import('../src/wiki-surface.mjs?dir=' + encodeURIComponent(a));
process.env.WIKI_DATA_DIR = a;
const first = (await import('../src/wiki-surface.mjs?x=1')).dataStamp();
process.env.WIKI_DATA_DIR = b;
const second = (await import('../src/wiki-surface.mjs?x=2')).dataStamp();
ok('the same payload with different mtimes gives the SAME stamp', first === second);
ok('and the stamp is a content hash, not an empty string', first.length === 8);

// One byte changes the stamp.
fs.writeFileSync(path.join(b, 'content', 'rules.json'), JSON.stringify({ records: { 'core-rules#A': { text: 'hello!' } } }));
const third = (await import('../src/wiki-surface.mjs?x=3')).dataStamp();
ok('a changed payload changes the stamp', third !== first);

// A rewrite that keeps every name and size still changes it: same length, one letter different.
fs.writeFileSync(path.join(b, 'content', 'rules.json'), JSON.stringify({ records: { 'core-rules#A': { text: 'hellp' } } }));
const fourth = (await import('../src/wiki-surface.mjs?x=4')).dataStamp();
ok('a same-size rewrite changes the stamp', fourth !== third && fourth !== first);

// The memo: the second call over unchanged files returns the same value without re-reading.
const fifth = (await import('../src/wiki-surface.mjs?x=5')).dataStamp();
ok('the memo returns the same value for unchanged files', fifth === fourth);

// The skip list still separates the English half from the overlay.
fs.mkdirSync(path.join(b, 'i18n', 'fr'), { recursive: true });
fs.writeFileSync(path.join(b, 'i18n', 'fr', 'rules.json'), JSON.stringify({ records: {} }));
const withFr = (await import('../src/wiki-surface.mjs?x=6')).dataStamp();
const noFr = (await import('../src/wiki-surface.mjs?x=7')).dataStamp({ skip: ['i18n'] });
ok('the overlay is part of the full stamp', withFr !== fourth);
ok('and the skip list gives the English half its own stamp', noFr !== withFr && noFr === fourth);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
