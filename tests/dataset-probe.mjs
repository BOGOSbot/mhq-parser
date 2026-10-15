import { readAllCorpus } from '../src/rules-corpus.mjs';
import { readTraces, titleCandidates, labelVote, labelOf } from '../src/dataset.mjs';

// The two gold-rule approaches measured and rejected for the title tier. This is
// the tracked script the comment in src/dataset.mjs cites: run it before
// proposing either of them again. Both are implemented here as they were tried,
// so their numbers can be re-measured rather than quoted.
//
//   1. NAIVE LEAF-TITLE: every corpus heading leaf, matched case-insensitively in
//      the answer. No ruleId filter, no suffix stripping, no sibling collapse.
//      It fires on generic structural headings ('Movement Phase', 'Engagement')
//      and labels the same answer many times.
//   2. 6-GRAM SHINGLE OVERLAP: the answer's word 6-grams against each record's
//      text, keeping records above a tiny overlap threshold. The coverage is so
//      thin that most questions either match nothing or match noise.
//
// The accepted tier (labelTitle) requires a ruleId, strips the leaf suffix,
// collapses siblings and matches case-sensitively.
const corpus = readAllCorpus();
const traces = readTraces();
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\u00e0-\u00ff]+/g, ' ').replace(/\s+/g, ' ').trim();
const toks = s => norm(s).split(' ').filter(Boolean);
const shingles = (s, n) => { const t = toks(s); const out = new Set(); for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(' ')); return out; };

const leaves = [];
for (const r of corpus) {
  const leaf = String(r.heading || '').split(' > ').pop().trim();
  if (leaf && leaf.length >= 6) leaves.push(leaf);
}
const accepted = titleCandidates(corpus);

function naiveLeaf(answer) {
  const text = String(answer || '').toLowerCase();
  const ids = [];
  for (const r of corpus) {
    const leaf = String(r.heading || '').split(' > ').pop().trim();
    if (leaf.length >= 6 && text.indexOf(leaf.toLowerCase()) !== -1) ids.push(r.id);
  }
  return ids.length ? ids : null;
}
function shingleOverlap(answer) {
  const a = shingles(answer, 6);
  if (!a.size) return null;
  const ids = [];
  for (const r of corpus) {
    const b = shingles(r.text || '', 6);
    if (!b.size) continue;
    let hit = 0;
    for (const s of b) if (a.has(s)) hit += 1;
    if (hit / b.size >= 0.02 && hit / b.size <= 0.03) ids.push(r.id);
  }
  return ids.length ? ids : null;
}

const tiers = { naiveLeaf: 0, shingle: 0, accepted: 0, none: 0 };
const distinct = new Map();
for (const t of traces) {
  const n = naiveLeaf(t.answer), s = shingleOverlap(t.answer), a = labelOf(t, accepted);
  if (n) tiers.naiveLeaf += 1;
  if (s) tiers.shingle += 1;
  if (a) tiers.accepted += 1;
  if (!n && !s && !a) tiers.none += 1;
  const k = norm(t.question);
  const best = a ? 'accepted' : (n ? 'naiveLeaf' : (s ? 'shingle' : 'none'));
  if (!distinct.has(k) || distinct.get(k) === 'none') distinct.set(k, best);
}
const distinctTiers = { accepted: 0, naiveLeaf: 0, shingle: 0, none: 0 };
for (const v of distinct.values()) distinctTiers[v] += 1;
console.log(JSON.stringify({
  traces: traces.length,
  distinctQuestions: distinct.size,
  candidates: { naiveLeaf: leaves.length, accepted: accepted.size },
  traceLevel: tiers,
  distinctLevel: distinctTiers,
}, null, 2));
