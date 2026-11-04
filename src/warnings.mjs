#!/usr/bin/env node
'use strict';
/**
 * Cross-analyse the warnings the parser emits, over any set of parse outputs.
 *
 *   node src/warnings.mjs [--dir <dir>]... [--labelled <label=dir>]... [--md]
 *                         [--json <file>] [--min <n>] [--top <n>] [--reparse]
 *
 * Every warning is recomputed through the same playerWarnings()/getMeta() pair
 * the site renders, so this reads the parser's own verdict and never a copy of
 * it. A parse output is whatever parse.mjs writes - { event, count, players } -
 * one file per event, in archive/events or anywhere a scan kept one.
 *
 * The point is the spread. A warning on one army is that player's submission;
 * the same warning across events, or concentrated in one exporter, is the
 * parser reading a shape it was never taught. The report keeps the two apart by
 * naming the number of events and exporters behind every repeated signature,
 * and by showing each exporter's warning rate against the pool.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getMeta, playerWarnings, totals, armyBudget, realUnits, detectExporter, parseListText } from './parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const WARNING_TYPES = ['unrecognized', 'mismatch', 'over-budget', 'missing-total', 'detachment', 'disposition'];

function parseArgs(argv) {
  const o = { dirs: [], md: false, json: null, min: 3, top: 25, since: null, reparse: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') o.dirs.push({ label: null, dir: argv[++i] });
    else if (a.startsWith('--dir=')) o.dirs.push({ label: null, dir: a.slice(6) });
    else if (a === '--labelled') {
      const v = String(argv[++i] || '');
      const i2 = v.indexOf('=');
      o.dirs.push({ label: i2 < 0 ? null : v.slice(0, i2), dir: i2 < 0 ? v : v.slice(i2 + 1) });
    } else if (a === '--md') o.md = true;
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--min') o.min = Number(argv[++i]) || 0;
    else if (a === '--top') o.top = Number(argv[++i]) || 0;
    else if (a === '--reparse') o.reparse = true;
    else if (a === '--since') o.since = argv[++i];
    else if (a.startsWith('--since=')) o.since = a.slice(8);
    else { console.error('unknown flag: ' + a); process.exit(2); }
  }
  if (!o.dirs.length) o.dirs.push({ label: 'archive', dir: path.join(__dirname, '..', 'archive', 'events') });
  return o;
}

function filesIn(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesIn(p));
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

// Squash the numbers so two occurrences of the same complaint land in one
// bucket: "declared 2000, parsed 1995 (+-5)" and "... (+-40)" are one warning
// with different arithmetic, and the arithmetic is kept separately as a delta.
export function signature(text) {
  return String(text)
    .replace(/[\u26a0\ufe0f]/g, '')
    .replace(/[+-]?\d+(?:[.,]\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

// Every army in every parse output, with the parser's own verdict attached.
//
// `since` drops events dated before it. The archive keeps a year and a year
// spans two editions, and the two do not have the same warnings to give: a
// 10th-edition list has no Force Disposition to declare, so its warning is a
// fact about the edition, not about the parser. Measure the current one.
// A stored parse carries the units the parser read when the event was archived,
// so a parser fix changes nothing here until the text is read again. --reparse
// does that: every army is rebuilt from its own body text by the current
// parser, which is what makes an archived fix measurable without re-harvesting.
function reparse(p) {
  if (!p || !p.bodyText) return p;
  try {
    const out = parseListText(String(p.bodyText), { name: p.name || 'x' });
    return (out && out.output && out.output.players && out.output.players[0]) || p;
  } catch {
    return p;
  }
}

export function readArmies(dirs, { since = null, reparseArmies = false } = {}) {
  const events = [];
  const armies = [];
  for (const { label, dir } of dirs) {
    if (!dir) continue;
    for (const file of filesIn(dir)) {
      let out;
      try { out = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (!out || !Array.isArray(out.players)) continue;
      const when = (out.event && out.event.date) || null;
      if (since && !(when && when >= since)) continue;
      const key = path.basename(file).replace(/\.json$/, '');
      const ev = {
        key,
        file,
        label: label || null,
        name: (out.event && out.event.name) || key,
        date: (out.event && out.event.date) || null,
        armies: out.players.length,
        warnings: 0,
      };
      for (const stored of out.players) {
        // Read the exporter off the stored text either way: a reparsed army's
        // bodyText is its slice, and a slice can lose the signature at the
        // bottom that named the tool.
        const body = stored.bodyText || stored.bodyRest || '';
        const p = reparseArmies ? reparse(stored) : stored;
        const meta = getMeta(p);
        const ws = playerWarnings(p, meta);
        const ex = detectExporter(body);
        const t = totals(p);
        const row = {
          file,
          label: ev.label,
          eventKey: key,
          eventName: ev.name,
          date: ev.date,
          player: p.name || null,
          faction: p.faction || null,
          team: meta.teamName || p.teamName || null,
          exporter: ex.id,
          exporterBasis: ex.basis,
          exporterSignature: ex.signature || null,
          units: realUnits(p).length,
          declared: t.declaredPts,
          parsed: t.parsedPts,
          budget: armyBudget(p),
          warnings: ws.map(w => ({
            type: w.type,
            text: w.text,
            signature: signature(w.text),
            delta: w.type === 'mismatch' && t.declaredPts != null
              ? t.parsedPts - t.declaredPts
              : (w.type === 'over-budget' ? t.parsedPts - (t.declaredPts != null ? t.declaredPts : t.parsedPts) : null),
          })),
        };
        if (ws.length) ev.warnings += ws.length;
        armies.push(row);
      }
      events.push(ev);
    }
  }
  return { events, armies };
}

function fmtPct(n, d) { return d ? (100 * n / d).toFixed(1) + '%' : '-'; }
function per100(n, d) { return d ? (100 * n / d).toFixed(1) : '-'; }

// Every warning as a flat instance, for the JSON record.
export function instancesOf(armies) {
  const out = [];
  for (const a of armies) {
    for (const w of a.warnings) {
      out.push({
        source: a.label,
        eventKey: a.eventKey,
        eventName: a.eventName,
        date: a.date,
        player: a.player,
        faction: a.faction,
        exporter: a.exporter,
        exporterBasis: a.exporterBasis,
        units: a.units,
        declared: a.declared,
        parsed: a.parsed,
        budget: a.budget,
        type: w.type,
        text: w.text,
        signature: w.signature,
        delta: w.delta,
      });
    }
  }
  return out;
}

export function summarise(events, armies) {
  const instances = instancesOf(armies);
  const byType = new Map();
  for (const w of instances) byType.set(w.type, (byType.get(w.type) || 0) + 1);

  // Per exporter: armies, armies that warned at all, and the breakdown. An
  // exporter whose lists warn far more often than the pool is where a parser
  // bug hides.
  const byExporter = new Map();
  for (const a of armies) {
    if (!byExporter.has(a.exporter)) byExporter.set(a.exporter, { armies: 0, warned: 0, types: new Map() });
    const x = byExporter.get(a.exporter);
    x.armies++;
    if (a.warnings.length) x.warned++;
    for (const w of a.warnings) x.types.set(w.type, (x.types.get(w.type) || 0) + 1);
  }

  // Signatures: one bucket per distinct complaint, with its spread.
  const bySignature = new Map();
  for (const w of instances) {
    const k = w.type + ' :: ' + w.signature;
    if (!bySignature.has(k)) bySignature.set(k, { type: w.type, signature: w.signature, count: 0, events: new Set(), exporters: new Set(), deltas: new Map(), samples: [] });
    const b = bySignature.get(k);
    b.count++;
    b.events.add(w.eventKey);
    b.exporters.add(w.exporter);
    if (w.delta != null) b.deltas.set(w.delta, (b.deltas.get(w.delta) || 0) + 1);
    if (b.samples.length < 3) b.samples.push((w.date || '') + ' ' + w.eventName + ' / ' + (w.player || '?'));
  }

  const byEvent = events.filter(e => e.warnings).sort((a, b) => b.warnings - a.warnings);
  const total = armies.length;
  return { events, armies: total, instances, byType, byExporter, bySignature, byEvent };
}

export function report(s, o = {}) {
  o = { min: 3, top: 25, ...o };
  const L = [];
  L.push('# Parser warnings');
  L.push('');
  L.push(s.events.length + ' events, ' + s.armies + ' armies, ' + s.instances.length + ' warnings (' +
    fmtPct(s.instances.length, s.armies) + ' of armies)');
  L.push('');
  L.push('| warning | count | share of warnings | per 100 armies |');
  L.push('|---|---:|---:|---:|');
  for (const t of WARNING_TYPES) {
    const n = s.byType.get(t) || 0;
    if (!n) continue;
    L.push('| ' + t + ' | ' + n + ' | ' + fmtPct(n, s.instances.length) + ' | ' + per100(n, s.armies) + ' |');
  }
  L.push('');
  L.push('## By exporter');
  L.push('');
  L.push('| exporter | armies | warned | warnings | per 100 armies | types |');
  L.push('|---|---:|---:|---:|---:|---|');
  for (const [id, x] of [...s.byExporter.entries()].sort((a, b) => b[1].armies - a[1].armies)) {
    const n = [...x.types.values()].reduce((a, b) => a + b, 0);
    const types = [...x.types.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => t + ' ' + c).join(', ');
    L.push('| ' + id + ' | ' + x.armies + ' | ' + x.warned + ' | ' + n + ' | ' + per100(n, x.armies) + ' | ' + types + ' |');
  }
  L.push('');
  L.push('## Repeated signatures');
  L.push('');
  L.push('Below the threshold a signature is one army and one player; at or above it, look at the events and exporters columns.');
  L.push('');
  L.push('| type | signature | n | events | exporters | deltas |');
  L.push('|---|---|---:|---:|---:|---|');
  const sigs = [...s.bySignature.values()].sort((a, b) => b.count - a.count);
  for (const b of sigs) {
    if (b.count < o.min) continue;
    const deltas = [...b.deltas.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 8).map(([d, c]) => d + '\u00d7' + c).join(' ');
    L.push('| ' + b.type + ' | ' + b.signature + ' | ' + b.count + ' | ' + b.events.size + ' | ' + b.exporters.size + ' | ' + deltas + ' |');
  }
  const single = sigs.filter(b => b.count < o.min);
  L.push('');
  L.push(single.reduce((a, b) => a + b.count, 0) + ' warning(s) across ' + single.length + ' signature(s) below the repeat threshold of ' + o.min + '.');
  L.push('');
  L.push('## Events with the most warnings');
  L.push('');
  L.push('| date | event | armies | warnings | per army |');
  L.push('|---|---|---:|---:|---:|');
  for (const e of s.byEvent.slice(0, o.top)) {
    L.push('| ' + (e.date || '') + ' | ' + e.name + ' | ' + e.armies + ' | ' + e.warnings + ' | ' + (e.warnings / e.armies).toFixed(2) + ' |');
  }
  return L.join('\n') + '\n';
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const { events, armies } = readArmies(o.dirs, { since: o.since, reparseArmies: o.reparse });
  const s = summarise(events, armies);
  console.log(report(s, o));
  if (o.json) {
    fs.mkdirSync(path.dirname(o.json), { recursive: true });
    fs.writeFileSync(o.json, JSON.stringify({
      at: new Date().toISOString(),
      dirs: o.dirs,
      since: o.since,
      events: s.events,
      summary: { events: events.length, armies: s.armies, warnings: s.instances.length, since: o.since, byType: Object.fromEntries(s.byType) },
      instances: s.instances,
    }, null, 2) + '\n');
    console.error('Wrote ' + o.json);
  }
}

const IS_MAIN = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] || '').href; }
  catch { return false; }
})();

if (IS_MAIN) main().catch(e => { console.error((e && e.stack) || e); process.exit(1); });
