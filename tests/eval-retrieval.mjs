#!/usr/bin/env node
'use strict';
/**
 * Retrieval accuracy for the /rules corpus.
 *
 *   node tests/eval-retrieval.mjs [--topk 20] [--kind player] [--verbose]
 *   node tests/eval-retrieval.mjs --retriever dual --per-side 10    # the page's own path
 *
 * Measures whether the sections that answer a question are actually the ones
 * the index returns. This is the number that decides whether the page needs a
 * second retrieval pass, a query rewriter, or nothing at all - so it is
 * measured before any of those are built, not after.
 *
 * What is graded:
 *   hit@k   at least one expected section is in the top k
 *   full    every expected section is (multi-hop questions only)
 *   MRR     mean of 1/rank of the first expected section
 *
 * Out-of-corpus questions carry no expected section - the answer is faction
 * data this corpus does not hold. They are reported with what was returned
 * instead, because "declines honestly" is a behaviour worth watching, and a
 * hit-rate over an empty expectation would be a number that means nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandQuery, grepCorpus, grepTerms, grepWithTerms, jevRank, queryIndex, readAllCorpus, retrieveDual, retrieveWide } from '../src/rules-corpus.mjs';
import { credential, fastCredential, jevKeyName } from '../src/rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUESTIONS = path.join(__dirname, 'fixtures', 'rules-questions.json');

const argv = process.argv.slice(2);
const flag = n => argv.indexOf(n) !== -1;
const value = n => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const TOPK = parseInt(value('--topk') || '20', 10);
const ONLY_KIND = value('--kind');
const VERBOSE = flag('--verbose');
// vector       the Upstash index
// grep         terms over the corpus on disk, no embedder, no network
// grep+jev     the same net, reranked by Jev
// grep+expand  the question rewritten into rulebook terms first, then grep+jev
// union        vector and grep merged by rank fusion, then Jev
// union+expand the same, with the rewritten terms on the grep side
// dual         the page's own two-half path: per half, vector + grep, Jev, the
//              anchors and the children, then both halves concatenated. This is
//              the arm whose numbers describe what the reader is actually shown.
const RETRIEVER = value('--retriever') || 'vector';
const NET = parseInt(value('--net') || '40', 10);
const PER_SIDE = parseInt(value('--per-side') || '10', 10);
const NEEDS_CORPUS = RETRIEVER !== 'vector';
const CORPUS = NEEDS_CORPUS && RETRIEVER !== 'dual' ? readAllCorpus() : null;
const RULES_CORPUS = RETRIEVER === 'dual' ? readAllCorpus('rules') : null;
const FACTIONS_CORPUS = RETRIEVER === 'dual' ? readAllCorpus('factions') : null;
const JEV_KEY = credential(jevKeyName());
const SENSE_KEY = fastCredential();
const asHits = list => list.map(s => ({ id: s.id, metadata: s, score: s.jev !== undefined ? s.jev : s.score }));

async function retrieve(question) {
  if (RETRIEVER === 'vector') return queryIndex(question, { topK: TOPK });
  if (RETRIEVER === 'dual') {
    const dual = await retrieveDual(question, {
      rulesCorpus: RULES_CORPUS, factionsCorpus: FACTIONS_CORPUS, jevKey: JEV_KEY,
      terms: [], grepNet: NET, jevMax: Math.max(NET, PER_SIDE + 70),
      perSide: { rules: PER_SIDE, factions: PER_SIDE },
    });
    return asHits(dual.all);
  }
  if (RETRIEVER === 'grep') return asHits(grepCorpus(question, CORPUS, NET).slice(0, TOPK));
  if (RETRIEVER === 'grep+jev') return asHits(await jevRank(question, grepCorpus(question, CORPUS, NET), JEV_KEY, { max: NET })).slice(0, TOPK);
  if (RETRIEVER === 'grep+expand') {
    const terms = await expandQuery(question, SENSE_KEY);
    const net = terms.length
      ? grepWithTerms(terms.concat(grepTerms(question)), CORPUS, NET, question)
      : grepCorpus(question, CORPUS, NET);
    return asHits(await jevRank(question, net, JEV_KEY, { max: NET })).slice(0, TOPK);
  }
  const terms = RETRIEVER === 'union+expand' ? await expandQuery(question, SENSE_KEY) : null;
  return asHits(await retrieveWide(question, { corpus: CORPUS, jevKey: JEV_KEY, terms, grepNet: NET, jevMax: NET, topK: TOPK }));
}

const bank = JSON.parse(fs.readFileSync(QUESTIONS, 'utf8'));
const questions = bank.questions.filter(q => !ONLY_KIND || q.kind === ONLY_KIND);

function rankOf(hits, expect) {
  const ids = hits.map(h => h.id);
  let best = null;
  for (const e of expect) {
    const i = ids.indexOf(e);
    if (i !== -1 && (best === null || i < best)) best = i;
  }
  return best === null ? null : best + 1;
}

const rows = [];
for (const item of questions) {
  const hits = await retrieve(item.q);
  const rank = item.expect.length ? rankOf(hits, item.expect) : null;
  const found = item.expect.filter(e => hits.some(h => h.id === e));
  rows.push({
    q: item.q,
    kind: item.kind,
    expect: item.expect,
    rank,
    found: found.length,
    needed: item.expect.length,
    top: hits.slice(0, 3).map(h => ({ id: h.id, heading: h.metadata && h.metadata.heading, score: h.score })),
  });
  if (VERBOSE) {
    console.log('  ' + (rank ? '#' + rank : '  -') + '  [' + item.kind + '] ' + item.q);
    for (const t of rows[rows.length - 1].top) console.log('        ' + t.score.toFixed(4) + '  ' + t.heading + '  (' + t.id + ')');
  }
}

const graded = rows.filter(r => r.needed > 0);
const declined = rows.filter(r => r.needed === 0);

function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : 0; }
function at(k) { return graded.filter(r => r.rank !== null && r.rank <= k).length; }

console.log('');
console.log('retriever ' + RETRIEVER + '  |  questions ' + rows.length + '  (graded ' + graded.length + ', out-of-corpus ' + declined.length + ')  topK ' + TOPK + (RETRIEVER === 'vector' ? '' : '  net ' + NET) + (RETRIEVER === 'dual' ? '  per-side ' + PER_SIDE : ''));
console.log('hit@1   ' + at(1) + '/' + graded.length + '  ' + pct(at(1), graded.length) + '%');
console.log('hit@5   ' + at(5) + '/' + graded.length + '  ' + pct(at(5), graded.length) + '%');
console.log('hit@10  ' + at(10) + '/' + graded.length + '  ' + pct(at(10), graded.length) + '%');
console.log('hit@' + TOPK + '  ' + at(TOPK) + '/' + graded.length + '  ' + pct(at(TOPK), graded.length) + '%');
const mrr = graded.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / (graded.length || 1);
console.log('MRR     ' + Math.round(mrr * 1000) / 1000);
const multi = graded.filter(r => r.needed > 1);
console.log('multi-hop fully found  ' + multi.filter(r => r.found === r.needed).length + '/' + multi.length);

const byKind = {};
for (const r of graded) {
  const b = byKind[r.kind] || (byKind[r.kind] = { n: 0, h1: 0, h5: 0, hk: 0, mrr: 0 });
  b.n++;
  if (r.rank === 1) b.h1++;
  if (r.rank !== null && r.rank <= 5) b.h5++;
  if (r.rank !== null) b.hk++;
  b.mrr += r.rank ? 1 / r.rank : 0;
}
console.log('\nby kind');
for (const k of Object.keys(byKind)) {
  const b = byKind[k];
  console.log('  ' + k.padEnd(15) + ' n=' + String(b.n).padStart(2) + '  hit@1 ' + pct(b.h1, b.n) + '%  hit@5 ' + pct(b.h5, b.n) + '%  found ' + pct(b.hk, b.n) + '%  MRR ' + (Math.round((b.mrr / b.n) * 1000) / 1000));
}

console.log('\nmisses (nothing expected in the top ' + TOPK + ')');
for (const r of graded.filter(x => x.rank === null)) {
  console.log('  [' + r.kind + '] ' + r.q);
  console.log('      expected: ' + r.expect.join(', '));
  console.log('      got     : ' + r.top.map(t => (t.metadata && t.metadata.heading) || t.id).join(' | '));
}

console.log('\nout-of-corpus (expected to be declined, not answered)');
for (const r of declined) {
  console.log('  ' + r.q);
  console.log('      returned: ' + r.top.map(t => (t.metadata && t.metadata.heading) || t.id).join(' | '));
}
