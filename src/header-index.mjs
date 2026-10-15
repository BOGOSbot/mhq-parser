#!/usr/bin/env node
'use strict';
/**
 * The header index: a lookup router over the corpus's own headings.
 *
 * A reader who types "find rapid ingress" wants the rule, not a search. Every
 * record's heading already names it, so the lookup is a grep over those headings
 * - in memory, no embedding, no index write, no model call. This module is the
 * PROJECTION and the match, nothing else.
 *
 * The header-embed arm was measured and lost (header-only hit@1 33.3 / hit@20
 * 48.5 against the full text's 42.4 / 69.7, and fusing the two costs the head),
 * so there is no vector here and no second index to keep in step: the projection
 * is regenerated from the corpus, and the fallback when it misses is the normal
 * pipeline, never a header-embed step.
 *
 * French phrasings are rewritten through the two mechanical tables we already
 * own (glossaryIndex().frToEn and KEYWORDS, both model-free) before the headings
 * are grepped, so 'trouve abaddon le fléau' reaches ABADDON THE DESPOILER. Where
 * neither table holds the word - the rulebook's own vocabulary, 'cohésion' - the
 * lookup falls through to the normal pipeline: a stated English-only limit, never
 * a half-answer. A question that merely mentions a unit is not a lookup, and the
 * tables are never consulted for one.
 *
 * The match is deliberately conservative, because a wrong answer is worse than a
 * slow one - the reader has no reason to doubt a lookup they typed themselves:
 *   - the question must LOOK like a lookup (a lookup verb in front, either
 *     language), or it is not one and the pipeline runs untouched;
 *   - every content word must match at the START of a word in the heading path;
 *   - a candidate whose path carries a sentence, a question or an FAQ/Errata
 *     segment is a MENTION of the rule, not the rule, and is dropped;
 *   - the best tier wins: the last heading segment IS the phrase, then contains
 *     all of it, then carries it somewhere in the path;
 *   - several DIFFERENT headings carrying the words is ambiguous and falls
 *     through, and so does a phrase the corpus does not name at all.
 *
 * The measurement set is tests/fixtures/rules-lookups.json, written before this
 * module existed; tests/test-lookup.mjs prints how many of it land, fall through
 * and answer wrongly.
 */
import { readAllCorpus, termPresent } from './rules-corpus.mjs';
import { KEYWORDS, glossaryIndex } from './translate-fr-en.mjs';

// The verbs a lookup opens with. Both languages: the reader types 'cherche' or
// 'find' and means the same thing.
const LOOKUP_VERB = /^(?:please\s+|peux-tu\s+|can\s+you\s+)?(?:find|search(?:\s+for)?|look\s*up|show\s+me|show|where\s+(?:is|are)|locate|cherche[r]?|trouve[r]?|montre(?:-moi)?|affiche|o[uù]\s+(?:est|se\s+trouve))\b[\s:,\-]*(.*)$/i;

// Words that carry no name: articles, the verb repeated, the word 'rule' itself
// ('find the rules for X' names X). Folded to unaccented lower case, because the
// headings are ASCII-ish and a phone keyboard is not.
const STOP = new Set(('the a an and or of to in on at is are for with me my our your please ' +
  'rules rule about find search look locate show where ' +
  'le la les l des de du d un une et ou pour sur dans au aux moi mon ma mes je ' +
  'regle regles stp merci').split(' '));

function foldWords(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function contentWords(text) {
  return foldWords(text).filter(w => w.length >= 3 && !STOP.has(w));
}

// The French the reader types is not the English the headings carry, and two
// tables already own that mapping, both mechanical and model-free: the glossary
// (the Munitorum Field Manual's own pairs, 'ABADDON LE FLÉAU' -> 'ABADDON THE
// DESPOILER') and KEYWORDS (the closed keyword/ability vocabulary, 'INSENSIBLE'
// -> 'FEEL'). A lookup phrase is rewritten through them BEFORE the headings are
// grepped.
//
// The limit is the tables', and it is a stated one: neither holds the rulebook's
// own vocabulary ('cohésion', 'repli'), so a phrasing that names a rule in
// French still falls through to the normal pipeline rather than answering by
// accident. That is the English-only case, not a half-answer.
const foldTerm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const KEY_FR_TO_EN = (() => {
  const m = new Map();
  for (const [en, fr] of Object.entries(KEYWORDS)) {
    const k = foldTerm(fr);
    if (k && !m.has(k)) m.set(k, foldTerm(en));
  }
  return m;
})();
const GLOSSARY_FR = (() => {
  const list = [];
  for (const [fr, e] of glossaryIndex().frToEn) {
    const words = foldTerm(fr).split(/[^a-z0-9]+/).filter(Boolean);
    if (words.length && e.en) list.push({ words: words, en: foldTerm(e.en) });
  }
  list.sort((a, b) => b.words.length - a.words.length);
  return list;
})();

export function translateLookupWords(rawWords) {
  const out = [];
  for (let i = 0; i < rawWords.length; i++) {
    // Longest glossary phrase first, so a name is rewritten whole rather than one
    // word at a time ('abaddon le fleau' -> 'abaddon the despoiler').
    let matched = false;
    for (const g of GLOSSARY_FR) {
      if (i + g.words.length <= rawWords.length && g.words.every((w, j) => rawWords[i + j] === w)) {
        out.push.apply(out, g.en.split(/[^a-z0-9]+/).filter(Boolean));
        i += g.words.length - 1;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const keyword = KEY_FR_TO_EN.get(rawWords[i]);
    out.push(keyword || rawWords[i]);
  }
  return out;
}

// A lookup, or a real question. Anchored: 'can I find cover?' is a question, and
// the pipeline must run it.
export function lookupIntent(question) {
  const raw = String(question == null ? '' : question).trim();
  const m = LOOKUP_VERB.exec(raw);
  if (!m) return { lookup: false, words: [], phrase: '' };
  const words = contentWords(translateLookupWords(foldWords(m[1])).join(' '));
  if (!words.length) return { lookup: false, words: [], phrase: '' };
  return { lookup: true, words, phrase: words.join(' ') };
}

// A heading segment that names a rule: short, no question mark, not FAQ/Errata,
// not a sentence. A long sentence segment ('The Tank Shock Stratagem is the same
// as the Crushing Impact stratagem .') marks a card promoted out of someone
// else's body; it mentions the rule, it is not the rule.
export function isTitleLike(segment) {
  const s = String(segment == null ? '' : segment).trim();
  if (!s) return false;
  if (s.length > 64) return false;
  if (s.indexOf('?') !== -1) return false;
  if (/^(q:|faq$|errata$|see\s)/i.test(s)) return false;
  if (/[.!]\s*$/.test(s) && s.length > 30) return false;
  return true;
}

export function normalizePhrase(text) {
  return foldWords(text).join(' ');
}

function hrefFor(rec) {
  const url = String((rec && rec.url) || '').split('#')[0];
  return rec && rec.anchor ? url + '#' + rec.anchor : url;
}

// The projection: one entry per record, {id, heading, segments, last, kind,
// href, canonical}. Canonical is false when any segment is a sentence, a
// question or FAQ/Errata, which is what keeps a mention from answering a lookup.
// A split part says '(1/2)' and a unitrules twin says '- keywords and abilities':
// both are markers on the same record, not names, and leaving them in made a
// lookup for a unit ambiguous with its own twin. The tree strips the same two.
const cleanMarker = s => String(s)
  .replace(/\s*\(\d+\/\d+\)$/, '')
  .replace(/\s*-\s*keywords and abilities(\s*\(\d+\/\d+\))?$/i, '')
  .trim();

export function buildHeaderIndex(records) {
  return (records || []).map(rec => {
    const heading = String((rec && rec.heading) || '');
    const segments = heading.split(' > ').map(s => s.trim()).filter(Boolean);
    return {
      id: rec.id,
      heading,
      segments,
      last: normalizePhrase(cleanMarker(segments.length ? segments[segments.length - 1] : '')),
      kind: (rec && rec.kind) || '',
      href: hrefFor(rec),
      canonical: segments.every(isTitleLike),
    };
  });
}

let INDEX = null;
export function headerIndex(records) {
  if (records) return buildHeaderIndex(records);
  if (!INDEX) INDEX = buildHeaderIndex(readAllCorpus());
  return INDEX;
}
export function resetHeaderIndex() { INDEX = null; }

// Which kind answers first when several carry the same name. A rule beats the
// ability card that repeats it; a stratagem beats nothing else here (an index
// page or a datasheet only answers when it is the name). Unknown kinds last.
const KIND_ORDER = ['rule', 'stratagem', 'faction-rule', 'ability', 'datasheet', 'detachment', 'enhancement', 'unitrules', 'index', 'card'];
function kindRank(kind) {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
}
function rankCmp(a, b) {
  return (kindRank(a.kind) - kindRank(b.kind))
    || (a.segments.length - b.segments.length)
    || (a.heading.length - b.heading.length)
    || String(a.id).localeCompare(String(b.id));
}

// The match. Returns { found: true, id, tier, candidates } or
// { found: false, reason, candidates } with reason one of 'not-a-lookup',
// 'no-heading', 'only-mentions', 'ambiguous'.
export function lookupRecord(question, opts) {
  const o = opts || {};
  const intent = o.intent || lookupIntent(question);
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
  // Several different headings carrying the words is not one answer: 'find
  // charge' names the Charge phase, a charge move and a charge roll, and picking
  // one of them for the reader would be a confident guess. Fall through.
  if (new Set(at.map(e => e.last)).size > 1) return { found: false, reason: 'ambiguous', candidates: at.length, tier: best };
  at.sort(rankCmp);
  return { found: true, id: at[0].id, tier: best, candidates: at.length };
}
