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
  // The reader's language, when they have chosen one. A ruling shows the French
  // source by default and reveals the machine translation only when the reader
  // explicitly asked for English: data-lang, not lang, so a page the reader has
  // not expressed a preference on never claims one.
  "(function () { try { var l = localStorage.getItem('rulesLang'); if (l === 'en' || l === 'fr') document.documentElement.dataset.lang = l; } catch (e) { /* private mode */ } })();",
  // The cascade behaviour, one implementation for the record pages and the ask
  // page. It reads WIKI_TREE_INDEX (the three branches) and WIKI_HERE (the
  // record's pre-computed node chain), fetches one node file only when a level is
  // opened, and pre-walks the chain only when the reader opens it on a record.
  '(function () {',
  '  var IDX = window.WIKI_TREE_INDEX, HERE = window.WIKI_HERE || null;',
  '  if (!IDX || !IDX.branches || !IDX.branches.length) return;',
  '  var BASE = window.WIKI_TREE_BASE || "";',
  '  var CACHE = {}, path = [], nodes = [], open = false, pushed = false;',
  '  var herePath = (HERE && HERE.path) || [], hereId = HERE && (HERE.at || HERE.id);',
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
  '    if (k.pg) { r.setAttribute("data-wc-rec", k.pg); r.appendChild(el("span", "wcn", k.n)); if (k.c) r.appendChild(el("span", "wcc", String(k.c))); r.appendChild(el("span", "wcch", "\u203a")); return r; }',
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
  '    if (rec.q) r.appendChild(el("span", "wcc", String(rec.q)));',
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
import { readAllCorpus, isDelivered } from './rules-corpus.mjs';
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
// pageSlug is the OLD name, kept only to build the redirect map: <kind>_<id>-<hash>
// was served in the wild (traces, docs, bookmarks) and has to keep resolving.
export function pageSlug(id) { return String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) + '-' + hash8(String(id)); }

// The page a record gets now: readable first (its kind and its title), stable
// last (the id hash keeps two records with the same title apart and keeps the URL
// when a heading is edited). The old name led with the id, which says nothing.
export function pageTitleSlug(record) {
  const r = record || {};
  // The heading's own leaf, not leafTitle's id fallback: an untitled record is
  // named by its kind and the id hash, never by a positional id in the path.
  const leaf = String(r.heading || '').split(' > ').filter(Boolean).pop() || '';
  const slug = (String(r.kind || 'record') + '-' + cleanTitle(leaf))
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return slug || 'record';
}
export function pageName(record) { return pageTitleSlug(record) + '-' + hash8(String((record && record.id) || '')) + '.html'; }
export function pageNamer(records) { const m = new Map(); for (const r of records) m.set(r.id, pageName(r)); return m; }

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
// A record split into parts carries " (1/2)" in its title and a unitrules twin
// carries " - keywords and abilities": both are markers, not names.
export function cleanTitle(t) {
  return String(t).replace(/\s*\(\d+\/\d+\)$/, '').replace(/\s*-\s*keywords and abilities(\s*\(\d+\/\d+\))?$/i, '');
}

// One rule for what an annotation is, in one place: a kind-rule record whose
// heading names a FAQ, Errata, Duplicated Abilities or [TORRENT] block, or whose
// heading carries a question. A question segment is one ending in "?", one
// starting with the "Q:" label, or one under a FAQ block. The label is NOT
// required - 64 of the questions have no "Q:" and 28 of those do not even end in
// "?" (the corpus truncates them with "...") - but where it exists it is the
// only signal left. Non-rule records are never annotations (a stratagem named
// "WHERE D'YA FINK YOU'RE GOING?" is a name).
export function headingSegments(r) { return String(r.heading || '').split(' > ').filter(Boolean); }
export function isAnnotation(r) {
  if (r.kind !== 'rule') return false;
  for (const seg of headingSegments(r)) {
    const x = String(seg).trim();
    if (/^FAQ$/i.test(x) || /^Errata$/i.test(x) || /^Duplicated Abilities$/i.test(x) || /^\[TORRENT\]$/i.test(x) || /^Q:/i.test(x) || /\?\s*$/.test(x)) return true;
  }
  return false;
}

// An update names the rule it updates by number ('12.08 - Consolidation Move…'):
// that number is its join key, the way a Q&A's own heading is. Only the leaf's
// leading number counts, and only the rule-number form (12.08, 01.02.06).
export function updateRuleNumber(r) {
  const leaf = String(headingSegments(r).slice(-1)[0] || '').trim();
  const m = /^(\d{2}(?:\.\d{2}){1,2})\b/.exec(leaf);
  return m ? m[1] : '';
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
    if (chapter) cur = { key: h.id || ('num:' + h.num) || h.name, name: h.name || h.text, num: h.num || '', order: i };
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
  // A record the importer split into parts ("~2") is one record, not two rows:
  // the parts group by base id, the first is the row, and the rest fold onto its
  // page. Also collected: what the edition filter removed, what was merged, and
  // the synthetic one-page collections.
  const filteredIds = [], mergedIds = [], mergedHere = [], pages = [];
  const owned = new Map(), mergedOn = new Map();
  const baseOf = id => String(String(id).split('#')[1] || '').split('~')[0];
  const primaryOf = list => {
    const m = new Map();
    for (const r of list) { const n = baseOf(r.id); if (!m.has(n)) m.set(n, []); m.get(n).push(r); }
    const out = [];
    for (const g of m.values()) {
      g.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      out.push(g[0]);
      if (g.length > 1) {
        mergedOn.set(g[0].id, g.slice(1).map(x => x.id));
        for (const x of g.slice(1)) { mergedIds.push(x.id); mergedHere.push(x.id); }
      }
    }
    return out;
  };
  const ent = r => ({ i: r.id, t: cleanTitle(leafTitle(r)), f: pageOf.get(r.id) || '' });

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
  // An annotation is not a section: it attaches to the section it annotates.
  // Target, in order: the parent chain's nearest non-annotation record; the
  // longest heading prefix that is a section; the nearest earlier section with
  // the same first heading segment (the entry an errata annotates sits above
  // it). No target means unattached, counted per book, never invented.
  // The record an update names, by its number: a rule carrying that ruleId, else
  // the numbered section whose own leaf leads with it. An update is not its own
  // target (it is an annotation), so the map is built from sections and rules.
  const targetByNumber = new Map();
  const noteNumber = (r, n) => { if (n && !targetByNumber.has(n)) targetByNumber.set(n, r); };
  for (const r of records) if (r.ruleId) noteNumber(r, String(r.ruleId));
  for (const r of records) if (!isAnnotation(r)) noteNumber(r, updateRuleNumber(r));
  const attach = new Map();
  const attachTarget = new Map();
  const unattached = [];
  let annotationTotal = 0;
  const fold = bookRecs => {
    const annotations = bookRecs.filter(isAnnotation);
    annotationTotal += annotations.length;
    const sections = bookRecs.filter(r => !isAnnotation(r));
    const bySectionHeading = new Map();
    for (const r of sections) if (!bySectionHeading.has(r.heading)) bySectionHeading.set(r.heading, r);
    const pos = new Map(bookRecs.map((r, i) => [r.id, i]));
    const keptVisible = [];
    for (const a of annotations) {
      // An update's number is its join key and is tried first. When the number has
      // no target the update does NOT fall back to a nearby section: it stays a
      // row of its own, labelled by the number it names, never silently tucked
      // into a rule it does not update.
      const un = updateRuleNumber(a);
      let target = un ? (targetByNumber.get(un) || null) : null;
      if (!target && !un) {
        let cur = a.parent ? byIdAll.get(a.parent) : null, guard = 0;
        while (cur && guard++ < 24) { if (!isAnnotation(cur)) { target = cur; break; } cur = cur.parent ? byIdAll.get(cur.parent) : null; }
      }
      if (!target && !un) {
        const seg = headingSegments(a);
        for (let i = seg.length - 1; i >= 1; i--) { const pre = seg.slice(0, i).join(' > '); const hit = bySectionHeading.get(pre); if (hit) { target = hit; break; } }
      }
      if (!target && !un) {
        const first = headingSegments(a)[0], at = pos.get(a.id);
        for (let i = at - 1; i >= 0; i--) { const c = bookRecs[i]; if (isAnnotation(c)) continue; if (headingSegments(c)[0] === first) { target = c; break; } }
      }
      if (!target) {
        if (un) { keptVisible.push(a); annotationTotal -= 1; }
        else unattached.push(a);
        continue;
      }
      if (!attach.has(target.id)) attach.set(target.id, []);
      attach.get(target.id).push(a);
      attachTarget.set(a.id, target.id);
    }
    return { sections: sections.concat(keptVisible), annotations: annotations };
  };

  // Core-stratagem records that are not stratagems, by their OWN Type line: the
  // 15 "Movement Ability" and 7 "Shooting Ability" records are move/shoot type
  // definitions whose text names the chapter they belong to ("as described in
  // Moving (03)", "... Making Attacks (04)"), so they go to those chapters. The 9
  // "Challenger" records are mission-format stratagems with no core home and no
  // detachment, so they join the event machinery as Missions > Events >
  // Challenger. Core Rules > Stratagems keeps only the core stratagems.
  const stratType = r => (/Type:\s*(.+)/.exec(String(r.text || '')) || [])[1] || '';
  const forcedChapter = new Map();
  const challengers = [];
  for (const r of records) {
    if (r.source !== 'core-stratagems' || r.kind !== 'stratagem') continue;
    const ty = stratType(r);
    if (/^Movement Ability/i.test(ty)) forcedChapter.set(r.id, '03');
    else if (/^Shooting Ability/i.test(ty)) forcedChapter.set(r.id, '04');
    else if (/^Challenger/i.test(ty)) challengers.push(r);
  }
  const challengerIds = new Set(challengers.map(r => r.id));
  const childrenOf = new Map();
  const bookNodes = [];
  const rulesRef = { n: 'Rules', lvl: 'branch', f: 'tree/rules.js' };
  const unattachedBooks = {};
  const dropped = [];
  let uruRecord = null;
  // A chapter's number is the leading integer of its records' ruleIds (the page
  // outline's own number agrees); 00 sorts after 25, an unnumbered chapter - the
  // appendix's local [ONE SHOT] - after that.
  const chapterNum = (ch, recs) => {
    if (ch && ch.num) return ch.num;
    const counts = new Map();
    for (const r of recs) { const m = /^(\d+)/.exec(String(r.ruleId || '')); if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1); }
    let best = '', n = 0;
    for (const [k, v] of counts) if (v > n) { best = k; n = v; }
    return best;
  };
  const chapterLabel = (num, title) => (num ? String(num).padStart(2, '0') + ' ' : '') + title;
  const chapterRank = ch => ch.num === '' ? 300 : (ch.num === '00' ? 200 : parseInt(ch.num, 10));
  for (const book of TREE_BOOKS) {
    const bookRef = { n: book.name, lvl: 'book', f: 'tree/rules/' + book.slug + '.js' };
    const bookRecs = records.filter(r => r.set === 'rules' && book.sources.indexOf(r.source) !== -1 && !challengerIds.has(r.id));
    const before = unattached.length, beforeDropped = dropped.length;
    const folded = fold(bookRecs);
    unattachedBooks[book.slug] = unattached.length - before;
    // Universal Rules Updates is the 00 chapter at the end of the Rules branch.
    const u = folded.sections.findIndex(r => r.id.indexOf('Universal-Rules-Updates') !== -1);
    if (u >= 0) uruRecord = folded.sections.splice(u, 1)[0];
    const chapters = new Map();
    for (const r of folded.sections) {
      const forced = forcedChapter.has(r.id) ? (outline && outline.byNumber(forcedChapter.get(r.id))) : null;
      const ch = forced || resolveChapter(r, book);
      // Books is the edition/history front matter, not a chapter.
      if (ch && ch.key === 'Books') { dropped.push(r); continue; }
      const key = ch ? ch.key : '\u0000unplaced';
      if (!chapters.has(key)) chapters.set(key, { title: ch ? ch.name : 'Unplaced', num: ch ? (ch.num || '') : '', order: ch ? ch.order : 1e9, recs: [] });
      chapters.get(key).recs.push(r);
    }
    for (const ch of chapters.values()) ch.num = chapterNum(ch, ch.recs);
    const ordered = [...chapters.values()].sort((a, b) => chapterRank(a) - chapterRank(b) || a.title.localeCompare(b.title));
    const used = new Set(), kids = [];
    for (const ch of ordered) {
      const slug = uniqueSlug(nodeSlug(ch.title), used);
      const file = 'tree/rules/' + book.slug + '/' + slug + '.js';
      const label = chapterLabel(ch.num, ch.title);
      const rows = primaryOf(ch.recs).sort((a, b) => String(a.heading || '').localeCompare(String(b.heading || '')));
      // A subsection is never a sibling of its own parent: within a chapter, a
      // section whose heading extends another section's heading nests under it.
      const parentOfSection = new Map(), nestedSection = new Set();
      for (const r of rows) {
        const h = String(r.heading || '');
        let best = null, bestLen = -1;
        for (const o of rows) {
          if (o.id === r.id) continue;
          const oh = String(o.heading || '');
          if (oh && h.indexOf(oh + ' > ') === 0 && oh.length > bestLen) { best = o; bestLen = oh.length; }
        }
        if (best) { parentOfSection.set(r.id, best.id); nestedSection.add(r.id); }
      }
      for (const r of rows) {
        const subs = rows.filter(x => parentOfSection.get(x.id) === r.id).map(x => x.id);
        if (subs.length) childrenOf.set(r.id, subs);
      }
      let counted = ch.recs.reduce((n, r) => n + 1 + (attach.get(r.id) || []).length, 0);
      const entryFor = r => {
        const q = (attach.get(r.id) || []).length;
        const e = ent(r);
        if (q) e.q = q;
        const subs = rows.filter(x => parentOfSection.get(x.id) === r.id);
        if (subs.length) e.s = subs.map(entryFor);
        return e;
      };
      const list = rows.filter(r => !nestedSection.has(r.id)).map(entryFor);
      files[file] = { n: label, lvl: 'chapter', c: counted, recs: list };
      const chapterRef = { n: label, lvl: 'chapter', f: file };
      for (const r of ch.recs) {
        paths.set(r.id, [rulesRef, bookRef, chapterRef]);
        for (const a of (attach.get(r.id) || [])) paths.set(a.id, [rulesRef, bookRef, chapterRef]);
      }
      kids.push({ n: label, lvl: 'chapter', c: counted, f: file });
    }
    const bookC = bookRecs.length - (unattached.length - before) - (dropped.length - beforeDropped) - (u >= 0 ? 1 : 0);
    const file = 'tree/rules/' + book.slug + '.js';
    files[file] = { n: book.name, lvl: 'book', c: bookC, kids: kids };
    bookNodes.push({ n: book.name, lvl: 'book', c: bookC, f: file });
  }
  // The 00 chapter, at the Rules level after the two books.
  if (uruRecord) {
    const q = (attach.get(uruRecord.id) || []).length;
    const counted = 1 + q;
    const file = 'tree/rules/universal-rules-updates.js';
    const e = ent(uruRecord);
    if (q) e.q = q;
    files[file] = { n: '00 Universal Rules Updates', lvl: 'chapter', c: counted, recs: [e] };
    const uruRef = { n: '00 Universal Rules Updates', lvl: 'chapter', f: file };
    paths.set(uruRecord.id, [rulesRef, uruRef]);
    for (const a of (attach.get(uruRecord.id) || [])) paths.set(a.id, [rulesRef, uruRef]);
    bookNodes.push({ n: '00 Universal Rules Updates', lvl: 'chapter', c: counted, f: file });
  }
  const rulesTotal = bookNodes.reduce((n, b) => n + b.c, 0);
  files['tree/rules.js'] = { n: 'Rules', lvl: 'branch', c: rulesTotal, kids: bookNodes };

  // --- Missions -> Events / Primary / Secondary -> chapter -> section -------
  // The coarse level is the decks and the event machinery, not the questions.
  // Folding happens first, so no FAQ/Errata/question is a section here either;
  // a record's first heading segment still picks its part and its chapter.
  const ev = records.filter(r => r.set === 'rules' && r.source === 'event-companion');
  const beforeM = unattached.length;
  const foldedM = fold(ev);
  const missionsUnattached = () => unattached.length - beforeM;
  unattachedBooks['event-companion'] = missionsUnattached();
  // The 9 Challenger mission stratagems join Events as one chapter.
  const evSections = foldedM.sections.concat(challengers);
  const partNodes = [];
  const missionsRef = { n: 'Missions', lvl: 'branch', f: 'tree/missions.js' };
  for (const part of MISSION_PARTS) {
    const recs = evSections.filter(r => {
      if (challengerIds.has(r.id)) return part.name === 'Events';
      const h = String(r.heading || '').split(' > ')[0];
      return part.heading === null ? (h !== 'Primary Mission deck' && h !== 'Secondary Mission deck') : h === part.heading;
    });
    const partFile = 'tree/missions/' + nodeSlug(part.name) + '.js';
    const partRef = { n: part.name, lvl: 'part', f: partFile };
    const chapters = new Map();
    for (const r of recs) {
      const first = challengerIds.has(r.id) ? 'Challenger' : (headingSegments(r)[0] || 'Other');
      if (!chapters.has(first)) chapters.set(first, []);
      chapters.get(first).push(r);
    }
    const used = new Set(), kids = [];
    for (const leaf of [...chapters.keys()].sort((a, b) => a.localeCompare(b))) {
      const slug = uniqueSlug(nodeSlug(leaf), used);
      const file = 'tree/missions/' + nodeSlug(part.name) + '/' + slug + '.js';
      const list = chapters.get(leaf).sort((a, b) => String(a.heading || '').localeCompare(String(b.heading || '')));
      const counted = list.reduce((n, r) => n + 1 + (attach.get(r.id) || []).length, 0);
      const rows = primaryOf(list).map(r => {
        const q = (attach.get(r.id) || []).length;
        const e = ent(r);
        if (q) e.q = q;
        return e;
      });
      files[file] = { n: leaf, lvl: 'chapter', c: counted, recs: rows };
      const chapterRef = { n: leaf, lvl: 'chapter', f: file };
      for (const r of list) {
        paths.set(r.id, [missionsRef, partRef, chapterRef]);
        for (const a of (attach.get(r.id) || [])) paths.set(a.id, [missionsRef, partRef, chapterRef]);
      }
      kids.push({ n: leaf, lvl: 'chapter', c: counted, f: file });
    }
    const partC = recs.reduce((n, r) => n + 1 + (attach.get(r.id) || []).length, 0);
    files[partFile] = { n: part.name, lvl: 'part', c: partC, kids: kids };
    partNodes.push({ n: part.name, lvl: 'part', c: partC, f: partFile });
  }
  const missionsC = ev.length + challengers.length - missionsUnattached();
  files['tree/missions.js'] = { n: 'Missions', lvl: 'branch', c: missionsC, kids: partNodes };

  // --- Factions -> alliance -> faction -> Army rules / Detachments / Units ---
  // Two filters and one merge, all on the record's own Source line:
  //  - edition 0 is the Legends / Forge World lines, and the importer stamps it
  //    on every record (rules-corpus.mjs); the whole line leaves the tree, every
  //    kind, not just the datasheets. A legacy datasheet's unitrules twin is
  //    edition 0 itself, so it leaves with it.
  //  - unitrules#<n> pairs with datasheet#<n>: one page per datasheet. The card
  //    already carries the keywords and the abilities, so the merged record
  //    contributes nothing the page does not already show; it is kept on the
  //    page as a collapsed section, not as a row. A unitrules with no datasheet
  //    stays a unit of its own.
  //  - the 10th-edition Strands of Fate is dropped by id inside that predicate
  //    (the corpus puts no edition marker on any of its 63 faction rules).
  // ONE predicate for "does this record exist in the product" (rules-corpus.mjs):
  // the index build and the render read the same one, so neither re-derives it.
  const LEGACY = r => !isDelivered(r);
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
  const sorter = (a, b) => String(a.heading || '').localeCompare(String(b.heading || ''));
  const factionsRef = { n: 'Factions', lvl: 'branch', f: 'tree/factions.js' };
  for (const alliance of ALLIANCE_ORDER) {
    const allianceRef = { n: alliance, lvl: 'alliance', f: 'tree/factions/' + nodeSlug(alliance) + '.js' };
    const facNodes = [];
    for (const f of roster.filter(x => allianceOf.get(x.name) === alliance)) {
      const recs = byFaction.get(f.name) || [];
      // Every edition-0 record leaves, whatever its kind; the tree consumes what
      // the importer stamped rather than re-reading the text for a marker.
      const inScope = recs.filter(r => !LEGACY(r));
      for (const r of recs) if (LEGACY(r)) filteredIds.push(r.id);
      const base = 'tree/factions/' + nodeSlug(alliance) + '/' + f.slug;
      const facRef = { n: f.name, lvl: 'faction', f: base + '.js' };
      // Army rules: the faction-rule records and the "Detachment: Army Rules"
      // stratagems, collected on one synthetic page with no subsection beneath.
      const rules = [];
      for (const r of inScope.filter(r => r.kind === 'faction-rule').sort(sorter)) rules.push(r);
      const detGroups = new Map();
      for (const d of inScope.filter(r => r.kind === 'detachment')) {
        const n = stripSuffix(d.heading);
        if (!detGroups.has(n)) detGroups.set(n, { name: n, recs: [], enh: [], strat: [] });
        detGroups.get(n).recs.push(d);
      }
      for (const r of inScope.filter(r => r.kind === 'enhancement' || r.kind === 'stratagem')) {
        // The corpus marks the attachment in the record itself: "Detachment: X".
        // "Army Rules" is not a detachment: it goes on the faction's army-rules
        // page. No faction record has an empty Detachment value (measured).
        const n = detachmentName(r);
        if (!n || n === 'Army Rules') { rules.push(r); continue; }
        if (!detGroups.has(n)) detGroups.set(n, { name: n, recs: [], enh: [], strat: [] });
        (r.kind === 'enhancement' ? detGroups.get(n).enh : detGroups.get(n).strat).push(r);
      }
      // Units: one row per datasheet, the legacy rows out, the twins merged. A
      // record split into parts ("~2") is not a second unit: the base id groups
      // them and the extra parts fold onto the one page.
      const baseOf = id => String(String(id).split('#')[1] || '').split('~')[0];
      const groupByBase = list => { const m = new Map(); for (const r of list) { const n = baseOf(r.id); if (!m.has(n)) m.set(n, []); m.get(n).push(r); } return m; };
      const dsGroups = groupByBase(inScope.filter(r => r.kind === 'datasheet').sort(sorter));
      const urGroups = groupByBase(inScope.filter(r => r.kind === 'unitrules').sort(sorter));
      const units = [];
      let mergedC = 0;
      for (const n of [...dsGroups.keys()].sort()) {
        const parts = dsGroups.get(n), d = parts[0];
        units.push(d);
        const extras = parts.slice(1).concat(urGroups.get(n) || []);
        if (extras.length) {
          mergedOn.set(d.id, extras.map(x => x.id));
          for (const x of extras) { mergedIds.push(x.id); mergedHere.push(x.id); }
          mergedC += extras.length;
        }
      }
      for (const n of [...urGroups.keys()].sort()) {
        if (dsGroups.has(n)) continue;
        const parts = urGroups.get(n), u = parts[0];
        units.push(u);
        if (parts.length > 1) {
          mergedOn.set(u.id, parts.slice(1).map(x => x.id));
          for (const x of parts.slice(1)) { mergedIds.push(x.id); mergedHere.push(x.id); }
          mergedC += parts.length - 1;
        }
      }
      // Detachments: one page per detachment record; its enhancements and
      // stratagems live on that page, and nothing nests beneath either.
      const detGroupRef = { n: 'Detachments', lvl: 'group', f: base + '/detachments.js' };
      const detRows = [];
      const usedDet = new Set();
      let detC = 0;
      for (const n of [...detGroups.keys()].sort((a, b) => a.localeCompare(b))) {
        const g = detGroups.get(n);
        g.enh.sort(sorter); g.strat.sort(sorter); g.recs.sort(sorter);
        const c = g.recs.length + g.enh.length + g.strat.length;
        detC += c;
        const d = g.recs[0];
        if (d) {
          owned.set(d.id, { name: n, enh: g.enh.map(r => r.id), strat: g.strat.map(r => r.id) });
          detRows.push({ i: d.id, t: n, f: pageOf.get(d.id) || '', q: c });
          for (const r of g.recs) paths.set(r.id, [factionsRef, allianceRef, facRef, detGroupRef]);
        } else {
          // A Detachment value with no detachment record still gets one page: a
          // synthetic page holding what it owns. The corpus has none today (only
          // "Army Rules", which is not a detachment); this is the guard rail.
          const file = base + '/detachment-' + uniqueSlug(nodeSlug(n), usedDet) + '.html';
          pages.push({ f: file, n: n, lvl: 'detachment', area: f.name, path: [factionsRef, allianceRef, facRef], recs: g.enh.concat(g.strat).map(r => r.id) });
          detRows.push({ i: 'page:' + file, t: n, f: file, q: c });
        }
        for (const r of g.enh.concat(g.strat)) paths.set(r.id, [factionsRef, allianceRef, facRef, detGroupRef]);
      }
      files[base + '/detachments.js'] = { n: 'Detachments', lvl: 'group', c: detC, recs: detRows };
      const unitsRef = { n: 'Units', lvl: 'group', f: base + '/units.js' };
      files[base + '/units.js'] = { n: 'Units', lvl: 'group', c: units.length, recs: units.map(ent) };
      for (const r of units) paths.set(r.id, [factionsRef, allianceRef, facRef, unitsRef]);
      // A merged twin still has a page: it pre-walks to the Units level too.
      for (const u of mergedHere) paths.set(u, [factionsRef, allianceRef, facRef, unitsRef]);
      let army = null;
      if (rules.length) {
        const armyFile = base + '/army-rules.html';
        army = { n: 'Army rules', lvl: 'army-rules', c: rules.length, f: armyFile };
        pages.push({ f: armyFile, n: 'Army rules', lvl: 'army-rules', area: f.name, path: [factionsRef, allianceRef, facRef], recs: rules.map(r => r.id) });
      }
      for (const r of rules) paths.set(r.id, [factionsRef, allianceRef, facRef]);
      const facC = detC + units.length + rules.length + mergedC;
      const facFile = base + '.js';
      files[facFile] = { n: f.name, lvl: 'faction', c: facC, recs: [], kids: [
        ...(army ? [{ n: army.n, lvl: army.lvl, c: army.c, pg: army.f }] : []),
        { n: 'Detachments', lvl: 'group', c: detC, f: base + '/detachments.js' },
        { n: 'Units', lvl: 'group', c: units.length, f: base + '/units.js' },
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

  // --- Rulings -> document -> topic/type -> facet/faction ---------------------
  // Third-party tournament interpretations, not Games Workshop text. The product
  // exists so a player can show a card to an opponent, and misattribution is the
  // one failure mode we cannot ship: so every record carries its provenance
  // verbatim and the card says, in the banner, whose words these are.
  //
  // Mandal overruled the fourth branch: the two documents sit directly under
  // Rules, as a chapter of the branch. The guarantee is not distance from the
  // rulebook - it is the provenance label, which the branch move does not touch.
  // Scope still separates the answer sets: 'game' is the default listing, and
  // 'event' (conduct, modelling) and 'tip' (Did you know) are labelled and
  // sorted after it.
  const rulingRecs = records.filter(r => r.set === 'rulings' && !LEGACY(r));
  const rulingsRef = { n: 'Rulings', lvl: 'chapter', f: 'tree/rulings.js' };
  const scopeLabel = (topic, scope) => scope === 'event' ? topic + ' \u2014 event conduct (not game rules)'
    : scope === 'tip' ? topic + ' \u2014 tips (not game rules)' : topic;
  const fileSafe = s => nodeSlug(String(s || 'Other')) || 'other';
  const docNodes = [];
  for (const doc of [
    { key: 'wtc', n: 'WTC 11th Edition FAQ', file: 'tree/rulings/wtc.js' },
    { key: 'feq', n: 'FEQ 40K FAQ', file: 'tree/rulings/feq.js' },
  ]) {
    const docRecs = rulingRecs.filter(r => String(r.id).indexOf(doc.key + '11-') === 0);
    const docRef = { n: doc.n, lvl: 'doc', f: doc.file };
    const firstOf = r => doc.key === 'wtc' ? (r.provenance.topic || 'Other') : (r.provenance.type_norm || 'Other');
    const secondOf = r => doc.key === 'wtc' ? (r.provenance.facet || 'Other') : (r.provenance.faction || 'General');
    const groups = new Map();
    for (const r of docRecs) {
      const a = firstOf(r);
      if (!groups.has(a)) groups.set(a, new Map());
      const b = secondOf(r);
      if (!groups.get(a).has(b)) groups.get(a).set(b, []);
      groups.get(a).get(b).push(r);
    }
    const rank = a => Math.max(...[...groups.get(a).values()].flat().map(r => (r.provenance.scope === 'game' ? 0 : 1)));
    const usedFirst = new Set(), kids = [];
    for (const a of [...groups.keys()].sort((x, y) => rank(x) - rank(y) || x.localeCompare(y))) {
      const aRecs = [...groups.get(a).values()].flat();
      const scope = aRecs.some(r => r.provenance.scope === 'game') ? 'game' : (aRecs[0].provenance.scope || '');
      const aLabel = doc.key === 'wtc' ? scopeLabel(a, scope) : a;
      const aSlug = uniqueSlug(fileSafe(a), usedFirst);
      const aFile = 'tree/rulings/' + doc.key + '/' + aSlug + '.js';
      const aRef = { n: aLabel, lvl: 'chapter', f: aFile };
      const subKids = [];
      let aC = 0;
      for (const b of [...groups.get(a).keys()].sort((x, y) => x.localeCompare(y))) {
        const rows = groups.get(a).get(b).sort((x, y) => String(x.heading).localeCompare(String(y.heading)) || String(x.id).localeCompare(String(y.id)));
        const bFile = 'tree/rulings/' + doc.key + '/' + aSlug + '/' + uniqueSlug(fileSafe(b), new Set()) + '.js';
        files[bFile] = { n: b, lvl: 'leaf', c: rows.length, recs: rows.map(ent) };
        const bRef = { n: b, lvl: 'leaf', f: bFile };
        subKids.push({ n: b, lvl: 'leaf', c: rows.length, f: bFile });
        aC += rows.length;
        for (const r of rows) paths.set(r.id, [rulesRef, rulingsRef, docRef, aRef, bRef]);
      }
      files[aFile] = { n: aLabel, lvl: 'chapter', c: aC, kids: subKids };
      kids.push({ n: aLabel, lvl: 'chapter', c: aC, f: aFile });
    }
    files[doc.file] = { n: doc.n, lvl: 'doc', c: docRecs.length, kids: kids };
    docNodes.push({ n: doc.n, lvl: 'doc', c: docRecs.length, f: doc.file });
  }
  const rulingsC = rulingRecs.length;
  files['tree/rulings.js'] = { n: 'Rulings', lvl: 'chapter', c: rulingsC, kids: docNodes };
  // Directly under Rules, after the rulebooks: the branch's own count carries them.
  files['tree/rules.js'].kids.push({ n: 'Rulings', lvl: 'chapter', c: rulingsC, f: 'tree/rulings.js' });
  files['tree/rules.js'].c += rulingsC;

  // The cutoff (task-55): the level where the index stops and the entry expands
  // inline instead of navigating. Measured on the real tree, per branch - Rules
  // stops at the numbered chapter ('0x header'), Rulings at the WTC/FEQ document,
  // Factions at a faction's three groups (Army rules / Detachments / Units),
  // Missions at its three parts. The document is newer than the chapter, so the
  // Rulings chapter itself is a waypoint, not a cutoff.
  const CUT_LEVELS = new Set(['chapter', 'doc', 'part', 'group']);
  let cuts = 0;
  for (const f of Object.keys(files)) {
    const n = files[f];
    if (!CUT_LEVELS.has(n.lvl)) continue;
    if (n.lvl === 'chapter' && n.n === 'Rulings') continue;
    n.cut = true;
    cuts += 1;
  }
  // A node that IS one page has nothing to drill into: it is an endpoint of the
  // index by construction ('Army rules' on a faction, a detachment's own page).
  for (const f of Object.keys(files)) {
    if (files[f].pg && !files[f].cut) { files[f].cut = true; cuts += 1; }
  }
  // The inline kid lists carry their own copy: a kid that is one page, or that
  // opens a cutoff file, is a cutoff entry too.
  for (const f of Object.keys(files)) {
    for (const k of (files[f].kids || [])) {
      if (k.pg || (k.f && files[k.f] && files[k.f].cut)) k.cut = true;
    }
  }

  // A record folded across books - a mission errata into the core rule it names,
  // for instance - attaches after its target's book has been walked, so give every
  // attached record the target's chain here. Every placed record then has its
  // pre-walked path, including the ones this pass moved.
  for (const [target, list] of attach) {
    const chain = paths.get(target);
    if (!chain) continue;
    for (const a of list) if (!paths.has(a.id)) paths.set(a.id, chain);
  }

  const placed = rulesTotal + missionsC + facTotal + rulingsC;
  const rulesBranchC = rulesTotal + rulingsC;
  const index = {
    v: 1, n: 'Wiki', total: records.length, placed: placed,
    branches: [
      { n: 'Rules', lvl: 'branch', c: rulesBranchC, f: 'tree/rules.js' },
      { n: 'Missions', lvl: 'branch', c: missionsC, f: 'tree/missions.js' },
      { n: 'Factions', lvl: 'branch', c: facTotal, f: 'tree/factions.js' },
    ],
    excluded: excludedIds.length ? [{ k: 'index', c: excludedIds.length, why: 'navigation stubs, not corpus content' }] : [],
  };
  return {
    index: index, files: files, paths: paths, outline: outline,
    // The folded annotations: attach is section id -> its annotations (the render
    // lists them on the section's page), attachTarget is annotation id -> section
    // id (so the cascade opens on the section), unattached is the ones with no
    // section, counted per book and never given an invented home.
    attach: attach, attachTarget: attachTarget, unattached: unattached.map(r => r.id), childrenOf: childrenOf,
    // One page per detachment and one page per army-rules set: the tree carves
    // the collections, the render writes their pages.
    owned: owned, mergedOn: mergedOn, pages: pages,
    stats: { total: records.length, placed: placed, excluded: excludedIds.length, rules: rulesBranchC, missions: missionsC, factions: facTotal, rulings: rulingsC, cuts: cuts,
      annotations: annotationTotal, annotated: annotationTotal - unattached.length, unattached: unattached.length, unattachedByBook: unattachedBooks,
      dropped: dropped.length, filtered: filteredIds.length, merged: mergedIds.length },
    dropped: dropped.map(r => r.id), filtered: filteredIds, merged: mergedIds,
  };
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