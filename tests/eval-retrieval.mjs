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
import { anchorFor, credential, fastCredential, jevKeyName } from '../src/rules.mjs';

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
// The index holds one namespace per half. Queries used to go to the default
// namespace, which is empty - so 'vector' was measuring nothing at all.
// --namespace auto asks the half the question's expected section lives in.
const NAMESPACE = value('--namespace') || '';
const FUSION = value('--fusion');
const QUERY_MODE = value('--query-mode');
const WEIGHTING = value('--weighting');
const VECTOR_WEIGHT = parseFloat(value('--vector-weight') || '1');
const PROTECT_VECTOR = parseInt(value('--protect-vector') || '1', 10);
const corpusIds = ns => new Set(readAllCorpus(ns).map(s => s.id));
const PER_SIDE = parseInt(value('--per-side') || '10', 10);
const NEEDS_CORPUS = RETRIEVER !== 'vector';
const CORPUS = NEEDS_CORPUS && RETRIEVER !== 'dual' ? readAllCorpus() : null;
const RULES_CORPUS = RETRIEVER === 'dual' ? readAllCorpus('rules') : null;
const FACTIONS_CORPUS = RETRIEVER === 'dual' ? readAllCorpus('factions') : null;
const JEV_KEY = credential(jevKeyName());
const SENSE_KEY = fastCredential();
const asHits = list => list.map(s => ({ id: s.id, metadata: s, score: s.jev !== undefined ? s.jev : s.score }));

// An expectation is an id, and an id is only stable while the chunker that built
// it is. Two things break when the chunker changes:
//
//  - the record is still there but the rule has moved under it. The splitter
//    keeps a container's id (a citation already in the wild still resolves) and
//    gives the rule a child, '<container>->-<TITLE>'. The FAQ/errata promotion
//    does the opposite: it gives the swallowed card a heading of its own, which
//    is a different heading and so a different id - and no id function can derive
//    the new id from the old one. Both cases are what the "rule reachable" block
//    grades, next to the exact-id number and never in place of it: a rule the
//    chunker moved is a real hit for the reader and a real miss for the fixture,
//    and collapsing the two hides whichever one moved.
//  - the record is gone. The old harness scored that as a plain miss, which reads
//    exactly like a retrieval failure - that is how a chunking change gets
//    mistaken for a quality regression. So every expectation is checked against
//    the corpus before anything is graded, and one the corpus does not name is
//    resolved through the corpus's own id function (sectionId: the page anchor,
//    else anchorFor(heading)) when the same heading still exists - a split part,
//    or an id the de-duplicator suffixed. Resolution is reported, never silent,
//    and an id that resolves to nothing stays a miss.
let corpusIndexCache = null;
function corpusIndex() {
  if (!corpusIndexCache) {
    const all = readAllCorpus();
    const byId = new Set(all.map(s => s.id));
    const byKey = new Map();
    for (const s of all) {
      const key = s.source + '#' + (s.anchor || anchorFor(s.heading) || 'section');
      if (!byKey.has(key)) byKey.set(key, s.id);
    }
    corpusIndexCache = { byId, byKey, n: all.length };
  }
  return corpusIndexCache;
}

const resolveNotes = [];
function resolveExpectation(id, question) {
  const ix = corpusIndex();
  if (!ix.n || ix.byId.has(id)) return id;
  const moved = ix.byKey.get(id);
  if (moved) {
    resolveNotes.push('  moved      ' + id + '  ->  ' + moved + '   [' + question + ']');
    return moved;
  }
  resolveNotes.push('  NOT FOUND  ' + id + '   [' + question + ']');
  return id;
}

let rulesIdSet = null, factionsIdSet = null;
function namespaceFor(item) {
  if (NAMESPACE !== 'auto') return NAMESPACE;
  if (!rulesIdSet) { rulesIdSet = corpusIds('rules'); factionsIdSet = corpusIds('factions'); }
  return item && item.expect.some(e => rulesIdSet.has(e)) ? 'rules' : 'factions';
}

async function retrieve(question, item) {
  if (RETRIEVER === 'vector') {
    return queryIndex(question, { topK: TOPK, namespace: namespaceFor(item), fusionAlgorithm: FUSION, queryMode: QUERY_MODE, weightingStrategy: WEIGHTING });
  }
  if (RETRIEVER === 'dual') {
    const dual = await retrieveDual(question, {
      rulesCorpus: RULES_CORPUS, factionsCorpus: FACTIONS_CORPUS, jevKey: JEV_KEY,
      terms: [], grepNet: NET, jevMax: Math.max(NET, PER_SIDE + 70),
      perSide: { rules: PER_SIDE, factions: PER_SIDE },
      fusionWeights: [VECTOR_WEIGHT, 1], protectVector: PROTECT_VECTOR, queryMode: QUERY_MODE,
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
for (const item of questions) item.expect = (item.expect || []).map(e => resolveExpectation(e, item.q));

// reach=false is the fixture as written: the expected id and nothing else.
// reach=true also accepts a record the splitter put under it, '<id>->-<title>'.
function rankOf(hits, expect, reach) {
  const ids = hits.map(h => h.id);
  let best = null;
  for (const e of expect) {
    for (let i = 0; i < ids.length; i++) {
      const hit = ids[i];
      if (hit === e || (reach && hit.startsWith(e + '->-'))) { if (best === null || i < best) best = i; break; }
    }
  }
  return best === null ? null : best + 1;
}

const rows = [];
for (const item of questions) {
  const hits = await retrieve(item.q, item);
  const rank = item.expect.length ? rankOf(hits, item.expect) : null;
  const rankReach = item.expect.length ? rankOf(hits, item.expect, true) : null;
  const found = item.expect.filter(e => hits.some(h => h.id === e));
  const foundReach = item.expect.filter(e => hits.some(h => h.id === e || h.id.startsWith(e + '->-')));
  rows.push({
    q: item.q,
    kind: item.kind,
    expect: item.expect,
    rank,
    rankReach,
    found: found.length,
    foundReach: foundReach.length,
    needed: item.expect.length,
    top: hits.slice(0, 3).map(h => ({ id: h.id, heading: h.metadata && h.metadata.heading, score: h.score })),
  });
  if (VERBOSE) {
    console.log('  ' + (rank ? '#' + rank : '  -') + '  [' + item.kind + '] ' + item.q);
    // A hit can come from the corpus rather than from a retriever - an anchored
    // record, or the vector leg's protected head - and those carry no score.
    for (const t of rows[rows.length - 1].top) console.log('        ' + (typeof t.score === 'number' ? t.score.toFixed(4) : '   -    ') + '  ' + t.heading + '  (' + t.id + ')');
  }
}

const graded = rows.filter(r => r.needed > 0);
const declined = rows.filter(r => r.needed === 0);

function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : 0; }
function at(k) { return graded.filter(r => r.rank !== null && r.rank <= k).length; }

console.log('');
console.log('retriever ' + RETRIEVER + '  |  questions ' + rows.length + '  (graded ' + graded.length + ', out-of-corpus ' + declined.length + ')  topK ' + TOPK + (RETRIEVER === 'vector' ? '  ns ' + (NAMESPACE || '(default)') + [FUSION, QUERY_MODE, WEIGHTING].filter(Boolean).map(v => ' ' + v).join('') : '  net ' + NET) + (RETRIEVER === 'dual' ? '  per-side ' + PER_SIDE + '  w ' + VECTOR_WEIGHT + '  protect ' + PROTECT_VECTOR + (QUERY_MODE ? '  ' + QUERY_MODE : '') : ''));
if (resolveNotes.length) {
  console.log('');
  console.log('expectations the corpus does not name as written:');
  console.log(resolveNotes.join('\n'));
}
console.log('hit@1   ' + at(1) + '/' + graded.length + '  ' + pct(at(1), graded.length) + '%');
console.log('hit@5   ' + at(5) + '/' + graded.length + '  ' + pct(at(5), graded.length) + '%');
console.log('hit@10  ' + at(10) + '/' + graded.length + '  ' + pct(at(10), graded.length) + '%');
console.log('hit@' + TOPK + '  ' + at(TOPK) + '/' + graded.length + '  ' + pct(at(TOPK), graded.length) + '%');
const mrr = graded.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / (graded.length || 1);
console.log('MRR     ' + Math.round(mrr * 1000) / 1000);
const multi = graded.filter(r => r.needed > 1);
console.log('multi-hop fully found  ' + multi.filter(r => r.found === r.needed).length + '/' + multi.length);

// The same list graded as "the rule the question needs is reachable": the
// expected record itself, or one the splitter put under it. Shown next to the
// exact-id number, never instead of it - a rule the splitter moved is a real hit
// for the reader and a real miss for the fixture, and collapsing the two hides
// whichever one moved. This is the number docs/rules-page.md quotes as "rule
// reachable", and it is the one the reader actually gets.
const atR = k => graded.filter(r => r.rankReach !== null && r.rankReach <= k).length;
const mrrR = graded.reduce((a, r) => a + (r.rankReach ? 1 / r.rankReach : 0), 0) / (graded.length || 1);
console.log('\nrule reachable (expected id, or a record the split put under it)');
console.log('hit@1   ' + atR(1) + '/' + graded.length + '  ' + pct(atR(1), graded.length) + '%');
console.log('hit@5   ' + atR(5) + '/' + graded.length + '  ' + pct(atR(5), graded.length) + '%');
console.log('hit@10  ' + atR(10) + '/' + graded.length + '  ' + pct(atR(10), graded.length) + '%');
console.log('hit@' + TOPK + '  ' + atR(TOPK) + '/' + graded.length + '  ' + pct(atR(TOPK), graded.length) + '%');
console.log('MRR     ' + Math.round(mrrR * 1000) / 1000);
console.log('multi-hop fully found  ' + multi.filter(r => r.foundReach === r.needed).length + '/' + multi.length);

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
