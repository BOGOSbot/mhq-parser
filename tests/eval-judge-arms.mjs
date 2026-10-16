#!/usr/bin/env node
'use strict';
/**
 * Four judges, one retrieval, one bank.
 *
 *   node tests/eval-judge-arms.mjs [--limit 5] [--ids 3,9] [--out judge-arms.ndjson]
 *
 * The question: should the judge be allowed to open a link while it reasons, and is it
 * worth paying for the deep judge to do it?
 *
 *   A  fast judge, no manifest, no hop   the shipping shape
 *   B  fast judge, one hop              the feature
 *   C  deep judge, one hop              the feature with the careful judge
 *   D  fast judge, manifest offered, hop refused   the CONTROL
 *
 * D exists because B differs from A in two ways at once. Handing the judge a list of
 * links changes the prompt even when it opens nothing, so a change in B is not yet
 * evidence about the hop. D has the byte-identical prompt to B and never opens a link:
 * A->D is what being OFFERED a link does, D->B is what OPENING one does, and only the
 * second is the feature.
 *
 * All four see the SAME findings. One retrieval per question at the deep scope
 * (per-side 10, net 60), so the judge is the only variable. The arms run in parallel
 * per question; questions run one at a time so the free route is not burst.
 *
 * What is graded is not hit@k - that is eval-retrieval.mjs - but whether the judge
 * CITES the rule the fixture expects. A judge that says 'answered' and cites the wrong
 * rule is a worse product than one that says 'not answered' honestly, and only this
 * number tells them apart.
 *
 *   cited       an expected id is cited exactly
 *   citedReach  an expected id is cited, or a record the splitter put under it
 *               ('<id>->-<title>'): the rule the reader can actually reach
 *   full        every expected group has a cited member
 *   missed      the rule WAS retrieved and the baseline judge cited nothing useful:
 *               the population the hop exists for
 *   hop/hopGood the judge opened a link / the record it opened was expected
 *
 * Expectations are resolved against the corpus before anything is graded, exactly as
 * eval-retrieval.mjs does. The fixture's ids are as old as the chunker that wrote them,
 * and grading them raw scores a rule that merely moved as a rule that is absent.
 *
 * ndjson is appended as it lands, and a question already in the output is not redone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchorFor, credential, fastCredential, jevKeyName } from '../src/rules.mjs';
import { findingFor, followManifest, judgeCoverage, readAllCorpus, retrieveDual } from '../src/rules-corpus.mjs';
import { expectGroups } from './expectation-groups.mjs';
import { resolveExpectation as resolveOne } from './expectations.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const value = n => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const LIMIT = parseInt(value('--limit') || '0', 10);
const ONLY_IDS = (value('--ids') || '').split(',').map(s => s.trim()).filter(Boolean);
const OUT = value('--out') || 'judge-arms.ndjson';
// The page's own fast scope. Every arm sees the SAME findings, and they are the ones the
// product actually shows the judge: 5 a side. A wider set made the prompt 28 KB and a
// small judge drifts into prose at that size, which measures the harness, not the arms.
const PER_SIDE = parseInt(value('--per-side') || '5', 10);
const NET = parseInt(value('--net') || '60', 10);
const JEV_MAX = parseInt(value('--jev-max') || '60', 10);

const RULES_CORPUS = readAllCorpus('rules');
const FACTIONS_CORPUS = readAllCorpus('factions');
const ALL = RULES_CORPUS.concat(FACTIONS_CORPUS);
const BY_ID = new Map(ALL.map(r => [r.id, r]));
const RESOLVE = id => BY_ID.get(id);
// The resolver's index, built the way eval-retrieval.mjs builds it: exact ids, plus the
// source#anchor lane that catches a record the chunker moved.
const IDX = (function () {
  const byId = new Set(ALL.map(s => s.id));
  const byKey = new Map();
  for (const s of ALL) {
    const key = s.source + '#' + (s.anchor || anchorFor(s.heading) || 'section');
    if (!byKey.has(key)) byKey.set(key, s.id);
  }
  return { byId, byKey, ids: ALL.map(s => s.id) };
})();
const JEV = credential(jevKeyName());
const FAST = fastCredential();
if (!FAST) { console.error('no fast-route key: the judge cannot run'); process.exit(1); }

const bank = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rules-questions.json'), 'utf8'));
let questions = bank.questions.filter(q => Array.isArray(q.expect) && q.expect.length);
// An expectation is a list of groups; each member is resolved on its own, and a split
// expands to the parts the corpus actually has. Same resolution as eval-retrieval.mjs.
for (const item of questions) item.expect = expectGroups(item.expect).map(g => g.flatMap(e => {
  const r = resolveOne(e, IDX);
  return r.via === 'split' ? r.parts : [r.resolved];
}));
if (ONLY_IDS.length) questions = questions.filter((q, i) => ONLY_IDS.indexOf(String(i)) !== -1 || ONLY_IDS.indexOf(q.q) !== -1);
if (LIMIT) questions = questions.slice(0, LIMIT);

const ARMS = [
  { key: 'A', label: 'A fast, no hop    ', opts: { reasoning: 'none' } },
  { key: 'B', label: 'B fast, one hop   ', opts: { reasoning: 'none', follow: true, resolve: RESOLVE } },
  { key: 'C', label: 'C deep, one hop   ', opts: { reasoning: 'medium', follow: true, resolve: RESOLVE } },
  { key: 'D', label: 'D fast, control   ', opts: { reasoning: 'none', follow: true, resolve: RESOLVE, noHop: true } },
];

const groupsOf = item => item.expect.map(g => new Set(g));
// Reach, exactly as the retrieval harness reads it: the fixture's id, or a record the
// splitter put under it. The reader can reach both; only the fixture can tell them apart.
const matches = (set, id) => { const s = String(id || ''); for (const e of set) if (s === e || s.startsWith(e + '->-')) return true; return false; };
const inAny = (groups, id) => !!id && groups.some(g => matches(g, id));
const inAnyExact = (groups, id) => !!id && groups.some(g => g.has(id));
const coversAll = (groups, ids) => groups.every(g => ids.some(id => matches(g, id)));

function citedIds(verdict, findings, followed) {
  const list = findings.map(f => f.id);
  if (followed) list.push(followed.to);
  return (verdict.passages || []).map(n => list[n - 1]).filter(Boolean);
}

function scoreArm(item, findings, arm, verdict, ms) {
  const g = groupsOf(item);
  const ids = citedIds(verdict, findings, verdict.followed);
  return {
    arm: arm.key,
    cited: ids.some(id => inAnyExact(g, id)),
    citedReach: ids.some(id => inAny(g, id)),
    full: coversAll(g, ids),
    answered: verdict.answered === true,
    confidence: verdict.confidence || '',
    hop: !!verdict.followed,
    hopTo: verdict.followed ? verdict.followed.to : '',
    hopGood: !!(verdict.followed && inAny(g, verdict.followed.to)),
    retrievedHit: findings.some(f => inAny(g, f.id)),
    citedIds: ids,
    passages: verdict.passages || [],
    why: verdict.why || '',
    failed: verdict.followFailed || '',
    ms,
  };
}

const done = new Set();
try {
  for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o.q) done.add(o.q); } catch (e) { /* a torn last line */ }
  }
} catch (e) { /* first run */ }

const rows = [];
for (let i = 0; i < questions.length; i++) {
  const item = questions[i];
  if (done.has(item.q)) continue;
  const t0 = Date.now();
  let findings = [];
  try {
    const dual = await retrieveDual(item.q, {
      rulesCorpus: RULES_CORPUS, factionsCorpus: FACTIONS_CORPUS,
      jevKey: JEV, rulesNamespace: 'rules', factionsNamespace: 'factions',
      terms: [], grepNet: NET, jevMax: JEV_MAX, perSide: { rules: PER_SIDE, factions: PER_SIDE },
    });
    findings = dual.all.map((s, n) => findingFor(s, n + 1));
  } catch (e) {
    console.log('[' + (i + 1) + '/' + questions.length + '] RETRIEVAL FAILED  ' + item.q + '  ' + String(e.message).slice(0, 90));
    continue;
  }
  const retrievalMs = Date.now() - t0;
  // The ceiling of the whole feature: a hop can only open what the link graph holds.
  const man = followManifest(findings, RESOLVE);
  const linkItems = man.reduce((a, m) => a + m.items.length, 0);
  const results = await Promise.all(ARMS.map(async arm => {
    const t = Date.now();
    const verdict = await judgeCoverage(item.q, findings, FAST, arm.opts)
      .catch(e => ({ rulesQuestion: null, answered: null, confidence: '', passages: [], why: '', followFailed: String(e.message) }));
    return scoreArm(item, findings, arm, verdict, Date.now() - t);
  }));
  const row = { q: item.q, kind: item.kind, findings: findings.length, retrievalMs, linkItems, arms: results };
  rows.push(row);
  fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
  const mark = r => (r.citedReach ? 'C' : '.') + (r.answered ? 'a' : '-') + (r.hop ? (r.hopGood ? 'H' : 'h') : '.');
  console.log('[' + (i + 1) + '/' + questions.length + '] ' + ARMS.map((x, k) => mark(results[k])).join(' ') + '  ' + item.q.slice(0, 58));
}

// --- the reading --------------------------------------------------------------
const n = rows.length;
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '-';
const cell = (a, b) => (pct(a, b) + ' (' + a + ')').padEnd(11);
console.log('');
console.log('bank: ' + n + ' graded questions, one retrieval each at per-side ' + PER_SIDE + ' / net ' + NET);
console.log('');
console.log('arm                cited       reach       full        answered    missed  noparse  hop  good  calls');
for (let k = 0; k < ARMS.length; k++) {
  const rs = rows.map(r => r.arms[k]);
  const cited = rs.filter(r => r.cited).length;
  const reach = rs.filter(r => r.citedReach).length;
  const full = rs.filter(r => r.full).length;
  const answered = rs.filter(r => r.answered).length;
  const missed = rs.filter(r => r.retrievedHit && !r.citedReach).length;
  const hop = rs.filter(r => r.hop).length;
  const good = rs.filter(r => r.hopGood).length;
  const calls = rs.reduce((a, r) => a + (r.hop ? 2 : 1), 0);
  const noparse = rs.filter(r => /returned nothing parseable/.test(r.why)).length;
  console.log(ARMS[k].label + ' ' + cell(cited, n) + ' ' + cell(reach, n) + ' ' + cell(full, n) + ' '
    + cell(answered, n) + ' ' + String(missed).padEnd(7) + ' ' + String(noparse).padEnd(8) + ' ' + String(hop).padEnd(4) + ' ' + String(good).padEnd(5) + ' ' + calls);
}
console.log('');
// The decomposition the control arm exists for: A->D is the offer, D->B is the open.
const [a, b, c, d] = [0, 1, 2, 3].map(k => rows.map(r => r.arms[k]));
const delta = (x, y, key) => y.filter((r, i) => r[key] && !x[i][key]).length + ' gained, ' + y.filter((r, i) => !r[key] && x[i][key]).length + ' lost';
console.log('reach       offered only  A->D : ' + delta(a, d, 'citedReach'));
console.log('reach       opened        D->B : ' + delta(d, b, 'citedReach'));
console.log('answered    offered only  A->D : ' + delta(a, d, 'answered'));
console.log('answered    opened        D->B : ' + delta(d, b, 'answered'));
console.log('answered    deep          D->C : ' + delta(d, c, 'answered'));
console.log('');
const answeredOnly = (x, y) => x.filter((r, i) => r.answered && !y[i].answered).length;
console.log('A says answered and D does not : ' + answeredOnly(a, d) + '   (the offer alone already makes it more cautious)');
console.log('D says answered and B does not : ' + answeredOnly(d, b) + '   (opening a link costs the answer)');
console.log('D says answered and C does not : ' + answeredOnly(d, c) + '   (and the deep judge costs more)');
const hopRows = rows.filter(r => r.arms[1].hop || r.arms[2].hop);
console.log('');
console.log('every hop (' + hopRows.length + ' questions):');
for (const r of hopRows) for (const k of [1, 2, 3]) {
  const x = r.arms[k];
  if (!x.hop) continue;
  console.log('  ' + ARMS[k].key + ' ' + (x.hopGood ? 'GOOD' : 'miss') + '  ' + r.q.slice(0, 48) + '  -> ' + x.hopTo);
}
console.log('');
const noLinks = rows.filter(r => !r.linkItems);
console.log('the link graph the hop can use, before any judge runs:');
console.log('  questions with nothing openable : ' + noLinks.length + '/' + n);
console.log('  openable links per question     : ' + (n ? (rows.reduce((x, r) => x + r.linkItems, 0) / n).toFixed(1) : '0') + ' mean, '
  + (n ? Math.max.apply(null, rows.map(r => r.linkItems)) : 0) + ' max');
const missedAny = rows.filter(r => r.arms[0].retrievedHit && !r.arms[0].citedReach);
console.log('');
console.log('the rule was retrieved and A did not cite it (' + missedAny.length + '):');
for (const r of missedAny) {
  const line = [1, 2, 3].map(k => ARMS[k].key + (r.arms[k].citedReach ? '+' : '-')).join(' ');
  console.log('  ' + line + '  ' + r.q.slice(0, 56));
}
const notRetrieved = rows.filter(r => !r.arms[0].retrievedHit);
console.log('');
console.log('A said answered on a question whose rule was never retrieved: '
  + rows.filter(r => r.arms[0].answered && !r.arms[0].retrievedHit).length + ' of ' + notRetrieved.length + ' such questions');
