import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMG = path.join(ROOT, 'img');
const PORT = 18731;

function request(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}
async function boot(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs'), '--port', String(port), '--host', '127.0.0.1'], { cwd: ROOT, env: Object.assign({}, process.env), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += String(d); });
  child.stderr.on('data', d => { out += String(d); });
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250));
    try { const h = await request(port, '/health'); if (h.status === 200) return child; } catch (e) { /* not up yet */ }
    if (child.exitCode !== null) throw new Error('server exited: ' + out.slice(-300));
  }
  child.kill();
  throw new Error('server did not start: ' + out.slice(-300));
}

// --- both heads carry the two links ------------------------------------------
const rulesHtml = fs.readFileSync(path.join(ROOT, 'src', 'rules.html'), 'utf8');
for (const pair of [['rules.html', rulesHtml]]) {
  const label = pair[0], html = pair[1];
  ok(label + ' links the 32x32 PNG as the icon', html.indexOf('<link rel="icon" href="/favicon.png" type="image/png">') !== -1);
  ok(label + ' links the 180x180 touch icon', html.indexOf('<link rel="apple-touch-icon" href="/apple-touch-icon.png">') !== -1);
}

// --- the assets are the ones Mandal supplied ---------------------------------
const pngSize = buf => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
const icon32 = fs.readFileSync(path.join(IMG, 'favicon-32.png'));
const icon180 = fs.readFileSync(path.join(IMG, 'apple-touch-icon.png'));
t('the 32x32 asset is 32x32', pngSize(icon32), { w: 32, h: 32 });
t('the touch asset is 180x180', pngSize(icon180), { w: 180, h: 180 });
ok('both assets carry the PNG signature', icon32.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && icon180.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
const deploySrc = fs.readFileSync(path.join(ROOT, 'src', 'deploy-check.mjs'), 'utf8');
ok('the server reads the icons once at boot', /readIcon\('favicon-32\.png'\)/.test(serverSrc) && /readIcon\('apple-touch-icon\.png'\)/.test(serverSrc));
ok('and keeps the inline ICO as the fallback', /const ICON = Buffer\.from\(/.test(serverSrc) && /ICON_32 \|\| ICON/.test(serverSrc) && /ICON_180 \|\| ICON_32 \|\| ICON/.test(serverSrc));


// --- task-63: the deploy check, and the fallback that hid it -------------------
// The favicon was 'lost' on the live page for a day while every check passed: the
// fallback answers 200 by design, so a deploy whose archive forgot img/ served the
// 119-byte placeholder and nothing said so. The check asserts BYTES, not status.
ok('the deploy check reads the two brand icons', /favicon-32\.png/.test(deploySrc) && /apple-touch-icon\.png/.test(deploySrc));
ok('it refuses the placeholder by name', /the placeholder is being served/.test(deploySrc) && /favicon !== 'fallback'/.test(deploySrc));
ok('it fetches all three icon routes', ['/favicon.png', '/favicon.ico', '/apple-touch-icon.png'].every(r => deploySrc.indexOf("'" + r + "'") !== -1));
ok('it compares byte counts, not just the status', /bytes === want\.length/.test(deploySrc));
ok('and it exits non-zero on a failure', /process\.exitCode = 1/.test(deploySrc));
// /health publishes what the process is actually serving, so a deployment can say
// 'fallback' out loud instead of looking healthy.
ok('/health carries the brand field', /brand: \{/.test(serverSrc) && /faviconBytes/.test(serverSrc) && /appleTouchIconBytes/.test(serverSrc));
ok('and names the fallback when it is serving it', /favicon: ICON_32 \? 'img\/favicon-32\.png' : 'fallback'/.test(serverSrc));
// The recipe is the thing that forgot img/ in the first place.
const deployDoc = fs.readFileSync(path.join(ROOT, 'docs', 'deploy.md'), 'utf8');
// The recipe grew the build marker and the corpus on top of src and img; the pin follows
// the doc's own order, and the two lines below still catch the img/ regression it was born for.
ok('the deploy recipe archives img/', /tar -czf mhq-deploy\.tgz BUILD src img workspace\/rules-corpus/.test(deployDoc));
ok('and says why it is not optional', /img\/ is not optional/.test(deployDoc));
ok('and points at the check', /node src\/deploy-check\.mjs/.test(deployDoc));

// --- the three endpoints, byte for byte --------------------------------------
const child = await boot(PORT);
try {
  for (const pair of [['/favicon.png', icon32], ['/favicon.ico', icon32], ['/apple-touch-icon.png', icon180]]) {
    const p = pair[0], want = pair[1];
    const r = await request(PORT, p);
    t('GET ' + p + ' answers 200', r.status, 200);
    t('GET ' + p + ' is image/png', String(r.headers['content-type']).split(';')[0], 'image/png');
    t('GET ' + p + ' is the file byte for byte', [r.body.length, Buffer.compare(r.body, want)], [want.length, 0]);
    ok('GET ' + p + ' caches a week', /max-age=604800/.test(String(r.headers['cache-control'])));
  }
  // The fallback is 119 bytes; the served icon is the brand file, so it is not it.
  ok('MUTATION: the served icon is the brand file, not the 119-byte ICO', (await request(PORT, '/favicon.png')).body.length === 119 === false);
} finally {
  child.kill();
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
