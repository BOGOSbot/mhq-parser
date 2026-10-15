#!/usr/bin/env node
'use strict';
/**
 * wiki-render: a static, offline, phone-readable render of the rules corpus.
 *
 * It is a RENDER, not a source. Nothing here is read back into the corpus, and
 * nothing it writes is committed: the corpus is third-party rules material and
 * the render is a copy of it, so both live under workspace/ and never in git.
 *
 *   node src/wiki-render.mjs            -> workspace/wiki-render/
 *   WIKI_RENDER_DIR=<dir> node src/wiki-render.mjs
 *
 * No CDN, no external asset, no build step beyond node: the directory opens
 * from a folder, offline, on a phone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readAllCorpus } from './rules-corpus.mjs';
import { renderLinks } from './wiki-plan.mjs';
import { CARD_CSS, cardIndex, recordBody } from './wiki-cards.mjs';
import { SHELL_CSS, shellHead, topBar } from './wiki-shell.mjs';
import { TOC_CSS, TOC_JS, tocData, tocIndex, tocTree, pageNamer, pageSlug, factionRoster, factionAssigner, allianceAssigner, isAnnotation } from './wiki-toc.mjs';
import { cardTables } from './unit-card.mjs';

const OUT = process.env.WIKI_RENDER_DIR || path.join('workspace', 'wiki-render');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

const CSS = [
  ':root { --ink:#1a1a1a; --dim:#666; --line:#e2e2e2; --bg:#fdfdfc; --chip:#f2f4f7; --warn:#b3261e; --ok:#1b5e20; --link:#1d4ed8; }'
  , '@media (prefers-color-scheme: dark) { :root { --ink:#e8e8e6; --dim:#9a9a96; --line:#333; --bg:#16161a; --chip:#24242a; --warn:#ff8a80; --ok:#8bd18b; --link:#8ab4ff; } }'
  // Mandal: anchors were falling back to the UA default (#0000EE), near-invisible
  // on --bg:#16161a. One variable, both palettes; the chips, crumbs and nav keep
  // their own colours because their rules are more specific.
  , 'a { color:var(--link); }'
  , '* { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }'
  , 'main { max-width:46rem; margin:0 auto; padding:0 1rem 4rem; }'
  , 'header { position:sticky; top:0; background:var(--bg); border-bottom:1px solid var(--line); padding:.6rem 1rem; z-index:2; }'
  , 'header nav a { color:var(--dim); text-decoration:none; margin-right:.9rem; font-size:.9rem; }'
  , 'h1 { font-size:1.35rem; line-height:1.25; margin:.9rem 0 .2rem; }'
  , 'h2 { font-size:1.05rem; margin:1.6rem 0 .4rem; }'
  , '.crumb { font-size:.85rem; color:var(--dim); margin:.6rem 0 0; } .crumb a { color:var(--dim); }'
  , '.meta { font-size:.8rem; color:var(--dim); margin:.2rem 0 1rem; word-break:break-all; }'
  , '.text { white-space:pre-wrap; word-wrap:break-word; border-left:3px solid var(--line); padding:.2rem 0 .2rem .8rem; margin:0 0 1rem; font:inherit; }'
  , '.chips { display:flex; flex-wrap:wrap; gap:.35rem; padding:0; margin:.3rem 0 1rem; list-style:none; }'
  , '.chips a, .chips span { background:var(--chip); border-radius:999px; padding:.25rem .6rem; font-size:.85rem; text-decoration:none; color:var(--ink); }'
  , '.chips .kind { color:var(--dim); font-size:.75rem; }'
  , '.missing { color:var(--warn); }'
  , 'pre.block { background:var(--chip); padding:.6rem; border-radius:.4rem; overflow-x:auto; font-size:.85rem; }'
  , 'table { border-collapse:collapse; width:100%; font-size:.9rem; } td, th { text-align:left; border-bottom:1px solid var(--line); padding:.35rem .4rem; }'
  , 'input[type=search] { width:100%; padding:.7rem .8rem; font-size:1rem; border:1px solid var(--line); border-radius:.5rem; background:var(--bg); color:var(--ink); }'
  , 'ul.plain { list-style:none; padding:0; } ul.plain li { border-bottom:1px solid var(--line); padding:.45rem 0; }'
  , '.num { color:var(--dim); font-size:.85rem; }'
  // A rule page's sections and subsections are native <details>: collapsible,
  // keyboard-operable with no script, and reset on navigation (nothing persists).
  , 'details.wsec,details.wqa { border-top:1px solid var(--line); padding:.15rem 0; }'
  , 'details.wsec > summary,details.wqa > summary { cursor:pointer; font-weight:650; padding:.5rem 0; font-size:.95rem; }'
  , 'details.wsec > summary:focus-visible,details.wqa > summary:focus-visible { outline:2px solid var(--ink); outline-offset:2px; }'
  , '.wsecbody { border-left:3px solid var(--line); padding:.15rem 0 .15rem .7rem; margin:.1rem 0 .5rem; overflow-wrap:break-word; white-space:pre-wrap; }'
  , '.wsecbody .text { border-left:0; padding-left:0; margin:0; }'
  , '.wseclink { font-size:.78rem; margin:0 0 .5rem; }'
  , 'details.wsec details.wsec { margin-left:.7rem; }'
  , '@media (max-width:600px){ main{padding:0 .7rem 3rem;} h1{font-size:1.2rem;} .text{font-size:.95rem;} }'
].join('\n');

// The card's stylesheet is its own file, not part of the shell: the card belongs to
// the record, and the same string is served as /card.css to the ask page's dialog.
// A record page links it; the index, search and reading-aids pages do not.
function page(title, nav, body, head) {
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + esc(title) + '</title>\n<link rel="stylesheet" href="wiki.css">\n' + (head || '') + '</head>\n<body>\n<header><nav>' + nav + '</nav></header>\n<main>\n' + body + '\n</main>\n</body>\n</html>\n';
}
const NAV = '<a href="index.html">Index</a><a href="search.html">Search</a><a href="anomalies.html">Reading aids</a>';

// A record page in the product shell. The top bar and the CSS are the shared
// asset (src/wiki-shell.mjs), not a copy; the page carries its own record id and
// area so the Wiki control can open the tree where the reader is.
function productPage(title, body, r, openArea) {
  // The cascade opens on where the reader is: WIKI_HERE carries the record's own
  // node chain (path), computed by the tree, so the UI pre-walks exactly those
  // files instead of guessing from the heading. The path inlines names and file
  // refs only - the files themselves are fetched when the cascade is opened.
  const here = r ? JSON.stringify({ id: r.id, heading: r.heading || '', title: title, area: r.area || '', path: r.path || [], at: r.at || '' }).replace(/</g, '\\u003c') : '';
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + esc(title) + '</title>\n' + shellHead({}) + '</head>\n<body class="wpage">\n' + body + '\n'
    + (here ? '<script>window.WIKI_HERE = ' + here + ';</script>\n' : '')
    + (openArea ? '<script>window.WIKI_TOC_OPEN = ' + JSON.stringify(openArea) + ';</script>\n' : '')
    + '</body>\n</html>\n';
}

const all = readAllCorpus();
const byId = new Map(all.map(r => [r.id, r]));
const pageOf = pageNamer(all);
// The two things a record body needs besides the record itself: the card builder's
// corpora (the ability resolver reads both halves) and one index for the ability
// links, built once rather than per datasheet.
const corpora = {
  rules: all.filter(r => r.set === 'rules'),
  factions: all.filter(r => r.set === 'factions'),
};
const cardIdx = cardIndex(byId);
const records = all.map(r => ({
  id: r.id, heading: r.heading || '', kind: r.kind || '', source: r.source || '', set: r.set || '',
  text: String(r.text || ''), links: Array.isArray(r.links) ? r.links : [], parent: r.parent || '', children: Array.isArray(r.children) ? r.children : [],
  // url and faction are what the two-pane tree files a record by; anchor and
  // ruleId are what the Rules chapters are resolved by (the saved page outline),
  // and edition is what the faction filters consume, so the projection must
  // carry them or the render's tree would drift from the tests'.
  url: r.url || '', faction: r.faction || '', anchor: r.anchor || '', ruleId: r.ruleId || '',
  edition: r.edition == null ? '' : String(r.edition),
  // The rulings' provenance travels into the tree's grouping and the card banner,
  // and text_en is the additional English the card shows a reader who chose it.
  provenance: r.provenance || null,
  text_en: r.text_en || '',
}));

// The tree data and the area of every record, computed once. Each record's area
// comes from its own url (factions/<slug>), the only field a stratagem, an
// enhancement or a detachment carries - their source is 'stratagems' and their
// faction is empty, and that is what filed them under Core Rules.
const slugNames = new Map();
for (const [id, url] of cardTables().factionLink) {
  const m = /factions\/([a-z0-9-]+)$/i.exec(String(url || ''));
  if (m) slugNames.set(m[1].toLowerCase(), cardTables().factionName.get(id) || id);
}
// WIKI_RENDER_ONLY=<id>[,<id>] renders just those: it is what the two-paths
// test uses to compare this render's fragment with the one the server serves on
// demand, without paying for 6,705 pages to prove one. A partial render's map is
// the manifest of what it wrote, so its links never claim an unwritten page.
const ONLY = String(process.env.WIKI_RENDER_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const onlySet = ONLY.length ? new Set(ONLY) : null;

const toc = tocData(records, pageOf, cardTables().factionName, slugNames);
const areaOf = new Map();
for (const a of toc.areas) for (const g of a.g) for (const p of g.p) areaOf.set(p.i, a.n);
// --- the reading aids, computed here so the pages can show them -----------------
const W = 100;
const windowCount = new Map();
for (const r of records) {
  const t = norm(r.text), seen = new Set();
  for (let i = 0; i + W <= t.length; i += W) { const w = t.slice(i, i + W); if (seen.has(w)) continue; seen.add(w); windowCount.set(w, (windowCount.get(w) || 0) + 1); }
}
for (const r of records) {
  const t = norm(r.text); let total = 0, shared = 0;
  for (let i = 0; i + W <= t.length; i += W) { total++; if ((windowCount.get(t.slice(i, i + W)) || 0) > 1) shared++; }
  r.borrowed = total ? shared / total : 0;
  r.chars = String(r.text).length;
  r.keptSegments = (String(r.text).match(/Ability \((Core|Faction)\): [^\n]*/g) || []);
  r.debris = (String(r.text).match(/Ability \((Core|Faction|Datasheet)\): [^\n]*? - (?=\n|$)/g) || []);
  r.dangling = r.links.filter(l => !byId.has(l.to));
  r.arrayBlock = renderLinks(r.links, 40).text;
  // The one-format contract: the text's link lines and the links array must name the
  // same links. Checked in BOTH directions, because a stale array is as wrong as a
  // missing one - the reader renders from the array and never parses the text.
  r.textLinks = (String(r.text).match(/^- ([a-z-]+): (.+)$/gm) || []).map(l => l.slice(2));
  r.arrayLinks = r.links.map(l => (l.kind || '') + ': ' + (l.title || ''));
  r.onlyText = r.textLinks.filter(x => r.arrayLinks.indexOf(x) === -1);
  r.onlyArray = r.arrayLinks.filter(x => r.textLinks.indexOf(x) === -1);
}
const kept = records.filter(r => r.keptSegments.length);
const debris = records.filter(r => r.debris.length);
const dangling = records.filter(r => r.dangling.length);
const textMore = records.filter(r => r.onlyText.length);
const arrayMore = records.filter(r => r.onlyArray.length);
const disagree = records.filter(r => r.onlyText.length || r.onlyArray.length);
const biggest = records.slice().sort((a, b) => b.chars - a.chars).slice(0, 20);
const emptiest = records.slice().sort((a, b) => a.chars - b.chars).slice(0, 20);
const borrowed = records.filter(r => r.chars >= 400).sort((a, b) => b.borrowed - a.borrowed).slice(0, 30);
const reverse = new Map();
for (const r of records) for (const l of r.links) { if (!reverse.has(l.to)) reverse.set(l.to, []); reverse.get(l.to).push(r.id); }

function linkChips(links, missingOk) {
  if (!links.length) return '<p class="num">No links.</p>';
  const items = links.map(l => {
    const has = live.has(l.to);
    const label = '<span class="kind">' + esc(l.kind || 'link') + '</span> ' + esc(l.title || l.to);
    if (has) return '<li><a href="' + esc(pageOf.get(l.to)) + '">' + label + '</a></li>';
    return '<li><span class="missing" title="' + esc(l.to) + '">' + label + ' (missing)</span></li>';
  }).join('');
  return '<ul class="chips">' + items + '</ul>';
}

// --- the pages ------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'wiki.css'), CSS);
// The card's own CSS, from the one export in src/wiki-cards.mjs. Served as
// /wiki/card.css (offline: a relative link) and as /card.css for the ask page.
fs.writeFileSync(path.join(OUT, 'card.css'), CARD_CSS);
// The product shell's stylesheet, from the one export in src/wiki-shell.mjs. The
// ask page links the same file as /wiki/shell.css: one asset, two surfaces.
fs.writeFileSync(path.join(OUT, 'shell.css'), SHELL_CSS + '\n' + TOC_CSS);
// The tree: its data is a JS assignment so a page opened from a folder has it
// without a fetch, and its behaviour is one file both surfaces load.
fs.writeFileSync(path.join(OUT, 'shell.js'), TOC_JS);
fs.writeFileSync(path.join(OUT, 'shell-data.js'), 'window.WIKI_TOC = ' + JSON.stringify(tocIndex(toc)) + ';');
// One file per area, loaded when the popup first opens that area: every record
// page used to pull the whole tree (788KB raw) for a popup most views never open.
for (const a of toc.areas) fs.writeFileSync(path.join(OUT, a.f), 'window.WIKI_TOC_AREA = ' + JSON.stringify({ n: a.n, g: a.g }) + ';');

// --- the three-branch tree, additive -------------------------------------------
// Rules / Missions / Factions, per node: the index names the three branches, a
// branch names its children, and only the node a reader opens carries records.
// The two-pane files above keep being written, so the popup is untouched; these
// files are what the cascade slice will load, on demand.
const roster = factionRoster(cardTables().factionName, cardTables().factionLink);
const tree = tocTree(records, pageOf, {
  roster: roster,
  factionOf: factionAssigner(roster),
  allianceOf: allianceAssigner(roster, cardTables().datasheets, cardTables().keywords),
});
// A full rebuild: drop the node files of any earlier layout first, so a chapter
// file that no longer belongs to the tree is not left behind for the server.
fs.rmSync(path.join(OUT, 'tree'), { recursive: true, force: true });
for (const rel of Object.keys(tree.files)) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'window.WIKI_TREE_NODE = ' + JSON.stringify(tree.files[rel]) + ';');
}
fs.mkdirSync(path.join(OUT, 'tree'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'tree', 'index.js'), 'window.WIKI_TREE_INDEX = ' + JSON.stringify(tree.index) + ';');

// --- one notion of "exists" ----------------------------------------------------
// A record is delivered iff the tree keeps it. The tree's filtered set (the
// edition-0 Legends / Forge World line and the named tenth-edition rule) gets no
// page, no search row, no link and no fragment: search.html used to inline the
// whole corpus, so a filtered rule stayed two keystrokes away and the exclusion
// held in navigation and nowhere else. `live` is the single list every surface
// below reads; the filesystem is its manifest, and the sweep at the end deletes
// any page an earlier pass wrote for a record that no longer exists.
const filteredSet = new Set(tree.filtered || []);
const live = new Set([...pageOf.keys()].filter(id => !filteredSet.has(id)));
// What this pass actually wrote: under WIKI_RENDER_ONLY the live set is wider
// than the pages, and a link must never name a file that is not there.
const writtenIds = new Set([...live].filter(id => !onlySet || onlySet.has(id)));
const delivered = records.filter(r => live.has(r.id));
const hrefOf = id => (writtenIds.has(id) ? pageOf.get(id) : '');

const counts = {};
for (const r of delivered) counts[r.kind || '(none)'] = (counts[r.kind || '(none)'] || 0) + 1;
const sources = {};
for (const r of delivered) sources[r.source || '(none)'] = (sources[r.source || '(none)'] || 0) + 1;
const idxRows = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map(k => '<tr><td><a href="search.html?kind=' + esc(k) + '">' + esc(k) + '</a></td><td class="num">' + counts[k] + '</td></tr>').join('');
const srcRows = Object.keys(sources).sort((a, b) => sources[b] - sources[a]).map(k => '<tr><td>' + esc(k) + '</td><td class="num">' + sources[k] + '</td></tr>').join('');
fs.writeFileSync(path.join(OUT, 'index.html'), page('Rules corpus - index', NAV, [
  '<h1>Rules corpus</h1>',
  '<p class="num">' + delivered.length + ' records, rendered from workspace/rules-corpus. A render, not a source: nothing here is read back into the corpus, and nothing here is committed.</p>',
  '<h2>Read task 30</h2>',
  '<ul class="plain">',
  '<li><a href="anomalies.html">Reading aids</a> - records that still carry another rule\'s text, links that point nowhere, bodies that are mostly someone else\'s rule, biggest and emptiest.</li>',
  '<li>' + (hrefOf('unitrules#000002541') ? '<a href="' + esc(hrefOf('unitrules#000002541')) + '">unitrules#000002541</a>' : 'unitrules#000002541') + ' - the Starweaver record the restructure merged (Rapid Embarkation).</li>',
  '</ul>',
  '<h2>By kind</h2><table>' + idxRows + '</table>',
  '<h2>By source</h2><table>' + srcRows + '</table>',
].join('\n')));

// search over headings, filtering a list rendered at build time
const searchRows = delivered.slice().sort((a, b) => a.heading.localeCompare(b.heading)).map(r => {
  const h = hrefOf(r.id);
  const title = h ? '<a href="' + esc(h) + '">' + esc(r.heading || r.id) + '</a>' : esc(r.heading || r.id);
  return '<li data-h="' + esc((r.heading + ' ' + r.id).toLowerCase()) + '" data-k="' + esc(r.kind) + '">' + title + ' <span class="num">' + esc(r.kind) + '</span></li>';
}).join('');
fs.writeFileSync(path.join(OUT, 'search.html'), page('Search headings', NAV, [
  '<h1>Search</h1>',
  '<p><input type="search" id="q" placeholder="Filter ' + delivered.length + ' headings\u2026" autocomplete="off"></p>',
  '<p class="num" id="n"></p>',
  '<ul class="plain" id="list">' + searchRows + '</ul>',
  '<script>',
  'var q=document.getElementById("q"),list=document.getElementById("list"),n=document.getElementById("n"),items=[].slice.call(list.children);',
  'function kind(){var m=/[?&]kind=([^&]+)/.exec(location.search);return m?decodeURIComponent(m[1]):"";}',
  'function run(){var s=q.value.toLowerCase().trim(),k=kind(),shown=0;for(var i=0;i<items.length;i++){var it=items[i],ok=(!s||it.getAttribute("data-h").indexOf(s)!==-1)&&(!k||it.getAttribute("data-k")===k);it.style.display=ok?"":"none";if(ok)shown++;}n.textContent=shown+" of "+items.length+" headings"+(k?" (kind "+k+")":"");}',
  'q.addEventListener("input",run);run();',
  '</script>',
].join('\n')));

// The reading aids are computed on the whole corpus but may only link what is
// delivered; a filtered record's title is shown plain, never as a dead link.
const listOf = (rows, render) => '<ul class="plain">' + rows.filter(r => live.has(r.id)).map(render).join('') + '</ul>';
const recLink = r => { const h = hrefOf(r.id); return h ? '<a href="' + esc(h) + '">' + esc(r.heading || r.id) + '</a>' : esc(r.heading || r.id); };
fs.writeFileSync(path.join(OUT, 'anomalies.html'), page('Reading aids', NAV, [
  '<h1>Reading aids</h1>',
  '<p class="num">What the numbers say, and where to look at it. Everything here is computed from the rendered corpus.</p>',
  '<table>',
  '<tr><td>records</td><td class="num">' + records.length + '</td></tr>',
  '<tr><td>records still carrying a Core/Faction segment</td><td class="num">' + kept.length + '</td></tr>',
  '<tr><td>records with a segment label and no text after it (debris)</td><td class="num">' + debris.length + '</td></tr>',
  '<tr><td>records with a link that points nowhere</td><td class="num">' + dangling.length + '</td></tr>',
  '<tr><td>records whose TEXT names links the array does not</td><td class="num">' + textMore.length + '</td></tr>',
  '<tr><td>records whose ARRAY holds links the text does not</td><td class="num">' + arrayMore.length + '</td></tr>',
  '<tr><td>records with any text/array disagreement</td><td class="num">' + disagree.length + '</td></tr>',
  '<tr><td>records with no links and no parent (islands)</td><td class="num">' + records.filter(r => !r.links.length && !r.parent).length + '</td></tr>',
  '</table>',
  '<h2>Still carrying another rule\'s text (' + kept.length + ')</h2>',
  '<p class="num">These are the records the strip left alone because the rendition is materially different, or because the segment is not a Core/Faction rule. Read a few.</p>',
  listOf(kept.slice(0, 60), r => '<li>' + recLink(r) + ' <span class="num">' + esc(r.keptSegments.map(s => s.replace('Ability (Core): ', '').replace('Ability (Faction): ', '').split(' - ')[0]).join(', ').slice(0, 90)) + '</span></li>'),
  '<h2>Links that point nowhere (' + dangling.length + ')</h2>',
  listOf(dangling.slice(0, 40), r => '<li>' + recLink(r) + ' <span class="num">' + esc(r.dangling.map(l => l.kind + ':' + l.to).join(', ').slice(0, 110)) + '</span></li>'),
  '<h2>Text names links the array does not (' + textMore.length + ')</h2>',
  '<p class="num">The reader renders from the array and never parses the text, so these links would not reach the page. Task-30 added its ability lines to the text only.</p>',
  listOf(textMore.slice().sort((a, b) => b.onlyText.length - a.onlyText.length).slice(0, 40), r => '<li>' + recLink(r) + ' <span class="num">text ' + r.textLinks.length + ' vs array ' + r.arrayLinks.length + ': ' + esc(r.onlyText.slice(0, 4).join(', ')) + '</span></li>'),
  '<h2>Array holds links the text does not (' + arrayMore.length + ')</h2>',
  listOf(arrayMore.slice(0, 20), r => '<li>' + recLink(r) + ' <span class="num">' + esc(r.onlyArray.slice(0, 4).join(', ')) + '</span></li>'),
  '<h2>Mostly someone else\'s text</h2>',
  '<p class="num">Share of the record\'s 100-char windows that also appear in another record. High means the page is mostly a copy of a rule that lives elsewhere.</p>',
  listOf(borrowed, r => '<li>' + recLink(r) + ' <span class="num">' + Math.round(r.borrowed * 100) + '% borrowed, ' + r.chars + 'c</span></li>'),
  '<h2>Biggest</h2>',
  listOf(biggest, r => '<li>' + recLink(r) + ' <span class="num">' + r.chars + 'c</span></li>'),
  '<h2>Emptiest</h2>',
  listOf(emptiest, r => '<li>' + recLink(r) + ' <span class="num">' + r.chars + 'c</span></li>'),
].join('\n')));


// A rule page's sections and subsections collapse: the corpus's own child
// records that are sections in the same chapter, rendered as nested native
// <details>. The body embedded is bounded and links to the full page; there is
// no script, so the open/closed state is per page load and does not survive
// navigation.
const leafOf = rec => { const p = String(rec.heading || '').split(' > ').filter(Boolean); return p.length ? p[p.length - 1] : rec.id; };
// The tree's own nesting: a subsection is never a sibling of its parent.
const sectionKids = rec => (tree.childrenOf.get(rec.id) || []).map(id => byId.get(id)).filter(Boolean);
const sectionText = rec => { const t = String(rec.text || ''); return '<pre class="text">' + esc(t.length > 1600 ? t.slice(0, 1600) + '\n…' : t) + '</pre>'; };
const sectionsHtml = (rec, depth) => {
  if (depth <= 0) return '';
  const kids = sectionKids(rec);
  if (!kids.length) return '';
  return '<h2>Sections (' + kids.length + ')</h2>' + kids.map(c => '<details class="wsec" open><summary>' + esc(leafOf(c)) + '</summary><div class="wsecbody">' + sectionText(c) + '</div><p class="wseclink"><a href="' + esc(hrefOf(c.id)) + '">Open section</a></p>' + sectionsHtml(c, depth - 1) + '</details>').join('');
};
// one page per record. WIKI_RENDER_ONLY=<id>[,<id>] renders just those: it is what
// the two-paths test uses to compare this render's fragment with the one the
// server serves on demand, without paying for 6,705 pages to prove one.
let written = 0;
for (const r of delivered) {
  if (onlySet && !onlySet.has(r.id)) continue;
  const crumbs = String(r.heading || '').split(' > ').filter(Boolean);
  const crumbHtml = crumbs.map((c, i) => {
    const prefix = crumbs.slice(0, i + 1).join(' > ');
    const target = records.find(x => x.heading === prefix);
    const th = target && target.id !== r.id ? hrefOf(target.id) : '';
    return th ? '<a href="' + esc(th) + '">' + esc(c) + '</a>' : esc(c);
  }).join(' &rsaquo; ');
  const back = (reverse.get(r.id) || []).slice(0, 40);
  // The product shell: the top bar the ask page has, over the record itself. The
  // developer furniture (the link block, the reading aids) moves into one row of
  // links at the foot, so nothing is lost and nothing is in the reader's way.
  const leaf = crumbs.length ? crumbs[crumbs.length - 1] : (r.heading || r.id);
  const annoTitle = a => { const p = String(a.heading || '').split(' > ').filter(Boolean); return p.length ? p[p.length - 1] : a.id; };
  const folded = tree.attach.get(r.id) || [];
  const foldsInto = tree.attachTarget.get(r.id) || '';
  const sections = (r.kind === 'rule' && !isAnnotation(r)) ? sectionsHtml(r, 2) : '';
  // A detachment's own enhancements and stratagems live on its page: one page
  // per detachment, and nothing nests beneath it in the tree.
  const detOwned = tree.owned.get(r.id);
  const ownedHtml = detOwned ? [['Enhancements', detOwned.enh], ['Stratagems', detOwned.strat]].filter(pair => pair[1].length).map(pair => {
    const list = pair[1].map(id => byId.get(id)).filter(Boolean).sort((a, b) => String(a.heading || '').localeCompare(String(b.heading || '')));
    return '<h2>' + pair[0] + ' (' + list.length + ')</h2>' + list.map(x => '<details class="wsec" open><summary>' + esc(leafOf(x)) + '</summary><div class="wsecbody">' + esc(String(x.text || '').slice(0, 1200)) + '</div><p class="wseclink"><a href="' + esc(hrefOf(x.id)) + '">Open record</a></p></details>').join('');
  }).join('') : '';
  // The datasheet and its unitrules twin are one page: the card already carries
  // the keywords and abilities, so the twin is a collapsed section, not a row.
  // One page per datasheet: the twin and any extra part of the same record are
  // folded on as collapsed sections, not listed as units of their own.
  const mergedList = (tree.mergedOn.get(r.id) || []).map(mid => byId.get(mid)).filter(Boolean);
  const mergedHtml = mergedList.length ? '<h2>Merged records (' + mergedList.length + ')</h2>' + mergedList.map(x => '<details class="wsec"><summary>' + esc(leafOf(x)) + '</summary><div class="wsecbody">' + esc(String(x.text || '').slice(0, 4000)) + '</div><p class="wseclink"><a href="' + esc(hrefOf(x.id)) + '">Open the merged record</a></p></details>').join('') : '';
  const body = [
    topBar({}),
    '<main class="wrec">',
    '<p class="wcrumb">' + (crumbHtml || '<a href="index.html">index</a>') + '</p>',
    '<h1 class="wtitle">' + esc(leaf) + '</h1>',
    '<p class="wmeta">' + esc(r.id) + ' &middot; ' + esc(r.kind) + ' &middot; ' + esc(r.source) + ' &middot; ' + r.chars + ' chars</p>',
    // The record body: the structured card for a datasheet or unitrules record,
    // the flat text for everything else (and for the 111 card records whose CSV
    // row is missing, which fall back to the same text).
    recordBody(r, { corpora, index: cardIdx, href: id => hrefOf(id) }),
    // The rule's own sections and subsections, each a collapsible <details>.
    sections,
    ownedHtml,
    mergedHtml,
    // A folded annotation still has its own page, and points back to its section.
    (foldsInto && live.has(foldsInto)) ? '<p class="qa-back">Folded into <a href="' + esc(hrefOf(foldsInto)) + '">' + esc(byId.get(foldsInto).heading) + '</a></p>' : '',
    // The annotation's section carries the folded questions and errata, so they
    // stay reachable from the tree even though they are not tree rows.
    folded.length ? '<h2>Questions and errata (' + folded.length + ')</h2>' + folded.map(a => '<details class="wqa"><summary>' + esc(annoTitle(a)) + '</summary><div class="wsecbody">' + esc(String(a.text || '').slice(0, 1200)) + '</div><p class="wseclink"><a href="' + esc(hrefOf(a.id)) + '">Open question</a></p></details>').join('') : '',
    '<h2>Links (' + r.links.length + ')</h2>',
    linkChips(r.links, true),
    (r.parent && live.has(r.parent)) ? '<p class="num">Parent: <a href="' + esc(hrefOf(r.parent)) + '">' + esc(byId.get(r.parent).heading) + '</a></p>' : '',
    back.filter(id => live.has(id)).length ? '<h2>Linked from (' + back.filter(id => live.has(id)).length + ')</h2><ul class="chips">' + back.filter(id => live.has(id)).map(id => '<li><a href="' + esc(hrefOf(id)) + '">' + esc(byId.get(id).heading || id) + '</a></li>').join('') + '</ul>' : '',
    (r.onlyText.length || r.onlyArray.length) ? '<p class="num missing">This page\'s text and its link array disagree.</p>' : '',
    r.links.length ? '<h2>The corpus\'s own link block</h2><pre class="block">' + esc(r.arrayBlock) + '</pre>' : '',
    '<p class="wfoot">' + esc(r.id) + ' &middot; ' + esc(r.kind) + ' &middot; ' + esc(r.source) + '</p>',
    '<div class="wdev"><a href="index.html">Index</a><a href="search.html">Search</a><a href="anomalies.html">Reading aids</a></div>',
    '</main>',
  ].filter(Boolean).join('\n');
  fs.writeFileSync(path.join(OUT, pageOf.get(r.id)), productPage(leaf, body, Object.assign({}, r, { area: areaOf.get(r.id) || '', path: tree.paths.get(r.id) || [], at: tree.attachTarget.get(r.id) || '' })));
  written++;
}
// One page per army-rules set: a synthetic page, not a record. Its members are
// rendered inline, so the tree holds a single row and nothing nests beneath it.
let synthetic = 0;
for (const p of tree.pages) {
  const members = p.recs.map(id => byId.get(id)).filter(Boolean);
  const synthBody = [
    topBar({}),
    '<main class="wrec">',
    '<p class="wcrumb">' + p.path.map(s => esc(s.n)).join(' &rsaquo; ') + '</p>',
    '<h1 class="wtitle">' + esc(p.n) + '</h1>',
    '<p class="wmeta">' + esc(p.area) + ' &middot; ' + members.length + (p.lvl === 'army-rules' ? ' army rules' : ' records') + '</p>',
    members.map(x => '<details class="wsec" open><summary>' + esc(leafOf(x)) + '</summary><div class="wsecbody">' + esc(String(x.text || '').slice(0, 4000)) + '</div><p class="wseclink"><a href="' + esc(hrefOf(x.id)) + '">Open record</a></p></details>').join(''),
    '<p class="wfoot">' + (p.lvl === 'army-rules' ? 'One page holding every army rule of this faction.' : 'One page holding everything this detachment owns.') + ' Nothing nests beneath it.</p>',
    '</main>',
  ].join('\n');
  const out = path.join(OUT, p.f);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, productPage(p.n, synthBody, null, null));
  synthetic += 1;
}
// The record -> page map, so a server can link a finding's record to its page
// without re-deriving the slug - the slug carries a hash this script owns, and a
// second implementation of it would drift. Missing map = no deep link, never a
// dead one.
// The product entry: /wiki/ serves this, with the tree open on Core Rules. The
// developer index stays where it is (reachable from the foot) until slice 8.
const tocAreas = toc.areas;
const homeBody = [
  topBar({}),
  '<main class="wrec">',
  '<p class="wcrumb">Wiki</p>',
  '<h1 class="wtitle">40k rules</h1>',
  '<p class="wmeta">' + records.length + ' records \u00b7 ' + tocAreas.length + ' areas</p>',
  '<p class="wfoot">Every page is also reachable from the Wiki control above, and the developer index is at <a href="index.html">index.html</a>.</p>',
  '</main>',
].join('\n');
// The cold /wiki/: no record context, so the cascade rests at the root and its
// bar shows the three branches one tap away.
fs.writeFileSync(path.join(OUT, 'home.html'), productPage('40k rules', homeBody, null, null));
// The map is the manifest of what this pass wrote: live records, and under
// WIKI_RENDER_ONLY only the ones it rendered, so a partial render never claims a
// page it did not write.
fs.writeFileSync(path.join(OUT, 'map.json'), JSON.stringify(Object.fromEntries([...pageOf].filter(([id]) => writtenIds.has(id)))));
// --- the output directory holds this pass, and nothing older ------------------
// Pages are named <base>-<contenthash>.html, so a rebuild renames instead of
// replacing: the directory used to become a union of every state ever rendered
// (after the edition rebuild, 1,218 pages for ids no longer in the corpus -
// deleted Legends and Boarding Actions content still served at its old URL, and
// a stale synthetic page still listing it). Track what this pass wrote and sweep
// the rest. The scope is deliberately narrow: only files matching the page
// pattern, and only files under tree/ (the node files and the synthetic pages
// this script owns). A hand-authored asset - shell.css, card.css, search.html,
// anything without a content hash - is left alone even if it looks unused.
const keep = new Set();
const noteKeep = f => keep.add(String(f).split(path.sep).join('/'));
for (const id of writtenIds) noteKeep(pageOf.get(id));
for (const p of tree.pages) noteKeep(p.f);
for (const f of Object.keys(tree.files)) noteKeep(f);
noteKeep('tree/index.js');
for (const f of ['wiki.css', 'card.css', 'shell.css', 'shell.js', 'shell-data.js', 'index.html', 'search.html', 'anomalies.html', 'home.html', 'map.json', 'render.json', 'legacy.json']) noteKeep(f);
for (const a of toc.areas) noteKeep(a.f);
// hash8() is FNV-1a in base36, unpadded: 4 to 8 characters. Matching that is
// what keeps a hand-authored "keep-me.html" (2) out of the sweep.
const PAGE_FILE = /-[a-z0-9]{4,8}\.html$/;
let pruned = 0;
const sweep = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(OUT, full).split(path.sep).join('/');
    if (entry.isDirectory()) { sweep(full); if (!fs.readdirSync(full).length) fs.rmdirSync(full); continue; }
    if (keep.has(rel)) continue;
    const owned = PAGE_FILE.test(rel) || rel.indexOf('tree/') === 0;
    if (owned) { fs.rmSync(full); pruned += 1; }
  }
};
sweep(OUT);
console.log('wiki-render -> ' + OUT);
console.log('  records rendered      ' + written);
console.log('  tree branches         ' + tree.index.branches.map(b => b.n + ' ' + b.c).join(', ') + '  (placed ' + tree.stats.placed + ' of ' + tree.stats.total + ', excluded ' + tree.stats.excluded + ' index stubs)');
console.log('  tree node files       ' + (Object.keys(tree.files).length + 1));
console.log('  synthetic pages       ' + synthetic + ' (one per army-rules set, one per page for a detachment)');
console.log('  stale pages pruned    ' + pruned + ' (pages and tree files this pass did not write)');
console.log('  filtered records      ' + tree.stats.filtered + ' (edition 0 / Warhammer Legends) / merged unitrules ' + tree.stats.merged);
console.log('  kept segments         ' + kept.length + ' records');
console.log('  debris                ' + debris.length);
console.log('  dangling links        ' + dangling.length + ' records');
console.log('  text/array disagree   ' + disagree.length + '  (text-only ' + textMore.length + ', array-only ' + arrayMore.length + ')');
console.log('  mostly borrowed (top) ' + (borrowed[0] ? Math.round(borrowed[0].borrowed * 100) + '% ' + borrowed[0].id : '-'));
console.log('  biggest               ' + (biggest[0] ? biggest[0].chars + 'c ' + biggest[0].id : '-'));
console.log('  emptiest              ' + (emptiest[0] ? emptiest[0].chars + 'c ' + emptiest[0].id : '-'));
// The pass writes its own numbers beside the pages, so the diagnostics surface
// reads one file instead of scraping stdout: how many pages, and what the last
// pass pruned. Written last, so it describes a finished pass.
// The readable-URL rename leaves the old hashed names in the wild, so the pass
// writes the one-way map the server redirects with. Delivered records only: a
// filtered record's old URL has no new page and keeps its 404.
const legacy = {};
for (const id of writtenIds) legacy[pageSlug(id) + '.html'] = pageOf.get(id);
fs.writeFileSync(path.join(OUT, 'legacy.json'), JSON.stringify(legacy) + '\n');
fs.writeFileSync(path.join(OUT, 'render.json'), JSON.stringify({
  writtenAt: new Date().toISOString(),
  records: written,
  pages: writtenIds.size,
  pruned: pruned,
  treeFiles: Object.keys(tree.files).length + 1,
  branches: tree.index.branches.map(b => ({ n: b.n, c: b.c })),
  total: tree.stats.total,
  filtered: tree.stats.filtered,
  excluded: tree.stats.excluded,
}, null, 1) + '\n');