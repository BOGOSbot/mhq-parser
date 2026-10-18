#!/usr/bin/env node
'use strict';
/**
 * bench-card-render: the full-corpus record render, timed (task-10).
 *
 * The old wiki render ran recordBody() once per record over the whole corpus,
 * and every datasheet record (its twin unitrules row and its ~n parts included)
 * rebuilt the same card from the CSV export. This script is that pass, measured:
 * records rendered, unit cards actually built, bytes written and milliseconds.
 *
 *   node tests/bench-card-render.mjs
 *
 * Pure: it reads the corpus and the CSV export, writes nothing.
 */
import { readAllCorpus } from '../src/rules-corpus.mjs';
import { recordBody, cardIndex } from '../src/wiki-cards.mjs';

let cardBuildCount = () => 0;
try {
  const unit = await import('../src/unit-card.mjs');
  if (typeof unit.cardBuildCount === 'function') cardBuildCount = unit.cardBuildCount;
} catch (e) { /* older module: the build count is simply not reported */ }

const corpora = {
  rules: readAllCorpus('rules'),
  factions: readAllCorpus('factions'),
  rulings: readAllCorpus('rulings'),
};
const all = corpora.rules.concat(corpora.factions, corpora.rulings);
const byId = new Map(all.map(r => [r.id, r]));
const index = cardIndex(byId);
const href = id => '#' + id;

const before = cardBuildCount();
const t0 = process.hrtime.bigint();
let bytes = 0;
for (const r of all) bytes += recordBody(r, { corpora, index, href }).length;
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const out = {
  records: all.length,
  cards: cardBuildCount() - before,
  bytes,
  ms: Math.round(ms),
  perRecordUs: Math.round(ms * 1000 / Math.max(1, all.length)),
};
console.log(JSON.stringify(out));
