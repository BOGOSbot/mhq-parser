import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pageName, pageSlug, pageTitleSlug, cleanTitle } from '../src/wiki-toc.mjs';

// Readable wiki URLs: <kind>-<title>-<idhash>.html, readable first and stable
// last. The old <kind>_<id>-<idhash>.html names were served in the wild, so they
// redirect (301) to the new path; a filtered record has no new page and keeps its
// 404.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP = path.join(ROOT, 'workspace', 'wiki-render', 'map.json');
const LEGACY = path.join(ROOT, 'workspace', 'wiki-render', 'legacy.json');
const DATASHEET = 'datasheet#000000882';

// --- the naming ---------------------------------------------------------------
const rec = { id: DATASHEET, kind: 'datasheet', heading: 'Sorcerer > Sorcerer' };
const name = pageName(rec);
ok('the name leads with the kind and the title, not the id', /^datasheet-sorcerer-[a-z0-9]{4,8}\.html$/.test(name));
ok('the id hash still disambiguates', name.slice(0, -5) !== pageName({ id: 'datasheet#000000938', kind: 'datasheet', heading: 'Sorcerer' }).slice(0, -5) || name !== pageName({ id: 'datasheet#000000938', kind: 'datasheet', heading: 'Sorcerer' }));
t('the old name is still derivable for the redirect map', pageSlug(DATASHEET) + '.html', 'datasheet_000000882-rojyh.html');
t('a part marker is not part of the name', cleanTitle('Embarking (1/2)'), 'Embarking');
t('nor is the unitrules twin marker', cleanTitle('Sorcerer - keywords and abilities'), 'Sorcerer');
ok('an accented or punctuated title folds to a readable slug', /^faction-rule-regle-d-armee-[a-z0-9]{4,8}\.html$/.test(pageName({ id: 'faction-rule#000008445', kind: 'faction-rule', heading: "Règle d'armée" })));
t('an empty title still yields a name', pageTitleSlug({ id: 'x#1', kind: '', heading: '' }), 'record');
ok('two records with the same title never share a file', pageName({ id: 'a#1', kind: 'rule', heading: 'Charge' }) !== pageName({ id: 'a#2', kind: 'rule', heading: 'Charge' }));

// --- the live render ----------------------------------------------------------
if (fs.existsSync(MAP)) {
  const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
  const legacy = JSON.parse(fs.readFileSync(LEGACY, 'utf8'));
  const names = Object.values(map);
  ok('every delivered page has a readable name', names.every(n => /^[a-z0-9]+(?:-[a-z0-9]+)+-[a-z0-9]{4,8}\.html$/.test(n)));
  ok('no delivered page is named by its id', names.every(n => n.indexOf('_00000') === -1));
  t('the map and the redirect map cover the same records', Object.keys(legacy).length, names.length);
  ok('every old name redirects to its record new name', Object.entries(map).every(([id, n]) => legacy[pageSlug(id) + '.html'] === n));
  ok('a filtered record has no redirect (it still 404s)', !legacy[pageSlug('faction-rule#000008445') + '.html']);
  const page = fs.readFileSync(path.join(ROOT, 'workspace', 'wiki-render', map[DATASHEET]), 'utf8');
  ok('the page links its neighbours by the readable name', page.indexOf('href="datasheet_000000882') === -1 && /href="[a-z0-9]+(?:-[a-z0-9]+)+-[a-z0-9]{4,8}\.html"/.test(page));
} else {
  console.log('no live render: skipping the render-side assertions');
}

// --- the route ----------------------------------------------------------------
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

if (fs.existsSync(MAP)) {
  const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
  const port = 18100 + Math.floor(Math.random() * 40000);
  const child = await boot(port);
  try {
    const now = await request(port, '/wiki/' + map[DATASHEET]);
    t('the readable page is served', now.status, 200);
    const old = await request(port, '/wiki/' + pageSlug(DATASHEET) + '.html');
    t('the old hashed URL redirects, not 404s', old.status, 301);
    t('to the record new page', old.headers.location, '/wiki/' + map[DATASHEET]);
    t('and the redirect is not cached', old.headers['cache-control'], 'no-store');
    const gone = await request(port, '/wiki/' + pageSlug('faction-rule#000008445') + '.html');
    t('a filtered record old URL still 404s', gone.status, 404);
  } finally {
    child.kill();
  }
} else {
  console.log('no live render: skipping the route assertions');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
