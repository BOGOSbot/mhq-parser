#!/usr/bin/env node
'use strict';
/**
 * THE ROWS TABLE: the one place a record id becomes an address (task-108).
 *
 * Before this, four code paths answered 'what is this record's address', and three of
 * them answered 'nothing' for most of the corpus: surfaceSlugMap walked the tree's recs
 * and kids and reached 1,926 of the 6,171 delivered records, index/<branch>-rows.json
 * reached 2,086, branch.pages named 75, and 2,159 delivered records were in no index row
 * at all - so a search hit or a finding on one of them could not become an address the
 * drawer could open.
 *
 * The bake (src/wiki-payload.mjs) writes workspace/wiki-data/index/rows.json: every
 * DELIVERED record id -> { slug, title, book, source, num?, path?, own? }. This module is
 * the only reader. A consumer asks it for the slug map or for the rows themselves; none of
 * them walks the tree to guess an address again.
 *
 * The cache is keyed on (path, mtime, size), not on the process: a bake replaces the file
 * under a running server, and a table cached at boot would answer with yesterday's
 * addresses for every record the rebake moved (task-95's lesson, same shape).
 */
import fs from 'node:fs';
import path from 'node:path';

export const ROWS_FILE = 'index/rows.json';
export function rowsPath(dir) { return path.join(dir, ROWS_FILE); }

// rows and the map built from them are cached together, and the map is cached as an
// OBJECT, not rebuilt per call: the render path asks for a record's address once per LINK
// inside it (server.mjs wikiFileFor), so a rebuild per call would put a 6,171-entry Map
// construction in the middle of every record render (the cost task-99 removed elsewhere).
let CACHE = { key: '', rows: null, map: null };

// The rows, or null when the payload carries no table (a checkout that never baked, or a
// payload from before task-108). A caller that gets null keeps its old behaviour: a missing
// address is a visible miss, never a crash.
export function readRows(dir) {
  const file = rowsPath(dir);
  let stat = null;
  try { stat = fs.statSync(file); } catch (e) { CACHE = { key: 'missing:' + file, rows: null, map: new Map() }; return null; }
  const key = file + ':' + stat.mtimeMs + ':' + stat.size;
  if (key === CACHE.key) return CACHE.rows;
  let rows = null;
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); rows = (j && j.rows) || {}; } catch (e) { rows = null; }
  CACHE = { key: key, rows: rows, map: null };
  return rows;
}

// id -> slug, for the callers that only need the address.
export function slugMap(dir) {
  const rows = readRows(dir);
  if (CACHE.map) return CACHE.map;
  const out = new Map();
  for (const id of Object.keys(rows || {})) {
    const slug = rows[id] && rows[id].slug;
    if (slug) out.set(String(id), String(slug));
  }
  CACHE.map = out;
  return out;
}

export default { ROWS_FILE, rowsPath, readRows, slugMap };
