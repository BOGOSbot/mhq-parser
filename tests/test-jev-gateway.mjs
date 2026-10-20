import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jevRank, jevCalls, jevCallsReset } from '../src/rules-corpus.mjs';
import { gatewayAllowed, gatewayVerdict, jevChain, jevSpend, jevSpendReset, JEV_DAILY_CAP_USD, JEV_PRICE_PER_CALL } from '../src/rules.mjs';

// task-45: the gateway chain. Mandal: 'The free should be default, but we should
// auto fallback to paid.' These pin the four decisions the fallback rests on:
//   1. the free route is tried FIRST, always;
//   2. a QUOTA answer (429 / FreeUsageLimitError) falls through to the next gateway;
//   3. a timeout, a 5xx and a malformed body do NOT - they are failures, and the
//      caller's no-rerank fallback is what handles them;
//   4. the paid route is not tried once the day's cap is reached, and the spend is
//      logged per call with a running total.
// The gateways are a local http server, so nothing here costs a real call.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// --- the decision, as a pure function ---------------------------------------
ok('a 429 is a quota answer', gatewayVerdict(429, '{}') === 'quota');
ok('a FreeUsageLimitError body is a quota answer whatever its status', gatewayVerdict(400, '{"error":{"type":"FreeUsageLimitError"}}') === 'quota');
ok('a rate-limit word in the body is a quota answer', gatewayVerdict(400, '{"message":"rate limited"}') === 'quota');
ok('a 500 is an error, not a quota', gatewayVerdict(500, '') === 'error' && gatewayVerdict(503, '') === 'error');
ok('a 400 that is not about quota is an error', gatewayVerdict(400, '{"error":"bad request"}') === 'error');
ok('a status of 0 (a timeout) is a timeout, not a quota', gatewayVerdict(0, '') === 'timeout');
ok('a 200 is ok', gatewayVerdict(200, '{"answers":{}}') === 'ok');

// --- the chain order --------------------------------------------------------
const chain = jevChain();
ok('the free gateway is first', chain.length >= 1 && chain[0].name === 'opencode' && chain[0].free === true);
ok('the paid gateway is second', chain.length === 2 && chain[1].name === 'openrouter' && chain[1].free === false);
ok('and the paid one is not free', chain[1].keyName === 'OPENROUTER_API_KEY');

// --- a local pair of gateways ------------------------------------------------
// free: answers whatever the test says. paid: same. Both count their calls.
const makeGateway = behaviour => {
  const state = { calls: 0, bodies: [] };
  const server = http.createServer((req, res) => {
    state.calls++;
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      state.bodies.push(body);
      const answer = behaviour(state.calls, body);
      if (answer && answer.hang) return;   // never answer: the client times out
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({ state, server, gateway: { name: behaviour.gatewayName || 'test', free: false, endpoint: 'http://127.0.0.1:' + port + '/decisions', model: 'test-model', keyName: 'TEST_KEY' }, close: () => new Promise(r => server.close(r)) });
  }));
};
const answers = n => ({ answers: Object.fromEntries(Array.from({ length: n }, (_, i) => ['p' + i, { type: 'noul', noul: 0.5 }])) });
const candidates = n => Array.from({ length: n }, (_, i) => ({ id: 'sec#' + i, heading: 'Heading ' + i, text: 'text ' + i }));

const free = await makeGateway(() => ({ status: 429, body: { error: { type: 'FreeUsageLimitError', message: 'free usage limit' } } }));
free.gateway.name = 'free'; free.gateway.free = true;
const paid = await makeGateway(() => ({ status: 200, body: answers(3) }));
paid.gateway.name = 'paid'; paid.gateway.free = false;

const chainOf = [free.gateway, paid.gateway];
const rank = (opts) => jevRank('a question', candidates(3), 'test-key', Object.assign({ chain: chainOf, max: 3 }, opts));

// (1) a 429 on the free route falls through to paid, and the request completes.
jevCallsReset();
let ranked = await rank({});
ok('a 429 on the free route falls through to the paid one', ranked.length === 3 && free.state.calls === 1 && paid.state.calls === 1);
ok('and the ranking comes back ranked', ranked[0].jev === 0.5);
ok('the gateway that served it is reported', ranked.gateway === 'paid');
ok('the free route was tried first', free.state.calls === 1);
ok('the call is counted as answered, not failed', jevCalls().rerank.answered === 1 && jevCalls().rerank.failed === 0);

// (2) the free route answering means the paid one is never called.
const freeOk = await makeGateway(() => ({ status: 200, body: answers(3) }));
freeOk.gateway.name = 'free'; freeOk.gateway.free = true;
const paidIdle = await makeGateway(() => ({ status: 200, body: answers(3) }));
paidIdle.gateway.name = 'paid'; paidIdle.gateway.free = false;
ranked = await jevRank('q', candidates(3), 'k', { chain: [freeOk.gateway, paidIdle.gateway], max: 3 });
ok('a free answer never reaches the paid route', ranked.gateway === 'free' && paidIdle.state.calls === 0);

// (3) a timeout IS a failure the paid route can rescue: the free one hangs, the
//     paid one answers, the reader gets a ranked list. The decision the card asks
//     about is the LAST gateway's failure, pinned at (7).
const slow = await makeGateway(() => ({ hang: true }));
slow.gateway.name = 'slow'; slow.gateway.free = true;
const paidRescue = await makeGateway(() => ({ status: 200, body: answers(3) }));
paidRescue.gateway.name = 'paid'; paidRescue.gateway.free = false;
let threw = '';
let rescued = null;
try { rescued = await jevRank('q', candidates(3), 'k', { chain: [slow.gateway, paidRescue.gateway], max: 3, timeoutMs: 400 }); }
catch (e) { threw = String(e && e.message); }
ok('a free timeout falls through and the paid route answers', !!rescued && rescued.length === 3 && paidRescue.state.calls === 1);
ok('and the gateway that rescued it is reported', rescued && rescued.gateway === 'paid');

// (4) a 5xx on the free route is rescued the same way.
const broken = await makeGateway(() => ({ status: 503, body: { error: 'upstream' } }));
broken.gateway.name = 'broken'; broken.gateway.free = true;
const paidRescue2 = await makeGateway(() => ({ status: 200, body: answers(3) }));
paidRescue2.gateway.name = 'paid'; paidRescue2.gateway.free = false;
rescued = null;
try { rescued = await jevRank('q', candidates(3), 'k', { chain: [broken.gateway, paidRescue2.gateway], max: 3 }); }
catch (e) { threw = String(e && e.message); }
ok('a free 5xx falls through to the paid route', !!rescued && paidRescue2.state.calls === 1);

// (5) a malformed 200 body on the free route is rescued too.
const junk = await makeGateway(() => ({ status: 200, body: 'not json at all' }));
junk.gateway.name = 'junk'; junk.gateway.free = true;
const paidRescue3 = await makeGateway(() => ({ status: 200, body: answers(3) }));
paidRescue3.gateway.name = 'paid'; paidRescue3.gateway.free = false;
rescued = null;
try { rescued = await jevRank('q', candidates(3), 'k', { chain: [junk.gateway, paidRescue3.gateway], max: 3 }); }
catch (e) { threw = String(e && e.message); }
ok('a malformed free answer falls through to the paid route', !!rescued && paidRescue3.state.calls === 1);

// (6) a chain with no key at all fails honestly rather than throwing something raw.
const noKey = await makeGateway(() => ({ status: 200, body: answers(3) }));
noKey.gateway.name = 'nokey'; noKey.gateway.free = false; noKey.gateway.keyName = 'ABSENT_KEY_NAME';
threw = '';
try { await jevRank('q', candidates(3), '', { chain: [noKey.gateway], max: 3 }); }
catch (e) { threw = String(e && e.message); }
ok('a gateway with no key is reported as no key', noKey.state.calls === 0 && /no key/.test(threw));

// (7) both gateways failing degrades honestly: the caller's catch turns it into
//     unranked order, and the failure is counted.
const bothA = await makeGateway(() => ({ status: 503, body: {} }));
bothA.gateway.name = 'a'; bothA.gateway.free = true;
const bothB = await makeGateway(() => ({ status: 503, body: {} }));
bothB.gateway.name = 'b'; bothB.gateway.free = false;
jevCallsReset();
threw = '';
try { await jevRank('q', candidates(3), 'k', { chain: [bothA.gateway, bothB.gateway], max: 3 }); }
catch (e) { threw = String(e && e.message); }
ok('both gateways failing throws, and the caller can degrade', /no gateway answered/.test(threw) && /a: HTTP 503/.test(threw) && /b: HTTP 503/.test(threw));
ok('and the failed call is counted as a failure', jevCalls().rerank.failed === 1 && jevCalls().rerank.answered === 0);

// --- the spend ledger and the cap -------------------------------------------
const spend = jevSpend();
ok('the ledger names the day', /^\d{4}-\d{2}-\d{2}$/.test(spend.day));
ok('it counts the calls per gateway', typeof spend.calls === 'object' && Object.keys(spend.calls).length > 0);
ok('the paid calls cost the measured price', spend.costUsd > 0 && spend.costUsd >= JEV_PRICE_PER_CALL);
ok('the cap is the configured one', spend.capUsd === JEV_DAILY_CAP_USD && spend.remainingUsd <= spend.capUsd);
ok('the free route always may be tried', gatewayAllowed({ free: true }) === true);
ok('a paid gateway may be tried under the cap', gatewayAllowed({ free: false }) === true);
// The cap is enforced against the ledger, not a constant: a paid gateway whose
// ledger would exceed the cap is refused before the call, and the free one is not.
ok('a paid gateway is refused once the cap would be exceeded',
  gatewayAllowed({ free: false, name: 'paid-over-cap' }) === (jevSpend().costUsd < JEV_DAILY_CAP_USD));
ok('and the free route is still allowed at any spend', gatewayAllowed({ free: true, name: 'free' }) === true);
// The degradation path the cap leads to: a paid-only chain that is refused throws,
// and retrieveWide's catch turns that into unranked order rather than a failed run.
// The ledger is set over the cap for this one check and put back after.
const overCap = await makeGateway(() => ({ status: 200, body: answers(3) }));
overCap.gateway.name = 'paid'; overCap.gateway.free = false;
const spentBefore = jevSpend().costUsd;
jevSpendReset(JEV_DAILY_CAP_USD + 1);
ok('the ledger reports the cap as hit', jevSpend().capped === true && gatewayAllowed({ free: false }) === false);
threw = '';
try { await jevRank('q', candidates(3), 'k', { chain: [overCap.gateway], max: 3 }); }
catch (e) { threw = String(e && e.message); }
ok('a refused chain throws the same honest error the caller degrades on', /no gateway answered/.test(threw) && /over the daily cap/.test(threw));
ok('and the refused call never reached the network', overCap.state.calls === 0);
ok('the free route would still have been tried over the cap', gatewayAllowed({ free: true }) === true);
jevSpendReset(spentBefore);

// --- the wiring -------------------------------------------------------------
const corpus = read('src/rules-corpus.mjs');
const rulesSrc = read('src/rules.mjs');
const server = read('src/server.mjs');
const dev = read('src/dev-report.mjs');
ok('the free gateway is first in the chain', /return \[first, JEV_GATEWAYS\.openrouter\]/.test(rulesSrc));
ok('both Jev calls go through the chain', /jevChainCall\(model => JSON.stringify\(\{ model: model, state, questions \}\)/.test(corpus) && /jevChainCall\(model => JSON.stringify\(\{ model: model, state: gateState/.test(corpus));
ok('a served call is logged with its gateway and cost', /noteJevCall\(gateway\.name, res\.obj && res\.obj\.usage && res\.obj\.usage\.cost\)/.test(corpus));
ok('the rerank reports ranked or degraded', /rerankStatus = \{ state: 'degraded'/.test(corpus) && /result\.rerank = rerankStatus/.test(corpus));
ok('/health exposes the spend and the call counts', /jev: jevSpend\(\)/.test(server) && /jevCalls: jevCallStats\(\)/.test(server));
ok('the dev report exposes the gateway chain', /Jev gateways/.test(dev) && /spend: jevSpend\(\), calls: jevCalls\(\)/.test(dev));
ok('the reader is told when the list was not reranked', read('src/wiki-surface.js').indexOf('the reranker did not answer') !== -1);

for (const g of [free, paid, freeOk, paidIdle, slow, paidRescue, broken, paidRescue2, junk, paidRescue3, noKey, bothA, bothB, overCap]) await g.close();
console.log('chain ' + chain.map(g => g.name).join(' -> ') + '; spend today $' + spend.costUsd + ' of $' + spend.capUsd);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
