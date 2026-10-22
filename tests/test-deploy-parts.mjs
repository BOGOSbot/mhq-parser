// task-87: the archive splitter deletes its own parts, and the split is verified before it is
// uploaded.
//
// The bug this pins was found in the Box, not here: a smaller rebuild left the tail of an
// older part file behind, the concatenation was longer than the archive, and the upload died
// with 'gzip: invalid compressed data--crc error'. One of those deploys left a server running
// the OLD code, which is worse than a dead one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existingParts, partPaths, splitArchive, verifyParts, PART_COUNT } from '../src/deploy-parts.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-parts-'));
const archive = (name, bytes) => { const p = path.join(tmp, name); fs.writeFileSync(p, Buffer.alloc(bytes, 7)); return p; };

// --- the stale-tail case, which is the defect ---------------------------------
const dir = path.join(tmp, 'stale');
fs.mkdirSync(dir, { recursive: true });
// A previous build wrote BIG parts; the new archive is small.
const big = archive('big.tgz', 6000);
splitArchive(big, dir, PART_COUNT);
ok('a first split writes the parts', existingParts(dir).length === PART_COUNT);
const small = archive('small.tgz', 1200);
const res = splitArchive(small, dir, PART_COUNT);
const stale = existingParts(dir).filter(p => res.parts.indexOf(p) === -1);
ok('a smaller rebuild leaves no stale part behind', stale.length === 0);
ok('and it rewrites every part it names', res.parts.length === PART_COUNT && fs.statSync(res.parts[PART_COUNT - 1]).size <= 200);
const check = verifyParts(dir, small, PART_COUNT);
ok('the concatenation equals the archive in length', check.concatBytes === check.archiveBytes);
ok('and in sha256', check.concatSha256 === check.archiveSha256);
ok('the check passes', check.ok === true);

// --- the check catches a hand-planted stale tail ------------------------------
// The exact shape of the original failure: the right parts, plus an old file after them.
const dir2 = path.join(tmp, 'planted');
fs.mkdirSync(dir2, { recursive: true });
const a2 = archive('a2.tgz', 5000);
splitArchive(a2, dir2, PART_COUNT);
fs.writeFileSync(path.join(dir2, 'mhq56.part99'), Buffer.alloc(400, 7));
const planted = verifyParts(dir2, a2, PART_COUNT);
ok('a planted stale part is caught', planted.ok === false);
ok('and it is named', planted.stale.indexOf('mhq56.part99') !== -1);
let threw = '';
try { splitArchive(a2, dir2, PART_COUNT); } catch (e) { threw = String(e.message); }
ok('but a split deletes it rather than failing', threw === '' && existingParts(dir2).every(p => fs.statSync(p).size <= 1000));

// --- a hand-edited part is caught by the hash --------------------------------
const dir3 = path.join(tmp, 'edited');
fs.mkdirSync(dir3, { recursive: true });
const a3 = archive('a3.tgz', 4000);
splitArchive(a3, dir3, PART_COUNT);
const first = partPaths(dir3, PART_COUNT)[0];
const bytes = fs.readFileSync(first);
bytes[0] = bytes[0] ^ 0xff;
fs.writeFileSync(first, bytes);
const edited = verifyParts(dir3, a3, PART_COUNT);
ok('an edited part fails the check', edited.ok === false);
ok('on the hash, with the length intact', edited.concatBytes === edited.archiveBytes && edited.concatSha256 !== edited.archiveSha256);

// --- a normal split ----------------------------------------------------------
const dir4 = path.join(tmp, 'normal');
fs.mkdirSync(dir4, { recursive: true });
const a4 = archive('a4.tgz', 17);
const r4 = splitArchive(a4, dir4, 6);
ok('a tiny archive still writes the part count, with the tail empty', r4.parts.length === PART_COUNT && fs.readdirSync(dir4).length === PART_COUNT);
ok('and verifies', r4.check.ok === true && r4.check.concatBytes === 17);
const a5 = archive('a5.tgz', 17648772);
const dir5 = path.join(tmp, 'big');
fs.mkdirSync(dir5, { recursive: true });
const r5 = splitArchive(a5, dir5, PART_COUNT);
ok('the real size splits into six parts', r5.parts.length === PART_COUNT);
ok('each part is under the upload limit', r5.parts.every(p => fs.statSync(p).size < 3 * 1024 * 1024));
ok('and the concatenation hashes as the archive does', r5.check.concatSha256 === sha256(fs.readFileSync(a5)));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
