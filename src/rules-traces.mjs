#!/usr/bin/env node
'use strict';
/**
 * Question traces: what the reader asked, what the page did with it, written
 * down so the page is improved from real questions instead of guessed at.
 *
 * The reader is told first. The disclaimer on the page is what makes keeping a
 * question legitimate, so the writer is OFF by default - \`RULES_TRACES=1\` turns
 * it on - and the deployment sets it only because that line is live and rendered
 * in both languages (docs/question-traces.md).
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

// How the writer ended, as its own field: 'ok', 'empty' (it came back with
// nothing), 'timeout' (the call was cut) or 'declined' (it read the findings and
// refused). Empty and timeout read the same to a reader - one sentence covers
// both - but they are different defects and a trace has to be filterable by which
// one happened, or the page's real failure rate stays invisible in the data we
// just started collecting.
//
// This is the PROSE outcome and nothing else. The card used to answer alone and
// wrote 'card' here; now that the card is a preview the prose always runs, and a
// preview must not overwrite the outcome - the evaluation bank's writer-empty
// guard and any failure-rate count read this field. Which datasheet previewed is
// in `card: { id, name }`.
export function writerMode(input) {
  const o = input || {};
  if (o.failed) return o.failed;
  if (o.declined) return 'declined';
  if (!String(o.answer == null ? '' : o.answer).trim()) return 'empty';
  return 'ok';
}

// Which findings the verdict rested on. The passages array names positions in
// the findings list, never prose, so the trace keeps the pointers and still keeps
// no agent reasoning - and the harvest reads them to put a checkable trace first.
const citedPassages = j => (j && Array.isArray(j.passages) ? j.passages : []).filter(n => typeof n === 'number').slice(0, 24);

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
    // task-24 (J4): the ruling's slots, so a trace can be read back as the page
    // rendered it, and the trace check's own outcome (total claims, how many the
    // cited passages did not carry) is measurable across the bank.
    agent: {
      answered: !!(input.agent && input.agent.answered),
      confidence: (input.agent && input.agent.confidence) || '',
      reasoning: input.agentReasoning || '',
      cited: citedPassages(input.agent),
      answer: (input.agent && input.agent.answer) || '',
      from: (input.agent && input.agent.from) || null,
      exceptions: (input.agent && Array.isArray(input.agent.exceptions)) ? input.agent.exceptions : [],
      trace: (input.agent && input.agent.trace) ? { total: input.agent.trace.total || 0, dropped: input.agent.trace.dropped || 0 } : null,
    },
    // The second agent, and whether the two disagreed. The rate this exists to
    // make measurable is count(agentDisagreement) / count(traces with secondAgent): a
    // question the binding agent accepted and the careful one refused is the
    // reader's one signal that the prose is provisional.
    agentDisagreement: !!input.agentDisagreement,
    // Which agent dissented, and whether that dissent was allowed to downgrade
    // the answer. Both are needed to measure the rule: a refusal from the quick
    // agent in deep mode is information, not a downgrade.
    agentDowngrade: !!input.agentDowngrade,
    agentDissentFrom: input.agentDissentFrom || '',
    answer: input.answer || '',
    writer: writerMode(input),
    steps: input.steps || [],
    elapsedMs: input.elapsedMs || 0,
    unresolved: !!input.unresolved,
    escalated: !!input.escalated,
    attempts: input.attempts || 0,
  };
  // The English the question was turned into, when it was not English already:
  // that is what was actually searched.
  if (input.asked && input.asked !== input.question) t.asked = input.asked;
  // A datasheet lookup is answered from the CSV, not from the corpus: the trace
  // records which datasheet, so card questions are filterable instead of looking
  // like an answer whose writer came back empty.
  if (input.card) t.card = { id: input.card.id, name: input.card.name };
  // A manual rerank is a human override of the retrieval, not a second question:
  // which passages the reader kept, dropped or added, and which trace it
  // overrides. The candidate list the reader saw is already in the trace's
  // findings, so only the delta and the pointer are stored.
  if (input.override) t.override = input.override;
  if (input.overrideOf) t.overrideOf = input.overrideOf;
  if (input.secondAgent) {
    t.secondAgent = {
      answered: input.secondAgent.answered === true,
      confidence: input.secondAgent.confidence || '',
      reasoning: input.secondAgent.reasoning || '',
    };
  }
  return t;
}

// One JSON line per question, in the month it was asked. The reader's questions
// live here, apart from workspace/rules-corpus/: the corpus is third-party, this
// is not, and neither should end up in the other's store.
export function appendTrace(trace, dir) {
  const d = dir || TRACES_DIR;
  fs.mkdirSync(d, { recursive: true });
  // A mark the reader made while this run was still going: the label was posted
  // the moment it was clicked and held against this id (holdLabels), and it lands
  // with the line it belongs to. Validated here against THIS trace's own findings,
  // so an id the trace never showed is dropped with the hold, not written.
  const held = takePendingLabels(trace && trace.id);
  if (held) applyLabels(trace, held.positive, held.negative);
  const file = path.join(d, String(trace.at || '').slice(0, 7) + '.ndjson');
  fs.appendFileSync(file, JSON.stringify(trace) + '\n');
  return file;
}

// --- the label that arrives before its trace ---------------------------------
// The reader's caret and x are posted the moment they are clicked, and the trace
// that holds them is only written when the answer lands - seconds later, or never,
// if the reader leaves. A label for an id the store does not hold yet is held here
// against that id and applied by appendTrace when the line lands. The hold is
// keyed by the question's random id, so it can never reach another question's
// record; it expires (a run that takes half an hour is not coming back) and the
// map is capped, so a reader who never returns cannot grow it without bound.
export const PENDING_LABEL_MS = 30 * 60 * 1000;
export const PENDING_LABEL_MAX = 500;
let pendingLabels = new Map();   // id -> { positive, negative, at }

export function pendingLabelCount(now) {
  dropExpiredLabels(now);
  return pendingLabels.size;
}
export function resetPendingLabels() { pendingLabels = new Map(); }

function dropExpiredLabels(now) {
  const t = now === undefined ? Date.now() : now;
  for (const [id, p] of pendingLabels) {
    if (t - (p.at || 0) > PENDING_LABEL_MS) pendingLabels.delete(id);
  }
  // Oldest first: a Map iterates in insertion order.
  while (pendingLabels.size > PENDING_LABEL_MAX) pendingLabels.delete(pendingLabels.keys().next().value);
}

export function holdLabels(id, pick, now) {
  if (!id) return false;
  const p = pick || {};
  const clean = list => [...new Set((list || []).filter(x => typeof x === 'string' && x))].slice(0, 40);
  const t = now === undefined ? Date.now() : now;
  dropExpiredLabels(t);
  pendingLabels.delete(id);
  pendingLabels.set(id, { positive: clean(p.positive), negative: clean(p.negative), at: t });
  dropExpiredLabels(t);
  return true;
}

export function takePendingLabels(id, now) {
  dropExpiredLabels(now);
  if (!id || !pendingLabels.has(id)) return null;
  const p = pendingLabels.get(id);
  pendingLabels.delete(id);
  return p;
}

// --- retention ---------------------------------------------------------------
// Raw traces expire; the bank does not. A question promoted into the eval bank
// lives in tests/fixtures, which is tracked and never swept, so the raw line that
// produced it can go - and the sweep must never reach into the bank. The sweep
// rides the monthly ingest (src/rules-corpus.mjs) so it cannot be forgotten, and
// a line it cannot date is kept rather than deleted.
export const TRACE_RETENTION_MONTHS = 12;

// Every post-hoc write into a trace goes through here: find the record by its
// random id, apply the patch, write the file back. The whole scan-and-rewrite is
// synchronous, so inside one process two patches cannot interleave - the server
// that answered the question is the only writer. It is the read-modify-write
// shape, and it is exposed only if a second process shares the traces dir.
function patchTrace(id, patch, dir, onMiss) {
  if (!id) return false;
  const d = dir || TRACES_DIR;
  let names = [];
  try { names = fs.readdirSync(d); } catch { return false; }
  for (const name of names.filter(n => /^\d{4}-\d{2}\.ndjson$/.test(n)).sort().reverse()) {
    const file = path.join(d, name);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let hit = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let t = null;
      try { t = JSON.parse(lines[i]); } catch { continue; }
      if (!t || t.id !== id) continue;
      if (patch(t) === false) return false;   // refused: the file is left alone
      lines[i] = JSON.stringify(t);
      hit = true;
      break;
    }
    if (hit) { fs.writeFileSync(file, lines.join('\n')); return true; }
  }
  // No line holds this id yet: the caller may hold the patch for when one does.
  if (onMiss) onMiss();
  return false;
}

// A reader's thumb, written into the trace record it belongs to, by question id.
// The trace exists whether or not anyone votes - most readers never click - so
// the vote is a bonus on top of the record, never the record itself. One id, one
// vote: a second vote replaces the first. It returns false when there is no trace
// to hold it (traces off, or the line already swept) and the page says nothing.
// Nothing in it identifies the reader: it is one boolean beside a random id.
export function voteTrace(id, vote, dir) {
  const v = vote === 'up' || vote === 'down' ? vote : '';
  if (!v) return false;
  return patchTrace(id, t => { t.vote = v; return true; }, dir);
}

// The reader's rerank, as labelled examples: the green caret is a POSITIVE for a
// record id, the x a NEGATIVE. Both name a record the reader was actually shown,
// and both go into the SAME trace as the question - which is the dataset's gold
// slice - through the same find-by-id patch the thumb uses. It is the same
// mechanism and the same store, deliberately: a second file or a second scan
// would be a second answer to 'what did the reader mean by that tap'.
//
// The sets are the reader's CURRENT state, not an action log: a second caret or a
// second x replaces the first, exactly as a second thumb does, and an id the
// trace never held is refused. Clearing every mark clears the field, so a tap the
// reader took back does not stay in the record - the same reason the pick has one
// slot rather than a log.
// The reader's CURRENT state applied to one trace: each id must be one the trace
// really showed, and a record is positive or negative, never both - the caret
// wins, because the page clears one when the reader taps the other. An empty
// request is a deliberate clear; a request that named records and resolved none
// of them is refused, because the reader can only mark what they were shown.
function applyLabels(t, positive, negative) {
  const shown = new Set((t.findings || []).map(f => f && f.id));
  const pos = positive.filter(x => shown.has(x));
  const neg = negative.filter(x => shown.has(x) && pos.indexOf(x) === -1);
  if (!pos.length && !neg.length) {
    if (positive.length || negative.length) return false;
    delete t.labels;
    return true;
  }
  t.labels = { positive: pos, negative: neg };
  return true;
}

export function labelsTrace(id, pick, dir) {
  const p = pick || {};
  if (!Array.isArray(p.positive) || !Array.isArray(p.negative)) return false;
  const clean = list => [...new Set(list.filter(x => typeof x === 'string' && x))].slice(0, 40);
  const positive = clean(p.positive);
  const negative = clean(p.negative);
  // No line holds the id yet - the run is still going, or the reader left before
  // it ended - so the pick is held and lands with the trace (appendTrace). The
  // hold is the reader's latest state, like the patch it stands in for.
  let held = false;
  const patched = patchTrace(id, t => applyLabels(t, positive, negative), dir, () => { held = holdLabels(id, { positive, negative }); });
  return patched || held;
}

// The reader's explicit 'this passage answered it', or 'none of these'. It is an
// ASSERTION about the answer and not the manual rerank's kept set, which is a
// preference about what the next answer should rest on: the two are different
// signals and must not be read as each other. It is a CANDIDATE for the bank,
// never a label - kind stays 'unknown' and only a human promotes it - and it adds
// no identifier: a record id the trace already holds, or a boolean, beside the
// question's random id.
//
// The record id is checked against the findings of the trace it names, so a pick
// can only point at something the reader was actually shown. One pick per
// question: a second replaces the first in either direction - a record after
// 'none', or 'none' after a record.
export function answeredTrace(id, pick, dir) {
  const p = pick || {};
  const none = p.none === true;
  const by = typeof p.by === 'string' ? p.by : '';
  if (!none && !by) return false;
  return patchTrace(id, t => {
    if (!none && !(t.findings || []).some(f => f && f.id === by)) return false;
    if (none) { delete t.answeredBy; t.answeredNone = true; }
    else { delete t.answeredNone; t.answeredBy = by; }
    return true;
  }, dir);
}

export function traceCutoff(months, now) {
  const m = months === undefined ? TRACE_RETENTION_MONTHS : months;
  const n = now ? new Date(now) : new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - m, n.getUTCDate())).getTime();
}

export function sweepTraces(opts) {
  const o = opts || {};
  const dir = o.dir || TRACES_DIR;
  const months = o.months === undefined ? TRACE_RETENTION_MONTHS : o.months;
  const cutoff = traceCutoff(months, o.now);
  const out = { dir, months, cutoff: new Date(cutoff).toISOString(), files: 0, kept: 0, removed: 0, expired: [], deleted: [] };
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names.filter(n => /^\d{4}-\d{2}\.ndjson$/.test(n)).sort()) {
    out.files++;
    const file = path.join(dir, name);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const keep = [];
    for (const line of lines) {
      let at = NaN;
      try { at = new Date(JSON.parse(line).at).getTime(); } catch { at = NaN; }
      if (isNaN(at) || at >= cutoff) { keep.push(line); continue; }
      out.removed++;
      if (out.expired.length < 20) { try { out.expired.push(JSON.parse(line).id); } catch { out.expired.push('?'); } }
    }
    out.kept += keep.length;
    if (keep.length === lines.length || o.dryRun) continue;
    if (!keep.length) { fs.unlinkSync(file); out.deleted.push(name); }
    else fs.writeFileSync(file, keep.join('\n') + '\n');
  }
  return out;
}
