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
import { cfStats, expandQuery, gateHalf, gateHalfLexical, gateVocabularies, grepCorpus, grepTerms, grepWithTerms, jevCalls, jevRank, queryIndex, readAllCorpus, rerankArm, retrieveDual, retrieveWide } from '../src/rules-corpus.mjs';
import { anchorFor, credential, fastCredential, jevKeyName } from '../src/rules.mjs';
import { makeFeatures, rerankWith, train, trainingExamples, loadTraces, FEATURE_NAMES } from './learned-rerank.mjs';
import { expectGroups, missingGroupLine, missingGroups, partialHeadline, satisfiedGroups } from './expectation-groups.mjs';
import { resolveExpectation as resolveOne } from './expectations.mjs';

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
// gate         one Jev choice picks the half, then only that half is searched -
//              the same path as dual, minus the half the question did not use.
//              Reports its routing against the expectation and what a wrong
//              route costs.
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
// Which decider the gate arm uses: 'jev' is the closed-set call, 'lexical' is
// the same decision made from the question's terms and the halves' headings,
// with no call at all. --gate-margin is the lexical one's abstention threshold.
const GATE = value('--gate') || 'jev';
const GATE_MARGIN = parseFloat(value('--gate-margin') || '0');
// The rerank control: --rerank off keeps the key and the whole downstream path
// (anchoring, head protection, clarifications) and skips only the call, so the
// control and the ranked arm are the same pipeline. The recorded OFF sweeps were
// taken by accident, while the free gateway was 429ing - that is the fallback
// pipeline, not passing no key, and the two measure differently.
const RERANK_VALUE = value('--rerank') || 'on';
const RERANK_OFF = RERANK_VALUE === 'off' || RERANK_VALUE === 'learned';
// task-60: --rerank learned re-orders the candidates the same arm already holds
// with a logistic regression trained on the traces. It makes no Jev call (the
// pipeline runs exactly as --rerank off does) and no extra embedding call: the
// features are lexical and rank-based, computed locally.
const LEARNED = RERANK_VALUE === 'learned';
// --no-key is the no-key deployment: the dual/wide arms get no Jev key at all.
// It must land on the same list as --rerank off (the same pipeline, no call),
// which is what makes the zero-call control representative.
const NO_KEY = flag('--no-key');
// A run in which any question fell back is not the arm it says it is. The bank
// numbers are withheld unless this is passed on purpose.
const ALLOW_DEGRADED = flag('--allow-degraded');
// The two halves are queried by namespace name. The default is the live pair;
// the wiki arm points the rules half at a scratch namespace while the corpus on
// disk comes from RULES_CORPUS_DIR, so a corpus rewrite can be measured before
// the live index is rebuilt.
const RULES_NS = value('--rules-ns') || 'rules';
const FACTIONS_NS = value('--factions-ns') || 'factions';
const corpusIds = ns => new Set(readAllCorpus(ns).map(s => s.id));
const PER_SIDE = parseInt(value('--per-side') || '10', 10);
const NEEDS_CORPUS = RETRIEVER !== 'vector';
const SPLIT_HALVES = RETRIEVER === 'dual' || RETRIEVER === 'gate';
const CORPUS = NEEDS_CORPUS && !SPLIT_HALVES ? readAllCorpus() : null;
const RULES_CORPUS = SPLIT_HALVES ? readAllCorpus('rules') : null;
const FACTIONS_CORPUS = SPLIT_HALVES ? readAllCorpus('factions') : null;
const JEV_KEY = credential(jevKeyName());
const SENSE_KEY = fastCredential();
const asHits = list => list.map(s => ({ id: s.id, metadata: s, score: s.jev !== undefined ? s.jev : s.score }));

// The learned arm, trained once: features over the whole corpus (both halves), the
// labels from every trace's own verdict and the reader's marks.
let LEARNED_W = null, featurize = null, LEARNED_STATS = '';
if (LEARNED) {
  const all = (RULES_CORPUS || []).concat(FACTIONS_CORPUS || []);
  const byId = new Map(all.map(r => [r.id, r]));
  featurize = makeFeatures(all);
  const traces = loadTraces();
  const t = trainingExamples(traces, featurize, byId);
  LEARNED_W = value('--learned-weights') === 'rank' ? [0, 0, 0, 0, 0, 1, 0, 0, 0] : train(t.examples);
  LEARNED_STATS = 'learned from ' + traces.length + ' traces, ' + t.examples.length + ' examples, ' + t.positives + ' positive';
  console.log('learned rerank: ' + LEARNED_STATS + '\n  weights ' + FEATURE_NAMES.map((n, i) => n + '=' + LEARNED_W[i].toFixed(3)).join('  '));
}

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
    corpusIndexCache = { byId, byKey, ids: all.map(s => s.id), n: all.length };
  }
  return corpusIndexCache;
}

const resolveNotes = [];
// The conventions live in tests/expectations.mjs so the guard test reads the
// same rules; this wrapper only adds the question to the report line.
function resolveExpectation(id, question) {
  const r = resolveOne(id, corpusIndex());
  if (r.note) resolveNotes.push(r.note + '   [' + question + ']');
  return r;
}

let rulesIdSet = null, factionsIdSet = null;
// The half a question's expectation lives in: the oracle the gate is scored
// against, and the namespace the vector arm asks for under --namespace auto.
function expectedHalf(item) {
  if (!rulesIdSet) { rulesIdSet = corpusIds('rules'); factionsIdSet = corpusIds('factions'); }
  return item && item.expect.flat().some(e => rulesIdSet.has(e)) ? 'rules' : 'factions';
}
function namespaceFor(item) {
  if (NAMESPACE !== 'auto') return NAMESPACE;
  return expectedHalf(item);
}

// What the gate chose for the question just retrieved, so the row can carry it
// without every arm having to return a shape it does not need.
let lastGate = null;
let gateVocab = null;

async function retrieve(question, item) {
  if (RETRIEVER === 'vector') {
    return queryIndex(question, { topK: TOPK, namespace: namespaceFor(item), fusionAlgorithm: FUSION, queryMode: QUERY_MODE, weightingStrategy: WEIGHTING });
  }
  if (RETRIEVER === 'dual') {
    const dual = await retrieveDual(question, {
      rulesCorpus: RULES_CORPUS, factionsCorpus: FACTIONS_CORPUS, jevKey: NO_KEY ? '' : JEV_KEY, jevSkip: RERANK_OFF,
      rulesNamespace: RULES_NS, factionsNamespace: FACTIONS_NS,
      terms: [], grepNet: NET, jevMax: Math.max(NET, PER_SIDE + 70),
      perSide: { rules: PER_SIDE, factions: PER_SIDE },
      fusionWeights: [VECTOR_WEIGHT, 1], protectVector: PROTECT_VECTOR, queryMode: QUERY_MODE,
    });
    return asHits(dual.all);
  }
  if (RETRIEVER === 'gate') {
    let g;
    if (GATE === 'lexical') {
      if (!gateVocab) gateVocab = gateVocabularies({ rules: RULES_CORPUS, factions: FACTIONS_CORPUS });
      const l = gateHalfLexical(question, gateVocab, { minMargin: GATE_MARGIN });
      g = { half: l.half, confidence: null, error: l.half ? '' : l.abstain, score: l.score, margin: l.margin };
    } else {
      g = await gateHalf(question, JEV_KEY);
    }
    lastGate = g;
    // No half from the gate means no route: searching both is the safe reading,
    // and the run reports how often that happened instead of hiding it.
    if (!g.half) {
      const dual = await retrieveDual(question, {
        rulesCorpus: RULES_CORPUS, factionsCorpus: FACTIONS_CORPUS, jevKey: NO_KEY ? '' : JEV_KEY, jevSkip: RERANK_OFF,
        rulesNamespace: RULES_NS, factionsNamespace: FACTIONS_NS,
        terms: [], grepNet: NET, jevMax: Math.max(NET, PER_SIDE + 70),
        perSide: { rules: PER_SIDE, factions: PER_SIDE },
        fusionWeights: [VECTOR_WEIGHT, 1], protectVector: PROTECT_VECTOR, queryMode: QUERY_MODE,
      });
      return asHits(dual.all);
    }
    const wide = await retrieveWide(question, {
      corpus: g.half === 'factions' ? FACTIONS_CORPUS : RULES_CORPUS,
      namespace: g.half === 'factions' ? FACTIONS_NS : RULES_NS, jevKey: NO_KEY ? '' : JEV_KEY, jevSkip: RERANK_OFF, terms: [],
      grepNet: NET, jevMax: Math.max(NET, PER_SIDE + 70), topK: PER_SIDE,
      fusionWeights: [VECTOR_WEIGHT, 1], protectVector: PROTECT_VECTOR, queryMode: QUERY_MODE,
    });
    return asHits(wide);
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
  return asHits(await retrieveWide(question, { corpus: CORPUS, jevKey: NO_KEY ? '' : JEV_KEY, jevSkip: RERANK_OFF, terms, grepNet: NET, jevMax: NET, topK: TOPK }));
}

const bank = JSON.parse(fs.readFileSync(QUESTIONS, 'utf8'));
const questions = bank.questions.filter(q => !ONLY_KIND || q.kind === ONLY_KIND);
// An expectation is a list of groups (tests/expectation-groups.mjs): a plain list
// is one group per id, a list of lists is the groups as written. Each member is
// resolved on its own, so one the chunker moved is still named.
// A split expands to the parts the corpus actually has: the question scores on
// any of them, which is what "a record the splitter put under it" means here.
for (const item of questions) item.expect = expectGroups(item.expect).map(g => g.flatMap(e => {
  const r = resolveExpectation(e, item.q);
  return r.via === 'split' ? r.parts : [r.resolved];
}));

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
// How many questions took a lower-quality path instead of the arm's own: a
// rerank or gate call that threw is a call the run did not get. Counted per
// question, never averaged - a run is only as clean as its worst row, and this
// is the number that proves the artifact was taken from the arm it names.
let fallbacks = 0;
for (const item of questions) {
  const callsBefore = jevCalls();
  let hits = await retrieve(item.q, item);
  // The learned arm re-orders what the arm retrieved; it adds no call.
  if (LEARNED_W) hits = rerankWith(LEARNED_W, featurize(item.q, hits));
  const callsAfter = jevCalls();
  const fellBack = (callsAfter.rerank.failed - callsBefore.rerank.failed) +
    (callsAfter.gate.failed - callsBefore.gate.failed);
  if (fellBack) fallbacks++;
  // The rank is the best rank among every member of every group - what hit@K and
  // MRR already measured - while 'found' counts GROUPS: one member found satisfies
  // its group, and a question is only partial when a whole group is missing.
  const members = item.expect.flat();
  const ids = hits.map(h => h.id);
  const rank = members.length ? rankOf(hits, members) : null;
  const rankReach = members.length ? rankOf(hits, members, true) : null;
  const found = satisfiedGroups(item.expect, ids);
  const foundReach = satisfiedGroups(item.expect, ids, true);
  rows.push({
    q: item.q,
    kind: item.kind,
    groups: item.expect,
    expect: members,
    rank,
    rankReach,
    found: found.length,
    foundReach: foundReach.length,
    needed: item.expect.length,
    // What the reader is actually handed, and (on the gate arm) which half the
    // question's expectation lives in against the half the gate chose.
    candidates: hits.length,
    expected: item.expect.length ? expectedHalf(item) : '',
    gated: RETRIEVER === 'gate' && lastGate ? lastGate.half : '',
    gateError: RETRIEVER === 'gate' && lastGate ? (lastGate.error || '') : '',
    top: hits.slice(0, 3).map(h => ({ id: h.id, heading: h.metadata && h.metadata.heading, score: h.score })),
    // Every id the reader was handed, for the per-question partial line below:
    // which expectation entered the findings, and which did not.
    ids,
  });
  if (VERBOSE) {
    console.log('  ' + (rank ? '#' + rank : '  -') + '  [' + item.kind + '] ' + item.q);
    // A hit can come from the corpus rather than from a retriever - an anchored
    // record, or the vector leg's protected head - and those carry no score.
    for (const t of rows[rows.length - 1].top) console.log('        ' + (typeof t.score === 'number' ? t.score.toFixed(4) : '   -    ') + '  ' + t.heading + '  (' + t.id + ')');
  }
}

const jc = jevCalls();
const fmtCalls = c => 'attempted ' + c.attempted + '  answered ' + c.answered + '  failed ' + c.failed;
const graded = rows.filter(r => r.needed > 0);
const declined = rows.filter(r => r.needed === 0);

function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : 0; }
function at(k) { return graded.filter(r => r.rank !== null && r.rank <= k).length; }

console.log('');
console.log('retriever ' + RETRIEVER + '  |  questions ' + rows.length + '  (graded ' + graded.length + ', out-of-corpus ' + declined.length + ')  topK ' + TOPK + (RETRIEVER === 'vector' ? '  ns ' + (NAMESPACE || '(default)') + [FUSION, QUERY_MODE, WEIGHTING].filter(Boolean).map(v => ' ' + v).join('') : '  net ' + NET) + (SPLIT_HALVES ? '  per-side ' + PER_SIDE + '  w ' + VECTOR_WEIGHT + '  protect ' + PROTECT_VECTOR + (QUERY_MODE ? '  ' + QUERY_MODE : '') : '')
  + (RETRIEVER === 'gate' ? '  gate ' + GATE + (GATE === 'lexical' ? ' margin ' + GATE_MARGIN : '') : '')
  + (RERANK_OFF ? '  rerank off' : '  rerank ' + rerankArm()) + (NO_KEY ? '  no key' : '')
  + (RULES_NS !== 'rules' || FACTIONS_NS !== 'factions' ? '  ns ' + RULES_NS + '/' + FACTIONS_NS : ''));
if (resolveNotes.length) {
  console.log('');
  console.log('expectations the corpus does not name as written:');
  console.log(resolveNotes.join('\n'));
}
console.log('');
console.log((rerankArm() + ' calls').padEnd(11) + ' ' + fmtCalls(jc) + '  (rerank ' + fmtCalls(jc.rerank) + ', gate ' + fmtCalls(jc.gate) + ')  ' + (rows.length ? (jc.answered / rows.length).toFixed(1) : '0') + ' answered per question' + (rerankArm() === 'cf' ? '  (cf truncated ' + cfStats().truncated + ')' : ''));
console.log('fallbacks   ' + fallbacks + '/' + rows.length + ' questions' + (fallbacks ? '  DEGRADED' : '  clean'));
const withhold = fallbacks > 0 && !ALLOW_DEGRADED;
if (withhold) {
  console.log('            bank numbers withheld: a run that fell back is not the arm it says it is.');
  console.log('            Re-run it clean, or pass --allow-degraded to print them anyway.');
  process.exitCode = 2;
}
if (!withhold) {
console.log('hit@1   ' + at(1) + '/' + graded.length + '  ' + pct(at(1), graded.length) + '%');
console.log('hit@5   ' + at(5) + '/' + graded.length + '  ' + pct(at(5), graded.length) + '%');
console.log('hit@10  ' + at(10) + '/' + graded.length + '  ' + pct(at(10), graded.length) + '%');
console.log('hit@' + TOPK + '  ' + at(TOPK) + '/' + graded.length + '  ' + pct(at(TOPK), graded.length) + '%');
const mrr = graded.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / (graded.length || 1);
console.log('MRR     ' + Math.round(mrr * 1000) / 1000);
const multi = graded.filter(r => r.needed > 1);
console.log('multi-hop fully found  ' + multi.filter(r => r.found === r.needed).length + '/' + multi.length);
// The cost side, in the same run as the recall side: how many passages the
// reader is handed. A core-rules definition asked live was handed 21, 10 rules
// and 11 factions, and cited six.
{
  const cand = graded.map(r => r.candidates);
  const sum = cand.reduce((a, b) => a + b, 0);
  console.log('candidates  mean ' + (Math.round((sum / (cand.length || 1)) * 10) / 10) + '  min ' + Math.min(...cand) + '  max ' + Math.max(...cand) + '  total ' + sum);
}

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

// The gate arm's own score: does a cheap choice pick the half the expectation
// lives in, and what does a wrong route cost. An abstention is not a wrong
// answer - it searched both - and is reported separately.
if (RETRIEVER === 'gate') {
  const routed = graded.filter(r => r.gated);
  const right = routed.filter(r => r.gated === r.expected);
  const wrong = routed.filter(r => r.gated !== r.expected);
  console.log('\ngate routing (the half each expectation lives in)');
  console.log('  correct   ' + right.length + '/' + graded.length + '  ' + pct(right.length, graded.length) + '%');
  const abstained = graded.filter(r => !r.gated);
  console.log('  abstained ' + abstained.length + '  (no half from the gate - searched both)');
  for (const r of abstained) console.log('  abstain   ' + r.q);
  for (const r of wrong) console.log('  wrong     ' + r.q + '  -> ' + r.gated + ', expected ' + r.expected);
  console.log('  wrong route and nothing expected in the top ' + TOPK + ': ' + wrong.filter(r => r.rank === null).length);
  for (const r of wrong.filter(x => x.rank === null)) console.log('      ' + r.q);
}

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

// Per-question partial findings, which the miss list above cannot show: that one
// only catches rank === null, so an entry whose groups are not all covered reads
// as a hit at the best rank of the ones that were. The global 'multi-hop fully
// found' column catches the ratio; this says which entry, and which group, never
// entered the findings - which is what a corpus or chunker change is read on. A
// group is satisfied by any of its alternatives, so the line names the
// alternatives that never appeared; one the splitter moved under a child is named
// as reachable, a real hit for the reader and a real miss for the fixture.
const partial = graded.filter(r => r.found < r.needed);
if (partial.length) {
  console.log('\npartial (' + partial.length + '/' + graded.length + ') - expectations not all covered');
  for (const r of partial) {
    console.log('  [' + r.kind + '] ' + r.q);
    console.log(partialHeadline(r.needed, r.found, r.rank, TOPK));
    for (const g of missingGroups(r.groups, r.ids)) console.log('      ' + missingGroupLine(g, r.ids));
  }
}

console.log('\nout-of-corpus (expected to be declined, not answered)');
for (const r of declined) {
  console.log('  ' + r.q);
  console.log('      returned: ' + r.top.map(t => (t.metadata && t.metadata.heading) || t.id).join(' | '));
}
}
