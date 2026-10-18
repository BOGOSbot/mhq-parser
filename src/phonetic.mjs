#!/usr/bin/env node
'use strict';
/**
 * The phonetic leg (task-18).
 *
 * The dense leg is multilingual, so it already crosses French to English. What it
 * cannot do is a proper noun that was never spelled right: a French speaker says
 * "Arkon" for what the book writes "Archon", and no embedding fixes a name the
 * reader (or the recogniser) never had. This module is the missing leg, and it is
 * the one BOGOS measured by hand in notes/mhq-voice-transcription.md
 * (section *The vocal-search bet*): key every word on both sides with one
 * English-leaning phonetic spelling, keep the vowels, and score key overlap with
 * a normalised Levenshtein distance rather than equality.
 *
 * Three decisions are the note's, and each one was measured there:
 *   - vowels stay in. A consonant skeleton collapsed YNNEAD onto dans/deux/tous,
 *     every one at distance 0.00;
 *   - ch -> k, not s, because the pair this corpus actually produces is
 *     'Archon' heard as 'Arkon'; a French encoder applied to both sides gives S
 *     for Archon and K for arcon and they never meet;
 *   - words INSIDE names are indexed, not whole names: 'Agamatus' exists only
 *     inside 'Agamatus Custodians'.
 *
 * Aliases are hand-written because the corpus cannot produce them: 11th edition
 * renamed Eldar to Aeldari and every player still says the old name.
 *
 * Pure and model-free: no I/O, no network, no index write. src/header-index.mjs
 * builds its map from the heading projection it already holds; the eval builds
 * one from the corpus sections. One implementation, two callers.
 */

// Words that carry no name. Keys of these match names by accident, so they never
// enter a query. English and French, the two languages the reader types.
const STOP = new Set(('the a an and or of to in on at is are was were be been being for with me my our your ' +
  'can could does do did if then than that this these those what which when where how why who whom ' +
  'unit units model models phase phases turn turns rule rules player players question about after before ' +
  'shoot shooting charge charged move moving fall fell back make makes made take takes taken when while ' +
  'le la les l des de du d un une et ou pour sur dans au aux moi mon ma mes je ce cet cette il elle on ' +
  'est sont peut peuvent apres avant pendant quand avec sans sous sur').split(' '));

export function levenshtein(a, b) {
  const s = String(a || ''), t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = new Array(t.length + 1);
  let cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s.charCodeAt(i - 1) === t.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return prev[t.length];
}

export function phoneticKey(word) {
  let w = String(word == null ? '' : word)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  w = w
    .replace(/ph/g, 'f').replace(/qu/g, 'k').replace(/gu/g, 'k')
    .replace(/ch/g, 'k').replace(/ck/g, 'k').replace(/gn/g, 'n').replace(/th/g, 't')
    .replace(/c/g, 'k').replace(/q/g, 'k').replace(/y/g, 'i').replace(/w/g, 'v').replace(/z/g, 's');
  w = w.replace(/(e|s|t|x|d|p)+$/, '');
  w = w.replace(/(.)\1+/g, '$1');
  return w;
}

// distance / max(len) on the keys, as the note specifies: 'cobalites' and
// 'kabalit' differ by one substitution, not by a rename.
export function phoneticDistance(a, b) {
  const x = phoneticKey(a), y = phoneticKey(b);
  const m = Math.max(x.length, y.length);
  if (!m) return 1;
  return levenshtein(x, y) / m;
}

// The names the corpus cannot derive from the reader's spelling. One line each,
// because each one is a decision: Eldar is 11th edition's Aeldari; Votann is
// spelled with one N in the book and two in most voices; Krieg is the Death
// Korps' planet.
export const PHONETIC_ALIASES = {
  eldar: 'aeldari',
  'dark eldar': 'drukhari',
  drukhari: 'drukhari',
  votaan: 'votann',
  votan: 'votann',
  kreig: 'krieg',
  creig: 'krieg',
  aeldar: 'aeldari',
  aeldary: 'aeldari',
};

export function aliasWord(word) {
  const w = String(word == null ? '' : word).toLowerCase();
  return PHONETIC_ALIASES[w] || w;
}

// The multi-word aliases first, longest first, so 'dark eldar' is rewritten whole
// rather than word by word ('dark' names nothing, and 'eldar' alone would leave
// the reader's 'dark' to match a Dark Talon).
const PHRASE_ALIASES = Object.keys(PHONETIC_ALIASES).filter(k => k.indexOf(' ') !== -1).sort((a, b) => b.length - a.length);

export function phoneticWords(text) {
  let s = String(text == null ? '' : text)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  for (const phrase of PHRASE_ALIASES) {
    if (s.indexOf(phrase) !== -1) s = s.split(phrase).join(PHONETIC_ALIASES[phrase]);
  }
  return s.split(/[^a-z0-9']+/)
    .map(w => aliasWord(w.replace(/^'+|'+$/g, '')))
    .filter(w => w.length >= 3 && !STOP.has(w));
}

// entries: [{id, words: [name word, ...]}]. One key per word, word -> ids.
export function buildPhoneticIndex(entries) {
  const index = new Map();
  for (const e of entries || []) {
    if (!e || !e.id) continue;
    for (const raw of e.words || []) {
      const word = String(raw || '').trim();
      if (word.length < 3) continue;
      const key = phoneticKey(word);
      if (!key || key.length < 3) continue;
      let bucket = index.get(key);
      if (!bucket) { bucket = []; index.set(key, bucket); }
      bucket.push({ id: e.id, word: word });
    }
  }
  return index;
}

export function phoneticIndexSize(index) {
  let words = 0;
  for (const bucket of index.values()) words += bucket.length;
  return { keys: index.size, words: words };
}

// The query side: key every content word, keep the index words within the
// distance, and score the overlap. A word that is not a name (no key, a stop
// word, too short) contributes nothing; a long key can differ by more sounds
// than a short one before it is a different word.
export function phoneticMatches(text, index, opts) {
  const o = opts || {};
  const limit = Math.min(Math.max(Number(o.limit) || 10, 1), 100);
  const maxLong = o.maxDistance != null ? Number(o.maxDistance) : 0.30;
  const maxShort = o.maxShortDistance != null ? Number(o.maxShortDistance) : 0.2;
  const scored = new Map();
  for (const w of phoneticWords(text)) {
    const q = phoneticKey(w);
    if (!q || q.length < 4) continue;
    const max = q.length >= 6 ? maxLong : maxShort;
    for (const [key, bucket] of index) {
      if (Math.abs(key.length - q.length) > 3) continue; // cheap length gate
      const d = phoneticDistance(q, key);
      if (d > max) continue;
      for (const hit of bucket) {
        const cur = scored.get(hit.id) || { id: hit.id, score: 0, heard: [] };
        cur.score += 1 - d;
        if (cur.heard.length < 3) cur.heard.push(w + '~' + hit.word);
        scored.set(hit.id, cur);
      }
    }
  }
  return Array.from(scored.values())
    .sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit);
}

export default { phoneticKey, phoneticDistance, phoneticWords, phoneticMatches, buildPhoneticIndex, phoneticIndexSize, PHONETIC_ALIASES, aliasWord, levenshtein };
