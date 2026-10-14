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
  // The Miller cascade over the three-branch tree. The retracted bar sits at the
  // top of the page (inside the sticky top bar) and is the resting form: the path
  // to where the reader is, one tap from the full screen. Open, it is a left
  // column of the path walked and, beside it, the next level down.
  '.wcbar{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:4px 0;margin:0;border:0;background:none;color:var(--w-dim);font:12px system-ui;text-align:left;cursor:pointer;overflow:hidden}',
  '.wcbar:focus-visible{outline:2px solid var(--w-acc);outline-offset:2px}',
  '.wcbpath{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wcblead{color:var(--w-txt);font-weight:700}',
  '.wcbhere{color:var(--w-acc);font-weight:700}',
  '.wcsep{color:var(--w-dim)}',
  '.wcasc{position:fixed;inset:0;z-index:80;background:var(--w-bg);display:flex;flex-direction:column}',
  '.wcasc.hidden{display:none}',
  '.wcaschead{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--w-line);background:var(--w-panel)}',
  '.wcaschead .wcbpath{font-size:12px}',
  '.wcclose{width:36px;height:36px;flex:0 0 auto;border:1px solid var(--w-line);border-radius:8px;background:var(--w-panel2);color:var(--w-txt);font-size:16px;cursor:pointer}',
  '.wcpans{flex:1;display:flex;min-height:0}',
  '.wccol{width:42%;max-width:220px;flex:0 0 auto;border-right:1px solid var(--w-line);background:var(--w-panel);overflow-y:auto}',
  '.wccolrow{display:flex;align-items:center;gap:8px;padding:12px 10px;font-size:12.5px;color:var(--w-dim);border-bottom:1px solid #1b202a;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:44px}',
  '.wccolrow.on{color:var(--w-txt);font-weight:700;background:var(--w-panel2);border-left:3px solid var(--w-acc);padding-left:7px}',
  '.wcdot{width:5px;height:5px;flex:0 0 auto;border-radius:50%;background:#4e596e}',
  '.wccolrow.on .wcdot{background:var(--w-acc)}',
  '.wcpane{flex:1;min-width:0;overflow-y:auto;overscroll-behavior:contain}',
  '.wcgrp{padding:9px 12px 5px;font:10px var(--w-mono);letter-spacing:.09em;text-transform:uppercase;color:var(--w-dim)}',
  '.wcrow{display:flex;align-items:center;gap:9px;padding:11px 12px;min-height:44px;border-bottom:1px solid var(--w-line);cursor:pointer}',
  '.wcrow:active{background:var(--w-panel2)}',
  '.wcrow .wcn{flex:1;min-width:0;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.wcrow .wcc{font:10px var(--w-mono);color:var(--w-dim);border:1px solid var(--w-line);border-radius:4px;padding:1px 5px}',
  '.wcrow .wcch{flex:0 0 auto;color:var(--w-dim);font-size:12px}',
  '.wcrow.here{background:#13203a;border-left:3px solid var(--w-acc)}',
  '.wcrow.here .wcn{color:#fff;font-weight:700}',
  '.wcempty{padding:16px 12px;color:var(--w-dim);font-size:12.5px}',
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
  // The cascade behaviour, one implementation for the record pages and the ask
  // page. It reads WIKI_TREE_INDEX (the three branches) and WIKI_HERE (the
  // record's pre-computed node chain), fetches one node file only when a level is
  // opened, and pre-walks the chain only when the reader opens it on a record.
  '(function () {',
  '  var IDX = window.WIKI_TREE_INDEX, HERE = window.WIKI_HERE || null;',
  '  if (!IDX || !IDX.branches || !IDX.branches.length) return;',
  '  var BASE = window.WIKI_TREE_BASE || "";',
  '  var CACHE = {}, path = [], nodes = [], open = false, pushed = false;',
  '  var herePath = (HERE && HERE.path) || [], hereId = HERE && HERE.id;',
  '  function el(t, c, txt) { var e = document.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e; }',
  '  function loadNode(f, cb) {',
  '    if (CACHE[f]) { cb(CACHE[f]); return; }',
  '    var s = document.createElement("script");',
  '    s.src = BASE + f;',
  '    s.onload = function () { CACHE[f] = window.WIKI_TREE_NODE; cb(CACHE[f]); };',
  '    s.onerror = function () { CACHE[f] = { n: f, kids: [], recs: [] }; cb(CACHE[f]); };',
  '    document.head.appendChild(s);',
  '  }',
  '  function current() { return path.length ? nodes[nodes.length - 1] : { n: "Wiki", lvl: "root", kids: IDX.branches, recs: [] }; }',
  '  function names() { if (path.length) return path.map(function (p) { return p.n; }); if (herePath.length) return herePath.map(function (p) { return p.n; }); return []; }',
  '  function crumbs() {',
  '    var b = el("span", "wcbpath"), n = names(), i;',
  '    b.appendChild(el("span", "wcblead", "Wiki"));',
  '    for (i = 0; i < n.length; i++) { b.appendChild(el("span", "wcsep", " \u203a ")); b.appendChild(el("span", null, n[i])); }',
  '    if (herePath.length && !path.length && HERE && HERE.title) { b.appendChild(el("span", "wcsep", " \u203a ")); b.appendChild(el("span", "wcbhere", HERE.title)); }',
  '    if (!n.length) b.appendChild(el("span", "wcsep", " \u203a Browse rules"));',
  '    return b;',
  '  }',
  '  function render() {',
  '    var b = document.getElementById("wcbar"), o = document.getElementById("wcasc"), i;',
  '    if (b) { b.textContent = ""; b.appendChild(crumbs()); b.setAttribute("aria-expanded", open ? "true" : "false"); }',
  '    if (!o) return;',
  '    if (open) o.classList.remove("hidden"); else o.classList.add("hidden");',
  '    var hp = document.getElementById("wcascpath");',
  '    if (hp) { hp.textContent = ""; hp.appendChild(crumbs()); }',
  '    if (!open) return;',
  '    var col = document.getElementById("wccol"), pane = document.getElementById("wcpane");',
  '    if (!col || !pane) return;',
  '    col.textContent = "";',
  '    var levels = [{ n: "Wiki" }].concat(path);',
  '    for (i = 0; i < levels.length; i++) {',
  '      var cr = el("div", "wccolrow" + (i === levels.length - 1 ? " on" : ""));',
  '      cr.setAttribute("data-wc-jump", String(i - 1));',
  '      cr.appendChild(el("span", "wcdot"));',
  '      cr.appendChild(el("span", null, levels[i].n));',
  '      col.appendChild(cr);',
  '    }',
  '    pane.textContent = "";',
  '    pane.appendChild(level(current()));',
  '    if (hereId) { var hr = pane.querySelector(".wcrow.here"); if (hr && hr.scrollIntoView) hr.scrollIntoView({ block: "center" }); }',
  '  }',
  '  function level(node) {',
  '    var box = el("div", "wcrows"), any = false, i, j;',
  '    var kids = node.kids || [], recs = node.recs || [];',
  '    for (i = 0; i < kids.length; i++) {',
  '      var k = kids[i];',
  '      if (k.recs) {',
  '        box.appendChild(el("div", "wcgrp", k.n));',
  '        for (j = 0; j < k.recs.length; j++) { box.appendChild(recRow(k.recs[j])); any = true; }',
  '      } else { box.appendChild(nodeRow(k)); any = true; }',
  '    }',
  '    if (recs.length) {',
  '      var label = node.lvl === "faction" ? "Faction rules" : node.lvl === "detachment" ? "Detachment" : "";',
  '      if (label) box.appendChild(el("div", "wcgrp", label));',
  '      for (j = 0; j < recs.length; j++) { box.appendChild(recRow(recs[j])); any = true; }',
  '    }',
  '    if (!any) box.appendChild(el("div", "wcempty", "Nothing under this node."));',
  '    return box;',
  '  }',
  '  function nodeRow(k) {',
  '    var r = el("div", "wcrow");',
  '    r.setAttribute("data-wc-node", k.f);',
  '    r.setAttribute("data-wc-name", k.n);',
  '    r.appendChild(el("span", "wcn", k.n));',
  '    if (k.c) r.appendChild(el("span", "wcc", String(k.c)));',
  '    r.appendChild(el("span", "wcch", "\u203a"));',
  '    return r;',
  '  }',
  '  function recRow(rec) {',
  '    var r = el("div", "wcrow" + (hereId && rec.i === hereId ? " here" : ""));',
  '    r.setAttribute("data-wc-rec", rec.f);',
  '    r.appendChild(el("span", "wcn", rec.t));',
  '    return r;',
  '  }',
  '  function prewalk(done) {',
  '    var i = 0;',
  '    function step() {',
  '      if (i >= herePath.length) { done(); return; }',
  '      var k = herePath[i++];',
  '      loadNode(k.f, function (n) {',
  '        path.push({ n: k.n, f: k.f });',
  '        nodes.push(n || { n: k.n, kids: [], recs: [] });',
  '        render();',
  '        step();',
  '      });',
  '    }',
  '    step();',
  '  }',
  '  function pushOpen() { if (!pushed) { pushed = true; try { history.pushState({ wc: 1 }, ""); } catch (e) { pushed = false; } } }',
  '  function openUp() {',
  '    if (open) { render(); return; }',
  '    open = true; pushOpen();',
  '    if (herePath.length && !path.length) prewalk(function () { render(); });',
  '    render();',
  '  }',
  '  function closeUp() {',
  '    if (!open) return;',
  '    open = false; render();',
  '    if (pushed) { pushed = false; try { history.back(); } catch (e) {} }',
  '  }',
  '  function jump(at) {',
  '    if (at < 0) { path = []; nodes = []; } else { path = path.slice(0, at + 1); nodes = nodes.slice(0, at + 1); }',
  '    render();',
  '  }',
  '  function drill(f, name) {',
  '    loadNode(f, function (n) {',
  '      path.push({ n: name || f, f: f });',
  '      nodes.push(n || { n: name || f, kids: [], recs: [] });',
  '      render();',
  '    });',
  '  }',
  '  function openRec(f) {',
  '    if (!f) return;',
  '    open = false; pushed = false; render();',
  '    location.href = BASE + f;',
  '  }',
  '  function mount() {',
  '    var host = document.querySelector(".wtop") || document.querySelector("header") || document.body;',
  '    var b = el("button", "wcbar");',
  '    b.id = "wcbar"; b.type = "button"; b.setAttribute("data-wc-open", "1"); b.setAttribute("aria-label", "Open the wiki index");',
  '    host.insertBefore(b, host.firstChild);',
  '    var o = el("div", "wcasc hidden"); o.id = "wcasc";',
  '    var head = el("div", "wcaschead");',
  '    var x = el("button", "wcclose", "\u00d7"); x.type = "button"; x.setAttribute("data-wc-close", "1"); x.setAttribute("aria-label", "Close");',
  '    head.appendChild(x);',
  '    var t = el("span", "wcbpath"); t.id = "wcascpath";',
  '    head.appendChild(t);',
  '    o.appendChild(head);',
  '    var panes = el("div", "wcpans");',
  '    var col = el("nav", "wccol"); col.id = "wccol";',
  '    var pane = el("div", "wcpane"); pane.id = "wcpane";',
  '    panes.appendChild(col); panes.appendChild(pane);',
  '    o.appendChild(panes);',
  '    document.body.appendChild(o);',
  '  }',
  '  document.addEventListener("click", function (e) {',
  '    var t = e.target;',
  '    if (!t || !t.closest) return;',
  '    if (t.closest("[data-wc-open]") || t.closest("[data-toc-open]")) { e.preventDefault(); openUp(); return; }',
  '    if (t.closest("[data-wc-close]")) { e.preventDefault(); closeUp(); return; }',
  '    var j = t.closest("[data-wc-jump]"); if (j) { jump(parseInt(j.getAttribute("data-wc-jump"), 10)); return; }',
  '    var n = t.closest("[data-wc-node]"); if (n) { drill(n.getAttribute("data-wc-node"), n.getAttribute("data-wc-name")); return; }',
  '    var r = t.closest("[data-wc-rec]"); if (r) { openRec(r.getAttribute("data-wc-rec")); return; }',
  '  });',
  '  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeUp(); });',
  '  window.addEventListener("popstate", function () { if (open) { open = false; pushed = false; render(); } });',
  '  window.WIKI_CASCADE = {',
  '    state: function () { return { open: open, path: path.map(function (p) { return p.n; }), names: names(), node: current().n, fetched: Object.keys(CACHE), here: hereId || "" }; },',
  '    open: openUp,',
  '    close: closeUp,',
  '  };',
  '  mount();',
  '  render();',
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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// --- the saved page outline, the authority for the Rules chapters ------------
// workspace/rules-corpus/core-rules.html is the scraped page, and its own TOC
// (the .mw2 list) is the true tree: an i10 entry is a rulebook chapter, an i30
// one of its sections. The page body repeats the same headings in document
// order, so the chapter a record belongs to is the chapter heading in force at
// the record's anchor. The BASIC RULES / ADVANCED RULES / REFERENCE super
// headers are parts, not chapters, and are skipped.
export function coreOutline(file) {
  const at = file || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workspace', 'rules-corpus', 'core-rules.html');
  let html = '';
  try { html = fs.readFileSync(at, 'utf8'); } catch (e) { return null; }
  const re = /<h([1-4])([^>]*)>([\s\S]*?)<\/h\1>/g;
  const clean = s => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const headings = [];
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[2], text = clean(m[3]);
    const id = /(?:^|\s)id="([^"]*)"/.exec(attrs);
    const cls = /(?:^|\s)class="([^"]*)"/.exec(attrs);
    const num = /([0-9]+(?:\.[0-9]+)*)\s*$/.exec(text);
    const name = num ? text.slice(0, num.index).trim() : text;
    headings.push({ lvl: +m[1], id: id ? id[1] : '', cls: cls ? cls[1] : '', text: text, num: num ? num[1] : '', name: name });
  }
  const chaptersOf = new Array(headings.length).fill(null);
  let cur = null;
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const part = /super_header/.test(h.cls);
    const chapter = !part && (/outline_header_book/.test(h.cls) || /^[0-9]+$/.test(h.num));
    if (chapter) cur = { key: h.id || ('num:' + h.num) || h.name, name: h.name || h.text, order: i };
    chaptersOf[i] = cur;
  }
  const byAnchor = new Map(), byNum = new Map(), byName = new Map();
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h.id && !byAnchor.has(h.id)) byAnchor.set(h.id, i);
    if (h.num && !byNum.has(h.num)) byNum.set(h.num, i);
    if (h.name && !byName.has(h.name)) byName.set(h.name, i);
  }
  const chapterAt = i => (i == null || i < 0) ? null : chaptersOf[i];
  const byNumber = num => {
    if (!num) return null;
    const p = String(num).split('.');
    for (let i = p.length; i >= 1; i--) { const cand = p.slice(0, i).join('.'); if (byNum.has(cand)) return chapterAt(byNum.get(cand)); }
    return null;
  };
  const chapterCount = chaptersOf.filter((c, i) => c && c.order === i).length;
  return { headings: headings, byAnchor: byAnchor, byNum: byNum, byName: byName, chapterAt: chapterAt, byNumber: byNumber, byIdName: a => chapterAt(byAnchor.get(String(a))), byText: t => chapterAt(byName.get(String(t).trim())), chapterCount: chapterCount };
}

// The tree itself, pure: it takes the records, their page names and the faction
// wiring, so a test can build it from a mutated corpus.
export function tocTree(records, pageOf, opts) {
  const roster = opts.roster, factionOf = opts.factionOf, allianceOf = opts.allianceOf;
  const files = {};
  // record id -> the chain of nodes the cascade walks to reach it. The render
  // writes it into the record page's WIKI_HERE, so opening the cascade on a
  // record pre-walks exactly these files instead of guessing from the heading.
  const paths = new Map();
  const ent = r => ({ i: r.id, t: leafTitle(r), f: pageOf.get(r.id) || '' });

  // --- Rules -> book -> chapter -> section ----------------------------------
  // Core Rules chapters come from the saved page's own outline (coreOutline):
  // the rulebook chapters, not whatever heading string a record carries. The
  // appendix has no saved page, so its records follow the same chapters through
  // their parent (which points at a core-rules record), their ruleId, or the
  // known ancestor name in their heading. A record with none of those is
  // counted and shown under an explicit Unplaced chapter, never silently filed.
  const outline = opts.outline !== undefined ? opts.outline : coreOutline();
  const byIdAll = new Map(records.map(r => [r.id, r]));
  const chapterMemo = new Map();
  const resolveRaw = r => {
    if (!outline) return null;
    const chain = [];
    let cur = r, ch = null;
    while (cur && chain.length < 24) {
      if (chapterMemo.has(cur.id)) { ch = chapterMemo.get(cur.id); break; }
      chain.push(cur);
      const anchor = cur.anchor || (/^[^#]*#(.+)$/.exec(String(cur.url || '')) || [])[1];
      ch = anchor ? outline.byIdName(anchor) : null;
      if (!ch && cur.ruleId) ch = outline.byNumber(cur.ruleId);
      if (!ch && cur.heading) ch = outline.byText(String(cur.heading).split(' > ')[0]);
      if (!ch && cur.parent && byIdAll.has(cur.parent)) { cur = byIdAll.get(cur.parent); continue; }
      break;
    }
    for (const c of chain) chapterMemo.set(c.id, ch || null);
    return ch || null;
  };
  const resolveChapter = (r, book) => {
    const ch = resolveRaw(r);
    if (ch) return ch;
    // The 18 ability records carry no page anchor at all: they are the Core
    // Abilities content, so they join that chapter by kind rather than vanish.
    if (r.kind === 'ability') { const a = outline && outline.byText('Core Abilities'); if (a) return a; }
    // The appendix has no saved page; a record whose parent, ruleId, anchor and
    // ancestor name all miss still names its own group in its heading (the
    // [ONE SHOT] block), so that first segment becomes an appendix-local chapter.
    if (book && book.slug === 'rules-appendix') {
      const seg = String(r.heading || '').split(' > ').filter(Boolean)[0];
      if (seg) return { key: 'local:' + seg, name: seg, order: 1000 };
    }
    return null;
  };
  const bookNodes = [];
  const rulesRef = { n: 'Rules', lvl: 'branch', f: 'tree/rules.js' };
  for (const book of TREE_BOOKS) {
    const bookRef = { n: book.name, lvl: 'book', f: 'tree/rules/' + book.slug + '.js' };
    const recs = records.filter(r => r.set === 'rules' && book.sources.indexOf(r.source) !== -1);
    const chapters = new Map();
    for (const r of recs) {
      const ch = resolveChapter(r, book);
      const key = ch ? ch.key : '\u0000unplaced';
      if (!chapters.has(key)) chapters.set(key, { title: ch ? ch.name : 'Unplaced', order: ch ? ch.order : 1e9, recs: [] });
      chapters.get(key).recs.push(r);
    }
    const ordered = [...chapters.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    const used = new Set(), kids = [];
    for (const ch of ordered) {
      const slug = uniqueSlug(nodeSlug(ch.title), used);
      const file = 'tree/rules/' + book.slug + '/' + slug + '.js';
      ch.recs.sort((a, b) => String(a.heading || '').localeCompare(String(b.heading || '')));
      files[file] = { n: ch.title, lvl: 'chapter', c: ch.recs.length, recs: ch.recs.map(ent) };
      const chapterRef = { n: ch.title, lvl: 'chapter', f: file };
      for (const r of ch.recs) paths.set(r.id, [rulesRef, bookRef, chapterRef]);
      kids.push({ n: ch.title, lvl: 'chapter', c: ch.recs.length, f: file });
    }
    const file = 'tree/rules/' + book.slug + '.js';
    files[file] = { n: book.name, lvl: 'book', c: recs.length, kids: kids };
    bookNodes.push({ n: book.name, lvl: 'book', c: recs.length, f: file });
  }
  const rulesTotal = bookNodes.reduce((n, b) => n + b.c, 0);
  files['tree/rules.js'] = { n: 'Rules', lvl: 'branch', c: rulesTotal, kids: bookNodes };

  // --- Missions -> Events / Primary / Secondary -> chapter -> section -------
  // The coarse level is the decks and the event machinery, not the questions.
  // A record's first heading segment picks its part; inside a deck its second
  // segment FAQ/Errata becomes its own leaf (the annotations are not the deck);
  // the event machinery keeps its own top-level parts, and their FAQ sits with
  // the part it annotates.
  const ev = records.filter(r => r.set === 'rules' && r.source === 'event-companion');
  const partNodes = [];
  const missionsRef = { n: 'Missions', lvl: 'branch', f: 'tree/missions.js' };
  for (const part of MISSION_PARTS) {
    const recs = ev.filter(r => {
      const h = String(r.heading || '').split(' > ')[0];
      return part.heading === null ? (h !== 'Primary Mission deck' && h !== 'Secondary Mission deck') : h === part.heading;
    });
    const partFile = 'tree/missions/' + nodeSlug(part.name) + '.js';
    const partRef = { n: part.name, lvl: 'part', f: partFile };
    const chapters = new Map();
    for (const r of recs) {
      const seg = String(r.heading || '').split(' > ').filter(Boolean);
      const first = seg[0] || 'Other', second = seg[1] || '';
      const leaf = (part.name !== 'Events' && (second === 'FAQ' || second === 'Errata')) ? second : first;
      if (!chapters.has(leaf)) chapters.set(leaf, []);
      chapters.get(leaf).push(r);
    }
    const used = new Set(), kids = [];
    for (const leaf of [...chapters.keys()].sort((a, b) => a.localeCompare(b))) {
      const slug = uniqueSlug(nodeSlug(leaf), used);
      const file = 'tree/missions/' + nodeSlug(part.name) + '/' + slug + '.js';
      const list = chapters.get(leaf).sort((a, b) => String(a.heading || '').localeCompare(String(b.heading || '')));
      files[file] = { n: leaf, lvl: 'chapter', c: list.length, recs: list.map(ent) };
      const chapterRef = { n: leaf, lvl: 'chapter', f: file };
      for (const r of list) paths.set(r.id, [missionsRef, partRef, chapterRef]);
      kids.push({ n: leaf, lvl: 'chapter', c: list.length, f: file });
    }
    files[partFile] = { n: part.name, lvl: 'part', c: recs.length, kids: kids };
    partNodes.push({ n: part.name, lvl: 'part', c: recs.length, f: partFile });
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
  const factionsRef = { n: 'Factions', lvl: 'branch', f: 'tree/factions.js' };
  for (const alliance of ALLIANCE_ORDER) {
    const allianceRef = { n: alliance, lvl: 'alliance', f: 'tree/factions/' + nodeSlug(alliance) + '.js' };
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
      const facRef = { n: f.name, lvl: 'faction', f: base + '.js' };
      const detGroupRef = { n: 'Detachments', lvl: 'group', f: base + '/detachments.js' };
      const unitsRef = { n: 'Units', lvl: 'group', f: base + '/units.js' };
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
        const detRef = { n: n, lvl: 'detachment', f: file };
        for (const r of g.recs.concat(g.enh, g.strat)) paths.set(r.id, [factionsRef, allianceRef, facRef, detGroupRef, detRef]);
        detKids.push({ n: n, lvl: 'detachment', c: c, f: file, synthetic: g.synthetic ? 1 : 0 });
      }
      const detFile = base + '/detachments.js';
      const detC = detKids.reduce((n, k) => n + k.c, 0);
      files[detFile] = { n: 'Detachments', lvl: 'group', c: detC, kids: detKids };
      units.sort((a, b) => String(a.heading || '').localeCompare(String(b.heading || '')));
      const unitsFile = base + '/units.js';
      files[unitsFile] = { n: 'Units', lvl: 'group', c: units.length, recs: units.map(ent) };
      for (const r of units) paths.set(r.id, [factionsRef, allianceRef, facRef, unitsRef]);
      rules.sort((a, b) => String(a.heading || '').localeCompare(String(b.heading || '')));
      const facC = detC + units.length + rules.length;
      const facFile = base + '.js';
      files[facFile] = { n: f.name, lvl: 'faction', c: facC, recs: rules.map(ent), kids: [
        { n: 'Detachments', lvl: 'group', c: detC, f: detFile },
        { n: 'Units', lvl: 'group', c: units.length, f: unitsFile },
      ] };
      for (const r of rules) paths.set(r.id, [factionsRef, allianceRef, facRef]);
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
  return { index: index, files: files, paths: paths, outline: outline, stats: { total: records.length, placed: placed, excluded: excludedIds.length, rules: rulesTotal, missions: ev.length, factions: facTotal } };
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
    outline: coreOutline(),
  });
}