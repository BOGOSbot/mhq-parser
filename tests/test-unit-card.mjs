import {
  ABILITY_CHARS, abilityRuleIds, buildUnitCard, cardBuildCount, cardTables, findAbilityRecord, findDatasheet, recordCard, resetCardTables, resolveRecordLinks, unitCard, unitCardEnabled, wantsUnitCard,
} from '../src/unit-card.mjs';
import { readAllCorpus, findingFor } from '../src/rules-corpus.mjs';
import { markRange, markHit, markWargearText } from '../src/wargear-marks.mjs';
import { buildTrace } from '../src/rules-traces.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

// --- the decision is closed-set ---------------------------------------------
// A datasheet lookup or a rules question. The card is shown only when the
// question asks for the unit's own data AND names a datasheet exactly.
t('a French profile question wants a card', wantsUnitCard('donne moi le profil de fuegan'), true);
t('an English profile question wants a card', wantsUnitCard("what is Fuegan's profile?"), true);
t('a statline question wants a card', wantsUnitCard('what is the Toughness of a Tyrannofex?'), true);
t('a keywords question wants a card', wantsUnitCard('Le Tyrannofex a-t-il le mot-clé FRAME ?'), true);
t('a rules question does not', wantsUnitCard('can a unit shoot after it Fell Back?'), false);
t('a rules question naming a unit does not', wantsUnitCard('Fuegan peut-il tirer après avoir battu en retraite ?'), false);

// The gate reads the question and its translation, NEVER the translator's search
// terms. Those are a retrieval artefact - for the French melta question the
// translator generated 'Melta weapons', "weapons" matched, and a rules question
// was answered with a datasheet and no judge. The English wording needed no
// translation, had no terms, and answered correctly: the whole asymmetry.
const meltaFr = 'est-ce que fuegan peut arriver de reserves a portee de melta ?';
const meltaEn = 'Can fuegan arrive from reserves in melta range ?';
const meltaTerms = ['FUEGAN', 'Reserves', 'Melta', 'Charge', 'Melta range', 'Deep Strike', 'Melta weapons'];
t('the French melta question does not want a card', wantsUnitCard(meltaFr, 'Can Fuegan arrive from Reserves into Melta range?'), false);
t('the generated terms cannot make it want one', wantsUnitCard(meltaFr, 'Can Fuegan arrive from Reserves into Melta range?', meltaTerms), false);
t('the English variant is the same decision', wantsUnitCard(meltaEn, ''), false);
// The name does resolve - Fuegan is named in the translation - and that is
// exactly why intent and name are two halves of the decision: a name alone must
// not turn a rules question into a card.
t('the name resolves but the question is still not a card', [findDatasheet(meltaFr, 'Can Fuegan arrive from Reserves into Melta range?').id, unitCard(meltaFr, { asked: 'Can Fuegan arrive from Reserves into Melta range?', terms: meltaTerms })], ['000000574', null]);
t('a profile question still does', wantsUnitCard('donne moi le profil de fuegan', 'Give me the profile of Fuegan.'), true);

t('Fuegan = 000000574', buildUnitCard('000000574').id, '000000574');
t('the question resolves to the datasheet id', findDatasheet('donne moi le profil de fuegan', 'Give me the profile of FUEGAN.').id, '000000574');
t('the translated text resolves it too', findDatasheet('', 'Give me the profile of Fuegan.').id, '000000574');
t('an unknown unit does not resolve', findDatasheet('donne moi le profil de Zorglub', ''), null);
t('a bare unit word does not match a longer name', findDatasheet('what is the profile of a rhino', ''), null);

// --- task-34: the wargear marks ---------------------------------------------
// Six cases on the formatter itself, then the record Mandal read on the phone and
// the finding text the excerpt shows.
t('a numeric range on a Ranged weapon gets its inch mark', markRange('12', 'Ranged'), '12"');
t('Melee is not a distance', markRange('Melee', 'Melee'), 'Melee');
t('an empty range stays empty', markRange('', 'Ranged'), '');
t('a numeric BS/WS gets its plus', [markHit('3'), markHit('2')], ['3+', '2+']);
t('N/A means the profile has none', markHit('N/A'), 'N/A');
t("'-' means the profile has none", markHit('-'), '-');
t('an empty BS/WS stays empty', markHit(''), '');
// The flat text the corpus stores and a finding shows: postfix at render only.
const flat = 'Wargear Grabba Dragga (Ranged): Range 12 A 1 BS 2 S 10 AP -2 D 3';
t('the flat passage text takes the same marks', markWargearText(flat), 'Wargear Grabba Dragga (Ranged): Range 12" A 1 BS 2+ S 10 AP -2 D 3');
t('and the marks are idempotent', markWargearText(markWargearText(flat)), markWargearText(flat));
t('Melee, N/A and - in the flat text are untouched', markWargearText('Range Melee BS N/A WS - Range'), 'Range Melee BS N/A WS - Range');
t('the finding excerpt and its passage are the marked text', (function () {
  const f = findingFor({ id: 'datasheet#x', set: 'factions', source: 'factions-csv', heading: 'Raptors', url: 'https://x', text: flat }, 1);
  return [f.excerpt, f.text];
})(), ['Wargear Grabba Dragga (Ranged): Range 12" A 1 BS 2+ S 10 AP -2 D 3', 'Wargear Grabba Dragga (Ranged): Range 12" A 1 BS 2+ S 10 AP -2 D 3']);

// --- the Fuegan card, field for field ---------------------------------------
const c = buildUnitCard('000000574');
// task-33: the 2026-10-19 export bumps the Aeldari source to version 1.4 (errata 14.10.2026).
ok('every field comes from the export, none from a model', c && c.source === 'Aeldari' && c.edition === '11' && c.version === '1.4');
t('the statline is the CSV statline', c.models, [{
  line: '1', name: 'Fuegan', M: '7"', T: '3', Sv: '2+', inv: '4+', W: '5', Ld: '6+', OC: '1', base: '40mm',
}]);
// task-34: the range carries its inch mark and BS/WS its plus - the export writes
// both bare (0 of 7,758 wargear rows carry either), so this is the game's notation
// restored at render. A and S and AP and D are not touched.
t('the weapons are the CSV weapons, with the notation marks', c.ranged.map(w => [w.name, w.range, w.A, w.BS, w.S, w.AP, w.D, w.notes]), [
  ['Searsong – beam', '12"', '3', '2+', '8', '-3', '2', 'assault, melta 1, sustained hits 2'],
  ['Searsong – lance', '18"', '1', '2+', '14', '-4', 'D6', 'assault, melta 6'],
]);
t('melee is split out', c.melee.map(w => w.name), ['Fire Axe']);
t('the abilities are named, including the ones resolved through Abilities.csv', c.abilities.map(a => a.type + ':' + a.name), ['Core:Leader', 'Faction:Battle Focus', 'Datasheet:Burning Lance', 'Datasheet:Unquenchable Resolve']);
t('an ability does not repeat its own name and rule id', c.abilities[0].description.slice(0, 19), 'Mighty heroes fight');
ok('a long Faction ability is shortened and says so', c.abilities[1].truncated && c.abilities[1].description.length <= ABILITY_CHARS + 3);
// task-33: the 2026-10-19 export writes the keyword list in its own order now.
t('the keywords are split into faction and other', c.keywords, {
  faction: ['Asuryani'],
  other: ['Infantry', 'Character', 'Epic Hero', 'Phoenix Lord', 'Aspect Warrior', 'Aeldari', 'Grenades', 'Fuegan'],
});
t('the points are the CSV points', c.points, [{ label: '1 model', cost: '130' }]);
t('the composition keeps its HTML out', c.composition, ['1 Fuegan – EPIC HERO']);
t('the loadout drops the sentence the label already says', c.loadout, 'Searsong; Fire Axe.');
t('Fuegan has no options and no damaged bracket', [c.options, c.damaged], [[], null]);
ok('the card cites the datasheet page', /^https:\/\/wahapedia\.ru\//.test(c.url));
t('the card marks both columns and leaves A/S/AP/D alone', c.ranged.map(w => [w.range, w.BS, w.A, w.S]), [['12"', '2+', '3', '8'], ['18"', '2+', '1', '14']]);
const waz = buildUnitCard(findDatasheet('Wazdakka Gutsmek', 'Wazdakka Gutsmek').id);
t('the record Mandal read: ranged ranges and BS', waz.ranged.map(w => [w.range, w.BS]), [['12"', '2+'], ['24"', '4+']]);
t('and its melee table keeps Melee in the range column with WS marked', waz.melee.map(w => [w.range, w.BS]), [['Melee', '2+'], ['Melee', '4+'], ['Melee', '2+']]);

// Nothing on the card may carry markup: the export is HTML inside a pipe file,
// and a card is the one place it is displayed raw.
const asText = JSON.stringify(c);
t('no tag survives into the card', /<[a-z/][^>]*>/i.test(asText), false);
t('no HTML entity survives into the card', /&(?:amp|nbsp|lt|gt|#\d+);/.test(asText), false);

// --- the abilities that are rules, not datasheet data ----------------------
// Mandal's change: a Base (Core) or Faction ability is a rule defined elsewhere
// in the corpus, so the card links to its record and does not reprint it; a
// Datasheet ability is the unit's own and keeps its text. An ability whose
// record cannot be found keeps its text too - a dead link is worse than a long
// card.
const corpora = { rules: readAllCorpus('rules'), factions: readAllCorpus('factions') };
const linked = buildUnitCard('000000574', { corpora });
const leader = linked.abilities[0];
t('Leader is a Core ability', leader.type, 'Core');
ok('Leader resolves to its corpus record', leader.link);
t('the link names the rule it resolved to', /LEADER/i.test(leader.link.heading), true);
t('the link is a real url', /^https:\/\//.test(leader.link.href || leader.link.url), true);
ok('the link carries the passage for the popup', String(leader.link.passage).length > 80);
const focus = linked.abilities[1];
t('Battle Focus is a Faction ability', focus.type, 'Faction');
// Phase C gave Battle Focus a record of its own - faction-rule#000009894, created
// by the wiki rebuild - so the card links it. This used to be the no-record case
// (text kept, no link); that path now lives on the resolver below and on the
// no-corpora card, where nothing can resolve.
ok('Battle Focus resolves to its new corpus record', focus.link);
t('and the link names the record', focus.link.heading, 'Battle Focus - faction rule');
ok('and carries the passage for the popup', String(focus.link.passage).length > 80);
t('a Datasheet ability gets no link', linked.abilities.slice(2).map(a => [a.name, a.link]), [['Burning Lance', null], ['Unquenchable Resolve', null]]);
ok('and keeps its text', linked.abilities[2].description.length > 50);
// Without the corpora nothing links: the card degrades to text, never to a
// dead link.
t('no corpora, no links', buildUnitCard('000000574').abilities.map(a => a.link), [null, null, null, null]);

// The rule id the ability's own card cites is what separates the Leader rule
// from a section that merely begins with the same word.
t('the rule id is read off the export', abilityRuleIds('<div class="abName">LEADER<span class="h_number">24.22</span></div>'), ['24.22']);
t('an ability with no cited id yields none', abilityRuleIds('<div>no heading here</div>'), []);
const fake = [
  { heading: 'Leadership Rolls', ruleId: '01.06', url: 'u', text: 't' },
  { heading: 'Muster Armies > FAQ > Do rules that affect a keyword include it? > LEADER', ruleId: '24.22', url: 'u', text: 't' },
  { heading: 'Forming Attached Units > LEADER 24.22 / SUPPORT', ruleId: '24.34', url: 'u', text: 't' },
];
// The FAQ also carries the rule id and ends with the ability's name; the rule
// whose own title carries the id is the one the reader wants.
t('the rule id in the title picks the ability own record, not the FAQ', findAbilityRecord({ type: 'Core', name: 'Leader', ruleIds: ['24.22'] }, fake, []).heading, 'Forming Attached Units > LEADER 24.22 / SUPPORT');
t('a bare name match still resolves', findAbilityRecord({ type: 'Core', name: 'Leadership', ruleIds: [] }, fake, []).heading, 'Leadership Rolls');
t('a name nothing starts with does not resolve', findAbilityRecord({ type: 'Core', name: 'Battle Focus', ruleIds: [] }, fake, []), null);
t('a Datasheet ability never resolves to a rule', findAbilityRecord({ type: 'Datasheet', name: 'Leader', ruleIds: ['24.22'] }, fake, []), null);
t('a Faction ability looks in the factions half', findAbilityRecord({ type: 'Faction', name: 'Leader', ruleIds: [] }, fake, [{ heading: 'Leader', url: 'u', text: 't' }]).heading, 'Leader');

// --- the silent fallback ----------------------------------------------------
t('a rules question gets no card', unitCard('can a unit shoot after it Fell Back?'), null);
t('a rules question that names a unit gets no card', unitCard('Fuegan peut-il tirer après avoir battu en retraite ?'), null);
t('a question with no data intent gets no card', unitCard('Asurmen'), null);
t('a name several factions share gets no card rather than a guess', unitCard('what is the profile of a Chaos Rhino?'), null);
t('an unknown datasheet id gets no card', buildUnitCard('nope'), null);

// --- the switch -------------------------------------------------------------
t('the card is on by default', unitCardEnabled({}), true);
t('RULES_UNIT_CARD=0 turns it off', unitCardEnabled({ RULES_UNIT_CARD: '0' }), false);
process.env.RULES_UNIT_CARD = '0';
t('switched off, the module falls back to prose', unitCard('donne moi le profil de fuegan'), null);
delete process.env.RULES_UNIT_CARD;
ok('switched back on, it resolves again', unitCard('donne moi le profil de fuegan'));

// --- the trace --------------------------------------------------------------
const tr = buildTrace({
  id: 'x', at: '2026-10-13T00:00:00.000Z', question: 'donne moi le profil de fuegan',
  asked: 'Give me the profile of Fuegan.', terms: ['FUEGAN'], answer: '', findings: [], judge: null,
  card: { id: '000000574', name: 'Fuegan' },
});
// The writer field is the prose outcome, never the preview: the card is additive
// now, so a card trace whose writer produced nothing is an 'empty' writer, and
// the datasheet it previewed lives in its own field.
t('a card trace with no prose is an empty writer, not a card writer', tr.writer, 'empty');
t('the trace names the datasheet beside the prose outcome', tr.card, { id: '000000574', name: 'Fuegan' });
t('a previewed card with prose is an ok writer', buildTrace({ id: 'x', at: '2026-10-13T00:00:00.000Z', question: 'q', answer: 'A rule [1].', card: { id: '000000574', name: 'Fuegan' } }).writer, 'ok');
t('a card trace carries no findings and no answer', [tr.findings, tr.answer], [[], '']);

// The tables are a cache of files on disk; a reload must give the same card.
resetCardTables();
t('a reloaded table set gives the same card', buildUnitCard('000000574').models[0].T, '3');
ok('the table cache is one object', cardTables() === cardTables());

// --- the record card: one builder for the four categories --------------------
// The full-screen view opens a unit, a faction, a detachment or a rules section
// through this one function, so a datasheet id must find the CSV card, and every
// other category must come back as the record itself with its links resolved.
const allRecords = readAllCorpus();
const bothHalves = { rules: readAllCorpus('rules'), factions: readAllCorpus('factions') };
const byId = new Map(allRecords.map(r => [r.id, r]));
const pickKind = kind => allRecords.find(r => (r.kind || '') === kind);
const dsRec = pickKind('datasheet');
const dsCard = recordCard(dsRec.id, { corpora: bothHalves });
ok('a datasheet record opens the unit card', !!(dsCard && dsCard.card && dsCard.card.models.length));
t('and the category says unit', dsCard.kind, 'datasheet');
t('the record id keeps its corpus prefix', dsCard.id, dsRec.id);
t('the CSV lookup gets the bare id, not the prefix', dsCard.card.name, buildUnitCard(dsRec.id.replace(/^datasheet#/, '')).name);
const baseOf = id => String(String(id).split('#')[1] || '').split('~')[0];
const urRec = allRecords.find(r => r.kind === 'unitrules' && baseOf(r.id) === baseOf(dsRec.id));
ok('the keywords half of the same datasheet opens the same card', !!(urRec && recordCard(urRec.id, { corpora: bothHalves }).card) && recordCard(urRec.id, { corpora: bothHalves }).card.name === dsCard.card.name);
const detRec = pickKind('detachment');
const detCard = recordCard(detRec.id, { corpora: bothHalves });
t('a detachment is a record, not a unit card', [detCard.kind, detCard.card], ['detachment', null]);
ok('and it keeps its own text', detCard.text.length > 0);
// An index target has no source page of its own, so a resolved link keeps its
// to and title and carries a url only when the target has one.
ok('its links stay resolved', detCard.links.length > 0 && detCard.links.every(l => l.to && l.title));
const ruleRec = allRecords.find(r => r.kind === 'rule' && (r.links || []).length > 0);
const ruleCard = recordCard(ruleRec.id, { corpora: bothHalves });
t('a rules section is a rules section', ruleCard.kind, 'rule');
t('and the breadcrumb is split off its heading', ruleCard.crumb.join(' > '), ruleRec.heading.split(' > ').slice(0, -1).join(' > '));
t('the title is the last heading segment', ruleCard.title, ruleRec.heading.split(' > ').pop());
t('a faction rule is a faction record', recordCard(pickKind('faction-rule').id, { corpora: bothHalves }).kind, 'faction-rule');
t('an id the corpus does not hold is null', recordCard('nope#nope', { corpora: bothHalves }), null);
t('an empty id is null', recordCard('', { corpora: bothHalves }), null);
// A dead link is dropped rather than rendered, the rule the build follows.
t('a link with no target in the index is dropped', resolveRecordLinks([{ to: 'ghost#1', title: 'Ghost', kind: 'rule' }], byId), []);
const withAnchor = allRecords.find(r => (r.links || []).some(l => byId.has(l.to) && byId.get(l.to).anchor));
const resolved = resolveRecordLinks(withAnchor.links, byId).find(l => l.anchor);
ok('a resolved link keeps the target anchor and url', !!(resolved && resolved.url && resolved.to && resolved.title));

// --- task-10: one card per id and corpora, not one per record -----------------
// The full render calls the builder for a datasheet's record, its unitrules twin
// and its ~n parts: 3,859 calls for 1,501 cards. The memo's own measure.
resetCardTables(); // start from an empty cache so the count means something
const built0 = cardBuildCount();
const firstBuild = buildUnitCard('000000574');
const secondBuild = buildUnitCard('000000574');
t('the same id builds one card', cardBuildCount() - built0, 1);
ok('and the second call returns the same card object', firstBuild === secondBuild);
const built1 = cardBuildCount();
buildUnitCard('000000574', { corpora: bothHalves });
buildUnitCard('000000574', { corpora: bothHalves });
t('a corpora object is its own cache and builds once', cardBuildCount() - built1, 1);
const otherCorpora = { rules: allRecords, factions: allRecords };
buildUnitCard('000000574', { corpora: otherCorpora });
t('a different corpora object is a different cache', cardBuildCount() - built1, 2);
resetCardTables();
const built2 = cardBuildCount();
buildUnitCard('000000574');
t('resetCardTables starts a new cache generation', cardBuildCount() - built2, 1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
