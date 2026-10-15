import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus } from './rules-corpus.mjs';

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
//   vote  - the reader's own pick ('This one answers it'), already perfect;
//   title - rule names the answerer writes, matched against the corpus with the
//           leaf suffix stripped and sibling records collapsed into one group;
//   judge - the passages the answer cites, high recall but CIRCULAR (it can only
//           cite what the retriever showed it), so it is marked and never eval;
//   manual - a human wrote it (the bank's curation).
// Do NOT revive the two measured-and-rejected approaches: naive leaf-title
// matching (20/68, false hits) and 6-gram shingle overlap (26/68 at 2-3%
// coverage). They are recorded in workspace/dataset-probe*.tmp.mjs.
export const SCHEMA_KEYS = ['id', 'q', 'answer', 'gold', 'how', 'edition', 'date', 'source', 'url', 'split'];
export const HOW = ['vote', 'title', 'judge', 'manual'];
export const SPLITS = ['train', 'eval'];

export function questionRecord(o) {
  return {
    id: String(o.id || ''),
    q: String(o.q || ''),
    answer: o.answer == null ? '' : String(o.answer),
    gold: Array.isArray(o.gold) ? o.gold.map(g => (Array.isArray(g) ? g.slice() : [String(g)])) : [],
    how: HOW.indexOf(o.how) !== -1 ? o.how : '',
    edition: String(o.edition || ''),
    date: String(o.date || ''),
    source: String(o.source || ''),
    url: String(o.url || ''),
    split: SPLITS.indexOf(o.split) !== -1 ? o.split : 'train',
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
  if (r.split === 'eval' && r.how === 'judge') problems.push('a judge label cannot be eval');
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
    // measured difference: naive leaf matching fires on 77 of 113 answers with a
    // median of 5 groups; this fires on 50 with a median of 2.
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

export function yieldReport(traces, corpus) {
  const candidates = titleCandidates(corpus);
  const tiers = { vote: 0, title: 0, judge: 0, none: 0 };
  const titleGroups = [];
  const hows = {};
  for (const t of traces) {
    const v = labelVote(t);
    const ti = v ? null : labelTitle(t.answer, candidates);
    const j = (v || ti) ? null : labelJudge(t);
    const label = v || ti || j;
    if (!label) tiers.none += 1;
    else tiers[label.how] += 1;
    if (ti) titleGroups.push(ti.gold.length);
    hows[t.how || '?'] = (hows[t.how || '?'] || 0) + 1;
  }
  return { total: traces.length, tiers, titleGroups, candidates: candidates.size, modes: hows };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'dataset.mjs') {
  const corpus = readAllCorpus();
  const traces = readTraces();
  const r = yieldReport(traces, corpus);
  console.log(JSON.stringify({ traces: r.total, titleCandidates: r.candidates, yield: r.tiers, titleLabelGroups: r.titleGroups.length, modes: r.modes }, null, 2));
}
