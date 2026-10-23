import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SOURCES, EDITION, assignIds, corpusDir, extractSections, isBoardingActionsPageSection, parseMarker, stripChrome, writeCorpus, buildFactionCorpus,
} from '../src/rules-corpus.mjs';
import { readPlanInput } from '../src/wiki-plan.mjs';
import { writeWikiCorpus } from '../src/wiki-build.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

// task-82/83: the drift guard. STATIC imports on purpose - the corpus directory is
// resolved per call, so setting RULES_CORPUS_DIR below is enough and the test needs
// no dynamic imports to dodge an import-time global.
//
// What it measures, from source only (the scraped HTML and the CSV export on disk,
// nothing stored): the scrape stage, then the shape stage, against the baselines.
// The stored core-rules.json is the SHAPE stage, not the scrape stage: 375 sections
// from the scrape against its 401 is a stage mismatch, not loss. The shape stage
// re-chunks long rules and skips the 18 core-ability records the ability-defs
// builder owns; no rule text is lost, which the invariant below checks.
//
// Baselines moved 2026-10-16 (task-85). Three changes, all intended, all measured:
//  * D1 - htmlToText no longer leaves a space before punctuation or inside brackets
//    that a tag boundary introduced ('rounds</a>,' was 'rounds ,'; '( 05.04.05 )'
//    was 162 and 221 occurrences against the raw page's 3 and 0);
//  * D2 - deriveTitle no longer cuts a heading at 90 characters with a literal '...',
//    so the FAQ headings are whole again (49 of them) and the scrape is 374 sections
//    against 375: one heading now matches its twin and the pair collapses;
//  * D4 - the shaper no longer writes the 'section' child links into the record text,
//    so core-rules' shape count equals its scrape count. The other four block kinds
//    (- faction:, - card:, - index:, - rule:) are untouched; they are the
//    cross-reference index the vectors were measured with.
// The comparison below is content-based for exactly those reasons.
//
// Decision recorded here, not to be re-run without reason: the pipeline's re-chunking
// (375 against 401, same content) is not worth a reparse today - it would rewrite 78
// sections, move ids, re-embed, and refetch 26 faction pages for no user-visible
// gain. It belongs to the next real Wahapedia update, when the corpus moves anyway.
const BASELINE = {
  // task-90: the heading hierarchy is the number's depth, not the tag level. A SECTION
  // is an h2 and a CHAPTER an h3 on the page, so chapter '02 Datasheets' was filed
  // under '01.07 Battle-shock Rolls'. The heading's own dotted number is now the depth
  // ('02' = 1, '01.07' = 2), tag level the fallback; 138 headings and 76 parents change
  // and the core-rules text carries the corrected paths (+5,180 characters).
  // task-86: the wound/hit-roll dice are text now - htmlToText substitutes '$1+' for the
  // '+N' modifier and '$1' for a bare face, so core-rules gains 30 characters and the CSV
  // path gains 252 bytes. task-94: 19 numbered sections the length floor was dropping came
  // back (382 core-rules, 191 appendix). task-101: the faction abilities are no longer a
  // source of their own - they are the factions' own army rules - so the CSV half carries
  // 2 more records (Devastator Doctrine, Sons of Russ) and the rules half 62 fewer.
  scrape: { sections: 382, chars: 288387 },
  shape: {
    'core-rules': { sections: 382, chars: 288387 },
    // task-13: +710 bytes - the Wazdakka Gutsmek datasheet now carries the full
    // PULSE JET MOVE definition that used to be a core-stratagem record.
    // task-33 (2026-10-19 export): 6,502 shaped sections, 10,244,777 bytes - the new
    // export's records with task-32's three fixes still in. task-40: the $FAQ$ marker
    // leaves one ability's text, which merges one part back - 6,501 / 10,243,873.
    'factions-csv': { sections: 6501, bytes: 10243873 },
  },
};

const REAL = path.join(process.cwd(), 'workspace', 'rules-corpus');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-drift-'));
fs.cpSync(path.join(REAL, 'csv'), path.join(root, 'csv'), { recursive: true });
for (const f of fs.readdirSync(REAL)) if (f.endsWith('.html')) fs.copyFileSync(path.join(REAL, f), path.join(root, f));
process.env.RULES_CORPUS_DIR = root;
// task-85 changed the shape on purpose, in two ways this comparison must see through:
// the whitespace a tag boundary introduced before punctuation and inside brackets is
// gone, and the '- section:' child-link lines no longer ride in the text. The guard
// compares CONTENT, so it strips exactly those two classes from both sides. Without
// this, every fixed record would read as 'changed' and the no-loss invariant as loss.
const stripBlocks = s => String(s || '').split('\n').filter(l => !/^- (?:section|faction|card|index|rule): /.test(l)).join('\n');
const norm = s => stripBlocks(s).replace(/\s+/g, ' ').replace(/ ([.,;:!?])(?=\s|$)/g, '$1').replace(/\( /g, '(').replace(/ \)/g, ')').trim();

// the seam: a build must refuse to guess the directory rather than read the live one
let loud = '';
try { writeWikiCorpus(undefined, null, {}); } catch (e) { loud = String(e.message); }
ok('(83) a build with no directory and no data fails loudly', /directory is required/.test(loud));
let loudPlan = '';
try { readPlanInput(); } catch (e) { loudPlan = String(e.message); }
ok('(83) readPlanInput with no directory fails loudly', /directory is required/.test(loudPlan));
t('(83) and the per-call directory is the one set above', corpusDir(), root);

buildFactionCorpus();
const scrape = {};
for (const s of SOURCES) {
  const html = path.join(root, s.name + '.html');
  if (s.built || !fs.existsSync(html)) continue;
  const body = fs.readFileSync(html, 'utf8');
  const sections = assignIds(s.name, extractSections(stripChrome(body), s).filter(x => !isBoardingActionsPageSection(x)));
  scrape[s.name] = sections;
  writeCorpus(s.name, { source: s.name, set: s.set || 'rules', url: s.url, edition: EDITION, marker: parseMarker(body), scrapedAt: new Date().toISOString(), bytes: body.length, count: sections.length, anchored: sections.filter(x => x.hasAnchor).length, sections: sections }, root);
}
// After the scrape, so the core-rules headings exist for the exclusion: 14 CSV ability
// names already have a record, 57 are built, and 5 descriptions exceed MAX_CHARS so the
// shape splits them into a ~2 part - 62 sections is the pipeline's number.
writeWikiCorpus(root, null, { blockInText: true });

const core = scrape['core-rules'] || [];
t('(drift) the scrape stage still produces its baseline', { sections: core.length, chars: core.reduce((n, s) => n + norm(s.text).length, 0) }, BASELINE.scrape);
for (const [name, base] of Object.entries(BASELINE.shape)) {
  const built = JSON.parse(fs.readFileSync(path.join(root, name + '.json'), 'utf8'));
  const got = { sections: built.sections.length };
  if (base.chars) got.chars = built.sections.reduce((n, s) => n + norm(s.text).length, 0);
  if (base.bytes) got.bytes = fs.statSync(path.join(root, name + '.json')).size;
  t('(drift) the shape stage still produces its baseline for ' + name, got, base);
}
// The CSV path is the one that reruns every update: same sections, same size, every
// text identical. (The stamp fields - scrapedAt, marker - are the build's own
// metadata and are regenerated, so the file is not byte-identical by construction;
// 10,024,842 bytes and 0 changed texts is the content claim.)
const csvBuilt = JSON.parse(fs.readFileSync(path.join(root, 'factions-csv.json'), 'utf8'));
const csvStored = JSON.parse(fs.readFileSync(path.join(REAL, 'factions-csv.json'), 'utf8'));
// The comparison is on CONTENT, not on ids: a record that differed only by the removed
// whitespace now collapses into its twin, so the surviving record keeps one of the ids and
// the '~n' suffixes move. A text multiset is what 'nothing was lost' means here; the id
// churn is measured by the payload slug delta and tests/test-bank-scoreable.mjs.
// Chunk boundaries move with the text (the 2,000-character split), so a chunked record
// is compared by its content: three 60-character windows, exactly as the core-rules
// invariant below does.
const windowOk = (t, pool) => {
  const w = [0.25, 0.5, 0.75].map(f => t.slice(Math.floor(t.length * f), Math.floor(t.length * f) + 60)).filter(x => x.length >= 40);
  return w.length === 0 || w.some(x => pool.indexOf(x) !== -1);
};
const csvStoredTexts = csvStored.sections.map(s => norm(s.text));
const csvBuiltTexts = csvBuilt.sections.map(s => norm(s.text));
const csvStoredPool = csvStoredTexts.join(' \n ');
const csvBuiltPool = csvBuiltTexts.join(' \n ');
const tally = list => { const m = new Map(); for (const t of list) m.set(t, (m.get(t) || 0) + 1); return m; };
const csvStoredTally = tally(csvStoredTexts);
const csvBuiltTally = tally(csvBuiltTexts);
let csvMissing = 0, csvAdded = 0;
for (const [t, c] of csvStoredTally) { if ((csvBuiltTally.get(t) || 0) < c && !windowOk(t, csvBuiltPool)) csvMissing += 1; }
for (const [t, c] of csvBuiltTally) { if ((csvStoredTally.get(t) || 0) < c && !windowOk(t, csvStoredPool)) csvAdded += 1; }
t('(drift) the CSV path reproduces factions-csv.json', {
  sections: csvBuilt.sections.length,
  bytes: fs.statSync(path.join(root, 'factions-csv.json')).size,
  added: csvAdded,
  missing: csvMissing,
}, { sections: 6501, bytes: 10243873, added: 0, missing: 0 });

const rebuiltPool = fs.readdirSync(root).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')))
  .flatMap(j => (j.sections || []).map(s => norm(s.text))).join(' \n ');
const builtCore = new Set(JSON.parse(fs.readFileSync(path.join(root, 'core-rules.json'), 'utf8')).sections.map(s => s.id));
const storedCore = JSON.parse(fs.readFileSync(path.join(REAL, 'core-rules.json'), 'utf8')).sections;
const only = storedCore.filter(s => !builtCore.has(s.id) && String(s.id).indexOf('ability#') !== 0 && !/See-Also/.test(s.id));
let carried = 0; const gone = [];
for (const s of only) {
  const text = norm(s.text);
  const windows = [0.25, 0.5, 0.75].map(f => text.slice(Math.floor(text.length * f), Math.floor(text.length * f) + 60)).filter(x => x.length >= 40);
  if (windows.some(w => rebuiltPool.indexOf(w) !== -1)) carried++; else gone.push(s.id);
}
t('(drift) every stored-only section is re-chunked, not dropped', { carried: carried, gone: gone }, { carried: only.length, gone: [] });
const seeAlsoNames = ['Random Characteristics', 'Measuring To A Destroyed Model Or Unit', 'Fight On Death'];
t('(drift) the See-Also entries still reach the enclosing rule', seeAlsoNames.every(n => rebuiltPool.indexOf(n) !== -1), true);

fs.rmSync(root, { recursive: true, force: true });
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
