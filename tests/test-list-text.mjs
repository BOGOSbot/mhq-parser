import fs from 'node:fs';
import { parseListText, listStartIndexes, isUnrecognizedFormat, playerWarnings, getMeta, totals, armyBudget, nameFromFile } from '../parse.mjs';

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

// A header must survive concatenation too. The standalone checks above offer
// each list on its own, where the first-list special case applies; in a blob,
// the second and later freeform lists used to be cut at the budget line, so
// their faction/detachment/disposition was handed to the previous army. That is
// why the chips appeared only on a multi-list paste.
for (const r of freeform) {
  const alone = getMeta(oneOf(r.body).players[0]);
  const slice = many.players.find(p => sig(p) === sigOf(r.body));
  ok('multi: ' + r.source + ' keeps its header',
    !!slice && !!slice.faction && getMeta(slice).detachment === alone.detachment &&
      getMeta(slice).forceDisposition === alone.forceDisposition,
    slice ? JSON.stringify({ faction: slice.faction, det: getMeta(slice).detachment, disp: getMeta(slice).forceDisposition }) : 'no slice');
}

// Two app-freeform lists pasted one after the other, the second with a blank
// between its faction and its detachment and no army total anywhere: the only
// army-sized number is the "Strike Force" budget. The boundary belongs on the
// faction, not on the budget.
const chain = [
  'Adeptus Custodes',
  'Lions of the Emperor (3 Detachment Points)',
  'Take and Hold',
  'Strike Force (2,000 Points)',
  '',
  'CHARACTERS',
  '',
  'Shield-Captain (150 Points)',
  '\u2022 1x Guardian spear',
  'Custodians (220 Points)',
  '\u2022 9x Custodian',
  '',
  'World Eaters',
  '',
  'Berzerker Warband (3 Detachment Points)',
  'Take and Hold',
  'Strike Force (2000 points)',
  '',
  'CHARACTERS',
  '',
  'Angron (330 Points)',
  '\u2022 1x Samniarius and Spinegrinder',
  'Kharn the Betrayer (115 Points)',
  '\u2022 1x Gorechild',
  '',
].join('\n');
const chainLines = chain.split('\n');
t('split: two freeform lists are two boundaries', listStartIndexes(chainLines).length, 2);
t('split: the second starts at its faction', listStartIndexes(chainLines)[1], chainLines.indexOf('World Eaters'));
const chainOut = parseListText(chain, { name: 'x' }).output;
t('split: two players', chainOut.count, 2);
t('split: the first keeps its own detachment', getMeta(chainOut.players[0]).detachment, 'Lions of the Emperor');
const chain2 = chainOut.players[1];
t('split: the second keeps its faction', chain2.faction, 'World Eaters');
t('split: the second keeps its detachment', getMeta(chain2).detachment, 'Berzerker Warband');
t('split: the second keeps its disposition', getMeta(chain2).forceDisposition, 'Take and Hold');
t('split: the second warns about neither', playerWarnings(chain2, getMeta(chain2)).map(w => w.type), []);

// --- categories ---------------------------------------------------------------
// A unit takes the category of the last section header above it, so a header the
// parser does not know makes its units inherit the previous section's label: a
// Chaos Rhino under "Dedicated Transports" read as Battleline, a Cultist Mob
// under "Unités alliées" as Autres fiches techniques. Each spelling the corpus
// has produced is pinned here by source.
const CAT_PIN = [
  ['tournoi-de-dinan-2026-09-05__00', 'Dedicated Transports'],
  ['la-croisade-des-canuts-2-2026-09-19__01', 'Dedicated Transports'],
  ['la-croisade-des-canuts-2-2026-09-19__26', 'Unités alliées'],
  ['tournoi-de-dinan-2026-09-05__20', 'Unités alliées'],
  ['la-croisade-des-canuts-2-2026-09-19__32', 'Transports assignés'],
  ['la-croisade-des-canuts-2-2026-09-19__37', 'Transport assigné'],
];
t('category: six pinned lists', CAT_PIN.length, 6);
for (const [src_, cat] of CAT_PIN) {
  const body = corpus.find(r => r.source === src_).body;
  const seen = oneOf(body).players[0].units.map(u => (u.category || '').trim().toLowerCase());
  ok('category: ' + src_ + ' recognises ' + cat, seen.includes(cat.toLowerCase()),
    'saw ' + JSON.stringify([...new Set(seen)]));
}

// The corpus carries only the French allied-units spelling, so the English one is
// pinned on a minimal list: it is the spelling the MHQ phone-app export uses.
const allied = parseListText('Chaos Space Marines\nALLIED UNITS\nNoise Marines (160 Points)\n  • 1x Disharmonist\nDEDICATED TRANSPORTS\nChaos Rhino (65 Points)\n  • 1x Armoured tracks\n', { name: 'x' }).output.players[0];
t('category: the English spellings', allied.units.map(u => u.category), ['ALLIED UNITS', 'DEDICATED TRANSPORTS']);

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

// --- metadata: detachment and force disposition ------------------------------
// Every exporter writes its metadata differently, and the parser used to read
// only two of those spellings. Each shape below is one the corpus actually
// produces.
const metaOf = body => getMeta(parseListText(body, { name: 'x' }).output.players[0]);
const detOf = body => metaOf(body).detachment;
const dispOf = body => metaOf(body).forceDisposition;

// "== DETACHEMENT <name> : <faction> [...] ==" — the newrecruit/9th-era line.
t('det: == DETACHEMENT ==', detOf(
  '++++++++++++++++\nNom du joueur : Azz\nFactions utilisées : Necrons\n++++++++++++++++\n' +
  '== DETACHEMENT Nécrons - Dynastie Éveillée : Necrons [2000pts] ==\n' +
  'Héros épiques 1 : Illuminor Szeras [185pts]\nPersonnages 1 : Tétrarque [110pts]\n'),
  'Nécrons - Dynastie Éveillée');
// The 9th-edition spelling, English.
t('det: == DETACHEMENT Bataillon ==', detOf(
  '== DETACHEMENT Bataillon : Tyranids (0 PC) [2000pts] == \nHQ1: Hive Tyrant\nTR1: 10 Termagants\n'),
  'Bataillon');
// "Détachement principal" names no detachment, only says there is one.
t('det: principal is not a name', detOf(
  '== Détachement principal : Necrons [1990pts] ==\nHéros 1 : X [100pts]\n'), null);
// Labelled forms, both spellings and the "Rule"/"USED" suffixes.
t('det: Detachement:', detOf(
  'Joueur: Tomasson\nFaction: Space Marines\nDetachement: Righteous Crusaders\nCHARACTERS\n' +
  'Captain (95 points)\n• 1x Bolt pistol\nChaplain (75 points)\n• 1x Crozius\n'), 'Righteous Crusaders');
t('det: DETACHMENT USED', detOf(
  '+ PLAYER : Kurze\n+ FACTION KEYWORD: Genestealer Cult\n+ DETACHMENT USED : Unparalleled Foresight\n' +
  '+++++++++++++++\nCHARACTERS\nChar1: 1x X (10 pts): y\nChar2: 1x Y (10 pts): z\n'), 'Unparalleled Foresight');
t('det: Detachment Rule', detOf(
  'Factions Used: Drukhari\nArmy Points: 1995\nDetachment Rule: Kabalite Cartel\n+++++++++++++++\n' +
  'CHARACTERS\nChar1: 1x Archon (80 pts): huskblade\nChar2: 1x Succubus (95 pts): agoniser\n'), 'Kabalite Cartel');
t('det: +DETACHEMENT', detOf(
  '+ PLAYER NAME: CLEMENCERY\n+ FACTION KEYWORD: Astra Militarum\n+DETACHEMENT: Combined Regiment\n' +
  '+ TOTAL ARMY POINTS: 2000\n+++++++++++++++++\nCHARACTERS\nChar1: 1x Lord Solar (130 pts): sword\nChar2: 1x Ursula (60 pts): bolt pistol\n'),
  'Combined Regiment');
// "Detachment Rule :" with the value on the line under it.
t('det: label with value on next line', detOf(
  'Player: X\nFactions Used: World Eaters\nDETACHMENT USED :\nWorld Eaters - Berzerker Warband\n' +
  '+++++++++++++++\nCHARACTERS\nChar1: 1x Angron (340 pts): samniarius\nChar2: 1x Kharn (85 pts): gorechild\n'),
  'World Eaters - Berzerker Warband');
// armylistnetwork: the heading alone, values on the lines under it.
t('det: ### Détachements list', detOf(
  'Thousand Sons : Tournoi armageddon\n### Détachements :\n* Thousand Sons - Phalange Rubricae\n' +
  '=> Disposition : Prendre et tenir\n--- Ligne ---\nMarines Rubricae (10) : 190 pts\n- gear\n'),
  'Thousand Sons - Phalange Rubricae');
t('disp: => Disposition', dispOf(
  'Thousand Sons : Tournoi armageddon\n### Détachements :\n* Thousand Sons - Phalange Rubricae\n' +
  '=> Disposition : Prendre et tenir\n--- Ligne ---\nMarines Rubricae (10) : 190 pts\n- gear\n'),
  'Prendre et tenir');
// The freeform app header: detachment before, and after, the budget line.
const free = (extra, mid) =>
  'Tyty septembre (1995 Points)\nTyranids\n' + extra + 'Strike Force (2000 Points)\n' + mid +
  'CHARACTERS\nDeathleaper (70 Points)\n• 1x Lictor claws and talons\nHive Tyrant (255 Points)\n• 1x Monstrous bonesword\n';
t('det: freeform before Strike Force', detOf(free('Synaptic Nexus\n', '')), 'Synaptic Nexus');
t('det: freeform after Strike Force', detOf(
  'Banished cup (1995 points)\nAeldari\nStrike Force (2000 points)\nBattle Host\n' +
  'CHARACTER\nAutarch Wayleaper (130 points)\n• 1x Dragon fusion gun\nFarseer (105 points)\n• 1x Witchblade\n'), 'Battle Host');
t('det: freeform with no detachment', detOf(free('', '')), null);
// The freeform budget line carries the faction, not a detachment, in both
// positions.
t('det: freeform faction before is skipped', detOf(
  'Bare (2000 points)\nNecrons\nStrike Force (2000 points)\nCHARACTERS\nChar1: 1x X (10 pts): y\nChar2: 1x Y (10 pts): z\n'), null);
// Labelled dispositions, English and French, singular and plural.
t('disp: Dispositions des Forces', dispOf(
  'Chevaliers du Chaos\nForce de Frappe (2000 points)\nInfernal Lance (3 Points de Détachement)\n' +
  'Dispositions des Forces : Éliminez l’Adversaire\nPERSONNAGES\nChar1: 1x Knight (430 points): gatling\nChar2: 1x Knight (450 points): gatling\n'),
  'Éliminez l’Adversaire');
t('disp: Force Dispositions', dispOf(
  'Adeptus Custodes\nLions of the Emperor (3 Detachment Points)\nForce Dispositions: Purge the Foe\n' +
  'Strike Force (2000 points)\nCHARACTERS\nChar1: 1x X (10 pts): y\nChar2: 1x Y (10 pts): z\n'), 'Purge the Foe');
t('disp: bare line', dispOf(
  'Adeptus Custodes\nLions of the Emperor (3 Detachment Points)\nTake and Hold\nStrike Force (2000 points)\n' +
  'CHARACTERS\nChar1: 1x X (10 pts): y\nChar2: 1x Y (10 pts): z\n'), 'Take and Hold');
// A rule line is not a name: the "+++" that follows an empty label must not be
// read as the detachment.
t('det: a rule line is not a detachment', detOf(
  'Nom du joueur : X\nRègle de détachement :\n+++++++++++++++++++++++++++++\nFactions utilisées : Necrons\n' +
  'Points d’armée : 2000\nPersonnages 1 : Tétrarque [110pts]\nVéhicules 1 : Arche [200pts]\n'), null);
// A player who puts the metadata under the units still names it.
t('det: whole-body fallback', detOf(
  'Player: Papy\nFaction Used: Tyranids\nArmy Points: 1995\n== Characters==\n' +
  'Char1:Hiver Tyrant(260)\n-Monstrous Bones Sword\n== Battle Line==\n*10 Gargoyles(75)\n' +
  'Detachment Rule: Invasion Fleet\n'), 'Invasion Fleet');
// A fully-specified list warns about neither.
t('warnings: no detachment warning when found', playerWarnings(
  parseListText('World Eaters\nStrike Force (2000 points)\nBerzerker Warband\nDetachment Rule: Berzerker Warband\n' +
    'CHARACTERS\nChar1: 1x Angron (340 pts): samniarius\nChar2: 1x Kharn (85 pts): gorechild\n', { name: 'x' }).output.players[0],
  metaOf('World Eaters\nStrike Force (2000 points)\nBerzerker Warband\nDetachment Rule: Berzerker Warband\n' +
    'CHARACTERS\nChar1: 1x Angron (340 pts): samniarius\nChar2: 1x Kharn (85 pts): gorechild\n')
).filter(w => w.type === 'detachment'), []);

// --- the battle-size budget ----------------------------------------------------
// "Strike Force (2000 points)" is the game size the list is built for, not the
// army's own total: an army under it is not in error. Going over it still is.
const budgetList = costs => 'World Eaters\n\nBerzerker Warband (3 Detachment Points)\nTake and Hold\n' +
  'Strike Force (2000 points)\nCHARACTERS\n' +
  costs.map((c, i) => 'Squad ' + (i + 1) + ' (' + c + ' Points)\n\u2022 1x Body').join('\n') + '\n';
const budgetWarn = costs => { const p = parseListText(budgetList(costs), { name: 'x' }).output.players[0]; return playerWarnings(p, getMeta(p)).map(w => w.type); };
t('budget: read off the Strike Force line', armyBudget(parseListText(budgetList([330, 115]), { name: 'x' }).output.players[0]), 2000);
t('budget: under the limit is not a mismatch', budgetWarn([330, 115]), []);
t('budget: over the limit warns', budgetWarn([700, 700, 700]).filter(w => w === 'mismatch' || w === 'over-budget'), ['over-budget']);
// A real banner still declares, and still mismatches, when it disagrees.
const bannerList = 'Duck Fifiler (1990 points)\nWorld Eaters\nBerzerker Warband (3 Detachment Points)\n' +
  'Take and Hold\nStrike Force (2000 points)\nCHARACTERS\n' +
  'Angron (330 Points)\n\u2022 1x Samniarius\nKharn the Betrayer (115 Points)\n\u2022 1x Gorechild\n';
const bannerP = parseListText(bannerList, { name: 'x' }).output.players[0];
t('budget: the banner is still the declaration', totals(bannerP).declaredPts, 1990);
t('budget: a banner mismatch still warns', playerWarnings(bannerP, getMeta(bannerP)).some(w => w.type === 'mismatch'), true);

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
