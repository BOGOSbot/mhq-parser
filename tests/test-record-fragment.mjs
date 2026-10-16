import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readAllCorpus } from '../src/rules-corpus.mjs';

// ONE renderer, one route: the fragment the server serves on demand for the ask
// page's record dialog must be byte-for-byte what the one renderer (recordBody in
// src/wiki-cards.mjs) produces for the same record and the same links.
//
// task-77: the static render used to be the second path compared here. It is
// deleted with the flip, so the comparison is now against the model directly - the
// claim (one renderer, no drift) is unchanged and no longer needs a render to hold.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const REC = 'datasheet#000000882';
const FALLBACK = 'detachment#000000990';
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

const { CARD_CSS, cardIndex, recordBody } = await import('../src/wiki-cards.mjs');
const { surfaceSlugMap } = await import('../src/wiki-surface.mjs');
const all = readAllCorpus();
const byId = new Map(all.map(r => [r.id, r]));
const corpora = { rules: all.filter(r => r.set === 'rules'), factions: all.filter(r => r.set === 'factions') };
const index = cardIndex(byId);
// The route's own link resolver: a record's address is its payload slug.
const href = id => { const s = surfaceSlugMap().get(String(id)); return s ? '#' + s : ''; };

const port = 8893;
const child = await boot(port);
try {
  for (const id of [REC, FALLBACK]) {
    const raw = byId.get(id) || null;
    ok('the corpus holds ' + id, !!raw);
    const route = await request(port, '/rules/record?id=' + encodeURIComponent(id) + '&format=html');
    t('the fragment route answers ' + id, route.status, 200);
    t('as html', String(route.headers['content-type']).slice(0, 9), 'text/html');
    t('THE ONE RENDERER AGREES on ' + id, route.body, raw ? recordBody(raw, { corpora, index, href }) : null);
    ok('and the fragment is not empty', route.body.length > 200);
  }
  const json = JSON.parse((await request(port, '/rules/record?id=' + encodeURIComponent(REC))).body);
  ok('the JSON shape carries the record and its slug', json.ok === true && json.record && json.record.id === REC && typeof json.slug === 'string');
  t('and no wiki page address is left', 'wiki' in json, false);
  // --- the card's CSS travels with the card, from one source ------------------
  const cardCss = await request(port, '/card.css');
  t('the card stylesheet is served on its own URL', cardCss.status, 200);
  t('as css', String(cardCss.headers['content-type']).slice(0, 8), 'text/css');
  t('and it IS the one export, byte for byte', cardCss.body, CARD_CSS);
  ok('with a validator', typeof cardCss.headers.etag === 'string' && cardCss.headers.etag.length > 4);
  const pageSrc = fs.readFileSync(path.join(ROOT, 'src', 'rules.html'), 'utf8');
  ok('and the ask page links the same asset, with no copy of its own', pageSrc.indexOf('href="/card.css"') !== -1 && pageSrc.indexOf('.wcard-table') === -1);
  ok('the ask page links the surface stylesheet', pageSrc.indexOf('href="/rules/surface.css"') !== -1 && pageSrc.indexOf('/wiki/shell.css') === -1);
} finally { child.kill(); }

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
