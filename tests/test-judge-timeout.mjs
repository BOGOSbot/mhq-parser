// task-31 A: a judge call that asks for reasoning must be bounded, and when it
// does not come back the judge must be asked again without reasoning rather than
// the whole run dying as an error. Measured on the real route: reasoning medium
// returned in 27.6s on an 18.6k prompt where 'none' returned in 3.6s, and the
// Box's deep list never returned inside the model timeout. This test stands a
// stub upstream that never answers a reasoning request, and checks the second,
// non-reasoning request produces the verdict.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => { const same = JSON.stringify(got) === JSON.stringify(want); if (same) pass++; else { fail++; console.log('FAIL ' + name + ' | got: ' + JSON.stringify(got) + ' | want: ' + JSON.stringify(want)); } };
const seen = [];
const reply = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rules_question: true, answered: true, confidence: 'high', quote: 'a quote', from: 1, exceptions: [], missing: null }) }, finish_reason: 'stop' }] });
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    // task-76: the reasoning control is either shape, so the stub reads both - a nested
    // gateway sends reasoning.effort and this plain endpoint gets reasoning_effort.
    let reasoning = null;
    try {
      const b = JSON.parse(body);
      reasoning = (b.reasoning && b.reasoning.effort) || b.reasoning_effort || null;
    } catch (e) { }
    seen.push(reasoning);
    if (reasoning && reasoning !== 'none') { return; } // never answer the reasoning call
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(reply);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const corpus = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'rules-corpus.mjs');
const script = [
  'import { judgeCoverage } from ' + JSON.stringify(new URL('file:///' + corpus.replace(/\\/g, '/')).href) + ';',
  'const passages = [{ id: "core-rules#1", n: 1, set: "rules", source: "core-rules", heading: "A rule", text: "A unit cannot shoot after it Fell Back unless a rule says otherwise." }];',
  'const v = await judgeCoverage("Can a unit shoot after it Fell Back?", passages, "stub-key", { reasoning: "medium", lang: "en" });',
  'console.log(JSON.stringify({ answered: v.answered, confidence: v.confidence, from: v.from, why: v.missing }));',
].join('\n');
const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
  env: Object.assign({}, process.env, { RULES_FAST_ENDPOINT: 'http://127.0.0.1:' + port + '/v1/chat/completions', RULES_FAST_MODEL: 'stub', RULES_FAST_TIMEOUT_MS: '5000', RULES_JUDGE_REASONING_TIMEOUT_MS: '400' }),
});
let out = '', err = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { err += d; });
const code = await new Promise(r => child.on('close', r));
server.close();
t('the child run exits clean', code, 0);
const verdict = out.trim() ? JSON.parse(out.trim().split('\n').pop()) : null;
ok('the reasoning call was asked first', seen.length >= 2 && (seen[0] === 'medium' || seen[0] === 'high'));
// task-76: 'no reasoning' on a nested-reasoning gateway is asked for as its cheapest
// effort rather than by dropping the field - OpenRouter's minimax answers 400 'Reasoning
// is mandatory' without it, which emptied 18 of 19 judge calls. This stub is a plain
// local endpoint, so the fallback drops the field as it always did; the nested shape is
// pinned in tests/test-rules.mjs.
// The reasoning attempt carries the effort; the fallback asks with NO effort field at all
// (a plain endpoint does not know it), which is what 'without reasoning' means here. The
// nested gateway's shape - where 'no reasoning' is its cheapest effort - is pinned in
// tests/test-rules.mjs and exercised by the judge's own retry.
ok('and the fallback asked again without reasoning', seen.indexOf('medium') !== -1 && seen[seen.length - 1] === null);
ok('the judge answered through the fallback, no error', !!verdict && verdict.answered === true && verdict.confidence === 'high' && verdict.from === 1);
if (err) console.log('child stderr: ' + err.slice(0, 400));

// --- the wiring the behaviour above depends on --------------------------------
const fs = await import('node:fs');
const path2 = await import('node:path');
const { fileURLToPath: f2u } = await import('node:url');
const here = path2.dirname(f2u(import.meta.url));
const rulesSrc = fs.readFileSync(path2.join(here, '..', 'src', 'rules.mjs'), 'utf8');
const corpusSrc = fs.readFileSync(path2.join(here, '..', 'src', 'rules-corpus.mjs'), 'utf8');
ok('the reasoning attempt has its own bound, env-overridable', /export const JUDGE_REASONING_TIMEOUT_MS = Number\(process\.env\.RULES_JUDGE_REASONING_TIMEOUT_MS\)/.test(rulesSrc));
ok('the judging call passes it as the one-call timeout', /timeout: JUDGE_REASONING_TIMEOUT_MS/.test(corpusSrc));
ok('and a call that fails falls back to no reasoning', /reasoning: 'none'/.test(corpusSrc) && /the judge did not answer/.test(corpusSrc));
ok('the route honours a per-call timeout and a plain-http endpoint', /\(opts && opts\.timeout\) \|\| route\.timeout/.test(corpusSrc) && /u\.protocol === 'http:' \? http : https/.test(corpusSrc) && /port: u\.port \|\| undefined/.test(corpusSrc));
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;