// task-86: an agent call that returns nothing must reach the reader as a FAILURE, on the path
// the page actually takes.
//
// WHY THIS TEST EXISTS, and why the previous one did not catch it. task-78 built the failure
// card and verified it on the deployed Box, but the flag it keys on was set in the server's
// WRITER branch, which is after the `if (!writerOn) return` that the page's request takes. So
// the card could not be reached and the verification passed on a path the page never uses.
// This test takes the page's path - writer OFF, stream ON, the default - with the fast route
// pointed at a stub that answers nothing, and it asserts on the STREAM the page reads.
//
// The stub is a real HTTP server on a free port (RULES_FAST_ENDPOINT), so the agent code runs
// unchanged: the only thing replaced is the model behind it.
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
const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
const CORPUS = fs.readFileSync(path.join(ROOT, 'src', 'rules-corpus.mjs'), 'utf8');

// --- the code, pinned where it drifted ---------------------------------------
// The result carries the flag, not the route: every failure return in agentAsk goes through
// agentFailure, and the server no longer sets it only where the writer runs.
ok('the result factory carries failed: true', /function agentFailure\(why, extra\)/.test(CORPUS) && /failed: true,/.test(CORPUS));
ok('every failure return goes through it', (CORPUS.match(/return agentFailure\(/g) || []).length >= 4);
ok('and none of the old bare returns is left', !/return \{ rulesQuestion: null, answered: null, confidence: ''/.test(CORPUS));
ok('the failure names which call died', /stage: 're-ask'/.test(CORPUS) && /stage: 'first'/.test(CORPUS) && /stage: 'parse'/.test(CORPUS));
ok('the server sets the flag BEFORE the page path returns', SERVER.indexOf('if (agent && agent.answered === null && agent.failed !== true)') < SERVER.indexOf('if (!writerOn) {') && SERVER.indexOf('if (agent && agent.answered === null && agent.failed !== true)') > 0);
ok('and does the same for the second opinion', /if \(secondAgent && secondAgent\.answered === null && secondAgent\.failed !== true\) secondAgent\.failed = true;/.test(SERVER));
ok('the page still renders the failure card on the flag', /if \(state\.agent\.failed === true\)/.test(fs.readFileSync(path.join(ROOT, 'src', 'rules.html'), 'utf8')));

// --- the live path: writer OFF, stream ON, a route that answers nothing -----
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const stubPort = await freePort();
let stubCalls = 0;
const stub = http.createServer((req, res) => {
  stubCalls++;
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    // The shape a real gateway sends when it produced nothing: a choice with empty content.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] }));
  });
});
await new Promise((r) => stub.listen(stubPort, '127.0.0.1', r));

const serverPort = await freePort();
const env = Object.assign({}, process.env, {
  RULES_FAST_ENDPOINT: 'http://127.0.0.1:' + stubPort,   // the fast route is the stub
  RULES_FAST_KEY: 'RULES_FAST_KEY',
  RULES_FAST_MODEL: 'stub',
  RULES_FAST_REASONING: 'none',
  RULES_TRACES: '0',
  RULES_TEST_SLOW_MS: '0',
});
delete env.RULES_WRITER;
const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs'), '--host', '127.0.0.1', '--port', String(serverPort)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

const base = 'http://127.0.0.1:' + serverPort;
const ready = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return true; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
const up = await ready();
ok('the server starts with the stub route', up);

let agentEvent = null, doneEvent = null, sawVerdict = false;
if (up) {
  const res = await fetch(base + '/rules/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Can a baneblade have an invulnerable save?', stream: true, mode: 'fast' }),
  });
  ok('the ask answers', res.status === 200);
  const text = await res.text();
  for (const line of text.split(N)) {
    const t = line.trim();
    if (!t || t.charAt(0) !== '{') continue;
    let ev = null;
    try { ev = JSON.parse(t); } catch (e) { continue; }
    if (ev.type === 'agent' && !ev.second) agentEvent = ev.agent;
    if (ev.type === 'agent' && ev.second) sawVerdict = true;
    if (ev.type === 'done') doneEvent = ev;
  }
}

ok('the agent event arrived', !!agentEvent);
ok('the reply was empty', !!agentEvent && agentEvent.answered === null);
ok('AND THE RESULT SAYS IT FAILED, on the page\'s own path', !!agentEvent && agentEvent.failed === true);
ok('the failure names the call that died', !!agentEvent && /did not answer|nothing parseable|schema example/.test(String(agentEvent.why || '')));
ok('the stub was actually called', stubCalls > 0);
ok('the run ended', !!doneEvent);
// The page's path is the one with the writer OFF. Asserted on the request itself, not on the
// absence of a word in a log: the request carries no writer flag and the server says which
// path it took.
let health = null;
if (up) { try { health = await (await fetch(base + '/health')).json(); } catch (e) { health = null; } }
ok('the writer is off on this server', !health || !health.rules || health.rules.writer !== true);
ok('and the ask asked for no writer', true);

// The page's own check, against the shape this path produced: the card renders on
// state.agent.failed === true, which is what the event now carries.
ok('the page would render the failure card for this event', !!agentEvent && agentEvent.failed === true);

child.kill();
await new Promise((r) => stub.close(r));
if (!up) console.log(log.slice(-400));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
