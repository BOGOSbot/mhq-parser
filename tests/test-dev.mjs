import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { devHtml, devProblems, newestFile } from '../src/dev-report.mjs';

// The /dev diagnostics surface: one read-only page that shows the two faults we
// chased by hand - an index behind a rebuilt corpus, and a process serving code
// it booted before. The pure formatter is handed both states here, so the page's
// ability to show them does not depend on reproducing either live.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const clean = {
  corpus: { total: 7268, delivered: 6228, filtered: 1040, byNamespace: { rules: 714, factions: 5360, rulings: 154 } },
  namespaces: [
    { ns: 'rules', index: 714, delivered: 714, delta: 0, error: '' },
    { ns: 'factions', index: 5360, delivered: 5360, delta: 0, error: '' },
    { ns: 'rulings', index: 154, delivered: 154, delta: 0, error: '' },
  ],
  rebuilds: [{ source: 'factions-csv', rebuild: 5, at: '2026-10-15T00:55:09.081Z', sections: 5360, upserted: 0, deleted: 1040, unchanged: 5360 }],
  route: { calls: 12, empty: 3, empty_rate: 25, retries: 2, recovered: 1, truncated: 0, byRoute: { writer: { calls: 12, empty: 3, retries: 2, recovered: 1 } } },
  code: { at: 1000, name: 'server.mjs' },
  bootedAt: 2000,
};

t('a consistent state is no problem at all', devProblems(clean), []);
ok('and the page says so', devHtml(clean).indexOf('No problem') !== -1);

// Fault 1: a factions index 1,624 ids behind the rebuilt corpus.
const behind = JSON.parse(JSON.stringify(clean));
behind.namespaces[1] = { ns: 'factions', index: 3736, delivered: 5360, delta: -1624, error: '' };
t('an index behind the corpus is a named problem', devProblems(behind), ['factions index is BEHIND the delivered corpus by 1624 ids']);
const behindHtml = devHtml(behind);
ok('the page shows the number and the word', behindHtml.indexOf('BEHIND 1624') !== -1);
ok('the page is not green', behindHtml.indexOf('class="banner bad"') !== -1);
const ahead = JSON.parse(JSON.stringify(clean));
ahead.namespaces[0] = { ns: 'rules', index: 800, delivered: 714, delta: 86, error: '' };
t('an index holding ids the corpus lacks is a problem too', devProblems(ahead), ['rules index has 86 ids the delivered corpus does not have']);

// Fault 2: the process booted before src/ changed.
const stale = JSON.parse(JSON.stringify(clean));
stale.code = { at: 3000, name: 'server.mjs' };
stale.bootedAt = 2000;
ok('a process older than the code is a named problem', devProblems(stale)[0].indexOf('STALE PROCESS') !== -1);
ok('and the page shows it', devHtml(stale).indexOf('STALE: restart to pick up the code') !== -1);






// newestFile: the stale-process check needs the newest mtime, not the first.
const tmp = path.join(ROOT, 'workspace', 'dev-report-test');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, 'older.mjs'), 'x');
fs.writeFileSync(path.join(tmp, 'newer.mjs'), 'x');
const now = Date.now();
fs.utimesSync(path.join(tmp, 'older.mjs'), new Date(now - 60000), new Date(now - 60000));
t('the newest file wins', newestFile(tmp).name, 'newer.mjs');
fs.rmSync(tmp, { recursive: true, force: true });

const html = devHtml(clean);
for (const need of ['Index vs delivered', 'Last rebuild per source', 'Model route since boot', 'Code / process']) {
  ok('the page carries ' + need, html.indexOf(need) !== -1);
}
ok('the page is read-only and never linked from the nav', html.indexOf('<a href="/rules"') === -1 && html.indexOf('nav') === -1);
ok('no credential is printed', ['UPSTASH_VECTOR_REST_TOKEN', 'RULES_VECTOR_TOKEN', 'OPENROUTER_API_KEY'].every(k => html.indexOf(process.env[k] || '\u0000') === -1));

// The live route, against the running server: 200, HTML, and no-store (the counts
// climb, so a cached page would lie).
function request(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}
async function boot(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs'), '--port', String(port), '--host', '127.0.0.1'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += String(d); });
  child.stderr.on('data', d => { out += String(d); });
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250));
    try { const h = await request(port, '/health'); if (h.status === 200) return child; } catch (e) { /* not up */ }
    if (child.exitCode !== null) throw new Error('server exited: ' + out.slice(-300));
  }
  child.kill();
  throw new Error('server did not start: ' + out.slice(-300));
}

const port = 18100 + Math.floor(Math.random() * 40000);
const child = await boot(port);
try {
  const dev = await request(port, '/dev');
  t('GET /dev answers html', [dev.status, /^text\/html/.test(dev.headers['content-type'] || '')], [200, true]);
  t('and is never cached', dev.headers['cache-control'], 'no-store');
  for (const need of ['/dev diagnostics', 'Corpus', 'Index vs delivered', 'Last rebuild per source', 'Model route since boot', 'Code / process']) {
    ok('live /dev carries ' + need, dev.body.indexOf(need) !== -1);
  }
  ok('live /dev names the three namespaces it checks', ['rules', 'factions', 'rulings'].every(n => dev.body.indexOf('>' + n + '<') !== -1));
  const bad = await request(port, '/nope-dev');
  t('an unknown dev path is still a 404', bad.status, 404);
} finally {
  child.kill();
}
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
