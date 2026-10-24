#!/usr/bin/env node
'use strict';
/**
 * wiki-surface: the server-side adapter for the revamp's client. It serves the two
 * real source files (src/wiki-surface.js and src/wiki-surface.css) and renders the
 * page that mounts them, so slice 4's flip has one place to wire the surface in.
 *
 * The client itself is NOT a string constant here: it is a file with an editor,
 * because a regex written into a template literal once lost its backslashes and
 * killed the whole shell with an error node --check could not see.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugMap } from './rows-table.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SURFACE_DIR = process.env.WIKI_SURFACE_DIR || __dirname;
const DATA_DIR = process.env.WIKI_DATA_DIR || path.join(__dirname, '..', 'workspace', 'wiki-data');

const ASSETS = {
  'surface.js': { file: 'wiki-surface.js', type: 'text/javascript; charset=utf-8' },
  'surface.css': { file: 'wiki-surface.css', type: 'text/css; charset=utf-8' },
  // task-38: the service worker is an asset for the same reason the other two are - it
  // carries the deploy's stamp, so a new deploy is a new worker byte-for-byte and the
  // browser cannot keep an old one. The stamp is also what NAMES its cache.
  'surface-sw.js': { file: 'wiki-surface-sw.js', type: 'text/javascript; charset=utf-8' },
};

// task-95: the shell names the assets with a content stamp, so a browser can never run
// yesterday's client against today's server. A stale tab cost Mandal three reports of a
// defect that was already fixed on the server: his page had the old bundle in memory and
// nothing asked for the new one. The stamp is a hash of the three files, read per render -
// they are read to serve them anyway.
export function assetStamp() {
  const h = crypto.createHash('sha1');
  for (const name of Object.keys(ASSETS).sort()) h.update(fs.readFileSync(path.join(SURFACE_DIR, ASSETS[name].file)));
  return h.digest('hex').slice(0, 10);
}

// task-80: the PAYLOAD has its own stamp, and the two are kept apart on purpose.
//
// The offline cache is named with both (see workerStamp), because a cache whose name only
// covered the shell would survive a corpus re-bake: activate would delete nothing, and a
// reader would get yesterday's tree and yesterday's record body - a record the corpus had
// dropped would still be listed and would still open. That is the task-95 class of defect
// with data instead of a bundle.
//
// They are NOT one stamp: the page's ?v= must stay the shell's, so a payload-only deploy
// does not make every reader re-download 90 KB of client that did not change, while the
// worker's cache name covers both so nothing stale can be served.
//
// mtime+size, not contents: the payload is 18.7 MB raw over 61 files and a hash of its bytes
// would be paid on every page render. Every file counts - an index-only stamp would miss a
// record-text fix, which is exactly the kind of change that must not be served from cache.
// Memoized on the set of (name, mtime, size), so a re-bake invalidates it by itself and a
// long-lived process cannot pin the old value.
let DATA_STAMP = { key: '', stamp: '' };
function payloadFiles() {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.json')) out.push(p);
    }
  };
  walk(DATA_DIR, 0);
  return out.sort();
}
// task-83: an optional SKIP list, so the app bundle can stamp its English half without the
// French overlay. The memo is keyed on the skip list too, or the second call would return the
// first call's stamp.
export function dataStamp(opts) {
  const skip = (opts && opts.skip) || [];
  const files = payloadFiles().filter(f => !skip.some(s => path.relative(DATA_DIR, f).split(path.sep).join('/').indexOf(s) === 0));
  const key = files.map(f => { try { const s = fs.statSync(f); return f + ':' + s.mtimeMs + ':' + s.size; } catch (e) { return f + ':?'; } }).join('|');
  const memoKey = skip.join(',') + '|' + key;
  if (key && memoKey === DATA_STAMP.key) return DATA_STAMP.stamp;
  // task-95: THE STAMP IS A CONTENT HASH, and the memo key above stays (name, mtime, size).
  //
  // It used to hash the key, which made it a stamp of a DEPLOY of a payload tree rather than of
  // its content: the Box's files carry the deploy's mtimes and the local bake carries its own,
  // so the same corpus had two stamps that could never match. As a worker's cache name that was
  // safe - over-invalidation only costs a download - but the native app compares this stamp
  // against the server's and TELLS THE READER the rules have moved, so it has to mean content.
  //
  // The 18.7 MB is hashed only when (name, mtime, size) changes, which is exactly when the
  // content may have changed, so a page render does not pay for it.
  const h = crypto.createHash('sha1');
  for (const f of files) {
    h.update(path.relative(DATA_DIR, f).split(path.sep).join('/'));
    h.update('\u0000');
    try { h.update(fs.readFileSync(f)); } catch (e) { h.update('missing'); }
    h.update('\u0000');
  }
  // The file NAMES are in the hash, so a payload that only loses a book still changes the
  // stamp; the bytes catch a rewrite that keeps every name.
  const stamp = h.digest('hex').slice(0, 8);
  DATA_STAMP = { key: memoKey, stamp: stamp };
  return stamp;
}

// What the service worker's cache is named after: the shell AND the payload, so neither can
// go stale behind the other. The worker's bytes carry it (surfaceAsset substitutes it), which
// is what makes the browser update the worker at all.
export function workerStamp() { return assetStamp() + '-' + dataStamp(); }

export function surfaceAsset(name) {
  const a = ASSETS[String(name || '').replace(/^.*\//, '')];
  if (!a) return null;
  const body = fs.readFileSync(path.join(SURFACE_DIR, a.file), 'utf8');
  // task-38: the worker's cache name is the deploy's stamp, substituted here rather than
  // read from its own URL. A worker whose BYTES change on every deploy is one the browser
  // must update; a worker that only reads a query string can be left un-updated when the
  // script itself is byte-identical, and an old worker keeps an old cache name.
  return { type: a.type, body: a.file === 'wiki-surface-sw.js' ? body.split('__STAMP__').join(workerStamp()) : body };
}

export function dataDir() { return DATA_DIR; }

// Every delivered record's address, from the payload's ONE addressing table
// (index/rows.json, written by src/wiki-payload.mjs, read by src/rows-table.mjs).
//
// task-108: this used to walk index.json and the branch payloads' own recs and kids, and
// reached 1,926 of the 6,171 delivered records - so a finding, the tail of an answer or a
// search hit on any of the other 4,245 had no address to open. The NAME stays, because the
// server, the web bundle and three tests ask for it; the body is now the table's slug view,
// which answers for every record the corpus delivers and re-reads itself when the bake
// replaces the file under a running server.
export function surfaceSlugMap() {
  return slugMap(DATA_DIR);
}

// --- task-109: the record bodies, addressed by content -----------------------------
// The bake renders one HTML body per record, and 30.9% of them repeat another record's
// bytes: a datasheet republished in five factions carries five copies, and a unitrules
// half resolves to its parent body byte for byte. The store is content addressed instead:
// ONE body per distinct HTML, keyed by its hash, and an id -> hash map beside it. The
// reader resolves id -> hash -> body, so a body it cannot resolve is null - a missing
// body, never an empty string that renders as a blank pane.
//
// The hash is sha256 truncated to 16 hex characters: 64 bits over 4,265 bodies is a
// collision chance far below the chance of a corrupted file, and it keeps the map small.
// The bodies keep the order the bake met them in (the corpus order), because a repeat then
// sits inside deflate's own window; sorting the keys by hash cost 61 KB of the archive,
// measured on the 2026-10-24 bundle.
const BODY_HASH_CHARS = 16;

export function bodyHash(html) {
  return crypto.createHash('sha256').update(String(html)).digest('hex').slice(0, BODY_HASH_CHARS);
}

// The two files of one book's store: the bodies (hash -> HTML) and the ids (id -> hash).
// They are separate files on purpose. A reader that still expects the old flat shape
// (records/<book>.json keyed by id) finds no id in the bodies file and answers 'no such
// record', which is loud; one file holding both maps would have handed it a hash to render
// as HTML. The id map is sorted, so two runs over the same corpus write the same bytes; the
// bodies follow the records object's own insertion order, which the bake builds in corpus
// order.
export function bodyFiles(version, book, records) {
  const bodies = new Map();
  const refs = {};
  for (const id of Object.keys(records || {})) {
    const html = String(records[id]);
    const hash = bodyHash(html);
    if (!bodies.has(hash)) bodies.set(hash, html);
    refs[id] = hash;
  }
  const bodyLines = [];
  for (const [hash, html] of bodies) bodyLines.push('    ' + JSON.stringify(hash) + ': ' + JSON.stringify(html));
  const refLines = [];
  for (const id of Object.keys(refs).sort()) refLines.push('    ' + JSON.stringify(id) + ': ' + JSON.stringify(refs[id]));
  const head = '{\n  "version": ' + JSON.stringify(version) + ',\n  "book": ' + JSON.stringify(book) + ',\n';
  return {
    bodies: head + '  "bodies": {\n' + bodyLines.join(',\n') + '\n  }\n}\n',
    ids: head + '  "records": {\n' + refLines.join(',\n') + '\n  }\n}\n',
  };
}

// The one reader: two files, two lookups. The ids file answers the id, the bodies file the
// hash. Null when either link is missing - an id the map does not carry, or a hash the
// bodies file lost - so a caller must answer 'no such record' rather than render an empty
// body.
export function bodyById(ids, bodies, id) {
  const hash = ids && ids.records ? ids.records[String(id)] : null;
  if (!hash) return null;
  const html = bodies && bodies.bodies ? bodies.bodies[hash] : null;
  return html == null ? null : String(html);
}

// The page. One ask box and one viewscreen; the drawer is markup here and behaviour
// in the client, closed by default and never opened by the page itself.
export function surfacePage(opts) {
  const o = opts || {};
  const title = o.title || 'Rules';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<title>' + title + '</title>',
    '<link rel="stylesheet" href="/rules/surface.css?v=' + assetStamp() + '">',
    '</head>',
    '<body>',
    '<header class="sv-top">',
    '  <button type="button" id="sv-drawer-toggle" class="sv-btn sv-drawer-toggle" aria-expanded="false" aria-controls="sv-drawer">Wiki</button>',
    '  <span class="sv-brand">' + title + '</span>',
    '</header>',
    '<main class="sv-main">',
    '  <section id="sv-viewscreen" class="sv-viewscreen" aria-live="polite">',
    '    <p class="sv-hint">Ask a rules question, or open the wiki to browse.</p>',
    '  </section>',
    '</main>',
    '<form id="sv-ask" class="sv-ask" autocomplete="off">',
    '  <textarea id="sv-q" rows="1" placeholder="Ask a rules question" aria-label="Ask a rules question"></textarea>',
    '  <button type="submit" class="sv-btn sv-send">Ask</button>',
    '</form>',
    '<aside id="sv-drawer" class="sv-drawer" aria-hidden="true" aria-label="Wiki">',
    '  <div class="sv-drawer-head">',
    '    <strong>Wiki</strong>',
    '    <button type="button" id="sv-drawer-close" class="sv-btn sv-close" aria-label="Close the wiki">Close</button>',
    '  </div>',
    '  <input id="sv-filter" class="sv-filter" type="search" placeholder="Filter the tree" aria-label="Filter the tree">',
    '  <div id="sv-tree" class="sv-tree" role="tree"></div>',
    '</aside>',
    '<script>window.WIKI_SURFACE = { data: ' + JSON.stringify(o.dataBase || '/rules/data') + ', record: ' + JSON.stringify(o.recordBase || '/rules/record') + ' };</script>',
    '<script src="/rules/surface.js?v=' + assetStamp() + '"></script>',
    '</body>',
    '</html>',
  ].join('\n');
}

export default { surfaceAsset, surfacePage, dataDir };
