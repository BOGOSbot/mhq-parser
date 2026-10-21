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

// task-95: the shell names the two assets with a content stamp, so a browser can never run
// yesterday's client against today's server. A stale tab cost Mandal three reports of a
// defect that was already fixed on the server: his page had the old bundle in memory and
// nothing asked for the new one. The stamp is a hash of the two files, read per render -
// they are read to serve them anyway.
export function assetStamp() {
  const h = crypto.createHash('sha1');
  for (const name of Object.keys(ASSETS).sort()) h.update(fs.readFileSync(path.join(SURFACE_DIR, ASSETS[name].file)));
  return h.digest('hex').slice(0, 10);
}

export function surfaceAsset(name) {
  const a = ASSETS[String(name || '').replace(/^.*\//, '')];
  if (!a) return null;
  const body = fs.readFileSync(path.join(SURFACE_DIR, a.file), 'utf8');
  // task-38: the worker's cache name is the deploy's stamp, substituted here rather than
  // read from its own URL. A worker whose BYTES change on every deploy is one the browser
  // must update; a worker that only reads a query string can be left un-updated when the
  // script itself is byte-identical, and an old worker keeps an old cache name.
  return { type: a.type, body: a.file === 'wiki-surface-sw.js' ? body.split('__STAMP__').join(assetStamp()) : body };
}

export function dataDir() { return DATA_DIR; }

// task-44: the slugs of the payload the Legends setting opens, from the ids-only file
// the bake writes for exactly this. Read on request and NOT cached in the process: a
// bake replaces the file under a running server, and a stale map would offer a row the
// reader's page cannot open. The map is also the search's gate - a row is offered only
// when the record it names is in the book the asking page actually holds.
export function legendsSlugMap() {
  const out = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index', 'legends-slugs.json'), 'utf8'));
    for (const [id, slug] of Object.entries((j && j.slugs) || {})) if (slug) out.set(String(id), String(slug));
  } catch (e) { /* no bake, or no Legends: the setting opens nothing rather than erroring */ }
  return out;
}

// Every record with a payload page's slug, from the index payloads rather than the
// content payloads. The findings and the tail carry no slug of their own, and a record
// opened from the answer must have one to become an address - this is the one map that
// answers it. task-44: the Legends book is part of it, so a record the reader turned on
// is addressable by the same route as every other; the branch itself is still fetched
// only when the setting is on.
let SLUGS = null;
export function surfaceSlugMap() {
  if (SLUGS) return SLUGS;
  const map = legendsSlugMap();
  let index = null;
  try { index = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index.json'), 'utf8')); } catch (e) { index = null; }
  for (const b of ((index && index.branches) || [])) {
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index', b.b + '.json'), 'utf8')); } catch (e) { payload = null; }
    if (!payload) continue;
    const walk = n => {
      for (const r of (n.recs || [])) if (r && r.id && r.slug) map.set(r.id, r.slug);
      for (const k of (n.kids || [])) walk(k);
    };
    walk(payload);
  }
  SLUGS = map;
  return map;
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
