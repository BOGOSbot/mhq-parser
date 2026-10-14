#!/usr/bin/env node
'use strict';
/**
 * wiki-toc: the two-pane area tree, one implementation for both surfaces.
 *
 * The design is the chosen toc-3-twopanes mockup: a rail of areas (Core Rules and
 * the factions, with their record counts) beside the selected area's tree; a group
 * opens on the first tap and a page opens on the second - a tap on a group never
 * collapses it - and the rail collapses to the current-area chip once an area is
 * picked. The wiki render writes it as shell.js + shell-data.js, so a record page
 * still opens from a folder; the ask page loads the same two files from /wiki/.
 */

// The popup's own CSS, kept apart from the shell's: shell.css reads as two blocks,
// the top bar and then the tree, on the same palette and custom properties.
export const TOC_CSS = [
  ".wtoc{position:fixed;inset:0;z-index:60}",
  ".wtoc.hidden{display:none}",
  ".wscrim{position:absolute;inset:0;background:rgba(6,8,12,.66)}",
  ".wsheet{position:absolute;left:0;right:0;bottom:0;top:64px;background:var(--w-panel);border-top:1px solid var(--w-line);display:flex;flex-direction:column;box-shadow:0 -18px 40px rgba(0,0,0,.55)}",
  ".wshbar{padding:9px 12px 8px;border-bottom:1px solid var(--w-line);display:flex;align-items:center;gap:9px}",
  ".wshtitle{font-size:12.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}",
  ".wsub{font:10.5px var(--w-mono);color:var(--w-dim)}",
  ".wclose{margin-left:auto;width:30px;height:30px;border:1px solid var(--w-line);border-radius:7px;background:var(--w-panel2);color:var(--w-dim);font-size:13px;cursor:pointer}",
  ".wpanes{flex:1;display:flex;min-height:0}",
  ".wpanes.wrail-off .wrail{display:none}",
  ".wrail{width:132px;flex:0 0 auto;border-right:1px solid var(--w-line);background:#12161d;overflow-y:auto}",
  ".wrailhead{padding:9px 10px 6px;font:9px var(--w-mono);letter-spacing:.1em;text-transform:uppercase;color:var(--w-dim);border-bottom:1px solid #212633}",
  ".wra{display:flex;align-items:center;gap:7px;padding:10px;font-size:12px;color:#c3cbd8;border-bottom:1px solid #1b202a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}",
  ".wra .wdot{width:5px;height:5px;flex:0 0 auto;border-radius:50%;background:#4e596e}",
  ".wra.on{background:var(--w-panel);color:#fff;font-weight:700;border-left:3px solid var(--w-acc);padding-left:7px}",
  ".wra.on .wdot{background:var(--w-acc)}",
  ".wbody{flex:1;min-width:0;display:flex;flex-direction:column}",
  ".wareahdr{padding:10px 12px;border-bottom:1px solid var(--w-line);background:var(--w-panel2)}",
  ".wan{font-size:13.5px;font-weight:700}",
  ".wad{font:10px var(--w-mono);color:var(--w-dim);margin-top:3px}",
  ".wlist{flex:1;overflow-y:auto;overscroll-behavior:contain}",
  ".wrow{display:flex;align-items:center;gap:9px;padding:11px 12px;border-bottom:1px solid #212633;min-height:44px;cursor:pointer}",
  ".wgrp>.wrow{background:var(--w-panel2)}",
  ".wpage .wrow{background:var(--w-panel)}",
  ".wchev{flex:0 0 auto;width:14px;color:var(--w-dim);font-size:12px}",
  ".wgrp.wopen .wchev{transform:rotate(90deg);color:var(--w-acc)}",
  ".wglabel{flex:1;font-size:13.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".wcount{font:10px var(--w-mono);color:var(--w-dim);border:1px solid var(--w-line);border-radius:4px;padding:1px 5px}",
  ".wpdot{flex:0 0 auto;width:5px;height:5px;border-radius:50%;background:#54607a;margin:0 4px}",
  ".wplabel{flex:1;font-size:13px;color:#dbe1eb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".where{background:#13203a!important;border-left:3px solid var(--w-acc)}",
  ".where .wplabel{color:#fff;font-weight:700}",
  ".where .wpdot{background:var(--w-acc);width:7px;height:7px}",
  ".wyoutag{font:9px var(--w-mono);color:var(--w-acc);border:1px solid #2f4c78;background:#0f1a2c;border-radius:4px;padding:2px 5px}",
  ".wkids{margin-left:18px;border-left:1px solid #232a38}",
  ".wtreefoot{border-top:1px solid var(--w-line);background:var(--w-panel)}",
  ".wlbl{font:9.5px var(--w-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--w-dim);padding:8px 12px 4px}",
  ".wchips{display:flex;gap:6px;overflow-x:auto;padding:2px 12px 10px}",
  ".wchip{flex:0 0 auto;font-size:11.5px;padding:6px 10px;border-radius:999px;border:1px solid var(--w-line);background:var(--w-panel2);color:var(--w-dim);cursor:pointer}",
  ".wchip.on{color:#0b1020;background:var(--w-acc);border-color:var(--w-acc);font-weight:700}",
].join('\n');

// Each area's tree, built from the corpus and the page map. The area comes from the
// record's OWN url ('factions/adeptus-custodes'), because that is the only field
// every kind carries: a stratagem's source is 'stratagems' and its faction is empty,
// and filing it under Core Rules is the defect this fixes. Fallbacks, in order: the
// record's faction field (the card carries it), then a trailing '(Faction)' in the
// heading, which is how a faction-rule with no url still lands in its own area.
// Anything left over - the ability records and the rule ids with no url and no
// parenthetical - is a core-side record and lands in Core Rules, deliberately.
const GROUP = {
  datasheet: 'Datasheets', unitrules: 'Datasheets', stratagem: 'Stratagems',
  enhancement: 'Enhancements', detachment: 'Detachments', 'faction-rule': 'Faction rules',
  'faction-index': 'Index', rule: 'Rules', 'core-rules': 'Core rules',
  'core-stratagem': 'Core stratagems', 'rules-appendix': 'Appendix', ability: 'Abilities',
  index: 'Index', 'event-companion': 'Event companion',
};
const groupOf = r => GROUP[r.kind] || 'Other';

export function tocData(records, pageOf, factionNames, factionSlug) {
  const names = factionNames || new Map();
  const slugs = factionSlug || new Map();
  const known = new Set();
  for (const n of names.values()) known.add(String(n));
  const areaOf = r => {
    const m = /factions\/([a-z0-9-]+)/i.exec(String(r.url || ''));
    if (m) { const hit = slugs.get(m[1].toLowerCase()); if (hit) return hit; }
    if (r.faction) return String(r.faction);
    const h = /\(([^()]+)\)\s*$/.exec(String(r.heading || ''));
    if (h && known.has(h[1].trim())) return h[1].trim();
    return 'Core Rules';
  };
  const areas = new Map();
  for (const r of records) {
    const a = areaOf(r);
    if (!areas.has(a)) areas.set(a, []);
    areas.get(a).push(r);
  }
  const out = [];
  for (const [name, list] of areas) {
    const groups = new Map();
    for (const r of list) {
      const path = String(r.heading || '').split(' > ').filter(Boolean);
      const leaf = path.length ? path[path.length - 1] : (r.heading || r.id);
      const g = groupOf(r);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ i: r.id, t: leaf, f: pageOf.get(r.id) || '' });
    }
    const g = [];
    for (const [gn, pages] of groups) { pages.sort((a, b) => a.t.localeCompare(b.t)); g.push({ n: gn, c: pages.length, p: pages }); }
    g.sort((a, b) => a.n.localeCompare(b.n));
    out.push({ n: name, c: list.length, g });
  }
  out.sort((a, b) => (a.n === 'Core Rules' ? -1 : b.n === 'Core Rules' ? 1 : a.n.localeCompare(b.n)));
  // The file each area's tree lives in, so a record page loads the index and then
  // exactly one area when the popup opens - not every page in the corpus.
  for (const a of out) a.f = 'toc-' + a.n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.js';
  return { areas: out };
}

// The index a page loads up front: the areas with their counts and the file their
// tree lives in, and nothing else.
export function tocIndex(data) {
  return { areas: data.areas.map(a => ({ n: a.n, c: a.c, f: a.f })) };
}

// The behaviour, one implementation for both surfaces. The rail comes from the
// index; an area's tree is loaded when it is first opened (shell.js is small and
// shell-data.js is only the index - the 788KB payload was the thing every record
// page paid for and most page views never opened).
export const TOC_JS = [
  '(function () {',
  '  var D = window.WIKI_TOC, HERE = window.WIKI_HERE || null, OPEN = window.WIKI_TOC_OPEN || null;',
  '  if (!D || !D.areas || !D.areas.length) return;',
  '  var BASE = window.WIKI_TOC_BASE || \'\';',
  '  var root = null, entry = null, railOpen = true, opened = {};',
  '  function el(t, c, txt) { var e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; }',
  '  function entryByName(n) { for (var i = 0; i < D.areas.length; i++) if (D.areas[i].n === n) return D.areas[i]; return D.areas[0]; }',
  '  function tree() { return window.WIKI_TOC_AREA && entry && window.WIKI_TOC_AREA.n === entry.n ? window.WIKI_TOC_AREA : null; }',
  '  function hereName() { return HERE && HERE.area ? HERE.area : null; }',
  '  function hereGroup() { var t = tree(); if (!HERE || !t) return \'\'; for (var j = 0; j < t.g.length; j++) { var p = t.g[j].p; for (var k = 0; k < p.length; k++) if (p[k].i === HERE.id) return t.g[j].n; } return \'\'; }',
  '  function load(cb) {',
  '    if (tree()) { cb(); return; }',
  '    var old = document.getElementById(\'wtocdata\'); if (old) old.parentNode.removeChild(old);',
  '    var s = document.createElement(\'script\'); s.id = \'wtocdata\'; s.src = BASE + entry.f;',
  '    s.onload = function () { cb(); };',
  '    s.onerror = function () { window.WIKI_TOC_AREA = { n: entry.n, g: [] }; cb(); };',
  '    document.head.appendChild(s);',
  '  }',
  '  function build() {',
  '    root = el(\'div\', \'wtoc hidden\'); root.id = \'wtoc\';',
  '    var scrim = el(\'div\', \'wscrim\'); scrim.setAttribute(\'data-toc-close\', \'1\');',
  '    var sheet = el(\'div\', \'wsheet\');',
  '    var bar = el(\'div\', \'wshbar\');',
  '    bar.appendChild(el(\'span\', \'wshtitle\', \'Wiki\'));',
  '    bar.appendChild(el(\'span\', \'wsub\', \'two panes\'));',
  '    var x = el(\'button\', \'wclose\', \'\u00d7\'); x.type = \'button\'; x.setAttribute(\'data-toc-close\', \'1\'); x.setAttribute(\'aria-label\', \'Close\');',
  '    bar.appendChild(x);',
  '    var panes = el(\'div\', \'wpanes\'); panes.id = \'wpanes\';',
  '    var foot = el(\'div\', \'wtreefoot\'); foot.id = \'wfoot\';',
  '    sheet.appendChild(bar); sheet.appendChild(panes); sheet.appendChild(foot);',
  '    root.appendChild(scrim); root.appendChild(sheet);',
  '    document.body.appendChild(root);',
  '  }',
  '  function render() {',
  '    if (!entry) return;',
  '    var t = tree() || { n: entry.n, g: [] };',
  '    var panes = root.querySelector(\'#wpanes\');',
  '    panes.className = railOpen ? \'wpanes\' : \'wpanes wrail-off\';',
  '    var rail = el(\'nav\', \'wrail\');',
  '    rail.appendChild(el(\'div\', \'wrailhead\', \'Areas\'));',
  '    for (var i = 0; i < D.areas.length; i++) {',
  '      var a = D.areas[i];',
  '      var r = el(\'div\', \'wra\' + (a.n === entry.n ? \' on\' : \'\'));',
  '      r.setAttribute(\'data-area\', a.n);',
  '      r.appendChild(el(\'span\', \'wdot\'));',
  '      r.appendChild(el(\'span\', null, a.n));',
  '      r.appendChild(el(\'span\', \'wcount\', String(a.c)));',
  '      rail.appendChild(r);',
  '    }',
  '    var body = el(\'div\', \'wbody\');',
  '    var hdr = el(\'div\', \'wareahdr\');',
  '    hdr.appendChild(el(\'div\', \'wan\', t.n));',
  '    var pages = 0; for (var g1 = 0; g1 < t.g.length; g1++) pages += t.g[g1].c;',
  '    hdr.appendChild(el(\'div\', \'wad\', t.g.length + \' sections \u00b7 \' + pages + \' pages\'));',
  '    body.appendChild(hdr);',
  '    var list = el(\'div\', \'wlist\');',
  '    var hg = hereGroup();',
  '    if (!hg && !HERE && t.g.length) opened[t.n + \'|\' + t.g[0].n] = true;',
  '    for (var q = 0; q < t.g.length; q++) {',
  '      var g = t.g[q];',
  '      var open = !!opened[t.n + \'|\' + g.n] || g.n === hg;',
  '      var grp = el(\'div\', \'wgrp\' + (open ? \' wopen\' : \'\'));',
  '      var grow = el(\'div\', \'wrow\'); grow.setAttribute(\'data-group\', g.n);',
  '      grow.appendChild(el(\'span\', \'wchev\', \'\u25b8\'));',
  '      grow.appendChild(el(\'span\', \'wglabel\', g.n));',
  '      grow.appendChild(el(\'span\', \'wcount\', String(g.c)));',
  '      grp.appendChild(grow);',
  '      if (open) {',
  '        var kids = el(\'div\', \'wkids\');',
  '        for (var z = 0; z < g.p.length; z++) {',
  '          var p = g.p[z];',
  '          var isHere = HERE && p.i === HERE.id;',
  '          var pw = el(\'div\', \'wpage\');',
  '          var pr = el(\'div\', \'wrow\' + (isHere ? \' where\' : \'\'));',
  '          pr.setAttribute(\'data-page\', p.i);',
  '          pr.setAttribute(\'data-file\', p.f);',
  '          pr.appendChild(el(\'span\', \'wpdot\'));',
  '          pr.appendChild(el(\'span\', \'wplabel\', p.t));',
  '          if (isHere) pr.appendChild(el(\'span\', \'wyoutag\', \'You are here\'));',
  '          pw.appendChild(pr);',
  '          kids.appendChild(pw);',
  '        }',
  '        grp.appendChild(kids);',
  '      }',
  '      list.appendChild(grp);',
  '    }',
  '    body.appendChild(list);',
  '    panes.textContent = \'\';',
  '    panes.appendChild(rail);',
  '    panes.appendChild(body);',
  '    var foot = root.querySelector(\'#wfoot\');',
  '    foot.textContent = \'\';',
  '    foot.appendChild(el(\'div\', \'wlbl\', \'Area\'));',
  '    var chips = el(\'div\', \'wchips\');',
  '    var chip = el(\'button\', \'wchip on\', t.n);',
  '    chip.type = \'button\'; chip.setAttribute(\'data-rail-open\', \'1\');',
  '    chips.appendChild(chip);',
  '    foot.appendChild(chips);',
  '  }',
  '  function show() { if (!root) build(); root.classList.remove(\'hidden\'); }',
  '  function hide() { if (root) root.classList.add(\'hidden\'); }',
  '  function openAt(name) {',
  '    show();',
  '    entry = entryByName(name || hereName() || OPEN || \'Core Rules\');',
  '    load(function () {',
  '      var hg = hereGroup(); if (hg) opened[entry.n + \'|\' + hg] = true;',
  '      render();',
  '    });',
  '  }',
  '  document.addEventListener(\'click\', function (e) {',
  '    var t = e.target;',
  '    if (t && t.closest && t.closest(\'[data-toc-open]\')) { e.preventDefault(); openAt(); return; }',
  '    if (!root || !t || !t.closest) return;',
  '    if (t.closest(\'[data-toc-close]\')) { hide(); return; }',
  '    if (t.closest(\'[data-rail-open]\')) { railOpen = true; render(); return; }',
  '    var ra = t.closest(\'[data-area]\'); if (ra) { entry = entryByName(ra.getAttribute(\'data-area\')); railOpen = false; load(render); return; }',
  '    var gr = t.closest(\'[data-group]\'); if (gr) { opened[entry.n + \'|\' + gr.getAttribute(\'data-group\')] = true; render(); return; }',
  '    var pg = t.closest(\'[data-page]\'); if (pg) { var f = pg.getAttribute(\'data-file\'); if (f) location.href = f; return; }',
  '  });',
  '  document.addEventListener(\'keydown\', function (e) { if (e.key === \'Escape\') hide(); });',
  '  if (OPEN || (window.WIKI_TOC_ALWAYS)) openAt();',
  '})();',
].join('\n');

export default { TOC_CSS, TOC_JS, tocData, tocIndex, tocTree, wikiTree, pageNamer };



// ============================================================================
// The three-branch tree: Rules / Missions / Factions.
//
// Additive: the two-pane areas above keep being written, so the popup that
// consumes them is untouched. This model is the reader's path instead -
// Rules -> book -> chapter -> section; Missions -> Events / Primary / Secondary
// -> section; Factions -> Imperium / Chaos / Xenos -> faction ->
// Detachments / Units, and each detachment holds its OWN enhancements and
// stratagems. Every node is one file, loaded when the cascade opens it, so no
// view ever pulls the corpus: the index names the three branches, a branch names
// its children, and only the node a reader opens carries records.
//
// A node file is { n, lvl, c, recs, kids }: c counts the records at or under the
// node, recs are its own record entries { i, t, f } (id, title, page file), and
// kids are child refs { n, lvl, c, f } - or, for a detachment's Enhancements and
// Stratagems, an inline group { n, lvl, c, recs } because those leaves are small
// and belong to their detachment, not to a file of their own.
import { readAllCorpus } from './rules-corpus.mjs';
import { cardTables } from './unit-card.mjs';

// Alliances come from the cards' own faction keyword: IMPERIUM on the Imperium
// factions and CHAOS on the Chaos ones. 11th edition has no XENOS keyword, so a
// faction carrying neither marker is Xenos by exclusion. One measured exception,
// in this one place: Genestealer Cults carries IMPERIUM on 100 of its 139
// datasheets, all of them Brood Brothers (Astra Militarum units it can take), so
// its own identity is Xenos.
export const ALLIANCE_EXCEPTIONS = { 'Genestealer Cults': 'Xenos' };
export const ALLIANCE_ORDER = ['Imperium', 'Chaos', 'Xenos'];
export const ALLIANCE_KEYWORDS = ['Imperium', 'Chaos'];

// The books of the Rules branch. The core-stratagems decision lives here and
// nowhere else: the 54 records whose source is core-stratagems and whose url is
// the-rules/core-rules/#Core-Stratagems are a SECTION of the Core Rules page,
// not a third book, so their source is folded into this book's source list.
export const TREE_BOOKS = [
  { slug: 'core-rules', name: 'Core Rules', sources: ['core-rules', 'core-stratagems'] },
  { slug: 'rules-appendix', name: 'Rules Appendix', sources: ['rules-appendix'] },
];

// The Mission parts, measured on the event-companion page's 14 top-level parts.
// Primary is its Primary Mission deck (13), Secondary its Secondary Mission deck
// (24), and Events is the tournament machinery: Generating Command Points (14),
// Books (8, the mission FAQ), Ranking Players (6), Deployment Card Key (6),
// When Drawn (2), Pairing Players (2), Force Disposition Cards (1), Deployment
// deck (1), plus the four general parts that fit nowhere else - Welcome to the
// Warhammer Event Companion!, 'Cumulative' and 'Or' Conditions, Leaves the
// Battelefield and VP Up to a Limit (1 each). 13 + 24 + 44 = 81.
export const MISSION_PARTS = [
  { name: 'Events', heading: null },
  { name: 'Primary', heading: 'Primary Mission deck' },
  { name: 'Secondary', heading: 'Secondary Mission deck' },
];

// The page name of a record, one implementation for the render and for this
// tree: the slug carries a hash only this function knows, so a second copy
// would drift.
function hash8(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
export function pageSlug(id) { return String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) + '-' + hash8(String(id)); }
export function pageNamer(records) { const m = new Map(); for (const r of records) m.set(r.id, pageSlug(r.id) + '.html'); return m; }

// The 24 factions, in the order the tree shows them, from the card tables. UA
// (Unbound Adversaries) is not one of the 24 and is left out.
export function factionRoster(factionName, factionLink) {
  const roster = [];
  for (const [id, name] of factionName) {
    if (id === 'UA') continue;
    const m = /factions\/([a-z0-9-]+)$/i.exec(String((factionLink || new Map()).get(id) || ''));
    roster.push({ id: String(id), name: String(name), slug: m ? m[1].toLowerCase() : String(id).toLowerCase() });
  }
  roster.sort((a, b) => a.name.localeCompare(b.name));
  return roster;
}

// A record's faction, from the only fields that carry it: its own url
// (factions/<slug>), its parent (faction-index#faction-<id>), then its own id
// for a faction index page. 923 records - most unitrules - have no faction url
// and are recovered by the parent; 71 cross-faction index stubs have neither.
export function factionAssigner(roster) {
  const bySlug = new Map(roster.map(f => [f.slug, f.name]));
  const byId = new Map(roster.map(f => [f.id.toLowerCase(), f.name]));
  return r => {
    const u = /factions\/([a-z0-9-]+)/i.exec(String(r.url || ''));
    if (u && bySlug.has(u[1].toLowerCase())) return bySlug.get(u[1].toLowerCase());
    const p = /^faction-index#faction-([a-z0-9]+)(?:::\d+)?$/i.exec(String(r.parent || ''));
    if (p && byId.has(p[1].toLowerCase())) return byId.get(p[1].toLowerCase());
    const q = /^faction-index#faction-([a-z0-9]+)(?:::\d+)?$/i.exec(String(r.id || ''));
    if (q && byId.has(q[1].toLowerCase())) return byId.get(q[1].toLowerCase());
    return null;
  };
}

// The alliance of each faction, measured from the keywords on its own datasheets.
export function allianceAssigner(roster, datasheets, keywords) {
  const out = new Map();
  for (const f of roster) {
    const kws = new Set();
    for (const d of datasheets) if (d.faction_id === f.id) for (const k of (keywords.get(d.id) || [])) kws.add(String(k.keyword || '').trim());
    let a = 'Xenos';
    for (const k of ALLIANCE_KEYWORDS) if (kws.has(k)) { a = k; break; }
    if (ALLIANCE_EXCEPTIONS[f.name]) a = ALLIANCE_EXCEPTIONS[f.name];
    out.set(f.name, a);
  }
  return out;
}

// "Auric Champions (Adeptus Custodes) (1/2)" -> "Auric Champions": a detachment
// heading carries its faction and, when the page was split, a part number; the
// Detachment: line inside an enhancement or stratagem carries neither.
function stripSuffix(s) {
  let p = String(s == null ? '' : s).replace(/[\u2019']/g, "'").replace(/\s+/g, ' ').trim();
  for (let prev; p !== prev; ) { prev = p; p = p.replace(/\s*\([^)]*\)\s*$/, '').trim(); }
  return p;
}
function detachmentName(r) {
  const m = /Detachment:\s*(.+)/.exec(String(r.text || ''));
  return m ? stripSuffix(m[1]) : null;
}
function leafTitle(r) {
  const path = String(r.heading || '').split(' > ').filter(Boolean);
  return path.length ? path[path.length - 1] : String(r.id);
}
function nodeSlug(s) {
  const base = String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return base || 'node';
}
function uniqueSlug(base, used) {
  let s = base, i = 2;
  while (used.has(s)) { s = base + '-' + i; i++; }
  used.add(s);
  return s;
}

// The tree itself, pure: it takes the records, their page names and the faction
// wiring, so a test can build it from a mutated corpus.
export function tocTree(records, pageOf, opts) {
  const roster = opts.roster, factionOf = opts.factionOf, allianceOf = opts.allianceOf;
  const files = {};
  const ent = r => ({ i: r.id, t: leafTitle(r), f: pageOf.get(r.id) || '' });

  // --- Rules -> book -> chapter -> section ----------------------------------
  const bookNodes = [];
  for (const book of TREE_BOOKS) {
    const recs = records.filter(r => r.set === 'rules' && book.sources.indexOf(r.source) !== -1);
    const byHeading = new Map();
    for (const r of recs) { const h = String(r.heading || ''); if (!byHeading.has(h)) byHeading.set(h, []); byHeading.get(h).push(r); }
    // Chapter: the nearest ancestor, not a fixed depth. Walk the heading path
    // from the deepest prefix up; the first prefix that is another record's
    // heading is the chapter. "Muster Armies > Errata > X" has no record at the
    // middle prefix, so it lands under Muster Armies; a top-level heading - or a
    // core stratagem, whose heading is just its name - has no ancestor and falls
    // back to the book itself.
    const chapters = new Map();
    for (const r of recs) {
      const path = String(r.heading || '').split(' > ').filter(Boolean);
      let title = book.name, key = '\u0000book';
      for (let i = path.length - 2; i >= 0; i--) {
        const prefix = path.slice(0, i + 1).join(' > ');
        const hit = byHeading.get(prefix);
        if (hit && hit.some(x => x.id !== r.id)) { title = path[i]; key = prefix; break; }
      }
      if (!chapters.has(key)) chapters.set(key, { title: title, recs: [] });
      chapters.get(key).recs.push(r);
    }
    const used = new Set(), kids = [];
    for (const ch of chapters.values()) {
      const slug = uniqueSlug(nodeSlug(ch.title), used);
      const file = 'tree/rules/' + book.slug + '/' + slug + '.js';
      ch.recs.sort((a, b) => String(a.heading || '').localeCompare(String(b.heading || '')));
      files[file] = { n: ch.title, lvl: 'chapter', c: ch.recs.length, recs: ch.recs.map(ent) };
      kids.push({ n: ch.title, lvl: 'chapter', c: ch.recs.length, f: file });
    }
    kids.sort((a, b) => a.n.localeCompare(b.n));
    const file = 'tree/rules/' + book.slug + '.js';
    files[file] = { n: book.name, lvl: 'book', c: recs.length, kids: kids };
    bookNodes.push({ n: book.name, lvl: 'book', c: recs.length, f: file });
  }
  const rulesTotal = bookNodes.reduce((n, b) => n + b.c, 0);
  files['tree/rules.js'] = { n: 'Rules', lvl: 'branch', c: rulesTotal, kids: bookNodes };

  // --- Missions -> Events / Primary / Secondary -> section -------------------
  const ev = records.filter(r => r.set === 'rules' && r.source === 'event-companion');
  const partNodes = [];
  for (const part of MISSION_PARTS) {
    const recs = ev.filter(r => {
      const h = String(r.heading || '').split(' > ')[0];
      return part.heading === null ? (h !== 'Primary Mission deck' && h !== 'Secondary Mission deck') : h === part.heading;
    });
    const file = 'tree/missions/' + nodeSlug(part.name) + '.js';
    recs.sort((a, b) => String(a.heading || '').localeCompare(String(b.heading || '')));
    files[file] = { n: part.name, lvl: 'part', c: recs.length, recs: recs.map(ent) };
    partNodes.push({ n: part.name, lvl: 'part', c: recs.length, f: file });
  }
  files['tree/missions.js'] = { n: 'Missions', lvl: 'branch', c: ev.length, kids: partNodes };

  // --- Factions -> alliance -> faction -> Detachments / Units ---------------
  const byFaction = new Map();
  const excludedIds = [];
  for (const r of records) {
    if (r.set !== 'factions') continue;
    // The 163 index records are generated link stubs, not corpus content: 92
    // name a faction and 71 span several. They are navigation, and the tree
    // replaces them - counted and named, never silently dropped.
    if (r.kind === 'index') { excludedIds.push(r.id); continue; }
    const f = factionOf(r);
    if (!f) continue;
    if (!byFaction.has(f)) byFaction.set(f, []);
    byFaction.get(f).push(r);
  }
  const allianceNodes = [];
  for (const alliance of ALLIANCE_ORDER) {
    const facNodes = [];
    for (const f of roster.filter(x => allianceOf.get(x.name) === alliance)) {
      const recs = byFaction.get(f.name) || [];
      const rules = recs.filter(r => r.kind === 'faction-rule');
      const units = recs.filter(r => r.kind === 'datasheet' || r.kind === 'unitrules');
      const detGroups = new Map();
      for (const d of recs.filter(r => r.kind === 'detachment')) {
        const n = stripSuffix(d.heading);
        if (!detGroups.has(n)) detGroups.set(n, { name: n, recs: [], enh: [], strat: [], synthetic: false });
        detGroups.get(n).recs.push(d);
      }
      for (const r of recs.filter(r => r.kind === 'enhancement' || r.kind === 'stratagem')) {
        // The corpus marks the attachment in the record itself: "Detachment: X"
        // inside the enhancement or stratagem. A value with no detachment record
        // (Aeldari's 6 "Army Rules" stratagems) keeps its own node, marked
        // synthetic, so nothing is flattened into a pile.
        const n = detachmentName(r) || 'Army Rules';
        if (!detGroups.has(n)) detGroups.set(n, { name: n, recs: [], enh: [], strat: [], synthetic: true });
        (r.kind === 'enhancement' ? detGroups.get(n).enh : detGroups.get(n).strat).push(r);
      }
      const base = 'tree/factions/' + nodeSlug(alliance) + '/' + f.slug;
      const used = new Set(), detKids = [];
      for (const n of [...detGroups.keys()].sort((a, b) => a.localeCompare(b))) {
        const g = detGroups.get(n);
        const slug = uniqueSlug(nodeSlug(n), used);
        const file = base + '/detachments/' + slug + '.js';
        const kids = [];
        if (g.enh.length) { g.enh.sort((a, b) => String(a.heading || '').localeCompare(String(b.heading || ''))); kids.push({ n: 'Enhancements', lvl: 'group', c: g.enh.length, recs: g.enh.map(ent) }); }
        if (g.strat.length) { g.strat.sort((a, b) => String(a.heading || '').localeCompare(String(b.heading || ''))); kids.push({ n: 'Stratagems', lvl: 'group', c: g.strat.length, recs: g.strat.map(ent) }); }
        g.recs.sort((a, b) => String(a.heading || '').localeCompare(String(b.heading || '')));
        const c = g.recs.length + g.enh.length + g.strat.length;
        files[file] = { n: n, lvl: 'detachment', c: c, recs: g.recs.map(ent), kids: kids, synthetic: g.synthetic ? 1 : 0 };
        detKids.push({ n: n, lvl: 'detachment', c: c, f: file, synthetic: g.synthetic ? 1 : 0 });
      }
      const detFile = base + '/detachments.js';
      const detC = detKids.reduce((n, k) => n + k.c, 0);
      files[detFile] = { n: 'Detachments', lvl: 'group', c: detC, kids: detKids };
      units.sort((a, b) => String(a.heading || '').localeCompare(String(b.heading || '')));
      const unitsFile = base + '/units.js';
      files[unitsFile] = { n: 'Units', lvl: 'group', c: units.length, recs: units.map(ent) };
      rules.sort((a, b) => String(a.heading || '').localeCompare(String(b.heading || '')));
      const facC = detC + units.length + rules.length;
      const facFile = base + '.js';
      files[facFile] = { n: f.name, lvl: 'faction', c: facC, recs: rules.map(ent), kids: [
        { n: 'Detachments', lvl: 'group', c: detC, f: detFile },
        { n: 'Units', lvl: 'group', c: units.length, f: unitsFile },
      ] };
      facNodes.push({ n: f.name, lvl: 'faction', c: facC, f: facFile });
    }
    facNodes.sort((a, b) => a.n.localeCompare(b.n));
    const file = 'tree/factions/' + nodeSlug(alliance) + '.js';
    const c = facNodes.reduce((n, k) => n + k.c, 0);
    files[file] = { n: alliance, lvl: 'alliance', c: c, kids: facNodes };
    allianceNodes.push({ n: alliance, lvl: 'alliance', c: c, f: file });
  }
  const facTotal = allianceNodes.reduce((n, k) => n + k.c, 0);
  files['tree/factions.js'] = { n: 'Factions', lvl: 'branch', c: facTotal, kids: allianceNodes };

  const placed = rulesTotal + ev.length + facTotal;
  const index = {
    v: 1, n: 'Wiki', total: records.length, placed: placed,
    branches: [
      { n: 'Rules', lvl: 'branch', c: rulesTotal, f: 'tree/rules.js' },
      { n: 'Missions', lvl: 'branch', c: ev.length, f: 'tree/missions.js' },
      { n: 'Factions', lvl: 'branch', c: facTotal, f: 'tree/factions.js' },
    ],
    excluded: excludedIds.length ? [{ k: 'index', c: excludedIds.length, why: 'navigation stubs, not corpus content' }] : [],
  };
  return { index: index, files: files, stats: { total: records.length, placed: placed, excluded: excludedIds.length, rules: rulesTotal, missions: ev.length, factions: facTotal } };
}

// The real corpus, wired once: the render and the tests both call this, so there
// is one implementation of the branches.
export function wikiTree(records) {
  const all = records || readAllCorpus();
  const t = cardTables();
  const roster = factionRoster(t.factionName, t.factionLink);
  return tocTree(all, pageNamer(all), {
    roster: roster,
    factionOf: factionAssigner(roster),
    allianceOf: allianceAssigner(roster, t.datasheets, t.keywords),
  });
}
