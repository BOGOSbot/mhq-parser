#!/usr/bin/env node
'use strict';
/**
 * Parse the events that have NOT closed yet, and keep each parse beside a
 * manifest of what was checked.
 *
 *   node src/scan-open.mjs [--out-dir <dir>] [--concurrency 4]
 *
 * A closed event is archived and will not move again - that is why archive.mjs
 * stores it. An open one is the opposite: its lists are still being submitted,
 * so it is parsed afresh on every run and never archived, because a copy taken
 * today would freeze a page mid-submission. This is the same reason the site
 * declines its own cache for an event that has not been played (notYetPlayed()).
 *
 * The scan checks every event dated today or later: another game and "no lists
 * out yet" both cost one request to learn, and a failure is never recorded as
 * either, so the next run tries it again.
 *
 * Output, under --out-dir:
 *   <type>--<slug>.json   the parse output, exactly what /parse returns
 *   ../scan-manifest.json  one row per event checked, with its verdict
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllEvents, checkEvent, parseUrl } from './parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = { outDir: path.join(__dirname, '..', 'workspace', 'weekly', 'future-parses'), concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out-dir') o.outDir = argv[++i];
    else if (a.startsWith('--out-dir=')) o.outDir = a.slice(10);
    else if (a === '--concurrency') o.concurrency = Number(argv[++i]) || 4;
    else if (a.startsWith('--concurrency=')) o.concurrency = Number(a.slice(14)) || 4;
    else { console.error('unknown flag: ' + a); process.exit(2); }
  }
  return o;
}

function is40k(game) {
  return /warhammer\s*40/i.test(game || '');
}

// A slug is already URL-safe, but a key is about to become a filename.
function fileNameFor(type, slug) {
  return (type + '--' + slug).replace(/[^A-Za-z0-9._-]+/g, '-') + '.json';
}

export async function scanOpen({ outDir, concurrency = 4, log = m => process.stderr.write(m + '\n'), today } = {}) {
  const dir = outDir || path.join(__dirname, '..', 'workspace', 'weekly', 'future-parses');
  const t = today || new Date().toISOString().slice(0, 10);
  fs.mkdirSync(dir, { recursive: true });
  const all = await getAllEvents();
  const todo = all.filter(e => typeof e.date === 'string' && e.date >= t);
  log('sitemap ' + all.length + ', not closed ' + todo.length + ' (on or after ' + t + ')');

  const manifest = [];
  const queue = todo.slice();
  let n = 0;
  const worker = async () => {
    while (queue.length) {
      const ev = queue.shift();
      n++;
      const row = { key: ev.type + '/' + ev.slug, date: ev.date, name: ev.name, status: 'failed' };
      try {
        const check = await checkEvent(ev.detailsUrl);
        row.game = check.game || null;
        row.hasLists = !!check.hasLists;
        if (!is40k(check.game)) row.status = 'not-40k';
        else if (!check.hasLists) row.status = 'no-lists';
        else {
          const { output } = await parseUrl(ev.url);
          row.listCount = output.count;
          const body = JSON.stringify(output);
          fs.writeFileSync(path.join(dir, fileNameFor(ev.type, ev.slug)), body);
          row.status = 'parsed';
          row.bytes = Buffer.byteLength(body);
        }
      } catch (e) {
        // A failure says nothing about the event, so it is left unparsed and
        // the next run retries it rather than recording a verdict.
        row.error = String((e && e.message) || e);
      }
      manifest.push(row);
      log('[' + n + '/' + todo.length + '] ' + ev.date + '  ' + row.status.padEnd(8) + '  ' + ev.name);
      await new Promise(r => setTimeout(r, 150));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  manifest.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const summary = {};
  for (const m of manifest) summary[m.status] = (summary[m.status] || 0) + 1;
  fs.writeFileSync(path.join(dir, '..', 'scan-manifest.json'), JSON.stringify({ at: new Date().toISOString(), today: t, summary, manifest }, null, 2) + '\n');
  log('checked ' + manifest.length + ': ' + JSON.stringify(summary));
  return { dir, manifest, summary };
}

const IS_MAIN = (() => {
  try { return import.meta.url === new URL('file://' + process.argv[1].replace(/\\/g, '/')).href; }
  catch { return false; }
})();

if (IS_MAIN) {
  scanOpen(parseArgs(process.argv.slice(2))).catch(e => { console.error((e && e.stack) || e); process.exit(1); });
}
