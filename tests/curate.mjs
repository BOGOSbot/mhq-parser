'use strict';
/**
 * Arm B's context curation, kept in tests/ because it is a hypothesis under
 * measurement, not a default. Four curations, in the order they were named:
 *
 *   1. drop near-identical records - the same rule arrives twice (core rules and
 *      the rules appendix both carry it) and a parent and its child overlap;
 *   2. cap characters per passage - a 2,000-character record spends the judge's
 *      and the writer's prompt on text the question does not turn on;
 *   3. put the title-anchored rule first - the record the question names by title
 *      is the one the reader asked about, whatever the reranker thought;
 *   4. drop the passages an earlier pass already passed over - the judge named
 *      the passages it considered in its why, and the rest were shown for nothing.
 *
 * The first three are pure functions of the list; the fourth reads the previous
 * attempt, which answerableFindings hands to the curator. Nothing here touches a
 * default: src/ only gained the seam that calls a curator when one is given.
 */
import { entityAnchors } from '../src/rules-corpus.mjs';

const norm = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
const tokens = s => new Set(norm(s).split(/[^a-z0-9]+/).filter(w => w.length >= 4));

// Same record, or the same rule under a parent and its child. Token overlap
// catches the paraphrase a re-scrape produces; the prefix test catches the
// container whose body starts with its child's text.
export function nearDuplicate(a, b) {
  const A = norm(a), B = norm(b);
  if (!A || !B) return false;
  if (A === B) return true;
  if (A.length >= 80 && B.length >= 80 && (A.startsWith(B) || B.startsWith(A))) return true;
  const ta = tokens(A), tb = tokens(B);
  if (!ta.size || !tb.size) return false;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.min(ta.size, tb.size) >= 0.85;
}

// Cut on a sentence, a line or a space - never mid-word, so the passage the
// judge reads still ends where the rule does.
export function capPassage(text, max) {
  const t = String(text == null ? '' : text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return (at > max * 0.6 ? cut.slice(0, at) : cut).trim() + ' ...';
}

export function makeCurator(opts) {
  const o = opts || {};
  const passageChars = o.passageChars || 1200;
  return function curate(findings, ctx) {
    const all = findings || [];
    // What the curator must not touch, computed before anything is dropped. The
    // record the question names by title is the one the reader asked about, and
    // the retriever's own first hit per half is its strongest evidence: the
    // pipeline already learned once that anchoring must not depend on the
    // reranker, and it must not depend on the curator either. A protected record
    // is never dropped, never capped and never reordered away.
    const anchored = new Set();
    if (o.corpora) {
      for (const half of Object.keys(o.corpora)) {
        for (const a of entityAnchors(ctx.question, o.corpora[half], 2, o.terms)) anchored.add(a.id);
      }
    }
    const firstHit = new Set();
    for (const half of new Set(all.map(x => x.set))) {
      const first = all.find(x => x.set === half);
      if (first) firstHit.add(first.id);
    }
    const protectedId = x => anchored.has(x.id) || firstHit.has(x.id);

    // 1. near-identical records, but never at the cost of a protected one
    const kept = [];
    for (const x of all) {
      if (!protectedId(x) && kept.some(k => nearDuplicate(k.text, x.text))) continue;
      kept.push(x);
    }
    let list = kept;

    // 4. what the previous pass already passed over. The judge's why names the
    // passages it weighed; a passage from that pass it never named was shown for
    // nothing, and showing it again costs the same slot.
    if (o.dropPassedOver && ctx && ctx.previous && ctx.previous.judge) {
      const why = String(ctx.previous.judge.why || '');
      const cited = new Set();
      const re = /\[(\d+)\]/g;
      let m;
      while ((m = re.exec(why)) !== null) cited.add(Number(m[1]));
      if (cited.size) {
        const byId = new Map((ctx.previous.findings || []).map(x => [x.id, x.n]));
        list = list.filter(x => protectedId(x) || !byId.has(x.id) || cited.has(byId.get(x.id)));
      }
    }

    // 3. the record the question names by title, first
    if (anchored.size) {
      list = list.slice().sort((a, b) => (anchored.has(b.id) ? 1 : 0) - (anchored.has(a.id) ? 1 : 0));
    }

    // 2. cap what each passage may spend - a protected record is left whole
    return list.map(x => (protectedId(x) ? x : Object.assign({}, x, {
      text: capPassage(x.text, passageChars),
      excerpt: capPassage(x.excerpt, passageChars),
    })));
  };
}
