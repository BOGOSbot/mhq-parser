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
 *   GET  /session   { loggedIn, username, remember }  current stored session
 *   POST /login     { username, password, remember }  log in to miniheadquarters.com
 *   POST /logout    clear the stored session and credentials
 *   POST /parse     { url } -> { event, count, players, miniText, elapsedMs }
 *
 * The browser cannot fetch miniheadquarters.com directly (no CORS headers), so
 * every parse happens here and the UI only renders. Stdlib only, no deps.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { URL_RE, checkEvent, getAllEvents, getMeta, listEvents, playerWarnings, parseUrl, totals, loginSession } from './parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, 'index.html');
// Read per request rather than at startup, so editing index.html does not
// require a server restart. It is a single small file and the response is no-store.
function readIndex() {
  return fs.readFileSync(INDEX_PATH, 'utf8');
}

// --- session auth ------------------------------------------------------
// The browser never holds a miniheadquarters.com session: it would be cross-origin
// junk and it would mean the cookie sits in localStorage. The server logs in
// itself and keeps the result here, plus in .secrets/ (gitignored) so a restart
// does not log you out. Passwords are only kept when the user ticks "remember".
import { spawnSync } from 'child_process';
const AUTH_FILE = path.join(__dirname, '.secrets', 'mhq-auth.json');
const auth = { cookie: null, username: null, password: null, remember: false };

function loadAuth() {
  try {
    const a = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (typeof a.cookie === 'string' && a.cookie) auth.cookie = a.cookie;
    if (a.remember && typeof a.username === 'string' && typeof a.password === 'string') {
      auth.username = a.username; auth.password = a.password; auth.remember = true;
    }
  } catch {}
}

function saveAuth() {
  const out = { cookie: auth.cookie, remember: !!auth.remember };
  if (auth.remember) { out.username = auth.username; out.password = auth.password; }
  try {
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(out, null, 2));
    return true;
  } catch { return false; }
}

// True when .gitignore keeps .secrets out of the repository, null when this is
// not a git checkout so nothing can be verified. A false here is worth a warning.
function authGitIgnored() {
  try {
    return spawnSync('git', ['check-ignore', '-q', AUTH_FILE], { cwd: __dirname }).status === 0;
  } catch { return null; }
}

function sessionInfo() {
  return {
    loggedIn: !!auth.cookie,
    username: auth.remember ? auth.username : null,
    remember: !!auth.remember,
    gitIgnored: authGitIgnored(),
  };
}

function logout() {
  auth.cookie = null; auth.username = null; auth.password = null; auth.remember = false;
  try { fs.unlinkSync(AUTH_FILE); } catch {}
}

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
    auth.cookie = r.cookie; auth.username = u;
    auth.password = body.remember ? p : null;
    auth.remember = !!body.remember;
    saveAuth();
    return json(res, 200, { ...sessionInfo(), gitIgnored: authGitIgnored(), redirect: r.redirect });
  } catch (e) {
    return json(res, 502, { error: 'login request failed: ' + String((e && e.message) || e) });
  }
}

// --- event filtering ---------------------------------------------------
// The sitemap lists every tournament regardless of game or whether its army
// lists are published. The details page carries both facts, so we check each
// one in the background and hand the UI only what is both Warhammer 40,000 and
// has lists out. Results are cached for an hour.
const FILTER_TTL_MS = 60 * 60 * 1000;
const FILTER_CONCURRENCY = 8;
let filterCache = new Map(); // detailsUrl -> { game, hasLists, at }
let filterScan = null;       // running scan promise, or null

function is40k(game) {
  return /warhammer\s*40/i.test(game || '');
}

async function runScan(events) {
  if (filterScan) return filterScan;
  filterScan = (async () => {
    const toCheck = events.filter(e => {
      const c = filterCache.get(e.detailsUrl);
      return !c || Date.now() - c.at > FILTER_TTL_MS;
    });
    const queue = toCheck.slice();
    const workers = [];
    const n = Math.min(FILTER_CONCURRENCY, queue.length || 1);
    for (let i = 0; i < n; i++) {
      workers.push((async () => {
        while (queue.length) {
          const e = queue.shift();
          try {
            const r = await checkEvent(e.detailsUrl);
            filterCache.set(e.detailsUrl, { ...r, at: Date.now() });
          } catch {
            filterCache.set(e.detailsUrl, { game: null, hasLists: false, at: Date.now() });
          }
        }
      })());
    }
    await Promise.all(workers);
    filterScan = null;
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

function filteredList(events, limit) {
  const out = [];
  for (const e of events) {
    const c = filterCache.get(e.detailsUrl);
    if (c && is40k(c.game) && c.hasLists) out.push({ ...e, listCount: c.listCount || 0 });
    if (out.length >= limit) break;
  }
  return out;
}

// --port / --host, with PORT / HOST env vars as fallback.
const argv = process.argv.slice(2);
let port = Number(process.env.PORT) || 8787;
let host = process.env.HOST || '127.0.0.1';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') port = Number(argv[++i]);
  else if (argv[i] === '--host') host = argv[++i];
  else if (argv[i].startsWith('--port=')) port = Number(argv[i].slice(7));
  else if (argv[i].startsWith('--host=')) host = argv[i].slice(7);
}
if (!Number.isFinite(port) || port <= 0) {
  console.error('Error: --port must be a positive integer');
  process.exit(1);
}

const MAX_BODY = 64 * 1024;

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
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

// Fetch an event, attaching whatever session is available, and refreshing it
// once if the stored one has gone stale. A cookie pasted by hand always wins
// and is never refreshed over, since that is an explicit override.
async function parseWithSession(target, explicitCookie) {
  let cookie = explicitCookie
    || (typeof auth.cookie === 'string' && auth.cookie)
    || (typeof process.env.MHQ_COOKIE === 'string' && process.env.MHQ_COOKIE)
    || null;
  let refreshed = false;
  for (;;) {
    try {
      const { output, miniText } = await parseUrl(target, { cookie });
      return { ok: true, output, miniText, refreshed };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/authentication required/.test(msg)) {
        if (!explicitCookie && auth.username && auth.password) {
          const r = await loginSession(auth.username, auth.password);
          if (r.ok) {
            auth.cookie = r.cookie; saveAuth(); cookie = r.cookie;
            refreshed = true; continue;
          }
          // Cached password no longer works; drop it so the UI asks for a login.
          auth.cookie = null; auth.password = null; auth.remember = false; saveAuth();
        }
        return { ok: false, status: 401, error: msg, auth: true };
      }
      if (/no army lists found/.test(msg)) return { ok: false, status: 404, error: msg };
      return { ok: false, status: /HTTP \d{3}/.test(msg) ? 502 : 500, error: msg };
    }
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
      'or the organiser form https://miniheadquarters.com/tournaments/<type>/administrate/<slug>/(army-lists|details))');
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
  const wantFilter = u.searchParams.get('filter') === '1';
  try {
    if (wantFilter) {
      const all = await getAllEvents();
      runScan(all); // fire and forget: the scan fills the cache in the background
      const fl = filteredList(all, limit);
      return json(res, 200, {
        events: fl,
        count: fl.length,
        scanned: scanProgress(all).scanned,
        total: all.length,
        done: scanProgress(all).done,
      });
    }
    return json(res, 200, await listEvents({ limit, type: u.searchParams.get('type') || null }));
  } catch (e) {
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
  if (req.method === 'GET' && u.pathname === '/session') return json(res, 200, sessionInfo());
  if (req.method === 'POST' && u.pathname === '/login') return handleLogin(req, res);
  if (req.method === 'POST' && u.pathname === '/logout') { logout(); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && u.pathname === '/parse') return handleParse(req, res);
  return fail(res, 404, 'not found: ' + u.pathname);
});

server.on('clientError', (err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

loadAuth();
server.listen(port, host, () => {
  console.log('MHQ army-lists UI   http://' + host + ':' + port);
  console.log('POST /parse {"url":"<army-lists url>"}');
  console.log('GET  /events?limit=80&type=team');
});
