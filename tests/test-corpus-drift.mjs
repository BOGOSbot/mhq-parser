import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}

// task-82: the drift guard, and the two traps it exists to avoid.
//
// The stored corpus file is the output of TWO stages: the scrape stage
// (extractSections over the scraped HTML) and the shape stage (writeWikiCorpus in
// src/wiki-build.mjs). Two ways to measure nothing:
//   - compare the scrape stage with the stored file (375 against 401 is a STAGE
//     mismatch, not loss - the shape stage puts the other 26 there);
//   - build into a temp dir while RULES_CORPUS_DIR still points at the live corpus.
//     readPlanInput() takes no directory: writeWikiCorpus reads whatever that env
//     says, so an unset env makes a temp-dir build read the LIVE corpus and write
//     it back - a perfect reproduction of itself. That was the 'zero drift'
//     measurement of 2026-10-16; it was an artifact.
//
// So: source only (the HTML and CSV on disk, nothing stored), env pointed at the
// temp dir, then check the baselines AND that no rule text is lost. The stored
// file is not reproduced section for section today - the shape stage re-chunks
// long rules and skips the 18 core-ability records the ability-defs builder owns -
// and that is structure, not content. The invariant below is the content.
const BASELINE = {
  scrape: { sections: 375, chars: 281473 },
  shape: { 'core-rules': { sections: 375, chars: 294892 }, 'factions-csv': { sections: 6400, bytes: 10024842 } },
};

const REAL = path.join(process.cwd(), 'workspace', 'rules-corpus');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-drift-'));
fs.cpSync(path.join(REAL, 'csv'), path.join(root, 'csv'), { recursive: true });
for (const f of fs.readdirSync(REAL)) if (f.endsWith('.html')) fs.copyFileSync(path.join(REAL, f), path.join(root, f));
process.env.RULES_CORPUS_DIR = root;

const RC = await import('../src/rules-corpus.mjs');
const { writeWikiCorpus } = await import('../src/wiki-build.mjs');
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();

RC.buildFactionCorpus();
const scrape = {};
for (const s of RC.SOURCES) {
  const html = path.join(root, s.name + '.html');
  if (s.built || !fs.existsSync(html)) continue;
  const body = fs.readFileSync(html, 'utf8');
  const sections = RC.assignIds(s.name, RC.extractSections(RC.stripChrome(body), s).filter(x => !RC.isBoardingActionsPageSection(x)));
  scrape[s.name] = sections;
  RC.writeCorpus(s.name, { source: s.name, set: s.set || 'rules', url: s.url, edition: RC.EDITION, marker: RC.parseMarker(body), scrapedAt: new Date().toISOString(), bytes: body.length, count: sections.length, anchored: sections.filter(x => x.hasAnchor).length, sections: sections });
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

// The content invariant: no stored section's rule text disappears from the rebuild.
// The 18 core-ability records are skipped by design (writeWikiCorpus line 75: ids
// owned by the ability-defs builder are not written twice), so they are excluded;
// everything else must still be there, allowing for re-chunking.
const rebuiltPool = fs.readdirSync(root).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')))
  .flatMap(j => (j.sections || []).map(s => norm(s.text))).join(' \n ');
const builtCore = new Set(JSON.parse(fs.readFileSync(path.join(root, 'core-rules.json'), 'utf8')).sections.map(s => s.id));
const storedCore = JSON.parse(fs.readFileSync(path.join(REAL, 'core-rules.json'), 'utf8')).sections;
// See-Also widgets are excluded twice over: the ability-defs skip above, and the
// step-5 fix that stops the widget becoming a section at all (its list is merged
// into the enclosing rule, which the entries assertion below checks).
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
