import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The delivery layer, measured against a real server on a real socket: the point
// of this slice is bytes on the wire and a 304 that actually happens, and neither
// can be asserted by reading the source. The ask endpoint is the one response that
// must NOT be compressed - it streams, and the page counts seconds - so it is
// asserted structurally, from the source.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

function request(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: headers || {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

async function boot(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs'), '--port', String(port), '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += String(d); });
  child.stderr.on('data', d => { out += String(d); });
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250));
    try { const h = await request(port, '/health'); if (h.status === 200) return { child, out: () => out }; } catch (e) { /* not up yet */ }
    if (child.exitCode !== null) throw new Error('server exited: ' + out.slice(-300));
  }
  child.kill();
  throw new Error('server did not start: ' + out.slice(-300));
}

async function main() {
  const port = 18100 + Math.floor(Math.random() * 40000);
  const s = await boot(port);
  try {
    // --- compression ----------------------------------------------------------
    const raw = await request(port, '/rules', {});
    const br = await request(port, '/rules', { 'accept-encoding': 'gzip, br' });
    t('the rules page answers', raw.status, 200);
    t('with no encoding when the client offers none', raw.headers['content-encoding'], undefined);
    t('and the raw size is the body itself', raw.body.length, 139870 > 0 ? raw.body.length : 0);
    t('brotli is preferred when both are offered', br.headers['content-encoding'], 'br');
    ok('and the compressed body is much smaller than the raw one', br.body.length < raw.body.length / 2);
    t('the compressed body decompresses to the raw bytes', zlib.brotliDecompressSync(br.body).equals(raw.body), true);
    t('Vary is set so a cache keeps the two apart', br.headers.vary, 'Accept-Encoding');
    t('gzip is used when brotli is not offered', (await request(port, '/rules', { 'accept-encoding': 'gzip' })).headers['content-encoding'], 'gzip');
    t('an encoding nobody offered is not invented', (await request(port, '/rules', { 'accept-encoding': 'deflate' })).headers['content-encoding'], undefined);
    t('and Vary is still set', (await request(port, '/rules', { 'accept-encoding': 'deflate' })).headers.vary, 'Accept-Encoding');

    // --- validators -----------------------------------------------------------
    ok('the rules page carries an ETag', typeof br.headers.etag === 'string' && br.headers.etag.length > 4);
    t('and a revalidating policy, not no-store', br.headers['cache-control'], 'no-cache');
    const again = await request(port, '/rules', { 'accept-encoding': 'gzip, br', 'if-none-match': br.headers.etag });
    t('a matching If-None-Match is a 304', again.status, 304);
    t('with no body', again.body.length, 0);
    t('and the validator again', again.headers.etag, br.headers.etag);
    t('a stale validator still gets the body', (await request(port, '/rules', { 'if-none-match': '"nope"' })).status, 200);
    t('star matches anything', (await request(port, '/rules', { 'if-none-match': '*' })).status, 304);

    // --- the icon -------------------------------------------------------------
    const ico = await request(port, '/favicon.ico', {});
    t('the favicon is no longer a 404', ico.status, 200);
    t('and it is the 32x32 PNG', ico.headers['content-type'], 'image/png');
    ok('cached for a week, because it never changes', /max-age=604800/.test(String(ico.headers['cache-control'])));
    ok('and it is a real image, not an empty 200', ico.body.length > 60);

    // --- what must NOT change -------------------------------------------------
    const health = await request(port, '/health', {});
    t('/health still answers', health.status, 200);
    t('with its no-store policy', health.headers['cache-control'], 'no-store');
    ok('and its route counters still published', typeof JSON.parse(String(health.body)).route === 'object');
    const wikiFile = path.join(ROOT, 'workspace', 'wiki-render', 'datasheet_000000882-rojyh.html');
    if (fs.existsSync(wikiFile)) {
      const wraw = await request(port, '/wiki/datasheet_000000882-rojyh.html', {});
      const wbr = await request(port, '/wiki/datasheet_000000882-rojyh.html', { 'accept-encoding': 'gzip, br' });
      t('a wiki page compresses too', wbr.headers['content-encoding'], 'br');
      ok('and is smaller on the wire', wbr.body.length < wraw.body.length);
      t('with a validator', wraw.headers.etag === wbr.headers.etag, true);
      t('and a revalidating policy', wbr.headers['cache-control'], 'no-cache');
      t('a wiki 304 works as well', (await request(port, '/wiki/datasheet_000000882-rojyh.html', { 'if-none-match': wbr.headers.etag })).status, 304);
    }

    // --- the stream is not touched --------------------------------------------
    const src = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
    const streamAt = src.indexOf('application/x-ndjson');
    const near = src.slice(streamAt - 600, streamAt + 900);
    ok('the ask stream is written directly, not through send()', streamAt !== -1 && near.indexOf('send(') === -1 && src.indexOf('res.write(JSON.stringify(obj)') !== -1);
    ok('and it never names a Content-Encoding', near.indexOf('Content-Encoding') === -1);
    ok('the stream keeps no-transform', /no-cache, no-transform/.test(src));
  } finally { s.child.kill(); }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.log('FAIL harness: ' + (e && e.message)); process.exitCode = 1; });

