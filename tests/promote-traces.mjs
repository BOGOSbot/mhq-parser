#!/usr/bin/env node
'use strict';
/**
 * Promote a question trace into the retrieval bank.
 *
 * The bank grows from real questions, and a trace is the raw material: what the
 * reader asked, what the page retrieved, and how the writer ended. Two commands:
 *
 *   node tests/promote-traces.mjs --list
 *   node tests/promote-traces.mjs --id <traceId> --expect <id>[,<id>...] --kind <label> [--dry-run]
 *
 * The LABEL IS THE HUMAN'S, never derived. The bank's kinds name the failure mode
 * a question is put in the bank to catch, the best derivation agreed with only
 * 63.6% of the hand labels and caught none of the cross-source or multi-hop ones,
 * and that is why a trace writes kind: unknown. The EXPECTATION is the human's
 * too, but the trace offers candidates - the records it really retrieved, in the
 * order the page put them - so the field is not blank.
 *
 * A trace whose writer failed (empty or timeout) is not a question the bank can
 * use: it is listed as refused and cannot be promoted by accident. A question
 * already in the bank is not promoted twice. Existing entries are never touched -
 * the new one is appended as text, so the fixture's own formatting and every line
 * above it survive byte for byte.
 *
 * Promoting copies what the bank needs and nothing else: the question, the
 * expectation and the label. The raw trace still expires on its own clock; the
 * bank is the durable record.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus } from '../src/rules-corpus.mjs';
import { TRACES_DIR } from '../src/rules-traces.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BANK_PATH = path.join(__dirname, 'fixtures', 'rules-questions.json');
export const KINDS = ['literal', 'paraphrase', 'player', 'cross-source', 'multi-hop', 'out-of-corpus'];
// A writer that came back empty or was cut is a broken run, not a question.
export const BAD_WRITER = ['empty', 'timeout'];

export const norm = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').replace(/[\u2019']/g, "'").trim();

// --expect takes one or more corpus ids, comma-separated - and a corpus id may
// itself contain a comma: the FAQ-derived ids do, e.g.
// 'core-rules#Secured-Objectives->-Q:-...,-can-they-...?'. A comma separates ids
// unless it is escaped as '\,', and the escape never reaches the fixture: the id
// is written the way the corpus spells it. Comma-free ids are unaffected.
export function parseExpectation(value) {
  const out = [];
  const s = String(value == null ? '' : value);
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === ',') { cur += ','; i++; continue; }
    if (c === ',') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function loadTraces(dir) {
  const d = dir || TRACES_DIR;
  const out = [];
  let names = [];
  try { names = fs.readdirSync(d); } catch { return out; }
  for (const name of names.filter(n => /^\d{4}-\d{2}\.ndjson$/.test(n)).sort()) {
    for (const line of fs.readFileSync(path.join(d, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a half-written last line */ }
    }
  }
  return out;
}

export function bankQuestions(bankPath) {
  const bank = JSON.parse(fs.readFileSync(bankPath || BANK_PATH, 'utf8'));
  return (bank.questions || []).map(q => q.q);
}

// What the human can pick from: the records the page actually retrieved, in the
// order it put them, which is already the anchoring order - the record the
// question names by title sits first in its half.
export function candidates(trace, limit) {
  return (trace.findings || []).slice(0, limit || 6).map(f => f.id).filter(Boolean);
}

// What the reader asserted about the answer, when they asserted anything: the
// record they said answered the question, or that none of them did. It is shown to
// the human choosing the expectation - a candidate the pick strongly suggests,
// never the expectation itself, which only that human writes.
export function readerPick(trace) {
  const t = trace || {};
  if (typeof t.answeredBy === 'string' && t.answeredBy) return 'answeredBy: ' + t.answeredBy;
  if (t.answeredNone === true) return 'answeredNone: true';
  return '';
}

// The reader's rerank examples, as one line for the harvest: the records they
// careted (positives) and the ones they x-ed (negatives). The caret and the x are
// labelled examples and the trace is the dataset's gold slice, so the human
// promoting a trace sees them beside the pick and the thumb - they are evidence
// for an expectation, never the expectation itself, which only that human writes.
export function rerankLabels(trace) {
  const l = trace && trace.labels;
  if (!l) return '';
  const pos = (l.positive || []).map(id => '+' + id);
  const neg = (l.negative || []).map(id => '-' + id);
  return pos.concat(neg).join('  ');
}

// The harvest order (task-27): the traces a human should label first are the ones
// that already carry a signal. A thumbs-down is a reader saying the answer was
// wrong; a verdict that cited a passage (judge.cited, or the writer's markers on
// an older trace) is one whose evidence can be checked against the candidates.
// Everything else waits, newest first.
export function tracePriority(trace) {
  if (trace && trace.vote === 'down') return 0;
  const cited = trace && trace.judge && Array.isArray(trace.judge.cited) && trace.judge.cited.length;
  if (cited || /\[\d+\]/.test(String((trace && trace.answer) || ''))) return 1;
  return 2;
}

export function harvestOrder(traces) {
  return (traces || []).map((t, i) => ({ t, i }))
    .sort((a, b) => (tracePriority(a.t) - tracePriority(b.t))
      || String(b.t.at || '').localeCompare(String(a.t.at || ''))
      || (a.i - b.i))
    .map(x => x.t);
}

export function traceStatus(trace, bankQs) {
  // A trace written before the writer field existed still has to be judged on
  // something: an empty answer is a writer failure whatever the field says, and
  // that is how a broken run stays out of the bank.
  const writer = trace.writer || (String(trace.answer == null ? '' : trace.answer).trim() ? '' : 'empty');
  if (BAD_WRITER.indexOf(writer) !== -1) return 'writer-' + writer;
  const set = bankQs instanceof Set ? bankQs : new Set((bankQs || []).map(norm));
  if (set.has(norm(trace.question))) return 'already-in-bank';
  return 'promotable';
}

// The bank is English and the trace's question may not be. The question text is a
// human judgement like the expectation is, so --q overrides it; it defaults to the
// trace's own, and an empty override is refused upstream rather than shipping a
// blank question into the bank.
export function promotedQuestion(trace, override) {
  if (override === undefined || override === null) return String((trace && trace.question) || '');
  return String(override).trim();
}

// One line, the way the fixture writes them: a single JSON object per line.
export function entryLine(entry) {
  return JSON.stringify({ q: entry.q, expect: entry.expect, kind: entry.kind });
}

// Append before the closing bracket, leaving every existing byte alone. The
// fixture keeps one entry per line and ends in '  ]' then '}'; the new entry goes
// in at the same indent, with a comma added to the entry above it if it lacks one.
export function insertEntry(text, line) {
  const m = text.match(/\r?\n([ \t]*)\][ \t]*\r?\n\}[ \t]*\r?\n?$/);
  if (!m) throw new Error('the fixture does not end in a questions array followed by the closing brace');
  const nl = text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const entryIndent = m[1] + '  ';
  const before = text.slice(0, m.index).replace(/[ \t]+$/, '');
  const withComma = /,$/.test(before) ? before : before + ',';
  return withComma + nl + entryIndent + line + text.slice(m.index);
}

export function validateExpectation(ids, corpus) {
  const have = new Set((corpus || readAllCorpus()).map(s => s.id));
  return (ids || []).filter(Boolean).filter(id => !have.has(id));
}

// The eval's own taxonomy, derived from the SIGNALS the trace already carries -
// no corpus lookup, no second opinion about what the reader meant. It labels a
// retained trace for the human who decides whether to promote it; it never writes
// the label, because the trace's kind stays 'unknown' until a human says what it
// is. Agreement with the hand labels measured 63.6% (tests/test-traces.mjs),
// which is a sorting aid, not an authority.
export function classifyTrace(trace) {
  const signals = (trace && trace.signals) || {};
  const q = String((trace && trace.question) || '');
  const findings = (trace && trace.findings) || [];
  if (!findings.length) return 'out-of-corpus';
  const named = /^(what (is|are)|how (does|do))\b/i.test(q.trim());
  if (named && signals.termMatch && !signals.firstPerson) return 'literal';
  if (signals.firstPerson) return 'player';
  const nonCore = (signals.sources || []).some(s => s !== 'core-rules');
  if (nonCore && !signals.termMatch) return 'cross-source';
  return 'paraphrase';
}

async function main() {
  const argv = process.argv.slice(2);
  const value = n => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
  const flag = n => argv.indexOf(n) !== -1;
  const dir = value('--dir') || TRACES_DIR;
  const bankPath = value('--bank') || BANK_PATH;
  const traces = loadTraces(dir);
  const bankQs = bankQuestions(bankPath);

  // --classify: label the retained traces with the eval's taxonomy. Read only.
  if (flag('--classify')) {
    const traces = loadTraces(dir);
    const id = value('--id');
    if (id) {
      const t = traces.find(x => x.id === id);
      if (!t) { console.log('no retained trace with id ' + id); return; }
      console.log(JSON.stringify({ id: t.id, class: classifyTrace(t), signals: t.signals, counts: t.counts, question: t.question }, null, 2));
      console.log('read only: the trace keeps kind=unknown until a human supplies the label at promotion.');
      return;
    }
    const byClass = {};
    for (const t of traces) { const k = classifyTrace(t); byClass[k] = (byClass[k] || 0) + 1; }
    console.log(JSON.stringify({ traces: traces.length, byClass }, null, 2));
    return;
  }

  // --harvest: the read-only listing a human labels from. One block per trace in
  // the harvest order - thumbs-down first, then a cited verdict, then the rest -
  // with the question, the derived class (a sorting aid, never the label), the
  // thumb, the verdict and the top findings with their ids and headings, so the
  // expectation can be chosen by reading the candidates instead of trusting the
  // order. It writes nothing.
  if (flag('--harvest')) {
    const all = flag('--all');
    const limit = Number(value('--limit')) || 40;
    const byId = new Map(readAllCorpus().map(s => [s.id, s]));
    const rows = harvestOrder(traces).map(t => ({ t, status: traceStatus(t, bankQs) })).filter(r => all || r.status === 'promotable').slice(0, limit);
    let down = 0, cited = 0;
    for (const { t } of rows) { const p = tracePriority(t); if (p === 0) down++; else if (p === 1) cited++; }
    console.log('harvest: ' + rows.length + ' traces of ' + traces.length + '   thumb-down ' + down + '   cited ' + cited + '   bank ' + bankQs.length + '   dir ' + dir);
    for (const { t, status } of rows) {
      const j = t.judge || {};
      const marked = Array.isArray(j.cited) && j.cited.length ? j.cited.join(',') : (/\[\d+\]/.test(String(t.answer || '')) ? 'writer-markers' : 'none');
      console.log('');
      console.log('=== ' + t.id + '  ' + String(t.at).slice(0, 16) + '  ' + (t.lang || '?') + '  ' + (t.mode || '?') + '  writer ' + (t.writer || 'unknown') + '  vote ' + (t.vote || '-') + '  class ' + classifyTrace(t) + (status === 'promotable' ? '' : '  [' + status + ']'));
      console.log('Q: ' + t.question);
      if (t.asked && t.asked !== t.question) console.log('EN: ' + t.asked);
      // The reader's own candidate, when they picked one: the record they said
      // answered it, or 'none of these'. A candidate to weigh, not the expectation.
      const reader = readerPick(t);
      if (reader) console.log('reader: ' + reader);
      // The reader's rerank, when they made one: +record is the caret (rank it
      // first), -record is the x (ignore it).
      const labels = rerankLabels(t);
      if (labels) console.log('labels: ' + labels);
      console.log('judge: answered=' + (j.answered === true) + '  confidence=' + (j.confidence || '-') + '  cited=' + marked + (t.overrideOf ? '  override of ' + t.overrideOf : ''));
      console.log('answer: ' + String(t.answer || '').replace(/\s+/g, ' ').slice(0, 220));
      console.log('findings (' + (t.findings || []).length + ', top ' + Math.min(8, (t.findings || []).length) + '):');
      for (const f of (t.findings || []).slice(0, 8)) {
        const rec = byId.get(f.id) || {};
        console.log('  [' + f.n + '] ' + f.id + '  [' + (f.source || rec.source || '?') + ']  ' + (rec.heading || '(not in the corpus)'));
      }
    }
    return;
  }

  if (flag('--list') || !flag('--promote')) {
    const rows = harvestOrder(traces).map(t => ({ t, status: traceStatus(t, bankQs) }));
    const promotable = rows.filter(r => r.status === 'promotable');
    const refused = rows.filter(r => r.status !== 'promotable');
    console.log('traces ' + traces.length + ' in ' + dir + '   bank ' + bankQs.length + ' questions');
    console.log('\npromotable (' + promotable.length + ')');
    // The order is the harvest: thumbs-down, then a cited verdict, then the rest.
    const mark = t => t.vote === 'down' ? 'DOWN ' : ((t.judge && t.judge.cited && t.judge.cited.length) ? 'CITED' : (/\[\d+\]/.test(String(t.answer || '')) ? 'cites' : '     '));
    for (const { t } of promotable) {
      console.log('  ' + mark(t) + ' ' + t.id + '  ' + String(t.at).slice(0, 16) + '  ' + (t.lang || '?') + '  ' + (t.mode || '?') + '  writer ' + (t.writer || 'unknown') + '  findings ' + (t.findings || []).length + '  chars ' + (t.answer || '').length + '  class ' + classifyTrace(t));
      console.log('      Q: ' + t.question);
      console.log('      expect from: ' + (candidates(t).join('  ') || '(no findings)'));
    }
    console.log('\nnot promotable (' + refused.length + ')');
    for (const { t, status } of refused) console.log('  ' + status.padEnd(16) + ' ' + t.id + '  ' + String(t.question).slice(0, 60));
    if (!promotable.length && !refused.length) console.log('  (nothing yet - the page writes traces to ' + dir + ')');
    return;
  }

  const id = value('--id');
  const expect = parseExpectation(value('--expect'));
  const kind = value('--kind');
  const qOverride = value('--q');
  const dryRun = flag('--dry-run');
  if (!id) { console.log('usage: node tests/promote-traces.mjs --harvest | --promote --id <traceId> --expect <id>[,<id>] --kind <label> [--q <english question>] [--dry-run]\n       an id that contains a comma escapes it: --expect "a\\,b,c" is the ids "a,b" and "c"'); process.exitCode = 1; return; }
  if (!KINDS.includes(kind)) { console.log('--kind must be one of: ' + KINDS.join(', ')); process.exitCode = 1; return; }
  const trace = traces.find(t => t.id === id);
  if (!trace) { console.log('no trace with id ' + id + ' in ' + dir); process.exitCode = 1; return; }
  const status = traceStatus(trace, bankQs);
  if (status !== 'promotable') { console.log('refusing: ' + status + '  (' + String(trace.question).slice(0, 70) + ')'); process.exitCode = 1; return; }
  const question = promotedQuestion(trace, qOverride);
  if (!question) { console.log('refusing: the promoted question is empty (--q overrides the trace)'); process.exitCode = 1; return; }
  if (new Set((bankQs || []).map(norm)).has(norm(question))) { console.log('refusing: already-in-bank  (' + question + ')'); process.exitCode = 1; return; }
  const unknown = validateExpectation(expect, readAllCorpus());
  if (unknown.length) { console.log('these expectation ids are not in the corpus: ' + unknown.join(', ')); process.exitCode = 1; return; }

  const line = entryLine({ q: question, expect, kind });
  const text = fs.readFileSync(bankPath, 'utf8');
  const next = insertEntry(text, line);
  console.log('trace    ' + trace.id + '  writer ' + (trace.writer || 'unknown'));
  console.log('question ' + question + (qOverride !== null ? '   (--q override of: ' + trace.question + ')' : ''));
  console.log('entry    ' + line);
  if (dryRun) { console.log('dry run - nothing written'); return; }
  fs.writeFileSync(bankPath, next);
  console.log('written to ' + bankPath);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('promote-traces.mjs')) main();
