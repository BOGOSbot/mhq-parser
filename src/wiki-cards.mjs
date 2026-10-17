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
// task-66: one escaper and one linkifier for the whole card and prose path.
import { linkify, esc } from './wikilinks.mjs';
// The corpus's own link block and the page's terminal 'SEE ALSO' list ride inside the
// stored text (they are what the vector sees). Neither is the reader's text: the link
// block is stripped exactly from the record's own links array (task-72), and the SEE
// ALSO block is stripped for display only when it names the record's own section links
// (task-87).
import { stripBuiltBlock, stripSeeAlso } from './wiki-plan.mjs';

// The two kinds whose text is a flat transcription of the CSV card. Every other
// kind (stratagem, enhancement, detachment, rule, ability, index) has no card
// and keeps the text block exactly as it was.
export const CARD_KINDS = ['datasheet', 'unitrules'];

// esc lives in wikilinks.mjs: one escaper for the whole card and link path (a
// second copy is what turned the fr/en ruling-body tests red).
const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// The CSS the card needs, on top of whatever chrome the shell already has. The
// class names are semantic on purpose: a restyle (slice 2) targets .wcard-* and
// never has to guess what a div was for.
export const CARD_CSS = [
  // task-72: a rule the corpus also holds in full is a pointer, and its text sits
  // one tap away, collapsed.
  '.wcard-more { margin:.15rem 0 0; font-size:.85rem; }',
  // task-78 B: the labelled layouts - a stratagem's CP badge, an ability's rows.
  '.svl-head { display:flex; align-items:center; gap:8px; margin:0 0 10px; }',
  '.svl-cp { display:inline-block; min-width:34px; text-align:center; padding:4px 8px; border-radius:6px; background:#7a1f1f; color:#fff; font-weight:700; }',
  '.svl-type { font-size:.85em; letter-spacing:.04em; text-transform:uppercase; opacity:.75; }',
  '.svl-rows { width:100%; border-collapse:collapse; margin:0 0 12px; }',
  '.svl-rows th { text-align:left; vertical-align:top; white-space:nowrap; padding:6px 10px 6px 0; font-size:.8em; letter-spacing:.04em; text-transform:uppercase; opacity:.7; border-top:1px solid rgba(255,255,255,.12); }',
  '.svl-rows td { padding:6px 0; border-top:1px solid rgba(255,255,255,.12); vertical-align:top; }',
  // task-89: the ALL-CAPS structure in the plain ability fallback.
  '.wcaps { font-weight:700; color:var(--dim, #98a2b3); }',
  // The datasheet's flavour is its own column in the export; it reads as flavour
  // only if it looks like flavour. task-72.
  '.wcard-legend { margin:.7rem 0 0; color:var(--dim, #98a2b3); font-size:.85rem; font-style:italic; }',
  '.wcard-more summary { cursor:pointer; color:var(--w-dim, #98a2b3); }',
  '.wcard { margin:0 0 1.2rem; }',
  // The rule body as prose (mhq task-74). The stored text is a flat transcription, so
  // the reading has to be put back: paragraphs, bullets, and monospace only where the
  // text is really a table. Colours are literal rgba rather than a variable: card.css is
  // loaded by both surfaces and they do not name their palette the same way.
  '.wprose { margin:.2rem 0 0; }',
  '.wprose p { margin:0 0 .85rem; }',
  '.wprose .wlist { margin:0 0 .85rem; padding-left:1.15rem; }',
  '.wprose .wlist li { margin:0 0 .3rem; }',
  '.wprose .wtable { margin:0 0 .85rem; padding:.55rem .6rem; overflow-x:auto; background:rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.10); border-radius:8px; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre; }',
  // The rulings' provenance banner: it rides in the fragment (recordBody), so
  // the page and the ask dialog share it. Loud enough to not be mistaken for GW
  // text, quiet enough not to shout on every card.
  '.wprov { margin:.2rem 0 .9rem; padding:.5rem .6rem; border-left:3px solid var(--line); background:var(--chip); font-size:.8rem; color:var(--dim); }',
  '.wprov strong { color:var(--ink); }',
  '.wprov-mt { color:var(--dim); }',
  // The language switch: the French is the source of record and shows by default;
  // the English pane is revealed only when the reader has chosen English, which
  // the shell records as data-lang on <html>. Never the other way round.
  '.wlang-body.wlang-en { display:none; }',
  'html[data-lang="en"] .wlang-body.wlang-fr { display:none; }',
  'html[data-lang="en"] .wlang-body.wlang-en { display:block; }',
  '.wlang-note { font-size:.78rem; color:var(--dim); margin:.35rem 0 0; }',
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
  '.wcard-abilitylist { list-style:none; padding-left:0; margin:.35rem 0; }',
'.wcard-abilityline { margin:.35rem 0; line-height:1.35; }',
'.wcard-abtype { color:var(--w-dim, #98a2b3); font-size:.85em; }',
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
    text: a.description ? '<span class="wcard-ability-text">' + linkify(a.description, { selfId: o.selfId, href: o.href })
      + (a.truncated ? ' <span class="wcard-note">(cut short)</span>' : '') + '</span>' : '',
    link: href ? '<a class="wcard-ability-link" href="' + esc(href) + '">'
      + esc(target.title || a.name || 'the rule') + ' in the rules</a>' : '',
    // task-81 step 4: the resolved record id, so the card can name each DISTINCT
    // ability once however many rows point at it.
    to: (target && target.to) || '',
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
    // task-81 step 4 (Mandal): the heading and one link per DISTINCT ability -
    // '[Leader] [Battle Focus]' - instead of a three-column table whose Description
    // repeated the record the link already opens. A wording that differs from the
    // linked record stays reachable, collapsed, under its link; the stored text,
    // the payload and the vector are untouched (this is a rendering).
    const items = [];
    const byKey = new Map();
    for (const a of rules) {
      const key = a.to || ('name:' + String(a.name || '').toLowerCase());
      let it = byKey.get(key);
      if (!it) { it = { head: a, texts: [] }; byKey.set(key, it); items.push(it); }
      else if (a.text && a.text !== it.head.text && it.texts.indexOf(a.text) === -1) it.texts.push(a.text);
    }
    const lines = items.map(it => {
      const a = it.head;
      const texts = (a.text ? [a.text] : []).concat(it.texts);
      const more = texts.map(t => '<details class="wcard-more"><summary>the text</summary>' + t + '</details>').join('');
      return '<li class="wcard-abilityline">' + (a.link || '<b>' + esc(a.name) + '</b>')
        + (a.type ? ' <span class="wcard-abtype">' + esc(a.type) + '</span>' : '') + more + '</li>';
    }).join('');
    parts.push('<h2 class="wcard-h">Core abilities and army rules</h2>'
      + '<ul class="wcard-abilities wcard-abilitylist">' + lines + '</ul>');
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
  if (card.legend) parts.push('<p class="wcard-legend">' + esc(card.legend) + '</p>');

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
// A ruling is a third party's words: the banner says whose, and says plainly
// that it is not Games Workshop rules text. It is part of the FRAGMENT, so the
// record page and the ask dialog show the same attribution.
function provenanceBanner(p) {
  if (!p) return '';
  const bits = [
    p.publisher || p.document || '',
    p.publisher && p.document ? p.document : '',
    p.version ? 'version ' + p.version : '',
    p.retrieved_at ? 'retrieved ' + String(p.retrieved_at).slice(0, 10) : '',
    p.modified ? 'modified ' + p.modified : '',
    p.language ? String(p.language).toUpperCase() : '',
    p.scope ? 'scope: ' + p.scope : '',
  ].filter(Boolean);
  // A machine translation is never presented as a reviewed one: the banner
  // carries the fact, the model and the 'no human has read it' flag.
  const tr = p.translation;
  const translated = tr ? '<br><span class="wprov-mt">' + esc(String(tr.from || 'fr').toUpperCase()) + '\u2192' + esc(String(tr.to || 'en').toUpperCase())
    + ' machine translation (' + esc(tr.model || 'unknown model') + '), <strong>not reviewed</strong> \u2014 no human has read this rendering of the ruling. The French is the source of record.</span>' : '';
  return '<aside class="wprov" data-source="' + esc(p.source_id || '') + '"><strong>Third-party ruling</strong> \u2014 '
    + esc(bits.join(' \u00b7 ')) + '. <em>Not Games Workshop rules text.</em>' + translated + '</aside>';
}

// The ruling's text in the reader's language. Both languages ship in the record:
// the French is the source of record, the English is an addition. The default
// (no lang) keeps the French and lets the shell reveal the English only when the
// reader has said they want English - a French ruling is never defaulted to
// English. A missing translation falls back to the French, with the fact said
// out loud rather than an empty body.
export function rulingBody(record, lang, opts) {
  const o = opts || {};
  const link = t => linkify(t, { selfId: record && record.id, href: o.href });
  // A third party's ruling is read, not parsed either: the same prose renderer, with the
  // language carried so the French is not read as English.
  const proseOpts = { selfId: record && record.id, href: o.href, selfHeading: record && record.heading };
  const fr = proseHtml(record && record.text, Object.assign({ lang: 'fr' }, proseOpts));
  const hasEn = !!(record && record.text_en && String(record.text_en).trim());
  const en = hasEn
    ? proseHtml(record.text_en, Object.assign({ lang: 'en' }, proseOpts))
    : fr;
  const note = hasEn
    ? '<p class="wlang-note">Machine translation, unreviewed \u2014 the French is the source of record.</p>'
    : '<p class="wlang-note">No English translation yet \u2014 showing the French source.</p>';
  if (lang === 'en') return en + note;
  if (lang === 'fr') return fr;
  return '<div class="wlang"><div class="wlang-body wlang-fr" lang="fr">' + fr + '</div>'
    + '<div class="wlang-body wlang-en" lang="en">' + en + note + '</div></div>';
}

// task-76 (5): the corpus stores a rule's fields as one run on one line -
// 'MAXIMUM DISTANCE: ... ELIGIBLE IF: ... EFFECT: ...' - and a phone reads a wall.
// Break before the field labels, and only those labels: the STORED text, the
// payload's text and what the vector sees are untouched, because this is a
// rendering of the stored line. Labels and the records containing them, measured
// over the 7,157-record corpus: EFFECT 1494, WHEN 1399, TARGET 1254, ELIGIBLE IF
// 202, AFTER MOVING 164, MAXIMUM DISTANCE 145, RESTRICTIONS 74, WHILE MOVING 51,
// BEFORE MOVING 41, SET-UP DISTANCE 29, STARTS 26, UNITS 26, USE LIMIT 26,
// COMPLETES 26, AFTER SHOOTING 20, WHILE SHOOTING 17, WHEN DRAWN 11, TRIGGER 6,
// RESTRICTION 6. The stat-line labels the measurement also found (LETHAL HITS,
// DEVASTATING WOUNDS) are deliberately NOT here: they follow 'AP 0 D 1 -', not a
// field run, and breaking there would shred a weapon profile.
const FIELD_LABELS = /(?:MAXIMUM DISTANCE|SET-UP DISTANCE|ELIGIBLE IF|BEFORE MOVING|WHILE MOVING|AFTER MOVING|WHEN DRAWN|AFTER SHOOTING|WHILE SHOOTING|USE LIMIT|RESTRICTIONS?|EFFECT|TARGET|TRIGGER|WHEN|STARTS|COMPLETES|UNITS):/g;
function fieldLines(line) {
  FIELD_LABELS.lastIndex = 0;
  const idx = [];
  let m;
  while ((m = FIELD_LABELS.exec(line))) idx.push(m.index);
  if (!idx.length) return [line];
  const segs = [];
  for (let i = 0; i < idx.length; i++) {
    const end = i + 1 < idx.length ? idx[i + 1] : line.length;
    segs.push(line.slice(idx[i], end).trim());
  }
  const head = line.slice(0, idx[0]).trim();
  if (head) segs.unshift(head);
  return segs.filter(Boolean);
}

// The rule body as prose. The stored text is a flat transcription: paragraphs separated
// by blank lines, '- ' bullets, tables pasted as runs of spaces, and the record's own
// breadcrumb as its first line. Printing it inside one <pre> kept every line break and
// lost the reading - on a phone it was a wall of monospace (Mandal, task-74). Prose
// becomes paragraphs, bullets become a list, and only a block that is really tabular
// keeps its monospace shape, in its own scrolling box.
export function proseHtml(text, opts) {
  const o = opts || {};
  const link = t => linkify(t, { selfId: o.selfId, href: o.href, cap: o.cap });
  // A ruling keeps its language: it is the source of record and a screen reader should
  // not read French as English.
  const langAttr = o.lang ? ' lang="' + esc(o.lang) + '"' : '';
  const all = String(text == null ? '' : text).replace(/\r/g, '').split('\n');
  // A first line that is the record's own name, id or breadcrumb is not a sentence: the
  // page has already printed it as the title, and printing it twice reads as a duplicate.
  const first = all.length ? all[0].trim() : '';
  const crumbs = String(o.selfHeading || '').split(' > ').filter(Boolean);
  const names = [o.selfHeading, o.selfId, crumbs.length ? crumbs[crumbs.length - 1] : ''].filter(Boolean);
  // task-81 (D): the exact match above missed the shape that actually repeats the
  // name in the body - '<NAME> - <subtitle>', e.g. 'ADVANCE MOVE - core movement
  // ability' - which is what every core ability and every mislabelled stratagem
  // opens with. Drop the first line when it opens with the name and a separator and
  // stays short (<= 90 chars), so a real sentence that happens to start with the
  // name is never eaten. Render-only: the stored text is untouched.
  const quoted = n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const shortEcho = names.some(n => first.length <= 90 && new RegExp('^' + quoted(n) + '\\s*[-\u2013\u2014:]\\s').test(first));
  if (first && (names.indexOf(first) !== -1 || shortEcho)) all.shift();
  const blocks = [];
  let cur = [];
  // task-85 D4: the shaper wrote a link index into some records' text; the card
  // rendered it as raw '- faction: faction-tyr' bullets. Drop those lines, keyed on
  // the five known kinds - never on the pattern, because '- Combat Disembark: ...'
  // is real content that starts the same way.
  const LINK_INDEX = /^- (?:section|faction|card|index|rule): /;
  for (const line of all) {
    if (LINK_INDEX.test(line.trim())) continue;
    if (line.trim()) cur.push(line);
    else if (cur.length) { blocks.push(cur); cur = []; }
  }
  if (cur.length) blocks.push(cur);
  // Two aligned columns, or a run of short lines: that is a table, not prose.
  const isTable = b => {
    if (b.length < 2) return false;
    if (b.filter(l => /\S {2,}\S/.test(l)).length >= 2) return true;
    return b.length >= 3 && b.every(l => l.length <= 44);
  };
  const parts = [];
  for (const b of blocks) {
    if (b.every(l => /^\s*[-*]\s+/.test(l))) {
      parts.push('<ul class="wlist">' + b.map(l => '<li>' + link(l.replace(/^\s*[-*]\s+/, '')) + '</li>').join('') + '</ul>');
      continue;
    }
    if (isTable(b)) { parts.push('<pre class="wtable">' + link(b.join('\n')) + '</pre>'); continue; }
    // Linked line by line, never after joining: linkify escapes what it is given, so a
    // <br> spliced in first would come out as text. Field labels split a line into
    // its own lines first, then each line is linked and the <br>s are joined between
    // the already-escaped pieces.
    parts.push('<p>' + b.flatMap(fieldLines).map(l => link(l.trim())).join('<br>') + '</p>');
  }
  return '<div class="wprose"' + langAttr + '>' + parts.join('') + '</div>';
}

// --- task-78 B: the labelled layouts --------------------------------------------
// The classifier is the (Type, CP) pair and nothing else; kind is untouched because
// the tree places by it. An EMPTY Type with an empty CP is deliberately NOT an ability:
// the 6 Aeldari records shaped that way are the same family by their content, but an
// empty Type cannot be told from a missing field, so they take a layout only when the
// content actually carries the ability rows (MAXIMUM DISTANCE / WHEN / EFFECT).
const SHAPE_ROWS = ['MAXIMUM DISTANCE', 'WHEN', 'TARGET', 'EFFECT'];
const SHAPE_ROW_LINE = /^\s*(?:Type|CP|Maximum Distance|When|Target|Effect)\s*:/i;
function shapeGrab(text, label, inline) {
  // Type and CP decide the family, so they must start a line: an inline match would
  // file datasheet prose as an ability. The row labels may sit mid-line after the
  // record's name echo, so those are bounded by a non-letter instead.
  const pat = inline ? '(?:^|[^A-Za-z])' : '(?:^|\\n)\\s*';
  const m = new RegExp(pat + label + '\\s*:\\s*([^\\n]*)', 'i').exec(text);
  if (!m) return '';
  // Labels share a line in the flat transcription: the 22 ability records read
  // 'CP:  Turn:   Phase: Ability "Move"', so the CP value is what comes before the
  // next label, not the rest of the line. An empty CP is what makes them abilities.
  const nxt = /\b([A-Z][A-Za-z ]{2,20})\s*:\s/.exec(m[1]);
  return (nxt ? m[1].slice(0, nxt.index) : m[1]).trim();
}
function phaseLabel(heading) {
  const m = /\b(Movement|Shooting|Charge|Fight)\b/i.exec(String(heading || ''));
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : '';
}
export function recordShape(text, heading) {
  const t = String(text == null ? '' : text);
  const type = shapeGrab(t, 'Type');
  const cp = shapeGrab(t, 'CP');
  const rows = SHAPE_ROWS.map(function (L) { return [L, shapeGrab(t, L, true)]; }).filter(function (r) { return r[1]; });
  const hasRows = rows.length > 0;
  // The empty-Type candidate needs its rows at line starts: datasheet prose carries
  // label-shaped words inline, and that rule would swallow 115 unit cards.
  const strictRows = SHAPE_ROWS.some(function (L) { return shapeGrab(t, L, false); });
  if (/stratagem/i.test(type) && cp !== '') return { family: 'stratagem', type: type, cp: cp, rows: rows };
  // A move/shoot ability is the Type line and the empty CP, rows or no rows (the 22).
  // task-89: an ability takes the table only when its rows start a line. A mid-line
  // grab is a collapsed CSV table (every label after 'Turn: Phase: ... ' on one line)
  // and rendering it duplicated the EFFECT sentence; that record falls to plain prose.
  if (/^(movement|shooting) ability$/i.test(type) && cp === '') {
    if (!strictRows) return { family: 'ability-plain', type: type, cp: '', rows: [] };
    return { family: 'ability', type: type, cp: '', rows: rows };
  }
  // An empty Type with an empty CP is only an ability when the content rows are there -
  // that is how the 6 Aeldari records join the family without guessing from a blank.
  // The label must be one the record actually carries: its own Type, or the phase its
  // heading chains to. A record with no Type is not given an invented 'Ability'.
  if (type === '' && cp === '' && strictRows) return { family: 'ability', type: phaseLabel(heading), cp: '', rows: rows };
  return null;
}
// task-89: 'Turn:   Phase: Ability "Shoot"' is CSV navigation metadata, not a rule.
// Dropped for display only; the corpus keeps it and the index still searches it.
// task-90: the CSV's own columns ('Type: Movement Ability', 'CP:') are not the book's
  // words, so they leave the display in this path too; the corpus keeps them.
function stripCsvColumns(text) {
  return String(text == null ? '' : text).split(/\r?\n/).filter(function (l) { return !/^\s*(?:Type|CP)\s*:/.test(l); }).join('\n');
}
function stripTurnPhase(text) {
  return String(text == null ? '' : text)
    .replace(/Turn:\s+Phase:\s+Ability\s+"[^"]*"/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}
// task-89: in the plain fallback the ALL-CAPS tokens are the structure the table would
// have shown, so they get weight and the card palette's own dim accent. Applied only on
// this path - the byte-identical prose records are untouched.
function capsHtml(html) {
  return String(html).split(/(<[^>]+>)/).map(function (seg, i) {
    if (i % 2 === 1) return seg;
    return seg.replace(/\b[A-Z][A-Z0-9]*(?:[ \/(\[)\]]+[A-Z0-9][A-Z0-9]*)*\b/g, function (m) {
      return (m.replace(/[^A-Z]/g, '').length >= 2) ? '<span class="wcaps">' + m + '</span>' : m;
    });
  }).join('');
}
function shapeHtml(text, opts) {
  const shape = recordShape(text, opts && opts.selfHeading);
  if (!shape) return proseHtml(text, opts);
  // task-89: the plain fallback - no head, no table, the CSV fragment gone, ALL CAPS styled.
  if (shape.family === 'ability-plain') return capsHtml(proseHtml(stripTurnPhase(stripCsvColumns(text)), opts));
  const head = shape.family === 'stratagem'
    ? '<div class="svl-head svl-strat"><span class="svl-cp">' + esc(shape.cp) + '</span><span class="svl-type">' + esc(shape.type) + '</span></div>'
    : '<div class="svl-head svl-ability">' + (shape.type ? '<span class="svl-type">' + esc(shape.type) + '</span>' : '') + '</div>';
  const body = shape.rows.map(function (r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>'; }).join('');
  const table = body ? '<table class="svl-rows">' + body + '</table>' : '';
  // task-92: the table takes the labels it models, and only those fragments leave the
  // prose. The CSV transcription puts a whole move on ONE line ('MAXIMUM DISTANCE: ...
  // ELIGIBLE IF: ... EFFECT: ... BEFORE MOVING: ...'), so filtering the line out because
  // it starts with a modelled label silently dropped ELIGIBLE IF, BEFORE MOVING and
  // AFTER MOVING - Mandal's 'missing data'. Type: and CP: are the head's own fields, so
  // those lines still go.
  const rx = function (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  const rest = String(text == null ? '' : text).split(/\r?\n/).map(function (line) {
    if (/^\s*(?:Type|CP)\s*:/.test(line)) return '';
    if (!SHAPE_ROW_LINE.test(line)) return line;
    let out = line;
    shape.rows.forEach(function (r) {
      out = out.replace(new RegExp('(?:^|[^A-Za-z])' + rx(r[0]) + '\\s*:\\s*' + rx(r[1]), 'i'), ' ');
    });
    return out.replace(/\s+/g, ' ').trim();
  }).filter(function (l) { return l !== ''; }).join('\n');
  // The 'Turn:   Phase: Ability "Move"' fragment is CSV navigation, not the book's words:
  // stripped on this path too (task-89 stripped it only in the plain fallback).
  return head + table + proseHtml(stripTurnPhase(rest), opts);
}
export function recordBody(record, opts) {
  const o = opts || {};
  // The card prose gets the same links as the prose path, and the record's own id
  // is carried so it never links to itself.
  if (record && !o.selfId) o.selfId = record.id;
  // task-87: the two display-only strips happen once, here. The stored text keeps both
  // blocks; the vector sees them and the corpus is unchanged.
  const text = stripSeeAlso({ text: stripBuiltBlock(record), links: record && record.links });
  const banner = record && record.kind === 'ruling' ? provenanceBanner(record.provenance) : '';
  if (record && record.kind === 'ruling') return banner + rulingBody(record, o.lang, o);
  // task-78 B: the labelled families come before the card. FALL-BACK MOVE is kind
  // 'stratagem' and had a stratagem card; its Type line says Movement Ability, and
  // Mandal's point is that it is not a stratagem, so the layout wins over the card.
  // Only records the classifier claims are affected; every other card is untouched.
  if (recordShape(text, record && record.heading)) {
    return banner + shapeHtml(text, { selfId: record && record.id, href: o.href, cap: record && record.kind === 'index' ? 0 : 40, selfHeading: record && record.heading });
  }
  const card = cardFor(record, o);
  if (card) return banner + cardHtml(card, o);
  // An index page carpeted in links is worse than an index with none: kind
  // 'index' keeps its text plain (cap 0).
  const cap = record && record.kind === 'index' ? 0 : 40;
  // task-78 B: the two labelled families get their own layout; every other record
  // takes the same proseHtml call, with the same options, as before - byte-identical.
  return banner + shapeHtml(text, { selfId: record && record.id, href: o.href, cap: cap, selfHeading: record && record.heading });
}

export default { CARD_KINDS, CARD_CSS, cardIndex, abilityTarget, cardFor, proseHtml, recordBody, rulingBody, recordShape };

