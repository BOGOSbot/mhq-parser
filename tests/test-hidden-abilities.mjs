import fs from 'node:fs';
import { readAllCorpus, csvRows } from '../src/rules-corpus.mjs';

// MEASUREMENT, no corpus change: how many universal abilities are defined inside
// a parent section but never given a heading of their own. Two structured sources,
// both the export's or the rulebook's own, so the count is reproducible:
//
//   - weapon and universal abilities, from the rulebook's own notation in the
//     corpus text: the bracketed tokens, [BLAST], [LETHAL HITS: VEHICLE],
//     [SUSTAINED HITS 1: INFANTRY/BEASTS];
//   - core abilities, from Datasheets_abilities rows of type Core resolved
//     through Abilities.csv.
//
// 'Dedicated heading' means a heading segment that IS the name (brackets
// stripped, case-folded) - a section of its own. 'Mentioned' means the name
// appears inside some other heading. This is the line between a rule the reader
// can look up and one that only exists inside someone else's page.
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const all = readAllCorpus();
const fold = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// --- weapon and universal abilities, from the bracketed notation --------------
const bracket = new Map();
for (const r of all) {
  for (const m of String(r.text || '').matchAll(/\[([^\]]{2,40})\]/g)) {
    const base = m[1].trim().split(':')[0].replace(/\s+[0-9X]+$/, '').trim();
    if (!base || !/[a-z]/i.test(base)) continue;
    if (/^\d+BTP$/i.test(base)) continue;            // [2BTP]: a timing marker, not an ability
    const k = fold(base);
    bracket.set(k, (bracket.get(k) || 0) + 1);
  }
}
// The parameterised forms are one ability with an argument: [ANTI-VEHICLE 4+] is
// [ANTI], [SUSTAINED HITS D3] is [SUSTAINED HITS]. Canonicalise before counting.
const canonical = raw => {
  const u = raw.toUpperCase();
  if (/^ANTI(-|\b)/.test(u)) return 'ANTI';
  if (/^BLAST(\s|$)/.test(u)) return 'BLAST';
  if (/^MELTA(\s|$)/.test(u)) return 'MELTA';
  if (/^RAPID FIRE(\s|$)/.test(u)) return 'RAPID FIRE';
  if (/^SUSTAIN(ED|DED) HITS(\s|$)/i.test(u)) return 'SUSTAINED HITS';
  if (/^CLEAVE(\s|$)/.test(u)) return 'CLEAVE';
  if (/^IGNORES? COVER$/.test(u)) return 'IGNORES COVER';
  return u;
};
const weapon = new Map();
for (const [k, n] of bracket) { const c = canonical(k); weapon.set(c, (weapon.get(c) || 0) + n); }

// --- core abilities, from the export's own table ------------------------------
const ab = csvRows(fs.readFileSync(new URL('../workspace/rules-corpus/csv/Abilities.csv', import.meta.url), 'utf8'));
const abById = new Map(ab.map(r => [String(r.id), r]));
const core = new Set();
for (const r of csvRows(fs.readFileSync(new URL('../workspace/rules-corpus/csv/Datasheets_abilities.csv', import.meta.url), 'utf8'))) {
  if (r.type !== 'Core') continue;
  const a = abById.get(String(r.ability_id));
  if (a && a.name) core.add(a.name);
}
t('the export names 14 core abilities', core.size, 14);

const leafNames = () => all.flatMap(r => String(r.heading || '').split(' > ').map(s => fold(s).replace(/^\[|\]$/g, '').trim())).filter(Boolean);
const leaves = leafNames();
const allHeadings = ' ' + all.map(r => fold(r.heading || '')).join(' ') + ' ';
const dedicated = name => leaves.indexOf(fold(name)) !== -1;
const mentioned = name => allHeadings.indexOf(fold(name)) !== -1;

const report = rows => rows.map(r => ({ name: r.name, uses: r.uses, dedicated: dedicated(r.name), mentioned: mentioned(r.name) }));
const weapons = report([...weapon].map(([name, uses]) => ({ name: name, uses: uses })).sort((a, b) => a.name.localeCompare(b.name)));
const cores = report([...core].map(name => ({ name: name, uses: null })).sort((a, b) => a.name.localeCompare(b.name)));

const hiddenWeapons = weapons.filter(r => !r.dedicated);
const hiddenCores = cores.filter(r => !r.dedicated);
console.log('WEAPON / UNIVERSAL ABILITIES (' + weapons.length + ', hidden ' + hiddenWeapons.length + ')');
for (const r of weapons) console.log((r.dedicated ? '  dedicated  ' : '  HIDDEN     ') + r.name.padEnd(20) + String(r.uses).padStart(5) + ' uses' + (r.dedicated ? '' : (r.mentioned ? '  (mentioned in another heading)' : '  (text only)')));
console.log('CORE ABILITIES (' + cores.length + ', hidden ' + hiddenCores.length + ')');
for (const r of cores) console.log((r.dedicated ? '  dedicated  ' : '  HIDDEN     ') + r.name.padEnd(20) + (r.dedicated ? '' : (r.mentioned ? '  (mentioned in another heading)' : '  (text only)')));

// The facts as measured. If the corpus gains headings for these, the numbers move
// and this test is the place that says so.
t('23 weapon/universal abilities are named in the corpus text', weapons.length, 23);
t('20 of them have no heading of their own', hiddenWeapons.length, 20);
t('EXTRA ATTACKS, ONE SHOT and TORRENT are the only three with one', weapons.filter(r => r.dedicated).map(r => r.name).sort(), ['EXTRA ATTACKS', 'ONE SHOT', 'TORRENT']);
t('Lethal Hits is one of the hidden', hiddenWeapons.some(r => r.name === 'LETHAL HITS'), true);
t('and the corpus uses it 346 times', (weapons.find(r => r.name === 'LETHAL HITS') || {}).uses, 346);
t('no core ability is hidden: the export names them and the corpus carries them', hiddenCores, []);
ok('the hidden set is a bounded list, not a chunking crisis', hiddenWeapons.length < 25);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
