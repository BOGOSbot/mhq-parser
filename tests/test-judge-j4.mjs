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
const t = (name, got, want) => { const same = JSON.stringify(got) === JSON.stringify(want); if (same) pass++; else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); } };
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
ok('the uncited rest is ONE collapsed line', /t\('otherPassages'\)/.test(surface) && /distinctNames\(rest, 3\)/.test(surface));

// --- task-25: no card, no label, short names, distinct residue names ----------
ok('the ruling is not wrapped in a card', page.indexOf("var verdict = el('div', 'card')") === -1 && /el\('div', 'ruleblock'\)/.test(page));
ok('no heading is drawn over the ruling', page.indexOf("el('h2', null, t('judgeTitle'))") === -1);
ok('the ledger is not a card either', /el\('div', 'ledger'\)/.test(surface) && !/var card = ctx\.sectionCard/.test(surface.slice(surface.indexOf('function rulingLedger'), surface.indexOf('function findingsCard'))));
ok('the display name is the short one, from one implementation', /api\.shortName/.test(page) && /shortName: shortName/.test(surface));
ok('the second judge is a plain dim sentence, not an eyebrow', /secondJudgeWith/.test(page) && /secondJudgeWithout/.test(page) && page.indexOf("'secondhead'") === -1 && page.indexOf('sreason') === -1);

// The pure row display chain is tested, not just grepped: pull it out of the asset
// by brace matching and run it on the capture's own headings.
const fnText = name => {
  const at = surface.indexOf('function ' + name + '(');
  let i = surface.indexOf('{', at), depth = 0;
  for (; i < surface.length; i++) {
    if (surface[i] === '{') depth++;
    else if (surface[i] === '}') { depth--; if (!depth) return surface.slice(at, i + 1); }
  }
  return '';
};
const sandbox = new Function(['displayTitle', 'shortName', 'pathParts', 'rowName', 'rowDisplay', 'distinctNames'].map(fnText).join('\n')
  + '\nreturn { shortName: shortName, rowDisplay: rowDisplay, distinctNames: distinctNames };')();
t('a units twin loses its kind marker', sandbox.shortName('Ironstrider Ballistarii - keywords and abilities (2/2)'), 'Ironstrider Ballistarii');
t('an ALL-CAPS name is title-cased for display', sandbox.shortName('FALL-BACK MOVE'), 'Fall-Back Move');
t('a datasheet marker is stripped too', sandbox.shortName('Wazdakka Gutsmek - datasheet'), 'Wazdakka Gutsmek');
t('a name that is not a marker is untouched', sandbox.shortName('Tactical Doctrine - faction rule'), 'Tactical Doctrine - faction rule');
t('the residue names three DISTINCT names, not three copies', sandbox.distinctNames([{ heading: 'A > FALL-BACK MOVE' }, { heading: 'B > FALL-BACK MOVE' }, { heading: 'C > FALL-BACK MOVE' }, { heading: 'D > CHARGE MOVE' }], 3), ['Fall-Back Move', 'Charge Move']);

// --- task-26: the one row display derivation ---------------------------------
// The capture's own headings, the same expectations as test-rules-page.mjs.
const FAQ_Q = 'If a rule says my unit must make a hazard roll does every model in the unit make a hazard roll?';
const FAQ_PATH = ['Muster Armies', 'Fill Your Army Roster', 'FAQ', FAQ_Q, 'FALL-BACK MOVE'];
const ONESHOT_PATH = ['[ONE SHOT]', 'FAQ', 'Q: ' + FAQ_Q, 'FALL-BACK MOVE'];
const NESTED = ['Core Rules', '09 Movement Phase', 'FALL-BACK MOVE'];
t('a Q&A row is named by its question, and the path stops before it', sandbox.rowDisplay(FAQ_PATH), { name: FAQ_Q, path: ['Muster Armies', 'Fill Your Army Roster', 'FAQ'], at: 3 });
t('the one-shot row keeps the source own question label', sandbox.rowDisplay(ONESHOT_PATH), { name: 'Q: ' + FAQ_Q, path: ['[ONE SHOT]', 'FAQ'], at: 2 });
t('a plain nested rule keeps its own name', sandbox.rowDisplay(NESTED), { name: 'Fall-Back Move', path: ['Core Rules', '09 Movement Phase'], at: 2 });
t('the three rows the Fell Back capture shows no longer share a title', sandbox.distinctNames([{ heading: FAQ_PATH.join(' > ') }, { heading: ONESHOT_PATH.join(' > ') }, { heading: NESTED.join(' > ') }], 3), [FAQ_Q, 'Q: ' + FAQ_Q, 'Fall-Back Move']);
ok('the ledger name and path are that one derivation', /function ledgerName\(f\) \{ return rowDisplay\(f\.heading\)\.name; \}/.test(surface) && /function ledgerPath\(f\) \{ return rowDisplay\(f\.heading\)\.path/.test(surface));
ok('the page source line asks the same helper', /api\.rowDisplay/.test(page) && /rowDisplay: function \(heading\)/.test(surface));
ok('shortName runs AFTER the rowName pick, never before', surface.indexOf('name: shortName(r.name)') > surface.indexOf('var r = rowName(parts)'));
ok('opening the residue shows path-only rows, not excerpts', /'fitem res'/.test(surface) && /'rname'/.test(surface) && /'rpath'/.test(surface));
// The ledger row is the mockup's: a name, a path, no rank number and no cite chip.
const usedRow = surface.slice(surface.indexOf('function ledgerUsedRow'), surface.indexOf('function ledgerResidue'));
ok('a ledger row carries no [n] chip', usedRow.indexOf("'num'") === -1 && usedRow.indexOf('f.n') === -1);
ok('a ledger row carries no cite badge', usedRow.indexOf('citedByJudge') === -1 && usedRow.indexOf('leg cite') === -1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;