// task-97: THE MATCHER, SHARED BY THE SERVER AND THE BROWSER.
//
// The find route greps a header index; the app's WebView runs the same client, so it must grep
// the SAME way or the two presentations drift. This file holds the matcher itself and nothing
// else: no node imports, no reads, no model calls. Everything it needs comes in through `opts`:
//
//   opts.index     the header index (buildHeaderIndex output), shipped as search/index.json
//   opts.vocab     the set of every folded word any heading carries, shipped as data
//   opts.keywords  the closed keyword/ability vocabulary, shipped as data
//   opts.glossary  the glossary's French-to-English pairs, shipped as data
//   opts.termPresent  a predicate (heading, word) -> boolean; the server injects the corpus's
//                     own, the browser uses the vocab set
//   opts.phonetic  false to skip the phonetic leg (the browser passes the shipped rows instead)
//
// header-index.mjs keeps the server's own wiring and re-exports these, so the server's behaviour
// does not change and there is exactly ONE implementation.

// EXACTLY the server's regex, so the two cannot drift on what counts as a lookup.
const LOOKUP_VERB = /^(?:please\s+|peux-tu\s+|can\s+you\s+)?(?:find|search(?:\s+for)?|look\s*up|show\s+me|show|where\s+(?:is|are)|locate|cherche[r]?|trouve[r]?|montre(?:-moi)?|affiche|o[uù]\s+(?:est|se\s+trouve))\b[\s:,\-]*(.*)$/i;
const STOP = new Set(('the a an and or of to in on at is are for with me my our your please ' +
  'rules rule about find search look locate show where ' +
  'le la les l des de du d un une et ou pour sur dans au aux moi mon ma mes je ' +
  'regle regles stp merci').split(' '));

export function foldWords(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
export function contentWords(text) {
  return foldWords(text).filter(w => w.length >= 3 && !STOP.has(w));
}
export function normalizePhrase(text) { return foldWords(text).join(' '); }
const foldTerm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// The French the reader types is not the English the headings carry, and two tables own that
// mapping: the glossary and the keyword vocabulary. Both are data here.
export function translationTables(opts) {
  const o = opts || {};
  const keyFrToEn = new Map();
  for (const [en, fr] of Object.entries(o.keywords || {})) {
    const k = foldTerm(fr);
    if (k && !keyFrToEn.has(k)) keyFrToEn.set(k, foldTerm(en));
  }
  const glossary = [];
  for (const pair of o.glossary || []) {
    const words = foldTerm(pair[0]).split(/[^a-z0-9]+/).filter(Boolean);
    if (words.length && pair[1]) glossary.push({ words, en: foldTerm(pair[1]) });
  }
  glossary.sort((a, b) => b.words.length - a.words.length);
  return { keyFrToEn, glossary };
}
export function translateLookupWords(rawWords, tables) {
  const t = tables || { keyFrToEn: new Map(), glossary: [] };
  const out = [];
  for (let i = 0; i < rawWords.length; i++) {
    let matched = false;
    for (const g of t.glossary) {
      if (i + g.words.length <= rawWords.length && g.words.every((w, j) => rawWords[i + j] === w)) {
        out.push.apply(out, g.en.split(/[^a-z0-9]+/).filter(Boolean));
        i += g.words.length - 1;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    out.push(t.keyFrToEn.get(rawWords[i]) || rawWords[i]);
  }
  return out;
}
export function lookupIntent(question, tables) {
  const raw = String(question == null ? '' : question).trim();
  const m = LOOKUP_VERB.exec(raw);
  if (m) {
    const words = contentWords(translateLookupWords(foldWords(m[1]), tables).join(' '));
    if (!words.length) return { lookup: false, words: [], phrase: '' };
    return { lookup: true, words, phrase: words.join(' ') };
  }
  if (raw.indexOf('?') !== -1) return { lookup: false, words: [], phrase: '' };
  const bare = contentWords(translateLookupWords(foldWords(raw), tables).join(' '));
  if (!bare.length || bare.length > 4) return { lookup: false, words: [], phrase: '' };
  return { lookup: true, words: bare, phrase: bare.join(' '), bare: true };
}
export function isTitleLike(segment) {
  const s = String(segment == null ? '' : segment).trim();
  if (!s) return false;
  if (s.length > 64) return false;
  if (s.indexOf('?') !== -1) return false;
  if (/^(q:|faq$|errata$|see\s)/i.test(s)) return false;
  if (/[.!]\s*$/.test(s) && s.length > 30) return false;
  return true;
}
export const cleanMarker = s => String(s)
  .replace(/\s*\(\d+\/\d+\)$/, '')
  .replace(/\s*-\s*keywords and abilities(\s*\(\d+\/\d+\))?$/i, '')
  .trim();

function hrefFor(rec) {
  const url = String((rec && rec.url) || '').split('#')[0];
  return rec && rec.anchor ? url + '#' + rec.anchor : url;
}
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

// The word-start match, EXACTLY as rules-corpus.mjs defines it: a term matches at the start of a
// word, not anywhere inside one, so 'embark' is not read inside 'disembark'. The browser cannot
// import the corpus's predicate, so the rule lives here too - one definition of what 'present'
// means, used by the shipped matcher and checked against the server's in the tests.
export function termCount(text, term) {
  const t = String(term);
  if (!t) return 0;
  const hay = String(text);
  let n = 0;
  let at = hay.indexOf(t);
  while (at !== -1) {
    if (at === 0 || !/[a-z0-9]/.test(hay.charAt(at - 1))) n++;
    at = hay.indexOf(t, at + 1);
  }
  return n;
}
export function termPresent(text, term) { return termCount(text, term) > 0; }

// The vocabulary: every folded word any heading carries, three letters or more. Shipped as data
// for the browser; the server builds it from the same index.
export function headingVocab(index) {
  const out = new Set();
  for (const e of index) for (const w of foldWords(e.heading)) if (w.length >= 3) out.add(w);
  return out;
}

// The literal search. `termPresent` is injected: the server passes the corpus's own predicate,
// the browser passes a vocabulary-set check, and the ROWS are what must agree.
export function searchHeadings(query, opts) {
  const o = opts || {};
  // The default is the word-start predicate above, so a browser that passes nothing still matches
  // the way the server does.
  const present = o.termPresent || termPresent;
  const limit = Math.min(Math.max(Number(o.limit) || 40, 1), 100);
  const raw = String(query == null ? '' : query).trim();
  if (raw.length < 2) return { words: [], rows: [], total: 0 };
  const intent = lookupIntent(raw, o.tables);
  const words = (intent.lookup && intent.words && intent.words.length)
    ? intent.words
    : contentWords(translateLookupWords(foldWords(raw), o.tables).join(' '));
  if (!words.length) return { words: [], rows: [], total: 0 };
  const phrase = words.join(' ');
  const index = o.index || [];
  const scored = [];
  for (const e of index) {
    if (!e.canonical) continue;
    if (!words.every(w => present(e.heading.toLowerCase(), w))) continue;
    scored.push({ e, tier: e.last === phrase ? 1 : (words.every(w => present(e.last, w)) ? 2 : 3) });
  }
  scored.sort((a, b) => (a.tier - b.tier) || rankCmp(a.e, b.e));
  const rows = scored.slice(0, limit).map(x => ({
    id: x.e.id,
    tier: x.tier,
    title: cleanMarker(x.e.segments.length ? x.e.segments[x.e.segments.length - 1] : x.e.heading),
    crumbs: x.e.segments.slice(0, -1),
    kind: x.e.kind,
  }));
  return { words, rows, total: scored.length };
}

// EXACTLY the server's order and tie-breaks.
const KIND_ORDER = ['rule', 'stratagem', 'faction-rule', 'ability', 'datasheet', 'detachment', 'enhancement', 'unitrules', 'index', 'card'];
export function kindRank(kind) {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
}
export function rankCmp(a, b) {
  return (kindRank(a.kind) - kindRank(b.kind))
    || (a.segments.length - b.segments.length)
    || (a.heading.length - b.heading.length)
    || String(a.id).localeCompare(String(b.id));
}
