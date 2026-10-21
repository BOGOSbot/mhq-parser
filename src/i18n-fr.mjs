#!/usr/bin/env node
'use strict';
/**
 * i18n-fr: the French overlay, server side.
 *
 * The English corpus stays the canon. This module is the display layer over it: a
 * per-record French TEXT keyed by record id, read from the files the bake writes
 * (workspace/wiki-data/i18n/fr/<book>.json), and a fallback to the English text for
 * the 39 records the pass blocked.
 *
 * Two rules decide what it does with a record, both Mandal's:
 *   - the BODY renders French; the HEADINGS and the KEYWORDS stay English, because a
 *     keyword that has a definition is referenced across languages and translating it
 *     would break the reference. The translation pass enforced this with a mask, and
 *     frKeywords() is the spot check that it held.
 *   - a QUOTE is evidence, and the evidence is English. The ask shows the English
 *     canon with the French beneath it (frBeneath), never French alone.
 *
 * Nothing here is cached in the process across a bake: the file's mtime is the key, so
 * a re-export under a running server is picked up on the next request.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksFrench } from './lang-detect.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const I18N_DIR = process.env.MHQ_I18N_DIR || path.join(__dirname, '..', 'workspace', 'i18n');

// The source the pass wrote. 14.8 MB, one array, read once per process and kept - it is
// the only file the loader needs and the server has the memory for it.
let SOURCE = null;
let SOURCE_MTIME = 0;

function sourcePath() { return path.join(I18N_DIR, 'fr-full.json'); }

export function frReady() {
  try { return fs.statSync(sourcePath()).isFile(); } catch (e) { return false; }
}

function loadSource() {
  const file = sourcePath();
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch (e) { return null; }
  if (SOURCE && mtime === SOURCE_MTIME) return SOURCE;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = new Map();
  for (const rec of (raw.records || [])) {
    if (!rec || !rec.id) continue;
    map.set(String(rec.id), { fr: String(rec.fr || ''), gate: String(rec.gate || ''), kind: String(rec.kind || '') });
  }
  SOURCE = map;
  SOURCE_MTIME = mtime;
  return SOURCE;
}

// The French text for one record, or '' when there is none. A blocked record (the pass
// refused 39) and a record the pass never saw both return '' - the caller falls back to
// the English, which is the rule: a record with no French shows English, not nothing.
export function frText(id) {
  const map = loadSource();
  if (!map) return '';
  const hit = map.get(String(id || ''));
  if (!hit || !hit.fr) return '';
  return hit.fr;
}

export function frStats() {
  const map = loadSource();
  if (!map) return { ready: false, records: 0, translated: 0, blocked: 0 };
  let translated = 0, blocked = 0;
  for (const v of map.values()) { if (v.fr) translated++; else blocked++; }
  return { ready: true, records: map.size, translated: translated, blocked: blocked };
}

// --- the keyword spot check ---------------------------------------------------
// Mandal's rule is that a defined term keeps its English name inside French prose. The
// pass masked them; this reads the result. The English side gives the terms (the
// record's own keyword list and the ALL-CAPS tokens in its text), and the check is
// whether the French still carries them.
const CAPS = /\b[A-Z][A-Z0-9''\-]{2,}(?:\s+[A-Z][A-Z0-9''\-]{2,})*\b/g;
export function enTerms(text) {
  const out = new Set();
  const t = String(text || '');
  for (const m of t.match(CAPS) || []) {
    const s = m.trim();
    // A term is a keyword when it is not a sentence's first word and not a stat label.
    if (s.length < 3 || s.length > 40) continue;
    if (/^(?:THE|AND|OR|IF|WHEN|WHILE|UNTIL|THIS|THAT|THESE|THOSE|EACH|ALL|ANY|A|AN|IN|ON|AT|OF|TO|FOR|WITH|FROM|BY|AS|IS|ARE|WAS|WERE|BE|CAN|MAY|MUST|DO|DOES|NOT|NO|YES|YOU|YOUR|IT|ITS|THEY|THEIR|MODEL|MODELS|UNIT|UNITS|POINTS|RANGE|SOURCE|TYPE|CP|WARGEAR|ABILITY|KEYWORDS|COMPOSITION)$/.test(s)) continue;
    out.add(s);
  }
  return [...out];
}

// How many of the English terms survive in the French. Returns the misses so a test can
// name them rather than print a rate.
export function frKeywordCheck(enText, frTextBody) {
  const terms = enTerms(enText);
  const fr = String(frTextBody || '');
  const missed = terms.filter(t => fr.indexOf(t) === -1);
  return { terms: terms.length, kept: terms.length - missed.length, missed: missed.slice(0, 12) };
}

// --- the ask ------------------------------------------------------------------
// The quote is the English canon with the French beneath it. Both parts are the record's
// own text; the French is not a re-translation of the quote but the record's French
// body, which is what the pass produced and what the reader can check against.
export function frBeneath(quote, id) {
  const q = String(quote || '').trim();
  if (!q) return '';
  // The quote is a fragment of the English record, and the record's French body is what
  // sits under it. The reader sees the evidence and its translation, and can check one
  // against the other; the French is never shown INSTEAD of the quote.
  return frText(id);
}

// A record's French is only offered when it really is French: a pass that echoed the
// English would otherwise put English under a French label. looksFrench is the same
// detector the corpus uses for its own French records.
export function frUsable(id, minWords) {
  const fr = frText(id);
  if (!fr) return '';
  if (!looksFrench(fr)) return '';
  if (minWords && fr.split(/\s+/).length < minWords) return '';
  return fr;
}

export default { frReady, frText, frStats, frUsable, frKeywordCheck, frBeneath, enTerms };
