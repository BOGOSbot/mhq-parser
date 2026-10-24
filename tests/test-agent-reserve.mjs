// task-105: a call cut on the output ceiling is retried with ANSWER ROOM, not with a blind
// doubling and the reasoning dropped. The old recovery doubled the budget and set reasoning
// 'none' on a JSON call, and the repo's own bank measured the same agent at 61.8% with
// reasoning off against 79.4% with it on, so every recovered empty was recovered by making
// the agent worse on the call that had already failed. The reserve instead adds
// RULES_AGENT_RESERVE_TOKENS to the ceiling, keeps the reasoning at the provider's cheapest
// explicit rung ('low'), and appends a brevity clause to the retry prompt. The knob at 0 is
// today's behaviour byte for byte, so both arms run on one build.
//
// The arithmetic is pinned against a stub route, not against the source text alone: the stub
// answers the first call with content null and finish_reason 'length' (the shape every empty
// reply has) and the second with a usable object, and it records what each call asked for.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
function t(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) pass++;
  else { fail++; console.log('FAIL ' + name + ' | got: ' + JSON.stringify(got) + ' | want: ' + JSON.stringify(want)); }
}
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const CORPUS = fs.readFileSync(path.join(ROOT, 'src', 'rules-corpus.mjs'), 'utf8');

// --- the knob exists, and both paths are in the source --------------------------
ok('the reserve has a named default', /const RESERVE_DEFAULT_TOKENS = \d+;/.test(CORPUS));
ok('and an env override that keeps the arms separate', /const RESERVE_TOKENS = process\.env\.RULES_AGENT_RESERVE_TOKENS === undefined/.test(CORPUS));
ok('the reserve adds to the ceiling', /budget \+= RESERVE_TOKENS;/.test(CORPUS));
ok('the retry keeps the reasoning at the cheapest explicit rung', /retryReasoning = 'low';/.test(CORPUS));
ok('and carries the brevity clause', /sendPrompt = prompt \+ RESERVE_BREVITY;/.test(CORPUS));
ok('the retry prompt is what the request sends', /content: sendPrompt/.test(CORPUS));
ok('the empty ring names the reasoning the call used', /reasoning: String\(reasoning \|\| ''\)/.test(CORPUS));
ok('the legacy path is still there for the other arm', /budget \*= 2;/.test(CORPUS) && /reasoningOff = true;/.test(CORPUS));

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function runArm(env) {
  const seen = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(body); } catch (e) { b = {}; }
      const max = Number(b.max_tokens || 0);
      const content = String(((b.messages || [])[0] || {}).content || '');
      seen.push({ max: max, reasoning: b.reasoning_effort === undefined ? null : b.reasoning_effort, brevity: content.indexOf('cut off at the output limit') !== -1 });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (seen.length === 1) {
        res.end(JSON.stringify({ choices: [{ message: { content: null }, finish_reason: 'length' }], usage: { prompt_tokens: 4323, completion_tokens: max, max_tokens: max } }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: '{"answered":true,"answer":"ok"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4323, completion_tokens: 20, max_tokens: max } }));
      }
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  const script = [
    'import { fastText, routeStats } from ' + JSON.stringify(new URL('file:///' + path.join(ROOT, 'src', 'rules-corpus.mjs').replace(/\\/g, '/')).href) + ';',
    'const raw = await fastText("A PROMPT", "stub-key", 4000, { json: true, reasoning: "medium", stage: "agent-first" });',
    'console.log("RESULT " + JSON.stringify({ ok: raw.length > 0, empties: routeStats().emptyCalls }));',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: Object.assign({}, process.env, {
      RULES_FAST_ENDPOINT: 'http://127.0.0.1:' + port + '/v1/chat/completions',
      RULES_FAST_MODEL: 'stub', RULES_FAST_TIMEOUT_MS: '5000',
    }, env),
  });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const code = await new Promise(r => child.on('close', r));
  await new Promise(r => stub.close(r));
  const m = /RESULT (.*)/.exec(out);
  if (!m) console.log('child produced no result (exit ' + code + '); stderr: ' + err.slice(0, 400));
  return { seen: seen, result: m ? JSON.parse(m[1]) : null };
}

// --- arm B: the reserve -------------------------------------------------------
const reserve = await runArm({ RULES_AGENT_RESERVE_TOKENS: '2000' });
t('the reserve arm makes two calls', reserve.seen.length, 2);
t('the first call keeps the caller budget', reserve.seen[0].max, 4000);
t('the retry adds the reserve instead of doubling', reserve.seen[1].max, 6000);
t('and keeps the reasoning, at the cheapest explicit rung', reserve.seen[1].reasoning, 'low');
t('and carries the brevity clause', reserve.seen[1].brevity, true);
ok('the reserve arm answered', !!reserve.result && reserve.result.ok === true);
const ring = (reserve.result && reserve.result.empties) || [];
t('the empty ring records one attributed call', ring.length, 1);
t('and names the reasoning the cut actually used', ring[0] && ring[0].reasoning, 'medium');
t('and the shape that made it an empty', ring[0] && ring[0].shape, 'length');
t('and the ceiling it was cut at', ring[0] && ring[0].maxTokens, 4000);

// --- arm A: today's behaviour, byte for byte ----------------------------------
const legacy = await runArm({ RULES_AGENT_RESERVE_TOKENS: '0' });
t('the legacy arm makes two calls', legacy.seen.length, 2);
t('and doubles the ceiling', legacy.seen[1].max, 8000);
t('and drops the reasoning', legacy.seen[1].reasoning, null);
t('and adds no brevity clause', legacy.seen[1].brevity, false);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
