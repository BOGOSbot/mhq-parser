#!/usr/bin/env node
'use strict';
/**
 * Validation on real questions.
 *
 *   node tests/eval-reddit.mjs [--limit 20] [--retriever union] [--topk 5]
 *
 * The authored question set in fixtures/rules-questions.json has an answer key,
 * which is what makes it precise - and also what makes it mine. These are real
 * questions players asked in r/WarhammerCompetitive weekly threads, after 11th
 * edition launched, so the phrasing is the phrasing a user will actually type:
 * colloquial, ambiguous, sometimes about tournaments rather than rules.
 *
 * There is no answer key for them, so the retrieval is graded by the model:
 * given the question and the five passages, does any passage state the rule
 * needed? It is instructed to judge only what is written, because a model
 * answering from memory would pass a retrieval that never contained the rule.
 *
 * Reported:
 *   coverage   rules questions where the top-k contained the answering rule
 *   cited      where in the top-k the answering passage sat, so a reranker
 *              problem is distinguishable from a recall problem
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAST_MODEL, credential, fastCredential } from '../src/rules.mjs';
import { judgeCoverage, readAllCorpus, retrieveDual } from '../src/rules-corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const value = n => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const LIMIT = parseInt(value('--limit') || '0', 10);
const TOPK = parseInt(value('--topk') || '5', 10);

const bank = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'reddit-questions.json'), 'utf8'));
const questions = LIMIT ? bank.questions.slice(0, LIMIT) : bank.questions;
const rulesCorpus = readAllCorpus('rules');
const factionsCorpus = readAllCorpus('factions');
const JEV = credential('OPENCODE_GO_API_KEY');
const SENSE = fastCredential();

console.log('questions ' + questions.length + ' from ' + bank.source);
console.log('corpus: ' + rulesCorpus.length + ' rules sections + ' + factionsCorpus.length + ' faction records  |  topK ' + TOPK + ' per half');
console.log('judge:  ' + FAST_MODEL);
console.log('');

let rules = 0, answered = 0, unparsed = 0;
const judgeMs = [];
const citedAt = {};
const misses = [];

for (let i = 0; i < questions.length; i++) {
  const item = questions[i];
  let passages = [];
  try {
    const dual = await retrieveDual(item.q, { rulesCorpus, factionsCorpus, jevKey: JEV, grepNet: 40, jevMax: 30, topK: TOPK });
    passages = dual.all;
  } catch (e) {
    console.log('  retrieve failed: ' + e.message);
    continue;
  }
  let verdict;
  const judgeAt = Date.now();
  try {
    verdict = await judgeCoverage(item.q, passages, SENSE);
    judgeMs.push(Date.now() - judgeAt);
  } catch (e) {
    console.log('  judge failed: ' + e.message);
    continue;
  }
  if (verdict.rulesQuestion === null) { unparsed++; continue; }
  if (!verdict.rulesQuestion) { continue; }
  rules++;
  const rank = verdict.passages.length ? Math.min.apply(null, verdict.passages) : null;
  if (verdict.answered && rank) {
    answered++;
    citedAt[rank] = (citedAt[rank] || 0) + 1;
  } else {
    misses.push({ q: item.q, why: verdict.why, top: passages.slice(0, 3).map(p => p.heading) });
  }
  process.stdout.write('  ' + (i + 1) + '/' + questions.length + '  ' + (verdict.answered ? 'ok  ' : 'MISS') + '  ' + item.q.slice(0, 70) + '\r');
}

console.log('\n');
console.log('rules questions   ' + rules + ' of ' + questions.length + (unparsed ? '  (' + unparsed + ' unparsed verdicts)' : ''));
console.log('coverage          ' + answered + '/' + rules + '  ' + (rules ? Math.round((answered / rules) * 1000) / 10 : 0) + '%');
console.log('cited at rank     ' + Object.keys(citedAt).sort().map(k => '#' + k + ': ' + citedAt[k]).join('   '));
if (judgeMs.length) {
  const sorted = judgeMs.slice().sort((a, b) => a - b);
  const mean = judgeMs.reduce((a, b) => a + b, 0) / judgeMs.length;
  console.log('judge latency     mean ' + Math.round(mean) + 'ms   median ' + sorted[Math.floor(sorted.length / 2)] + 'ms   over ' + judgeMs.length + ' calls, ' + FAST_MODEL);
}
console.log('');
console.log('misses (' + misses.length + '):');
for (const m of misses) {
  console.log('  ' + m.q.slice(0, 110));
  console.log('      ' + m.why);
  console.log('      got: ' + m.top.join(' | '));
}
