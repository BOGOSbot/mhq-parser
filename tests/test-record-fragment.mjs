import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ONE renderer, two paths, and this is the proof: the fragment the static wiki
// render writes into a page must be byte-for-byte the fragment the server serves
// on demand for the ask page's record dialog. It renders the static page here,
// fetches the route, and compares the fragments - not the pages - because the
// shell around them is the caller's.
//
// The record named is datasheet#000000882 (Custodian Guard, Adeptus Custodes): a
// datasheet with a card. Its duplicate-name sibling datasheet#000002532~1 is the
// fallback half of the pair - 111 of the 3,052 card records have no CSV row and
// must still come back as their text.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const REC = 'datasheet#000000882';
const FALLBACK = 'datasheet#000002532~1';
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got).slice(0, 400) + '\n  want: ' + JSON.stringify(want).slice(0, 400)); }
}
function ok(name, got) { t(name, !!got, true); }

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

function run(cmd, args, env) {
  return new Promise(resolve => {
    const c = spawn(cmd, args, { cwd: ROOT, env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', d => { out += String(d); });
    c.stderr.on('data', d => { out += String(d); });
    c.on('exit', code => resolve({ code, out }));
  });
}

async function boot(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs'), '--port', String(port), '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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

// The record body inside a rendered page: the card section, or the text block a
// record with no card falls back to. Everything the shell adds is outside it.
function fragmentOf(page) {
  const card = page.indexOf('<section class="wcard"');
  const text = page.indexOf('<pre class="text">');
  const starts = [card, text].filter(i => i !== -1);
  if (!starts.length) return '';
  const at = Math.min.apply(null, starts);
  const end = page.indexOf(at === card ? '</section>' : '</pre>', at);
  if (end === -1) return '';
  return page.slice(at, end + (at === card ? '</section>'.length : '</pre>'.length));
}

async function main() {
  const port = 18100 + Math.floor(Math.random() * 40000);
  const outDir = path.join(ROOT, 'workspace', 'wiki-fragment-test');
  fs.rmSync(outDir, { recursive: true, force: true });
  const rendered = await run(process.execPath, [path.join(ROOT, 'src', 'wiki-render.mjs')], { WIKI_RENDER_DIR: outDir, WIKI_RENDER_ONLY: REC + ',' + FALLBACK });
  t('the static render runs for the named records', rendered.code, 0);
  const map = JSON.parse(fs.readFileSync(path.join(outDir, 'map.json'), 'utf8'));

  const child = await boot(port);
  try {
    for (const id of [REC, FALLBACK]) {
      const file = map[id];
      ok('the render wrote a page for ' + id, !!file && fs.existsSync(path.join(outDir, file)));
      const staticFrag = fragmentOf(fs.readFileSync(path.join(outDir, file), 'utf8'));
      const route = await request(port, '/rules/record?id=' + encodeURIComponent(id) + '&format=html');
      t('the fragment route answers ' + id, route.status, 200);
      t('as html', String(route.headers['content-type']).slice(0, 9), 'text/html');
      t('THE TWO PATHS AGREE on ' + id, route.body, staticFrag);
      ok('and the fragment is not empty', staticFrag.length > 200);
    }
    const cardFrag = fragmentOf(fs.readFileSync(path.join(outDir, map[REC]), 'utf8'));
    ok('the datasheet renders as the card', cardFrag.indexOf('<section class="wcard"') === 0 && cardFrag.indexOf('<table') !== -1);
    const fallbackFrag = fragmentOf(fs.readFileSync(path.join(outDir, map[FALLBACK]), 'utf8'));
    ok('and a duplicate-name id with no CSV row falls back to its text', fallbackFrag.slice(0, 18) === '<pre class="text">' && fallbackFrag.indexOf('<table') === -1);
    t('the route still answers JSON without the flag', (await request(port, '/rules/record?id=' + encodeURIComponent(REC))).headers['content-type'].indexOf('application/json'), 0);
    const json = JSON.parse((await request(port, '/rules/record?id=' + encodeURIComponent(REC))).body);
    ok('with the record shape it always had', json.ok === true && json.record && json.record.id === REC && typeof json.wiki === 'string');
    const missing = await request(port, '/rules/record?id=nope&format=html');
    t('an unknown id is still a 404', missing.status, 404);
  } finally {
    child.kill();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.log('FAIL harness: ' + (e && e.message)); process.exitCode = 1; });

