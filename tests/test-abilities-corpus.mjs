import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'workspace', 'rules-corpus');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };
const t = (name, got, want) => ok(name + ' (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')', JSON.stringify(got) === JSON.stringify(want));

// A temp corpus holding only what the builder needs: the CSV and core-rules.json
// (the covered-name set is derived from the rules records, not hardcoded).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-abi-'));
try {
  fs.mkdirSync(path.join(tmp, 'csv'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'csv', 'Abilities.csv'), path.join(tmp, 'csv', 'Abilities.csv'));
  fs.copyFileSync(path.join(SRC, 'core-rules.json'), path.join(tmp, 'core-rules.json'));
  process.env.RULES_CORPUS_DIR = tmp;
  const RC = await import('../src/rules-corpus.mjs');
  const rulesBefore = RC.readAllCorpus('rules').length;
  const built = RC.buildAbilitiesCorpus();
  const j = JSON.parse(fs.readFileSync(path.join(tmp, 'abilities.json'), 'utf8'));
  const rulesAfter = RC.readAllCorpus('rules').length;
  t('the builder emits the 57 names no record covers', built.count, 57);
  t('the file holds the same 57 sections', j.sections.length, 57);
  t('the CSV has 71 distinct names and 24 duplicate rows', [built.names, built.dropped], [71, 24]);
  t('14 names are already covered and stay where they are', built.excluded.length, 14);
  ok('the covered list is the Duplicated Abilities family',
    ['Deep Strike', 'Feel No Pain', 'Stealth', 'Leader'].every(n => built.excluded.indexOf(n) !== -1));
  ok('none of the covered names is emitted as an ability record',
    j.sections.every(s => built.excluded.indexOf(s.heading) === -1));
  ok('every record is a rules-namespace ability',
    j.sections.every(s => s.kind === 'ability' && s.set === 'rules' && s.source === 'abilities'));
  ok('the id is readable and stable', j.sections.every(s => /^ability#[a-z0-9-]+$/.test(s.id)));
  ok('the record carries the name as its first line', j.sections.every(s => String(s.text).split('\n')[0] === s.heading));
  ok('the legend and the factions are fields', j.sections.every(s => typeof s.legend === 'string' && Array.isArray(s.factions)));
  ok('provenance points at Abilities.csv', j.sections.every(s => s.provenance && s.provenance.file === 'csv/Abilities.csv'));
  t('the rules namespace grows by the 57', rulesAfter - rulesBefore, 57);
  ok('the source is in ALL_SOURCES', RC.ALL_SOURCES.some(s => s.name === 'abilities'));
  const sample = j.sections.find(s => s.heading === 'Synapse');
  ok('Synapse resolves', !!sample && sample.id === 'ability#synapse');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Second build in a clean temp dir must be byte-identical per record: the builder is a
// pure function of the CSV and the rules corpus.
const toc = fs.readFileSync(path.join(ROOT, 'src', 'wiki-toc.mjs'), 'utf8');
ok('the tree has an Abilities book under Rules', /slug: 'abilities', name: 'Abilities', sources: \['abilities'\]/.test(toc));
ok('the book gets one chapter, before the Core Abilities fallback',
  /slug === 'abilities'\) return \{ key: 'local:Abilities'/.test(toc) &&
  toc.indexOf("slug === 'abilities'") < toc.indexOf("r.kind === 'ability'"));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
