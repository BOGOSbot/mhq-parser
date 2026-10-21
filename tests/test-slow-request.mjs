// task-78: a long ask must not be ended by the SERVER. Node sets server.requestTimeout to
// 300 seconds by default, and the ask can legitimately run past it: a translation, an agent
// call, a sweep and a second agent, each with a retry. Measured - three French runs died at
// exactly 302s on this machine and on the Box alike, with 'fetch failed' at the client and
// no verdict at all. The pipeline's own bounds are the cap, so the server's is off.
//
// This test spawns the REAL server with a test-only delay on /health and holds a request
// open past 300 seconds. It takes about five minutes and it is the only test in this suite
// that does; that is the point of it - a 300s assumption is invisible in every shorter test.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => { const same = JSON.stringify(got) === JSON.stringify(want); if (same) pass++; else { fail++; console.log('FAIL ' + name + NL + '  got : ' + JSON.stringify(got) + NL + '  want: ' + JSON.stringify(want)); } };

const PORT = 8791;
const SLOW_MS = Number(process.env.RULES_SLOW_TEST_MS || 305000);
const server = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs');
const child = spawn(process.execPath, [server], {
  env: Object.assign({}, process.env, { PORT: String(PORT), RULES_TEST_SLOW_MS: String(SLOW_MS) }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { out += d; });
// A cold boot reads the corpus and the archive; measured at about 15 seconds on this
// machine, so the probe waits generously and reports what the child said if it never comes
// up at all.
const waitUp = async () => {
  for (let i = 0; i < 240; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/health', { signal: AbortSignal.timeout(5000) }); if (r.ok) return true; } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
};
const up = await waitUp();
ok('the server started', up);
if (!up) console.log('child output: ' + out.slice(-600));
let answer = null, err = '';
if (up) {
  const t0 = Date.now();
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/health?slow=1', { signal: AbortSignal.timeout(SLOW_MS + 90000) });
    answer = await r.json();
  } catch (e) { err = String((e && e.message) || e); }
  const took = Date.now() - t0;
  ok('the slow request came back instead of failing to fetch', !err);
  ok('the body is the real one', !!(answer && answer.ok === true));
  ok('and it took the full delay, past Node\'s 300s default', took >= SLOW_MS - 1000);
  console.log('  slow request: ' + Math.round(took / 1000) + 's, ' + (err ? 'DROPPED ' + err : 'answered'));
}
child.kill();
if (err) console.log('child output tail: ' + out.slice(-400));
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
