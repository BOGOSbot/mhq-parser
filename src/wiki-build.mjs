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
import { readCorpus, textHash, ABILITY_DEFS } from './rules-corpus.mjs';

export const RULES_SOURCES = ['core-rules', 'rules-appendix', 'event-companion', 'core-stratagems', 'abilities'];
export const FACTION_SOURCES = ['factions-csv'];

// The section shape the corpus files carry. Only what readAllCorpus and the eval
// use: id, source, set, heading, ruleId, anchor, url, text, chars, hash.
export function toSection(rec) {
  return {
    id: rec.id, source: rec.source, set: rec.set, heading: rec.heading,
    ruleId: rec.ruleId || '', anchor: rec.anchor || '', hasAnchor: !!rec.hasAnchor,
    url: rec.url || '', text: rec.text, chars: chars(rec.text),
    // The hash decides what --ingest embeds (src/rules-corpus.mjs compares it to
    // the per-source state), so it has to describe the text actually written. A
    // carried source hash is a silent skip: the first phase-C dry run planned 6
    // rules upserts while 78 core-rules records had a new link block and the old
    // hash, i.e. the rebuild would have "succeeded" and left the old vectors in
    // the live index. Recomputed here, over the final text, the live convention.
    hash: textHash(rec.text),
    // The wiki fields ride along, so a later phase can render and follow them.
    parent: rec.parent || '', children: rec.children || [], links: rec.links || [],
    kind: rec.kind || '', idFrom: rec.idFrom || '', part: rec.part || 1, parts: rec.parts || 1,
  };
}

// The payload's own provenance, which the plan cannot know: /health publishes
// scrapedAt (when the copy was read) and the marker's lastUpdate (when the source
// said its data changed), and a trace records the same stamp - a trace against an
// undated corpus cannot be told from one against a stale corpus. An earlier build
// wrote only { sections }, so a rebuilt corpus served with updated:null.
//
// count and anchored are RECOMPUTED from the sections being written, not carried:
// the build adds and splits records, so the scrape's own numbers would be a stale
// claim about this corpus. bytes describes the raw page, which this does not touch.
export const STAMP_KEYS = ['source', 'set', 'url', 'edition', 'marker', 'scrapedAt', 'bytes'];
export function carryStamps(src, sections) {
  const list = sections || [];
  const out = {};
  for (const k of STAMP_KEYS) if (src && src[k] !== undefined) out[k] = src[k];
  out.count = list.length;
  out.anchored = list.filter(s => s.hasAnchor).length;
  out.sections = list;
  return out;
}

export function writeWikiCorpus(dir, data, opts) {
  if (!data && !dir) throw new Error('writeWikiCorpus: a corpus directory is required - no silent fallback to the live corpus');
  const input = data || readPlanInput(dir);
  const plan = planWiki(input, opts);
  fs.mkdirSync(dir, { recursive: true });
  // The rules half is four files by source; the faction half is ONE file that
  // carries its own per-faction 'source' label on every section (which is how the
  // live corpus is built - a datasheet's section says 'faction-ae' while the file
  // is factions-csv.json). Grouping the faction half by that label wrote 254 of
  // 6,829 records and dropped the rest on the floor.
  // One id, one file. The ability definitions are built into ability-defs.json by
  // their own builder, but they carry source 'core-rules' (their real page), so the
  // plan hands them back as core-rules records - writing them here as well is how
  // three builds turned 19 definitions into 57 duplicates and a red protocol. A
  // rebuild must replace, never append: ids owned by another builder are skipped,
  // and any remaining duplicate id is collapsed to its first record.
  // The stamps and the ids owned elsewhere come from the corpus this build is DERIVED
  // from, which is the target directory when a scrape re-shapes in place (the CLI)
  // and the live corpus when a caller builds into a scratch directory.
  const sourceDir = (opts && opts.sourceDir) || dir;
  const ownedElsewhere = new Set(((readCorpus(ABILITY_DEFS.name, sourceDir) || {}).sections || []).map(s => s.id));
  const byFile = new Map();
  const seen = new Set();
  for (const rec of plan.records) {
    if (ownedElsewhere.has(rec.id) || seen.has(rec.id)) continue;
    seen.add(rec.id);
    const file = rec.set === 'rules' ? rec.source : FACTION_SOURCES[0];
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(toSection(rec));
  }
  const written = {};
  for (const source of RULES_SOURCES.concat(FACTION_SOURCES)) {
    const sections = byFile.get(source) || [];
    if (!sections.length) continue;
    // Read the source payload before writing it: the stamps are the only thing the
    // build must carry from the corpus it is derived from.
    fs.writeFileSync(path.join(dir, source + '.json'), JSON.stringify(carryStamps(readCorpus(source, sourceDir), sections), null, 0));
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
