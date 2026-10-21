#!/usr/bin/env node
'use strict';
/**
 * guard-order: the retrieval guard, re-specified (task-9).
 *
 * The old guard (workspace/guard5.mjs, guard5b.mjs) posted five questions to
 * /rules/ask and compared FINDING COUNTS. That is not a fingerprint: the agent's
 * first pass decides whether the search widens, so the same build returned
 * 15/12/15/35/13 and 15/34/34/35/13 minutes apart, and neither matched the
 * recorded 15/13/12/33/15 (handoff, 2026-10-16). The retriever itself is
 * deterministic; the agent is not, and a count moves when the agent widens.
 *
 * What this command fingerprints is the UNJUDGED retrieval order: the two halves'
 * ordered findings for a fixed five-question set, rerank off (jevSkip, no key),
 * no agent, no model, no billed spend. Two runs minutes apart hash the same; a
 * change to the corpus, the index, the grep, the fusion, the anchoring or the
 * child-clarification rule moves the hash.
 *
 *   node tests/guard-order.mjs            # print the fingerprint, compare to the baseline
 *   node tests/guard-order.mjs --record   # record the current order (a deliberate change)
 *
 * Exit codes: 0 the order matches the baseline (or was recorded); 1 the order
 * changed, naming the first moved id; 2 the vector leg answered nothing - an
 * index or credentials failure, not an order change.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { retrieveDual } from '../src/rules-corpus.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'tests', 'fixtures', 'retrieval-guard.json');

// The five questions the old guard asked, unchanged: the point is to compare the
// SAME set run to run, not to widen it.
const QUESTIONS = [
  'Can a unit shoot after it Fell Back?',
  'How does Devastating Wounds interact with Anti-?',
  'When does a unit become Battle-shocked?',
  'What does Oath of Moment do for Space Marines?',
  'Does the Tyrannofex have the FRAME keyword?',
];
// Fast mode's per-side depth (ASK_MODES.fast). The order is what is guarded, not
// the depth; a deliberate depth change re-records the baseline.
const PLAN = { rules: 5, factions: 5 };

export function fingerprint(orders) {
  return crypto.createHash('sha256').update(JSON.stringify(orders)).digest('hex');
}

async function orderFor(q) {
  const dual = await retrieveDual(q, { perSide: PLAN, topK: PLAN.rules, jevSkip: true });
  const legs = dual.rules.concat(dual.factions).map(s => s.leg);
  return {
    q,
    rules: dual.rules.map(s => s.id),
    factions: dual.factions.map(s => s.id),
    vector: legs.filter(l => l === 'vector' || l === 'both').length,
  };
}

function load() {
  try { return JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch (e) { return null; }
}

function firstMove(before, after) {
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    if (before[i] !== after[i]) return { at: i, was: before[i], now: after[i] };
  }
  return null;
}

async function main() {
  const record = process.argv.indexOf('--record') !== -1;
  const orders = [];
  for (const q of QUESTIONS) orders.push(await orderFor(q));
  const fp = fingerprint(orders);
  const vectorLegs = orders.reduce((n, o) => n + o.vector, 0);
  console.log('retrieval guard - unjudged order, ' + QUESTIONS.length + ' questions, per-side ' + PLAN.rules + '/' + PLAN.factions);
  for (const o of orders) console.log('  ' + fingerprint(o).slice(0, 12) + '  ' + o.q);
  console.log('FINGERPRINT ' + fp);
  if (!vectorLegs) {
    console.log('VECTOR_LEG_MISSING: the index answered no vector hit for any question - check UPSTASH_VECTOR_* and the namespace, not the order');
    process.exitCode = 2;
    return;
  }
  if (record) {
    fs.writeFileSync(BASELINE, JSON.stringify({ recordedAt: new Date().toISOString(), questions: QUESTIONS, plan: PLAN, orders: orders, fingerprint: fp }, null, 2) + '\n');
    console.log('RECORDED ' + path.relative(ROOT, BASELINE));
    return;
  }
  const base = load();
  if (!base) {
    console.log('NO_BASELINE: run with --record to write ' + path.relative(ROOT, BASELINE));
    process.exitCode = 1;
    return;
  }
  if (JSON.stringify(base.orders) === JSON.stringify(orders)) {
    console.log('MATCH baseline ' + String(base.fingerprint).slice(0, 16) + ' (recorded ' + base.recordedAt + ')');
    return;
  }
  console.log('CHANGED: the unjudged order no longer matches the recorded fingerprint');
  for (let i = 0; i < orders.length; i++) {
    const b = base.orders[i] || { rules: [], factions: [] };
    for (const list of ['rules', 'factions']) {
      const moved = firstMove(b[list] || [], orders[i][list]);
      if (moved) {
        console.log('  ' + orders[i].q + ' [' + list + '] position ' + (moved.at + 1) + ':');
        console.log('    was ' + (moved.was === undefined ? '(none)' : moved.was));
        console.log('    now ' + (moved.now === undefined ? '(none)' : moved.now));
      }
    }
  }
  process.exitCode = 1;
}

main().catch(e => { console.error('GUARD_FAILED: ' + (e && e.message ? e.message : e)); process.exitCode = 2; });
