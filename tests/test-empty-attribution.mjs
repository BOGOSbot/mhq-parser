// task-89: the empty reply is attributed to the CALL that produced it, and the provider's
// usage is captured so the 'length' question can be settled instead of guessed.
//
// WHY. Three calls in the agent chain take 4000 tokens and an empty can come from any of them,
// so two budget changes in a row were made blind and one of them did not move the number. The
// shape alone cannot tell 'the model spent its whole budget thinking' (completion_tokens ==
// max_tokens) from 'something else truncated it' (completion_tokens small). Those two look
// identical from outside the call.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const N = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const CORPUS = fs.readFileSync(path.join(ROOT, 'src', 'rules-corpus.mjs'), 'utf8');
const RULES = fs.readFileSync(path.join(ROOT, 'src', 'rules.mjs'), 'utf8');

// --- the labels exist, on every call that can empty ----------------------------
ok('the empty branch records the stage', /const stage = String\(\(opts && opts\.stage\) \|\| 'unlabelled'\)/.test(CORPUS));
ok('and records the provider usage', /promptTokens: usage \? Number\(usage\.prompt_tokens/.test(CORPUS) && /completionTokens: usage \? Number\(usage\.completion_tokens/.test(CORPUS));
ok('and keeps a bounded ring of the last empties', /ROUTE_STATS\.emptyCalls\.push\(record\)/.test(CORPUS) && /emptyCalls\.length > 20/.test(CORPUS));
ok('and counts them per stage', /emptyByStage\[stage\]/.test(CORPUS));
for (const label of ['agent-first', 'agent-re-ask', 'agent-object', 'terms', 'translate', 'sweep', 'writer']) {
  ok('the ' + label + ' call is labelled', CORPUS.indexOf("stage: '" + label + "'") !== -1);
}
ok('the failure result and the empty counter use the same vocabulary', /stage: 'agent-first'/.test(CORPUS) && /stage: 're-ask'/.test(CORPUS));

// --- the live path: an empty with usage, read back from /health ---------------
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const stubPort = await freePort();
let calls = 0;
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    calls++;
    let maxTok = 0;
    try { maxTok = JSON.parse(body).max_tokens || 0; } catch (e) { maxTok = 0; }
    // The provider's own body for a call that spent its whole budget thinking: content null,
    // finish_reason length, and the usage that proves it.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: null }, finish_reason: 'length' }],
      usage: { prompt_tokens: 18342, completion_tokens: maxTok, max_tokens: maxTok },
    }));
  });
});
await new Promise((r) => stub.listen(stubPort, '127.0.0.1', r));
const port = await freePort();
const env = Object.assign({}, process.env, {
  RULES_FAST_ENDPOINT: 'http://127.0.0.1:' + stubPort,
  RULES_FAST_KEY: 'RULES_FAST_KEY',
  RULES_FAST_MODEL: 'stub',
  RULES_FAST_REASONING: 'none',
  RULES_TRACES: '0',
});
delete env.RULES_WRITER;
const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs'), '--host', '127.0.0.1', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const base = 'http://127.0.0.1:' + port;
let up = false;
for (let i = 0; i < 60; i++) { try { const r = await fetch(base + '/health'); if (r.ok) { up = true; break; } } catch (e) { /* not up */ } await new Promise((r) => setTimeout(r, 500)); }
ok('the server starts with the empty-answering stub', up);

if (up) {
  const res = await fetch(base + '/rules/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Can a baneblade have an invulnerable save?', stream: true, mode: 'fast' }) });
  await res.text();
  const health = await (await fetch(base + '/health')).json();
  const route = health.route || {};
  ok('the empty was counted', (route.empty || 0) > 0);
  ok('the shape is length', !!(route.emptyShapes && route.emptyShapes.length > 0));
  const byStage = route.emptyByStage || {};
  ok('and it is attributed to a CALL', Object.keys(byStage).length > 0);
  ok('the call is named, not unlabelled', Object.keys(byStage).indexOf('unlabelled') === -1);
  ok('the agent first call is the one that emptied', (byStage['agent-first'] || 0) > 0);
  const last = (route.emptyCalls || [])[(route.emptyCalls || []).length - 1];
  ok('the provider usage is captured', !!last);
  if (last) {
    ok('with the prompt tokens', last.promptTokens === 18342);
    ok('with the completion tokens', typeof last.completionTokens === 'number');
    ok('with the max tokens of that attempt', typeof last.maxTokens === 'number' && last.maxTokens > 0);
    ok('and the finish reason', last.finishReason === 'length');
    ok('THE QUESTION IS ANSWERABLE FROM THE RECORD: completion_tokens equals max_tokens', last.completionTokens === last.maxTokens);
    ok('and the record names the attempt', last.attempt >= 1);
  }
  ok('the stub was called', calls > 0);
}

child.kill();
await new Promise((r) => stub.close(r));
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
