#!/usr/bin/env node
'use strict';
/**
 * Accuracy on real questions, against the answers the players gave.
 *
 *   node tests/eval-accuracy.mjs [--bank reddit|fr] [--limit 20] [--thread 1wy7tog]
 *                             [--lang en|fr] [--out accuracy.ndjson] [--all]
 *
 * --bank fr grades the six French questions in fixtures/rules-questions-fr.json
 * against the answer a French player gave, in French, which is the only way the
 * translate-and-answer-back-in-French half of the page is measured at all.
 *
 * fixtures/reddit-questions.json has no answers, so eval-reddit.mjs can only
 * grade whether the retrieval looks right. fixtures/reddit-answers.json carries
 * what was actually replied under each question in its thread, which is what an
 * answer can be checked against. Both are wanted: one counts the passages, this
 * counts the ruling.
 *
 * The answer under test is the page's own path: translate if the question needs
 * it, search both halves, Jev reranks, the judge rules on the findings, the
 * model writes from those findings only.
 *
 * The grader is deliberately a different model from the one being tested - a
 * model marking its own prose grades its own style. It reads the question, what
 * the community said, and the candidate answer, and returns correct / partial /
 * wrong. A question the thread never really answered ("ask your TO", a joke, no
 * reply at all) makes a refusal the correct answer: not knowing is right there,
 * and confidently ruling is not.
 *
 *   correct   same ruling as the community, including the conditions
 *   partial   same headline, a condition or exception missed or contradicted
 *   wrong     a different ruling, or a confident ruling where there is none
 *
 * Accuracy is (correct + partial / 2) / graded. RULES_GRADER_ENDPOINT,
 * RULES_GRADER_MODEL and RULES_GRADER_KEY move the grader; DeepSeek is the
 * default. Results are appended one JSON object per line as they land, and a
 * line already in the output is not redone, so a long run can be resumed.
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { credential, fastCredential, jevKeyName, modelCredential, FAST_MODEL, MODEL } from '../src/rules.mjs';
import { answerableFindings, compileFindings, parseJsonObject, readAllCorpus, translateQuestion } from '../src/rules-corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const value = n => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const flag = n => argv.indexOf(n) !== -1;
const LIMIT = parseInt(value('--limit') || '0', 10);
const ONLY_THREAD = value('--thread');
const OUT = value('--out') || 'accuracy.ndjson';
const ONLY_IDS = (value('--ids') || '').split(',').map(s => s.trim()).filter(Boolean);
const INCLUDE_EMPTY = flag('--all');

const GRADER_ENDPOINT = process.env.RULES_GRADER_ENDPOINT || 'https://api.deepseek.com/chat/completions';
const GRADER_MODEL = process.env.RULES_GRADER_MODEL || 'deepseek-chat';
const GRADER_KEY_NAME = process.env.RULES_GRADER_KEY || 'DEEPSEEK_API_KEY';
const GRADER_KEY = credential(GRADER_KEY_NAME);

// Two banks, one harness. The reddit bank is questions with the thread's own
// answers in a second file; the French bank carries the answer a French player
// gave next to each question already, because it is the same six questions and
// answers and there is nothing to join. Both end up as {id, q, replies} here.
const BANK = (value('--bank') || 'reddit').toLowerCase();
const ANSWER_LANG = value('--lang') || (BANK === 'fr' ? 'fr' : 'en');

function loadBank() {
  if (BANK === 'fr') {
    const fr = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rules-questions-fr.json'), 'utf8'));
    return fr.questions.map(q => ({
      id: 'fr/' + q.id, q: q.q, thread: 'fr', url: '', comment: q.id,
      replies: [{ score: 1, body: q.expected }],
    }));
  }
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'reddit-answers.json'), 'utf8')).questions;
}

const key = { questions: loadBank() };
const rulesCorpus = readAllCorpus('rules');
const factionsCorpus = readAllCorpus('factions');
const modelKey = modelCredential();   // the writer: the answer the reader sees
const fastKey = fastCredential();     // the judge, on the fast route
const jevKey = credential(jevKeyName());

function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname, headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers) }, r => {
      const c = []; r.on('data', d => c.push(d));
      r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch { resolve(null); } });
    });
    req.on('error', reject); req.setTimeout(120000, () => req.destroy(new Error('grader timed out'))); req.end(body);
  });
}

export function graderPrompt(question, replies, candidate) {
  const community = replies.slice(0, 8).map((r, i) => '[' + (i + 1) + '] (' + r.score + ' points) ' + String(r.body).replace(/\s+/g, ' ').slice(0, 900)).join('\n\n').slice(0, 6000);
  return [
    'You are grading a Warhammer 40,000 rules answer against what the community said in the thread where the question was asked.',
    '',
    'Question: ' + question,
    '',
    BANK === 'fr' ? 'The answer a French player gave to it:' : 'What the players replied, best-voted first:',
    community || '(nobody replied)',
    '',
    'Candidate answer, written by a rules assistant from its own retrieved rule passages:',
    String(candidate || '').slice(0, 4000) || '(empty)',
    '',
    'Decide whether the candidate reaches the same ruling as the community.',
    '- "correct": the ruling agrees with the substance of what the community said, including the conditions and exceptions that change it.',
    '- "partial": it agrees on the headline but misses or contradicts a condition the community stated, or the community was split/uncertain and the candidate presents one reading as settled.',
    '- "wrong": it reaches a different ruling, or states a rule the community contradicts.',
    '- If the community gave no ruling at all - nobody replied, the reply is a joke or a tangent, or it says the call belongs to a tournament organiser - then a candidate that says it does not know, declines, or says the question cannot be settled from the rules is "correct", and a candidate that confidently rules is "wrong".',
    '',
    'Reply with JSON only: {"verdict": "correct", "community": "the ruling the community gave, one sentence", "reason": "why the candidate is that verdict, two sentences"}',
  ].join('\n');
}

export async function grade(question, replies, candidate) {
  if (!GRADER_KEY) return { verdict: 'ungraded', reason: 'no grader key (' + GRADER_KEY_NAME + ')' };
  const body = JSON.stringify({
    model: GRADER_MODEL,
    temperature: 0,
    max_tokens: 700,
    messages: [{ role: 'user', content: graderPrompt(question, replies, candidate) }],
  });
  const res = await post(GRADER_ENDPOINT, { Authorization: 'Bearer ' + GRADER_KEY }, body);
  const text = res && res.choices && res.choices[0] && res.choices[0].message ? res.choices[0].message.content : '';
  const obj = parseJsonObject(text);
  if (!obj) return { verdict: 'ungraded', reason: 'grader returned nothing parseable', raw: String(text).slice(0, 200) };
  const v = String(obj.verdict || '').toLowerCase();
  return {
    verdict: /correct/.test(v) ? 'correct' : /partial/.test(v) ? 'partial' : /wrong/.test(v) ? 'wrong' : 'ungraded',
    community: String(obj.community || ''),
    reason: String(obj.reason || ''),
  };
}

// The page's path, measured per stage so latency is reported too.
export async function answerQuestion(question, lang) {
  const t0 = Date.now();
  const translation = await translateQuestion(question, fastKey);
  const asked = translation.translated || question;
  const tRetrieve = Date.now();
  let findings = [];
  const outcome = await answerableFindings(asked, {
    fastKey,
    dual: { rulesCorpus, factionsCorpus, jevKey, terms: translation.terms, grepNet: 60, jevMax: 80 },
    onFindings: ({ findings: found }) => { findings = found; },
  });
  const tJudge = Date.now();
  const answer = await compileFindings(asked, outcome.findings, modelKey, { lang: lang || ANSWER_LANG });
  const tAnswer = Date.now();
  return {
    asked, answer, findings: outcome.findings.length,
    judge: { answered: outcome.judge.answered, confidence: outcome.judge.confidence, why: outcome.judge.why },
    unresolved: outcome.unresolved, escalated: outcome.escalated,
    ms: { translate: tRetrieve - t0, retrieveJudge: tJudge - tRetrieve, answer: tAnswer - tJudge, total: tAnswer - t0 },
  };
}

async function main() {
  let questions = key.questions.filter(q => INCLUDE_EMPTY || q.replies.length);
  if (ONLY_THREAD) questions = questions.filter(q => q.thread === ONLY_THREAD);
  if (ONLY_IDS.length) questions = questions.filter(q => ONLY_IDS.indexOf(q.thread + '/' + q.comment) !== -1);
  if (LIMIT) questions = questions.slice(0, LIMIT);

  const done = new Set();
  if (fs.existsSync(OUT)) {
    for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { done.add(JSON.parse(line).id); } catch { /* a half-written last line is redone */ }
    }
  }
  console.log('questions ' + questions.length + '  (' + done.size + ' already in ' + OUT + ')');
  console.log('bank ' + BANK + '  answer language ' + ANSWER_LANG + '   writer ' + MODEL + '   judge/translate ' + FAST_MODEL + '   grader ' + GRADER_MODEL + (GRADER_KEY ? '' : '  GRADER KEY MISSING'));

  const counts = { correct: 0, partial: 0, wrong: 0, ungraded: 0 };
  let graded = 0, refused = 0, seconds = 0;

  for (const item of questions) {
    const id = item.thread + '/' + item.comment;
    if (done.has(id)) { continue; }
    const row = { id, q: item.q, url: item.url, thread: item.thread };
    try {
      Object.assign(row, await answerQuestion(item.q, ANSWER_LANG));
      const g = await grade(item.q, item.replies, row.answer);
      row.verdict = g.verdict; row.community = g.community; row.gradeReason = g.reason;
    } catch (e) {
      row.verdict = 'ungraded'; row.gradeReason = 'failed: ' + (e && e.message);
    }
    counts[row.verdict] = (counts[row.verdict] || 0) + 1;
    if (row.verdict !== 'ungraded') graded++;
    if (/I do not know|do not answer this question/i.test(String(row.answer || ''))) refused++;
    seconds += (row.ms && row.ms.total ? row.ms.total : 0) / 1000;
    fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
    console.log('  ' + (graded + counts.ungraded) + '/' + questions.length + '  ' + String(row.verdict).padEnd(8)
      + (row.ms ? (row.ms.total / 1000).toFixed(1) + 's ' : '') + item.q.slice(0, 62));
  }

  const accuracy = graded ? (counts.correct + counts.partial / 2) / graded : 0;
  console.log('');
  console.log('graded            ' + graded + ' of ' + questions.length);
  console.log('correct           ' + counts.correct);
  console.log('partial           ' + counts.partial + '  (half credit)');
  console.log('wrong             ' + counts.wrong);
  console.log('ungraded          ' + counts.ungraded);
  console.log('accuracy          ' + (accuracy * 100).toFixed(1) + '%');
  console.log('declined          ' + refused + ' answers said they did not know');
  console.log('mean answer time  ' + (graded ? (seconds / Math.max(1, graded + counts.wrong)).toFixed(1) : '0') + 's');
  console.log('written to        ' + OUT);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('eval-accuracy.mjs')) main();
