/* task-38: the offline SHELL. Scope (a) of the card, and the numbers chose it: the shell
 * is about 90 KB gzipped (the page, this client, the stylesheet), where the whole wiki -
 * every book's payload, 27 files - is about 1.65 MB gzipped and nearly 12 MB raw. A shell
 * that works offline costs every reader one page load; a whole-wiki download is a decision
 * a reader opts into, and it belongs to a later card with a progress bar and a way to
 * clear it.
 *
 * WHAT WORKS OFFLINE (measured in a browser with the network disabled, see the report):
 *   the page loads, the wiki drawer opens, and the tree of any book whose branch payload
 *   was already fetched renders; a record already opened renders from cache.
 * WHAT DOES NOT, and it says so rather than failing silently:
 *   the agent (POST /rules/ask), the drawer's search (the server greps its index), and any
 *   book not already fetched.
 *
 * THE TWO RULES THAT MATTER:
 *   1. The cache is NAMED WITH THE DEPLOY'S ASSET STAMP, so a deploy is a new cache and the
 *      old one is deleted. A reader can never be served yesterday's client, and a version
 *      mismatch cannot half-work: one name, one deploy.
 *   2. NOTHING about a record is cached. /rules/data carries the tree and the record TEXT,
 *      and it is served stale-while-revalidate - the fresh copy wins whenever the network
 *      answers, and the cache is only a fallback. A record the corpus no longer has cannot
 *      be offered from this cache, because the branch payload that would offer it is
 *      refreshed from the network first. The /rules/ask answer is never cached at all.
 */
'use strict';
// __STAMP__ is replaced with the deploy's asset stamp when the worker is served (see
// surfaceAsset). The literal below is what a checkout that never ran the server sees.
var STAMP = '__STAMP__';
var CACHE = 'mhq-rules-' + STAMP;
// The shell: fetched network-first so a fresh deploy wins the moment it is reachable, and
// the cache is the offline fallback only.
var SHELL = ['/rules', '/rules/surface.js', '/rules/surface.css'];
// Data is stale-while-revalidate: the network copy always wins when it answers.
var DATA_PREFIX = '/rules/data';

self.addEventListener('install', function (e) {
  // Nothing is pre-fetched: the reader's own first visit populates the cache, and a
  // pre-fetch would download the shell a second time on every install.
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    var names = await caches.keys();
    // One cache per deploy stamp: everything else is a previous deploy.
    await Promise.all(names.map(function (n) { return n.indexOf('mhq-rules-') === 0 && n !== CACHE ? caches.delete(n) : null; }));
    if (self.registration && self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (err) { /* not supported */ }
    }
    await self.clients.claim();
  })());
});

function isShell(url) {
  return SHELL.indexOf(url.pathname) !== -1;
}

// Network first, cache as the fallback. A response that is not ok is never cached: an error
// page must not become the page.
async function networkFirst(request) {
  var cache = await caches.open(CACHE);
  try {
    var res = await fetch(request);
    if (res && res.ok && request.method === 'GET') cache.put(request, res.clone());
    return res;
  } catch (e) {
    var hit = await cache.match(request, { ignoreSearch: false });
    if (hit) return hit;
    hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

// Stale-while-revalidate: answer from the cache when there is one, refresh in the
// background, and fall through to the network when there is not. The fresh copy replaces
// the cached one, so the next offline visit is yesterday's corpus at the oldest.
async function staleWhileRevalidate(request) {
  var cache = await caches.open(CACHE);
  var hit = await cache.match(request, { ignoreSearch: false });
  var fetching = fetch(request).then(function (res) {
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  }).catch(function () { return null; });
  if (hit) return hit;
  var res = await fetching;
  if (res) return res;
  throw new Error('offline and not cached: ' + request.url);
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return; // never cache a POST: the ask is not a document
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  // The ask and the drawer's search are server work; offline they fail, and the caller
  // says so. Caching them would be caching an answer.
  if (url.pathname.indexOf('/rules/ask') === 0 || url.pathname.indexOf('/rules/find') === 0 || url.pathname.indexOf('/rules/lookup') === 0) return;
  if (isShell(url)) { e.respondWith(networkFirst(req)); return; }
  if (url.pathname.indexOf(DATA_PREFIX) === 0) { e.respondWith(staleWhileRevalidate(req)); return; }
  // The record bodies (/rules/record) are the same rule as the data: fresh wins, cache is
  // the fallback. They carry one record's rendered HTML, never a list.
  if (url.pathname.indexOf('/rules/record') === 0) { e.respondWith(staleWhileRevalidate(req)); return; }
});