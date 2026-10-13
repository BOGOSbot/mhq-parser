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
  'secondJudge', 'judgeNoReasoning', 'judgeReasoning', 'judgeDisagreeTitle', 'judgeDisagreeNo', 'judgeDisagreeYes', 'judgeDissentTitle', 'judgeDissentWeaker', 'judgeDissentOther',
  'cardReady', 'streamCut', 'citedByJudge', 'verdictEvidence', 'voteHelp', 'voteUp', 'voteDown', 'voteThanks',
  'rerunTitle', 'rerunNote', 'rerankHelp', 'rerankButton', 'rerankDrop', 'rerankUse'];
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
t('the page only fetches the three routes it needs', fetchCalls, ['/health', '/rules/ask', '/rules/vote']);

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

// The evidence behind a verdict is never collapsed: the list is the union of the
// top five by rank and the passages the judge names, in rank order, cited ones
// badged, no duplicate when a cited passage is already in the top five.
ok('the card takes the cited passages', /function findingsCard\(findings, counts, cited, state\)/.test(code));
ok('the union keeps the top five and promotes the cited ones', /i < 5 \|\| isCited\(findings\[i\]\)/.test(code));
ok('a cited finding is badged and shown whole', /if \(cited\) head\.appendChild\(el\('span', 'leg cite'/.test(code));
ok('the verdict links to the passages it rests on', /ev\.appendChild\(citeLink\(f, '\[' \+ cited\[c\] \+ '\]'\)\)/.test(code));
ok('a widening drops the citations it renumbered', /if \(ev\.attempt > 0\) state\.cited = \[\];/.test(code));
ok('citations show only against the list the verdict judged', /var samePass = /.test(code));
ok('one place draws the findings list', /function renderFindings\(state\)/.test(code));

// The manual rerank (task-21): the reader unticks passages, the request carries
// their ids and nothing else, the server runs the judge and the writer over
// exactly those records, and the second answer is appended rather than replacing
// the first the reader may already have read.
ok('each finding carries its own keep/drop', /el\('button', 'keepbtn'/.test(code));
ok('the request carries the kept ids', /keep: Array\.isArray\(o\.keep\) \? o\.keep : undefined/.test(code));
ok('and the ids the reader was shown', /shown: Array\.isArray\(o\.shown\) \? o\.shown : undefined/.test(code));
ok('and the trace of the answer it overrides', /over: o\.over \|\| undefined/.test(code));
ok('the rerun appends rather than replacing', /startResult\(answerLang, \{ append: o\.append === true \}\)/.test(code) && /el\('div', 'rerun'\)/.test(code));
ok('the rerun does not translate again', /asked: o\.asked \|\| undefined/.test(code));
ok('the rerun button is a phone-sized target', PAGE.indexOf('.rerunbtn{min-height:44px}') !== -1);
ok('only the first answer is selectable', /state\.selectable = o\.append !== true;/.test(code));


// The non-stream JSON replies carry the same reconciliation the trace and the
// stream do, or a JSON consumer cannot tell a dissent from a downgrade.
// The thumb: drawn from the trace id, fired without ever delaying the answer, one
// vote per id, and the same in both languages.
ok('the page builds the vote row from the trace id', /if \(ev\.traceId\) voteRow\(ev\.traceId\);/.test(code));
ok('the vote is a tap target a phone can hit', PAGE.indexOf('.vote .vbtn{min-height:44px') !== -1);
ok('the vote is fire and forget', /fetch\('\/rules\/vote'/.test(code));
ok('a second vote replaces the first', /made\.sent/.test(code));
ok('the page ignores a vote the server could not keep', /out\.saved === false/.test(code));
const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.mjs'), 'utf8');
const jsonReplies = server.split('return json(res, 200,').slice(1);
const withDisagreement = jsonReplies.filter(x => x.slice(0, 900).indexOf('judgeDisagreement') !== -1);
const withBoth = withDisagreement.filter(x => x.slice(0, 900).indexOf('judgeDowngrade') !== -1 && x.slice(0, 900).indexOf('judgeDissentFrom') !== -1);
t('every JSON reply that reports a disagreement reports the downgrade and the dissenter', withBoth.length, withDisagreement.length);
ok('and there is more than one such reply', withBoth.length >= 2);

// The server side of the override, checked where the server text is in scope.
const overrideHead = server.indexOf('if (override) {');
const overrideRetrieve = server.indexOf('answerableFindings(asked, {');
const overrideElse = server.indexOf('} else {', overrideHead);
ok('the server has an override path', overrideHead !== -1);
ok('the override path runs before the search call', overrideHead !== -1 && overrideElse !== -1 && overrideRetrieve > overrideElse);
ok('the override resolves ids against the corpus', /keepIds\.map\(id => byId\.get\(id\)\)/.test(server));
ok('the override refuses an unknown selection', /none of those passages is in the corpus/.test(server));
ok('the override path emits findings without searching', /type: 'findings', findings: toPayload\(chosen\)/.test(server));
const traces = fs.readFileSync(path.join(__dirname, '..', 'src', 'rules-traces.mjs'), 'utf8');
ok('the trace carries the human override', /if \(input\.override\) t\.override = input\.override;/.test(traces));
ok('and points at the answer it overrides', /if \(input\.overrideOf\) t\.overrideOf = input\.overrideOf;/.test(traces));
ok('the server records kept, dropped and added', /dropped: shownIds\.filter/.test(server) && /added: keepIds\.filter/.test(server));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
