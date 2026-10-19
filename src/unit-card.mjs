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
import { csvDir, csvRows, htmlToText, trimAbilityTail } from './rules-corpus.mjs';
import { mergeChunkParts } from './wiki-plan.mjs';

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

// --- the abilities that are rules, not datasheet data ------------------------
// A Core or Faction ability is a rule defined elsewhere in the corpus - LEADER,
// Battle Focus - and the card links to that record instead of reprinting it. A
// Datasheet ability belongs to the unit and keeps its text. When the record
// cannot be found the text is kept: a dead link is worse than a long card.
const ABILITY_HALF = { Core: 'rules', Faction: 'factions' };

// The rule id the ability's own card cites, read off the export's HTML: LEADER
// carries 24.22 in an <span class="h_number">. It is what tells the Leader rule
// apart from a section that merely starts with the same word.
export function abilityRuleIds(raw) {
  const out = [];
  const re = /h_number[^>]*>\s*([0-9]{1,2}(?:\.[0-9]{1,2})*)/g;
  let m;
  while ((m = re.exec(String(raw || ''))) !== null) out.push(m[1]);
  return Array.from(new Set(out));
}

// The record an ability names, in its own half, or null. Matching is mechanical:
// the heading must start with the ability's name (word-start, so LEADER does not
// reach Leadership Rolls), and a heading that also carries the rule id the
// ability cites wins over one that does not.
export function findAbilityRecord(ability, rules, factions) {
  const half = ABILITY_HALF[ability && ability.type];
  if (!half) return null;
  const sections = (half === 'rules' ? rules : factions) || [];
  if (!sections.length || !ability.name) return null;
  const name = norm(ability.name);
  const words = name.split(' ').filter(Boolean);
  const ids = (ability.ruleIds || []).map(norm).filter(Boolean);
  let best = null;
  for (const sec of sections) {
    // The corpus writes a child's ancestry in front of its own title
    // ('Forming Attached Units > LEADER 24.22 / SUPPORT'), so the ability's name
    // is matched against the last segment as well as the whole heading.
    const raw = String(sec.heading || '');
    const path = raw.split(' > ').filter(Boolean);
    const leaf = norm(path[path.length - 1] || '');
    const whole = norm(raw);
    const starts = leaf === name || leaf.indexOf(name + ' ') === 0 || whole === name || whole.indexOf(name + ' ') === 0;
    if (!starts) continue;
    const hay = whole + ' ' + norm(sec.anchor || '') + ' ' + norm(sec.ruleId || '');
    const own = leaf || whole;
    const withId = ids.length ? ids.some(id => hay.indexOf(id) !== -1) : false;
    // The ability's own record carries the cited id in its title
    // ('LEADER 24.22 / SUPPORT'); an FAQ that merely ends with the ability's
    // name does not. That is a stronger signal than a short leaf, and without it
    // the FAQ wins and the reader lands on someone else's question.
    const idInTitle = ids.length ? ids.some(id => own.indexOf(id) !== -1) : false;
    const extra = own.split(' ').length - words.length;
    const score = [withId ? 0 : 1, idInTitle ? 0 : 1, extra];
    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])
      || (score[0] === best.score[0] && score[1] === best.score[1] && score[2] < best.score[2])) best = { sec, score };
  }
  return best ? best.sec : null;
}

function hrefFor(section) {
  const url = String((section && section.url) || '').split('#')[0];
  return section && section.anchor ? url + '#' + section.anchor : url;
}

let TABLES = null;

// task-10: the full render calls buildUnitCard once per record, and a datasheet's
// twin and its ~n parts all open the same card, so the same id was built over and
// over (3,052 datasheets over 6,705 records). The card is a pure function of the
// CSV tables and the corpora it resolves ability links against, so it is cached
// under those two identities: resetCardTables() starts a new generation, and a
// caller with its own corpora object gets its own map. A FRESH corpora object per
// call is a miss by design - the cache never guesses that two objects hold the
// same records.
let CARD_BUILDS = 0;
let CARD_CACHES = new WeakMap(); // corpora object -> Map(card id, card)
let NO_CORPORA_CARDS = new Map();
function cardCacheFor(corpora) {
  if (!corpora) return NO_CORPORA_CARDS;
  let m = CARD_CACHES.get(corpora);
  if (!m) { m = new Map(); CARD_CACHES.set(corpora, m); }
  return m;
}
// The number of cards actually built in this process: the measurement the memo's
// own test reads (and the full-render bench reports).
export function cardBuildCount() { return CARD_BUILDS; }

// Read once per process, like the corpus. The export is 20 files and the card
// asks for one datasheet, so the tables are indexed by id at load.
export function cardTables() {
  if (TABLES) return TABLES;
  const read = f => csvRows(fs.readFileSync(path.join(csvDir(), f), 'utf8'));
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
export function resetCardTables() {
  TABLES = null;
  CARD_CACHES = new WeakMap();
  NO_CORPORA_CARDS = new Map();
}

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
//
// The question and its translation ONLY, never the translator's search terms.
// Those terms are a retrieval artefact: for 'est-ce que fuegan peut arriver de
// reserves a portee de melta ?' the translator offered 'Melta weapons' among
// them, CARD_INTENT matched "weapons", and the page answered a rules question
// with a datasheet and ran no judge and no writer. The English wording of the
// same question needed no translation, had no terms, and answered correctly -
// which was the whole French-versus-English asymmetry. A term the search engine
// wanted is not a question the reader asked.
export function wantsUnitCard(question, asked) {
  const hay = norm([question, asked].filter(Boolean).join(' '));
  return CARD_INTENT.test(hay);
}

// The datasheet the question names, or null. The name has to appear as a whole
// phrase: 'captain' reaching every Captain datasheet would be right, but 'rhino'
// reaching the five chaos datasheets that share the name is not - that is a
// different unit per faction and the card would be a confident guess.
export function findDatasheet(question, asked) {
  const hay = norm([question, asked].filter(Boolean).join(' '));
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
export function buildUnitCard(id, opts) {
  const o = opts || {};
  const corpora = o.corpora || {};
  const key = String(id == null ? '' : id);
  const cache = cardCacheFor(o.corpora);
  if (cache.has(key)) return cache.get(key);
  const t = cardTables();
  const d = t.byId.get(key);
  if (!d) { cache.set(key, null); return null; }
  const models = (t.models.get(d.id) || []).map(m => ({
    line: m.line, name: clean(m.name),
    M: m.M, T: m.T, Sv: m.Sv,
    inv: (m.inv_sv && m.inv_sv !== '-') ? m.inv_sv + '+' : '',
    W: m.W, Ld: m.Ld, OC: m.OC,
    base: clean(m.base_size),
  }));
  if (!models.length) { cache.set(key, null); return null; }
  const weapons = (t.wargear.get(d.id) || []).map(w => ({
    name: clean(w.name), type: clean(w.type), range: clean(w.range),
    A: w.A, BS: w.BS_WS, S: w.S, AP: w.AP, D: w.D, notes: clean(w.description),
  }));
  const abilities = (t.abilities.get(d.id) || []).map(ab => {
    const ref = ab.ability_id ? t.abilityById.get(ab.ability_id) : null;
    const name = clean(ab.name) || clean(ref && ref.name);
    const source = ab.description || (ref && ref.description) || '';
    const raw = clean(source) || clean(ref && ref.description);
    const body = cap(stripAbilityHead(name, trimAbilityTail(raw)), ABILITY_CHARS);
    const type = clean(ab.type);
    // A rule defined elsewhere: link it, or keep the text.
    const record = findAbilityRecord({ type, name, ruleIds: abilityRuleIds(source) }, corpora.rules, corpora.factions);
    return {
      type, name, description: body.text, truncated: body.truncated,
      link: record ? {
        heading: record.heading || '', url: record.url || '', href: hrefFor(record),
        passage: record.text || '', source: record.source || '', ruleId: record.ruleId || '',
      } : null,
    };
  }).filter(a => a.name || a.description);
  const kws = (t.keywords.get(d.id) || []).map(k => ({ keyword: clean(k.keyword), faction: String(k.is_faction_keyword) === 'true' })).filter(k => k.keyword);
  const points = (t.costs.get(d.id) || [])
    .map(c => ({ label: clean(c.description), cost: clean(c.cost) }))
    .filter(c => c.cost);
  const src = t.sources.get(d.source_id);
  CARD_BUILDS++;
  const card = {
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
  cache.set(key, card);
  return card;
}

// A record's links, resolved against an index of the corpus: each target carries
// its heading, anchor and url so a caller renders a chip from this array and
// never parses the '- section: X' text. A target the index does not hold is
// dropped - a dead link is worse than no link, the rule the build follows.
// Exported because the findings payload and the record card are its two callers
// and they must not drift.
export function resolveRecordLinks(links, byId) {
  const out = [];
  for (const l of links || []) {
    const target = l && l.to ? byId.get(l.to) : null;
    if (!target) continue;
    out.push({
      to: l.to,
      title: l.title || target.heading || '',
      kind: l.kind || '',
      anchor: target.anchor || '',
      url: target.url || '',
    });
  }
  return out;
}

// Any corpus record as a card, for the full-screen view: the CSV unit card when
// the record is a datasheet or its keywords-and-abilities half, and for every
// other category the record itself, its breadcrumb and its resolved links. One
// builder for the four categories the view opens - unit, faction, detachment,
// rules section - so the page renders one shape instead of a renderer per kind.
// Null when the id is not in the corpus: a half card is never shown.
// task-23: the record's own name, not the section it hangs under. Same rule and
// same shape as src/wiki-surface.js's rowName (tests pin both against the same
// headings): a Q&A / errata / '[ONE SHOT]' record's path ends at the rule it
// answers about, so its leaf is that section's name and three records printed
// 'FALL-BACK MOVE'; the record's own name is the question segment above the leaf,
// and the breadcrumb stops before it. A heading whose leaf IS the name is
// untouched.
function rowName(parts) {
  const list = (parts || []).map(p => String(p == null ? '' : p).trim());
  if (!list.length) return { name: '', at: -1 };
  const last = list.length - 1;
  for (let i = last - 1; i >= 0; i--) {
    if (/\?$/.test(list[i]) || /^q\s*:/i.test(list[i])) return { name: list[i], at: i };
  }
  const low = list[last].toLowerCase();
  for (let i = last - 1; i >= 0; i--) {
    if (list[i].toLowerCase() !== low) continue;
    for (let k = i - 1; k >= 0; k--) {
      if (list[k].toLowerCase() !== low) return { name: list[k], at: k };
    }
    break;
  }
  return { name: list[last], at: last };
}

export function recordCard(id, opts) {
  const o = opts || {};
  const corpora = o.corpora || {};
  const byId = o.index || new Map(
    ([]).concat(corpora.rules || [], corpora.factions || []).map(r => [r.id, r]));
  const raw = byId.get(String(id == null ? '' : id));
  if (!raw) return null;
  // task-29: a (1/2)/(2/2) part opens the whole record, named by its base heading -
  // display only, the corpus keeps the parts for the judge and the index.
  const sections = ([]).concat(corpora.rules || [], corpora.factions || [], corpora.rulings || []);
  const rec = mergeChunkParts(raw, sections);
  const kind = rec.kind || '';
  // The CSV card is keyed by the bare datasheet id; the corpus record carries a
  // source prefix. `datasheet#X` and `unitrules#X` are the two halves of one
  // datasheet and both open the same card.
  // A record the importer split into parts keeps the CSV number plus "~n";
  // both halves and every part open the same card.
  const bare = String(rec.id).replace(/^(?:datasheet|unitrules)#/, '').replace(/~\d+$/, '');
  const card = (kind === 'datasheet' || kind === 'unitrules')
    ? buildUnitCard(bare, o.corpora ? { corpora: o.corpora } : undefined)
    : null;
  const parts = String(rec.heading || '').split(' > ').filter(Boolean);
  const named = rowName(parts);
  return {
    id: rec.id,
    kind,
    set: rec.set || '',
    source: rec.source || '',
    faction: rec.faction || '',
    heading: rec.heading || '',
    ruleId: rec.ruleId || '',
    title: named.name || rec.heading || rec.id,
    crumb: parts.slice(0, named.at >= 0 ? named.at : parts.length - 1),
    text: String(rec.text || ''),
    url: rec.url || '',
    href: hrefFor(rec),
    links: resolveRecordLinks(rec.links, byId),
    card,
  };
}

// The whole decision, for a caller that has the question and its translation:
// a card, or null and the prose path stays exactly as it was.
export function unitCard(question, opts) {
  const o = opts || {};
  if (!unitCardEnabled(o.env)) return null;
  if (!wantsUnitCard(question, o.asked)) return null;
  const d = findDatasheet(question, o.asked);
  return d ? buildUnitCard(d.id, o.corpora ? { corpora: o.corpora } : undefined) : null;
}

export default { CARD_INTENT, ABILITY_CHARS, cardTables, resetCardTables, cardBuildCount, unitCardEnabled, wantsUnitCard, findDatasheet, buildUnitCard, recordCard, resolveRecordLinks, unitCard, abilityRuleIds, findAbilityRecord };
