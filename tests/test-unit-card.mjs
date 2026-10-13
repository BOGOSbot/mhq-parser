import {
  ABILITY_CHARS, buildUnitCard, cardTables, findDatasheet, resetCardTables, unitCard, unitCardEnabled, wantsUnitCard,
} from '../src/unit-card.mjs';
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
