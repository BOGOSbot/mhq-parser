// task-90: the deploy check must fail when the box runs another build. A deploy that
// extracts over the tree but never restarts the process answers 200 from yesterday's
// modules, so the status code cannot tell the two apart and the build identity can.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }
function t(name, got, want) { const c = JSON.stringify(got) === JSON.stringify(want); if (c) pass++; else { fail++; console.log('FAIL ' + name + String.fromCharCode(10) + '  got : ' + JSON.stringify(got) + String.fromCharCode(10) + '  want: ' + JSON.stringify(want)); } }

const icon32 = fs.readFileSync(path.join(ROOT, 'img', 'favicon-32.png'));
const icon180 = fs.readFileSync(path.join(ROOT, 'img', 'apple-touch-icon.png'));
const FULL = 'abc123def4567890';

function serve(withBuild) {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      if (req.url.indexOf('/health') === 0) {
        const body = { brand: { favicon: 'img/favicon-32.png', faviconBytes: icon32.length, appleTouchIcon: 'img/apple-touch-icon.png', appleTouchIconBytes: icon180.length } };
        if (withBuild) body.build = { commit: FULL, source: 'file', bootedAt: '2026-10-24T00:00:00.000Z' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(body));
      }
      if (req.url === '/favicon.png' || req.url === '/favicon.ico') { res.writeHead(200); return res.end(icon32); }
      if (req.url === '/apple-touch-icon.png') { res.writeHead(200); return res.end(icon180); }
      res.writeHead(404); res.end('no');
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, url: 'http://127.0.0.1:' + s.address().port }));
  });
}
// ASYNC on purpose: spawnSync would block this process's event loop, and the stub server
// below lives in it, so the child could never get an answer and every case would hang.
function run(url, expect) {
  return new Promise(resolve => {
    const args = [path.join(ROOT, 'src', 'deploy-check.mjs'), url];
    if (expect) args.push('--expect', expect);
    const ch = spawn(process.execPath, args);
    let out = '';
    ch.stdout.on('data', c => { out += c; });
    ch.stderr.on('data', c => { out += c; });
    ch.on('close', code => resolve({ code: code, out: out }));
  });
}

const withBuild = await serve(true);
const noBuild = await serve(false);
try {
  const good = await run(withBuild.url, FULL);
  t('the shipped build is proven', good.code, 0);
  ok('and the line says so', good.out.indexOf('the running build is the one this deploy shipped') !== -1);

  const full = await run(withBuild.url, FULL + 'extra');
  t('a longer expectation that starts with the short one is the same build', full.code, 0);

  const short = await run(withBuild.url, FULL.slice(0, 12));
  t('a short commit matches the full one', short.code, 0);

  const stale = await run(withBuild.url, '999999999999');
  t('another build FAILS the check', stale.code, 1);
  ok('and it says the box is serving another build', stale.out.indexOf('THE BOX IS SERVING ANOTHER BUILD') !== -1);
  ok('and the deploy is reported as not proven', stale.out.indexOf('the deploy is not proven') !== -1);

  const silent = await run(noBuild.url, FULL);
  t('a server that cannot name its build FAILS the check', silent.code, 1);
  ok('and says why', silent.out.indexOf('does not say which build it is') !== -1);

  const unchecked = await run(withBuild.url, '');
  t('with no expectation the icons are still checked', unchecked.code, 0);
  ok('and it says the identity was not compared', unchecked.out.indexOf('was not compared with the one this deploy shipped') !== -1);
} finally {
  // The child's keep-alive socket to the stub would hold this process's event loop open.
  for (const s of [withBuild.server, noBuild.server]) { if (s.closeAllConnections) s.closeAllConnections(); s.close(); }
}
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);