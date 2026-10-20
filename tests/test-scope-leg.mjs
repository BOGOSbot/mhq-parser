import { readAllCorpus, indexedSections, scopeIndex, scopeKeywords, scopeLookup, scopeLegIndex, entityKeywords, retrieveDual, findingFor, judgePrompt, passageCaps, passageTruncation } from '../src/rules-corpus.mjs';

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


// --- task-67: the scope record's budget in the judge's prompt ------------------
// The leg's records reached the widened findings and were then CUT by the prompt's
// per-passage budget: at the widest pass (63 passages) each got 952 characters, and the
// Enginseer's record is 1,374 with its answer at 1,043, so the judge read the ability's
// opening and never its effect. A record the leg found now gets its full length; the
// rest of the list shares what is left.
{
  const many = Array.from({ length: 63 }, (_, i) => ({ id: 'r' + i, text: 'x'.repeat(1400), scope: i === 0 || i === 1 }));
  const caps = passageCaps(many, {});
  ok('a scope record gets its full length', caps[0] === 2400 && caps[1] === 2400);
  ok('the rest of the list shares what is left', caps[2] < 2400 && caps[2] >= 400);
  ok('and the total stays inside the prompt budget', caps.reduce((a, b) => a + b, 0) <= 60000);
  const plain = passageCaps(many.map(p => ({ id: p.id, text: p.text })), {});
  ok('with no scope record every passage is treated the same', new Set(plain).size === 1);
  const uniform = passageCaps(many, { perPassage: 2400, totalChars: 60000 });
  ok('an explicit perPassage pins one budget for every passage', uniform.every(c => c === uniform[0]));
  const t = passageTruncation(many, {});
  ok('the truncation count is published', t.passages === 63 && t.cut === 61 && t.dropped > 0);
  const none = passageTruncation([{ text: 'short', scope: true }, { text: 'short' }], {});
  ok('a list that fits is not counted as cut', none.cut === 0 && none.dropped === 0);
}
// The prompt itself: the scope record's text is whole, and the finding carries the mark.
{
  const all2 = readAllCorpus();
  const rules2 = all2.filter(r => r.set === 'rules');
  const factions2 = all2.filter(r => r.set === 'factions');
  const dual = await retrieveDual('Can a baneblade have an invulnerable save?', { corpus: all2, rulesCorpus: rules2, factionsCorpus: factions2, mode: 'fast', topK: 30, jevSkip: true, scopeLeg: true });
  const findings = (dual.all || []).map((s, i) => findingFor(s, i + 1));
  const eng = findings.find(f => f.id === 'unitrules#000001396');
  ok('the scope record is marked on the finding', !!eng && eng.scope === true);
  const prompt = judgePrompt('Can a baneblade have an invulnerable save?', findings, {});
  ok('the prompt carries the scope record\u2019s answer, not just its opening', /that VEHICLE model has a 4\+ invulnerable save/.test(prompt));
  const caps2 = passageCaps(findings, {});
  ok('the scope record is not truncated in the prompt', String(eng.text).length <= caps2[findings.indexOf(eng)]);
  const before = passageTruncation(findings, { perPassage: 2400, totalChars: 60000 });
  const after = passageTruncation(findings, {});
  ok('the cut count is reported for both budgets', before.cut > 0 && after.cut > 0);
  console.log('truncation: uniform cap ' + before.cut + ' passages cut / ' + before.dropped + ' chars dropped; scope-full ' + after.cut + ' cut / ' + after.dropped + ' dropped');
}


// --- task-67: an EMPTY terms array is not 'no terms' --------------------------
// The server passes the translation's terms, which is [] for an English question.
// `o.terms || grepTerms(question)` treated [] as truthy, so every record scored zero
// capability terms and the leg returned whichever three the rarity weight favoured -
// measured on the Box as three Astra Militarum stratagems instead of the Enginseer.
{
  const q = 'Can a baneblade have an invulnerable save?';
  const corpus = indexedSections(readAllCorpus());
  const kws = entityKeywords(q, corpus, {});
  const idx = scopeLegIndex();
  const withEmpty = scopeLookup(q, idx, kws, { cap: 3, terms: [] }).map(r => r.id);
  const withNone = scopeLookup(q, idx, kws, { cap: 3 }).map(r => r.id);
  ok('an empty terms array falls back to the question\u2019s own words', withEmpty.join(',') === withNone.join(','));
  ok('and the lookup still reaches the Enginseer', withEmpty.indexOf('unitrules#000001396') !== -1);
  ok('a real terms list is still used', scopeLookup(q, idx, kws, { cap: 3, terms: ['invulnerable'] }).length > 0);
}

console.log(pass + ' passed, ' + fail + ' failed');
console.log('scope index: ' + index.size + ' keywords');
process.exitCode = fail ? 1 : 0;
