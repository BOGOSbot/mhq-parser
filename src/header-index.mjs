#!/usr/bin/env node
'use strict';
/**
 * The header index: the SERVER'S WIRING around the shared matcher.
 *
 * task-97: the matcher itself (the projection, the match, the row shape) lives in
 * src/search-core.mjs, which is also what the local web bundle ships as search/search.js. This
 * file keeps what only the server needs - the corpus read, the two French tables built from the
 * glossary and the keyword vocabulary, the phonetic leg's cache - and re-exports the matcher so
 * the route's imports do not change.
 *
 * Before this, the repo held two copies with the same bodies: the route ran this file's copy and
 * the bundle shipped the other, so 'one implementation, two callers' was not true of the code.
 */
import { readAllCorpus, termPresent } from './rules-corpus.mjs';
import { KEYWORDS, glossaryIndex } from './translate-fr-en.mjs';
import { buildPhoneticIndex, phoneticMatches } from './phonetic.mjs';
import {
  foldWords, contentWords, translationTables, translateLookupWords, lookupIntent, isTitleLike,
  normalizePhrase, cleanMarker, buildHeaderIndex, searchHeadings as coreSearch,
  termPresent as coreTermPresent, unitKey, foldUnitRows, findRows as coreFindRows, kindRank, rankCmp,
} from './search-core.mjs';

export {
  contentWords, translateLookupWords, lookupIntent, isTitleLike, normalizePhrase, cleanMarker,
  buildHeaderIndex, unitKey, foldUnitRows, kindRank, rankCmp,
};
// findRows is defined below, through this file's own wiring, so a caller that passes no options
// still gets the server's vocabulary and phonetic leg.

// The two mechanical tables, built once from the glossary and the keyword vocabulary. They are
// DATA to the matcher, which is what lets the browser ship them and run the same code.
let TABLES = null;
function tables() {
  if (!TABLES) {
    const glossary = [];
    for (const [fr, e] of glossaryIndex().frToEn) if (e && e.en) glossary.push([fr, e.en]);
    TABLES = translationTables({ keywords: KEYWORDS, glossary });
  }
  return TABLES;
}

let INDEX = null;
export function headerIndex(records) {
  if (records) return buildHeaderIndex(records);
  if (!INDEX) INDEX = buildHeaderIndex(readAllCorpus());
  return INDEX;
}
export function resetHeaderIndex() { INDEX = null; PHONETIC = null; VOCAB = null; }

// task-18: the phonetic leg's map, built from the same projection the literal search reads.
let PHONETIC = null;
let VOCAB = null;
function headingVocab(index) {
  if (!VOCAB) {
    VOCAB = new Set();
    for (const e of index) for (const w of foldWords(e.heading)) if (w.length >= 3) VOCAB.add(w);
  }
  return VOCAB;
}
function nameWords(e) {
  const out = [];
  for (const seg of e.segments) {
    for (const w of String(seg).split(/[^A-Za-z0-9']+/)) if (w.length >= 3) out.push(w);
  }
  return out;
}
export function phoneticIndex(entries) {
  const index = entries || headerIndex();
  if (!PHONETIC) PHONETIC = buildPhoneticIndex(index.filter(e => e.canonical).map(e => ({ id: e.id, words: nameWords(e) })));
  return PHONETIC;
}

// The search, with the phonetic rescue leg the server has always had. The literal pass is
// search-core's; this adds the leg that fires only when the literal pass found NOTHING and a word
// is absent from the corpus's whole vocabulary, which is what a misheard name looks like.
// The search: search-core's matcher, plus the server's own phonetic resolver. The leg itself lives
// in the core now (injected), so the browser runs the same logic with its shipped tables.
export function searchHeadings(query, opts) {
  const o = opts || {};
  const index = o.index || headerIndex();
  const raw = String(query == null ? '' : query).trim();
  const out = coreSearch(query, Object.assign({}, o, {
    tables: o.tables || tables(),
    index,
    vocab: headingVocab(index),
    termPresent,
    phoneticMatches: o.phoneticMatches || ((text, legOpts) => phoneticMatches(text, phoneticIndex(index), legOpts)),
  }));
  // The leg's count, for the route and the drawer: how many rows came from a misheard name.
  out.phonetic = out.rows.filter(r => r.phonetic === true).length;
  return out;
}

// The match. Returns { found: true, id, tier, candidates } or
// { found: false, reason, candidates } with reason one of 'not-a-lookup',
// 'no-heading', 'only-mentions', 'ambiguous'.
export function lookupRecord(question, opts) {
  const o = opts || {};
  const intent = o.intent || lookupIntent(question, tables());
  if (!intent.lookup) return { found: false, reason: 'not-a-lookup', candidates: 0 };
  const index = o.index || headerIndex();
  const words = intent.words;
  const hits = index.filter(e => words.every(w => termPresent(e.heading.toLowerCase(), w)));
  const clean = hits.filter(e => e.canonical);
  if (!clean.length) return { found: false, reason: hits.length ? 'only-mentions' : 'no-heading', candidates: hits.length };
  const tierOf = e => (e.last === intent.phrase ? 1 : (words.every(w => termPresent(e.last, w)) ? 2 : 3));
  const tiers = new Map(clean.map(e => [e, tierOf(e)]));
  const best = Math.min(...clean.map(e => tiers.get(e)));
  const at = clean.filter(e => tiers.get(e) === best);
  if (intent.bare && best > 2) return { found: false, reason: 'no-heading', candidates: hits.length };
  if (new Set(at.map(e => e.last)).size > 1) return { found: false, reason: 'ambiguous', candidates: at.length, tier: best };
  at.sort(rankCmp);
  return { found: true, id: at[0].id, tier: best, candidates: at.length };
}

// The row shape, with the same wiring searchHeadings uses.
export function findRows(query, opts) {
  const o = Object.assign({}, opts, { tables: (opts && opts.tables) || tables() });
  const index = o.index || headerIndex();
  return coreFindRows(query, Object.assign({}, o, {
    index,
    termPresent,
    vocab: headingVocab(index),
    phoneticMatches: o.phoneticMatches || ((text, legOpts) => phoneticMatches(text, phoneticIndex(index), legOpts)),
  }));
}

export default { headerIndex, searchHeadings, lookupRecord, findRows, resetHeaderIndex };
