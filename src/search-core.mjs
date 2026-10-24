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
  // task-18/task-97: THE PHONETIC RESCUE LEG, injected. The literal search requires EVERY word in
  // the heading, so one misheard name kills the lookup ('arcon' for Archon). It fires only when
  // the literal pass found NOTHING and a word is absent from the whole vocabulary - a rescue, not
  // a rewriter. The server passes its own resolver (src/phonetic.mjs over the corpus index); the
  // browser passes one built from the shipped search/phonetic.js and the shipped vocab.
  if (typeof o.phoneticMatches === 'function' && rows.length === 0 && words.some(w => !(o.vocab && o.vocab.has ? o.vocab.has(w) : false))) {
    const have = new Set(rows.map(r => r.id));
    for (const m of o.phoneticMatches(raw, { limit: limit - rows.length }) || []) {
      const e = (o.byId && o.byId.get(m.id)) || index.find(x => x.id === m.id);
      if (!e || have.has(m.id)) continue;
      rows.push({
        id: e.id,
        tier: 4,
        phonetic: true,
        heard: m.heard,
        title: cleanMarker(e.segments.length ? e.segments[e.segments.length - 1] : e.heading),
        crumbs: e.segments.slice(0, -1),
        kind: e.kind,
      });
      have.add(m.id);
    }
  }
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
// --- the route's row shape -----------------------------------------------------
//
// task-97: findRows and the unit fold live HERE, with the matcher, because the app's local server
// must answer /rules/find in the route's exact shape (id, slug, title, kind, tier, crumbs,
// phonetic, heard, parts). header-index.mjs re-exports them, so the server keeps its imports and
// the browser gets the same code.
export function unitKey(row) {
  const id = String((row && row.id) || '');
  const m = /^(datasheet|unitrules)#([0-9]+)(?:~\d+)?$/.exec(id);
  return m ? 'unit:' + m[2] : '';
}

export function foldUnitRows(rows) {
  const groups = new Map();
  const order = [];
  for (const r of rows) {
    const key = unitKey(r);
    if (!key) { order.push({ key: '', row: r }); continue; }
    if (!groups.has(key)) { groups.set(key, []); order.push({ key: key, row: null }); }
    groups.get(key).push(r);
  }
  const out = [];
  for (const entry of order) {
    if (!entry.key) { out.push(entry.row); continue; }
    const group = groups.get(entry.key);
    const head = group.find(function (r) { return r.kind === 'datasheet' && r.slug; })
      || group.find(function (r) { return r.kind === 'datasheet'; })
      || group[0];
    const parts = group.filter(function (r) { return r !== head; });
    const row = Object.assign({}, head);
    if (parts.length) row.parts = parts.map(function (r) { return { id: r.id, kind: r.kind, title: r.title, slug: r.slug || '' }; });
    out.push(row);
  }
  return out;
}

export function findRows(query, opts) {
  const o = opts || {};
  const cap = Math.max(Number(o.cap) || 40, 1);
  const out = searchHeadings(query, Object.assign({}, o, { limit: 100 }));
  const slugs = o.slugs || new Map();
  const delivered = o.delivered || null;
  const matched = foldUnitRows((out.rows || []).filter(function (r) {
    const id = String(r.id);
    return !delivered || delivered.has(id);
  }));
  return {
    q: String(query == null ? '' : query),
    total: matched.length,
    rows: matched.slice(0, cap).map(function (r) {
      return {
        id: r.id,
        slug: slugs.get(r.id) || '',
        title: r.title,
        kind: r.kind,
        tier: r.tier,
        crumbs: r.crumbs,
        phonetic: r.phonetic === true,
        heard: r.heard || [],
        parts: (r.parts || []).map(function (p) {
          return { id: p.id, kind: p.kind, title: p.title, slug: slugs.get(p.id) || p.slug || '' };
        }),
      };
    }),
  };
}
