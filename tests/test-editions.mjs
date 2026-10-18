import { readAllCorpus, editionCounts, editionOf, isBoardingActionsDetachment, isBoardingActionsPageSection, buildFactionSections, assignEditions } from '../src/rules-corpus.mjs';
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
t('the distribution (154 rulings and 19 ability definitions are edition 11 too)', editionCounts(all), { 0: 1037, 10: 3, 11: 6324 });
t('edition 0 is the Legends / Forge World line, every kind', tally(all.filter(r => String(r.edition) === '0')), { 'faction-rule': 1, datasheet: 427, unitrules: 599, stratagem: 6, enhancement: 4 });
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
t('assignEditions stamps a whole list', assignEditions([{ id: 'datasheet#000000882', kind: 'datasheet' }], '11')[0].edition, '11');

// --- Boarding Actions is out of scope ----------------------------------------
const raw = buildFactionSections();
t('the importer removes the 59 Boarding Actions detachments, 241 stratagems and 117 enhancements', raw.boarding, { detachments: 59, stratagems: 241, enhancements: 117 });
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
