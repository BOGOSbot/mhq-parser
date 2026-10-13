#!/usr/bin/env node
'use strict';
/**
 * Question traces: what the reader asked, what the page did with it, written
 * down so the page is improved from real questions instead of guessed at.
 *
 * The reader is told first. The disclaimer on the page is what makes keeping a
 * question legitimate, so the writer is OFF by default - \`RULES_TRACES=1\` turns
 * it on - and the switch is deliberately not flipped until that line is live.
 *
 * What must never be in a trace:
 *   - no IP address, no user agent, no cookie, no account and no session id. The
 *     id is 8 random bytes per question and ties to nothing;
 *   - no corpus passage text. A finding is stored as a pointer to the record
 *     (set, source, ruleId, id), never as its excerpt or its heading: a retained
 *     copy of third-party prose would be a second corpus, growing, inside the
 *     reader's store. The compiled answer is the one corpus-derived thing kept,
 *     and only because the eval bank cannot grade without it.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TRACES_DIR = process.env.RULES_TRACES_DIR || path.join(__dirname, '..', 'workspace', 'rules-traces');

// Off unless asked for, and off in the only way that matters: a missing or
// unrecognised value is off.
export function tracesEnabled(env) {
  const v = String((env || process.env).RULES_TRACES || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

export function newTraceId() {
  return crypto.randomBytes(8).toString('hex');
}

// The eval bank's labels - literal, paraphrase, player, cross-source - name the
// failure mode a question was PUT IN THE BANK to catch. They are a curation
// decision, not a property of the text: measured against the bank's own 29 hand
// labels, the best derivation from the question and the records it reached
// agreed 21/33 (63.6%), and caught 0 of 4 cross-source and 0 of 2 multi-hop. So
// a trace records the SIGNALS a label would be made from and leaves \`kind\`
// unknown, rather than writing a guess that would not be comparable to the bank.
// \`node tests/test-traces.mjs\` prints that measurement.
export const KIND_UNKNOWN = 'unknown';

const STOP = new Set(('the a an is are was were be been being how what does do did i my our we me you your it its that this these those when can could would should in on of to for with and or not while into out up over more than one two all there their have has had will may might must about after before during between under above then so such same other another own both some many much most only also just even still yet get gets make makes take takes use uses give gives work works rule rules phase step steps end start turn battle round point points type types order sequence way ways thing things unit units model models').split(' '));
const words = s => String(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
const distinctive = s => words(s).filter(w => w.length >= 4 && !STOP.has(w));

export function termMatch(question, headings) {
  const qw = new Set(words(question));
  for (const h of headings || []) for (const t of distinctive(h)) if (qw.has(t)) return true;
  return false;
}

export function firstPerson(question) {
  const q = String(question);
  return /\b(i|my|our|we|me|us)\b/i.test(q) || /\b(je|mon|ma|mes|notre|nos|moi|nous)\b/i.test(q);
}

// What the label would have been made from, so promoting a trace into the bank
// needs no second read of it.
export function traceSignals(question, findings) {
  const list = findings || [];
  const sources = [...new Set(list.map(f => f.source).filter(Boolean))];
  const halves = [...new Set(list.map(f => f.set).filter(Boolean))];
  const rules = [...new Set(list.map(f => f.ruleId).filter(Boolean))];
  return {
    firstPerson: firstPerson(question),
    termMatch: termMatch(question, list.map(f => f.heading)),
    sources,
    halves,
    rules: rules.length,
  };
}

// The pointer, not the passage.
export function traceFindings(findings) {
  return (findings || []).map(f => ({
    n: f.n, set: f.set, source: f.source, ruleId: f.ruleId || '', id: f.id || '',
  }));
}

export function buildTrace(input) {
  const t = {
    id: input.id,
    at: input.at,
    edition: input.edition || '',
    // The corpus build the answer came from: a trace against a stale corpus is
    // worthless as an expectation, and after the fact there is no other way to
    // tell. /health publishes the same stamp.
    corpusAt: input.corpusAt || '',
    mode: input.mode || '',
    lang: input.lang || 'und',
    question: input.question,
    terms: input.terms || [],
    kind: KIND_UNKNOWN,
    signals: input.signals,
    counts: input.counts || { rules: 0, factions: 0 },
    findings: traceFindings(input.findings),
    judge: { answered: !!(input.judge && input.judge.answered), confidence: (input.judge && input.judge.confidence) || '' },
    answer: input.answer || '',
    steps: input.steps || [],
    elapsedMs: input.elapsedMs || 0,
    unresolved: !!input.unresolved,
    escalated: !!input.escalated,
    attempts: input.attempts || 0,
  };
  // The English the question was turned into, when it was not English already:
  // that is what was actually searched.
  if (input.asked && input.asked !== input.question) t.asked = input.asked;
  return t;
}

// One JSON line per question, in the month it was asked. The reader's questions
// live here, apart from workspace/rules-corpus/: the corpus is third-party, this
// is not, and neither should end up in the other's store.
export function appendTrace(trace, dir) {
  const d = dir || TRACES_DIR;
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, String(trace.at || '').slice(0, 7) + '.ndjson');
  fs.appendFileSync(file, JSON.stringify(trace) + '\n');
  return file;
}
