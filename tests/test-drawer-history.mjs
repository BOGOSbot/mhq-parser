import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };

// task-42: back walks the trail. The drawer stack used to be internal, so the Android
// back button (a popstate) had nothing of ours to consume: it closed the drawer or
// left the page, and the reader lost the record they had followed. Each push onto the
// stack now pushes ONE history entry carrying the depth it reached, the URL never
// changes, and popstate draws the drawer down to that depth. Measured in the browser
// before: history.length and location.hash were unchanged across a two-link walk.
// The working tree mixes line endings (a git stash round trip rewrites CRLF), so the
// pins read the source with one ending: the discipline is the code, not the EOL.
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const surface = rd('src/wiki-surface.js');
const css = rd('src/wiki-surface.css');

// --- one entry per level -----------------------------------------------------
ok('a push onto the stack pushes a history entry', /history\.pushState\(\{ sv: 'drawer', n: depth, seq: seq \}/.test(surface));
ok('the entry carries the depth it reached', /function historyPush\(depth\)/.test(surface) && /var seq = state\.dhist \|\| 0;/.test(surface));
ok('the address does not change', /history\.pushState\(\{ sv: 'drawer', n: depth, seq: seq \}, '', location\.href\)/.test(surface));
ok('showInDrawer is what pushes it', /stack\.push\(\{ rec: record, top: 0 \}\);\n\s*historyPush\(stack\.length\);/.test(surface));

// --- popstate is the trail ---------------------------------------------------
ok('our own entries are handled first', /var st = ev && ev\.state;\n\s*if \(st && st\.sv === 'drawer'\) \{ state\.dhist = st\.seq \+ 1; setDepth\(st\.n\); return; \}/.test(surface));
ok('stepping off the trail closes the drawer', /if \(state\.dhist\) \{ state\.dhist = 0; setDepth\(-1\); return; \}/.test(surface));
ok('and only then does the page leave', /if \(!fromHash\(\)\) closePage\(\);/.test(surface));
ok('the drawer\u2019s own back button takes the same step', /function drawerBack\(\) \{\n\s*if \(state\.dhist\) \{ try \{ history\.back\(\); return; \} catch \(e\) \{\} \}/.test(surface));

// --- the three layers --------------------------------------------------------
ok('depth 0 is the tree, -1 the closed drawer', /if \(n < 0\) \{ stashStack\(\); hideDrawerRecord\(\); drawerOpen\(false, true\); return; \}/.test(surface) && /if \(!n\) \{ stashStack\(\); hideDrawerRecord\(\); return; \}/.test(surface));
ok('an open drawer is the first layer', /if \(!noHistory && want && !was\) historyPush\(0\);/.test(surface));
ok('closing it takes every entry back in one step', /history\.go\(-state\.dhist\)/.test(surface));
ok('the depth is applied in one place, and only there', (surface.match(/function setDepth\(n\)/g) || []).length === 1 && /while \(stack\.length > n\)/.test(surface) && /while \(stack\.length < n && state\.dfwd\.length\)/.test(surface));

// --- the place is kept per entry ---------------------------------------------
ok('the place in the record being left is saved with it', /e\.top = panelTop\(\)/.test(surface) && /function panelTop\(\)/.test(surface));
ok('the panel opens at that entry\u2019s own place', /var top = stack\.length \? stack\[stack\.length - 1\]\.top : 0;/.test(surface) && /panel\.scrollTop = top;/.test(surface));
ok('and the place is applied again when a fetched body lands', /wireFaces\(body\);\n\s*panel\.scrollTop = top;/.test(surface));
ok('the back label reads the entry\u2019s own record', /titleOf\(stack\[stack\.length - 2\]\.rec\)/.test(surface));

// --- the affordance ----------------------------------------------------------
ok('a body link is underlined, and keeps the reading ink readable', /\.wlink\{color: var\(--sv-acc\);text-decoration:underline;/.test(css.replace(/\n\s*/g, '')) || /\.wlink\{color:var\(--sv-acc\);text-decoration:underline;/.test(css));
ok('the underline is quiet, not the full accent', /text-decoration-color:color-mix\(in srgb,var\(--sv-acc\) 45%,transparent\)/.test(css));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
