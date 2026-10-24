// task-37: the CLI for agents. Three pins, and the third is the one that matters: a CLI row
// and a page row must come from the SAME function, or an agent and a reader can be told
// different things about one corpus. find imports the modules the server's own
// /rules/find route passes (findRows + surfaceSlugMap + deliveredIds), so this test starts
// the real server, asks both, and compares.
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs, renderAnswer, renderRows, serverUrl, summarise } from '../src/rules-cli.mjs';

const N = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => { const same = JSON.stringify(got) === JSON.stringify(want); if (same) pass++; else { fail++; console.log('FAIL ' + name + N + '  got : ' + JSON.stringify(got) + N + '  want: ' + JSON.stringify(want)); } };

t('an empty command line has no verb', parseArgs([]).verb, '');
t('--help', parseArgs(['--help']).help, true);
t('find takes words', parseArgs(['find', 'voice', 'of', 'command']).words, ['voice', 'of', 'command']);
t('find is a verb', parseArgs(['find', 'x']).verb, 'find');
t('ask is a verb', parseArgs(['ask', 'can', 'I', 'shoot']).verb, 'ask');
t('deep is a verb', parseArgs(['deep', 'fall', 'back']).verb, 'deep');
t('--json', parseArgs(['find', 'x', '--json']).json, true);
t('--lang fr', parseArgs(['ask', 'q', '--lang', 'fr']).lang, 'fr');
t('--limit', parseArgs(['find', 'x', '--limit', '5']).limit, 5);
t('--server', parseArgs(['ask', 'q', '--server', 'http://x:1']).server, 'http://x:1');
t('the default server is the local one', serverUrl({ server: '' }), 'http://127.0.0.1:8787');
t('and a trailing slash is trimmed', serverUrl({ server: 'http://x:1/' }), 'http://x:1');

ok('a failed call reads as a failure', renderAnswer({ agent: { failed: true, why: 'x' }, findings: [] }, false).indexOf('THE CALL FAILED') === 0);
ok('an answer reads as an answer', renderAnswer({ agent: { answered: true, answer: 'Yes.' }, findings: [] }, false).indexOf('ANSWER: Yes.') === 0);
ok('a refusal reads as a refusal', renderAnswer({ agent: { answered: false, why: 'no record states it' }, findings: [] }, false).indexOf('NOT ANSWERED') === 0);
ok('--json is one JSON object', (() => { const s = renderAnswer({ agent: { answered: true, answer: 'Yes.' }, findings: [] }, true); try { JSON.parse(s); return s.indexOf(N) === -1; } catch (e) { return false; } })());
ok('find --json is one JSON object', (() => { const s = renderRows({ rows: [{ id: 'x' }], total: 1 }, true); try { JSON.parse(s); return s.indexOf(N) === -1; } catch (e) { return false; } })());
t('the last findings event is the answer, and a second opinion is kept apart', (() => { const s = summarise([{ type: 'findings', findings: [{ n: 1 }, { n: 2 }] }, { type: 'agent', agent: { answered: true } }, { type: 'agent', agent: { answered: false }, second: true }]); return [s.findings.length, s.agent.answered, s.secondAgent.answered]; })(), [2, true, false]);
t('a reconcile event is read for its polarity', summarise([{ type: 'reconcile', polar: true }]).polar, true);

const free = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await free();
const dir = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(dir, '..', 'src', 'server.mjs');
const child = spawn(process.execPath, [server], { env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try { const r = await fetch('http://127.0.0.1:' + PORT + '/health', { signal: AbortSignal.timeout(4000) }); if (r.ok) up = true; } catch (e) { /* not up yet */ }
  if (!up) await new Promise(r => setTimeout(r, 500));
}
ok('the server started', up);
const query = 'voice of command';
const cli = spawnSync(process.execPath, [path.join(dir, '..', 'src', 'rules-cli.mjs'), 'find', query, '--json'], { encoding: 'utf8' });
const route = up ? await (await fetch('http://127.0.0.1:' + PORT + '/rules/find?q=' + encodeURIComponent(query))).json() : { rows: [] };
t('the CLI find exits clean', cli.status, 0);
let cliRows = null;
try { cliRows = JSON.parse(cli.stdout); } catch (e) { cliRows = null; }
ok('and prints JSON', !!cliRows);
t('the CLI and the route return the same rows', (cliRows ? cliRows.rows.map(r => r.id) : []), (route.rows || []).map(r => r.id));
t('and the same total', (cliRows ? cliRows.total : -1), route.total);
ok('find returned at least one row', ((cliRows && cliRows.rows) || []).length > 0);
child.kill();
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
