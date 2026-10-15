import { cfRank, cfStats, cfStatsReset, jevCalls, jevCallsReset, rerankArm, CF_MAX_CHARS } from '../src/rules-corpus.mjs';

// task-72: the Cloudflare rerank arm. The live call cannot run yet (no token in the
// credential store), so these tests pin everything except the network: the arm
// switch, the request shape, position mapping, truncation-with-a-count, and the
// call accounting that stops a failed arm printing as a good reading.
let pass = 0, fail = 0;
function t(name, got, want) { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); } }
function ok(name, got) { t(name, !!got, true); }

t('the arm defaults to jev', rerankArm({}), 'jev');
t('cf is selectable', rerankArm({ RULES_RERANK: 'cf' }), 'cf');
t('off is selectable', rerankArm({ RULES_RERANK: 'off' }), 'off');
t('anything unknown is jev, never a silent change of arm', rerankArm({ RULES_RERANK: 'cloudflare' }), 'jev');

const cands = (n, len) => Array.from({ length: n }, (_, i) => ({ id: 'rec' + i, text: 'x'.repeat(len || 40) }));
let seen = null;
globalThis.fetch = async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ result: { response: [{ id: 2, score: 0.9 }, { id: 0, score: 0.5 }, { id: 1, score: 0.1 }] } }) }; };
jevCallsReset(); cfStatsReset();
const out = await cfRank('what is engagement?', cands(3), 'test-token', { account: 'acct-1' });
t('records are mapped back by the response id, ordered by score', out.map(r => r.id), ['rec2', 'rec0', 'rec1']);
ok('the request is the Cloudflare reranker with the query and contexts', seen.url.indexOf('/accounts/acct-1/ai/run/@cf/baai/bge-reranker-base') !== -1 && seen.body.query === 'what is engagement?' && seen.body.contexts.length === 3 && seen.body.top_k === 3);
ok('the token travels in the Authorization header only', seen.init.headers.authorization === 'Bearer test-token' && JSON.stringify(seen.body).indexOf('test-token') === -1 && seen.url.indexOf('test-token') === -1);
t('an answered call counts as an answer', [jevCalls().rerank.attempted, jevCalls().rerank.answered, jevCalls().rerank.failed], [1, 1, 0]);
t('and the arm reports its own stats', [cfStats().calls, cfStats().returned, cfStats().truncated], [1, 3, 0]);

// Truncation: a record over the cap is SHORTENED and still scored, never dropped.
seen = null; jevCallsReset(); cfStatsReset();
const long = await cfRank('q', cands(2, CF_MAX_CHARS + 500), 'test-token', { account: 'acct-1' });
t('an over-cap record is truncated to the cap', seen.body.contexts[0].text.length, CF_MAX_CHARS);
t('and is counted as truncated, not dropped', [cfStats().truncated, long.length], [2, 2]);

// A response without ids is mapped by position.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { response: [{ score: 0.2 }, { score: 0.8 }] } }) });
jevCallsReset(); cfStatsReset();
t('a response without ids maps by position', (await cfRank('q', cands(2), 'k', { account: 'a' })).map(r => r.id), ['rec1', 'rec0']);

// Failure paths: no fetch is even attempted without a token, and the accounting
// refuses to call it a success.
let fetched = 0;
globalThis.fetch = async () => { fetched++; throw new Error('network'); };
jevCallsReset(); cfStatsReset();
let err = '';
try { await cfRank('q', cands(1), '', { account: 'a' }); } catch (e) { err = String(e.message); }
ok('a missing token fails without a call', fetched === 0 && /CLOUDFLARE_API_TOKEN/.test(err));
t('and is counted as a failed attempt, never an answer', [jevCalls().rerank.attempted, jevCalls().rerank.answered, jevCalls().rerank.failed], [1, 0, 1]);
err = '';
try { await cfRank('q', cands(1), 'k', { account: 'a' }); } catch (e) { err = String(e.message); }
ok('a network failure propagates and is counted', fetched === 1 && jevCalls().rerank.failed === 2 && jevCalls().rerank.answered === 0);

// A failed bank arm's numbers must not print as good: the eval withholds on any
// fallback, and the counter is the witness.
jevCallsReset();
globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
try { await cfRank('q', cands(2), 'k', { account: 'a' }); } catch (e) {}
ok('a 429 lands in failed, so the run is DEGRADED and the numbers are withheld', jevCalls().rerank.failed === 1 && jevCalls().rerank.answered === 0);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
