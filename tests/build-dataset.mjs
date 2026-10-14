#!/usr/bin/env node
'use strict';
/**
 * The /rules dataset: one JSONL record per trace, plus the bank as the eval split.
 *
 *   node tests/build-dataset.mjs [--dir workspace/rules-traces] [--out workspace/dataset/dataset.jsonl]
 *                                [--bank tests/fixtures/rules-questions.json] [--manifest workspace/dataset/manifest.json]
 *                                [--retrieval]
 *
 * The schema is the vault note's (notes/mhq-dataset.md): id, q, lang, translation,
 * answer, gold as GROUPS, gold_how, negatives, source, at, split. The dataset is
 * rule text with questions attached, so it lives in workspace/ like the corpus,
 * never in git.
 *
 * Every id is resolved against the CORPUS AT READ TIME and the failures are
 * reported, never silently dropped: task-30 moved 1,594 ids, so a pre-move trace
 * can name a record that no longer exists. The manifest says how many, per source
 * and in total.
 *
 * Gold comes from the trace, in the note's precision order: the reader's own pick
 * (the caret, or the 'this one answers it' button) first, then an up-vote's cited
 * passages, then the judge's citations unmarked for what they are (marked
 * `gold_how: 'judge'` and never used for eval). Negatives are the x button plus
 * everything the run showed that is not gold.
 *
 * ACCURACY of the labels is not measurable here: gold_how says where each label
 * came from, and only 'caret'/'vote' are a person saying it.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { TRACES_DIR } from '../src/rules-traces.mjs';
import { ASK_MODES, askMode, readAllCorpus, retrieveDual, findingFor } from '../src/rules-corpus.mjs';
import { credential, jevKeyName } from '../src/rules.mjs';
import { expectGroups } from './expectation-groups.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
function flag(name, def) { const i = process.argv.indexOf('--' + name); return i === -1 ? def : (process.argv[i + 1] || ''); }
export const sha8 = text => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 8);

// --- reading -----------------------------------------------------------------
export function loadTraces(dir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /\.ndjson$/.test(n)).sort(); } catch (e) { return out; }
  for (const name of names) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (e) { /* a broken line is not a trace */ }
    }
  }
  return out.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}

export function loadBank(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).questions || []; } catch (e) { return []; }
}

// --- resolving ---------------------------------------------------------------
// A gold group keeps the members the corpus still holds. An id the corpus lost is
// reported, and a group that loses every member is dropped: a dead id must not
// enter the dataset, and the writer must say how many died.
export function resolveGroups(groups, live) {
  const kept = [], missing = [];
  for (const group of groups || []) {
    const k = (group || []).filter(id => {
      if (live.has(id)) return true;
      missing.push(id);
      return false;
    });
    if (k.length) kept.push(k);
  }
  return { groups: kept, missing };
}

// The passages the verdict rested on: the judge's cited finding numbers, or - on
// an older trace that predates cited - the writer's own [n] markers.
export function citedIds(trace) {
  const findings = trace.findings || [];
  const byN = new Map(findings.map(f => [f.n, f.id]));
  const out = [];
  const add = n => { const id = byN.get(n); if (id && out.indexOf(id) === -1) out.push(id); };
  const cited = (trace.judge && Array.isArray(trace.judge.cited)) ? trace.judge.cited : [];
  for (const n of cited) add(n);
  if (!out.length) {
    for (const m of String(trace.answer || '').matchAll(/\[(\d+)\]/g)) add(Number(m[1]));
  }
  return out;
}

// The label, in the note's precision order. Returns the groups and how they were
// made; 'caret' covers the reader's own pick (the caret or the answeredBy button),
// the strongest label the page can produce without a human at a desk.
// One group PER ID on the trace lanes: a group means 'any member satisfies, every
// group must be satisfied', so every record the reader marked is required - the
// caret asserts each one answers, and the judge's citations are the passages the
// answer rested on, all of them. Alternatives (one answer in two places) are the
// bank's shape, not the trace's: a trace lane that folded them together said 'any
// one of six passages answers it', which is not what either reader meant.
export function goldFor(trace) {
  const labels = trace.labels || {};
  const positives = (labels.positive || []).filter(x => typeof x === 'string' && x);
  if (positives.length) return { gold: positives.map(id => [id]), gold_how: 'caret' };
  if (typeof trace.answeredBy === 'string' && trace.answeredBy) return { gold: [[trace.answeredBy]], gold_how: 'caret' };
  if (trace.vote === 'up') {
    const cited = citedIds(trace);
    if (cited.length) return { gold: cited.map(id => [id]), gold_how: 'vote' };
  }
  const cited = citedIds(trace);
  if (cited.length) return { gold: cited.map(id => [id]), gold_how: 'judge' };
  return { gold: [], gold_how: '' };
}

// What the run showed and the reader rejected: the x marks first, then the rest of
// the shown findings, gold excluded. The hard negatives an embedder needs.
export function negativesFor(trace, goldIds, live) {
  const seen = new Set(goldIds);
  const ids = [], missing = [];
  const push = id => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    if (live.has(id)) ids.push(id); else missing.push(id);
  };
  for (const id of (trace.labels && trace.labels.negative) || []) push(id);
  for (const f of trace.findings || []) push(f.id);
  return { negatives: ids, missing };
}

// One record per trace, schema for schema.
export function traceRecord(trace, live) {
  const label = goldFor(trace);
  const resolved = resolveGroups(label.gold, live);
  const goldIds = [];
  for (const g of resolved.groups) for (const id of g) goldIds.push(id);
  const neg = negativesFor(trace, goldIds, live);
  const record = {
    id: 'trace/' + String(trace.id || ''),
    q: String(trace.question || ''),
    lang: trace.lang === 'fr' ? 'fr' : 'en',
    translation: (trace.asked && String(trace.asked).trim() && String(trace.asked).trim() !== String(trace.question || '').trim()) ? String(trace.asked) : null,
    answer: (trace.answer && String(trace.answer).trim()) ? String(trace.answer) : null,
    gold: resolved.groups,
    gold_how: resolved.groups.length ? label.gold_how : '',
    negatives: neg.negatives,
    source: 'trace',
    at: trace.at || null,
    split: 'train',
  };
  return {
    record,
    meta: {
      label_how: label.gold_how,
      gold_before: label.gold.reduce((n, g) => n + g.length, 0),
      gold_missing: resolved.missing,
      gold_groups_before: label.gold.length,
      gold_groups_after: resolved.groups.length,
      negatives_missing: neg.missing,
      shown: (trace.findings || []).length,
    },
  };
}

// The bank, through the same schema: the eval split, manual labels, no answer and
// no translation (it was authored, not asked).
export function bankRecord(entry, live) {
  const resolved = resolveGroups(expectGroups(entry.expect), live);
  const goldIds = [];
  for (const g of resolved.groups) for (const id of g) goldIds.push(id);
  return {
    record: {
      id: 'bank/' + sha8(entry.q),
      q: String(entry.q || ''),
      lang: 'en',
      translation: null,
      answer: null,
      gold: resolved.groups,
      gold_how: resolved.groups.length ? 'manual' : '',
      negatives: [],
      source: 'bank',
      at: null,
      split: 'eval',
    },
    meta: {
      label_how: 'manual',
      gold_before: expectGroups(entry.expect).reduce((n, g) => n + g.length, 0),
      gold_missing: resolved.missing,
      gold_groups_before: expectGroups(entry.expect).length,
      gold_groups_after: resolved.groups.length,
      negatives_missing: [],
      shown: 0,
    },
  };
}

// --- the build ---------------------------------------------------------------
export function buildDataset(traces, bank, live) {
  const records = [], metas = [];
  for (const t of traces) { const r = traceRecord(t, live); records.push(r.record); metas.push(r.meta); }
  for (const e of bank) { const r = bankRecord(e, live); records.push(r.record); metas.push(r.meta); }
  const stats = {
    traces: traces.length,
    bank: bank.length,
    records: records.length,
    by_split: {},
    by_source: {},
    by_gold_how: {},
    with_gold: 0,
    query_only: 0,
    with_gold_by_split: {},
    query_only_by_split: {},
    negatives: 0,
    records_with_negatives: 0,
    ids_checked: 0,
    ids_missing: 0,
    records_with_missing: 0,
    gold_groups_before: 0,
    gold_groups_after: 0,
    gold_lost_records: 0,
    missing_by_source: {},
  };
  records.forEach((rec, i) => {
    const meta = metas[i];
    const bump = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };
    bump(stats.by_split, rec.split);
    bump(stats.by_source, rec.source);
    bump(stats.by_gold_how, rec.gold_how || 'none');
    if (rec.gold.length) { stats.with_gold++; bump(stats.with_gold_by_split, rec.split); }
    else { stats.query_only++; bump(stats.query_only_by_split, rec.split); }
    stats.negatives += rec.negatives.length;
    if (rec.negatives.length) stats.records_with_negatives++;
    const missing = (meta.gold_missing || []).concat(meta.negatives_missing || []);
    stats.ids_checked += meta.gold_before + rec.negatives.length + missing.length;
    stats.ids_missing += missing.length;
    if (missing.length) {
      stats.records_with_missing++;
      stats.missing_by_source[rec.source] = (stats.missing_by_source[rec.source] || 0) + missing.length;
    }
    stats.gold_groups_before += meta.gold_groups_before;
    stats.gold_groups_after += meta.gold_groups_after;
    if (meta.gold_groups_before > 0 && meta.gold_groups_after === 0) stats.gold_lost_records++;
  });
  return { records, metas, stats };
}

// --- the page's own retrieval on the real questions --------------------------
// The same call the page makes: retrieveDual with the trace's own mode, on the
// English it actually searched, with the terms the translator produced. Gold is
// the trace's gold; a rank is the best rank of any member of any group.
// Where the gold sits in a ranked list. 'rank' is the best rank of any required
// record - the bank's hit@k reading; 'rank_all' is the rank at which EVERY group
// is satisfied, which is what a reader would call answered.
export function scoreRanks(gold, ids) {
  const rankOf = group => {
    for (let i = 0; i < ids.length; i++) if (group.indexOf(ids[i]) !== -1) return i + 1;
    return null;
  };
  const groupRanks = (gold || []).map(rankOf);
  const found = groupRanks.filter(r => r !== null);
  return {
    rank: found.length ? Math.min(...found) : null,
    rank_all: groupRanks.length && groupRanks.every(r => r !== null) ? Math.max(...groupRanks) : null,
  };
}

export async function measureRetrieval(records, traces, opts) {
  const o = opts || {};
  const rulesCorpus = o.rulesCorpus || readAllCorpus('rules');
  const factionsCorpus = o.factionsCorpus || readAllCorpus('factions');
  const byId = new Map((traces || []).map(t => ['trace/' + t.id, t]));
  const rows = [];
  for (const rec of records) {
    if (!rec.gold.length) continue;
    const trace = byId.get(rec.id);
    // The bank was authored, not asked: no trace, no translator terms and no
    // fast/deep choice - the default mode, which is what the page uses for an
    // English question.
    const mode = ASK_MODES[askMode(trace && trace.mode)];
    const q = (trace && trace.asked) ? trace.asked : rec.q;
    const terms = (trace && Array.isArray(trace.terms)) ? trace.terms : [];
    let rank = null, rankAll = null, error = '';
    try {
      const dual = await retrieveDual(q, {
        rulesCorpus, factionsCorpus, jevKey: o.jevKey, terms,
        grepNet: mode.grepNet, jevMax: mode.jevMax,
        perSide: { rules: mode.first, factions: mode.first },
      });
      const ids = (dual.all || []).map((s, i) => findingFor(s, i + 1).id);
      // Two readings, because the gold groups are now strict: the BEST rank of any
      const scored = scoreRanks(rec.gold, ids);
      rank = scored.rank;
      rankAll = scored.rank_all;
    } catch (e) { error = String((e && e.message) || e); }
    rows.push({ id: rec.id, q: rec.q, asked: q, gold_how: rec.gold_how, split: rec.split, groups: rec.gold.length, rank, rank_all: rankAll, error });
    if (o.onRow) o.onRow(rows[rows.length - 1]);
  }
  return rows;
}

export function rankStats(rows) {
  const graded = rows.filter(r => !r.error);
  const at = (k, key) => graded.filter(r => r[key] != null && r[key] <= k).length;
  const mrr = graded.length ? graded.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / graded.length : 0;
  return {
    n: graded.length,
    hit1: at(1, 'rank'), hit5: at(5, 'rank'), hit20: at(20, 'rank'),
    all1: at(1, 'rank_all'), all5: at(5, 'rank_all'), all20: at(20, 'rank_all'),
    found: graded.filter(r => r.rank != null).length,
    all: graded.filter(r => r.rank_all != null).length,
    mrr,
  };
}

function pct(a, b) { return b ? (100 * a / b).toFixed(1) + '%' : '-'; }

// --- main --------------------------------------------------------------------
async function main() {
  const dir = path.resolve(flag('dir', TRACES_DIR));
  const out = path.resolve(flag('out', path.join(ROOT, 'workspace', 'dataset', 'dataset.jsonl')));
  const bankFile = path.resolve(flag('bank', path.join(ROOT, 'tests', 'fixtures', 'rules-questions.json')));
  const manifestFile = path.resolve(flag('manifest', path.join(path.dirname(out), 'manifest.json')));
  if (flag('retrieval', null) !== null) return retrievalMain(out, dir);
  const live = new Set(readAllCorpus().map(r => r.id));
  const traces = loadTraces(dir);
  const bank = loadBank(bankFile);
  const { records, stats } = buildDataset(traces, bank, live);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(manifestFile, JSON.stringify({ at: new Date().toISOString(), dir, bank: bankFile, stats }, null, 1));
  console.log('dataset -> ' + out);
  console.log('  records           ' + stats.records + '  (traces ' + stats.traces + ', bank ' + stats.bank + ')');
  console.log('  split             ' + JSON.stringify(stats.by_split));
  console.log('  source            ' + JSON.stringify(stats.by_source));
  console.log('  with gold         ' + stats.with_gold + '   query-only ' + stats.query_only);
  console.log('  with gold / split ' + JSON.stringify(stats.with_gold_by_split) + '   query-only ' + JSON.stringify(stats.query_only_by_split));
  console.log('  gold_how          ' + JSON.stringify(stats.by_gold_how));
  console.log('  negatives         ' + stats.negatives + ' ids over ' + stats.records_with_negatives + ' records');
  console.log('  gold groups       ' + stats.gold_groups_before + ' -> ' + stats.gold_groups_after + '   gold lost to resolution ' + stats.gold_lost_records);
  console.log('  corpus resolution ' + stats.ids_missing + ' missing of ' + stats.ids_checked + ' ids, in ' + stats.records_with_missing + ' records' + (Object.keys(stats.missing_by_source).length ? '  ' + JSON.stringify(stats.missing_by_source) : ''));
  console.log('  manifest          ' + manifestFile);
}

async function retrievalMain(datasetFile, dir) {
  const live = new Set(readAllCorpus().map(r => r.id));
  const traces = loadTraces(dir);
  // Every record with gold: the traces (the real questions) and the bank (the
  // authored eval split), through the identical call - the comparison the report
  // turns on. A bank record has no trace, so it takes the page's default mode and
  // no translator terms, which is what the page does for an English question.
  const records = fs.readFileSync(datasetFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.gold.length);
  const outFile = path.join(path.dirname(datasetFile), 'retrieval.json');
  // Written after every question: a long arm must survive an interrupted process.
  const rows = [];
  await measureRetrieval(records, traces, {
    jevKey: credential(jevKeyName()),
    onRow: r => {
      rows.push(r);
      fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), partial: true, rows }, null, 1));
    },
  });
  const reader = rows.filter(r => r.split === 'train' && (r.gold_how === 'caret' || r.gold_how === 'vote'));
  const judge = rows.filter(r => r.gold_how === 'judge');
  const bankRows = rows.filter(r => r.split === 'eval');
  for (const row of rows) console.log('  ' + (row.rank ? '#' + row.rank : '  -') + ' all:' + (row.rank_all ? '#' + row.rank_all : '-') + '  groups ' + row.groups + '  ' + (row.gold_how || '-').padEnd(6) + '  ' + row.q.slice(0, 52) + (row.error ? '  ERROR ' + row.error : ''));
  for (const [name, set] of [['reader gold (caret/vote)', reader], ['judge gold (circular)', judge], ['all trace gold', rows.filter(r => r.split === 'train')], ['bank eval (authored)', bankRows]]) {
    const s = rankStats(set);
    console.log(name + ': n ' + s.n + '  [any] hit@1 ' + s.hit1 + ' (' + pct(s.hit1, s.n) + ')  hit@5 ' + s.hit5 + '  hit@20 ' + s.hit20 + '  found ' + s.found + '  MRR ' + s.mrr.toFixed(3)
      + '   [every group] @1 ' + s.all1 + ' @5 ' + s.all5 + ' @20 ' + s.all20 + ' (' + pct(s.all20, s.n) + ')  all found ' + s.all);
  }
  fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), rows, stats: { reader: rankStats(reader), judge: rankStats(judge), all: rankStats(rows.filter(r => r.split === 'train')), bank: rankStats(bankRows) } }, null, 1));
  console.log('retrieval -> ' + outFile);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(e => { console.error(String((e && e.stack) || e)); process.exitCode = 1; });
}
