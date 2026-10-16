#!/usr/bin/env node
'use strict';
/**
 * box-snapshot: the off-disk recovery point for the corpus, as a recipe rather than
 * a memory.
 *
 *   node src/box-snapshot.mjs            # tar + sha256, then the box steps to run
 *   node src/box-snapshot.mjs --print    # only print the recipe
 *
 * The corpus is third-party material: the archive lives under workspace/ and is
 * never committed. The Box side is a few commands and about two minutes; the trap
 * is that `box snapshot list` needs a box selected, so once the box is deleted the
 * snapshot id is the ONLY handle on the recovery point and has to be written down
 * (docs/corpus-storage.md keeps it).
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { corpusDir } from './rules-corpus.mjs';
const CORPUS = corpusDir();
const OUT = path.join('workspace', 'box-snapshot');
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const archive = path.join(OUT, 'rules-corpus-' + stamp + '.tar.gz');

const recipe = [
  '1. box create --name corpus-snapshot --ttl 1h      (a small box, deleted after)',
  '2. box upload <box> ' + archive,
  '3. box snapshot create <box> --name ' + path.basename(archive),
  '4. box snapshot list <box>      WRITE THE SNAPSHOT ID DOWN - it is the only',
  '                                handle on the recovery point once the box is gone',
  '5. box delete <box>',
  '6. restore: new box, upload the snapshot, sha256sum the file inside it and',
  '   compare with the hash printed below - verified, not assumed',
  '7. box delete <box>             (no box is left running)',
].join('\n');

if (!process.argv.includes('--print')) {
  if (!fs.existsSync(CORPUS)) { console.error('no corpus at ' + CORPUS); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  execFileSync('tar', ['-czf', archive, '-C', path.dirname(CORPUS), path.basename(CORPUS)]);
  const bytes = fs.readFileSync(archive);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  console.log('archive  ' + archive);
  console.log('  bytes  ' + bytes.length + '  (' + (bytes.length / 1048576).toFixed(2) + ' MB)');
  console.log('  sha256 ' + sha);
  console.log('  write both into docs/corpus-storage.md with the snapshot id.');
}
console.log('');
console.log('Box recipe:');
console.log(recipe);