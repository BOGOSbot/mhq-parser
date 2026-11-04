import fs from 'node:fs';
import { parseListText, totals, realUnits, playerWarnings, getMeta } from '../src/parse.mjs';

// What a group header is, and why it is not a unit.
//
// Both the app's header dialect and the league template that puts two
// datasheets in one attached group print the group's combined points on a
// header line, then print the members with their own points underneath. Read
// the header as a unit and the group is counted twice; the army total comes out
// hundreds of points over and the export's own unit count is exceeded. The
// group lines are containers, so they are skipped and their members kept.

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, cond, detail) {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (detail ? ' - ' + detail : '')); }
}
const one = s => parseListText(s, { name: 'x' }).output.players[0];
const models = p => realUnits(p).map(u => u.model);

const audit = (p) => ({ units: realUnits(p).length, parsed: totals(p).parsedPts, declared: totals(p).declaredPts, warned: playerWarnings(p, getMeta(p)).map(w => w.type) });

// --- the app's header dialect, "Attached Unit N (N points)" ------------------
const appBody = [
  '+++++++++++++++++++++++++++++++++++++++++++++++',
  '+ PLAYER NAME: Grek',
  '+ FACTION KEYWORD: Xenos - Orks',
  '+ DETACHMENT: Green Tide (1 DP)',
  '+ FORCE DISPOSITION: Take and Hold',
  '+ TOTAL ARMY POINTS: 470',
  '+ NUMBER OF UNITS: 5',
  '+++++++++++++++++++++++++++++++++++++++++++++++',
  'ATTACHED UNITS',
  'Attached Unit 1 (200 points)',
  'Warboss (115 points)',
  '* Attached as: Leader',
  '• 1x Power Klaw',
  'Boyz (85 points)',
  '* Attached as: Bodyguard (Battleline)',
  '• 9x Choppa',
  '',
  'Attached Unit 2 (185 points)',
  'Warboss (100 points)',
  '* Attached as: Leader',
  '• 1x Kombi-skorcha',
  'Boyz (85 points)',
  '* Attached as: Bodyguard (Battleline)',
  '• 9x Slugga',
  '',
  'CHARACTERS',
  'Char1: Ghazghkull Thraka (85 points)',
  '• 1x Mork\u2019s Roar',
].join('\n');
const app = one(appBody);
t('app group: totals are the members, not the group', audit(app), { units: 5, parsed: 470, declared: 470, warned: [] });
t('app group: no group header is a unit', models(app).filter(m => /Attached Unit/i.test(m)), []);
t('app group: a member keeps the group it belongs to', app.units.filter(u => u.attachedUnit).map(u => u.attachedUnit), ['Attached Unit 1', 'Attached Unit 1', 'Attached Unit 2', 'Attached Unit 2']);

// --- the league template, "Name + Name (N pts)" under ATTACHED UNITS ---------
const pairBody = [
  '+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++',
  'List Name: NWA Test',
  'Factions Used: Tyranids',
  'Army Points: 450',
  'Disposition: Reconnaissance',
  'Detachment(s): Ambush Predators, Vanguard Onslaught',
  '+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++',
  '',
  'ATTACHED UNITS:',
  'Hyperadapted Raveners + Raveners (290 pts)',
  'Hyperadapted Raveners (165 pts)',
  '• 3x Ravener',
  'Raveners (125 pts)',
  '• 5x Ravener',
  '',
  'CHARACTERS:',
  'Deathleaper (80 pts)',
  '• Lictor claws and talons',
  '',
  'OTHER DATASHEETS:',
  'Neurogaunts (80 pts)',
  '• 10x Neurogaunt',
].join('\n');
const pair = one(pairBody);
t('pair header: totals are the members, not the pair', audit(pair), { units: 4, parsed: 450, declared: 450, warned: [] });
t('pair header: the pair line is not a unit', models(pair).filter(m => m.includes(' + ')), []);
// The label the same template prints, "Detachment(s):", is the detachment.
t('pair header: Detachment(s) is read as the detachment', getMeta(pair).detachment, 'Ambush Predators, Vanguard Onslaught');

// --- the older freeform group label still works ------------------------------
// The category dialect prints "Attached unit 1" with no points on it. That line
// was never a unit, and the members under it must still be counted once.
const freeBody = [
  'Grek\u2019s Orks (400 points)',
  '',
  'Orks',
  'Green Tide (1 Detachment Points)',
  'Take and Hold',
  'Strike Force (2000 points)',
  '',
  'ATTACHED UNITS',
  '',
  'Attached unit 1',
  '',
  'Warboss (115 points)',
  '• Attached as: Leader',
  '• 1x Power Klaw',
  '',
  'Boyz (85 points)',
  '• Attached as: Bodyguard',
  '• 9x Choppa',
  '',
  'CHARACTERS',
  '',
  'Ghazghkull Thraka (200 points)',
  '• 1x Mork\u2019s Roar',
].join('\n');
const free = one(freeBody);
t('freeform group label: members once, header never', { units: realUnits(free).length, parsed: totals(free).parsedPts, warned: playerWarnings(free, getMeta(free)).map(w => w.type) }, { units: 3, parsed: 400, warned: [] });

// --- a "A + B" line outside an attached section is still a unit --------------
// The pair rule is gated on the section: elsewhere that line is a player
// folding two choices into one entry, and dropping it would lose their points.
const foldBody = [
  'Grek\u2019s Orks (200 points)',
  '',
  'Orks',
  'Green Tide (1 Detachment Points)',
  'Take and Hold',
  'Strike Force (2000 points)',
  '',
  'CHARACTERS',
  '',
  'Warboss + Boyz (120 points)',
  '• 1x Power Klaw',
  '',
  'OTHER DATASHEETS',
  '',
  'Trukk (80 points)',
  '• 1x Spiked Ram',
].join('\n');
t('outside the section a combined line stays a unit', { units: realUnits(one(foldBody)).length, models: models(one(foldBody)), parsed: totals(one(foldBody)).parsedPts }, { units: 2, models: ['Warboss + Boyz', 'Trukk'], parsed: 200 });

console.log((fail ? 'FAILED ' : 'ok ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
