import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordCard } from '../src/unit-card.mjs';

// The /rules page's own rules, checked where a reviewer cannot see them by hand:
// commit 864ad28 fixed one hardcoded English label ('Findings - N') that the
// French page showed among French ones, and the defect was invisible until a
// French reader looked at that exact card. Two structural checks catch the whole
// class: both language tables carry the same keys, and every t('...') key in the
// script exists in them. A third catches a fresh hardcoded label.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'src', 'rules.html'), 'utf8');
const SURFACE = fs.readFileSync(path.join(__dirname, '..', 'src', 'wiki-surface.js'), 'utf8');

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
  'cardReady', 'streamCut', 'citedByJudge', 'voteHelp', 'voteUp', 'voteDown',
  // task-24 (J4): the ruling's own lines and the ledger's.
  'rulingStart', 'rulingUnless', 'rulingTrace', 'findingsLedger', 'nearestPassages', 'quotedAbove', 'otherPassages', 'voteThanks',
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
// is the only fetch outside /rules/ask on the page. task-17 adds the voice
// transcription upload; it is the one other POST, and only when the mic is used.
const fetchCalls = Array.from(new Set(Array.from(PAGE.matchAll(/fetch\('([^']+)'/g)).map(m => m[1]))).sort();
// task-69 adds the ninth: the French body of one record, for the translation under the
// English quote. It is a GET of the overlay, not a second ask.
t('the page only fetches the nine routes it needs', fetchCalls, ['/health', '/rules/answered', '/rules/ask', '/rules/fr?id=', '/rules/labels', '/rules/lookup?q=', '/rules/record?id=', '/rules/voice', '/rules/vote']);

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
ok('the fragment links are NOT rebased: the address is the slug', code.indexOf('wikiHrefs') === -1 && fs.readFileSync(path.join(__dirname, '..', 'src', 'server.mjs'), 'utf8').indexOf("return slug ? '#' + slug : '';") !== -1);
ok('while the dialog keeps its shell: marks, chips, wiki link, swipe',
  ['window.WIKI_SURFACE_API.controls(state, f, PAGE_CTX)', "el('a', 'recwiki', t('recordWiki'))", "el('h3', null, t('recordLinks'))", "el('p', 'recswipe', t('recordSwipe'))"].every(function (s) { return code.indexOf(s) !== -1; }));
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
ok('the card takes the cited passages', /function findingsCard\(findings, counts, cited, state, ctx\)/.test(SURFACE));
ok('the union keeps the top five and promotes the cited ones', /i < 5 \|\| isCited\(findings\[i\]\)/.test(SURFACE));
ok('a cited finding is badged and shown whole', /if \(cited\) head\.appendChild\(el\('span', 'leg cite'/.test(SURFACE));
// task-24 (J4): the ruling names its source BY TITLE, with the section path
// beside it, and that name is the link to the passage.
ok('the ruling links its source by title', /function sourceLine/.test(code) && /leafOf\(f\.heading\)/.test(code) && /openPassage\(f\)/.test(code));
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
ok('each finding is a hero card with its own caret and x', /el\('button', 'herocaret'/.test(SURFACE) && /el\('button', 'herox'/.test(SURFACE) && /'fitem hero'/.test(SURFACE));
ok('the caret is a positive example in the same trace as the question', code.indexOf('state.positive.unshift(id)') !== -1 && code.indexOf('postLabels(state)') !== -1);
ok('the x is a negative example in the same trace as the question', /negative: state\.shownIds\.filter/.test(code));
// They are posted the moment they are made: the trace is written when the answer
// lands, and the server holds the mark for it, so a reader who leaves early still
// leaves the label the dataset wants.
ok('the caret and the x are posted the moment they are made', /function markLabels\(state\) \{[\s\S]{0,80}postLabels\(state\);/.test(code));
t('and nothing waits for the run to end any more', code.indexOf('labelsPending'), -1);
ok('a widening cannot undo the reader\'s marks', /state\.keep\[sid\] = prevKeep\[sid\] !== false;/.test(code));
ok('the dev toggle opens the whole passage and its indicators', /function devPanel\(f, state, ctx\)/.test(SURFACE) && SURFACE.indexOf("t('foundBy')") !== -1 && /ctx\.passageBody\(f\)/.test(SURFACE) && SURFACE.indexOf("t('rankScore')") !== -1);
ok('the card shows one line at rest', /\.heroline\{white-space:nowrap;overflow:hidden;text-overflow:ellipsis\}/.test(PAGE));
ok('the caret is green and a phone-sized target', /\.herocaret\{color:var\(--ok\)/.test(PAGE) && /\.fctl button\{[^}]*min-height:44px/.test(PAGE));
ok('the judge citations and the reader picks both resort the list', /picked\.concat\(citedOnes, rest, dropped\)/.test(SURFACE) && /picked\.sort\(/.test(SURFACE));
ok('and the reader wins over the judge', SURFACE.slice(SURFACE.indexOf('var picked = []'), SURFACE.indexOf('var order = picked')).indexOf('citedOnes') !== -1);
ok('an ignored record sinks but never leaves the page', /if \(prominent\[g\.id\] \|\| firsted\(g\) \|\| ignored\(g\)\)/.test(SURFACE));
// The links render from the payload's own array and nowhere else: the page must
// never parse a link line out of the passage text, or the two drift.
ok('the links render from the payload array', /function linkChips\(f\)/.test(code) && /var links = f\.links \|\| \[\];/.test(code));
ok('the chip preview is the target title and url', /prev\.appendChild\(el\('b', null, l\.title \|\| l\.to\)\)/.test(code) && /linkHref\(l\)/.test(code));
ok('the preview is a hover and focus style, not a fetch', /\.linkchip:hover \.linkprev,\.linkchip:focus-visible \.linkprev\{display:block\}/.test(PAGE));
ok('the page never parses a link line out of the text', code.indexOf("'- section:") === -1 && code.indexOf("'- ability:") === -1);
ok('the rerun keeps the caret order for the server', /if \(state\.keep\[id1\] !== false && positive\.indexOf\(id1\) !== -1\) kept\.push\(id1\)/.test(SURFACE));
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
ok('the pick is offered with findings and with none', (SURFACE.match(/pickRow\(state, ctx\)/g) || []).length, 2);
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
// task-28: the instant lookup is a row like any other - it opens the door the
// setting names (In the book: the drawer; Quick read: the record view), not a
// bespoke surface.
ok('a lookup opens the door, without a model', /openDoor\(state, out\.record\);/.test(code) && /setStatus\(t\('lookupFound'\), 'ok'\)/.test(code) && code.indexOf('unitCardView(ev.card)') !== -1);
ok('the door honours both settings', /function openDoor\(state, f\)[\s\S]{0,220}if \(doorMode\(\) === 'inline'\) openInline\(state, f\);\s*else openPage\(state, f\)/.test(code));

// --- task-28: the explainer is gone, the M value is centred ------------------
ok('no How this works control in either language', I18N.en.howto === undefined && I18N.fr.howto === undefined && I18N.en.intro === undefined && I18N.fr.intro === undefined && code.indexOf('howtosum') === -1 && code.indexOf('introtext') === -1);
ok('the browse line and its books stay', code.indexOf("$('#browse')") !== -1 && code.indexOf('renderBrowse') !== -1);
ok('the M value is explicitly centred in its chip', /\.stat \.v\{[^}]*text-align:center/.test(PAGE));
ok('and hides the marks there is no question to label', /state\.selectable = false;/.test(code) && /state\.findings = \[out\.record\];/.test(code));
// task-110: the lookup waits for Ask. task-67 also fired it from an input
// listener with a 250 ms debounce, so a bare name drew its card while the reader
// was still typing it. The call site is the ask path and nothing else; these two
// assertions fail if a keystroke path comes back.
t('(110) the lookup has one call site, the ask path', (code.match(/lookupAnswer\(/g) || []).length, 2);
ok('(110) no keystroke listener survives for it', code.indexOf('lookupTimer') === -1 && code.indexOf('lastLookup') === -1);
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
ok('a card tap opens the door the switch names', /ctx.openDoor\(state, f\)/.test(SURFACE));
ok('the sheet and the path do not re-open it themselves', SURFACE.indexOf(".closest('.fmore, .fpath, .fdev, .flinks, .pickbtn, .ftitle')") !== -1);
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
ok('the record carries the same three controls', /ctl\.appendChild\(window\.WIKI_SURFACE_API\.controls\(state, f, PAGE_CTX\)\)/.test(code));
ok('and the dev toggle opens the same provenance line', /body\.appendChild\(window\.WIKI_SURFACE_API\.meta\(f, PAGE_CTX\)\)/.test(code));
ok('a swipe moves through the findings', /addEventListener\('touchstart'/.test(code) && /addEventListener\('touchend'/.test(code) && /Math\.abs\(dx\) > 46 && Math\.abs\(dx\) > Math\.abs\(dy\)/.test(code) && /recordStep\(RECORD_STATE, dx < 0 \? 1 : -1\)/.test(code));
ok('the arrow keys move too', /e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'/.test(code));
// task-41's up/down swipe: vertical pages only at the scroll edge, so a long
// passage stays scrollable; horizontal is unchanged.
ok('an up/down swipe pages at the scroll edge', /recordAtEdge\(body, dy < 0\)/.test(code) && /recordStep\(RECORD_STATE, dy < 0 \? 1 : -1\)/.test(code));
ok('the edge test reads the body scroll, not the window', /function recordAtEdge\(box, forward\)/.test(code) && /box\.scrollTop \+ box\.clientHeight >= box\.scrollHeight - 2/.test(code) && /box\.scrollTop <= 2/.test(code));
ok('and the horizontal swipe still comes first', /if \(Math\.abs\(dx\) > 46 && Math\.abs\(dx\) > Math\.abs\(dy\)\) \{ recordStep\(RECORD_STATE, dx < 0 \? 1 : -1\); return; \}/.test(code));
ok('a swipe walks the order the list draws', /var order = window\.WIKI_SURFACE_API\.findingOrder\(state\.findings, state\.cited, state, PAGE_CTX\);/.test(code));
ok('the ends hold rather than wrap', /if \(next < 0 \|\| next >= order\.length\) return;/.test(code));
ok('the x is the top-right way back', /el\('button', 'recclose'/.test(code) && /\.recclose\{[^}]*width:44px/.test(PAGE));
ok('no horizontal scroll in the record', /\.recbody\{[^}]*overflow-x:hidden/.test(PAGE) && /\.recbody \*\{max-width:100%\}/.test(PAGE));
ok('the record body scrolls while the page behind does not', /body\.recopen\{overflow:hidden\}/.test(PAGE));
ok('the record is fetched once and cached', /if \(state\.recordCache && state\.recordCache\[id\]\) return;/.test(code) && /state\.recordCache\[id\] = out\.record;/.test(code));
ok('a failed record fetch leaves the passage readable', /the payload passage stays readable/.test(code));
ok('the record re-renders with the list on every mark', /function refresh\(state\)/.test(code) && /if \(!state \|\| !state\.recordId\) return;/.test(code));
// The wiki, on this origin: the page links to it, the server serves the render
// directory, and the route refuses a path that climbs out of it.
ok('the header carries the Wiki control that opens the drawer', /id="wikinav"/.test(PAGE) && /wk\.textContent = t\('wikiNav'\)/.test(code));
// task-77: the record's deep link is the finding's slug (the surface answers #<slug>),
// and only a record with no slug falls back to the old wiki address.
ok('the record deep-links to the slug when it has one', /deepSlug \? '#' \+ deepSlug/.test(code) && /wiki\.href = deepSlug/.test(code));
ok('the server no longer serves /wiki', server.indexOf("u.pathname.indexOf('/wiki/')") === -1 && server.indexOf('handleWiki(') === -1);
ok('and refuses a path outside it', server.indexOf('no such payload') !== -1 && server.indexOf('index\\/[a-z0-9-]') !== -1);
ok('the record route exists', server.indexOf("'/rules/record'") !== -1 && server.indexOf('handleRulesRecord') !== -1 && /recordCard\(id, \{ corpora: corpora\(\), index: corpusById\(\) \}\)/.test(server));
ok('the route refuses an id the corpus does not hold', /if \(!record\) return fail\(res, 404/.test(server));
ok('the record address is the payload slug, never a second map', /slug: surfaceSlugMap\(\).get\(id\)/.test(server) && server.indexOf('map.json') === -1);



// task-23: a finding row is titled with the record, not with the section it hangs
// under. The helper is pure and lives between markers so it can be driven here
// with the capture's own headings; the row then prints it, and the path stops
// before it so the question is not printed twice.
const rnStart = SURFACE.indexOf('// --- task-23 row name');
const rnEnd = SURFACE.indexOf('// --- end task-23 row name');
ok('the row-name helper is a pure block the test can drive', rnStart !== -1 && rnEnd > rnStart);
const rowName = new Function(SURFACE.slice(rnStart, rnEnd) + '; return rowName;')();
const FAQ_Q = 'If a rule says my unit must make a hazard roll does every model in the unit make a hazard roll?';
const FAQ_PATH = ['Muster Armies', 'Fill Your Army Roster', 'FAQ', FAQ_Q, 'FALL-BACK MOVE'];
const ONESHOT_PATH = ['[ONE SHOT]', 'FAQ', 'Q: ' + FAQ_Q, 'FALL-BACK MOVE'];
const NESTED = ['Movement Phase', '3. End of Movement Phase', '09.05.01 More Than One Normal Move in a Phase', 'FALL-BACK MOVE'];
t('an FAQ row is named by its own question', rowName(FAQ_PATH), { name: FAQ_Q, at: 3 });
t('a one-shot FAQ row keeps the source own question label', rowName(ONESHOT_PATH), { name: 'Q: ' + FAQ_Q, at: 2 });
t('a nested rule keeps its own name', rowName(NESTED), { name: 'FALL-BACK MOVE', at: 3 });
t('a bare name keeps its own name', rowName(['FALL-BACK MOVE']), { name: 'FALL-BACK MOVE', at: 0 });
t('a datasheet row keeps its own name', rowName(['Datasheets', 'Tyrannofex']), { name: 'Tyrannofex', at: 1 });
t('a question that IS the name is not mistaken for a section', rowName(['Other Concepts', 'Hazard Rolls', 'Q: I failed hazard rolls?']), { name: 'Q: I failed hazard rolls?', at: 2 });
ok('the three rows above print three distinct titles',
  new Set([rowName(NESTED).name, rowName(FAQ_PATH).name, rowName(ONESHOT_PATH).name].map(function (s) { return s.toLowerCase(); })).size === 3);
t('a leaf that restates a segment above it is not the name', rowName(['Muster Armies', 'FAQ', 'Some Rule', 'Some Rule']).name, 'FAQ');
ok('the row prints the helper name and the path stops before it',
  /var named = rowName\(parts\);[\s\S]{0,200}displayTitle\(named\.name/.test(SURFACE) && /var above = parts\.slice\(0, named\.at >= 0 \? named\.at : parts\.length - 1\)/.test(SURFACE));
ok('the drawer and record header name the record too', /function titleOf\(rec\) \{[\s\S]{0,320}rowName\(String\(rec\.heading\)\.split\(' > '\)\.filter\(Boolean\)\)\.name/.test(SURFACE) && /if \(rec\.title\) return rec\.title;/.test(SURFACE));
// The same rule, on the server, is what the drawer and the record header read:
// /rules/record's title and crumb must name the record too, or the row and the
// sheet disagree. Driven with the same headings as the client helper above.
const mk = (id, heading) => ({ id: id, heading: heading, kind: 'rule', set: 'rules', source: 'core-rules', text: '' });
const cardFor = heading => recordCard('core-rules#X', { index: new Map([['core-rules#X', mk('core-rules#X', heading)]]) });
t('the record header names the FAQ by its question', cardFor(FAQ_PATH.join(' > ')).title, FAQ_Q);
t('the record breadcrumb stops before the question', cardFor(FAQ_PATH.join(' > ')).crumb, ['Muster Armies', 'Fill Your Army Roster', 'FAQ']);
t('the record header keeps a nested rule own name', cardFor(NESTED.join(' > ')).title, 'FALL-BACK MOVE');
t('the record breadcrumb keeps a nested rule path', cardFor(NESTED.join(' > ')).crumb, ['Movement Phase', '3. End of Movement Phase', '09.05.01 More Than One Normal Move in a Phase']);
t('the record header keeps a datasheet name', cardFor('Datasheets > Tyrannofex').title, 'Tyrannofex');
ok('the client and server name a record the same way',
  rowName(FAQ_PATH).name === cardFor(FAQ_PATH.join(' > ')).title && rowName(NESTED).name === cardFor(NESTED.join(' > ')).title);
// task-26: the ledger renders the same derivation - one helper, driven here with
// the same headings as the tree row above and the record header above it. This is
// the regression the Lead found on the live Box: four ledger rows titled
// 'Fall-Back Move' with the question stranded in the path.
const fnSrc = name => {
  const at = SURFACE.indexOf('function ' + name + '(');
  let i = SURFACE.indexOf('{', at), depth = 0;
  for (; i < SURFACE.length; i++) {
    if (SURFACE[i] === '{') depth++;
    else if (SURFACE[i] === '}') { depth--; if (!depth) return SURFACE.slice(at, i + 1); }
  }
  return '';
};
const rdStart = SURFACE.indexOf('// --- task-26 row display');
const rdEnd = SURFACE.indexOf('// --- end task-26 row display');
ok('the row-display helper is a pure block the test can drive', rdStart !== -1 && rdEnd > rdStart);
const rowDisplay = new Function(['displayTitle', 'shortName', 'pathParts', 'rowName', 'rowDisplay'].map(fnSrc).join('\n') + '; return rowDisplay;')();
t('the ledger names the FAQ row by its own question', rowDisplay(FAQ_PATH), { name: FAQ_Q, path: ['Muster Armies', 'Fill Your Army Roster', 'FAQ'], at: 3 });
t('the ledger names the one-shot row by its own question', rowDisplay(ONESHOT_PATH), { name: 'Q: ' + FAQ_Q, path: ['[ONE SHOT]', 'FAQ'], at: 2 });
t('the ledger path stops before the question', rowDisplay(FAQ_PATH).path.join(' \u203a '), 'Muster Armies \u203a Fill Your Army Roster \u203a FAQ');
t('the ledger agrees with the record header', rowDisplay(FAQ_PATH).name, cardFor(FAQ_PATH.join(' > ')).title);
t('and with the tree row name', rowDisplay(FAQ_PATH).name, rowName(FAQ_PATH).name);
ok('the ledger uses that one helper for its name and its path', /function ledgerName\(f\) \{ return rowDisplay\(f\.heading\)\.name/.test(SURFACE) && /function ledgerPath\(f\) \{ return rowDisplay\(f\.heading\)\.path/.test(SURFACE));
ok('and the page source line asks for the same object', /api\.rowDisplay/.test(code));


// The layout of the question: the box grows with its text, the translation has
// its own box under it, and the retention line is in the body where a run cannot
// hide it. None of the three is visible to an i18n check and each is one edit
// away from being undone, so each is asserted structurally.
const formHtml = PAGE.slice(PAGE.indexOf('<form id="f">'), PAGE.indexOf('</form>'));
ok('the question box is a textarea, not a one-line input',
  formHtml.indexOf('<textarea id="q"') !== -1 && formHtml.indexOf('<input id="q"') === -1);
const growHelper = code.slice(code.indexOf('function growBox'), code.indexOf('function growQuestion'));
const growBlock = code.slice(code.indexOf('function growQuestion'), code.indexOf('function openWikiBranch'));
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
// task-2: the landing page carries no example-question chips. Three separate
// shapes of the same return - markup, CSS and the i18n arrays - plus the renderer.
t('(2) no example chips in the markup or the styles', [PAGE.indexOf('id="examples"'), PAGE.indexOf('.examples{')].filter(x => x !== -1), []);
t('(2) no example prompts in either language table', [I18N.en.examples, I18N.fr.examples].filter(x => x !== undefined), []);
t('(2) the chip renderer is gone', [code.indexOf('renderExamples')].filter(x => x !== -1), []);
ok('the translation re-ask grows the box', /growQuestion\(\);\s*\n\s*ask\(\{ question: text, english: true \}\)/.test(code));

// task-22: a correction clicked while a run is in flight is queued, not pasted
// into #q and dropped on ask()'s busy guard. The pins are the order that makes
// that true: the busy branch returns BEFORE #q is written, there is one slot, the
// queued state is drawn on the card, and ask()'s finally launches it.
const trSend = code.slice(code.indexOf("send.addEventListener('click'"), code.indexOf('// This box holds English'));
ok('the translation send checks the run before touching #q',
  /if \(busy\) \{ queueCorrection\(text\); return; \}/.test(trSend) && trSend.indexOf('queueCorrection(text)') < trSend.indexOf("$('#q').value = text"));
ok('one queued correction, a second click replacing the first',
  /var PENDING = null;/.test(code) && /function queueCorrection\(question\) \{\s*\n\s*PENDING = \{ question: question, english: true \};/.test(code));
ok('the queued correction keeps the English flag the card asked with',
  /ask\(\{ question: queued\.question, english: queued\.english === true \}\)/.test(code));
ok('the queue is launched only when the run finishes',
  /finally \{[\s\S]{0,700}var queued = PENDING;[\s\S]{0,240}if \(queued\) \{[\s\S]{0,200}ask\(\{ question: queued\.question/.test(code));
ok('the queued state is on the card, not only in the status line',
  /function paintQueued\(\)/.test(code) && /t\('correctionQueuedCard'\)/.test(code) && /\.trqueue\{/.test(PAGE) && /\.trrow\.queued\{/.test(PAGE));
ok('the queued status is stated in the reader\'s language', /correctionQueued: '/.test(PAGE) && /correctionQueuedCard: '/.test(PAGE));
ok('ask() still refuses a second concurrent run', /async function ask\(over\) \{\s*\n\s*if \(busy\) return;/.test(code));

const headerHtml = PAGE.slice(PAGE.indexOf('<header>'), PAGE.indexOf('</header>'));
// The ask moved from the sticky header into the page body: the question is the page.
const askHtml = PAGE.slice(PAGE.indexOf('<main>'), PAGE.indexOf('</main>'));
ok('the translation box sits under the question',
  askHtml.indexOf('id="trslot"') !== -1 && askHtml.indexOf('id="trslot"') > askHtml.indexOf('id="q"')
  && askHtml.indexOf('id="trslot"') < askHtml.indexOf('id="result"'));
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
ok('the row is the ask row shape', /\.trrow\{display:flex[^}]*flex-wrap:wrap/.test(PAGE));
ok('the box can shrink, so the icons never push the page sideways', /textarea#q, textarea\.trbox\{[^}]*min-width:0[;}]/.test(PAGE));
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

// --- task-36: the landing page's find box ------------------------------------
// Mandal asked for a lexical search box on the landing page that sends to the wiki with
// its search pre-filled. The design rule that matters: it is a DOOR, not a second
// pipeline, so the page owns the box and the drawer owns the field, the search and the
// route. These pins hold that split.
const findHtml = PAGE.slice(PAGE.indexOf('<section class="findwrap">'), PAGE.indexOf('</section>', PAGE.indexOf('<section class="findwrap">')));
ok('the landing page carries the find box with its own field, mic and send',
  findHtml.indexOf('id="fq"') !== -1 && findHtml.indexOf('id="fmic"') !== -1 && findHtml.indexOf('id="fgo"') !== -1);
ok('and a line saying what it does', /class="findhint" id="findhint"/.test(findHtml));
ok('it sits after the ask composer and before the browse links',
  PAGE.indexOf('class="askwrap"') < PAGE.indexOf('class="findwrap"') && PAGE.indexOf('class="findwrap"') < PAGE.indexOf('id="intro"'));
ok('the find microphone is the same voice path and the same language switch',
  /wireVoice\(document\.getElementById\('fmic'\), document\.getElementById\('fq'\), function \(\) \{\s*\n\s*return LANG === 'fr' \? 'fr-FR' : 'en-GB';/.test(code));
ok('and it has no box to grow, so its grow callback is a no-op', /\}, function \(\) \{\}\);/.test(code));
// The handoff: the page passes the typed name to the drawer and does nothing else.
ok('submitting hands the name to the drawer', /WIKI_SURFACE_API\.find\) window\.WIKI_SURFACE_API\.find\(name\)/.test(code));
// The page must not grow its own route for this: the drawer owns /rules/find, and the
// only URL the page builds for a find is none at all. (The page does carry a comment
// naming the route, and it has its own /rules/lookup?q= for the instant lookup, so the
// test is about the FIND BLOCK rather than about the file.)
ok('the find block builds no URL of its own', code.slice(code.indexOf('function wireFind'), code.indexOf('function wireFind') + 800).indexOf('http') === -1);
ok('and the find path fetches nothing of its own', code.slice(code.indexOf('function wireFind'), code.indexOf('function wireFind') + 700).indexOf('fetch(') === -1);
ok('an empty submit keeps the reader in the box', /if \(!name\) \{ if \(box\) box\.focus\(\); return; \}/.test(code));
// Four strings, both languages: the existing parity test would catch a missing key, and
// this catches a key that is in the tables but never painted.
for (const k of ['findPlaceholder', 'find', 'findVoice', 'findHint']) {
  ok('the find box has ' + k + ' in both languages', !!I18N.en[k] && !!I18N.fr[k]);
}
ok('and applyLang paints all four', /t\('findPlaceholder'\)/.test(code) && /paintSend\(fgo, t\('find'\)\)/.test(code) && /paintMic\(fmic, t\('findVoice'\)\)/.test(code) && /t\('findHint'\)/.test(code));
ok('the find send is not the page second filled button', /\.findwrap button\.sendbtn\{[^}]*background:var\(--panel2\)/.test(PAGE));
ok('the language switch sits in the top bar, not under the question',
  headerHtml.indexOf('id="lang"') !== -1 && PAGE.indexOf('id="lang"') < PAGE.indexOf('<form id="f">'));
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


// --- task-80: one findings renderer, and it is not on this page ----------------
// The page's copy was deleted and the surface's renderer is the only one; a future
// edit that pastes it back fails here rather than in a screenshot review.
const moved = ['findingsCard', 'findingItem', 'findingControls', 'findingMeta', 'devPanel', 'sortedFindings', 'heroOrder', 'pickRow', 'isFirsted', 'isIgnored'];
t('(80) no moved findings identifier is defined on the page', moved.filter(n => PAGE.indexOf('function ' + n + '(') !== -1), []);
t('(80) the surface defines every moved renderer', moved.filter(n => SURFACE.indexOf('function ' + n + '(') === -1), []);
ok('(80) the page renders findings through the surface API', PAGE.indexOf('window.WIKI_SURFACE_API') !== -1 && PAGE.indexOf('api.findings(state.findingSlot, state, PAGE_CTX)') !== -1);
ok('(80) the surface exposes the findings entry points', ['findings:', 'findingOrder:', 'controls:', 'meta:'].every(k => SURFACE.indexOf(k) !== -1));
ok('(80) the page keeps the concerns that are not finding rendering', ['function sectionCard(', 'function markTerms(', 'function linkChips(', 'function passageBody('].every(k => PAGE.indexOf(k) !== -1));
ok('(80) the page still receives the same findings fields', PAGE.indexOf('state.findings') !== -1 && PAGE.indexOf('state.counts') !== -1 && PAGE.indexOf('state.cited') !== -1);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
