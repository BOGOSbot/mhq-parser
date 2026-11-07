import { parseListText, totals, realUnits, playerWarnings, getMeta } from '../src/parse.mjs';

// Four shapes the parser misread, and one it must keep warning on, from "League Wars 2026-2027 - Ligue 2 - L2 Sud-Est - Aller" that
// raised a warning the list did not deserve. Each fixture is cut down from the
// real submission; the audit is what the page shows for it.

let pass = 0, fail = 0;
function t(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
const one = s => parseListText(s, { name: 'x' }).output.players[0];
const audit = p => ({
  parsed: totals(p).parsedPts,
  warned: playerWarnings(p, getMeta(p)).map(w => w.type),
  det: getMeta(p).detachment,
  disp: getMeta(p).forceDisposition,
});

// --- "(QUE 70 points)": a tag before the cost ---------------------------------
const que = [
  'Crisis a balle (1995 points)',
  '',
  'T’au Empire',
  'Retaliation Cadre (3 Detachment Points)',
  'Purge the Foe',
  'Strike Force (2000 points)',
  '',
  'Attached Units',
  'Attached Unit 1',
  '',
  'Commander Farsight (QUE 70 points)',
  '• Attached as: Leader (Character)',
  '• Warlord',
  '',
  'Crisis Fireknife Battlesuits (100 points)',
  '• Attached as: Bodyguard',
  '• 1x Crisis Fireknife Shas’vre',
  '',
  'CHARACTERS',
  '',
  'Darkstrider (1825 points)',
].join('\n');
{
  const p = one(que);
  t('QUE: the epic hero is a unit', realUnits(p).map(u => u.model).slice(0, 2), ['Commander Farsight', 'Crisis Fireknife Battlesuits']);
  t('QUE: its cost is read', realUnits(p)[0].points, 70);
}

// --- a hand-merged list is left to warn ----------------------------------------
const berz = [
  '+++++++++++++++++++++++++++++++++++++++++++++++',
  '+ PLAYER: Liabdeh',
  '+ FACTION KEYWORD: Chaos - World Eaters',
  '+ DETACHMENT: Berzerker Warband and Vessels of Wrath (3 Detachment Points)',
  '+ FORCE DISPOSITION: Purge the Foe',
  '+ TOTAL ARMY POINTS: 505pts',
  '+++++++++++++++++++++++++++++++++++++++++++++++',
  'ATTACHED UNITS',
  'Attached unit 1',
  '',
  '1x Khârn the Betrayer (115 pts): Gorechild, Plasma pistol',
  '• Attached as: Leader (Character)',
  '',
  'Khorne Berzerkers (170 Points)',
  '• Attached as: Bodyguard (Battleline)',
  '10x Khorne Berzerkers (170 pts)',
  '• 9x Khorne Berzerker',
  '• 1x Khorne Berzerker Champion: Chainblade, Plasma pistol',
  '',
  'OTHER DATASHEETS',
  '2x Chaos Spawn (95 pts): 2 with Hideous Mutations',
  '2x Chaos Spawn (95 pts): 2 with Hideous Mutations',
].join('\n');
{
  const p = one(berz);
  // Deliberately NOT merged: this is a hand-merged list (app header, New Recruit
  // body), not an export, and the inflated total is how the page flags it.
  t('Berzerkers: the repeated line stays a second unit', realUnits(p).map(u => u.model), ['Khârn the Betrayer', 'Khorne Berzerkers', 'Khorne Berzerkers', 'Chaos Spawn', 'Chaos Spawn']);
  t('Berzerkers: so the total is over and the list warns', [totals(p).parsedPts, playerWarnings(p, getMeta(p)).map(w => w.type)], [115 + 170 + 170 + 95 + 95, ['mismatch']]);
}

// --- "FORCES DISPOSITIONS" ---------------------------------------------------
{
  const p = one([
    '+++++++++++++++++++++++++++++++++++++++++++++++',
    '+ PLAYER NAME: Skaerssen',
    '+ FACTION KEYWORD: Imperium - Adeptus Astartes - Ultramarines',
    '+ DETACHMENT: Assault Brethren (3 Detachment Points)',
    '+ TOTAL ARMY POINTS: 2000pts',
    '+ FORCES DISPOSITIONS: Take and Hold',
    '+++++++++++++++++++++++++++++++++++++++++++++++',
    'CHARACTERS',
    'Roboute Guilliman (415 Points)',
    '• Warlord',
    'Librarian in Phobos Armour (75 Points)',
  ].join('\n'));
  t('FORCES DISPOSITIONS is the disposition', audit(p).disp, 'Take and Hold');
}

// --- "Detachment [3 Detachment Points] --> A [1 Points], B [2 Points]" ---------
{
  const p = one([
    'Joueur : Squaelon',
    'Equipe : Legio Mistralis',
    'Army :  Imperial Knights  [2000 pts]',
    'Detachment [3 Detachment Points] --> Dominus Foebreakers [1 Points], Valourstrike Lance [2 Points]',
    'Force Disposition: Priority Assets',
    '',
    'Char1: 1x Knight Paladin (375 pts): Rapid-fire battle cannon',
    'Char2: 1x Knight Crusader (410 pts): Avenger gatling cannon',
  ].join('\n'));
  t('arrow form: the names, without their costs', audit(p).det, 'Dominus Foebreakers, Valourstrike Lance');
  t('arrow form: the disposition is still read', audit(p).disp, 'Priority Assets');
}

// --- an unlabelled detachment line above the disposition ----------------------
{
  const p = one([
    'Discrushption (1995 points)',
    'Joueur: Arnaud',
    'Team: Ramoneurs',
    'Tyranides',
    'Crusher Stampede + Prédateurs Embusqués',
    'Perturbation',
    'Assassinat: 1 perso (4pts)',
    '',
    'Unités Attachées',
    'Unité 1 Attachée',
    '',
    'The Swarmlord (210 points)',
    '• Attachée en tant que : Meneur (Personnage)',
    'Tyrant Guard (80 points)',
    '• 3x Tyrant Guard',
  ].join('\n'));
  t('unlabelled: the line above the disposition is the detachment', audit(p).det, 'Crusher Stampede + Prédateurs Embusqués');
  t('unlabelled: the disposition', audit(p).disp, 'Perturbation');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
