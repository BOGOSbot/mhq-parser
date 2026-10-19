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
// task-32: B restores 62 parts the record-wise dedupe dropped (25 of them edition 0,
// 37 edition 11) and A drops the export's template row (2 edition-11 records), so the
// distribution moves by +25 edition 0 and +34 edition 11 - all of it the three fixes.
t('the distribution (154 rulings and 19 ability definitions are edition 11 too; task-13 removed ten edition-11 records)', editionCounts(all), { 0: 1062, 10: 3, 11: 6280 });
t('edition 0 is the Legends / Forge World line, every kind (task-32: the restored parts)', tally(all.filter(r => String(r.edition) === '0')), { 'faction-rule': 1, datasheet: 431, unitrules: 620, stratagem: 6, enhancement: 4 });
t('edition 10 is the two leftover 10th-edition datasheets and their half', tally(all.filter(r => String(r.edition) === '10')), { datasheet: 2, unitrules: 1 });
// The join resolves by the record's own id, not by a name in its text:
const fx = id => editionOf({ id: id, kind: String(id).split('#')[0] }, '11');
t('a datasheet resolves through its own source_id', fx('datasheet#000000882'), '11');
t('a Legends datasheet resolves to edition 0', fx('datasheet#000001458'), '0');
t('a faction stratagem joins its faction source by name', fx('stratagem#000008931007'), '11');
t('a stratagem only edition-0 datasheets carry is edition 0 (the pack link)', fx('stratagem#000009127002'), '0');
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
// The frozen corpus carries 928 Legends records (384 datasheets, 534 unitrules, 5
// stratagems, 4 enhancements, 1 faction rule) and every one of them is edition 0
// today, so the new rule changes nothing until the 2026-10-19 export is adopted.
const legends = all.filter(isLegendsRecord);
t('the frozen corpus has 928 Legends records and none is delivered', [legends.length, legends.filter(isDelivered).length], [928, 0]);
t('assignEditions stamps a whole list', assignEditions([{ id: 'datasheet#000000882', kind: 'datasheet' }], '11')[0].edition, '11');

// --- Boarding Actions is out of scope ----------------------------------------
const raw = buildFactionSections();
t('the importer removes the 59 Boarding Actions detachments, 241 stratagems and 117 enhancements, the 9 Challengers and the one attached ability copy', raw.boarding, { detachments: 59, stratagems: 241, enhancements: 117, challengers: 9, abilitiesAttached: 1, abilitiesDropped: 0 });
const named = ['Khaine\u2019s Arrow', 'Protector Host', 'Wraiths of the Void', 'Star-dancer Masque'];
t('NAMED: the 4 Aeldari Boarding Actions detachments are gone', named.map(n => all.some(r => r.kind === 'detachment' && String(r.heading).indexOf(n) === 0)), [false, false, false, false]);
ok('a detachment row is out of scope by its own type column', isBoardingActionsDetachment({ type: 'Boarding Actions' }) && !isBoardingActionsDetachment({ type: '' }));
ok('a faction-page rule naming the expansion is out of scope', isBoardingActionsPageSection({ heading: 'Mustering a Boarding Patrol' }) && isBoardingActionsPageSection({ heading: '', anchor: 'Forming-Boarding-Squads' }));
ok('and a normal rule, or the BOARDING DRILL stratagem, is not', !isBoardingActionsPageSection({ heading: 'Agile Manoeuvres' }) && !isBoardingActionsPageSection({ heading: 'BOARDING DRILL (Imperial Agents) / rules' }));
// Strands of Fate: the CSV has no 10th-edition Aeldari source, so the join stamps
// it 11 and it stands; the tree drops it by id. Said plainly, not claimed fixed.
ok('NAMED: Strands of Fate is still in the corpus, edition 11', (function () { const r = all.find(x => x.id === 'faction-rule#000008445'); return !!r && r.edition === '11'; })());

// --- the name is never the filter (Mandal's guard rail) -----------------------
const tree = wikiTree(all);
const seer = all.find(r => r.id === 'detachment#000001023');
ok('NAMED: Seer Council carries a Strands of Fate ability and is edition 11', !!seer && seer.edition === '11' && /Strands of Fate/i.test(String(seer.text)));
const sofNamed = all.filter(r => /Strands of Fate/i.test(String(r.heading)));
t('the only record of that name the tree drops is the faction rule, by id', tree.filtered.filter(id => sofNamed.some(r => r.id === id)), ['faction-rule#000008445']);
ok('and the Seer Council detachment is a row in the Aeldari tree', (tree.files['tree/factions/xenos/aeldari/detachments.js'].recs || []).some(r => r.i === 'detachment#000001023'));
// --- the mutation check -------------------------------------------------------
ok('MUTATION: clearing the type column clears the out-of-scope verdict', !isBoardingActionsDetachment({ id: '000000959', type: '' }));
ok('MUTATION: a page heading that only looks like the expansion is kept', !isBoardingActionsPageSection({ heading: 'Boarding Action Plan' }));
t('MUTATION: changing the fallback edition changes the answer', editionOf({ id: 'page#x', kind: 'rule' }, '10'), '10');
t('MUTATION: and a pack-linked stratagem cannot be talked back to 11 by a fallback', editionOf({ id: 'stratagem#000009127002', kind: 'stratagem' }, '11'), '0');

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
