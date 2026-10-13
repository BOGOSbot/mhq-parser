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

async function main() {
  const argv = process.argv.slice(2);
  const value = n => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
  const flag = n => argv.indexOf(n) !== -1;
  const dir = value('--dir') || TRACES_DIR;
  const bankPath = value('--bank') || BANK_PATH;
  const traces = loadTraces(dir);
  const bankQs = bankQuestions(bankPath);

  if (flag('--list') || !flag('--promote')) {
    const rows = traces.map(t => ({ t, status: traceStatus(t, bankQs) }));
    const promotable = rows.filter(r => r.status === 'promotable');
    const refused = rows.filter(r => r.status !== 'promotable');
    console.log('traces ' + traces.length + ' in ' + dir + '   bank ' + bankQs.length + ' questions');
    console.log('\npromotable (' + promotable.length + ')');
    for (const { t } of promotable) {
      console.log('  ' + t.id + '  ' + String(t.at).slice(0, 16) + '  ' + (t.lang || '?') + '  ' + (t.mode || '?') + '  writer ' + (t.writer || 'unknown') + '  findings ' + (t.findings || []).length + '  chars ' + (t.answer || '').length);
      console.log('      Q: ' + t.question);
      console.log('      expect from: ' + (candidates(t).join('  ') || '(no findings)'));
    }
    console.log('\nnot promotable (' + refused.length + ')');
    for (const { t, status } of refused) console.log('  ' + status.padEnd(16) + ' ' + t.id + '  ' + String(t.question).slice(0, 60));
    if (!promotable.length && !refused.length) console.log('  (nothing yet - the page writes traces to ' + dir + ')');
    return;
  }

  const id = value('--id');
  const expect = (value('--expect') || '').split(',').map(s => s.trim()).filter(Boolean);
  const kind = value('--kind');
  const dryRun = flag('--dry-run');
  if (!id) { console.log('usage: node tests/promote-traces.mjs --list | --promote --id <traceId> --expect <id>[,<id>] --kind <label> [--dry-run]'); process.exitCode = 1; return; }
  if (!KINDS.includes(kind)) { console.log('--kind must be one of: ' + KINDS.join(', ')); process.exitCode = 1; return; }
  const trace = traces.find(t => t.id === id);
  if (!trace) { console.log('no trace with id ' + id + ' in ' + dir); process.exitCode = 1; return; }
  const status = traceStatus(trace, bankQs);
  if (status !== 'promotable') { console.log('refusing: ' + status + '  (' + String(trace.question).slice(0, 70) + ')'); process.exitCode = 1; return; }
  const unknown = validateExpectation(expect, readAllCorpus());
  if (unknown.length) { console.log('these expectation ids are not in the corpus: ' + unknown.join(', ')); process.exitCode = 1; return; }

  const line = entryLine({ q: trace.question, expect, kind });
  const text = fs.readFileSync(bankPath, 'utf8');
  const next = insertEntry(text, line);
  console.log('trace    ' + trace.id + '  writer ' + (trace.writer || 'unknown'));
  console.log('question ' + trace.question);
  console.log('entry    ' + line);
  if (dryRun) { console.log('dry run - nothing written'); return; }
  fs.writeFileSync(bankPath, next);
  console.log('written to ' + bankPath);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('promote-traces.mjs')) main();
