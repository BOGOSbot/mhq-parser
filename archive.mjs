#!/usr/bin/env node
'use strict';
/**
 * The archive: every closed 40k event, parsed once and kept in the repository.
 *
 *   node archive.mjs [--plan] [--list] [--verify] [--prune] [--refresh]
 *                    [--limit <n>] [--months <n>] [--concurrency <n>]
 *                    [--out-dir <dir>]
 *
 * Only the last year is kept. The archive exists to characterise the current
 * formats and to answer the site, and a list from three editions ago does
 * neither: the harvest ignores anything older than WINDOW_MONTHS, and --prune
 * drops what is already on disk. --months <n> widens or narrows the window;
 * --months 0 means all time.
 *
 * A closed tournament is finished business. Its lists will not change, MHQ keeps
 * the page up for years, and nothing on it moves again - which makes it the one
 * thing in this project worth storing rather than fetching. So the harvest
 * pulls each closed event once, writes the parse to
 * archive/events/<type>--<slug>.json, and never asks for it again.
 *
 * server.mjs then reads those files off disk:
 *   - /parse on an archived event answers from the file, with no request to
 *     MHQ, no session and no timeout to wait out;
 *   - /events lists the archived ones without checking them, because a closed
 *     event's game and its list count are already known here.
 *
 * Layout
 *   archive/index.json      the catalogue, one entry per archived event
 *   archive/events/<file>   the parse output, exactly what /parse returns
 *
 * The index exists so the server can draw a picker without reading 400 files:
 * name, date, format and list count for every archived event sit in one small
 * file, and the heavy JSON is only opened when an event is actually opened.
 *
 * The files are compact, not indented. Nothing reads them by eye, the diff is
 * never the point - a commit here is a bulk import - and pretty-printing costs
 * about 30% of the size, which is hundreds of megabytes over a full history.
 *
 * It is a cache, so it is allowed to be wrong: every entry records when it was
 * taken, --refresh re-takes one, and serving an archived event can be declined
 * per request so the live page wins whenever that is what you want.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { checkEvent, detectExporter, detectFormat, getAllEvents, parseUrl } from './parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ARCHIVE_DIR = process.env.MHQ_ARCHIVE_DIR || path.join(__dirname, 'archive');
const EVENTS_DIR = 'events';
const INDEX_FILE = 'index.json';

// Four at a time. This is someone's hobby site: the scan already found six
// concurrent requests enough to earn a 524 from the origin.
const DEFAULT_CONCURRENCY = 4;

// How far back the archive reaches, in months. A year covers the current
// edition and the tail of the last one, which is what the parser needs to be
// right about; older lists only exist in formats nothing supports any more.
export const WINDOW_MONTHS = 12;

export function eventKey(type, slug) {
  return type + '/' + slug;
}

// A sitemap slug is already URL-safe, but a hand-edited index is not trusted
// input and a key is about to become a filename.
function fileNameFor(type, slug) {
  return (type + '--' + slug).replace(/[^A-Za-z0-9._-]+/g, '-');
}

function indexPath(dir) {
  return path.join(dir, INDEX_FILE);
}

// --- reading -------------------------------------------------------------
// The index is re-read when the file changes, not on a timer: a harvest run
// writes it, and a server that waited out a TTL would keep offering a picker
// without the events harvested a second ago. One stat per read is cheaper than
// the mistake of a stale list.
const cache = new Map(); // dir -> { at, index }

export function loadIndex(dir = ARCHIVE_DIR) {
  const file = indexPath(dir);
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { mtime = 0; }
  const hit = cache.get(dir);
  if (hit && hit.mtime === mtime) return hit.index;
  let index = { generated: null, events: [] };
  if (mtime) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && Array.isArray(parsed.events)) {
        index = parsed;
        // An index written before the rejected-event ledger existed has no
        // "checked"; give it an empty one rather than making every reader
        // remember to test for it.
        if (!Array.isArray(index.checked)) index.checked = [];
      }
    } catch (e) {
      // A truncated index is a broken commit, not an empty archive. Say so
      // rather than quietly serving nothing: an empty picker looks like MHQ
      // forgot its history.
      throw new Error('archive index unreadable (' + e.message + ') at ' + file);
    }
  }
  cache.set(dir, { mtime, index });
  return index;
}

// One entry, or null. A miss is the normal case for a live event, so it is not
// an error and not logged.
export function entryFor(index, type, slug) {
  return entryForKey(index, eventKey(type, slug));
}

// The same lookup by the key an incoming URL resolves to.
export function entryForKey(index, key) {
  if (!index || !index.events.length || !key) return null;
  return index.events.find(e => e.key === key) || null;
}

// The parse output behind an entry, or null when the file is gone. A committed
// index pointing at a missing file means a partial checkout; the caller falls
// back to fetching live rather than failing the request.
export function readEvent(dir, entry) {
  if (!entry || !entry.file) return null;
  try {
    const out = JSON.parse(fs.readFileSync(path.join(dir, entry.file), 'utf8'));
    // An archived file was written by whatever parser was current when it was
    // harvested, so one taken before `exporter` existed lacks it. Detect it
    // here rather than rewriting 160 MB of archive: the body text is in the
    // file, the answer is cheap, and every caller - the site, the picker, a
    // test - sees the field filled in.
    for (const p of (out.players || [])) {
      if (p.exporter != null) continue;
      const ex = detectExporter(p.bodyText);
      p.exporter = ex.id;
      p.exporterVersion = ex.version;
    }
    return out;
  } catch {
    return null;
  }
}

// The key an incoming URL maps to, or null when the URL is not a plain public
// event page.
//
// An organiser URL is deliberately not matched. It is a different view of the
// same event - it carries submitted lists that were never published - so a
// cached public parse in answer to one would quietly show the wrong armies.
export function keyOfUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== 'miniheadquarters.com') return null;
  const m = u.pathname.match(/^\/tournaments\/([a-z-]+)\/(?:army-lists|details)\/([^/]+)\/?$/);
  if (!m) return null;
  return eventKey(m[1], m[2]);
}

// What the picker draws for an archived event. The shape is the sitemap row's,
// so the page needs no second code path: it already knows how to render a
// name, a date, a format tag and a list count.
export function rowFor(entry) {
  return {
    slug: entry.slug,
    type: entry.type,
    name: entry.name,
    date: entry.date,
    format: entry.format,
    url: entry.url,
    detailsUrl: entry.detailsUrl,
    listCount: entry.listCount,
    checked: true,
    past: true,
    archived: true,
    archivedAt: entry.archivedAt,
  };
}

// --- the harvest ---------------------------------------------------------

// Closed means the date is behind us. The sitemap dates every tournament it
// lists, and a date it cannot read cannot be placed on either side of today,
// so an undated entry is left out rather than guessed at.
export function isClosed(ev, today = new Date().toISOString().slice(0, 10)) {
  return typeof ev.date === 'string' && ev.date !== '' && ev.date < today;
}

export function is40k(game) {
  return /warhammer\s*40/i.test(game || '');
}

function fmtBytes(n) {
  return n >= 1024 * 1024
    ? (n / (1024 * 1024)).toFixed(1) + ' MB'
    : Math.round(n / 1024) + ' KB';
}

// The oldest date the window keeps. months <= 0 means all time, which is
// spelled as a date no real event can precede rather than as a second branch
// every caller has to remember.
export function windowStart(months, now = Date.now()) {
  return months > 0
    ? new Date(now - Math.round(months * 30.44) * 86400000).toISOString().slice(0, 10)
    : '0000-01-01';
}

// The keys already judged and rejected, from the "checked" ledger. A decision
// is permanent when it cannot become wrong: another game never turns into 40k,
// and a closed event's "no lists out" stays true. A future event's "no lists
// yet" is not a decision at all, so it is not counted here and the event is
// checked again once it has happened.
export function rejectedKeys(index) {
  return (index.checked || [])
    .filter(e => {
      // Another game never becomes 40k, so that refusal is permanent.
      if (!is40k(e.game)) return true;
      if (e.hasLists !== false) return false;
      // "No lists out" is final only if the event had already happened when
      // the check was made. One made before the date is a promise to look
      // again once it has, which is why the check's own date is compared, not
      // yesterday's.
      const on = String(e.checkedAt || '').slice(0, 10);
      return typeof e.date === 'string' && on >= e.date;
    })
    .map(e => e.key);
}

// What the harvest would consider, before it fetches anything.
export function candidates(all, index, { months = WINDOW_MONTHS, refresh = false, today } = {}) {
  const t = today || new Date().toISOString().slice(0, 10);
  const start = windowStart(months);
  const have = new Set(index.events.map(e => e.key));
  const rejected = new Set(rejectedKeys(index));
  return all.filter(e => isClosed(e, t) && e.date >= start &&
    (refresh || (!have.has(eventKey(e.type, e.slug)) && !rejected.has(eventKey(e.type, e.slug)))));
}

// Drop archived events that have fallen out of the window, and rebuild the
// index around what is left. Without this --prune is the only thing that ever
// deletes, and it deletes exactly what the harvest would no longer take.
export function prune(dir = ARCHIVE_DIR, { months = WINDOW_MONTHS, log = () => {} } = {}) {
  const index = loadIndex(dir);
  const start = windowStart(months);
  const keep = [];
  const dropped = [];
  for (const e of index.events) (typeof e.date === 'string' && e.date >= start ? keep : dropped).push(e);
  for (const e of dropped) {
    try { fs.unlinkSync(path.join(dir, e.file)); } catch { /* already gone */ }
    log('  dropped ' + (e.date || '(undated)') + '  ' + e.key);
  }
  // The rejected ledger follows the same window: an event no longer in range
  // will not be considered again, so its refusal need not be kept either.
  const checked = (index.checked || []).filter(e => typeof e.date === 'string' && e.date >= start);
  saveIndex(dir, { events: keep, checked });
  return { kept: keep.length, dropped: dropped.length, checked: checked.length };
}

// One event's worth of fetching: judge it, then parse it if it qualifies.
//
// Both steps can fail for reasons that are not about the event - a throttled
// origin, a timeout. A failure is therefore never recorded as "not 40k" and
// never as "no lists": the event is left unarchived so the next run retries it.
async function archiveOne(ev, { dir, log, totals }) {
  const check = await checkEvent(ev.detailsUrl);
  if (!(is40k(check.game) && check.hasLists)) {
    // Remember the refusal. Without it the next harvest fetches the same
    // details page to learn the same thing, and over a sitemap that is
    // hundreds of requests for an answer already known.
    return { decision: {
      key: eventKey(ev.type, ev.slug),
      type: ev.type,
      slug: ev.slug,
      date: ev.date,
      game: check.game || null,
      hasLists: !!check.hasLists,
      detailsUrl: ev.detailsUrl,
      checkedAt: new Date().toISOString(),
    } };
  }
  const { output } = await parseUrl(ev.url);
  const file = path.join(EVENTS_DIR, fileNameFor(ev.type, ev.slug) + '.json');
  const body = JSON.stringify(output);
  const abs = path.join(dir, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  const entry = {
    key: eventKey(ev.type, ev.slug),
    type: ev.type,
    slug: ev.slug,
    name: output.event.name || ev.name,
    date: output.event.date || ev.date,
    format: ev.format,
    game: check.game,
    url: ev.url,
    detailsUrl: ev.detailsUrl,
    listCount: output.count,
    bytes: Buffer.byteLength(body),
    archivedAt: new Date().toISOString(),
    file: file.split(path.sep).join('/'),
  };
  totals.done++;
  totals.bytes += entry.bytes;
  log('  ' + entry.date + '  ' + pad(entry.name, 44) + '  ' + pad(output.count + ' lists', 10) + '  ' + fmtBytes(entry.bytes) +
      '   [archive ' + fmtBytes(totals.bytes) + ']');
  return { entry };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n - 1) + '\u2026' : s + ' '.repeat(n - s.length);
}

export function saveIndex(dir, index) {
  const next = {
    generated: new Date().toISOString(),
    events: (index.events || []).slice().sort(byDateDesc),
    checked: (index.checked || []).slice().sort(byDateDesc),
  };
  fs.mkdirSync(dir, { recursive: true });
  const file = indexPath(dir);
  fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file); // atomic: a crash never leaves half an index
  cache.delete(dir);
  return next;
}

function byDateDesc(a, b) {
  if (a.date === b.date) return a.key < b.key ? -1 : 1;
  return a.date < b.date ? 1 : -1;
}

/**
 * Walk the closed events, archive the ones worth keeping.
 *
 * Resumable by construction: what is already in the index is skipped, so a run
 * that dies halfway - or that you stop - costs a rerun, not the whole harvest.
 */
export async function harvest(opts = {}) {
  const dir = opts.dir || ARCHIVE_DIR;
  const log = opts.log || (m => process.stderr.write(m + '\n'));
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
  const limit = opts.limit || 0;
  const index = loadIndex(dir);
  const all = await getAllEvents();
  const queue = candidates(all, index, { months: opts.months == null ? WINDOW_MONTHS : opts.months, refresh: !!opts.refresh });
  const todo = limit > 0 ? queue.slice(0, limit) : queue;

  log('Closed events in the sitemap: ' + all.filter(e => isClosed(e)).length +
      ', of which ' + queue.length + ' to check' +
      (limit > 0 && queue.length > todo.length ? ' (taking ' + todo.length + ')' : ''));
  log('Already archived: ' + index.events.length + ', ' + fmtBytes(index.events.reduce((s, e) => s + (e.bytes || 0), 0)) +
      ', already rejected: ' + (index.checked || []).length);
  if (!todo.length) return { entries: [], bytes: 0, checked: 0 };

  const added = [];
  const refused = [];
  // What the index holds, as of this run. Kept as its own array on purpose:
  // concat() returns a new one, so folding the batches into the loaded index
  // would throw the earlier batches away and the file would end up holding only
  // the last flush.
  let merged = index.events.slice();
  let mergedChecked = (index.checked || []).slice();
  const totals = { done: 0, bytes: 0, checked: 0, failed: 0, skipped: 0 };
  const total = todo.length;
  let n = 0;
  // One entry per key: a re-check replaces the refusal it supersedes.
  const byKey = (base, add) => {
    const m = new Map(base.map(e => [e.key, e]));
    for (const e of add) m.set(e.key, e);
    return [...m.values()];
  };
  const flush = () => {
    if (!added.length && !refused.length) return;
    merged = byKey(merged, added.splice(0));
    mergedChecked = byKey(mergedChecked, refused.splice(0));
    saveIndex(dir, { events: merged, checked: mergedChecked });
  };

  const worker = async () => {
    while (todo.length) {
      const ev = todo.shift();
      n++;
      log('[' + n + '/' + total + '] ' + ev.date + '  ' + ev.name);
      totals.checked++;
      try {
        const r = await archiveOne(ev, { dir, log, totals });
        if (r.decision) { totals.skipped++; refused.push(r.decision); }
        else added.push(r.entry);
      } catch (e) {
        // Left unarchived on purpose: the next run tries it again.
        totals.failed++;
        log('  failed: ' + String((e && e.message) || e));
      }
      // Flushed periodically rather than per event: the index is small, but a
      // harvest is long and Ctrl-C should not throw away the last hundred.
      if (added.length + refused.length >= 25) flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  flush();

  log('');
  log('Archived ' + totals.done + ' event' + (totals.done === 1 ? '' : 's') + ', ' +
      fmtBytes(totals.bytes) + ' this run, ' + merged.length + ' in total; ' +
      mergedChecked.length + ' rejected so far.');
  log('Checked ' + totals.checked + ', kept ' + totals.done + ', skipped ' + totals.skipped +
      ' (another game, or no lists out), failed ' + totals.failed + '.');
  return { entries: added, bytes: totals.bytes, checked: totals.checked };
}

// Rebuild the index from the files in archive/events/.
//
// Two reasons it exists. A harvest interrupted between writing a file and
// flushing the index leaves an event on disk that nothing points at, and the
// next run would fetch it all over again. And the events are the data: the
// index is derived from them, so it can be thrown away and read back off them.
//
// What it cannot recover is what came from the details page - the game, and
// when the copy was taken - so those are reconstructed rather than invented:
// the game from the filter that put the event in the archive at all, and the
// timestamp from the file's own mtime.
export function reindex(dir = ARCHIVE_DIR) {
  // The rejected ledger cannot be rebuilt from event files - a refused event
  // has none - so it is carried over rather than derived.
  const existing = loadIndex(dir);
  const eventsDir = path.join(dir, EVENTS_DIR);
  let files = [];
  try { files = fs.readdirSync(eventsDir); } catch { files = []; }
  const entries = [];
  const dropped = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const rel = EVENTS_DIR + '/' + f;
    const out = readEvent(dir, { file: rel });
    const dash = f.indexOf('--');
    let stat = null;
    try { stat = fs.statSync(path.join(eventsDir, f)); } catch { stat = null; }
    if (!out || !stat || dash < 1) { dropped.push(f); continue; }
    const type = f.slice(0, dash);
    const slug = f.slice(dash + 2, -5);
    entries.push({
      key: eventKey(type, slug),
      type,
      slug,
      name: out.event.name || slug,
      date: out.event.date || null,
      format: detectFormat(slug, type),
      game: 'Warhammer 40,000',
      url: 'https://miniheadquarters.com/tournaments/' + type + '/army-lists/' + slug,
      detailsUrl: 'https://miniheadquarters.com/tournaments/' + type + '/details/' + slug,
      listCount: out.count,
      bytes: stat.size,
      archivedAt: stat.mtime.toISOString(),
      file: rel,
    });
  }
  saveIndex(dir, { events: entries, checked: existing.checked || [] });
  return { entries, dropped, checked: (existing.checked || []).length };
}

// --- CLI ---------------------------------------------------------------

function parseArgs(argv) {
  const o = { plan: false, list: false, verify: false, reindex: false, prune: false, refresh: false, limit: 0, months: WINDOW_MONTHS, concurrency: DEFAULT_CONCURRENCY, dir: ARCHIVE_DIR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') o.plan = true;
    else if (a === '--list') o.list = true;
    else if (a === '--verify') o.verify = true;
    else if (a === '--reindex') o.reindex = true;
    else if (a === '--prune') o.prune = true;
    else if (a === '--refresh') o.refresh = true;
    else if (a === '--limit') o.limit = Number(argv[++i]) || 0;
    else if (a.startsWith('--limit=')) o.limit = Number(a.slice(8)) || 0;
    else if (a === '--months') o.months = Number(argv[++i]) || 0;
    else if (a.startsWith('--months=')) o.months = Number(a.slice(9)) || 0;
    else if (a === '--concurrency') o.concurrency = Number(argv[++i]) || DEFAULT_CONCURRENCY;
    else if (a.startsWith('--concurrency=')) o.concurrency = Number(a.slice(14)) || DEFAULT_CONCURRENCY;
    else if (a === '--out-dir') o.dir = argv[++i];
    else if (a.startsWith('--out-dir=')) o.dir = a.slice(10);
    else { console.error('unknown flag: ' + a); process.exit(2); }
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const index = loadIndex(o.dir);

  if (o.list) {
    for (const e of index.events) {
      console.log(e.date + '  ' + pad(e.name, 44) + '  ' + pad(e.listCount + ' lists', 12) + '  ' + fmtBytes(e.bytes || 0) + '  ' + e.slug);
    }
    console.log('\n' + index.events.length + ' archived event(s), ' +
      fmtBytes(index.events.reduce((s, e) => s + (e.bytes || 0), 0)) + ', ' +
      (index.checked || []).length + ' rejected event(s).');
    return;
  }

  if (o.reindex) {
    const r = reindex(o.dir);
    console.log(r.entries.length + ' events indexed from ' + path.join(o.dir, 'events') +
      ', ' + r.checked + ' rejected entries kept');
    if (r.dropped.length) console.log(r.dropped.length + ' unreadable file(s) skipped: ' + r.dropped.join(', '));
    return;
  }

  if (o.prune) {
    const r = prune(o.dir, { months: o.months, log: s => console.log(s) });
    console.log('Kept ' + r.kept + ' event(s) and ' + r.checked + ' rejected entr' + (r.checked === 1 ? 'y' : 'ies') +
      ' within ' + (o.months > 0 ? o.months + ' months' : 'all time') + ', dropped ' + r.dropped + '.');
    return;
  }

  if (o.verify) {
    let bad = 0;
    for (const e of index.events) {
      const out = readEvent(o.dir, e);
      if (!out) { console.log('MISSING  ' + e.key + '  ' + e.file); bad++; continue; }
      if (out.count !== e.listCount) { console.log('MISMATCH ' + e.key + '  index says ' + e.listCount + ', file says ' + out.count); bad++; }
    }
    console.log(index.events.length + ' entries, ' + bad + ' broken');
    if (bad) process.exit(1);
    return;
  }

  if (o.plan) {
    const all = await getAllEvents();
    const closed = all.filter(e => isClosed(e));
    const todo = candidates(all, index, { months: o.months, refresh: o.refresh });
    console.log('sitemap        ' + all.length + ' tournaments');
    console.log('closed         ' + closed.length);
    console.log('already in     ' + index.events.length);
    console.log('to check       ' + todo.length + (o.months ? ' (last ' + o.months + ' months)' : ' (all time)'));
    const byYear = new Map();
    for (const e of todo) byYear.set(e.date.slice(0, 4), (byYear.get(e.date.slice(0, 4)) || 0) + 1);
    for (const y of [...byYear.keys()].sort()) console.log('   ' + y + '  ' + byYear.get(y));
    return;
  }

  await harvest(o);
}

const IS_MAIN = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] || '').href; }
  catch { return false; }
})();

if (IS_MAIN) {
  main().catch(e => { console.error(String((e && e.stack) || e)); process.exit(1); });
}
