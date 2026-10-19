#!/usr/bin/env node
'use strict';
/**
 * The glossary coverage sweep (task-21).
 *
 * The voice benchmark found names the glossary could not repair, and the
 * glossary is the accuracy lever, so the gaps are measured rather than guessed
 * at. This builds the corpus vocabulary the note describes - the Wahapedia
 * tables' names plus the distinctive words INSIDE multi-word names - and sweeps
 * it against the generated glossary.
 *
 *   node tests/glossary-coverage.mjs                 # the 12k vocabulary sweep
 *   node tests/glossary-coverage.mjs --terms <file>  # a tested term set; exits 1 on a miss
 *
 * Coverage is word-level: 'Agamatus' is covered by 'Agamatus Custodians', and
 * apostrophes/accents are folded before comparison (the MFM writes T'AU EMPIRE
 * with a curly apostrophe; a recogniser writes T'au).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { csvRows, csvDir } from '../src/rules-corpus.mjs';
import { coverageReport, foldName } from '../src/glossary.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// --glossary <file> measures another build (the before/after of a coverage fix).
const argv0 = process.argv.slice(2);
const at0 = argv0.indexOf('--glossary');
const GLOSSARY = JSON.parse(fs.readFileSync(at0 === -1 ? path.join(ROOT, 'src', 'glossary-fr-en.json') : path.resolve(argv0[at0 + 1]), 'utf8'));

// The tables the note names, and the count it reported from them.
const SOURCES = [
  { file: 'Datasheets.csv', label: 'datasheets' },
  { file: 'Datasheets_wargear.csv', label: 'weapons' },
  { file: 'Stratagems.csv', label: 'stratagems' },
  { file: 'Enhancements.csv', label: 'enhancements' },
  { file: 'Factions.csv', label: 'factions' },
];

const rowsOf = file => {
  try { return csvRows(fs.readFileSync(path.join(csvDir(), file), 'utf8')); } catch { return []; }
};
const clean = s => String(s == null ? '' : s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const wordsIn = name => foldName(name).split(/[^a-z0-9']+/).filter(w => w.length >= 3);

export function vocabulary() {
  const names = new Map(); // folded name -> display name
  const words = new Map();
  const bySource = {};
  for (const src of SOURCES) {
    const got = new Set();
    for (const row of rowsOf(src.file)) {
      const name = clean(row.name);
      if (!name || name.length < 3) continue;
      const f = foldName(name);
      if (got.has(f)) continue;
      got.add(f);
      names.set(f, name);
      for (const w of wordsIn(name)) if (!words.has(w)) words.set(w, w);
    }
    bySource[src.label] = got.size;
  }
  const nameList = Array.from(names.values());
  const wordList = Array.from(words.values()).filter(w => !names.has(w));
  return { names: nameList, words: wordList, bySource };
}

function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--terms');
  if (at !== -1) {
    const file = path.resolve(argv[at + 1] || '');
    const terms = JSON.parse(fs.readFileSync(file, 'utf8')).map(t => t.en || t.id || t);
    const report = coverageReport(terms, GLOSSARY);
    console.log('tested terms ' + report.total + '  covered ' + report.covered + '  missing ' + report.missing.length);
    for (const m of report.missing) console.log('  MISSING ' + m.name + '  (no glossary word for: ' + m.absent.join(', ') + ')');
    process.exitCode = report.missing.length ? 1 : 0;
    return;
  }
  const v = vocabulary();
  const all = v.names.concat(v.words);
  const report = coverageReport(all, GLOSSARY);
  console.log('');
  console.log('glossary entries ' + GLOSSARY.entries.length + ' from ' + GLOSSARY.pairs.length + ' faction pairs');
  console.log('vocabulary by source: ' + Object.entries(v.bySource).map(([k, n]) => k + ' ' + n).join(', '));
  console.log('vocabulary ' + all.length + ' entries (' + v.names.length + ' names + ' + v.words.length + ' words inside names)');
  console.log('covered ' + report.covered + '  missing ' + report.missing.length + '  (' + Math.round(1000 * report.missing.length / all.length) / 10 + '%)');
  const notable = report.missing.slice(0, 60);
  if (notable.length) {
    console.log('');
    console.log('notable missing names (first ' + notable.length + '):');
    for (const m of notable) console.log('  ' + m.name + '  (absent: ' + m.absent.join(', ') + ')');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(String((e && e.message) || e)); process.exitCode = 1; }
}
