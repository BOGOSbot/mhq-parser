#!/usr/bin/env node
'use strict';
/**
 * Wiki phase B: write the planned corpus to a SEPARATE directory.
 *
 * The planner (src/wiki-plan.mjs) stays pure; this is the only thing that writes.
 * It never touches the live corpus and never touches the vector index: the target
 * is a directory of its own, and the local backend keeps its store inside it, so
 * a phase-B measurement cannot reach Upstash.
 *
 *   node src/wiki-build.mjs workspace/rules-corpus-wiki
 *
 * The output is the same file layout readAllCorpus() reads: one
 * <source>.json per source with a { sections: [...] } body, for the four rules
 * sources and the single factions source.
 */

import fs from 'fs';
import path from 'path';
import { planWiki, readPlanInput, distribution, chars } from './wiki-plan.mjs';

export const RULES_SOURCES = ['core-rules', 'rules-appendix', 'event-companion', 'core-stratagems'];
export const FACTION_SOURCES = ['factions-csv'];

// The section shape the corpus files carry. Only what readAllCorpus and the eval
// use: id, source, set, heading, ruleId, anchor, url, text, chars, hash.
export function toSection(rec) {
  return {
    id: rec.id, source: rec.source, set: rec.set, heading: rec.heading,
    ruleId: rec.ruleId || '', anchor: rec.anchor || '', hasAnchor: !!rec.hasAnchor,
    url: rec.url || '', text: rec.text, chars: chars(rec.text), hash: rec.hash || '',
    // The wiki fields ride along, so a later phase can render and follow them.
    parent: rec.parent || '', children: rec.children || [], links: rec.links || [],
    kind: rec.kind || '', idFrom: rec.idFrom || '', part: rec.part || 1, parts: rec.parts || 1,
  };
}

export function writeWikiCorpus(dir, data, opts) {
  const input = data || readPlanInput();
  const plan = planWiki(input, opts);
  fs.mkdirSync(dir, { recursive: true });
  // The rules half is four files by source; the faction half is ONE file that
  // carries its own per-faction 'source' label on every section (which is how the
  // live corpus is built - a datasheet's section says 'faction-ae' while the file
  // is factions-csv.json). Grouping the faction half by that label wrote 254 of
  // 6,829 records and dropped the rest on the floor.
  const byFile = new Map();
  for (const rec of plan.records) {
    const file = rec.set === 'rules' ? rec.source : FACTION_SOURCES[0];
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(toSection(rec));
  }
  const written = {};
  for (const source of RULES_SOURCES.concat(FACTION_SOURCES)) {
    const sections = byFile.get(source) || [];
    if (!sections.length) continue;
    fs.writeFileSync(path.join(dir, source + '.json'), JSON.stringify({ sections }, null, 0));
    written[source] = sections.length;
  }
  const manifest = {
    builtAt: new Date().toISOString(),
    linkBlockInText: plan.stats.blockInText !== false,
    records: plan.records.length,
    links: plan.stats.links,
    written,
    rules: distribution(plan.records.filter(r => r.set === 'rules')),
    factions: distribution(plan.records.filter(r => r.set !== 'rules')),
  };
  fs.writeFileSync(path.join(dir, 'wiki-build.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'wiki-build.mjs') {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node src/wiki-build.mjs <dir> [--links-out-of-text]'); process.exit(1); }
  // --links-out-of-text is the surgical variant: links stay on the record, the
  // block leaves the embedded text (see planWiki).
  const manifest = writeWikiCorpus(dir, null, { blockInText: !process.argv.includes('--links-out-of-text') });
  console.log(JSON.stringify(manifest, null, 2));
}
