#!/usr/bin/env node
'use strict';
/**
 * The rules corpus: Wahapedia scraped into citable sections, and pushed into
 * the vector index the /rules page searches.
 *
 *   node src/rules-corpus.mjs --scrape            fetch every source, write the corpus
 *   node src/rules-corpus.mjs --ingest            embed + upsert what changed
 *   node src/rules-corpus.mjs --stats             what is on disk and in the index
 *   node src/rules-corpus.mjs --prune             delete index vectors the corpus no longer has
 *   node src/rules-corpus.mjs --source faqs       restrict --scrape/--ingest to one
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
import zlib from 'zlib';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { FAST_ENDPOINT, FAST_MODEL, FAST_REASONING, FAST_TIMEOUT_MS, MODEL_ENDPOINT, MODEL, MODEL_REASONING, MODEL_TIMEOUT_MS, AGENT_REASONING_TIMEOUT_MS, JEV_ENDPOINT, JEV_MODEL, anchorFor, credential, gatewayAllowed, gatewayVerdict, jevChain, noteJevCall } from './rules.mjs';
import { TRACE_RETENTION_MONTHS, sweepTraces } from './rules-traces.mjs';
// task-34: the flat passage text gets the wargear marks at display time - the corpus
// bytes are untouched, the finding's excerpt and the passage sheet are not bare.
import { markWargearText } from './wargear-marks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// task-83: the corpus directory is resolved PER CALL. Captured at import it was a
// hidden global: a caller that set RULES_CORPUS_DIR after the import still read the
// directory the process started with, and a temp-dir build read the LIVE corpus back
// and wrote it out - the artifact behind two wrong 'zero drift' measurements.
const DEFAULT_CORPUS_DIR = path.join(__dirname, '..', 'workspace', 'rules-corpus');
export function corpusDir() { return process.env.RULES_CORPUS_DIR || DEFAULT_CORPUS_DIR; }
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

export function csvDir(dir) { return path.join(dir || corpusDir(), 'csv'); }

// The staged rulings inputs. Read-only to this module: the text is stored
// verbatim, never re-normalised and never re-fetched.
export function rulingsDir(dir) { return path.join(dir || corpusDir(), 'rulings'); }

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

// The third-party rulings half: two tournament FAQ documents staged as
// normalised CSVs beside the export. Built here, never scraped; see
// buildRulingsCorpus.
export const RULINGS = { name: 'rulings', set: 'rulings', url: '', built: true };

// The universal ability definitions, re-read from the core-rules page already on
// disk (never fetched again, never written by hand): see buildAbilityDefsCorpus.
export const ABILITY_DEFS = { name: 'ability-defs', set: 'rules', url: '', built: true };

export const ALL_SOURCES = SOURCES.concat([FACTIONS_CSV, CORE_STRATAGEMS, RULINGS, ABILITY_DEFS]);

export function sourcesFor(setName) {
  if (!setName || setName === 'all') return ALL_SOURCES;
  return ALL_SOURCES.filter(s => s.set === setName);
}

export function namespaceFor(setName) {
  if (setName === 'factions') return 'factions';
  if (setName === 'rulings') return 'rulings';
  return 'rules';
}

// bge-m3 takes 8192 tokens, but a long passage dilutes its own embedding: the
// one paragraph that answers the question is averaged against three pages that
// do not. Cutting at ~2400 characters keeps a section specific enough to rank
// and long enough to hold a rule and its exception.
// Kept just under AGENT_PASSAGE_CHARS on purpose. A stored record must never be
// longer than the agent is shown, or the agent ends up saying "no such ability
// is in the visible text" about text it was not given - which is exactly how a
// correct retrieval produced a wrong "I do not know".
// The live chunker's cap, and the only rule that may decide whether an existing
// record is split: it measures the BODY and then prepends the heading. Exported
// so the corpus wiki plan splits by the same rule instead of a fitted whole-text
// budget (which silently re-chunked 35 records).
export const MAX_CHARS = 2000;
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
// task-40: Wahapedia's CSV exports carry their page-template placeholders inline - '$FAQ$'
// is the one that reaches us, standing where their page renders an FAQ link, and 39
// records carried the literal marker into the reader's page (faction-rule#000008466 among
// them). It is not rules text: named and stripped at the ingest, not at display.
export function stripWahapediaMarkers(text) {
  return String(text == null ? '' : text).replace(/\$[A-Z][A-Z0-9_]*\$/g, ' ');
}

export function htmlToText(html) {
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    // task-86: Wahapedia draws the wound/hit-roll dice as CSS sprite divs, not text
    // (main1.css maps .cruD1..6 to a die face). The block-close rule below turns the
    // div into a newline before the generic strip can see it, so this must come first;
    // '2+' and '1' are the record's content. Only these two patterns - the other sprite
    // classes (abIcon, str11*Bg, Corner*, h_number*) are chrome, postponed by Mandal.
    .replace(/<div class="cruD([1-6])"><\/div>\s*<b>\+<\/b>/gi, '$1+')
    .replace(/<div class="cruD([1-6])"><\/div>/gi, '$1')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol|blockquote|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  // task-40: Wahapedia's page-template placeholders ('$FAQ$') are not rules text, and
  // the shape stage reads the same CSVs through its own clean() - so the strip lives in
  // the converter both of them call, named and exported above.
  return stripWahapediaMarkers(decodeEntities(text))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    // task-85 D1: the tag-to-space rule above is load-bearing - 'REMAIN
    // STATIONARY<span>09.04</span>' needs that space for the rule-id splitter -
    // but it also left one before the punctuation that followed a tag
    // ('rounds</a>,' became 'rounds ,', 806 times on this page alone). Drop the
    // space before punctuation, and only when the punctuation ends a token.
    .replace(/[ \t\u00a0]+([.,;:!?])(?=\s|$)/g, '$1')
    // Same class, brackets: '<i>Fight On Death (<span>05.04.05</span>)</i>' became
    // '( 05.04.05 )' - 162 and 221 occurrences against the raw page's 3 and 0.
    .replace(/\([ \t\u00a0]+/g, '(')
    .replace(/[ \t\u00a0]+\)/g, ')')
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
// The FAQ and the errata are not headings. A question is a `<td>Q:</td><td>`
// cell inside a table, and an errata entry is a `<div class="errata_H">` title;
// the extractor only cuts at headings, so one card's question became the heading
// for every card after it - 'Units and Models > Q: If a rule's effect lasts...'
// was a 2,000-character record holding a dozen unrelated answers, and the vector
// built from it describes none of them well. 96 FAQ cards and 9 errata entries
// in the core rules alone. Promoting each card's own title to a heading is the
// whole fix, and it is done on the HTML so the splitter and the heading stack
// see exactly what a real heading would give them.
const FAQ_Q_CELL = /<td[^>]*class="faq_Q"[^>]*>\s*Q:\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
const ERRATA_TITLE = /<div class="errata_H">([\s\S]*?)<\/div>/g;

export function promoteFaqCards(html) {
  const plain = s => htmlToText(s).replace(/\s+/g, ' ').trim();
  return String(html == null ? '' : html)
    .replace(FAQ_Q_CELL, (m, question) => '<h4 class="faq-heading">Q: ' + plain(question) + '</h4>' + m)
    .replace(ERRATA_TITLE, (m, title) => '<h4 class="errata-heading">' + plain(title) + '</h4>');
}

export function extractSections(html, source) {
  const page = promoteFaqCards(html);
  const head = /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi;
  const marks = [];
  let m;
  while ((m = head.exec(page)) !== null) {
    const attrs = m[2] || '';
    const idMatch = attrs.match(/\bid="([^"]*)"/i);
    const raw = htmlToText(m[3]);
    if (!raw) continue;
    // task-81 step 5: the 'See Also' widget is a list of RELATED RULES, not a
    // section. Cut at its heading and it becomes a record (the mashed chain
    // 'See-Also') whose <li> entries become child records; the 50 widgets without
    // a heading already merge into their rule. Make the heading form behave like
    // the span form: invisible here, so the list stays in the enclosing rule's body
    // and the link builder turns those names into links.
    if (/^See Also$/i.test(raw) && /CornerSeeAlso/.test(page.slice(Math.max(0, m.index - 300), m.index))) continue;
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
    // task-90: the page's tag level is NOT the hierarchy - a SECTION is an h2 and a
    // CHAPTER an h3, so chapter '02 Datasheets' was filed under the section before it
    // ('01.07 Battle-shock Rolls'). The heading's own dotted number is the depth:
    // '02' = 1, '01.07' = 2, '01.05.01' = 3. Tag level is the fallback when it has none.
    const tagLevel = marks[i].level;
    const depth = ruleId ? ruleId.split('.').length : 0;
    const level = depth || tagLevel;
    // An h1 is the page, not a rule on it: its body is the introduction and a
    // citation to it says nothing. Same for the marker table the page carries at
    // the top - it is how we date the copy, not something anyone asks about.
    if (tagLevel === 1) { stack.length = 0; continue; }
    // The export's own stamp, as a heading: "Book Kind Edition Version Last
    // update". It dates the copy; nobody asks about it.
    if (/^Book\s+Kind\s+Edition\s+Version\s+Last update/i.test(title)) continue;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    // 'Show' and 'Hide' are the spoiler toggles: they end up as ancestors once a
    // promoted card hangs under them, and they say nothing about the rule.
    const path = stack.map(s => s.title).filter(t => !/^(show|hide)$/i.test(t));
    // "FAQ" over eighty-four sections, "Errata" over fourteen: a real heading
    // that names a container rather than a rule. The content is worth keeping -
    // a clarification is a rule - but the label has to come from the content or
    // the citation is worthless. The same applies to a card under a container
    // heading, which is the mission decks.
    if (GENERIC_HEADING.test(title) || (titleCount.get(title) || 0) > 1) {
      title = deriveTitle(body) || title;
    }
    stack.push({ level, title });
    // A heading with no body is a label in a card, not a section. A NUMBERED heading is a
    // rule whatever its length, though: the appendix defines some in one line ('The term
    // Battle-shock test is the same as battle-shock roll.', 57 chars, 01.07.02), and the
    // 80-char floor was dropping 11 of its numbered sections - the empty containers Mandal
    // saw under a SEE ALSO entry (2026-10-18).
    if (body.length < MIN_CHARS && !ruleId) continue;
    // A table of contents is navigation, not a rule. The core rules page carries
    // one under "Books", and its only content is the list of pages.
    if (/^(books|contents)$/i.test(title) && body.length < 400) continue;
    if (/^Book\s+Kind\s+Edition\s+Version\s+Last update/i.test(body)) continue;
    const anchor = marks[i].anchor || '';
    // The ancestors go in front of the body, so the vector is embedded with the
    // context it belongs to rather than as an orphan paragraph, and grep can
    // match a parent term.
    const full = path.length ? path.concat([title]).join(' > ') : title;
    // The rules the page wrote inside this body become records of their own; the
    // parent keeps its id and whatever came before the first of them.
    for (const part of splitInlineRules(full, body, ruleId, anchor, title)) {
      const pieces = splitSection(part.body, MAX_CHARS);
      for (const piece of pieces) {
        out.push({
          source: source.name,
          title: part.title,
          path,
          heading: part.heading,
          ruleId: part.ruleId,
          anchor: part.anchor,
          hasAnchor: !!part.anchor,
          url: source.url + (part.anchor ? '#' + part.anchor : ''),
          text: part.heading + '\n' + piece.text,
          part: piece.part,
          parts: pieces.length,
          chars: piece.text.length,
        });
      }
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
    // cut is one the agent cannot be shown whole - so it is cut on a space as a
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

// A numbered rule the page rendered inside its parent's body. The core rules
// page anchors '3. End of Shooting Phase' (10.03) and then writes 10.04 NORMAL
// SHOOTING, 10.05 ASSAULT SHOOTING and the rest as plain text under it, so one
// 1,938-character record holds six rules and a question about normal shooting
// is answered from a record labelled something else. 78 of the 285 core-rules
// records carry rules this way - 180 of them between them.
//
// A boundary is a line that is a title and a rule id and nothing else, with a
// blank line before it: 'NORMAL SHOOTING 10.04'. Both halves are required, so a
// sentence that happens to end in a number is not a heading, and the title may
// not read as prose (no '. ' inside it, no more than ten words).
//
// The parent keeps its id and the text before the first boundary, so every
// citation that already exists still resolves; each boundary becomes a record
// the parent owns ('3. End of Shooting Phase > NORMAL SHOOTING'), which is the
// shape childSections already attaches to a parent.
const INLINE_RULE_LINE = /^([A-Z][^\n]{1,69}?)\s+(\d{2}(?:\.\d{2}){1,2})$/;

export function splitInlineRules(heading, body, ruleId, anchor, parentTitle) {
  const text = String(body == null ? '' : body);
  const lines = text.split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(INLINE_RULE_LINE);
    if (!m) continue;
    const title = m[1].trim();
    if (title.indexOf('. ') !== -1 || title.endsWith('.')) continue;
    if (title.split(/\s+/).length > 10) continue;
    // Prose that ends in a number is not a heading. Every observed sub-rule
    // title starts with the rule's own name; a sentence starts with one of
    // these, and 'The rule refers to page 10.04' is exactly the false positive
    // this line is for.
    if (/^(the|this|that|these|those|it|if|when|where|a|an|you|your|once|each|every|any|in|on|at|for|to|see|page)\b/i.test(title)) continue;
    if (m[2] === ruleId) continue;
    if (i > 0 && lines[i - 1].trim() !== '') continue;
    marks.push({ line: i, title, ruleId: m[2] });
  }
  if (!marks.length) return [{ heading, title: parentTitle || heading, ruleId: ruleId || '', anchor, body: text }];
  const out = [];
  // The parent is emitted even when nothing precedes the first boundary: its id
  // is a citation that already exists, and a container heading is a weak but real
  // signal. The children are the content.
  const lead = lines.slice(0, marks[0].line).join('\n').trim();
  out.push({ heading, title: parentTitle || heading, ruleId: ruleId || '', anchor, body: lead });
  for (let k = 0; k < marks.length; k++) {
    const from = marks[k].line + 1;
    const to = k + 1 < marks.length ? marks[k + 1].line : lines.length;
    out.push({
      heading: heading + ' > ' + marks[k].title,
      title: marks[k].title,
      ruleId: marks[k].ruleId,
      anchor: '',
      body: lines.slice(from, to).join('\n').trim(),
    });
  }
  return out;
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
  // task-85 D2: the 90-character cut put a literal '...' into 49 core-rules headings,
  // and the heading is the record's id and its citation label. A title is a label, not
  // a slug budget: keep it whole and let the id be as long as it is.
  const first = flat.split(/(?<=[.!?])\s+/)[0] || flat;
  return first;
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

// The staged rulings CSVs are quoted commas, not the export's pipes: an RFC-4180
// reader, because a ruling's text holds commas, quotes and newlines. Kept
// separate from csvRows so neither format can silently eat the other's rows.
export function csvQuotedRows(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(s => s.trim());
  return rows
    .filter(r => r.some(v => String(v).trim() !== ''))
    .map(r => Object.fromEntries(head.map((k, i) => [k, r[i] === undefined ? '' : r[i]])));
}

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
  fs.mkdirSync(csvDir(), { recursive: true });
  const written = [];
  let failures = 0;
  for (const f of CSV_FILES) {
    const dest = path.join(csvDir(), f);
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

// --- editions ---------------------------------------------------------------
// Every record carries the edition it came from. Datasheets resolve through
// their own source_id; the rest of the export carries only a faction_id, so a
// faction joins its own Source row by name. That join cannot see a Faction Pack
// (Legends, Forge World): the export gives those no faction row. Pack content is
// found through the datasheet link tables instead - a stratagem, enhancement or
// ability that only edition-0 datasheets carry is edition 0. Boarding Actions is
// the edition-10 expansion riding in the same tables, marked by Detachments.csv's
// own type column. Nothing here is written by name.
let EDITION_TABLES = null;
export function editionTables() {
  if (EDITION_TABLES) return EDITION_TABLES;
  const read = f => { try { return csvRows(fs.readFileSync(path.join(csvDir(), f), 'utf8')); } catch { return []; } };
  const sources = new Map(read('Source.csv').map(s => [s.id, s]));
  const byName = new Map();
  for (const s of sources.values()) if (!byName.has(s.name)) byName.set(s.name, s);
  const factionEdition = new Map();
  // task-32: the same join that stamps the edition stamps Legends, so the filter and
  // the edition can never disagree about which source row a record came from.
  const legendsFaction = new Set();
  for (const f of read('Factions.csv')) {
    const exact = byName.get(f.name);
    const near = exact || [...sources.values()].find(s => s.name.indexOf(f.name + ' (') === 0);
    factionEdition.set(f.id, near ? String(near.edition || '') : '');
    if (near && isLegendsSource(near.name)) legendsFaction.add(f.id);
  }
  const dsSource = new Map(read('Datasheets.csv').map(d => [d.id, d.source_id]));
  const dsEdition = id => { const s = sources.get(dsSource.get(id)); return s ? String(s.edition || '') : ''; };
  const dsLegends = id => { const s = sources.get(dsSource.get(id)); return !!s && isLegendsSource(s.name); };
  const packLinked = (file, key, test) => {
    const seen = new Map();
    for (const l of read(file)) {
      const flag = test(l.datasheet_id);
      if (!flag) continue;
      const cur = seen.get(l[key]);
      if (cur === undefined) seen.set(l[key], flag);
      else if (cur !== flag) seen.set(l[key], 'mix');
    }
    const out = new Set();
    for (const [id, v] of seen) if (v === true || v === '0') out.add(id);
    return out;
  };
  const packEdition = (file, key) => packLinked(file, key, id => dsEdition(id));
  // task-32: the same link tables, read for Legends instead of edition - a stratagem
  // that only Legends datasheets carry is Legends too.
  // A link row counts for Legends only when EVERY datasheet the record links to is a
  // Legends one - the same 'mix' rule the edition link sets use. A stratagem that a
  // normal unit can also use is not a Legends stratagem.
  const packLegends = (file, key) => {
    const seen = new Map();
    for (const l of read(file)) {
      const flag = dsLegends(l.datasheet_id) ? 'legend' : 'plain';
      const cur = seen.get(l[key]);
      if (cur === undefined) seen.set(l[key], flag);
      else if (cur !== flag) seen.set(l[key], 'mix');
    }
    const out = new Set();
    for (const [id, v] of seen) if (v === 'legend') out.add(id);
    return out;
  };
  const detachments = new Map(read('Detachments.csv').map(d => [d.id, d]));
  EDITION_TABLES = {
    factionEdition, dsEdition, legendsFaction, dsLegends,
    boarding: new Set([...detachments.values()].filter(isBoardingActionsDetachment).map(d => d.id)),
    packStratagems: packEdition('Datasheets_stratagems.csv', 'stratagem_id'),
    packEnhancements: packEdition('Datasheets_enhancements.csv', 'enhancement_id'),
    packAbilities: packEdition('Datasheets_abilities.csv', 'ability_id'),
    legendsStratagems: packLegends('Datasheets_stratagems.csv', 'stratagem_id'),
    legendsEnhancements: packLegends('Datasheets_enhancements.csv', 'enhancement_id'),
    legendsAbilities: packLegends('Datasheets_abilities.csv', 'ability_id'),
    stratagem: new Map(read('Stratagems.csv').map(s => [s.id, s])),
    enhancement: new Map(read('Enhancements.csv').map(e => [e.id, e])),
    detachment: detachments,
    ability: new Map(read('Abilities.csv').map(a => [a.id, a])),
  };
  return EDITION_TABLES;
}

// task-32 (Mandal, 2026-10-19): Warhammer Legends is out, whatever edition the export
// claims. The 2026-10-19 export re-tagged the 15 '<faction> (Warhammer Legends)'
// Source.csv rows from edition 0 to edition 11, so the edition-0 filter alone stopped
// catching them (~897 records / 1,035k characters). National tournaments run WTC and
// FEQ rulings; Legends is a friendly-game minority, and carrying a second copy of a
// faction's rules is the same 'two editions answer one question differently' problem
// the corpus rule exists to prevent. The rule reads the SOURCE NAME, never the edition.
export function isLegendsSource(name) {
  return /\(warhammer legends\)/i.test(String(name == null ? '' : name));
}

// A detachment is Boarding Actions when the export's own type column says so.
export function isBoardingActionsDetachment(row) {
  return /boarding actions/i.test(String((row && row.type) || ''));
}

// The faction PAGES carry the expansion's rules with no type column, so a page
// section is out of scope when its heading or anchor names the expansion.
export function isBoardingActionsPageSection(section) {
  return /boarding[-\s](actions|patrol|squads)/i.test(String((section && section.heading) || '') + ' ' + String((section && section.anchor) || ''));
}

// One lookup, by the record's own id, so it works for CSV sections and for the
// ones the wiki planner assembles from the same tables.
export function editionOf(section, fallback) {
  const t = editionTables();
  const kind = String((section && section.kind) || '').toLowerCase() || String((section && section.id) || '').split('#')[0];
  const num = String((section && section.id) || '').split('#')[1] ? String(section.id).split('#')[1].split('~')[0] : '';
  let ed = '';
  if (kind === 'datasheet' || kind === 'unitrules') ed = t.dsEdition(num);
  else if (kind === 'stratagem' && t.stratagem.has(num)) {
    const s = t.stratagem.get(num);
    if (isBoardingActionsDetachment({ type: s.type }) || t.boarding.has(s.detachment_id)) ed = '10';
    else if (t.packStratagems.has(num)) ed = '0';
    else ed = t.factionEdition.get(s.faction_id) || '';
  } else if (kind === 'enhancement' && t.enhancement.has(num)) {
    const e = t.enhancement.get(num);
    if (t.boarding.has(e.detachment_id)) ed = '10';
    else if (t.packEnhancements.has(num)) ed = '0';
    else ed = t.factionEdition.get(e.faction_id) || '';
  } else if (kind === 'detachment' && t.detachment.has(num)) {
    const d = t.detachment.get(num);
    ed = isBoardingActionsDetachment(d) ? '10' : (t.factionEdition.get(d.faction_id) || '');
  } else if (kind === 'faction-rule' && t.ability.has(num)) {
    const a = t.ability.get(num);
    ed = t.packAbilities.has(num) ? '0' : (t.factionEdition.get(a.faction_id) || '');
  }
  if (ed !== '') return ed;
  const fb = String(fallback == null ? '' : fallback);
  return /^\d+$/.test(fb) ? fb : '';
}

export function assignEditions(sections, fallback) {
  for (const s of sections) if (s) s.edition = editionOf(s, fallback);
  return sections;
}

export function editionCounts(sections) {
  const c = {};
  for (const s of sections) { const e = String((s && s.edition) || '') || '(none)'; c[e] = (c[e] || 0) + 1; }
  return c;
}

// --- one predicate for "does this record exist in the product" ----------------
// task-32: the Legends predicate, in one place, using the same join as the edition.
// A datasheet or unitrules record resolves through its own source_id; every other
// CSV record resolves through its faction's source row (the join above). A record
// whose source row is a '<...> (Warhammer Legends)' row is filtered whatever edition
// the export claims for it.
export function isLegendsRecord(section) {
  const t = editionTables();
  const kind = String((section && section.kind) || '').toLowerCase() || String((section && section.id) || '').split('#')[0];
  const num = String((section && section.id) || '').split('#')[1] ? String(section.id).split('#')[1].split('~')[0] : '';
  if (kind === 'datasheet' || kind === 'unitrules') return t.dsLegends(num);
  if (kind === 'stratagem' && t.stratagem.has(num)) return t.legendsFaction.has(t.stratagem.get(num).faction_id) || t.legendsStratagems.has(num);
  if (kind === 'enhancement' && t.enhancement.has(num)) return t.legendsFaction.has(t.enhancement.get(num).faction_id) || t.legendsEnhancements.has(num);
  if (kind === 'detachment' && t.detachment.has(num)) return t.legendsFaction.has(t.detachment.get(num).faction_id);
  if (kind === 'faction-rule' && t.ability.has(num)) return t.legendsFaction.has(t.ability.get(num).faction_id) || t.legendsAbilities.has(num);
  return false;
}

// Delivered means the render will give it a page and the index may return it.
// Three things are filtered: a Warhammer Legends source (the named rule above, which
// holds whatever edition the export claims - the 2026-10-19 export re-tagged those
// rows to edition 11), edition 0 (the Forge World / pack line), and the one named
// tenth-edition faction rule. The tree, the index build, the prune and the query path
// all read this one predicate; no side re-derives it. Index stubs are counted
// navigation, not filtered content, so they are delivered.
export const TENTH_EDITION_RULE_IDS = new Set(['faction-rule#000008445']);
export function isDelivered(record) {
  if (!record) return false;
  if (isLegendsRecord(record)) return false;
  if (String(record.edition == null ? '' : record.edition) === '0') return false;
  return !TENTH_EDITION_RULE_IDS.has(String(record.id || ''));
}

export function deliveredSections(sections) {
  return (sections || []).filter(isDelivered);
}

// task-44: WHY a record is not delivered, named so the render can say it out loud. The
// direct-id route still answers for these records - Mandal's call: label them, never
// 404 - and a reader who lands on one must know why it is not in the search.
export function exclusionReason(record) {
  if (!record) return '';
  if (isLegendsRecord(record)) return 'Warhammer Legends';
  if (String(record.edition == null ? '' : record.edition) === '0') return 'the pack line (edition 0)';
  if (TENTH_EDITION_RULE_IDS.has(String(record.id || ''))) return 'tenth edition';
  return '';
}

// task-32 C: kind 'index' pages are navigation - a faction's name list with no rules
// text, 296,563 characters that all sit over the agent's passage window - and every
// card name in the corpus has one competing with the card itself. They stay in the
// corpus (a link can still land on one, and the payload renders them) but they are
// never embedded, so a retrieval can never return one. The ingest's plan and the
// query's second line of defence share this predicate.
export function indexedSections(sections) {
  return deliveredSections(sections).filter(s => String((s && s.kind) || '') !== 'index');
}

let INDEXED_IDS = null;
// The ids a retrieval is allowed to return: delivered, and not a navigation page.
export function indexedIds() {
  if (!INDEXED_IDS) {
    INDEXED_IDS = new Set(readAllCorpus()
      .filter(isDelivered).filter(r => String(r.kind || '') !== 'index')
      .map(r => String(r.id)));
  }
  return INDEXED_IDS;
}

// The delivered ids of the corpus on disk, cached: the query path asks once per
// process, and a test that mutates the corpus uses isDelivered/deliveredSections.
let DELIVERED_IDS = null;
export function deliveredIds() {
  if (!DELIVERED_IDS) DELIVERED_IDS = new Set(readAllCorpus().filter(isDelivered).map(r => String(r.id)));
  return DELIVERED_IDS;
}

// The second line of defence: a hit whose id the product does not deliver is
// dropped even if it is still in the index (a stale vector between an ingest and
// a prune, or a hand-run upsert). The first line is the ingest skipping it.
export function deliveredHits(hits) {
  const ids = indexedIds();
  return (hits || []).filter(h => ids.has(String((h && h.id) || '')));
}


// One record per thing a reader could be shown. A datasheet is assembled from
// six tables because that is how the export splits it; the reader wants the
// datasheet, not the sixth of it that happens to live in one file.
export function buildFactionSections() {
  const read = f => csvRows(fs.readFileSync(path.join(csvDir(), f), 'utf8'));
  const lastUpdate = (read('Last_update.csv')[0] || {}).last_update || '';
  const factions = read('Factions.csv');
  const factionName = new Map(factions.map(f => [f.id, f.name]));
  const factionLink = new Map(factions.map(f => [f.id, f.link]));
  const sources = new Map(read('Source.csv').map(s => [s.id, s]));
  // Boarding Actions is the edition-10 expansion, and its material is filtered
  // here rather than in the tree: the 59 detachments the export types, and the
  // stratagems and enhancements that point at them. Counted, never silent.
  const boardingIds = new Set(read('Detachments.csv').filter(isBoardingActionsDetachment).map(d => d.id));
  const outOfScope = { detachments: 0, stratagems: 0, enhancements: 0, challengers: 0, abilitiesAttached: 0, abilitiesDropped: 0 };
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
  // task-13(a), Mandal 2026-10-19: one faction-less movement ability is NOT a core
  // ability. PULSE JET MOVE exists only for the Ork Epic Hero Wazdakka Gutsmek and
  // the core rules page never names it (measured over the 22 names after the
  // duplicate collapse: 21 appear in the core-rules text, this is the one that does
  // not). The export carries the full movement definition ONLY in its Stratagems.csv
  // row, so the definition is attached to the datasheet that owns the ability and
  // the standalone core copy is dropped - the text is not lost.
  // Fold the way dedupeKey does: the export writes a non-breaking hyphen in
  // 'CLOSE\u2011QUARTERS SHOOTING' while the rules page writes an ASCII one, and a
  // raw substring check called that core ability a stray (measured, 2026-10-19).
  const foldAbility = s => String(s == null ? '' : s)
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .toLowerCase().replace(/[\s\u00a0]+/g, ' ');
  const corePageText = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(corpusPath('core-rules'), 'utf8'));
      return foldAbility((j.sections || []).map(s => String(s.text || '')).join('\n'));
    } catch (e) { return ''; }
  })();
  const strayAbilities = new Map();
  for (const s of read('Stratagems.csv')) {
    if (s.faction_id) continue;
    const type = clean(s.type);
    if (!/^(Movement|Shooting) Ability$/i.test(type)) continue;
    const name = clean(s.name);
    if (!name) continue;
    if (corePageText.indexOf(foldAbility(name)) !== -1) continue;
    strayAbilities.set(foldAbility(name), {
      id: 'core-stratagem#' + s.id, name: name, type: type,
      cp: String(s.cp_cost || ''), turn: clean(s.turn), phase: clean(s.phase),
      body: [clean(s.legend), clean(s.description)].filter(Boolean).join(' ').trim(),
      done: false,
    });
  }

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
    // task-32 A: Datasheets.csv 000003708, 'Example Wargear', is the export's own
    // template row and was shipping as a Space Marines datasheet (2 records).
    if (/^example wargear$/i.test(String(d.name || '').trim())) continue;
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
      // task-32 A: 871 CSV model rows carry inv_sv '-' for none, and '-' is truthy -
      // so 503 datasheets printed 'inv -+'. Print the field only for a real save.
      const inv = /^\d+$/.test(String(m.inv_sv == null ? '' : m.inv_sv).trim()) ? ' inv ' + m.inv_sv + '+' : '';
      stats.push('Model ' + m.name + ': M ' + m.M + ' T ' + m.T + ' Sv ' + m.Sv + inv + ' W ' + m.W + ' Ld ' + m.Ld + ' OC ' + m.OC + (m.base_size ? ' base ' + m.base_size : ''));
    }
    for (const c of composition.get(d.id) || []) stats.push('Composition: ' + clean(c.description));
    for (const w of wargear.get(d.id) || []) {
      // task-32 A: 39 CSV rows have no name and no type (A 0, WS -, AP 0) - the
      // export's blank template rows, printed as 'Wargear  (): ...' on 17 records.
      if (!clean(w.name) && !clean(w.type)) continue;
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
      // task-13(a): the datasheet's own line is one sentence; the full definition
      // (MAXIMUM DISTANCE / BEFORE / WHILE / AFTER MOVING) lives in the export's
      // faction-less ability row. That row belongs here, on the datasheet whose
      // ability it defines, so it is attached to this list rather than left in the
      // core rules.
      const abName = foldAbility(name);
      if (abName.length >= 4) {
        for (const stray of strayAbilities.values()) {
          if (stray.done) continue;
          const key = foldAbility(stray.name);
          if (key === abName || key.indexOf(abName + ' ') === 0 || abName.indexOf(key + ' ') === 0) {
            rules.push('Ability (' + stray.type + '): ' + stray.name + ' - ' + stray.body);
            stray.done = true;
            outOfScope.abilitiesAttached += 1;
            break;
          }
        }
      }
    }
    push('unitrules#' + d.id, source, d.name + ' - keywords and abilities', url, rules);
  }

  // task-98: the export carries two rows for 8 core stratagems - the 11th-ed set (Type
  // 'Core - Battle Tactic Stratagem', the current WHEN/TARGET wording) and an older set with
  // the generic Type 'Core Stratagem'. Both are faction-less, so both were emitted and the
  // drawer listed each stratagem twice. One per name, decided after the loop.
  const strayById = new Map();
  for (const stray of strayAbilities.values()) strayById.set(stray.id, stray);
  const corePending = [];
  for (const s of read('Stratagems.csv')) {
    // Boarding Actions is a different game with its own stratagems, and it rides
    // in this file with no faction id like the core ones. The corpus is 11th
    // edition matched play, so it is out of scope - the same reason the 10th
    // edition sources were dropped rather than mixed in.
    if (isBoardingActionsDetachment({ type: s.type }) || boardingIds.has(s.detachment_id)) { outOfScope.stratagems++; continue; }
    const isCore = !s.faction_id;
    const faction = factionName.get(s.faction_id) || '';
    if (isCore) {
      // Not every faction-less row is a stratagem. The export carries the core
      // stratagems next to the move and shooting ability entries - NORMAL
      // SHOOTING, ASSAULT SHOOTING, DISEMBARK MOVE - whose Type is 'Shooting
      // Ability' or 'Movement Ability'. Calling those 'core stratagem' told the
      // reader a unit's normal shooting is a stratagem, which it is not; the
      // label now follows the export's own Type.
      const type = clean(s.type);
      // task-13(b), Mandal 2026-10-19: the nine 'Challenger - ...' rows are
      // mission-format stratagems from a format outside matched play, so they are
      // out of the corpus like the boarding-patrol records - counted, never
      // silent.
      if (/^Challenger/i.test(type)) { outOfScope.challengers++; continue; }
      // task-13(a): a faction-less ability the core page does not name is not a
      // core rule. Its definition has been attached to the datasheet that owns it
      // (PULSE JET MOVE -> Wazdakka Gutsmek) and the standalone copy is dropped.
      const stray = strayById.get('core-stratagem#' + s.id);
      if (stray) {
        if (!stray.done) outOfScope.abilitiesDropped += 1;
        continue;
      }
      const coreKind = /stratagem/i.test(type) ? 'core stratagem' : 'core ' + String(type || 'ability').toLowerCase();
      // task-32 A: a movement/shooting ability row has no CP, and 6 rows have no
      // Type - the labels print only when there is a value behind them.
      const lines = [
        s.name + ' - ' + coreKind,
        clean(type) ? 'Type: ' + type : '',
        String(s.cp_cost == null ? '' : s.cp_cost).trim() ? 'CP: ' + s.cp_cost : '',
        'Turn: ' + clean(s.turn) + '  Phase: ' + clean(s.phase),
        clean(s.legend),
        clean(s.description),
      ];
      corePending.push({ id: 'core-stratagem#' + s.id, name: clean(s.name), type: type, cp: String(s.cp_cost || ''), lines: lines });
      continue;
    }
    // Mandal, 2026-10-18: a Stratagems.csv row with no Type and the detachment 'Army Rules'
    // is a faction ARMY RULE, not a stratagem - 'FLITTING SHADOWS' is Aeldari's, and a
    // stratagem lives in a detachment or in Core Rules > Stratagems. 6 rows, all Aeldari
    // (ids under the Agile Manoeuvres ability 000009895), were labelled '<name> - Aeldari
    // stratagem' and filed under the faction's stratagems. They join the Army rules group.
    const armyRule = !/stratagem/i.test(clean(s.type)) && /^army rules$/i.test(clean(s.detachment));
    if (armyRule) {
      const ruleLines = [
        s.name + ' - ' + faction + ' army rule',
        clean(s.type) ? 'Type: ' + clean(s.type) : '',
        'Turn: ' + clean(s.turn) + '  Phase: ' + clean(s.phase),
        clean(s.legend),
        clean(s.description),
      ];
      push('faction-rule#' + s.id, 'factions-csv', s.name + ' - ' + faction + ' army rule', factionLink.get(s.faction_id) || '', ruleLines);
      continue;
    }
    const lines = [
      s.name + ' - ' + faction + ' stratagem',
      clean(s.type) ? 'Type: ' + clean(s.type) : '',
      String(s.cp_cost == null ? '' : s.cp_cost).trim() ? 'CP: ' + s.cp_cost : '',
      'Turn: ' + clean(s.turn) + '  Phase: ' + clean(s.phase),
      s.detachment ? 'Detachment: ' + clean(s.detachment) : '',
      clean(s.legend),
      clean(s.description),
    ];
    push('stratagem#' + s.id, 'stratagems', s.name + ' (' + faction + ')', factionLink.get(s.faction_id) || '', lines);
  }

  // One core stratagem per name: the row whose Type names its category ('Core - Battle
  // Tactic Stratagem') wins over the generic 'Core Stratagem' export, and between two of
  // a kind the fuller text wins. 8 names had two rows; the older wording was the duplicate.
  {
    const score = c => (/^core\s*[-\u2013]\s*/i.test(c.type) ? 100000 : 0) + c.lines.join('\n').length;
    const best = new Map();
    for (const c of corePending) { const prev = best.get(c.name); if (!prev || score(c) > score(prev)) best.set(c.name, c); }
    for (const c of corePending) if (best.get(c.name) === c) push(c.id, 'core-stratagems', c.name, CORE_STRATAGEMS.url, c.lines);
  }

  const detachmentAbilities = new Map();
  for (const a of read('Detachment_abilities.csv')) {
    if (!detachmentAbilities.has(a.detachment_id)) detachmentAbilities.set(a.detachment_id, []);
    detachmentAbilities.get(a.detachment_id).push(a);
  }
  for (const d of read('Detachments.csv')) {
    if (boardingIds.has(d.id)) { outOfScope.detachments++; continue; }
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
    if (boardingIds.has(e.detachment_id)) { outOfScope.enhancements++; continue; }
    const faction = factionName.get(e.faction_id) || e.faction_id;
    const lines = [
      e.name + ' - ' + faction + ' enhancement',
      'Cost: ' + e.cost + ' pts' + (e.upgrade === 'true' ? ' (upgrade)' : ''),
      'Detachment: ' + clean(e.detachment),
      clean(e.legend),
      clean(e.description),
    ];
    // Mandal, 2026-10-18: the heading names the KIND and where the enhancement lives -
    // 'Spirit Stone of Raelyth (Enhancement - Aeldari, Armoured Warhost)' - so a reader sees
    // what it is and which detachment it belongs to without opening it.
    const heading = e.name + ' (Enhancement - ' + faction + (clean(e.detachment) ? ', ' + clean(e.detachment) : '') + ')';
    push('enhancement#' + e.id, 'enhancements', heading, factionLink.get(e.faction_id) || '', lines);
  }

  return { lastUpdate, sections: out, boarding: outOfScope };
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

// task-32 B: dedupe a GROUP, not a part. The export lists some datasheets twice
// (Raptors 000000958 and 000004067, Legionaries 000002570 and 000004064, ...): the
// two rows' first parts differ in a source line, their second parts are identical
// points tables. Record-wise dedupe kept the first row's ~1 and the second row's ~2
// and dropped the second row's ~1 - leaving the first unit with no Points part at
// all, which is where 22,844 characters the CSV holds went missing. The whole group
// is now the unit of dedupe: identical groups collapse together, a group is never
// left with a hole, and the parts of one record always come from one row.
export function dedupeSections(sections) {
  const list = (sections || []).slice();
  const order = [], groups = new Map();
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const id = String((s && s.id) || '');
    // A record with no id is its own group: keying every id-less record on '' would
    // collapse unrelated records into one and stop deduping them at all (the builder
    // test builds sections without ids on purpose).
    const base = id ? id.replace(/~\d+$/, '') : '#' + i;
    if (!groups.has(base)) { groups.set(base, []); order.push(base); }
    groups.get(base).push(s);
  }
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const base of order) {
    const group = groups.get(base);
    const head = String((group[0] && group[0].heading) || '').replace(/\s*\(\d+\/\d+\)$/, '');
    const text = group.map(s => String(s.text || '')).join('\n');
    const key = dedupeKey({ heading: head, text: text });
    if (seen.has(key)) { dropped += group.length; continue; }
    seen.add(key);
    for (const s of group) out.push(s);
  }
  return { sections: out, dropped };
}

export function buildFactionCorpus() {
  const raw = buildFactionSections();
  const deduped = dedupeSections(raw.sections);
  // The one code path: every section gets its edition here, before it is written.
  const sections = assignEditions(deduped.sections, '11');
  const built = { lastUpdate: raw.lastUpdate, sections: sections, dropped: deduped.dropped };
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
  return { count: built.sections.length, marker, factions: halves[0].sections.length, core: halves[1].sections.length, dropped: built.dropped, main, boarding: raw.boarding, editions: editionCounts(built.sections) };
}


// --- the rulings half ---------------------------------------------------------
// Two third-party tournament FAQ documents, staged beside the export as
// normalised CSVs (workspace/rules-corpus/rulings/). This reads those two files
// and nothing else: never the raw sheet copies, never a re-fetch, never a
// re-normalise. The text is stored VERBATIM - the source's own typos included -
// because the product's use is a player showing a card to an opponent, and a
// paraphrase or a tidy-up would put our words in a third party's mouth. Every
// record carries its provenance so the card can say whose words they are.
// Junk rows from the staging that are not rulings. Dropped by id, never by text
// (a tip could legitimately be the same words) and never by editing the staged
// CSV, which stays the source of record. wtc11-did-you-know-057 is the 'Did you
// know' tab's own intro row - 'Did you know that...', 20 chars - a heading that
// would otherwise render as a card and surface in a findings list as content.
export const RULING_DROP_IDS = new Set(['wtc11-did-you-know-057']);

export function buildRulingsCorpus() {
  const manifest = JSON.parse(fs.readFileSync(path.join(rulingsDir(), 'sources.json'), 'utf8'));
  const bySource = new Map((manifest.sources || []).map(s => [s.source_id, s]));
  const read = f => csvQuotedRows(fs.readFileSync(path.join(rulingsDir(), f), 'utf8'));
  // The staged English for the French document. It is ADDITIONAL to the French,
  // never a replacement: the normalised CSV stays the source of record, and this
  // file is a display aid whose own metadata says a human has never read it. It
  // is joined on the record id, and an orphan key throws at build time - a
  // silently unmatched translation would be a hole in a ruling.
  const enPath = path.join(rulingsDir(), 'feq-11-faq.en.json');
  const english = fs.existsSync(enPath) ? JSON.parse(fs.readFileSync(enPath, 'utf8')) : {};
  const enText = english.text_en || {};
  const enMeta = english.translation || null;
  const translated = new Set();
  const sections = [];
  const add = (row, doc) => {
    if (RULING_DROP_IDS.has(String(row.id))) return false;
    const text = String(row.text == null ? '' : row.text);
    if (!text.trim()) return false;
    const src = bySource.get(row.source_id) || {};
    const heading = doc === 'wtc'
      ? 'WTC ' + (row.faction || row.topic || '') + ' \u2014 ' + (row.facet || '') + (row.entry_no ? ' #' + row.entry_no : '')
      : 'FEQ ' + (row.type_norm || row.topic || 'FAQ') + (row.faction ? ' \u2014 ' + row.faction : '');
    const id = String(row.id);
    const rec = {
      id: id, source: RULINGS.name, set: 'rulings', kind: 'ruling',
      heading: heading.trim(), ruleId: '', anchor: '', hasAnchor: false, url: src.url || '',
      text: text, chars: text.length, hash: textHash(text),
      // Verbatim provenance, per record: which document, which version, when it
      // was retrieved, and the source's own raw labels beside the normalised ones.
      provenance: {
        source_id: row.source_id || '', publisher: src.publisher || '', document: src.name || '',
        url: src.url || '', version: src.version || '', edition: String(row.edition || src.edition || '11'),
        language: row.language || src.language || '', retrieved_at: manifest.retrieved_at || '',
        scope: row.scope || '', topic: row.topic || '', facet: row.facet || '',
        type_raw: row.type_raw || '', type_norm: row.type_norm || '',
        faction: row.faction || '', faction_raw: row.faction_raw || '',
        entry_no: row.entry_no || '', modified: row.modified || '',
      },
      parent: '', children: [], links: [], edition: String(row.edition || '11'),
    };
    const en = enText[id];
    if (doc === 'feq' && en !== undefined && String(en).trim()) {
      rec.text_en = String(en);
      translated.add(id);
      if (enMeta) {
        rec.provenance.translation = {
          from: enMeta.from || '', to: enMeta.to || '', by: enMeta.by || '',
          reviewed: !!enMeta.reviewed, model: enMeta.model || '', translated_at: enMeta.translated_at || '',
        };
      }
    }
    sections.push(rec);
    return true;
  };
  let wtc = 0, feq = 0;
  for (const row of read('wtc-11-faq-1.0.normalised.csv')) if (add(row, 'wtc')) wtc++;
  for (const row of read('feq-11-faq.normalised.csv')) if (add(row, 'feq')) feq++;
  const ids = new Set(sections.map(s => s.id));
  if (ids.size !== sections.length) throw new Error('duplicate ruling ids: ' + sections.length + ' rows, ' + ids.size + ' ids');
  const orphans = Object.keys(enText).filter(id => !translated.has(id));
  if (orphans.length) throw new Error('FEQ English with no ruling record: ' + orphans.slice(0, 5).join(', '));
  const payload = {
    source: RULINGS.name, set: 'rulings', url: '', edition: '11',
    marker: { kind: 'Rulings normalised CSV', edition: '11', version: '', lastUpdate: '', retrieved_at: manifest.retrieved_at || '' },
    scrapedAt: new Date().toISOString(), count: sections.length, anchored: 0, sections,
  };
  writeCorpus(RULINGS.name, payload);
  return { count: sections.length, wtc, feq, translated: translated.size, main: payload };
}



// --- the mission decks --------------------------------------------------------
// The event companion's scrape produced the two decks as 37 arbitrary chunks,
// all headed 'Primary Mission deck' / 'Secondary Mission deck' and cut mid-card.
// One record per card, keyed by the card name the text already carries
// ('BATTLEFIELD DOMINANCE Primary Mission'), so a reader can look a mission up
// and the tree has 25 primary rows instead of 13 anonymous ones.
//
// Integrity is the point: the cards are contiguous slices of the chunks' own
// text, concatenated in document order, so nothing is authored, tidied or
// dropped. A leading fragment that no card name covers is kept as its own
// labelled fragment rather than merged or discarded.
export const MISSION_DECKS = [
  { deck: 'Primary Mission deck', label: /Primary\s+Mission/ },
  { deck: 'Secondary Mission deck', label: /Secondary\s+Mission/ },
];

function deckChunkOrder(id) {
  const m = /#(\d+)$/.exec(String(id || ''));
  return m ? parseInt(m[1], 10) : 1;
}

// The capitalised run immediately before the 'Primary/Secondary Mission' label,
// trimmed to something that can only be a card name (one short line, no prose).
export function missionCardName(text, at) {
  // A card title sits on its own line, immediately above the 'Primary/Secondary
  // Mission' label; a scoring run ('10VP', '5VP CUMULATIVE') or the previous
  // card's last word does not, and rejecting those is what keeps the split at the
  // deck's real cards instead of inventing '10VP' as a mission.
  const ok = s => !!s && s.length <= 60 && s.split(' ').length <= 6 && !/^\d/.test(s) && !/\bVP\b/i.test(s);
  const at0 = (start, end, name) => start + text.slice(start, end).indexOf(name);
  let lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const same = text.slice(lineStart, at).replace(/\s+/g, ' ').trim();
  if (ok(same)) return { name: same, at: at0(lineStart, at, same) };
  // A blank line between the title and the type line is common ('NO PRISONERS\n\n
  // Secondary Mission'): walk up over the blanks to the nearest text line.
  for (let hop = 0; hop < 3; hop++) {
    const prevEnd = lineStart - 1;
    if (prevEnd < 0) return '';
    const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
    const prev = text.slice(prevStart, prevEnd).replace(/\s+/g, ' ').trim();
    if (prev) return ok(prev) ? { name: prev, at: at0(prevStart, prevEnd, prev) } : '';
    lineStart = prevStart;
  }
  return '';
}

// The card boundaries of one deck's joined text: every label match whose name is
// a plausible card title. Returns the slices, in order, covering the text whole.
export function splitMissionText(text, label) {
  const re = new RegExp('(?:' + label.source + ')', 'g');
  const starts = [];
  let m;
  while ((m = re.exec(text))) {
    // Only the card's own type line splits: it starts a line, and the line above
    // it is the card's title in capitals. Prose ('... this Primary Mission ...'),
    // a repeated label mid-line and the scoring lines in between are not titles.
    if (m.index > 0 && text.charAt(m.index - 1) !== '\n') continue;
    const found = missionCardName(text, m.index);
    if (!found || !/^[A-Z0-9'\u2019\-\s]+$/.test(found.name)) continue;
    starts.push({ name: found.name, at: found.at });
  }
  if (!starts.length) return [{ name: '', text: text }];
  const out = [];
  if (starts[0].at > 0) out.push({ name: '', text: text.slice(0, starts[0].at) });
  for (let i = 0; i < starts.length; i++) {
    const to = i + 1 < starts.length ? starts[i + 1].at : text.length;
    out.push({ name: starts[i].name, text: text.slice(starts[i].at, to) });
  }
  return out;
}

export function splitMissionDecks() {
  const payload = readCorpusStamped('event-companion');
  if (!payload) return null;
  const sections = payload.sections || [];
  const next = [];
  const report = { chunks: 0, cards: 0, fragments: 0, decks: [] };
  for (const deck of MISSION_DECKS) {
    const chunks = sections
      .filter(s => String(s.heading || '').trim() === deck.deck)
      .sort((a, b) => deckChunkOrder(a.id) - deckChunkOrder(b.id));
    if (!chunks.length) continue;
    const joined = chunks.map(s => String(s.text || '')).join('');
    // The pre-split bytes are kept beside the corpus so the integrity of the
    // split stays checkable after the chunks are gone: the test concatenates the
    // new records and compares against this file, byte for byte.
    fs.writeFileSync(path.join(corpusDir(), 'event-companion.deck-' + deck.deck.split(' ')[0].toLowerCase() + '.presplit.txt'), joined);
    const parts = splitMissionText(joined, deck.label);
    if (parts.map(p => p.text).join('') !== joined) throw new Error('mission split lost text in ' + deck.deck);
    const used = new Set();
    let cards = 0, fragments = 0;
    for (const part of parts) {
      if (!part.text.trim()) continue;
      // The deck's own title line, captured as a record by the scrape, is not
      // content: it is the same class of noise as a page's intro row, and it is
      // dropped by name, not kept as a fragment.
      if (!part.name && part.text.trim() === deck.deck) continue;
      const label = part.name || ('Fragment ' + (fragments + 1));
      if (part.name) cards += 1; else fragments += 1;
      let slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'fragment';
      let id = 'event-companion#' + deck.deck.split(' ')[0] + '-Mission-deck->-' + slug;
      let n = 1;
      while (used.has(id)) { n += 1; id = 'event-companion#' + deck.deck.split(' ')[0] + '-Mission-deck->-' + slug + '#' + n; }
      used.add(id);
      const text = part.text;
      next.push({
        id: id, source: 'event-companion', set: 'rules', kind: 'rule',
        heading: deck.deck + ' > ' + label, ruleId: '', anchor: '', hasAnchor: false,
        url: chunks[0].url || '', text: text, chars: text.length, hash: textHash(text),
        parent: '', children: [], links: [],
        edition: String(chunks[0].edition || '11'),
      });
    }
    report.chunks += chunks.length;
    report.cards += cards;
    report.fragments += fragments;
    report.decks.push({ deck: deck.deck, chunks: chunks.length, cards: cards, fragments: fragments, bytes: joined.length });
  }
  // Everything that is not a deck chunk passes through untouched, in order.
  const deckNames = new Set(MISSION_DECKS.map(d => d.deck));
  for (const s of sections) if (!deckNames.has(String(s.heading || '').trim())) next.push(s);
  next.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const out = Object.assign({}, payload, { sections: next, count: next.length, anchored: next.filter(s => s.hasAnchor).length });
  writeCorpus('event-companion', out);
  return report;
}

// --- the universal ability definitions ----------------------------------------
// The core rules page states each universal ability verbatim in an
// <div class="abName"> block ('[LETHAL HITS] 24.23 ...'), but the scraper folds
// the whole list into one parent record, so twenty of them ended up with no
// heading of their own - a player cannot look up Lethal Hits by name, and the
// router correctly refuses to guess. This source re-reads the page ON DISK (the
// same fetched copy the scraper wrote; nothing is fetched again, and no rules
// text is authored here - every word comes from the page) and emits one record
// per ability that the corpus actually uses as [NAME] and that has no heading of
// its own. An ability the page does not define is left out and named in the
// build output, never invented.
function abilityBlock(page, at) {
  const start = page.lastIndexOf('<div class="abWrap', at);
  if (start === -1) return '';
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = start;
  let depth = 0, m;
  while ((m = tag.exec(page))) {
    if (m[0].indexOf('</div') === 0) { depth -= 1; if (depth === 0) return page.slice(start, m.index + m[0].length); }
    else depth += 1;
  }
  return '';
}

export function abilityDefsOnPage(page) {
  const re = /<div class="abName">\s*\[?([^<\]]+)\]?\s*<span class="h_number">([0-9.]+)<\/span>/g;
  const first = new Map();
  let m;
  while ((m = re.exec(page))) {
    const name = m[1].trim().toUpperCase();
    if (!first.has(name)) first.set(name, { name: name, num: m[2], at: m.index });
  }
  return first;
}

export function buildAbilityDefsCorpus() {
  const page = fs.readFileSync(path.join(corpusDir(), 'core-rules.html'), 'utf8');
  const blocks = abilityDefsOnPage(page);
  // Exclude this source's own previous output by ID, not by its section label: the
  // sections carry source 'core-rules' (their real page), the FACTION_SOURCES
  // pattern, so a rebuild does not mistake its own records for existing headings.
  const ownIds = new Set(((readCorpusStamped(ABILITY_DEFS.name) || {}).sections || []).map(s => s.id));
  const others = readAllCorpus().filter(r => !ownIds.has(r.id));
  const used = new Set();
  for (const r of others) {
    for (const m of String(r.text || '').matchAll(/\[([^\]]{2,40})\]/g)) {
      const base = m[1].split(':')[0].replace(/\s+[0-9X]+$/, '').trim().toUpperCase();
      if (base) used.add(base);
    }
  }
  const hasHeading = name => others.some(r => String(r.heading || '').split(' > ').some(s => s.replace(/^\[|\]$/g, '').trim().toUpperCase() === name));
  const coreUrl = String((readCorpus('core-rules') || {}).url || 'https://wahapedia.ru/wh40k11ed/the-rules/core-rules/').split('#')[0] + '#Abilities';
  const sections = [];
  const skipped = [];
  for (const [name, b] of blocks) {
    if (!used.has(name) || hasHeading(name)) continue;
    const text = htmlToText(abilityBlock(page, b.at)).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    sections.push({
      id: 'ability-def#' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      // Their real page is the core rules: the tree files records by the section's
      // own source label, exactly as a faction section says 'faction-ae' while the
      // file is factions-csv.json.
      source: 'core-rules', set: 'rules', kind: 'ability',
      heading: '[' + name + ']', ruleId: b.num, anchor: '', hasAnchor: false, url: coreUrl,
      text: text, chars: text.length, hash: textHash(text),
      parent: 'core-rules#Abilities', children: [], links: [], edition: '11',
    });
  }
  // An ability the corpus uses but the page does not define stays a fall-through;
  // the build names it so the omission is a decision, not an accident.
  const defined = [...blocks.keys()];
  for (const name of used) {
    if (blocks.has(name) || hasHeading(name)) continue;
    if (/^\d+BTP$/.test(name)) continue;                       // [2BTP]: a timing marker
    if (defined.some(d => name.indexOf(d) === 0)) continue;     // ANTI-VEHICLE 4+ is [ANTI]
    skipped.push(name);
  }
  const payload = {
    source: ABILITY_DEFS.name, set: 'rules', url: coreUrl, edition: '11',
    marker: { kind: 'Core rules ability blocks', edition: '11', version: '', lastUpdate: '' },
    scrapedAt: new Date().toISOString(), count: sections.length, anchored: 0, sections,
  };
  writeCorpus(ABILITY_DEFS.name, payload);
  return { count: sections.length, names: sections.map(s => s.heading), skipped: skipped };
}

// --- the corpus on disk -----------------------------------------------------
export function corpusPath(name, dir) {
  return path.join(dir || corpusDir(), name + '.json');
}

export function writeCorpus(name, payload, dir) {
  fs.mkdirSync(dir || corpusDir(), { recursive: true });
  fs.writeFileSync(corpusPath(name, dir), JSON.stringify(payload));
  return corpusPath(name, dir);
}

export function readCorpus(name, dir) {
  try { return JSON.parse(fs.readFileSync(corpusPath(name, dir), 'utf8')); }
  catch { return null; }
}
// --- the snapshot, before anything writes the corpus -------------------------
// The corpus directory is the one store with no other copy: the vector index can be
// rebuilt from it, not the other way round. On 2026-10-16 a local rebuild script
// overwrote core-rules.json and its own backup, and the file came back only because
// a box snapshot from the day before happened to hold the directory. Every command
// that can write it now snapshots first: a tar.gz under workspace/box-snapshot/
// named for the minute, keeping the last three. It is a plain ustar + gzip, written
// here so a snapshot needs no platform tar (Windows tar exists, but the guard must
// run wherever the tests do), and it is verified by extracting it in the test.
const TAR_BLOCK = 512;
function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(TAR_BLOCK);
  const put = (s, off, len) => { Buffer.from(String(s)).copy(h, off, 0, Math.min(String(s).length, len)); };
  const octal = (n, len) => String(n.toString(8)).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(mtime / 1000), 12), 136, 12);
  h.write('        ', 148, 8);                    // checksum placeholder
  put('0', 156, 1);
  h.write('ustar\0' + '00', 257, 8);
  put('corpus', 265, 32);
  put('corpus', 297, 32);
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) sum += h[i];
  h.write(String(sum.toString(8)).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
export function tarGzOfDir(dir, arcName) {
  const chunks = [];
  const walk = (rel, abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absChild = path.join(abs, entry.name);
      const relChild = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { walk(relChild, absChild); continue; }
      const body = fs.readFileSync(absChild);
      chunks.push(tarHeader(relChild, body.length, fs.statSync(absChild).mtimeMs), body);
      const pad = (TAR_BLOCK - (body.length % TAR_BLOCK)) % TAR_BLOCK;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  };
  const before = chunks.length;
  walk(arcName || path.basename(dir), dir);
  if (chunks.length === before) throw new Error('snapshot: nothing to archive in ' + dir);
  chunks.push(Buffer.alloc(TAR_BLOCK * 2));
  return zlib.gzipSync(Buffer.concat(chunks));
}
export function snapshotCorpus(opts) {
  const o = opts || {};
  const dir = o.dir || corpusDir();
  const outDir = o.outDir || path.join(__dirname, '..', 'workspace', 'box-snapshot');
  const keep = o.keep == null ? 3 : o.keep;
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = o.stamp || new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const file = path.join(outDir, 'rules-corpus-' + stamp + '.tar.gz');
  fs.writeFileSync(file, tarGzOfDir(dir, path.basename(dir)));
  const kept = fs.readdirSync(outDir).filter(f => /^rules-corpus-\d{12}\.tar\.gz$/.test(f)).sort();
  for (const old of kept.slice(0, Math.max(0, kept.length - keep))) fs.unlinkSync(path.join(outDir, old));
  return file;
}


// The same payload with its editions stamped. They are computed at read time
// (the wiki shape drops fields it does not know), so a planner that reads the
// JSON raw sees edition '' and would treat every record as delivered. The index
// build and the prune read through here; the render reads through readAllCorpus.
export function readCorpusStamped(name) {
  const c = readCorpus(name);
  if (!c || !Array.isArray(c.sections)) return c;
  const fallback = c.marker && /^\d+$/.test(String(c.marker.edition)) ? String(c.marker.edition) : '11';
  assignEditions(c.sections, fallback);
  return c;
}

export function readAllCorpus(setName, dir) {
  const all = [];
  for (const s of sourcesFor(setName)) {
    const c = readCorpus(s.name, dir);
    if (c && Array.isArray(c.sections)) {
      // The faction pages carry the Boarding Actions expansion's rules with no
      // type column, so they are dropped here by the expansion's own wording.
      const isPage = String(s.name).indexOf('faction-') === 0;
      const kept = isPage ? c.sections.filter(sec => !isBoardingActionsPageSection(sec)) : c.sections;
      // Every record carries an edition, whether it was built from the CSV,
      // assembled by the wiki planner or scraped: the fallback is the file's own
      // marker edition, and 11 for the 11th-edition rules pages.
      const fallback = c.marker && /^\d+$/.test(String(c.marker.edition)) ? String(c.marker.edition) : '11';
      assignEditions(kept, fallback);
      // The set travels with the section so a merged candidate list can still
      // say which half a finding came from - the reader is shown both.
      for (const sec of kept) all.push(Object.assign({ set: s.set, source: s.name }, sec));
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
  const sections = assignIds(source.name, extractSections(stripChrome(r.body), source).filter(sec => !isBoardingActionsPageSection(sec)));
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
    // A re-scrape rebuilds the mission decks as chunks; re-split them here so the
    // cards are not a one-off local edit.
    if (s.name === 'event-companion') { try { splitMissionDecks(); } catch (e) { /* the test reports a lost split */ } }
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

// task-55: a three-character floor WITH a guard. The floor alone was measured first,
// and it is a trap: at a floor of 3, 24 of the 33 bank questions change their term set,
// exactly ONE gains a term its expected record contains ('fly' for 'what are the rules
// for a unit that can fly', whose record is 'Flying Models'), and the other 23 gain only
// function words - 'how', 'the', 'can', 'are', 'for', 'see', 'put', 'own', 'end', 'let',
// 'you', 'hit'. So the guard is what keeps the one word worth having without making
// every query match everything.
const SHORT_STOP = new Set(['the', 'and', 'for', 'can', 'are', 'was', 'not', 'you', 'all', 'any', 'but', 'how', 'its', 'may', 'one', 'out', 'see', 'use', 'who', 'why', 'per', 'off', 'own', 'end', 'get', 'set', 'way', 'day', 'new', 'old', 'top', 'two', 'six', 'hit', 'run', 'put', 'add', 'her', 'his', 'him', 'she', 'our', 'too', 'yet', 'nor', 'via', 'did', 'let', 'far', 'due', 'non', 'pre', 'sub', 'it', 'is', 'of', 'in', 'to', 'on', 'at', 'by', 'or', 'as', 'be', 'do', 'if', 'no', 'so', 'up', 'we', 'he', 'me', 'my', 'us', 'an', 'am']);
export function grepTerms(question) {
  const words = String(question == null ? '' : question)
    .toLowerCase()
    .replace(/[^a-z0-9' -]+/g, ' ')
    .split(/\s+/)
    .filter(w => STOP.has(w) ? false : (w.length >= 4 || (w.length === 3 && !SHORT_STOP.has(w))));
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

// --- the question SHAPE (task-47) -------------------------------------------
// Mandal: 'Is jev truly bad at this, or are we using it wrong? Asking it to
// classify might work better than a noul.' Measured over the 33-question bank on
// the gate corpus, same candidates and same corpus for both shapes:
//
//   noul   (one absolute question per candidate)   18/26/26/27, MRR .622
//   choice (one comparative question per half)     20/27/29/30, MRR .698
//
// against the retrieval order's 15/26/28/29, .582 - and the choice shape does it
// with 2 sub-questions a question instead of ~134. The noul shape stays reachable
// (RULES_JEV_SHAPE=noul, or opts.shape) for the eval arms and for a before/after.
export function jevShape(opts) {
  const v = String((opts && opts.shape) || process.env.RULES_JEV_SHAPE || 'choice').toLowerCase();
  return v === 'noul' ? 'noul' : 'choice';
}
// The label the choice question offers for 'the pool holds no answer'. It exists so
// the model can say so instead of picking the least-bad candidate, and it is
// RECORDED but never acted on: the measurement says sorting the probabilities anyway
// beats falling back to the retrieval order when it is picked (per-half MRR .711
// against .676), so a gate on it would lose. Do not build one.
export const JEV_NONE = 'none';
const passageLabel = c => String((c && c.heading) || '') + ((c && c.ruleId) ? ' (' + c.ruleId + ')' : '');
// The old shape: one question per candidate, batched into one call.
export function noulAskFor(question, top) {
  const q = {};
  top.forEach((c, i) => {
    q['p' + i] = {
      type: 'noul',
      instructions: 'Does passage ' + i + ' (' + c.heading + ') state the rule that answers: ' + question,
      criteria: { true: 'It answers the question', false: 'It does not' },
    };
  });
  return q;
}
// The shape this slice ships: ONE comparative question for the whole half. The
// candidates ARE the criteria map, so the model makes one decision instead of N.
export function choiceAskFor(question, top) {
  const criteria = {};
  top.forEach((c, i) => { criteria['p' + i] = passageLabel(c); });
  criteria[JEV_NONE] = 'None of these passages states the rule that answers it';
  return { pick: { type: 'choice', instructions: 'Which passage states the rule that answers: ' + question, criteria: criteria } };
}
// A choice answer -> the order. Ranked by probability, and a TIE KEEPS THE INPUT
// ORDER (the retrieval's own), so the rerank can only ever move a candidate up and
// a pool the model has no opinion about is left exactly as it was found.
export function orderByChoice(top, answer) {
  const probs = (answer && answer.probabilities) || {};
  const scored = top.map((c, i) => ({ c: c, i: i, jev: typeof probs['p' + i] === 'number' ? probs['p' + i] : 0 }));
  scored.sort((a, b) => (b.jev - a.jev) || (a.i - b.i));
  return { order: scored.map(x => Object.assign({ jev: x.jev }, x.c)), none: typeof probs[JEV_NONE] === 'number' ? probs[JEV_NONE] : 0, pick: (answer && answer.choice) || '' };
}

// One call, one yes/no per candidate, the same shape rules.mjs uses. Batched so
// a wide net costs one request rather than forty.
export const JEV_STATE_CHARS = Number(process.env.RULES_JEV_STATE_CHARS) || 40000;

// How many Jev requests a process actually makes, by kind, and how many of
// them came back. A rerank-shaped call costs $0.000634 on the paid fallback, so
// this stopped being curiosity and became accounting: the page measured
// $0.005-0.007 a question, which is 8-11 calls where the code intends 2 per
// pass. A counter in the request path is the only honest way to see where they
// come from - a credits delta is too coarse.
//
// An ATTEMPT is the request leaving, an ANSWER is a response good enough to
// rank with, and a FAILURE is a call that threw. The counter used to increment
// before the request, so a 429 counted as a rerank: an arm measured while the
// free gateway was rate-limiting printed '66 rerank calls' and reproduced the
// recorded no-rerank row to the digit. Attempts alone cannot witness a success,
// which is exactly what made that artifact unverifiable - the failed count is
// the witness, and a bank arm must refuse to report numbers when it is set.
const JEV_CALLS = { rerank: { attempted: 0, answered: 0, failed: 0 }, gate: { attempted: 0, answered: 0, failed: 0 } };
const jevKind = k => ({ attempted: JEV_CALLS[k].attempted, answered: JEV_CALLS[k].answered, failed: JEV_CALLS[k].failed });
export function jevCalls() {
  const rerank = jevKind('rerank'), gate = jevKind('gate');
  return {
    rerank, gate,
    attempted: rerank.attempted + gate.attempted,
    answered: rerank.answered + gate.answered,
    failed: rerank.failed + gate.failed,
    total: rerank.answered + gate.answered,
  };
}
export function jevCallsReset() {
  for (const k of ['rerank', 'gate']) { JEV_CALLS[k].attempted = 0; JEV_CALLS[k].answered = 0; JEV_CALLS[k].failed = 0; }
}
// task-72: the rerank ARM. RULES_RERANK=jev|cf|off, jev the default; anything
// unknown is jev. 'off' is the no-call arm - the eval's --rerank off already
// reaches the call site as jevSkip, so this is belt and braces.
export function rerankArm(env) {
  const v = String((env || process.env).RULES_RERANK || 'jev').trim().toLowerCase();
  return v === 'cf' ? 'cf' : v === 'off' ? 'off' : 'jev';
}

// Cloudflare's bge-reranker-base is a cross-encoder: one score per candidate for
// one query, inside a 512-token context cap. Records are capped at 2000 chars
// (~500 tokens), so most fit; the rest are TRUNCATED and counted, never dropped.
export const CF_MAX_CHARS = 2000;
const CF_MODEL = '@cf/baai/bge-reranker-base';
const cfUrl = id => 'https://api.cloudflare.com/client/v4/accounts/' + id + '/ai/run/' + CF_MODEL;
const CF_STATS = { calls: 0, truncated: 0, returned: 0 };
export function cfStats() { return { arm: rerankArm(), calls: CF_STATS.calls, truncated: CF_STATS.truncated, returned: CF_STATS.returned }; }
export function cfStatsReset() { CF_STATS.calls = 0; CF_STATS.truncated = 0; CF_STATS.returned = 0; }

// The token is read from the credential store by the caller and never printed;
// tests/test-dev.mjs pins the same rule for the HTML. A missing token or account
// is a FAILED attempt, counted like every other rerank call, so an arm that could
// not run can never print as a good reading.
export async function cfRank(question, candidates, key, opts) {
  const o = opts || {};
  const top = (candidates || []).slice(0, o.max || 50);
  if (!top.length) return [];
  const account = o.account || credential('CLOUDFLARE_ACCOUNT_ID');
  JEV_CALLS.rerank.attempted++;
  try {
    if (!key) throw new Error('CLOUDFLARE_API_TOKEN is not in the credential store');
    if (!account) throw new Error('CLOUDFLARE_ACCOUNT_ID is not in the credential store');
    const contexts = top.map(c => {
      const text = String((c && (c.text || c.excerpt || c.content)) || '');
      if (text.length > CF_MAX_CHARS) { CF_STATS.truncated += 1; return { text: text.slice(0, CF_MAX_CHARS) }; }
      return { text };
    });
    const res = await fetch(cfUrl(account), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ query: String(question || ''), contexts: contexts, top_k: top.length }),
    });
    if (!res || !res.ok) throw new Error('cloudflare rerank HTTP ' + ((res && res.status) || 'no response'));
    const body = await res.json();
    const scored = (body && body.result && body.result.response) || (body && body.response) || [];
    if (!Array.isArray(scored) || !scored.length) throw new Error('cloudflare rerank: no scores');
    // The response carries the context index as `id`; a response without it is
    // mapped by position instead, so a record is never mis-assigned to a score.
    // `id` is the context index when present; an id-less response is mapped by the
    // position it came in at, before the score sort, so a record is never shifted
    // onto a neighbour's score.
    const mapped = scored.map((s, at) => ({ s: s, i: Number.isFinite(Number(s.id)) ? Number(s.id) : at }))
      .filter(x => x.i >= 0 && x.i < top.length)
      .sort((a, b) => Number(b.s.score) - Number(a.s.score));
    const seen = new Set();
    const out = [];
    for (const x of mapped) { if (seen.has(x.i)) continue; seen.add(x.i); out.push(top[x.i]); }
    if (!out.length) throw new Error('cloudflare rerank: no scorable records');
    CF_STATS.calls += 1; CF_STATS.returned += out.length;
    JEV_CALLS.rerank.answered++;
    return out;
  } catch (e) {
    JEV_CALLS.rerank.failed++;
    throw e;
  }
}


// The page keeps its graceful fallback - a 429 must not take the question with
// it - but a measurement arm must never degrade quietly. With RULES_JEV_STRICT
// set, a Jev failure throws instead of being absorbed, so an arm that would
// have fallen back stops loudly rather than printing a mixed number.
export function jevStrict() {
  const v = process.env.RULES_JEV_STRICT;
  return !!v && v !== '0' && v !== 'false' && v !== 'no';
}

export async function jevRank(question, candidates, key, opts) {
  const o = opts || {};
  const top = (candidates || []).slice(0, o.max || 50);
  if (!top.length) return [];
  JEV_CALLS.rerank.attempted++;
  try {
    const ranked = await jevRankOnce(question, top, key, o);
    JEV_CALLS.rerank.answered++;
    // The gateway that served this half (task-45) and the shape it was asked in
    // (task-47), read by the caller for the degraded-versus-ranked report. Properties
    // on the array keep the signature every caller already destructures.
    ranked.gateway = o.gateway || '';
    ranked.shape = o.shape || '';
    ranked.none = typeof o.jevNone === 'number' ? o.jevNone : 0;
    return ranked;
  } catch (e) {
    JEV_CALLS.rerank.failed++;
    throw e;
  }
}

// --- the gateway chain: free first, paid on a quota answer (task-45) ---------
// Every Jev call in this file goes through here, so there is one place that knows
// which gateway served a call, one place that counts the spend, and one place the
// fallback decision lives. The chain is walked in order and a QUOTA answer moves to
// the next gateway; a timeout, a 5xx and a malformed body do not (see
// gatewayVerdict in src/rules.mjs for why).
//
// The key is per gateway, read by name from the credential store - the caller passes
// the key for the FIRST gateway only when it is pinned to one (a harness, an eval arm
// with a stub endpoint), which is the `key` argument.
const JEV_TRANSPORT_TIMEOUT_MS = 60000;
async function jevPost(body, gateway, key, timeoutMs) {
  const res = await new Promise((resolve, reject) => {
    const u = new URL(gateway.endpoint);
    // The protocol the endpoint names: a custom RULES_JEV_ENDPOINT may be plain
    // http, and a local test gateway is.
    const req = (u.protocol === 'http:' ? http : https).request({ method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'Content-Length': Buffer.byteLength(body) } }, r => {
      const chunks = []; r.on('data', d => chunks.push(d));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let obj = null;
        try { obj = JSON.parse(text); } catch { /* an error page, not an answer set */ }
        resolve({ status: r.statusCode, obj, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || JEV_TRANSPORT_TIMEOUT_MS, () => req.destroy(new Error('jev timed out')));
    req.end(body);
  });
  return res;
}
// One decision request, walked down the chain. Returns the first gateway that
// ANSWERED (a body with answers) or throws naming every gateway it tried and why.
// The body is rebuilt per gateway because the model id belongs to the gateway.
async function jevChainCall(makeBody, opts) {
  const o = opts || {};
  const chain = o.chain || jevChain();
  const tried = [];
  // A QUOTA answer (429 / FreeUsageLimitError) moves down the chain - that is the
  // case Mandal named. So does a FAILURE (a timeout, a 5xx, a body with no answers):
  // the paid route exists to make the reader's rerank happen, and a free route that
  // timed out is exactly when paying for one call is worth it. The distinction that
  // matters is the LAST gateway's failure: that is what the caller's no-rerank
  // fallback turns into unranked order, and it is reported as such.
  for (const gateway of chain) {
    if (!gatewayAllowed(gateway)) { tried.push(gateway.name + ': over the daily cap'); continue; }
    const key = o.key && chain.length === 1 ? o.key : (credential(gateway.keyName) || o.key || '');
    if (!key) { tried.push(gateway.name + ': no key'); continue; }
    let res = null;
    try { res = await jevPost(makeBody(gateway.model), gateway, key, o.timeoutMs); }
    catch (e) {
      // A transport error is a timeout or a socket failure: counted as an attempt
      // that failed, never as a quota answer, and never retried on the next gateway.
      tried.push(gateway.name + ': ' + String((e && e.message) || e));
      if (o.onAttempt) o.onAttempt({ gateway: gateway.name, verdict: 'timeout', status: 0 });
      if (!gateway.free) break;   // the paid route failed: nothing after it to try
      continue;
    }
    const verdict = gatewayVerdict(res.status, res.text);
    if (o.onAttempt) o.onAttempt({ gateway: gateway.name, verdict: verdict, status: res.status });
    if (verdict === 'ok' && res.obj && res.obj.answers) {
      noteJevCall(gateway.name, res.obj && res.obj.usage && res.obj.usage.cost);
      return { gateway: gateway.name, obj: res.obj, res: res };
    }
    tried.push(gateway.name + ': HTTP ' + res.status + (verdict === 'quota' ? ' (quota)' : ''));
    if (!gateway.free) break;   // the paid route failed: nothing after it to try
  }
  const err = new Error('jev: no gateway answered (' + tried.join('; ') + ')');
  err.tried = tried;
  throw err;
}
// Every attempt is counted where it leaves and every answer where it arrives;
// a call that throws is an attempt and a failure, never an answer. The wrapper
// exists so the counting cannot drift back above the request again.
async function jevRankOnce(question, top, key, o) {
  // task-47: which shape to ask in. 'choice' is the default and the product's; the
  // noul path is kept whole so a before/after is one env var and the eval arms that
  // measure the old shape still run.
  const shape = jevShape(o);
  const questions = shape === 'choice'
    ? choiceAskFor(question, top)
    : (function () {
      const ask = o.ask || defaultAsk;
      const q = {};
      top.forEach((c, i) => { q['p' + i] = ask(i, c, question); });
      return q;
    })();
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
  // task-45: the chain, not one endpoint. Free first; a quota answer (429 /
  // FreeUsageLimitError) falls through to the paid route for THIS call and the rest
  // of the request, and the ledger records which gateway served it and what it cost.
  // o.endpoint is a harness override and pins the chain to that one transport.
  const chain = o.chain || (o.endpoint
    ? [Object.assign({}, jevChain()[0], { endpoint: o.endpoint, name: 'custom', free: true })]
    : jevChain());
  const out = await jevChainCall(model => JSON.stringify({ model: model, state, questions }), {
    key: key, chain: chain, timeoutMs: o.timeoutMs, onAttempt: o.onAttempt,
  });
  const answers = out.obj.answers;
  // Which gateway actually served it rides back on the options object, so jevRank's
  // return stays the array every caller already destructures.
  o.gateway = out.gateway;
  o.shape = shape;
  if (shape === 'choice') {
    const ranked = orderByChoice(top, answers && answers.pick);
    // The 'none' probability is recorded, never acted on (see JEV_NONE).
    o.jevNone = ranked.none;
    o.jevPick = ranked.pick;
    return ranked.order;
  }
  return top.map((c, i) => {
    const a = answers['p' + i];
    return Object.assign({ jev: a && typeof a.noul === 'number' ? a.noul : 0 }, c);
  }).sort((a, b) => b.jev - a.jev);
}

// --- the half gate ----------------------------------------------------------
// Which half of the corpus answers this question. One short item in, one label
// out: a choice rather than a judgement, which is the shape Jev is built for -
// translate-fr-en.mjs asks the same shape for a term's kind. The reason to ask
// at all is cost: a core-rules definition asked live pulled 21 candidates, 10
// from the rules half and 11 from factions, and the answer cited six, all of
// them rules. Half the context went to a half the question never used.
//
// The gate is measured, not trusted: `node tests/eval-retrieval.mjs --retriever
// gate` scores its routing against the bank's expectations and reports what a
// wrong route costs in sections lost. On any failure it returns no half rather
// than a guess, because the safe route for the page is to search both.
export const HALVES = ['rules', 'factions'];

export function gatePrompt(question) {
  return {
    half: {
      type: 'choice',
      instructions: 'Which half of a Warhammer 40,000 11th edition rules corpus answers this question: ' + question,
      criteria: {
        rules: 'the core rules, the rules appendix or the event companion - phases, movement, shooting, charging, terrain, objectives, missions, and the stratagems every army shares',
        factions: 'one army\'s own material - a datasheet, unit, weapon, stratagem, detachment or enhancement, anything that depends on which faction it is',
      },
    },
  };
}

// The same gate without a model: score the question's terms against each half's
// headings, weighted by how rare the term is in that half, and take the stronger
// one. Nothing to call and nothing to rate-limit, and it is the same evidence the
// retriever already uses - a question that names a datasheet names a heading in
// the faction half, and one about how a phase works names a core heading. It
// abstains rather than guessing when nothing matches or the two are too close,
// and an abstention means "search both", which is the safe route.
export function gateVocabularies(corpora) {
  const out = {};
  for (const half of Object.keys(corpora || {})) {
    const df = new Map();
    const headings = [];
    for (const s of corpora[half] || []) {
      const terms = new Set(grepTerms(s.heading));
      headings.push(terms);
      for (const t of terms) df.set(t, (df.get(t) || 0) + 1);
    }
    out[half] = { df, headings };
  }
  return out;
}

export function gateHalfLexical(question, vocab, opts) {
  const o = opts || {};
  const terms = grepTerms(question);
  // A term's weight comes from how many headings of EITHER half carry it, and
  // the score is the best SINGLE heading, not a scatter of words. Counting
  // occurrences corpus-wide fails on size: one coincidental 'escape' in 6,575
  // faction headings outscored the core heading that is actually called
  // 'Desperate Escape Test', because a raw count cannot tell a rare match from a
  // small corpus. A question names one rule, and that rule's words sit together
  // in one heading.
  const both = new Map();
  for (const half of Object.keys(vocab || {})) for (const [t, n] of vocab[half].df) both.set(t, (both.get(t) || 0) + n);
  const weight = t => 1 / Math.log(2 + (both.get(t) || 0));
  const score = {};
  for (const half of Object.keys(vocab || {})) {
    let top = 0;
    for (const set of vocab[half].headings) {
      let sc = 0;
      for (const t of terms) if (set.has(t)) sc += weight(t);
      if (sc > top) top = sc;
    }
    score[half] = Math.round(top * 1000) / 1000;
  }
  const order = Object.keys(score).sort((a, b) => score[b] - score[a]);
  const top = order[0], second = order[1];
  const margin = top !== undefined && second !== undefined ? Math.round((score[top] - score[second]) * 1000) / 1000 : 0;
  const minMargin = o.minMargin === undefined ? 0 : o.minMargin;
  if (top === undefined || score[top] <= 0) return { half: '', score, margin, abstain: 'no term in either half' };
  if (margin <= minMargin) return { half: '', score, margin, abstain: 'the two halves score within ' + minMargin };
  return { half: top, score, margin };
}

export async function gateHalf(question, key, opts) {
  const o = opts || {};
  if (!key) return { half: '', confidence: null, error: 'no jev key' };
  JEV_CALLS.gate.attempted++;
  let out;
  try {
    out = await gateHalfOnce(question, key, o);
  } catch (e) {
    JEV_CALLS.gate.failed++;
    throw e;
  }
  // A response that came back but names no usable label is a real abstention,
  // not a failure: the gate is built to say nothing rather than guess. An HTTP
  // error, a non-JSON body or a timeout is the failure the counter is for, and
  // it is what makes the gate arm's fallback (search both) visible.
  if (out.error) {
    JEV_CALLS.gate.failed++;
    if (jevStrict()) throw new Error('jev gate failed: ' + out.error);
  } else {
    JEV_CALLS.gate.answered++;
  }
  return out;
}

async function gateHalfOnce(question, key, o) {
  const gateState = 'A reader asks a Warhammer 40,000 11th edition rules question. The corpus has two halves: the core rules (how the game works for every army) and faction rules (what one army\'s own units and cards do).';
  // The same chain as the ranker (task-45): the gate is a Jev call too, and a quota
  // answer on it used to leave the run half-routed for no reason the reader could see.
  // o.endpoint is a harness override and pins the chain to that one transport.
  const chain = o.endpoint
    ? [Object.assign({}, jevChain()[0], { endpoint: o.endpoint, name: 'custom', free: true })]
    : jevChain();
  let gateOut = null;
  try {
    gateOut = await jevChainCall(model => JSON.stringify({ model: model, state: gateState, questions: gatePrompt(question) }), {
      key: key, chain: chain, timeoutMs: o.timeoutMs, onAttempt: o.onAttempt,
    });
  } catch (e) {
    // The gate is built to say nothing rather than guess, so a chain that ran out is
    // an abstention with a reason - never a thrown error the caller has to catch.
    return { half: '', confidence: null, error: String((e && e.message) || e), gateway: '' };
  }
  const obj = gateOut.obj;
  const a = obj && obj.answers && obj.answers.half;
  const choice = a && a.choice;
  return {
    half: HALVES.indexOf(choice) !== -1 ? choice : '',
    confidence: (a && a.confidence) || null,
    choice: choice || null,
  };
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

// One OpenAI-compatible call, used by the writer, the rewriter and the agent.
// Pure inference: none of them writes anything, which is why all three keep
// working when the vector index is out of write budget. The caller picks the
// route, so the agent can run on a small fast model while the answer keeps the
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
// What the route actually did, because a caller never sees it and the page's real
// call count is not what its code suggests. The free route returns an empty body
// (measured at about half its calls even with the gateway idle), and an empty body
// is fast and silent. These counters are published in /health, so a deployment can
// see the empty rate, the retries and how many retries landed.
const ROUTE_STATS = { calls: 0, empty: 0, truncated: 0, retries: 0, recovered: 0, byRoute: {} };
export function routeStats() {
  const byRoute = {};
  for (const [k, v] of Object.entries(ROUTE_STATS.byRoute)) byRoute[k] = Object.assign({}, v);
  return {
    calls: ROUTE_STATS.calls, empty: ROUTE_STATS.empty, truncated: ROUTE_STATS.truncated,
    retries: ROUTE_STATS.retries, recovered: ROUTE_STATS.recovered,
    empty_rate: ROUTE_STATS.calls ? Math.round(1000 * ROUTE_STATS.empty / ROUTE_STATS.calls) / 10 : 0,
    // task-89: the shape, the CALL it came from, and the provider's own usage for the last few.
    // These were being recorded on the route buckets and never surfaced, so /health could not
    // answer the one question the counters exist for.
    emptyShapes: Object.assign({}, ROUTE_STATS.emptyShapes || {}),
    emptyByStage: Object.assign({}, ROUTE_STATS.emptyByStage || {}),
    emptyCalls: (ROUTE_STATS.emptyCalls || []).slice(),
    // task-96: the share of the agent's first JSON replies that did not parse as an object.
    jsonShape: Object.assign({}, ROUTE_STATS.jsonShape || {}),
    // task-96: the last forty calls' provider usage, for the completion-token distribution.
    usage: (ROUTE_STATS.usage || []).slice(),
    byRoute,
  };
}
export function routeStatsReset() {
  ROUTE_STATS.calls = 0; ROUTE_STATS.empty = 0; ROUTE_STATS.truncated = 0;
  ROUTE_STATS.retries = 0; ROUTE_STATS.recovered = 0; ROUTE_STATS.byRoute = {};
  ROUTE_STATS.emptyShapes = {}; ROUTE_STATS.emptyByStage = {}; ROUTE_STATS.emptyCalls = [];
}

async function routeText(route, prompt, key, maxTokens, opts) {
  if (!key) return '';
  const name = route.name || route.model || 'route';
  const bucket = ROUTE_STATS.byRoute[name] || (ROUTE_STATS.byRoute[name] = { calls: 0, empty: 0, truncated: 0, retries: 0, recovered: 0 });
  let budget = maxTokens || 900;
  let last = '';
  let recovering = false;
  // task-89/task-91: set when a JSON call was cut on LENGTH, so the retry drops the reasoning
  // instead of buying more room to think. See the length branch below.
  let reasoningOff = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    ROUTE_STATS.calls++;
    bucket.calls++;
    if (attempt > 0) { ROUTE_STATS.retries++; bucket.retries++; }
    // The route carries a default; a caller may override it for one call - the
    // /rules page's fast mode asks the agent not to reason, deep asks it to.
    const startedCall = Date.now();
    const reasoning = reasoningOff ? 'none' : ((opts && opts.reasoning !== undefined) ? opts.reasoning : route.reasoning);
    // task-76: the reasoning control differs by gateway, and a wrong one is a 400 rather
    // than a bad answer - so both shapes are VERIFIED, not assumed: a live call to
    // OpenRouter's minimax with reasoning_effort returned 200 but reasoning 'null' (the
    // field is accepted and ignored), where reasoning.effort returned 200 WITH reasoning
    // text. SenseNova is the other way round: it reads reasoning_effort and does not know
    // the nested object. The host decides.
    const nested = /openrouter\.ai$/i.test(String(route.endpoint || ''));
    const jsonMode = JSON_MODE;
    const json = !!(opts && opts.json);
    // A nested-reasoning gateway may DEMAND it: OpenRouter's minimax answers 400
    // 'Reasoning is mandatory for this endpoint and cannot be disabled.' to a request
    // without it, so 'no reasoning' is asked for as the provider's cheapest effort rather
    // than by omitting the field. Measured: the agent's own retry (reasoning 'none') was
    // the call that emptied, 18 of 19 calls, and the log named it exactly.
    const effort = reasoning && reasoning !== 'none' ? reasoning : (nested ? 'low' : '');
    // task-96: A JSON CALLER NOW ASKS THE GATEWAY FOR AN OBJECT, instead of asking in the prompt
    // text alone and hoping. `json: true` was read only for the truncation treatment, so the
    // verdict, the terms, the translation and the sweep all left the shape to the model, and a
    // prose preamble is exactly what eats a 4000-token budget - the object arrives after it.
    // SenseNova is OpenAI-compatible and accepts this (measured 2026-10-22: 4 of 4 answered 200
    // with a clean object). RULES_JSON_MODE=0 turns it off for an A/B measurement.
    const body = JSON.stringify(Object.assign({
      model: route.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: budget,
    }, nested ? { reasoning: { effort: effort || 'low' } } : (effort ? { reasoning_effort: effort } : {}), jsonMode && json ? { response_format: { type: 'json_object' } } : {}));
    const res = await new Promise((resolve, reject) => {
      const u = new URL(route.endpoint);
      const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'Content-Length': Buffer.byteLength(body) };
      // The opencode.ai chat gateway routes on a session id and answers 400
      // MissingSessionID without one. Any stable id does - it is routing, not
      // authentication - so one per process is enough.
      if (/opencode\.ai$/i.test(u.hostname)) headers['x-opencode-session'] = SESSION_ID;
      // The endpoint is whatever RULES_*_ENDPOINT says - a local gateway on http is a
      // legitimate route (and the only way to test the fallback offline).
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request({ method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname, headers }, r => {
        const chunks = []; r.on('data', d => chunks.push(d));
        r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
      });
      req.on('error', reject);
      // A caller may bound one call below the route's default (task-31: the agent's
      // reasoning attempt, which is unbounded in practice on the fast model).
      req.setTimeout((opts && opts.timeout) || route.timeout || 180000, () => req.destroy(new Error('the model timed out')));
      req.end(body);
    });
    const choice = res && res.choices && res.choices[0];
    const content = String((choice && choice.message && choice.message.content) || '');
    last = content;
    // task-96: the DISTRIBUTION of what an ordinary call costs, straight from the provider's own
    // usage. The ladder test answered a one-sentence question for ~347 completion tokens; the
    // agent's real reply carries an answer, a quote, a why and arrays, so its normal size decides
    // whether the 4000 ceiling is simply too tight or whether a thin tail is doing something else.
    // A bounded ring of the last forty, read on /health.
    if (res && res.usage) {
      const ring = ROUTE_STATS.usage = ROUTE_STATS.usage || [];
      ring.push({
        stage: String((opts && opts.stage) || 'unlabelled'),
        prompt: Number(res.usage.prompt_tokens || 0),
        completion: Number(res.usage.completion_tokens || 0),
        max: budget,
        finish: choice ? String(choice.finish_reason || '') : '',
        chars: content.length,
        ms: Date.now() - startedCall,
      });
      if (ring.length > 40) ring.shift();
    }
    // task-70: an empty reply is RETRIED, not returned. It was returned as it always had
    // been, and the agent then read it as 'the agent did not answer', which the escalation
    // loop treats as 'not answered' - a statement about the corpus made from a call that
    // never happened. Measured on the Box: 2 empty and 3 truncated replies in 130 fast
    // calls, and a probe hit an empty body after one 180 s timeout and kept getting them.
    // A route that returns nothing has said nothing; it has not declined.
    if (!choice || !content.trim()) {
      ROUTE_STATS.empty++;
      bucket.empty++;
      // task-86: WHY it was empty, as a counter rather than a story. The failure is either
      // 'the gateway said nothing' (no choice, or an empty content field) or 'the gateway
      // thought instead of writing' (content null with finish_reason length), and the two
      // want different fixes. Recorded per route so /health can show the shape without a
      // second measurement round.
      const shape = !choice ? 'no-choice' : (choice.finish_reason === 'length' ? 'length' : 'empty-content');
      bucket.emptyShapes = bucket.emptyShapes || {};
      bucket.emptyShapes[shape] = (bucket.emptyShapes[shape] || 0) + 1;
      ROUTE_STATS.emptyShapes = ROUTE_STATS.emptyShapes || {};
      ROUTE_STATS.emptyShapes[shape] = (ROUTE_STATS.emptyShapes[shape] || 0) + 1;
      // task-89: WHICH CALL produced it, and WHAT THE PROVIDER SAID IT SPENT.
      //
      // The shape alone could not be attributed: three calls in the agent chain take 4000
      // tokens and an empty can come from any of them, so the last two budget changes were
      // guesses and one of them was wrong. `opts.stage` is the caller's own label for the call
      // (first / re-ask / object / terms / translate / sweep / writer), and the provider's
      // usage settles the 'length' question outright: completion_tokens equal to max_tokens
      // means the model spent the whole budget thinking, a small completion_tokens means
      // something else truncated it and the budget was a red herring. From the outside those
      // two are identical, which is exactly why they are recorded here.
      const stage = String((opts && opts.stage) || 'unlabelled');
      const usage = (res && res.usage) || null;
      const record = {
        shape,
        stage,
        attempt: attempt + 1,
        maxTokens: budget,
        promptTokens: usage ? Number(usage.prompt_tokens || 0) : null,
        completionTokens: usage ? Number(usage.completion_tokens || 0) : null,
        reportedMax: usage && usage.max_tokens !== undefined ? Number(usage.max_tokens) : null,
        finishReason: choice ? String(choice.finish_reason || '') : 'no-choice',
      };
      ROUTE_STATS.emptyCalls = ROUTE_STATS.emptyCalls || [];
      // Bounded: the last twenty are enough to attribute a shape and cheap to read on /health.
      ROUTE_STATS.emptyCalls.push(record);
      if (ROUTE_STATS.emptyCalls.length > 20) ROUTE_STATS.emptyCalls.shift();
      bucket.emptyByStage = bucket.emptyByStage || {};
      bucket.emptyByStage[stage] = (bucket.emptyByStage[stage] || 0) + 1;
      ROUTE_STATS.emptyByStage = ROUTE_STATS.emptyByStage || {};
      ROUTE_STATS.emptyByStage[stage] = (ROUTE_STATS.emptyByStage[stage] || 0) + 1;
      // A gateway that thinks BEFORE it writes can spend the whole budget on reasoning
      // and return content:null with finish_reason 'length' - OpenRouter's minimax does
      // (task-96: the usage of this call is already in the ring above, with chars 0.)
      // exactly that at 4000. That is the truncated-JSON case, so it gets the truncated
      // treatment: a bigger budget, not a shrug. Without this the agent answered
      // 'nothing parseable' on a call that had simply run out of room thinking.
      //
      // task-89/task-91: BUT A BIGGER BUDGET ALONE GIVES IT MORE ROOM TO THINK. Measured
      // with the attribution counter on the Box: the agent-first call returns content null,
      // finish_reason length, with completion_tokens 4000 EQUAL TO max_tokens 4000 - the model
      // spent the whole budget deliberating and never wrote. Doubling to 8000 keeps the same
      // reasoning setting, so it can spend 8000 the same way. The deliberation is the luxury
      // and the verdict is the product: a JSON call cut on LENGTH is retried WITHOUT reasoning,
      // which is the cheap path the agent already falls back to on a timeout.
      const cutOnLength = !!(choice && choice.finish_reason === 'length');
      if (cutOnLength) {
        budget *= 2;
        if (json) reasoningOff = true;
      }
      if (attempt < 2) { recovering = true; continue; }
      return content;
    }
    // A reply that stopped on the token limit is only usable when a cut cannot
    // break it. Prose that had to be cut is still prose; a JSON object cut
    // mid-string is not an object at all - and that is what a agent returned
    // once, which the caller read as 'nothing parseable' and answered "I do not
    // know" over findings that were fine. Those get a bigger budget instead.
    const truncated = choice.finish_reason === 'length';
    if (truncated) { ROUTE_STATS.truncated++; bucket.truncated++; }
    if (!truncated || (content.trim() && !json)) {
      if (recovering) { ROUTE_STATS.recovered++; bucket.recovered++; }
      return content;
    }
    budget *= 2;
    recovering = true;
  }
  return last;
}

// The writer's route: the cited answer the reader sees.
export async function modelText(prompt, key, maxTokens, opts) {
  return routeText({ name: 'model', endpoint: MODEL_ENDPOINT, model: MODEL, reasoning: MODEL_REASONING, timeout: MODEL_TIMEOUT_MS }, prompt, key, maxTokens, opts);
}

// The fast route: everything that only decides or rewrites - the translated
// question, the search terms, the verdict. Same call, a different model behind
// it, and the same route as the writer until RULES_FAST_* names another.
export async function fastText(prompt, key, maxTokens, opts) {
  return routeText({ name: 'fast', endpoint: FAST_ENDPOINT, model: FAST_MODEL, reasoning: FAST_REASONING, timeout: FAST_TIMEOUT_MS }, prompt, key, maxTokens, opts);
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

// task-75: the schema example, echoed back. The prompt ends with a filled-in example, and a
// small model sometimes returns the EXAMPLE as its answer instead of filling it in: the
// reply parses as valid JSON and reads as prose, so every earlier guard let it through and
// the reader was shown 'une phrase, dans les termes du lecteur' as the answer. Measured on
// the Box, French: see workspace/t75-report-2026-10-21.md.
//
// The fields are matched EXACTLY, not as substrings: a real answer may well CONTAIN
// 'one sentence', and the whole point is to catch the placeholder standing alone. The
// quote and why placeholders are matched too, because a model that echoes one field of the
// example is echoing the example.
const TEMPLATE_PLACEHOLDERS = [
  'une phrase, dans les termes du lecteur',
  'des mots copi\u00e9s verbatim du passage nomm\u00e9 dans from, ou null',
  'la raison, en deux ou trois phrases',
  "one sentence, in the reader's terms",
  'words copied verbatim from the passage named in from, or null',
  'the reason, in two or three sentences',
];
function isPlaceholder(value) {
  const s = String(value == null ? '' : value).trim();
  return !!s && TEMPLATE_PLACEHOLDERS.indexOf(s) !== -1;
}
// True when the parsed object is the prompt's own example rather than an answer.
export function agentTemplate(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return isPlaceholder(obj.answer) || isPlaceholder(obj.quote) || isPlaceholder(obj.why);
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

// The search terms are a rewrite, not a deliberation, so they run with reasoning
// OFF. They used to inherit the fast route's default 'medium' at a 900-token
// budget, and that budget went to the thinking: measured on the bank's own
// question, the call returned 0 characters where the same call with reasoning off
// returned 156 characters of terms. An empty term list is silent - the lexical
// grep simply has nothing to match and the reader never knows.
export async function expandQuery(question, key, opts) {
  if (!key) return [];
  return parseTerms(await fastText(expansionPrompt(question), key, 900, { reasoning: 'none', stage: 'terms' }));
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
// the agent and the writer need the question itself: 'Est-ce qu'Asurmen peut
// embarquer apres avoir tire' and 'asurmen embark shoot' are not the same
// question, and a agent shown the second one grades a question nobody asked.
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
  const parsed = parseTranslation(await fastText(translationPrompt(question, hits), key, 3000, { json: true, stage: 'translate' }));
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
// the work this is meant to avoid. The agent is asked the narrow question
// instead: do these passages state the rule that answers it? It is told to
// agent only what is written, because a model that answers from memory will
// mark a retrieval correct that never contained the rule.
// How much of each passage the agent is shown. It used to be 700 characters,
// which is a quarter of an Asurmen datasheet: his Battle Focus ability and the
// Agile Manoeuvres that answer a question about moving after shooting start
// around character 940, so the agent was asked whether the passages stated a
// rule while being shown none of the part that did. It answered honestly and
// wrongly, and the pipeline duly said it did not know.
//
// A agent blind to most of the evidence is not a cautious agent, it is a
// misinformed one. It now sees as much as the compiler does, and a passage that
// is still cut says so, so a "not stated" conclusion is at least made about text
// that was shown.
export const AGENT_PASSAGE_CHARS = 2400;
export const AGENT_TOTAL_CHARS = 60000;

// --- one hop: the agent may open a link --------------------------------------
// A datasheet's ability rarely states the rule; it names it and points at it
// ('Leader ... in the rules', 'Battle Focus - faction rule in the rules'). The agent
// was asked whether the passages state the rule while the rule sat one link away,
// and answered honestly and wrongly. One hop is aimed at exactly that case: the
// agent may name ONE link from the manifest below, that record's text is appended
// as a further passage, and the verdict is taken again on the longer list. There is
// no second hop - the retry is handed an empty manifest - so a chain cannot walk
// the corpus, and the cost of the feature is bounded at one extra agent call.
export const AGENT_FOLLOW_PER_PASSAGE = 4;
export const AGENT_FOLLOW_TOTAL = 24;

// --- the sweep: the agent names what it would have to look up --------------
// task-43. The one hop above failed for a reason that is now clear: a single hop has
// no stopping rule, so it fires when a link happens to be offered and says nothing
// when none is. A sweep is the same act with a termination condition - the agent
// names the searches it would still run to be sure, each is run for REAL, and the
// agent is shown what came back. An empty list of checks is the agent saying the
// passages settle it, and that is where the loop ends.
//
// The bounds are the feature's own safety: at most AGENT_SWEEP_ROUNDS extra rounds,
// AGENT_CHECKS_PER_ROUND searches in each, a wall-clock budget and a hard cap on the
// extra model calls. Every one of them is reported on the event, because a loop that
// cannot terminate is worse than no loop.
export const AGENT_CHECKS_MAX = 4;
export const AGENT_CHECKS_PER_ROUND = 4;
export const AGENT_SWEEP_ROUNDS = 2;
export const AGENT_SWEEP_BUDGET_MS = 25000;
export const AGENT_SWEEP_CALLS = 2;
export const AGENT_SWEEP_HITS = 3;

// Which links a agent may open, for the passages it was given. Only links whose
// target is really in the corpus, never a target already on screen, and capped both
// per passage and in total: the manifest is prompt, so it is spent on the first few
// links of the first passages rather than on all of them.
export function followManifest(passages, resolve, opts) {
  const o = opts || {};
  const per = o.perPassage || AGENT_FOLLOW_PER_PASSAGE;
  const total = o.total || AGENT_FOLLOW_TOTAL;
  const shown = new Set((passages || []).map(p => p && p.id).filter(Boolean));
  const out = [];
  let n = 0;
  for (let i = 0; i < (passages || []).length && n < total; i++) {
    const p = passages[i];
    const rec = p && p.id ? resolve(p.id) : null;
    const items = [];
    const seen = new Set();
    for (const l of ((rec && rec.links) || [])) {
      const id = String((l && l.to) || '');
      if (!id || seen.has(id) || shown.has(id)) continue;
      const target = resolve(id);
      if (!target) continue;
      seen.add(id);
      items.push({ k: String((l && l.kind) || ''), t: String(target.heading || (l && l.title) || id), id });
      if (items.length >= per) break;
    }
    if (!items.length) continue;
    out.push({ p: i + 1, passage: String(p.heading || p.id || ''), items });
    n += items.length;
  }
  return out;
}

// The manifest rendered for the prompt, and the one line that says the hop is closed.
function manifestLines(manifest) {
  if (!manifest || !manifest.length) return [];
  const lines = ['', 'Links you may open (numbered [passage.link]):'];
  for (const m of manifest) for (let j = 0; j < m.items.length; j++) {
    const it = m.items[j];
    lines.push('[' + m.p + '.' + (j + 1) + '] ' + it.t + (it.k ? ' (' + it.k + ')' : ''));
  }
  lines.push('', 'One hop is allowed. If a rule you need is named by a passage but not stated by it, name ONE link to open and its text is added to the passages before you rule. Name null when nothing needs opening.');
  lines.push('- follow: {"passage": 1, "link": 2} to open that link, or null. At most one.');
  return lines;
}

export function passageForAgent(p, i, cap) {
  const full = String(p.text || '');
  const cut = full.length > cap;
  const head = '[' + (i + 1) + '] ' + (p.set === 'factions' ? 'Faction rules' : 'Core rules') + ' - '
    + (p.faction ? p.faction + ' - ' : '') + p.heading + (p.ruleId ? ' (' + p.ruleId + ')' : '');
  const note = cut ? ' [TRUNCATED - showing the first ' + cap + ' of ' + full.length + ' characters]' : '';
  return head + note + '\n' + full.slice(0, cap);
}

// --- a negative about what is possible --------------------------------------
// task-56, Mandal's first-day warning: 'we need to be careful of the confidently
// wrong answer.' Asked 'Can a baneblade have an invulnerable save?', the agent was
// shown the datasheet, saw that its statline grants none, and answered 'No, a
// Baneblade does not have an invulnerable save.' A datasheet cannot show that
// NOTHING ELSE grants one, and the corpus holds the Tech-Priest Enginseer's
// Omnissiah's Blessing, which gives an ASTRA MILITARUM VEHICLE a 4+ invulnerable
// save while a Baneblade is exactly that. The agent was not wrong about what it
// read; it was wrong about the reach of a no.
//
// The rule is the sweep's absence copy (task-51) applied to the verdict: a
// negative about CAPABILITY is a claim about the records the agent was shown,
// never about the corpus. 'None of the records I was given grants one' is true
// and useful; 'the unit has no invulnerable save' is a claim about 7,390 records
// that a single retrieval never established.
//
// The pattern is deliberately narrow. It fires on permission and capability
// questions - can/could/may/is it possible, does it have, is there a way - and
// stays out of 'what does X do', where a plain answer is what the reader wants
// and a scope note would only be hedging. A question whose honest answer is no
// still gets a plain no; what changes is that the no says what was read.
export const CAPABILITY_RE = /\b(can|could|may|possible|allowed|permitted|able to|is there (?:a|any) way|(?:does|do|did)\b.{0,40}?\b(?:have|has|get|gets|gain|gains|benefit|benefits)\b|(?:is|are|was|were)\b.{0,40}?\b(?:able|allowed|permitted)\b)\b/i;

export function isCapabilityQuestion(question) {
  return CAPABILITY_RE.test(String(question || ''));
}

// The character each passage gets in the agent's prompt. A long list must not starve
// each passage, and a long passage must not starve the rest of the list - so the budget
// is divided. task-67 measured what that division costs: at the widest pass (63 passages)
// each gets 952 characters, and the Astra Militarum Tech-Priest Enginseer's record is
// 1,374 with its answer at character 1,043, so the agent read the ability's opening and
// never its effect, and answered no. Holding the passage list fixed and raising only the
// cap flipped the answer to yes.
//
// A record the SCOPE LEG found is therefore given its FULL length: the leg exists because
// that record is the answer to a question whose subject it never names, and a budget that
// cuts it is the same defect in a different place. The rest of the list shares what is
// left, so the cost lands on the passages that are not the leg's. An explicit perPassage
// still wins, so a measurement can pin one budget for every passage.
export function passageCaps(passages, opts) {
  const o = opts || {};
  const per = o.perPassage || AGENT_PASSAGE_CHARS;
  const total = o.totalChars || AGENT_TOTAL_CHARS;
  const list = passages || [];
  const n = Math.max(1, list.length);
  const shared = Math.max(400, Math.min(per, Math.floor(total / n)));
  if (o.perPassage) return list.map(() => shared);
  const full = list.filter(p => p && p.scope === true).length;
  if (!full) return list.map(() => shared);
  const rest = Math.max(1, n - full);
  const other = Math.max(400, Math.min(per, Math.floor((total - full * per) / rest)));
  return list.map(p => (p && p.scope === true) ? per : other);
}

// How many passages the budget cuts, and how many characters it drops: the cost of the
// division, published so it is visible rather than assumed (task-67 asks for it).
export function passageTruncation(passages, opts) {
  const caps = passageCaps(passages, opts);
  let cut = 0, dropped = 0;
  (passages || []).forEach((p, i) => {
    const len = String((p && p.text) || '').length;
    if (len > caps[i]) { cut += 1; dropped += len - caps[i]; }
  });
  return { passages: (passages || []).length, cut: cut, dropped: dropped, caps: caps };
}

// The scope leg's facts, as lines the agent reads beside the passages. Each names the
// record, the keyword its scope is written with, and the subject's own keyword that met
// it - which is exactly what the leg computed, not a conclusion drawn for the agent.
export function scopeLines(facts) {
  const list = facts || [];
  if (!list.length) return [];
  return ['', 'The scope check has already been run on these passages, mechanically:']
    .concat(list.map(f => {
      const scope = (f.scopeKeys || []).join(' ');
      return '- passage ' + f.n + ' (' + f.id + ') is scoped to ' + scope + '; the subject of the question carries ' + f.keyword + ', so that record APPLIES.';
    }))
    .concat(['It is still for you to read what that record grants.']);
}

export function agentPrompt(question, passages, opts) {
  const o = opts || {};
  const per = o.perPassage || AGENT_PASSAGE_CHARS;
  const total = o.totalChars || AGENT_TOTAL_CHARS;
  // Empty unless the caller enabled the hop, so the prompt the page already sends
  // is byte-identical when the feature is off.
  const manifest = o.manifest || [];
  // Per-passage budgets: the scope leg's records get their full length, the rest share
  // what is left (see passageCaps).
  const caps = passageCaps(passages, o);
  // The passages stay in the corpus's English; the verdict is read by the reader
  // and is therefore written in the page's language. The rule names quoted inside
  // it are still the rule names.
  //
  // One clause at the end of a long prompt was not enough: measured live, a
  // reasoning agent wrote its verdict in French on one call and in English on
  // the next, same question, same server. The language is therefore said twice -
  // in the JSON schema itself and in its own bullet - because a drifting call is
  // the failure mode, not a wrong option.
  const french = String(o.lang || '').slice(0, 2) === 'fr';
  const why = french
    ? '- why: say which passage states what, and what is missing when it is not answered. Two or three sentences on one line, in French (the passages and the rule names quoted from them stay in English); it is shown to the reader in full, so do not trail off.'
    : '- why: say which passage states what, and what is missing when it is not answered. Two or three sentences on one line; it is shown to the reader in full, so do not trail off.';
  const whyMust = french
    ? 'The "why", "answer", "quote", "exceptions" and "missing" fields are written in French. The "quote" is the exception inside that rule: it is copied VERBATIM from its passage and therefore stays in the passage\'s English. That is the field the reader reads.'
    : '';
  // task-24 (J4): the answer is written as slots, not a paragraph - the line, the
  // rule's own words under it, the passage they were copied from, the named rules
  // that change the answer, and what the corpus does not cover when it refuses.
  const schema = french
    ? '{"rules_question": true, "answered": true, "verdict": "oui", "confidence": "high", "widen": "both", "passages": [1,2], "answer": "une phrase, dans les termes du lecteur", "quote": "des mots copi\u00e9s verbatim du passage nomm\u00e9 dans from, ou null", "from": 1, "exceptions": [3], "missing": null, "why": "la raison, en deux ou trois phrases"}'
    : '{"rules_question": true, "answered": true, "verdict": "yes", "confidence": "high", "widen": "both", "passages": [1,2], "answer": "one sentence, in the reader\'s terms", "quote": "words copied verbatim from the passage named in from, or null", "from": 1, "exceptions": [3], "missing": null, "why": "the reason, in two or three sentences"}';
  // The follow member is declared only when a hop is on offer: a agent asked for a
  // field it cannot use invents a value for it. The same rule holds for the sweep's
  // checks, and it is why the fast prompt is byte-identical to what it was.
  const sweep = o.sweep === true;
  const followBit = manifest.length ? ' "follow": {"passage": 1, "link": 2},' : '';
  const sweepBit = sweep ? ' "checks": [{"what": "whether any detachment grants this", "query": "detachment grants fall back shoot"}],' : '';
  const schemaOut = (followBit || sweepBit) ? schema.replace('"passages": [1,2],', '"passages": [1,2],' + followBit + sweepBit) : schema;
  return [
    'You are grading a retrieval system for Warhammer 40,000 11th edition rules.',
    '',
    'Question: ' + question,
    '',
    'Retrieved passages:',
    passages.map((p, i) => passageForAgent(p, i, caps[i])).join('\n\n'),
    manifestLines(manifest).join('\n'),
    // task-70: the scope leg's own finding, stated as a fact. The leg's purpose is to find
    // records whose scope covers the subject; the agent was being asked to re-derive that
    // from two records' prose, and it is the inference it keeps getting wrong (a run wrote
    // 'it can only gain one if another rule, such as Omnissiah's Blessing from a Tech-Priest
    // Enginseer, grants it to it' and answered NO). Stating it removes the inference, not
    // the check: the agent still has to read what the record grants.
    scopeLines(o.scopeFacts).join('\n'),
    '',
    'Judge only what is written above, not what you know about the game.',
    'A passage marked TRUNCATED has more text that is not shown; if the rule could be in the unseen part, say so in "why" instead of concluding it is absent.',
    // task-59: the applicability check. Measured on the deployed Box: the Baneblade
    // question's findings hold the Enginseer's record ('select one friendly Astra
    // Militarum Vehicle model ... that VEHICLE model has a 4+ invulnerable save') at #9
    // AND the Baneblade's own keyword list (Astra Militarum, Vehicle, Titanic, ...) at
    // #25, and the agent answered no without mentioning Vehicle - six runs gave two yes
    // and four no on the same passages. It has both halves of the join and does not make
    // it. The same step catches the wrong yes (a record whose scope excludes the subject,
    // the Rampart Crest saving the unit the bearer LEADS and not the bearer).
    'A record that states a rule is not yet a record that APPLIES to the subject of the question.',
    '- Every record names a SCOPE: who the rule reaches. It is written in the record - "models in this model\u2019s unit", "the bearer", "one friendly Astra Militarum Vehicle model", "ADEPTUS MECHANICUS BATTLELINE models", "a friendly unit within 6\"". For each record you rely on, state that scope in "why" and say whether the SUBJECT of the question is inside it.',
    '- A record whose scope EXCLUDES the subject cannot support the answer, whichever way it reads. Name it and look for one that reaches the subject.',
    // task-82: the conditional-yes rule, and the pair that proves it. The Rampart Crest
    // gives a 5+ invulnerable save to 'models in that unit' while the bearer LEADS a unit.
    // The same record answers 'does a unit led by a Kahl have a 5+ save' YES and 'can a Kahl
    // have a 5+ save from its crest' NO, because the Kahl is the bearer, not a model in the
    // unit it leads. The bank encodes it and the old prompt left both halves to luck.
    '- A grant has a SUBJECT and often a CONDITION. Two questions can rest on one record and have opposite answers: yes when the grant reaches the subject of the question, no when it reaches a different one, however similar the wording.',
    '- A conditional yes is still a YES, and its answer MUST state the condition in the same sentence - "Yes, while the bearer is leading that unit" - because the condition is the answer. Never a bare "Yes" for a conditional grant, and never a yes when the scope puts the subject outside the grant.',
    '- A scope is usually a KEYWORD rather than the subject\u2019s name. When the passages carry the subject\u2019s own keyword list, compare it with the scope: if the subject carries a keyword the scope names, the record APPLIES and the answer is what it says. This is the join, and it is written in the passages, not in what you know about the game.',
    '- Once the scope check is done the answer is DECISIVE: yes when a record that applies grants it, no when none does. Do not answer "no general answer is given" or "it depends" when a record in front of you applies - that is the hedge this check exists to prevent.',
    o.scoped === true
      ? [
        'This question asks whether something is possible or permitted, and that changes what a no may claim.',
        '- The answer must never state what a unit has or does not have. A datasheet shows what that datasheet lists; it is not evidence about what an army rule, a stratagem or another unit can grant. The wording is "none of the records I was given grants ..." - a statement about the records in front of you, not about the unit or the game.',
        '- Answer yes outright when one of the records grants it, and name that record. When none does, the scoped no is the answer; it is not a hedge and it must not be softened into vagueness.',
        '- In "why", name the kind of record that would settle it if it exists, so the reader can see what was and was not checked.',
        '- In "missing", state the search that would settle it. A rule that permits something usually names a KEYWORD (VEHICLE, INFANTRY, CHARACTER, PSYKER, TITANIC) rather than the unit, so say which keyword the answer would hang on.',
      ].join('\n')
      : '',
    'Reply with JSON only:',
    schemaOut,
    whyMust,
    '- rules_question: is this a question about 40k rules at all? Some are about tournaments, paint or the subreddit.',
    '- answered: do the passages state the rule needed to answer it? Partial coverage is not answered.',
    // task-71: the verdict's own polarity, so two agents can be compared by what they
    // SAID rather than only by whether they spoke. Measured on the key question: five runs
    // WITH the field returned 'yes' five times; five runs without it returned no verdict at
    // all, which is what left the disagreement detector blind. It also forces the headline
    // to commit, which is the shape behind 'does not have it by default, but can gain it' -
    // that answer's verdict is yes.
    '- verdict: the polarity of YOUR answer LINE, one of "yes", "no" or "unclear". It is what the answer says, not what the passages contain: an answer that says the unit does not have it by default but can gain it is "yes". "unclear" only when the answer genuinely cannot commit. Give it whenever answered is true.',
    '- confidence: how sure you are of that verdict. "high" when a passage states the rule outright, "med" when the passages are about the right subject but do not settle it, "low" when the retrieval looks off-topic or the question names something absent from the passages. Always give one of the three.',
    '- widen: only when answered is false, which half to search deeper next. "rules" if it is the core rules that are missing, "faction" if it is a datasheet, stratagem or enhancement, "both" if you cannot tell which. Always give one of the three.',
    '- passages: the numbers that carry the answer, best first; [] if none do.',
    french
      ? '- answer : une phrase qui r\u00e9pond \u00e0 la question dans les termes du lecteur, sans h\u00e9sitation et sans \u00ab le passage dit que \u00bb. C\'est la ligne que le lecteur lit ; la citation est le texte de la r\u00e8gle en dessous.'
      : '- answer: one sentence that answers the question in the reader\'s terms, no hedging and no "the passage says". It is the line the reader reads; the quote is the rule\'s own words under it.',
    french
      ? '- quote : des mots copi\u00e9s VERBATIM du passage nomm\u00e9 dans "from", rien d\'autre - pas de paraphrase, pas de fusion de deux passages, pas de ponctuation ajout\u00e9e. null quand aucun passage ne dit la r\u00e8gle dans les mots du lecteur.'
      : '- quote: words copied VERBATIM from the passage you name in "from" and nothing else - no paraphrase, no joining two passages, no added punctuation. null when no single passage states the rule in the reader\'s words.',
    french
      ? '- from : le num\u00e9ro du passage d\'o\u00f9 la citation a \u00e9t\u00e9 copi\u00e9e, ou null.'
      : '- from: the passage number the quote was copied from, or null.',
    french
      ? '- exceptions : les num\u00e9ros des passages qui sont des r\u00e8gles nomm\u00e9es et qui changent la r\u00e9ponse (\u00ab sauf si ... \u00bb). [] quand aucune ne le fait.'
      : '- exceptions: the numbers of any passages that are named rules changing the answer ("unless ..."). [] when none do.',
    french
      ? '- missing : seulement quand answered est false - ce que le corpus ne couvre pas, en une ou deux phrases. null quand answered est true.'
      : '- missing: only when answered is false - what the corpus does not cover, in one or two sentences. null when answered is true.',
    french
      ? '- verdict : la polarite de TA phrase de reponse, "oui", "non" ou "incertain". C\'est ce que dit la reponse, pas ce que disent les passages : une reponse qui dit que l\'unite ne l\'a pas par defaut mais peut l\'obtenir est "oui". "incertain" seulement quand la reponse ne peut vraiment pas trancher. A donner quand answered est true.'
      : '',
    sweep
      ? '- checks: what you would have to LOOK UP to be sure the answer is not incomplete. Ask yourself what could make it WRONG or narrow - an exception in another chapter, a detachment or army rule that grants it, a unit whose own datasheet overrides the general rule - and name each as a search. "what" is the claim you are checking, "query" is the words a rulebook would use to state it (a search, never a question). Up to four, best first. [] only when you can already see that nothing outside these passages could change the answer; when in doubt, name the check. This is not "follow": a follow opens a link a passage already names, a check is a search the corpus has not run.'
      : '',
    why,
  ].filter(Boolean).join('\n');
}

// How much a agent's reasoning is worth, for deciding whose refusal counts. The
// bank measured the same agent at 61.8% with reasoning off and 79.4% with it on,
// and 'high' measured no deeper than 'medium'. An unknown setting - a custom
// endpoint told nothing - ranks as the equal of anything, so it can still
// downgrade rather than being silently ignored.
export function agentStrength(reasoning) {
  const r = String(reasoning || '').toLowerCase();
  if (r === 'none') return 0;
  return 1;
}

// Two verdicts on the same findings. The caller annotates the answer it already
// sent rather than replacing it, so this decides three things: whether the two
// disagree at all, who dissented, and whether that dissent may downgrade the
// answer.
//
// A second refusal binds only when it comes from a agent at least as reliable as
// the one that answered. Fast mode pairs a quick binding agent with a careful
// second, so the careful refusal still downgrades - that is the case the rule was
// written for. Deep mode pairs a careful binding agent with a quick second, and
// there the quick refusal must NOT stamp a correct answer 'not confirmed': the
// less accurate agent was vetoing the more accurate one, which is a design bug
// and not a display one. A weaker dissent is still reported, as a dissent.
export function reconcileVerdicts(binding, second) {
  const a = binding ? binding.answered : null;
  const b = second ? second.answered : null;
  if (a === null || a === undefined || b === null || b === undefined) return { disagreement: false, conservative: 'binding', downgrade: false, dissenter: '', polar: false };
  if (a === b) {
    // task-71: TWO JUDGES THAT BOTH ANSWERED CAN STILL DISAGREE, and that is the case
    // Mandal hit - agent 1 'does not have it by default, but can gain it', agent 2 'yes, a
    // Baneblade can have one' - recorded as agreement because only `answered` was
    // compared. The verdict field is what they are compared on now. Two answers with no
    // verdict at all cannot be compared, and stay as they were: not a disagreement, but
    // not evidence of agreement either.
    const va = normalizeVerdict(binding && binding.verdict);
    const vb = normalizeVerdict(second && second.verdict);
    // 'unclear' is a agent saying it cannot commit. That is not a polarity to disagree
    // with, so only yes against no counts - the sentence this catches is the one that
    // names the condition and still says yes, against one that says no.
    const polar = (va === 'yes' || va === 'no') && (vb === 'yes' || vb === 'no') && va !== vb;
    if (a === true && polar) {
      // The stronger agent's answer gets the headline: agentStrength is the measured one
      // (61.8% with reasoning off against 79.4% with it on).
      const secondStronger = agentStrength(second.reasoning) > agentStrength(binding.reasoning);
      return { disagreement: true, conservative: secondStronger ? 'second' : 'binding', downgrade: false, dissenter: secondStronger ? 'binding' : 'second', polar: true };
    }
    return { disagreement: false, conservative: 'binding', downgrade: false, dissenter: '', polar: false };
  }
  // Only the second agent's refusal has something to downgrade: when the binding
  // agent refused, the answer is already the cautious one.
  if (b === false) {
    const downgrade = agentStrength(second.reasoning) >= agentStrength(binding.reasoning);
    return { disagreement: true, conservative: downgrade ? 'second' : 'binding', downgrade, dissenter: 'second', polar: false };
  }
  return { disagreement: true, conservative: 'binding', downgrade: false, dissenter: 'binding', polar: false };
}

// task-71: the verdict's polarity, folded to yes / no / unclear. A model reaches for its
// own language ('oui', 'non') and for synonyms ('true', 'false', 'uncertain'), and an
// unknown value is '' - no verdict - rather than a wrong one.
export function normalizeVerdict(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (/^(yes|y|true|oui|vrai|correct)$/.test(s)) return 'yes';
  if (/^(no|n|false|non|faux|incorrect)$/.test(s)) return 'no';
  if (/^(unclear|uncertain|unknown|maybe|incertain|indetermine|ind\u00e9termin\u00e9)$/.test(s)) return 'unclear';
  return '';
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

// task-24 (J4): the trace check. The ruling is printed as the agent wrote it, and the
// page's claim to soundness rests on every checkable phrase in it being present in
// the passages the ruling itself names: the quote's own passage, the exceptions and
// the cited passages. A figure the cited passage does not carry is a fabricated one,
// and the reader is told rather than shown a confident wrong answer. Returns
// { total, dropped, bad, quoteOk }: bad holds the offending tokens so the client can
// strike them, and quoteOk is false when the quote is not in the passage it names.
export function traceRuling(ruling, passages) {
  const list = Array.isArray(passages) ? passages : [];
  const r = ruling || {};
  const text = p => String((p && (p.text || p.passage || p.excerpt)) || '');
  const fold = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const nums = [];
  const add = n => { if (Number.isInteger(n) && n >= 1 && n <= list.length && nums.indexOf(n) === -1) nums.push(n); };
  add(r.from);
  for (const n of (Array.isArray(r.exceptions) ? r.exceptions : [])) add(n);
  for (const n of (Array.isArray(r.passages) ? r.passages : [])) add(n);
  // Case-insensitive: a quoted stretch may open a sentence in the passage and be
  // quoted mid-sentence in the answer, which is the same words.
  const hay = fold(nums.map(n => text(list[n - 1])).join('\n')).toLowerCase();
  const answer = String(r.answer || '');
  const quote = String(r.quote || '');
  const bad = [];
  let total = 0;
  for (const figure of (answer + ' ' + quote).match(/\b\d{2,}\b/g) || []) {
    total += 1;
    if (hay.indexOf(figure) === -1 && bad.indexOf(figure) === -1) bad.push(figure);
  }
  for (const span of answer.match(/["\u201c]([^"\u201d]{12,})["\u201d]/g) || []) {
    const inner = fold(span.replace(/^["\u201c]|["\u201d]$/g, '')).toLowerCase();
    total += 1;
    if (inner && hay.indexOf(inner) === -1 && bad.indexOf(span) === -1) bad.push(span);
  }
  // The quote must be in the passage it NAMES. A truncated passage is not a
  // fabrication, so a shared 40-character prefix counts as found - the same
  // tolerance the approved mockup used.
  let quoteOk = true;
  if (quote) {
    total += 1;
    const own = fold(quote).toLowerCase();
    const inOwn = r.from && list[r.from - 1] ? fold(text(list[r.from - 1])).toLowerCase() : '';
    const probe = own.length > 40 ? own.slice(0, 40) : own;
    quoteOk = !!inOwn && (inOwn.indexOf(own) !== -1 || inOwn.indexOf(probe) !== -1);
    if (!quoteOk && bad.indexOf(quote) === -1) bad.push(quote);
  }
  return { total: total, dropped: bad.length, bad: bad, quoteOk: quoteOk };
}

// The ruling's slots, taken from one agent object. Split out of agentAsk so the
// fallbacks are a tested interface rather than a branch inside a network call:
// - no answer means the empty string (the client falls back to the recommendation line)
// - no quote, or a refusal, means null - and a refusal NEVER carries a quote
// - from/exceptions are passage numbers of the list the agent was shown
// - missing is for the refusal only; an answer does not explain what is absent
// The trace is computed here, against the passages the ruling names, so `trace` and
// the slots it describes cannot drift apart.
export function rulingSlots(obj, answered, passages) {
  const o = obj || {};
  const list = Array.isArray(passages) ? passages : [];
  const inRange = n => Number.isInteger(n) && n >= 1 && n <= list.length;
  const from = inRange(parseInt(o.from, 10)) ? parseInt(o.from, 10) : null;
  const exceptions = Array.isArray(o.exceptions)
    ? o.exceptions.map(n => parseInt(n, 10)).filter(inRange).filter((n, i, a) => a.indexOf(n) === i)
    : [];
  const answer = String(o.answer || '').trim();
  const quote = typeof o.quote === 'string' && o.quote.trim() ? o.quote.trim() : null;
  const missing = typeof o.missing === 'string' && o.missing.trim() ? o.missing.trim() : null;
  const ruling = {
    answer: answer,
    quote: answered ? quote : null,
    from: answered ? from : null,
    exceptions: answered ? exceptions : [],
    passages: Array.isArray(o.passages) ? o.passages : [],
  };
  return {
    answer: answer,
    quote: ruling.quote,
    from: ruling.from,
    exceptions: ruling.exceptions,
    missing: answered ? null : missing,
    trace: traceRuling(ruling, list),
  };
}

// A verdict that says 'no' while its own sentence grants the capability. The refusal shape
// is 'does not have ... but it can gain one from ...'; the answer that follows its own
// reasoning is a yes. Only a refusal is tested, so an answer that already says yes cannot
// be turned into a re-ask by this.
// NOT WIRED IN (task-70): the mechanical join took the key case from 7/10 to 9/10, and the
// detector's own false positive - a correct no that names an exception ('only the unit it
// leads can have one') - would re-ask a verdict that is already right. It is kept, tested
// and unused until a card authorises the re-ask itself.
export function contradictsItself(obj) {
  const o = obj || {};
  if (o.answered === true) return false;
  const text = String(o.answer || '');
  if (!text.trim()) return false;
  // A no is stated first; a yes is stated first. Only the second shape is a contradiction.
  if (/^\s*(yes\b|it can|a unit can|they can|such a unit can|the answer is yes)/i.test(text)) return false;
  // The capability is granted TO the subject: 'one can be granted to it', 'it can gain
  // one', 'the unit can have one'. A refusal that names an exception about ANOTHER model
  // ('only the unit it leads can have one') is not a contradiction, so the pronoun or the
  // subject has to be in the clause.
  return /\b(can|may) be (granted|given|obtained|received)\b[^.]{0,30}?\b(it|them|this|that model|the (?:unit|model|vehicle))\b/i.test(text)
    || /\b(it|this|the (?:unit|model|vehicle)|such a (?:unit|model))\b[^.]{0,30}?\b(can|may)\b[^.]{0,30}?\b(have|gain|get|obtain|receive|be granted)\b/i.test(text)
    || /\bcan gain one\b|\bcan have one\b|\bcan obtain one\b/i.test(text);
}

// task-86: a result the agent could not produce is a FAILURE, and it says so on the result
// itself.
//
// The flag used to be set only in the server's WRITER branch, which is after the
// `if (!writerOn) return` that the page's request takes, so on the page's own path
// `agent.failed` was never true and the failure card task-78 built could not be reached: a
// reader whose agent returned nothing got a ruling card with no ruling. The route is not what
// failed, the RESULT is, so every failure return carries it and every caller sees it.
//
// It also carries the numbers the rate needs: which call died (first, re-ask, parse) and how
// long it took, so an empty reply can be told from a timeout without a second guess.
// The first call's output budget, and the last latency item (task-89/task-96).
//
// The attribution counter settled the question: every empty on the agent's FIRST call comes back
// with content null, finish_reason 'length', and completion_tokens EQUAL to max_tokens - the
// model spends the whole budget thinking and never writes. 4000 output tokens is the same wall
// as the 45s reasoning bound seen from the other end. The knob exists so both arms of the
// measurement run on ONE deploy; it is not a tuning dial to be turned on a single sample.
const FIRST_TOKENS = Number(process.env.RULES_AGENT_FIRST_TOKENS) || 4000;

// task-96: whether a JSON caller asks the gateway for an object (response_format json_object).
// Measured 2026-10-22 on SenseNova: accepted, 200 with a clean object, 4 of 4. Off with
// RULES_JSON_MODE=0, which exists so the preamble rate can be measured on both arms.
const JSON_MODE = process.env.RULES_JSON_MODE !== '0';

function agentFailure(why, extra) {
  return Object.assign({
    rulesQuestion: null,
    answered: null,
    failed: true,
    confidence: '',
    passages: [],
    why,
  }, extra || {});
}

// One agent call: the prompt, the parse, and the one extra ask the verdict is worth.
// Split out of agentCoverage so the hop can run it twice on two lists.
async function agentAsk(question, passages, key, o, manifest) {
  const callOpts = o.reasoning === undefined ? { json: true } : { json: true, reasoning: o.reasoning };
  // task-56: a capability question gets the scoped-negative rule, and the scope
  // travels with the QUESTION rather than with the caller - the page, the CLI and
  // the sweep all ask the same question and must all get the same discipline. An
  // explicit o.scoped wins either way, so a measurement can force one arm.
  const scoped = o.scoped === undefined ? isCapabilityQuestion(question) : o.scoped === true;
  // task-70: the scope leg's finding travels with the passages as a stated fact, unless a
  // measurement turns it off (RULES_SCOPE_FACTS=0, or o.scopeFacts).
  const facts = o.scopeFacts !== undefined
    ? o.scopeFacts
    : (process.env.RULES_SCOPE_FACTS === '0' ? [] : scopeFacts(passages, question));
  const prompt = agentPrompt(question, passages, Object.assign({}, o, { manifest: manifest || [], scoped, scopeFacts: facts }));
  // task-31: the reasoning verdict is the slow, unbounded step. Bound it, and when
  // it does not come back ask the same prompt without reasoning - a agent that
  // answered without thinking beats a run that died thinking. Measured on the fast
  // model: 27.6s with reasoning medium against 3.6s without, on one 18.6k prompt.
  const asking = !!(o.reasoning && o.reasoning !== 'none');
  const callStarted = Date.now();
  let raw = '';
  try {
    raw = await fastText(prompt, key, FIRST_TOKENS, asking ? Object.assign({}, callOpts, { timeout: AGENT_REASONING_TIMEOUT_MS, stage: 'agent-first' }) : Object.assign({}, callOpts, { stage: 'agent-first' }));
  } catch (e) {
    const firstMs = Date.now() - callStarted;
    if (!asking) return agentFailure('the agent did not answer: ' + String((e && e.message) || e), { raw: true, stage: 'first', ms: firstMs });
    try {
      raw = await fastText(prompt, key, FIRST_TOKENS, Object.assign({}, callOpts, { reasoning: 'none', stage: 'agent-re-ask' }));
    } catch (e2) {
      return agentFailure('the agent did not answer: ' + String((e2 && e2.message) || e2), { raw: true, stage: 're-ask', ms: firstMs, reAskMs: Date.now() - callStarted - firstMs });
    }
  }
  let obj = parseJsonObject(raw);
  // task-96: THE PREAMBLE RATE, as a counter rather than a story. The first reply of the agent
  // chain is a JSON call, and this counts the share of those that did NOT parse as an object on
  // the first try - which is the shape failure a reader feels as a failure card. Measured before
  // the gateway was asked for an object (the off counters) and after (calls / clean).
  ROUTE_STATS.jsonShape = ROUTE_STATS.jsonShape || { calls: 0, clean: 0, off: 0, offClean: 0 };
  ROUTE_STATS.jsonShape.calls++;
  if (JSON_MODE) { if (obj) ROUTE_STATS.jsonShape.clean++; }
  else { ROUTE_STATS.jsonShape.off++; if (obj) ROUTE_STATS.jsonShape.offClean++; }
  // A small model sometimes answers the judgement in prose instead of the object
  // it was asked for. The verdict is binding - an unparseable one is read as
  // "I do not know" - so it is asked once more, for the object alone, rather
  // than the reader being told the rule is absent because a brace was missing.
  // Asking once more was not enough on a long list: measured, the fast model drifts into
  // a prose preamble on roughly a fifth of calls at a 30 KB prompt, and a single retry
  // left the reader with 'the agent returned nothing'. It is asked up to three times in
  // all, and only when the object is missing - a verdict that parsed is never re-asked.
  // task-31: these re-asks are a wait too, so they run without reasoning and stay
  // bounded - the verdict's words are what matters, not the deliberation behind it.
  const reOpts = Object.assign({}, callOpts, { reasoning: 'none' });
  // task-88: the OBJECT re-ask gets the first call's budget, not a tight one. It is the only
  // call in the chain whose emptiness loses the whole verdict, and it was the only tight
  // budget in it (1200 against 4000). The provider's empty shape is a BUDGET shape: measured
  // on this route, 2 of 6 calls came back with content null at max_tokens=16 and none of 6 did
  // at 4000, and the counters show the same thing as 'length' (content null, finish_reason
  // 'length' - the model spent the budget thinking and wrote nothing). RULES_AGENT_REASK_TOKENS
  // moves it for a measurement; it is not a tuning knob.
  const REASK_TOKENS = Number(process.env.RULES_AGENT_REASK_TOKENS) || 4000;
  // task-75: a reply that IS the schema example is re-asked exactly like a missing object,
  // and with the word that stops the copying. It parses, so nothing else in this file
  // catches it.
  const mustNotCopy = '\n\nYour previous reply was the EXAMPLE from the schema, not an answer: it repeated the placeholder text of the example. Reply with the JSON object only, in one line, and with the fields FILLED IN for this question. Do not copy the wording of the example.';
  for (let ask = 1; (!obj || agentTemplate(obj)) && ask < (o.maxAsks || 3); ask++) {
    try {
      // The FIRST re-ask is the plain one - it is the old behaviour, and it applies to a
      // reply that was missing. When the reply we already hold IS the example, or when a
      // plain re-ask has already failed, the prompt says what went wrong instead.
      const prior = ask > 1 || agentTemplate(obj) ? mustNotCopy : '\n\nReply with the JSON object only, in one line, and nothing else.';
      obj = parseJsonObject(await fastText(prompt + prior, key, REASK_TOKENS, Object.assign({}, reOpts, { stage: 'agent-object' })));
    } catch (e) { break; }
  }
  if (agentTemplate(obj)) {
    // Three asks and it is still the template. That is not a refusal and not an answer:
    // the records may hold the rule and this call never read them. Reported as such.
    ROUTE_STATS.template = (ROUTE_STATS.template || 0) + 1;
    return agentFailure('the agent returned the schema example instead of an answer', { template: true, stage: 'parse' });
  }
  if (!obj) return agentFailure('agent returned nothing parseable', { raw: true, stage: 'parse' });
  const answered = obj.answered === true;
  // The model is asked to always give one; when it does not, the verdict itself
  // is the fallback rather than an empty field, because the caller escalates on
  // this and a blank must not read as certainty.
  let confidence = normalizeConfidence(obj.confidence);
  if (!confidence) confidence = answered ? 'med' : 'low';
  const inRange = n => Number.isInteger(n) && n >= 1 && n <= passages.length;
  const passageNumbers = Array.isArray(obj.passages) ? obj.passages.map(n => parseInt(n, 10)).filter(inRange) : [];
  const slots = rulingSlots(Object.assign({}, obj, { passages: passageNumbers }), answered, passages);
  return {
    rulesQuestion: obj.rules_question !== false,
    answered,
    // task-71: the polarity the answer LINE committed to, '' when the agent gave none.
    // A refusal has no verdict - it says nothing about the answer, only about the
    // records - so it is never invented from `answered`.
    verdict: answered ? normalizeVerdict(obj.verdict) : '',
    confidence,
    widen: normalizeWiden(obj.widen),
    passages: passageNumbers,
    // task-24 (J4): the ruling's slots. answered:false never carries a usable quote,
    // whatever the model wrote in the field.
    answer: slots.answer,
    quote: slots.quote,
    from: slots.from,
    exceptions: slots.exceptions,
    missing: slots.missing,
    trace: slots.trace,
    // Not sliced. A 160-character cap here cut the agent's reasoning mid-word,
    // and the reader was shown a verdict that stopped in the middle of the
    // sentence explaining it. What the agent says is the page's headline; it is
    // published whole, and the prompt asks for the sentences it takes.
    why: String(obj.why || ''),
    // What the agent asked to open, named but not yet resolved: the caller owns the
    // corpus, so it is the caller that turns a name into a record.
    follow: obj.follow && typeof obj.follow === 'object'
      ? { passage: parseInt(obj.follow.passage, 10), link: parseInt(obj.follow.link, 10) }
      : null,
    // task-43: what the agent says it would have to check to be sure nothing is
    // missing. Normalised here (a string where an object was asked for, a query that
    // is only punctuation) and capped; running them is the caller's job, because the
    // caller owns the corpus and the search legs.
    checks: normalizeChecks(obj.checks, o.checksMax),
  };
}

// The checks a agent asked for, in the one shape the runner reads. Anything that is
// not a usable search is dropped rather than run: a check with no query would be
// marked absent after searching nothing, and 'absent' is the one verdict this
// feature exists to make true.
export function normalizeChecks(raw, max) {
  const cap = Math.max(Number(max) || AGENT_CHECKS_MAX, 1);
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= cap) break;
    const o = typeof item === 'string' ? { what: item, query: item } : (item || {});
    const what = String(o.what == null ? '' : o.what).trim().slice(0, 200);
    const query = String(o.query == null ? '' : o.query).trim().slice(0, 200);
    // A query needs words to search on: punctuation and single characters are not a
    // search, and a check that cannot be searched cannot be called absent.
    if (query.replace(/[^\p{L}\p{N}]+/gu, '').length < 3) continue;
    out.push({ what: what || query, query: query });
  }
  return out;
}

// A named link -> the record it points at, or null. Everything is re-checked against
// the manifest the agent was actually shown: a model that answers [3.7] when it was
// offered two links is not followed, it is ignored.
export function resolveFollow(follow, manifest, resolve) {
  if (!follow) return null;
  const p = follow.passage, l = follow.link;
  if (!(p >= 1) || !(l >= 1)) return null;
  const m = (manifest || []).find(x => x.p === p);
  if (!m) return null;
  const it = m.items[l - 1];
  if (!it) return null;
  const rec = resolve(it.id);
  return rec ? { passage: p, link: l, rec } : null;
}

// --- the sweep: one check, run for real --------------------------------------
// A check is a search the agent asked for, and it runs through the SAME two legs the
// retrieval runs: the lexical leg over the indexable corpus, and the vector leg. Both
// go through indexedSections()/deliveredHits(), so a check can never surface a record
// the product filters out (Legends, the pack line, a navigation page) - the guarantee
// that a sweep cannot smuggle in what the answer is not allowed to cite.
//
// The two legs are joined by id, in the order they were found, and the already-shown
// passages are dropped: a check that only finds what the agent has read has found
// nothing new, and saying 'absent' there would be a lie about the search.
export async function runChecks(checks, opts) {
  const o = opts || {};
  const list = (checks || []).slice(0, Math.max(Number(o.max) || AGENT_CHECKS_PER_ROUND, 1));
  const corpus = indexedSections(o.corpus || readAllCorpus());
  const shown = o.shown || new Set();
  const limit = Math.max(Number(o.hits) || AGENT_SWEEP_HITS, 1);
  const lexical = (query, cap) => {
    const terms = grepTerms(query);
    if (!terms.length) return [];
    return grepWithTerms(terms, corpus, Math.max(cap * 4, 12), query)
      .filter(sec => sec && sec.id && !shown.has(String(sec.id)))
      .slice(0, cap)
      .map(sec => ({ id: String(sec.id), heading: String(sec.heading || sec.id), set: sec.set || '', leg: 'lexical' }));
  };
  const vector = async (query, cap) => {
    if (o.vector === false) return [];
    try {
      const hits = await queryIndex(query, { topK: Math.max(cap * 3, 10), cfg: o.cfg, namespace: o.namespace });
      const byId = new Map(corpus.map(s => [String(s.id), s]));
      const out = [];
      for (const h of hits) {
        const sec = byId.get(String(h.id));
        if (!sec || shown.has(String(h.id))) continue;
        out.push({ id: String(sec.id), heading: String(sec.heading || sec.id), set: sec.set || '', leg: 'vector' });
        if (out.length >= cap) break;
      }
      return out;
    } catch (e) { return []; }
  };
  const out = [];
  for (const c of list) {
    const query = String((c && c.query) || '').trim();
    const what = String((c && c.what) || query);
    // task-49: the check's own number rides through, so a check that is re-run in a
    // later round is still the SAME check and the reader sees one row for it.
    const n = (c && Number(c.n)) || 0;
    // The lexical leg is a grep and costs nothing; the vector leg is a network call.
    // Both run: the sweep's claim is about the corpus, and one leg missing a record
    // the other finds is exactly the case that would make an 'absent' wrong.
    let hits = [];
    let ran = true;
    let error = '';
    try {
      const lex = lexical(query, limit);
      const seen = new Set(lex.map(h => h.id));
      const vec = await vector(query, limit);
      hits = lex.concat(vec.filter(h => !seen.has(h.id))).slice(0, limit);
    } catch (e) { ran = false; error = String((e && e.message) || e); }
    out.push({ n: n, what: what, query: query, ran: ran, hits: hits, verdict: '', id: '', why: '', error: error });
  }
  return out;
}

// What the agent is shown about the checks it asked for, and what it is asked back.
// The passages are labelled c1, c2... so a verdict can point at one without a second
// numbering scheme, and a check whose search found nothing says so in the prompt:
// 'nothing' is information, and the agent is the one who decides whether that settles
// the claim or whether the search was phrased wrong.
export function sweepPrompt(question, checks, opts) {
  const o = opts || {};
  const french = String(o.lang || '').slice(0, 2) === 'fr';
  // Enough of a record to agent whether it answers the check, not the whole record:
  // this prompt carries up to four checks x three hits, and every character here is
  // latency on a phone. The id and heading are always complete.
  const cap = Math.max(Number(o.passageChars) || 400, 120);
  const lines = [
    'You are grading a retrieval system for Warhammer 40,000 11th edition rules.',
    '',
    'Question: ' + question,
    '',
    'You said these still had to be checked. Each has now been searched for in the corpus, and what the search returned is under it.',
  ];
  checks.forEach((c, i) => {
    lines.push('', 'CHECK ' + (i + 1) + ': ' + c.what, 'searched for: ' + c.query);
    if (!c.ran) lines.push('the search DID NOT RUN (' + (c.error || 'unknown') + ') - you cannot call this absent.');
    else if (!c.hits.length) lines.push('the search ran and found nothing in the corpus.');
    else for (const h of c.hits) {
      lines.push('  c' + (i + 1) + ' [' + h.id + '] ' + h.heading);
      if (h.text) lines.push('    ' + String(h.text).slice(0, cap));
    }
  });
  lines.push(
    '',
    'Reply with JSON only:',
    '{"checks": [{"n": 1, "absent": true, "id": null, "why": "one sentence"}]}',
    '- n: the CHECK number this verdict is about, one entry per check.',
    '- absent: true ONLY when the search ran and found nothing that states the rule. A search that did not run is never absent.',
    '- id: the record id (the [id] in brackets) that answers the check, or null when none does. Use an id that was shown above, never one you invent.',
    french ? '- why : une phrase, en fran\u00e7ais.' : '- why: one sentence.',
  );
  return lines.join('\n');
}

// The agent's verdicts on its own checks, applied to the check list. A verdict that
// names a record the search did not return is refused rather than trusted - the same
// discipline resolveFollow() applies to a named link - and a check whose search did
// not run stays unresolved whatever the agent says.
export function applySweepVerdicts(checks, obj) {
  const verdicts = (obj && Array.isArray(obj.checks)) ? obj.checks : [];
  const out = (checks || []).map(c => Object.assign({}, c));
  for (const v of verdicts) {
    const n = parseInt((v || {}).n, 10);
    if (!(n >= 1) || n > out.length) continue;
    const c = out[n - 1];
    const why = String((v && v.why) || '').trim().slice(0, 240);
    const id = v && v.id != null ? String(v.id) : '';
    const hit = id ? (c.hits || []).find(h => h.id === id) : null;
    if (hit) { c.verdict = 'answered'; c.id = hit.id; c.why = why; continue; }
    if (v && v.absent === true && c.ran) { c.verdict = 'absent'; c.id = ''; c.why = why; continue; }
    c.verdict = 'unresolved'; c.why = why;
  }
  // A check the agent said nothing about is unresolved, never absent: silence is not
  // a search that came back empty.
  for (const c of out) if (!c.verdict) c.verdict = 'unresolved';
  return out;
}

// The whole sweep, bounded. One round is: run the checks the agent named, show it what
// came back, and take its verdicts. A round ends the loop when every check it resolved
// is ABSENT - the agent has said the corpus does not hold what it was worried about,
// which is the statement this feature exists to make - or when the agent resolves
// nothing new. The bounds are checked before each round and reported on the result.
export async function sweepChecks(question, checks, opts) {
  const o = opts || {};
  const started = Number.isFinite(o.startedAt) ? o.startedAt : Date.now();
  const budgetMs = Number.isFinite(o.budgetMs) ? o.budgetMs : AGENT_SWEEP_BUDGET_MS;
  const maxRounds = Math.max(Number(o.rounds) || AGENT_SWEEP_ROUNDS, 1);
  const maxCalls = Math.max(Number(o.calls) || AGENT_SWEEP_CALLS, 0);
  const perRound = Math.max(Number(o.checksPerRound) || AGENT_CHECKS_PER_ROUND, 1);
  const shown = o.shown || new Set();
  const all = [];
  let calls = 0;
  let round = 0;
  // 'nothing-to-check' is a real ending and it is the one the reader needs told
  // apart from 'nobody looked' (task-49): the agent answered and named nothing.
  let stopped = 'nothing-to-check';
  let pending = normalizeChecks(checks, perRound).map((c, i) => ({ n: i + 1, what: c.what, query: c.query }));
  while (pending.length) {
    if (round >= maxRounds) { stopped = 'rounds'; break; }
    if (calls >= maxCalls) { stopped = 'calls'; break; }
    if (Date.now() - started >= budgetMs) { stopped = 'budget'; break; }
    round += 1;
    const ran = await runChecks(pending, { corpus: o.corpus, shown: shown, hits: o.hits, max: perRound, vector: o.vector, cfg: o.cfg, namespace: o.namespace });
    // The agent reads what the search returned; a check whose search found nothing
    // is shown that, because 'nothing' is the answer it has to agent.
    const withText = ran.map(c => Object.assign({}, c, { hits: (c.hits || []).map(h => Object.assign({}, h, { text: (o.textOf ? o.textOf(h.id) : '') })) }));
    let obj = null;
    // The budget has to bound the CALL, not just the top of the round: one resolution
    // call took 74 s against a 45 s budget and the sweep reported itself unbounded.
    // Whatever is left of the budget is the call's own timeout, so the deadline is
    // real and a call that eats it is recorded as unresolved rather than absent.
    const left = budgetMs - (Date.now() - started);
    if (left <= 0) {
      // The search ran and its results are real, so they are kept - a check whose
      // search found nothing is still NOT absent, because no agent read it. The
      // verdicts stay empty and the reason is the bound.
      all.push.apply(all, ran.map(c => Object.assign({}, c, { verdict: 'unresolved' })));
      stopped = 'budget';
      break;
    }
    calls += 1;
    // The model call is injectable, like every other network step in this file: the
    // loop's termination and its bounds are the feature's contract, and a test that
    // has to spend real calls to pin them is a test nobody runs.
    const ask = o.ask || (prompt => fastText(prompt, o.key, 1200, { json: true, reasoning: 'none', timeout: left, stage: 'sweep' }));
    try {
      const raw = await ask(sweepPrompt(question, withText, o), { round: round, checks: withText, leftMs: left });
      obj = parseJsonObject(raw);
    } catch (e) { obj = null; }
    const resolved = applySweepVerdicts(ran, obj);
    all.push.apply(all, resolved);
    for (const c of resolved) for (const h of (c.hits || [])) shown.add(h.id);
    // Termination, in three endings and only three:
    //  - every check came back ABSENT: the agent has said the corpus does not hold what
    //    it was worried about, which is the statement this feature exists to make;
    //  - nothing was resolved at all: the agent had nothing to say about its own
    //    checks, so another round would ask the same question again;
    //  - every check was ANSWERED: the agent found a record for each, so there is
    //    nothing left it said it needed;
    //  - otherwise only the checks it could NOT resolve are carried into the next
    //    round. That is the deepening the feature is for: the records the first round
    //    found are in the shown set, so the same search reaches further down the list,
    //    and the rounds, calls and budget bounds end the walk. A check it resolved is
    //    never re-run - repeating a search that already answered costs a phone seconds
    //    and can only return what the reader has.
    const absent = resolved.filter(c => c.verdict === 'absent');
    const unresolved = resolved.filter(c => c.verdict === 'unresolved');
    if (absent.length === resolved.length && resolved.length) { stopped = 'absent'; break; }
    if (!unresolved.length) { stopped = 'answered'; break; }
    // A check the agent could not settle is re-run with the OTHER half of what it
    // wrote: 'what' is the claim, 'query' was the search, and searching the claim's own
    // words is a different search that can reach records the first one did not. The
    // same query would return the same list and the round would cost a phone seconds
    // for nothing, which is why the loop does not simply repeat itself.
    const next = unresolved
      .map(c => ({ n: c.n, what: c.what, query: String(c.what || '').trim() }))
      .filter(c => normalizeChecks([c], 1).length);
    if (!next.length) { stopped = 'nothing-new'; break; }
    pending = next;
  }
  // task-49: `checks` keeps EVERY attempt, in order, so the trace can see that a
  // check was re-run and why; `final` is one entry per check carrying the LAST
  // outcome, which is what the reader is shown. The footer's count is final.length
  // and the rows come from the same array, so they cannot disagree.
  const attempts = {};
  const byN = new Map();
  all.forEach((c, i) => {
    const n = c.n || (i + 1);
    attempts[n] = (attempts[n] || 0) + 1;
    byN.set(n, Object.assign({}, c, { n: n }));
  });
  const final = [...byN.values()].sort((a, b) => a.n - b.n).map(c => Object.assign({}, c, { attempts: attempts[c.n] || 1 }));
  return {
    rounds: round, checks: all, final: final, calls: calls, ms: Date.now() - started,
    absent: final.filter(c => c.verdict === 'absent').map(c => c.what),
    answered: final.filter(c => c.verdict === 'answered').length,
    unresolved: final.filter(c => c.verdict === 'unresolved').length,
    stopped: stopped,
    bounds: { rounds: maxRounds, checksPerRound: perRound, budgetMs: budgetMs, calls: maxCalls },
  };
}
export async function agentCoverage(question, passages, key, opts) {
  const o = opts || {};
  const manifest = (o.follow && typeof o.resolve === 'function') ? followManifest(passages, o.resolve, o) : [];
  const first = await agentAsk(question, passages, key, o, manifest);
  // The control arm: the manifest is offered and the prompt is byte-identical, and the
  // hop is refused. It separates 'the agent changed because it was offered a link' from
  // 'the agent changed because it opened one' - which are different claims about the
  // feature and only one of them is about the feature.
  if (o.noHop) return first;
  if (!manifest.length || !first.follow) return first;
  const t = resolveFollow(first.follow, manifest, o.resolve);
  if (!t) return first;
  // The opened record rides as a passage of its own, marked, so the verdict can cite
  // it by number like any other and the page can say where it came from.
  const opened = Object.assign({}, t.rec, { openedFrom: t.passage });
  let second;
  try { second = await agentAsk(question, passages.concat([opened]), key, o, []); }
  catch (e) { return Object.assign({}, first, { followFailed: String((e && e.message) || e) }); }
  return Object.assign({}, second, { followed: { from: t.passage, link: t.link, to: t.rec.id, title: String(t.rec.heading || t.rec.id), hop: 1 } });
}

// --- what to do when the agent says no --------------------------------------
// A agent that flags a retrieval as insufficient and is then ignored is worse
// than no agent: it produces a confident answer to a question the system has
// already established it cannot answer. So the verdict is binding, and a miss
// deepens the search rather than being answered anyway.
//
// One widening was never enough. 'Can Asurmen re-embark after shooting' missed
// the Embarking rule on the first pass, missed it again on the widened one (it
// sat below the reranker's cut at 50), and was declared absent by a system whose
// corpus holds it - the agent had simply never been shown it. The search now
// keeps deepening by WIDEN_ADD findings a round, aimed at the half the agent
// named, until the agent says it can answer.
//
// What bounds that: each round re-shows the whole candidate list to the agent,
// so a widened pass is a slower and more expensive call, and past a point the
// per-passage cap in agentPrompt starts cutting the evidence the agent is asked
// to agent. RULES_MAX_PASSES (default 3) is the ceiling; the last pass is final
// by definition, so a miss there is still reported as not knowing.
//
// Finding a passage that was ranked 7th is a real win. Guessing from a passage
// that was ranked 3rd and is about something else is not, and the difference is
// exactly what the agent is for.
export const ESCALATION_TOPKS = [10];
export const WIDEN_ADD = 20;
export const MAX_PASSES = Math.max(1, Number(process.env.RULES_MAX_PASSES) || 3);

// --- the two settings the page offers --------------------------------------
// Not a speed dial: measured, the agent's wall-clock is its own reasoning, not
// the size of the prompt (holding the question and the route fixed, 10 findings
// and 23 findings came out at a 31.9s and a 33.0s mean). So the fast setting
// buys its seconds where the seconds are - the agent does not think - and pays
// for them where the benchmark says the thinking is worth it (79.4% -> 61.8% on
// the real bank). Taking fewer findings is the second half of it: a smaller
// prompt that costs no recall once the rerank is on - on the 29-question bank
// per-side 5 is at least as good as 10 on every reported column (reachable
// 51.7 / 86.2 / 93.1 / 93.1 against 48.3 / 86.2 / 93.1 / 93.1, MRR 0.670 against
// 0.648) while handing the agent 13.1 passages instead of 23.4 - with the
// anchoring still guaranteeing the rule the question names.
export const ASK_MODES = {
  fast: { first: 5, passes: 2, reasoning: 'none', second: 'medium', grepNet: 50, jevMax: 60 },
  // task-43: deep is where the sweep runs. The bounds live here with the rest of the
  // mode's settings, and every one of them is reported on the event: a loop that
  // cannot terminate is worse than no loop, so the reader is told when one stopped it.
  deep: {
    first: 10, passes: 3, reasoning: 'medium', second: 'none', grepNet: 60, jevMax: 80,
    sweep: { rounds: 2, checksPerRound: 4, budgetMs: 45000, calls: 2, hits: 3 },
  },
};
// Fast is the default: the reader gets the answer while the question is still in
// mind. Deep stays reachable by asking for it explicitly - one word in the request
// body or in a harness - and ASK_MODES keeps both entries.
export function askMode(value) {
  const s = String(value == null ? '' : value).toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(ASK_MODES, s) ? s : 'fast';
}

// The writer - the "answer" call that turns findings into prose - is OFF by
// default. What the page shows is the findings, the agent's verdict, the citations
// and the marks; the prose is a later format whose home is going to be the agent,
// so the call is switched off rather than deleted. RULES_WRITER=1 (or
// writer: true in the request) turns it back on for whoever wants it.
export function writerEnabled(env, requested) {
  if (requested !== undefined && requested !== null) {
    if (typeof requested === 'boolean') return requested;
    return ['1', 'true', 'on', 'yes'].indexOf(String(requested).trim().toLowerCase()) !== -1;
  }
  const e = env || process.env;
  const v = String(e.RULES_WRITER == null ? '' : e.RULES_WRITER).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

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

export function dontKnowAnswer(agent, lang) {
  const why = (agent && agent.why) ? agent.why : 'no passage states the rule.';
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
    'The agent: ' + why,
    '',
    'This is not an answer, it is a statement of absence. Two likely causes: the rule is not in this copy (a missing datasheet or stratagem), or the question falls outside what the corpus covers. An invented answer here would be worse than none.',
  ].join('\n');
}

// The escalation loop, with the retrieval and the judging injected so the
// policy can be tested without network calls.
export async function answerableFindings(question, opts) {
  const o = opts || {};
  const base = (o.topKs && o.topKs[0]) || ESCALATION_TOPKS[0];
  // Until the agent stops, not once: a question the corpus can answer must not
  // be declared unanswerable because the first two looks missed. MAX_PASSES is
  // the ceiling, not the plan.
  const passes = Math.max(1, o.passes || MAX_PASSES);
  const retrieve = o.retrieve || ((q, plan) => retrieveDual(q, Object.assign({}, o.dual, { perSide: plan })));
  const agent = o.agent || ((q, findings) => agentCoverage(q, findings, o.fastKey, o.agentOpts));
  const attempts = [];
  let widened = false;
  let plan = { rules: base, factions: base };
  for (let i = 0; i < passes; i++) {
    const dual = await retrieve(question, plan);
    let findings = dual.all.map((s, idx) => findingFor(s, idx + 1));
    // A curator, when one is given, sees the list the agent and the writer are
    // about to see and may drop, cap and reorder it. The previous attempt travels
    // with it, so a passage an earlier pass already passed over can be dropped
    // rather than judged again. Nothing changes by default: with no curator the
    // list is exactly what it always was.
    if (o.curate) findings = o.curate(findings, { question, plan, attempt: i, previous: attempts[attempts.length - 1] });
    if (o.onFindings) o.onFindings({ plan, findings, dual, attempt: i });
    const verdict = await agent(question, findings);
    const final = verdict.answered === true || i === passes - 1;
    attempts.push({ plan, findings, agent: verdict, dual, final });
    if (o.onAgent) o.onAgent({ agent: verdict, plan, attempt: i, final });
    if (verdict.answered === true) break;
    if (!final) { widened = true; plan = widenPlan(verdict.widen, plan); }
  }
  const last = attempts[attempts.length - 1];
  return {
    findings: last.findings,
    agent: last.agent,
    dual: last.dual,
    attempts: attempts.map(a => ({
      plan: a.plan, count: a.findings.length, answered: a.agent.answered === true,
      confidence: a.agent.confidence, widen: a.agent.widen, final: a.final,
    })),
    unresolved: last.agent.answered !== true,
    escalated: widened,
  };
}

// --- merging retrievers -----------------------------------------------------
// Vector scores are rank-fusion values in a narrow band and grep scores are
// term counts; they are not on the same scale and must not be compared. Rank
// fusion merges the two lists without pretending otherwise - a section both
// retrievers like wins, and one only a single retriever found still gets in.
// Reciprocal rank fusion. Lists may be weighted: the two retrievers are not
// equally good at the top - measured on the retrieval bank, a dense vector
// query alone lands the expected section first 62% of the time and a hybrid one
// 59%, while our own grep does not - and an unweighted merge lets a long grep
// list walk over the head of a short vector list.
export function rrfMerge(lists, k, weights) {
  const weight = k || 60;
  const w = weights || [];
  const score = new Map();
  const item = new Map();
  lists.forEach((list, li) => {
    const scale = w[li] || 1;
    (list || []).forEach((entry, i) => {
      const id = entry.id;
      if (!id) return;
      item.set(id, entry);
      score.set(id, (score.get(id) || 0) + scale / (weight + i + 1));
    });
  });
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

// --- the scope leg: a rule scoped to a KEYWORD, reachable FROM that keyword -------
// task-65, from task-57's and task-61's measurements. A rule that says 'select one
// friendly ASTRA MILITARUM VEHICLE model' is scoped to a keyword that is not on the
// record's own unit: the Astra Militarum Tech-Priest Enginseer's Omnissiah's Blessing
// reaches a Baneblade, and neither the Enginseer's keywords (Infantry, Character) nor
// the Baneblade's (Titanic, Vehicle) are in the other's record. Measured: the
// Enginseer sits at lexical rank 24 of 80 and is absent from the vector top 80, and
// embedding either record's own keywords does not reach it (task-61: -3.0 points at
// every level on the 33-bank).
//
// So the bridge is the SCOPE PHRASE itself, and this is an index of it: a record whose
// text names a KEYWORD as the target of a grant is indexed under that keyword. The leg
// fires only when the question names an entity (an anchor), takes only THAT entity's own
// keywords, and is capped - a blanket keyword boost was measured to make things worse
// (task-57: the Enginseer was not in a keyword-boosted lexical list's top 40).
// The words that introduce a scope target and carry no keyword themselves. 'ONE' and
// 'FRIENDLY' are how every grant in the corpus opens; the rest are the connectives a
// scope phrase uses ('all models in that unit', 'each time a model in this unit').
const SCOPE_STOP = new Set(['ONE', 'A', 'AN', 'ANY', 'EACH', 'ALL', 'EVERY', 'THAT', 'THIS', 'THE', 'FRIENDLY', 'ENEMY', 'OTHER', 'SUCH', 'ITS', 'HIS', 'HER', 'YOUR', 'YOURS', 'MORE', 'MOST', 'EVERYONE', 'SELECT', 'SELECTED', 'CHOOSE', 'WITHIN', 'WITH', 'FROM', 'INTO', 'IN', 'OF', 'TO', 'AND', 'OR', 'IF', 'WHILE', 'WHEN', 'THEN', 'IT', 'ITSELF', 'THEIR', 'THEM', 'THESE', 'THOSE', 'BEFORE', 'AFTER', 'DURING', 'UNTIL', 'AT', 'BY', 'FOR', 'ON', 'UP', 'AS']);

// Every keyword a record's scope phrases name. A scope target is a run of KEYWORDS
// immediately before the word 'model'/'unit' - 'one friendly ASTRA MILITARUM VEHICLE
// model', 'ADEPTUS MECHANICUS BATTLELINE models', 'INFANTRY unit'. The run is read
// backwards from the target noun and stops at the first word that is not a keyword, so
// the sentence before it cannot leak in. Built from the corpus once, like the header
// projection: no index write, no model, no embedding.
// Character codes, not a regex class: [^A-Z0-9'\u2019-] was measured to swallow most
// of the alphabet (a hyphen in a class reads as a range), which turned 'Vehicle' into
// 'V' and dropped every keyword. A predicate cannot be misread that way.
const isWordChar = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 39;
const isUpperChar = c => (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 39;

// A KEYWORD is a word written in capitals - all of it ('VEHICLE') or its first letter
// only ('Astra Militarum Vehicle'). A sentence word ('friendly', 'one') is neither, and
// a stop word is excluded by name. Both spellings are in the corpus: the CSV writes
// 'Astra Militarum Vehicle model', the core rules write 'ADEPTUS MECHANICUS BATTLELINE'.
export function isScopeKeyword(word) {
  const w = String(word || '');
  if (w.length < 3) return false;
  const first = w.charCodeAt(0);
  if (first < 65 || first > 90) return false;
  for (const c of w) if (!isUpperChar(c.charCodeAt(0)) && !(c.charCodeAt(0) >= 97 && c.charCodeAt(0) <= 122)) return false;
  const upper = w.toUpperCase();
  return !SCOPE_STOP.has(upper);
}

// The verbs a grant opens with. A scope target is only indexed when one of these is in
// the same sentence window: without it the index fills with records that merely MENTION
// a keyword ('Are models that are within the boundary of a terrain area...'), which is
// the noise the leg cannot afford - it is capped at three records.
const SCOPE_VERB = /\b(select|selected|has|have|gains?|grant(?:s|ed)?|equipped|bearer|regains?|becomes?|is|are|target|choose|allows?|lets?)\b/i;

export function scopeKeywords(text) {
  const out = new Set();
  const t = String(text || '');
  for (const m of t.matchAll(/\b(?:model|models|unit|units)\b/g)) {
    const from = Math.max(0, m.index - 80);
    const before = t.slice(from, m.index);
    const words = before.split(/[^A-Za-z0-9']+/).filter(Boolean);
    const keys = [];
    for (let i = words.length - 1; i >= 0; i--) {
      if (!isScopeKeyword(words[i])) break;
      keys.push(words[i].toUpperCase());
    }
    if (!keys.length || !SCOPE_VERB.test(before)) continue;
    for (const k of keys) out.add(k);
  }
  return out;
}

export function scopeIndex(records) {
  const index = new Map();
  for (const r of records || []) {
    for (const key of scopeKeywords(r.text)) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(r);
    }
  }
  return index;
}

// The records the entity's own keywords scope, best first: a record that grants
// something to the keyword beats one that merely mentions it, and a shorter record
// beats a longer one (the same shape the header search ranks by). `terms` are the
// question's own content words - a scope record that also answers the question's
// capability is the one to show, and that is the only ranking signal available
// without a model.
export function scopeLookup(question, index, keywords, opts) {
  const o = opts || {};
  const cap = Math.max(Number(o.cap) || 3, 1);
  // A keyword list holds multi-word entries ('ASTRA MILITARUM'); the index is keyed by
  // the single words a scope phrase is made of, so each is looked up on its own words.
  const list = [];
  for (const k of keywords || []) for (const w of String(k).split(/\s+/)) if (w.length >= 3 && list.indexOf(w) === -1) list.push(w);
  if (!list.length || !index) return [];
  // A RARE keyword is the one that identifies the entity: BANEBLADE scopes two records
  // and TITANIC a hundred, so a record scoped to the entity's rarest keyword is a better
  // answer than one scoped to VEHICLE alone. Measured on the model case: counting matched
  // keywords put the Enginseer 6th behind four stratagems that scope VEHICLE; weighting
  // them by rarity is what puts the record scoped to ASTRA MILITARUM VEHICLE first.
  const idf = new Map();
  const total = Math.max(index.size, 1);
  for (const key of list) idf.set(key, Math.log(1 + total / (1 + (index.get(key) || []).length)));
  // An EMPTY terms array is not "no terms": the server passes the translation's terms,
  // which is [] for an English question, and `[] || grepTerms(...)` is `[]` - so every
  // record scored zero capability terms and the leg returned whichever three records the
  // rarity weight happened to favour (measured on the Box: three Astra Militarum
  // stratagems instead of the Enginseer, which is the record the question is about).
  const given = Array.isArray(o.terms) && o.terms.length ? o.terms : null;
  const words = (given || grepTerms(question)).map(w => String(w).toLowerCase()).filter(Boolean);
  const scored = new Map();
  for (const key of list) {
    for (const r of (index.get(key) || [])) {
      const t = String(r.text || '').toLowerCase();
      const kw = words.filter(w => termPresent(t, w)).length;
      const prev = scored.get(r.id) || { rec: r, kw: kw, keys: [], score: 0 };
      prev.kw = Math.max(prev.kw, kw);
      prev.keys.push(key);
      prev.score += idf.get(key) || 0;
      scored.set(r.id, prev);
    }
  }
  // THE QUESTION'S OWN WORDS DECIDE. A record scoped to the entity's keyword that does
  // not hold the capability the question asks about is not an answer - the Baneblade's
  // own keyword list scopes VEHICLE and says nothing about an invulnerable save. So the
  // candidates that carry at least one of the question's content words come first, and
  // the rarity-weighted scope score only orders within them. Measured: without this the
  // leg returned the Baneblade's own record and four Astra Militarum stratagems, and the
  // Enginseer - the record that answers the question - was not in the list at all.
  const carries = x => x.kw > 0 ? 1 : 0;
  return Array.from(scored.values())
    .sort((a, b) => (carries(b) - carries(a)) || (b.score - a.score) || (b.kw - a.kw) || (String(a.rec.text || '').length - String(b.rec.text || '').length))
    .slice(0, cap)
    // scopeKeys is what the record's scope NAMES; subjectKeys is which of the SUBJECT's
    // own keywords the scope matched (task-70). The two together are the join, already
    // computed: the agent is told it instead of re-deriving it from prose.
    .map(x => Object.assign({}, x.rec, { scopeKeys: x.keys, subjectKeys: (keywords || []).filter(k => x.keys.some(w => String(k).split(/\s+/).indexOf(w) !== -1)), carriesQuestion: x.kw > 0 }));

}

// task-70: the scope leg's finding, made legible beside the passages. The leg exists to
// find records whose scope covers the subject; asking the agent to re-derive that from the
// two records' prose is the inference it keeps getting wrong (measured: a run wrote the
// correct sentence and answered NO). This returns the fact as the leg computed it - the
// record, the keyword the record's scope names, and the subject's own keyword that met it.
export function scopeFacts(findings, question) {
  const out = [];
  // A capability question only: a scope fact is about whether a record reaches the
  // subject, which is the question a 'can it ...' answer turns on.
  if (!CAPABILITY_RE.test(String(question || ''))) return out;
  (findings || []).forEach((f, i) => {
    const keys = (f && f.scopeKeys) || [];
    // Only a record that carries one of the question's own content words is stated as
    // applying: the Baneblade's own keyword list is scoped to ASTRA MILITARUM too, and it
    // says nothing about an invulnerable save. The leg already ranks on this (carries()).
    if (!f || !keys.length || f.carriesQuestion !== true) return;
    // And the record must SAY the thing the question asks about, not merely share a word
    // with it: the Baneblade's keyword list carries 'Baneblade' and 'Save' while stating
    // 'Save 2+', and stating 'that record APPLIES' for it would be a false fact. A record
    // that states a capability states it with one of these, so they are the gate - what
    // the record actually grants is still the agent's to read.
    if (!/\b(has|have|had|gets?|gains?|grants?|granted|gives?|given|benefits?)\b/i.test(String(f.text || ''))) return;
    const subject = (f.subjectKeys || [])[0] || '';
    out.push({ n: f.n || i + 1, id: f.id, keyword: subject || keys[0], scopeKeys: keys });
  });
  return out;
}

// The index is built once from the whole corpus and kept, like the header projection:
// one pass over ~6,300 records, no index write and no model call. RULES_SCOPE_LEG=0
// turns the leg off for a measurement arm without touching a caller.
let SCOPE_LEG = null;
export function scopeLegReady() { return String(process.env.RULES_SCOPE_LEG || '') !== '0'; }
export function scopeLegIndex(records) {
  if (records) return scopeIndex(records);
  if (!SCOPE_LEG) SCOPE_LEG = scopeIndex(indexedSections(readAllCorpus()));
  return SCOPE_LEG;
}
export function scopeLegReset() { SCOPE_LEG = null; }

// The entity a question names, and the keywords its own record carries: the anchor
// records entityAnchors already resolves, plus the sibling unitrules record that holds
// the keyword list (the two are separate records - task-58's fold hides that from the
// reader, and task-61 measured that merging them does not help the vector).
export function entityKeywords(question, corpus, opts) {
  const o = opts || {};
  const sections = corpus || [];
  const byId = new Map(sections.map(s => [s.id, s]));
  const anchors = o.anchors || entityAnchors(question, sections, o.anchorCap || 1, o.terms);
  const out = new Set();
  // The FIRST anchor only: a unit name can match several records - a Baneblade is both
  // an Astra Militarum and a Genestealer Cults datasheet - and the union of their
  // keyword lists ranks GENESTEALER CULTS (a rare keyword, so a heavy weight) above the
  // ASTRA MILITARUM VEHICLE the question is about. The anchors are already ranked, and
  // the first is the record the name belongs to.
  for (const a of anchors.slice(0, 1)) {
    const id = String(a.id || '');
    const ur = byId.get(id.replace(/^datasheet#/, 'unitrules#')) || byId.get(id);
    const m = String((ur && ur.text) || '').match(/Keywords: ([^\n|]+)/);
    if (!m) continue;
    for (const w of m[1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean)) out.add(w);
  }
  return Array.from(out);
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
  // task-32 C, the second line of defence: BOTH legs read this corpus, and the lexical
  // leg greps all of it, so a kind 'index' navigation page (or a filtered edition-0
  // record) could still reach a finding through a word match even though the vector
  // leg never returns one. The corpus this function sees is the indexable one.
  const corpus = indexedSections(o.corpus || readAllCorpus());
  const lists = [];

  // Which retriever found what, and where it ranked it. The two legs are fused
  // by rank and then reordered by the reranker and by anchoring, so by the time
  // a finding reaches the page its origin is gone - and a reader shown '[3]' has
  // no way to tell a vector hit from a word match. The scores are kept separate
  // for the same reason the fusion does not compare them: a similarity and a
  // term score are not the same quantity.
  const prov = new Map();
  const note = (id, key, rank, score) => {
    if (!id) return;
    const p = prov.get(id) || {};
    p[key + 'Rank'] = rank;
    if (typeof score === 'number') p[key + 'Score'] = score;
    prov.set(id, p);
  };

  try {
    const hits = await queryIndex(question, { topK: o.vectorTopK || 20, cfg: o.cfg, namespace: o.namespace, queryMode: o.queryMode });
    const byId = new Map(corpus.map(s => [s.id, s]));
    const vec = [];
    hits.forEach((h, i) => {
      const sec = byId.get(h.id);
      if (!sec) return;
      note(h.id, 'vector', i + 1, h.score);
      vec.push(sec);
    });
    if (vec.length) lists.push(vec);
  } catch (e) {
    // No index, no vectors. Grep does not care, and neither does the caller.
  }

  // The lexical pass, and the terms it ran on: the same words decide the
  // matched-keyword outline the page draws, so they are computed once here.
  const lexicalTerms = o.terms && o.terms.length ? o.terms.concat(grepTerms(question)) : grepTerms(question);
  const grep = grepWithTerms(lexicalTerms, corpus, o.grepNet || 40, question);
  grep.forEach((g, i) => note(g.id, 'lexical', i + 1, g.score));
  if (grep.length) lists.push(grep);

  // Anchoring and clarification are recorded as they happen further down; the
  // sets are declared here so every return path labels its findings the same way.
  const anchoredIds = new Set();
  const childIds = new Set();
  // task-65: the records the scope leg adds, filled in below and read by decorate().
  const scopedIds = new Set();
  const matchedTerms = sec => {
    const hay = (String(sec.heading || '') + '\n' + String(sec.text || '')).toLowerCase();
    const hits = [];
    for (const raw of lexicalTerms) {
      const t = String(raw).toLowerCase().trim();
      if (!t || t.indexOf(' ') !== -1) continue;
      if (termPresent(hay, t)) hits.push(t);
    }
    return Array.from(new Set(hits)).slice(0, 4);
  };
  // The retriever that produced each finding, and its rank inside this half's
  // list. 'both' means the two legs agreed; 'anchored' and 'child' are the
  // records anchoring and clarification added rather than a retriever.
  const decorate = list => list.map((s, i) => {
    const p = prov.get(s.id) || {};
    const leg = p.vectorRank
      ? (p.lexicalRank ? 'both' : 'vector')
      : (p.lexicalRank ? 'lexical' : (anchoredIds.has(s.id) ? 'anchored' : (scopedIds.has(s.id) ? 'scope' : 'child')));
    return Object.assign({}, s, p, { leg, rank: i + 1, matchedTerms: (leg === 'lexical' || leg === 'both') ? matchedTerms(s) : [] });
  });

  // The vector list is short and its head is its best evidence; the grep list is
  // long and its head is a word match. Weighting keeps the second from burying
  // the first - measured on the retrieval bank, see docs/rules-page.md.
  const merged = rrfMerge(lists, o.fusionK || 60, o.fusionWeights).slice(0, o.jevMax || 80);
  // The ranker is optional; without it the fusion order is the answer, and the
  // provenance has to ride along on this path too - a page whose findings have
  // no leg is a page that cannot say where they came from.
  //
  // Skipping the call must not skip the path. Anchoring, the retriever head
  // protection and a rule's clarifications are not reranker features, and this
  // used to return early when no key was configured - so a no-key deployment
  // served findings without them, and the Asurmen ability could sit outside the
  // findings again, which is the failure the protection exists for. There is
  // one post-processing path now, whether the ranker answered, threw or was
  // skipped; o.jevSkip is how a caller that holds a key asks for the zero-call
  // arm, and it lands on the same list a no-key deployment gets.
  let ranked = null;
  // task-45: whether the rerank actually ran, and on which gateway. The reader is
  // owed the difference between a ranked list and the fusion order: 'degraded' is
  // reported on the result and shown on the page, never silently swapped in.
  let rerankStatus = { state: 'skipped', gateway: '', reason: '' };
  const rerankArmName = rerankArm();
  if (!o.jevSkip && rerankArmName !== 'off') {
    try {
      if (rerankArmName === 'cf') {
        ranked = await cfRank(question, merged, credential('CLOUDFLARE_API_TOKEN'), { max: o.jevMax || 80 });
        if (ranked && ranked.length) rerankStatus = { state: 'ranked', gateway: 'cf', reason: '' };
      } else if (o.jevKey) {
        // The gateway that served it comes back with the ranking, so the operator can
        // see free-versus-paid per half without a second lookup.
        // task-47: the shape rides through, so a harness can ask for the noul shape
        // without an env var (and the product's default is the choice shape).
        ranked = await jevRank(question, merged, o.jevKey, { max: o.jevMax || 80, endpoint: o.jevEndpoint, shape: o.jevShape });
        if (ranked && ranked.length) rerankStatus = { state: 'ranked', gateway: ranked.gateway || '', shape: ranked.shape || '', none: ranked.none || 0, reason: '' };
      } else {
        rerankStatus = { state: 'skipped', gateway: '', reason: 'no key' };
      }
    } catch (e) {
      // The ranker is a free-tier call one shared budget away from a 429, and it
      // must not take the question with it: grep and the vector index already
      // found passages, and the agent reads the model, not Jev. Unranked order is
      // the rank fusion itself - what the two retrievers already agree on. A
      // measurement arm turns that fallback into a stop instead of a mixed row;
      // the page never sets the flag.
      rerankStatus = { state: 'degraded', gateway: '', reason: String((e && e.message) || e).slice(0, 200) };
      if (jevStrict()) throw e;
    }
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
  // The retriever heads run BEFORE anchoring and on the pick alone, so the
  // weakest pick is still what a head displaces - never an anchor. Unchanged
  // from before: it is the rerank's own correction, not anchoring's.
  for (let li = 0; li < lists.length; li++) {
    // The vector leg's own head is not one hit but its first few: on the bank it
    // ranks the expected section first more often than the merged result does,
    // and a reranker that reorders 80 candidates can only shuffle that head.
    const protect = li === 0 ? (o.protectVector || 1) : 1;
    for (const own of lists[li].slice(0, protect)) {
      if (!own || guarded.some(s => s.id === own.id)) continue;
      if (guarded.length < topK) guarded.push(own);
      else guarded[guarded.length - 1] = own;
    }
  }
  // task-65: the scope leg, one shape and one firing condition.
  //
  // IT FIRES when, and only when, all three hold:
  //   1. the question names an entity - entityAnchors resolves a record from its own
  //      words ('baneblade' -> the Baneblade datasheet). No entity, no leg.
  //   2. that entity's FIRST anchor carries a keyword list (the sibling unitrules
  //      record), and a record in the scope index names one of those keywords in a
  //      grant ('one friendly Astra Militarum Vehicle model'). The first anchor only: a
  //      name can match several records (a Baneblade is an Astra Militarum and a
  //      Genestealer Cults datasheet) and the union of their keywords ranks the wrong
  //      variant first.
  //   3. that record also carries one of the QUESTION's own content words - a record
  //      scoped to VEHICLE that says nothing about an invulnerable save is not an answer.
  // Capped at three records. It is INSERTED above the anchors and the children rather
  // than appended: an appended record lands past the display cut, which is where the
  // first version of this leg put the Enginseer (present in the list, rank 24 of 24, and
  // invisible to the agent). The retriever heads keep their places; the weakest picks
  // make room.
  if (o.scopeLeg !== false && scopeLegReady()) {
    const kws = entityKeywords(question, o.scopeCorpus || corpus, { terms: o.terms, anchorCap: o.anchorCap || 2 });
    const scoped = scopeLookup(question, scopeLegIndex(), kws, { cap: o.scopeCap || 3, terms: o.terms })
      .filter(rec => rec && !guarded.some(s => s.id === rec.id));
    if (scoped.length) {
      for (const rec of scoped) scopedIds.add(rec.id);
      const keep = guarded.slice(0, Math.max(1, (o.protectVector || 1)));
      const rest = guarded.slice(keep.length);
      const room = Math.max(0, topK - keep.length - scoped.length);
      guarded.length = 0;
      guarded.push.apply(guarded, keep.concat(scoped, rest.slice(0, room)));
    }
  }
  // Anchoring APPENDS: the retrievers' scores decide the topK pick and an anchor
  // can no longer take a slot in front of it. The guarantee anchoring actually
  // makes - the records of the unit the question names are present - survives;
  // what it loses is the power to evict a record a retriever already ranked,
  // which showed up as scoreless '-' entries sitting above scored hits. Strictly
  // one-directional: nothing here moves a record up or removes one.
  const append = rec => { if (rec && !guarded.some(s => s.id === rec.id)) guarded.push(rec); };
  for (const anchor of entityAnchors(question, corpus, o.anchorCap || 2, o.terms)) {
    anchoredIds.add(anchor.id);
    append(anchor);
  }
  // A rule's own clarifications travel with it, so the condition that limits
  // the answer is on the page even when the reranker only saw the permission.
  for (const child of childSections(guarded.slice(), corpus, o.childPerParent || 1, o.childCap || 3)) {
    childIds.add(child.id);
    append(child);
  }

  // Anchored and clarifying records may sit past the cut once everything is merged.
  const out = guarded.slice(0, topK + (o.anchorCap || 2) + (o.childCap || 3));
  // task-75, additive: the candidates the cut did NOT take, in the ranker's own
  // order. This is the same pre-cut net of 50-80 passages the findings were drawn
  // from - exposing it costs nothing, because the retrieval already paid for it -
  // and it is deliberately UNJUDGED: it is the tail, not a second findings list.
  // Nothing about the findings themselves changes here.
  const shownIds = new Set(out.map(s => s.id));
  const rest = (ranked || merged).filter(s => s.id && !shownIds.has(s.id)).slice(0, 30);
  const result = decorate(out);
  result.rest = decorate(rest);
  result.rerank = rerankStatus;
  return result;
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
  // reasons - a missing core rule is not a missing datasheet - and the agent
  // says which one is short.
  const plan = o.perSide || {};
  const rulesK = plan.rules || o.topK || 10;
  const factionsK = plan.factions || o.topK || 10;
  // The reranker's net is much wider than the cut it fills, and deliberately so.
  // Jev reorders the candidates it is given; it cannot rank a passage that was
  // sliced off first. On the Asurmen embark question the Embarking rule sat at
  // merged rank 54 - a candidate list cut at 50 never showed it to Jev, and with
  // a net of 80 the same passage came back 4th and the agent could finally read
  // it. K + 10 was too tight a net to let the reranker do the job it exists for,
  // and it is the net, not K, that has to grow when the search deepens.
  const netFor = k => Math.max(o.jevMax || 30, k + 70);
  const [rules, factions] = await Promise.all([
    retrieveWide(question, {
      corpus: o.rulesCorpus || readAllCorpus('rules'),
      namespace: o.rulesNamespace || 'rules',
      jevKey: o.jevKey, jevSkip: o.jevSkip, jevEndpoint: o.jevEndpoint, jevShape: o.jevShape, cfg: o.cfg, terms: o.terms,
      grepNet: Math.max(o.grepNet || 40, rulesK * 4), jevMax: netFor(rulesK), topK: rulesK,
      queryMode: o.queryMode, fusionWeights: o.fusionWeights, fusionK: o.fusionK, protectVector: o.protectVector,
      // task-65: the scope leg and the corpus it resolves the entity against travel
      // with the call, so one half cannot silently run a different retrieval.
      scopeLeg: o.scopeLeg, scopeCap: o.scopeCap, scopeCorpus: o.scopeCorpus,
    }),
    retrieveWide(question, {
      corpus: o.factionsCorpus || readAllCorpus('factions'),
      namespace: o.factionsNamespace || 'factions',
      jevKey: o.jevKey, jevSkip: o.jevSkip, jevEndpoint: o.jevEndpoint, jevShape: o.jevShape, cfg: o.cfg, terms: o.terms,
      grepNet: Math.max(o.grepNet || 40, factionsK * 4), jevMax: netFor(factionsK), topK: factionsK,
      queryMode: o.queryMode, fusionWeights: o.fusionWeights, fusionK: o.fusionK, protectVector: o.protectVector,
      scopeLeg: o.scopeLeg, scopeCap: o.scopeCap, scopeCorpus: o.scopeCorpus,
    }),
  ]);
  // The pre-cut pool, both halves, deduped, in the order the ranker put it. The
  // findings keep the cut; this is what the tail reads.
  const restSeen = new Set();
  const tail = [];
  for (const s of (rules.rest || []).concat(factions.rest || [])) {
    if (!s || !s.id || restSeen.has(s.id)) continue;
    restSeen.add(s.id);
    tail.push(s);
  }
  // task-45: the rerank state of each half, so the run can say out loud when a list
  // was NOT ranked (a chain that ran out, or a day over the paid cap).
  const rerank = (rules.rerank && rules.rerank.state === 'ranked') || (factions.rerank && factions.rerank.state === 'ranked')
    ? { state: (rules.rerank && rules.rerank.state === 'degraded') || (factions.rerank && factions.rerank.state === 'degraded') ? 'degraded' : 'ranked',
      rules: rules.rerank || null, factions: factions.rerank || null }
    : { state: (rules.rerank && rules.rerank.state) || (factions.rerank && factions.rerank.state) || 'skipped', rules: rules.rerank || null, factions: factions.rerank || null };
  return { rules, factions, all: rules.concat(factions), tail, plan: { rules: rulesK, factions: factionsK }, rerank };
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
    findings.map((f, i) => '[' + (i + 1) + '] ' + (f.set === 'factions' ? 'Faction rules' : 'Core rules') + ' - ' + (f.faction ? f.faction + ' - ' : '') + f.heading + (f.ruleId ? ' (' + f.ruleId + ')' : '') + '\n' + String(f.text).slice(0, AGENT_PASSAGE_CHARS)).join('\n\n'),
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
  const o = opts || {};
  // The route carries a reasoning default; a caller may override it for one call.
  return String(await modelText(compilePrompt(question, findings, o), key, 8000, Object.assign({ stage: 'writer' }, o.reasoning === undefined ? {} : { reasoning: o.reasoning }))).trim();
}

// What the writer says when it read the findings and will not answer from them.
export const WRITER_DECLINED = 'The findings do not answer this question.';

// The writer cascade: reasoning off first, and only a decline pays for thinking.
// The decline is the cheap path's failure shape and the exact place the prose
// sample showed the difference - the thinking writer reasoned from the
// Not-on-the-Battlefield rule to an answer, the fast one refused. A refusal is
// cheap to detect (the sentence is fixed) and cheap to re-ask; paying 85 seconds
// on every question to fix the tail is not. It mirrors the escalation the agent
// already has, one layer up.
//
// opts.write is for tests: (question, findings, reasoning) -> prose.
export async function compileCascade(question, findings, key, opts) {
  const o = opts || {};
  const write = o.write || ((q, f, reasoning) => compileFindings(q, f, key, { lang: o.lang, reasoning }));
  const fast = String(await write(question, findings, o.fastReasoning === undefined ? 'none' : o.fastReasoning) || '').trim();
  if (fast && fast !== WRITER_DECLINED) return { answer: fast, path: 'fast', retried: false };
  const slow = String(await write(question, findings, o.slowReasoning || 'medium') || '').trim();
  return { answer: slow || fast, path: 'slow', retried: true };
}

// The finding as the page shows it: what it is, where it came from, and the
// link. Built here from the record that was retrieved, so a marker in the prose
// and a link under it cannot drift apart.
export function findingFor(section, n) {
  return {
    n,
    // The record's own key, so a consumer can point back at the section without
    // copying its text - the question traces keep the pointer and drop the
    // passage (src/rules-traces.mjs).
    id: section.id || '',
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
    // Which leg produced it and how it ranked, for the page's own labels. A
    // finding the caller built by hand (a test, a caller with no retrievers)
    // simply carries no provenance.
    rank: section.rank || 0,
    leg: section.leg || '',
    // task-67: the scope leg's own record, marked so the agent prompt can give it its
    // full length. scopeKeys is set by scopeLookup (the keywords it matched); a finding
    // built by hand carries none and is treated like any other.
    scope: Array.isArray(section.scopeKeys) && section.scopeKeys.length > 0,
    // The leg's own output, carried so the agent prompt can state the join (task-70).
    scopeKeys: Array.isArray(section.scopeKeys) ? section.scopeKeys : [],
    subjectKeys: Array.isArray(section.subjectKeys) ? section.subjectKeys : [],
    carriesQuestion: section.carriesQuestion === true,
    vectorRank: section.vectorRank || 0,
    vectorScore: section.vectorScore,
    lexicalRank: section.lexicalRank || 0,
    lexicalScore: section.lexicalScore,
    matchedTerms: section.matchedTerms || [],
    // task-34: the flat text as displayed - a finding's excerpt, the passage sheet,
    // the record dialog's first paint. The stored bytes stay bare; the marks are a
    // render convention and markWargearText is idempotent.
    text: markWargearText(section.text),
    excerpt: markWargearText(section.text.length > 600 ? section.text.slice(0, 600).replace(/\s+\S*$/, '') + ' ...' : section.text),
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
// section every 6-12s (measured 2026-10-13: 25.65s for 4 live rules records,
// 169.7s and 188.0s for two 16-record batches, 98% CPU / 2% GPU on a GTX 660),
// so the rules halves of the live and wiki corpora are 2.5-4.5 hours and the
// whole 7,556-record wiki corpus 13-25 hours - fine for a fallback, not for an
// index you want to rebuild. RULES_VECTOR_BACKEND=local switches to it; both
// stores live side by side and neither is destroyed by using the other.
export const VECTOR_BACKEND = String(process.env.RULES_VECTOR_BACKEND || 'upstash').toLowerCase();

// One store per namespace, not one store with a namespace column: a rules
// question never wants a faction vector and scanning them costs nothing, the
// files stay small, and a rewrite of one half cannot corrupt the other.
const LOCAL_EMBED_MODEL = process.env.RULES_LOCAL_EMBED_MODEL || 'bge-m3';
const localStorePath = (ns, ext) => path.join(corpusDir(), 'local-index-' + (ns || 'all') + ext);
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

function vectorRequest(cfg, endpoint, body, method) {
  return new Promise((resolve, reject) => {
    const u = new URL(cfg.url + endpoint);
    const payload = JSON.stringify(body);
    const req = https.request({
      method: method || 'POST',
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
  // includeFiltered is a diagnostic escape hatch (a before/after on the index's own
  // contents); the product path always returns through deliveredHits.
  const rawHits = !!(opts && opts.includeFiltered);
  if (VECTOR_BACKEND === 'local') { const h = await queryIndexLocal(question, opts); return rawHits ? h : deliveredHits(h); }
  const cfg = (opts && opts.cfg) || vectorConfig();
  const ns = (opts && opts.namespace) || '';
  // A hybrid index embeds the raw text with both halves and fuses them with RRF
  // by default. Every knob Upstash exposes for that - the fusion algorithm, the
  // sparse weighting, dense-only or sparse-only - is passed through when asked
  // for, because which one is most reliable is a measurement, not a preference.
  const o = opts || {};
  const body = {
    data: String(question),
    topK: o.topK || 12,
    includeMetadata: true,
    includeData: o.includeData || false,
  };
  if (o.fusionAlgorithm) body.fusionAlgorithm = o.fusionAlgorithm;
  // Dense, not the index's own HYBRID default. The sparse half of the index is
  // BM25 over the same text our grep leg already scans, so a hybrid query fuses
  // an answer we already have with one we are about to compute anyway - and it
  // measured worse: on the retrieval bank the dense-only query landed the
  // expected section first 62.1% of the time (MRR 0.696) against the hybrid
  // 58.6% (0.679), DBSF 51.7% (0.646), weighting IDF 51.7% (0.626) and
  // sparse-only 41.4% (0.549). Pass queryMode to override.
  body.queryMode = o.queryMode || 'DENSE';
  if (o.weightingStrategy) body.weightingStrategy = o.weightingStrategy;
  const r = await vectorRequest(cfg, '/query-data' + (ns ? '/' + ns : ''), body);
  if (r.status !== 200) throw new Error('query failed: HTTP ' + r.status + ' ' + r.text.slice(0, 200));
  const hits = r.obj.result || [];
  return rawHits ? hits : deliveredHits(hits);
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

// DELETE /delete/{namespace} with { ids }. The endpoint used to be written as
// POST /delete-data/{namespace}, which Upstash answers 404 — it never ran,
// because a rebuild had never needed a delete. The first one that did (splitting
// a parent record into its sub-rules) failed on it.
export const DELETE_BATCH = 500;
export async function deleteIds(ids, cfg, namespace) {
  if (!ids.length) return 0;
  if (VECTOR_BACKEND === 'local') return deleteIdsLocal(ids, namespace);
  const ns = namespace || '';
  // The endpoint refuses more than 1,000 ids in one call - HTTP 400 "Exceeded max
  // batch deletion limit: 1000" - and a restructure of this size hits it (task-30
  // deletes 1,619). Batches of 500 stay clear of the limit and keep one bad batch
  // from losing the whole delete; the count is summed across batches.
  let deleted = 0;
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    const slice = ids.slice(i, i + DELETE_BATCH);
    const r = await vectorRequest(cfg || vectorConfig(), '/delete' + (ns ? '/' + ns : ''), { ids: slice }, 'DELETE');
    if (r.status !== 200) throw new Error('delete failed: HTTP ' + r.status + ' ' + r.text.slice(0, 200));
    deleted += r.obj && r.obj.result && typeof r.obj.result.deleted === 'number' ? r.obj.result.deleted : slice.length;
  }
  return deleted;
}

// Every id in a namespace, cursor by cursor. GET /range/{namespace}. This is how
// a stray is found: a vector whose id the corpus no longer has cannot be named
// by --ingest (that compares the corpus against the ingest state, and the state
// is in sync), so the only way to see it is to enumerate the index itself.
export async function rangeIds(namespace, cfg, opts) {
  const o = opts || {};
  if (VECTOR_BACKEND === 'local') return localLoad(namespace).meta.ids.slice();
  const out = [];
  let cursor = '0';
  for (let page = 0; page < (o.maxPages || 500); page++) {
    const r = await vectorRequest(cfg || vectorConfig(), '/range' + (namespace ? '/' + namespace : ''), { cursor, limit: o.limit || 100, includeMetadata: false }, 'GET');
    if (r.status !== 200) throw new Error('range failed: HTTP ' + r.status + ' ' + r.text.slice(0, 200));
    const result = (r.obj && r.obj.result) || {};
    const vectors = result.vectors || [];
    for (const v of vectors) out.push(v.id);
    if (!vectors.length || !result.nextCursor || result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  return out;
}

// Delete what the index holds and the corpus does not. --ingest keeps the index
// in step with the corpus it knows about; it cannot see a vector whose id was
// dropped by an older build, because the ingest state agrees with the corpus.
// Those strays still occupy top-K slots in every query.
export async function pruneIndex(opts) {
  const setName = (opts && opts.set) || undefined;
  const o = opts || {};
  const report = [];
  for (const ns of [...new Set(sourcesFor(setName).map(s => namespaceFor(s.set)))]) {
    const known = new Set();
    for (const s of sourcesFor(setName)) {
      if (namespaceFor(s.set) !== ns) continue;
      const payload = readCorpusStamped(s.name);
      // The prune's idea of what the corpus holds is the delivered set, not the
      // corpus: a filtered record is a stray here, which is how the 1,040 that
      // were embedded before this predicate existed get removed.
      for (const sec of deliveredSections(payload && payload.sections)) known.add(sec.id);
    }
    const present = await rangeIds(ns, o.cfg, o);
    const strays = present.filter(id => !known.has(id));
    const deleted = o.dryRun ? 0 : await deleteIds(strays, o.cfg, ns);
    report.push({ namespace: ns, vectors: present.length, corpus: known.size, strays: strays.length, deleted, sample: strays.slice(0, 4) });
  }
  return report;
}

// A rebuild that would delete most of a namespace is a bug wearing a rebuild's
// clothes: a corpus read from the wrong directory, a payload grouped by the wrong
// field, a scrape that half-wrote. One of tonight's two bugs would have deleted
// 5,769 of 6,829 faction records had only the diff been right about it, and only
// a hand-written diff caught it. The guard stops the run instead, and the way past
// it is a flag someone has to type on purpose.
export const MAX_DELETE_FRACTION = 0.25;
export function massDeleteGuard(name, vanished, known) {
  if (!known || !vanished) return null;
  if (vanished <= known * MAX_DELETE_FRACTION) return null;
  return 'refusing to delete ' + vanished + ' of ' + known + ' ids in ' + name +
    ' (more than ' + Math.round(MAX_DELETE_FRACTION * 100) + '%): pass --allow-mass-delete if that is intended';
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
    const payload = readCorpusStamped(source.name);
    if (!payload) { report.sources.push({ source: source.name, skipped: 'no corpus on disk' }); continue; }
    const stateFile = path.join(corpusDir(), source.name + '.index.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
    // Every rebuild is counted: the ledger beside the state records what each
    // one upserted, deleted and left alone, so a rebuild is a step with a
    // number rather than an event nobody can account for afterwards.
    const ledgerPath = path.join(corpusDir(), source.name + '.rebuilds.json');
    let ledger = [];
    try { const l = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); if (Array.isArray(l)) ledger = l; } catch { }
    // Only what moved. An upsert replaces the vectors of the ids it names and
    // touches nothing else, and a delete is issued only for ids that really
    // left the corpus - a rebuild never wipes the index to rebuild it.
    // The index answers for the product: only delivered records are planned, and
    // a filtered id already in the state becomes a vanish, so one ingest removes
    // what an earlier one embedded. The render reads the same predicate.
    // task-32 C: the ingest embeds and remembers only what a retrieval may return;
    // a kind 'index' page is delivered (it renders) but never indexed.
    const delivered = deliveredSections(payload.sections);
    const sections = indexedSections(payload.sections);
    const filtered = payload.sections.length - delivered.length;
    const indexExcluded = delivered.length - sections.length;
    report.filtered = (report.filtered || 0) + filtered;
    report.indexExcluded = (report.indexExcluded || 0) + indexExcluded;
    const changed = sections.filter(s => state[s.id] !== s.hash);
    const currentIds = new Set(sections.map(s => s.id));
    const vanished = Object.keys(state).filter(id => !currentIds.has(id));
    const ns = namespaceFor(source.set);
    const unchanged = sections.length - changed.length;
    const guard = massDeleteGuard(ns + ' (' + source.name + ')', vanished.length, Object.keys(state).length);
    if (guard) {
      if (dryRun) { report.guard = report.guard || []; report.guard.push(guard); }
      else if (!(opts && opts.allowMassDelete)) throw new Error(guard);
    }
    if (dryRun) {
      report.sources.push({ source: source.name, sections: sections.length, filtered, indexExcluded, upserted: 0, deleted: 0, unchanged, planned: changed.length, vanishedPlanned: vanished.length, rebuild: ledger.length + 1, dryRun: true });
      report.upserted += 0;
      report.unchanged += unchanged;
      report.planned = (report.planned || 0) + changed.length;
      continue;
    }
    const upserted = await upsertSections(changed, { cfg, namespace: ns, onProgress: opts && opts.onProgress });
    const deleted = await deleteIds(vanished, cfg, ns);
    const next = {};
    for (const s of sections) next[s.id] = s.hash;
    fs.writeFileSync(stateFile, JSON.stringify(next));
    ledger.push({ rebuild: ledger.length + 1, at: new Date().toISOString(), backend: VECTOR_BACKEND, sections: sections.length, filtered, upserted, deleted, unchanged });
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1));
    report.upserted += upserted;
    report.unchanged += unchanged;
    report.deleted += deleted;
    report.sources.push({ source: source.name, sections: sections.length, filtered, indexExcluded, upserted, deleted, unchanged, rebuild: ledger.length });
  }
  // The retention sweep rides the monthly ingest: the corpus is refreshed on a
  // cadence, so the raw traces past their retention go at the same time and the
  // sweep cannot be forgotten. The bank is not touched - it is tracked, and a
  // promoted question lives there, not here.
  report.traces = sweepTraces({ dryRun });
  return report;
}

// --- cli --------------------------------------------------------------------

// --- when was this corpus last built? ----------------------------------------
// Not "is it behind an official update": that compares clocks which date
// different things and can only ever answer coarsely. What can be stated exactly
// is when our own copy was made - the export's stamp, and the moment we built
// from it. A reader who wants to know whether that is recent enough can see the
// date and agent for themselves.
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
  // task-32 C: the health line compares the index against what may be indexed, not
  // against everything the sources built: kind 'index' pages are delivered (they
  // render) but never embedded, and the filtered edition-0 records are not delivered
  // at all. `sets` is the indexable count per set, so /health's ahead/behind means
  // what it says.
  const indexed = {};
  let deliveredCount = 0, filteredCount = 0, indexExcluded = 0;
  try {
    const all = readAllCorpus();
    const del = all.filter(isDelivered);
    const idx = del.filter(r => String((r && r.kind) || '') !== 'index');
    filteredCount = all.length - del.length;
    deliveredCount = del.length;
    indexExcluded = del.length - idx.length;
    for (const r of idx) indexed[namespaceFor(r.set)] = (indexed[namespaceFor(r.set)] || 0) + 1;
  } catch (e) { /* a corpus read failure must not take /health down */ }
  corpusStateCache = {
    edition: EDITION,
    // What the sources said their data was last changed.
    sourceDate,
    // When we last read them. This is the one to publish: it describes the copy
    // rather than the origin.
    updated: built,
    sets: indexed,
    delivered: deliveredCount,
    filtered: filteredCount,
    indexExcluded,
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

// The live corpus is the wiki build (phase C): links in the text, the 63 faction
// rules, the 191 index pages. A scrape writes the FLAT corpus into the same
// directory - one scrape would silently revert all of it, and the next --ingest
// would re-embed 6,705 flat vectors. So the build runs here, at the only place
// that writes the corpus; --flat is the escape hatch for a measurement corpus
// that wants the raw scrape (the surgical arms).
export function scrapeBuildsWiki(argv) {
  return (argv || []).indexOf('--flat') === -1;
}

async function buildWikiShape(dir) {
  // Dynamic import: wiki-build.mjs imports this module, so a static import would
  // be a cycle at load time.
  const { writeWikiCorpus } = await import('./wiki-build.mjs');
  const m = writeWikiCorpus(dir, null, { blockInText: true });
  console.log('wiki shape  ' + String(m.records).padStart(5) + ' records, ' + String(m.links).padStart(6) + ' links (block in text)');
  return m;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = n => argv.indexOf(n) !== -1;
  const value = n => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
  const only = value('--source');

  const set = value('--set');
  if (flag('--scrape')) {
    // task-82: the corpus is the one store with no other copy, and a scrape, a
    // rebuild or an ingest is the moment it can be lost. Snapshot first, keep the
    // last three (--no-snapshot skips; tests point the output at a temp dir).
    if (!flag('--no-snapshot')) { try { console.log('snapshot    ' + snapshotCorpus()); } catch (e) { console.log('snapshot    failed: ' + e.message); } }
    if (set === 'factions') {
      const files = await downloadCsvExport({ allowCached: flag('--cached') });
      console.log('downloaded ' + files.length + ' CSV files to ' + csvDir());
      const built = buildFactionCorpus();
      console.log('  ' + 'faction records'.padEnd(24) + String(built.factions).padStart(5) + '  -> ' + corpusPath(FACTIONS_CSV.name));
      console.log('  ' + 'core stratagems'.padEnd(24) + String(built.core).padStart(5) + '  -> ' + corpusPath(CORE_STRATAGEMS.name));
      console.log('duplicate records collapsed: ' + built.dropped);
      console.log('boarding actions removed: ' + built.boarding.detachments + ' detachments, ' + built.boarding.stratagems + ' stratagems, ' + built.boarding.enhancements + ' enhancements');
      console.log('editions: ' + JSON.stringify(built.editions));
      console.log('next: run --ingest, then --prune, then check index-vs-corpus reads 0 missing / 0 stray - a rebuild without an ingest leaves the index serving a dead layout.');
      console.log('export last update: ' + built.marker.lastUpdate);
      console.log('total ' + built.count + ' records from ' + CSV_FILES.length + ' CSV files');
      if (scrapeBuildsWiki(argv)) await buildWikiShape(corpusDir());
      else console.log('--flat: the corpus is NOT the shape the live index was built from.');
      return;
    }
    if (set === 'missions') {
      // Not a scrape: the decks are already on disk, and the split is a local
      // transformation of their own text.
      const built = splitMissionDecks();
      if (!built || !built.chunks) { console.log('no mission deck chunks left to split'); return; }
      for (const d of built.decks) console.log('  ' + d.deck.padEnd(24) + String(d.chunks).padStart(3) + ' chunks -> ' + String(d.cards).padStart(3) + ' cards, ' + d.fragments + ' fragment(s), ' + d.bytes + ' bytes');
      console.log('next: run --ingest, then --prune, then check index-vs-corpus reads 0 / 0');
      return;
    }
    if (set === 'ability-defs') {
      // Not a scrape either: the page is already on disk, and the definitions are
      // taken from it verbatim.
      const built = buildAbilityDefsCorpus();
      console.log('  ' + 'ability definitions'.padEnd(24) + String(built.count).padStart(5) + '  -> ' + corpusPath(ABILITY_DEFS.name));
      for (const n of built.names) console.log('      ' + n);
      if (built.skipped.length) console.log('  left out (the page defines no such ability): ' + built.skipped.join(', '));
      console.log('next: run --ingest, then --prune, then check index-vs-corpus reads 0 / 0');
      return;
    }
    if (set === 'rulings') {
      // Not a scrape: the two documents are already staged as normalised CSVs.
      const built = buildRulingsCorpus();
      console.log('  ' + 'rulings records'.padEnd(24) + String(built.count).padStart(5) + '  (WTC ' + built.wtc + ' en + FEQ ' + built.feq + ' fr) -> ' + corpusPath(RULINGS.name));
      console.log('stored verbatim from the staged normalised CSVs; nothing re-fetched, nothing re-normalised');
      if (built.translated) console.log('  ' + 'English translation'.padEnd(24) + String(built.translated).padStart(5) + '  (machine, unreviewed - an addition to the French, never a replacement)');
      console.log('next: run --ingest, then --prune, then check index-vs-corpus reads 0 / 0');
      return;
    }
    const done = await scrapeAll(only, set);
    for (const p of done) console.log(p.source.padEnd(17) + ' ' + String(p.count).padStart(4) + ' sections (' + p.anchored + ' anchored)  ' + Math.round(p.bytes / 1024) + ' KB');
    console.log('written to ' + corpusDir());
    if (scrapeBuildsWiki(argv)) await buildWikiShape(corpusDir());
    else console.log('--flat: the corpus is NOT the shape the live index was built from.');
    return;
  }
  if (flag('--ingest')) {
    if (!flag('--no-snapshot') && !flag('--dry-run')) { try { console.log('snapshot    ' + snapshotCorpus()); } catch (e) { console.log('snapshot    failed: ' + e.message); } }
    const dryRun = flag('--dry-run');
    if (dryRun) console.log('dry run - nothing is written to the index or to the state files');
    const r = await ingest(only, { set, dryRun, allowMassDelete: flag('--allow-mass-delete') });
    for (const s of r.sources) {
      if (s.skipped) { console.log(s.source.padEnd(17) + ' skipped: ' + s.skipped); continue; }
      const rebuild = 'rebuild #' + s.rebuild;
      if (s.dryRun) {
        console.log(s.source.padEnd(17) + ' ' + String(s.sections).padStart(5) + ' sections, would embed ' + String(s.planned).padStart(5) + ', delete ' + String(s.vanishedPlanned).padStart(3) + ', leave ' + String(s.unchanged).padStart(5) + '  (' + rebuild + ')');
        continue;
      }
      console.log(s.source.padEnd(17) + ' ' + String(s.sections).padStart(5) + ' sections, ' + String(s.upserted).padStart(5) + ' embedded, ' + String(s.unchanged).padStart(5) + ' unchanged, ' + String(s.deleted).padStart(3) + ' deleted  (' + rebuild + ')');
    }
    for (const g of (r.guard || [])) console.log((dryRun ? 'GUARD ' : '') + g);
    console.log(dryRun ? 'would upsert ' + (r.planned || 0) : 'total upserted ' + r.upserted + ', deleted ' + r.deleted);
    console.log('filtered (never indexed): ' + (r.filtered || 0));
    const tr = r.traces || {};
    console.log('traces     ' + String(tr.files || 0).padStart(5) + ' file(s), ' + String(tr.kept || 0).padStart(5) + ' kept, ' + String(tr.removed || 0).padStart(3) + ' past ' + (tr.months || TRACE_RETENTION_MONTHS) + ' months' + (dryRun ? '  (dry run - nothing deleted)' : (tr.deleted && tr.deleted.length ? '  files removed: ' + tr.deleted.join(', ') : '')));
    return;
  }
  if (flag('--prune')) {
    const dryRun = flag('--dry-run');
    if (dryRun) console.log('dry run - nothing is deleted');
    const set = value('--set');
    const rows = await pruneIndex({ set, dryRun });
    for (const r of rows) {
      console.log(r.namespace.padEnd(10) + ' index ' + String(r.vectors).padStart(5) + ', corpus ' + String(r.corpus).padStart(5) + ', strays ' + String(r.strays).padStart(4) + (dryRun ? '' : ', deleted ' + r.deleted));
      for (const id of r.sample) console.log('    ' + id);
    }
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
      for (const ns of ['rules', 'factions', 'rulings']) {
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
    const corpus = readAllCorpus();
    const delivered = corpus.filter(isDelivered);
    const byNamespace = {};
    for (const r of delivered) { const ns = namespaceFor(r.set); byNamespace[ns] = (byNamespace[ns] || 0) + 1; }
    // The ids a query can return are the provable count; /info's vectorCount can
    // lag a delete by a moment, so it is printed beside them, not instead of them.
    let indexed = 0;
    if (VECTOR_BACKEND === 'local') {
      indexed = ['rules', 'factions', 'rulings'].reduce((n, ns) => n + localLoad(ns).meta.ids.length, 0);
    } else {
      for (const ns of ['rules', 'factions', 'rulings']) indexed += (await rangeIds(ns)).length;
      if (indexed !== info.vectorCount) console.log('index ids read now: ' + indexed + ' (info says ' + info.vectorCount + ', it lags a delete)');
    }
    // task-32 C: the comparison is against what may be indexed - delivered minus the
    // kind 'index' navigation pages - not against everything delivered.
    const indexable = indexedSections(corpus);
    const indexableBy = {};
    for (const r of indexable) { const ns = namespaceFor(r.set); indexableBy[ns] = (indexableBy[ns] || 0) + 1; }
    console.log('records: ' + corpus.length + ' corpus, ' + delivered.length + ' delivered ' + JSON.stringify(byNamespace) + ', ' + (corpus.length - delivered.length) + ' filtered (edition 0 or the named tenth-edition rule)');
    console.log('indexable: ' + indexable.length + ' ' + JSON.stringify(indexableBy) + ' (' + (delivered.length - indexable.length) + ' kind: index pages excluded from the index)');
    console.log('index ids: ' + indexed + ' vs ' + indexable.length + ' indexable  ' + (indexed === indexable.length ? 'MATCH' : 'MISMATCH'));
    console.log('editions: ' + JSON.stringify(editionCounts(corpus)) + '  (' + corpus.length + ' records; every record carries one)');
    return;
  }
  console.log('usage: node src/rules-corpus.mjs --scrape | --ingest | --stats | --prune [--source <name>] [--set rules|factions] [--dry-run]');
}

if (process.argv[1] && process.argv[1].endsWith('rules-corpus.mjs')) {
  main().catch(e => { console.error(String((e && e.message) || e)); process.exitCode = 1; });
}

export default { SOURCES, scrapeAll, ingest, queryIndex, indexInfo, readAllCorpus };
