import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// task-24 (J4): the rendering. What ships on the reader's page is the ruling's
// slots and the ledger; what must be gone is the verification chrome - the verdict
// line, the confidence chip, the 'why' toggle and the 'passages it rests on' line.
// The server half (the field contract, the trace check, the fallbacks) is pinned in
// tests/test-judge-ruling.mjs; the browser proof is the 390x844 capture of the Fell
// Back, points, refused, not-a-question and fabricated-figure states.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(ROOT, 'src', 'rules.html'), 'utf8');
const surface = fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.js'), 'utf8');

// --- the ruling's slots, and nothing else ------------------------------------
for (const cls of ['ruling', 'rline', 'rquote', 'rstrike', 'rsrc', 'rex', 'rmiss', 'rtrace']) {
  ok('the page styles .' + cls, page.indexOf('.' + cls) !== -1);
}
ok('the page builds the ruling from the response fields', /judge\.answer/.test(page) && /judge\.quote/.test(page) && /judge\.exceptions/.test(page) && /judge\.missing/.test(page));
ok('the source is named by title, with the section path beside it', /function sourceLine/.test(page) && /leafOf\(f\.heading\)/.test(page) && /'srule'/.test(page));
ok('the ruling is rendered by one builder, used by both verdicts', (page.match(/rulingBlock\(/g) || []).length >= 3);
ok('the exceptions read as an unless-line of title links', /t\('rulingUnless'\)/.test(page) && /'exlink'|rex/.test(page));

// --- the chrome is deleted ----------------------------------------------------
ok('no verdict line is rendered', page.indexOf('verdictLine(') === -1 && page.indexOf("t('answeredYes')") === -1 && page.indexOf("t('answeredNo')") === -1);
ok('no confidence chip is rendered', page.indexOf("'conf ' + judge.confidence") === -1 && page.indexOf('t(\'confidence\')') === -1);
ok('no why toggle is rendered', page.indexOf('whybox') === -1 && page.indexOf("t('judgeWhy')") === -1);
ok('the why field is never put on the page', page.indexOf('judge.why') === -1);
ok('no passages-it-rests-on line is rendered', page.indexOf('verdictEvidence') === -1 && page.indexOf("'vevidence'") === -1 && page.indexOf('.vevidence') === -1);

// --- the trace check reaches the page ----------------------------------------
ok('a dropped figure is struck where it stands', /strikeFigures/.test(page) && /'rstrike'/.test(page));
ok('a quote the passage does not carry is struck', /rquote bad/.test(page));
ok('the count line is printed in warn', /t\('rulingTrace'\)/.test(page) && /replace\('\{n\}'/.test(page));
ok('the fallback with no answer is the recommendation line', /t\('rulingStart'\)/.test(page));

// --- the ledger: cited in full, the rest one collapsed line -------------------
ok('the ledger renderer exists', /function rulingLedger/.test(surface) && /function ledgerUsedRow/.test(surface) && /function ledgerResidue/.test(surface));
ok('the ledger is used once a verdict exists', /state\.judge\) \{ host\.appendChild\(rulingLedger/.test(surface));
ok('the used passages are the ruling\'s own numbers', /add\(judge\.from\)/.test(surface) && /judge\.exceptions/.test(surface) && /judge\.passages/.test(surface));
ok('a refusal shows the nearest three in full', /if \(!used\.length\) used = order\.slice\(0, 3\)/.test(surface) && /t\('nearestPassages'\)/.test(surface));
ok('the quoted row is marked instead of repeating the words', /t\('quotedAbove'\)/.test(surface) && /lmark/.test(surface));
ok('the excerpt is one tap away, not above the answer', /text\.hidden = true/.test(surface) && /ledgerPath|ftext/.test(surface));
ok('the uncited rest is ONE collapsed line with the first three names', /t\('otherPassages'\)/.test(surface) && /\.slice\(0, 3\)\.map\(ledgerName\)/.test(surface));
ok('opening the residue shows path-only rows, not excerpts', /'fitem res'/.test(surface) && /'rname'/.test(surface) && /'rpath'/.test(surface));
// The ledger row is the mockup's: a name, a path, no rank number and no cite chip.
const usedRow = surface.slice(surface.indexOf('function ledgerUsedRow'), surface.indexOf('function ledgerResidue'));
ok('a ledger row carries no [n] chip', usedRow.indexOf("'num'") === -1 && usedRow.indexOf('f.n') === -1);
ok('a ledger row carries no cite badge', usedRow.indexOf('citedByJudge') === -1 && usedRow.indexOf('leg cite') === -1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;