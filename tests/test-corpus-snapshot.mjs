import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { snapshotCorpus } from '../src/rules-corpus.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

// task-82: a snapshot must be a real tar.gz of the directory, keeping three.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-snap-'));
const src = path.join(root, 'rules-corpus');
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, 'core-rules.json'), JSON.stringify({ sections: [{ id: 'a' }] }));
fs.writeFileSync(path.join(src, 'notes.txt'), 'hello snapshot');

const out = path.join(root, 'box-snapshot');
const one = snapshotCorpus({ dir: src, outDir: out, stamp: '202601010101' });
ok('the snapshot file exists', fs.existsSync(one));
ok('and is named for the minute', /rules-corpus-\d{12}\.tar\.gz$/.test(path.basename(one)));
const buf = fs.readFileSync(one);
t('and is gzip', [buf[0], buf[1]], [0x1f, 0x8b]);
const raw = zlib.gunzipSync(buf).toString('latin1');
ok('and carries the directory and its files', raw.indexOf('rules-corpus/core-rules.json') !== -1 && raw.indexOf('rules-corpus/notes.txt') !== -1);
const listed = execFileSync('tar', ['-tzf', one]).toString();
ok('a system tar can list it', listed.indexOf('rules-corpus/core-rules.json') !== -1 && listed.indexOf('rules-corpus/notes.txt') !== -1);
const extracted = path.join(root, 'extract');
fs.mkdirSync(extracted, { recursive: true });
execFileSync('tar', ['-xzf', one, '-C', extracted]);
t('and extracting it gives the file back byte for byte', fs.readFileSync(path.join(extracted, 'rules-corpus', 'core-rules.json'), 'utf8'), fs.readFileSync(path.join(src, 'core-rules.json'), 'utf8'));

for (const s of ['202601010102', '202601010103', '202601010104', '202601010105']) snapshotCorpus({ dir: src, outDir: out, stamp: s });
const kept = fs.readdirSync(out).filter(f => /^rules-corpus-\d{12}\.tar\.gz$/.test(f)).sort();
t('only the last three are kept', kept, ['rules-corpus-202601010103.tar.gz', 'rules-corpus-202601010104.tar.gz', 'rules-corpus-202601010105.tar.gz']);

fs.rmSync(root, { recursive: true, force: true });
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
