import { readAllCorpus, indexedSections, scopeIndex, scopeKeywords, scopeLookup, entityKeywords, retrieveDual } from '../src/rules-corpus.mjs';

// task-65: the scope leg. A rule scoped to a KEYWORD ('one friendly ASTRA MILITARUM
// VEHICLE model') is reachable FROM that keyword, because the two records that must
// meet - the unit and the rule - share no word of their own (task-57 measured the
// Enginseer at lexical 24 of 80, absent from the vector top 80; task-61 measured that
// embedding either record's own keywords is worse on every column).
//
// What is pinned here: the index really is built from scope phrases, the lookup is
// capped and ranked, it fires only for a question that names an entity, and the
// Baneblade case reaches the Enginseer.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };

const all = readAllCorpus();
const corpus = indexedSections(all);
const index = scopeIndex(corpus);
ok('the scope index is built from the corpus', index.size > 100);
ok('VEHICLE is a scope keyword', (index.get('VEHICLE') || []).length > 5);
ok('and ASTRA and MILITARUM are', (index.get('ASTRA') || []).length > 0 && (index.get('MILITARUM') || []).length > 0);
ok('a scope keyword points at records, not at the unit that carries it', (index.get('VEHICLE') || []).every(r => !!r.id && !!r.text));

// The phrase reader: a scope target is a keyword run before 'model'/'unit'.
const kws = scopeKeywords('select one friendly Astra Militarum Vehicle model within 3" of this model');
ok('the phrase reader finds ASTRA', kws.has('ASTRA'));
ok('and MILITARUM and VEHICLE', kws.has('MILITARUM') && kws.has('VEHICLE'));
ok('a lower-case word is not a keyword', scopeKeywords('select one friendly unit within 3"').size === 0);
ok('the sentence "this model has a 4+ invulnerable save" scopes nothing', scopeKeywords('The bearer has a 4+ invulnerable save.').size === 0);

const BANE = 'Can a baneblade have an invulnerable save?';
const baneKws = entityKeywords(BANE, corpus, {});
ok('the question resolves to the Baneblade\u2019s own keywords', baneKws.indexOf('VEHICLE') !== -1 && baneKws.indexOf('ASTRA MILITARUM') !== -1);
ok('and not to a keyword the Baneblade does not carry', baneKws.indexOf('PSYKER') === -1);
const hits = scopeLookup(BANE, index, baneKws, { cap: 3 });
ok('the lookup is capped', hits.length <= 3);
ok('and reaches the Enginseer\u2019s Omnissiah\u2019s Blessing', hits.some(r => r.id === 'unitrules#000001396'));
ok('the record it returns really names the keyword in a grant', hits.some(r => /one friendly Astra Militarum Vehicle model/i.test(String(r.text))));
ok('a question with no entity scopes nothing', scopeLookup('What is a Hazard Roll?', index, entityKeywords('What is a Hazard Roll?', corpus, {}), { cap: 3 }).length === 0);

// The leg as the retrieval runs it: on for the Baneblade question, and off when asked
// to be off - the two arms the measurement compares.
{
  const rules = all.filter(r => r.set === 'rules');
  const factions = all.filter(r => r.set === 'factions');
  const withLeg = await retrieveDual(BANE, { corpus: all, rulesCorpus: rules, factionsCorpus: factions, mode: 'fast', topK: 10, jevSkip: true, scopeLeg: true });
  const without = await retrieveDual(BANE, { corpus: all, rulesCorpus: rules, factionsCorpus: factions, mode: 'fast', topK: 10, jevSkip: true, scopeLeg: false });
  const at = (r) => (r.all || []).findIndex(x => x.id === 'unitrules#000001396');
  ok('with the scope leg the Enginseer is in the findings', at(withLeg) !== -1);
  ok('without it, it is not', at(without) === -1);
  // The record may reach the list through the lexical leg AND be pulled forward by the
  // scope leg - it carries the scope keys, which is what proves the leg found it. The
  // leg label stays whatever else found it first; the position is the leg's work.
  ok('and it carries the scope keys the leg matched', (withLeg.all || []).some(x => x.id === 'unitrules#000001396' && (x.scopeKeys || []).length >= 2));
  // Inserted above the anchors, not appended: an appended record lands past the cut.
  ok('it is inside the list the judge is shown, not at the tail', at(withLeg) < (withLeg.all || []).length - 3);
  ok('the retriever\u2019s own head keeps its place', (withLeg.all || [])[0].id === (without.all || [])[0].id);
  const plain = await retrieveDual('What is a Hazard Roll?', { corpus: all, rulesCorpus: rules, factionsCorpus: factions, mode: 'fast', topK: 10, jevSkip: true });
  ok('a question with no entity adds no scope records', (plain.all || []).every(x => x.leg !== 'scope'));
}

console.log(pass + ' passed, ' + fail + ' failed');
console.log('scope index: ' + index.size + ' keywords');
process.exitCode = fail ? 1 : 0;
