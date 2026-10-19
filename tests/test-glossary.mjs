import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MFM_SLUGS, buildGlossary, coverageReport, foldName, glossaryWordSet } from '../src/glossary.mjs';
import { vocabulary } from './glossary-coverage.mjs';

// task-21: the glossary's coverage. The benchmark lost names to gaps in it, and
// the glossary is the accuracy lever, so the shape, the source list and the
// tested set are pinned here rather than trusted.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => { const good = JSON.stringify(got) === JSON.stringify(want); if (good) pass++; else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); } };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'glossary-fr-en.json'), 'utf8'));
const TERMS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'glossary-terms.json'), 'utf8'));

// --- the build ---------------------------------------------------------------
t('every expected faction pair is cached', G.missingPairs, []);
t('the pair list is the corpus\' 25 factions', MFM_SLUGS.length, 25);
ok('the MFM is named as the source', /mfm\.warhammer-community\.com/.test(G.source) && G.pairs.length === 25);
t('the three pairs task-21 fetched are in the list', MFM_SLUGS.filter(s => ['leagues-of-votann', 'adeptus-mechanicus', 'imperial-agents'].indexOf(s) !== -1), ['adeptus-mechanicus', 'imperial-agents', 'leagues-of-votann']);
ok('the file is generated, not hand-edited', typeof G.generated === 'string' && !Array.isArray(G.generated));
t('the entries the fix added', G.entries.length, 1897);
t('the categories', Object.keys(G.counts).sort(), ['datasheet', 'detachment', 'enhancement', 'faction', 'force_disposition', 'rule', 'weapon']);
ok('the coverage fix grew every table it touched', G.counts.datasheet >= 877 && G.counts.enhancement >= 758 && G.counts.faction === 26 && G.counts.weapon === 2);
ok('a rebuild is reproducible and pure', (() => { const b = buildGlossary(); return b.entries.length === G.entries.length && b.missingPairs.length === 0; })());

// --- the names the benchmark could not repair --------------------------------
const byName = en => G.entries.filter(e => foldName(e.en) === foldName(en));
const byWord = w => G.entries.filter(e => foldName(e.en).split(/[^a-z0-9']+/).indexOf(w) !== -1);
t('Votann is a faction now', byWord('votann').map(e => e.category), ['faction']);
t('Sicaran is a datasheet now', byName('Sicaran').map(e => e.category), ['datasheet']);
t('Krak and Rapier are weapons now', [byName('Krak').map(e => e.category), byName('Rapier').map(e => e.category)], [['weapon'], ['weapon']]);
t("T'au is carried with its own spelling", G.entries.filter(e => e.fr === "T'AU").map(e => e.en), ["T'au"]);
ok("the MFM's own T AU faction is still there", G.entries.some(e => foldName(e.en) === foldName("T\u2019AU EMPIRE")));

// --- the tested set ----------------------------------------------------------
t('the tested set is the benchmark\'s 30 terms', TERMS.length, 30);
const report = coverageReport(TERMS.map(x => x.en), G);
t('every tested term is covered', [report.total, report.covered, report.missing.length], [30, 30, 0]);
ok('the check folds apostrophes and accents', foldName("T\u2019AU EMPIRE") === foldName("T'au empire") && foldName('CÉRASTES') === 'cerastes');
ok('a word inside a name covers it', coverageReport(['Agamatus'], G).missing.length === 0 && coverageReport(['Nightspear'], G).missing.length === 1);

// --- the vocabulary sweep ----------------------------------------------------
const csv = path.join(ROOT, 'workspace', 'rules-corpus', 'csv');
if (fs.existsSync(csv)) {
  const v = vocabulary();
  const sweep = coverageReport(v.names.concat(v.words), G);
  ok('the sweep builds the corpus vocabulary from the tables', v.names.length > 5000 && v.words.length > 4000);
  ok('the sweep is still a report, not a promise: most weapon and stratagem names are unsourced', sweep.missing.length > 4000 && sweep.covered > 3800);
  const before = 6417; // measured with the 1,710-entry build (workspace/glossary-before-task21.json)
  ok('the fix moved the sweep, not just the tested set', sweep.missing.length < before);
  ok('no tested term is missing from the sweep', coverageReport(TERMS.map(x => x.en), G).missing.length === 0);
} else {
  console.log('(CSV dir absent: sweep assertions skipped)');
}

// --- the source list is in the file, not only in the cache -------------------
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'glossary.mjs'), 'utf8');
ok('the build reports missing pairs instead of quietly shrinking', /missingPairs/.test(SRC) && /WARNING: '.+ expected MFM pair/.test(SRC));
ok('the hand-set names are documented as such', /const COVERAGE_TERMS = \[/.test(SRC) && /MFM publishes unit, detachment and enhancement names only/.test(SRC));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
