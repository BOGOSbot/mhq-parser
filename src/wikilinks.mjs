import { readAllCorpus } from './rules-corpus.mjs';

// task-66: the general wikilink rule. Any exact match of a rule, detachment, unit
// or faction name becomes a link to that record's page - label as written, href
// to the target. One name map, built with the distinctive discipline the rulings
// fold proved: suffix-stripped leaf title, >=2 words with a non-generic token (or
// a long single name), and UNIQUE across the corpus - ambiguous names are not
// targets and are never guessed.
export const GENERIC = new Set(['stratagem','stratagems','ability','abilities','unit','units','charge','phase','phases','attack','attacks','weapon','weapons','model','models','objective','objectives','mission','missions','rule','rules','turn','round','battle','army','armies','player','players','damage','wound','wounds','wounded','move','moves','movement','shooting','shoot','fight','fights','combat','psychic','keyword','keywords','enhancement','enhancements','detachment','detachments','leader','core','action','actions','target','targets','saves','save','saved','hit','hits','roll','rolls','tests','test','points','strength','toughness','leadership','marker','markers','point','game','warhammer','40k','destroyed','normal','advance','consolidation','pile','engaged','engagement','reserves','reserve','deployment','deploy','fall','back','falling','fallback','vertical','range','ranged','melee','crushing','deadly','demise','hazardous','sustained','lethal','devastating','precision','anti','blast','torrent','melta','rapid','fire','overwatch','assault','heavy','pistol','lance','twin','linked','mortal','invulnerable','benefit','cover','obscured','hidden','visibility','terrain','area','seeking','indirect','ignore','ignores','withdraw','advances']);

export function stripSuffix(s) {
  return String(s).replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*\[[^\]]*\]\s*$/, '').replace(/\s*:\s.*$/, '').trim();
}
export function leafOf(heading) {
  const segs = String(heading || '').split(' > ');
  return String(segs[segs.length - 1] || '').replace(/^\[[^\]]*\]\s*/, '').trim();
}
export function isDistinctive(name) {
  const words = String(name).split(/\s+/);
  if (words.length < 2) return name.length >= 8 && !GENERIC.has(name.toLowerCase());
  return words.some(w => !GENERIC.has(w.toLowerCase().replace(/[^a-z0-9-]/gi, '')));
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The map plus the two sanity numbers: eligible targets, ambiguous exclusions.
export function buildLinkMap(records) {
  const byName = new Map();
  const ambiguous = new Set(), generic = new Set();
  for (const r of records) {
    const raw = stripSuffix(leafOf(r.heading));
    if (!raw || raw.length < 5) continue;
    if (!isDistinctive(raw)) { generic.add(raw); continue; }
    const key = raw.toLowerCase();
    if (!byName.has(key)) byName.set(key, { name: raw, ids: new Set() });
    byName.get(key).ids.add(r.id);
  }
  const eligible = new Map();
  for (const [key, v] of byName) {
    if (v.ids.size !== 1) { ambiguous.add(v.name); continue; }
    eligible.set(key, { name: v.name, id: [...v.ids][0] });
  }
  return { eligible, ambiguous, generic, names: [...eligible.values()].sort((a, b) => b.name.length - a.name.length) };
}

let cachedMap = null;
export function linkMap(records) {
  if (!cachedMap) cachedMap = buildLinkMap(records || readAllCorpus());
  return cachedMap;
}

// The compiled matcher is cached with the map: building a 4,000-name alternation
// per page made the measurement (and would make the render) unusably slow.
let cachedMatcher = null;
function matcher(map) {
  if (cachedMatcher && cachedMatcher.map === map) return cachedMatcher;
  const usable = map.names;
  const re = usable.length ? new RegExp('\\b(?:' + usable.map(n => escapeRe(n.name)).join('|') + ')\\b', 'gi') : null;
  const byKey = new Map(usable.map(n => [n.name.toLowerCase(), n]));
  cachedMatcher = { map: map, re: re, byKey: byKey, usable: usable };
  return cachedMatcher;
}

// Linkify one record's text: word boundaries, longest name first, FIRST occurrence
// of each name only, no self-link, and a cap so a page is never carpeted.
export function linkify(text, opts) {
  const o = opts || {};
  const raw = String(text == null ? '' : text);
  if (!raw) return '';
  if (typeof o.href !== 'function') return escHtml(raw);
  const map = o.map || linkMap();
  const cap = o.cap || 40;
  const mm = matcher(map);
  if (!mm.re) return escHtml(raw);
  const used = new Set();
  let out = '', last = 0, count = 0, m;
  mm.re.lastIndex = 0;
  while ((m = mm.re.exec(raw))) {
    const hit = mm.byKey.get(m[0].toLowerCase());
    if (!hit || hit.id === o.selfId || used.has(hit.name.toLowerCase())) continue;
    if (count >= cap) break;
    used.add(hit.name.toLowerCase());
    count += 1;
    out += escHtml(raw.slice(last, m.index));
    const href = o.href(hit.id);
    out += href ? '<a class="wlink" href="' + escHtml(href) + '">' + escHtml(m[0]) + '</a>' : escHtml(m[0]);
    last = m.index + m[0].length;
  }
  out += escHtml(raw.slice(last));
  return out;
}

