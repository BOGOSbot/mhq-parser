import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { mfmDumpPath } from './mfm-factions.mjs';

// The mission decks, read from Games Workshop's Munitorum Field Manual export.
//
// The event-companion page writes each card as a div, not a heading, so the scrape
// carried a deck as one huge body and the chunker cut it by length: twelve different
// secondary missions came out titled with one errata label, and card section labels
// ('SECOND BATTLE ROUND ONWARDS') surfaced as if they were card names. The dump has
// the decks as records with their objectives, their scoring criteria, their victory
// points and the disposition matrix, so the page is no longer needed for them.
//
// The records keep the page's own shape - source 'event-companion', heading
// '<Deck> > <NAME>' - because the tree places the Missions branch from that source
// and the id convention is what the readers and citations already use.

const DECK_PRIMARY = 'Primary Mission deck';
const DECK_SECONDARY = 'Secondary Mission deck';
const DECK_DISPOSITION = 'Force Dispositions';

const PERIOD = {
  firstBattleRound: 'first battle round',
  secondBattleRound: 'second battle round',
  thirdBattleRound: 'third battle round',
  fourthBattleRound: 'fourth battle round',
  fifthBattleRound: 'fifth battle round',
  anyBattleRound: 'any battle round',
  endOfBattle: 'end of the battle',
};

function en(row) {
  return (row && row.localisations && row.localisations.en) || {};
}

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(Number(d)); });
}

// The dump keeps its prose in light HTML with markdown bold inside it.
function plainText(input) {
  let s = String(input == null ? '' : input);
  s = s.replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '');
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\*\*/g, '');
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function textHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function slugOf(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'card';
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows || []) {
    const k = row[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

export function buildMissionSections(options) {
  const opts = options || {};
  const raw = JSON.parse(fs.readFileSync(opts.dumpPath || mfmDumpPath(), 'utf8'));
  const T = (raw && raw.data) || {};
  const sections = [];
  const stats = { version: String((raw.metadata || {}).data_version || ''), primary: 0, secondary: 0, dispositions: 0, pack: '' };
  // Two mission packs ride in the dump: the Chapter Approved matched-play deck and
  // Combat Patrol, which is a different game with its own 26 primary missions. The
  // corpus answers at a tournament table, so only the pack that carries secondary
  // missions is read - that is the matched-play deck by construction.
  const packs = (T.mission_pack || []).filter(function (p) { return String(en(p).name || '').indexOf('Chapter Approved') === 0; });
  const packId = packs.length ? packs[0].id : '';
  stats.pack = packs.length ? en(packs[0]).name || '' : '';
  const inPack = function (row) { return !packId || row.missionPackId === packId; };

  const push = function (deck, name, lines) {
    const text = lines.filter(Boolean).join('\n').trim();
    if (text.length < 20) return;
    const heading = deck + ' > ' + name;
    sections.push({
      id: 'event-companion#' + deck.split(' ')[0] + '-Mission-deck->-' + slugOf(name),
      source: 'event-companion', set: 'rules', kind: 'rule',
      heading: heading, ruleId: '', anchor: '', hasAnchor: false, url: '',
      text: text, chars: text.length, hash: textHash(text),
      parent: '', children: [], links: [], edition: '11',
    });
  };

  // --- primary missions ------------------------------------------------------
  const primaryObjectives = groupBy(T.primary_mission_objective || [], 'primaryMissionId');
  const primaryScoring = groupBy(T.primary_mission_objective_scoring || [], 'primaryMissionObjectiveId');
  const primaryPeriods = groupBy(T.primary_mission_objective_scorable_period || [], 'primaryMissionObjectiveId');
  for (const mission of (T.primary_mission || []).filter(inPack)) {
    const loc = en(mission);
    const name = String(loc.name || '').trim();
    if (!name) continue;
    const lines = [name + ' - Primary Mission'];
    const lore = plainText(loc.lore);
    if (lore) lines.push(lore);
    const description = plainText(loc.description);
    if (description) lines.push(description);
    for (const objective of (primaryObjectives.get(mission.id) || []).slice().sort(function (a, b) { return Number(a.displayOrder || 0) - Number(b.displayOrder || 0); })) {
      const ol = en(objective);
      lines.push('');
      lines.push(String(ol.name || 'Objective') + (ol.whenText ? ' - ' + plainText(ol.whenText) : ''));
      const periods = (primaryPeriods.get(objective.id) || []).map(function (p) { return PERIOD[p.scorablePeriod] || p.scorablePeriod; });
      if (periods.length) lines.push('Scored in: ' + periods.join(', '));
      for (const score of (primaryScoring.get(objective.id) || []).slice().sort(function (a, b) { return Number(a.displayOrder || 0) - Number(b.displayOrder || 0); })) {
        const sl = en(score);
        const vp = score.victoryPoints == null ? '' : score.victoryPoints + ' VP';
        const cap = score.victoryPointsCap == null ? '' : ' (max ' + score.victoryPointsCap + ' per game)';
        const flags = [score.isCumulative ? 'cumulative' : '', score.isMutuallyExclusive ? 'mutually exclusive' : ''].filter(Boolean).join(', ');
        lines.push('- ' + vp + cap + (flags ? ' [' + flags + ']' : '') + ': ' + plainText(sl.scoringCriteria));
      }
    }
    push(DECK_PRIMARY, name, lines);
    stats.primary += 1;
  }

  // --- secondary missions ----------------------------------------------------
  const secondaryObjectives = groupBy(T.secondary_mission_objective || [], 'secondaryMissionId');
  const secondaryScoring = groupBy(T.secondary_mission_objective_scoring || [], 'secondaryMissionObjectiveId');
  for (const mission of (T.secondary_mission || []).filter(inPack)) {
    const loc = en(mission);
    const name = String(loc.name || '').trim();
    if (!name) continue;
    const lines = [name + ' - Secondary Mission'];
    const lore = plainText(loc.lore);
    if (lore) lines.push(lore);
    const description = plainText(loc.description);
    if (description) lines.push(description);
    for (const objective of (secondaryObjectives.get(mission.id) || []).slice().sort(function (a, b) { return Number(a.displayOrder || 0) - Number(b.displayOrder || 0); })) {
      const ol = en(objective);
      lines.push('');
      lines.push(String(ol.name || 'Objective') + (ol.whenText ? ' - ' + plainText(ol.whenText) : ''));
      for (const score of (secondaryScoring.get(objective.id) || []).slice().sort(function (a, b) { return Number(a.displayOrder || 0) - Number(b.displayOrder || 0); })) {
        const sl = en(score);
        const vp = score.victoryPoints == null ? '' : score.victoryPoints + ' VP';
        const cap = score.victoryPointsCap == null ? '' : ' (max ' + score.victoryPointsCap + ')';
        lines.push('- ' + vp + cap + ': ' + plainText(sl.scoringCriteria));
      }
    }
    push(DECK_SECONDARY, name, lines);
    stats.secondary += 1;
  }

  // The force-disposition matrix is deliberately NOT written into the corpus. A card
  // that named dispositions would make the pairing corpus-verifiable, and the matrix is
  // reference material (mission-matrix.mjs renders it from the dump); the page's own
  // disposition cards stay as the corpus text.

  return { sections: sections, stats: stats };
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const out = buildMissionSections({ dumpPath: process.argv[2] });
  console.log(JSON.stringify(out.stats, null, 1));
  console.log('sections ' + out.sections.length);
}
