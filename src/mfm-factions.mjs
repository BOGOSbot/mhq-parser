import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

// The faction half of the corpus, read from Games Workshop's own Munitorum
// Field Manual export instead of the Wahapedia CSV.
//
// Why this exists: the CSV is a community mirror of the same data, and every
// inconsistency in it (a lore paragraph in the Legends flag, ally copies of
// another faction's datasheet, a points table that mixes header rows, unit
// prices and wargear option prices in one column) had to be patched by hand
// after the fact. The dump is the source the official app renders from: one
// relational export, stamped with data_version, in eight languages.
//
// What it emits is the SAME section shape rules-corpus.mjs has always emitted,
// so wiki-build.mjs, wiki-plan.mjs and the surface downstream of them do not
// change. The seam is here, not there.
//
//   { id, source, set, heading, ruleId, anchor, hasAnchor, url, text, chars,
//     hash, kind, idFrom }
//
// The website is https://mfm.warhammer-community.com/en; the data endpoint is
// the dump below, and its metadata.data_version is the corpus stamp.

export const MFM_DUMP_URL = 'https://pub-6443f136c6fc4c60a15cc7935463d637.r2.dev/dump.json';

// Faction keyword name (the dump's own vocabulary) to the corpus faction code
// the rest of the pipeline already uses. Chapters fold into Space Marines: the
// tree has one Space Marines node, and the chapter catalogues are detachments,
// not factions.
const FACTION_OF_KEYWORD = {
  'Adeptus Custodes': 'AC',
  'Anathema Psykana': 'AC',
  'Adeptus Mechanicus': 'AdM',
  'Aeldari': 'AE',
  'Asuryani': 'AE',
  'Harlequins': 'AE',
  'Ynnari': 'AE',
  'Astra Militarum': 'AM',
  'Agents of the Imperium': 'AoI',
  'Adepta Sororitas': 'AS',
  'Legiones Daemonica': 'CD',
  'Blood Legions': 'CD',
  'Plague Legions': 'CD',
  'Legions of Excess': 'CD',
  'Scintillating Legions': 'CD',
  'Heretic Astartes': 'CSM',
  'Death Guard': 'DG',
  'Drukhari': 'DRU',
  'Emperor\u2019s Children': 'EC',
  'Genestealer Cults': 'GC',
  'Grey Knights': 'GK',
  'Leagues of Votann': 'LoV',
  'Necrons': 'NEC',
  'Orks': 'ORK',
  'Imperial Knights': 'QI',
  'Chaos Knights': 'QT',
  'Adeptus Astartes': 'SM',
  'Black Templars': 'SM',
  'Blood Angels': 'SM',
  'Dark Angels': 'SM',
  'Deathwatch': 'SM',
  'Imperial Fists': 'SM',
  'Iron Hands': 'SM',
  'Raven Guard': 'SM',
  'Salamanders': 'SM',
  'Space Wolves': 'SM',
  'Ultramarines': 'SM',
  'White Scars': 'SM',
  'T\u2019au Empire': 'TAU',
  'Thousand Sons': 'TS',
  'Tyranids': 'TYR',
  'World Eaters': 'WE',
  'Adeptus Titanicus': 'TL',
  'Titanicus Traitoris': 'TL',
};

const ROLE_TYPE = ['Infantry', 'Mounted', 'Beast', 'Monster', 'Walker', 'Vehicle', 'Aircraft', 'Titanic', 'Fortification'];
const ROLE_CLASS = ['Epic Hero', 'Character', 'Battleline'];

const PHASE_NAME = {
  commandPhase: 'Command phase',
  movementPhase: 'Movement phase',
  shootingPhase: 'Shooting phase',
  chargePhase: 'Charge phase',
  fightPhase: 'Fight phase',
};

const TURN_NAME = {
  yourTurn: 'Your turn',
  opponentsTurn: 'Opponent\u2019s turn',
  eitherPlayer: 'Either player\u2019s turn',
};

const STRATAGEM_TYPE = {
  battleTactic: 'Battle Tactic',
  strategicPloy: 'Strategic Ploy',
  epicDeed: 'Epic Deed',
  wargear: 'Wargear',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, function (m, hex) { return String.fromCharCode(parseInt(hex, 16)); })
    .replace(/&#(\d+);/g, function (m, dec) { return String.fromCharCode(Number(dec)); });
}

// The dump stores GW prose as light HTML with markdown bold inside it. The
// corpus wants plain text: a list becomes dash lines, a break becomes a
// newline, and the emphasis markers carry no information a reader needs.
export function plainText(input) {
  let s = String(input == null ? '' : input);
  s = s.replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '');
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\*\*/g, '');
  s = s.replace(/\r\n?/g, '\n');
  // The dump carries the app's own bullet glyphs as control characters.
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '-');
  s = s.replace(/^-\s*/, '- ');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// The snapshot lives beside the rest of the corpus so a build is reproducible
// from the repo's own workspace, and MFM_DUMP overrides it for a fresh pull.
export function mfmDumpPath() {
  if (process.env.MFM_DUMP) return process.env.MFM_DUMP;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workspace', 'rules-corpus', 'mfm-dump.json');
}

// The stamp on a dump file, without building anything from it. '' when there is
// no file or it does not parse.
export function dumpVersionOf(dumpPath) {
  try { return String(((JSON.parse(fs.readFileSync(dumpPath || mfmDumpPath(), 'utf8')) || {}).metadata || {}).data_version || ''); }
  catch (e) { return ''; }
}

// Download the dump beside the current one and swap it in only when it parses
// and carries a version: a cut-off transfer or an error page must never replace
// a good snapshot. The previous file is kept as mfm-dump.prev.json, one step of
// rollback on top of the corpus snapshot. -> { path, version, previous, bytes }
export async function downloadMfmDump(options) {
  const opts = options || {};
  const dest = opts.dest || mfmDumpPath();
  const url = opts.url || process.env.MFM_DUMP_URL || MFM_DUMP_URL;
  const fetchBuffer = opts.fetchBuffer || (async u => {
    const r = await fetch(u, { signal: AbortSignal.timeout(opts.timeoutMs || 300000) });
    if (!r.ok) throw new Error('MFM dump: HTTP ' + r.status + ' from ' + u);
    return Buffer.from(await r.arrayBuffer());
  });
  const buf = await fetchBuffer(url);
  let version = '';
  try { version = String(((JSON.parse(buf.toString('utf8')) || {}).metadata || {}).data_version || ''); }
  catch (e) { throw new Error('MFM dump: the download is not JSON (' + buf.length + ' bytes) - the file on disk is untouched'); }
  if (!version) throw new Error('MFM dump: the download carries no metadata.data_version - the file on disk is untouched');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  fs.writeFileSync(part, buf);
  const previous = fs.existsSync(dest) ? dumpVersionOf(dest) : '';
  if (fs.existsSync(dest)) fs.renameSync(dest, dest.replace(/\.json$/, '') + '.prev.json');
  fs.renameSync(part, dest);
  return { path: dest, version, previous, bytes: buf.length };
}

function textHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function en(row) {
  return (row && row.localisations && row.localisations.en) || {};
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

function firstMappedCode(names, keywordNameById) {
  for (const id of names) {
    const name = keywordNameById.get(id);
    const code = name && FACTION_OF_KEYWORD[name];
    if (code) return code;
  }
  return '';
}

// The dump's faction vocabulary is wider than the tree's: it also carries the
// four daemon legions, the four Aeldari sub-factions, the twelve Space Marine
// chapters and the two Titanicus books. Everything unmapped is counted and
// reported rather than dropped silently.
export function loadMfmDump(dumpPath) {
  const raw = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
  if (!raw || !raw.data) throw new Error('MFM dump: no data table in ' + dumpPath);
  return { version: String((raw.metadata || {}).data_version || ''), tables: raw.data };
}

export function buildMfmFactions(options) {
  const opts = options || {};
  const dump = loadMfmDump(opts.dumpPath);
  const T = dump.tables;
  const now = opts.scrapedAt || new Date().toISOString();

  const tables = function (name) { return Array.isArray(T[name]) ? T[name] : []; };

  const keywordNameById = new Map(tables('keyword').map(function (k) { return [k.id, en(k).name || '']; }));
  const factionKeywordNameById = new Map(tables('faction_keyword').map(function (k) { return [k.id, en(k).name || '']; }));
  const publicationById = new Map(tables('publication').map(function (p) { return [p.id, p]; }));

  const miniaturesByDatasheet = groupBy(tables('miniature'), 'datasheetId');
  const keywordsByMiniature = groupBy(tables('miniature_keyword'), 'miniatureId');
  const compositionsByDatasheet = groupBy(tables('unit_composition'), 'datasheetId');
  const compositionMiniatures = groupBy(tables('unit_composition_miniature'), 'unitCompositionId');
  const factionKeywordsByDatasheet = groupBy(tables('datasheet_faction_keyword'), 'datasheetId');
  const damageByDatasheet = groupBy(tables('datasheet_damage'), 'datasheetId');
  const invulnerableByDatasheet = groupBy(tables('invulnerable_save'), 'datasheetId');
  const invulnerableByMiniature = groupBy(tables('invulnerable_save'), 'miniatureId');
  const abilityLinksByDatasheet = groupBy(tables('datasheet_datasheet_ability'), 'datasheetId');
  const abilityById = new Map(tables('datasheet_ability').map(function (a) { return [a.id, a]; }));
  const wargearItemById = new Map(tables('wargear_item').map(function (w) { return [w.id, w]; }));
  const wargearOptionById = new Map(tables('wargear_option').map(function (w) { return [w.id, w]; }));
  const profilesByWargear = groupBy(tables('wargear_item_profile'), 'wargearItemId');
  const wargearAbilitiesByProfile = groupBy(tables('wargear_item_profile_wargear_ability'), 'wargearItemProfileId');
  const wargearAbilityById = new Map(tables('wargear_ability').map(function (a) { return [a.id, a]; }));
  const loadoutsByDatasheet = groupBy(tables('base_miniature_loadout'), 'datasheetId');
  const loadoutOptionsByLoadout = groupBy(tables('base_miniature_loadout_wargear_option'), 'baseMiniatureLoadoutId');
  // Wargear OPTIONS: what a unit can take besides its default loadout. The card's
  // printed option text is wargear_rule; the items it names are reachable through
  // the option groups and the three choice tables (loadout, limited, all-model).
  const wargearRulesByDatasheet = groupBy(tables('wargear_rule'), 'datasheetId');
  const optionGroupsByDatasheet = groupBy(tables('wargear_option_group'), 'datasheetId');
  const optionsByGroup = groupBy(tables('wargear_option'), 'wargearOptionGroupId');
  const choiceItemsByDatasheet = new Map();
  (function indexChoiceItems() {
    const add = function (dsId, itemId) {
      if (!dsId || !itemId) return;
      if (!choiceItemsByDatasheet.has(dsId)) choiceItemsByDatasheet.set(dsId, []);
      choiceItemsByDatasheet.get(dsId).push(itemId);
    };
    const via = function (setTable, choiceTable, itemTable, setKey, choiceKey) {
      const sets = new Map(tables(setTable).map(function (r) { return [r.id, r]; }));
      const choices = new Map(tables(choiceTable).map(function (r) { return [r.id, r]; }));
      for (const r of tables(itemTable)) {
        const c = choices.get(r[choiceKey]);
        const set = c && sets.get(c[setKey]);
        if (set) add(set.datasheetId, r.wargearItemId);
      }
    };
    via('loadout_choice_set', 'loadout_choice', 'loadout_choice_wargear_item', 'loadoutChoiceSetId', 'loadoutChoiceId');
    via('limited_wargear_choice_set', 'limited_wargear_choice', 'limited_wargear_choice_wargear_item', 'limitedWargearChoiceSetId', 'limitedWargearChoiceId');
    via('all_model_wargear_choice_set', 'all_model_wargear_choice', 'all_model_wargear_choice_wargear_item', 'allModelWargearChoiceSetId', 'allModelWargearChoiceId');
  })();
  const phasesByStratagem = groupBy(tables('stratagem_phase'), 'stratagemId');
  const forceDispositionById = new Map(tables('force_disposition').map(function (f) { return [f.id, en(f).name || '']; }));
  const dispositionsByDetachment = groupBy(tables('detachment_force_disposition'), 'detachmentId');
  const factionKeywordsByDetachment = groupBy(tables('detachment_faction_keyword'), 'detachmentId');
  const rulesByDetachment = groupBy(tables('detachment_rule'), 'detachmentId');
  const componentsByDetachmentRule = groupBy(tables('rule_container_component'), 'detachmentRuleId');
  const componentsByArmyRule = groupBy(tables('rule_container_component'), 'armyRuleId');
  const armyRulesByFaction = groupBy(tables('army_rule_faction_keyword'), 'factionKeywordId');
  const armyRuleById = new Map(tables('army_rule').map(function (r) { return [r.id, r]; }));
  const stratagemsByDetachment = groupBy(tables('stratagem'), 'detachmentId');
  const enhancementsByDetachment = groupBy(tables('enhancement'), 'detachmentId');
  const detachmentById = new Map(tables('detachment').map(function (d) { return [d.id, d]; }));

  const sections = [];
  const stats = {
    version: dump.version, scrapedAt: now,
    datasheets: 0, unitrules: 0, stratagems: 0, detachments: 0, enhancements: 0, factionRules: 0,
    skipped: { legends: 0, unmappedDatasheet: 0, unmappedDetachment: 0, emptyText: 0 },
    factionCounts: {},
    wargear: { base: 0, optional: 0, options: 0 },
  };

  function push(id, source, heading, url, lines, kind, idFrom, set) {
    const text = lines.filter(Boolean).join('\n').trim();
    if (text.length < 20) { stats.skipped.emptyText += 1; return; }
    sections.push({
      id: id, source: source, set: set || 'factions', heading: heading, ruleId: '', anchor: '',
      hasAnchor: false, url: url || '', text: text, chars: text.length, hash: textHash(text),
      kind: kind, idFrom: idFrom || 'mfm-dump',
    });
  }

  function roleOf(miniatureRows) {
    const names = [];
    for (const m of miniatureRows) {
      for (const link of keywordsByMiniature.get(m.id) || []) {
        const name = keywordNameById.get(link.keywordId);
        if (name && names.indexOf(name) === -1) names.push(name);
      }
    }
    const type = ROLE_TYPE.find(function (r) { return names.indexOf(r) !== -1; }) || '';
    const cls = ROLE_CLASS.find(function (r) { return names.indexOf(r) !== -1; }) || '';
    return [type, cls].filter(Boolean).join(' ');
  }

  function statline(miniature, baseSize, datasheetId) {
    const dsInv = (invulnerableByDatasheet.get(datasheetId) || []).find(function (r) { return !r.miniatureId; });
    const miInv = (invulnerableByMiniature.get(miniature.id) || [])[0];
    const invRow = miInv || dsInv;
    const inv = invRow ? String(invRow.save).replace(/\+?$/, '') + '+' : '';
    return 'Model ' + (en(miniature).name || 'model') + ': M ' + miniature.movement + ' T ' + miniature.toughness +
      ' Sv ' + miniature.save + (inv ? ' inv ' + inv : '') + ' W ' + miniature.wounds +
      ' Ld ' + miniature.leadership + ' OC ' + miniature.objectiveControl + (baseSize ? ' base ' + baseSize : '');
  }

  // The weapons a datasheet can field, default loadout first and then every
  // item its options can add, in the order the dump lists them. One line per
  // distinct profile, the same 'Wargear <name> (<Melee|Ranged>): ...' line the
  // CSV corpus wrote for every weapon including the optional ones.
  function wargearItemIds(datasheetId) {
    const ids = [];
    const seen = new Set();
    const add = function (id) { if (id && !seen.has(id) && wargearItemById.has(id)) { seen.add(id); ids.push(id); } };
    for (const loadout of loadoutsByDatasheet.get(datasheetId) || []) {
      for (const opt of loadoutOptionsByLoadout.get(loadout.id) || []) {
        const option = wargearOptionById.get(opt.wargearOptionId);
        if (option) add(option.wargearItemId);
      }
    }
    stats.wargear.base += ids.length;
    const groups = (optionGroupsByDatasheet.get(datasheetId) || []).slice()
      .sort(function (a, b) { return Number(a.displayOrder || 0) - Number(b.displayOrder || 0); });
    const before = ids.length;
    for (const g of groups) {
      for (const o of (optionsByGroup.get(g.id) || []).slice().sort(function (a, b) { return Number(a.displayOrder || 0) - Number(b.displayOrder || 0); })) add(o.wargearItemId);
    }
    for (const id of choiceItemsByDatasheet.get(datasheetId) || []) add(id);
    stats.wargear.optional += ids.length - before;
    return ids;
  }

  function wargearLines(datasheetId) {
    const lines = [];
    const seen = new Set();
    for (const itemId of wargearItemIds(datasheetId)) {
      const item = wargearItemById.get(itemId);
      const name = en(item).name || '';
      const ruleText = plainText(en(item).ruleText);
      const profiles = (profilesByWargear.get(item.id) || []).slice()
        .sort(function (a, b) { return Number(a.displayOrder || 0) - Number(b.displayOrder || 0); });
      for (const profile of profiles) {
        // A multi-profile weapon names each profile ('Plasma Pistol - supercharge');
        // a single-profile one repeats the item's name, which says nothing new.
        const pname = String(en(profile).name || '').trim();
        const profileName = !pname || pname.toLowerCase() === name.toLowerCase() ? name
          : (pname.toLowerCase().indexOf(name.toLowerCase()) === 0 ? pname : name + ' - ' + pname);
        const key = profileName + '|' + profile.type + '|' + profile.range + '|' + profile.attacks + '|' + profile.strength + '|' + profile.armourPenetration + '|' + profile.damage;
        if (seen.has(key)) continue;
        seen.add(key);
        const weaponAbilities = (wargearAbilitiesByProfile.get(profile.id) || [])
          .map(function (link) { return en(wargearAbilityById.get(link.wargearAbilityId) || {}).name || ''; })
          .filter(Boolean);
        const abilityText = weaponAbilities.length ? ' - ' + weaponAbilities.join(', ') : '';
        const body = profile.type === 'melee'
          ? 'A ' + profile.attacks + ' WS ' + (profile.weaponSkill || '-') + ' S ' + profile.strength + ' AP ' + profile.armourPenetration + ' D ' + profile.damage
          : 'Range ' + profile.range + ' A ' + profile.attacks + ' BS ' + (profile.ballisticSkill || '-') + ' S ' + profile.strength + ' AP ' + profile.armourPenetration + ' D ' + profile.damage;
        lines.push('Wargear ' + profileName + ' (' + (profile.type === 'melee' ? 'Melee' : 'Ranged') + '): ' + body + abilityText + (ruleText ? ' - ' + ruleText : ''));
      }
      if (!profiles.length && !seen.has(name + '|none')) {
        seen.add(name + '|none');
        lines.push('Wargear ' + name + (ruleText ? ' - ' + ruleText : ''));
      }
    }
    return lines;
  }

  // The card's printed wargear options, one 'Option:' line each, as the CSV
  // corpus wrote them. wargear_rule is the printed text; a datasheet with option
  // groups and no printed rule (7 in data version 995) falls back to the groups'
  // own instruction text. 'Default Wargear' groups are the loadout, not options.
  function optionLines(datasheetId) {
    const flat = function (t) { return plainText(t).replace(/^[\s■▪▫•-]+/, '').replace(/\s*\n\s*[■▪▫•]?\s*/g, ' ').replace(/\s+/g, ' ').trim(); };
    const printed = (wargearRulesByDatasheet.get(datasheetId) || []).slice()
      .sort(function (a, b) { return Number(a.displayOrder || 0) - Number(b.displayOrder || 0); })
      .map(function (r) { return flat(en(r).rulesText); }).filter(Boolean);
    const texts = printed.length ? printed : (optionGroupsByDatasheet.get(datasheetId) || []).slice()
      .sort(function (a, b) { return Number(a.displayOrder || 0) - Number(b.displayOrder || 0); })
      .map(function (g) { return flat(en(g).instructionText); })
      .filter(function (t) { return t && !/^def\w*\s+warg\w*$/i.test(t); });
    const out = [];
    for (const t of texts) if (out.indexOf(t) === -1) out.push(t);
    stats.wargear.options += out.length;
    return out.map(function (t) { return 'Option: ' + t; });
  }

  function pointsLines(datasheetId) {
    const rows = (compositionsByDatasheet.get(datasheetId) || []).filter(function (c) { return c.points != null; });
    if (!rows.length) return [];
    return rows.map(function (c) {
      const minis = compositionMiniatures.get(c.id) || [];
      const sizes = minis.map(function (m) {
        return m.max && m.max !== m.min ? m.min + '-' + m.max : String(m.min);
      }).filter(Boolean);
      const models = sizes.length ? sizes.join('+') + (sizes[0] === '1' ? ' model' : ' models') : 'unit';
      return 'Points: ' + models + ' ' + c.points + ' pts';
    });
  }

  function ruleComponents(map, id) {
    return (map.get(id) || [])
      .slice()
      .sort(function (a, b) { return Number(a.displayOrder || 0) - Number(b.displayOrder || 0); })
      .map(function (c) {
        const loc = en(c);
        const title = String(loc.title || '');
        const body = plainText(loc.textContent);
        if (!body) return '';
        if (/^lore$/i.test(title)) return '';
        return title ? title + ': ' + body : body;
      })
      .filter(Boolean);
  }

  // --- datasheets -----------------------------------------------------------
  for (const ds of tables('datasheet')) {
    const loc = en(ds);
    const name = String(loc.name || '').trim();
    if (!name) continue;
    if (ds.isLegends) { stats.skipped.legends += 1; continue; }
    const kwIds = (factionKeywordsByDatasheet.get(ds.id) || []).map(function (r) { return r.factionKeywordId; });
    const code = firstMappedCode(kwIds, factionKeywordNameById);
    if (!code) { stats.skipped.unmappedDatasheet += 1; continue; }
    stats.factionCounts[code] = (stats.factionCounts[code] || 0) + 1;

    const miniatures = miniaturesByDatasheet.get(ds.id) || [];
    const factionName = factionKeywordNameById.get(kwIds.find(function (id) { return FACTION_OF_KEYWORD[factionKeywordNameById.get(id)] === code; })) || code;
    const role = roleOf(miniatures);
    const header = name + ' - ' + factionName + (role ? ' (' + role + ')' : '');
    const source = 'faction-' + code.toLowerCase();

    const statsLines = [header];
    const pub = publicationById.get(ds.publicationId);
    if (pub) statsLines.push('Source: ' + (en(pub).name || '') + ' (edition 11)');
    for (const m of miniatures) statsLines.push(statline(m, loc.baseSize, ds.id));
    const composition = plainText(loc.unitComposition).split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
    composition.forEach(function (line, index) {
      if (!index) statsLines.push('Composition: ' + line.replace(/^- /, ''));
      else statsLines.push(line);
    });
    for (const line of wargearLines(ds.id)) statsLines.push(line);
    for (const line of optionLines(ds.id)) statsLines.push(line);
    for (const line of pointsLines(ds.id)) statsLines.push(line);
    for (const dmg of damageByDatasheet.get(ds.id) || []) {
      const dl = en(dmg);
      if (dl.rules) statsLines.push('Damaged: ' + (dl.name ? dl.name + ' - ' : '') + plainText(dl.rules));
    }
    push('datasheet#' + ds.id, source, name, '', statsLines, 'datasheet', 'mfm-datasheet-id');
    stats.datasheets += 1;

    const ruleLines = [header + ' - keywords and abilities'];
    const keywordNames = [];
    for (const m of miniatures) {
      for (const link of keywordsByMiniature.get(m.id) || []) {
        const k = keywordNameById.get(link.keywordId);
        if (k && keywordNames.indexOf(k) === -1) keywordNames.push(k);
      }
    }
    for (const id of kwIds) {
      const k = factionKeywordNameById.get(id);
      if (k && keywordNames.indexOf(k) === -1) keywordNames.push(k);
    }
    if (keywordNames.length) ruleLines.push('Keywords: ' + keywordNames.join(', '));
    for (const link of abilityLinksByDatasheet.get(ds.id) || []) {
      const ability = abilityById.get(link.datasheetAbilityId || link.id);
      if (!ability) continue;
      const al = en(ability);
      const restriction = plainText((en(link) || {}).restriction);
      const body = plainText(al.rules);
      if (!al.name && !body) continue;
      if (!body || body === '-') continue;
      const type = ability.abilityType
        ? String(ability.abilityType).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); })
        : '';
      ruleLines.push('Ability' + (type ? ' (' + type + ')' : '') + ': ' + (al.name || '') + (al.name ? ' - ' : '') + body + (restriction ? ' Restriction: ' + restriction : ''));
    }
    if (ruleLines.length > 1) {
      push('unitrules#' + ds.id, source, name + ' - keywords and abilities', '', ruleLines, 'unitrules', 'mfm-datasheet-id');
      stats.unitrules += 1;
    }
  }

  // --- detachments, their rules, and their stratagems and enhancements -------
  function codeOfDetachment(detachmentId) {
    const kwIds = (factionKeywordsByDetachment.get(detachmentId) || []).map(function (r) { return r.factionKeywordId; });
    return firstMappedCode(kwIds, factionKeywordNameById);
  }

  for (const det of tables('detachment')) {
    const dl = en(det);
    const name = String(dl.name || '').trim();
    if (!name) continue;
    const code = codeOfDetachment(det.id);
    if (!code) { stats.skipped.unmappedDetachment += 1; continue; }
    const factionName = factionKeywordNameById.get((factionKeywordsByDetachment.get(det.id) || [])
      .map(function (r) { return r.factionKeywordId; })
      .find(function (id) { return FACTION_OF_KEYWORD[factionKeywordNameById.get(id)] === code; })) || code;
    const source = 'faction-' + code.toLowerCase();
    const dispositions = (dispositionsByDetachment.get(det.id) || [])
      .map(function (r) { return forceDispositionById.get(r.forceDispositionId) || ''; })
      .filter(Boolean);
    const lines = [name + ' - ' + factionName + ' detachment'];
    lines.push('Detachment points: ' + (det.detachmentPointsCost == null ? '-' : det.detachmentPointsCost) +
      (dispositions.length ? '; force disposition: ' + dispositions.join(', ') : ''));
    for (const rule of rulesByDetachment.get(det.id) || []) {
      const rl = en(rule);
      const body = ruleComponents(componentsByDetachmentRule, rule.id);
      if (!body.length) continue;
      lines.push('Ability: ' + (rl.name || 'Detachment rule') + ' - ' + body.join('\n'));
    }
    push('detachment#' + det.id, source, name + ' (' + factionName + ')', '', lines, 'detachment', 'mfm-detachment-id');
    stats.detachments += 1;

    for (const strat of stratagemsByDetachment.get(det.id) || []) {
      const sl = en(strat);
      if (!String(sl.name || '').trim()) continue;
      const phases = (phasesByStratagem.get(strat.id) || [])
        .map(function (p) { return PHASE_NAME[p.phase] || p.phase; })
        .filter(Boolean);
      const typeWord = STRATAGEM_TYPE[strat.category] || '';
      const stratLines = [String(sl.name).toUpperCase() + ' - ' + factionName + ' stratagem'];
      stratLines.push('Type: ' + (typeWord ? typeWord + ' Stratagem' : 'Stratagem') + (detachmentById.has(det.id) ? ' (' + name + ')' : ''));
      stratLines.push('CP: ' + (strat.cpCost == null ? '-' : strat.cpCost));
      stratLines.push('Turn: ' + (TURN_NAME[strat.key] || '') + (phases.length ? '; phase: ' + phases.join(', ') : ''));
      stratLines.push('Detachment: ' + name);
      for (const field of ['whenRules', 'targetRules', 'effectRules', 'restrictionRules']) {
        const value = plainText(sl[field]);
        if (!value || value === '-') continue;
        const label = { whenRules: 'WHEN', targetRules: 'TARGET', effectRules: 'EFFECT', restrictionRules: 'RESTRICTIONS' }[field];
        stratLines.push(label + ': ' + value);
      }
      const secondary = plainText(sl.secondaryEffect);
      if (secondary) stratLines.push('SECONDARY EFFECT: ' + secondary);
      push('stratagem#' + strat.id, source, String(sl.name).toUpperCase() + ' (' + factionName + ')', '', stratLines, 'stratagem', 'mfm-stratagem-id');
      stats.stratagems += 1;
    }

    for (const enh of enhancementsByDetachment.get(det.id) || []) {
      const el = en(enh);
      if (!String(el.name || '').trim()) continue;
      const enhLines = [String(el.name) + ' (Enhancement - ' + factionName + ', ' + name + ')'];
      enhLines.push('Cost: ' + (enh.basePointsCost == null ? '-' : enh.basePointsCost) + ' pts');
      enhLines.push('Detachment: ' + name);
      const body = plainText(el.rules);
      if (body) enhLines.push(body);
      push('enhancement#' + enh.id, source, String(el.name) + ' (Enhancement - ' + factionName + ', ' + name + ')', '', enhLines, 'enhancement', 'mfm-enhancement-id');
      stats.enhancements += 1;
    }
  }

  for (const strat of tables('stratagem').filter(function (s) { return !s.detachmentId; })) {
    const sl = en(strat);
    const name = String(sl.name || '').trim();
    if (!name) continue;
    const phases = (phasesByStratagem.get(strat.id) || [])
      .map(function (p) { return PHASE_NAME[p.phase] || p.phase; })
      .filter(Boolean);
    const typeWord = STRATAGEM_TYPE[strat.category] || '';
    const lines = [name.toUpperCase() + ' - core stratagem'];
    lines.push('Type: ' + (typeWord ? typeWord + ' Stratagem' : 'Stratagem'));
    lines.push('CP: ' + (strat.cpCost == null ? '-' : strat.cpCost));
    lines.push('Turn: ' + (TURN_NAME[strat.key] || '') + (phases.length ? '; phase: ' + phases.join(', ') : ''));
    for (const field of ['whenRules', 'targetRules', 'effectRules', 'restrictionRules']) {
      const value = plainText(sl[field]);
      if (!value || value === '-') continue;
      const label = { whenRules: 'WHEN', targetRules: 'TARGET', effectRules: 'EFFECT', restrictionRules: 'RESTRICTIONS' }[field];
      lines.push(label + ': ' + value);
    }
    push('core-stratagem#' + strat.id, 'core-stratagems', name.toUpperCase(), 'https://mfm.warhammer-community.com/en', lines, 'stratagem', 'mfm-stratagem-id', 'rules');
    stats.coreStratagems = (stats.coreStratagems || 0) + 1;
  }

  // --- army rules ----------------------------------------------------------
  const seenArmyRule = new Set();
  for (const link of tables('army_rule_faction_keyword')) {
    const code = FACTION_OF_KEYWORD[factionKeywordNameById.get(link.factionKeywordId)];
    if (!code) continue;
    const rule = armyRuleById.get(link.armyRuleId);
    if (!rule) continue;
    const key = code + '|' + rule.id;
    if (seenArmyRule.has(key)) continue;
    seenArmyRule.add(key);
    const rl = en(rule);
    const name = String(rl.name || '').trim();
    if (!name) continue;
    const body = ruleComponents(componentsByArmyRule, rule.id);
    if (!body.length) continue;
    const factionName = factionKeywordNameById.get(link.factionKeywordId) || code;
    push('faction-rule#' + rule.id + '-' + code.toLowerCase(), 'faction-' + code.toLowerCase(), name + ' - ' + factionName + ' army rule', '', [name + ' - ' + factionName + ' army rule'].concat(body), 'faction-rule', 'mfm-army-rule-id');
    stats.factionRules += 1;
  }

  const corpus = {
    source: 'factions-mfm',
    set: 'factions',
    url: 'https://mfm.warhammer-community.com/en',
    edition: 'wh40k11ed',
    marker: { kind: 'MFM dump', edition: '11', version: dump.version, lastUpdate: '' },
    scrapedAt: now,
    count: sections.length,
    anchored: 0,
    sections: sections,
  };
  return { corpus: corpus, stats: stats };
}

export function writeMfmFactionsCorpus(opts) {
  const out = buildMfmFactions(opts);
  if (opts.outPath) {
    fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
    fs.writeFileSync(opts.outPath, JSON.stringify(out.corpus));
  }
  return out;
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const dumpPath = args[0] || process.env.MFM_DUMP || '';
  const outPath = args[1] || '';
  if (!dumpPath) {
    console.error('usage: node src/mfm-factions.mjs <dump.json> [out.json]');
    process.exit(2);
  }
  const out = writeMfmFactionsCorpus({ dumpPath: dumpPath, outPath: outPath });
  console.log(JSON.stringify(out.stats, null, 1));
  console.log('sections ' + out.corpus.count + '  data_version ' + out.stats.version);
}
