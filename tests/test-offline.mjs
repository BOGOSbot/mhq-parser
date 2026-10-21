// task-38 + task-80: the offline SHELL, and the rules that keep a cache from lying.
//
// 1. VERSIONED WITH THE DEPLOY, SHELL AND PAYLOAD TOGETHER. The worker is served as an
//    asset, so the deploy's stamps are substituted INTO its bytes and into the URL the page
//    registers; the cache is named mhq-rules-<shell>-<payload>. A shell change makes a new
//    cache and so does a payload change, because a cache named only after the client would
//    survive a corpus re-bake and serve a record the corpus has dropped. The page's ?v= stays
//    the SHELL stamp alone, so a payload-only deploy does not re-download a client that did
//    not change.
// 2. THE NETWORK ANSWERS FIRST. The shell, /rules/data and /rules/record are all fetched
//    before the cache is consulted; the cache answers only when the fetch failed. There is no
//    stale-while-revalidate anywhere: SWR would serve one load of yesterday's tree in front
//    of a live corpus, which is what the card forbids. What the cache holds is at most one
//    deploy old, and it is read only while offline.
// 3. AN ANSWER IS NEVER CACHED. /rules/ask, /rules/find and /rules/lookup are not
//    intercepted at all, and a non-ok response is never stored - so a 404 for a record the
//    corpus has dropped cannot come back as a cached page.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assetStamp, dataStamp, surfaceAsset, workerStamp } from '../src/wiki-surface.mjs';

const N = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(here, '..', 'src', 'rules.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(here, '..', 'src', 'server.mjs'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(here, '..', 'src', 'wiki-surface-sw.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(here, '..', 'src', 'wiki-surface.js'), 'utf8');

const stamp = assetStamp();
ok('the shell stamp is a content hash', /^[0-9a-f]{10}$/.test(stamp));
ok('the payload stamp is a short hash too', /^[0-9a-f]{8}$/.test(dataStamp()));
ok('the worker stamp is the pair', workerStamp() === stamp + '-' + dataStamp());
const sw = surfaceAsset('surface-sw.js');
ok('the worker is served as an asset', !!(sw && sw.body));
ok('its cache name carries the pair', sw.body.indexOf("var STAMP = '" + workerStamp() + "'") !== -1);
ok('and the template literal is gone from what is served', sw.body.indexOf('__STAMP__') === -1);
ok('the source file still carries the template', SW_SRC.indexOf("var STAMP = '__STAMP__'") !== -1);
ok('the one cache name is derived from it', /var CACHE = 'mhq-rules-' \+ STAMP;/.test(SW_SRC));
ok('activate deletes every other mhq-rules cache', /caches\.keys\(\)/.test(SW_SRC) && /caches\.delete\(n\)/.test(SW_SRC));
ok('the server allows the worker its scope', /'Service-Worker-Allowed': '\/rules'/.test(SERVER));
ok('the worker is served on the asset route', SERVER.indexOf("u.pathname === '/rules/surface-sw.js'") !== -1);
ok('the page registers it with the worker stamp', PAGE.indexOf("navigator.serviceWorker.register('/rules/surface-sw.js?v=__WORKER_STAMP__'") !== -1);
ok('and the server fills that stamp in', /\.replace\('__WORKER_STAMP__', workerStamp\(\)\)/.test(SERVER));
ok('the page assets keep the SHELL stamp, not the pair', /\.replace\('\/rules\/surface\.js"', '\/rules\/surface\.js\?v=' \+ v \+ '"'/.test(SERVER));
ok('the two stamps are visible on /health', /stamp: assetStamp\(\)/.test(SERVER) && /payloadStamp: dataStamp\(\)/.test(SERVER));
ok('registration failure is silent, never fatal', /catch\(function \(\) \{ \/\* no offline shell/.test(PAGE));

// The proof the card asked for, in a temp tree: a changed payload changes the stamp with the
// shell untouched. Run in a CHILD so this process's memoization and the real tree are not
// involved.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-offline-'));
const surfaceDir = path.join(tmp, 'shell');
fs.mkdirSync(surfaceDir, { recursive: true });
for (const f of ['wiki-surface.js', 'wiki-surface.css', 'wiki-surface-sw.js']) fs.copyFileSync(path.join(here, '..', 'src', f), path.join(surfaceDir, f));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(path.join(dataDir, 'content'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'index'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'index.json'), JSON.stringify({ branches: [{ b: 'rules' }] }));
fs.writeFileSync(path.join(dataDir, 'index', 'rules.json'), JSON.stringify({ records: [{ id: 'a' }] }));
fs.writeFileSync(path.join(dataDir, 'content', 'rules.json'), JSON.stringify({ records: [{ id: 'a', text: 'one' }] }));
const probe = path.join(tmp, 'probe.mjs');
const probeSrc = [
  'import { assetStamp, dataStamp, workerStamp } from ' + JSON.stringify(new URL('../src/wiki-surface.mjs', import.meta.url).href) + ';',
  'console.log(JSON.stringify({ shell: assetStamp(), data: dataStamp(), worker: workerStamp() }));',
].join(N);
fs.writeFileSync(probe, probeSrc);
const run = () => {
  const r = spawnSync(process.execPath, [probe], { encoding: 'utf8', env: Object.assign({}, process.env, { WIKI_SURFACE_DIR: surfaceDir, WIKI_DATA_DIR: dataDir }) });
  try { return JSON.parse(r.stdout.trim().split(N).pop()); } catch (e) { return null; }
};
const first = run();
ok('the temp tree stamps', !!(first && first.shell && first.data && first.worker));
ok('the child stamp is not the real tree\'s', !!(first && first.data !== dataStamp()));
if (first) {
  fs.writeFileSync(path.join(dataDir, 'content', 'rules.json'), JSON.stringify({ records: [{ id: 'a', text: 'two, longer' }] }));
  const second = run();
  ok('a payload change moves the payload stamp', !!(second && second.data !== first.data));
  ok('and the worker stamp with it', !!(second && second.worker !== first.worker));
  ok('while the SHELL stamp is unchanged', !!(second && second.shell === first.shell));
  fs.appendFileSync(path.join(surfaceDir, 'wiki-surface.css'), N + '/* touched */' + N);
  const third = run();
  ok('a shell change moves the shell stamp', !!(third && third.shell !== second.shell));
  ok('and the worker stamp too', !!(third && third.worker !== second.worker));
  ok('and the payload stamp does not move', !!(third && third.data === second.data));
  fs.unlinkSync(path.join(dataDir, 'index', 'rules.json'));
  const fourth = run();
  ok('losing a payload file moves the stamp', !!(fourth && fourth.data !== third.data));
}
fs.rmSync(tmp, { recursive: true, force: true });

ok('the ask is never intercepted', SW_SRC.indexOf("'/rules/ask'") !== -1);
ok('nor the drawer\'s search', SW_SRC.indexOf("'/rules/find'") !== -1);
ok('nor the lookup', SW_SRC.indexOf("'/rules/lookup'") !== -1);
ok('a non-GET is never cached', /if \(req\.method !== 'GET'\) return;/.test(SW_SRC));
ok('a non-ok response is never stored', /if \(res && res\.ok && request\.method === 'GET'\) cache\.put/.test(SW_SRC) && /if \(res && res\.ok\) cache\.put/.test(SW_SRC));
ok('there is no stale-while-revalidate left', !/staleWhileRevalidate/.test(SW_SRC));
ok('the shell is network-first', /function networkFirst/.test(SW_SRC) && /if \(isShell\(url\)\) \{ e\.respondWith\(networkFirst\(req\)\); return; \}/.test(SW_SRC));
ok('the data is network-first with the cache as fallback', /function networkFirstWithCache/.test(SW_SRC) && /url\.pathname\.indexOf\(DATA_PREFIX\) === 0/.test(SW_SRC));
ok('and so is a record body', /url\.pathname\.indexOf\('\/rules\/record'\) === 0/.test(SW_SRC));
ok('the cache is only reached after a failed fetch', /catch \(e\) \{[\s\S]{0,200}cache\.match/.test(SW_SRC));

ok('the drawer reports offline instead of showing nothing', /function offlineNote/.test(CLIENT) && /sv-offline/.test(CLIENT));
ok('the book list failing says so', /the list of books could not be loaded/.test(CLIENT));
ok('and a book never downloaded says so', /this book has not been downloaded yet/.test(CLIENT));
ok('both offer a retry', /sv-offline-again/.test(CLIENT) && /Try again/.test(CLIENT));
ok('the offline note is styled', /sv-offline-again\{/.test(fs.readFileSync(path.join(here, '..', 'src', 'wiki-surface.css'), 'utf8')));

// --- task-81: the VISIBILITY rule the capture scripts broke ------------------
// Four screenshots came out byte-identical because the capture script toggled a drawer that
// localStorage had restored open, so the record rendered inside a drawer the script had shut.
// The rule the client must keep is that the record is a rectangle the reader can see: the
// drawer carries the open class AND the record is inside the viewport. A check that asserts
// only the record's TEXT passes with the drawer closed, which is how it was missed.
ok('the drawer opens before the record is drawn', /d\.classList\.add\('sv-reading'\)/.test(CLIENT) && /drawerOpen\(true/.test(CLIENT));
ok('a capture can read the drawer state without toggling it', /DRAWER_KEY/.test(CLIENT) && /localStorage\.getItem\(DRAWER_KEY\) === '1'/.test(CLIENT));
ok('the record view is a panel with its own id, so its rect is measurable', /p\.id = 'sv-drawer-record'/.test(CLIENT));
ok('the tree keeps the record in place across a re-render', /function restoreInline/.test(CLIENT));
ok('the offline note carries a retry, not just a sentence', /sv-offline-again/.test(CLIENT) && /Try again/.test(CLIENT));
ok('a hit that cannot be fetched reports instead of doing nothing', /is not in the offline copy/.test(CLIENT));
ok('a failed rows load is FAILED, never an empty book', /state\.rowsFailed\[b\] = true/.test(CLIENT) && !/catch\(function \(\) \{ state\.rowsCache\[b\] = \{\}; return \{\}; \}\)/.test(CLIENT));
ok('a failed rows load says so in the tree', /records could not be fetched/.test(CLIENT));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
