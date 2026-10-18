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
 * A record's slug carries its book ('<book>--<readable>-<hash>'), so a cold
 * address resolves with no manifest: split on '--', fetch that one content file,
 * find the record. The record's fields are the seam's; the text is the STORED
 * text and no HTML is baked - no card rendering, no CARD_CSS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus } from './rules-corpus.mjs';
import { allianceAssigner, factionAssigner, factionRoster, hash8, pageNamer, pageTitleSlug, tocTree } from './wiki-toc.mjs';
import { stripSeeAlso } from './wiki-plan.mjs';
import { cardTables } from './unit-card.mjs';

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

const textOf = rec => String((rec && rec.text) || '');
// The drawer's one-line row: id, slug, title, source and a plain-text snippet of
// at most 100 characters, so a branch renders its lines without fetching content.
function row(rec, slugOf, byId, chapter) {
  const raw = byId.get(rec.i) || {};
  const plain = textOf(raw).replace(/\s+/g, ' ').trim();
  // task-88: a record whose heading ends in its chapter's own name is the chapter's lead
  // block, and the chapter header already names it: '05 Attack Sequence' under the chapter
  // '05 Attack Sequence' names the same thing twice. Such a block takes its own heading's
  // remaining segments ('3. Resolve Attacks > Attack Sequence' -> '3. Resolve Attacks'),
  // and the chapter's number is not its number, so it is not printed twice either.
  const chName = String(chapter || '').replace(/^\d{2}(?:\.\d+)?\s*/, '').trim();
  const chNum = (String(chapter || '').match(/^(\d{2})/) || [])[1] || '';
  const segs = String(raw.heading || '').split(' > ').map(s => s.trim()).filter(Boolean);
  // task-4: the appendix's ability tag is a container, not a parent - the page
  // headings the Universal Rules Updates block '[ONE SHOT] > Universal Rules
  // Updates', and task-88's lead-row rule would print that row as '[ONE SHOT]'
  // under the 00 chapter, the very heading this task removed. A remaining path
  // that is only a bracketed tag falls back to the record's own leaf.
  const parent = chName && segs.length && segs[segs.length - 1].toLowerCase() === chName.toLowerCase() ? segs.slice(0, -1).join(' > ') : '';
  const own = /^\[[^\]]+\]$/.test(parent) ? '' : parent;
  // task-106: a rule's number is sometimes still inside its heading - the appendix's
  // errata h3s carry '01.02.06 Splitting Units' and no ruleId - so the number moves
  // into the row's own slot and the title loses it. A record whose text is an errata
  // ('Add: ...', 'Change: ...') says so: two rows named 'Splitting Units' read as a
  // duplicate otherwise, and one of them is the errata to the other.
  const leaf = String(raw.heading || '').split(' > ').pop().trim();
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
  const out = { id: rec.i, slug: slugOf(rec.i), title: title, source: raw.source || '', snippet: plain.slice(0, 100) };
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
  const live = [...pageOf.keys()].filter(id => !filtered.has(id));

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
  const slugOf = id => {
    const raw = byId.get(id) || {};
    return bookOf(id) + '--' + pageTitleSlug(raw) + '-' + hash8(String(id));
  };

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

  // index.json: the branches with the key each one's payload lives under.
  const branches = tree.index.branches.map(b => ({ n: b.n, c: b.c, b: path.basename(String(b.f || ''), '.js') }));
  write('index.json', { branches: branches });

  for (const b of branches) {
    const ref = tree.index.branches.find(x => path.basename(String(x.f || ''), '.js') === b.b) || {};
    const node = { n: b.n, lvl: 'branch', c: b.c, kids: [], recs: [], pages: [] };
    const root = tree.files[ref.f] || {};
    if (root.kids) node.kids = root.kids.map(k => (k.f && tree.files[k.f]) ? inlineNode(k.f, tree, slugOf, byId, new Set([k.f])) : { n: k.n, lvl: k.lvl, c: k.c, ...(k.cut ? { cut: true } : {}), ...(k.pg ? { page: true } : {}) });
    if (root.recs) node.recs = root.recs.map(r => row(r, slugOf, byId));
    node.pages = (tree.pages || []).filter(p => p.path && p.path[0] && p.path[0].f === ref.f).map(p => ({ n: p.n, lvl: p.lvl, area: p.area || '', recs: p.recs || [] }));
    // task-81: the rows only reachable through this branch's pages (Army rules)
    // or a detachment's owned list. Built per branch so each row is carried once,
    // and only for the ids this branch actually mentions.
    const branchIds = new Set();
    for (const p of node.pages) for (const id of (p.recs || [])) branchIds.add(id);
    const ownOf = id => (tree.owned && tree.owned.get(id)) ? tree.owned.get(id).enh.concat(tree.owned.get(id).strat) : null;
    const annotate = n => {
      for (const r of (n.recs || [])) { const own = ownOf(r.id); if (own && own.length) { r.own = own; for (const id of own) branchIds.add(id); } }
      for (const k of (n.kids || [])) annotate(k);
    };
    annotate(node);
    // The rows ride in their OWN file, fetched the first time a reader opens a
    // page or a detachment: the branch payload is on the critical path of every
    // Factions open, and 2,082 rows there cost 736 KB for a feature most opens
    // never touch (task-81 step 3b). `own` (ids) stays in the branch, which is
    // cheap; the rows are one fetch, cached by the client.
    if (branchIds.size) {
      const rowMap = {};
      for (const id of branchIds) {
        const raw = byId.get(id);
        if (!raw) continue;
        rowMap[id] = row({ i: id, t: raw.heading || '' }, slugOf, byId);
      }
      write('index/' + b.b + '-rows.json', { rows: rowMap });
    }
    write('index/' + b.b + '.json', node);
  }

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

  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  const biggest = files.slice().sort((a, b) => b.bytes - a.bytes)[0] || { name: '', bytes: 0 };
  const byBook = {};
  for (const [book, ids] of books) byBook[book] = ids.length;
  const stats = {
    outDir: out, records: all.length, delivered: live.length, filtered: filtered.size,
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
  console.log('  delivered           ' + stats.delivered + ' of ' + stats.records + ' (' + stats.filtered + ' filtered)');
  console.log('  books               ' + stats.books.length + ': ' + stats.books.join(', '));
  console.log('  files               ' + stats.fileCount + ' (' + fmtMB(stats.bytes) + ' MB)');
  console.log('  biggest             ' + stats.biggest.name + ' ' + fmtMB(stats.biggest.bytes) + ' MB');
  console.log('  seconds             ' + seconds.toFixed(2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
