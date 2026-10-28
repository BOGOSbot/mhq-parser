import { readAllCorpus, editionCounts, editionOf, isBoardingActionsDetachment, isBoardingActionsPageSection, isDelivered, isLegendsRecord, isLegendsSource, buildFactionSections, assignEditions } from '../src/rules-corpus.mjs';
import { wikiTree } from '../src/wiki-toc.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const all = readAllCorpus();
const tally = rows => rows.reduce((a, r) => { const k = r.kind || '(none)'; a[k] = (a[k] || 0) + 1; return a; }, {});

// --- every record carries an edition -----------------------------------------
t('every record carries a numeric edition', all.filter(r => !/^\d+$/.test(String(r.edition || ''))).length, 0);
// task-33: the 2026-10-19 export re-tags the 15 '<faction> (Warhammer Legends)' source
// rows to edition 11, so edition 0 is down to the 121 records the export still calls
// 0 (the Forge World / pack line) and edition 11 carries 7,303 (task-99: +36).
// 2026-10-24: the lore cut merged 34 edition-11 detachment halves into 17, so edition 11
// is 18 records lighter. Editions 0 and 10 are untouched.
// 2026-10-26: the dump carries one edition. The rows the CSV still called edition 0
// (Forge World packs) and edition 10 (two leftover datasheets) are not in it, so the
// corpus is entirely 11 and nothing is left to exclude by edition - which is why the
// guard is asserted synthetically, so a snapshot that reintroduces an old edition fails.
// 5,836 before the wargear options split 68 long datasheets (2026-10-28).
t('the MFM corpus is entirely edition 11', editionCounts(all), { 11: 5914 });
t('nothing in the corpus is edition 0 or 10', [all.filter(r => String(r.edition) === '0').length, all.filter(r => String(r.edition) === '10').length], [0, 0]);
// edition 10 is not excluded wholesale - the predicate names the ids it knows - so only
// the pack line is asserted here. The 10th-edition case is the MUTATION check at the end.
t('and a pack-line record would not be delivered', isDelivered({ id: 'datasheet#x', kind: 'datasheet', edition: '0' }), false);
// The join resolves by the record's own id, not by a name in its text:
const fx = id => editionOf({ id: id, kind: String(id).split('#')[0] }, '11');
t('a datasheet resolves through its own source_id', fx('datasheet#000000882'), '11');
// task-33: Contemptor-Achillus Dreadnought (000001458) was a Forge World pack datasheet
// and is a normal Adeptus Custodes one in the new export (source 000000024, edition 11),
// so the pack fixture is a datasheet the export still calls edition 0.
t('a Forge World pack datasheet resolves to edition 0', fx('datasheet#000001564'), '0');
t('a faction stratagem joins its faction source by name', fx('stratagem#000008931007'), '11');
// task-33: this pack-linked stratagem's datasheets are edition 11 now, so the pack link
// no longer stamps it 0 - the Legends name rule filters it (the pack link still finds
// the Forge World packs, see the mutation check below).
t('a pack-linked Legends stratagem resolves 11 now, and is filtered by name', [fx('stratagem#000009127002'), isLegendsRecord({ id: 'stratagem#000009127002', kind: 'stratagem' }), isDelivered({ id: 'stratagem#000009127002', kind: 'stratagem', edition: '11' })], ['11', true, false]);
t('a faction rule joins through Abilities.csv', fx('faction-rule#000009894'), '11');
t('a Boarding Actions detachment is edition 10', fx('detachment#000000959'), '10');
t('and its enhancements are edition 10', fx('enhancement#000009588002'), '10');
t('an id the tables do not hold takes the file fallback', editionOf({ id: 'page#x', kind: 'rule' }, '11'), '11');
t('and with no numeric fallback it stays unresolved', editionOf({ id: 'page#x', kind: 'rule' }, ''), '');
// --- task-32: Warhammer Legends is out, whatever edition the export claims ---------
// Mandal, 2026-10-19: national tournaments run WTC and FEQ rulings, Legends is a
// friendly-game minority, and the 2026-10-19 export re-tagged the 15
// '<faction> (Warhammer Legends)' Source.csv rows from edition 0 to edition 11 - so
// the edition filter alone would let ~897 records / 1,035k characters back in. The
// rule reads the source NAME.
t('a Legends source name is recognised, whatever the case', [isLegendsSource('Adeptus Custodes (Warhammer Legends)'), isLegendsSource('space marines (WARHAMMER LEGENDS)')], [true, true]);
t('a normal source name is not', [isLegendsSource('Adeptus Custodes'), isLegendsSource('Adeptus Custodes (Forge World)'), isLegendsSource(''), isLegendsSource(null)], [false, false, false, false]);
t('a Legends datasheet is Legends', isLegendsRecord({ id: 'datasheet#000001525', kind: 'datasheet' }), true);
t('and a normal datasheet is not', isLegendsRecord({ id: 'datasheet#000000882', kind: 'datasheet' }), false);
// The crux: the export may stamp it edition 11, and it is filtered anyway.
t('a Legends record claiming edition 11 is still not delivered', isDelivered({ id: 'datasheet#000001525', kind: 'datasheet', edition: '11' }), false);
t('a Legends stratagem only Legends datasheets carry is Legends too', isLegendsRecord({ id: 'stratagem#000009127002', kind: 'stratagem' }), true);
t('a normal stratagem is not', isLegendsRecord({ id: 'stratagem#000008931007', kind: 'stratagem' }), false);
// The 2026-10-19 export carries 959 Legends records (396 datasheets, 553 unitrules, 5
// stratagems, 4 enhancements, 1 faction rule); 942 of them are edition 11, which is
// exactly why the name rule exists - none is delivered.
// 2026-10-26: the dump carries isLegends as a boolean and the builder drops those rows
// at the source, so the corpus no longer holds a Legends record to exclude. The remaining
// name rule is exercised by the MUTATION case at the bottom of this file.
const legends = all.filter(isLegendsRecord);
t('the MFM corpus carries no Legends record at all', legends.length, 0);
t('assignEditions stamps a whole list', assignEditions([{ id: 'datasheet#000000882', kind: 'datasheet' }], '11')[0].edition, '11');

// --- Boarding Actions is out of scope ----------------------------------------
const raw = buildFactionSections();
// 2026-10-26: the dump has no Boarding Actions rows to remove - the mode is not in the
// matched-play export - so the counters are structurally zero rather than 59 / 241 / 117.
t('the MFM importer has no Boarding Actions rows to remove', [raw.boarding.detachments, raw.boarding.stratagems, raw.boarding.enhancements], [0, 0, 0]);
const named = ['Khaine\u2019s Arrow', 'Protector Host', 'Wraiths of the Void', 'Star-dancer Masque'];
t('NAMED: the 4 Aeldari Boarding Actions detachments are gone', named.map(n => all.some(r => r.kind === 'detachment' && String(r.heading).indexOf(n) === 0)), [false, false, false, false]);
ok('a detachment row is out of scope by its own type column', isBoardingActionsDetachment({ type: 'Boarding Actions' }) && !isBoardingActionsDetachment({ type: '' }));
ok('a faction-page rule naming the expansion is out of scope', isBoardingActionsPageSection({ heading: 'Mustering a Boarding Patrol' }) && isBoardingActionsPageSection({ heading: '', anchor: 'Forming-Boarding-Squads' }));
ok('and a normal rule, or the BOARDING DRILL stratagem, is not', !isBoardingActionsPageSection({ heading: 'Agile Manoeuvres' }) && !isBoardingActionsPageSection({ heading: 'BOARDING DRILL (Imperial Agents) / rules' }));
// 2026-10-26: the dump names the Aeldari army rule Battle Focus; Strands of Fate is the
// Seer Council detachment's rule text, not a record of its own. Both are looked up by
// heading, because the ids are dump UUIDs now.
const aeldariRule = all.find(r => r.kind === 'faction-rule' && /^Battle Focus/.test(String(r.heading)));
ok('NAMED: the Aeldari army rule is Battle Focus and is edition 11', !!aeldariRule && aeldariRule.edition === '11');

// --- the name is never the filter (Mandal's guard rail) -----------------------
const tree = wikiTree(all);
const seer = all.find(r => r.kind === 'detachment' && /^Seer Council/.test(String(r.heading)));
ok('NAMED: Seer Council carries a Strands of Fate ability and is edition 11', !!seer && seer.edition === '11' && /Strands of Fate/i.test(String(seer.text)));
// The guard rail, stated as an invariant rather than by one hardcoded id: everything the
// tree filters resolves to a corpus record, so the filter is never a name match.
const byId = new Map(all.map(r => [r.id, r]));
t('the tree filters only ids the corpus carries', tree.filtered.filter(id => !byId.has(id)), []);
ok('and the Seer Council detachment is a row in the Aeldari tree', !!seer && (tree.files['tree/factions/xenos/aeldari/detachments.js'].recs || []).some(r => r.i === seer.id));
// --- the mutation check -------------------------------------------------------
ok('MUTATION: clearing the type column clears the out-of-scope verdict', !isBoardingActionsDetachment({ id: '000000959', type: '' }));
ok('MUTATION: a page heading that only looks like the expansion is kept', !isBoardingActionsPageSection({ heading: 'Boarding Action Plan' }));
t('MUTATION: changing the fallback edition changes the answer', editionOf({ id: 'page#x', kind: 'rule' }, '10'), '10');
// task-33: the fallback cannot talk a Legends record back in either - it resolves 11
// and isDelivered still says no.
t('MUTATION: a Legends record cannot be talked back in by a fallback', [editionOf({ id: 'stratagem#000009127002', kind: 'stratagem' }, '11'), isDelivered({ id: 'stratagem#000009127002', kind: 'stratagem', edition: '11' })], ['11', false]);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
