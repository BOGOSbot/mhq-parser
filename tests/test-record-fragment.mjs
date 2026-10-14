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

async function boot(port, wikiDir) {
  const env = Object.assign({}, process.env);
  // The server must serve the render THIS test just made, not whatever is in the
  // live workspace/wiki-render: the two must be the same bytes to be compared.
  if (wikiDir) env.WIKI_RENDER_DIR = wikiDir;
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs'), '--port', String(port), '--host', '127.0.0.1'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

  const child = await boot(port, outDir);
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
    // --- the card's CSS travels with the card, from one source ------------------
    // The defect this slice fixes: the fragment was shared but its stylesheet was
    // not, so the same markup was a datasheet on a wiki page and an unstyled table
    // in the dialog. One export (CARD_CSS) and three surfaces carrying the same
    // bytes: /card.css for the ask page, card.css beside the render, and the link
    // in the record page's head. The shell must NOT carry it - the card belongs to
    // the record, not to the wiki.
    const cardCss = await request(port, '/card.css');
    const cssExport = (await import('../src/wiki-cards.mjs')).CARD_CSS;
    t('the card stylesheet is served on its own URL', cardCss.status, 200);
    t('as css', String(cardCss.headers['content-type']).slice(0, 8), 'text/css');
    t('and it IS the one export, byte for byte', cardCss.body, cssExport);
    ok('with a validator', typeof cardCss.headers.etag === 'string' && cardCss.headers.etag.length > 4);
    t('the render writes the same file beside its pages', fs.readFileSync(path.join(outDir, 'card.css'), 'utf8'), cssExport);
    t('and serves it there too', (await request(port, '/wiki/card.css')).body, cssExport);
    ok('the record page links the card stylesheet', fs.readFileSync(path.join(outDir, map[REC]), 'utf8').indexOf('<link rel="stylesheet" href="card.css">') !== -1);
    ok('the shell stylesheet does NOT carry the card', fs.readFileSync(path.join(outDir, 'wiki.css'), 'utf8').indexOf('.wcard') === -1);
    const pageSrc = fs.readFileSync(path.join(ROOT, 'src', 'rules.html'), 'utf8');
    ok('and the ask page links the same asset, with no copy of its own', pageSrc.indexOf('href="/card.css"') !== -1 && pageSrc.indexOf('.wcard-table') === -1);
    // --- the product shell, one asset for both surfaces -------------------------
    // The wiki record page and the ask page share the top bar and its CSS: the
    // markup comes from src/wiki-shell.mjs's topBar() and the stylesheet is the
    // one shell.css the render writes (served as /wiki/shell.css). Neither copies
    // the other - that is the drift this replaces.
    const shellSrc = await import('../src/wiki-shell.mjs');
    const page874 = fs.readFileSync(path.join(outDir, map[REC]), 'utf8');
    ok('the record page carries the product top bar', page874.indexOf(shellSrc.topBar({})) !== -1);
    ok('and knows which area it is in, so the popup opens there', /WIKI_HERE = \{[^}]*"area":"Adeptus Custodes"/.test(page874));
    ok('and links the shared shell stylesheet', page874.indexOf('href="shell.css"') !== -1 && page874.indexOf('href="card.css"') !== -1);
    ok('and tells the tree which record it is', /window\.WIKI_HERE = \{/.test(page874));
    t('the render writes the one shell stylesheet plus the tree', fs.readFileSync(path.join(outDir, 'shell.css'), 'utf8'), shellSrc.SHELL_CSS + '\n' + (await import('../src/wiki-toc.mjs')).TOC_CSS);
    const servedShell = await request(port, '/wiki/shell.css');
    t('and serves it for the ask page', servedShell.status, 200);
    t('byte for byte', servedShell.body, shellSrc.SHELL_CSS + '\n' + (await import('../src/wiki-toc.mjs')).TOC_CSS);
    const askPage = fs.readFileSync(path.join(ROOT, 'src', 'rules.html'), 'utf8');
    ok('the ask page links the same asset', askPage.indexOf('href="/wiki/shell.css"') !== -1);
    ok('and keeps no copy of the shell stylesheet', askPage.indexOf('.wtop{') === -1 && askPage.indexOf('.wrec{') === -1);
    // --- the two-pane tree, one implementation for both surfaces ---------------
    // The index is what a record page loads before the popup opens; each area's
    // tree is its own file, loaded when that area is first opened.
    const tocSrc = await import('../src/wiki-toc.mjs');
    const indexJs = fs.readFileSync(path.join(outDir, 'shell-data.js'), 'utf8');
    const index = JSON.parse(indexJs.replace(/^window\.WIKI_TOC = /, '').replace(/;$/, ''));
    ok('the index is small: a page loads it before the popup opens', indexJs.length < 4096);
    t('25 areas: Core Rules and the 24 factions', index.areas.length, 25);
    t('and they partition the whole corpus', index.areas.reduce((n, a) => n + a.c, 0), 6705);
    t('Core Rules first', index.areas[0].n, 'Core Rules');
    ok('Core Rules is down to the rules-side records', index.areas[0].c < 2000);
    const areaFile = (name) => { const a = index.areas.find(x => x.n === name); return { a, data: JSON.parse(fs.readFileSync(path.join(outDir, a.f), 'utf8').replace(/^window\.WIKI_TOC_AREA = /, '').replace(/;$/, '')) }; };
    const cust = areaFile('Adeptus Custodes');
    t('a faction carries its own groups, not one flat list', cust.data.g.map(g => g.n).sort(), ['Datasheets', 'Detachments', 'Enhancements', 'Stratagems']);
    const custIds = cust.data.g.reduce((all, g) => all.concat(g.p.map(p => p.i)), []);
    ok('THE FIX: a Custodes stratagem files under Adeptus Custodes', custIds.indexOf('stratagem#000008931007') !== -1);
    ok('and so does its enhancement', custIds.indexOf('enhancement#000009273002') !== -1);
    ok('every group counts its own pages', cust.data.g.every(g => g.c === g.p.length && g.c > 0));
    ok('and every page carries the id and the file the tree opens', cust.data.g.every(g => g.p.every(p => p.i && typeof p.f === 'string')));
    const core = areaFile('Core Rules');
    ok('the rules-side records stay there, grouped by kind', core.data.g.length >= 4 && core.data.g.some(g => /Rules|rules/.test(g.n)));
    const shellJs = await request(port, '/wiki/shell.js');
    t('the behaviour is served for the ask page', shellJs.status, 200);
    t('and is the one implementation', shellJs.body, tocSrc.TOC_JS);
    t('the index is served too', (await request(port, '/wiki/shell-data.js')).body, indexJs);
    t('and an area file loads on demand', (await request(port, '/wiki/' + cust.a.f)).body, fs.readFileSync(path.join(outDir, cust.a.f), 'utf8'));
    ok('the two-tap rule: a group opens, a page navigates', /data-group/.test(tocSrc.TOC_JS) && /data-page/.test(tocSrc.TOC_JS) && /opened\[entry\.n \+ '\|' \+ gr\.getAttribute\('data-group'\)\] = true; render\(\); return; \}/.test(tocSrc.TOC_JS) && /location\.href = f/.test(tocSrc.TOC_JS));
    ok('and a group is never collapsed by a tap', /opened\[[^\]]*\] = true/.test(tocSrc.TOC_JS) && !/opened\[[^\]]*\] = false/.test(tocSrc.TOC_JS) && tocSrc.TOC_JS.indexOf('delete opened') === -1);
    ok('the rail collapses to the current-area chip', /wrail-off/.test(tocSrc.TOC_CSS) && /data-rail-open/.test(tocSrc.TOC_JS) && /wchip on/.test(tocSrc.TOC_JS));
    ok('a record page also loads only one area file, on demand', /s\.src = BASE \+ entry\.f/.test(tocSrc.TOC_JS) && /if \(tree\(\)\) \{ cb\(\); return; \}/.test(tocSrc.TOC_JS));
    const home = await request(port, '/wiki/');
    t('a cold /wiki/ serves the product', home.status, 200);
    ok('with the top bar', home.body.indexOf('class="wtop"') !== -1);
    ok('and the tree open on Core Rules', /window\.WIKI_TOC_OPEN = "Core Rules"/.test(home.body));
    ok('while the developer index stays reachable', home.body.indexOf('index.html') !== -1);
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

