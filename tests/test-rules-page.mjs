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
const needed = ['legVector', 'legLexical', 'legBoth', 'legAnchored', 'legChild', 'rankN', 'rankScore', 'rankScoreTitle', 'matchedWords', 'moreFindings', 'close', 'openSource',
  'cardTitle', 'cardRanged', 'cardMelee', 'cardAbilities', 'cardKeywords', 'cardComposition', 'cardPoints', 'cardSourceNote', 'cardOpen',
  'secondJudge', 'judgeNoReasoning', 'judgeReasoning', 'judgeDisagreeTitle', 'judgeDisagreeNo', 'judgeDisagreeYes', 'judgeDissentTitle', 'judgeDissentWeaker', 'judgeDissentOther',
  'cardReady', 'streamCut', 'citedByJudge', 'verdictEvidence', 'voteHelp', 'voteUp', 'voteDown', 'voteThanks',
  'pickHelp', 'pickThis', 'pickNone', 'pickWaiting', 'pickThanks', 'pickNoneThanks',
  'rerunTitle', 'rerunNote', 'rerankHelp', 'rerankButton',
  // The hero card's controls and the provenance its dev toggle opens.
  'heroCaret', 'heroCaretOn', 'heroIgnore', 'heroIgnoreOn', 'heroTop', 'heroIgnored',
  'heroDev', 'heroDevHide', 'heroLinks', 'foundBy', 'legUnknown',
  // The full-screen record, the wiki link and the four categories it opens.
  'wikiNav', 'recordOpen', 'recordClose', 'recordSwipe', 'recordWiki', 'recordSource', 'recordText', 'recordLinks',
  'kindUnit', 'kindFaction', 'kindDetachment', 'kindRule', 'kindStratagem', 'kindEnhancement', 'kindAbility', 'kindIndex', 'kindOther',
  // The lookup router's one reader-facing line.
  'lookupFound'];
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
t('the page only fetches the seven routes it needs', fetchCalls, ['/health', '/rules/answered', '/rules/ask', '/rules/labels', '/rules/lookup?q=', '/rules/record?id=', '/rules/vote']);

// The display the task asks for, asserted where it can be seen: findings above
// the prose, re-rendered whenever a findings event lands, popup over payload.
ok('the findings slot is placed before the trailing block', code.indexOf("host.appendChild(findingSlot)") !== -1 && code.indexOf("host.appendChild(findingSlot)") < code.indexOf("host.appendChild(rest)"));
ok('the findings slot is rebuilt on every findings event', /state\.findingSlot\.textContent = ''/.test(code));
// Slice 2: the record dialog no longer builds record markup. It fetches the one
// fragment - the same bytes the static wiki page carries - and keeps only its own
// shell around it: the marks, the link chips, the wiki link and the swipe.
ok('the dialog fetches the shared fragment',
  /'\/rules\/record\?id=' \+ encodeURIComponent\(id\) \+ '&format=html'/.test(code) && /frag\.innerHTML = fragHtml/.test(code));
ok('and builds no card of its own anymore', code.indexOf('body.appendChild(unitCardView(data.card))') === -1);
ok('the fragment links are rebased into the wiki', /function wikiHrefs\(root\)/.test(code) && /setAttribute\('href', '\/wiki\/' \+ h\)/.test(code) && /frag\.innerHTML = fragHtml;\s*wikiHrefs\(frag\)/.test(code));
ok('while the dialog keeps its shell: marks, chips, wiki link, swipe',
  ['findingControls(state, f, isFirsted(state, f), isIgnored(state, f))', "el('a', 'recwiki', t('recordWiki'))", "el('h3', null, t('recordLinks'))", "el('p', 'recswipe', t('recordSwipe'))"].every(function (s) { return code.indexOf(s) !== -1; }));
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
// The findings are hero cards above the prose, and the reader's three controls
// are on the card itself: the green caret reranks a record to the top, the x
// ignores it, and <> opens the whole chunk with the provenance behind it. Each
// control is one edit away from being undone, so each is asserted structurally.
ok('each finding is a hero card with its own caret and x', /el\('button', 'herocaret'/.test(code) && /el\('button', 'herox'/.test(code) && /'fitem hero'/.test(code));
ok('the caret is a positive example in the same trace as the question', code.indexOf('state.positive.unshift(id)') !== -1 && code.indexOf('postLabels(state)') !== -1);
ok('the x is a negative example in the same trace as the question', /negative: state\.shownIds\.filter/.test(code));
// They are posted the moment they are made: the trace is written when the answer
// lands, and the server holds the mark for it, so a reader who leaves early still
// leaves the label the dataset wants.
ok('the caret and the x are posted the moment they are made', /function markLabels\(state\) \{[\s\S]{0,80}postLabels\(state\);/.test(code));
t('and nothing waits for the run to end any more', code.indexOf('labelsPending'), -1);
ok('a widening cannot undo the reader\'s marks', /state\.keep\[sid\] = prevKeep\[sid\] !== false;/.test(code));
ok('the dev toggle opens the whole passage and its indicators', /function devPanel\(f, state\)/.test(code) && code.indexOf("t('foundBy')") !== -1 && /passageBody\(f\)/.test(code) && code.indexOf("t('rankScore')") !== -1);
ok('the card shows one line at rest', /\.heroline\{white-space:nowrap;overflow:hidden;text-overflow:ellipsis\}/.test(PAGE));
ok('the caret is green and a phone-sized target', /\.herocaret\{color:var\(--ok\)/.test(PAGE) && /\.fctl button\{[^}]*min-height:44px/.test(PAGE));
ok('the judge citations and the reader picks both resort the list', /picked\.concat\(citedOnes, rest, dropped\)/.test(code) && /picked\.sort\(/.test(code));
ok('and the reader wins over the judge', code.slice(code.indexOf('var picked = []'), code.indexOf('var order = picked')).indexOf('citedOnes') !== -1);
ok('an ignored record sinks but never leaves the page', /if \(prominent\[g\.id\] \|\| firsted\(g\) \|\| ignored\(g\)\)/.test(code));
// The links render from the payload's own array and nowhere else: the page must
// never parse a link line out of the passage text, or the two drift.
ok('the links render from the payload array', /function linkChips\(f\)/.test(code) && /var links = f\.links \|\| \[\];/.test(code));
ok('the chip preview is the target title and url', /prev\.appendChild\(el\('b', null, l\.title \|\| l\.to\)\)/.test(code) && /linkHref\(l\)/.test(code));
ok('the preview is a hover and focus style, not a fetch', /\.linkchip:hover \.linkprev,\.linkchip:focus-visible \.linkprev\{display:block\}/.test(PAGE));
ok('the page never parses a link line out of the text', code.indexOf("'- section:") === -1 && code.indexOf("'- ability:") === -1);
ok('the rerun keeps the caret order for the server', /if \(state\.keep\[id1\] !== false && positive\.indexOf\(id1\) !== -1\) kept\.push\(id1\)/.test(code));
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

// The pick: an explicit 'this passage answered it', or 'none of these', posted to
// its own route and written beside the question's random id. It is an ASSERTION,
// not the rerank's kept set, it is offered on every findings list whether or not
// the reader re-asks, and it waits for the trace it belongs to - a pick made
// while the prose is still being written must not be lost to a record that does
// not exist yet.
ok('the page posts the pick to its own route', /fetch\('\/rules\/answered'/.test(code));
ok('a pick names a record, or none of them', /none \? \{ id: state\.traceId, none: true \} : \{ id: state\.traceId, by: state\.pick \}/.test(code));
ok('the pick controls are phone-sized targets', /\.pickbtn\{min-height:44px/.test(PAGE) && /\.picknone\{min-height:44px/.test(PAGE));
ok('the pick is offered with findings and with none', (code.match(/pickRow\(state\)/g) || []).length, 2);
ok('the pick is not gated on the rerank selection', code.slice(code.indexOf('function pickRow'), code.indexOf('function findingsCard')).indexOf('selectable'), -1);
ok('a pick waits for the run that writes its trace', /if \(state\.runDone\) \{ state\.pickPending = false; postPick\(state\); \}/.test(code));
ok('one pick per question: a second replaces the first', /state\.pick = none \? 'none' : String\(by \|\| ''\)/.test(code));
const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.mjs'), 'utf8');
const unit = fs.readFileSync(path.join(__dirname, '..', 'src', 'unit-card.mjs'), 'utf8');
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
// The server side of the pick, where the server and trace text are in scope.
ok('the server exposes the pick route', server.indexOf("'/rules/answered'") !== -1 && server.indexOf('handleRulesAnswered') !== -1);
ok('the pick is written into the trace it names', server.indexOf('answeredTrace(id, { by, none })') !== -1 && traces.indexOf('export function answeredTrace') !== -1);
ok('the pick is checked against the findings the trace holds', traces.indexOf('(t.findings || []).some(f => f && f.id === by)') !== -1);
// The page can only name a finding the payload identifies. The rerank sends the
// kept ids back and the pick names a record id, and both are the record's own id:
// without it in the payload the page has a list it cannot name a record in.
const payloadAt = server.indexOf('const toPayload = list');
ok('the findings payload carries the record id both controls name', payloadAt !== -1 && server.slice(payloadAt, payloadAt + 900).indexOf('id: f.id') !== -1);
ok('a record pick and none replace each other', traces.indexOf('t.answeredNone = true;') !== -1 && traces.indexOf('t.answeredBy = by;') !== -1);
const promote = fs.readFileSync(path.join(__dirname, 'promote-traces.mjs'), 'utf8');
ok('the harvest prints the reader pick', promote.indexOf('const reader = readerPick(t);') !== -1 && promote.indexOf("console.log('reader: ' + reader)") !== -1);
ok('the harvest prints the rerank labels', promote.indexOf('rerankLabels(t)') !== -1 && promote.indexOf("console.log('labels: ' + labels)") !== -1);

// The server side of the rerank labels, where the server and trace text are in
// scope. The caret and the x go into the SAME trace as the question, through the
// same find-by-id patch as the thumb and the pick - no second store.
ok('the server exposes the labels route', server.indexOf("'/rules/labels'") !== -1 && server.indexOf('handleRulesLabels') !== -1);
ok('the labels are written into the trace they name', server.indexOf('labelsTrace(id, { positive') !== -1 && traces.indexOf('export function labelsTrace') !== -1);
ok('a label is checked against the findings the trace holds', traces.indexOf('new Set((t.findings || []).map(f => f && f.id))') !== -1);
ok('a named record the trace never showed is refused', traces.indexOf('if (positive.length || negative.length) return false;') !== -1);
// The links a finding carries are resolved from the record it points at, so the
// page's chips and the record's own links are one source. The resolver lives in
// unit-card.mjs, where the record card uses it too: one implementation, two
// callers, and neither can drift from the other.
ok('the findings payload carries the links', /links: resolveRecordLinks\(/.test(server));
ok('the link targets are resolved against the corpus', /const target = l && l\.to \? byId\.get\(l\.to\) : null;/.test(unit) && /if \(!target\) continue;/.test(unit));
ok('a link keeps the target anchor and url', /anchor: target\.anchor \|\| ''[\s\S]{0,60}url: target\.url \|\| ''/.test(unit));
ok('the record card resolves them through the same function', /links: resolveRecordLinks\(rec\.links, byId\)/.test(unit));

// Task-38: a lookup by name is answered from the header index before any model
// runs, and a miss falls through to the pipeline untouched. The set it is
// measured on was written BEFORE the module (tests/fixtures/rules-lookups.json);
// tests/test-lookup.mjs is the measurement.
ok('the page asks the header index first', /if \(!o\.keep && !o\.english && await lookupAnswer\(question\)\) return;/.test(code));
ok('a lookup opens the record without a model', /openRecord\(state, out\.record\.id\);/.test(code) && /setStatus\(t\('lookupFound'\), 'ok'\)/.test(code));
ok('and hides the marks there is no question to label', /state\.selectable = false;/.test(code) && /state\.findings = \[out\.record\];/.test(code));
ok('the server exposes the lookup route', server.indexOf("'/rules/lookup'") !== -1 && server.indexOf('handleRulesLookup') !== -1 && /lookupRecord\(q\)/.test(server));
// The route counters: the free route returns empty bodies under load, so /health
// publishes what the model route actually did - calls, empties, retries, recovered.
ok('the health payload publishes what the route did', server.indexOf('route: routeStats()') !== -1 && server.indexOf('routeStats') !== -1);
const corpusSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'rules-corpus.mjs'), 'utf8');
ok('and the counters count an empty body and a recovered retry', corpusSrc.indexOf('ROUTE_STATS.empty++') !== -1 && corpusSrc.indexOf('ROUTE_STATS.recovered++') !== -1);
ok('a lookup miss reports why it fell through', /reason: hit\.reason, candidates/.test(server));
ok('the route answers in the findings shape the page already renders', /kind: rec\.kind \|\| '',/.test(server) && /links: resolveRecordLinks\(rec\.links, corpusById\(\)\)/.test(server));
const lookupFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rules-lookups.json'), 'utf8'));
// The set predates the router and grew when the route learned the French tables
// (the six phrasings in the FR additions); the size still sits in the same band.
ok('the measurement set predates the router and is the size asked for', lookupFixture.lookups.length >= 20 && lookupFixture.lookups.length <= 60);
ok('it names nothing in the corpus several times', lookupFixture.lookups.filter(l => l.kind === 'none').length >= 5);
t('it is bilingual', new Set(lookupFixture.lookups.map(l => l.lang)).size, 2);

// Task-41: a card tap opens the record full screen, one shape for the four
// categories, with the same controls, a swipe through the findings, and the
// static wiki wired in on the same origin. Each is one edit from being undone
// and none is visible to an i18n check, so each is asserted structurally.
ok('a card tap opens the record', /openRecord\(state, f\.id\)/.test(code));
ok('the controls do not open it', code.indexOf(".closest('.fctl, .fdev, .flinks, .pickbtn, .ftitle')") !== -1);
ok('the whole card is the tap target', /\.fitem\.hero\{cursor:pointer\}/.test(PAGE));
ok('the record is a full-screen dialog', /el\('div', 'record hidden'\)/.test(code) && /setAttribute\('role', 'dialog'\)/.test(code));
ok('the record draws one shape for every category', /function renderRecord\(state\)/.test(code) && /recordKindLabel\(/.test(code));
// Slice 2 moved the dialog's body to the server's shared fragment, so the card
// branch is gone from renderRecord - and the CSV card view is still there for the
// question path that draws a card inline, which is a different surface.
ok('the unit category no longer draws its own card in the dialog', code.indexOf("body.appendChild(unitCardView(data.card))") === -1);
ok('but the CSV card view still exists for the question path', /function unitCardView\(/.test(code) && /state\.cardSlot\.appendChild\(unitCardView\(ev\.card\)\)/.test(code));
ok('the dialog fetches the one fragment instead', /'\/rules\/record\?id=' \+ encodeURIComponent\(id\) \+ '&format=html'/.test(code) && /frag\.innerHTML = fragHtml/.test(code));
ok('while a record with no fragment still shows the payload passage', /passageBody\(\{ passage: \(data && data\.text\) \|\| f\.passage/.test(code));
ok('and the links stay the dialog\'s own', /linkChips\(\{ links: \(data && data\.links/.test(code));
ok('the record carries the same three controls', /ctl\.appendChild\(findingControls\(state, f, isFirsted\(state, f\), isIgnored\(state, f\)\)\)/.test(code));
ok('and the dev toggle opens the same provenance line', /body\.appendChild\(findingMeta\(f\)\)/.test(code));
ok('a swipe moves through the findings', /addEventListener\('touchstart'/.test(code) && /addEventListener\('touchend'/.test(code) && /Math\.abs\(dx\) > 46 && Math\.abs\(dx\) > Math\.abs\(dy\)/.test(code) && /recordStep\(RECORD_STATE, dx < 0 \? 1 : -1\)/.test(code));
ok('the arrow keys move too', /e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'/.test(code));
// task-41's up/down swipe: vertical pages only at the scroll edge, so a long
// passage stays scrollable; horizontal is unchanged.
ok('an up/down swipe pages at the scroll edge', /recordAtEdge\(body, dy < 0\)/.test(code) && /recordStep\(RECORD_STATE, dy < 0 \? 1 : -1\)/.test(code));
ok('the edge test reads the body scroll, not the window', /function recordAtEdge\(box, forward\)/.test(code) && /box\.scrollTop \+ box\.clientHeight >= box\.scrollHeight - 2/.test(code) && /box\.scrollTop <= 2/.test(code));
ok('and the horizontal swipe still comes first', /if \(Math\.abs\(dx\) > 46 && Math\.abs\(dx\) > Math\.abs\(dy\)\) \{ recordStep\(RECORD_STATE, dx < 0 \? 1 : -1\); return; \}/.test(code));
ok('a swipe walks the order the list draws', /var order = heroOrder\(state\.findings, state\.cited, state\);/.test(code));
ok('the ends hold rather than wrap', /if \(next < 0 \|\| next >= order\.length\) return;/.test(code));
ok('the x is the top-right way back', /el\('button', 'recclose'/.test(code) && /\.recclose\{[^}]*width:44px/.test(PAGE));
ok('no horizontal scroll in the record', /\.recbody\{[^}]*overflow-x:hidden/.test(PAGE) && /\.recbody \*\{max-width:100%\}/.test(PAGE));
ok('the record body scrolls while the page behind does not', /body\.recopen\{overflow:hidden\}/.test(PAGE));
ok('the record is fetched once and cached', /if \(state\.recordCache && state\.recordCache\[id\]\) return;/.test(code) && /state\.recordCache\[id\] = out\.record;/.test(code));
ok('a failed record fetch leaves the passage readable', /the payload passage stays readable/.test(code));
ok('the record re-renders with the list on every mark', /function refresh\(state\)/.test(code) && /if \(!state \|\| !state\.recordId\) return;/.test(code));
// The wiki, on this origin: the page links to it, the server serves the render
// directory, and the route refuses a path that climbs out of it.
ok('the header links to the wiki', /id="wikinav" href="\/wiki\/"/.test(PAGE) && /wk\.textContent = t\('wikiNav'\)/.test(code));
ok('the record links to the wiki page when it has one', /wiki\.href = state\.recordWiki \|\| '\/wiki\/';/.test(code));
ok('the server serves the wiki render', server.indexOf("u.pathname.indexOf('/wiki/') === 0") !== -1 && server.indexOf('function handleWiki(') !== -1);
ok('and refuses a path outside it', /!abs\.startsWith\(root \+ path\.sep\)/.test(server));
ok('the record route exists', server.indexOf("'/rules/record'") !== -1 && server.indexOf('handleRulesRecord') !== -1 && /recordCard\(id, \{ corpora: corpora\(\), index: corpusById\(\) \}\)/.test(server));
ok('the route refuses an id the corpus does not hold', /if \(!record\) return fail\(res, 404/.test(server));
ok('the wiki page comes from the render map, never a second slug', /path\.join\(WIKI_DIR, 'map\.json'\)/.test(server));
ok('the render writes that map', fs.readFileSync(path.join(__dirname, '..', 'src', 'wiki-render.mjs'), 'utf8').indexOf("path.join(OUT, 'map.json')") !== -1);


// The layout of the question: the box grows with its text, the translation has
// its own box under it, and the retention line is in the body where a run cannot
// hide it. None of the three is visible to an i18n check and each is one edit
// away from being undone, so each is asserted structurally.
const formHtml = PAGE.slice(PAGE.indexOf('<form id="f">'), PAGE.indexOf('</form>'));
ok('the question box is a textarea, not a one-line input',
  formHtml.indexOf('<textarea id="q"') !== -1 && formHtml.indexOf('<input id="q"') === -1);
const growHelper = code.slice(code.indexOf('function growBox'), code.indexOf('function growQuestion'));
const growBlock = code.slice(code.indexOf('function growQuestion'), code.indexOf('function renderExamples'));
ok('one helper grows both boxes',
  code.indexOf('function growBox(box, cap)') !== -1
  && /function growQuestion\(\) \{ growBox\(\$\('#q'\), QCAPPX\); \}/.test(code)
  && /function growTranslation\(\) \{ growBox\(\$\('#tr'\), TRCAPPX\); \}/.test(code));
ok('the box grows to its scrollHeight', /box\.scrollHeight/.test(growHelper));
ok('and stops at the cap', /Math\.min\([^)]*cap\)/.test(growHelper));
// Each cap is one number in two places: the CSS max-height the box scrolls at,
// and the JS constant that stops the growth. The question box and the translation
// box are ONE rule now - the translation IS the question box - so there is one cap
// and both constants have to hold it.
function cssCaps(re) {
  const m = re.exec(PAGE);
  return m ? Array.from(m[1].matchAll(/max-height:(\d+)px/g)).map(x => Number(x[1])) : [];
}
const sharedCapCss = cssCaps(/textarea#q, textarea\.trbox\{([^}]*)\}/);
t('the question and translation caps are one rule', sharedCapCss.length, 1);
t('and both JS caps are that CSS number', [Number((/var QCAPPX = (\d+)/.exec(code) || [])[1]), Number((/var TRCAPPX = (\d+)/.exec(code) || [])[1])], [sharedCapCss[0], sharedCapCss[0]]);
ok('Enter asks and Shift+Enter adds a line',
  /e\.key !== 'Enter' \|\| e\.shiftKey/.test(growBlock) && /e\.preventDefault\(\)/.test(growBlock) && /ask\(\);/.test(growBlock));
const voiceBlock = code.slice(code.indexOf('rec.onresult'), code.indexOf('rec.onerror'));
ok('the voice transcript grows the box it types into',
  /box\.value = \(base \? base \+ ' ' : ''\) \+ text\.trim\(\);/.test(voiceBlock) && voiceBlock.indexOf('grow();') !== -1);
ok('an example chip grows the box', code.indexOf("$('#q').value = text; $('#q').focus(); growQuestion();") !== -1);
ok('the translation re-ask grows the box', /growQuestion\(\);\s*\n\s*ask\(\{ question: text, english: true \}\)/.test(code));

const headerHtml = PAGE.slice(PAGE.indexOf('<header>'), PAGE.indexOf('</header>'));
ok('the translation box sits under the question in the header',
  headerHtml.indexOf('id="trslot"') !== -1 && headerHtml.indexOf('id="trslot"') > headerHtml.indexOf('id="q"'));
ok('the translation event fills that box', /state\.translation = ev;[\s\S]{0,60}renderTranslation\(state\)/.test(code));
ok('the box is the server text through the same card', /slot\.appendChild\(translationCard\(tr\)\)/.test(code));
ok('it is no longer a results card', code.indexOf('state.rest.appendChild(translationCard') === -1);
ok('a new question clears it', /clearTranslation\(\);/.test(code));
ok('an empty translation draws no box',
  /var tr = state && state\.translation;\s*\n\s*if \(!tr \|\| !String\(tr\.translated \|\| ''\)\.trim\(\)\) \{ slot\.classList\.add\('hidden'\); return; \}/.test(code));
ok('the correction path re-asks in English', /ask\(\{ question: text, english: true \}\)/.test(code));
const trKeys = ['translationTitle', 'translationFrom', 'translationTo', 'translationNote', 'translationButton', 'translationTooShort'];
t('the translation labels exist in both languages', trKeys.filter(k => I18N.en[k] === undefined || I18N.fr[k] === undefined), []);

// Slice 1b, the three fixes Mandal asked for on the translation card. Each is one
// edit away from being undone and none is visible to an i18n check, so each is
// asserted structurally.
const trBlock = code.slice(code.indexOf('function translationCard'), code.indexOf('function renderTranslation'));
// 1. No visible note: the sentence that explained the box is the button's
// tooltip now, so a novice still finds it and the header loses the four lines.
ok('the translation card draws no visible note', trBlock.indexOf("el('div', 'note', t('translationNote'))") === -1);
ok('the note key is table-only, drawn nowhere', code.indexOf("t('translationNote')") === -1);
// 2. The box adapts to its text, through the question box's own helper, and it
// grows while the reader corrects it as well as when the card is drawn.
ok('the translation box grows through the shared helper', /ta\.addEventListener\('input', growTranslation\)/.test(trBlock));
ok('and is grown once the card is visible', /slot\.appendChild\(translationCard\(tr\)\);[\s\S]{0,180}growTranslation\(\);/.test(code));
ok('the box lost its fixed 64px height and its drag handle',
  /textarea#q, textarea\.trbox\{[^}]*min-height:40px/.test(PAGE) && /textarea#q, textarea\.trbox\{[^}]*resize:none/.test(PAGE)
  && /textarea#q, textarea\.trbox\{[^}]*overflow-y:auto/.test(PAGE) && !/\.trbox\{[^}]*min-height:64px/.test(PAGE));
// 3. The row mirrors the ask row - box, send, its own voice control - with one
// mark in front that is not a control. Nothing is drawn around it.
ok('the row is mark, box, send, voice, in that order',
  /el\('div', 'trrow'\)/.test(trBlock)
  && trBlock.indexOf('row.appendChild(mark)') < trBlock.indexOf('row.appendChild(ta)')
  && trBlock.indexOf('row.appendChild(ta)') < trBlock.indexOf('row.appendChild(send)')
  && trBlock.indexOf('row.appendChild(send)') < trBlock.indexOf('row.appendChild(mic)')
  && trBlock.indexOf("el('div', 'card')") === -1);
ok('the mark in front is a mark, not a control',
  /el\('span', 'trmark'\)/.test(trBlock) && /mark\.setAttribute\('aria-hidden', 'true'\)/.test(trBlock)
  && /\.trmark\{[^}]*color:var\(--dim\)/.test(PAGE) && /\.trmark svg\{[^}]*rotate\(45deg\)/.test(PAGE)
  && trBlock.indexOf("el('button', 'trmark')") === -1 && PAGE.indexOf('transsend') === -1);
ok('the row is the ask row shape', /\.trrow\{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap\}/.test(PAGE));
ok('the box keeps the question box min width so the row wraps instead of squeezing', /textarea#q, textarea\.trbox\{[^}]*min-width:260px/.test(PAGE));
ok('the box starts at one row, like the question box', /ta\.rows = 1;/.test(trBlock));

// Slice 1c: no heading, and the ask and the correction are one send control whose
// icon is its only visible label - the name (aria-label and tooltip) comes from
// the tables and the target is 44px.
ok('the translation draws no card at all around the box - it IS the question box',
  trBlock.indexOf('sectionCard(') === -1 && trBlock.indexOf("el('h2'") === -1
  && trBlock.indexOf("el('div', 'card')") === -1);
ok('the dead detected-language caption is gone', trBlock.indexOf('var from = ') === -1);
const goHtml = formHtml.slice(formHtml.indexOf('<button id="go"'), formHtml.indexOf('</button>', formHtml.indexOf('<button id="go"')));
ok('the main ask is the same send button',
  /class="sendbtn"/.test(goHtml) && /type="submit"/.test(goHtml) && goHtml.indexOf('>Ask<') === -1);
ok('the translation send is the same up-arrow control as the ask, after the box',
  /el\('button', 'sendbtn'\)/.test(trBlock) && /paintSend\(send, t\('translationButton'\)\)/.test(trBlock)
  && trBlock.indexOf('row.appendChild(ta)') < trBlock.indexOf('row.appendChild(send)'));
ok('and it has a voice control of its own, listening in English',
  /el\('button', 'mic'\)/.test(trBlock) && /paintMic\(mic, t\('voiceEnglish'\)\)/.test(trBlock)
  && /wireVoice\(mic, ta, function \(\) \{ return 'en-GB'; \}, growTranslation\)/.test(trBlock));
const sendBlock = code.slice(code.indexOf('var SEND_ICON'), code.indexOf('function applyLang'));
ok('one svg shape per control, each injected once',
  (sendBlock.match(/<svg /g) || []).length === 2 && /btn\.innerHTML = SEND_ICON/.test(sendBlock)
  && /btn\.innerHTML = MIC_ICON/.test(sendBlock));
ok('and only set when the button has no icon yet', /if \(!btn\.firstChild\) btn\.innerHTML = SEND_ICON;/.test(sendBlock));
ok('the label is an accessible name and a tooltip, never text',
  /btn\.setAttribute\('aria-label', label\)/.test(sendBlock) && /btn\.title = label/.test(sendBlock));
ok('both send buttons are painted with their own table key',
  /paintSend\(go, t\('ask'\)\)/.test(code) && /paintSend\(send, t\('translationButton'\)\)/.test(trBlock));
ok('the main button no longer writes its label as text', code.indexOf("go.textContent = t('ask')") === -1);
ok('the send control is a 44px target',
  /button\.sendbtn\{[^}]*width:44px/.test(PAGE) && /button\.sendbtn\{[^}]*height:44px/.test(PAGE));
ok('the main button keeps its disabled state during a run',
  /var btn = \$\('#go'\);\s*\n\s*btn\.disabled = true;/.test(code) && /btn\.disabled = false;/.test(code));
ok('the correction keeps its short-text guard', trBlock.indexOf("t('translationTooShort')") !== -1);
// Slice 4: the voice control is an icon with the name on its aria-label and
// tooltip; the language switch is chrome in the top bar; the mode choice is gone
// but the page still asks for the careful settings through 'mode'.
ok('the voice button is icon only, named by aria-label and tooltip',
  /id="mic" class="mic"[^>]*aria-label="Ask by voice"/.test(formHtml) && formHtml.indexOf('id="miclabel"') === -1
  && /button\.mic\{[^}]*width:44px/.test(PAGE) && /paintMic\(mb, t\('voice'\)\)/.test(code));
ok('the question microphone types into the question box in the page language',
  /wireVoice\(document\.getElementById\('mic'\), document\.getElementById\('q'\), function \(\) \{\s*\n\s*return LANG === 'fr' \? 'fr-FR' : 'en-GB';/.test(code)
  && code.indexOf('speechLocale') === -1);
ok('the language switch sits in the top bar, not under the question',
  headerHtml.indexOf('id="lang"') !== -1 && headerHtml.indexOf('id="lang"') < headerHtml.indexOf('<form id="f">'));
ok('the wiki box reaches the ask pipeline', /function askFromQuery\(\)/.test(code) && /\[\?&\]q=\(\[\^&\]\*\)/.test(code) && /box\.value = text;\s*\n\s*growQuestion\(\);\s*\n\s*ask\(\);/.test(code));
// task-22 brought the control back, for the judge's reasoning only: it must
// exist, default to fast, and state what it moves (test-ask-toggle.mjs pins the
// mapping against ASK_MODES).
ok('the judge fast/deep control is back and defaults to fast', /id="modeFast"[^>]*aria-pressed="true"/.test(PAGE) && /id="modeDeep"/.test(PAGE) && /var MODE = 'fast'/.test(PAGE));
ok('the page asks for the fast settings, the default', /var MODE = 'fast'/.test(code) && /mode: MODE/.test(code));
// The writer is off by default, so the page draws no answer: no card to wait in,
// no handler for an event that will not arrive, and no stage it could belong to.
ok('the page draws no answer card', code.indexOf('answerCard') === -1 && code.indexOf('state.answer = ') === -1);
ok('and handles no answer event', code.indexOf("ev.type === 'answer'") === -1 && code.indexOf("doneStage('answer'") === -1);
ok('and calls none of the answer strings', code.indexOf("t('writingAnswer')") === -1 && code.indexOf("t('answerFailed')") === -1 && code.indexOf("t('answerTitle')") === -1);
// The server decides the stages, and it leaves the answer out when the writer is
// off; the request can still turn the writer back on.
ok('the server gates the writer and its stage', /const writerOn = writerEnabled\(process\.env, body\.writer\)/.test(server) && /writerOn \? \['answer'\] : \[\]/.test(server) && server.indexOf('if (!writerOn) {') !== -1);
ok('and the payload says which one ran', /mode: modeName, writer: writerOn/.test(server));
t('the send and voice controls have names in both languages',
  ['ask', 'translationButton', 'voiceEnglish', 'stopListening'].filter(k => I18N.en[k] === undefined || I18N.fr[k] === undefined), []);

// The matching close of a div, so 'in the body' cannot mean 'inside the block a
// run hides'.
function closeOf(html, from) {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = from;
  let depth = 0, m;
  while ((m = re.exec(html)) !== null) {
    if (m[0] === '<div') depth++;
    else if (--depth === 0) return re.lastIndex;
  }
  return -1;
}
const mainAt = PAGE.indexOf('<main>');
const retentionAt = PAGE.indexOf('id="retention"');
const introAt = PAGE.indexOf('<div id="intro">');
const introEnd = closeOf(PAGE, introAt);
ok('the retention line is in the body', retentionAt > mainAt && retentionAt < PAGE.indexOf('</main>'));
ok('and outside the intro a run hides', introEnd > introAt && retentionAt > introEnd);
ok('nothing hides it', !/^.*retention.*(classList|add\('hidden'\))/m.test(code));
ok('its text is a table key, not a literal', code.indexOf("rt.textContent = t('retention')") !== -1);
t('the retention text exists in both languages', ['retention'].filter(k => I18N.en[k] === undefined || I18N.fr[k] === undefined), []);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
