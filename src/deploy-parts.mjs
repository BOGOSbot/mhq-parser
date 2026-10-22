#!/usr/bin/env node
// task-87: split a deploy archive into uploadable parts, and PROVE the split before anyone
// uploads it.
//
// WHY THIS EXISTS. The splitter used to write fixed-size parts and never delete the parts of a
// previous build. When a rebuild produced a SMALLER archive, the tail of the old last part
// survived, the concatenation was longer than the archive, and the upload was corrupt: two
// deploys died in the Box with 'gzip: invalid compressed data--crc error' and 'tar: A lone zero
// block at 131347', and one of them left a server running the OLD code. A page that looks alive
// and answers with yesterday's rules is the worst deploy failure there is, so the check belongs
// here, on this machine, before the upload.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PART_PREFIX = 'mhq56.part';
export const PART_COUNT = 6;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function partPaths(dir, count) {
  const n = count || PART_COUNT;
  const out = [];
  for (let i = 1; i <= n; i++) out.push(path.join(dir, PART_PREFIX + String(i).padStart(2, '0')));
  return out;
}

// Every part a previous build could have left, including ones beyond the current count: a
// build that used to write eight parts leaves two that a six-part run would never touch.
export function existingParts(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names
    .filter(n => n.indexOf(PART_PREFIX) === 0 && /^\d+$/.test(n.slice(PART_PREFIX.length)))
    .sort()
    .map(n => path.join(dir, n));
}

// The check the Box was doing for us. Length AND sha256, because a stale tail of the same
// length as the gap would pass a length check alone.
export function verifyParts(dir, archivePath, count) {
  const want = fs.readFileSync(archivePath);
  const files = partPaths(dir, count).filter(p => fs.existsSync(p));
  const got = Buffer.concat(files.map(p => fs.readFileSync(p)));
  const stale = existingParts(dir).filter(p => files.indexOf(p) === -1);
  const wantSha = sha256(want);
  const gotSha = sha256(got);
  return {
    ok: got.length === want.length && gotSha === wantSha && stale.length === 0,
    archiveBytes: want.length,
    concatBytes: got.length,
    archiveSha256: wantSha,
    concatSha256: gotSha,
    parts: files.length,
    stale: stale.map(p => path.basename(p)),
  };
}

// Split, and refuse to leave a split that does not verify. The parts are written only after
// the stale ones are gone, so a failure between the two leaves no part of a previous build for
// a later upload to pick up.
export function splitArchive(archivePath, dir, count) {
  const n = count || PART_COUNT;
  const buf = fs.readFileSync(archivePath);
  for (const p of existingParts(dir)) fs.rmSync(p, { force: true });
  const per = Math.ceil(buf.length / n);
  const written = [];
  for (let i = 0; i < n; i++) {
    const start = i * per;
    const p = partPaths(dir, n)[i];
    fs.writeFileSync(p, buf.subarray(start, Math.min(buf.length, start + per)));
    written.push(p);
  }
  const check = verifyParts(dir, archivePath, n);
  if (!check.ok) {
    const why = check.stale.length ? 'stale parts left: ' + check.stale.join(', ')
      : check.concatBytes !== check.archiveBytes ? 'the concatenation is ' + check.concatBytes + ' bytes against the archive\'s ' + check.archiveBytes
      : 'the concatenation hashes ' + check.concatSha256 + ' against the archive\'s ' + check.archiveSha256;
    throw new Error('the split does not verify: ' + why);
  }
  return { parts: written, check };
}
