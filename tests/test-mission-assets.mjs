import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'workspace', 'rules-corpus', 'assets', 'missions');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ASSETS, 'sources.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => ok(name + ' (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')', JSON.stringify(got) === JSON.stringify(want));

// --- the manifest matches what is on disk (task-78) --------------------------------
const assets = MANIFEST.assets || [];
t('the manifest is a source with an assets list', [typeof MANIFEST.source, Array.isArray(MANIFEST.assets)], ['string', true]);
ok('the manifest carries the mission faces', assets.length >= 60);
let missing = 0, badHash = 0, badBytes = 0;
// One entry is the deck page image the crawler could not attach to a record: it has
// no corpus record and is deliberately not downloaded. Everything else is a face.
const faces = assets.filter(a => a.status !== 'no-corpus-record');
for (const a of faces) {
  const p = path.join(ASSETS, a.file.replace(/^missions[\/]/, ''));
  if (!fs.existsSync(p)) { missing++; continue; }
  const buf = fs.readFileSync(p);
  if (a.bytes !== undefined && buf.length !== a.bytes) badBytes++;
  if (a.sha256 && crypto.createHash('sha256').update(buf).digest('hex') !== a.sha256) badHash++;
}
t('every manifest entry is on disk', missing, 0);
t('every sha256 matches the file', badHash, 0);
t('every byte count matches the file', badBytes, 0);
ok('the faces are png', assets.every(a => /\.png$/.test(a.file)));
ok('the attacker and the defender both exist for the secondary deck',
  assets.some(a => a.role === 'attacker') && assets.some(a => a.role === 'defender'));

// --- a mission record resolves its face --------------------------------------------
const ev = JSON.parse(fs.readFileSync(path.join(ROOT, 'workspace', 'rules-corpus', 'event-companion.json'), 'utf8'));
const ids = new Set((ev.sections || []).map(s => s.id));
const withRecord = assets.filter(a => a.record_id);
const cardRecords = new Set(withRecord.map(a => a.record_id));
t('the manifest names a corpus record for every face', withRecord.length, faces.length);
t('our 43 mission cards each have a face', [cardRecords.size, [...cardRecords].filter(id => !ids.has(id)).length], [43, 0]);
t('the secondary deck has both roles for the same cards',
  [new Set(assets.filter(a => a.role === 'attacker').map(a => a.record_id)).size, new Set(assets.filter(a => a.role === 'defender').map(a => a.record_id)).size], [18, 18]);

// --- the route ----------------------------------------------------------------------
const PORT = 8795;
const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: 'ignore' });
const base = 'http://127.0.0.1:' + PORT + '/rules/asset?path=';
const wait = ms => new Promise(r => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(base + encodeURIComponent('missions/sources.json')); up = r.ok; } catch (e) { await wait(250); } }
ok('the server answers the asset route', up);
if (up) {
  const real = assets.find(a => a.kind === 'primary');
  const r1 = await fetch(base + encodeURIComponent(real.file));
  t('a real face is served', r1.status, 200);
  t('with the png type', r1.headers.get('content-type'), 'image/png');
  ok('with an immutable cache', /immutable/.test(String(r1.headers.get('cache-control'))));
  const body = Buffer.from(await r1.arrayBuffer());
  ok('the bytes are the file', body.length === fs.statSync(path.join(ASSETS, real.file.replace(/^missions[\/]/, ''))).size);
  const r2 = await fetch(base + encodeURIComponent('missions/primary/take-and-hold/no-such-card.png'));
  t('a missing face is a 404, not a 500', r2.status, 404);
  const r3 = await fetch(base + encodeURIComponent('../src/server.mjs'));
  t('a traversal is refused', r3.status, 404);
  const r4 = await fetch(base + encodeURIComponent('missions/sources.json'));
  t('the manifest is served as json', [r4.status, r4.headers.get('content-type')], [200, 'application/json; charset=utf-8']);
  const r5 = await fetch(base);
  t('no path is a 404', r5.status, 404);
}
try { child.kill(); } catch (e) {}

// --- the render is wired (static) ----------------------------------------------------
const surface = fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
ok('the surface loads the mission manifest', surface.indexOf('missions/sources.json') !== -1 && surface.indexOf('function loadFaces') !== -1);
ok('the surface prepends the face to the record', surface.indexOf('faceHtml(r.id)') !== -1 && surface.indexOf('faceHtml(record.id)') !== -1);
ok('the css styles it', fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.css'), 'utf8').indexOf('.sv-recface') !== -1);
ok('the route is anchored and refuses a traversal', server.indexOf('const ASSET_PATH =') !== -1 && server.indexOf("'/rules/asset'") !== -1);
ok('the route reads under the corpus assets', server.indexOf("path.join(corpusDir(), 'assets', rel)") !== -1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
