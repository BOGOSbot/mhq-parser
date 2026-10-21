// task-38: the offline SHELL, and the two rules that keep it from lying.
//
// 1. VERSIONED WITH THE DEPLOY. The service worker is served as an asset, so the deploy's
//    asset stamp is substituted INTO its bytes (the cache name) and into the URL the page
//    registers. That matters twice: a worker whose bytes change must be updated by the
//    browser, and a cache named with the stamp means one cache per deploy, with the old one
//    deleted on activate. A reader can never be served yesterday's client, and a deploy
//    cannot half-apply.
// 2. NOTHING ABOUT A RECORD IS CACHED AS AN ANSWER. The routes the worker touches are
//    network-first (the shell) or stale-while-revalidate (the tree, the branch payloads, a
//    record body) - the fresh copy always wins when the network answers. /rules/ask,
//    /rules/find and /rules/lookup are NOT intercepted at all, because an answer is not a
//    document. A record the corpus no longer has cannot be offered from this cache: the
//    payload that would list it is refreshed from the network first, and a non-ok response
//    is never stored.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetStamp, surfaceAsset } from '../src/wiki-surface.mjs';

const N = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => { const same = JSON.stringify(got) === JSON.stringify(want); if (same) pass++; else { fail++; console.log('FAIL ' + name + N + '  got : ' + JSON.stringify(got) + N + '  want: ' + JSON.stringify(want)); } };
const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(here, '..', 'src', 'rules.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(here, '..', 'src', 'server.mjs'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(here, '..', 'src', 'wiki-surface-sw.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(here, '..', 'src', 'wiki-surface.js'), 'utf8');

const stamp = assetStamp();
ok('the stamp is a content hash', /^[0-9a-f]{10}$/.test(stamp));
const sw = surfaceAsset('surface-sw.js');
ok('the worker is served as an asset', !!(sw && sw.body));
ok('its cache name carries the deploy stamp', sw.body.indexOf("var STAMP = '" + stamp + "'") !== -1);
ok('and the template literal is gone from what is served', sw.body.indexOf('__STAMP__') === -1);
ok('the source file still carries the template', SW_SRC.indexOf("var STAMP = '__STAMP__'") !== -1);
ok('the one cache name is derived from it', /var CACHE = 'mhq-rules-' \+ STAMP;/.test(SW_SRC));
ok('activate deletes every other mhq-rules cache', /caches\.keys\(\)/.test(SW_SRC) && /caches\.delete\(n\)/.test(SW_SRC));
ok('the server allows the worker its scope', /'Service-Worker-Allowed': '\/rules'/.test(SERVER));
ok('the worker is served on the asset route', SERVER.indexOf("u.pathname === '/rules/surface-sw.js'") !== -1);
ok('the page registers it with the stamp', PAGE.indexOf("navigator.serviceWorker.register('/rules/surface-sw.js?v=__STAMP__'") !== -1);
ok('and the server fills that stamp in', /\.replace\('__STAMP__', v\)/.test(SERVER));
ok('registration failure is silent, never fatal', /catch\(function \(\) \{ \/\* no offline shell/.test(PAGE));

ok('the ask is never intercepted', SW_SRC.indexOf("'/rules/ask'") !== -1);
ok('nor the drawer\'s search', SW_SRC.indexOf("'/rules/find'") !== -1);
ok('nor the lookup', SW_SRC.indexOf("'/rules/lookup'") !== -1);
ok('a non-GET is never cached', /if \(req\.method !== 'GET'\) return;/.test(SW_SRC));
ok('a non-ok response is never stored', /if \(res && res\.ok && request\.method === 'GET'\) cache\.put/.test(SW_SRC) && /if \(res && res\.ok\) cache\.put/.test(SW_SRC));
ok('the shell is network-first', /function networkFirst/.test(SW_SRC) && /if \(isShell\(url\)\) \{ e\.respondWith\(networkFirst\(req\)\); return; \}/.test(SW_SRC));
ok('the data is stale-while-revalidate', /function staleWhileRevalidate/.test(SW_SRC) && /url\.pathname\.indexOf\(DATA_PREFIX\) === 0/.test(SW_SRC));
ok('and so is a record body', /url\.pathname\.indexOf\('\/rules\/record'\) === 0/.test(SW_SRC));

ok('the drawer reports offline instead of showing nothing', /function offlineNote/.test(CLIENT) && /sv-offline/.test(CLIENT));
ok('the book list failing says so', /the list of books could not be loaded/.test(CLIENT));
ok('and a book never downloaded says so', /this book has not been downloaded yet/.test(CLIENT));
ok('both offer a retry', /sv-offline-again/.test(CLIENT) && /Try again/.test(CLIENT));
ok('the offline note is styled', /sv-offline-again\{/.test(fs.readFileSync(path.join(here, '..', 'src', 'wiki-surface.css'), 'utf8')));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
