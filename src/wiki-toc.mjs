#!/usr/bin/env node
'use strict';
/**
 * wiki-toc: the index model - the area tree, page naming, the rosters and the
 * assigners. The two-pane UI that used to live here (TOC_JS/TOC_CSS) is gone
 * with the shell (task-77); the model is what the payload bake and the surface
 * read.
 *
 * The design is the chosen toc-3-twopanes mockup: a rail of areas (Core Rules and
 * the factions, with their record counts) beside the selected area's tree; a group
 * opens on the first tap and a page opens on the second - a tap on a group never
 * collapses it - and the rail collapses to the current-area chip once an area is
 * picked. The wiki render writes it as shell.js + shell-data.js, so a record page
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, isDelivered } from './rules-corpus.mjs';
import { cardTables } from './unit-card.mjs';

// The popup's own CSS, kept apart from the shell's: shell.css reads as two blocks,
// the top bar and then the tree, on the same palette and custom properties.
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
export const ALLIANCE_EXCEPTIONS = { 'Genestealer Cults': 'Xenos' };
export const ALLIANCE_ORDER = ['Imperium', 'Chaos', 'Xenos'];
export const ALLIANCE_KEYWORDS = ['Imperium', 'Chaos'];

// The books of the Rules branch. One rulebook: task-5 folds the Rules Appendix
// into Core Rules, because it is the same chapters repeated one level deeper, and
// a reader looking for 01.02 must not see two '01 Core Concepts'. The
// core-stratagems decision lives here too: the 54 records whose source is
// core-stratagems and whose url is the-rules/core-rules/#Core-Stratagems are a
// SECTION of the Core Rules page, not a third book.
export const TREE_BOOKS = [
  { slug: 'core-rules', name: 'Core Rules', sources: ['core-rules', 'core-stratagems', 'rules-appendix'] },
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
export function hash8(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
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

// --- the rule's number, and the order the book prints it in ------------------
// A rule's own number is its place in the book: 01.05 < 01.05.01 < 01.06. The
// corpus does not always extract it - an appendix errata h3 carries the number
// inside the heading ('01.02.06 Splitting Units') and its ruleId is empty - so
// the number is read from the leaf too, and that is what the drawer files the
// row under. A record with neither keeps its heading for the alphabetical tie.
export function ruleNumber(r) {
  const own = String((r && r.ruleId) || '');
  if (/^\d{2}(?:\.\d{2}){1,2}$/.test(own)) return own;
  const leaf = String(headingSegments(r || {}).slice(-1)[0] || '').trim();
  const m = /^(\d{2}(?:\.\d{2}){1,2})\b/.exec(leaf);
  return m ? m[1] : '';
}
function numberParts(n) {
  const s = String(n || '');
  return s ? s.split('.').map(x => parseInt(x, 10) || 0) : [];
}
// An errata h3 names a rule and starts its body with the change ('Add: ...'): it
// sorts after the rule it updates, never before it.
function errataText(r) {
  const t = String((r && r.text) || ''), h = String((r && r.heading) || '');
  const body = h && t.indexOf(h) === 0 ? t.slice(h.length) : t;
  return /^(?:add|change|replace|remove|delete|amend)\s*:/i.test(body.trim());
}
export function compareRuleNumber(a, b) {
  const x = numberParts(ruleNumber(a)), y = numberParts(ruleNumber(b));
  if (!x.length && !y.length) return 0;
  if (!x.length) return -1;
  if (!y.length) return 1;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] === undefined ? -1 : x[i]) - (y[i] === undefined ? -1 : y[i]);
    if (d) return d;
  }
  return 0;
}
// The chapter's own lead row first (its leaf names the chapter), then the rows by
// their number, then the unnumbered ones by heading. The drawer's order is the
// book's order, not the alphabet's.
export function sortChapterRows(rows, chapterTitle) {
  const t = String(chapterTitle || '').trim().toLowerCase();
  const rank = r => (t && leafTitle(r).toLowerCase() === t) ? 0 : (ruleNumber(r) ? 1 : 2);
  return rows.slice().sort((a, b) =>
    rank(a) - rank(b) ||
    compareRuleNumber(a, b) ||
    (errataText(a) ? 1 : 0) - (errataText(b) ? 1 : 0) ||
    String(a.heading || '').localeCompare(String(b.heading || '')) ||
    String(a.id).localeCompare(String(b.id)));
}

// One rule for what an annotation is, in one place: a kind-rule record whose
// heading names a FAQ, Errata, Duplicated Abilities or [TORRENT] block, or whose
// heading carries a question. A question segment is one ending in "?", one
// starting with the "Q:" label, or one under a FAQ block. The label is NOT
// required - 64 of the questions have no "Q:" and 28 of those do not even end in
// "?" (the corpus truncates them with "...") - but where it exists it is the
// only signal left. Non-rule records are never annotations (a stratagem named
// "WHERE D'YA FINK YOU'RE GOING?" is a name).
//
// task-96: a SHORT question with no 'Q:' label is a section TITLE, not a question
// someone asked. The appendix titles 02.02.01's own subsections that way ('What are
// Modifiers?', 19 characters) and the annotation rule was filing it as an answer to
// something, so it never appeared as a row and 02.02.01 rendered empty. Measured over
// the 61 question-leaf records with no FAQ ancestor: one is 19 characters, one is 29 and
// starts with 'Q:', the other 59 run past 40.
export function headingSegments(r) { return String(r.heading || '').split(' > ').filter(Boolean); }
export function isAnnotation(r) {
  if (r.kind !== 'rule') return false;
  for (const seg of headingSegments(r)) {
    const x = String(seg).trim();
    const question = /\?\s*$/.test(x) && (/^Q:/i.test(x) || x.length > 40);
    if (/^FAQ$/i.test(x) || /^Errata$/i.test(x) || /^Duplicated Abilities$/i.test(x) || /^\[TORRENT\]$/i.test(x) || /^Q:/i.test(x) || question) return true;
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
// The scraped pages are the outline of record, so both Rules books read them the
// same way: the headings in document order, each with the anchor a record can be
// resolved against. The chapter rule differs per page and is the only difference.
function outlineHeadings(file) {
  let html = '';
  try { html = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const re = /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g;
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
  return headings;
}

// workspace/rules-corpus/core-rules.html is the scraped page, and its own TOC
// (the .mw2 list) is the true tree: an i10 entry is a rulebook chapter, an i30
// one of its sections. The page body repeats the same headings in document
// order, so the chapter a record belongs to is the chapter heading in force at
// the record's anchor. The BASIC RULES / ADVANCED RULES / REFERENCE super
// headers are parts, not chapters, and are skipped.
export function coreOutline(file) {
  const at = file || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workspace', 'rules-corpus', 'core-rules.html');
  const headings = outlineHeadings(at);
  if (!headings) return null;
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

// The Rules Appendix's own saved page. Its outline marks a chapter with the
// `outline_header` class (Core Concepts, ..., Core Abilities, Universal Rules
// Updates) and a part with `outline_header_book` (Books); the levels are h3s, not
// the core page's h2. A record is placed by its anchor: the outline header in
// force at that heading is its chapter. This is the fallback the numbered appendix
// records never need - their ruleId carries the core chapter - and the one their
// heading cannot give: the page nests the Universal Rules Updates h3s under the
// [ONE SHOT] h2, so the heading path calls them one-shot (task-4).
export function appendixOutline(file) {
  const at = file || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workspace', 'rules-corpus', 'rules-appendix.html');
  const headings = outlineHeadings(at);
  if (!headings) return null;
  const chapterOf = new Array(headings.length).fill(null);
  let cur = null;
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (/outline_header/.test(h.cls) && !/outline_header_book/.test(h.cls)) cur = { key: h.id || h.text, name: h.text, num: h.num || '', order: i };
    chapterOf[i] = cur;
  }
  const byAnchor = new Map();
  for (let i = 0; i < headings.length; i++) if (headings[i].id && !byAnchor.has(headings[i].id)) byAnchor.set(headings[i].id, i);
  const chapterAt = i => (i == null || i < 0) ? null : chapterOf[i];
  return { headings: headings, byAnchor: byAnchor, chapterAt: chapterAt, byIdName: a => chapterAt(byAnchor.get(String(a))) };
}
// Read once per process: the page is 363 KB and every tocTree call wants the same
// outline.
let appendixDefault;
function appendixOutlineDefault() {
  if (appendixDefault === undefined) appendixDefault = appendixOutline();
  return appendixDefault;
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
  const filteredIds = [], mergedIds = [], pages = [];
  const owned = new Map(), mergedOn = new Map();
  // Two sources can share an anchor id - 'Hidden-and-the-First-Turn' exists on
  // both the core page and the appendix - and that is one rule in two places, not
  // parts of one record. task-5 merges the books, so the base carries the source;
  // only the ids an importer split ('~2', or a repeated '#2' in one source) are
  // one record.
  const baseOf = r => String(r.source || '') + '|' + String(String(r.id).split('#')[1] || '').split('~')[0];
  const primaryOf = list => {
    const m = new Map();
    for (const r of list) { const n = baseOf(r); if (!m.has(n)) m.set(n, []); m.get(n).push(r); }
    const out = [];
    for (const g of m.values()) {
      g.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      out.push(g[0]);
      if (g.length > 1) {
        mergedOn.set(g[0].id, g.slice(1).map(x => x.id));
        for (const x of g.slice(1)) mergedIds.push(x.id);
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
    // The appendix has a saved page of its own, and its outline is the authority
    // for the records the number cannot place: the page's heading path files the
    // Universal Rules Updates topics under whichever h2 happens to enclose them
    // ('[ONE SHOT] > Modifying a Stratagem's CP Cost'), which used to become an
    // appendix-local [ONE SHOT] chapter of 73 records. The page's own outline
    // header puts them where they belong (task-4). The heading segment remains the
    // last resort when the saved page is absent.
    if (r.source === 'rules-appendix') {
      const ap = appendixOutlineDefault();
      const anchor = r.anchor || (/^[^#]*#(.+)$/.exec(String(r.url || '')) || [])[1];
      const ax = ap && anchor ? ap.byIdName(anchor) : null;
      if (ax) return ax;
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
  // task-4: the Universal Rules Updates block's own topics; they travel with the
  // 00 chapter the block's outline header opens, outside either book.
  let uruExtra = [];
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
    // task-4: the block's topics are h3s inside it on the saved page, and the
    // heading path files them under the h2 that happens to enclose it ('[ONE SHOT]
    // > Modifying a Stratagem's CP Cost'). The appendix outline places them in the
    // block's own chapter; they leave the book and join the 00 chapter below with
    // their annotations, so the drawer no longer invents an appendix-local [ONE
    // SHOT] chapter of 73 records.
    if (u >= 0) {
      uruExtra = folded.sections.filter(r => {
        const ch = resolveChapter(r, book);
        return ch && ch.key === 'Universal-Rules-Updates';
      });
      if (uruExtra.length) {
        const keep = new Set(uruExtra.map(r => r.id));
        folded.sections = folded.sections.filter(r => !keep.has(r.id));
      }
    }
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
      // task-106: the chapter's rows follow the rule's own number, not the
      // alphabet (the chapter's lead row stays first). task-5: Core Rules and the
      // Rules Appendix are one book and one header list - the reader must not see
      // two '01 Core Concepts' - and the appendix's 0x.0x SECTION level survives:
      // its definitions nest under the section their number names, and the core's
      // own 0x.0x record is that section's lead row. task-4 rides here: 24 Core
      // Abilities keeps exactly one [ONE SHOT] section (24.26).
      const chapterTitle = String(ch.title || '').trim();
      const allRows = sortChapterRows(primaryOf(ch.recs), ch.title);
      // The section each appendix definition names: its number's first two parts.
      // Only the appendix names a section; the core's own 3-part rows are the book's
      // sub-rules and keep the home they had.
      const groups = new Map(), loose = [];
      for (const r of allRows) {
        if (leafTitle(r).toLowerCase() === chapterTitle.toLowerCase()) { loose.push(r); continue; }
        const parts = ruleNumber(r).split('.');
        if (parts.length >= 3 && r.source === 'rules-appendix') {
          const key = parts.slice(0, 2).join('.');
          const segs = headingSegments(r);
          const first = segs.length > 1 ? String(segs[0]).trim() : '';
          if (!groups.has(key)) groups.set(key, { num: key, name: first, seg: first.toLowerCase(), rows: [] });
          groups.get(key).rows.push(r);
        } else loose.push(r);
      }
      // A core row the number places in one of those sections joins it: the
      // appendix's section 01.02 and the core's own 01.02 row are one level.
      for (const r of loose.slice()) {
        const rn = ruleNumber(r);
        if (rn.split('.').length < 3) continue;
        const g = groups.get(rn.split('.').slice(0, 2).join('.'));
        if (!g) continue;
        g.rows.push(r);
        loose.splice(loose.indexOf(r), 1);
      }
      // The core's 0x.0x record heads the section its number names; a numbered row
      // with no section under it (the 15.02..15.12 stratagems, the 24.08 duplicated
      // abilities) stays a row of the chapter, where it was.
      for (const r of loose.slice()) {
        const rn = ruleNumber(r);
        if (rn.split('.').length !== 2) continue;
        const g = groups.get(rn);
        if (!g) continue;
        g.rows.push(r);
        g.name = cleanTitle(leafTitle(r));
        g.seg = '';
        loose.splice(loose.indexOf(r), 1);
      }
      // An unnumbered row whose heading extends a section row's heading is that
      // section's row: the split inline rules ('3. Resolve Attacks > Identical
      // Attacks').
      for (const r of loose.slice()) {
        if (ruleNumber(r)) continue;
        const h = String(r.heading || '');
        let bestKey = null, bestLen = -1;
        for (const [key, g] of groups) {
          for (const o of g.rows) {
            const oh = String(o.heading || '');
            if (oh && h.indexOf(oh + ' > ') === 0 && oh.length > bestLen) { bestKey = key; bestLen = oh.length; }
          }
        }
        if (!bestKey) continue;
        groups.get(bestKey).rows.push(r);
        loose.splice(loose.indexOf(r), 1);
      }
      // task-4: an ability tag is not a section name unless the records say so.
      // The Core Abilities page prints the [PRECISION] (24.28) and [TORRENT]
      // (24.37) clarifications as h3s under the [ONE SHOT] h2, so their heading
      // says [ONE SHOT] while their rule number says otherwise - which is how one
      // ability became three sections. When a bracketed tag is shared by more than
      // one rule number, a group whose own leaf does not name it is the page's
      // container, and is titled by the leaf. The real one-shot record's leaf
      // ('Multiple [ONE SHOT] Weapons') does name it, so [ONE SHOT] reads one
      // section. A plain segment ('Move Units' over 09.02 and 09.05) is the
      // appendix's section and is left alone.
      const segOwners = new Map();
      for (const g of groups.values()) {
        if (!g.seg) continue;
        if (!segOwners.has(g.seg)) segOwners.set(g.seg, new Set());
        segOwners.get(g.seg).add(g.num);
      }
      for (const g of groups.values()) {
        if (!/^\[[^\]]+\]$/.test(g.name)) continue;
        const owners = segOwners.get(g.name.toLowerCase());
        if (!owners || owners.size < 2) continue;
        const leaf = cleanTitle(leafTitle(g.rows[0]));
        if (leaf && leaf.toLowerCase().indexOf(g.name.toLowerCase()) === -1) g.name = leaf;
      }
      // task-5: one rule, two sources. The core page and the appendix print the
      // same definition for eight numbers (and the core page splits three more out
      // as unnumbered children); left alone they would read as two rows with one
      // title. The numbered copy stays the row - the appendix's own title when the
      // core copy carries no number, the core's when both do - and the other copy
      // is attached to it: still delivered, still found by its own slug, counted in
      // the section's annotation badge. The groups are read first, so a hidden
      // appendix row still opened its section.
      const hidden = new Set();
      const byTitle = new Map();
      const titleOf = r => cleanTitle(leafTitle(r)).replace(/^\d{2}(?:\.\d{2}){1,2}\s*[-\u2013]?\s*/, '').toLowerCase();
      const visible = [];
      for (const g of groups.values()) visible.push(...g.rows);
      visible.push(...loose);
      for (const r of visible) {
        if (r.source !== 'core-rules' && r.source !== 'rules-appendix') continue;
        const key = titleOf(r);
        if (!byTitle.has(key)) byTitle.set(key, []);
        byTitle.get(key).push(r);
      }
      for (const list of byTitle.values()) {
        if (list.length < 2) continue;
        if (!list.some(r => r.source === 'core-rules') || !list.some(r => r.source === 'rules-appendix')) continue;
        let keep = list[0];
        for (const r of list) {
          const rn = ruleNumber(r), kn = ruleNumber(keep);
          if (rn && !kn) keep = r;
          else if (rn && kn && r.source === 'core-rules' && keep.source !== 'core-rules') keep = r;
        }
        for (const r of list.slice()) {
          if (r.id === keep.id) continue;
          if (!attach.has(keep.id)) attach.set(keep.id, []);
          attach.get(keep.id).push(r);
          attachTarget.set(r.id, keep.id);
          hidden.add(r.id);
          // A record the importer split rides its primary: hide the parts with it.
          for (const t of (mergedOn.get(r.id) || [])) {
            if (hidden.has(t)) continue;
            attach.get(keep.id).push(byIdAll.get(t));
            attachTarget.set(t, keep.id);
            hidden.add(t);
          }
        }
      }
      for (const g of groups.values()) g.rows = g.rows.filter(r => !hidden.has(r.id));
      const keptLoose = loose.filter(r => !hidden.has(r.id));
      loose.length = 0;
      loose.push(...keptLoose);
      const rows = allRows.filter(r => !hidden.has(r.id));
      // A subsection is never a sibling of its own parent: a row whose heading
      // extends another row's heading nests under it. The chapter's own LEAD row is
      // not a container (every section's heading extends the chapter name), and a
      // nested row is not listed twice: the payload carries no nested rows, so this
      // is the rule that keeps the core page's copies of the CSV stratagems out of
      // the drawer. Sections keep every row they group.
      const lead = chapterTitle;
      const parentOfSection = new Map(), nestedSection = new Set();
      for (const r of rows) {
        const h = String(r.heading || '');
        let best = null, bestLen = -1;
        for (const o of rows) {
          if (o.id === r.id) continue;
          const oh = String(o.heading || '');
          if (oh === lead) continue;
          if (oh && h.indexOf(oh + ' > ') === 0 && oh.length > bestLen) { best = o; bestLen = oh.length; }
        }
        if (best) { parentOfSection.set(r.id, best.id); nestedSection.add(r.id); }
      }
      for (const r of rows) {
        const subs = rows.filter(x => parentOfSection.get(x.id) === r.id).map(x => x.id);
        if (subs.length) childrenOf.set(r.id, subs);
      }
      const counted = ch.recs.filter(r => !hidden.has(r.id)).reduce((n, r) => n + 1 + (attach.get(r.id) || []).length, 0);
      const entryFor = r => {
        const q = (attach.get(r.id) || []).length;
        const e = ent(r);
        if (q) e.q = q;
        const subs = rows.filter(x => parentOfSection.get(x.id) === r.id);
        if (subs.length) e.s = subs.map(entryFor);
        return e;
      };
      const sections = [], sectionOf = new Map();
      for (const g of [...groups.values()].sort((x, y) => x.num.localeCompare(y.num))) {
        // '02.01 1. Datasheet Name' would print the ordinal twice: the section's own
        // number is the first one, the source's '1.' is its place in the chapter.
        const glabel = g.num + ' ' + g.name.replace(/^\d+\.\s*/, '');
        const gfile = file.replace(/\.js$/, '/' + nodeSlug(glabel) + '.js');
        const grows = sortChapterRows(g.rows, '');
        const gcount = grows.reduce((n, r) => n + 1 + (attach.get(r.id) || []).length, 0);
        files[gfile] = { n: glabel, lvl: 'section', c: gcount, recs: grows.map(entryFor) };
        const ref = { n: glabel, lvl: 'section', f: gfile };
        for (const r of grows) sectionOf.set(r.id, ref);
        sections.push({ n: glabel, lvl: 'section', c: gcount, f: gfile });
      }
      const list = loose.filter(r => !nestedSection.has(r.id)).map(entryFor);
      files[file] = sections.length
        ? { n: label, lvl: 'chapter', c: counted, kids: sections, recs: list }
        : { n: label, lvl: 'chapter', c: counted, recs: list };
      const chapterRef = { n: label, lvl: 'chapter', f: file };
      for (const r of ch.recs) {
        if (hidden.has(r.id)) continue;
        const chain = [rulesRef, bookRef, chapterRef];
        if (sectionOf.has(r.id)) chain.push(sectionOf.get(r.id));
        paths.set(r.id, chain);
        for (const a of (attach.get(r.id) || [])) paths.set(a.id, chain);
      }
      kids.push({ n: label, lvl: 'chapter', c: counted, f: file });
    }
    // The URU block and its topics left this book for the 00 chapter below, with
    // their annotations: subtract them or the Rules total counts them twice.
    const bookC = bookRecs.length - (unattached.length - before) - (dropped.length - beforeDropped) - (u >= 0 ? 1 : 0)
      - uruExtra.reduce((n, r) => n + 1 + (attach.get(r.id) || []).length, 0);
    const file = 'tree/rules/' + book.slug + '.js';
    files[file] = { n: book.name, lvl: 'book', c: bookC, kids: kids };
    bookNodes.push({ n: book.name, lvl: 'book', c: bookC, f: file });
  }
  // The 00 chapter, at the Rules level after the two books. task-4: its block's
  // topics ride with it as rows - the saved page makes them h3s of the Universal
  // Rules Updates outline header - and their annotations ride as their counts.
  if (uruRecord) {
    const file = 'tree/rules/universal-rules-updates.js';
    const family = [uruRecord].concat(uruExtra);
    const rows = primaryOf(family);
    // A merged twin has no row but is a delivered record, and its attachments are
    // delivered with it: count the family, not the rows.
    const counted = family.reduce((n, r) => n + 1 + (attach.get(r.id) || []).length, 0);
    const recs = rows.map(r => {
      const q = (attach.get(r.id) || []).length;
      const e = ent(r);
      if (q) e.q = q;
      return e;
    });
    files[file] = { n: '00 Universal Rules Updates', lvl: 'chapter', c: counted, recs: recs };
    const uruRef = { n: '00 Universal Rules Updates', lvl: 'chapter', f: file };
    // task-5: the chapter is inside the Core Rules book now, so its records' chain
    // carries the book (the drawer's pre-walk and the search row's book label read it).
    const coreBookRef = { n: 'Core Rules', lvl: 'book', f: 'tree/rules/' + TREE_BOOKS[0].slug + '.js' };
    for (const r of rows) {
      paths.set(r.id, [rulesRef, coreBookRef, uruRef]);
      for (const a of (attach.get(r.id) || [])) paths.set(a.id, [rulesRef, coreBookRef, uruRef]);
    }
    // task-5: the appendix is folded into Core Rules, so its Universal Rules
    // Updates chapter is the book's last chapter (00 sorts after 25), not a
    // sibling of the books: every former appendix record is under Core Rules.
    const coreBook = bookNodes.find(b => b.n === 'Core Rules');
    const coreFile = coreBook && files[coreBook.f];
    if (coreFile && coreFile.kids) {
      coreFile.kids.push({ n: '00 Universal Rules Updates', lvl: 'chapter', c: counted, f: file });
      coreFile.c += counted;
      coreBook.c += counted;
    } else {
      bookNodes.push({ n: '00 Universal Rules Updates', lvl: 'chapter', c: counted, f: file });
    }
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
          for (const x of extras) mergedIds.push(x.id);
          mergedC += extras.length;
        }
      }
      for (const n of [...urGroups.keys()].sort()) {
        if (dsGroups.has(n)) continue;
        const parts = urGroups.get(n), u = parts[0];
        units.push(u);
        if (parts.length > 1) {
          mergedOn.set(u.id, parts.slice(1).map(x => x.id));
          for (const x of parts.slice(1)) mergedIds.push(x.id);
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
        for (const r of rows) paths.set(r.id, [rulesRef, docRef, aRef, bRef]);
      }
      files[aFile] = { n: aLabel, lvl: 'chapter', c: aC, kids: subKids };
      kids.push({ n: aLabel, lvl: 'chapter', c: aC, f: aFile });
    }
    // A BOOK, not a document in a chapter: WTC and FEQ sit alongside Core Rules
    // and the Appendix under Rules, so either can be omitted later by deleting one
    // line (Mandal, task-65).
    files[doc.file] = { n: doc.n, lvl: 'book', c: docRecs.length, kids: kids };
    docNodes.push({ n: doc.n, lvl: 'book', c: docRecs.length, f: doc.file });
  }
  const rulingsC = rulingRecs.length;
  // The two books are siblings of the rulebooks under Rules - no Rulings chapter.
  for (const d of docNodes) files['tree/rules.js'].kids.push({ n: d.n, lvl: 'book', c: d.c, f: d.f });
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
    // A 0x header is NOT an entry: on screen it is a collapsed group label and its
    // children are listed in its place, so it must not be a cut card either.
    if (n.lvl === 'chapter' && /^\d{2}\s/.test(n.n)) continue;
    if (n.lvl === 'doc') continue;
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

  // A merged twin - a rule the importer split into parts - still has a page, and it
  // pre-walks exactly where its primary does. It used to be handed the path of
  // whichever faction was walked last: measured, all 1,774 twins pre-walked to
  // Tyranids, core-rules twins included. The primary's chain exists by now, so the
  // twins are settled here, once, after every book has been walked.
  for (const [primary, twins] of mergedOn) {
    const chain = paths.get(primary);
    if (!chain) continue;
    for (const t of twins) if (!paths.has(t)) paths.set(t, chain);
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