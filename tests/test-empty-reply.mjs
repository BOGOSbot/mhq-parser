// task-70: an empty reply from the route is RETRIED, not returned. It used to be returned
// as-is, and the judge then read it as 'the judge did not answer' - which the escalation
// loop treats as 'not answered', a statement about the corpus made from a call that never
// happened. Measured on the Box: 2 empty and 3 truncated replies in 130 fast calls, and a
// probe that timed out once then got an empty body on every following call.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => { const same = JSON.stringify(got) === JSON.stringify(want); if (same) pass++; else { fail++; console.log('FAIL ' + name + ' | got: ' + JSON.stringify(got) + ' | want: ' + JSON.stringify(want)); } };
const reply = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rules_question: true, answered: true, confidence: 'high', quote: 'a quote', from: 1, exceptions: [], missing: null }) }, finish_reason: 'stop' }] });
// The stub answers NOTHING on the first two calls, then answers. A route that returns the
// empty body would give the caller '' and the judge would report 'did not answer'.
const empty = JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
let calls = 0;
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    calls++;
    seen.push(calls);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(calls <= 2 ? empty : reply);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const corpus = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'rules-corpus.mjs');
const script = [
  'import { fastText } from ' + JSON.stringify(new URL('file:///' + corpus.replace(/\\/g, '/')).href) + ';',
  'const raw = await fastText("a prompt", "stub-key", 900, { json: true });',
  'console.log(JSON.stringify({ len: raw.length, answered: /"answered":true/.test(raw) }));',
].join('\n');
const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
  env: Object.assign({}, process.env, { RULES_FAST_ENDPOINT: 'http://127.0.0.1:' + port + '/v1/chat/completions', RULES_FAST_MODEL: 'stub', RULES_FAST_TIMEOUT_MS: '5000' }),
});
let out = '', err = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { err += d; });
const code = await new Promise(r => child.on('close', r));
server.close();
t('the child run exits clean', code, 0);
ok('the empty reply was retried', calls >= 3);
ok('and the third call was the one that answered', out.indexOf('"len"') !== -1 && out.indexOf('"answered":true') !== -1);
if (!out) console.log('child stdout empty; stderr: ' + err.slice(0, 600));
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
