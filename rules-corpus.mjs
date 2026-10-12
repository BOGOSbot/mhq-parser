#!/usr/bin/env node
'use strict';
/**
 * The rules corpus: Wahapedia scraped into citable sections, and pushed into
 * the vector index the /rules page searches.
 *
 *   node rules-corpus.mjs --scrape            fetch every source, write the corpus
 *   node rules-corpus.mjs --ingest            embed + upsert what changed
 *   node rules-corpus.mjs --stats             what is on disk and in the index
 *   node rules-corpus.mjs --source faqs       restrict --scrape/--ingest to one
 *
 * Why a corpus at all. The page used to answer by searching Wahapedia per
 * question: a query, a fetch, a lexical shortlist, then a model. It worked when
 * the question used the page's own words and failed otherwise - "Fall-back
 * Move 09.07" was invisible to a search for "Fell Back", and a rule the reader
 * could see on the page could not be retrieved at all. Scraping once and
 * embedding the result moves that work off the request path and gives the
 * retriever a chance to match meaning rather than spelling.
 *
 * Two shapes of source, one record type:
 *
 *   - anchored pages (core rules, appendix, event companion) carry an id on
 *     most headings, so a section is a real fragment and a citation can link
 *     straight to it;
 *   - card pages (FAQs, Chapter Approved) carry none, so sections are cut by
 *     size instead and a citation links the page. That is a weaker citation,
 *     and the record says so with hasAnchor:false rather than inventing one.
 *
 * A record is one thing a reader could be shown:
 *   { id, source, heading, ruleId, anchor, hasAnchor, url, text, chars }
 * The id is stable across scrapes - it is built from the source and the anchor,
 * not from position - which is what lets --ingest tell a changed section from a
 * new one and re-embed only what moved.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { FAST_ENDPOINT, FAST_MODEL, FAST_REASONING, FAST_TIMEOUT_MS, MODEL_ENDPOINT, MODEL, MODEL_REASONING, MODEL_TIMEOUT_MS, JEV_ENDPOINT, JEV_MODEL, anchorFor, credential } from './rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = process.env.RULES_CORPUS_DIR || path.join(__dirname, 'rules-corpus');
const SESSION_ID = crypto.randomUUID();

const UA = 'Mozilla/5.0 (compatible; mhq-rules/1)';

// The five sources this page answers from. 11th edition throughout: the
// edition is not a detail here, it is the difference between an answer and a
// confidently wrong one.
// Two sources were dropped after the version marker caught them. Sitting under
// the /wh40k11ed/ path is not proof of an edition: both the FAQs page and
// chapter-approved-2025-26 carry a metadata table reading "Edition 10", and
// neither page title carries the "[Warhammer 40,000 11th edition]" suffix the
// other three do. They were serving 10th-edition answers to 11th-edition
// questions. The 11th-edition mission deck is not lost - the event companion
// page carries "Chapter Approved 2026-27: Mission Deck, Expansion 11".
export const SOURCES = [
  { name: 'core-rules', set: 'rules', url: 'https://wahapedia.ru/wh40k11ed/the-rules/core-rules/' },
  { name: 'rules-appendix', set: 'rules', url: 'https://wahapedia.ru/wh40k11ed/the-rules/rules-appendix/' },
  { name: 'event-companion', set: 'rules', url: 'https://wahapedia.ru/wh40k11ed/the-rules/warhammer-event-companion/' },
];

// Pages that are 10th edition under an 11th-edition path. Kept here so the
// check reports them rather than silently forgetting they exist.
export const REJECTED_SOURCES = [
  { name: 'faqs', url: 'https://wahapedia.ru/wh40k11ed/the-rules/faqs/' },
  { name: 'chapter-approved', url: 'https://wahapedia.ru/wh40k11ed/the-rules/chapter-approved-2025-26/' },
];

// The faction half. Every question a player actually asks that the core rules
// cannot answer is in here - a datasheet's keywords, its wargear options, the
// wording of a stratagem. Scraped from Wahapedia's 11th-edition faction pages,
// one page per faction carrying all of its datasheets.
//
// The slugs come from the 40KAnalyzer package's faction table, whose links
// point at the 10th-edition pages; the path is identical under 11th. The
// package's own tables are NOT used: its source publications are edition 10 and
// it carries 10th-edition points and keywords, which is the cross-edition
// mistake this whole exercise is meant to avoid.
export const FACTION_SLUGS = [
  'adeptus-custodes', 'aeldari', 'astra-militarum', 'adepta-sororitas', 'adeptus-mechanicus',
  'imperial-agents', 'chaos-daemons', 'chaos-space-marines', 'death-guard', 'drukhari',
  'emperor-s-children', 'genestealer-cults', 'grey-knights', 'leagues-of-votann', 'necrons',
  'orks', 'imperial-knights', 'chaos-knights', 'space-marines', 't-au-empire',
  'adeptus-titanicus', 'thousand-sons', 'tyranids', 'unbound-adversaries', 'unaligned-forces',
  'world-eaters',
];

// The faction half comes from Wahapedia's own CSV export, not from scraping.
// The faction PAGES carry detachments, stratagems and FAQ but no datasheets at
// all - which is the thing players actually ask about - while the export has
// every datasheet, its keywords, wargear, abilities, composition and points,
// stamped with the export date and per-source edition. It is also the site's
// own data rather than our reading of its HTML, so there is no chrome to strip
// and no heading to mis-attribute.
export const CSV_FILES = [
  'Factions.csv', 'Source.csv', 'Last_update.csv',
  'Datasheets.csv', 'Datasheets_models.csv', 'Datasheets_models_cost.csv',
  'Datasheets_wargear.csv', 'Datasheets_abilities.csv', 'Datasheets_keywords.csv',
  'Datasheets_options.csv', 'Datasheets_unit_composition.csv', 'Datasheets_stratagems.csv',
  'Datasheets_detachment_abilities.csv', 'Datasheets_enhancements.csv', 'Datasheets_leader.csv',
  'Abilities.csv', 'Stratagems.csv', 'Detachments.csv', 'Detachment_abilities.csv', 'Enhancements.csv',
];

export const CSV_DIR = path.join(CORPUS_DIR, 'csv');

// One source for the whole export: it is downloaded and built as a unit, and a
// per-faction split would only fragment the refresh.
export const FACTIONS_CSV = {
  name: 'factions-csv',
  set: 'factions',
  url: 'https://wahapedia.ru/wh40k11ed/',
};

// Stratagems in the CSV with no faction are core rules, not faction rules: the
// core stratagems (Command Re-roll, Go to Ground, Fire Overwatch) and the
// stratagem key's move/shooting reference entries. Built from the same download
// as the faction half, but a separate source, because it belongs in the other
// namespace - filing it under "factions" is what put core rules in front of the
// reader wearing a FACTION tag.
export const CORE_STRATAGEMS = {
  name: 'core-stratagems',
  set: 'rules',
  url: 'https://wahapedia.ru/wh40k11ed/the-rules/core-rules/#Core-Stratagems',
  built: true,
};

export const ALL_SOURCES = SOURCES.concat([FACTIONS_CSV, CORE_STRATAGEMS]);

export function sourcesFor(setName) {
  if (!setName || setName === 'all') return ALL_SOURCES;
  return ALL_SOURCES.filter(s => s.set === setName);
}

export function namespaceFor(setName) {
  return setName === 'factions' ? 'factions' : 'rules';
}

// bge-m3 takes 8192 tokens, but a long passage dilutes its own embedding: the
// one paragraph that answers the question is averaged against three pages that
// do not. Cutting at ~2400 characters keeps a section specific enough to rank
// and long enough to hold a rule and its exception.
// Kept just under JUDGE_PASSAGE_CHARS on purpose. A stored record must never be
// longer than the judge is shown, or the judge ends up saying "no such ability
// is in the visible text" about text it was not given - which is exactly how a
// correct retrieval produced a wrong "I do not know".
const MAX_CHARS = 2000;
const MIN_CHARS = 80;

// --- fetching ---------------------------------------------------------------
export function fetchPage(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity' },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchPage(new URL(res.headers.location, url).href, timeoutMs));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeoutMs || 60000, () => req.destroy(new Error('timed out fetching ' + url)));
    req.on('error', reject);
  });
}

// --- the staleness marker ---------------------------------------------------
// Wahapedia stamps every rules page with a book table: Book | Kind | Edition |
// Version | Last update. It is the marker to trust, because it catches both
// kinds of drift - a page that moved on (version or date changed) and a page
// that was never the right one (edition is not 11).
//
// The page title carries a second, coarser signal: 11th-edition pages end in
// "[Warhammer 40,000 11th edition]", and the two 10th-edition pages sitting
// under the same path do not.
export const EDITION = 'wh40k11ed';

export function parseMarker(html) {
  const title = (String(html).match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  const text = htmlToText(String(html).replace(/<script[\s\S]*?<\/script>/gi, ' '));
  const m = text.match(/\b(Rulebook|Expansion|App)\s+(\d{1,2})(?:\s+(\d+\.\d+))?(?:\s+([A-Z][a-z]+ \d{4}))?/);
  const plain = decodeEntities(title).replace(/\s+/g, ' ').trim();
  return {
    title: plain,
    titleEdition: (plain.match(/Warhammer 40,000 (\d+)(?:st|nd|rd|th) edition/i) || [])[1] || '',
    kind: m ? m[1] : '',
    edition: m ? m[2] : '',
    version: m && m[3] ? m[3] : '',
    lastUpdate: m && m[4] ? m[4] : '',
  };
}

// A copy is stale when the live marker differs from the one recorded at scrape
// time. A copy is WRONG - not merely old - when the live marker says another
// edition, and that is reported separately because the fix is different.
export function markerStatus(stored, live) {
  if (!live || !live.edition) return { state: 'unknown', detail: 'no marker on the page' };
  if (String(live.edition) !== '11') return { state: 'wrong-edition', detail: 'page says edition ' + live.edition };
  if (!stored) return { state: 'never-scraped', detail: '' };
  const same = stored.version === live.version && stored.lastUpdate === live.lastUpdate && String(stored.edition) === String(live.edition);
  return same
    ? { state: 'current', detail: 'v' + (live.version || '-') + ' ' + (live.lastUpdate || '-') }
    : { state: 'stale', detail: 'was v' + (stored.version || '-') + ' ' + (stored.lastUpdate || '-') + ', now v' + (live.version || '-') + ' ' + (live.lastUpdate || '-') };
}

// --- html into text ---------------------------------------------------------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '-', ndash: '-', hellip: '...', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] !== undefined ? ENTITIES[n.toLowerCase()] : ' '));
}

// Block ends become newlines, everything else becomes a space. Tables survive
// as runs of cells rather than collapsing into one line of noise.
export function htmlToText(html) {
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol|blockquote|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- chrome removal ---------------------------------------------------------
// Wahapedia puts its navigation, its ad-removal widget and its tooltip
// templates in the same document as the rules. Left in, they are not merely
// noise: the section splitter attributes everything between two headings to the
// heading above it, so a page of Boosty login instructions lands under the
// heading "Disable Ads" and - worse - the mission scoring text that follows it
// lands there too. A third of the corpus was filed under a junk heading this
// way, and the retrieval looked worse than it was: the right passage was found,
// wearing a label no citation could use.
//
// The class names are Wahapedia's own, taken from ForTKSim's BeautifulSoup
// scraper, which solved this before us.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

const CHROME = [
  (tag, attrs) => tag === 'h1',
  (tag, attrs) => tag === 'script' || tag === 'style',
  (tag, attrs) => tag === 'div' && /\bid="siteNav"/.test(attrs),
  (tag, attrs) => tag === 'div' && /class="[^"]*(NavColumns2|page_breaker_ads)"/.test(attrs),
  // The Boosty login widget that removes ads. It lives inside
  // tooltip_templates, alongside the FAQ accordions that are real rules text,
  // so the container cannot be dropped whole - dropping it cost 53 questions.
  // The widget itself is addressed by its own ids instead. Left in, its
  // "E-mail: Pin code: Disable Ads" heading is what the section splitter
  // attaches to, and the rule that follows it is filed under an ad.
  (tag, attrs) => /\bid="(tooltip_contentLoginForm|disable-ads|btnDisableAds|btnCloseLogin)"/.test(attrs),
  (tag, attrs) => /class="[^"]*\blfWrapper\b/.test(attrs),
];

// Remove elements matching a predicate, with their contents. A tag scanner
// rather than a regex on the whole document: HTML nests, and a regex cannot
// find the matching close of a div.
export function dropElements(html, predicate) {
  const src = String(html);
  const re = /<(\/?)([a-zA-Z][\w:-]*)([^>]*)>/g;
  let out = '';
  let last = 0;
  let depth = 0;
  let dropTag = null;
  let m;
  while ((m = re.exec(src)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    if (depth === 0) {
      if (!closing && predicate(tag, attrs)) {
        out += src.slice(last, m.index);
        if (VOID_TAGS.has(tag) || /\/\s*$/.test(attrs)) {
          last = re.lastIndex;
        } else {
          depth = 1;
          dropTag = tag;
          last = re.lastIndex;
        }
        continue;
      }
    } else {
      if (!closing && tag === dropTag && !VOID_TAGS.has(tag)) depth++;
      else if (closing && tag === dropTag) {
        depth--;
        if (depth === 0) { dropTag = null; last = re.lastIndex; }
      }
    }
  }
  out += src.slice(last);
  return out;
}

export function stripChrome(html) {
  return dropElements(html, (tag, attrs) => CHROME.some(fn => fn(tag, attrs)));
}

// --- html into sections -----------------------------------------------------
// Every heading, with or without an id. A heading the page anchored becomes a
// citable fragment; one it did not stays a label on a page-level citation.
export function extractSections(html, source) {
  const page = String(html);
  const head = /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi;
  const marks = [];
  let m;
  while ((m = head.exec(page)) !== null) {
    const attrs = m[2] || '';
    const idMatch = attrs.match(/\bid="([^"]*)"/i);
    const raw = htmlToText(m[3]);
    if (!raw) continue;
    marks.push({
      at: m.index,
      end: head.lastIndex,
      anchor: idMatch ? idMatch[1] : '',
      heading: raw,
      level: parseInt(m[1], 10),
    });
  }

  // A heading that names several sections names a container, not a section. The
  // mission decks are the case in point: ten cards all headed "Primary Mission
  // deck", so the heading identifies none of them and a citation to it is
  // worthless. Counting repeats finds these without naming any of them.
  const titleCount = new Map();
  for (const mk of marks) {
    const t = mk.heading.replace(/\s+\d{2}(?:\.\d{2})*\s*$/, '').trim() || mk.heading;
    titleCount.set(t, (titleCount.get(t) || 0) + 1);
  }

  const out = [];
  // The heading hierarchy, kept as a stack so a section knows what it sits under.
  // The level was already being captured and then discarded, which is why a
  // mission card embedded as a bare paragraph: 'Primary Mission deck' says
  // nothing, but 'Primary Mission deck > Battlefield Dominance' says what it is,
  // and the difference is most of what an embedding has to work with.
  const stack = [];
  for (let i = 0; i < marks.length; i++) {
    const body = stripMarker(htmlToText(page.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].at : page.length)));
    let title = marks[i].heading.replace(/\s+\d{2}(?:\.\d{2})*\s*$/, '').trim() || marks[i].heading;
    const ruleId = (marks[i].heading.match(/\s(\d{2}(?:\.\d{2})*)\s*$/) || [])[1] || '';
    const level = marks[i].level;
    // An h1 is the page, not a rule on it: its body is the introduction and a
    // citation to it says nothing. Same for the marker table the page carries at
    // the top - it is how we date the copy, not something anyone asks about.
    if (level === 1) { stack.length = 0; continue; }
    // The export's own stamp, as a heading: "Book Kind Edition Version Last
    // update". It dates the copy; nobody asks about it.
    if (/^Book\s+Kind\s+Edition\s+Version\s+Last update/i.test(title)) continue;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const path = stack.map(s => s.title);
    // "FAQ" over eighty-four sections, "Errata" over fourteen: a real heading
    // that names a container rather than a rule. The content is worth keeping -
    // a clarification is a rule - but the label has to come from the content or
    // the citation is worthless. The same applies to a card under a container
    // heading, which is the mission decks.
    if (GENERIC_HEADING.test(title) || (titleCount.get(title) || 0) > 1) {
      title = deriveTitle(body) || title;
    }
    stack.push({ level, title });
    // A heading with no body is a label in a card, not a section.
    if (body.length < MIN_CHARS) continue;
    // A table of contents is navigation, not a rule. The core rules page carries
    // one under "Books", and its only content is the list of pages.
    if (/^(books|contents)$/i.test(title) && body.length < 400) continue;
    if (/^Book\s+Kind\s+Edition\s+Version\s+Last update/i.test(body)) continue;
    const anchor = marks[i].anchor || '';
    // The ancestors go in front of the body, so the vector is embedded with the
    // context it belongs to rather than as an orphan paragraph, and grep can
    // match a parent term.
    const full = path.length ? path.concat([title]).join(' > ') : title;
    const pieces = splitSection(body, MAX_CHARS);
    for (const piece of pieces) {
      out.push({
        source: source.name,
        title,
        path,
        heading: full,
        ruleId,
        anchor,
        hasAnchor: !!anchor,
        url: source.url + (anchor ? '#' + anchor : ''),
        text: full + '\n' + piece.text,
        part: piece.part,
        parts: pieces.length,
        chars: piece.text.length,
      });
    }
  }
  return out;
}

// Cut an over-long body on sentence ends, so a split never lands mid-rule.
// The generic policy, in order, and only as far down as it has to go:
//
//   1. the section as it stands, if it fits;
//   2. its paragraphs, because a paragraph is the author's own unit of thought;
//   3. its sentences, so a cut never lands mid-rule;
//   4. a hard cut on a space, for a weapon profile or a table row that is one
//      unbroken run of text.
//
// Cutting at a character count and then looking for a sentence end - which is
// what this used to do - ignores the structure the page already has, and lands
// unrelated text under one heading.
export function splitSection(text, max) {
  const t = String(text);
  if (t.length <= max) return [{ text: t, part: 0 }];
  const paras = t.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  if (paras.length > 1) {
    const out = [];
    let buf = '';
    const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
    for (const para of paras) {
      if (para.length > max) {
        flush();
        for (const piece of splitLong(para, max)) out.push(piece.text);
        continue;
      }
      if (buf && buf.length + para.length + 2 > max) flush();
      buf += (buf ? '\n\n' : '') + para;
    }
    flush();
    if (out.length) return out.map((piece, i) => ({ text: piece, part: i }));
  }
  return splitLong(t, max);
}

export function splitLong(text, max) {
  const t = String(text);
  if (t.length <= max) return [{ text: t, part: 0 }];
  const sentences = t.split(/(?<=[.!?])\s+/);
  const out = [];
  let buf = '';
  const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
  for (const s of sentences) {
    // A weapon profile or a table row can be one "sentence" longer than the
    // limit. Sentence splitting alone cannot cut it, and a record that cannot be
    // cut is one the judge cannot be shown whole - so it is cut on a space as a
    // last resort. Five records needed this.
    if (s.length > max) {
      flush();
      let rest = s;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max);
        if (cut < max * 0.5) cut = max;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      buf = rest;
      continue;
    }
    if (buf && buf.length + s.length + 1 > max) flush();
    buf += (buf ? ' ' : '') + s;
  }
  flush();
  return out.map((piece, i) => ({ text: piece, part: i }));
}

const GENERIC_HEADING = /^(faq|errata|see also|introduction|books|contents|disable ads|enable ads|subscribe|author|community|data export|color theme|nav|menu)$/i;

// A usable label for a section whose own heading names a container: the first
// question or sentence it holds, trimmed to something a citation can carry.
// The page carries its own version table - "Book Kind Edition Version Last
// update" - and as text it reads like prose. Left in, it becomes the title of
// whatever section holds it: the "Books" section derived its name from the stamp
// and every section under it inherited that as an ancestor, which is how
// "Book Kind Edition Version Last update..." ended up as part of a citation.
export function stripMarker(text) {
  return String(text)
    .replace(/^\s*Book\s+Kind\s+Edition\s+Version\s+Last update[\s\S]*?(?:\d{1,2}\s+[A-Z][a-z]+\s+\d{4}|\d{4}-\d{2}-\d{2})/i, '')
    .replace(/^[\s\u00a0]+/, '');
}

export function deriveTitle(text) {
  const flat = String(stripMarker(text)).replace(/\s+/g, ' ').replace(/^Show\s+/, '').trim();
  if (!flat || /^Book\s+Kind\s+Edition/i.test(flat)) return '';
  const q = flat.match(/^Q:\s*([^?]{10,110}\?)/);
  if (q) return q[1].trim();
  const first = flat.split(/(?<=[.!?])\s+/)[0] || flat;
  return first.length > 90 ? first.slice(0, 87).replace(/\s+\S*$/, '') + '...' : first;
}

export function sectionId(source, section) {
  const key = section.anchor || anchorFor(section.heading) || 'section';
  return source + '#' + key + (section.part ? '#' + (section.part + 1) : '');
}

export function textHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

// --- the CSV export ---------------------------------------------------------
// Pipe-delimited, with a BOM and HTML inside the description fields. A cell
// count over the header means an unescaped pipe in a description: the extra
// pieces belong to the last column rather than being dropped, because losing a
// stratagem's wording silently is worse than a slightly wrong cell.
// A record ends when it has as many cells as the header - not at a newline.
// Wahapedia's export contains literal newlines inside description fields, so a
// line-based split cuts a stratagem in half: the first line becomes a record
// with a name and no rules, and the remainder becomes a second record whose
// "name" is whatever word the description happened to break on. Eleven rows in
// Stratagems.csv alone are like this, and they produced stratagems whose id was
// the word "Shooting phase".
//
// Joining the pieces keeps the newline inside the cell it belongs to, so the
// cell count still works out: line A contributes n cells, line B contributes m,
// and the join yields n + m - 1.
export function csvRows(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!lines.length) return [];
  const head = lines[0].split('|').map(s => s.trim());
  const want = head.length;
  const toRow = line => {
    const cells = line.split('|');
    const row = {};
    for (let i = 0; i < head.length; i++) row[head[i]] = cells[i] === undefined ? '' : cells[i];
    if (cells.length > head.length) row[head[head.length - 1]] = cells.slice(head.length - 1).join('|');
    return row;
  };
  const out = [];
  let buf = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (buf === null) {
      if (!line.trim()) continue;
      buf = line;
    } else {
      buf += '\n' + line;
    }
    if (buf.split('|').length >= want) { out.push(toRow(buf)); buf = null; }
  }
  if (buf !== null) out.push(toRow(buf));
  return out;
}

// Twenty files in a row is enough to earn an ECONNRESET from the origin, so
// each one is retried with a growing pause. With allowCached, a file that
// cannot be fetched is kept from the previous download rather than failing the
// whole refresh - the export is stamped with one date, and a mixed-age set is
// still better than none, as long as the caller knows the stamp is the newest
// file's.
export async function downloadCsvExport(opts) {
  fs.mkdirSync(CSV_DIR, { recursive: true });
  const written = [];
  let failures = 0;
  for (const f of CSV_FILES) {
    const dest = path.join(CSV_DIR, f);
    let body = null;
    for (let attempt = 0; attempt < 3 && body === null; attempt++) {
      try {
        const r = await fetchPage('https://wahapedia.ru/wh40k11ed/' + f);
        if (r.status === 200) body = r.body;
      } catch (e) { /* retry */ }
      if (body === null) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
    if (body === null) {
      failures++;
      if (opts && opts.allowCached && fs.existsSync(dest)) { written.push(f + ' (kept from previous download)'); continue; }
      throw new Error(f + ' could not be downloaded after 3 attempts');
    }
    fs.writeFileSync(dest, body);
    written.push(f);
    await new Promise(r => setTimeout(r, 300));
  }
  if (failures && !(opts && opts.allowCached)) throw new Error(failures + ' files failed');
  return written;
}

const clean = s => htmlToText(String(s == null ? '' : s)).replace(/\s+/g, ' ').trim();

// An army-rule ability arrives on every datasheet that can use it - Battle
// Focus comes in carrying its whole Agile Manoeuvres card, six sub-rules that
// mostly cannot apply to the datasheet they land on (STAR ENGINES is
// VEHICLE-only on an infantry hero). The card is kept on its own: each
// manoeuvre has its own Stratagems.csv record, so the tail is dead weight here.
// The sub-card is introduced by a line in caps; everything after it, including
// the intro over it, is cut. Battle Focus rows are the one seen so far - the
// strip is driven by the marker, not the name, so the next one is caught too.
const ABILITY_TAIL_MARKER = /(?<![\w'])[A-Z][A-Z' -]{4,}(?=\s+[A-Z][A-Z' -]+\s+(?:TRIGGER|EFFECT):)/;
export function trimAbilityTail(desc) {
  const text = String(desc == null ? '' : desc);
  const m = ABILITY_TAIL_MARKER.exec(text);
  return m && m.index > 0 ? text.slice(0, m.index).trim() : text;
}

// One record per thing a reader could be shown. A datasheet is assembled from
// six tables because that is how the export splits it; the reader wants the
// datasheet, not the sixth of it that happens to live in one file.
export function buildFactionSections() {
  const read = f => csvRows(fs.readFileSync(path.join(CSV_DIR, f), 'utf8'));
  const lastUpdate = (read('Last_update.csv')[0] || {}).last_update || '';
  const factions = read('Factions.csv');
  const factionName = new Map(factions.map(f => [f.id, f.name]));
  const factionLink = new Map(factions.map(f => [f.id, f.link]));
  const sources = new Map(read('Source.csv').map(s => [s.id, s]));
  const abilityById = new Map();
  for (const a of read('Abilities.csv')) if (!abilityById.has(a.id)) abilityById.set(a.id, a);

  const byDatasheet = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.datasheet_id)) m.set(r.datasheet_id, []);
      m.get(r.datasheet_id).push(r);
    }
    return m;
  };
  const models = byDatasheet(read('Datasheets_models.csv'));
  const costs = byDatasheet(read('Datasheets_models_cost.csv'));
  const wargear = byDatasheet(read('Datasheets_wargear.csv'));
  const dAbilities = byDatasheet(read('Datasheets_abilities.csv'));
  const keywords = byDatasheet(read('Datasheets_keywords.csv'));
  const options = byDatasheet(read('Datasheets_options.csv'));
  const composition = byDatasheet(read('Datasheets_unit_composition.csv'));

  const out = [];
  const push = (id, source, heading, url, lines, ruleId) => {
    const text = lines.filter(Boolean).join('\n').trim();
    if (text.length < 40) return;
    const set = source === 'core-stratagems' ? 'rules' : 'factions';
    const anchor = set === 'rules' ? 'Core-Stratagems' : '';
    // The scraped sources are cut at MAX_CHARS and so must these be. A datasheet
    // is not one idea, it is a statline, a set of weapons, several abilities and
    // a points table, and embedding all of it as one vector dilutes every part
    // of it: a quarter of the faction records here are over the limit, and the
    // longest is 6,941 characters, so the ability that answers a question is
    // averaged against everything else on the card and stops ranking for it.
    const pieces = splitSection(text, MAX_CHARS);
    for (const piece of pieces) {
      out.push({
        // A core stratagem cites the core rules section, so it takes an anchor
        // even though the CSV has no headings to derive one from.
        id: pieces.length > 1 ? id + '~' + (piece.part + 1) : id,
        source, set,
        heading: pieces.length > 1 ? heading + ' (' + (piece.part + 1) + '/' + pieces.length + ')' : heading,
        ruleId: ruleId || '', anchor, hasAnchor: set === 'rules',
        url, text: piece.text, chars: piece.text.length, hash: textHash(piece.text),
      });
    }
  };

  for (const d of read('Datasheets.csv')) {
    const faction = factionName.get(d.faction_id) || d.faction_id;
    const src = sources.get(d.source_id);
    const url = d.link || (factionLink.get(d.faction_id) || '');
    const source = 'faction-' + String(d.faction_id || '').toLowerCase();
    const header = d.name + ' - ' + faction + (d.role ? ' (' + clean(d.role) + ')' : '');

    // A datasheet answers two unrelated kinds of question, and they are filed
    // separately. "What is a Tyrannofex's Toughness?" and "does it have the FRAME
    // keyword?" have nothing to do with each other, and as one record each is
    // half noise to the other: the statline dilutes the keyword search and the
    // keyword list dilutes the statline search. Two records, one citation.
    const stats = [header];
    if (src) stats.push('Source: ' + src.name + ' (edition ' + src.edition + (src.version ? ', v' + src.version : '') + ')');
    for (const m of models.get(d.id) || []) {
      stats.push('Model ' + m.name + ': M ' + m.M + ' T ' + m.T + ' Sv ' + m.Sv + (m.inv_sv ? ' inv ' + m.inv_sv + '+' : '') + ' W ' + m.W + ' Ld ' + m.Ld + ' OC ' + m.OC + (m.base_size ? ' base ' + m.base_size : ''));
    }
    for (const c of composition.get(d.id) || []) stats.push('Composition: ' + clean(c.description));
    for (const w of wargear.get(d.id) || []) {
      const prof = w.type === 'Ranged'
        ? 'Range ' + w.range + ' A ' + w.A + ' BS ' + w.BS_WS + ' S ' + w.S + ' AP ' + w.AP + ' D ' + w.D
        : 'A ' + w.A + ' WS ' + w.BS_WS + ' S ' + w.S + ' AP ' + w.AP + ' D ' + w.D;
      stats.push('Wargear ' + w.name + ' (' + w.type + '): ' + prof + (w.description ? ' - ' + clean(w.description) : ''));
    }
    for (const o of options.get(d.id) || []) stats.push('Option: ' + clean(o.description));
    const cost = (costs.get(d.id) || []).filter(c => c.cost && c.cost !== '').map(c => clean(c.description) + ' ' + c.cost + ' pts');
    if (cost.length) stats.push('Points: ' + cost.join('; '));
    if (d.damaged_description) stats.push('Damaged: ' + clean(d.damaged_description));
    push('datasheet#' + d.id, source, d.name, url, stats);

    const rules = [header + ' - keywords and abilities'];
    const kw = (keywords.get(d.id) || []).map(k => k.keyword).filter(Boolean);
    if (kw.length) rules.push('Keywords: ' + kw.join(', '));
    for (const ab of dAbilities.get(d.id) || []) {
      const ref = ab.ability_id ? abilityById.get(ab.ability_id) : null;
      const name = clean(ab.name) || (ref ? clean(ref.name) : '');
      const desc = trimAbilityTail(clean(ab.description) || (ref ? clean(ref.description) : ''));
      if (name || desc) rules.push('Ability' + (ab.type ? ' (' + ab.type + ')' : '') + ': ' + (name ? name + ' - ' : '') + desc);
    }
    push('unitrules#' + d.id, source, d.name + ' - keywords and abilities', url, rules);
  }

  for (const s of read('Stratagems.csv')) {
    // Boarding Actions is a different game with its own stratagems, and it rides
    // in this file with no faction id like the core ones. The corpus is 11th
    // edition matched play, so it is out of scope - the same reason the 10th
    // edition sources were dropped rather than mixed in.
    if (/boarding actions/i.test(s.type || '')) continue;
    const isCore = !s.faction_id;
    const faction = factionName.get(s.faction_id) || '';
    if (isCore) {
      const lines = [
        s.name + ' - core stratagem',
        'Type: ' + clean(s.type),
        'CP: ' + s.cp_cost,
        'Turn: ' + clean(s.turn) + '  Phase: ' + clean(s.phase),
        clean(s.legend),
        clean(s.description),
      ];
      push('core-stratagem#' + s.id, 'core-stratagems', s.name, CORE_STRATAGEMS.url, lines);
      continue;
    }
    const lines = [
      s.name + ' - ' + faction + ' stratagem',
      'Type: ' + clean(s.type),
      'CP: ' + s.cp_cost,
      'Turn: ' + clean(s.turn) + '  Phase: ' + clean(s.phase),
      s.detachment ? 'Detachment: ' + clean(s.detachment) : '',
      clean(s.legend),
      clean(s.description),
    ];
    push('stratagem#' + s.id, 'stratagems', s.name + ' (' + faction + ')', factionLink.get(s.faction_id) || '', lines);
  }

  const detachmentAbilities = new Map();
  for (const a of read('Detachment_abilities.csv')) {
    if (!detachmentAbilities.has(a.detachment_id)) detachmentAbilities.set(a.detachment_id, []);
    detachmentAbilities.get(a.detachment_id).push(a);
  }
  for (const d of read('Detachments.csv')) {
    const faction = factionName.get(d.faction_id) || d.faction_id;
    const lines = [
      d.name + ' - ' + faction + ' detachment',
      'Detachment points: ' + (d.dp || '-') + '  Force disposition: ' + (d.force_disposition || '-'),
      clean(d.legend),
      ...(detachmentAbilities.get(d.id) || []).map(a => 'Ability: ' + clean(a.name) + ' - ' + clean(a.description)),
    ];
    push('detachment#' + d.id, 'detachments', d.name + ' (' + faction + ')', factionLink.get(d.faction_id) || '', lines);
  }

  for (const e of read('Enhancements.csv')) {
    const faction = factionName.get(e.faction_id) || e.faction_id;
    const lines = [
      e.name + ' - ' + faction + ' enhancement',
      'Cost: ' + e.cost + ' pts' + (e.upgrade === 'true' ? ' (upgrade)' : ''),
      'Detachment: ' + clean(e.detachment),
      clean(e.legend),
      clean(e.description),
    ];
    push('enhancement#' + e.id, 'enhancements', e.name + ' (' + faction + ')', factionLink.get(e.faction_id) || '', lines);
  }

  return { lastUpdate, sections: out };
}

// The export lists some things more than once under different ids with the same
// wording - the stratagem key's move and shooting entries each appear twice, and
// one of the pair is written with a non-breaking hyphen (U+2011) so the strings
// are not even equal. Left alone they fill the top of a result list with copies
// of one record. Deduping on the normalised text collapses the copies and keeps
// per-faction records distinct, because those differ in the text itself.
export function dedupeKey(section) {
  const norm = s => String(s || '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return norm(section.heading) + '|' + norm(section.text);
}

export function dedupeSections(sections) {
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const s of sections) {
    const key = dedupeKey(s);
    if (seen.has(key)) { dropped++; continue; }
    seen.add(key);
    out.push(s);
  }
  return { sections: out, dropped };
}

export function buildFactionCorpus() {
  const raw = buildFactionSections();
  const deduped = dedupeSections(raw.sections);
  const built = { lastUpdate: raw.lastUpdate, sections: deduped.sections, dropped: deduped.dropped };
  const ids = new Set(built.sections.map(s => s.id));
  if (ids.size !== built.sections.length) {
    throw new Error('duplicate ids: ' + built.sections.length + ' sections, ' + ids.size + ' ids');
  }
  const stamp = new Date().toISOString();
  const marker = { kind: 'CSV export', edition: '11', version: '', lastUpdate: built.lastUpdate };
  // Two files from one download, because they belong in two namespaces and the
  // reader is told which half a finding came from.
  const halves = [
    { source: FACTIONS_CSV, set: 'factions', sections: built.sections.filter(s => s.set === 'factions') },
    { source: CORE_STRATAGEMS, set: 'rules', sections: built.sections.filter(s => s.set === 'rules') },
  ];
  let main = null;
  for (const half of halves) {
    const payload = {
      source: half.source.name,
      set: half.set,
      url: half.source.url,
      edition: EDITION,
      marker,
      scrapedAt: stamp,
      count: half.sections.length,
      anchored: half.sections.filter(s => s.hasAnchor).length,
      sections: half.sections,
    };
    writeCorpus(half.source.name, payload);
    if (half.set === 'factions') main = payload;
  }
  return { count: built.sections.length, marker, factions: halves[0].sections.length, core: halves[1].sections.length, dropped: built.dropped, main };
}

// --- the corpus on disk -----------------------------------------------------
export function corpusPath(name) {
  return path.join(CORPUS_DIR, name + '.json');
}

export function writeCorpus(name, payload) {
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  fs.writeFileSync(corpusPath(name), JSON.stringify(payload));
  return corpusPath(name);
}

export function readCorpus(name) {
  try { return JSON.parse(fs.readFileSync(corpusPath(name), 'utf8')); }
  catch { return null; }
}

export function readAllCorpus(setName) {
  const all = [];
  for (const s of sourcesFor(setName)) {
    const c = readCorpus(s.name);
    if (c && Array.isArray(c.sections)) {
      // The set travels with the section so a merged candidate list can still
      // say which half a finding came from - the reader is shown both.
      for (const sec of c.sections) all.push(Object.assign({ set: s.set, source: s.name }, sec));
    }
  }
  return all;
}

// --- scraping ---------------------------------------------------------------
// An id has to be unique, and the obvious scheme is not. A page with no
// heading ids - the FAQs, Chapter Approved - derives every key from the heading
// text, and those pages repeat headings: the same card title over a dozen
// entries. Two sections then share an id, the second upsert overwrites the
// first, and the corpus quietly loses a fifth of itself while the index reports
// success. A repeated base key gets a suffix in document order instead. The
// first scrape lost 120 of 604 sections this way.
export function assignIds(sourceName, raw) {
  const seen = new Map();
  return raw.map(s => {
    const base = sectionId(sourceName, s);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const id = n === 1 ? base : base + '~' + n;
    return Object.assign({}, s, { id, hash: textHash(s.text) });
  });
}

export async function scrapeSource(source) {
  const r = await fetchPage(source.url);
  if (r.status !== 200) throw new Error(source.name + ' returned HTTP ' + r.status);
  const marker = parseMarker(r.body);
  const sections = assignIds(source.name, extractSections(stripChrome(r.body), source));
  const ids = new Set(sections.map(s => s.id));
  if (ids.size !== sections.length) {
    throw new Error(source.name + ': ' + sections.length + ' sections but only ' + ids.size + ' unique ids');
  }
  const payload = {
    source: source.name,
    set: source.set || 'rules',
    url: source.url,
    edition: EDITION,
    marker,
    scrapedAt: new Date().toISOString(),
    bytes: r.body.length,
    count: sections.length,
    anchored: sections.filter(s => s.hasAnchor).length,
    sections,
  };
  writeCorpus(source.name, payload);
  return payload;
}

export async function scrapeAll(only, setName) {
  // Built sources come from the CSV download, not from a page, and must not be
  // scraped - their content is written by buildFactionCorpus.
  const list = (only ? sourcesFor(setName).filter(s => s.name === only) : sourcesFor(setName)).filter(s => !s.built);
  const out = [];
  for (const s of list) {
    // Three pages in a row is enough to earn an ECONNRESET from the origin, and
    // a retry costs four seconds against a re-scrape costing the whole run.
    let payload = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3 && !payload; attempt++) {
      try {
        payload = await scrapeSource(s);
      } catch (e) {
        lastError = e;
        if (attempt < 2) await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
      }
    }
    if (!payload) {
      // A slug that has no page is not a reason to abandon the other
      // twenty-five. "Unbound Adversaries" and "Unaligned Forces" are entries in
      // the faction table, not armies with a page of their own. The previous
      // corpus is left alone rather than overwritten with an empty one, so a
      // rate-limited refresh cannot silently gut the corpus.
      const previous = readCorpus(s.name);
      const kept = previous && previous.count ? previous.count : 0;
      console.log('  ' + s.name + ' could not be fetched (' + String((lastError && lastError.message) || lastError) + ')' + (kept ? ' - keeping the ' + kept + ' sections already on disk' : ''));
      if (kept) { out.push(previous); continue; }
      const payload = { source: s.name, set: s.set, url: s.url, skipped: String((lastError && lastError.message) || lastError), scrapedAt: new Date().toISOString(), count: 0, anchored: 0, sections: [] };
      writeCorpus(s.name, payload);
      out.push(payload);
      continue;
    }
    out.push(payload);
  }
  return out;
}

// --- grep, and Jev over the result ------------------------------------------
// Retrieval without an embedder, for the cases an embedder is worst at. A rule
// id, a hyphenated term, a keyword in capitals: these are exact strings, and a
// vector is a lossy summary of them. "Fall-back Move 09.07" is one grep away
// and was invisible to both the old lexical pass and the first dense query.
//
// Grep is cheap enough to be generous - a few hundred sections cost nothing to
// scan - so it hands back a wide net and Jev picks from it. That division is
// the same one the page already uses: Jev decides, it does not write.
const STOP = new Set(['that', 'this', 'these', 'those', 'with', 'from', 'have', 'has', 'had', 'does', 'what', 'when', 'where', 'which', 'while', 'would', 'could', 'should', 'about', 'after', 'before', 'into', 'onto', 'your', 'their', 'there', 'then', 'than', 'them', 'they', 'same', 'also', 'only', 'must', 'rule', 'rules', 'unit', 'units', 'model', 'models', 'turn', 'game', 'warhammer', 'edition', 'mean', 'means', 'work', 'works']);

export function grepTerms(question) {
  const words = String(question == null ? '' : question)
    .toLowerCase()
    .replace(/[^a-z0-9' -]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP.has(w));
  return Array.from(new Set(words));
}

// A section scores on where its terms appear, not only how often: a term in the
// heading is what the section is about, a term in the body may be incidental.
export function grepCorpus(question, corpus, limit) {
  return grepWithTerms(grepTerms(question), corpus, limit, question);
}

// A term matches at the start of a word, not anywhere inside one. A substring
// test reads 'embark' inside 'disembark', and that is not a corner case: the
// question 'can Asurmen re-embark after shooting' is translated with both
// 'embark' and 'disembark' among its terms, and the Disembarking rule - 1960
// characters against Embarking's 728, and full of the longer word - outranked
// the rule the question was actually asking about. A word-start match still
// reads 'move' in 'movement' and 'moves', which is the recall the substring
// test was there for, and reads 'embark' only where that word begins.
export function termCount(text, term) {
  const t = String(term);
  if (!t) return 0;
  const hay = String(text);
  let n = 0;
  let at = hay.indexOf(t);
  while (at !== -1) {
    if (at === 0 || !/[a-z0-9]/.test(hay.charAt(at - 1))) n++;
    at = hay.indexOf(t, at + 1);
  }
  return n;
}

export function termPresent(text, term) {
  return termCount(text, term) > 0;
}

// The same scoring, with the terms supplied. That is what lets a rewritten
// query - a question turned into the words the rulebook actually uses - run
// through the identical path as the raw one.
export function grepWithTerms(terms, corpus, limit, phraseText) {
  const phrase = String(phraseText == null ? '' : phraseText).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // How concentrated each term is, so a hit can be worth what it means. 'move'
  // sits in a third of the corpus and separates nothing; 'Embark' sits in a
  // handful of sections and decides the half of them. Each occurrence is worth
  // log(1 + N/df): a common word stays at ~+1 as before, a rare one climbs
  // several points, so the term that answers cannot be steamrolled by sections
  // that merely repeat the vocabulary of movement.
  const N = Math.max(1, (corpus || []).length);
  const df = new Map();
  for (const sec of corpus || []) {
    const low = (String(sec.heading || '') + '\n' + String(sec.text || '')).toLowerCase();
    for (const raw of terms) {
      const t = String(raw).toLowerCase().trim();
      if (!t || t.indexOf(' ') !== -1) continue;
      // indexOf first: it is the cheap test, and a word-start match implies a
      // substring match. Only a hit pays for the scan.
      if (low.indexOf(t) !== -1 && termPresent(low, t)) df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const weight = t => {
    const d = df.get(t) || 0;
    return d ? Math.log(1 + N / d) : 0;
  };
  const scored = (corpus || []).map(sec => {
    const heading = String(sec.heading || '').toLowerCase();
    const text = String(sec.text || '').toLowerCase();
    const ruleId = String(sec.ruleId || '').toLowerCase();
    let score = 0;
    for (const raw of terms) {
      const t = String(raw).toLowerCase().trim();
      if (!t) continue;
      // A multi-word phrase is the strongest signal there is when it lands.
      if (t.indexOf(' ') !== -1) {
        if (text.indexOf(t) !== -1) score += 12;
        if (heading.indexOf(t) !== -1) score += 20;
        continue;
      }
      const w = weight(t);
      if (!w) continue;
      // The same word-start rule as the document frequency above, or a term
      // would be worth a weight it was never counted for.
      score += w * termCount(text, t);
      if (termPresent(heading, t)) score += 8 * w;
      if (ruleId && termPresent(ruleId, t)) score += 4 * w;
    }
    // The whole question, verbatim, is a strong signal when it happens - and a
    // hyphen or a plural is enough to stop it happening.
    if (phrase.length > 12 && text.indexOf(phrase) !== -1) score += 25;
    return { sec, score: Math.round(score * 10) / 10 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter(x => x.score > 0).slice(0, limit || 40).map(x => Object.assign({ score: x.score }, x.sec));
}

// What each candidate is asked. Two wordings were measured. The answer-hood one
// below ('state the rule that answers') ranked Asurmen's Tactical Acumen fifth
// for an embark question - the passage grants the Normal move after shooting
// that the question turns on, without mentioning embarking. A looseness test
// ('bears on answering') scored every passage higher and pushed the same
// passage to twentieth, so it made the case it was written for worse and is not
// the default. The retriever's own strongest hit is protected separately in
// retrieveWide; opts.ask still accepts a replacement for experiments.
export function defaultAsk(i, c, question) {
  return {
    type: 'noul',
    instructions: 'Does passage ' + i + ' (' + c.heading + ') state the rule that answers: ' + question,
    criteria: { true: 'It answers the question', false: 'It does not' },
  };
}

// One call, one yes/no per candidate, the same shape rules.mjs uses. Batched so
// a wide net costs one request rather than forty.
export const JEV_STATE_CHARS = Number(process.env.RULES_JEV_STATE_CHARS) || 40000;

export async function jevRank(question, candidates, key, opts) {
  const o = opts || {};
  const top = (candidates || []).slice(0, o.max || 50);
  if (!top.length) return [];
  const questions = {};
  const ask = o.ask || defaultAsk;
  top.forEach((c, i) => {
    questions['p' + i] = ask(i, c, question);
  });
  // How much of each candidate Jev is shown. It used to be a flat 700 characters
  // in a state cut at 40000, and the two together were a trap: past about fifty
  // candidates the tail of the list was sliced off the state while the questions
  // still asked about every passage, so Jev scored passages it had not been shown
  // - and widening the net, the thing a hard question is supposed to benefit
  // from, silently made the reranker less informed. The budget is now spent
  // evenly over however many candidates there are, so every one of them is
  // visible and only the depth of each shrinks.
  const stateChars = o.stateChars || JEV_STATE_CHARS;
  const per = Math.max(200, Math.min(700, Math.floor(stateChars / Math.max(1, top.length)) - 80));
  const state = 'Question: ' + question + '\n\nCandidate passages:\n\n' + top.map((c, i) =>
    'PASSAGE ' + i + ' - ' + c.heading + (c.ruleId ? ' (' + c.ruleId + ')' : '') + '\n' + String(c.text).slice(0, per)
  ).join('\n\n');
  const body = JSON.stringify({ model: JEV_MODEL, state, questions });
  const res = await new Promise((resolve, reject) => {
    const u = new URL(JEV_ENDPOINT);
    const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'Content-Length': Buffer.byteLength(body) } }, r => {
      const chunks = []; r.on('data', d => chunks.push(d));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let obj = null;
        try { obj = JSON.parse(text); } catch { /* an error page, not an answer set */ }
        resolve({ status: r.statusCode, obj, text });
      });
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('jev timed out'))); req.end(body);
  });
  if (!res) throw new Error('jev returned nothing');
  // The free tier answers rate limits with a JSON error body that has no
  // answers field, which used to surface as the useless 'jev returned no
  // answers'. Name the wall instead.
  if (res.status === 429) throw new Error('jev rate limited (HTTP 429, free tier) - try again later');
  if (!res.obj || !res.obj.answers) throw new Error('jev returned no answers: HTTP ' + res.status + ' ' + String(res.text || '').slice(0, 120));
  return top.map((c, i) => {
    const a = res.obj.answers['p' + i];
    return Object.assign({ jev: a && typeof a.noul === 'number' ? a.noul : 0 }, c);
  }).sort((a, b) => b.jev - a.jev);
}

// --- query expansion --------------------------------------------------------
// Grep is exact, so it fails on exactly the questions people ask: a player says
// "fell back", the rulebook says "fall-back move". The words are the problem,
// not the corpus. The model already knows both vocabularies - it is the model
// that writes the answers - so it is asked to translate the question into the
// terms a literal search should look for, and nothing else.
//
// This is deliberately not a re-query loop. It rewrites the query once, before
// any retrieval happens, so it costs one call and no extra round trip through
// the corpus.
export function expansionPrompt(question) {
  return [
    'You convert a Warhammer 40,000 11th edition rules question into search terms for a literal text search over the rulebook.',
    '',
    'The rulebook uses formal wording; the question may be casual or use an older edition\'s term.',
    'Give the words that would actually appear in the rules text.',
    '- Include the official term when the question uses a colloquial one.',
    '- Include a multi-word phrase as one string when it is likely to appear verbatim.',
    '- Do not include the question itself, and do not explain anything.',
    '- 6 to 12 terms, most specific first.',
    '',
    'Reply with JSON only: {"terms": ["...", "..."]}',
    '',
    'Question: ' + question,
  ].join('\n');
}

export function parseTerms(text) {
  const raw = String(text == null ? '' : text).replace(/```[a-z]*/gi, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    const terms = Array.isArray(obj.terms) ? obj.terms : [];
    return terms.map(t => String(t).trim()).filter(t => t.length >= 3 && t.length <= 60).slice(0, 14);
  } catch { return []; }
}

// One OpenAI-compatible call, used by the writer, the rewriter and the judge.
// Pure inference: none of them writes anything, which is why all three keep
// working when the vector index is out of write budget. The caller picks the
// route, so the judge can run on a small fast model while the answer keeps the
// model that engages with half-found rules.
// The model reasons before it answers and both are billed to the same budget, so
// a cap that looks generous for the answer can be consumed entirely by the
// thinking. When that happens the reply comes back empty with
// finish_reason 'length', and every caller sees a silent failure - an empty
// translation, a missing verdict, an answer that was never written. Two French
// questions failed this way while their retrieval had found the right rule.
//
// So an empty reply that stopped on length is retried with double the budget
// rather than returned.
async function routeText(route, prompt, key, maxTokens, opts) {
  if (!key) return '';
  let budget = maxTokens || 900;
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = JSON.stringify(Object.assign({
      model: route.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: budget,
    }, route.reasoning ? { reasoning_effort: route.reasoning } : {}));
    const res = await new Promise((resolve, reject) => {
      const u = new URL(route.endpoint);
      const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'Content-Length': Buffer.byteLength(body) };
      // The opencode.ai chat gateway routes on a session id and answers 400
      // MissingSessionID without one. Any stable id does - it is routing, not
      // authentication - so one per process is enough.
      if (/opencode\.ai$/i.test(u.hostname)) headers['x-opencode-session'] = SESSION_ID;
      const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname, headers }, r => {
        const chunks = []; r.on('data', d => chunks.push(d));
        r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
      });
      req.on('error', reject);
      req.setTimeout(route.timeout || 180000, () => req.destroy(new Error('the model timed out')));
      req.end(body);
    });
    const choice = res && res.choices && res.choices[0];
    const content = String((choice && choice.message && choice.message.content) || '');
    last = content;
    if (!choice) return content;
    // A reply that stopped on the token limit is only usable when a cut cannot
    // break it. Prose that had to be cut is still prose; a JSON object cut
    // mid-string is not an object at all - and that is what a judge returned
    // once, which the caller read as 'nothing parseable' and answered "I do not
    // know" over findings that were fine. Those get a bigger budget instead.
    const truncated = choice.finish_reason === 'length';
    const json = !!(opts && opts.json);
    if (!truncated || (content.trim() && !json)) return content;
    budget *= 2;
  }
  return last;
}

// The writer's route: the cited answer the reader sees.
export async function modelText(prompt, key, maxTokens, opts) {
  return routeText({ endpoint: MODEL_ENDPOINT, model: MODEL, reasoning: MODEL_REASONING, timeout: MODEL_TIMEOUT_MS }, prompt, key, maxTokens, opts);
}

// The fast route: everything that only decides or rewrites - the translated
// question, the search terms, the verdict. Same call, a different model behind
// it, and the same route as the writer until RULES_FAST_* names another.
export async function fastText(prompt, key, maxTokens, opts) {
  return routeText({ endpoint: FAST_ENDPOINT, model: FAST_MODEL, reasoning: FAST_REASONING, timeout: FAST_TIMEOUT_MS }, prompt, key, maxTokens, opts);
}

// A small model writes a paragraph into a JSON string and does not always escape
// the line breaks in it, which JSON.parse refuses as a bad control character.
// The shape of the object is right and only the escaping is missing, so the
// control characters inside strings are escaped rather than the whole verdict
// thrown away: an unparseable verdict is read as "I do not know", and the
// findings it was judging were fine.
var BACKSLASH = String.fromCharCode(92);
export function repairJsonStrings(text) {
  var out = '';
  var inString = false;
  var escaped = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) { escaped = false; out += ch; continue; }
    if (ch === '"') { inString = false; out += ch; continue; }
    if (ch === BACKSLASH) { escaped = true; out += ch; continue; }
    // JSON.stringify of one character is its JSON escape, quotes and all.
    out += text.charCodeAt(i) < 32 ? JSON.stringify(ch).slice(1, -1) : ch;
  }
  return out;
}

export function parseJsonObject(text) {
  const raw = String(text == null ? '' : text).split(String.fromCharCode(96)).join(' ').trim();
  for (let start = raw.indexOf('{'); start !== -1; start = raw.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const slice = raw.slice(start, i + 1);
          try { return JSON.parse(slice); } catch { /* escaping may be missing */ }
          try { return JSON.parse(repairJsonStrings(slice)); } catch { break; }
        }
      }
    }
  }
  return null;
}

export async function expandQuery(question, key, opts) {
  if (!key) return [];
  return parseTerms(await fastText(expansionPrompt(question), key, 900));
}

// A French question against an English corpus. Grep cannot match a word that is
// not there, and neither can an embedding: "blessures mortelles" is nothing like
// "mortal wounds" in vector space. So the question is translated into the terms
// an English search would use, once, before any retrieval happens.
//
// The glossary contributes what it knows exactly; the model carries the rest.
// Every term is a guess until it matches something, which is why they are only
// ever used as search terms and never shown as translations.
export function frenchExpansionPrompt(question) {
  return [
    'You convert a French Warhammer 40,000 11th edition rules question into English search terms for a literal text search over the English rulebook and datasheets.',
    '',
    'The English rulebook uses its own wording; the French question may be casual or use French community shorthand.',
    '- Give the English words that would actually appear in the English rules text.',
    '- Translate French keywords to their official English keywords (mot-clé -> keyword).',
    '- Keep unit, stratagem and detachment names in English, spelled as the English datasheets spell them.',
    '- Include a multi-word phrase as one string when it is likely to appear verbatim.',
    '- Do not include the question itself, and do not explain anything.',
    '- 8 to 16 terms, most specific first.',
    '',
    'Reply with JSON only: {"terms": ["...", "..."]}',
    '',
    'Question: ' + question,
  ].join('\n');
}

// --- the question in English ------------------------------------------------
// A French question against an English corpus fails twice if only its keywords
// are translated. Grep needs English words - that is the keywords' job - but
// the judge and the writer need the question itself: 'Est-ce qu'Asurmen peut
// embarquer apres avoir tire' and 'asurmen embark shoot' are not the same
// question, and a judge shown the second one grades a question nobody asked.
// So the whole question is translated into natural English, and the keyword
// list is asked for in the same call - one request, both products.
//
// The translator is handed the glossary pairs that matched, as the official
// wording to use. Without them it invents its own translations of game terms
// (embarquement -> 'boarding', mot-cle -> 'key word'), and a fabricated term
// searches for nothing.
export function glossaryHits(question, limit) {
  const out = [];
  try {
    const g = JSON.parse(fs.readFileSync(path.join(__dirname, 'glossary-fr-en.json'), 'utf8'));
    const upper = String(question).toUpperCase();
    for (const e of g.entries) {
      // The hand-set 'rule' category holds core-rules vocabulary the MFM
      // cannot pair but a real question exposes: embarquement is Embark.
      if (e.category === 'datasheet' || e.category === 'detachment' || e.category === 'enhancement' || e.category === 'rule') {
        if (e.fr && upper.indexOf(e.fr.toUpperCase()) !== -1) out.push({ fr: e.fr, en: e.en });
      }
      if (out.length >= (limit || 20)) break;
    }
  } catch { /* glossary optional */ }
  return out;
}

export function translationPrompt(question, hits) {
  const pairs = (hits || []).map(h => '- ' + h.fr + ' -> ' + h.en).join('\n');
  return [
    'You prepare a Warhammer 40,000 11th edition rules question for an English rules index.',
    '',
    'Detect the language of the question, then translate it into natural English if it is not already English.',
    '- Translate the WHOLE question, as a question: keep its meaning and its detail, do not reduce it to keywords.',
    '- If it is already English, return it unchanged.',
    '- Use the official English terms below wherever they apply, and do not invent a translation for a term that is listed.',
    '- Keep unit, stratagem, detachment and keyword names spelled as the English datasheets spell them.',
    '- Also give 6 to 12 search terms: the words and short phrases that would appear verbatim in the English rules text.',
    '',
    'Reply with JSON only: {"lang": "<two-letter code>", "translated": "<the whole question, in English>", "terms": ["...", "..."]}',
    '',
    pairs ? 'Official terms (French -> English), use exactly:' : 'No glossary terms matched this question.',
    pairs,
    '',
    'Question: ' + question,
  ].join('\n');
}

// The model answers with a language, not always with a code: 'French',
// 'francais', 'fr-FR'. All three mean fr, and an unnormalised 'french' left the
// page showing 'und' and the answer defaulting to English.
const LANG_ALIASES = {
  french: 'fr', francais: 'fr', 'fran\u00e7ais': 'fr', english: 'en', anglais: 'en',
  spanish: 'es', espagnol: 'es', german: 'de', allemand: 'de', italian: 'it',
  portuguese: 'pt', portugais: 'pt', dutch: 'nl', neerlandais: 'nl',
};
export function normalizeLang(value) {
  const s = String(value || '').toLowerCase().trim().replace(/[^a-z]/g, '');
  if (!s) return '';
  if (Object.prototype.hasOwnProperty.call(LANG_ALIASES, s)) return LANG_ALIASES[s];
  return s.slice(0, 2);
}

export function parseTranslation(text) {
  const obj = parseJsonObject(text);
  if (!obj) return { lang: '', translated: '', terms: [] };
  return {
    lang: normalizeLang(obj.lang),
    translated: String(obj.translated || '').trim(),
    terms: Array.isArray(obj.terms) ? obj.terms.map(t => String(t).trim()).filter(t => t.length >= 3 && t.length <= 60).slice(0, 14) : [],
  };
}

// Is this worth a translation call? The page no longer asks the reader which
// language they typed in, so the decision is made here: letters English does not
// use, or a function word from a nearby language, is enough to look. A question
// in plain English without either is left alone and costs no call.
const FOREIGN_HINTS = /[àâäçéèêëîïôöûüùÿñßœ]|\b(le|la|les|des|une|un|est|que|qui|quoi|pour|avec|sur|dans|je|peut|doit|peuvent|combien|est-ce|quand|comment|quelle?|quel|mon|ma|mes|son|sa|ses|figurine|figurines|unité|unités|règle|règles|dé|el|los|las|una|puede|cuando|como|der|die|das|und|oder|wenn|kann|ein|eine)\b/i;
export function looksForeign(text) {
  return FOREIGN_HINTS.test(String(text || ''));
}

export async function translateQuestion(question, key, opts) {
  const o = opts || {};
  const hits = glossaryHits(question);
  const glossary = hits.map(h => h.en);
  // English that looks English: no call, no translation, nothing to correct.
  if (!o.force && !looksForeign(question)) return { lang: 'en', translated: '', terms: glossary, glossary };
  const parsed = parseTranslation(await fastText(translationPrompt(question, hits), key, 3000, { json: true }));
  // One term spelled twice is one term. The glossary supplies ASURMEN and the
  // model supplies Asurmen, and a case-sensitive dedupe keeps both, so the same
  // word is scored against the same text twice - a doubled weight nobody chose.
  const seenTerm = new Set();
  const terms = glossary.concat(parsed.terms).filter(t => {
    const k = String(t).toLowerCase();
    if (seenTerm.has(k)) return false;
    seenTerm.add(k);
    return true;
  }).slice(0, 16);
  return { lang: parsed.lang || '', translated: parsed.translated, terms, glossary };
}

// Kept for the callers that only want search terms.
export async function frenchTerms(question, key, opts) {
  const out = await translateQuestion(question, key, Object.assign({ force: true }, opts));
  return out.terms;
}


// --- judging ----------------------------------------------------------------
// Grading a retrieval without ground-truth section ids. Real questions do not
// come with an answer key, and mapping a Reddit answer to a rule id by hand is
// the work this is meant to avoid. The judge is asked the narrow question
// instead: do these passages state the rule that answers it? It is told to
// judge only what is written, because a model that answers from memory will
// mark a retrieval correct that never contained the rule.
// How much of each passage the judge is shown. It used to be 700 characters,
// which is a quarter of an Asurmen datasheet: his Battle Focus ability and the
// Agile Manoeuvres that answer a question about moving after shooting start
// around character 940, so the judge was asked whether the passages stated a
// rule while being shown none of the part that did. It answered honestly and
// wrongly, and the pipeline duly said it did not know.
//
// A judge blind to most of the evidence is not a cautious judge, it is a
// misinformed one. It now sees as much as the compiler does, and a passage that
// is still cut says so, so a "not stated" conclusion is at least made about text
// that was shown.
export const JUDGE_PASSAGE_CHARS = 2400;
export const JUDGE_TOTAL_CHARS = 60000;

export function passageForJudge(p, i, cap) {
  const full = String(p.text || '');
  const cut = full.length > cap;
  const head = '[' + (i + 1) + '] ' + (p.set === 'factions' ? 'Faction rules' : 'Core rules') + ' - '
    + (p.faction ? p.faction + ' - ' : '') + p.heading + (p.ruleId ? ' (' + p.ruleId + ')' : '');
  const note = cut ? ' [TRUNCATED - showing the first ' + cap + ' of ' + full.length + ' characters]' : '';
  return head + note + '\n' + full.slice(0, cap);
}

export function judgePrompt(question, passages, opts) {
  const o = opts || {};
  const per = o.perPassage || JUDGE_PASSAGE_CHARS;
  const total = o.totalChars || JUDGE_TOTAL_CHARS;
  // A long list must not starve each passage, and a long passage must not starve
  // the rest of the list.
  const cap = Math.max(400, Math.min(per, Math.floor(total / Math.max(1, passages.length))));
  return [
    'You are grading a retrieval system for Warhammer 40,000 11th edition rules.',
    '',
    'Question: ' + question,
    '',
    'Retrieved passages:',
    passages.map((p, i) => passageForJudge(p, i, cap)).join('\n\n'),
    '',
    'Judge only what is written above, not what you know about the game.',
    'A passage marked TRUNCATED has more text that is not shown; if the rule could be in the unseen part, say so in "why" instead of concluding it is absent.',
    'Reply with JSON only:',
    '{"rules_question": true, "answered": true, "confidence": "high", "widen": "both", "passages": [1,2], "why": "the reason, in two or three sentences"}',
    '- rules_question: is this a question about 40k rules at all? Some are about tournaments, paint or the subreddit.',
    '- answered: do the passages state the rule needed to answer it? Partial coverage is not answered.',
    '- confidence: how sure you are of that verdict. "high" when a passage states the rule outright, "med" when the passages are about the right subject but do not settle it, "low" when the retrieval looks off-topic or the question names something absent from the passages. Always give one of the three.',
    '- widen: only when answered is false, which half to search deeper next. "rules" if it is the core rules that are missing, "faction" if it is a datasheet, stratagem or enhancement, "both" if you cannot tell which. Always give one of the three.',
    '- passages: the numbers that carry the answer, best first; [] if none do.',
    '- why: say which passage states what, and what is missing when it is not answered. Two or three sentences on one line; it is shown to the reader in full, so do not trail off.',
  ].join('\n');
}

// 'medium' and 'normal' are what a model reaches for when it is not given the
// exact spelling, so they are folded in rather than shown as-is.
export function normalizeConfidence(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (/^(high|haut|haute|strong|sure)$/.test(s)) return 'high';
  if (/^(low|faible|basse|weak|unsure)$/.test(s)) return 'low';
  if (/^(med|medium|moderate|moyen|moyenne)$/.test(s)) return 'med';
  return '';
}

// Which half the next search should favour. A question about a unit's ability and
// one about a core rule fail for different reasons, and widening both halves
// always spends half the extra budget on the half that was never going to help.
export function normalizeWiden(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (/^(rules?|core|core rules?)$/.test(s)) return 'rules';
  if (/^(factions?|faction rules?|datasheets?|units?)$/.test(s)) return 'faction';
  return 'both';
}

export async function judgeCoverage(question, passages, key) {
  const prompt = judgePrompt(question, passages);
  let obj = parseJsonObject(await fastText(prompt, key, 4000, { json: true }));
  // A small model sometimes answers the judgement in prose instead of the object
  // it was asked for. The verdict is binding - an unparseable one is read as
  // "I do not know" - so it is asked once more, for the object alone, rather
  // than the reader being told the rule is absent because a brace was missing.
  if (!obj) obj = parseJsonObject(await fastText(prompt + '\n\nReply with the JSON object only, in one line, and nothing else.', key, 1200, { json: true }));
  if (!obj) return { rulesQuestion: null, answered: null, confidence: '', passages: [], why: 'judge returned nothing parseable', raw: true };
  const answered = obj.answered === true;
  // The model is asked to always give one; when it does not, the verdict itself
  // is the fallback rather than an empty field, because the caller escalates on
  // this and a blank must not read as certainty.
  let confidence = normalizeConfidence(obj.confidence);
  if (!confidence) confidence = answered ? 'med' : 'low';
  return {
    rulesQuestion: obj.rules_question !== false,
    answered,
    confidence,
    widen: normalizeWiden(obj.widen),
    passages: Array.isArray(obj.passages) ? obj.passages.filter(n => Number.isInteger(n) && n >= 1 && n <= passages.length) : [],
    // Not sliced. A 160-character cap here cut the judge's reasoning mid-word,
    // and the reader was shown a verdict that stopped in the middle of the
    // sentence explaining it. What the judge says is the page's headline; it is
    // published whole, and the prompt asks for the sentences it takes.
    why: String(obj.why || ''),
  };
}

// --- what to do when the judge says no --------------------------------------
// A judge that flags a retrieval as insufficient and is then ignored is worse
// than no judge: it produces a confident answer to a question the system has
// already established it cannot answer. So the verdict is binding, and a miss
// deepens the search rather than being answered anyway.
//
// One widening was never enough. 'Can Asurmen re-embark after shooting' missed
// the Embarking rule on the first pass, missed it again on the widened one (it
// sat below the reranker's cut at 50), and was declared absent by a system whose
// corpus holds it - the judge had simply never been shown it. The search now
// keeps deepening by WIDEN_ADD findings a round, aimed at the half the judge
// named, until the judge says it can answer.
//
// What bounds that: each round re-shows the whole candidate list to the judge,
// so a widened pass is a slower and more expensive call, and past a point the
// per-passage cap in judgePrompt starts cutting the evidence the judge is asked
// to judge. RULES_MAX_PASSES (default 3) is the ceiling; the last pass is final
// by definition, so a miss there is still reported as not knowing.
//
// Finding a passage that was ranked 7th is a real win. Guessing from a passage
// that was ranked 3rd and is about something else is not, and the difference is
// exactly what the judge is for.
export const ESCALATION_TOPKS = [10];
export const WIDEN_ADD = 20;
export const MAX_PASSES = Math.max(1, Number(process.env.RULES_MAX_PASSES) || 3);

// The next pass adds WIDEN_ADD findings in total to the depth the previous one
// searched. Naming a half concentrates all twenty there; naming both splits
// them. A plain number is accepted as the depth of both halves, so the first
// plan and a depth read the same.
export function widenPlan(target, perSide) {
  const prev = (perSide && typeof perSide === 'object')
    ? { rules: perSide.rules || ESCALATION_TOPKS[0], factions: perSide.factions || ESCALATION_TOPKS[0] }
    : { rules: perSide || ESCALATION_TOPKS[0], factions: perSide || ESCALATION_TOPKS[0] };
  const t = normalizeWiden(target);
  if (t === 'rules') return { rules: prev.rules + WIDEN_ADD, factions: prev.factions, target: 'rules' };
  if (t === 'faction') return { rules: prev.rules, factions: prev.factions + WIDEN_ADD, target: 'faction' };
  const half = Math.floor(WIDEN_ADD / 2);
  return { rules: prev.rules + half, factions: prev.factions + half, target: 'both' };
}

export function dontKnowAnswer(judge, lang) {
  const why = (judge && judge.why) ? judge.why : 'no passage states the rule.';
  if (lang === 'fr') {
    return [
      "**Je ne sais pas.**",
      '',
      "La question a bien été cherchée dans le corpus — les constats sont listés ci-dessous, et la recherche a été élargie — mais aucun passage n'énonce la règle nécessaire pour y répondre.",
      '',
      'Le juge : ' + why,
      '',
      "Ce n'est pas une réponse, c'est un constat d'absence. Deux causes possibles : la règle n'est pas dans cette copie (une fiche technique ou un stratagème manquant), ou la question sort de ce que le corpus couvre. Une réponse inventée ici serait pire que pas de réponse.",
    ].join('\n');
  }
  return [
    '**I do not know.**',
    '',
    'The question was searched for — the findings are listed below, and the search was widened — but no passage states the rule needed to answer it.',
    '',
    'The judge: ' + why,
    '',
    'This is not an answer, it is a statement of absence. Two likely causes: the rule is not in this copy (a missing datasheet or stratagem), or the question falls outside what the corpus covers. An invented answer here would be worse than none.',
  ].join('\n');
}

// The escalation loop, with the retrieval and the judging injected so the
// policy can be tested without network calls.
export async function answerableFindings(question, opts) {
  const o = opts || {};
  const base = (o.topKs && o.topKs[0]) || ESCALATION_TOPKS[0];
  // Until the judge stops, not once: a question the corpus can answer must not
  // be declared unanswerable because the first two looks missed. MAX_PASSES is
  // the ceiling, not the plan.
  const passes = Math.max(1, o.passes || MAX_PASSES);
  const retrieve = o.retrieve || ((q, plan) => retrieveDual(q, Object.assign({}, o.dual, { perSide: plan })));
  const judge = o.judge || ((q, findings) => judgeCoverage(q, findings, o.fastKey));
  const attempts = [];
  let widened = false;
  let plan = { rules: base, factions: base };
  for (let i = 0; i < passes; i++) {
    const dual = await retrieve(question, plan);
    const findings = dual.all.map((s, idx) => findingFor(s, idx + 1));
    if (o.onFindings) o.onFindings({ plan, findings, dual, attempt: i });
    const verdict = await judge(question, findings);
    const final = verdict.answered === true || i === passes - 1;
    attempts.push({ plan, findings, judge: verdict, dual, final });
    if (o.onJudge) o.onJudge({ judge: verdict, plan, attempt: i, final });
    if (verdict.answered === true) break;
    if (!final) { widened = true; plan = widenPlan(verdict.widen, plan); }
  }
  const last = attempts[attempts.length - 1];
  return {
    findings: last.findings,
    judge: last.judge,
    dual: last.dual,
    attempts: attempts.map(a => ({
      plan: a.plan, count: a.findings.length, answered: a.judge.answered === true,
      confidence: a.judge.confidence, widen: a.judge.widen, final: a.final,
    })),
    unresolved: last.judge.answered !== true,
    escalated: widened,
  };
}

// --- merging retrievers -----------------------------------------------------
// Vector scores are rank-fusion values in a narrow band and grep scores are
// term counts; they are not on the same scale and must not be compared. Rank
// fusion merges the two lists without pretending otherwise - a section both
// retrievers like wins, and one only a single retriever found still gets in.
export function rrfMerge(lists, k) {
  const weight = k || 60;
  const score = new Map();
  const item = new Map();
  for (const list of lists) {
    (list || []).forEach((entry, i) => {
      const id = entry.id;
      if (!id) return;
      item.set(id, entry);
      score.set(id, (score.get(id) || 0) + 1 / (weight + i + 1));
    });
  }
  return Array.from(score.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id, s]) => Object.assign({ rrf: s }, item.get(id)));
}

// A question that names a unit - or a rule - is asking about that thing, and its
// own records have to reach the reader even when the reranker does not think
// they answer the question. 'Can Asurmen embark with his normal move after
// shooting?' is decided by Asurmen's Tactical Acumen and by the Embarking rule,
// and neither survives a rerank on this query: the corpus is full of shooting
// abilities, so four measured Jev calls put Embarking 10th-12th out of the same
// eighty candidates and the top ten filled with NORMAL SHOOTING, SNAP SHOOTING
// and their like. A tenth-place cut is a coin flip, and the rule the question
// turns on is not something to leave to one.
//
// Anchoring is the guarantee. The words the question and its translation name
// are matched against the first word of a heading, which is how a datasheet, an
// ability record and a rule title are found in either language ('asurmen'
// survives translation; capitalisation does not). Matching is word-start, like
// the grep leg, so 'embark' reaches the heading 'Embarking'.
//
// The candidates are ranked, because rarity alone picks the wrong rule: in the
// real corpus 'normal' is in 57 sections and 'embark' in 62, so rarest-first
// anchored NORMAL MOVE, NORMAL SHOOTING and NORMAL FIGHT before the Embarking
// rule the question named. The order that works reads the heading's shape:
//
//   1. the question's own words before the translation's extra terms, so a
//      term the model added ('disembark' for 'réembarquer') cannot outrank the
//      word the reader actually used;
//   2. a one-word heading before a multi-word one - 'Embarking' is the rule,
//      while 'NORMAL MOVE' is an adjective on a different head;
//   3. the rarer word, so a word the whole corpus uses cannot choose the anchor
//      a specific one asked for.
//
// Ties keep corpus order, so the same question anchors the same records twice.
const ANCHOR_MIN_WORD = 5;
// Words that name nothing. A question says 'using his normal move', and 'using'
// is not the name of a rule - but 'Using Stratagems' is the first word of a
// heading, so it anchored a stratagem key entry onto an embark question. These
// are structure, not vocabulary, and an anchor is supposed to be the latter.
const ANCHOR_STOP = new Set(['using', 'their', 'after', 'before', 'during', 'while', 'within', 'without', 'under', 'over', 'when', 'where', 'which', 'would', 'could', 'should', 'about']);
export function entityAnchors(question, corpus, cap, extraWords) {
  // A hyphenated word contributes its parts, so 're-embark' anchors Embarking
  // even when no translation term says 'embark' outright.
  const own = new Set();
  const extra = new Set();
  const add = (set, raw) => {
    for (const part of String(raw).toLowerCase().split(/[^a-z0-9']+/)) {
      if (part.length >= ANCHOR_MIN_WORD && !ANCHOR_STOP.has(part)) set.add(part);
    }
  };
  for (const w of grepTerms(question)) add(own, w);
  for (const w of extraWords || []) add(extra, w);
  const words = Array.from(own).concat(Array.from(extra));
  if (!words.length) return [];
  const sections = corpus || [];
  const df = new Map();
  for (const w of words) df.set(w, 0);
  for (const sec of sections) {
    const hay = (String(sec.heading || '') + '\n' + String(sec.text || '')).toLowerCase();
    for (const w of words) {
      if (hay.indexOf(w) !== -1 && termPresent(hay, w)) df.set(w, df.get(w) + 1);
    }
  }
  const found = [];
  for (const sec of sections) {
    const parts = String(sec.heading || '').toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
    const first = parts[0] || '';
    if (!first) continue;
    const oneWord = parts.length === 1;
    let best = null;
    for (const w of words) {
      if (first !== w && !first.startsWith(w)) continue;
      const cand = { extra: extra.has(w) && !own.has(w) ? 1 : 0, one: oneWord ? 0 : 1, df: df.get(w) || 0 };
      if (!best
        || cand.extra < best.extra
        || (cand.extra === best.extra && (cand.one < best.one
          || (cand.one === best.one && cand.df < best.df)))) best = cand;
    }
    if (best) found.push(Object.assign({ sec }, best));
  }
  found.sort((a, b) => (a.extra - b.extra) || (a.one - b.one) || (a.df - b.df));
  return found.slice(0, cap || 2).map(x => x.sec);
}

// The corpus files a core rule's clarifications under its heading: 'Embarking'
// carries 'Embarking > Able To Embark' and a Q&A on the set-up restriction, and
// those children are where the rule is qualified. A retrieval that shows the
// parent and drops the children answers half the question - it was the
// Embarking Q&A that says a unit which disembarked this turn has made a set-up
// move, and so cannot embark again that turn.
export function childSections(records, corpus, perParent, total) {
  const out = [];
  const seen = new Set((records || []).map(s => s.id));
  const each = perParent || 1;
  const cap = total || 3;
  for (const parent of records || []) {
    if (!parent.heading) continue;
    const prefix = String(parent.heading) + ' > ';
    let taken = 0;
    for (const sec of corpus || []) {
      if (seen.has(sec.id) || !String(sec.heading || '').startsWith(prefix)) continue;
      seen.add(sec.id);
      out.push(sec);
      if (++taken >= each) break;
      if (out.length >= cap) return out;
    }
    if (out.length >= cap) return out;
  }
  return out;
}

// The whole retrieval path in one place: vector and grep both propose, rank
// fusion merges the two lists without comparing their incomparable scores, and
// Jev picks the ones worth showing. Either retriever may be missing - an empty
// index, no embedder, an unreachable service - and the other still answers.
export async function retrieveWide(question, opts) {
  const o = opts || {};
  const corpus = o.corpus || readAllCorpus();
  const lists = [];

  try {
    const hits = await queryIndex(question, { topK: o.vectorTopK || 20, cfg: o.cfg, namespace: o.namespace });
    const byId = new Map(corpus.map(s => [s.id, s]));
    const vec = hits.map(h => byId.get(h.id)).filter(Boolean);
    if (vec.length) lists.push(vec);
  } catch (e) {
    // No index, no vectors. Grep does not care, and neither does the caller.
  }

  const grep = o.terms && o.terms.length
    ? grepWithTerms(o.terms.concat(grepTerms(question)), corpus, o.grepNet || 40, question)
    : grepCorpus(question, corpus, o.grepNet || 40);
  if (grep.length) lists.push(grep);

  const merged = rrfMerge(lists).slice(0, o.jevMax || 80);
  if (!o.jevKey) return merged.slice(0, o.topK || 10);
  let ranked = null;
  try {
    ranked = await jevRank(question, merged, o.jevKey, { max: o.jevMax || 80 });
  } catch (e) {
    // The ranker is a free-tier call one shared budget away from a 429, and it
    // must not take the question with it: grep and the vector index already
    // found passages, and the judge reads the model, not Jev. Unranked order is
    // the rank fusion itself - what the two retrievers already agree on.
  }
  const topK = o.topK || 10;
  const picked = (ranked || merged).slice(0, topK);
  // A reranker decides emphasis, not existence. Asurmen's Tactical Acumen is
  // the retriever's strongest exact hit for an embark question (grep rank 1 by
  // a wide margin) and Jev still rated it 0.06 below three unrelated
  // stratagems, because the passage grants the move without stating the embark
  // rule. Letting that happen hides the ability the question is about. Each
  // retriever's own first hit therefore survives the rerank, displacing the
  // weakest pick when the result is full.
  const guarded = picked.slice();
  if (process.env.RULES_DEBUG_ANCHORS) console.log('[anchors] ns=' + (o.namespace || '') + ' corpus=' + (corpus || []).length + ' found=' + entityAnchors(question, corpus, o.anchorCap || 2, o.terms).map(a => a.id).join(','));
  // The records of the unit the question names come first: dropping the answer
  // to a question about a datasheet is worse than showing one passage too many.
  for (const anchor of entityAnchors(question, corpus, o.anchorCap || 2, o.terms)) {
    if (guarded.some(s => s.id === anchor.id)) continue;
    guarded.unshift(anchor);
  }
  for (const list of lists) {
    const own = list[0];
    if (!own || guarded.some(s => s.id === own.id)) continue;
    if (guarded.length < topK) guarded.push(own);
    else guarded[guarded.length - 1] = own;
  }
  // A rule's own clarifications travel with it, so the condition that limits
  // the answer is on the page even when the reranker only saw the permission.
  for (const child of childSections(guarded.slice(), corpus, o.childPerParent || 1, o.childCap || 3)) {
    if (guarded.some(s => s.id === child.id)) continue;
    guarded.push(child);
  }
  // Anchored and clarifying records may sit past the cut once everything is merged.
  return guarded.slice(0, topK + (o.anchorCap || 2) + (o.childCap || 3));
}

// --- the two halves ---------------------------------------------------------
// Core rules and faction rules are searched separately rather than merged into
// one index. A datasheet question and a core-rules question want different
// halves, and searching each on its own keeps a faction page from crowding out
// the core rule that answers a generic question - the failure the single index
// showed on real questions.
//
// Findings from both halves are returned and both are shown to the reader. The
// compiled answer is an addition to them, never a replacement: the citations
// are the product, and a reader who does not trust the prose can read the rule.
export async function retrieveDual(question, opts) {
  const o = opts || {};
  // Each half can be asked for a different depth. They fail for different
  // reasons - a missing core rule is not a missing datasheet - and the judge
  // says which one is short.
  const plan = o.perSide || {};
  const rulesK = plan.rules || o.topK || 10;
  const factionsK = plan.factions || o.topK || 10;
  // The reranker's net is much wider than the cut it fills, and deliberately so.
  // Jev reorders the candidates it is given; it cannot rank a passage that was
  // sliced off first. On the Asurmen embark question the Embarking rule sat at
  // merged rank 54 - a candidate list cut at 50 never showed it to Jev, and with
  // a net of 80 the same passage came back 4th and the judge could finally read
  // it. K + 10 was too tight a net to let the reranker do the job it exists for,
  // and it is the net, not K, that has to grow when the search deepens.
  const netFor = k => Math.max(o.jevMax || 30, k + 70);
  const [rules, factions] = await Promise.all([
    retrieveWide(question, {
      corpus: o.rulesCorpus || readAllCorpus('rules'),
      namespace: 'rules',
      jevKey: o.jevKey, cfg: o.cfg, terms: o.terms,
      grepNet: Math.max(o.grepNet || 40, rulesK * 4), jevMax: netFor(rulesK), topK: rulesK,
    }),
    retrieveWide(question, {
      corpus: o.factionsCorpus || readAllCorpus('factions'),
      namespace: 'factions',
      jevKey: o.jevKey, cfg: o.cfg, terms: o.terms,
      grepNet: Math.max(o.grepNet || 40, factionsK * 4), jevMax: netFor(factionsK), topK: factionsK,
    }),
  ]);
  return { rules, factions, all: rules.concat(factions), plan: { rules: rulesK, factions: factionsK } };
}

// --- compiling, with the findings still cited -------------------------------
// The same discipline the single-index page used: the model may write markers,
// never links. Every [n] resolves to a finding that was really retrieved, and
// the page draws the link from the finding itself.
export function compilePrompt(question, findings, opts) {
  // The question handed to the compiler is the English translation, whatever
  // language the reader typed. A French answer is still a French answer, with
  // the official English terms kept beside the French where they help.
  const lang = (opts && opts.lang) === 'fr'
    ? ['- The reader asked in French (the question below is its English translation): write the answer in French, but keep rule, datasheet and keyword names as the official English terms in brackets after the French where it helps.', '']
    : [];
  return [
    'You answer Warhammer 40,000 11th edition rules questions using ONLY the numbered findings below.',
    '',
    ...lang,
    'Rules:',
    '- Every sentence that states a rule must end with the marker of the finding it came from, like [1] or [3].',
    '- The general answer comes from the Core Rules. A finding from a faction page applies to that faction only; say which faction it belongs to.',
    '- Cite a finding only for what it supports. If the findings do not answer the question, reply with exactly: The findings do not answer this question.',
    '- Do not write a Sources list, do not write URLs, and do not invent a finding that is not below.',
    // A yes with an unstated condition is the failure this line exists for: an
    // embark answer read the permission out of Embarking and the ability out of
    // the datasheet, and left out "that unit was not set up on the battlefield
    // this turn" - which is the half that decides it whenever the unit
    // disembarked, because a disembark sets models up.
    '- State the conditions the cited rules require, and every limit or exception the findings place on the answer, even when the headline answer is yes. A finding that states a permission and a finding that states its condition are one answer, not two.',
    '- Be direct: the answer first, then the conditions and the exception if one exists.',
    // The page renders blank-line-separated paragraphs and '-' lists. An answer
    // written as one unbroken block arrived as one unbroken block, and a
    // three-part ruling read as a wall.
    '- Format for reading: a short paragraph per idea, separated by a blank line. Use "- " for a list of conditions or cases. No headings, no tables, no code blocks.',
    // The Embarking condition "was not set up on the battlefield this turn" is
    // the whole answer for a unit that disembarked, and the clarification that
    // says so (a disembark is a set-up move) sits in the Q&A under that rule.
    // Stating the condition and leaving the reader to join the two is how a
    // complete answer reads as an incomplete one.
    '- When a finding states a condition and another finding clarifies it, say what the condition excludes in practice - name the case it rules out, not only the wording of the condition.',
    '',
    'Findings:',
    findings.map((f, i) => '[' + (i + 1) + '] ' + (f.set === 'factions' ? 'Faction rules' : 'Core rules') + ' - ' + (f.faction ? f.faction + ' - ' : '') + f.heading + (f.ruleId ? ' (' + f.ruleId + ')' : '') + '\n' + String(f.text).slice(0, JUDGE_PASSAGE_CHARS)).join('\n\n'),
    '',
    'Question: ' + question,
    '',
    'Answer:',
  ].join('\n');
}

// The writer's budget is reasoning + answer, and on a widened search (37
// findings, a 60k-character prompt) the model spends all of 3500 tokens
// thinking and returns an empty answer with finish_reason 'length' - measured:
// 25.8s for nothing, then the doubling retry costs another 11s. At 8000 the
// same call finishes in 10.8s with 1236 reasoning tokens and an 882-character
// answer. The budget is a ceiling, not a target: the model stops when it is
// done, and only a call that would have been cut pays for it.
export async function compileFindings(question, findings, key, opts) {
  if (!key || !findings.length) return '';
  return String(await modelText(compilePrompt(question, findings, opts), key, 8000)).trim();
}

// The finding as the page shows it: what it is, where it came from, and the
// link. Built here from the record that was retrieved, so a marker in the prose
// and a link under it cannot drift apart.
export function findingFor(section, n) {
  return {
    n,
    set: section.set || 'rules',
    source: section.source,
    faction: section.faction || '',
    heading: section.heading,
    ruleId: section.ruleId || '',
    url: section.url,
    anchor: section.anchor || '',
    // The scraped sections already carry their fragment in url, so appending
    // the anchor again produced '...#X#X'. Strip back to the page first.
    href: section.anchor ? String(section.url || '').split('#')[0] + '#' + section.anchor : String(section.url || '').split('#')[0],
    text: section.text,
    excerpt: section.text.length > 600 ? section.text.slice(0, 600).replace(/\s+\S*$/, '') + ' ...' : section.text,
  };
}

// --- the index --------------------------------------------------------------
// Two backends behind one interface. Upstash Vector over REST was the original:
// hosted BGE_M3, payload is raw text, Upstash does the embedding - zero
// dependencies, but the free tier's daily write budget throttles every rebuild
// and a rebuild that cannot write leaves the index serving an old layout.
// The local backend runs the same BGE_M3 through Ollama's /api/embed on this
// machine and keeps the vectors in a flat file: rebuilds are instant and free,
// and Upstash is only needed when a deployment is worth publishing to.
// RULES_VECTOR_BACKEND=upstash | local. Upstash is the default: the local
// backend works and costs nothing, but bge-m3 on this box's CPU embeds a
// section every ~1.5s, which is hours for the faction half - fine for a
// fallback, not for an index you want to rebuild. RULES_VECTOR_BACKEND=local
// switches to it; both stores live side by side and neither is destroyed by
// using the other.
export const VECTOR_BACKEND = String(process.env.RULES_VECTOR_BACKEND || 'upstash').toLowerCase();

// One store per namespace, not one store with a namespace column: a rules
// question never wants a faction vector and scanning them costs nothing, the
// files stay small, and a rewrite of one half cannot corrupt the other.
const LOCAL_EMBED_MODEL = process.env.RULES_LOCAL_EMBED_MODEL || 'bge-m3';
const localStorePath = (ns, ext) => path.join(CORPUS_DIR, 'local-index-' + (ns || 'all') + ext);
const localStores = new Map();

// Raw text in, one vector per input out. Same payload shape Upstash sees -
// source + heading + text - so the two backends embed identical strings.
export async function embedTexts(texts, opts) {
  const base = (opts && opts.ollamaUrl) || process.env.RULES_OLLAMA_URL || 'http://127.0.0.1:11434';
  const batch = (opts && opts.batch) || 16;
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    out.push(...(await embedRange(texts, i, Math.min(i + batch, texts.length), base, batch)));
    // A local build is minutes to hours of CPU, so it says where it is.
    if (i && i % (batch * 10) === 0) console.log('  embedded ' + i + '/' + texts.length);
  }
  return out;
}

// A batch that fails is halved and retried, down to a single text. A runner
// can die mid-request (a lost GPU device, an out-of-memory kill) and one dead
// batch must not end a forty-minute build; a single text that still fails is
// skipped with a warning, because it stays reachable through grep.
async function embedRange(texts, from, to, base, batch) {
  const slice = texts.slice(from, to);
  if (!slice.length) return [];
  try {
    return await embedBatch(slice, base);
  } catch (e) {
    if (slice.length === 1) {
      console.log('  embed skipped one text (' + e.message + ')');
      return [new Array(1024).fill(0)];
    }
    const mid = from + Math.floor((to - from) / 2);
    return (await embedRange(texts, from, mid, base, batch)).concat(await embedRange(texts, mid, to, base, batch));
  }
}

async function embedBatch(texts, base) {
  // num_ctx 512: the stored records are capped at 2000 characters (~500
  // tokens), so this truncates almost nothing while keeping the CPU runner's
  // memory flat - the full 8192-token context was where a 2 GB GPU died.
  const payload = JSON.stringify({ model: LOCAL_EMBED_MODEL, input: texts, options: { num_ctx: 512 } });
  const u = new URL(base + '/api/embed');
  const httpMod = u.protocol === 'https:' ? https : await import('http');
  const res = await new Promise((resolve, reject) => {
    const req = httpMod.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, r => {
      const chunks = []; r.on('data', d => chunks.push(d));
      r.on('end', () => {
        let obj = null;
        try { obj = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { }
        resolve({ status: r.statusCode, obj });
      });
    });
    // CPU bge-m3 is slow under load - a batch of sixteen took past two minutes
    // once the model was queueing behind another run.
    req.on('error', reject); req.setTimeout(300000, () => req.destroy(new Error('embed timed out'))); req.end(payload);
  });
  if (!res.obj || !Array.isArray(res.obj.embeddings)) {
    const why = res.obj && (res.obj.error || res.obj.message) ? (res.obj.error || res.obj.message) : JSON.stringify(res.obj || '').slice(0, 200);
    throw new Error('embed failed: HTTP ' + res.status + ' ' + why + ' (batch of ' + texts.length + ')');
  }
  return res.obj.embeddings;
}

// The store is a flat file of concatenated Float32 vectors plus a meta json
// with the id and dimension of each. Read whole, searched by cosine - at six
// thousand sections a full scan is milliseconds.
export function localLoad(ns) {
  const key = ns || '';
  if (localStores.has(key)) return localStores.get(key);
  let meta = { ids: [], dim: 0 };
  try { meta = JSON.parse(fs.readFileSync(localStorePath(key, '.meta.json'), 'utf8')); } catch { }
  let bin = null;
  try { bin = fs.readFileSync(localStorePath(key, '.bin')); } catch { }
  const store = { meta, bin: bin ? new Float32Array(bin.buffer, bin.byteOffset, Math.floor(bin.length / 4)) : new Float32Array(0), path: localStorePath(key, '.bin') };
  localStores.set(key, store);
  return store;
}

function localPersist(store, ns) {
  const key = ns || '';
  fs.writeFileSync(localStorePath(key, '.bin'), Buffer.from(store.bin.buffer, 0, store.bin.length * 4));
  fs.writeFileSync(localStorePath(key, '.meta.json'), JSON.stringify(store.meta));
}

export async function upsertSectionsLocal(sections, opts) {
  const ns = (opts && opts.namespace) || '';
  const store = localLoad(ns);
  const texts = sections.map(s => s.source + ' - ' + s.heading + '\n\n' + s.text);
  const vecs = await embedTexts(texts, opts);
  const dim = vecs.length ? vecs[0].length : (store.meta.dim || 1024);
  // A store built by another model would compare vectors that mean different
  // things, and every score would be quietly wrong. Refuse rather than mix.
  if (store.meta.dim && dim !== store.meta.dim) throw new Error('embedding dimension changed: store is ' + store.meta.dim + ', model returned ' + dim + ' - rebuild the local index');
  store.meta.dim = dim;
  const index = new Map(store.meta.ids.map((id, i) => [id, i]));
  const pending = [];
  for (let i = 0; i < sections.length; i++) {
    // L2-normalise so a plain dot product is a cosine.
    let sum = 0;
    for (const v of vecs[i]) sum += v * v;
    const norm = Math.sqrt(sum) || 1;
    const vec = new Float32Array(vecs[i].map(v => v / norm));
    const existing = index.get(sections[i].id);
    if (existing !== undefined) {
      store.bin.set(vec, existing * dim);
    } else {
      pending.push({ id: sections[i].id, vec });
    }
  }
  if (pending.length) {
    const grown = new Float32Array(store.bin.length + pending.length * dim);
    grown.set(store.bin);
    pending.forEach((p, i) => {
      grown.set(p.vec, store.bin.length + i * dim);
      store.meta.ids.push(p.id);
    });
    store.bin = grown;
  }
  localPersist(store, ns);
  return sections.length;
}

export function deleteIdsLocal(ids, ns) {
  const store = localLoad(ns);
  const dim = store.meta.dim || 1024;
  const before = store.meta.ids.length;
  const keep = [];
  for (let i = 0; i < before; i++) if (!ids.includes(store.meta.ids[i])) keep.push(i);
  const bin = new Float32Array(keep.length * dim);
  const nextIds = [];
  keep.forEach((src, i) => { bin.set(store.bin.subarray(src * dim, (src + 1) * dim), i * dim); nextIds.push(store.meta.ids[src]); });
  store.bin = bin;
  store.meta.ids = nextIds;
  localPersist(store, ns);
  return before - nextIds.length;
}

export async function queryIndexLocal(question, opts) {
  const ns = (opts && opts.namespace) || '';
  const store = localLoad(ns);
  const dim = store.meta.dim || 1024;
  const [qvec] = await embedTexts([String(question)], opts);
  let sum = 0;
  for (const v of qvec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  const hits = [];
  const count = store.meta.ids.length;
  for (let i = 0; i < count; i++) {
    let dot = 0;
    for (let d = 0; d < dim; d++) dot += qvec[d] / norm * store.bin[i * dim + d];
    hits.push({ id: store.meta.ids[i], score: dot });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, (opts && opts.topK) || 12);
}

// Upstash Vector over REST, so this stays a zero-dependency module. The index
// was created with the hosted BGE_M3 model, which means the payload is raw text
// and Upstash does the embedding - there is no local model to install.
export function vectorConfig() {
  return {
    url: credential('UPSTASH_VECTOR_REST_URL'),
    token: credential('UPSTASH_VECTOR_REST_TOKEN'),
  };
}

function vectorRequest(cfg, endpoint, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(cfg.url + endpoint);
    const payload = JSON.stringify(body);
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.token,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let obj = null;
        try { obj = JSON.parse(text); } catch { /* non-JSON error page */ }
        resolve({ status: res.statusCode, obj, text });
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error('vector request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

export async function indexInfo(cfg) {
  const r = await vectorRequest(cfg || vectorConfig(), '/info', {});
  if (r.status !== 200) throw new Error('info failed: HTTP ' + r.status + ' ' + r.text.slice(0, 200));
  return r.obj.result;
}

export async function queryIndex(question, opts) {
  if (VECTOR_BACKEND === 'local') return queryIndexLocal(question, opts);
  const cfg = (opts && opts.cfg) || vectorConfig();
  const ns = (opts && opts.namespace) || '';
  const r = await vectorRequest(cfg, '/query-data' + (ns ? '/' + ns : ''), {
    data: String(question),
    topK: (opts && opts.topK) || 12,
    includeMetadata: true,
    includeData: (opts && opts.includeData) || false,
  });
  if (r.status !== 200) throw new Error('query failed: HTTP ' + r.status + ' ' + r.text.slice(0, 200));
  return r.obj.result || [];
}

// Upsert in batches: the REST endpoint takes an array, and a 1500-section
// source is a large body to hand one request.
export async function upsertSections(sections, opts) {
  if (VECTOR_BACKEND === 'local') return upsertSectionsLocal(sections, opts);
  const cfg = (opts && opts.cfg) || vectorConfig();
  const ns = (opts && opts.namespace) || '';
  const batch = (opts && opts.batch) || 50;
  let done = 0;
  for (let i = 0; i < sections.length; i += batch) {
    const slice = sections.slice(i, i + batch).map(s => ({
      id: s.id,
      data: s.source + ' - ' + s.heading + '\n\n' + s.text,
      metadata: {
        source: s.source,
        heading: s.heading,
        ruleId: s.ruleId || '',
        anchor: s.anchor || '',
        url: s.url,
        hasAnchor: s.hasAnchor,
      },
    }));
    const r = await vectorRequest(cfg, '/upsert-data' + (ns ? '/' + ns : ''), slice);
    if (r.status !== 200) {
      // The free tier allows 10,000 writes a day, and re-ingesting a whole
      // corpus repeatedly will find that ceiling. Say which wall was hit and
      // how far the run got, so the next attempt resumes instead of guessing.
      if (r.status === 403 && /daily write limit/i.test(r.text)) {
        throw new Error('daily write limit reached after ' + done + ' of ' + sections.length +
          ' sections in this source. State is kept per source, so re-running --ingest resumes from here once the limit resets.');
      }
      throw new Error('upsert failed: HTTP ' + r.status + ' ' + r.text.slice(0, 300));
    }
    done += slice.length;
    if (opts && opts.onProgress) opts.onProgress(done, sections.length);
  }
  return done;
}

export async function deleteIds(ids, cfg, namespace) {
  if (!ids.length) return 0;
  if (VECTOR_BACKEND === 'local') return deleteIdsLocal(ids, namespace);
  const ns = namespace || '';
  const r = await vectorRequest(cfg || vectorConfig(), '/delete-data' + (ns ? '/' + ns : ''), ids);
  if (r.status !== 200) throw new Error('delete failed: HTTP ' + r.status + ' ' + r.text.slice(0, 200));
  return ids.length;
}

// --- ingest -----------------------------------------------------------------
// Only what changed. A dataslate moves a handful of rules; re-embedding every
// section to pick them up would spend the daily update budget on text that did
// not move, and on a free tier that budget is the whole constraint.
export async function ingest(only, opts) {
  const cfg = (opts && opts.cfg) || vectorConfig();
  const setName = opts && opts.set;
  const dryRun = !!(opts && opts.dryRun);
  const list = only ? sourcesFor(setName).filter(s => s.name === only) : sourcesFor(setName);
  const report = { upserted: 0, unchanged: 0, deleted: 0, sources: [] };
  for (const source of list) {
    const payload = readCorpus(source.name);
    if (!payload) { report.sources.push({ source: source.name, skipped: 'no corpus on disk' }); continue; }
    const stateFile = path.join(CORPUS_DIR, source.name + '.index.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
    // Every rebuild is counted: the ledger beside the state records what each
    // one upserted, deleted and left alone, so a rebuild is a step with a
    // number rather than an event nobody can account for afterwards.
    const ledgerPath = path.join(CORPUS_DIR, source.name + '.rebuilds.json');
    let ledger = [];
    try { const l = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); if (Array.isArray(l)) ledger = l; } catch { }
    // Only what moved. An upsert replaces the vectors of the ids it names and
    // touches nothing else, and a delete is issued only for ids that really
    // left the corpus - a rebuild never wipes the index to rebuild it.
    const changed = payload.sections.filter(s => state[s.id] !== s.hash);
    const currentIds = new Set(payload.sections.map(s => s.id));
    const vanished = Object.keys(state).filter(id => !currentIds.has(id));
    const ns = namespaceFor(source.set);
    const unchanged = payload.sections.length - changed.length;
    if (dryRun) {
      report.sources.push({ source: source.name, sections: payload.sections.length, upserted: 0, deleted: 0, unchanged, planned: changed.length, vanishedPlanned: vanished.length, rebuild: ledger.length + 1, dryRun: true });
      report.upserted += 0;
      report.unchanged += unchanged;
      report.planned = (report.planned || 0) + changed.length;
      continue;
    }
    const upserted = await upsertSections(changed, { cfg, namespace: ns, onProgress: opts && opts.onProgress });
    const deleted = await deleteIds(vanished, cfg, ns);
    const next = {};
    for (const s of payload.sections) next[s.id] = s.hash;
    fs.writeFileSync(stateFile, JSON.stringify(next));
    ledger.push({ rebuild: ledger.length + 1, at: new Date().toISOString(), backend: VECTOR_BACKEND, sections: payload.sections.length, upserted, deleted, unchanged });
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1));
    report.upserted += upserted;
    report.unchanged += unchanged;
    report.deleted += deleted;
    report.sources.push({ source: source.name, sections: payload.sections.length, upserted, deleted, unchanged, rebuild: ledger.length });
  }
  return report;
}

// --- cli --------------------------------------------------------------------

// --- when was this corpus last built? ----------------------------------------
// Not "is it behind an official update": that compares clocks which date
// different things and can only ever answer coarsely. What can be stated exactly
// is when our own copy was made - the export's stamp, and the moment we built
// from it. A reader who wants to know whether that is recent enough can see the
// date and judge for themselves.
//
// Cached because the corpus does not change while the server is running, and
// /health is read on every page load.
let corpusStateCache = null;
export function corpusState() {
  if (corpusStateCache) return corpusStateCache;
  const sets = {};
  let built = null;
  let sourceDate = null;
  for (const s of ALL_SOURCES) {
    let payload = null;
    try { payload = readCorpus(s.name); } catch (e) { payload = null; }
    if (!payload) continue;
    sets[s.set] = (sets[s.set] || 0) + (payload.count || (payload.sections || []).length);
    if (payload.scrapedAt && (!built || payload.scrapedAt > built)) built = payload.scrapedAt;
    const marker = payload.marker || {};
    const stamp = String(marker.lastUpdate || marker.version || '').trim();
    if (stamp && (!sourceDate || stamp > sourceDate)) sourceDate = stamp;
  }
  corpusStateCache = {
    edition: EDITION,
    // What the sources said their data was last changed.
    sourceDate,
    // When we last read them. This is the one to publish: it describes the copy
    // rather than the origin.
    updated: built,
    sets,
  };
  return corpusStateCache;
}

export function corpusAgeDays(now) {
  const s = corpusState();
  if (!s.updated) return null;
  const at = new Date(s.updated).getTime();
  if (isNaN(at)) return null;
  return Math.floor(((now ? now.getTime() : Date.now()) - at) / 86400000);
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = n => argv.indexOf(n) !== -1;
  const value = n => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
  const only = value('--source');

  const set = value('--set');
  if (flag('--scrape')) {
    if (set === 'factions') {
      const files = await downloadCsvExport({ allowCached: flag('--cached') });
      console.log('downloaded ' + files.length + ' CSV files to ' + CSV_DIR);
      const built = buildFactionCorpus();
      console.log('  ' + 'faction records'.padEnd(24) + String(built.factions).padStart(5) + '  -> ' + corpusPath(FACTIONS_CSV.name));
      console.log('  ' + 'core stratagems'.padEnd(24) + String(built.core).padStart(5) + '  -> ' + corpusPath(CORE_STRATAGEMS.name));
      console.log('duplicate records collapsed: ' + built.dropped);
      console.log('export last update: ' + built.marker.lastUpdate);
      console.log('total ' + built.count + ' records from ' + CSV_FILES.length + ' CSV files');
      return;
    }
    const done = await scrapeAll(only, set);
    for (const p of done) console.log(p.source.padEnd(17) + ' ' + String(p.count).padStart(4) + ' sections (' + p.anchored + ' anchored)  ' + Math.round(p.bytes / 1024) + ' KB');
    console.log('written to ' + CORPUS_DIR);
    return;
  }
  if (flag('--ingest')) {
    const dryRun = flag('--dry-run');
    if (dryRun) console.log('dry run - nothing is written to the index or to the state files');
    const r = await ingest(only, { set, dryRun });
    for (const s of r.sources) {
      if (s.skipped) { console.log(s.source.padEnd(17) + ' skipped: ' + s.skipped); continue; }
      const rebuild = 'rebuild #' + s.rebuild;
      if (s.dryRun) {
        console.log(s.source.padEnd(17) + ' ' + String(s.sections).padStart(5) + ' sections, would embed ' + String(s.planned).padStart(5) + ', delete ' + String(s.vanishedPlanned).padStart(3) + ', leave ' + String(s.unchanged).padStart(5) + '  (' + rebuild + ')');
        continue;
      }
      console.log(s.source.padEnd(17) + ' ' + String(s.sections).padStart(5) + ' sections, ' + String(s.upserted).padStart(5) + ' embedded, ' + String(s.unchanged).padStart(5) + ' unchanged, ' + String(s.deleted).padStart(3) + ' deleted  (' + rebuild + ')');
    }
    console.log(dryRun ? 'would upsert ' + (r.planned || 0) : 'total upserted ' + r.upserted + ', deleted ' + r.deleted);
    return;
  }
  if (flag('--check')) {
    console.log('source                    edition  version  last update         state');
    for (const s of ALL_SOURCES.concat(REJECTED_SOURCES.map(r => Object.assign({ set: 'rejected' }, r)))) {
      const stored = (readCorpus(s.name) || {}).marker || null;
      if (s.built) {
        // Built from the same export as the faction half, so its marker comes
        // from that file rather than from a page of its own.
        const parent = (readCorpus(FACTIONS_CSV.name) || {}).marker || {};
        console.log('  ' + s.name.padEnd(24) + '11       -        ' + String(parent.lastUpdate || '-').padEnd(20) + 'built (from the CSV export)');
        continue;
      }
      if (s.set === 'factions') {
        // The export's marker is its own Last_update.csv, not a page table.
        let live = null;
        try {
          const r = await fetchPage('https://wahapedia.ru/wh40k11ed/Last_update.csv');
          live = { edition: '11', version: '', lastUpdate: csvRows(r.body)[0].last_update || '' };
        } catch (e) { console.log('  ' + s.name.padEnd(24) + 'unreachable: ' + e.message); continue; }
        const stale = stored && stored.lastUpdate && stored.lastUpdate !== live.lastUpdate;
        console.log('  ' + s.name.padEnd(24) + '11       -        ' + String(live.lastUpdate).padEnd(20) + (stale ? 'stale  (was ' + stored.lastUpdate + ')' : (stored ? 'current' : 'never-scraped')));
        continue;
      }
      let live = null;
      try { live = parseMarker((await fetchPage(s.url)).body); }
      catch (e) { console.log('  ' + s.name.padEnd(24) + 'unreachable: ' + e.message); continue; }
      const status = markerStatus(stored, live);
      console.log('  ' + s.name.padEnd(24) + String(live.edition || '-').padEnd(9) + String(live.version || '-').padEnd(9) + String(live.lastUpdate || '-').padEnd(20) + status.state + (status.detail ? '  (' + status.detail + ')' : ''));
      await new Promise(r => setTimeout(r, 400));
    }
    return;
  }
  if (flag('--stats')) {
    const info = VECTOR_BACKEND === 'local' ? null : await indexInfo();
    if (VECTOR_BACKEND === 'local') {
      for (const ns of ['rules', 'factions']) {
        const st = localLoad(ns);
        console.log('local ' + ns.padEnd(9) + String(st.meta.ids.length).padStart(5) + ' vectors, ' + (st.meta.dim || 0) + ' dims  -> ' + localStorePath(ns, '.bin'));
      }
    } else {
      console.log('index: ' + info.vectorCount + ' vectors, ' + info.dimension + ' dims, ' + info.indexType + ' (' + (info.denseIndex && info.denseIndex.embeddingModel) + ' + ' + (info.sparseIndex && info.sparseIndex.embeddingModel) + ')');
    }
    for (const s of ALL_SOURCES) {
      const c = readCorpus(s.name);
      console.log('  ' + s.name.padEnd(17) + (c ? String(c.count).padStart(4) + ' sections on disk (' + c.anchored + ' anchored), scraped ' + c.scrapedAt.slice(0, 16) : 'not scraped'));
    }
    return;
  }
  console.log('usage: node rules-corpus.mjs --scrape | --ingest | --stats [--source <name>]');
}

if (process.argv[1] && process.argv[1].endsWith('rules-corpus.mjs')) {
  main().catch(e => { console.error(String((e && e.message) || e)); process.exitCode = 1; });
}

export default { SOURCES, scrapeAll, ingest, queryIndex, indexInfo, readAllCorpus };
