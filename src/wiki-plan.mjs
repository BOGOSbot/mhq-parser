#!/usr/bin/env node
'use strict';
/**
 * The corpus wiki plan: what a link-first corpus would look like, computed over
 * the records already on disk.
 *
 * PHASE A IS A DRY RUN. This module never writes the corpus, never touches the
 * vector index and never calls a model: it takes the corpus it is given and
 * returns the records and links a rewrite would produce, with the id each one
 * would carry. `node src/wiki-plan.mjs` prints the report docs/corpus-wiki.md
 * records.
 *
 * The shape, as Mandal specified it:
 *
 *   - a record holds its OWN text and links to what sits under it, so a parent's
 *     vector carries the NAMES of its children - that is the retrieval bet;
 *   - overflow: try the whole section first. If it does not fit the budget, its
 *     subsections are emitted as their own chunks and the parent keeps a link to
 *     each; a child still too large is emitted as ANOTHER chunk rather than cut
 *     between headings;
 *   - a link is { to, title, kind }. `to` must resolve to a record in the same
 *     plan; a link that does not resolve is dropped and counted, never emitted.
 *
 * Ids are the fragile part (docs/corpus-wiki.md states the rule): an id derived
 * from a source key (a CSV row, an anchor) survives a re-chunk; an id derived
 * from heading TEXT moves when the heading moves, which is what the FAQ
 * promotion did to the bank. This plan renames nothing - it is additive - and
 * every record says which key its id came from.
 */

import fs from 'fs';
import path from 'path';
import { MAX_CHARS, csvRows, csvDir, htmlToText, readAllCorpus, splitSection, trimAbilityTail , corpusDir} from './rules-corpus.mjs';

export const WIKI_BUDGET = 2000;
export const LINK_BLOCK_MAX = 40;
const LINK_LINE = 46;

const clean = s => htmlToText(String(s == null ? '' : s)).replace(/\s+/g, ' ').trim();
export const chars = s => String(s || '').length;

// The live chunker measures the BODY and then prepends the heading
// (src/rules-corpus.mjs). The planner used to budget the WHOLE record text, a
// different rule: a heading of any length pushed records the live chunker keeps
// whole over it, and the rebuild re-split 35 of them into 30 chunks that the
// live corpus never had. A corpus rewrite may not re-chunk a record nothing
// asked it to touch, so the live rule lives here now.
export function bodyOf(rec) {
  const text = String(rec.text || '');
  const h = String(rec.heading || '');
  if (h && text.slice(0, h.length) === h) return text.slice(h.length).replace(/^\n+/, '');
  return text;
}
export function withHeading(rec, body) {
  const h = String(rec.heading || '');
  return h ? h + '\n' + body : body;
}
export const lastCrumb = h => { const p = String(h || '').split(' > ').filter(Boolean); return p.length ? p[p.length - 1] : String(h || ''); };

// The input's links first, then the derived ones, deduped by target: the build may
// not drop a link the record already carried, and may not duplicate one.
export function mergeLinks(a, b) {
  const out = [], seen = new Set();
  for (const l of (a || []).concat(b || [])) {
    const to = l && l.to;
    if (!to || seen.has(to)) continue;
    seen.add(to);
    out.push(l);
  }
  return out;
}

export function renderLinks(links, max) {
  const list = links || [];
  const shown = list.slice(0, max === undefined ? LINK_BLOCK_MAX : max);
  return {
    text: shown.map(l => '- ' + (l.kind ? l.kind + ': ' : '') + l.title).join('\n'),
    shown: shown.length,
    omitted: list.length - shown.length,
  };
}

// A corpus that has already been built carries its link block inside the text,
// and nothing marks it: re-building one appends the block again and re-splits the
// records it grew (measured: a rebuild over the live rules half gave 392 sections
// where there were 383). That is how a partial scrape - --set factions, --source
// - would corrupt the live corpus on its way to the build. The block is exactly
// what renderLinks rendered from the record's own links array, so it can be
// removed exactly; a record whose text or links changed by hand is left alone.
export function stripBuiltBlock(rec) {
  const text = String((rec && rec.text) || '');
  const links = (rec && rec.links) || [];
  if (!links.length) return text;
  const block = renderLinks(links, LINK_BLOCK_MAX).text;
  if (!block) return text;
  const suffix = '\n\n' + block;
  return text.endsWith(suffix) ? text.slice(0, text.length - suffix.length) : text;
}

// task-87/91/94: the page's 'SEE ALSO' block is a navigation list, and the card renders its
// CHILD entries as containers of their own (seeAlsoEntries below). Every block leaves the
// reader's text - DISPLAY only: the corpus and the index keep it, because its numbers
// ('01.05.01') are real search material. A block is the run of '<Title> <number>' pairs after
// the marker; it ends at the first blank line, because a record can hold more than one (the
// 'Duplicated Abilities' records do), and the text after it is another rule, not an entry.
export function stripSeeAlso(rec) {
  const text = String((rec && rec.text) || '');
  if (text.indexOf('\nSEE ALSO\n') === -1) return text;
  let out = text, i, guard = 0;
  while ((i = out.indexOf('\nSEE ALSO\n')) !== -1 && guard++ < 40) {
    const rest = out.slice(i + '\nSEE ALSO\n'.length);
    const nl = rest.search(/\n\s*\n/);
    out = nl === -1 ? out.slice(0, i) : out.slice(0, i) + out.slice(i + '\nSEE ALSO\n'.length + nl);
  }
  return out.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

// task-91/94: the entries of every SEE ALSO block. An entry whose number EXTENDS the
// record's own number is a CHILD of it ('02.05' -> '02.05.01') and the card renders it as
// its own container. An entry whose number does not match the header it sits under is a
// cross-reference the extraction carried in ('01.02' -> '17.02'): it is not a child, and it
// is removed outright (Mandal, 2026-10-18).
export function seeAlsoEntries(rec) {
  const text = String((rec && rec.text) || '');
  const mine = String((rec && rec.ruleId) || '').trim();
  const out = [];
  const marker = /\nSEE ALSO\n/g;
  let m;
  while ((m = marker.exec(text)) !== null) {
    const rest = text.slice(m.index + m[0].length);
    const seg = rest.split(/\n\s*\n/)[0] || '';
    const num = /\b(\d{2}(?:\.\d{2}){1,2})\b/g;
    let last = 0, n, first = true;
    while ((n = num.exec(seg)) !== null) {
      let title = seg.slice(last, n.index).replace(/^[^\w\[]+/, '').trim();
      last = num.lastIndex;
      // The widget wraps, so the first fragment can be the tail of a word ('...within' +
      // 'thin'). A one-word lower-case opener is that fragment, not a title.
      if (first && title && title.indexOf(' ') === -1 && /^[a-z]/.test(title)) title = '';
      first = false;
      if (!title) continue;
      out.push({ title: title, num: n[1], child: !!mine && (n[1] === mine || n[1].indexOf(mine + '.') === 0) });
    }
  }
  return out;
}
export function resolveLinks(links, has) {
  const kept = [];
  let dropped = 0;
  for (const l of links || []) {
    if (l && l.to && has(l.to)) kept.push(l);
    else dropped++;
  }
  return { links: kept, dropped };
}

export function splitBody(text, budget) {
  const s = String(text || '');
  if (chars(s) <= budget) return [s];
  return splitSection(s, budget).map(p => p.text);
}

// A trailing fragment of a few characters is not a record, it is debris in a
// vector index: the chunker leaves one behind when a body ends just past the
// budget. A part under MIN_PART is joined back onto the part before it, even
// though that one then runs a little over - the corpus's own floor is 32
// characters today and 77 on the rules half.
export const MIN_PART = 80;
// task-29: one record per unit in the READER's surfaces. A record the splitter cut
// into '(1/2)' and '(2/2)' is one rule, split for the judge's passage window
// (JUDGE_PASSAGE_CHARS); the corpus and the index keep the parts, because that is
// what the judge and the embedder read. This reassembles them for display only:
// the base heading (the part marker gone) and the parts' texts in order, each
// part's built link block stripped so the seam is the rule's own words. The part
// metadata cannot find the siblings (part/parts read 1/1 on every labelled chunk);
// the heading's own (i/m) is the truth and the ids are <base>~i. A wiki-plan split
// can leave the first part unlabelled - the sibling then says (2/2) and the group
// is found by the id.
// task-99: THE SIBLING LOOKUP, BUILT ONCE.
//
// mergeChunkParts rebuilt a 7,390-entry Map for EVERY record rendered, and did an O(n) find before
// that: measured, 1,141 ms of 1,591 ms for 200 record bodies (72%), about 36 s of a full-corpus
// render. The lookup is a property of the CORPUS, not of the record, so it is prepared once and
// passed in. `lookup` is optional: without it the function behaves exactly as it did.
export function chunkLookup(sections) {
  const list = Array.isArray(sections) ? sections : [];
  const byId = new Map();
  const byBase = new Map();
  for (const s of list) {
    if (!s || !s.id) continue;
    byId.set(s.id, s);
    const base = String(s.id).replace(/~\d+$/, '');
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(s);
  }
  return { byId, byBase, list };
}

export function mergeChunkParts(record, sections, lookup) {
  if (!record) return record;
  const list = Array.isArray(sections) ? sections : [];
  const byId = (lookup && lookup.byId) || null;
  const byBase = (lookup && lookup.byBase) || null;
  const id = String(record.id || '');
  const baseId = id.replace(/~\d+$/, '');
  const marker = /^(.*?) \((\d+)\/(\d+)\)$/.exec(String(record.heading || '').trim());
  let base = marker ? marker[1] : String(record.heading || '');
  let of = marker ? parseInt(marker[3], 10) : 0;
  if (!of) {
    // With a prepared lookup, the candidates are the records sharing this base id - NOT the whole
    // corpus. Falling back to `list` here was an O(corpus) scan per record: measured 108 s against
    // 16 s for the whole English corpus, because almost every record has no sibling at all.
    const candidates = byBase ? (byBase.get(baseId) || []) : list;
    const sib = candidates.find(s => s && String(s.id || '').indexOf(baseId + '~') === 0 && /\(\d+\/\d+\)$/.test(String(s.heading || '')));
    const mm = sib ? /^(.*?) \((\d+)\/(\d+)\)$/.exec(String(sib.heading)) : null;
    if (mm) { base = mm[1]; of = parseInt(mm[3], 10); }
  }
  if (!(of > 1)) return record;
  const at = byId || (() => { const m = new Map(); for (const s of list) if (s && s.id) m.set(s.id, s); return m; })();
  const parts = [];
  for (let i = 1; i <= of; i++) {
    const p = at.get(baseId + '~' + i) || (i === 1 ? at.get(baseId) : null);
    if (p) parts.push(p);
  }
  if (parts.length < 2) return record;
  const text = parts.map(p => stripBuiltBlock(p)).join('\n\n');
  return Object.assign({}, record, { heading: base, title: base, part: 1, parts: 1, text: text, mergedFrom: parts.map(p => p.id) });
}

export function splitWithin(text, budget, min) {
  const floor = min === undefined ? MIN_PART : min;
  const out = [];
  for (const p of splitBody(text, budget)) {
    if (out.length && chars(p) < floor) out[out.length - 1] = (out[out.length - 1] + '\n' + p).trim();
    else out.push(p);
  }
  return out;
}

function baseRecord(r, extra) {
  return Object.assign({
    id: r.id, set: r.set === 'rules' ? 'rules' : 'factions', source: r.source || '',
    heading: r.heading || '', ruleId: r.ruleId || '', anchor: r.anchor || '', hasAnchor: !!r.hasAnchor,
    url: r.url || '', hash: r.hash || '',
  }, extra || {});
}

export function readPlanInput(dir) {
  if (!dir) throw new Error('readPlanInput: a corpus directory is required - no silent fallback to the live corpus');
  const read = f => csvRows(fs.readFileSync(path.join(csvDir(dir), f), 'utf8'));
  return {
    rules: readAllCorpus('rules', dir),
    factions: readAllCorpus('factions', dir),
    abilities: read('Abilities.csv').map(a => ({ id: a.id, name: a.name, faction_id: a.faction_id || '', description: a.description || '', legend: a.legend || '' })),
    factionsCsv: read('Factions.csv').map(f => ({ id: f.id, name: f.name })),
  };
}

export function planWiki(data, opts) {
  const o = opts || {};
  // The retrieval bet is that a parent's vector carries its children's NAMES.
  // blockInText:false is the surgical variant: every link is still resolved and
  // kept on the record, the block is simply not part of the text that is
  // embedded - and with it out, a parent that only overflowed BECAUSE of the
  // block stays one record again.
  const blockInText = o.blockInText !== false;
  const rules = (data && data.rules) || [];
  const factions = (data && data.factions) || [];
  const abilities = (data && data.abilities) || [];
  const factionRows = (data && data.factionsCsv) || [];
  // The budget sizes records this plan CREATES (the index pages) - there is no
  // live rule for those. Whether an existing record is split is decided by the
  // live chunker's own cap, MAX_CHARS, on the body alone.
  const budget = (data && data.budget) || WIKI_BUDGET;

  const planned = [];
  const index = new Map();
  const stats = {
    budget, cap: MAX_CHARS, blockInText, links: 0, linksDropped: 0, linksOmitted: 0, linksInText: 0, split: 0,
    created: { rules: 0, factions: 0 }, largest: { chars: 0, id: '' },
    factionRules: 0, indexPages: 0,
  };
  const push = rec => {
    planned.push(rec);
    index.set(rec.id, rec);
    if (chars(rec.text) > stats.largest.chars) stats.largest = { chars: chars(rec.text), id: rec.id };
    return rec;
  };
  // Split by the live rule: when the BODY is over MAX_CHARS, and reassemble each
  // piece the way the live chunker does (heading, newline, body). A record whose
  // whole text is over WIKI_BUDGET because of its heading is left alone.
  const fit = (rec, set) => {
    const body = bodyOf(rec);
    if (chars(body) <= MAX_CHARS) return rec;
    const parts = splitWithin(body, MAX_CHARS, MIN_PART);
    rec.text = withHeading(rec, parts[0]);
    for (let i = 1; i < parts.length; i++) {
      push(Object.assign({}, rec, { id: rec.id + '~' + (i + 1), text: withHeading(rec, parts[i]), part: i + 1, parts: parts.length, links: [], children: [], created: true }));
      stats.created[set]++;
      stats.split++;
    }
    return rec;
  };
  // Every id the plan will contain, known before a single link is resolved: a
  // link list built while the plan is half-pushed drops everything it points at
  // (which is exactly what happened to the first draft of this file - 6,575
  // index links resolved to nothing because their targets came later).
  // The build's own records - the index pages, the faction rules, the parts it
  // split out - are REGENERATED, not read back. Counting their ids here would
  // suppress their own creation on a re-build (the faction rules are added only
  // when their id is not already known) and hand a part back as an extra child
  // of the parent whose heading it shares.
  // A record the build itself created carries the wiki fields - the build writes a
  // links array for every record it emits, and a scraped corpus has none. So
  // "built" is: it has a links array AND is one of the records the build
  // regenerates (an index page, a faction rule, or a part it split). A scraped
  // corpus's own chunker parts have no links array and stay records like any
  // other, which is what keeps a first build from a flat corpus identical to the
  // live one.
  // The faction rules the build regenerates are exactly the ones it derives from a
  // CSV ability row, and it stamps them idFrom 'csv-ability-id'. `kind` cannot be the
  // test: the SCRAPER's own army rules carry the same faction-rule# prefix (the six
  // Aeldari manoeuvres under Agile Manoeuvres) and the card loop below stamps them the
  // same kind, so a kind test reads them back as build products, refuses to re-emit
  // them and deletes six real records on the second pass (measured: 7,272 -> 7,265).
  const BUILT_FACTION_RULE = 'csv-ability-id';
  const isBuiltRecord = r => Array.isArray(r.links) &&
    (r.kind === 'index' || r.idFrom === BUILT_FACTION_RULE || Number(r.part || 1) > 1);
  const known = new Set();
  for (const r of rules) if (!isBuiltRecord(r)) known.add(r.id);
  for (const r of factions) if (!isBuiltRecord(r)) known.add(r.id);
  const factionRuleIds = [];
  for (const a of abilities) {
    if (!a || !a.id || !a.faction_id) continue;
    const text = clean(trimAbilityTail(clean(a.description)));
    // task-101: no 80-character floor. A faction army rule is a rule however short - 'This
    // unit's ranged attacks have [ASSAULT].' is Devastator Doctrine, 42 characters - and the
    // floor was leaving exactly 2 of the 71 export abilities with no faction rule at all.
    if (chars(text) < 20) continue;
    const id = 'faction-rule#' + a.id;
    if (known.has(id)) continue;
    known.add(id);
    factionRuleIds.push(id);
  }
  // Index pages, one per faction, sized so a page fits the budget.
  const factionName = new Map(factionRows.map(f => [f.id, clean(f.name)]));
  const byFaction = new Map();
  for (const r of factions) {
    // A record a previous build created is regenerated from the CSV, not read
    // back as a card: the index pages, the faction rules, and the parts of a
    // card that was split. Read back, they are listed twice, and the index
    // pages' own source label invents a faction called 'factions-csv'.
    if (isBuiltRecord(r) || r.kind === 'ability') continue;
    const f = String(r.faction || r.source || '').toLowerCase();
    if (!byFaction.has(f)) byFaction.set(f, []);
    byFaction.get(f).push(r);
  }
  // The CSV names a faction 'AE'; the scraped half names it 'faction-ae'. One
  // has to be turned into the other or a faction rule ends up belonging to no
  // faction at all and never appears on its index.
  const factionKeyOf = id => 'faction-' + String(id || '').toLowerCase();
  const rulesByFaction = new Map();
  for (const id of factionRuleIds) {
    const ability = abilities.find(a => 'faction-rule#' + a.id === id);
    const f = ability ? factionKeyOf(ability.faction_id) : '';
    if (!rulesByFaction.has(f)) rulesByFaction.set(f, []);
    rulesByFaction.get(f).push(id);
  }
  const pageDefs = new Map();
  for (const [faction, list] of byFaction) {
    const indexId = 'faction-index#' + faction;
    const perPage = Math.max(8, Math.floor((budget - 200) / LINK_LINE));
    const pages = Math.max(1, Math.ceil(list.length / perPage));
    const ids = [];
    for (let p = 0; p < pages; p++) ids.push(p === 0 ? indexId : indexId + '::' + (p + 1));
    for (const id of ids) known.add(id);
    pageDefs.set(faction, { indexId, ids, perPage, pages, list });
  }

  // --- the rules half: the tree the headings already describe -----------------
  const byHeading = new Map();
  for (const r of rules) {
    // A part a previous build split out carries its parent's heading: counted
    // here it would be handed back as an extra child of that parent, and the
    // re-build would grow the parent's link list every time it ran. A scraped
    // corpus's own chunker parts are not the build's and stay records here.
    if (isBuiltRecord(r)) continue;
    const h = String(r.heading || '');
    if (!byHeading.has(h)) byHeading.set(h, []);
    byHeading.get(h).push(r);
  }
  const childrenOf = new Map();
  for (const h of byHeading.keys()) {
    const parts = String(h).split(' > ').filter(Boolean);
    if (parts.length < 2) continue;
    const parentHeading = parts.slice(0, -1).join(' > ');
    if (!byHeading.has(parentHeading)) continue;
    if (!childrenOf.has(parentHeading)) childrenOf.set(parentHeading, []);
    // A definition is a leaf. The core rules define an ability called [ONE SHOT], and the
    // appendix opens a section with the same label: without this guard the appendix's
    // topics became children of the ability, which dragged them into 24 Core Abilities.
    if (/^ability-def#/.test(String(byHeading.get(parentHeading)[0].id || ''))) continue;
    for (const kid of byHeading.get(h)) if (!childrenOf.get(parentHeading).some(k => k.id === kid.id)) childrenOf.get(parentHeading).push(kid);
  }
  // A child names its parent too, not only the other way round: navigation is
  // walked in both directions, and a record whose parent field is empty cannot
  // be followed upward.
  const parentIdOf = new Map();
  for (const h of byHeading.keys()) {
    const parts = String(h).split(' > ').filter(Boolean);
    if (parts.length < 2) continue;
    const parentHeading = parts.slice(0, -1).join(' > ');
    if (!byHeading.has(parentHeading)) continue;
    if (/^ability-def#/.test(String(byHeading.get(parentHeading)[0].id || ''))) continue;
    for (const kid of byHeading.get(h)) parentIdOf.set(kid.id, byHeading.get(parentHeading)[0].id);
  }
  for (const r of rules) {
    // A part a previous build created is already a part of its parent: its heading
    // is the parent's, so the heading lookup would hand it the parent's children
    // and grow a block it must not have. It is emitted as it is.
    const isPart = isBuiltRecord(r);
    const kids = isPart ? [] : (childrenOf.get(String(r.heading || '')) || []);
    const wanted = kids.map(k => ({ to: k.id, title: lastCrumb(k.heading), kind: 'section' }));
    const resolved = resolveLinks(wanted, id => known.has(id));
    stats.linksDropped += resolved.dropped;
    const rec = baseRecord(r, {
      // A record that arrives with its own kind keeps it (the extractor's ability
      // records); only the scraped rules are classified here.
      kind: r.kind || (r.source === 'core-stratagems' ? 'stratagem' : 'rule'),
      parent: isPart ? String(r.parent || '') : (parentIdOf.get(r.id) || ''),
      // The record's own links come first and the derived children are added to them:
      // a link the extractor put in the text must survive the build, or the text and
      // the array part company the moment the build runs.
      children: resolved.links.map(l => l.to), links: mergeLinks(r.links, resolved.links),
      // Only a part the BUILD made keeps its part number; a scraped corpus's own
      // chunker parts are ordinary records here, which is what the live corpus
      // already holds (part 1/1 on every one of them).
      idFrom: 'source-key', part: isPart ? Number(r.part || 1) : 1, parts: isPart ? Number(r.parts || 1) : 1, text: stripBuiltBlock(r),
    });
    // The chunker sees the BODY only: the block is attached after the split, so a long
    // link list cannot force a split that leaves the record naming links its text no
    // longer shows. The block's own size is not the chunker's business.
    if (rec.links.length) stats.links += rec.links.length;
    if (blockInText && rec.links.length) { const b = renderLinks(rec.links.filter(l => l && l.kind !== 'section'), LINK_BLOCK_MAX); stats.linksOmitted += b.omitted; }
    fit(rec, 'rules');
    // The block is appended AFTER the chunk decision: it is not part of the body the
    // chunker measures, so a long link list cannot force a split that leaves the
    // record naming links its text no longer shows.
    if (rec.links.length && blockInText && String(rec.text).indexOf(renderLinks(rec.links.filter(l => l && l.kind !== 'section'), LINK_BLOCK_MAX).text) === -1) {
      rec.text = String(rec.text).replace(/\s+$/, '') + '\n\n' + renderLinks(rec.links.filter(l => l && l.kind !== 'section'), LINK_BLOCK_MAX).text;
    }
    rec.chars = chars(rec.text);
    push(rec);
  }

  // --- faction rules that have no record anywhere -----------------------------
  for (const id of factionRuleIds) {
    const ability = abilities.find(a => 'faction-rule#' + a.id === id);
    const text = clean(trimAbilityTail(clean(ability.description)));
    const rec = baseRecord({ id, source: 'factions-csv', heading: clean(ability.name) + ' - faction rule', set: 'factions' }, {
      kind: 'faction-rule', parent: '', children: [], links: [], idFrom: 'csv-ability-id',
      part: 1, parts: 1, text, created: true,
    });
    const factionKey = factionKeyOf(ability.faction_id);
    const def = pageDefs.get(factionKey);
    const wanted = def ? [{ to: def.indexId, title: factionName.get(factionKey) || factionKey, kind: 'faction' }] : [];
    const resolved = resolveLinks(wanted, x => known.has(x));
    stats.links += resolved.links.length;
    rec.links = resolved.links;
    rec.parent = resolved.links.length ? resolved.links[0].to : '';
    fit(rec, 'factions');
    if (blockInText && rec.links.length) { rec.text = String(rec.text).replace(/\s+$/, '') + '\n\n' + renderLinks(rec.links, 1).text; stats.linksInText++; }
    rec.chars = chars(rec.text);
    push(rec);
    stats.factionRules++;
    stats.created.factions++;
  }

  // --- the faction indexes, then the cards that point back at them ------------
  for (const [faction, def] of pageDefs) {
    const sorted = def.list.slice().sort((a, b) => String(a.heading || '').localeCompare(String(b.heading || '')));
    for (let p = 0; p < def.ids.length; p++) {
      const slice = sorted.slice(p * def.perPage, (p + 1) * def.perPage);
      const wanted = [];
      if (p === 0) {
        for (const id of (rulesByFaction.get(faction) || [])) wanted.push({ to: id, title: clean(index.has(id) ? index.get(id).heading : id), kind: 'rule' });
      }
      for (const r of slice) wanted.push({ to: r.id, title: clean(r.heading), kind: 'card' });
      if (def.ids.length > 1 && p === 0) for (let q = 1; q < def.ids.length; q++) wanted.push({ to: def.ids[q], title: 'index ' + (q + 1) + '/' + def.ids.length, kind: 'index' });
      const resolved = resolveLinks(wanted, x => known.has(x));
      stats.linksDropped += resolved.dropped;
      stats.links += resolved.links.length;
      const head = baseRecord({ id: def.ids[p], source: 'factions-csv', heading: (factionName.get(faction) || faction) + ' - index' + (def.ids.length > 1 ? ' ' + (p + 1) + '/' + def.ids.length : ''), set: 'factions' }, {
        kind: 'index', parent: p === 0 ? '' : def.indexId, children: def.ids.slice(1), links: resolved.links,
        idFrom: 'faction-id', part: p + 1, parts: def.ids.length, created: true,
        text: (factionName.get(faction) || faction).trim(),
      });
      fit(head, 'factions');
      // The list is attached after the chunk decision, as everywhere else: the parts a
      // split creates then carry no links, and the page that shows the list carries all
      // of them.
      head.text = String(head.text).replace(/\s+$/, '') + '\n' + renderLinks(resolved.links.filter(l => l && l.kind !== 'section'), 1000).text;
      stats.linksInText += Math.min(resolved.links.length, 1000);
      head.chars = chars(head.text);
      push(head);
      stats.indexPages++;
      stats.created.factions++;
    }
  }
  for (const [faction, def] of pageDefs) {
    for (const r of def.list) {
      const wanted = [{ to: def.indexId, title: (factionName.get(faction) || faction), kind: 'faction' }];
      const rec = baseRecord(r, {
        kind: String(r.id || '').split('#')[0], parent: def.indexId, children: [], links: mergeLinks(r.links, wanted),
        idFrom: 'csv-row-id', part: 1, parts: 1, text: stripBuiltBlock(r),
      });
      stats.links++;
      fit(rec, 'factions');
      // Same order as the rules half: chunk the body, then attach the block.
      if (blockInText && rec.links.length && String(rec.text).indexOf(renderLinks(rec.links.filter(l => l && l.kind !== 'section'), LINK_BLOCK_MAX).text) === -1) {
        rec.text = String(rec.text).replace(/\s+$/, '') + '\n\n' + renderLinks(rec.links.filter(l => l && l.kind !== 'section'), LINK_BLOCK_MAX).text;
        stats.linksInText++;
      }
      rec.chars = chars(rec.text);
      push(rec);
    }
  }

  // An ability record the extractor created is not a card of any faction: it is
  // emitted unchanged, keeping its id, kind and text. Without this it either
  // became a card of a pseudo-faction named after its source, or vanished.
  for (const r of factions) if (r.kind === 'ability') push(Object.assign({}, r, { text: String(r.text || '') }));

  return { records: planned, index, stats };
}

export function distribution(records) {
  const sizes = (records || []).map(r => chars(r.text)).sort((a, b) => a - b);
  const q = p => sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))] : 0;
  const buckets = { '0-250': 0, '251-500': 0, '501-1000': 0, '1001-1500': 0, '1501-2000': 0, '2000+': 0 };
  for (const s of sizes) {
    if (s <= 250) buckets['0-250']++;
    else if (s <= 500) buckets['251-500']++;
    else if (s <= 1000) buckets['501-1000']++;
    else if (s <= 1500) buckets['1001-1500']++;
    else if (s <= 2000) buckets['1501-2000']++;
    else buckets['2000+']++;
  }
  return { n: sizes.length, min: sizes[0] || 0, median: q(0.5), p90: q(0.9), max: sizes[sizes.length - 1] || 0, buckets };
}

export function idReport(existing, planned) {
  const before = new Set((existing || []).map(r => r.id));
  const after = new Set((planned || []).map(r => r.id));
  const kept = [];
  const moved = [];
  const added = [];
  for (const id of before) (after.has(id) ? kept : moved).push(id);
  for (const id of after) if (!before.has(id)) added.push(id);
  const newKinds = {};
  for (const id of added) { const k = id.split('#')[0]; newKinds[k] = (newKinds[k] || 0) + 1; }
  return { before: before.size, after: after.size, kept: kept.length, moved: moved.length, added: added.length, newKinds, movedSample: moved.slice(0, 10), addedSample: added.slice(0, 6) };
}

// Exact basename: 'test-wiki-plan.mjs' also ends with 'wiki-plan.mjs', and a
// test that imports this module must not run its report.
if (process.argv[1] && path.basename(process.argv[1]) === 'wiki-plan.mjs') {
  const input = readPlanInput(corpusDir());
  const plan = planWiki(input);
  const existing = input.rules.concat(input.factions);
  const afterRules = plan.records.filter(r => r.set === 'rules');
  const afterFactions = plan.records.filter(r => r.set !== 'rules');
  const battle = plan.records.find(r => r.heading === 'Battle Focus - faction rule');
  console.log(JSON.stringify({
    stats: plan.stats,
    ids: idReport(existing, plan.records),
    distBefore: { rules: distribution(input.rules), factions: distribution(input.factions) },
    distAfter: { rules: distribution(afterRules), factions: distribution(afterFactions) },
    createdKinds: plan.records.filter(r => r.created).reduce((m, r) => { const k = r.kind || r.id.split('#')[0]; m[k] = (m[k] || 0) + 1; return m; }, {}),
    largest: plan.records.slice().sort((a, b) => chars(b.text) - chars(a.text)).slice(0, 5).map(r => ({ id: r.id, chars: chars(r.text) })),
    battleFocus: battle ? { id: battle.id, chars: chars(battle.text), links: battle.links.map(l => l.to), head: battle.text.slice(0, 90) } : null,
    indexSample: plan.records.filter(r => r.kind === 'index').slice(0, 2).map(r => ({ id: r.id, chars: chars(r.text), links: r.links.length })),
  }, null, 2));
}
