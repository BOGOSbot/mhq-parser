import { readAllCorpus } from './rules-corpus.mjs';

// task-66: the general wikilink rule. Any exact match of a rule, detachment, unit
// or faction name becomes a link to that record's page - label as written, href
// to the target. One name map, one escaper (esc is exported here and imported by
// wiki-cards), and the distinctive discipline the rulings fold proved.
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const GENERIC = new Set(['stratagem','stratagems','ability','abilities','unit','units','charge','phase','phases','attack','attacks','weapon','weapons','model','models','objective','objectives','mission','missions','rule','rules','turn','round','battle','army','armies','player','players','damage','wound','wounds','wounded','move','moves','movement','shooting','shoot','fight','fights','combat','psychic','keyword','keywords','enhancement','enhancements','detachment','detachments','leader','core','action','actions','target','targets','saves','save','saved','hit','hits','roll','rolls','tests','test','points','strength','toughness','leadership','marker','markers','point','game','warhammer','40k','destroyed','normal','advance','consolidation','pile','engaged','engagement','reserves','reserve','deployment','deploy','fall','back','falling','fallback','vertical','range','ranged','melee','crushing','deadly','demise','hazardous','sustained','lethal','devastating','precision','anti','blast','torrent','melta','rapid','fire','overwatch','assault','heavy','pistol','lance','twin','linked','mortal','invulnerable','benefit','cover','obscured','hidden','visibility','terrain','area','seeking','indirect','ignore','ignores','withdraw','advances']);

// Names barred by hand after reading the top-20 usage: the record they point at is
// real, but in prose the phrase is a verb, not that record's name. 'set up' (711
// occurrences) is the weakest - the target is the 'Set Up' step, but 'set up a
// unit' is ordinary prose; 'select units' (48) is the same shape.
export const BARRED = new Set(['set up', 'select units']);

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
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildLinkMap(records) {
  const byName = new Map();
  const ambiguous = new Set(), generic = new Set(), barred = new Set();
  for (const r of records) {
    const raw = stripSuffix(leafOf(r.heading));
    if (!raw || raw.length < 5) continue;
    if (BARRED.has(raw.toLowerCase())) { barred.add(raw); continue; }
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
  return { eligible, ambiguous, generic, barred, names: [...eligible.values()].sort((a, b) => b.name.length - a.name.length) };
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
// The href is resolved BEFORE anything is marked used: an empty href must not
// consume a name's only chance to link (that is what left Divine Intervention as
// plain text on the rendered page while the function-level call linked it).
export function linkify(text, opts) {
  const o = opts || {};
  const raw = String(text == null ? '' : text);
  if (!raw) return '';
  const map = o.map || linkMap();
  const cap = Number.isFinite(o.cap) ? o.cap : 40;
  if (!cap || typeof o.href !== 'function') return esc(raw);
  const mm = matcher(map);
  if (!mm.re) return esc(raw);
  const used = new Set();
  let out = '', last = 0, count = 0, m;
  mm.re.lastIndex = 0;
  while ((m = mm.re.exec(raw))) {
    const hit = mm.byKey.get(m[0].toLowerCase());
    if (!hit || hit.id === o.selfId || used.has(hit.name.toLowerCase())) continue;
    if (count >= cap) break;
    const href = o.href(hit.id);
    if (!href) continue;
    used.add(hit.name.toLowerCase());
    count += 1;
    out += esc(raw.slice(last, m.index));
    out += '<a class="wlink" href="' + esc(href) + '">' + esc(m[0]) + '</a>';
    last = m.index + m[0].length;
  }
  out += esc(raw.slice(last));
  return out;
}
