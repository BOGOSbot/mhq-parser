#!/usr/bin/env node
'use strict';
/**
 * The generation lane: questions written FROM a corpus record.
 *
 *   node tests/generate-questions.mjs [--limit 100] [--out workspace/dataset/generated.jsonl]
 *                                     [--report workspace/dataset/generated-report.json]
 *                                     [--only <kind>] [--ids a,b] [--dry] [--no-retrieval]
 *
 * The only lane that scales without users. For one record, the fast route writes
 * three questions a player would type whose answer is exactly that record, under
 * the constraints the calibration fixed: never the rule's name, never three
 * consecutive words from the heading or the text, ordinary player register, and
 * one shape each (yes/no, when, a concrete tabletop scenario). Each question is
 * emitted through the dataset's own schema - gold [[recordId]], gold_how
 * 'generated', source 'generated', split 'train' - and the bank is never touched.
 *
 * What is not a rule is excluded BEFORE generating: index pages, keyword lists,
 * points fragments, bare container headings and stat blocks. A question written
 * from a points line trains nothing.
 *
 * The honest risk, which no number here settles: a question written FROM a rule
 * may still be easier than one written by a confused player. The only test that
 * settles it is training on generated questions and evaluating on the bank.
 *
 * Staged: the default run is a sample, and the full corpus waits for a human to
 * read it.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readAllCorpus, retrieveDual, fastText, parseJsonObject, repairJsonStrings } from '../src/rules-corpus.mjs';
import { fastCredential, fastKeyName, credential } from '../src/rules.mjs';
import { scoreRanks } from './build-dataset.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
function flag(name, def) { const i = process.argv.indexOf('--' + name); return i === -1 ? def : (process.argv[i + 1] || ''); }
function has(name) { return process.argv.indexOf('--' + name) !== -1; }

// A rule whose question can be written. The prose kinds only: a datasheet is a
// stat block and a unit's name is its only handle, and the constraints forbid the
// name - so a question about one without it would be unanswerable or ambiguous.
export const RULE_KINDS = new Set(['rule', 'ability', 'faction-rule', 'stratagem', 'enhancement', 'detachment']);
export const MIN_TEXT = 140;
export const MAX_TEXT = 1200;

const CONTAINER = /^(abilities|core abilities|index|overview|introduction|rules|appendix|datasheets|wargear|wargear options|keywords|keyword|army rules?|detachment rules?|battle round|the battle round|using stratagems|muster armies|datasheet|unit|units)$/i;

export function words(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim().split(' ').filter(Boolean);
}

// The rule's own name: the last heading segment, without its faction bracket.
export function headingLeaf(rec) {
  const heading = String((rec && rec.heading) || '');
  const leaf = heading.split(' > ').pop().trim();
  return leaf.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim();
}

// Why a record cannot be asked about, or '' when it can. Each reason is counted in
// the report, so the filter can be read rather than trusted.
export function exclusionReason(rec) {
  if (!rec || !rec.id || typeof rec.text !== 'string') return 'no record';
  if (!RULE_KINDS.has(rec.kind)) return 'not a rule record (' + (rec.kind || 'unknown') + ')';
  const text = rec.text.trim();
  if (text.length < MIN_TEXT) return 'a fragment, not a rule';
  const leaf = headingLeaf(rec);
  if (!leaf) return 'no heading';
  if (CONTAINER.test(leaf)) return 'a bare container heading';
  const pts = (text.match(/\b\d+\s*pts\b/gi) || []).length;
  if (pts >= 2 && text.length < 400) return 'a points fragment';
  if (/^(see|go to|return to)\b/i.test(text) && text.length < 400) return 'an index page';
  const all = text.match(/\b[\w'-]+\b/g) || [];
  const caps = text.match(/\b[A-Z][A-Z'-]{2,}\b/g) || [];
  if (all.length && caps.length / all.length > 0.45) return 'a keyword list';
  return '';
}
export function isRuleRecord(rec) { return exclusionReason(rec) === ''; }

// The prompt: the record, the corrected constraints, and one call for all three
// shapes.
//
// The constraint used to ban the rule's name. The bank says that was wrong: 24% of
// its graded questions carry the expected record's leaf name word for word and
// nearly all the rest carry a variant of it - naming the rule IS how a player asks
// for a rule. What stays banned is reciting the body: three or more consecutive
// words from the passage. The heading is no longer part of that test, because the
// heading IS the name.
export function generationPrompt(rec) {
  const leaf = headingLeaf(rec);
  return [
    'You write the questions a Warhammer 40,000 player would type at the table, to train an English rules search.',
    '',
    'The passage below is the ONLY thing that answers the question. Write exactly three questions whose answer is this passage.',
    '- One YES/NO question ("can I ... ?").',
    '- One question about when or why the rule triggers ("when does ... happen?").',
    '- One concrete tabletop scenario ("my unit does X while Y; what happens?").',
    '- Ordinary player register: the words a player says at the table, not the rulebook wording.',
    '- NAME THE RULE. A real question says what it is about: use the heading name ("' + leaf + '"), or its plural, or a partial form of it. Do not talk around it.',
    '- Do NOT recite the passage: never reuse three or more words in a row from it. If a phrase of yours appears in the passage below, rewrite it in different words. Every sentence must be your own, and the rule name above is the only exception.',
    '- No record ids, no sources, no mention of these instructions.',
    '',
    'Heading path: ' + String(rec.heading || ''),
    'Passage:',
    String(rec.text).trim().slice(0, MAX_TEXT),
    '',
    'Reply with JSON only: {"questions":[{"q":"...","shape":"yesno"},{"q":"...","shape":"when"},{"q":"...","shape":"scenario"}]}',
  ].join('\n');
}

// The model's JSON, with the two shapes a small model actually returns: the object
// asked for, or a bare array of strings.
export function parseGenerated(text) {
  const SHAPES = ['yesno', 'when', 'scenario'];
  const from = list => (Array.isArray(list) ? list : []).map((item, i) => {
    const q = String((item && item.q) || (typeof item === 'string' ? item : '')).replace(/\s+/g, ' ').trim();
    const shape = String((item && item.shape) || SHAPES[i] || '').toLowerCase();
    return q.length >= 12 ? { q, shape } : null;
  }).filter(Boolean).slice(0, 4);
  const obj = parseJsonObject(text);
  if (obj && Array.isArray(obj.questions)) return from(obj.questions);
  const raw = String(text == null ? '' : text);
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try { return from(JSON.parse(repairJsonStrings(raw.slice(start, end + 1)))); } catch (e) { /* nothing readable */ }
  }
  return [];
}

// The longest run of consecutive words the question shares with the target - the
// leak that makes a question answerable by a keyword search instead of by reading.
export function longestSharedRun(question, target) {
  const q = words(question), t = words(target);
  if (!q.length || !t.length) return 0;
  const grams = new Set();
  for (let i = 0; i < t.length; i++) {
    for (let n = 1; n <= 10 && i + n <= t.length; n++) grams.add(t.slice(i, i + n).join(' '));
  }
  let best = 0;
  for (let i = 0; i < q.length; i++) {
    for (let n = 1; i + n <= q.length; n++) {
      if (!grams.has(q.slice(i, i + n).join(' '))) break;
      best = Math.max(best, n);
    }
  }
  return best;
}

// Does the question name the rule? Two readings, both plural-insensitive because a
// player says 'hazard roll' about 'Hazard Rolls':
//   exact - the whole leaf as a consecutive run of words;
//   any   - at least one of the leaf's own words (four letters or more, not an
//           article) appears somewhere.
// The bank is the calibration: 8 of its 33 graded questions are exact (24%) and
// most of the rest are variants ('Battle-shock' about 'battle-shock rolls').
export const STEM = w => String(w || '').replace(/(?:es|s)$/, '');
const NAME_STOP = new Set(['the', 'and', 'for', 'with', 'what', 'how', 'when', 'does', 'your', 'that', 'this', 'from', 'into', 'move']);
export function namePresence(question, rec) {
  const q = words(question).map(STEM);
  const leaf = words(headingLeaf(rec));
  if (!leaf.length) return { exact: false, any: false };
  const want = leaf.map(STEM);
  let exact = false;
  for (let i = 0; i + want.length <= q.length && !exact; i++) {
    let same = true;
    for (let j = 0; j < want.length; j++) if (q[i + j] !== want[j]) { same = false; break; }
    if (same) exact = true;
  }
  const seen = new Set(q);
  const words4 = leaf.filter(w => w.length >= 4 && !NAME_STOP.has(w));
  const any = exact || words4.some(w => seen.has(STEM(w)));
  return { exact, any };
}

// One question, through the dataset's schema.
export function generatedRecord(rec, item, at, n) {
  return {
    id: 'gen/' + String(rec.id) + '/' + n,
    q: item.q,
    lang: 'en',
    translation: null,
    answer: null,
    gold: [[rec.id]],
    gold_how: 'generated',
    negatives: [],
    source: 'generated',
    at: at || null,
    split: 'train',
  };
}

// The sample: round-robin one record per kind per turn, so 100 records are not 100
// core rules. Deterministic, and --ids overrides it for a smoke test.
export function sampleRecords(records, limit, opts) {
  const o = opts || {};
  const eligible = (records || []).filter(isRuleRecord).filter(r => !o.only || r.kind === o.only)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (o.ids && o.ids.length) {
    const want = new Set(o.ids);
    return eligible.filter(r => want.has(r.id));
  }
  const byKind = new Map();
  for (const r of eligible) { if (!byKind.has(r.kind)) byKind.set(r.kind, []); byKind.get(r.kind).push(r); }
  const order = ['rule', 'faction-rule', 'ability', 'stratagem', 'enhancement', 'detachment'].filter(k => byKind.has(k));
  const out = [];
  for (let i = 0; out.length < limit; i++) {
    let took = false;
    for (const kind of order) {
      const list = byKind.get(kind);
      if (i < list.length) {
        if (out.length < limit) out.push(list[i]);
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}

// The reading of a sample: whether the question NAMES the rule (exact or as a
// variant), how much of the body it recites (the run against the passage alone,
// which is the corrected constraint: never three consecutive words), and where
// each question retrieves its own record.
export function median(values) {
  const v = (values || []).slice().sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
export function sampleStats(items) {
  const runs = items.map(x => x.run);
  const bodies = items.map(x => (x.run_body === undefined ? x.run : x.run_body));
  const pct = (n, d) => (d ? Math.round(1000 * n / d) / 10 : 0);
  const exact = items.filter(x => x.name && x.name.exact).length;
  const any = items.filter(x => x.name && x.name.any).length;
  return {
    questions: items.length,
    median_run: median(runs),
    within3: runs.filter(r => r <= 3).length,
    within3_pct: pct(runs.filter(r => r <= 3).length, runs.length),
    max_run: runs.length ? Math.max(...runs) : 0,
    median_body: median(bodies),
    body_max: bodies.length ? Math.max(...bodies) : 0,
    body_within2: bodies.filter(r => r <= 2).length,
    body_within2_pct: pct(bodies.filter(r => r <= 2).length, bodies.length),
    name_exact: exact,
    name_exact_pct: pct(exact, items.length),
    name_any: any,
    name_any_pct: pct(any, items.length),
    shapes: items.reduce((a, x) => { a[x.shape || '-'] = (a[x.shape || '-'] || 0) + 1; return a; }, {}),
  };
}

// The family a record belongs to: every record whose heading leaf is the same
// phrase - the same rule in another place, which the bank would call one group.
export function familiesFor(records) {
  const byLeaf = new Map();
  for (const r of records || []) {
    const key = words(headingLeaf(r)).join(' ');
    if (!key) continue;
    if (!byLeaf.has(key)) byLeaf.set(key, []);
    byLeaf.get(key).push(r.id);
  }
  return byLeaf;
}

async function retrievalOnly(out, reportOut) {
  const records = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const all = readAllCorpus();
  const byId = new Map(all.map(r => [r.id, r]));
  const byLeaf = familiesFor(all);
  const rulesCorpus = readAllCorpus('rules');
  const factionsCorpus = readAllCorpus('factions');
  const jevKey = credential(FAST_KEY_NAME);
  const items = records.filter(r => r.gold && r.gold[0] && r.gold[0][0]).map(rec => {
    const target = byId.get(rec.gold[0][0]) || null;
    const leaf = target ? words(headingLeaf(target)).join(' ') : '';
    const text = target ? String(target.heading || '') + '\n' + String(target.text || '') : '';
    return {
      source: 'generated', rec: rec.gold[0][0], q: rec.q,
      family: (leaf && byLeaf.get(leaf)) || [rec.gold[0][0]],
      heading: target ? target.heading : '',
      run: target ? longestSharedRun(rec.q, text) : 0,
      run_body: target ? longestSharedRun(rec.q, String(target.text || '')) : 0,
      name: target ? namePresence(rec.q, target) : { exact: false, any: false },
      rank: null, rank_family: null,
    };
  });
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const dual = await retrieveDual(item.q, {
        rulesCorpus, factionsCorpus, jevKey, terms: [], grepNet: 60, jevMax: 80,
        perSide: { rules: 10, factions: 10 },
      });
      const ids = (dual.all || []).map(s => s.id);
      item.rank = scoreRanks([[item.rec]], ids).rank;
      item.rank_family = scoreRanks([item.family], ids).rank;
    } catch (e) { /* counted as a miss */ }
    if ((i + 1) % 40 === 0) console.log('  ' + (i + 1) + '/' + items.length);
  }
  const score = key => {
    const hit = k => items.filter(x => x[key] != null && x[key] <= k).length;
    return {
      hit1: hit(1), hit5: hit(5), hit20: hit(20),
      mrr: items.length ? Math.round(1000 * items.reduce((s, x) => s + (x[key] ? 1 / x[key] : 0), 0) / items.length) / 1000 : 0,
    };
  };
  const report = { at: new Date().toISOString(), retrieval_only: true, questions: items.length, exact: score('rank'), family: score('rank_family'), items };
  fs.writeFileSync(reportOut, JSON.stringify(report, null, 1));
  const pct = (a, b) => b ? Math.round(1000 * a / b) / 10 + '%' : '-';
  console.log('questions ' + items.length);
  console.log('exact record:  hit@1 ' + report.exact.hit1 + ' (' + pct(report.exact.hit1, items.length) + ')  hit@5 ' + report.exact.hit5 + '  hit@20 ' + report.exact.hit20 + '  MRR ' + report.exact.mrr);
  console.log('same-leaf rule: hit@1 ' + report.family.hit1 + ' (' + pct(report.family.hit1, items.length) + ')  hit@5 ' + report.family.hit5 + '  hit@20 ' + report.family.hit20 + '  MRR ' + report.family.mrr);
  console.log('report -> ' + reportOut);
}

// --- the run ------------------------------------------------------------------
async function main() {
  const limit = Number(flag('limit', 100)) || 100;
  const out = path.resolve(flag('out', path.join(ROOT, 'workspace', 'dataset', 'generated.jsonl')));
  const reportOut = path.resolve(flag('report', path.join(ROOT, 'workspace', 'dataset', 'generated-report.json')));
  const only = flag('only', '');
  const ids = String(flag('ids', '')).split(',').map(s => s.trim()).filter(Boolean);
  const all = readAllCorpus();
  const reasons = {};
  for (const rec of all) {
    const reason = exclusionReason(rec);
    if (reason) reasons[reason] = (reasons[reason] || 0) + 1;
  }
  const eligible = all.filter(isRuleRecord);
  const sample = sampleRecords(all, ids.length ? ids.length : limit, { only, ids });
  const kinds = sample.reduce((a, r) => { a[r.kind] = (a[r.kind] || 0) + 1; return a; }, {});
  console.log('corpus ' + all.length + '  eligible ' + eligible.length + '  sample ' + sample.length + '  kinds ' + JSON.stringify(kinds));
  console.log('excluded: ' + JSON.stringify(reasons));
  if (has('dry')) { console.log(sample.map(r => r.id + '  [' + r.kind + ']  ' + r.heading).join('\n')); return; }

  // --retrieval-only re-measures a staged file without generating anything, and
  // scores each question twice: its exact record, and the FAMILY of records that
  // carry the same heading leaf. The corpus holds one rule in several places (the
  // core rule, its ability card, the FAQ copies), so the exact reading alone can
  // call a question failed for finding the right rule in the wrong copy.
  if (has('retrieval-only')) return retrievalOnly(out, path.resolve(flag('retrieval-report', path.join(path.dirname(out), 'generated-retrieval.json'))));
  const key = fastCredential() || credential(fastKeyName());
  if (!key) { console.error('no fast route key (OPENCODE_GO_API_KEY / RULES_FAST_* )'); process.exitCode = 1; return; }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const done = new Set();
  if (fs.existsSync(out)) {
    for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const rec = JSON.parse(line); if (rec.gold && rec.gold[0]) done.add(rec.gold[0][0]); } catch (e) { /* ignore */ }
    }
  }
  const items = [];
  let calls = 0, callSeconds = 0, empty = 0, unparsed = 0;
  const failures = [];
  const startedAt = Date.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // reasoning: 'none' is the empty-response fix, measured: the fast route's default
  // is reasoning_effort 'medium', and at max_tokens 1200 the model spent ALL 1,200
  // completion tokens on reasoning - finish_reason 'length', content empty (0 of
  // 1,200 left). The same call with reasoning off answered in 89 completion tokens
  // with a 368-character body. That is where the 65 empties on 100 calls came from,
  // and most of the 94.7 s of calls per record: routeText does escalate the budget
  // (1200 -> 2400 -> 4800) on a truncated JSON reply, so the caller waited for the
  // thinking instead of being told it had failed.
  const CALL = { json: true, reasoning: 'none' };
  const one = async rec => {
    if (done.has(rec.id)) { items.push({ rec: rec.id, q: '', shape: '', run: 0, run_body: 0, name: { exact: false, any: false }, rank: null, skipped: true }); return; }
    const t0 = Date.now();
    let text = '';
    for (let attempt = 1; attempt <= 3 && !text; attempt++) {
      try { text = String(await fastText(generationPrompt(rec), key, 1200, CALL) || ''); } catch (e) { text = ''; }
      if (!text) { empty++; await sleep(1200 * attempt); }
    }
    callSeconds += (Date.now() - t0) / 1000;
    calls++;
    const parsed = parseGenerated(text);
    if (!parsed.length) { unparsed++; failures.push(rec.id); return; }
    const target = String(rec.heading || '') + '\n' + String(rec.text || '');
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      const record = generatedRecord(rec, item, new Date().toISOString(), i + 1);
      fs.appendFileSync(out, JSON.stringify(record) + '\n');
      items.push({
        rec: rec.id, kind: rec.kind, heading: rec.heading, q: item.q, shape: item.shape,
        run: longestSharedRun(item.q, target),
        run_body: longestSharedRun(item.q, String(rec.text || '')),
        name: namePresence(item.q, rec),
        rank: null,
      });
    }
  };
  // The route is slow (tens of seconds a call) and free, so the sample runs a few
  // at a time: the wall time is what is reported, and the per-call seconds too.
  const queue = sample.slice();
  const CONCURRENCY = Math.max(1, Number(flag('concurrency', 1)) || 1);
  let finished = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const rec = queue.shift();
      await one(rec);
      finished++;
      if (finished % 10 === 0) console.log('  ' + finished + '/' + sample.length + ' records, ' + calls + ' calls, ' + ((Date.now() - startedAt) / 1000).toFixed(0) + 's wall');
    }
  }));
  // The sweep: the gateway drops a burst of replies under load (measured - the same
  // records answer in ~100 completion tokens when re-sent, so it is not the record
  // and not the prompt), and a retry that re-sends immediately just rejoins the
  // burst. After the pool, the records that produced nothing are asked again ONE at
  // a time with a real backoff, so a transient burst costs seconds instead of a
  // third of the sample.
  if (failures.length) {
    console.log('  sweeping ' + failures.length + ' records that came back empty, one at a time');
    const byId = new Map(sample.map(r => [r.id, r]));
    const again = failures.slice();
    for (let round = 1; round <= 3 && again.length; round++) {
      const wait = round === 1 ? 5 : round === 2 ? 20 : 60;
      await sleep(wait * 1000);
      const still = [];
      for (const id of again) {
        const rec = byId.get(id);
        if (!rec) continue;
        const before = items.length;
        await one(rec);
        if (items.length === before) still.push(id);
      }
      again.length = 0;
      again.push(...still);
      console.log('  sweep round ' + round + ': ' + again.length + ' still empty');
    }
  }
  // What the sweep recovered and what it could not: 'unparsed' is what is still
  // missing, 'swept' is what the serial second pass brought back.
  const swept = failures.length - again.length;
  const stillEmpty = again.slice();
  failures.length = 0;
  failures.push(...stillEmpty);
  const wallSeconds = (Date.now() - startedAt) / 1000;
  const seconds = wallSeconds;
  const unanswered = items.filter(x => !x.skipped && x.q);
  // Self-retrieval: the page's own call, the default mode. A low number here is a
  // bad generator, not a bad retriever - the record is the answer by construction.
  if (!has('no-retrieval')) {
    const rulesCorpus = readAllCorpus('rules');
    const factionsCorpus = readAllCorpus('factions');
    const jevKey = credential(FAST_KEY_NAME);
    for (let i = 0; i < unanswered.length; i++) {
      const item = unanswered[i];
      try {
        const dual = await retrieveDual(item.q, {
          rulesCorpus, factionsCorpus, jevKey, terms: [], grepNet: 60, jevMax: 80,
          perSide: { rules: 10, factions: 10 },
        });
        const ids = (dual.all || []).map(s => s.id);
        item.rank = scoreRanks([[item.rec]], ids).rank;
      } catch (e) { item.rank = null; }
      if ((i + 1) % 10 === 0) console.log('  retrieved ' + (i + 1) + '/' + unanswered.length);
    }
  }
  const stats = sampleStats(unanswered);
  const ranked = unanswered.filter(x => x.rank != null);
  const retrieval = {
    hit1: ranked.filter(x => x.rank <= 1).length,
    hit5: ranked.filter(x => x.rank <= 5).length,
    hit20: ranked.filter(x => x.rank <= 20).length,
    mrr: unanswered.length ? Math.round(1000 * unanswered.reduce((s, x) => s + (x.rank ? 1 / x.rank : 0), 0) / unanswered.length) / 1000 : 0,
  };
  const perRecord = sample.length ? seconds / sample.length : 0;
  const perRecordCall = sample.length ? callSeconds / sample.length : 0;
  const perQuestion = unanswered.length ? seconds / unanswered.length : 0;
  const report = {
    at: new Date().toISOString(),
    sample: sample.length, eligible: eligible.length, corpus: all.length,
    questions: unanswered.length, calls, empty_retries: empty, unparsed: failures.length, swept, failures,
    seconds: Math.round(seconds * 10) / 10,
    call_seconds: Math.round(callSeconds * 10) / 10,
    concurrency: CONCURRENCY,
    seconds_per_record: Math.round(perRecord * 100) / 100,
    call_seconds_per_record: Math.round(perRecordCall * 100) / 100,
    shapes_per_record: sample.length ? Math.round(100 * unanswered.length / sample.length) / 100 : 0,
    stats, retrieval,
    projection: {
      records: eligible.length,
      questions: Math.round(eligible.length * (unanswered.length / Math.max(1, sample.length))),
      calls: eligible.length,
      wall_hours_at_this_concurrency: Math.round(perRecord * eligible.length / 36) / 100,
      call_hours: Math.round(perRecordCall * eligible.length / 36) / 100,
    },
    exclusions: reasons,
    items: unanswered,
  };
  fs.writeFileSync(reportOut, JSON.stringify(report, null, 1));
  console.log('');
  console.log('questions ' + stats.questions + '   NAMES the rule: exact ' + stats.name_exact + ' (' + stats.name_exact_pct + '%), or a variant ' + stats.name_any + ' (' + stats.name_any_pct + '%)');
  console.log('run against the passage: median ' + stats.median_body + ', max ' + stats.body_max + ', within 2 (the corrected constraint) ' + stats.body_within2_pct + '%');
  console.log('run against heading+passage (the old statistic): median ' + stats.median_run + ', within 3 ' + stats.within3_pct + '%, max ' + stats.max_run + '   shapes ' + JSON.stringify(stats.shapes));
  console.log('self-retrieval: hit@1 ' + retrieval.hit1 + ' (' + (stats.questions ? Math.round(1000 * retrieval.hit1 / stats.questions) / 10 : 0) + '%)  hit@5 ' + retrieval.hit5 + '  hit@20 ' + retrieval.hit20 + '  MRR ' + retrieval.mrr);
  console.log('calls ' + calls + ' (' + report.empty_retries + ' empty retries, ' + report.unparsed + ' unparsed) in ' + report.seconds + 's wall / ' + report.call_seconds + 's of calls at concurrency ' + CONCURRENCY + ' (' + report.seconds_per_record + 's wall, ' + report.call_seconds_per_record + 's call per record)');
  console.log('full corpus: ' + report.projection.calls + ' calls, ~' + report.projection.wall_hours_at_this_concurrency + 'h wall at this concurrency / ~' + report.projection.call_hours + 'h of calls, ' + report.projection.questions + ' questions');
  console.log('report -> ' + reportOut);
  console.log('');
  console.log('--- ten questions ---');
  for (const item of unanswered.slice(0, 10)) {
    console.log('[' + item.shape + '] name ' + (item.name.exact ? 'exact' : item.name.any ? 'variant' : 'NONE') + '  body run ' + item.run_body + '  rank ' + (item.rank || '-') + '  ' + item.q + '\n    (target: ' + item.heading + ')');
  }
}
const FAST_KEY_NAME = fastKeyName();
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(e => { console.error(String((e && e.stack) || e)); process.exitCode = 1; });
}
