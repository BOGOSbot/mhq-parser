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
 * THREE RULES, and they are what keeps a cache from lying:
 *   1. The cache is NAMED WITH THE DEPLOY'S STAMP - the shell's stamp AND the payload's.
 *      Either one changing makes a new cache, and activate deletes the others. A corpus
 *      re-bake that leaves every client file alone still invalidates the cache.
 *   2. THE NETWORK ANSWERS FIRST, ALWAYS. The shell, /rules/data and /rules/record are all
 *      fetched before the cache is consulted; the cache answers only when the fetch failed.
 *      So what a reader can be served from it is at most one deploy old and only while
 *      offline - never yesterday's tree in front of a live corpus.
 *   3. An ANSWER is never cached. /rules/ask, /rules/find and /rules/lookup are not
 *      intercepted at all, and a non-ok response is never stored - so a record the corpus
 *      has dropped cannot come back as a cached page.
 */
'use strict';
// __STAMP__ is replaced when the worker is served with the SHELL stamp, a hyphen, and the
// PAYLOAD stamp (workerStamp in wiki-surface.mjs). The literal below is what a checkout that
// never ran the server sees.
var STAMP = '__STAMP__';
var CACHE = 'mhq-rules-' + STAMP;
// The shell: fetched network-first so a fresh deploy wins the moment it is reachable, and
// the cache is the offline fallback only.
var SHELL = ['/rules', '/rules/surface.js', '/rules/surface.css'];
// Data is network-first with the cache as the offline fallback: see networkFirstWithCache.
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
// DATA IS NETWORK-FIRST WITH THE CACHE AS A FALLBACK, and it is NOT stale-while-revalidate.
// SWR would be faster - answer from the cache at once, refresh behind it - and it would
// serve a reader yesterday's tree and yesterday's record body for one load after a deploy,
// including a record the corpus no longer has. The card's rule is that the cache is only a
// fallback, so the network is asked first and the cache answers only when it cannot: offline,
// or the request failed. What the cache can hold is therefore at most one deploy old, and it
// is only ever READ when the network did not answer.
async function networkFirstWithCache(request) {
  var cache = await caches.open(CACHE);
  try {
    var res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    var hit = await cache.match(request, { ignoreSearch: false });
    if (hit) return hit;
    hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
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
  if (url.pathname.indexOf(DATA_PREFIX) === 0) { e.respondWith(networkFirstWithCache(req)); return; }
  // The record bodies (/rules/record) are the same rule as the data, and the same function:
  // the network answers first and the cache is only the offline fallback. They carry one
  // record's rendered HTML, never a list.
  if (url.pathname.indexOf('/rules/record') === 0) { e.respondWith(networkFirstWithCache(req)); return; }
});