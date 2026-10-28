import fs from 'node:fs';
import { buildMfmFactions, mfmDumpPath } from '../src/mfm-factions.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

if (!fs.existsSync(mfmDumpPath())) {
  console.log('skip test-mfm-wargear-options: no MFM dump at ' + mfmDumpPath());
  process.exit(0);
}

// A datasheet carries every weapon it can field, not only its default loadout,
// and the card's printed options as 'Option:' lines. The case that found the gap:
// data version 995 changed the Death Company Captain's Power Fist (A 3 to 6,
// WS 3+ to 2+), and the Power Fist is an option, so the corpus could not show it.
const out = buildMfmFactions({ dumpPath: mfmDumpPath() });
const ds = out.corpus.sections.filter(r => r.kind === 'datasheet');
const byName = n => ds.find(r => r.heading === n);
const lines = r => r.text.split('\n');

const dcc = byName('Death Company Captain');
ok('the Death Company Captain is built', dcc);
const w = lines(dcc).filter(l => l.startsWith('Wargear '));
t('default loadout first, then the options in card order', w.map(l => l.slice(8, l.indexOf(' ('))),
  ['Heavy Bolt Pistol', 'Master-crafted Chainsword', 'Power Fist', 'Relic Weapon', 'Inferno Pistol']);
ok('the optional Power Fist carries its 995 profile', w.indexOf('Wargear Power Fist (Melee): A 6 WS 2+ S 8 AP -2 D 2') !== -1);
t('the printed options, one line each', lines(dcc).filter(l => l.startsWith('Option: ')), [
  "Option: This model's Master-crafted Chainsword can be replaced with one of the following: 1 Power Fist, 1 Relic Weapon",
  "Option: This model's Heavy Bolt Pistol can be replaced with 1 Inferno Pistol.",
]);
const order = lines(dcc).map(l => l.split(/[ :]/)[0]);
ok('options sit between the wargear and the points', order.lastIndexOf('Wargear') < order.indexOf('Option') && order.lastIndexOf('Option') < order.indexOf('Points'));

// Across the corpus.
const s = out.stats.wargear;
ok('optional profiles were added (' + s.optional + ')', s.optional > 2000);
ok('option lines were written (' + s.options + ')', s.options > 1200);
let dupes = 0, defaults = 0, bullets = 0;
for (const r of ds) {
  const wl = lines(r).filter(l => l.startsWith('Wargear '));
  dupes += wl.length - new Set(wl).size;
  for (const l of lines(r).filter(l => l.startsWith('Option: '))) {
    if (/^Option: def\w*\s+warg\w*$/i.test(l)) defaults++;
    if (/[■▪▫]/.test(l)) bullets++;
  }
}
t('no weapon line twice on one datasheet', dupes, 0);
t('a "Default Wargear" group is never an option', defaults, 0);
t('the printed bullets are flattened', bullets, 0);

// A multi-profile weapon names each profile once, not the item twice.
const named = ds.flatMap(r => lines(r).filter(l => /^Wargear (.+) - \1 /.test(l)));
t('no profile name repeats its item name', named.length, 0);

console.log((fail ? 'FAIL' : 'ok') + ' test-mfm-wargear-options: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
