import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, writerEnabled } from './rules-corpus.mjs';

// The heading's own leaf, the name a reader would recognise.
function leafOf(heading) {
  const segs = String(heading || '').split(' > ');
  return String(segs[segs.length - 1] || '').trim();
}

// ONE schema for every harvested question (task-32). The answer is a FIELD, never
// the label; the label is gold: groups of rule ids where ANY member satisfies the
// question - the bank's own expect shape, so the bank is the curated EVAL split of
// this same schema and harvested data is the TRAIN split.
//
//   { id, q, answer, gold, how, edition, date, source, url, split, verifier }
//
// how is the labeller that made the gold, in precision order:
//   vote      - the reader's own pick ('This one answers it'), already perfect;
//   title     - rule names the answerer writes, matched against the corpus with
//               the leaf suffix stripped and siblings collapsed into one group;
//   judge     - the passages the answer cites, high recall but CIRCULAR (it can
//               only cite what the retriever showed it), so it is marked and
//               never used for eval;
//   generated - the question was written FROM the record, so the gold is true by
//               construction and non-circular; train-only, never eval;
//   manual    - a human wrote it (the bank's curation).
// Two approaches were measured and rejected and must not be revived: naive
// leaf-title matching (fires on generic structural headings) and 6-gram shingle
// overlap (coverage too thin to be a label). tests/dataset-probe.mjs is the
// tracked script that reproduces both on the traces we hold; run it before
// proposing either again.
// negatives are the findings the page SHOWED and the reader did not pick - mined
// hard negatives, the records closest to the answer that are not it. asks is the
// number of traces behind one normalized question: a question asked six times is
// one datapoint with asks 6, never six datapoints.
export const SCHEMA_KEYS = ['id', 'q', 'answer', 'gold', 'negatives', 'how', 'edition', 'date', 'source', 'url', 'split', 'asks'];
export const HOW = ['vote', 'title', 'judge', 'generated', 'manual'];
// Tiers that are train-only: a judge label is circular, a generated label is true
// by construction because the question was written from the record. Neither may
// be used to score us.
export const TRAIN_ONLY_HOW = ['judge', 'generated'];
export const SPLITS = ['train', 'eval'];

export function questionRecord(o) {
  return {
    id: String(o.id || ''),
    q: String(o.q || ''),
    answer: o.answer == null ? '' : String(o.answer),
    gold: Array.isArray(o.gold) ? o.gold.map(g => (Array.isArray(g) ? g.slice() : [String(g)])) : [],
    negatives: Array.isArray(o.negatives) ? o.negatives.map(String) : [],
    how: HOW.indexOf(o.how) !== -1 ? o.how : '',
    edition: String(o.edition || ''),
    date: String(o.date || ''),
    source: String(o.source || ''),
    url: String(o.url || ''),
    split: SPLITS.indexOf(o.split) !== -1 ? o.split : 'train',
    asks: Math.max(1, Math.floor(Number(o.asks) || 1)),
    // Provenance for the tier, not part of the schema's identity: a judge label
    // can never be used for eval, and the record says so itself.
    verifier: o.verifier || null,
  };
}

export function validateRecord(r) {
  const problems = [];
  for (const k of SCHEMA_KEYS) if (!(k in r)) problems.push('missing ' + k);
  if (!r.q) problems.push('empty q');
  if (HOW.indexOf(r.how) === -1) problems.push('bad how');
  if (SPLITS.indexOf(r.split) === -1) problems.push('bad split');
  for (const g of r.gold) if (!g.length) problems.push('empty gold group');
  if (!(r.asks >= 1)) problems.push('asks must be at least 1');
  // A zero-positive row (a rejection) is a good train example and a nonsense eval
  // one: the bank's expect-of-groups cannot score 'nothing answers this', it would
  // pass trivially or never. Only a labelled gold can be eval.
  if (!r.gold.length && r.split === 'eval') problems.push('an empty-gold row cannot be eval');
  if (r.split === 'eval' && TRAIN_ONLY_HOW.indexOf(r.how) !== -1) problems.push('a ' + r.how + ' label cannot be eval');
  return problems;
}

// --- the labellers ------------------------------------------------------------
// 1. VOTE: the reader's own selection. The page writes labels.positive (the
// findings they say answer it) and labels.negative (the ones they say do not); a
// thumbs up/down is a rating, not a passage label, and is not gold.
export function labelVote(trace) {
  const l = (trace && trace.labels) || null;
  const pos = (l && Array.isArray(l.positive)) ? l.positive.filter(Boolean) : [];
  if (!pos.length) return null;
  return { gold: pos.map(id => [id]), how: 'vote', verifier: { by: 'reader', at: (trace && trace.at) || '', negative: (l.negative || []).slice() } };
}

// 2. TITLE: the rule names the answerer writes. A candidate is a corpus leaf
// title whose suffix is stripped ('Armour of Contempt (Imperial Agents)' becomes
// 'Armour of Contempt'); it must appear in the answer verbatim (case-insensitive)
// and be specific enough to be a name, not a generic word. Sibling records that
// share the stripped title collapse into ONE group, which is the bank's shape.
export function strippedTitle(heading) {
  return String(leafOf(heading) || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .replace(/\s*:\s.*$/, '')
    .trim();
}
export function titleCandidates(corpus) {
  const byTitle = new Map();
  for (const r of corpus) {
    // A named rule, not a structural chapter: requiring a ruleId is what keeps
    // 'Movement Phase' and 'Engagement' - headings a reader would never write as
    // the name of the rule that answers them - out of the candidate set. The
    // measured difference on the traces we hold (113 traces, 49 distinct
    // questions): naive leaf matching labels 77 traces with a median of 5 groups;
    // this labels 37 traces / 15 distinct questions. `node src/dataset.mjs` is
    // the printed truth.
    if (!r.ruleId) continue;
    const t = strippedTitle(r.heading);
    if (!t) continue;
    if (t.length < 10 && t.split(/\s+/).length < 2) continue;
    if (['abilities', 'keywords and abilities', 'core concepts'].indexOf(t.toLowerCase()) !== -1) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(r.id);
  }
  return byTitle;
}
export function labelTitle(answer, candidates) {
  const text = String(answer || '');
  if (!text) return null;
  const hits = [];
  for (const [title, ids] of candidates) {
    if (title.length < 6) continue;
    // The answerer writes a named rule as the corpus writes it ('Desperate
    // Escape test', 'Armour of Contempt'); lowercase prose ('in the movement
    // phase') is how it writes an ordinary noun. Case-sensitive matching is the
    // cheapest discriminator and it measurably halves the group count.
    if (text.indexOf(title) !== -1) hits.push({ title, ids });
  }
  if (!hits.length) return null;
  return { gold: hits.map(h => h.ids.slice()), how: 'title', verifier: { by: 'title-match', titles: hits.map(h => h.title) } };
}

// 3. JUDGE: the passages the answer itself cites. The answer's [n] markers map to
// the findings the retriever showed, so this is high recall and CIRCULAR - it can
// only cite what was already retrieved - and it is never eval.
export function labelJudge(trace) {
  const answer = String((trace && trace.answer) || '');
  const findings = (trace && trace.findings) || [];
  if (!answer) return null;
  const cited = [];
  const seen = new Set();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const f = findings.find(x => String(x.n) === m[1]);
    if (f && f.id && !seen.has(f.id)) { seen.add(f.id); cited.push(f.id); }
  }
  if (!cited.length) return null;
  return { gold: cited.map(id => [id]), how: 'judge', verifier: { by: 'answer-citations', circular: true, evalSafe: false } };
}

// The tier ladder, in precision order: the first tier that yields a label wins.
export function labelTrace(trace, candidates) {
  return labelVote(trace) || labelTitle(trace.answer, candidates) || labelJudge(trace);
}

// --- the two splits of the one schema ----------------------------------------
export function harvestRow(trace, candidates) {
  const label = labelTrace(trace, candidates);
  return questionRecord({
    id: 'trace/' + (trace.id || ''),
    q: trace.question || '',
    answer: trace.answer || '',
    gold: label ? label.gold : [],
    how: label ? label.how : '',
    edition: trace.edition || '',
    date: trace.at || '',
    source: 'trace',
    url: (trace.findings && trace.findings[0] && trace.findings[0].url) || '',
    split: 'train',
    verifier: label ? label.verifier : null,
  });
}
export function bankRow(row, index) {
  return questionRecord({
    id: 'bank/' + (index + 1),
    q: row.q || '',
    answer: row.answer || '',
    gold: row.expect || [],
    how: 'manual',
    edition: '11',
    date: '',
    source: 'bank',
    url: '',
    split: 'eval',
    verifier: { by: 'curated-bank', kind: row.kind || '' },
  });
}

// --- the seed slice: the reader's pick is the label ---------------------------
// The page already collects a labelled pair for free: the question, the rule the
// reader says answers it ('This one answers it'), the rest of the findings the
// page showed (mined hard negatives) and the answer that was written. No
// permission, no scraping; the volume grows with page usage. One normalized
// question is ONE record carrying its ask count - a question asked six times is
// one datapoint, not six (task-33's requirement, measured: 113 traces are 49
// distinct questions).
export function harvestFromTraces(traces) {
  const groups = new Map();
  for (const t of traces || []) {
    const k = normalizeQuestion(t.question);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = [];
  for (const [k, list] of groups) {
    const picked = list.find(t => t.labels && Array.isArray(t.labels.positive) && t.labels.positive.filter(Boolean).length);
    // A rejection is a real example too: the reader x-ed a shown passage, or
    // clicked 'None of these' on the whole list. It gets a ZERO-POSITIVE row -
    // empty gold, the rejected ids as negatives - because inventing a gold for it
    // would be a lie; the schema accepts empty gold already.
    const rejected = picked ? null : list.find(t => t.labels && Array.isArray(t.labels.negative) && t.labels.negative.filter(Boolean).length);
    if (!picked && !rejected) continue;
    const source = picked || rejected;
    const positives = picked ? picked.labels.positive.filter(Boolean) : [];
    const shown = (source.findings || []).map(f => f.id).filter(Boolean);
    const negatives = source.answeredNone === true ? shown : (source.labels.negative || []).filter(Boolean);
    out.push(questionRecord({
      id: 'harvest/' + k.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60),
      q: source.question,
      answer: source.answer || '',
      gold: positives.map(id => [id]),
      negatives: positives.length ? shown.filter(id => positives.indexOf(id) === -1) : negatives,
      how: 'vote',
      edition: source.edition || '',
      date: source.at || '',
      source: 'trace',
      url: '',
      split: 'train',
      asks: list.length,
      verifier: picked ? { by: 'reader', negative: (picked.labels.negative || []).slice() } : { by: 'reader', noneOfThese: true, rejected: negatives.slice() },
    }));
  }
  return out;
}

export function readTraces(dir) {
  const d = dir || path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'workspace', 'rules-traces');
  const out = [];
  for (const f of fs.readdirSync(d)) {
    if (!/\.ndjson$/.test(f)) continue;
    for (const line of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (e) { /* a torn last line */ }
    }
  }
  return out;
}

// The same question asked six times is ONE question. A yield counted per trace
// weights it six times and overstates the harvest - measured, 113 traces are 49
// distinct questions, so '37 of 113' is really '15 of 49'. Every report carries
// both: the trace-level yield (what the labellers did) and the distinct-level
// yield (what we would actually harvest), with the ask count recorded.
export function normalizeQuestion(q) {
  return String(q || '').toLowerCase().replace(/[^a-z0-9\u00e0-\u00ff]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function labelOf(trace, candidates) {
  const v = labelVote(trace);
  const ti = v ? null : labelTitle(trace.answer, candidates);
  const j = (v || ti) ? null : labelJudge(trace);
  return v || ti || j;
}

const REFUSAL = /\*\*I do not know/i;

export function yieldReport(traces, corpus) {
  const candidates = titleCandidates(corpus);
  const tiers = { vote: 0, title: 0, judge: 0, generated: 0, none: 0 };
  const titleGroups = [];
  for (const t of traces) {
    const label = labelOf(t, candidates);
    tiers[label ? label.how : 'none'] += 1;
    if (label && label.how === 'title') titleGroups.push(label.gold.length);
  }
  // Distinct level: the best label any of a question's traces got, so a duplicate
  // cannot inflate the count and a single good trace is not lost.
  const groups = new Map();
  for (const t of traces) {
    const k = normalizeQuestion(t.question);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const RANK = ['vote', 'title', 'judge', 'generated'];   // precision order
  const distinct = { vote: 0, title: 0, judge: 0, generated: 0, none: 0 };
  const asks = [];
  for (const list of groups.values()) {
    let best = null;
    for (const t of list) {
      const l = labelOf(t, candidates);
      if (l && (best === null || RANK.indexOf(l.how) < RANK.indexOf(best.how))) best = l;
    }
    distinct[best ? best.how : 'none'] += 1;
    asks.push(list.length);
  }
  // Why the none bucket is big. It is not the labellers: the title tier reads the
  // answer's prose and the judge tier reads its citations, and the writer is OFF by
  // default, so most none traces carry no answer text at all (while still carrying
  // findings a human could label).
  const none = traces.filter(t => !labelOf(t, candidates));
  const noneReasons = {
    emptyAnswer: none.filter(t => !String(t.answer || '').trim()).length,
    refusal: none.filter(t => REFUSAL.test(String(t.answer || ''))).length,
    withFindings: none.filter(t => (t.findings || []).length > 0).length,
  };
  const noneQuestions = [...groups.keys()].filter(k => groups.get(k).every(t => !labelOf(t, candidates)));
  const noAnswer = k => groups.get(k).every(t => !String(t.answer || '').trim());
  const hasFindings = k => groups.get(k).some(t => (t.findings || []).length > 0);
  const distinctNone = {
    questions: noneQuestions.length,
    noAnswerAnywhere: noneQuestions.filter(noAnswer).length,
    noAnswerAnywhereWithFindings: noneQuestions.filter(k => noAnswer(k) && hasFindings(k)).length,
    withFindings: noneQuestions.filter(hasFindings).length,
  };
  const dupes = [...groups.values()].map(l => l.length).filter(n => n > 1);
  return {
    total: traces.length, candidates: candidates.size, tiers, distinct, titleGroups, noneReasons, distinctNone,
    asks: { questions: groups.size, max: asks.length ? Math.max(...asks) : 0, duplicated: dupes.length, extraTraces: dupes.reduce((n, x) => n + (x - 1), 0) },
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'dataset.mjs') {
  const corpus = readAllCorpus();
  const traces = readTraces();
  const r = yieldReport(traces, corpus);
  console.log(JSON.stringify({
    traces: r.total,
    distinctQuestions: r.asks.questions,
    titleCandidates: r.candidates,
    yieldTraceLevel: r.tiers,
    yieldDistinctLevel: r.distinct,
    titleLabelGroups: r.titleGroups.length,
    duplicateAsks: { duplicatedQuestions: r.asks.duplicated, extraTraces: r.asks.extraTraces, maxAskCount: r.asks.max },
    noneBecause: r.noneReasons,
    distinctNone: r.distinctNone,
    // The cause behind the none bucket: with the writer off there is no prose for
    // the title tier and no citations for the judge tier, so findings alone cannot
    // be labelled. This is a one-line default, not a labeller limit.
    writerEnabledByDefault: writerEnabled(undefined, undefined),
  }, null, 2));
}
