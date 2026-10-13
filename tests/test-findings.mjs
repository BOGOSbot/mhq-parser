import http from 'node:http';
import { findingFor, gateHalf, jevCalls, jevCallsReset, jevRank, retrieveWide } from '../src/rules-corpus.mjs';

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


// --- the Jev counter witnesses success, not the attempt ----------------------
// The counter used to increment before the request, so a 429 was counted as a
// rerank call: a dual arm measured while the free gateway was rate-limiting
// printed '66 rerank calls' and reproduced the recorded no-rerank row to the
// digit. An attempt alone cannot witness a success. The three counters are the
// fix - attempted, answered, failed - and only a response good enough to rank
// with is an answer. A local gateway stands in for the shared one, so none of
// this costs a call.
const replies = [];
const server = http.createServer((req, res) => {
  const r = replies.shift() || { status: 200, obj: {} };
  res.writeHead(r.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(r.obj));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const JEV_ENDPOINT_TEST = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions';
const ONE = [{ id: 'emb', heading: 'Embarking', text: 'A unit can embark.' }];
const rerankCalls = () => { const c = jevCalls(); return [c.rerank.attempted, c.rerank.answered, c.rerank.failed]; };
const gateCalls = () => { const c = jevCalls(); return [c.gate.attempted, c.gate.answered, c.gate.failed]; };

replies.push({ status: 200, obj: { answers: { p0: { noul: 1 } } } });
jevCallsReset();
await jevRank('can a unit embark?', ONE, 'key', { endpoint: JEV_ENDPOINT_TEST });
t('an answered rerank is an attempt and an answer', rerankCalls(), [1, 1, 0]);

replies.push({ status: 429, obj: { error: 'rate limited' } });
jevCallsReset();
let threw429 = false;
try { await jevRank('can a unit embark?', ONE, 'key', { endpoint: JEV_ENDPOINT_TEST }); } catch { threw429 = true; }
t('a 429 throws', threw429, true);
t('a thrown rerank is not counted as answered', rerankCalls(), [1, 0, 1]);

replies.push({ status: 200, obj: { error: 'no answers field here' } });
jevCallsReset();
let threwBody = false;
try { await jevRank('can a unit embark?', ONE, 'key', { endpoint: JEV_ENDPOINT_TEST }); } catch { threwBody = true; }
t('HTTP 200 without an answers field throws', threwBody, true);
t('an unusable body is a failure, not an answer', rerankCalls(), [1, 0, 1]);

// The page's fallback must still work - the fusion order comes back - but the
// measurement has to see that it happened.
replies.push({ status: 429, obj: { error: 'rate limited' } });
jevCallsReset();
const fallback = await retrieveWide('can a unit embark after shooting?', {
  corpus, namespace: 'rules', cfg: { url: 'http://127.0.0.1:1', token: 'none' },
  terms: ['embark'], topK: 3, grepNet: 10, jevKey: 'key', jevEndpoint: JEV_ENDPOINT_TEST,
});
ok('a failed rerank still returns the fusion order', fallback.length > 0);
t('the page fallback is a failure, never an answer', rerankCalls(), [1, 0, 1]);
// The bank's OFF control: the key stays, the call is skipped, and the rest of
// the path runs. It must land on the same list as a rerank that threw - that is
// what makes it a control for the ranked arm instead of a different pipeline.
jevCallsReset();
const skipped = await retrieveWide('can a unit embark after shooting?', {
  corpus, namespace: 'rules', cfg: { url: 'http://127.0.0.1:1', token: 'none' },
  terms: ['embark'], topK: 3, grepNet: 10, jevKey: 'key', jevSkip: true,
});
t('jevSkip is the pipeline a thrown rerank falls into', skipped.map(f => f.id), fallback.map(f => f.id));
t('jevSkip spends no call at all', rerankCalls(), [0, 0, 0]);

// --- the no-key path is the same path ----------------------------------------
// A deployment with no Jev key used to return the fused top K before anchoring,
// head protection and clarification, so the record the question names could sit
// outside the findings. It is one pipeline now: the no-key list and the
// key-present-with-the-call-skipped list must be the same, and the anchored
// record and its clarification must both be in it.
const anchorCorpus = [
  { id: 'emb', set: 'rules', heading: 'Embarking', text: 'A unit can embark on a transport it is within 3" of.' },
  { id: 'embq', set: 'rules', heading: 'Embarking > Able To Embark', text: 'A unit that disembarked this turn has made a set-up move and cannot embark again.' },
  { id: 'shoot', set: 'rules', heading: 'Shooting Types', text: 'shooting shooting shooting the shooting types a unit can make when it shoots.' },
  { id: 'move', set: 'rules', heading: 'NORMAL MOVE', text: 'Move the unit up to its Move characteristic.' },
];
const anchorQ = 'can a unit embark after shooting?';
const anchorOpts = { corpus: anchorCorpus, namespace: 'rules', cfg: { url: 'http://127.0.0.1:1', token: 'none' }, terms: ['embark'], topK: 2, grepNet: 10 };
jevCallsReset();
const fromNoKey = await retrieveWide(anchorQ, anchorOpts);
const fromSkip = await retrieveWide(anchorQ, Object.assign({ jevKey: 'key', jevSkip: true }, anchorOpts));
t('no key and a skipped call run one path', fromNoKey.map(f => f.id), fromSkip.map(f => f.id));
t('no key spends no call', rerankCalls(), [0, 0, 0]);
ok('the record the question names reaches a no-key retrieval', fromNoKey.some(f => f.id === 'emb'));
ok('its clarification travels with it', fromNoKey.some(f => f.id === 'embq'));

replies.push({ status: 429, obj: { error: 'rate limited' } });
jevCallsReset();
process.env.RULES_JEV_STRICT = '1';
let strictThrew = false;
try {
  await retrieveWide('can a unit embark after shooting?', {
    corpus, namespace: 'rules', cfg: { url: 'http://127.0.0.1:1', token: 'none' },
    terms: ['embark'], topK: 3, grepNet: 10, jevKey: 'key', jevEndpoint: JEV_ENDPOINT_TEST,
  });
} catch { strictThrew = true; }
delete process.env.RULES_JEV_STRICT;
t('RULES_JEV_STRICT rethrows instead of falling back', strictThrew, true);

replies.push({ status: 200, obj: { answers: { half: { choice: 'rules', confidence: 0.9 } } } });
jevCallsReset();
const g = await gateHalf('What is Engagement?', 'key', { endpoint: JEV_ENDPOINT_TEST });
t('an answered gate is an attempt and an answer', [g.half].concat(gateCalls()), ['rules', 1, 1, 0]);

replies.push({ status: 429, obj: { error: 'rate limited' } });
jevCallsReset();
const g2 = await gateHalf('What is Engagement?', 'key', { endpoint: JEV_ENDPOINT_TEST });
t('a failed gate is a failure, not an abstention', [g2.half].concat(gateCalls()), ['', 1, 0, 1]);

server.close();
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
