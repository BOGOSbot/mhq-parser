import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASK_MODES, askMode, writerEnabled } from '../src/rules-corpus.mjs';

// task-22: the fast/deep toggle selects the agent's reasoning. What it moves must
// be stated, not assumed - ASK_MODES fast already carries second:'medium', so
// 'fast' is not reason-free overall, and the retrieval scope is mode-bound rather
// than fixed. The writer call is OFF and the mode does not touch it; the copy says so.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'rules.html'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');

// --- the mapping, from the one table the server reads -------------------------
t('fast: agent reasoning off, second agent medium, scope 5/2/50/60',
  [ASK_MODES.fast.reasoning, ASK_MODES.fast.second, ASK_MODES.fast.first, ASK_MODES.fast.passes, ASK_MODES.fast.grepNet, ASK_MODES.fast.jevMax],
  ['none', 'medium', 5, 2, 50, 60]);
t('deep: agent reasoning medium, second agent off, scope 10/3/60/80',
  [ASK_MODES.deep.reasoning, ASK_MODES.deep.second, ASK_MODES.deep.first, ASK_MODES.deep.passes, ASK_MODES.deep.grepNet, ASK_MODES.deep.jevMax],
  ['medium', 'none', 10, 3, 60, 80]);
t('the default is fast', [askMode(''), askMode('nonsense'), askMode(undefined), askMode('deep')], ['fast', 'fast', 'fast', 'deep']);

// --- the page states the same mapping ----------------------------------------
const mapBlock = /var MODE_MAP = \{([\s\S]*?)\};/.exec(html);
ok('the page carries the mode map', !!mapBlock);
const page = mapBlock ? mapBlock[1] : '';
const fastRow = /fast:\s*\{([^}]*)\}/.exec(page);
const deepRow = /deep:\s*\{([^}]*)\}/.exec(page);
const num = (row, key) => { const m = new RegExp(key + ":\\s*'?([^,}']+)").exec(row || ''); return m ? m[1].trim() : null; };
t('the page states fast exactly as ASK_MODES does',
  fastRow ? [num(fastRow[1], 'agent'), num(fastRow[1], 'second'), num(fastRow[1], 'first'), num(fastRow[1], 'passes'), num(fastRow[1], 'grepNet'), num(fastRow[1], 'jevMax')] : null,
  ['none', 'medium', '5', '2', '50', '60']);
t('the page states deep exactly as ASK_MODES does',
  deepRow ? [num(deepRow[1], 'agent'), num(deepRow[1], 'second'), num(deepRow[1], 'first'), num(deepRow[1], 'passes'), num(deepRow[1], 'grepNet'), num(deepRow[1], 'jevMax')] : null,
  ['medium', 'none', '10', '3', '60', '80']);
// task-72: the measured score is test-bank knowledge, not reader-facing page copy.
ok('the page states the mapping and no measured accuracy', !/acc:/.test(page) && !/61\.8|79\.4/.test(page));
// task-74: the sentence under the form is off the page - Mandal asked for the line itself,
// not just the accuracy I cut from it. The dial states itself through its two buttons, and
// what the mode moves is still pinned above against ASK_MODES.
ok('the page no longer explains the dial in prose', html.indexOf('id="modenote"') === -1 && html.indexOf('Retrieval moves with the mode') === -1);
// task-69: the writer is off, and the copy must say so rather than implying prose
// that never arrives. task-28: the explainer that carried that sentence is gone -
// the page no longer implies prose at all, because the ruling slots and the ledger
// are the whole answer. The behaviour assertions below are unchanged.
ok('the writer-off disclaimer left with the explainer', html.indexOf('The model-written answer is off') === -1 && html.indexOf('introtext') === -1 && html.indexOf('howtosum') === -1);

// --- the toggle is real and defaults to fast ----------------------------------
ok('two toggle buttons with a default fast', /id="modeFast"[^>]*aria-pressed="true"/.test(html) && /id="modeDeep"[^>]*aria-pressed="false"/.test(html));
ok('the choice survives a reload, defaulting to fast', /localStorage\.setItem\('rulesMode'/.test(html) && /saved === 'deep' \? 'deep' : 'fast'/.test(html));
ok('the ask body sends the selected mode', /mode:\s*MODE/.test(html));
ok('the server acknowledges the mode it ran', /type: 'mode', mode: modeName/.test(server));
ok('and the reader can see which side of the dial they are on', /data-mode="fast"[^>]*>fast</.test(html) && /data-mode="deep"[^>]*>deep</.test(html));

// --- the answer call is not touched by the toggle -----------------------------
t('the writer is OFF by default', writerEnabled(undefined, undefined), false);
t('nothing in the request body turns it on', /writer:/.test(html), false);
ok('the writer call passes no reasoning derived from the mode', /compileFindings\(asked, outcome\.findings, keys\.model, \{ lang: answerLang \}\)/.test(server));
const writerCall = (server.match(/compileFindings\(asked[^\n]*/) || [''])[0];
ok('the writer call carries neither a mode nor a reasoning', writerCall.length > 0 && !/reasoning|mode:/.test(writerCall));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
