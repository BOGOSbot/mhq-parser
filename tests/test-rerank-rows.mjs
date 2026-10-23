import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rejectedRows } from '../src/rules-corpus.mjs';

// Every finding the retrieval produced reaches the page, the rows the judge did NOT
// select included. The shape is one ordered list marked `selected`: the judged rows
// first, the rejected ones after them, and ONE control - put this passage first -
// moves a rejected row to the top where the card and the answer read it. This file
// holds that shape, so a rejected row cannot be dropped silently between the
// retrieval and the client.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SURFACE = fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(ROOT, 'src', 'rules.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');

// --- the shape the server emits ------------------------------------------------
const judged = [
  { id: 'emb', n: 1, set: 'rules', heading: 'Embarking', text: 'A unit can embark.', excerpt: 'A unit can embark.' },
  { id: 'move', n: 2, set: 'rules', heading: 'NORMAL MOVE', text: 'Move the unit.', excerpt: 'Move the unit.' },
];
const tail = [
  { id: 'shoot', set: 'rules', heading: 'Shooting Types', text: 'shooting.', excerpt: 'shooting.' },
  { id: 'dis', set: 'rules', heading: 'Disembarking', text: 'disembark.', excerpt: 'disembark.' },
];
const rej = rejectedRows(judged, tail, 20);
t('every row the retrieval did not select comes back', rej.map(f => f.id), ['shoot', 'dis']);
t('and each one is marked not selected', rej.map(f => f.selected), [false, false]);
t('the retrieval order is the order the page gets', rej.map(f => f.heading), ['Shooting Types', 'Disembarking']);
t('the numbering continues after the judged rows', rej.map(f => f.n), [3, 4]);
ok('a rejected row is the same finding shape the page already reads', rej.every(f => f.id && f.heading && f.text && f.excerpt));

// A row already judged is not shown twice, and the cap is the ONLY thing that drops
// one - it takes the tail, and it says how many it left.
t('a judged row is never repeated as rejected', rejectedRows(judged, judged.concat(tail), 20).map(f => f.id), ['shoot', 'dis']);
const many = Array.from({ length: 30 }, (_, i) => ({ id: 'r' + i, set: 'factions', heading: 'R' + i, text: 't', excerpt: 't' }));
t('without a cap nothing is dropped', rejectedRows(judged, many, 99).length, 30);
t('the cap is the only drop, and it takes the tail', rejectedRows(judged, many, 5).map(f => f.id), ['r0', 'r1', 'r2', 'r3', 'r4']);
t('and the default cap keeps a phone-sized list', rejectedRows([], many).length, 20);
t('an empty tail is an empty list', rejectedRows(judged, [], 20), []);
t('a tail row with no id is not a row', rejectedRows(judged, [{ heading: 'no id' }], 20), []);

// The server marks both halves with its own builders, and the event carries them.
ok('the server marks the judged rows selected',
  /const toPayload = list => rowPayload\(list, true\)/.test(SERVER)
  && /const toPayloadRejected = list => rowPayload\(list, false\)/.test(SERVER)
  && /selected: selected !== false/.test(SERVER));
ok('and the findings event carries the rejected rows beside the judged ones',
  /type: 'findings', findings: judgedRows, rejected: rejectedFrom\(dual, judgedRows\)/.test(SERVER));
ok('the JSON tail is the same helper, so the two shapes cannot drift',
  /const tail = rejectedFrom\(outcome\.dual, payload\)/.test(SERVER));
ok('the page merges the rejected rows into the one list it holds',
  /state\.findings = \(ev\.findings \|\| \[\]\)\.concat\(ev\.rejected \|\| \[\]\)/.test(PAGE));
ok('and the non-stream fallback carries the tail into the same merge',
  /rejected: j\.tail \|\| \[\]/.test(PAGE));

// --- the reader's order, driven, not just read ---------------------------------
// The pure half of the client, extracted the way test-rules-page extracts the row
// display and driven with a list of both kinds of row.
const fnSrc = name => {
  const at = SURFACE.indexOf('function ' + name + '(');
  if (at === -1) return '';
  let i = SURFACE.indexOf('{', at), depth = 0;
  for (; i < SURFACE.length; i++) {
    if (SURFACE[i] === '{') depth++;
    else if (SURFACE[i] === '}') { depth--; if (!depth) return SURFACE.slice(at, i + 1); }
  }
  return '';
};
const parts = ['byHalf', 'sortedFindings', 'isFirsted', 'isIgnored', 'heroOrder'].map(fnSrc);
ok('the client ordering helpers are pure blocks the test can drive', parts.every(s => s.length > 0));
const order = new Function(parts.join('\n') + '; return heroOrder;')();

const rows = [
  { id: 'a', n: 1, set: 'rules', rank: 1, heading: 'A', selected: true },
  { id: 'b', n: 2, set: 'rules', rank: 2, heading: 'B', selected: true },
  { id: 'c', n: 3, set: 'rules', rank: 1, heading: 'C', selected: false },
  { id: 'd', n: 4, set: 'factions', rank: 1, heading: 'D', selected: false },
];
const fresh = () => ({ selectable: true, rerun: false, positive: [], keep: {} });
t('the judged rows come first and the rejected after them', order(rows, [], fresh(), {}).map(f => f.id), ['a', 'b', 'c', 'd']);
t('a promote moves a rejected row to the top of the list', order(rows, [], { selectable: true, rerun: false, positive: ['d'], keep: {} }, {}).map(f => f.id), ['d', 'a', 'b', 'c']);
t('and the judge rows keep their own order under it', order(rows, [], { selectable: true, rerun: false, positive: ['d'], keep: {} }, {}).slice(1).map(f => f.id), ['a', 'b', 'c']);
t('the newest promote leads, so the order is the reader\'s', order(rows, [], { selectable: true, rerun: false, positive: ['c', 'd'], keep: {} }, {}).map(f => f.id), ['c', 'd', 'a', 'b']);
t('a promote on a judged row moves it too', order(rows, [], { selectable: true, rerun: false, positive: ['b'], keep: {} }, {}).map(f => f.id), ['b', 'a', 'c', 'd']);
t('an ignored row sinks but never leaves the page', order(rows, [], { selectable: true, rerun: false, positive: [], keep: { c: false } }, {}).map(f => f.id), ['a', 'b', 'd', 'c']);
t('and an ignored rejected row still does not vanish', order(rows, [], { selectable: true, rerun: false, positive: [], keep: { c: false, d: false } }, {}).map(f => f.id), ['a', 'b', 'c', 'd']);

// --- a rejected row is rendered, never hidden ----------------------------------
ok('the ledger renders the rejected group in the page flow',
  /if \(restRejected\.length\) card\.appendChild\(ledgerRejected\(restRejected, state, ctx\)\)/.test(SURFACE))
ok('and the collapse only keeps the judge\'s remaining rows',
  /card\.appendChild\(ledgerResidue\(restKept, state, ctx\)\)/.test(SURFACE) && !/card\.appendChild\(ledgerResidue\(rest, state, ctx\)\)/.test(SURFACE));
ok('the group is a section, not a collapsed details',
  /el\('section', 'rejgroup'\)/.test(SURFACE) && !/rejgroup[\s\S]{0,200}createElement\('details'\)/.test(SURFACE));
ok('every rejected row carries the one promote control',
  /function ledgerRejectedRow\(f, state, ctx\)/.test(SURFACE)
  && /put\.addEventListener\('click', function \(ev\) \{ ev\.preventDefault\(\); ev\.stopPropagation\(\); ctx\.toggleFirst\(state, f\.id\); \}\)/.test(SURFACE));
ok('the row is dimmed and labelled as not selected',
  PAGE.indexOf('.fitem.rej{opacity:.6') !== -1 && PAGE.indexOf('.rejlabel{') !== -1
  && /ctx\.t\('rejectedLabel'\)/.test(SURFACE) && /ctx\.t\('rejectedTitle'\)/.test(SURFACE));
ok('both labels exist in both languages',
  PAGE.indexOf("rejectedTitle: 'Not selected by the judge'") !== -1 && PAGE.indexOf("rejectedTitle: 'Non retenu par le juge'") !== -1
  && PAGE.indexOf("rejectedLabel: 'not selected'") !== -1 && PAGE.indexOf("rejectedLabel: 'non retenu'") !== -1
  && PAGE.indexOf("promoteRow: 'put this passage first'") !== -1 && PAGE.indexOf("promoteRow: 'mettre ce passage en tête'") !== -1);
// The second answer is written from the reader's order, and a rejected row is in it
// only because the reader put it there: the rest of the tail is not re-asked.
ok('the rerun keeps a promoted rejected row, in the reader\'s order',
  /isRejectedRow\(state, positive\[k0\]\) && state\.keep\[positive\[k0\]\] !== false/.test(SURFACE));
ok('and an unpromoted rejected row is not in the selection',
  /positive\.indexOf\(id2\) === -1 && !isRejectedRow\(state, id2\)/.test(SURFACE));
ok('the rerun button is for a changed selection, not for the tail being visible',
  /again\.disabled = !\(ignoredJudged > 0 \|\| promotedRejected > 0\) \|\| !kept\.length/.test(SURFACE));
ok('and a promoted id is named once, not twice',
  /var uniqueKeep = \[\];\n  for \(var ku = 0; ku < kept\.length; ku\+\+\) if \(uniqueKeep\.indexOf\(kept\[ku\]\) === -1\) uniqueKeep\.push\(kept\[ku\]\);/.test(SURFACE.replace(/\r\n/g, '\n')));
// The drawer surface's own list reads the same rule: the rejected rows are in one
// list with the judge's and carry their own promote.
ok('the drawer surface renders the same two kinds of row in one list',
  SURFACE.indexOf("el('div', 'sv-tail-row sv-tail-rejected')") !== -1
  && SURFACE.indexOf("el('button', 'sv-tail-put', 'Put first')") !== -1
  && /el\('span', 'sv-tail-rejlabel', 'not selected'\)/.test(SURFACE));
ok('and its promote re-renders that one list', /function promoteAsk\(id\)/.test(SURFACE) && /if \(at === -1\) state\.positive\.unshift\(id\); else state\.positive\.splice\(at, 1\);/.test(SURFACE));
ok('the drawer styles its rejected rows too', fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.css'), 'utf8').indexOf('.sv-tail-rejected{opacity:.62}') !== -1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;