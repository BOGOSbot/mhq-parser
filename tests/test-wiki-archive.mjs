import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zipEntries } from '../src/wiki-archive.mjs';

// task-47: the one-shot offline download. The acceptance is that the archive
// enumerates exactly the delivered pages and that a filtered record is not in it.
// The manifest is the render's map.json - the same file /wiki routing and the
// prune sweep use - so this asserts against it directly, and against the real
// artifact the server actually serves.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got).slice(0, 300) + '\n  want: ' + JSON.stringify(want).slice(0, 300)); }
}
function ok(name, got) { t(name, !!got, true); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = path.join(ROOT, 'workspace', 'wiki-render');
const MAP = JSON.parse(fs.readFileSync(path.join(RENDER, 'map.json'), 'utf8'));
const PAGES = Object.values(MAP);
const FILTERED = 'faction-rule_000008445-1wal5mo.html';

function request(port, p, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 120000, () => req.destroy(new Error('timeout')));
  });
}
function boot(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs'), '--port', String(port), '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += String(d); });
  child.stderr.on('data', d => { out += String(d); });
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try { const h = await request(port, '/health'); if (h.status === 200) return resolve(child); } catch (e) { /* not up */ }
      if (child.exitCode !== null) return reject(new Error('server exited: ' + out.slice(-300)));
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function main() {
  const port = 21000 + Math.floor(Math.random() * 30000);
  const child = await boot(port);
  try {
    const res = await request(port, '/wiki/all.zip');
    t('the archive serves as a zip', [res.status, String(res.headers['content-type'])], [200, 'application/zip']);
    ok('as a download a phone can save', /attachment/.test(String(res.headers['content-disposition'])) && /mhq-rules-wiki\.zip/.test(String(res.headers['content-disposition'])));
    const entries = zipEntries(res.body);
    const names = entries.map(e => e.name);
    ok('it parses as a zip with thousands of files', entries.length > 6000);
    // The record pages are exactly map.json's manifest. The other HTML is the
    // wiki's own surfaces - the offline home, the search/dev pages and the 24
    // army-rules pages the render writes outside the record manifest - and it is
    // derived from the render, not assumed.
    const diskHtml = [];
    const walkHtml = p => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) walkHtml(q); else if (/\.html$/.test(e.name)) diskHtml.push(path.relative(RENDER, q).split(path.sep).join('/')); } };
    walkHtml(RENDER);
    const surfaces = diskHtml.filter(n => PAGES.indexOf(n) === -1 && n !== 'search.html' && n !== 'anomalies.html');
    const html = names.filter(n => /\.html$/.test(n));
    t('every page map.json names is in it', PAGES.filter(p => names.indexOf(p) === -1).length, 0);
    t('and no HTML outside the delivered pages plus the wiki surfaces', html.filter(n => PAGES.indexOf(n) === -1 && surfaces.indexOf(n) === -1).length, 0);
    t('the HTML it holds is exactly those two sets', html.length, PAGES.length + surfaces.length);
    ok('the dev search/anomaly surfaces are not shipped', !names.includes('search.html') && !names.includes('anomalies.html'));
    ok('and the offline front page is', names.includes('home.html'));
    ok('a filtered record has no page and no entry', !names.includes(FILTERED));
    ok('the navigation assets come with it', ['index.html', 'shell.js', 'shell.css', 'tree/index.js'].every(n => names.indexOf(n) !== -1));
    // Offline means file:// works: the pages carry relative refs, not /wiki/ paths.
    const page = entries.find(e => e.name === PAGES[0]);
    ok('a page is byte-identical to the render', page && page.data.equals(fs.readFileSync(path.join(RENDER, PAGES[0]))));
    ok('and its refs are relative, so the archive opens offline', page.data.toString('utf8').indexOf('href="shell.css"') !== -1 && page.data.toString('utf8').indexOf('src="/wiki/') === -1);
    // The page's own entry point.
    const rules = await request(port, '/rules');
    ok('the page carries a visible entry point to the archive', rules.body.indexOf('href="/wiki/all.zip"') !== -1);
    // A repeat visit revalidates rather than re-sends (the ETag is set).
    ok('the archive is revalidation-cached, not re-computed per visit', !!res.headers.etag);
  } finally {
    child.kill();
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
}
main().catch(e => { console.log('FAIL harness: ' + (e && e.message)); process.exitCode = 1; });
