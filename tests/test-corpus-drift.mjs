import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CORPUS_DIR, SOURCES, assignIds, extractSections, stripChrome, isBoardingActionsPageSection } from '../src/rules-corpus.mjs';
import { writeWikiCorpus } from '../src/wiki-build.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

// task-82: the drift guard. The stored corpus is the SHAPE stage, not the scrape
// stage: a fresh scrape of core-rules gives 375 sections, and writeWikiCorpus turns
// that into the 401 the file holds. Run the real pipeline in a temp copy and compare
// the result with the stored files. Baseline recorded 2026-10-16: zero drift.
const BASELINE = { 'core-rules': { sections: 401, chars: 334155 } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-drift-'));
const tmp = path.join(root, 'rules-corpus');
fs.cpSync(CORPUS_DIR, tmp, { recursive: true });

// the scrape stage, from the HTML that is on disk (no network, no writes outside tmp)
const core = SOURCES.find(s => s.name === 'core-rules');
const html = fs.readFileSync(path.join(tmp, 'core-rules.html'), 'utf8');
const scraped = assignIds('core-rules', extractSections(stripChrome(html), core).filter(s => !isBoardingActionsPageSection(s)));
// The parser stage has its own baseline: 375 sections / 281,473 characters from this
// HTML. A parser change that drops a section or a paragraph fails here even if the
// shape stage could mask it.
const flat = s => String(s || '').replace(/\s+/g, ' ').trim();
const scrapedChars = scraped.reduce((n, s) => n + flat(s.text).length, 0);
t('(drift) the scrape stage still produces 375 sections', scraped.length, 375);
t('(drift) and 281,473 characters of text', scrapedChars, 281473);

const stages = JSON.parse(fs.readFileSync(path.join(tmp, 'core-rules.json'), 'utf8'));
fs.writeFileSync(path.join(tmp, 'core-rules.json'), JSON.stringify(Object.assign({}, stages, { sections: scraped, count: scraped.length, anchored: scraped.filter(s => s.hasAnchor).length })));
writeWikiCorpus(tmp, null, { blockInText: true });

const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const chars = l => l.reduce((n, s) => n + norm(s.text).length, 0);
for (const name of Object.keys(BASELINE)) {
  const built = JSON.parse(fs.readFileSync(path.join(tmp, name + '.json'), 'utf8'));
  const stored = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, name + '.json'), 'utf8'));
  const byId = new Map(stored.sections.map(s => [s.id, s]));
  let only = 0, diff = 0;
  for (const s of built.sections) { const o = byId.get(s.id); if (!o) { only++; continue; } if (norm(o.text) !== norm(s.text)) diff++; }
  const missing = stored.sections.filter(s => !built.sections.some(x => x.id === s.id)).length;
  t('(drift) ' + name + ': the shape build still produces the stored sections', [built.sections.length, only, missing, diff], [BASELINE[name].sections, 0, 0, 0]);
  t('(drift) ' + name + ': and the same characters', chars(built.sections), BASELINE[name].chars);
}

// and every other source the shape build writes must round-trip unchanged too
const written = ['rules-appendix', 'event-companion', 'core-stratagems', 'factions-csv'];
for (const name of written) {
  const built = JSON.parse(fs.readFileSync(path.join(tmp, name + '.json'), 'utf8'));
  const stored = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, name + '.json'), 'utf8'));
  const byId = new Map(stored.sections.map(s => [s.id, norm(s.text)]));
  const diff = built.sections.filter(s => byId.has(s.id) && byId.get(s.id) !== norm(s.text)).length;
  const counts = built.sections.length - stored.sections.length;
  t('(drift) ' + name + ' is unchanged by the shape build', [counts, diff], [0, 0]);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
