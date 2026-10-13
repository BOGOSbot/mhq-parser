import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The /rules page's own rules, checked where a reviewer cannot see them by hand:
// commit 864ad28 fixed one hardcoded English label ('Findings - N') that the
// French page showed among French ones, and the defect was invisible until a
// French reader looked at that exact card. Two structural checks catch the whole
// class: both language tables carry the same keys, and every t('...') key in the
// script exists in them. A third catches a fresh hardcoded label.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'src', 'rules.html'), 'utf8');

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const start = PAGE.indexOf('var I18N = {');
const end = PAGE.indexOf('var LANG');
ok('the i18n tables are found', start !== -1 && end > start);
const table = PAGE.slice(start + 'var I18N = '.length, end).replace(/;\s*$/, '').trim();
const I18N = new Function('return ' + table)();
// Everything after the tables is code: the language tables are the only place a
// reader-facing string may live as a literal.
const code = PAGE.slice(end);

const en = Object.keys(I18N.en).sort();
const fr = Object.keys(I18N.fr).sort();
t('both languages carry the same keys', fr, en);

// Every key the script asks for exists in the English table (the French table
// falls back to it, so a missing FR key is a wrong-language answer, not a crash).
// The reverse matters more: a t() call whose key is in neither table prints the
// key itself, which is exactly how the page loses a label.
// The lookbehind matters: without it `createElement('div')` reads as t('div').
const USED = /(?<![A-Za-z0-9_])t\('([A-Za-z0-9_]+)'\)/g;
const used = new Set();
for (const m of code.matchAll(USED)) used.add(m[1]);
const missing = Array.from(used).filter(k => I18N.en[k] === undefined).sort();
t('every t() key the page asks for is in the tables', missing, []);
const usedFr = new Set();
for (const m of code.matchAll(USED)) usedFr.add(m[1]);
const missingFr = Array.from(usedFr).filter(k => I18N.fr[k] === undefined).sort();
t('and in the French table too', missingFr, []);

// The retrieval display and the unit card are new; their labels have to be in
// the tables like every other one.
const needed = ['legVector', 'legLexical', 'legBoth', 'legAnchored', 'legChild', 'rankN', 'rankScore', 'rankScoreTitle', 'matchedWords', 'openPassage', 'moreFindings', 'close', 'openSource',
  'cardTitle', 'cardRanged', 'cardMelee', 'cardAbilities', 'cardKeywords', 'cardComposition', 'cardPoints', 'cardSourceNote', 'cardOpen',
  'secondJudge', 'judgeNoReasoning', 'judgeReasoning', 'judgeDisagreeTitle', 'judgeDisagreeNo', 'judgeDisagreeYes', 'cardReady', 'streamCut'];
const absent = needed.filter(k => I18N.en[k] === undefined || I18N.fr[k] === undefined);
t('the new display labels exist in both languages', absent, []);

// A label written as a literal in the code is the defect 864ad28 fixed.
// Leg values ('lexical', 'vector') are data compared in code, not labels; the
// list is reader-facing strings only.
const literals = ["'Findings'", "'Answer'", "'Judge'", "'Passage'", "'Close'", "'more findings'", "'Open on Wahapedia'"];
const hardcoded = literals.filter(l => code.indexOf(l) !== -1);
t('no reader-facing label is hardcoded in the script', hardcoded, []);

// The passage popup reads the payload, never the network: one fetch of /health
// is the only fetch outside /rules/ask on the page.
const fetchCalls = Array.from(new Set(Array.from(PAGE.matchAll(/fetch\('([^']+)'/g)).map(m => m[1]))).sort();
t('the page only fetches /health and /rules/ask', fetchCalls, ['/health', '/rules/ask']);

// The display the task asks for, asserted where it can be seen: findings above
// the prose, re-rendered whenever a findings event lands, popup over payload.
ok('the findings slot is placed before the answer card', code.indexOf("host.appendChild(findingSlot)") !== -1 && code.indexOf("host.appendChild(findingSlot)") < code.indexOf("host.appendChild(answerCard)"));
ok('the findings slot is rebuilt on every findings event', /state\.findingSlot\.textContent = ''/.test(code));
ok('a widening flashes the rebuilt list', /if \(ev\.attempt > 0\) flash\(state\.findingSlot\)/.test(code));
ok('the popup reads the passage from the payload', /f\.passage \|\| f\.excerpt/.test(code));
ok('the similarity is labelled a rank score', /rankScoreTitle/.test(code));

// The unit card's abilities: a Base or Faction ability is a rule defined
// elsewhere and is a linked title with no body; a Datasheet ability, or one that
// could not be resolved, keeps its text.
const box = code.slice(code.indexOf('function abilityBox'), code.indexOf('function unitCardView'));
ok('a linked ability is rendered as a title', /if \(ab\.link\)/.test(box));
ok('a linked ability has no body before it returns', box.indexOf("ab.link") !== -1 && box.indexOf("ab.link") < box.indexOf("uabtext"));
ok('the truncation note belongs to the kept-text branch', box.indexOf("t('cardTruncated')") > box.indexOf("uabtext"));
ok('the ability link opens the passage popup', /openPassage\(\{ heading: ab\.link\.heading/.test(box));

// The card is additive: it previews at the top of the result and the search,
// judge and writer still run. It used to replace them, which answered a French
// rules question with a datasheet and no judge.
ok('the card previews above the pipeline', code.indexOf('host.appendChild(cardSlot)') !== -1 && code.indexOf('host.appendChild(cardSlot)') < code.indexOf('host.appendChild(verdict)'));
ok('the card renders into its own slot', /state\.cardSlot\.appendChild\(unitCardView/.test(code));
ok('the card event no longer clears the result', /host\.textContent = '';\s*\n\s*host\.appendChild\(unitCardView/.test(code) === false);
ok('done no longer short-circuits on a card', code.indexOf('if (state.card) { setStatus') === -1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
