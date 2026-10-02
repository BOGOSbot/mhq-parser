#!/usr/bin/env node
'use strict';
/**
 * MHQ Army Lists - local web UI for parse.mjs.
 *
 *   node server.mjs [--port 8787] [--host 127.0.0.1]
 *
 * Endpoints:
 *   GET  /          serves index.html
 *   GET  /health    { ok: true }
 *   GET  /events    recent tournaments, for the picker in index.html
 *   POST /login     { username, password } -> { cookie }  obtain a session
 *   GET  /my-events tournaments the caller organises (X-MHQ-Cookie header)
 *   POST /parse     { url } -> { event, count, players, miniText, elapsedMs }
 *   POST /parse-file?name=<file>  body: a saved page -> same shape as /parse
 *
 * The browser cannot fetch miniheadquarters.com directly (no CORS headers), so
 * every parse happens here and the UI only renders. Stdlib only, no deps.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { URL_RE, checkEvent, clearEventCache, getAllEvents, getMeta, playerWarnings, parseHtml, parseUrl, totals, loginSession, listOrganizedTournaments } from './parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, 'index.html');
// Read per request rather than at startup, so editing index.html does not
// require a server restart. It is a single small file and the response is no-store.
function readIndex() {
  return fs.readFileSync(INDEX_PATH, 'utf8');
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

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj));
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
  return { ...p, meta: meta, totals: totals(p), warnings: playerWarnings(p, meta) };
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
  }
  if (u.searchParams.get('clear') === '1') {
    clearEventCache();
    filterCache = new Map();
    filterScan = null;
  }
  if (u.searchParams.get('clear') === '1') {
    return json(res, 200, { events: [], count: 0, scanned: 0, total: 0, done: true, cleared: true, windowDays: FILTER_WINDOW_DAYS });
  }
  try {
    // The window is applied once, here, and the subset is what the scan, the
    // progress report and the result list all see. That keeps "done" reachable:
    // out-of-window events are never scanned, so counting them against a target
    // would mean the scan can never finish.
    const all = await getAllEvents();
    const windowed = withinWindow(all);
    lastWindowed = windowed;
    runScan(windowed); // fire and forget: the scan drains the queue on its own
    const progress = scanProgress(windowed);
    const fl = filteredList(windowed, limit);
    return json(res, 200, {
      events: fl,
      count: fl.length,
      scanned: progress.scanned,
      total: progress.total,
      done: progress.done,
      windowDays: FILTER_WINDOW_DAYS,
    });
  } catch (e) {
    // The catalogue could not be read. If we have one from a moment ago, hand
    // it back with the error attached rather than emptying the picker: a
    // throttled origin should cost a stale list, not a blank panel and an
    // error where the numbers should be.
    if (lastWindowed && lastWindowed.length) {
      return json(res, 200, {
        events: filteredList(lastWindowed, limit),
        count: filteredList(lastWindowed, limit).length,
        scanned: scanProgress(lastWindowed).scanned,
        total: scanProgress(lastWindowed).total,
        done: false,
        stale: true,
        error: String((e && e.message) || e),
        windowDays: FILTER_WINDOW_DAYS,
      });
    }
    return json(res, 502, { error: String((e && e.message) || e) });
  }
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); }
  catch { return fail(res, 400, 'bad request line'); }

  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    return send(res, 200, readIndex(), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && u.pathname === '/events') return handleEvents(req, res, u);
  if (req.method === 'GET' && u.pathname === '/my-events') return handleMyEvents(req, res);
  if (req.method === 'POST' && u.pathname === '/login') return handleLogin(req, res);
  if (req.method === 'POST' && u.pathname === '/parse') return handleParse(req, res);
  if (req.method === 'POST' && u.pathname === '/parse-file') return handleParseFile(req, res, u);
  return fail(res, 404, 'not found: ' + u.pathname);
});

server.on('clientError', (err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// Fill the catalogue before anyone asks for it. The sitemap costs about 9s and
// the checks behind it cost far more, so starting at boot means the first click
// on Browse reads a cache instead of waiting on a cold scan. Fire and forget:
// a failure here costs the scan, not the server.
getAllEvents()
  .then((all) => runScan(withinWindow(all)))
  .catch(() => {});

server.listen(port, host, () => {
  console.log('MHQ army-lists UI   http://' + host + ':' + port);
  console.log('POST /parse {"url":"<army-lists url>"}');
  console.log('POST /parse-file?name=<file>   (body: a saved page)');
  console.log('GET  /events?limit=80&type=team');
});
