import {
  ABILITY_CHARS, abilityRuleIds, buildUnitCard, cardTables, findAbilityRecord, findDatasheet, resetCardTables, unitCard, unitCardEnabled, wantsUnitCard,
} from '../src/unit-card.mjs';
import { readAllCorpus } from '../src/rules-corpus.mjs';
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

t('Fuegan = 000000574', buildUnitCard('000000574').id, '000000574');
t('the question resolves to the datasheet id', findDatasheet('donne moi le profil de fuegan', 'Give me the profile of FUEGAN.', ['FUEGAN']).id, '000000574');
t('the translated text resolves it too', findDatasheet('', 'Give me the profile of Fuegan.', []).id, '000000574');
t('an unknown unit does not resolve', findDatasheet('donne moi le profil de Zorglub', '', []), null);
t('a bare unit word does not match a longer name', findDatasheet('what is the profile of a rhino', '', []), null);

// --- the Fuegan card, field for field ---------------------------------------
const c = buildUnitCard('000000574');
ok('every field comes from the export, none from a model', c && c.source === 'Aeldari' && c.edition === '11' && c.version === '1.3');
t('the statline is the CSV statline', c.models, [{
  line: '1', name: 'Fuegan', M: '7"', T: '3', Sv: '2+', inv: '4+', W: '5', Ld: '6+', OC: '1', base: '40mm',
}]);
t('the weapons are the CSV weapons', c.ranged.map(w => [w.name, w.range, w.A, w.BS, w.S, w.AP, w.D, w.notes]), [
  ['Searsong – beam', '12', '3', '2', '8', '-3', '2', 'assault, melta 1, sustained hits 2'],
  ['Searsong – lance', '18', '1', '2', '14', '-4', 'D6', 'assault, melta 6'],
]);
t('melee is split out', c.melee.map(w => w.name), ['Fire Axe']);
t('the abilities are named, including the ones resolved through Abilities.csv', c.abilities.map(a => a.type + ':' + a.name), ['Core:Leader', 'Faction:Battle Focus', 'Datasheet:Burning Lance', 'Datasheet:Unquenchable Resolve']);
t('an ability does not repeat its own name and rule id', c.abilities[0].description.slice(0, 19), 'Mighty heroes fight');
ok('a long Faction ability is shortened and says so', c.abilities[1].truncated && c.abilities[1].description.length <= ABILITY_CHARS + 3);
t('the keywords are split into faction and other', c.keywords, {
  faction: ['Asuryani'],
  other: ['Character', 'Epic Hero', 'Aeldari', 'Grenades', 'Aspect Warrior', 'Phoenix Lord', 'Fuegan', 'Infantry'],
});
t('the points are the CSV points', c.points, [{ label: '1 model', cost: '130' }]);
t('the composition keeps its HTML out', c.composition, ['1 Fuegan – EPIC HERO']);
t('the loadout drops the sentence the label already says', c.loadout, 'Searsong; Fire Axe.');
t('Fuegan has no options and no damaged bracket', [c.options, c.damaged], [[], null]);
ok('the card cites the datasheet page', /^https:\/\/wahapedia\.ru\//.test(c.url));

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
t('an ability with no corpus record gets no link', focus.link, null);
ok('and keeps its text instead', focus.description.length > 100);
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
t('a card question is a writer mode of its own', tr.writer, 'card');
t('the trace names the datasheet, not a passage', tr.card, { id: '000000574', name: 'Fuegan' });
t('a card trace carries no findings and no answer', [tr.findings, tr.answer], [[], '']);

// The tables are a cache of files on disk; a reload must give the same card.
resetCardTables();
t('a reloaded table set gives the same card', buildUnitCard('000000574').models[0].T, '3');
ok('the table cache is one object', cardTables() === cardTables());

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
