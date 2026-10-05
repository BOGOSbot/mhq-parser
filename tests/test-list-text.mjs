import fs from 'node:fs';
import { parseListText, listStartIndexes, isUnrecognizedFormat, playerWarnings, getMeta, totals, nameFromFile } from '../parse.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, cond, detail) {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (detail ? ' - ' + detail : '')); }
}
function throws(name, fn, want) {
  try { fn(); fail++; console.log('FAIL ' + name + '\n  want: throw "' + want + '"\n  got : no throw'); }
  catch (e) {
    const msg = String((e && e.message) || e);
    if (msg === want) pass++;
    else { fail++; console.log('FAIL ' + name + '\n  got : "' + msg + '"\n  want: "' + want + '"'); }
  }
}

const fix = f => fs.readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8');
const example = fix('list-example.txt');
// 42 real lists, kept whole: the body of each, and what it should parse to. The
// blob below is assembled from them rather than stored twice, so the test can
// both concatenate them and feed them in one at a time without re-splitting the
// blob by hand - which would be a second, weaker implementation of the splitter.
const corpus = JSON.parse(fix('lists.json'));
const blob = corpus.map(r => r.body).join('\n\n');
const sig = p => JSON.stringify({ n: p.units.length, pts: p.units.map(u => [u.points, u.model]) });
const oneOf = s => parseListText(s, { name: 'x' }).output;
const sigOf = s => sig(oneOf(s).players[0]);

// --- one list, on its own ---------------------------------------------------
// The example the request came with: a newrecruit export with a "+++" header, no
// PLAYER NAME, and a footer. 21 units, 2000 points, no warnings.
const one = parseListText(example, { name: 'beer clowns.txt' }).output;
t('single: one army', one.count, 1);
t('single: event name from the file', one.event.name, 'beer clowns');
t('single: units', one.players[0].units.length, 21);
t('single: totals', totals(one.players[0]), { parsedPts: 2000, declaredPts: 2000 });
t('single: no warnings', playerWarnings(one.players[0], getMeta(one.players[0])), []);
t('single: faction from the header', one.players[0].faction, 'Xenos - Aeldari');
// No PLAYER NAME in the file and no banner, so the chain bottoms out.
t('single: unnamed falls back to "Not found"', one.players[0].name, 'Not found');
// A paste has no file, so it names itself rather than falling back to a slug.
t('single: a paste has no file name', parseListText(example, {}).output.event.name, 'Pasted lists');
// The footer is not a unit and must not appear in the raw text panel.
ok('single: the footer is stripped', !one.players[0].bodyRest.includes('Created with newrecruit'));

// --- one list must never come apart -----------------------------------------
// The worst failure available: a pasted list that splits. Each corpus list is
// offered on its own, so a signal that fires inside a real army shows up here
// rather than on someone's screen.
const shredded = corpus.filter(r => listStartIndexes(r.body.split('\n')).length > 1);
t('safety: no corpus list is split', shredded.map(r => r.source), []);
t('safety: every corpus list parses as one', corpus.filter(r => oneOf(r.body).count !== 1).length, 0);

// --- several lists in one file ----------------------------------------------
// 42 real lists concatenated with a single blank line between them - the hardest
// case, because a blank line carries no meaning of its own and every one of
// those lists contains blank lines of its own.
const many = parseListText(blob, { name: 'lists.txt' }).output;
t('multi: slices', many.count, 40);
ok('multi: never more slices than lists', many.count <= corpus.length, many.count + ' > ' + corpus.length);

// Most slices are exactly one corpus list, parsed the same way it parses alone.
const known = corpus.map(r => sigOf(r.body));
const found = many.players.filter(p => known.includes(sig(p)));
t('multi: slices that are exactly one corpus list', found.length, 39);
// Format and totals must agree too. An empty slice is left out: its signature
// is {0 units}, which two different lists in the corpus share, and its format
// label is decided by whichever marker the surrounding text happened to match.
// A list with no units is flagged Unrecognized format either way.
const bad = found.filter(p => p.units.length > 0).filter(p => {
  const m = corpus.find(r => sigOf(r.body) === sig(p));
  const t2 = totals(p);
  return m.units !== p.units.length || m.parsedPts !== t2.parsedPts || m.format !== p.format;
});
t('multi: and parsed identically to their standalone parse', bad.map(p => p.name), []);
// The known limitation. Three lists carry no start marker the splitter can read
// - two Ironbuilt exports, and one keyed only on "BTP:" - so a neighbour absorbs
// them. One slice is visibly two lists; the other absorption leaves the host's own
// units unchanged, so it surfaces as a missing list rather than a merged one.
// Pinned because it is a deliberate trade, not an accident: see listStartIndexes.
t('multi: slices carrying more than one list', many.count - found.length, 1);
t('multi: absorbed into a neighbour', corpus.length - found.length, 3);

// --- identity ----------------------------------------------------------------
// The chain: header key, then the army banner, then "Not found".
const twoUnits = 'Khorne Berzerkers (160 pts)\n• 1x Berzerker\n• 9x Berzerker\nBlood Angels (210 pts)\n• 10x Blood Angel\n';
t('name: taken from the banner',
  parseListText('Duck Fifiler (1990 points)\n' + twoUnits, { name: 'x' }).output.players[0].name, 'Duck Fifiler');
t('name: "Unnamed list" is not a name',
  parseListText('Unnamed list (1,995 Points)\n' + twoUnits, { name: 'x' }).output.players[0].name, 'Not found');
// "Strike Force (2000 points)" is the force layout, not a player.
t('name: "Strike Force" is not a name',
  parseListText('Strike Force (2000 points)\n' + twoUnits, { name: 'x' }).output.players[0].name, 'Not found');
const hdr = '+ FACTION KEYWORD: Chaos - World Eaters\n';
t('name: taken from the header',
  parseListText('++++++++++++++++++++++++\n+ PLAYER NAME: Blork\n' + hdr + '++++++++++++++++++++++++\n' + twoUnits, { name: 'x' }).output.players[0].name, 'Blork');
t('name: PSEUDO counts as a name',
  parseListText('++++++++++++++++++++++++\n+ PSEUDO: TITO\n' + hdr + '++++++++++++++++++++++++\n' + twoUnits, { name: 'x' }).output.players[0].name, 'TITO');
t('nameFromFile prettifies', nameFromFile('beer-clowns.txt'), 'beer clowns');

// --- the MHQ phone app's freeform header ------------------------------------
// Those exports carry no "+" keys at all: the faction, the detachment and the
// force disposition each sit on their own line, above the "Strike Force (N
// Points)" budget line. That budget line is the first army-sized number in the
// list, so the splitter used to read it as the start of the list and throw the
// header - and the three values that live only there - away with it. They came
// out with "detachment not found", "force disposition not found" and a null
// faction. They are in the corpus in both the English and the French spelling.
const freeform = corpus.filter(r => /la-croisade-des-canuts-2-2026-09-19__(34|35|39)$/.test(r.source));
t('freeform: three in the corpus', freeform.length, 3);
for (const r of freeform) {
  const p = oneOf(r.body).players[0];
  const m = getMeta(p);
  // The list starts at the top of the blob, not at the budget line.
  t('freeform: ' + r.source + ' starts at line zero', listStartIndexes(r.body.split('\n'))[0], 0);
  ok('freeform: ' + r.source + ' keeps its faction', !!p.faction, 'faction ' + JSON.stringify(p.faction));
  ok('freeform: ' + r.source + ' keeps its detachment', !!m.detachment, 'detachment ' + JSON.stringify(m.detachment));
  ok('freeform: ' + r.source + ' keeps its disposition', !!m.forceDisposition, 'disposition ' + JSON.stringify(m.forceDisposition));
}

// --- unrecognised format -----------------------------------------------------
// The Ironbuilt exports carry "[N pts]" but nothing this parser can structure, so
// they come out empty. That has to be said, not rendered as an army with no units.
const ironbuilt = corpus.filter(r => r.warnings.includes('unrecognized'));
t('unrecognised: two in the corpus', ironbuilt.length, 2);
t('unrecognised: zero units', ironbuilt.map(r => r.units), [0, 0]);
const ib = oneOf(ironbuilt[0].body).players[0];
t('unrecognised: flagged', isUnrecognizedFormat(ib), true);
t('unrecognised: the chip comes first and says so',
  playerWarnings(ib, getMeta(ib))[0].text, '> \u26a0 Unrecognized format');
// A list that parsed is not flagged.
const good = parseListText(example, { name: 'x' }).output.players[0];
t('unrecognised: a good list is not flagged', isUnrecognizedFormat(good), false);
// A single unit is not an army either.
t('unrecognised: one unit is flagged',
  isUnrecognizedFormat(parseListText('5x Sisters (100 pts)\n• 1x Sister\n• 4x Sister\n', { name: 'x' }).output.players[0]), true);

// --- errors -------------------------------------------------------------------
throws('empty text', () => parseListText('   ', {}), 'the text is empty - nothing to parse');
throws('not a string', () => parseListText(null, {}), 'the text is empty - nothing to parse');

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
