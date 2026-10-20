import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JEV_NONE, choiceAskFor, jevRank, jevShape, noulAskFor, orderByChoice } from '../src/rules-corpus.mjs';

// task-47: the rerank's question shape. The noul shape asks an absolute question per
// candidate and sorts the answers; the choice shape asks ONE comparative question for
// the whole half and reads the probability distribution back. Measured on the
// 33-question bank, same candidates and corpus: noul 18/26/26/27 MRR .622, choice
// 20/27/29/30 MRR .698, retrieval order 15/26/28/29 .582 - and the choice shape does
// it with 2 sub-questions a question instead of ~134.
//
// What this file pins: the two question shapes, the ORDER a choice answer produces
// (ranked by probability, ties keep the retrieval order), the rule that 'none' is
// recorded but never acted on, that the default is the choice shape, and that the
// noul shape is still reachable for a before/after.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const top = [
  { id: 'sec#a', heading: 'A rule', ruleId: '01.01', text: 'text a' },
  { id: 'sec#b', heading: 'B rule', text: 'text b' },
  { id: 'sec#c', heading: 'C rule', ruleId: '03.02', text: 'text c' },
];

// --- the shape selector ------------------------------------------------------
ok('the default shape is the choice one', jevShape() === 'choice' && jevShape({}) === 'choice');
ok('opts.shape picks the noul shape', jevShape({ shape: 'noul' }) === 'noul');
ok('an unknown shape falls back to choice', jevShape({ shape: 'whatever' }) === 'choice');
const prevEnv = process.env.RULES_JEV_SHAPE;
process.env.RULES_JEV_SHAPE = 'noul';
ok('RULES_JEV_SHAPE=noul is honoured', jevShape() === 'noul');
ok('and opts.shape still wins over it', jevShape({ shape: 'choice' }) === 'choice');
if (prevEnv === undefined) delete process.env.RULES_JEV_SHAPE; else process.env.RULES_JEV_SHAPE = prevEnv;
ok('and the env is back to the default', jevShape() === 'choice');

// --- the two question shapes -------------------------------------------------
const cq = choiceAskFor('can a unit shoot after falling back?', top);
ok('the choice shape asks ONE question', Object.keys(cq).length === 1 && !!cq.pick);
ok('of type choice', cq.pick.type === 'choice');
ok('the instructions name the question', cq.pick.instructions.indexOf('can a unit shoot after falling back?') !== -1);
ok('every candidate is a criterion', top.every((c, i) => typeof cq.pick.criteria['p' + i] === 'string'));
ok('the label is the heading and its number', cq.pick.criteria.p0 === 'A rule (01.01)' && cq.pick.criteria.p1 === 'B rule');
ok('and the pool can say none of these', cq.pick.criteria[JEV_NONE] === 'None of these passages states the rule that answers it');
const nq = noulAskFor('can a unit shoot after falling back?', top);
ok('the noul shape asks one question per candidate', Object.keys(nq).length === 3 && nq.p0 && nq.p2);
ok('of type noul with a true/false map', nq.p0.type === 'noul' && nq.p0.criteria.true && nq.p0.criteria.false);

// --- the order a choice answer produces --------------------------------------
const probs = (map, none) => ({ choice: 'p1', probabilities: Object.assign({ p0: 0.1, p1: 0.7, p2: 0.2 }, none === undefined ? {} : { [JEV_NONE]: none }) });
let r = orderByChoice(top, probs());
ok('the order is by probability, best first', r.order.map(x => x.id).join(',') === 'sec#b,sec#c,sec#a');
ok('every ranked record carries its probability', r.order[0].jev === 0.7 && r.order[2].jev === 0.1);
ok('the answer\'s pick is reported', r.pick === 'p1');
// ties keep the retrieval order: the rerank may only move a candidate UP.
r = orderByChoice(top, { probabilities: { p0: 0, p1: 0, p2: 0 } });
ok('all-zero probabilities leave the retrieval order alone', r.order.map(x => x.id).join(',') === 'sec#a,sec#b,sec#c');
r = orderByChoice(top, { probabilities: { p0: 0.5, p1: 0.5, p2: 0 } });
ok('a tie keeps the earlier candidate first', r.order.map(x => x.id).join(',') === 'sec#a,sec#b,sec#c');
r = orderByChoice(top, { probabilities: { p0: 0, p1: 0, p2: 0.9 } });
ok('a candidate can be moved to the front', r.order.map(x => x.id).join(',') === 'sec#c,sec#a,sec#b');
// a missing or malformed map is not an error: the input order stands.
ok('a missing answer leaves the input order', orderByChoice(top, null).order.map(x => x.id).join(',') === 'sec#a,sec#b,sec#c');
ok('a missing probabilities map leaves the input order', orderByChoice(top, { choice: 'p1' }).order.map(x => x.id).join(',') === 'sec#a,sec#b,sec#c');
r = orderByChoice(top, { probabilities: { p0: 'x', p1: null, p2: 0.4 } });
ok('a non-numeric probability counts as zero', r.order.map(x => x.id).join(',') === 'sec#c,sec#a,sec#b');
// 'none' is recorded and never acted on: the measurement says sorting anyway beats
// falling back to the retrieval order when the model picks it (MRR .711 vs .676).
r = orderByChoice(top, probs(1.0, 1.0));
ok('none is reported', r.none === 1);
ok('but none does NOT reorder the candidates', r.order.map(x => x.id).join(',') === 'sec#b,sec#c,sec#a');
ok('a none pick is reported as the pick', r.pick === 'p1' && orderByChoice(top, { choice: JEV_NONE, probabilities: { [JEV_NONE]: 0.9, p0: 0.05 } }).pick === JEV_NONE);

// --- through jevRank, against a local gateway --------------------------------
const bodies = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    bodies.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ answers: { pick: { type: 'choice', choice: 'p2', confidence: 0.9, probabilities: { p0: 0.05, p1: 0.05, p2: 0.9, [JEV_NONE]: 0.1 } } } }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const ENDPOINT = 'http://127.0.0.1:' + server.address().port + '/decisions';

const ranked = await jevRank('a question', top, 'test-key', { endpoint: ENDPOINT, max: 3 });
ok('the default call sends ONE question', bodies.length === 1 && Object.keys(bodies[0].questions).length === 1 && !!bodies[0].questions.pick);
ok('and that question is a choice with a criteria map', bodies[0].questions.pick.type === 'choice' && Object.keys(bodies[0].questions.pick.criteria).length === top.length + 1);
ok('the state still carries the passages', bodies[0].state.indexOf('PASSAGE 0') !== -1 && bodies[0].state.indexOf('Question: a question') !== -1);
ok('the returned order follows the probabilities', ranked.map(x => x.id).join(',') === 'sec#c,sec#a,sec#b');
ok('the shape and the none signal ride back on the array', ranked.shape === 'choice' && ranked.none === 0.1);
ok('and the gateway too', ranked.gateway === 'custom');

// the noul shape is still reachable, and still asks one question per candidate.
const noulRanked = await jevRank('a question', top, 'test-key', { endpoint: ENDPOINT, max: 3, shape: 'noul' });
const lastBody = bodies[bodies.length - 1];
ok('the noul shape sends one question per candidate', Object.keys(lastBody.questions).length === 3 && lastBody.questions.p0.type === 'noul');
ok('and its order comes from the noul values', noulRanked.length === 3 && noulRanked.every(x => x.jev === 0));
ok('the noul shape reports itself', noulRanked.shape === 'noul');
await new Promise(resolve => server.close(resolve));

// --- the wiring --------------------------------------------------------------
const corpus = read('src/rules-corpus.mjs');
const serverSrc = read('src/server.mjs');
ok('the retrieval passes the shape through to the reranker', /shape: o\.jevShape/.test(corpus));
ok('and the dual path carries it', /jevShape: o\.jevShape/.test(corpus));
ok('the request can ask for a shape', /jevShape: body\.shape/.test(serverSrc));
ok('the rerank report names the shape it used', /shape: ranked\.shape \|\| ''/.test(corpus));
ok('the default in the source is the choice shape', /process\.env\.RULES_JEV_SHAPE \|\| 'choice'/.test(corpus));
ok('and none is never used to reorder', !/none[^\n]*\.sort\(/.test(corpus));

console.log('shape default ' + jevShape() + '; choice asks 1 question, noul asks ' + top.length);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
