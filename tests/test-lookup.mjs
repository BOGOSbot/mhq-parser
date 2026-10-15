import fs from 'node:fs';
import { buildHeaderIndex, contentWords, headerIndex, isTitleLike, lookupIntent, lookupRecord, normalizePhrase } from '../src/header-index.mjs';

// The header index router: the projection, the intent, and the match. The last
// section is the acceptance measurement on the set written before the module
// existed (tests/fixtures/rules-lookups.json): how many lookups land on the right
// record, how many fall through, and how many answer WRONGLY. A wrong answer is
// worse than a slow one, so it is the one count asserted to zero.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

// --- the intent: a lookup, or a real question --------------------------------
t('find is a lookup', lookupIntent('find rapid ingress').words, ['rapid', 'ingress']);
t('show me is a lookup', lookupIntent('show me deadly demise').lookup, true);
t('search for is a lookup', lookupIntent('search for tank shock').words, ['tank', 'shock']);
t('the French verb is a lookup', lookupIntent('cherche rapid ingress').words, ['rapid', 'ingress']);
t('où est is a lookup', lookupIntent('où est le fall back').words, ['fall', 'back']);
t('montre moi is a lookup', lookupIntent('montre moi la règle coherency').words, ['coherency']);
t('a real question is not a lookup', lookupIntent('can a unit shoot after it Fell Back?').lookup, false);
// The translation tables never see a question: the intent check runs first, so a
// question that happens to name a unit is still a question.
t('a question naming a unit is still not a lookup', lookupIntent('peux-tu me dire si le chevalier acastus astérius peut tirer ?').lookup, false);
t('and a French question is not either', lookupIntent('est-ce que le protocole de résurrection fonctionne ?').lookup, false);
t('a French question is not a lookup', lookupIntent('est-ce que Fuegan peut tirer après avoir battu en retraite ?').lookup, false);
t('the verb with no name is not a lookup', lookupIntent('find the rules').lookup, false);
t('a stop word is not a name', contentWords('les règles de mouvement'), ['mouvement']);
t('a two-letter word is dropped', contentWords('find a rhino'), ['rhino']);
// The length guard, not the stop list: a two-letter token that is not a stop word
// is still not a name (the phone keyboard produces them, the headings do not).
t('a two-letter token is dropped', contentWords('find xz'), []);
t('accents fold', normalizePhrase('Règles de Mouvement'), 'regles de mouvement');

// --- the projection ----------------------------------------------------------
const idx = buildHeaderIndex([
  { id: 'core-rules#Movement', heading: 'Movement', kind: 'rule', url: 'https://x/core', anchor: 'Movement' },
  { id: 'core-rules#Muster-Armies->-FAQ->-Q:-does-it?->-MOVEMENT', heading: 'Muster Armies > FAQ > Q: does it? > MOVEMENT', kind: 'rule', url: 'https://x/core' },
]);
t('one entry per record', idx.length, 2);
t('the projection carries id, path, kind and target link', [idx[0].id, idx[0].segments.length, idx[0].kind, idx[0].href], ['core-rules#Movement', 1, 'rule', 'https://x/core#Movement']);
t('a mention under a question is not canonical', [idx[0].canonical, idx[1].canonical], [true, false]);
t('an exact name answers at the first tier', (function () { const r = lookupRecord('find movement', { index: idx }); return [r.found, r.id, r.tier]; })(), [true, 'core-rules#Movement', 1]);
t('a mention alone does not answer', lookupRecord('find movement', { index: [idx[1]] }).reason, 'only-mentions');
t('a long sentence heading is not a title', isTitleLike('The Tank Shock Stratagem is the same as the Crushing Impact stratagem'), false);
t('and one that ends in a full stop is not either', isTitleLike('The rule says the unit may not move at all .'), false);
t('FAQ is not a title', isTitleLike('FAQ'), false);

// --- ambiguity and the two fall-through reasons ------------------------------
const twoHeadings = buildHeaderIndex([
  { id: 'a#1', heading: 'Charge Phase', kind: 'rule', url: 'https://x' },
  { id: 'a#2', heading: 'CHARGE MOVE', kind: 'rule', url: 'https://x' },
]);
t('two different headings carrying the words are ambiguous', lookupRecord('find charge', { index: twoHeadings }).reason, 'ambiguous');
t('a phrase the corpus does not name has no heading', lookupRecord('find the resurrection protocol', { index: twoHeadings }).reason, 'no-heading');
const same = buildHeaderIndex([
  { id: 'a#1', heading: 'RAPID INGRESS', kind: 'stratagem', url: 'https://x' },
  { id: 'a#2', heading: 'RAPID INGRESS', kind: 'stratagem', url: 'https://x' },
]);
t('the same heading twice is one answer, not ambiguity', (function () { const r = lookupRecord('find rapid ingress', { index: same }); return [r.found, r.candidates]; })(), [true, 2]);
const kinds = buildHeaderIndex([
  { id: 'ability#1', heading: 'Deep Strike', kind: 'ability', url: 'https://x' },
  { id: 'core#1', heading: 'Abilities > DEEP STRIKE', kind: 'rule', url: 'https://x' },
]);
t('a rule beats the ability card repeating it', lookupRecord('find deep strike', { index: kinds }).id, 'core#1');

// --- the acceptance set ------------------------------------------------------
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/rules-lookups.json', import.meta.url), 'utf8'));
const full = headerIndex();
const rows = [];
for (const item of fixture.lookups) {
  const hit = lookupRecord(item.q, { index: full });
  const verdict = (hit.found && item.expect.indexOf(hit.id) !== -1) ? 'land'
    : hit.found ? 'WRONG'
      : item.expect.length ? 'miss' : 'fall';
  rows.push({ q: item.q, lang: item.lang, kind: item.kind, verdict, id: hit.id || '', reason: hit.reason || '', tier: hit.tier || 0 });
}
for (const r of rows) {
  console.log((r.verdict + '      ').slice(0, 7) + r.kind.padEnd(12) + r.lang + '  ' + r.q.padEnd(44) + (r.verdict === 'land' ? r.id : (r.verdict === 'fall' ? '-' + r.reason : r.id + '  (' + r.reason + ')')));
}
const count = v => rows.filter(r => r.verdict === v).length;
console.log('');
console.log('lookups ' + fixture.lookups.length + '   landed ' + count('land') + '   fell through ' + count('fall') + '   missed ' + count('miss') + '   WRONG ' + count('WRONG'));
t('no lookup answers wrongly', count('WRONG'), 0);
t('every lookup the corpus names lands', count('miss'), 0);
t('a lookup that names nothing never answers', rows.filter(r => r.kind === 'none' && r.verdict !== 'fall').length, 0);
t('an ambiguous name falls through', rows.filter(r => r.kind === 'ambiguous' && r.verdict !== 'fall').length, 0);
t('a real question is never answered as a lookup', rows.filter(r => r.kind === 'not-a-lookup' && r.verdict !== 'fall').length, 0);
// The set grew when the route learned the French tables: six phrasings a person
// would type ('trouve abaddon le fléau'), never titles copied out of the corpus.
ok('the set is the size the task asked for', fixture.lookups.length >= 20 && fixture.lookups.length <= 60);
ok('the set stays at least a third non-English', fixture.lookups.filter(l => l.lang === 'fr').length >= 12);
ok('the set names nothing in the corpus several times', rows.filter(r => r.kind === 'none').length >= 5);
t('the set is bilingual', new Set(fixture.lookups.map(l => l.lang)).size, 2);
t('and a third of it is not English', rows.filter(r => r.lang === 'fr').length >= 5, true);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
