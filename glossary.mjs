#!/usr/bin/env node
'use strict';
/**
 * FR/EN glossary, built from a parallel source.
 *
 *   node glossary.mjs --build      write glossary-fr-en.json + .md
 *   node glossary.mjs --stats      what is in the built glossary
 *
 * The Munitorum Field Manual is published in both languages at
 * mfm.warhammer-community.com/{en,fr}/<faction>, with the same structure: the
 * same units in the same order, the same detachments, the same enhancements.
 * That parallelism is the whole point - it means a translation can be read off
 * a line pair instead of guessed, and the repo already caches both languages
 * under .verify-ref/ for the points cross-check.
 *
 * Pairing is by position, which is safe for the 17 faction pairs whose two
 * files have the same line count. The other five differ by a few lines (a
 * Legends entry on one side), so they are aligned by longest common
 * subsequence first: identical lines - the unit names GW does not translate,
 * the "pts" rows, the section markers - anchor the diff, and the runs between
 * anchors are paired in order.
 *
 * What this source cannot give: keywords, stratagems and rules-section names.
 * Those are not in the MFM, and a glossary that invents them would be worse
 * than one that says so. They are reported as unsourced rather than filled in
 * from memory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REF_DIR = process.env.RULES_REF_DIR || path.join(__dirname, '.verify-ref');
export const OUT_JSON = path.join(__dirname, 'glossary-fr-en.json');
export const OUT_MD = path.join(__dirname, 'glossary-fr-en.md');

// Lines that look like a name but are furniture.
const SKIP = new Set([
  'UNITS', 'UNITÉS', 'FACTIONS', 'ENHANCEMENTS', 'OPTIMISATIONS', 'DETACHMENTS', 'DÉTACHEMENTS',
  'YOUR UNIT COSTS', 'VOTRE UNITÉ COÛTE', 'SHOW LEGENDS', 'MONTRER LES UNITÉS LEGENDS',
  'MUSTER ARMIES', 'RASSEMBLER LES ARMÉES', 'LEGENDS', '▼', '▲', 'DP', 'DPD',
]);

const DISPOSITIONS = new Set([
  'TAKE AND HOLD', 'PRENDRE ET TENIR', 'PRIORITY ASSETS', 'ATOUTS PRIORITAIRES',
  'DISRUPTION', 'PERTURBATION', 'PURGE THE FOE', 'ÉLIMINEZ L\'ADVERSAIRE',
  'RECONNAISSANCE', 'PREY IN AMBUSH', 'ATOUTS CACHÉS', 'PRÉDATEURS EMBUSQUÉS',
]);

const isUpperName = s => /^[A-Z0-9][A-Z0-9 ''’.\-:!\/&()]+$/.test(s) && /[A-Z]{3}/.test(s) && s.length > 2 && !SKIP.has(s) && !/^\d/.test(s);
const isPoints = s => /^(?:[▲▼]\s*)?\(?[-+]?\d+\)?\s*pts$/.test(s.trim()) || /^\d+\s*pts$/.test(s.trim());
const isDp = s => /^\d+\s*DPD?$/.test(s.trim());

// Longest common subsequence over trimmed lines, then pair the gaps in order.
// Only needed for the pairs whose line counts differ, but it is correct for the
// aligned ones too and costs nothing there.
export function alignLines(enLines, frLines) {
  const a = enLines.map(s => s.trim());
  const b = frLines.map(s => s.trim());
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > 200) return null;   // too far apart to pair honestly
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  let pendA = [], pendB = [];
  const flush = () => {
    const k = Math.min(pendA.length, pendB.length);
    for (let x = 0; x < k; x++) pairs.push([pendA[x] + 1, pendB[x] + 1]);
    pendA = []; pendB = [];
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      pairs.push([i + 1, j + 1]);
      i++; j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      pendA.push(i); i++;
    } else {
      pendB.push(j); j++;
    }
  }
  while (i < n) { pendA.push(i); i++; }
  while (j < m) { pendB.push(j); j++; }
  flush();
  return pairs;
}

// Walk the aligned pair and label what each line is, in the MFM's own order.
// A unit section runs from UNITS to DETACHMENTS; after that a name followed by
// NDP is a detachment, the line after the DP is its force disposition, and a
// title-cased line followed by a points row is an enhancement.
export function entriesFromPair(slug, enLines, frLines) {
  const pairs = alignLines(enLines, frLines);
  if (!pairs) return [];
  const en = i => (enLines[i - 1] || '').trim();
  const fr = i => (frLines[i - 1] || '').trim();
  const out = [];
  let section = 'header';
  for (let k = 0; k < pairs.length; k++) {
    const [ei, fi] = pairs[k];
    const E = en(ei), F = fr(fi);
    if (!E || !F) continue;
    if (/^(UNITS|UNITÉS)$/.test(E)) { section = 'unit'; continue; }
    if (/^(DETACHMENTS|DÉTACHEMENTS)$/.test(E)) { section = 'detachment'; continue; }
    if (/^(ENHANCEMENTS|OPTIMISATIONS)$/.test(E)) { section = 'enhancement'; continue; }
    if (isPoints(E) || isDp(E) || SKIP.has(E)) continue;
    if (DISPOSITIONS.has(E) || DISPOSITIONS.has(F)) {
      out.push({ category: 'force_disposition', en: E, fr: F, slug });
      continue;
    }
    const next = pairs[k + 1] ? en(pairs[k + 1][0]) : '';
    // A name followed by NDP is a detachment wherever it appears. Checking the
    // section first lost every detachment after the first ENHANCEMENTS marker -
    // the section had already flipped, so they were tested against the
    // enhancement rule and dropped.
    // Rows that describe a unit rather than name one: "1 model / 1 figurine",
    // "10 Gretchin". They sit between a unit name and its points and are not
    // terms anybody looks up.
    if (/^\+?\s*\d+\s+(model|models|figurine|figurines|Gretchin|Gretchins)\b/i.test(E)) continue;
    if (isUpperName(E) && isDp(next)) {
      out.push({ category: 'detachment', en: E, fr: F, slug });
    } else if (section === 'unit' && isUpperName(E)) {
      out.push({ category: 'datasheet', en: E, fr: F, slug });
    } else if (section === 'enhancement' && (isPoints(next) || F.endsWith('(Amélioration)') || E.endsWith('(Upgrade)'))) {
      out.push({ category: 'enhancement', en: E.replace(/\s*\(Upgrade\)$/, ''), fr: F.replace(/\s*\(Amélioration\)$/, ''), slug });
    }
  }
  return out;
}

// Rule text the MFM never publishes, so no parallel pair exists for it. Each
// entry below got here because a question failed without it, and the French
// wording was confirmed against the French rules before being recorded - a
// glossary that invents translations in bulk would be worse than none; two
// spellings read off actual usage are not that.
const RULE_TERMS = [
  // embarque(ment) -> embark(ing): the stem substring-matches the noun and the
  // verb alike. It cannot collide with débarque(ment) - the é of dé- blocks
  // the substring - but it DOES fire inside désembarque..., which contains
  // embarque whole. A disembark question therefore carries both terms; that is
  // tolerable because English 'disembark' contains 'embark' too, so both terms
  // score the same sections, and the exact Disembark term is what lifts the
  // right one. débarque(ment) is deliberately absent until a real question
  // shows the rules text uses it rather than désembarque-.
  { category: 'rule', en: 'Embark', fr: 'embarque' },
  { category: 'rule', en: 'Disembark', fr: 'désembarque' },
];

export function buildGlossary() {
  const files = fs.readdirSync(REF_DIR).filter(f => f.endsWith('.txt') && !f.includes('@fr'));
  const entries = [];
  const pairs = [];
  for (const f of files) {
    const slug = f.replace('.txt', '');
    const frPath = path.join(REF_DIR, slug + '@fr.txt');
    if (!fs.existsSync(frPath)) continue;
    const en = fs.readFileSync(path.join(REF_DIR, f), 'utf8').split(/\r?\n/);
    const fr = fs.readFileSync(frPath, 'utf8').split(/\r?\n/);
    const got = entriesFromPair(slug, en, fr);
    entries.push(...got);
    pairs.push({ slug, en: en.length, fr: fr.length, aligned: en.length === fr.length, entries: got.length });
  }
  // The faction name itself is the title line of each file.
  for (const f of files) {
    const slug = f.replace('.txt', '');
    const frPath = path.join(REF_DIR, slug + '@fr.txt');
    if (!fs.existsSync(frPath)) continue;
    const enLines = fs.readFileSync(path.join(REF_DIR, f), 'utf8').split(/\r?\n/).map(s => s.trim());
    const frLines = fs.readFileSync(frPath, 'utf8').split(/\r?\n/).map(s => s.trim());
    const title = i => {
      const at = enLines.findIndex((l, x) => l && l === l.toUpperCase() && /^[A-Z]{4,}/.test(l) && frLines[x] && frLines[x] === frLines[x].toUpperCase());
      return at;
    };
    // The faction title is the line directly above the version marker ("v1.5").
    // Matching the first uppercase line instead drifted onto a unit name in the
    // files whose title carries an apostrophe.
    const ver = enLines.findIndex(l => /^v\d+(\.\d+)?$/.test(l));
    if (ver > 0 && frLines[ver - 1] && enLines[ver - 1]) {
      entries.push({ category: 'faction', en: enLines[ver - 1], fr: frLines[ver - 1], slug });
    }
    void title;
  }
  // One entry per term pair, keeping the first faction that showed it. The
  // hand-set rule terms keep every spelling a reader would look up separately.
  const seen = new Map();
  for (const e of entries) {
    const key = e.category + '|' + e.en;
    if (!seen.has(key)) seen.set(key, e);
  }
  const ruleSeen = new Map();
  for (const e of RULE_TERMS) {
    const key = e.category + '|' + e.en + '|' + e.fr;
    if (!ruleSeen.has(key)) ruleSeen.set(key, e);
  }
  const list = Array.from(seen.values()).concat(Array.from(ruleSeen.values()))
    .sort((a, b) => a.category.localeCompare(b.category) || a.en.localeCompare(b.en) || a.fr.localeCompare(b.fr));
  const byCategory = {};
  for (const e of list) byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  return {
    generated: new Date().toISOString(),
    source: 'mfm.warhammer-community.com (en + fr), cached under .verify-ref/',
    note: "Parallel-source glossary. Keywords, stratagems and rules-section names are NOT covered by the MFM: the 'rule' category below carries the few of those a real question exposed, each read off the French rules text itself, not guessed.",
    pairs,
    counts: byCategory,
    entries: list,
  };
}

function toMarkdown(g) {
  const order = ['faction', 'force_disposition', 'detachment', 'datasheet', 'enhancement', 'rule'];
  const titles = {
    faction: 'Factions', force_disposition: 'Force dispositions', detachment: 'Detachments',
    datasheet: 'Datasheets / units', enhancement: 'Enhancements', rule: 'Rules (hand-set)',
  };
  const out = ['# Glossary FR / EN', '',
    'Built from the Munitorum Field Manual, published in both languages with the same structure.',
    'Generated ' + g.generated.slice(0, 10) + ' from ' + g.pairs.length + ' faction pairs.', '',
    '| category | entries |', '|---|---|'];
  for (const c of order) out.push('| ' + (titles[c] || c) + ' | ' + (g.counts[c] || 0) + ' |');
  out.push('', '> Keywords, stratagems and rules-section names are **not** covered: the MFM does not',
    '> publish them. They are left out rather than guessed.', '');
  for (const c of order) {
    const list = g.entries.filter(e => e.category === c);
    if (!list.length) continue;
    out.push('## ' + (titles[c] || c), '', '| English | Français |', '|---|---|');
    for (const e of list) out.push('| ' + e.en + ' | ' + e.fr + ' |');
    out.push('');
  }
  return out.join('\n');
}

export function printTable(rows) {
  const w = Math.max(...rows.map(r => r.term.length), 8);
  for (const r of rows) {
    const flag = r.verified ? 'verified' : 'UNVERIFIED';
    console.log('  ' + r.term.padEnd(w) + '  ->  ' + (r.translation || '(none)').padEnd(28) + r.route.padEnd(12) + flag);
    if (r.reason) console.log('  ' + ' '.repeat(w) + '      ' + r.reason);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const g = buildGlossary();
  if (argv.indexOf('--stats') !== -1) {
    console.log('pairs ' + g.pairs.length + ' | entries ' + g.entries.length);
    for (const c of Object.keys(g.counts)) console.log('  ' + c.padEnd(20) + g.counts[c]);
    return;
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify(g, null, 1));
  fs.writeFileSync(OUT_MD, toMarkdown(g));
  console.log('pairs ' + g.pairs.length + ' | entries ' + g.entries.length);
  for (const c of Object.keys(g.counts)) console.log('  ' + c.padEnd(20) + g.counts[c]);
  console.log('written ' + OUT_JSON);
  console.log('written ' + OUT_MD);
}

if (process.argv[1] && process.argv[1].endsWith('glossary.mjs')) {
  try { main(); } catch (e) { console.error(String((e && e.message) || e)); process.exitCode = 1; }
}

export default { buildGlossary, alignLines, entriesFromPair };
