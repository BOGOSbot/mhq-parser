#!/usr/bin/env node
'use strict';
/**
 * The unit card: a datasheet rendered mechanically from the CSV export.
 *
 * The faction half of the corpus already holds every datasheet field, but a
 * reader asking "donne moi le profil de fuegan" was being handed prose about
 * Fuegan written by a model. A statline is not a question a model should answer
 * at all: the numbers are in Datasheets_models, the weapons in Datasheets_wargear,
 * the abilities, keywords, composition, options and points in their own tables.
 * Every field on this card is copied from a CSV cell - no model writes any of
 * them - so the card cannot invent a Toughness or drop a weapon.
 *
 * Two rules shape the trigger:
 *
 *   - it is a CLOSED-SET decision, made before retrieval: a datasheet lookup or
 *     a rules question. The card is rendered only when the question both asks
 *     for the unit's own data (CARD_INTENT) and names a datasheet exactly
 *     (findDatasheet). Anything else keeps the prose path untouched;
 *   - it falls back SILENTLY. When the unit cannot be resolved to a datasheet id
 *     - no name match, a name several factions share, a datasheet with no
 *     statline - unitCard() returns null and the caller runs the search and the
 *     writer exactly as before. A half card is never shown.
 *
 * This module reads the CSV export, never the vector index, so asking for a card
 * cannot move or query a corpus vector.
 */

import fs from 'fs';
import path from 'path';
import { CSV_DIR, csvRows, htmlToText, trimAbilityTail } from './rules-corpus.mjs';

const clean = s => htmlToText(String(s == null ? '' : s)).replace(/\s+/g, ' ').trim();

// Words that ask for a unit's own data rather than for a rule: its profile, its
// statline, its weapons, its abilities, its keywords, its points. They are both
// languages because a French question reaches the card through the same door.
// An ability's card is capped rather than pasted whole: a Faction ability such
// as Battle Focus carries a table and six sub-rules, and a phone card is a
// summary with a link to the real page. The cut is marked on the card.
export const CARD_INTENT = /\b(profil|profils|profile|profiles|statline|stat line|stats?|caracteristiques?|caract[ée]ristiques?|fiche(?: technique)?|datasheet|datasheets|wargear|equipement|équipement|abilities|aptitude|aptitudes|keywords?|mots?[- ]cl[ée]s?|points?|co[uû]t|cost|weapons?|armes?|toughness|endurance|save|sauvegarde|invulnerable|wounds?|blessures?|leadership|mouvement|movement)\b/i;

export const ABILITY_CHARS = 600;

// Lower case, accents folded, punctuation to spaces: a question typed on a phone
// has no patience for exact spelling of apostrophes or hyphens.
function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function phraseIn(hay, phrase) {
  return (' ' + hay + ' ').indexOf(' ' + phrase + ' ') !== -1;
}

// An ability's text often opens by repeating its own name and the rule id it
// lives under ('LEADER 24.22 Mighty heroes...'): the card already prints the name
// above it, so the repetition is dropped and the text starts at the rule itself.
function stripAbilityHead(name, text) {
  let s = String(text || '').trim();
  const n = String(name || '').trim();
  if (n && s.toLowerCase().indexOf(n.toLowerCase() + ' ') === 0) s = s.slice(n.length).trim();
  return s.replace(/^\d{2}\.\d{2}\s+/, '').trim();
}

// 'This model is equipped with: X' repeated under a label that already says so
// is one line of chrome per datasheet; the equipment list is what the reader
// came for.
function stripLoadoutHead(s) {
  return String(s || '').replace(/^this (?:model|unit) is equipped with(?: one of the following)?:?\s*/i, '').trim();
}

// Cut at a word, and say so.
function cap(text, max) {
  const s = String(text || '');
  if (s.length <= max) return { text: s, truncated: false };
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return { text: (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, '') + '...', truncated: true };
}

let TABLES = null;

// Read once per process, like the corpus. The export is 20 files and the card
// asks for one datasheet, so the tables are indexed by id at load.
export function cardTables() {
  if (TABLES) return TABLES;
  const read = f => csvRows(fs.readFileSync(path.join(CSV_DIR, f), 'utf8'));
  const byDatasheet = rows => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.datasheet_id)) m.set(r.datasheet_id, []);
      m.get(r.datasheet_id).push(r);
    }
    return m;
  };
  const abilityById = new Map();
  for (const a of read('Abilities.csv')) if (!abilityById.has(a.id)) abilityById.set(a.id, a);
  const factionName = new Map();
  const factionLink = new Map();
  for (const f of read('Factions.csv')) { factionName.set(f.id, f.name); factionLink.set(f.id, f.link); }
  const datasheets = read('Datasheets.csv').map(d => ({
    id: d.id,
    name: clean(d.name),
    phrase: norm(d.name),
    words: norm(d.name).split(' ').filter(Boolean).length,
    faction_id: d.faction_id,
    faction: clean(factionName.get(d.faction_id) || d.faction_id),
    factionPhrase: norm(factionName.get(d.faction_id) || ''),
    source_id: d.source_id,
    role: clean(d.role),
    legend: clean(d.legend),
    loadout: clean(d.loadout),
    damaged_w: String(d.damaged_w || ''),
    damaged_description: d.damaged_description,
    link: d.link || '',
    row: d,
  }));
  const sources = new Map();
  for (const s of read('Source.csv')) sources.set(s.id, s);
  const updated = (read('Last_update.csv')[0] || {}).last_update || '';
  TABLES = {
    datasheets,
    byId: new Map(datasheets.map(d => [d.id, d])),
    models: byDatasheet(read('Datasheets_models.csv')),
    costs: byDatasheet(read('Datasheets_models_cost.csv')),
    wargear: byDatasheet(read('Datasheets_wargear.csv')),
    abilities: byDatasheet(read('Datasheets_abilities.csv')),
    keywords: byDatasheet(read('Datasheets_keywords.csv')),
    options: byDatasheet(read('Datasheets_options.csv')),
    composition: byDatasheet(read('Datasheets_unit_composition.csv')),
    abilityById, sources, factionName, factionLink, updated,
  };
  return TABLES;
}

// Tests only: the tables are a cache of files on disk.
export function resetCardTables() { TABLES = null; }

// One switch, off only when it is explicit: the card is on by default, and
// RULES_UNIT_CARD=0 puts the prose path back without a code change. A reviewer
// who does not want the card, or a deployment that cannot read the CSV export,
// needs exactly one knob.
export function unitCardEnabled(env) {
  const e = env || process.env;
  const v = e.RULES_UNIT_CARD === undefined ? '' : String(e.RULES_UNIT_CARD).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

// Does this question ask for a unit's own data? One half of the decision.
export function wantsUnitCard(question, asked, terms) {
  const hay = norm([question, asked, (terms || []).join(' ')].filter(Boolean).join(' '));
  return CARD_INTENT.test(hay);
}

// The datasheet the question names, or null. The name has to appear as a whole
// phrase: 'captain' reaching every Captain datasheet would be right, but 'rhino'
// reaching the five chaos datasheets that share the name is not - that is a
// different unit per faction and the card would be a confident guess.
export function findDatasheet(question, asked, terms) {
  const hay = norm([question, asked, (terms || []).join(' ')].filter(Boolean).join(' '));
  if (!hay) return null;
  const hits = [];
  for (const d of cardTables().datasheets) {
    if (d.phrase && phraseIn(hay, d.phrase)) hits.push(d);
  }
  if (!hits.length) return null;
  // The most specific name wins, so 'Intercessor Squad' beats 'Intercessor'
  // when the question says the longer one.
  hits.sort((a, b) => b.words - a.words || String(a.id).localeCompare(String(b.id)));
  const best = hits[0];
  const same = hits.filter(h => h.phrase === best.phrase && h !== best);
  if (!same.length) return best;
  // One name, several factions. Only a faction the question names can choose
  // between them; otherwise the question is ambiguous and belongs to the prose
  // path rather than to a guess.
  same.push(best);
  const named = same.filter(h => h.factionPhrase && phraseIn(hay, h.factionPhrase));
  return named.length === 1 ? named[0] : null;
}

// The card, field for field, from the export. Null when the datasheet has no
// statline to render: an id alone is not a card.
export function buildUnitCard(id) {
  const t = cardTables();
  const d = t.byId.get(String(id == null ? '' : id));
  if (!d) return null;
  const models = (t.models.get(d.id) || []).map(m => ({
    line: m.line, name: clean(m.name),
    M: m.M, T: m.T, Sv: m.Sv,
    inv: (m.inv_sv && m.inv_sv !== '-') ? m.inv_sv + '+' : '',
    W: m.W, Ld: m.Ld, OC: m.OC,
    base: clean(m.base_size),
  }));
  if (!models.length) return null;
  const weapons = (t.wargear.get(d.id) || []).map(w => ({
    name: clean(w.name), type: clean(w.type), range: clean(w.range),
    A: w.A, BS: w.BS_WS, S: w.S, AP: w.AP, D: w.D, notes: clean(w.description),
  }));
  const abilities = (t.abilities.get(d.id) || []).map(ab => {
    const ref = ab.ability_id ? t.abilityById.get(ab.ability_id) : null;
    const name = clean(ab.name) || clean(ref && ref.name);
    const raw = clean(ab.description) || clean(ref && ref.description);
    const body = cap(stripAbilityHead(name, trimAbilityTail(raw)), ABILITY_CHARS);
    return { type: clean(ab.type), name, description: body.text, truncated: body.truncated };
  }).filter(a => a.name || a.description);
  const kws = (t.keywords.get(d.id) || []).map(k => ({ keyword: clean(k.keyword), faction: String(k.is_faction_keyword) === 'true' })).filter(k => k.keyword);
  const points = (t.costs.get(d.id) || [])
    .map(c => ({ label: clean(c.description), cost: clean(c.cost) }))
    .filter(c => c.cost);
  const src = t.sources.get(d.source_id);
  return {
    id: d.id,
    name: d.name,
    faction: d.faction,
    role: d.role,
    url: d.link || t.factionLink.get(d.faction_id) || '',
    source: src ? clean(src.name) : '',
    edition: src ? String(src.edition || '') : '',
    version: src ? String(src.version || '') : '',
    updated: t.updated,
    legend: d.legend,
    loadout: stripLoadoutHead(d.loadout),
    models,
    ranged: weapons.filter(w => /ranged/i.test(w.type)),
    melee: weapons.filter(w => !/ranged/i.test(w.type)),
    abilities,
    keywords: {
      faction: kws.filter(k => k.faction).map(k => k.keyword),
      other: kws.filter(k => !k.faction).map(k => k.keyword),
    },
    composition: (t.composition.get(d.id) || []).map(c => clean(c.description)).filter(Boolean),
    options: (t.options.get(d.id) || []).map(o => clean(o.description)).filter(Boolean),
    points,
    damaged: d.damaged_description ? { w: d.damaged_w, description: clean(d.damaged_description) } : null,
  };
}

// The whole decision, for a caller that has the question and its translation:
// a card, or null and the prose path stays exactly as it was.
export function unitCard(question, opts) {
  const o = opts || {};
  if (!unitCardEnabled(o.env)) return null;
  if (!wantsUnitCard(question, o.asked, o.terms)) return null;
  const d = findDatasheet(question, o.asked, o.terms);
  return d ? buildUnitCard(d.id) : null;
}

export default { CARD_INTENT, ABILITY_CHARS, cardTables, resetCardTables, unitCardEnabled, wantsUnitCard, findDatasheet, buildUnitCard, unitCard };
