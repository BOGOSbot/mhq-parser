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

const OUT = process.env.WIKI_RENDER_DIR || path.join('workspace', 'wiki-render');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
function hash8(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
const slug = id => String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) + '-' + hash8(String(id));

const CSS = [
  ':root { --ink:#1a1a1a; --dim:#666; --line:#e2e2e2; --bg:#fdfdfc; --chip:#f2f4f7; --warn:#b3261e; --ok:#1b5e20; }'
  , '@media (prefers-color-scheme: dark) { :root { --ink:#e8e8e6; --dim:#9a9a96; --line:#333; --bg:#16161a; --chip:#24242a; --warn:#ff8a80; --ok:#8bd18b; } }'
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
  , '@media (max-width:600px){ main{padding:0 .7rem 3rem;} h1{font-size:1.2rem;} .text{font-size:.95rem;} }'
].join('\n');

function page(title, nav, body) {
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + esc(title) + '</title>\n<link rel="stylesheet" href="wiki.css">\n</head>\n<body>\n<header><nav>' + nav + '</nav></header>\n<main>\n' + body + '\n</main>\n</body>\n</html>\n';
}
const NAV = '<a href="index.html">Index</a><a href="search.html">Search</a><a href="anomalies.html">Reading aids</a>';

const all = readAllCorpus();
const byId = new Map(all.map(r => [r.id, r]));
const pageOf = new Map(all.map(r => [r.id, slug(r.id) + '.html']));
const records = all.map(r => ({
  id: r.id, heading: r.heading || '', kind: r.kind || '', source: r.source || '', set: r.set || '',
  text: String(r.text || ''), links: Array.isArray(r.links) ? r.links : [], parent: r.parent || '', children: Array.isArray(r.children) ? r.children : [],
}));

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
    const has = byId.has(l.to);
    const label = '<span class="kind">' + esc(l.kind || 'link') + '</span> ' + esc(l.title || l.to);
    if (has) return '<li><a href="' + esc(pageOf.get(l.to)) + '">' + label + '</a></li>';
    return '<li><span class="missing" title="' + esc(l.to) + '">' + label + ' (missing)</span></li>';
  }).join('');
  return '<ul class="chips">' + items + '</ul>';
}

// --- the pages ------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'wiki.css'), CSS);

const counts = {};
for (const r of records) counts[r.kind || '(none)'] = (counts[r.kind || '(none)'] || 0) + 1;
const sources = {};
for (const r of records) sources[r.source || '(none)'] = (sources[r.source || '(none)'] || 0) + 1;
const idxRows = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map(k => '<tr><td><a href="search.html?kind=' + esc(k) + '">' + esc(k) + '</a></td><td class="num">' + counts[k] + '</td></tr>').join('');
const srcRows = Object.keys(sources).sort((a, b) => sources[b] - sources[a]).map(k => '<tr><td>' + esc(k) + '</td><td class="num">' + sources[k] + '</td></tr>').join('');
fs.writeFileSync(path.join(OUT, 'index.html'), page('Rules corpus - index', NAV, [
  '<h1>Rules corpus</h1>',
  '<p class="num">' + records.length + ' records, rendered from workspace/rules-corpus. A render, not a source: nothing here is read back into the corpus, and nothing here is committed.</p>',
  '<h2>Read task 30</h2>',
  '<ul class="plain">',
  '<li><a href="anomalies.html">Reading aids</a> - records that still carry another rule\'s text, links that point nowhere, bodies that are mostly someone else\'s rule, biggest and emptiest.</li>',
  '<li><a href="' + esc(pageOf.get('unitrules#000002541')) + '">unitrules#000002541</a> - the Starweaver record the restructure merged (Rapid Embarkation).</li>',
  '</ul>',
  '<h2>By kind</h2><table>' + idxRows + '</table>',
  '<h2>By source</h2><table>' + srcRows + '</table>',
].join('\n')));

// search over headings, filtering a list rendered at build time
const searchRows = records.slice().sort((a, b) => a.heading.localeCompare(b.heading)).map(r =>
  '<li data-h="' + esc((r.heading + ' ' + r.id).toLowerCase()) + '" data-k="' + esc(r.kind) + '"><a href="' + esc(pageOf.get(r.id)) + '">' + esc(r.heading || r.id) + '</a> <span class="num">' + esc(r.kind) + '</span></li>').join('');
fs.writeFileSync(path.join(OUT, 'search.html'), page('Search headings', NAV, [
  '<h1>Search</h1>',
  '<p><input type="search" id="q" placeholder="Filter ' + records.length + ' headings\u2026" autocomplete="off"></p>',
  '<p class="num" id="n"></p>',
  '<ul class="plain" id="list">' + searchRows + '</ul>',
  '<script>',
  'var q=document.getElementById("q"),list=document.getElementById("list"),n=document.getElementById("n"),items=[].slice.call(list.children);',
  'function kind(){var m=/[?&]kind=([^&]+)/.exec(location.search);return m?decodeURIComponent(m[1]):"";}',
  'function run(){var s=q.value.toLowerCase().trim(),k=kind(),shown=0;for(var i=0;i<items.length;i++){var it=items[i],ok=(!s||it.getAttribute("data-h").indexOf(s)!==-1)&&(!k||it.getAttribute("data-k")===k);it.style.display=ok?"":"none";if(ok)shown++;}n.textContent=shown+" of "+items.length+" headings"+(k?" (kind "+k+")":"");}',
  'q.addEventListener("input",run);run();',
  '</script>',
].join('\n')));

const listOf = (rows, render) => '<ul class="plain">' + rows.map(render).join('') + '</ul>';
const recLink = r => '<a href="' + esc(pageOf.get(r.id)) + '">' + esc(r.heading || r.id) + '</a>';
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

// one page per record
let written = 0;
for (const r of records) {
  const crumbs = String(r.heading || '').split(' > ').filter(Boolean);
  const crumbHtml = crumbs.map((c, i) => {
    const prefix = crumbs.slice(0, i + 1).join(' > ');
    const target = records.find(x => x.heading === prefix);
    return target && target.id !== r.id ? '<a href="' + esc(pageOf.get(target.id)) + '">' + esc(c) + '</a>' : esc(c);
  }).join(' &rsaquo; ');
  const back = (reverse.get(r.id) || []).slice(0, 40);
  const body = [
    '<p class="crumb">' + (crumbHtml || '<a href="index.html">index</a>') + '</p>',
    '<h1>' + esc(crumbs.length ? crumbs[crumbs.length - 1] : (r.heading || r.id)) + '</h1>',
    '<p class="meta">' + esc(r.id) + ' &middot; ' + esc(r.kind) + ' &middot; ' + esc(r.source) + ' &middot; ' + r.chars + ' chars</p>',
    '<pre class="text">' + esc(r.text) + '</pre>',
    (r.onlyText.length || r.onlyArray.length) ? '<p class="num missing">This page\'s text and its link array disagree: ' + r.onlyText.length + ' link(s) only in the text, ' + r.onlyArray.length + ' only in the array.</p>' : '',
    '<h2>Links (' + r.links.length + ')</h2>',
    linkChips(r.links, true),
    r.links.length ? '<h2>The corpus\'s own link block</h2><pre class="block">' + esc(r.arrayBlock) + '</pre>' : '',
    r.parent && byId.has(r.parent) ? '<p class="num">Parent: <a href="' + esc(pageOf.get(r.parent)) + '">' + esc(byId.get(r.parent).heading) + '</a></p>' : '',
    back.length ? '<h2>Linked from (' + back.length + ')</h2><ul class="chips">' + back.map(id => '<li><a href="' + esc(pageOf.get(id)) + '">' + esc(byId.get(id).heading || id) + '</a></li>').join('') + '</ul>' : '',
  ].filter(Boolean).join('\n');
  fs.writeFileSync(path.join(OUT, pageOf.get(r.id)), page(r.heading || r.id, NAV, body));
  written++;
}
// The record -> page map, so a server can link a finding's record to its page
// without re-deriving the slug - the slug carries a hash this script owns, and a
// second implementation of it would drift. Missing map = no deep link, never a
// dead one.
fs.writeFileSync(path.join(OUT, 'map.json'), JSON.stringify(Object.fromEntries(pageOf)));
console.log('wiki-render -> ' + OUT);
console.log('  records rendered      ' + written);
console.log('  kept segments         ' + kept.length + ' records');
console.log('  debris                ' + debris.length);
console.log('  dangling links        ' + dangling.length + ' records');
console.log('  text/array disagree   ' + disagree.length + '  (text-only ' + textMore.length + ', array-only ' + arrayMore.length + ')');
console.log('  mostly borrowed (top) ' + (borrowed[0] ? Math.round(borrowed[0].borrowed * 100) + '% ' + borrowed[0].id : '-'));
console.log('  biggest               ' + (biggest[0] ? biggest[0].chars + 'c ' + biggest[0].id : '-'));
console.log('  emptiest              ' + (emptiest[0] ? emptiest[0].chars + 'c ' + emptiest[0].id : '-'));