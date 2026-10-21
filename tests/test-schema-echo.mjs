// task-75: the schema example, echoed back as the answer. The prompt ends with a filled-in
// example, and a small model sometimes returns the EXAMPLE instead of filling it in. The
// reply is valid JSON and reads as prose, so every earlier guard let it through and the
// reader was shown 'une phrase, dans les termes du lecteur' as the verdict - found on the
// Box in a French ask. This file pins the two halves: the detector, and the retry that
// stands between the detector and the reader.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { agentTemplate } from '../src/rules-corpus.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// --- the detector ------------------------------------------------------------
// Matched EXACTLY, not as a substring: a real answer may well contain 'one sentence'.
const FR = {
  rules_question: true, answered: true, verdict: 'oui', confidence: 'high', widen: 'both', passages: [1, 2],
  answer: 'une phrase, dans les termes du lecteur',
  quote: 'des mots copi\u00e9s verbatim du passage nomm\u00e9 dans from, ou null',
  from: 1, exceptions: [3], missing: null,
  why: 'la raison, en deux ou trois phrases',
};
t('the French example is the template', agentTemplate(FR), true);
t('the English example is the template', agentTemplate({ answer: "one sentence, in the reader's terms" }), true);
t('an echoed quote alone is the template', agentTemplate({ answer: 'Oui, un Baneblade peut en avoir une.', quote: 'words copied verbatim from the passage named in from, or null' }), true);
t('an echoed why alone is the template', agentTemplate({ answer: 'Oui.', why: 'la raison, en deux ou trois phrases' }), true);
t('a real French answer is not', agentTemplate({ answer: "Oui, un Baneblade peut obtenir un sauvetage invuln\u00e9rable gr\u00e2ce \u00e0 Omnissiah's Blessing." }), false);
t('an answer that CONTAINS the phrase is not the template', agentTemplate({ answer: 'The rule is one sentence, in the reader\u2019s terms, and it applies.' }), false);
t('a refusal is not the template', agentTemplate({ answered: false, answer: null, why: 'Aucun passage ne couvre ce point.' }), false);
t('an empty object is not the template', agentTemplate({}), false);
t('nothing at all is not the template', agentTemplate(null), false);

// --- the retry, against a stub that echoes the example ------------------------
// The stub answers with the schema EXAMPLE on every call until the retry prompt names the
// problem, then answers properly. The verdict must be the real answer, never the example.
const example = JSON.stringify({ choices: [{ message: { content: JSON.stringify(FR) }, finish_reason: 'stop' }] });
const yesWithVerdict = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rules_question: true, answered: true, verdict: 'oui', confidence: 'high', passages: [1], answer: "Oui, un Baneblade peut obtenir une sauvegarde invuln\u00e9rable.", quote: 'that VEHICLE model has a 4+ invulnerable save', from: 1, exceptions: [], missing: null, why: "Le passage 1 accorde la sauvegarde." }) }, finish_reason: 'stop' }] });
let calls = 0;
let sawTheWarning = false;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    calls++;
    if (body.indexOf('Do not copy the wording of the example') !== -1) sawTheWarning = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(calls <= 2 ? example : yesWithVerdict);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const corpus = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'rules-corpus.mjs');
const script = [
  'import { agentCoverage } from ' + JSON.stringify(new URL('file:///' + corpus.replace(/\\/g, '/')).href) + ';',
  'const passages = [{ id: "unitrules#1", n: 1, set: "rules", source: "unitrules", heading: "Tech-Priest Enginseer", text: "That VEHICLE model has a 4+ invulnerable save." }];',
  'const v = await agentCoverage("Est-ce qu\u2019un Baneblade peut avoir une sauvegarde invuln\u00e9rable ?", passages, "stub-key", { reasoning: "none", lang: "fr", maxAsks: 3 });',
  'console.log(JSON.stringify({ answered: v.answered, verdict: v.verdict, answer: v.answer, why: v.why, template: v.template === true }));',
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
t('the example was retried, not returned', calls, 3);
t('the retry prompt names the problem', sawTheWarning, true);
const verdict = out.trim() ? JSON.parse(out.trim().split('\n').pop()) : null;
t('and the verdict is the real answer', verdict && verdict.answer, 'Oui, un Baneblade peut obtenir une sauvegarde invuln\u00e9rable.');
// normalizeVerdict folds the model's own language: the stub answered 'oui' and the verdict
// that reaches the caller is 'yes'.
t('with the verdict folded from the model\u2019s French', verdict && verdict.verdict, 'yes');
t('never the template', verdict && agentTemplate(verdict), false);
if (!out) console.log('child stdout empty; stderr: ' + err.slice(0, 500));
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
