import { readAllCorpus, isDelivered } from './rules-corpus.mjs';
import { buildHeaderIndex, cleanMarker, isTitleLike, kindRank } from './header-index.mjs';

// task-66: the general wikilink rule. Any exact match of a rule, detachment, unit
// or faction name becomes a link to that record's page - label as written, href
// to the target. One name map, one escaper (esc is exported here and imported by
// wiki-cards), and the distinctive discipline the rulings fold proved.
//
// task-42: the name source is the HEADING INDEX - the corpus's own projection of
// what a record is called - and the discipline is the book's own spelling:
//   * a name is the last heading segment of a DELIVERED, canonical record;
//   * a single word is a name only in its keyword form: the book writes LEADER,
//     SCOUTS, DAMAGED, INFILTRATORS in caps, while 'Dice', 'Bearer', 'Destroyed'
//     are ordinary words that happen to head a section;
//   * a single-word name links only where the text writes it capitalised, because
//     that is the corpus's own evidence it is used as a name; a multi-word name is
//     distinctive by itself and links in either case.
// The measure behind the last rule, over the 7,390-record corpus: 'You' occurs
// 6,955 times and is capitalised in 13% of them; 'Command Phase' 1,624 times,
// 99.9%; 'SCOUTS' 709 times, 99.7%; 'dice' 2%; 'Bearer' 1%. Capitalisation is
// the corpus's own evidence that the word is used as a name, not as prose.
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Names barred by hand after reading the top-20 usage: the record they point at is
// real, but in prose the phrase is a verb, not that record's name. 'set up' (1,028
// occurrences, 4% of them capitalised) is the weakest - the target is the 'Set Up'
// step, but 'set up a unit' is ordinary prose; 'select units' is the same shape.
export const BARRED = new Set(['set up', 'select units']);

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A whole name in caps is the keyword form of a single word: LEADER, SCOUTS,
// DAMAGED. A single word with a lowercase letter in its heading is a section
// title made of an ordinary word, and it stays plain text.
const keywordForm = name => !/[a-z]/.test(name);
const singleFlag = name => name.split(/\s+/).length === 1;
// What the record is CALLED, as opposed to what the tree prints. cleanMarker drops the
// split/twin markers (the tree's own rule); a trailing parenthetical is the CSV's
// faction or kind tag - 'DIVINE INTERVENTION (Adepta Sororitas)', 'Spirit Stone of
// Raelyth (Enhancement - Aeldari, Armoured Warhost)' - and a colon tail is a
// qualifier. The 5,000-record faction half is written this way, so without this the
// whole stratagem/enhancement family would answer to a name no sentence ever uses.
const cleanName = s => cleanMarker(String(s == null ? '' : s))
  .replace(/\s*\([^()]*\)\s*$/, '')
  .replace(/\s*:\s.*$/, '')
  .trim();
const LETTER = /[A-Za-z]/;
function capitalised(s) {
  const m = LETTER.exec(String(s));
  return !!m && m[0] === m[0].toUpperCase();
}
// A line with no lowercase at all is a label or a sub-heading, not a sentence:
// the names on it are already the structure, so nothing there becomes a link.
function capsLine(text) {
  const s = String(text == null ? '' : text).trim();
  return s.length > 0 && s.length <= 64 && !/[a-z]/.test(s);
}

// The map: every delivered, canonical heading name, with its one target. A name
// carried by several records is not guessed at - except when exactly ONE candidate
// holds the top rank of the search's own kind order, which is how the search itself
// answers a name: FALL-BACK MOVE is the rule and not its three stratagem copies, and
// a unit name is the DATASHEET and not its unitrules twin (the twin marker is the
// same name once cleanMarker has stripped it). A tie at the top stays plain text.
export function buildLinkMap(records) {
  const all = records || readAllCorpus();
  const index = buildHeaderIndex(all.filter(r => isDelivered(r)));
  const byName = new Map();
  const barred = new Set(), generic = new Set(), ambiguous = new Set();
  for (const e of index) {
    if (!e.canonical) continue;
    const name = cleanName(e.segments.length ? e.segments[e.segments.length - 1] : '');
    if (!name || name.length < 3 || name.length > 64) continue;
    if (!isTitleLike(name)) continue;
    const key = name.toLowerCase();
    if (BARRED.has(key)) { barred.add(name); continue; }
    const single = name.split(/\s+/).length === 1;
    if (single && !keywordForm(name)) { generic.add(name); continue; }
    if (!byName.has(key)) byName.set(key, { name: name, ids: new Map() });
    byName.get(key).ids.set(e.id, e.kind);
  }
  const eligible = new Map();
  for (const [key, v] of byName) {
    const ids = [...v.ids.keys()];
    if (ids.length === 1) { eligible.set(key, { name: v.name, id: ids[0], key: key, single: singleFlag(v.name) }); continue; }
    const ranks = ids.map(id => kindRank(v.ids.get(id)));
    const min = Math.min.apply(null, ranks);
    const best = ids.filter((id, i) => ranks[i] === min);
    if (best.length === 1) eligible.set(key, { name: v.name, id: best[0], key: key, single: singleFlag(v.name) });
    else ambiguous.add(v.name);
  }
  return { eligible: eligible, ambiguous: ambiguous, generic: generic, barred: barred, names: [...eligible.values()].sort((a, b) => b.name.length - a.name.length) };
}

let cachedMap = null;
export function linkMap(records) {
  if (!cachedMap) cachedMap = buildLinkMap(records || readAllCorpus());
  return cachedMap;
}

let cachedMatcher = null;
function matcher(map) {
  if (cachedMatcher && cachedMatcher.map === map) return cachedMatcher;
  const usable = map.names;
  const re = usable.length ? new RegExp('\\b(?:' + usable.map(n => escapeRe(n.name)).join('|') + ')\\b', 'gi') : null;
  cachedMatcher = { map: map, re: re, byKey: new Map(usable.map(n => [n.name.toLowerCase(), n])) };
  return cachedMatcher;
}

// Linkify one record's text: word boundaries, longest name first, the FIRST
// occurrence of each name only, no self-link, capped so a page is never carpeted.
// task-42: the cap and the used set live in opts.state when the caller renders one
// record in several pieces (prose, a legend, a table), so the budget is per RECORD
// and not per fragment; a caller that passes no state gets a fresh budget per call.
// The href is resolved BEFORE anything is marked used: an empty href must not
// consume a name's only chance to link (that is what left Divine Intervention as
// plain text on the rendered page while the function-level call linked it).
export function linkify(text, opts) {
  const o = opts || {};
  const raw = String(text == null ? '' : text);
  if (!raw) return '';
  const map = o.map || linkMap();
  const cap = Number.isFinite(o.cap) ? o.cap : 12;
  if (!cap || typeof o.href !== 'function') return esc(raw);
  if (capsLine(raw)) return esc(raw);
  const mm = matcher(map);
  if (!mm.re) return esc(raw);
  const st = o.state || { used: new Set(), count: 0 };
  let out = '', last = 0, m;
  mm.re.lastIndex = 0;
  while ((m = mm.re.exec(raw))) {
    const hit = mm.byKey.get(m[0].toLowerCase());
    if (!hit || hit.id === o.selfId || st.used.has(hit.key)) continue;
    if (hit.single && !capitalised(m[0])) continue;
    if (st.count >= cap) break;
    const href = o.href(hit.id);
    if (!href) continue;
    st.used.add(hit.key);
    st.count += 1;
    out += esc(raw.slice(last, m.index));
    out += '<a class="wlink" href="' + esc(href) + '">' + esc(m[0]) + '</a>';
    last = m.index + m[0].length;
  }
  out += esc(raw.slice(last));
  return out;
}

export default { BARRED, buildLinkMap, esc, linkify, linkMap };
