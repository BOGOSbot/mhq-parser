#!/usr/bin/env node
'use strict';
/**
 * Cross-analyse the source formats in the archive.
 *
 *   node formats.mjs [--dir <archive dir>] [--md] [--unknown <n>]
 *
 * Every archived list is signed by whatever tool produced it - or is not. This
 * walks the archive, asks parse.mjs's detectExporter() what wrote each list, and
 * reports the spread: which exporter, how it was recognised, and what the
 * unrecognised remainder is made of.
 *
 * It reads archive/events/<file>.json, the same files the server serves. The
 * exporter is recomputed here rather than read off the file, so a running
 * archive harvested by an older parser still reports current answers.
 *
 * --md writes the report as Markdown instead of aligned text, for pasting into
 * a doc. formats.md is the write-up; this is the numbers behind it.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectExporter } from './parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = { dir: path.join(__dirname, 'archive'), md: false, unknown: 12 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--md') o.md = true;
    else if (a === '--dir') o.dir = argv[++i];
    else if (a.startsWith('--dir=')) o.dir = a.slice(6);
    else if (a === '--unknown') o.unknown = Number(argv[++i]) || 12;
    else { console.error('unknown flag: ' + a); process.exit(2); }
  }
  return o;
}

// Every list in the archive, with its exporter and the basis that gave it.
function collect(dir) {
  const eventsDir = path.join(dir, 'events');
  let files = [];
  try { files = fs.readdirSync(eventsDir).filter(f => f.endsWith('.json')); }
  catch { throw new Error('no archive at ' + eventsDir + ' - run archive.mjs first'); }
  const rows = [];
  let events = 0;
  for (const f of files) {
    let out;
    try { out = JSON.parse(fs.readFileSync(path.join(eventsDir, f), 'utf8')); } catch { continue; }
    events++;
    const year = (out.event && out.event.date || '').slice(0, 4) || '?';
    for (const p of (out.players || [])) {
      const body = String(p.bodyText || '').replace(/\r\n?/g, '\n');
      const ex = detectExporter(body);
      const lines = body.split('\n');
      let last = '';
      for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) { last = lines[i].trim(); break; } }
      rows.push({ f, year, exporter: ex.id, basis: ex.basis, version: ex.version, language: ex.language, signature: ex.signature || last, body, last, strategy: p.format, units: (p.units || []).length });
    }
  }
  return { events, rows };
}

function tally(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = key(r); m.set(k, (m.get(k) || 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1]);
}
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '0%';

function report({ events, rows }, opts) {
  const N = rows.length;
  const out = [];
  const P = s => out.push(s);
  if (opts.md) {
    P('# Source formats in the archive');
    P('');
    P(events + ' events, ' + N + ' lists.');
    P('');
    P('## Exporter');
    P('');
    P('| exporter | lists | share | via signature | via structure |');
    P('|---|---:|---:|---:|---:|');
    for (const [id, n] of tally(rows, r => r.exporter)) {
      const sig = rows.filter(r => r.exporter === id && (r.basis === 'trailer' || r.basis === 'signature')).length;
      P('| ' + id + ' | ' + n + ' | ' + pct(n, N) + ' | ' + sig + ' | ' + (n - sig) + ' |');
    }
    P('');
    P('## Recognised by');
    P('');
    for (const [k, v] of tally(rows, r => r.basis || '(none)')) P('- ' + k + ': ' + v + ' (' + pct(v, N) + ')');
    P('');
    P('## Signatures');
    P('');
    P('| lists | exporter | version | basis | line |');
    P('|---:|---|---|---|---|');
    const sigs = new Map();
    for (const r of rows) {
      if (r.basis !== 'trailer' && r.basis !== 'signature') continue;
      const norm = r.signature.replace(/\d+(?:\.\d+)*/g, '#');
      if (!sigs.has(norm)) sigs.set(norm, { n: 0, ex: r.signature, id: r.exporter, ver: r.version, basis: r.basis });
      sigs.get(norm).n++;
    }
    for (const [, v] of [...sigs].sort((a, b) => b[1].n - a[1].n)) {
      P('| ' + v.n + ' | ' + v.id + ' | ' + (v.ver || '') + ' | ' + v.basis + ' | `' + v.ex + '` |');
    }
    P('');
    P('## By event year');
    P('');
    const ids = tally(rows, r => r.exporter).map(x => x[0]);
    const years = [...new Set(rows.map(r => r.year))].sort();
    P('| year | ' + ids.join(' | ') + ' | lists |');
    P('|---|' + ids.map(() => '---:').join('|') + '|---:|');
    for (const y of years) {
      const yr = rows.filter(r => r.year === y);
      P('| ' + y + ' | ' + ids.map(id => yr.filter(r => r.exporter === id).length).join(' | ') + ' | ' + yr.length + ' |');
    }
    P('');
    P('## Unrecognised remainder');
    P('');
    P('| lists | shape |');
    P('|---:|---|');
    for (const [s, v] of unknownShapes(rows, opts.unknown)) P('| ' + v + ' | `' + s + '` |');
    P('');
  } else {
    const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n - 1) + '\u2026' : s + ' '.repeat(n - s.length); };
    P(events + ' events, ' + N + ' lists');
    P('');
    P(pad('exporter', 16) + pad('lists', 8) + pad('share', 8) + pad('signed', 8) + 'structural');
    for (const [id, n] of tally(rows, r => r.exporter)) {
      const sig = rows.filter(r => r.exporter === id && (r.basis === 'trailer' || r.basis === 'signature')).length;
      P(pad(id, 16) + pad(n, 8) + pad(pct(n, N), 8) + pad(sig, 8) + (n - sig));
    }
    P('');
    P('recognised by: ' + tally(rows, r => r.basis || 'none').map(([k, v]) => k + ' ' + v).join(', '));
    P('');
    P('by event year');
    const ids = tally(rows, r => r.exporter).map(x => x[0]);
    const years = [...new Set(rows.map(r => r.year))].sort();
    P('  ' + pad('year', 8) + ids.map(id => pad(id, 14)).join(''));
    for (const y of years) {
      const yr = rows.filter(r => r.year === y);
      P('  ' + pad(y, 8) + ids.map(id => pad(yr.filter(r => r.exporter === id).length, 14)).join(''));
    }
    P('');
    P('unrecognised remainder (' + rows.filter(r => r.exporter === 'unknown').length + ' lists)');
    for (const [s, v] of unknownShapes(rows, opts.unknown)) P('  ' + pad(v, 6) + s);
  }
  return out.join('\n');
}

// The unknown lists grouped by what they actually look like, most common first.
function unknownShapes(rows, limit) {
  const unk = rows.filter(r => r.exporter === 'unknown');
  const shapes = new Map();
  for (const r of unk) {
    const head = (r.body.split('\n').map(s => s.trim()).filter(Boolean)[0] || '(empty)').slice(0, 46);
    const units = r.units < 2 ? 'unparsed' : r.units + ' units';
    const pts = /\([^)]*\d\s*(?:pts?|points?)\)/i.test(r.body) ? 'pts' : 'no pts';
    const bullets = /^[\u2022\u25e6]/m.test(r.body) ? 'bullets' : 'no bullets';
    const key = units + ' | ' + pts + ' | ' + bullets + ' | ' + head;
    shapes.set(key, (shapes.get(key) || 0) + 1);
  }
  return [...shapes].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, n]) => [k.replace(/`/g, ''), n]);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  console.log(report(collect(o.dir), o));
}

const IS_MAIN = (() => {
  try { return import.meta.url === new URL('file://' + process.argv[1].replace(/\\/g, '/')).href; }
  catch { return false; }
})();

if (IS_MAIN) {
  try { main(); } catch (e) { console.error(String((e && e.message) || e)); process.exit(1); }
}
