// task-78: a dropped or empty call must never read as an answer, and the server must not
// END a slow one. Two halves, both pinned here: the server hands the pipeline its own
// bounds (requestTimeout 0) so a 300s ask is not cut off by Node's default, and an agent
// call that never ran is a FAILURE - not the statement of absence, whose first line claims
// the question was searched for. That is the empty-reply family from task-70, third time.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = fs.readFileSync(path.join(here, '..', 'src', 'server.mjs'), 'utf8');
const CORPUS = fs.readFileSync(path.join(here, '..', 'src', 'rules-corpus.mjs'), 'utf8');

// --- the server does not end a slow ask --------------------------------------
// task-79: the cap is RAISED above the worst ask (486s measured), not removed, and the
// header guard is left exactly as Node ships it - it guards the header phase only, so it
// cannot cut an ask, and dropping it would trade a real guard for nothing.
ok('the server raises requestTimeout above the worst ask', /server\.requestTimeout = 900000;/.test(SERVER));
ok('and never touches headersTimeout', !/server\.headersTimeout\s*=/.test(SERVER));
ok('the reason is written where the change is', /request at 300 seconds by default/.test(SERVER) && /headersTimeout is NOT touched/.test(SERVER));
ok('the test-only delay is inert without its variable', /RULES_TEST_SLOW_MS/.test(SERVER) && /if \(slow > 0\)/.test(SERVER));

// --- a failed call is a failure, not an absence ------------------------------
ok('the agent\'s null answer is detected as a failed call', /const agentCallFailed = !!\(agent && agent\.answered === null\);/.test(SERVER));
ok('the failure is flagged on the agent it sends', /if \(agentCallFailed\) agent\.failed = true;/.test(SERVER));
ok('a failed call never reaches the statement of absence', /agentCallFailed[\s\S]{0,200}Promise\.reject/.test(SERVER));
ok('and the two failures are told apart', /writerFailed = agentCallFailed \? 'agent' : 'timeout';/.test(SERVER));
ok('the agent reports a template as its own kind of failure', /agent returned the schema example instead of an answer/.test(CORPUS) && /template: true/.test(CORPUS));
ok('an empty reply is retried before it is reported', /recovering = true/.test(CORPUS));
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
