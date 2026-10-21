#!/usr/bin/env node
'use strict';
/**
 * Task-22's arm: the agent's latency, before and after the settle change.
 *
 *   node tests/measure-agent.mjs --arm before --out workspace/eval/agent-latency-before.json
 *
 * Same questions, same mode, same index state, one process per arm. What it
 * measures per question, and nothing else:
 *   - the seconds: retrieval, the agent loop, the writer, and their total;
 *   - the PASSES the widening loop ran, and how many agent calls those passes
 *     cost (a settle pass is two: the quick gate and the reasoned verdict);
 *   - every pass's VERDICT, and which pass was final.
 *
 * It injects the RETRIEVER and the writer, never the agent, so the loop's own
 * agent policy - whatever ASK_MODES says in this checkout - is exactly what is
 * measured. The question list is fixed here, taken from the traces on disk; each
 * entry carries that trace's own total and pass count as the recorded reference.
 *
 * Built for task-22's settle arm, whose change was REVERTED after this arm
 * measured it (workspace/eval/agent-latency-task22.txt): the reasoning-off gate
 * widened the fuegan question to three passes where the reasoned agent had
 * answered on the first, 73.2s -> 240.9s and answered -> unresolved. The settle
 * fields it reads (outcome.agentCalls, attempts[].settled and .quick) exist only
 * in a checkout that has the settle pass; on a checkout without it the arm
 * measures the one-agent-per-pass loop, which is what the 'before' arm did.
 *
 * ACCURACY IS NOT MEASURED HERE. The bank is 33 graded questions, one question
 * is ~3 points and the noise floor is 2-4, so a agent change cannot be resolved
 * by it. This file reports verdicts, not correctness, and says so in its output.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { credential, fastCredential, modelCredential, FAST_MODEL, MODEL } from '../src/rules.mjs';
import { ASK_MODES, askMode, answerableFindings, compileFindings, dontKnowAnswer, jevCalls, jevCallsReset, readAllCorpus, retrieveDual, WRITER_DECLINED } from '../src/rules-corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function flag(name, def) { const i = process.argv.indexOf('--' + name); return i === -1 ? def : (process.argv[i + 1] || ''); }
const ARM = flag('arm', 'unlabelled');
const OUT = flag('out', '');
const ONLY = Number(flag('only', 0)) || 0;

// The questions, with the trace each was taken from. The reference is what the
// reader actually waited for on the deployed page (translation included); this
// arm asks the English the run actually searched and times retrieve+agent+answer,
// so the two are compared on the part the change touches.
const QUESTIONS = [
  { q: 'I played against a Harlequin who secured an objective in the Movement phase with a stratagem, then disembarked into a Starweaver at the end of the turn. Is that legal?', mode: 'deep', ref: '3587537ce2a2bb67', refTotal: 374919, refPasses: 3 },
  { q: 'Can ASURMEN re-Embark using its Normal Move after it has fired?', mode: 'deep', ref: '4a2b599ec9703e77', refTotal: 285880, refPasses: 2 },
  { q: 'I played against a Harlequin who Secured an Objective during the Movement Phase with a Stratagem, then re-embarked into a Starweaver at the end of the turn. Is this legal?', mode: 'deep', ref: 'b59abd2568838f95', refTotal: 140100, refPasses: 2 },
  { q: 'Can a unit shoot after it Fell Back?', mode: 'deep', ref: 'fell-back-164s', refTotal: 164126, refPasses: 1 },
  { q: 'Can a unit shoot after falling back?', mode: 'deep', ref: '6baeb0b5d6f97daf', refTotal: 59629, refPasses: 1 },
  { q: 'Can dragons with fuegan arrive from reserves in melta range ?', mode: 'deep', ref: 'ad1689b801cb7a59', refTotal: 46920, refPasses: 1 },
  { q: 'Can a unit shoot after retreating?', mode: 'deep', ref: '02ada047e9197a7d', refTotal: 34891, refPasses: 1 },
  { q: 'What is a Desperate Escape test?', mode: 'deep', ref: 'desperate-27s', refTotal: 27638, refPasses: 1 },
  { q: 'How do I put a unit inside a transport?', mode: 'deep', ref: 'transport-22s', refTotal: 22698, refPasses: 1 },
  { q: 'Can the solitaire blitz and advance for +3d6 movement ?', mode: 'fast', ref: '527596ac92af14ea', refTotal: 87114, refPasses: 2 },
];

const JEV = credential('OPENCODE_GO_API_KEY');
const FAST = fastCredential();
const SENSE = modelCredential();
const rulesCorpus = readAllCorpus('rules');
const factionsCorpus = readAllCorpus('factions');

const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : 0; };

const results = [];
let degraded = 0;
// The artifact is written after every question, not only at the end: a long arm
// must survive an interrupted process, or the questions it already paid for are
// lost. It carries the mode fields it ran with, so a run cannot be read as the
// other shape after the fact.
const OUT_ABS = OUT ? (path.isAbsolute(OUT) ? OUT : path.join(__dirname, '..', OUT)) : '';
function save() {
  if (!OUT_ABS) return;
  fs.mkdirSync(path.dirname(OUT_ABS), { recursive: true });
  fs.writeFileSync(OUT_ABS, JSON.stringify({
    arm: ARM, at: new Date().toISOString(), model: MODEL, agentModel: FAST_MODEL,
    modes: { fast: ASK_MODES.fast, deep: ASK_MODES.deep },
    degraded, results,
  }, null, 1));
}
// --only N takes the LAST N: a smoke run wants the cheap end of the list, not
// the 375-second Harlequin.
const list = ONLY ? QUESTIONS.slice(Math.max(0, QUESTIONS.length - ONLY)) : QUESTIONS;
for (const item of list) {
  const mode = ASK_MODES[askMode(item.mode)];
  const rec = { q: item.q, mode: askMode(item.mode), ref: item.ref, refTotal: item.refTotal, refPasses: item.refPasses };
  let retrieveMs = 0, loopMs = 0, answerMs = 0;
  const startedAt = Date.now();
  try {
    jevCallsReset();
    const dual = { rulesCorpus, factionsCorpus, jevKey: JEV, terms: [], grepNet: mode.grepNet, jevMax: mode.jevMax };
    let outcome = null;
    const t0 = Date.now();
    outcome = await answerableFindings(item.q, {
      fastKey: FAST,
      topKs: [mode.first],
      passes: mode.passes,
      agentOpts: { reasoning: mode.reasoning, lang: 'en' },
      settleReasoning: mode.settle,
      dual,
      retrieve: async (q, plan) => {
        const a = Date.now();
        const r = await retrieveDual(q, Object.assign({}, dual, { perSide: plan }));
        retrieveMs += Date.now() - a;
        return r;
      },
    });
    loopMs = Date.now() - t0;
    rec.retrieveMs = retrieveMs;
    rec.agentMs = Math.max(0, loopMs - retrieveMs);
    rec.passes = outcome.attempts.length;
    rec.agentCalls = outcome.agentCalls;
    rec.attempts = outcome.attempts;
    rec.verdicts = (outcome.attempts || []).map(a => (a.answered ? 'Y' : 'N')).join('');
    rec.unresolved = outcome.unresolved;
    rec.escalated = outcome.escalated;
    rec.findings = outcome.findings.length;
    const jc = jevCalls();
    rec.jev = { attempted: jc.rerank.attempted, answered: jc.rerank.answered, failed: jc.rerank.failed };
    // The writer, exactly as the page runs it: a refusal is a statement of
    // absence, and a failed call is reported rather than dropped.
    const t1 = Date.now();
    let answer = '';
    try {
      answer = outcome.unresolved
        ? dontKnowAnswer(outcome.agent, 'en')
        : await compileFindings(item.q, outcome.findings, SENSE, { lang: 'en' });
      if (!outcome.unresolved && String(answer).trim() === WRITER_DECLINED) answer = dontKnowAnswer(outcome.agent, 'en');
    } catch (e) { rec.writerFailed = 'timeout'; }
    answerMs = Date.now() - t1;
    rec.answerMs = answerMs;
    rec.writer = rec.writerFailed ? 'timeout' : (String(answer).trim() ? 'ok' : 'empty');
    if (!rec.writerFailed && !String(answer).trim()) rec.writer = 'empty';
  } catch (e) {
    rec.failed = String((e && e.message) || e);
    rec.retrieveMs = retrieveMs;
    rec.agentMs = Math.max(0, Date.now() - startedAt - retrieveMs);
  }
  rec.totalMs = rec.retrieveMs + rec.agentMs + (rec.answerMs || 0);
  if (rec.failed || rec.writer === 'timeout' || rec.writer === 'empty' || (rec.jev && rec.jev.failed)) degraded++;
  results.push(rec);
  save();
  console.log([
    (rec.failed ? 'FAILED ' : '') + item.mode.padEnd(4),
    String(rec.passes === undefined ? '-' : rec.passes).padStart(2) + 'p',
    String(rec.verdicts || '-').padEnd(3),
    'agent ' + String(rec.agentMs || 0).padStart(6) + 'ms',
    'retr ' + String(rec.retrieveMs || 0).padStart(5) + 'ms',
    'ans ' + String(rec.answerMs || 0).padStart(5) + 'ms',
    'total ' + String(rec.totalMs).padStart(6) + 'ms',
    'ref ' + rec.refTotal + 'ms/' + rec.refPasses + 'p',
    rec.writer || '',
    item.q.slice(0, 52),
  ].join('  '));
}
const totals = results.map(r => r.totalMs);
const agents = results.filter(r => r.agentMs !== undefined).map(r => r.agentMs);
const deep = results.filter(r => r.mode === 'deep');
const fast = results.filter(r => r.mode === 'fast');
console.log('');
console.log('arm ' + ARM + '   questions ' + results.length + '   DEGRADED ' + degraded);
console.log('total ms   median ' + median(totals) + '   p90 ' + pct(totals, 0.9) + '   mean ' + Math.round(totals.reduce((a, b) => a + b, 0) / totals.length));
console.log('agent ms   median ' + median(agents) + '   p90 ' + pct(agents, 0.9) + '   mean ' + Math.round(agents.reduce((a, b) => a + b, 0) / agents.length));
console.log('deep n ' + deep.length + '   passes ' + deep.map(r => r.passes).join(',') + '   verdicts ' + deep.map(r => r.verdicts).join(' '));
if (fast.length) console.log('fast n ' + fast.length + '   passes ' + fast.map(r => r.passes).join(',') + '   verdicts ' + fast.map(r => r.verdicts).join(' '));
console.log('accuracy: UNMEASURED - 33 graded questions, one ~3 points, noise floor 2-4; this arm compares seconds, passes and verdicts only.');
if (degraded) console.log('WARNING: ' + degraded + ' question(s) degraded (fallback, writer failure or a thrown call) - the row is reported, not dropped.');
save();
if (OUT_ABS) console.log('written ' + OUT_ABS);
process.exitCode = degraded ? 1 : 0;
