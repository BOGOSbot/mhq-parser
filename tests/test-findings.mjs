import { findingFor, retrieveWide } from '../src/rules-corpus.mjs';

// The page labels every finding with the leg that produced it and outlines the
// words the lexical leg matched, so the provenance has to survive the fusion,
// the rerank and the anchoring. No network here: the vector leg fails against a
// closed port and is caught exactly as it is in production, which leaves the
// lexical pass to carry the test.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const corpus = [
  { id: 'emb', set: 'rules', heading: 'Embarking', text: 'A unit can embark on a transport it is within 3\" of.', url: 'https://x/core-rules', ruleId: '18.02' },
  { id: 'dis', set: 'rules', heading: 'Disembarking', text: 'A unit that disembarks has made a set-up move.', url: 'https://x/core-rules', ruleId: '18.01' },
  { id: 'move', set: 'rules', heading: 'NORMAL MOVE', text: 'Move the unit up to its Move characteristic.', url: 'https://x/core-rules' },
];

const found = await retrieveWide('can a unit embark after shooting?', {
  corpus,
  namespace: 'rules',
  cfg: { url: 'http://127.0.0.1:1', token: 'none' },
  terms: ['embark', 'shoot'],
  topK: 3,
  grepNet: 10,
});

ok('the lexical pass found the rule', found.some(f => f.id === 'emb'));
const emb = found.find(f => f.id === 'emb');
t('a word-match is labelled lexical', emb.leg, 'lexical');
ok('the matched words travel with it', emb.matchedTerms.indexOf('embark') !== -1);
t('the matched words are lower case, deduped', emb.matchedTerms, Array.from(new Set(emb.matchedTerms)));
ok('every finding carries a leg and a rank', found.every(f => f.leg && f.rank >= 1));
t('ranks are positions in this half', found.map(f => f.rank), found.map((_, i) => i + 1));
t('a word-start term does not read the longer word', (found.find(f => f.id === 'dis') || {}).matchedTerms || [], []);

// findingFor is the boundary the page sees: the provenance has to pass through.
const f = findingFor({ id: 'emb', set: 'rules', heading: 'Embarking', text: 'x', url: 'https://x', ruleId: '18.02', leg: 'both', rank: 4, vectorRank: 2, vectorScore: 0.81, lexicalRank: 9, matchedTerms: ['embark'] }, 3);
t('the finding keeps its retriever leg', f.leg, 'both');
t('the finding keeps its rank', f.rank, 4);
t('the vector similarity is carried beside its rank', [f.vectorRank, f.vectorScore], [2, 0.81]);
t('the lexical rank and matched words are carried', [f.lexicalRank, f.matchedTerms], [9, ['embark']]);

// A caller that builds a finding by hand has no provenance, and nothing may
// invent one for it.
const bare = findingFor({ id: 'x', set: 'rules', heading: 'H', text: 't', url: 'u' }, 1);
t('a hand-built finding carries no leg', [bare.leg, bare.rank, bare.matchedTerms], ['', 0, []]);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
