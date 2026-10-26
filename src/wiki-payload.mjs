#!/usr/bin/env node
'use strict';
/**
 * wiki-payload: the bake. The one place the corpus becomes something a reader can
 * fetch, so the interface is deliberately small and everything under it is the
 * index model the render already uses - tocTree is called here, exactly as
 * wiki-render.mjs calls it, so there is one implementation of the branches.
 *
 * Three shapes, written into outDir (workspace/wiki-data by default):
 *   index.json            { branches: [{ n, c, b }] }
 *   index/<b>.json        { n, lvl, c, kids: [...], recs: [...], pages: [...] }
 *   content/<book>.json   { book, records: { id: { ...record } } }
 *
 * And, since task-108, ONE addressing table:
 *   index/rows.json       { rows: { <id>: { slug, title, book, source, snippet,
 *                          num?, path?, own? } } }
 *                         every delivered record, so an id becomes an address AND the
 *                         drawer's own row in one place (src/rows-table.mjs), instead of
 *                         the four partial shapes that phase 1 replaced. The per-branch
 *                         index/<b>-rows.json files are gone (part A, 2026-10-24): the
 *                         tree's pages and a detachment's owned list are ids, and every
 *                         one of them now resolves through this table.
 *
 * A record's slug carries its book ('<book>--<readable>-<hash>'), so a cold
 * address resolves with no manifest: split on '--', fetch that one content file,
 * find the record. The record's fields are the seam's; the text is the STORED
 * text and no HTML is baked - no card rendering, no CARD_CSS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, isLegendsRecord } from './rules-corpus.mjs';
import { allianceAssigner, detachmentName, factionAssigner, factionRoster, nodeSlug, pageNamer, tocTree } from './wiki-toc.mjs';
// The naming model: the heading path, the marker strip, the page address (tasks/title-module.md).
import { cleanTitle, leafOf, pageSlug, splitHeading } from './title.mjs';
import { stripSeeAlso } from './wiki-plan.mjs';
import { cardTables } from './unit-card.mjs';
import { frFresh } from './i18n-fr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(REPO, 'workspace', 'wiki-data');

// The record projection the tree reads, the same fields wiki-render.mjs carries:
// url and faction are what the tree files a record by, anchor and ruleId resolve
// the Rules chapters, edition feeds the faction filters, provenance and text_en
// are what a ruling needs. Without these the tree would drift from the tests'.
function project(r) {
  return {
    id: r.id, heading: r.heading || '', kind: r.kind || '', source: r.source || '', set: r.set || '',
    text: String(r.text || ''), links: Array.isArray(r.links) ? r.links : [], parent: r.parent || '', children: Array.isArray(r.children) ? r.children : [],
    url: r.url || '', faction: r.faction || '', anchor: r.anchor || '', ruleId: r.ruleId || '',
    edition: r.edition == null ? '' : String(r.edition),
    provenance: r.provenance || null,
    text_en: r.text_en || '',
  };
}

// task-69: the French overlay, read from the translation pass's export and grouped by the
// SAME bookOf the English payload uses, so a record's French lives in the book the reader
// opened. Returns { source, translated, blocked, <book>: { text: { id: fr } } }.
//
// The export is 14.8 MB and carries the whole pass record; only the French text is kept
// here. It is NOT read when the file is absent (a checkout with no translation still
// bakes) - the function reports zero and the bake writes an empty index.
const FR_SOURCE = path.join(REPO, 'workspace', 'i18n', 'fr-full.json');
// Mandal, 2026-10-24: only French whose English has not moved is baked. The freshness
// decision lives in i18n-fr (one place, one hash), so the payload and the server cannot
// disagree about which records are still translated.
export function frByBook(ids, bookOf, enOf) {
  const out = { source: '', translated: 0, blocked: 0, stale: 0 };
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(FR_SOURCE, 'utf8')); } catch (e) { return out; }
  out.source = String(raw.exported_at || '');
  for (const rec of (raw.records || [])) { if (rec && rec.fr) out.translated++; else out.blocked++; }
  for (const id of (ids || [])) {
    const key = String(id);
    const fr = frFresh(key, enOf ? enOf(key) : undefined);
    if (fr === null) { out.stale++; continue; }
    const book = bookOf(key);
    if (!out[book]) out[book] = { text: {} };
    out[book].text[key] = fr;
  }
  return out;
}

const textOf = rec => String((rec && rec.text) || '');
// The name a row carries: the heading's own leaf, the same read wiki-toc's own rows use.

// The drawer's one-line row: id, slug, title, source and a plain-text snippet of
// at most 100 characters, so a branch renders its lines without fetching content.
// The row's one-line summary. The corpus writes the heading as the section's
// first line and a Source line right after it, both of which the reader already
// sees above the row; a hard slice then cut mid-word ('Codex: Adeptus Custodes
// (e'), which reads as a broken record rather than a summary. Drop the echo,
// drop the Source line, and cut on a word end.
export function snippetOf(text, heading, max) {
  const limit = max || 100;
  const head = String(heading || '').replace(/\s+/g, ' ').trim();
  // Work line by line while the lines still exist: the echo and the Source line
  // are whole lines, and collapsing first glues them into the sentence.
  const lines = String(text || '').split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
  if (lines.length && head && lines[0].indexOf(head) === 0) lines.shift();
  if (lines.length && /^Source: /i.test(lines[0])) lines.shift();
  let t = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit);
  const sentence = cut.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (sentence && sentence[0].length >= limit * 0.4) return sentence[0].trim();
  const space = cut.lastIndexOf(' ');
  return (space > 20 ? cut.slice(0, space) : cut).trim() + '\u2026';
}

function row(rec, slugOf, byId, chapter) {
  const raw = byId.get(rec.i) || {};
  const plain = textOf(raw).replace(/\s+/g, ' ').trim();
  // task-88: a record whose heading ends in its chapter's own name is the chapter's lead
  // block, and the chapter header already names it: '05 Attack Sequence' under the chapter
  // '05 Attack Sequence' names the same thing twice. Such a block takes its own heading's
  // remaining segments ('3. Resolve Attacks > Attack Sequence' -> '3. Resolve Attacks'),
  // and the chapter's number is not its number, so it is not printed twice either.
  const chLabel = String(chapter || '');
  // task-5: a section ('01.02 Units and Models') has a lead row carrying the same
  // rule, and task-88's lead-row rule would title that row with its parent path
  // instead ('Core Concepts'), which is worse in a section than the repetition.
  const isSection = /^\d{2}\.\d{2} /.test(chLabel);
  const chName = chLabel.replace(/^\d{2}(?:\.\d+)?\s*/, '').trim();
  const chNum = (chLabel.match(isSection ? /^(\d{2}\.\d{2})/ : /^(\d{2})/) || [])[1] || '';
  const segs = splitHeading(raw.heading).map(s => s.trim()).filter(Boolean);
  // task-4: the appendix's ability tag is a container, not a parent - the page
  // headings the Universal Rules Updates block '[ONE SHOT] > Universal Rules
  // Updates', and task-88's lead-row rule would print that row as '[ONE SHOT]'
  // under the 00 chapter, the very heading this task removed. A remaining path
  // that is only a bracketed tag falls back to the record's own leaf.
  const parent = !isSection && chName && segs.length && segs[segs.length - 1].toLowerCase() === chName.toLowerCase() ? segs.slice(0, -1).join(' > ') : '';
  const own = /^\[[^\]]+\]$/.test(parent) ? '' : parent;
  // task-106: a rule's number is sometimes still inside its heading - the appendix's
  // errata h3s carry '01.02.06 Splitting Units' and no ruleId - so the number moves
  // into the row's own slot and the title loses it. A record whose text is an errata
  // ('Add: ...', 'Change: ...') says so: two rows named 'Splitting Units' read as a
  // duplicate otherwise, and one of them is the errata to the other.
  const leaf = (splitHeading(raw.heading).pop() || '').trim();
  // The stored text carries its heading in front (the corpus writes it there so the
  // vector sees the context), so the errata verb is read after that echo.
  const body = plain.indexOf(String(raw.heading || '')) === 0 ? plain.slice(String(raw.heading || '').length).trim() : plain;
  const glued = !raw.ruleId ? /^(\d{2}(?:\.\d{2}){1,2})\b\s*[-\u2013]?\s*/.exec(leaf) : null;
  const num = raw.ruleId || (glued ? glued[1] : '');
  let title = own || rec.t || '';
  if (glued) {
    const stripped = String(title).replace(/^\d{2}(?:\.\d{2}){1,2}\s*[-\u2013]?\s*/, '').trim();
    if (stripped && stripped !== title) title = stripped;
    if (/^(?:add|change|replace|remove|delete|amend)\s*:/i.test(body)) title += ' \u2014 errata';
  }
  // task-87: the rule's own number ('01.05'); the row renders 'num title' when set. Omitted
  // when empty (the factions branch's 5,185 rows) and when it is only the chapter's number.
  const out = { id: rec.i, slug: slugOf(rec.i), title: title, source: raw.source || '', snippet: snippetOf(textOf(raw), raw.heading, 100) };
  if (num && num !== chNum) out.num = num;
  return out;
}

// One node of a branch, inlined: the file references ('f') become nested objects
// and the record rows lose their page file for the slug. A single-page node keeps
// a marker and is listed in the branch's pages.
function inlineNode(key, tree, slugOf, byId, seen) {
  const node = tree.files[key] || {};
  const out = { n: node.n, lvl: node.lvl, c: node.c };
  if (node.cut) out.cut = true;
  if (node.pg) out.page = true;
  if (node.kids && node.kids.length) out.kids = node.kids.map(k => (k.f && tree.files[k.f] && !seen.has(k.f)) ? inlineNode(k.f, tree, slugOf, byId, new Set([...seen, k.f])) : { n: k.n, lvl: k.lvl, c: k.c, ...(k.cut ? { cut: true } : {}), ...(k.pg ? { page: true } : {}) });
  if (node.recs && node.recs.length) out.recs = node.recs.map(r => row(r, slugOf, byId, node.n));
  return out;
}

export function buildPayloads(corpus, outDir) {
  const out = outDir || DEFAULT_OUT;
  const all = corpus || readAllCorpus();
  const byId = new Map(all.map(r => [r.id, r]));
  const records = all.map(project);
  const pageOf = pageNamer(all);
  const tables = cardTables();
  const roster = factionRoster(tables.factionName, tables.factionLink);
  const factionOf = factionAssigner(roster);
  const allianceOf = allianceAssigner(roster, tables.datasheets, tables.keywords);
  const tree = tocTree(records, pageOf, { roster: roster, factionOf: factionOf, allianceOf: allianceOf });

  // Delivery: a record is delivered iff the tree keeps it - pageNamer minus the
  // tree's filtered set. This is wiki-render.mjs's own rule, so the bake keeps the
  // same 6,271 the render pages, not an approximation.
  const filtered = new Set(tree.filtered || []);
  // Mandal, 2026-10-24: a kind 'index' page is navigation (a faction's card list), not a
  // rule, and the tree does not show it - so it gets no body either. It was 174 stubs of
  // 43 to 175 characters that no reader could reach.
  const isNavOnly = id => String(((byId.get(id) || {}).kind) || '') === 'index';
  const live = [...pageOf.keys()].filter(id => !filtered.has(id)).filter(id => !isNavOnly(id));

  // The book is the tree's own placement, never set or source: stratagems,
  // enhancements and detachments carry source 'stratagems' and an empty faction,
  // and 923 unitrules carry no faction url - the tree assigns them. A record with
  // a path takes the branch it sits in; one without a path (index stubs, dropped
  // front matter, unattached annotations) is placed by the same roster+assigner
  // signal the tree used, and falls back to the Rules book.
  const slugByName = new Map(roster.map(f => [f.name, f.slug]));
  // The BRANCH comes from the tree's path; the FACTION comes from the same roster
  // + factionAssigner that built the tree's own byFaction buckets (wiki-toc.mjs
  // line 1027), not from the path's faction element. The path is overwritten for
  // every merged twin: mergedHere is declared outside the faction loop and line
  // 1125 re-sets each accumulated id to the CURRENT faction's Units node, so the
  // last faction wins and 1,713 unitrules twins carried a Tyranids chain. Reading
  // the assigner instead gives the twin the book of the record it belongs to
  // without touching the index model (slice 1 may not). Reported, not fixed here.
  const bookOf = id => {
    const raw = byId.get(id) || {};
    const chain = tree.paths.get(id) || [];
    const branch = chain.length ? chain[0].n : '';
    const fac = factionOf(raw);
    if (branch === 'Factions' || (!branch && fac && slugByName.has(fac))) {
      return fac && slugByName.has(fac) ? 'faction-' + slugByName.get(fac) : 'rules';
    }
    if (branch === 'Missions') return 'missions';
    return 'rules';
  };

  const books = new Map();
  for (const id of live) { const b = bookOf(id); if (!books.has(b)) books.set(b, []); books.get(b).push(id); }
  // The one page address (src/title.mjs): its book, the readable title, the id hash.
  const slugOf = id => pageSlug(byId.get(id) || {}, bookOf(id));

  // --- write ----------------------------------------------------------------
  // Sweep first: the bake owns these two directories, and without this the output
  // becomes the union of every state ever baked (a renamed book or branch leaves
  // its old file behind and a cold address still resolves it - wiki-render.mjs
  // learned the same lesson on its tree sweep).
  fs.rmSync(path.join(out, 'index'), { recursive: true, force: true });
  fs.rmSync(path.join(out, 'content'), { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'index'), { recursive: true });
  fs.mkdirSync(path.join(out, 'content'), { recursive: true });
  const files = [];
  const write = (rel, value) => {
    const file = path.join(out, rel);
    const body = JSON.stringify(value);
    fs.writeFileSync(file, body);
    files.push({ name: rel, bytes: Buffer.byteLength(body) });
  };

  // index.json: the branches with the key each one's payload lives under. The Legends
  // branch is deliberately NOT in this list: a reader with the setting off fetches this
  // file and the tree it names, and never asks for index/legends.json (task-44).
  const branches = tree.index.branches.map(b => ({ n: b.n, c: b.c, b: path.basename(String(b.f || ''), '.js') }));
  write('index.json', { branches: branches });

  // task-108: the rows the TREE carries, id -> the row object its branch payload got. The
  // title in there is chapter-aware (a chapter's lead block is titled by its parent path),
  // and the addressing table below must not invent a second name for a record the tree
  // already names. Filled while the branches are written, read once, after the loop.
  const treeRows = new Map();
  const collectTreeRows = n => {
    for (const r of (n.recs || [])) { const id = String(r.id); if (!treeRows.has(id)) treeRows.set(id, r); }
    for (const k of (n.kids || [])) collectTreeRows(k);
  };
  // The ids a detachment owns (its enhancements and stratagems): the branch payload carries
  // them as `own`, and the table carries the same list for the same ids.
  const ownedBy = id => (tree.owned && tree.owned.get(id)) ? tree.owned.get(id).enh.concat(tree.owned.get(id).strat) : null;

  for (const b of branches) {
    const ref = tree.index.branches.find(x => path.basename(String(x.f || ''), '.js') === b.b) || {};
    const node = { n: b.n, lvl: 'branch', c: b.c, kids: [], recs: [], pages: [] };
    const root = tree.files[ref.f] || {};
    if (root.kids) node.kids = root.kids.map(k => (k.f && tree.files[k.f]) ? inlineNode(k.f, tree, slugOf, byId, new Set([k.f])) : { n: k.n, lvl: k.lvl, c: k.c, ...(k.cut ? { cut: true } : {}), ...(k.pg ? { page: true } : {}) });
    if (root.recs) node.recs = root.recs.map(r => row(r, slugOf, byId));
    node.pages = (tree.pages || []).filter(p => p.path && p.path[0] && p.path[0].f === ref.f).map(p => ({ n: p.n, lvl: p.lvl, area: p.area || '', recs: p.recs || [] }));
    // task-81: a detachment's owned list stays in the branch as ids (cheap), and the
    // client resolves each id through the one table (task-108 part A). The per-branch
    // index/<branch>-rows.json files are gone: index/rows.json addresses every delivered
    // record and carries the display row, so a page or an owned id is one lookup away.
    const annotate = n => {
      for (const r of (n.recs || [])) { const own = ownedBy(r.id); if (own && own.length) r.own = own; }
      for (const k of (n.kids || [])) annotate(k);
    };
    annotate(node);
    collectTreeRows(node);
    write('index/' + b.b + '.json', node);
  }

  // --- ONE addressing table (task-108) ---------------------------------------
  // The defect the architecture walk measured: an id became an address in four different
  // ways, three of them partial, and 2,159 of the 6,171 delivered records were in none of
  // them - so a search hit or a finding on one could not become an address the drawer
  // could open. This is the one answer: every DELIVERED record, keyed by id, with its
  // address (slug), its name (title, num), the book the slug lives in, where the tree
  // hangs it, and the ids a detachment owns.
  //
  // The invariant is the loop, not a promise: it runs over `live`, which is the same set
  // the content books below are written from, so an address always names a book that holds
  // the record. tests/test-rows-table.mjs asserts the same thing against the corpus's own
  // delivered predicate, in both directions, and does not take `live` on trust.
  const tableRows = {};
  for (const id of live) {
    const raw = byId.get(id) || {};
    // A record the tree carries keeps the row it was given there; one the tree never names
    // gets the tree's own title rule applied to its heading, so there is one naming rule.
    const known = treeRows.get(id) || row({ i: id, t: cleanTitle(leafOf(raw.heading) || String(raw.id || '')) }, slugOf, byId);
    // The display row rides in the table now (part A): the client used to fetch a
    // per-branch rows file for the page and owned ids, and that file is gone, so the
    // table carries the same five fields the drawer row reads (title, slug, source and
    // this 100-character snippet, which the tree's own filter matches on).
    const plain = textOf(raw).replace(/\s+/g, ' ').trim();
    const entry = { slug: slugOf(id), title: String(known.title || ''), book: bookOf(id), source: String(known.source || ''), snippet: snippetOf(textOf(raw), raw.heading, 100) };
    if (known.num) entry.num = String(known.num);
    const chain = tree.paths.get(id) || [];
    const chainPath = chain.slice(1).map(x => x && x.n).filter(Boolean).join(' > ');
    if (chainPath) entry.path = chainPath;
    const own = ownedBy(id);
    if (own && own.length) entry.own = own;
    tableRows[id] = entry;
  }
  write('index/rows.json', { rows: tableRows });

  // task-44: the excluded records, in their own book. Written AFTER the three real
  // branches and named by no index a default reader fetches, so the default reader's
  // bytes do not move; content/legends.json is where the branch's records live, and
  // index/legends-slugs.json is the id -> slug map the search and the record route read
  // without pulling the content's megabyte.
  // Mandal, 2026-10-24: Legends is out of the product. A Legends datasheet is not legal at
  // a tournament table, so the branch, its slug map and its book are no longer written; the
  // corpus keeps the records (isDelivered already excludes them from retrieval and the
  // index) and the build stays one predicate away from bringing them back if that changes.
  const legendRecs = all.filter(isLegendsRecord);

  for (const [book, ids] of books) {
    const recordsOut = {};
    for (const id of ids) {
      const raw = byId.get(id) || {};
      recordsOut[id] = {
        id: id, slug: slugOf(id), heading: raw.heading || '', kind: raw.kind || '', source: raw.source || '',
        ruleId: raw.ruleId || '', set: raw.set || '', text: stripSeeAlso({ text: textOf(raw), links: raw.links }),
        links: Array.isArray(raw.links) ? raw.links : [], parent: raw.parent || '',
        children: Array.isArray(raw.children) ? raw.children : [],
        // 'at' is where this record sits when it is an annotation: the section it
        // was attached to, exactly what wiki-render's productPage puts in WIKI_HERE.
        at: tree.attachTarget.get(id) || '',
      };
    }
    write('content/' + book + '.json', { book: book, records: recordsOut });
  }

  // --- the French overlay (task-69) -------------------------------------------
  // The English corpus stays the canon; the French is an overlay keyed by record id, and
  // it is baked PER BOOK so a reader fetches only the book they are reading, exactly like
  // the English content payloads. The source is the translation pass's own export
  // (workspace/i18n/fr-full.json): this reads it, it never re-runs it.
  //
  // Only the delivered records are written - a record the tree filtered has no page to
  // render, and its French would be dead weight. A record with no French (the pass
  // blocked 39) is simply absent from the file, which is how the reader falls back to
  // the English rather than to nothing.
  const fr = frByBook(live, bookOf, id => textOf(byId.get(id)));
  fs.rmSync(path.join(out, 'i18n'), { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'i18n', 'fr'), { recursive: true });
  const frIndex = {};
  for (const book of Object.keys(fr).filter(k => fr[k] && fr[k].text).sort()) {
    const body = JSON.stringify({ book: book, records: fr[book].text });
    fs.writeFileSync(path.join(out, 'i18n', 'fr', book + '.json'), body);
    files.push({ name: 'i18n/fr/' + book + '.json', bytes: Buffer.byteLength(body) });
    frIndex[book] = { file: book + '.json', records: Object.keys(fr[book].text).length, bytes: Buffer.byteLength(body) };
  }
  const frIndexBody = JSON.stringify({ source: fr.source, translated: fr.translated, blocked: fr.blocked, stale: fr.stale, books: frIndex });
  fs.writeFileSync(path.join(out, 'i18n', 'fr', 'index.json'), frIndexBody);
  files.push({ name: 'i18n/fr/index.json', bytes: Buffer.byteLength(frIndexBody) });

  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  const biggest = files.slice().sort((a, b) => b.bytes - a.bytes)[0] || { name: '', bytes: 0 };
  const byBook = {};
  for (const [book, ids] of books) byBook[book] = ids.length;
  const stats = {
    outDir: out, records: all.length, delivered: live.length, filtered: filtered.size,
    legendsExcluded: legendRecs.length,
    branches: branches, books: [...books.keys()].sort(), bookRecords: byBook,
    files: files.map(f => f.name).sort(), fileCount: files.length, bytes: bytes,
    biggest: biggest,
  };
  return stats;
}

const fmtMB = n => Math.round(n / 1024 / 10.24) / 100;
function main() {
  const i = process.argv.indexOf('--out');
  const out = i !== -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : DEFAULT_OUT;
  const t0 = Date.now();
  const stats = buildPayloads(readAllCorpus(), out);
  const seconds = (Date.now() - t0) / 1000;
  console.log('wiki-payload -> ' + path.relative(REPO, out));
  console.log('  delivered           ' + stats.delivered + ' of ' + stats.records + ' (' + stats.filtered + ' filtered, ' + stats.legendsExcluded + ' excluded as Legends)');
  console.log('  books               ' + stats.books.length + ': ' + stats.books.join(', '));
  console.log('  files               ' + stats.fileCount + ' (' + fmtMB(stats.bytes) + ' MB)');
  console.log('  biggest             ' + stats.biggest.name + ' ' + fmtMB(stats.biggest.bytes) + ' MB');
  console.log('  seconds             ' + seconds.toFixed(2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
