import { detectExporter, parseListText } from '../parse.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
const id = s => detectExporter(s).id;
const basis = s => detectExporter(s).basis;

// --- signatures --------------------------------------------------------------
// The last line is the strongest signal: every tool that signs its output puts
// the signature there.
t('app en signature', detectExporter('Char1: 1x X (10 pts): y\nExported with App Version: v1.51.1 (117), Data Version: v767'),
  { id: 'app', basis: 'trailer', signature: 'Exported with App Version: v1.51.1 (117), Data Version: v767', version: 'v1.51.1', language: 'en' });
t('app fr signature', id('Exporté avec la Version de l\'Appli : v2.0.1 (122), Version de Données : v875'), 'app');
t('app fr signature language', detectExporter('Exporté avec la Version de l\'Appli : v2.0.1 (122), Version de Données : v875').language, 'fr');
t('app end-of-roster', id('Char1: 1x X (10 pts): y\nEND OF ROSTER'), 'app');
t('app end-of-roster lower', id('Char1: 1x X (10 pts): y\nEnd of roster'), 'app');
t('newrecruit signature', detectExporter('X [10pts]\nCreated with newrecruit.eu v35.66').version, 'v35.66');
t('newrecruit signature id', id('X [10pts]\nCreated with newrecruit.eu v35.66'), 'newrecruit');
t('newrecruit "Exported with New Recruit"', id('Exported with New Recruit v36.31, Data Version: v18'), 'newrecruit');
t('warorgan signature', id('Chaos Rhino [75 points]\nCreated with WarOrgan (https://warorgan.com)'), 'warorgan');
t('battlebase signature', id('Captain (95 Points)\nExported with BattleBase, Data Version: v20251223'), 'battlebase');
t('ironbuilt signature', id('Tyrannofex  [190 pts]\nhttps://ironbuilt.app/?s=BFV7Ki8g'), 'ironbuilt');
t('armylistnetwork url', id('Total : 2000 points - 59 figurines - 15 unités\nurl : https://40k.armylistnetwork.com/liste-123-x.html'), 'armylistnetwork');
t('newrecruit app-list url', id('X [10pts]\nhttps://www.newrecruit.eu/app/list/ARFlQ'), 'newrecruit');

// A signature above later text still names the tool, but is marked weaker.
const buried = 'Char1: 1x X (10 pts): y\nExported with App Version: v1.51.1 (117), Data Version: v767\nNote de l\'orga : ok';
t('signature not last is still read', id(buried), 'app');
t('signature not last: basis', basis(buried), 'signature');

// --- structural fallbacks ----------------------------------------------------
// Most lists carry no signature, so the shape has to name the tool.
t('app header', detectExporter('+++++++++++++++++++++++++\n+ FACTION KEYWORD: Xenos - Necrons\n+ TOTAL ARMY POINTS: 1995pts\n+++++++++++++++++++++++++\nChar1: 1x Illuminor Szeras (165 pts): Eldritch lance').basis, 'header');
t('app header id', id('+++++++++++++++++++++++++\n+ FACTION KEYWORD: Xenos - Necrons\n+++++++++++++++++++++++++'), 'app');
t('app char lines', id('Char1: 1x Illuminor Szeras (165 pts): Eldritch lance'), 'app');
t('app categories', detectExporter('Flotte (1985 points)\nTyranids\nStrike Force (2000 points)\nCHARACTERS\nHive Tyrant (250 points)\n• 1x Heavy venom cannon').id, 'app');
t('app categories basis', basis('CHARACTERS\nHive Tyrant (250 points)\n• 1x Heavy venom cannon'), 'categories');
t('app freeform strike force', id('Banished cup (1995 points)\nAeldari\nStrike Force (2000 points)\n• 1x Shuriken pistol'), 'app');
t('newrecruit bracket', id('Véhicules 1 : Réanimateur Canoptek [105pts] 2x Griffes acérées'), 'newrecruit');
t('newrecruit bracket en', id('Riptide Battlesuit [200 pts]: Riptide fists, Ion accelerator'), 'newrecruit');
t('armylistnetwork structure', id('### Détachements :\n* Death Guard - Marteau de Mortarion\n--- Personnages ---\nBiologus Putréfacteur  : 80 pts'), 'armylistnetwork');
t('armylistnetwork total line', id('QG 1 : QG [8PP, 175pts]\nTotal : 1995 points - 42 figurines - 10 unités'), 'armylistnetwork');
t('warorgan structure', id('RK Gros [1980 points]\nChaos Knights\nBattle Size: Strike Force (2000 point limit)\nDetachment Choice: Pactbound Zealots'), 'warorgan');
t('legacy == detachment', id('== DETACHEMENT Bataillon : T\'au Empire (0 PC) [100PP, 1997pts] ==\nQG 1 : Commandant en Exo-armure Coldstar'), 'legacy');
t('legacy ++ patrol', id('++ Patrol Detachment 0CP (Imperium - Grey Knights) [54 PL, 3CP, 1,000pts] ++\nHQ1: Canoness'), 'legacy');
t('legacy pell', id('Starting Command Points: 6-1-1-1 = 3CP\nHQ1: Canoness, Blessed Blade(10)'), 'legacy');
t('ironbuilt structure', id('── EPIC HEROES ───────────────────────────\nThe Red Terror [WARLORD]  [130 pts]\nWeapons: Gaping maw\nTotal: 2000 pts'), 'ironbuilt');
t('unknown freeform', id('Kill team nemesis claw'), 'unknown');
t('unknown lunch order', id('Complet jambon / eau'), 'unknown');
t('empty text', id(''), 'unknown');
t('null text', detectExporter(null).id, 'unknown');

// Ordering: a signature wins over a structure that would say something else.
// newrecruit can re-export a list that keeps an app-shaped body.
t('signature beats shape', id('+ FACTION KEYWORD: Xenos - T\'au Empire\n+ TOTAL ARMY POINTS: 2000pts\nChar1: 1x Commander Farsight (70 pts): Warlord\nCreated with newrecruit.eu v35.80'), 'newrecruit');
// But a bracketed price on an app-headed list with no signature is an app list.
t('header beats bracket', id('+ FACTION KEYWORD: Xenos - T\'au Empire\nChar1: 1x Commander Farsight (70 pts)\nUnit 16 - 10 Purestrain Genestealers [150 pts]'), 'app');
t('legacy pell bracket', id('QG 1 : Commandant en Exo-armure Coldstar [8PP, 175pts]\nTR1: 5 Battle Sister Squad [55pts, 3PL]'), 'legacy');
// newrecruit prints "++ Total: [1,990pts] ++"; it must not read as legacy.
t('newrecruit ++ Total stays newrecruit', id('The Blue Scribes [65pts]\n++ Total: [1,990pts] ++'), 'newrecruit');

// --- the parser records it ---------------------------------------------------
// buildPlayers() sets exporter and exporterVersion on every parsed list.
const one = parseListText('+++++++++++++++++++++++++\n+ FACTION KEYWORD: Xenos - Necrons\n+ TOTAL ARMY POINTS: 1995pts\n+++++++++++++++++++++++++\nChar1: 1x Illuminor Szeras (165 pts): Eldritch lance\nChar2: 1x Imotekh the Stormlord (100 pts): Staff of the Destroyer\nExported with App Version: v1.51.1 (117), Data Version: v767\n', { name: 'x' }).output;
t('parsed list carries exporter', one.players[0].exporter, 'app');
t('parsed list carries version', one.players[0].exporterVersion, 'v1.51.1');
const nr = parseListText('++++++++++++++++++++++\n+ PLAYER NAME: Blork\n++++++++++++++++++++++\nPersonnages 1 : X [80pts]\nLigne 1 : Y [85pts]\nCreated with newrecruit.eu v35.66\n', { name: 'x' }).output;
t('parsed newrecruit exporter', nr.players[0].exporter, 'newrecruit');
t('parsed newrecruit version', nr.players[0].exporterVersion, 'v35.66');

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
