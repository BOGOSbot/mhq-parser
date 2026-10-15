import { loadTraces } from './promote-traces.mjs';

// task-60: the free learned reranker, as a measurement only. A logistic
// regression over features computed locally from candidates we already retrieved.
//
// LABELS come from what we hold: a trace's judge citations are positives and the
// other shown findings are negatives; a reader caret/x wins when present. That is
// circular for evaluation (the judge cited what the retriever showed it) and fine
// for TRAINING, which is the only thing it is used for here.
//
// FEATURES are lexical and rank-based, so the experiment makes no model call and
// no extra embedding call: BM25 of the question's terms against the candidate,
// term overlap in its text and its title, the retriever's own score, the
// candidate's rank, a source flag and a length flag.
//
// This module is deliberately test-side: nothing in the page or the server
// imports it.

export const FEATURE_NAMES = ['bias', 'bm25', 'overlapText', 'overlapTitle', 'retrieverScore', 'invRank', 'coreRules', 'factions', 'longText'];

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'can', 'do', 'does', 'my', 'i', 'it', 'that', 'this', 'with', 'at', 'be', 'if', 'when', 'how', 'what', 'which', 'unit', 'units', 'model', 'models']);
export function terms(q) {
  return String(q || '').toLowerCase().replace(/[^a-z0-9\u00e0-\u00ff]+/g, ' ').split(' ').filter(t => t.length > 1 && !STOP.has(t));
}

// BM25 over the corpus as the document set, k1=1.2, b=0.75.
export function buildBm25(corpus) {
  const docs = corpus.map(r => terms((r.heading || '') + ' ' + (r.text || '')));
  const df = new Map();
  let total = 0;
  for (const d of docs) { total += d.length; for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1); }
  return { docs, df, avg: docs.length ? total / docs.length : 1, N: docs.length };
}
export function bm25(b, queryTerms) {
  const k1 = 1.2, bq = 0.75;
  return b.docs.map(d => {
    const len = d.length || 1;
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of queryTerms) {
      const f = tf.get(t);
      if (!f) continue;
      const n = b.df.get(t) || 0;
      s += Math.log(1 + (b.N - n + 0.5) / (n + 0.5)) * (f * (k1 + 1)) / (f + k1 * (1 - bq + bq * (len / b.avg)));
    }
    return s;
  });
}

export function features(question, hit, bm25Score, rank) {
  const meta = (hit && hit.metadata) || {};
  const text = String(meta.text || '').toLowerCase();
  const title = String(meta.heading || '').toLowerCase();
  const q = terms(question);
  const score = Number(hit && hit.score);
  return [
    1,
    bm25Score || 0,
    q.filter(t => text.indexOf(t) !== -1).length / (q.length || 1),
    q.filter(t => title.indexOf(t) !== -1).length / (q.length || 1),
    Number.isFinite(score) ? score : 0,
    1 / (rank + 1),
    String(meta.source || '') === 'core-rules' ? 1 : 0,
    String(meta.source || '').indexOf('faction') === 0 ? 1 : 0,
    text.length > 400 ? 1 : 0,
  ];
}

// One BM25 index for the corpus, one featurizer for every question. The hits are
// annotated in place with __x, so the trainer and the harness use the same
// features by construction.
export function makeFeatures(corpusList) {
  const b = buildBm25(corpusList);
  const scoreById = new Map();
  return function featurize(question, hits) {
    const q = terms(question);
    const bm = bm25(b, q);
    corpusList.forEach((r, i) => scoreById.set(r.id, bm[i]));
    return hits.map((h, rank) => {
      const meta = h.metadata || h;
      const id = h.id || meta.id;
      return Object.assign({}, h, { __x: features(question, h, scoreById.get(id) || 0, rank) });
    });
  };
}

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
export function train(examples, opts) {
  const o = opts || {};
  const epochs = o.epochs || 500, lr = o.lr || 0.7, l2 = o.l2 || 0.001;
  const dim = FEATURE_NAMES.length;
  const w = new Array(dim).fill(0);
  if (!examples.length) return w;
  for (let e = 0; e < epochs; e++) {
    const g = new Array(dim).fill(0);
    for (const ex of examples) {
      const p = sigmoid(ex.x.reduce((s, v, i) => s + v * w[i], 0));
      const err = p - ex.y;
      for (let i = 0; i < dim; i++) g[i] += err * ex.x[i];
    }
    for (let i = 0; i < dim; i++) w[i] -= lr * (g[i] / examples.length + l2 * w[i]);
  }
  return w;
}
export function score(w, x) { return x.reduce((s, v, i) => s + v * w[i], 0); }

// The training examples from the traces, using the SAME featurizer as eval.
export function trainingExamples(traces, featurize, byId) {
  const ex = [];
  let positives = 0;
  for (const t of traces) {
    const findings = (t.findings || []).filter(f => f && f.id && byId.has(f.id));
    if (!findings.length) continue;
    const cited = new Set([].concat((t.judge && t.judge.cited) || [], (t.labels && t.labels.positive) || []));
    // The answer's [n] markers are the other citation source we hold, and with the
    // writer off they are the ONLY positives in the store: no markers, no label.
    for (const m of String(t.answer || '').matchAll(/\[(\d+)\]/g)) {
      const f = findings.find(x => String(x.n) === m[1]);
      if (f) cited.add(f.id);
    }
    const neg = new Set((t.labels && t.labels.negative) || []);
    const rows = featurize(t.question, findings.map(f => ({ id: f.id, metadata: byId.get(f.id), score: 0 })));
    for (const h of rows) {
      if (neg.has(h.id)) continue;
      const y = cited.has(h.id) ? 1 : 0;
      if (y) positives++;
      ex.push({ x: h.__x, y });
    }
  }
  return { examples: ex, positives };
}

export function rerankWith(w, hits) {
  return hits
    .map((h, i) => ({ h, i, s: score(w, h.__x) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map(x => x.h);
}

export { loadTraces };
