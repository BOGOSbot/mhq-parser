#!/usr/bin/env node
'use strict';
/**
 * MHQ Army Lists - local web UI for parse.mjs.
 *
 *   node src/server.mjs [--port 8787] [--host 127.0.0.1]
 *
 * Endpoints:
 *   GET  /          serves index.html
 *   GET  /health    { ok: true }
 *   GET  /events    recent tournaments, for the picker in index.html
 *                    (closed events held in archive/ are answered from there)
 *   POST /login     { username, password } -> { cookie }  obtain a session
 *   GET  /my-events tournaments the caller organises (X-MHQ-Cookie header)
 *   POST /parse     { url } -> { event, count, players, miniText, elapsedMs }
 *   POST /parse-file?name=<file>  body: a saved page -> same shape as /parse
 *   POST /parse-list?name=<file>  body: pasted/dropped list text -> same shape
 *   POST /feedback  { title?, body } -> { created, url }  file an issue on GitHub,
 *                    or a prefilled github.com/.../issues/new link when no token
 *   GET  /rules     serves rules.html, the rules-question page
 *   POST /rules/ask { question, answerLang, english?, stream? } -> findings, judge, answer
 *                    searches the indexed corpus, ranks with Jev, judges and writes
 *                    with a small model; every citation is a page it really fetched
 *
 * The browser cannot fetch miniheadquarters.com directly (no CORS headers), so
 * every parse happens here and the UI only renders. Stdlib only, no deps.
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { URL_RE, checkEvent, clearEventCache, getAllEvents, getMeta, playerWarnings, armyBudget, parseHtml, parseListText, parseUrl, renderMini, totals, loginSession, listOrganizedTournaments } from './parse.mjs';
import { ARCHIVE_DIR, entryForKey, eventKey, keyOfUrl, loadIndex, readEvent, rowFor } from './archive.mjs';
import { RulesError, credential, fastCredential, jevKeyName, keyState as rulesKeyState, modelCredential, RULES_EDITION as rulesEdition, RULES_EDITION_LABEL as rulesEditionLabel } from './rules.mjs';
import { ASK_MODES, VECTOR_BACKEND, WRITER_DECLINED, answerableFindings, askMode, compileFindings, corpusState, dontKnowAnswer, findingFor, indexInfo, judgeCoverage, looksForeign, readAllCorpus, routeStats, writerEnabled, reconcileVerdicts, translateQuestion } from './rules-corpus.mjs';
import { answeredTrace, appendTrace, buildTrace, labelsTrace, newTraceId, traceSignals, tracesEnabled, voteTrace } from './rules-traces.mjs';
// task-78: the asset route reads the corpus's asset tree; the import is its own line so
// the long corpus import above stays untouched.
import { corpusDir } from './rules-corpus.mjs';
import { recordCard, resolveRecordLinks, unitCard } from './unit-card.mjs';
import { CARD_CSS, cardIndex, recordBody } from './wiki-cards.mjs';
import { lookupRecord, searchHeadings } from './header-index.mjs';
import { devHtml, devState } from './dev-report.mjs';
// Slice 2, additive: the dev route and the surface's static files. The flip in
// slice 4 wires the surface into rules.html; nothing here touches it.
import { assetStamp, dataDir as surfaceDataDir, surfaceAsset, surfacePage, surfaceSlugMap } from './wiki-surface.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The process's own birth time, published by /dev: a src/ file newer than this is
// code the running process has never loaded.
const SERVER_BOOTED = Date.now();
const INDEX_PATH = path.join(__dirname, 'index.html');
// Read per request rather than at startup, so editing index.html does not
// require a server restart. It is a single small file and the response is no-store.
function readIndex() {
  return fs.readFileSync(INDEX_PATH, 'utf8');
}

// The rules page is read the same way, for the same reason: it is edited far
// more often than the server is restarted.
const RULES_PATH = path.join(__dirname, 'rules.html');
function readRules() {
  return fs.readFileSync(RULES_PATH, 'utf8');
}

// --- session auth ------------------------------------------------------
// The server is a login *proxy*, not a credential store. A password is accepted
// here, used exactly once to obtain a Django session, and discarded: it is never
// written to disk and is not held in memory past the request. The resulting
// session cookie goes back to the browser, which keeps it in its own localStorage
// and sends it with every /parse.
//
// This keeps two properties the old disk store did not have: no plaintext
// credential ever touches a file, and there is no single shared session, so two
// browsers on the same server cannot end up on one account.

async function handleLogin(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch (e) { return fail(res, 400, 'invalid JSON body: ' + e.message); }
  const u = typeof body.username === 'string' ? body.username.trim() : '';
  const p = typeof body.password === 'string' ? body.password : '';
  if (!u || !p) return fail(res, 400, 'missing "username" or "password"');
  try {
    const r = await loginSession(u, p);
    if (!r.ok) return json(res, 401, { error: r.error, auth: true });
    // The session goes straight back to the caller and the password is dropped.
    // Nothing is persisted, so there is no session to clear on logout.
    return json(res, 200, { cookie: r.cookie, redirect: r.redirect });
  } catch (e) {
    return json(res, 502, { error: 'login request failed: ' + String((e && e.message) || e) });
  }
}

// The caller's session arrives in a header, not the query string: a URL ends up
// in access logs, browser history and Referer headers, and this value is a live
// session. /parse already takes it in the JSON body, which is likewise never
// logged.
function headerCookie(req) {
  const v = req.headers['x-mhq-cookie'];
  return Array.isArray(v) ? v[0] : v;
}

// The events the caller organises, from MHQ's authenticated list. The sitemap
// carries only public events, so this is the only way an organiser can find
// their own from the picker - a private or not-yet-published event never shows
// up in the sitemap scan at all.
async function handleMyEvents(req, res) {
  const cookie = (typeof headerCookie(req) === 'string' && headerCookie(req).trim())
    || (typeof process.env.MHQ_COOKIE === 'string' && process.env.MHQ_COOKIE)
    || null;
  if (!cookie) return json(res, 200, { ok: false, auth: true, organized: [] });
  try {
    const r = await listOrganizedTournaments(cookie);
    if (r.auth) return json(res, 200, { ok: false, auth: true, organized: [] });
    if (!r.ok) return json(res, 502, { error: 'my-events returned HTTP ' + r.status, organized: [] });
    return json(res, 200, { ok: true, organized: r.organized });
  } catch (e) {
    return json(res, 502, { error: 'my-events request failed: ' + String((e && e.message) || e), organized: [] });
  }
}

// --- the archive --------------------------------------------------------
// Closed events live in archive/, committed to this repository, and they are
// read off disk. A closed event is finished business: its game, its list count
// and its armies are already known here, so listing it costs nothing and
// re-opening it costs no request to MHQ at all.
//
// A broken index is reported rather than swallowed. It means a bad commit, and
// the symptom without the message would be an empty archive that reads like MHQ
// had forgotten its own history.
let archiveError = null;
function archiveIndex() {
  try {
    const idx = loadIndex(ARCHIVE_DIR);
    archiveError = null;
    return idx;
  } catch (e) {
    archiveError = String((e && e.message) || e);
    return { events: [] };
  }
}

// The entry behind a URL, when we hold it. The organiser view never matches:
// it is a different page of the same event, carrying lists that were never
// published, so a cached public parse would answer it with the wrong armies.
function archiveEntryFor(url) {
  const key = keyOfUrl(url);
  return key ? entryForKey(archiveIndex(), key) : null;
}

// An archived parse is only as final as the event. A closed event cannot
// change, so the copy is the same parse MHQ would return; one that has not
// happened yet can, and the picker already labels it "(not yet)". Such an
// event is never answered from disk - opening it goes to the site.
function notYetPlayed(entry, today = new Date().toISOString().slice(0, 10)) {
  return !entry || typeof entry.date !== 'string' || entry.date >= today;
}

// Seed the in-memory scan from the committed refusal ledger. A serverless
// instance starts with an empty filter cache on every cold start, so without
// this the same non-40k events are fetched from MHQ again for an answer
// already on disk. The ledger is written by the harvest, which is the only
// place that can write it: the deployment's filesystem is read-only.
let filterSeeded = false;
function seedFilterFromArchive(index) {
  if (filterSeeded) return;
  filterSeeded = true;
  for (const e of (index.checked || [])) {
    if (!e.detailsUrl || filterCache.has(e.detailsUrl)) continue;
    filterCache.set(e.detailsUrl, { game: e.game || null, hasLists: !!e.hasLists, listCount: 0, at: Date.now() });
  }
}

// What the picker draws: the live window first, in the order it already had,
// then the archive newest-first. Archived events are all in the past, so they
// belong below the ones still worth watching - and they are added whole, not
// under the caller's limit, since serving them is free.
function withArchive(rows, index) {
  if (!index.events.length) return rows;
  const live = new Set(rows.map(e => eventKey(e.type, e.slug)));
  const extra = index.events
    .filter(e => !live.has(e.key))
    .map(rowFor)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return rows.concat(extra);
}

// --- event filtering ---------------------------------------------------
// The sitemap lists every tournament regardless of game or whether its army
// lists are published. The details page carries both facts, so we check each
// one in the background and hand the UI only what is both Warhammer 40,000 and
// has lists out. Results are cached for an hour.
//
// The scan is a fan-out: one fetch per event, two when lists are out, over
// ~2,000 tournaments. That cannot fit in a single serverless request at any
// concurrency - miniheadquarters.com alone takes about 9s to return the
// sitemap, and there is nothing left of the function's budget for the rest.
// FILTER_BATCH bounds each invocation so a request always terminates with the
// results it managed to fetch instead of being killed mid-scan and returning
// nothing. Warm instances (sitemap and filter both cached) finish much more
// than that, which is where the real headroom is.
const FILTER_TTL_MS = 60 * 60 * 1000;
// Sixteen at once is what got the origin to answer 524: this is someone's
// hobby site, not a load test. Six with a pause between batches keeps the scan
// moving without hammering it, and a slower honest scan beats a fast one that
// trips the throttle.
const FILTER_CONCURRENCY = 6;
const FILTER_BATCH = 24;
// Pause between batches, long enough for the origin to breathe.
const FILTER_BATCH_PAUSE_MS = 1200;
const FILTER_WINDOW_DAYS = 365;
let filterCache = new Map(); // detailsUrl -> { game, hasLists, at }
let filterScan = null;       // running scan promise, or null
// The last catalogue we managed to read, so a failed read is a stale list
// rather than an empty one. Process memory, like the caches beside it.
let lastWindowed = null;

// First day the filter will look at, in the ISO form the sitemap uses.
function windowStart() {
  return new Date(Date.now() - FILTER_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
}

// The catalogue is about two thirds tournaments more than a year old, and those
// are archaeology: nobody browses them, and an organiser's own history comes
// from /my-events, which never touches the sitemap. Restricting the window cuts
// the scan roughly in half with no infrastructure, which is what makes it
// tractable on a serverless instance. Dates are ISO strings, so the comparison
// is lexicographic. An event with no date cannot be placed in a window and is
// left out; the sitemap dates every tournament it lists.
function withinWindow(events) {
  const start = windowStart();
  return events.filter(e => typeof e.date === 'string' && e.date >= start);
}

function is40k(game) {
  return /warhammer\s*40/i.test(game || '');
}

// One event's check, with a retry. A timeout or a 5xx says nothing about the
// event, so it must not be recorded as one.
async function checkOne(detailsUrl) {
  try {
    return await checkEvent(detailsUrl);
  } catch (e) {
    await new Promise(r => setTimeout(r, 800));
    return await checkEvent(detailsUrl); // a second failure is caught below
  }
}

// Drain the queue in the background, one bounded batch at a time.
//
// It used to stop after FILTER_BATCH and wait for the next HTTP request to
// start another. That made progress a function of how often someone looked:
// open the page, walk away, and the scan sat at 40 until the next click. The
// request only reads the cache now; the scan runs on its own.
//
// An event that fails is left uncached, so the next pass retries it. Caching a
// failure as "checked, no lists" is the worst of both: the row disappears from
// the picker and stays gone for the whole TTL.
async function runScan(events) {
  if (filterScan) return filterScan;
  filterScan = (async () => {
    try {
      while (true) {
        const queue = events.filter(e => {
          const c = filterCache.get(e.detailsUrl);
          return !c || Date.now() - c.at > FILTER_TTL_MS;
        }).slice(0, FILTER_BATCH);
        if (!queue.length) break;
        let checked = 0;
        const workers = [];
        const n = Math.min(FILTER_CONCURRENCY, queue.length);
        for (let i = 0; i < n; i++) {
          workers.push((async () => {
            while (queue.length) {
              const e = queue.shift();
              try {
                const r = await checkOne(e.detailsUrl);
                filterCache.set(e.detailsUrl, { ...r, at: Date.now() });
                checked++;
              } catch {
                // Still failing: leave it uncached and try again next pass.
              }
            }
          })());
        }
        await Promise.all(workers);
        // Everything in the batch failed. Sleeping longer than a pause is the
        // difference between backing off and hammering a site that is down.
        await new Promise(r => setTimeout(r, checked === 0 ? 15000 : FILTER_BATCH_PAUSE_MS));
      }
    } finally {
      filterScan = null;
    }
  })();
  return filterScan;
}
function scanProgress(events) {
  let scanned = 0;
  for (const e of events) {
    if (filterCache.has(e.detailsUrl)) scanned++;
  }
  return { scanned, total: events.length, done: scanned >= events.length };
}

// The catalogue the picker draws. Every event in the window is listed, not
// only the ones already checked, because that is the whole cost of the first
// paint: waiting for the checks to trickle in means an empty list for minutes.
//
// So a row is listed when it is unknown or a confirmed match, and dropped only
// once a check has disproved it (another game, or no lists out). The list
// converges to the verified set as the scan runs, and starts as everything
// instead of nothing. An unchecked row carries no listCount, which the page
// already renders as the pending state.
function filteredList(events, limit) {
  const out = [];
  for (const e of events) {
    const c = filterCache.get(e.detailsUrl);
    if (c && !(is40k(c.game) && c.hasLists)) continue;
    out.push({ ...e, listCount: c ? (c.listCount || 0) : null, checked: !!c });
    if (out.length >= limit) break;
  }
  return out;
}

// --port / --host, with PORT / HOST env vars as fallback.
const argv = process.argv.slice(2);
let port = Number(process.env.PORT) || 8787;
// A hosted instance has to bind every interface: loopback inside its own
// container answers nothing, and the symptom is a connection refused that looks
// like a broken deployment rather than a bind address. Platforms set PORT, so
// that is the tell. A plain local run keeps loopback and stays off the network.
let host = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') port = Number(argv[++i]);
  else if (argv[i] === '--host') host = argv[++i];
  else if (argv[i].startsWith('--port=')) port = Number(argv[i].slice(7));
  else if (argv[i].startsWith('--host=')) host = argv[i].slice(7);
}
if (!Number.isFinite(port) || port <= 0) {
  // Warn and carry on. A hosted runtime treats a non-zero exit as a dead
  // function, so a bad port should cost one slow request, not every request.
  console.warn('Warning: --port must be a positive integer, falling back to 8787');
  port = 8787;
}

// A JSON control message is small; a saved army-lists page is not - a 40k team
// event is around a megabyte of markup, and the admin pages are heavier. The two
// limits are separate so raising one cannot loosen the other.
const MAX_BODY = 64 * 1024;
const MAX_FILE_BODY = 32 * 1024 * 1024;

// --- delivery: compression, validators, and the icon ------------------------
// The rules page is 140 KB of HTML and every wiki record is a page plus a
// stylesheet: a phone should not pay for that on every visit. Two things do the
// work - the body is compressed when the client offers it, and every cacheable
// response carries an ETag so a repeat visit costs a 304 rather than the body.
//
// The ask endpoint does NOT come through this helper: it STREAMS. A stream that
// arrives all at once is a regression the reader can see, because the page counts
// seconds while it waits, so that response is left exactly as it was.
const REQ_OF = new WeakMap();
const COMPRESS_MIN = 512;      // below this the framing costs more than it saves
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|xml|javascript)|image\/svg\+xml)/;
// The fallback icon: 119 bytes, an ICO holding a 16x16 PNG, kept so a clone
// without img/ still answers rather than 404ing.
const ICON = Buffer.from('AAABAAEAEBAAAAEAIABhAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAQAAAAEAgGAAAAH/P/YQAAAChJREFUeNpjyFvx7z8lmAFE8AuKkYUHqQEiUmp48agBI8OAIZqUKcEAWaOsmOgvCt0AAAAASUVORK5CYII=', 'base64');
// The brand icon, read once at boot: the 32x32 PNG Mandal supplied and the
// 180x180 touch icon generated beside it. Missing files fall back, above.
const readIcon = f => { try { return fs.readFileSync(path.join(__dirname, '..', 'img', f)); } catch { return null; } };
const ICON_32 = readIcon('favicon-32.png');
const ICON_180 = readIcon('apple-touch-icon.png');

// Brotli first: on this server's own text it beats gzip by about 15% (139,870
// bytes of /rules to 35,545 against gzip's 41,521), and a browser that offers
// brotli has offered it for years.
function pickEncoding(req) {
  const a = String((req && req.headers && req.headers['accept-encoding']) || '');
  if (/(?:^|[,\s])br(?:[;\s,]|$)/.test(a)) return 'br';
  if (/(?:^|[,\s])gzip(?:[;\s,]|$)/.test(a)) return 'gzip';
  return '';
}
function etagOf(buf) {
  return '"' + crypto.createHash('sha1').update(buf).digest('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 27) + '"';
}
// Compressed bodies are content-addressed and remembered: the ETag is a hash of
// the bytes, so a hit cannot be for different content. The rules page takes ~0.6 s
// to brotli at quality 11 (35,545 bytes against gzip's 41,521), which is worth
// paying ONCE per content change - a repeat visit is a memo hit or a 304. Bounded
// because the wiki render is 6,271 pages and every one of them has its own body.
const COMPRESSED = new Map();
const COMPRESS_CACHE_MAX = 64;
function compressedBody(buf, enc, tag) {
  const key = tag + ':' + enc;
  const hit = COMPRESSED.get(key);
  if (hit) return hit;
  const out = enc === 'br'
    ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } })
    : zlib.gzipSync(buf, { level: 9 });
  if (COMPRESSED.size >= COMPRESS_CACHE_MAX) COMPRESSED.delete(COMPRESSED.keys().next().value);
  COMPRESSED.set(key, out);
  return out;
}

function matchesEtag(req, tag) {
  const raw = String((req && req.headers && req.headers['if-none-match']) || '');
  if (!raw) return false;
  return raw.split(',').some(x => {
    const t = x.trim().replace(/^W\//, '');
    return t === '*' || t === tag.replace(/^W\//, '');
  });
}

// The cache policy, and there are exactly two:
//   revalidate (the default) - the bytes for a URL change only with the ETag, so
//     the body is stored and validated rather than re-sent: no-cache + ETag. The
//     HTML (/, /rules), the wiki render and its stylesheet.
//   no-store - an answer computed FOR one request and time-varying, where a
//     reused copy would be wrong rather than stale: /health (route counters that
//     climb), /rules/record, /rules/lookup, /rules/labels and the archive JSON.
//     They are small, so re-sending one costs less than a validator round trip.
function send(res, status, body, type, opts) {
  const o = opts || {};
  const req = REQ_OF.get(res);
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body == null ? '' : body), 'utf8');
  const contentType = type || 'application/json; charset=utf-8';
  const compressible = COMPRESSIBLE.test(contentType);
  const headers = { 'Content-Type': contentType };
  // Vary on every compressible response, compressed or not: the same URL has two
  // representations once Accept-Encoding is read, and a cache that forgets it
  // hands a br body to a client that asked for gzip.
  if (compressible) headers['Vary'] = 'Accept-Encoding';
  let tag = '';
  if (o.cache === 'no-store') {
    headers['Cache-Control'] = 'no-store';
  } else {
    headers['Cache-Control'] = o.maxAge || 'no-cache';
    tag = etagOf(buf);
    headers['ETag'] = tag;
    if (req && (req.method === 'GET' || req.method === 'HEAD') && matchesEtag(req, tag)) {
      res.writeHead(304, headers);
      return res.end();
    }
  }
  const enc = compressible ? pickEncoding(req) : '';
  if (enc && buf.length >= COMPRESS_MIN) {
    const out = compressedBody(buf, enc, tag || etagOf(buf));
    headers['Content-Encoding'] = enc;
    headers['Content-Length'] = out.length;
    res.writeHead(status, headers);
    return res.end(out);
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  return res.end(buf);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), undefined, { cache: 'no-store' });
const fail = (res, status, message) => json(res, status, { error: message });

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > max) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// One army, enriched with the derived fields the UI displays.
function viewPlayer(p) {
  const meta = getMeta(p);
  return { ...p, meta: meta, totals: totals(p), budget: armyBudget(p), warnings: playerWarnings(p, meta) };
}

// A session is always supplied by the caller: either pasted by hand, or obtained
// through /login and kept in that browser's localStorage. The server holds none
// of its own, so there is nothing to refresh here - an expired cookie is simply a
// 401, which the UI turns into a re-login prompt. Honesty beats magic: we cannot
// silently re-authenticate without a stored password, and storing one is exactly
// the privacy problem this module is meant to avoid.
async function parseWithSession(target, explicitCookie) {
  const cookie = explicitCookie
    || (typeof process.env.MHQ_COOKIE === 'string' && process.env.MHQ_COOKIE)
    || null;
  try {
    const { output, miniText } = await parseUrl(target, { cookie });
    return { ok: true, output, miniText, refreshed: false };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/authentication required/.test(msg)) return { ok: false, status: 401, error: msg, auth: true };
    if (/no army lists found/.test(msg)) return { ok: false, status: 404, error: msg };
    return { ok: false, status: /HTTP \d{3}/.test(msg) ? 502 : 500, error: msg };
  }
}

async function handleParse(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch (e) { return fail(res, 400, 'invalid JSON body: ' + e.message); }
  const target = body.url;
  if (typeof target !== 'string' || !target) return fail(res, 400, 'missing "url"');
  if (!URL_RE.test(target)) {
    return fail(res, 400, 'not a MiniHeadQuarters army-lists URL ' +
      '(expected https://miniheadquarters.com/tournaments/<type>/(army-lists|details)/<slug>, ' +
      'the organiser form https://miniheadquarters.com/tournaments/<type>/administrate/<slug>/(army-lists|details), ' +
      'or one submitted army https://miniheadquarters.com/tournaments/<type>/administrate/army-lists/<id>)');
  }
  const t0 = Date.now();
  // The archive answers first, for the events it holds. A closed event cannot
  // change, so this is not a shortcut with a stale answer: it is the same parse,
  // taken once and kept. "live": true declines it, which is what you want if
  // you suspect the copy rather than the cache.
  if (body.live !== true) {
    const entry = archiveEntryFor(target);
    const cached = entry && !notYetPlayed(entry) ? readEvent(ARCHIVE_DIR, entry) : null;
    if (cached && Array.isArray(cached.players)) {
      return json(res, 200, {
        event: cached.event,
        count: cached.count,
        players: cached.players.map(viewPlayer),
        miniText: renderMini(cached),
        elapsedMs: Date.now() - t0,
        source: 'archive',
        archivedAt: entry.archivedAt,
      });
    }
    // An index pointing at a file that is not there - a partial checkout, say -
    // falls through to the live page rather than failing the request.
  }
  const r = await parseWithSession(target, typeof body.cookie === 'string' ? body.cookie : null);
  if (r.ok) {
    return json(res, 200, {
      event: r.output.event,
      count: r.output.count,
      players: r.output.players.map(viewPlayer),
      miniText: r.miniText,
      elapsedMs: Date.now() - t0,
      refreshed: !!r.refreshed,
    });
  }
  return json(res, r.status, { error: r.error, auth: !!r.auth });
}

// A page the caller already has on disk, posted by the UI's file picker. The
// file *is* the input: nothing is fetched and no session is used, so a page that
// is private, unpublished or simply not reachable any more parses exactly like a
// fetched one.
//
// The markup travels as the raw request body rather than inside a JSON envelope.
// An MHQ page is a megabyte of quotes and backslashes, and JSON-escaping it would
// inflate that for nothing; the file's name rides in the query string instead.
// It is untrusted input that ends up in the page title, so it is reduced to a
// basename here rather than taken whole.
function displayName(raw) {
  if (typeof raw !== 'string') return null;
  const base = raw.replace(/\\/g, '/').split('/').pop() || '';
  // Drop control characters: a newline would run through into the heading.
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return clean || null;
}

async function handleParseFile(req, res, u) {
  let html;
  try { html = await readBody(req, MAX_FILE_BODY); }
  catch (e) {
    return fail(res, 413, 'file too large - the limit is ' +
      Math.round(MAX_FILE_BODY / (1024 * 1024)) + ' MB');
  }
  const t0 = Date.now();
  try {
    const { output, miniText } = parseHtml(html, { name: displayName(u.searchParams.get('name')) });
    return json(res, 200, {
      event: output.event,
      count: output.count,
      players: output.players.map(viewPlayer),
      miniText: miniText,
      elapsedMs: Date.now() - t0,
      source: 'file',
    });
  } catch (e) {
    // Nothing here is a remote failure - the file simply did not parse.
    return fail(res, 400, String((e && e.message) || e));
  }
}

// A pasted or dropped army list: text, not markup. The browser already holds it, so
// it arrives as the raw body with the file name in the query string, exactly as
// /parse-file takes a saved page. No session is involved and nothing is fetched - a
// list is the whole input.
//
// The answer is the same shape /parse gives, so a paste, a drop and a fetched event
// all render through one code path in the page.
async function handleParseList(req, res, u) {
  let text;
  try { text = await readBody(req, MAX_FILE_BODY); }
  catch (e) {
    return fail(res, 413, 'text too large - the limit is ' +
      Math.round(MAX_FILE_BODY / (1024 * 1024)) + ' MB');
  }
  const t0 = Date.now();
  try {
    const { output, miniText } = parseListText(text, { name: displayName(u.searchParams.get('name')) });
    return json(res, 200, {
      event: output.event,
      count: output.count,
      players: output.players.map(viewPlayer),
      miniText: miniText,
      elapsedMs: Date.now() - t0,
      source: 'list',
    });
  } catch (e) {
    // Nothing here is a remote failure - the text simply did not parse.
    return fail(res, 400, String((e && e.message) || e));
  }
}
// Recent tournaments for the picker. The browser cannot read the sitemap
// directly (no CORS), so the page asks us. The sitemap is heavy (~2 MB) and is
// cached for a few hours inside listEvents, so this stays cheap.
async function handleEvents(req, res, u) {
  let limit = 80;
  const lm = u.searchParams.get('limit');
  if (lm) {
    const n = parseInt(lm, 10);
    if (Number.isFinite(n)) limit = n;
  }
  // Two controls, and they are not the same thing.
  //
  // ?refresh=1 restarts the checking: every event is fetched and judged again,
  // but the catalogue itself (the 2 MB sitemap) stays, so it costs no re-read.
  // That is what you want when the scan stalled or a page was half checked.
  // ?clear=1 throws everything away and answers with nothing, so the picker
  // empties and the next open rebuilds from scratch.
  if (u.searchParams.get('refresh') === '1') {
    filterCache = new Map();
    filterScan = null;
    filterSeeded = false; // the committed refusals come back on the next read
  }
  if (u.searchParams.get('clear') === '1') {
    clearEventCache();
    filterCache = new Map();
    filterScan = null;
    filterSeeded = false;
  }
  if (u.searchParams.get('clear') === '1') {
    // The archived rows stay: they are committed files, not something this
    // process cached, so clearing the cache cannot empty them. Only the live
    // scan starts over.
    const rows = withArchive([], archiveIndex());
    return json(res, 200, { events: rows, count: rows.length, scanned: 0, total: 0, done: true, cleared: true, windowDays: FILTER_WINDOW_DAYS });
  }
  try {
    // The window is applied once, here, and the subset is what the scan, the
    // progress report and the result list all see. That keeps "done" reachable:
    // out-of-window events are never scanned, so counting them against a target
    // would mean the scan can never finish.
    const arch = archiveIndex();
    seedFilterFromArchive(arch);
    const archived = new Set(arch.events.map(e => e.key));
    const all = await getAllEvents();
    // Already archived means already judged, so the scan leaves it alone. That
    // is the whole point of the archive: history costs no requests at all,
    // here or on the harvest that filled it.
    const windowed = withinWindow(all).filter(e => !archived.has(eventKey(e.type, e.slug)));
    lastWindowed = windowed;
    runScan(windowed); // fire and forget: the scan drains the queue on its own
    const progress = scanProgress(windowed);
    const fl = withArchive(filteredList(windowed, limit), arch);
    return json(res, 200, {
      events: fl,
      count: fl.length,
      scanned: progress.scanned,
      total: progress.total,
      done: progress.done,
      archived: arch.events.length,
      checked: (arch.checked || []).length,
      windowDays: FILTER_WINDOW_DAYS,
      archiveError: archiveError || undefined,
    });
  } catch (e) {
    // The catalogue could not be read. If we have one from a moment ago, hand
    // it back with the error attached rather than emptying the picker: a
    // throttled origin should cost a stale list, not a blank panel and an
    // error where the numbers should be.
    const arch = archiveIndex();
    if (lastWindowed && lastWindowed.length) {
      const rows = withArchive(filteredList(lastWindowed, limit), arch);
      return json(res, 200, {
        events: rows,
        count: rows.length,
        scanned: scanProgress(lastWindowed).scanned,
        total: scanProgress(lastWindowed).total,
        done: false,
        archived: arch.events.length,
        stale: true,
        error: String((e && e.message) || e),
        windowDays: FILTER_WINDOW_DAYS,
      });
    }
    // Even with no catalogue at all, the archive still answers: it is on disk.
    const rows = withArchive([], arch);
    if (rows.length) {
      return json(res, 200, { events: rows, count: rows.length, scanned: 0, total: 0, done: true, archived: arch.events.length, archiveOnly: true, error: String((e && e.message) || e) });
    }
    return json(res, 502, { error: String((e && e.message) || e) });
  }
}

// --- feedback: file an issue on GitHub -------------------------------------
// The footer's Feedback button POSTs a short note here. Two outcomes:
//   * GITHUB_TOKEN is set   -> the note is filed as an issue on its own, and the
//     browser is handed the new issue's URL to confirm it. The token lives only
//     on the server, so a public instance never leaks a credential.
//   * no token configured    -> nothing is sent anywhere. Instead the server
//     builds a github.com/<repo>/issues/new link with the title and body already
//     filled in, and the browser opens it. The user reviews and clicks submit:
//     the minimum that still respects GitHub's own auth.
// The token is read from the environment, never from the request, so a caller
// cannot make this endpoint file an issue through somebody else's credentials.
const GITHUB_TOKEN = (typeof process.env.GITHUB_TOKEN === 'string' && process.env.GITHUB_TOKEN.trim()) || '';
const FEEDBACK_REPO = feedbackRepo(process.env.FEEDBACK_REPO) || 'BOGOSbot/mhq-parser';

function feedbackRepo(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  // owner/repo, nothing else; reject URLs and empty so a bad env cannot send
  // the issue to some arbitrary host.
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s) ? s : '';
}

function newIssueUrl(title, body) {
  const q = new URLSearchParams({ title, body });
  return 'https://github.com/' + FEEDBACK_REPO + '/issues/new?' + q.toString();
}

// POST an issue to the GitHub API. Resolves with a plain descriptor rather than
// rejecting: a bad token or a network stall must degrade to the prefilled link,
// not surface as a 500 to a user who only wanted to leave a note.
function createIssue({ repo, token, title, body }) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ title, body });
    const req = https.request({
      method: 'POST',
      hostname: 'api.github.com',
      path: '/repos/' + repo + '/issues',
      headers: {
        'User-Agent': 'mhq-parser-feedback',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let obj = null;
        try { obj = JSON.parse(text); } catch { /* non-JSON error page */ }
        resolve({ status: r.statusCode, obj });
      });
    });
    req.setTimeout(20000, () => { req.destroy(new Error('timed out')); });
    req.on('error', e => resolve({ status: 0, error: String((e && e.message) || e) }));
    req.write(payload);
    req.end();
  });
}

async function handleFeedback(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch (e) { return fail(res, 400, 'invalid JSON body: ' + e.message); }

  const detail = typeof body.body === 'string' ? body.body : '';
  if (!detail.trim()) return fail(res, 400, 'missing "body"');
  let title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    // No explicit title: the first non-empty line of the feedback is the title.
    const firstLine = detail.split(/\r?\n/).find(l => l.trim());
    title = (firstLine || 'Feedback').trim();
  }
  if (title.length > 256) title = title.slice(0, 253) + '\u2026';   // GitHub caps titles at 256
  const fullBody = detail.length > 62000 ? detail.slice(0, 62000) + '\n\n_(truncated)_' : detail;

  const fallback = newIssueUrl(title, fullBody);
  if (!GITHUB_TOKEN) return json(res, 200, { created: false, url: fallback });

  const r = await createIssue({ repo: FEEDBACK_REPO, token: GITHUB_TOKEN, title, body: fullBody });
  if (r.status >= 200 && r.status < 300 && r.obj && r.obj.html_url) {
    return json(res, 200, { created: true, url: r.obj.html_url, number: r.obj.number });
  }
  // Filed wrong (bad scope, rate limit, network). Do not lose the text: give the
  // browser the prefilled link so the user can still submit it by hand.
  const reason = r.error || (r.obj && r.obj.message) || ('GitHub returned HTTP ' + r.status);
  return json(res, 200, { created: false, url: fallback, error: String(reason) });
}

// --- rules answers ----------------------------------------------------------
// The page asks the corpus now, not Wahapedia. The corpus was scraped and
// embedded ahead of time, so a question costs a query rather than a crawl:
// seconds instead of ten to thirty, and no dependence on the origin being up.
//
// Both halves are searched. Core rules and faction rules live in separate
// namespaces and are retrieved separately, because a datasheet question and a
// core-rules question want different halves and, sharing one index, each
// crowded the other out.
//
// A French question is translated into English search terms first. The corpus
// is English and grep cannot match a word that is not there, so "blessures
// mortelles" has to become "mortal wounds" before anything can be found. Those
// terms are search input only - nothing machine-translated is ever shown as a
// fact, and the glossary that is sourced beats the model that is not.
//
// The findings are returned and rendered beside the answer. The answer is an
// addition to them, never a substitute: the citations are the product. The
// judge is a signal about the findings, not a replacement for them.
let corpusCache = null;
function corpora() {
  // Parsed once, not per request: the grep leg reads them whole and they are
  // thousands of records.
  // task-102: the rulings half is part of the corpus. Without it here, every WTC/FEQ record
  // 404s from the record endpoint while the drawer lists it - Mandal's 'The record could not
  // be loaded.' on FEQ Army Rule.
  if (!corpusCache) corpusCache = { rules: readAllCorpus('rules'), factions: readAllCorpus('factions'), rulings: readAllCorpus('rulings') };
  return corpusCache;
}

// Every record of both halves, by id, for the one job a finding's links cannot do
// on their own: a link is a target id, and a chip needs that target's own anchor
// and url. Built once beside the corpus cache, because it is 6,700 records and a
// second parse per question would be the whole corpus read again.
let byIdCache = null;
function corpusById() {
  if (!byIdCache) {
    byIdCache = new Map();
    for (const half of ['rules', 'factions', 'rulings']) for (const sec of corpora()[half] || []) byIdCache.set(sec.id, sec);
  }
  return byIdCache;
}

// The one record renderer's index, built once: the corpus by id plus the two keys
// an ability link carries. Same module and same arguments as the static wiki
// render, so the fragment served on demand IS the fragment the render wrote.
let cardIdxCache = null;
function cardIdx() {
  if (!cardIdxCache) cardIdxCache = cardIndex(corpusById());
  return cardIdxCache;
}

// A record's address is its slug now (task-77): the surface answers #<slug> on a
// cold load, so the links inside a record body point at the hash directly. No
// page file, no map: the payload's own slug is the link.
function wikiFileFor(id) {
  const slug = surfaceSlugMap().get(String(id || ''));
  return slug ? '#' + slug : '';
}

// A cheap guess, only used when the client does not say. The page sends its
// own answer, because the voice control already knows which language it
// listened for.
export function looksFrench(text) {
  return /[àâçéèêëîïôûùüÿœ]|\b(le|la|les|des|une|un|est|que|qui|pour|avec|sur|dans|je|peut|doit|figurine|unité|règle|test|combien)\b/i.test(String(text));
}

// A thumb on one answer. The vote is written into the trace record it belongs to,
// by question id, and only when traces are on: the record exists whether or not
// anyone votes, so a vote for a question nobody kept is dropped silently instead
// of starting a second store. Boolean, one id one vote, and nothing in it
// identifies the reader - it is one value beside a random id.
async function handleRulesVote(req, res) {
  let body = {};
  try { body = JSON.parse((await readBody(req, 4096)) || '{}'); } catch (e) { return fail(res, 400, 'bad JSON body'); }
  const id = typeof body.id === 'string' ? body.id : '';
  const vote = body.vote === 'up' || body.vote === 'down' ? body.vote : '';
  if (!id || !vote) return fail(res, 400, 'need { id, vote: up|down }');
  if (!tracesEnabled()) return json(res, 200, { ok: true, saved: false });
  let saved = false;
  try { saved = voteTrace(id, vote); } catch (e) { saved = false; }
  return json(res, 200, { ok: true, saved });
}

// The reader's pick: an explicit 'this passage answered it', or 'none of these'.
// It is an ASSERTION and not the manual rerank's kept set - the kept set is a
// preference for the next answer, this is recorded with the question as a
// candidate for the test bank, and the trace keeps kind: unknown either way. It
// is written into the trace record the question's random id names, exactly like
// the thumb, and the id is checked against the findings that record actually
// holds: a pick can only name something the reader was shown. One pick per
// question; a second replaces the first, whatever it was.
async function handleRulesAnswered(req, res) {
  let body = {};
  try { body = JSON.parse((await readBody(req, 4096)) || '{}'); } catch (e) { return fail(res, 400, 'bad JSON body'); }
  const id = typeof body.id === 'string' ? body.id : '';
  const none = body.none === true;
  const by = typeof body.by === 'string' ? body.by : '';
  if (!id || (!none && !by)) return fail(res, 400, 'need { id, by } or { id, none: true }');
  if (!tracesEnabled()) return json(res, 200, { ok: true, saved: false });
  let saved = false;
  try { saved = answeredTrace(id, { by, none }); } catch (e) { saved = false; }
  return json(res, 200, { ok: true, saved });
}

// The reader's rerank, as labelled examples: the green caret on a finding is a
// POSITIVE for that record id, the x a NEGATIVE. Both are written into the SAME
// trace as the question - the dataset's gold slice - through the same find-by-id
// patch the thumb and the pick use, so the reader's judgement sits beside the
// question, the findings and the verdict it was made about. Same posture as the
// vote: traces off or a swept line drops it silently ({ saved: false }), there is
// no second store, and a record id the trace never showed is refused rather than
// recorded.
async function handleRulesLabels(req, res) {
  let body = {};
  try { body = JSON.parse((await readBody(req, 4096)) || '{}'); } catch (e) { return fail(res, 400, 'bad JSON body'); }
  const id = typeof body.id === 'string' ? body.id : '';
  const positive = Array.isArray(body.positive) ? body.positive.filter(x => typeof x === 'string' && x).slice(0, 40) : null;
  const negative = Array.isArray(body.negative) ? body.negative.filter(x => typeof x === 'string' && x).slice(0, 40) : null;
  if (!id || (!positive && !negative)) return fail(res, 400, 'need { id, positive: [ids], negative: [ids] }');
  if (!tracesEnabled()) return json(res, 200, { ok: true, saved: false });
  let saved = false;
  try { saved = labelsTrace(id, { positive: positive || [], negative: negative || [] }); } catch (e) { saved = false; }
  return json(res, 200, { ok: true, saved });
}

// One record, for the full-screen view: the same builder for every category the
// view opens - unit, faction, detachment, rules section. Ids only, resolved
// against the corpus this process already holds, so a client cannot ask for a
// record the corpus does not have, and the page never asks the model for one.
// The baked payloads, read straight from workspace/wiki-data. Only the three
// shapes are addressable - index.json, index/<branch>.json, content/<book>.json -
// so a crafted path cannot walk out of the directory.
function handleSurfaceData(req, res, u) {
  const rel = String(u.pathname.slice('/rules/data/'.length));
  if (!/^(index\.json|index\/[a-z0-9-]+\.json|content\/[a-z0-9-]+\.json)$/.test(rel)) return fail(res, 404, 'no such payload: ' + rel);
  try {
    const body = fs.readFileSync(path.join(surfaceDataDir(), rel));
    return send(res, 200, body, 'application/json; charset=utf-8');
  } catch (e) { return fail(res, 404, 'no such payload: ' + rel); }
}

async function handleRulesRecord(req, res, u) {
  const id = String((u && u.searchParams.get('id')) || '');
  if (!id) return fail(res, 400, 'need ?id=<record id>');
  let record = null;
  try { record = recordCard(id, { corpora: corpora(), index: corpusById() }); } catch (e) { record = null; }
  if (!record) return fail(res, 404, 'no such record: ' + id);
  // The SAME fragment the static wiki render writes, on demand, for the ask page's
  // record dialog to insert. One renderer (src/wiki-cards.mjs), one index, one link
  // resolver - the two paths cannot drift because they are the same function. The
  // shell around it (marks, chips, wiki link, swipe) stays the page's.
  if (String(u.searchParams.get('format') || '').toLowerCase() === 'html') {
    const raw = corpusById().get(id);
    if (!raw) return fail(res, 404, 'no such record: ' + id);
    // task-89: selfId so a record never links to itself - '2. Select Targets > Selecting
    // Targets' was linkified back to the record being read.
    return send(res, 200, recordBody(raw, { corpora: corpora(), index: cardIdx(), href: wikiFileFor, selfId: raw.id }), 'text/html; charset=utf-8');
  }
  return json(res, 200, { ok: true, record, slug: surfaceSlugMap().get(id) || '' });
}

// task-78: the mission card faces. The corpus owns the bytes (private, off-git,
// refetchable by URL); this route is the only door to them. Anchored: one relative
// path, no '..', faces at missions/<kind>/<deck|role>/<slug>.png plus the manifest
// the render reads. The bytes behind a URL never change, so they cache forever;
// the manifest does not.
const ASSET_PATH = /^(?:missions\/(?:primary|secondary)\/(?:[a-z0-9-]+\/)?[a-z0-9-]+\.png|missions\/sources\.json)$/;
function handleRulesAsset(req, res, u) {
  const rel = String((u && u.searchParams.get('path')) || '');
  if (!ASSET_PATH.test(rel)) return fail(res, 404, 'no such asset: ' + rel);
  let body = null;
  try { body = fs.readFileSync(path.join(corpusDir(), 'assets', rel)); } catch (e) { return fail(res, 404, 'no such asset: ' + rel); }
  if (rel.slice(-5) === '.json') return send(res, 200, body, 'application/json; charset=utf-8', { cache: 'no-store' });
  return send(res, 200, body, 'image/png', { maxAge: 'public, max-age=31536000, immutable' });
}
// A lookup by name, answered from the header index before anything else runs:
// mechanical - a grep over the corpus's own headings - with no embedding, no
// index write and no model call. A miss (a phrase the corpus does not name, a
// name several headings carry, or a question that is not a lookup at all) falls
// through to the full pipeline, and the reply says which, so a fall-through is
// never silent.
async function handleRulesLookup(req, res, u) {
  const q = String((u && u.searchParams.get('q')) || '').trim();
  if (q.length < 3) return fail(res, 400, 'need ?q=<lookup>');
  let hit;
  try { hit = lookupRecord(q); } catch (e) { return fail(res, 500, 'lookup failed: ' + String((e && e.message) || e)); }
  if (!hit.found) return json(res, 200, { ok: true, found: false, reason: hit.reason, candidates: hit.candidates || 0 });
  const rec = corpusById().get(hit.id);
  if (!rec) return json(res, 200, { ok: true, found: false, reason: 'no-heading', candidates: 0 });
  const f = findingFor(rec, 1);
  return json(res, 200, {
    ok: true,
    found: true,
    tier: hit.tier,
    // The shape the record view reads, and only that: `passage` is the record's
    // own text, so the truncated `excerpt` the findings list prints is dropped
    // here rather than sent twice (byte-identical under 600 characters, one
    // wasted kilobyte above it).
    record: {
      id: f.id, n: 1, set: f.set, source: f.source, faction: f.faction, heading: f.heading,
      ruleId: f.ruleId, url: f.url, href: f.href, passage: f.text || '',
      rank: 0, leg: '', matchedTerms: [], kind: rec.kind || '',
      links: resolveRecordLinks(rec.links, corpusById()),
    },
  });
}

// GET /rules/find?q= - the drawer's search. Every record whose heading names the
// words, ranked, as one small JSON list: the server already holds the heading
// projection in memory for the lookup router, so a search is a grep and a round
// trip - no payload fetch, no model, nothing for a phone to download beyond the
// rows it shows. A row carries the payload slug, which is the only address the
// drawer can open a record by.
async function handleRulesFind(req, res, u) {
  const q = String((u && u.searchParams.get('q')) || '').trim();
  let out;
  try { out = searchHeadings(q, { limit: 40 }); }
  catch (e) { return fail(res, 500, 'search failed: ' + String((e && e.message) || e)); }
  const slugs = surfaceSlugMap();
  const rows = (out.rows || [])
    .map(r => ({ slug: slugs.get(r.id) || '', title: r.title, kind: r.kind, tier: r.tier, crumbs: r.crumbs }))
    .filter(r => r.slug);
  // The pre-filter count, so a capped list can say how many matched in all.
  return json(res, 200, { ok: true, q, total: out.total || rows.length, rows });
}

async function handleRulesAsk(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req, 128 * 1024)) || '{}'); }
  catch (e) { return fail(res, 400, 'invalid JSON body: ' + e.message); }
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (question.length < 3) return fail(res, 400, 'ask a question (at least 3 characters)');
  if (question.length > 1000) return fail(res, 400, 'that question is too long (1000 characters max)');

  // The manual rerank (task-21): the reader unticks the passages the answer should
  // not rest on, and the page sends back the ids that stay. Retrieval is skipped -
  // the reader has already decided what is relevant - and only the judge and the
  // writer run. The request carries ids, never passage text: the server resolves
  // them against its own corpus, so a client cannot inject prose into a prompt.
  // `asked` is the English question the reader already read, sent back so the
  // rerun does not pay for a translation it already has.
  const keepIds = Array.isArray(body.keep)
    ? body.keep.filter(x => typeof x === 'string' && x).slice(0, 40)
    : [];
  const shownIds = Array.isArray(body.shown)
    ? body.shown.filter(x => typeof x === 'string' && x).slice(0, 60)
    : [];
  const override = keepIds.length > 0;
  const reuseAsked = override && typeof body.asked === 'string' && body.asked.trim().length >= 3 ? body.asked.trim() : '';
  const overrideOf = override && typeof body.over === 'string' ? body.over.slice(0, 64) : '';

  // The reader no longer tells us the language. The question does: a clear
  // English question is left alone, anything else is translated in full. A
  // client that already has the English (a corrected translation) sends it back
  // as english:true and skips the call.
  const questionIsEnglish = body.english === true;
  const foreign = !questionIsEnglish && looksForeign(question);
  const lang = questionIsEnglish ? 'en' : (foreign ? '' : 'en');
  // The answer keeps the reader's language even though the search runs in
  // English: a French question gets a French answer citing the English terms.
  // A client that already corrected the translation says so with answerLang.
  const wantedAnswerLang = body.answerLang === 'fr' || body.answerLang === 'en' ? body.answerLang : '';
  // The Jev key follows the route: the ranker authenticates with whichever
  // gateway rules.mjs has active, OpenRouter's paid decisions endpoint right
  // now while the free tier rate-limits.
  // The judge and the translation run on the fast route, the answer on the
  // writer's: a small model decides well and writes badly, and the writer is
  // the step the reader grades.
  const keys = { jev: credential(jevKeyName()), model: modelCredential(), fast: fastCredential() };
  const steps = [];
  const started = Date.now();
  // One id per question, made once: the trace and the thumb have to agree on it.
  const traceId = tracesEnabled() ? newTraceId() : '';
  const timed = async (name, fn) => {
    const at = Date.now();
    const value = await fn();
    steps.push({ name, ms: Date.now() - at });
    return value;
  };

  // Each stage is published as it lands rather than all at the end. The findings
  // are the product, and they are ready in a couple of seconds; the judge and
  // the prose take twenty more. Sending them together would make a reader wait
  // for the slowest part to read the fastest one.
  //
  // The judge is emitted last but belongs first on the page: it says whether the
  // findings are worth reading, so it sits above them rather than after them.
  const stream = body.stream === true;
  let gone = false;
  req.on('close', function () { gone = true; });
  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    // A heartbeat. The longest silent gap on this stream is the judge thinking
    // (up to three minutes), and a response that sends nothing for a minute is
    // what an intermediary or a browser is entitled to cut - the page then shows
    // the browser's own 'Error in input stream' after an answer that had already
    // arrived. One line every 15s keeps the connection busy; the page ignores it
    // (an unknown event type is a no-op) and it is never written after the
    // response has finished.
    var pingTimer = setInterval(function () {
      if (!gone) { try { res.write(JSON.stringify({ type: 'ping', elapsedMs: Date.now() - started }) + '\n'); } catch (e) { gone = true; } }
    }, 15000);
    var stopPing = function () { clearInterval(pingTimer); pingTimer = null; };
    res.on('close', stopPing);
    res.on('finish', stopPing);
    // Without this the headers sit in Node until the first body write, so the
    // browser's fetch does not even resolve - and the page cannot draw its
    // waiting state - until translation has finished several seconds later.
    res.flushHeaders();
  }
  const emit = obj => {
    if (!stream || gone) return;
    try { res.write(JSON.stringify(obj) + '\n'); } catch (e) { gone = true; }
  };

  // Which stages this question will actually run. A French question has one
  // more than an English one, and the page needs the list to draw a bar with the
  // right segments rather than a fixed guess.
  // The writer is off by default (see writerEnabled): when it is off there is no
  // answer segment on the bar and nothing waits on prose.
  const writerOn = writerEnabled(process.env, body.writer);
  const stages = (override ? ['judge'] : (foreign ? ['translate'] : []).concat(['retrieve', 'judge'])).concat(writerOn ? ['answer'] : []);
  // The page needs the id to attach a thumb to the right record, and the id is
  // the only handle it gets: eight random bytes that tie to nothing.
  emit({ type: 'start', lang: lang || 'und', stages, traceId, elapsedMs: Date.now() - started });

  try {
    // The whole question is translated, not only its keywords: the retrieval
    // wants English words, but the judge and the writer want the question, and
    // 'can Asurmen embark after shooting' is not 'asurmen embark shoot'.
    // A rerun does not translate again: it already has the English the first
    // answer was judged and written from, and re-deriving it would be a call the
    // reader paid for once already.
    const translation = (foreign && !reuseAsked)
      ? await timed('translate', () => translateQuestion(question, keys.fast))
      : { lang: 'en', translated: reuseAsked, terms: [], glossary: [] };
    const asked = translation.translated || question;
    const terms = translation.terms || [];
    const answerLang = wantedAnswerLang || (String(translation.lang || '').slice(0, 2) === 'fr' ? 'fr' : 'en');
    if (foreign && !reuseAsked) {
      emit({ type: 'translation', detected: translation.lang || 'und', original: question, translated: translation.translated, terms, elapsedMs: Date.now() - started });
    }
    emit({ type: 'terms', terms, translated: translation.translated || '', elapsedMs: Date.now() - started });

    // Which setting the reader chose. Read here rather than further down so the
    // card branch below can put it in the trace; the event itself is still sent
    // only on the prose path, where the setting actually changes what runs.
    const modeName = askMode(body.mode);
    const mode = ASK_MODES[modeName];

    // A unit card is rendered here, before anything is searched, and it is
    // ADDITIVE: the search, the judge and the writer always run, and the card
    // arrives beside their answer rather than instead of it.
    //
    // It used to replace the pipeline when it fired, and that was a bug with a
    // trace: 'est-ce que fuegan peut arriver de reserves a portee de melta ?'
    // matched an intent word the TRANSLATOR had generated ('Melta weapons' among
    // its terms - the terms are a retrieval artefact, never the reader's
    // question), the card fired, and a rules question got a datasheet with no
    // judge and no answer. The English wording needed no translation, had no
    // terms, and answered correctly - the whole French-versus-English asymmetry.
    // The gate now reads the question and its translation only (src/unit-card.mjs)
    // and, because a question that literally says "melta weapons" still matches,
    // the pipeline runs whatever the card does. The card is mechanical and costs
    // 0.0s, so it is emitted at once as a preview: the reader gets something
    // immediately and the prose follows.
    //
    // The corpora are already in memory for the search; the card needs them to
    // resolve a Base or Faction ability to the rule it names. The index is never
    // touched either way.
    const card = override ? null : unitCard(question, { asked, corpora: corpora() });
    if (card) emit({ type: 'card', card, preview: true, elapsedMs: Date.now() - started });

    // The search keeps deepening while the judge says it cannot answer, and the
    // last pass is the last word. The judge's verdict is binding: a retrieval it
    // has already called insufficient must not go on to produce a confident
    // answer, which is exactly what used to happen.
    let findings = [];
    let counts = { rules: 0, factions: 0 };
    // The page labels every finding with the leg that produced it and outlines
    // the words the lexical leg matched, so the provenance travels with the
    // payload rather than being guessed from the question. `passage` is the
    // whole record - the popup shows the passage without a second request - and
    // `excerpt` stays the short form the list prints.
    //
    // `id` is the record's own id - the pointer, never the passage - and both
    // controls that name a finding need it: the manual rerank sends the kept ids
    // back and the server resolves them against the corpus, and the reader's pick
    // is checked against the findings the trace holds. Without it the page has a
    // list it cannot name a record in, and every keep/drop collapses onto one
    // undefined key.
    // A finding's links travel with it, resolved from the record the finding
    // points at: the page draws a chip per link from this array alone, so the
    // text's own '- section: X' block is never parsed - one source, or the two
    // drift. A finding whose record is not in the corpus carries none.
    const byId = corpusById();
    const toPayload = list => list.map(f => ({
      id: f.id, n: f.n, set: f.set, source: f.source, faction: f.faction, heading: f.heading,
      ruleId: f.ruleId, url: f.url, href: f.href, excerpt: f.excerpt, passage: f.text || '',
      rank: f.rank || 0, leg: f.leg || '',
      vectorRank: f.vectorRank || 0, vectorScore: f.vectorScore,
      lexicalRank: f.lexicalRank || 0, lexicalScore: f.lexicalScore,
      matchedTerms: f.matchedTerms || [],
      links: resolveRecordLinks((byId.get(f.id) || {}).links, byId),
    }));

    // The reader picks the setting: fast asks the judge not to reason and takes
    // a narrower, shallower search; deep lets it think and looks wider for
    // longer. Both keep the anchoring, which is what makes the fast setting safe.
    emit({ type: 'mode', mode: modeName, first: mode.first, passes: mode.passes, reasoning: mode.reasoning || 'model default', elapsedMs: Date.now() - started });
    // A manual rerank: the reader's own selection IS the retrieval. The ids are
    // resolved against both halves in the order sent, they become the findings,
    // and the judge's verdict on them is binding exactly as it is on a searched
    // list. Nothing is searched and nothing is widened.
    let outcome;
    if (override) {
      const byId = new Map();
      for (const half of ['rules', 'factions', 'rulings']) for (const sec of corpora()[half] || []) byId.set(sec.id, sec);
      const chosen = keepIds.map(id => byId.get(id)).filter(Boolean).map((sec, i) => findingFor(sec, i + 1));
      if (!chosen.length) throw new RulesError(400, 'none of those passages is in the corpus');
      findings = chosen;
      counts = { rules: chosen.filter(f => f.set !== 'factions').length, factions: chosen.filter(f => f.set === 'factions').length };
      const plan = { rules: counts.rules, factions: counts.factions };
      emit({ type: 'findings', findings: toPayload(chosen), counts, terms, steps, attempt: 0, plan, escalated: false, override: true, elapsedMs: Date.now() - started });
      const verdict = await timed('judge', () => judgeCoverage(asked, chosen, keys.fast, { reasoning: mode.reasoning, lang: answerLang }));
      emit({ type: 'judge', judge: verdict, final: true, attempt: 0, elapsedMs: Date.now() - started });
      outcome = {
        findings: chosen,
        judge: verdict,
        dual: null,
        attempts: [{ plan, count: chosen.length, answered: verdict.answered === true, confidence: verdict.confidence || '', widen: verdict.widen, final: true }],
        unresolved: verdict.answered !== true,
        escalated: false,
      };
    } else {
    outcome = await timed('retrieve+judge', () => answerableFindings(asked, {
      fastKey: keys.fast,
      topKs: [mode.first],
      passes: mode.passes,
      // The verdict is shown to the reader, so both judges write it in the
      // reader's language; the passages stay as the corpus writes them.
      judgeOpts: { reasoning: mode.reasoning, lang: answerLang },
      dual: {
        rulesCorpus: corpora().rules,
        factionsCorpus: corpora().factions,
        jevKey: keys.jev,
        terms,
        // The grep net and the reranker's net are both wider than the cut, and
        // the reranker's is the one that mattered: on 'can Asurmen re-embark
        // after shooting' the Embarking rule reached merged rank 54, so a net of
        // 50 never showed it to Jev and the judge was asked about a corpus that
        // had the rule without being shown it. At 80 the same passage came back
        // 4th. One batched call, so the wider net is one request, not forty.
        grepNet: mode.grepNet,
        jevMax: mode.jevMax,
      },
      onFindings: ({ plan, findings: found, dual, attempt }) => {
        findings = found;
        counts = { rules: dual.rules.length, factions: dual.factions.length };
        emit({
          type: 'findings', findings: toPayload(found), counts, terms, steps,
          attempt, plan, escalated: attempt > 0, elapsedMs: Date.now() - started,
        });
      },
      onJudge: ({ judge, final, attempt }) => {
        emit({ type: 'judge', judge, final, attempt, elapsedMs: Date.now() - started });
        // Only the intermediate verdict widens; the last one is final by
        // definition and the page should not be told the search will continue.
        if (!final) emit({ type: 'escalate', widen: judge.widen || 'both', elapsedMs: Date.now() - started });
      },
    }));
    }

    const judge = outcome.judge;
    const payload = toPayload(outcome.findings);
    // task-75: the TAIL - the candidates the cut did not take, in the order the
    // same retrieval ranked them and deliberately UNJUDGED. No extra retrieval:
    // outcome.dual.all is the pre-cut list the judged findings came from. Both
    // lists carry the record's slug, so a record opened from the answer has an
    // address (the slug is the only thing findingFor cannot know).
    const slugOf = surfaceSlugMap();
    const withSlug = list => list.map(f => Object.assign({}, f, { slug: slugOf.get(f.id) || '' }));
    const tail = (() => {
      const shown = new Set(payload.map(f => f.id));
      const preCut = (outcome.dual && Array.isArray(outcome.dual.tail)) ? outcome.dual.tail : [];
      const rest = preCut.filter(s => s && s.id && !shown.has(s.id)).slice(0, 20);
      return toPayload(rest.map((s, i) => findingFor(s, payload.length + i + 1)));
    })();

    // The SECOND judge: the reasoning setting the reader did not pick, fired
    // beside the writer so the prose never waits for it. In fast mode that is the
    // thinking judge - the reader keeps the fast answer and the careful verdict
    // lands after, as information rather than as a delay. In deep mode the
    // binding judge is already the careful one and the second opinion is the
    // quick one, which cannot upgrade anything.
    //
    // The conservative verdict stands, but only when it comes from a judge at
    // least as reliable as the one that answered: a second refusal downgrades
    // the answer, a second 'answered' never turns a refusal into prose, and a
    // refusal from the QUICK judge never outvotes a careful one. Nothing here
    // replaces the answer - the reader may already have read it - so a
    // disagreement is annotated on top of it, as a downgrade or as a dissent.
    const secondReasoning = mode.second === undefined ? (modeName === 'fast' ? 'medium' : 'none') : mode.second;
    let secondJudge = null;
    let judgeDisagreement = false;
    let judgeDowngrade = false;
    let judgeDissentFrom = '';
    const emitSecond = () => {
      if (!secondJudge) return;
      // The reconciliation needs to know how hard each judge thought: a refusal
      // from the quick judge must not downgrade an answer the careful one wrote.
      const reconciled = reconcileVerdicts(
        Object.assign({}, judge, { reasoning: mode.reasoning }),
        Object.assign({}, secondJudge, { reasoning: secondReasoning }),
      );
      judgeDisagreement = reconciled.disagreement;
      judgeDowngrade = reconciled.downgrade;
      judgeDissentFrom = reconciled.dissenter;
      emit({ type: 'judge', judge: secondJudge, final: true, attempt: 0, second: true, reasoning: secondReasoning, elapsedMs: Date.now() - started });
      if (judgeDisagreement) {
        emit({
          type: 'reconcile',
          // 'downgrade' is the whole of task-16: true only when the dissenting
          // judge was at least as reliable as the binding one.
          downgrade: reconciled.downgrade,
          dissenter: reconciled.dissenter,
          conservative: reconciled.conservative,
          binding: { answered: judge ? judge.answered : null, confidence: (judge && judge.confidence) || '', reasoning: mode.reasoning },
          second: { answered: secondJudge.answered, confidence: secondJudge.confidence || '', reasoning: secondReasoning },
          elapsedMs: Date.now() - started,
        });
      }
    };

    // The trace is written after the answer exists, never in front of it: a
    // retention feature that can fail an answer is a worse bug than a lost trace.
    // On only when RULES_TRACES says so (src/rules-traces.mjs), and the
    // deployment sets it because the page carries the retention line the reader
    // is owed - `#retention`, rendered in both languages.
    const trace = (answerText, writer) => {
      if (!tracesEnabled()) return;
      try {
        appendTrace(buildTrace({
          id: traceId,
          at: new Date().toISOString(),
          edition: rulesEdition,
          corpusAt: corpusState().updated,
          mode: modeName,
          lang: lang || 'und',
          question,
          asked,
          terms,
          signals: traceSignals(question, findings),
          counts,
          findings,
          judge,
          judgeReasoning: mode.reasoning,
          judge2: secondJudge,
          judgeDisagreement,
          judgeDowngrade,
          judgeDissentFrom,
          card: card ? { id: card.id, name: card.name } : null,
          // The human override, recorded on the trace it belongs to: which
          // passages the reader kept, which the first answer had shown and were
          // dropped, and any the reader put back that the first answer had not
          // shown. `overrideOf` is the trace of the answer being overridden.
          override: override ? {
            kept: keepIds,
            dropped: shownIds.filter(id => keepIds.indexOf(id) === -1),
            added: keepIds.filter(id => shownIds.indexOf(id) === -1),
          } : null,
          overrideOf,
          answer: answerText,
          failed: writer && writer.failed,
          declined: writer && writer.declined,
          steps,
          elapsedMs: Date.now() - started,
          unresolved: outcome.unresolved,
          escalated: outcome.escalated,
          attempts: outcome.attempts,
        }));
      } catch (e) { /* a trace must never break an answer */ }
    };

    if (!findings.length) {
      trace('');
      const notes = ['nothing in the corpus matched that question'];
      const elapsedMs = Date.now() - started;
      if (stream) {
        emit({ type: 'findings', findings: [], counts, terms, steps, elapsedMs, notes });
        emit({ type: 'done', elapsedMs, steps, notes });
        return res.end();
      }
      return json(res, 200, { question, asked, lang: lang || 'und', translation: translation.translated || '', terms, card, findings: [], tail: withSlug(tail), traceId, judge, answer: '', steps, elapsedMs, notes });
    }

    // The second judge starts here, beside the writer, and is only awaited after
    // the answer has been sent. It starts after the empty-retrieval return above
    // so a question that matched nothing does not spend a call judging nothing.
    const secondRun = judgeCoverage(asked, outcome.findings, keys.fast, { reasoning: secondReasoning, lang: answerLang })
      .then(v => { secondJudge = v; })
      .catch(() => { /* a second opinion that never arrives leaves the first standing */ });

    // The judge has already run; the answer waits on it rather than racing it,
    // because whether to write one at all depends on its verdict.
    const DECLINED = WRITER_DECLINED;
    // The writer is OFF by default (writerEnabled): the findings, the judge, the
    // citations and the marks are the run's product, so the run ends here - no
    // answer event, no prose to wait for, and no answer segment on the bar (the
    // start event already left it out). The call below is kept, not deleted: its
    // format is going into the judge next.
    if (!writerOn) {
      await secondRun;
      emitSecond();
      trace('', {});
      const elapsedMs = Date.now() - started;
      if (stream) {
        emit({ type: 'done', elapsedMs, steps, unresolved: outcome.unresolved, escalated: outcome.escalated, disputed: judgeDowngrade });
        return res.end();
      }
      return json(res, 200, { question, asked, lang: lang || 'und', translation: translation.translated || '', terms, card, findings: withSlug(payload), tail: withSlug(tail), traceId, judge, judge2: secondJudge, judgeDisagreement, judgeDowngrade, judgeDissentFrom, answer: '', writer: false, counts, steps, elapsedMs, mode: modeName, unresolved: outcome.unresolved, escalated: outcome.escalated, attempts: outcome.attempts });
    }

    // The judge has already run; the answer waits on it rather than racing it,
    // cut at the timeout, or it comes back with nothing because its own reasoning
    // ate the budget. One path, one ending - the findings are already on the page
    // and they stay, so the answer card says the prose failed rather than waiting
    // forever, and the provider's raw string never reaches the reader.
    let writerFailed = '';
    let answer = '';
    try {
      answer = await timed('answer', () => (outcome.unresolved
        ? Promise.resolve(dontKnowAnswer(judge, lang))
        : compileFindings(asked, outcome.findings, keys.model, { lang: answerLang })));
    } catch (e) {
      writerFailed = 'timeout';
    }
    if (!writerFailed && !outcome.unresolved && !String(answer).trim()) writerFailed = 'empty';
    // The writer's refusal beats the judge's boolean. The judge once marked a
    // question answered on a passage it then quoted as NOT applying - 'answer:
    // true' with a why that argued against itself - and the writer, reading the
    // same findings, declined. When the two disagree the honest verdict is the
    // refusal, so the reader gets the statement of absence instead of a page
    // that says both things at once.
    let writerDeclined = false;
    if (!writerFailed && !outcome.unresolved && String(answer).trim() === DECLINED) {
      answer = dontKnowAnswer(judge, lang);
      outcome.unresolved = true;
      writerDeclined = true;
    }

    if (writerFailed) {
      const elapsedMs = Date.now() - started;
      if (stream) emit({ type: 'answer', answer: '', failed: true, elapsedMs });
      await secondRun;
      emitSecond();
      trace('', { failed: writerFailed });
      if (stream) {
        emit({ type: 'done', elapsedMs, steps, failed: true, unresolved: outcome.unresolved, escalated: outcome.escalated, disputed: judgeDowngrade });
        return res.end();
      }
      return json(res, 200, { question, asked, lang: lang || 'und', translation: translation.translated || '', terms, card, findings: withSlug(payload), tail: withSlug(tail), traceId, judge, judge2: secondJudge, judgeDisagreement, judgeDowngrade, judgeDissentFrom, answer: '', failed: writerFailed, counts, steps, elapsedMs, mode: modeName, unresolved: outcome.unresolved, escalated: outcome.escalated, attempts: outcome.attempts });
    }

    emit({ type: 'answer', answer, unresolved: outcome.unresolved, elapsedMs: Date.now() - started });

    // The revised verdict follows the answer it is about. The writer spent that
    // time deciding to decline, and the page credits every stage with the seconds
    // between one event and the next: a verdict emitted before its own answer
    // would put the writer's time on the judge's clock.
    if (writerDeclined) {
      emit({ type: 'judge', judge: Object.assign({}, judge, { answered: false, confidence: judge && judge.confidence, why: ((judge && judge.why) || '') + ' - the writer declined these findings' }), final: true, attempt: 0, elapsedMs: Date.now() - started });
    }

    // The second verdict lands after the prose, which is the whole point: the
    // reader keeps the fast answer and a later contradiction is information.
    await secondRun;
    emitSecond();

    trace(answer, { declined: writerDeclined });
    if (stream) {
      emit({ type: 'done', elapsedMs: Date.now() - started, steps, unresolved: outcome.unresolved, escalated: outcome.escalated, disputed: judgeDowngrade });
      return res.end();
    }
    return json(res, 200, {
      question, asked, lang: lang || 'und', translation: translation.translated || '', terms, card, findings: withSlug(payload), tail: withSlug(tail), traceId, judge, answer,
      judge2: secondJudge, judgeDisagreement, judgeDowngrade, judgeDissentFrom,
      counts, steps, elapsedMs: Date.now() - started, mode: modeName, writer: writerOn,
      unresolved: outcome.unresolved, escalated: outcome.escalated, attempts: outcome.attempts,
    });
  } catch (e) {
    if (stream) { emit({ type: 'error', message: String((e && e.message) || e) }); return res.end(); }
    const status = e instanceof RulesError ? e.status : 502;
    return fail(res, status, String((e && e.message) || e));
  }
}

// The index counts, next to the corpus counts, with the difference spelled out:
// 'ahead' means the namespace holds vectors the corpus does not have (a stale
// rebuild), 'behind' means the corpus has sections the index never saw.
async function vectorState() {
  if (VECTOR_BACKEND === 'local') return { backend: VECTOR_BACKEND };
  try {
    const state = corpusState();
    const info = await indexInfo();
    const ns = (info && info.namespaces) || {};
    const counts = {};
    for (const k of Object.keys(ns)) counts[k || '(default)'] = ns[k].vectorCount;
    const corpus = {};
    for (const [set, n] of Object.entries(state.sets || {})) corpus[set] = n;
    const out = { backend: VECTOR_BACKEND, indexType: info && info.indexType, model: info && info.denseIndex && info.denseIndex.embeddingModel, counts, corpus };
    out.ahead = Object.entries(corpus).filter(([k, n]) => (counts[k] || 0) > n).map(([k, n]) => k + ' +' + ((counts[k] || 0) - n));
    out.behind = Object.entries(corpus).filter(([k, n]) => (counts[k] || 0) < n).map(([k, n]) => k + ' -' + (n - (counts[k] || 0)));
    return out;
  } catch (e) { return { backend: VECTOR_BACKEND, error: String((e && e.message) || e) }; }
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); }
  catch { return fail(res, 400, 'bad request line'); }
  // send() reads the request through this: Accept-Encoding decides the encoding,
  // If-None-Match decides whether the body goes out at all. Attached here, once,
  // rather than threaded through every one of send's call sites.
  REQ_OF.set(res, req);

  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    return send(res, 200, readIndex(), 'text/html; charset=utf-8');
  }
  // The card's stylesheet, the same string the wiki render writes beside its pages
  // (CARD_CSS in src/wiki-cards.mjs). One source, two consumers: a record page
  // links card.css relatively, the ask page's dialog links /card.css here.
  if (req.method === 'GET' && u.pathname === '/card.css') {
    return send(res, 200, CARD_CSS, 'text/css; charset=utf-8');
  }
  // The brand icon: the 32x32 PNG the tab asks for (as /favicon.png and as the
  // /favicon.ico a browser requests on its own) and the 180x180 home-screen icon.
  // Both are read at boot; both fall back to the inline ICO; both cache a week.
  if (req.method === 'GET' && (u.pathname === '/favicon.ico' || u.pathname === '/favicon.png')) {
    return send(res, 200, ICON_32 || ICON, 'image/png', { maxAge: 'public, max-age=604800' });
  }
  if (req.method === 'GET' && u.pathname === '/apple-touch-icon.png') {
    return send(res, 200, ICON_180 || ICON_32 || ICON, 'image/png', { maxAge: 'public, max-age=604800' });
  }
  if (req.method === 'GET' && u.pathname === '/rules') {
    // task-95: the two client assets are named with a content stamp, so a page load can
    // never run a client older than the server that served it. A stale tab cost Mandal
    // three reports of a defect already fixed here.
    try {
      const v = assetStamp();
      const html = readRules()
        .replace('/rules/surface.css"', '/rules/surface.css?v=' + v + '"')
        .replace('/rules/surface.js"', '/rules/surface.js?v=' + v + '"');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    catch (e) { return fail(res, 500, 'rules.html could not be read: ' + String((e && e.message) || e)); }
  }
  // The slice-2 dev route: the new surface beside the old one. It reads the baked
  // payloads from workspace/wiki-data and serves the two real client files.
  if (req.method === 'GET' && u.pathname === '/rules/dev') {
    try { return send(res, 200, surfacePage(), 'text/html; charset=utf-8'); }
    catch (e) { return fail(res, 500, 'the surface could not be read: ' + String((e && e.message) || e)); }
  }
  // The surface's two files, on their stable product paths. /rules/dev/surface.*
  // is kept as an alias so the dev page and old links keep working.
  if (req.method === 'GET' && (u.pathname === '/rules/surface.js' || u.pathname === '/rules/surface.css' || u.pathname.indexOf('/rules/dev/surface.') === 0)) {
    try {
      const name = u.pathname.slice(u.pathname.lastIndexOf('/') + 1);
      const asset = surfaceAsset(name);
      if (!asset) return fail(res, 404, 'no such surface file: ' + u.pathname);
      return send(res, 200, asset.body, asset.type);
    } catch (e) { return fail(res, 500, 'the surface file could not be read: ' + String((e && e.message) || e)); }
  }
  if (req.method === 'GET' && u.pathname.indexOf('/rules/data/') === 0) return handleSurfaceData(req, res, u);
  if (req.method === 'GET' && u.pathname === '/health') {
    const a = archiveIndex();
    return json(res, 200, {
      ok: true,
      archived: a.events.length,
      checked: (a.checked || []).length,
      archiveError: archiveError || undefined,
      // Which halves of the rules page this machine can run, so a missing key
      // is visible before a question is asked rather than after it fails.
      rules: rulesKeyState(),
      // What the model route actually did since this process started: calls, empty
      // bodies, retries and how many retries landed. The free route returns empty
      // bodies under load, so a page that looks like one call per step may be
      // making two - this is where a deployment sees it.
      route: routeStats(),
      // Which edition the page answers for. It is a deployment decision, not a
      // detail: 10th and 11th give different answers to the same question.
      rulesEdition: rulesEdition,
      rulesEditionLabel: rulesEditionLabel,
      // What the page actually searches, replacing the old page-count that
      // described the crawl the corpus replaced.
      // When our copy of the rules was last built, and how much of it there is.
      // This is the date a reader can act on - ours, rather than a guess at
      // whether somebody else's site is behind.
      corpus: (function () {
        try {
          const state = corpusState();
          const c = corpora();
          const out = {
            rules: c.rules.length,
            factions: c.factions.length,
            updated: state.updated,
            sourceDate: state.sourceDate,
            edition: state.edition,
          };
          return out;
        } catch (e) { return { error: String((e && e.message) || e) }; }
      })(),
      // What the vector index holds against what is on disk. A vector leg that
      // returns nothing looks exactly like a question whose answer is not there,
      // so the one place a half-landed rebuild, a stale id or a query against the
      // wrong namespace becomes visible is here.
      vectors: await vectorState(),
    });
  }
  // The diagnostics surface: read-only, for us, not linked from the reader's nav.
  // It renders what /health publishes plus the render and rebuild facts a stale
  // deployment hides, against the DELIVERED set.
  if (req.method === 'GET' && u.pathname === '/dev') {
    try {
      const state = await devState({ bootedAt: SERVER_BOOTED });
      return send(res, 200, devHtml(state), 'text/html; charset=utf-8', { cache: 'no-store' });
    } catch (e) { return fail(res, 500, 'dev report failed: ' + String((e && e.message) || e)); }
  }
  if (req.method === 'GET' && u.pathname === '/events') return handleEvents(req, res, u);
  if (req.method === 'GET' && u.pathname === '/my-events') return handleMyEvents(req, res);
  if (req.method === 'POST' && u.pathname === '/login') return handleLogin(req, res);
  if (req.method === 'POST' && u.pathname === '/parse') return handleParse(req, res);
  if (req.method === 'POST' && u.pathname === '/parse-file') return handleParseFile(req, res, u);
  if (req.method === 'POST' && u.pathname === '/parse-list') return handleParseList(req, res, u);
  if (req.method === 'POST' && u.pathname === '/feedback') return handleFeedback(req, res);
  if (req.method === 'POST' && u.pathname === '/rules/ask') return handleRulesAsk(req, res);
  if (req.method === 'POST' && u.pathname === '/rules/vote') return handleRulesVote(req, res);
  if (req.method === 'POST' && u.pathname === '/rules/answered') return handleRulesAnswered(req, res);
  if (req.method === 'POST' && u.pathname === '/rules/labels') return handleRulesLabels(req, res);
  if (req.method === 'GET' && u.pathname === '/rules/record') return handleRulesRecord(req, res, u);
  if ((req.method === 'GET' || req.method === 'HEAD') && u.pathname === '/rules/asset') return handleRulesAsset(req, res, u);
  if (req.method === 'GET' && u.pathname === '/rules/lookup') return handleRulesLookup(req, res, u);
  if (req.method === 'GET' && u.pathname === '/rules/find') return handleRulesFind(req, res, u);
  return fail(res, 404, 'not found: ' + u.pathname);
});

server.on('clientError', (err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// Fill the catalogue before anyone asks for it. The sitemap costs about 9s and
// the checks behind it cost far more, so starting at boot means the first click
// on Browse reads a cache instead of waiting on a cold scan. Fire and forget:
// a failure here costs the scan, not the server.
const archived = archiveIndex();
const archivedKeys = new Set(archived.events.map(e => e.key));
getAllEvents()
  .then((all) => runScan(withinWindow(all).filter(e => !archivedKeys.has(eventKey(e.type, e.slug)))))
  .catch(() => {});

server.listen(port, host, () => {
  console.log('MHQ army-lists UI   http://' + host + ':' + port);
  console.log('POST /parse {"url":"<army-lists url>"}');
  console.log('POST /parse-file?name=<file>   (body: a saved page)');
  console.log('GET  /events?limit=80&type=team');
  const keys = rulesKeyState();
  console.log('GET  /rules    then POST /rules/ask {question, engine}');
  console.log('Rules keys: tinyfish ' + (keys.tinyfish ? 'ok' : 'MISSING') +
    ', jev ' + (keys.jev ? 'ok' : 'MISSING') +
    ', writer ' + (keys.model ? 'ok' : 'MISSING') + ' (' + keys.modelName + ')' +
    ', fast ' + (keys.fast ? 'ok' : 'MISSING') + ' (' + keys.fastName + ')' +
    ' | edition ' + rulesEdition + ' (' + rulesEditionLabel + ')');
  console.log('POST /feedback {title?,body}  -> ' + (GITHUB_TOKEN
    ? 'files an issue on ' + FEEDBACK_REPO
    : 'returns a prefilled github.com/' + FEEDBACK_REPO + '/issues/new link (set GITHUB_TOKEN to file directly)'));
  console.log('Archive: ' + archived.events.length + ' closed event(s)' + (archiveError ? ' - UNAVAILABLE: ' + archiveError : ''));
});
