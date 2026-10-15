import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPlanInput } from '../src/wiki-plan.mjs';
import { writeWikiCorpus, RULES_SOURCES, FACTION_SOURCES } from '../src/wiki-build.mjs';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));

// The build must be idempotent: running it twice must not grow the corpus. It
// was not - the ability definitions carry source 'core-rules', so each build
// wrote them back into core-rules.json on top of the copies already there, and
// three builds turned 19 definitions into 57 duplicate records. This test feeds
// the build its own output and asserts nothing grows, which is the guard for
// every build path, not just the one that bit us.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const ids = list => list.map(s => s.id);
const dupes = list => { const m = {}; for (const id of ids(list)) m[id] = (m[id] || 0) + 1; return Object.keys(m).filter(id => m[id] > 1); };
const readOut = (dir, source) => (JSON.parse(fs.readFileSync(path.join(dir, source + '.json'), 'utf8')).sections) || [];

const input = readPlanInput();
const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-build-a-'));
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-build-b-'));
const first = writeWikiCorpus(tmpA, input);

// The second run reads the FIRST run's output, the way the next build reads the
// corpus directory. Before the fix, core-rules doubled here.
// The next build sees the same directory: the written rules files plus the
// ability-defs.json their own builder writes (which this pass must not touch).
const abilityDefs = JSON.parse(fs.readFileSync(path.join(ROOT, 'workspace', 'rules-corpus', 'ability-defs.json'), 'utf8')).sections || [];
const rules = RULES_SOURCES.flatMap(s => readOut(tmpA, s)).concat(abilityDefs);
const factions = readOut(tmpA, FACTION_SOURCES[0]);
const second = writeWikiCorpus(tmpB, {
  rules: rules.map(r => Object.assign({}, r, { set: 'rules' })),
  factions: factions.map(r => Object.assign({}, r, { set: 'factions' })),
  abilities: input.abilities, factionsCsv: input.factionsCsv,
});

const before = fs.readFileSync(path.join(tmpA, 'core-rules.json'));
const after = fs.readFileSync(path.join(tmpB, 'core-rules.json'));
t('the second run is byte-identical to the first', after.equals(before), true);
t('and the manifest record count is identical', second.records, first.records);
t('the output has no duplicate ids in any file', RULES_SOURCES.concat(FACTION_SOURCES).every(s => dupes(readOut(tmpB, s)).length === 0), true);
t('no ability definition is written by this build', RULES_SOURCES.every(s => !readOut(tmpB, s).some(r => String(r.id).indexOf('ability-def#') === 0)), true);
ok('the first run was not empty', first.records > 5000);

fs.rmSync(tmpA, { recursive: true, force: true });
fs.rmSync(tmpB, { recursive: true, force: true });
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
