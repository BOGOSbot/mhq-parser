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
// Baseline moved 2026-10-16 (task-85 D4): the shaper no longer writes the 'section'
// child links into the record text, and core-rules' link blocks were entirely those
// lines, so the shape-stage character count now equals the scrape stage's - 281,473.
// The other four block kinds (- faction:, - card:, - index:, - rule:) are untouched;
// they are the cross-reference index the vectors were measured with.
//
// Decision recorded here, not to be re-run without reason: the pipeline's re-chunking
// (375 against 401, same content) is not worth a reparse today - it would rewrite 78
// sections, move ids, re-embed, and refetch 26 faction pages for no user-visible
// gain. It belongs to the next real Wahapedia update, when the corpus moves anyway.
const BASELINE = {
  scrape: { sections: 375, chars: 281473 },
  shape: { 'core-rules': { sections: 375, chars: 281473 }, 'factions-csv': { sections: 6400, bytes: 10024842 } },
};

const REAL = path.join(process.cwd(), 'workspace', 'rules-corpus');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-drift-'));
fs.cpSync(path.join(REAL, 'csv'), path.join(root, 'csv'), { recursive: true });
for (const f of fs.readdirSync(REAL)) if (f.endsWith('.html')) fs.copyFileSync(path.join(REAL, f), path.join(root, f));
process.env.RULES_CORPUS_DIR = root;
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

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
const csvById = new Map(csvStored.sections.map(s => [s.id, norm(s.text)]));
t('(drift) the CSV path reproduces factions-csv.json', {
  sections: csvBuilt.sections.length,
  bytes: fs.statSync(path.join(root, 'factions-csv.json')).size,
  added: csvBuilt.sections.filter(s => !csvById.has(s.id)).length,
  missing: csvStored.sections.filter(s => !csvBuilt.sections.some(x => x.id === s.id)).length,
  changed: csvBuilt.sections.filter(s => csvById.has(s.id) && csvById.get(s.id) !== norm(s.text)).length,
}, { sections: 6400, bytes: 10024842, added: 0, missing: 0, changed: 0 });

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
