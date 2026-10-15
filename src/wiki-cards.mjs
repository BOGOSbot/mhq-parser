#!/usr/bin/env node
'use strict';
/**
 * wiki-cards: a datasheet record rendered as a card, for the wiki render.
 *
 * The wiki render used to dump every record's flat text into a <pre>. For the
 * 3,052 datasheet and unitrules records that text is a transcription of the CSV
 * export's cells - a stat line per model, the wargear, the abilities, the
 * keywords, the points - and a reader on a phone gets a wall of lines where
 * Wahapedia's own UI shows a card. This module renders that card.
 *
 * It does NOT re-derive the fields: buildUnitCard() in src/unit-card.mjs is the
 * one builder, the same one /rules/record uses, and it reads the CSV export. The
 * card here is a second RENDERER of that object, never a second builder, so the
 * two views cannot disagree about a Toughness or a weapon profile.
 *
 * Nothing is a table that can push the page sideways: every table is wrapped in
 * .wcard-scroll and the weapon and model tables use Wahapedia's two-row shape
 * (the name on its own line, the numbers under the fixed headers), which fits a
 * 390px phone without scrolling the page itself.
 */

import { buildUnitCard, resolveRecordLinks } from './unit-card.mjs';

// The two kinds whose text is a flat transcription of the CSV card. Every other
// kind (stratagem, enhancement, detachment, rule, ability, index) has no card
// and keeps the text block exactly as it was.
export const CARD_KINDS = ['datasheet', 'unitrules'];

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// The CSS the card needs, on top of whatever chrome the shell already has. The
// class names are semantic on purpose: a restyle (slice 2) targets .wcard-* and
// never has to guess what a div was for.
export const CARD_CSS = [
  '.wcard { margin:0 0 1.2rem; }',
  '.wcard-line { margin:.2rem 0 .6rem; font-size:.9rem; color:var(--dim); }',
  '.wcard-dot { padding:0 .3rem; }',
  '.wcard-role { color:var(--ink); font-weight:600; }',
  '.wcard-h { font-size:.82rem; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin:1.2rem 0 .35rem; }',
  '.wcard-scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }',
  '.wcard-table { width:100%; border-collapse:collapse; font-size:.82rem; table-layout:fixed; }',
  '.wcard-table th, .wcard-table td { border-bottom:1px solid var(--line); padding:.3rem .2rem; text-align:center; vertical-align:top; overflow-wrap:anywhere; }',
  '.wcard-table thead th { font-weight:600; color:var(--dim); font-size:.72rem; letter-spacing:.03em; }',
  '.wcard-table td:first-child, .wcard-table th[scope=row], .wcard-table th[scope=rowgroup] { text-align:left; }',
  '.wcard-table th[scope=rowgroup] { font-weight:600; color:var(--ink); }',
  '.wcard-note { font-weight:400; color:var(--dim); }',
  '.wcard-abilities td:last-child { text-align:left; }',
  '.wcard-abilities th[scope=row] { text-align:left; }',
  '.wcard-ability { margin:0 0 .7rem; }',
  '.wcard-ability-name { font-weight:600; }',
  '.wcard-ability-text { margin:.15rem 0 0; }',
  '.wcard-ability-link { display:inline-block; margin-top:.2rem; font-size:.82rem; }',
  '.wcard-keywords { display:flex; flex-wrap:wrap; gap:.35rem; padding:0; margin:.2rem 0 .8rem; list-style:none; }',
  '.wcard-kw { background:var(--chip); border-radius:999px; padding:.2rem .55rem; font-size:.82rem; }',
  '.wcard-kw-faction { font-weight:600; }',
  '.wcard-options, .wcard-composition { margin:.2rem 0 .8rem; padding-left:1.1rem; }',
  '.wcard-points { list-style:none; margin:.2rem 0 .8rem; padding-left:0; }',
  '.wcard-points li { display:flex; justify-content:space-between; gap:.6rem; border-bottom:1px solid var(--line); padding:.25rem 0; }',
  '.wcard-pts-cost { font-weight:600; white-space:nowrap; }',
  '.wcard-loadout { margin:.2rem 0 .8rem; }',
  '.wcard-damaged { border-left:3px solid var(--warn); padding:.1rem 0 .1rem .6rem; margin:.2rem 0 .8rem; }',
  '.wcard-foot { font-size:.78rem; color:var(--dim); margin:.9rem 0 0; }',
].join('\n');

// The index a card needs to resolve its ability links: the corpus by id, plus
// the two keys an ability link carries instead of an id. Built once by the
// caller - one pass over 6,705 records, not one per datasheet.
export function cardIndex(byId) {
  const byHeading = new Map(), byRuleId = new Map();
  for (const rec of (byId ? byId.values() : [])) {
    if (rec.heading && !byHeading.has(rec.heading)) byHeading.set(rec.heading, rec);
    if (rec.ruleId && !byRuleId.has(String(rec.ruleId))) byRuleId.set(String(rec.ruleId), rec);
  }
  return { byId: byId || new Map(), byHeading, byRuleId };
}

// An ability's link to the rule that defines it, resolved against that index.
// The link object buildUnitCard produces carries a heading and a rule id, not a
// record id, so the id is looked up here and then handed to the ONE resolver -
// resolveRecordLinks - which is what /rules/record uses. A target the corpus does
// not hold resolves to null and the ability keeps its text: a dead link is worse
// than a long card, the rule the build already follows.
export function abilityTarget(link, index) {
  if (!link || !index) return null;
  const rec = (link.heading && index.byHeading.get(link.heading))
    || (link.ruleId && index.byRuleId.get(String(link.ruleId)))
    || null;
  if (!rec) return null;
  const resolved = resolveRecordLinks([{ to: rec.id, title: link.heading || rec.heading || '', kind: 'rule' }], index.byId)[0];
  return resolved || null;
}

// The card object for a record, or null. buildUnitCard is the builder; a record
// whose CSV row is missing (the ~1/~2 duplicate-name ids, 111 of the 3,052) comes
// back null and the caller falls back to the text.
export function cardFor(record, opts) {
  if (!record || CARD_KINDS.indexOf(record.kind) === -1) return null;
  const o = opts || {};
  if (typeof o.cardBuilder === 'function') return o.cardBuilder(record) || null;
  // A record the importer split into parts keeps the CSV row's number plus a
  // "~n" suffix; the card is the same card.
  const bare = String(record.id || '').replace(/^(?:datasheet|unitrules)#/, '').replace(/~\d+$/, '');
  if (!bare) return null;
  try { return buildUnitCard(bare, { corpora: o.corpora || {} }) || null; } catch (e) { return null; }
}

// --- the card ---------------------------------------------------------------

// One table in the phone shape: the name on its own full-width row, then the
// numbers under a header that never moves. `cols` is the header row; each row is
// { name, note, cells }.
function twoRow(title, cls, cols, rows) {
  const head = '<tr>' + cols.map(c => '<th scope="col">' + esc(c) + '</th>').join('') + '</tr>';
  const body = rows.map(r =>
    '<tr class="wcard-name"><th scope="rowgroup" colspan="' + cols.length + '">' + esc(r.name)
    + (r.note ? ' <span class="wcard-note">' + esc(r.note) + '</span>' : '') + '</th></tr>'
    + '<tr class="wcard-stats">' + r.cells.map(v => '<td>' + esc(v == null ? '' : v) + '</td>').join('') + '</tr>').join('');
  return '<h2 class="wcard-h">' + esc(title) + '</h2>'
    + '<div class="wcard-scroll"><table class="wcard-table ' + cls + '"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
}

function abilityRow(a, o) {
  const target = abilityTarget(a.link, o.index);
  const href = target && typeof o.href === 'function' ? o.href(target.to) : '';
  return {
    name: a.name || '',
    type: a.type || '',
    text: a.description ? '<span class="wcard-ability-text">' + esc(a.description)
      + (a.truncated ? ' <span class="wcard-note">(cut short)</span>' : '') + '</span>' : '',
    link: href ? '<a class="wcard-ability-link" href="' + esc(href) + '">'
      + esc(target.title || a.name || 'the rule') + ' in the rules</a>' : '',
  };
}

function cardHtml(card, o) {
  const parts = [];

  // Identity: what the record's heading already said, plus the edition the card
  // was built from, so the card explains itself without the page chrome.
  const line = [card.role ? '<span class="wcard-role">' + esc(card.role) + '</span>' : '',
    card.faction ? '<span class="wcard-faction">' + esc(card.faction) + '</span>' : '',
    card.edition ? '<span class="wcard-edition">edition ' + esc(card.edition) + '</span>' : ''].filter(Boolean);
  if (line.length) parts.push('<p class="wcard-line">' + line.join('<span class="wcard-dot">\u00b7</span>') + '</p>');

  if (card.models && card.models.length) {
    const withInv = card.models.some(m => m.inv);
    const withBase = card.models.some(m => m.base);
    const cols = ['M', 'T', 'Sv'].concat(withInv ? ['inv'] : []).concat(['W', 'Ld', 'OC']).concat(withBase ? ['Base'] : []);
    const rows = card.models.map(m => ({
      name: m.name || card.name || 'Model',
      cells: [m.M, m.T, m.Sv].concat(withInv ? [m.inv] : []).concat([m.W, m.Ld, m.OC]).concat(withBase ? [m.base] : []),
    }));
    parts.push(twoRow('Models', 'wcard-models', cols, rows));
  }

  // Wahapedia's weapon tables, in the two-row shape. The melee header says WS,
  // which is where the export puts the melee skill (the field is BS_WS for both).
  const weaponTables = [['Ranged weapons', card.ranged, 'BS'], ['Melee weapons', card.melee, 'WS']];
  for (const t of weaponTables) {
    const list = t[1];
    if (!list || !list.length) continue;
    const rows = list.map(w => ({ name: w.name || '', note: w.notes || '', cells: [w.range || (t[2] === 'WS' ? 'Melee' : ''), w.A, w.BS, w.S, w.AP, w.D] }));
    parts.push(twoRow(t[0], 'wcard-weapons', ['Range', 'A', t[2], 'S', 'AP', 'D'], rows));
  }

  if (card.options && card.options.length) {
    parts.push('<h2 class="wcard-h">Wargear options</h2><ul class="wcard-options">' + card.options.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>');
  }

  const abilities = (card.abilities || []).map(a => abilityRow(a, o));
  const rules = abilities.filter(a => /core|army|faction/i.test(a.type));
  const named = abilities.filter(a => !/core|army|faction/i.test(a.type));
  if (rules.length) {
    const rows = rules.map(a => '<tr><td>' + esc(a.type) + '</td><th scope="row">' + esc(a.name) + '</th><td>'
      + a.text + (a.text && a.link ? ' ' : '') + a.link + '</td></tr>').join('');
    parts.push('<h2 class="wcard-h">Core abilities and army rules</h2>'
      + '<div class="wcard-scroll"><table class="wcard-table wcard-abilities"><thead><tr><th scope="col">Type</th><th scope="col">Name</th><th scope="col">Description</th></tr></thead><tbody>' + rows + '</tbody></table></div>');
  }
  if (named.length) {
    parts.push('<h2 class="wcard-h">Abilities</h2>' + named.map(a =>
      '<p class="wcard-ability"><b class="wcard-ability-name">' + esc(a.name) + '</b>'
      + (a.text ? ' ' + a.text : '') + (a.link ? ' ' + a.link : '') + '</p>').join(''));
  }

  if (card.composition && card.composition.length) {
    parts.push('<h2 class="wcard-h">Composition</h2><ul class="wcard-composition">' + card.composition.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>');
  }
  if (card.loadout) parts.push('<p class="wcard-loadout">' + esc(card.loadout) + '</p>');
  if (card.legend) parts.push('<p class="wcard-loadout">' + esc(card.legend) + '</p>');

  const factionKw = (card.keywords && card.keywords.faction) || [];
  const otherKw = (card.keywords && card.keywords.other) || [];
  const kws = [].concat(factionKw, otherKw);
  if (kws.length) {
    const faction = new Set(factionKw);
    parts.push('<h2 class="wcard-h">Keywords</h2><ul class="wcard-keywords">' + kws.map(k =>
      '<li class="wcard-kw' + (faction.has(k) ? ' wcard-kw-faction' : '') + '">' + esc(k) + '</li>').join('') + '</ul>');
  }

  if (card.points && card.points.length) {
    parts.push('<h2 class="wcard-h">Points</h2><ul class="wcard-points">' + card.points.map(p =>
      '<li><span class="wcard-pts-label">' + esc(p.label || 'unit') + '</span><span class="wcard-pts-cost">' + esc(p.cost) + '</span></li>').join('') + '</ul>');
  }
  if (card.damaged && card.damaged.description) {
    parts.push('<div class="wcard-damaged"><h2 class="wcard-h">Damaged' + (card.damaged.w ? ': ' + esc(card.damaged.w) + ' wounds remaining' : '') + '</h2>'
      + '<p>' + esc(card.damaged.description) + '</p></div>');
  }

  const foot = [card.source, card.version ? 'v' + card.version : '', card.updated ? 'updated ' + card.updated : ''].filter(Boolean);
  if (foot.length || card.url) {
    parts.push('<p class="wcard-foot">' + esc(foot.join(' \u00b7 '))
      + (card.url ? (foot.length ? ' \u00b7 ' : '') + '<a href="' + esc(card.url) + '">Wahapedia</a>' : '') + '</p>');
  }
  return '<section class="wcard" data-card="unit">' + parts.join('') + '</section>';
}

// --- the record body --------------------------------------------------------

// The body of a record page, as an HTML fragment. A datasheet or unitrules
// record renders as the card; a record whose card cannot be built, and every
// other kind, keeps the escaped text this render has always written.
//
// The card's text is NOT also dumped: for these two kinds the text is a flat
// transcription of the same CSV cells the card is built from (the Model lines,
// the Wargear lines, Option, Ability, Keywords, Points, Damaged, Source), so
// printing both would show every field twice. The record's LINKS are untouched -
// the page renders those from the record's own array, below this fragment.
export function recordBody(record, opts) {
  const o = opts || {};
  const card = cardFor(record, o);
  if (card) return cardHtml(card, o);
  return '<pre class="text">' + esc(record && record.text) + '</pre>';
}

export default { CARD_KINDS, CARD_CSS, cardIndex, abilityTarget, cardFor, recordBody };

