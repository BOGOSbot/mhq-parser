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

// A lookup, or a real question. Anchored: 'can I find cover?' is a question, and
// the pipeline must run it.
export function lookupIntent(question) {
  const raw = String(question == null ? '' : question).trim();
  const m = LOOKUP_VERB.exec(raw);
  if (!m) return { lookup: false, words: [], phrase: '' };
  const words = contentWords(m[1]);
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
export function buildHeaderIndex(records) {
  return (records || []).map(rec => {
    const heading = String((rec && rec.heading) || '');
    const segments = heading.split(' > ').map(s => s.trim()).filter(Boolean);
    return {
      id: rec.id,
      heading,
      segments,
      last: normalizePhrase(segments.length ? segments[segments.length - 1] : ''),
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
