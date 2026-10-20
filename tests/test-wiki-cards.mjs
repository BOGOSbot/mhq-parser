import { readAllCorpus } from '../src/rules-corpus.mjs';
import { proseHtml } from '../src/wiki-cards.mjs';
import { CARD_CSS, CARD_KINDS, abilityTarget, cardFor, cardIndex, recordBody } from '../src/wiki-cards.mjs';

// The wiki's datasheet card: the one shape Wahapedia's own UI puts in front of a
// phone reader, rendered from the CSV object /rules/record already uses. Every
// assertion here is structural: a stat line, both weapon tables, the rule and
// named ability blocks, keywords, points, the text fallback - plus the two things
// a reviewer cannot see by reading the code, that the card's text is not dumped a
// second time and that an ability link only exists when OUR record does.

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const all = readAllCorpus();
const byId = new Map(all.map(r => [r.id, r]));
const index = cardIndex(byId);
const corpora = { rules: all.filter(r => r.set === 'rules'), factions: all.filter(r => r.set === 'factions') };
const href = id => 'page-' + id + '.html';
const bodyOf = (r, opts) => recordBody(r, Object.assign({ corpora, index, href }, opts || {}));

// --- the builder is the one builder -----------------------------------------
// task-33: the example page is the re-issued Custodian Guard Sodality (the frozen
// datasheet#000000882 is one of the 75 the 2026-10-19 export superseded).
const ds = byId.get('datasheet#000004251');   // Custodian Guard Sodality, the example page
const baseOf = id => String(String(id).split('#')[1] || '').split('~')[0];
const ur = [...byId.values()].find(r => r.kind === 'unitrules' && baseOf(r.id) === baseOf('datasheet#000004251'));   // the same datasheet's keywords half
const card = cardFor(ds, { corpora });
t('the card builder resolves the datasheet', !!card, true);
t('and it is the CSV card, not a second builder', [card.name, card.models.length > 0, card.ranged.length > 0, card.melee.length > 0], ['Custodian Guard Sodality', true, true, true]);
t('a non-card kind has no card', cardFor(byId.get('stratagem#000000001') || { id: 'x', kind: 'stratagem' }, { corpora }), null);
t('a card record with no CSV row falls back', cardFor({ id: 'datasheet#999999999~1', kind: 'datasheet' }, { corpora }), null);
t('the two card kinds are the two CSV halves', CARD_KINDS, ['datasheet', 'unitrules']);

// --- the card ----------------------------------------------------------------
const dsHtml = bodyOf(ds);
ok('the card is a section, not a text block', dsHtml.indexOf('<section class="wcard"') === 0 && dsHtml.indexOf('<pre') === -1);
ok('the text is NOT dumped a second time', dsHtml.indexOf('<pre class="text">') === -1);
const c = card;
t('one identity line: role and faction', /<p class="wcard-line">.*wcard-role">Battleline<.*wcard-faction">Adeptus Custodes</.test(dsHtml), true);
const modelBlock = dsHtml.slice(dsHtml.indexOf('wcard-models'), dsHtml.indexOf('Ranged weapons'));
const modelNames = (modelBlock.match(/<tr class="wcard-name"><th scope="rowgroup"/g) || []).length;
t('a stat line per model', modelNames, c.models.length);
ok('the model header carries the stats', ['M', 'T', 'Sv', 'W', 'Ld', 'OC'].every(k => dsHtml.indexOf('<th scope="col">' + k + '</th>') !== -1));
// task-39: the base is one token in the column headed Base - '40', not '40mm'.
ok('and the model values, escaped where they hold a quote', dsHtml.indexOf('<td>8&quot;</td>') !== -1 && dsHtml.indexOf('<td>40</td>') !== -1);
ok('the ranged weapons table is headed Range/A/BS/S/AP/D', /Ranged weapons<\/h2><div class="wcard-scroll"><table class="wcard-table wcard-weapons"><thead><tr>(<th scope="col">(Range|A|BS|S|AP|D)<\/th>){6}<\/tr>/.test(dsHtml));
// task-34: the range and the skill carry the game's marks now - 24" and 2+.
ok('and holds the datasheet\'s own weapon with its stats', dsHtml.indexOf('Guardian Spear') !== -1 && dsHtml.indexOf('<td>24&quot;</td><td>2</td><td>2+</td><td>5</td><td>-1</td><td>2</td>') !== -1);
// task-33: the re-issued unit's melee row is its Guardian Spear (the frozen record's
// Misericordia is not on this datasheet).
ok('the melee table is headed with WS, where the export puts the skill', /Melee weapons<\/h2><div class="wcard-scroll"><table class="wcard-table wcard-weapons"><thead><tr>(<th scope="col">(Range|A|WS|S|AP|D)<\/th>){6}<\/tr>/.test(dsHtml) && dsHtml.indexOf('Guardian Spear') !== -1);
t('every name row is followed by its stats row', (dsHtml.match(/<tr class="wcard-name"/g) || []).length, (dsHtml.match(/<tr class="wcard-stats"/g) || []).length);
ok('(81-4) the rule abilities are one link per distinct ability, not a table', dsHtml.indexOf('Core abilities and army rules') !== -1 && dsHtml.indexOf('<ul class="wcard-abilities wcard-abilitylist">') !== -1 && dsHtml.indexOf('wcard-table wcard-abilities') === -1);
// task-93: the link is labelled with the unit's own ability name, not the resolved record's
// heading path ('Attached Units > Forming Attached Units > LEADER 24.22 / SUPPORT').
ok('(81-4/task-93) the ability link is labelled by the unit ability name', /class="wcard-ability-link"[^>]*>[^<]+<\/a>/.test(dsHtml) && dsHtml.indexOf('in the rules</a>') === -1);
ok('(task-93) and the row carries no Core/Faction tag', dsHtml.indexOf('wcard-abtype') === -1);
ok('(81-4) a differing wording stays reachable collapsed', /<details class="wcard-more"><summary>the text<\/summary>/.test(dsHtml));
ok('(81-4) the render is pure: the stored text and the payload text are unchanged', (function () { const before = String(ds.text); bodyOf(ds); return String(ds.text) === before && String(ds.text).indexOf('\n') !== -1; })());
ok('the named abilities are bold-name paragraphs', dsHtml.indexOf('<b class="wcard-ability-name">Impenetrable Defence</b>') !== -1);
ok('keywords are printed, the faction ones marked', dsHtml.indexOf('wcard-kw-faction') !== -1 && dsHtml.indexOf('Custodian Guard') !== -1 && dsHtml.indexOf('Infantry') !== -1);
ok('points are printed with their cost', /<span class="wcard-pts-cost">[0-9]/.test(dsHtml));
ok('wargear options are printed', dsHtml.indexOf('Wargear options') !== -1 && /can be equipped with/.test(dsHtml));
ok('composition is printed', dsHtml.indexOf('Composition') !== -1);
ok('the source is named with the external page', dsHtml.indexOf('wcard-foot') !== -1 && dsHtml.indexOf('Wahapedia</a>') !== -1);
// task-33: the Onager Dunecrawler carries a damaged bracket in the new export.
const dmg = byId.get('datasheet#000000854');
ok('a damaged bracket is rendered when the datasheet has one', bodyOf(dmg).indexOf('wcard-damaged') !== -1);

// --- the text fallback -------------------------------------------------------
const st = all.find(r => r.kind === 'rule' && !/^\s*Type\s*:/im.test(String(r.text)) && String(r.text).length > 200) || byId.get('stratagem#000000001') || all.find(r => r.kind === 'stratagem');
const stBody = bodyOf(st);
// task-74: it keeps its text, rendered as prose rather than as one monospace block.
t('a record with no card keeps its text, as prose', stBody.indexOf('<div class="wprose">'), 0);
const fake = { id: 'datasheet#000004251', kind: 'datasheet', text: '<b>a & b</b>' };
t('and that text is escaped', bodyOf(fake, { corpora: {}, index: cardIndex(new Map()), cardBuilder: () => null }), '<div class="wprose"><p>&lt;b&gt;a &amp; b&lt;/b&gt;</p></div>');
// task-33: this datasheet's unitrules halves are ability-shaped in the new export (the
// card-shaped unitrules parts are counted in test-record-shapes); the claim here is that
// the unitrules kind goes through the one renderer and is never a raw dump.
ok('the unitrules half renders through the one renderer, never as a raw dump', (function () {
  const h = bodyOf(ur);
  return h.indexOf('<pre') === -1 && (h.indexOf('<section class="wcard"') === 0 || h.indexOf('<div class="svl-head') === 0);
})());

// --- the ability links go through the one resolver --------------------------
const linked = (dsHtml.match(/class="wcard-ability-link" href="page-/g) || []).length;
ok('an ability whose rule record exists links to it', linked > 0 && /href="page-[^"]+"/.test(dsHtml));
const noTarget = recordBody(ds, { corpora, index: cardIndex(new Map()), href });
ok('and with no record in the index the link is not drawn', noTarget.indexOf('wcard-ability-link') === -1 && noTarget.indexOf('<section class="wcard"') === 0);
const target = abilityTarget((card.abilities.find(a => a.link) || {}).link, index);
t('abilityTarget hands back the corpus record it found', !!(target && byId.has(target.to)), true);
t('and returns null when nothing matches', abilityTarget({ heading: 'no such rule', ruleId: 'zz' }, index), null);
t('and with no link at all', abilityTarget(null, index), null);

// --- the mobile shape --------------------------------------------------------
const tables = (dsHtml.match(/<table/g) || []).length;
t('every table is inside a scroll container', (dsHtml.match(/<div class="wcard-scroll"><table/g) || []).length, tables);
ok('the card CSS never lets a table force the page wide', /\.wcard-scroll \{ overflow-x:auto/.test(CARD_CSS) && /\.wcard-table \{ width:100%/.test(CARD_CSS) && /\.wcard-table \{[^}]*table-layout:fixed/.test(CARD_CSS));
ok('and the cells wrap rather than push', /\.wcard-table th, \.wcard-table td \{[^}]*overflow-wrap:anywhere/.test(CARD_CSS));

// --- task-76 (5): a field run breaks before its labels, display only ---------
// task-33: the 2026-10-19 export drops the duplicate core-stratagem 000010850002; the
// twin it keeps (000010811005) carries the same FALL-BACK MOVE text.
const fb = byId.get('core-stratagem#000010811005');
const adv = byId.get('core-stratagem#000010851002');
const fbText = String(fb.text);
// task-78 B: FALL-BACK MOVE is a move ability now, so the label-run contract is tested
// on proseHtml directly and the record's own rendering is asserted below.
const fbHtml = proseHtml(fbText, { selfId: fb.id, selfHeading: fb.heading });
ok('(5) the label run breaks before ELIGIBLE IF', fbHtml.indexOf('<br>ELIGIBLE IF:') !== -1);
ok('(5) and before EFFECT and BEFORE MOVING', fbHtml.indexOf('<br>EFFECT:') !== -1 && fbHtml.indexOf('<br>BEFORE MOVING:') !== -1);
ok('(5) the wall is gone: no label follows a stop on the same line', !/\. (?:ELIGIBLE IF|EFFECT|BEFORE MOVING|AFTER MOVING):/.test(fbHtml));
ok('(5) FALL-BACK MOVE breaks at its labels', proseHtml(fbText, { selfId: fb.id }).indexOf('<br>ELIGIBLE IF:') !== -1);
ok('(5) ADVANCE MOVE breaks at its labels', proseHtml(String(adv.text), { selfId: adv.id }).indexOf('<br>ELIGIBLE IF:') !== -1);
ok('(5) rendering does not mutate the stored text', String(fb.text) === fbText && /MAXIMUM DISTANCE: .* ELIGIBLE IF:/.test(fbText));
const weaponLine = [...byId.values()].find(r => String(r.text || '').indexOf('AP 0 D 1') !== -1 && /LETHAL HITS/.test(String(r.text)));
ok('(5) a weapon profile is not shredded: LETHAL HITS keeps its stat line', !weaponLine || bodyOf(weaponLine).indexOf('<br>LETHAL HITS') === -1);

// --- task-81 (D): the body must not repeat the title it already printed ---------
const corpusAll = readAllCorpus();
const byIdAll = new Map(corpusAll.map(r => [r.id, r]));
const advance = byIdAll.get('core-stratagem#000010851002');
if (advance) {
  const body = recordBody(advance, { record: advance }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  ok('(81-D) the body drops the echoed name-and-subtitle first line', body.indexOf('ADVANCE MOVE - core movement ability') === -1);
  ok('(81-D) the stored text still carries it (render-only)', String(advance.text).indexOf('ADVANCE MOVE - core movement ability') === 0);
}
const actions = byIdAll.get('core-rules#Actions');
if (actions) {
  const body2 = recordBody(actions, { record: actions }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  ok('(81-D) a real sentence that opens with the name is kept', body2.indexOf('Actions represent vital battlefield tasks') === 0);
}

// --- task-85 D4: the link index is not card prose --------------------------------
const indexed = proseHtml('Body line.\n\n- faction: faction-tyr\n- card: Some Card\n- Combat Disembark: the unit may disembark\n', {});
ok('(85) a link-index line is not rendered', indexed.indexOf('faction-tyr') === -1 && indexed.indexOf('card: Some Card') === -1);
ok('(85) a real content line that starts the same way is kept', indexed.indexOf('Combat Disembark') !== -1 && indexed.indexOf('Body line.') !== -1);

// --- task-40 / task-39: the reading face, the closed children, the header rows --------
// task-40: the record fragment is the surface with the most text on the page; it must
// carry the rulebook face, not the chrome sans it used to inherit.
const rulesHtml = (await import('node:fs')).readFileSync(new URL('../src/rules.html', import.meta.url), 'utf8');
ok('the record fragment has the reading face', /\.recfrag\{[^}]*font-family:var\(--serif\)/.test(rulesHtml));
ok('and the same face the dialog fallback uses', /\.rectext\{[^}]*font-family:var\(--serif\)/.test(rulesHtml));
// task-40: a see-also child is a record of its own; printing it open welds it into the
// parent (core-rules#Units-and-Models rendered 8,480 characters that way).
const units = byIdAll.get('core-rules#Units-and-Models');
if (units) {
  const h = bodyOf(units);
  ok('the see-also children print closed', h.indexOf('<details class="wseealso">') !== -1 && h.indexOf('<details class="wseealso" open>') === -1);
  t('and every one of them is closed', (h.match(/<details class="wseealso" open>/g) || []).length, 0);
}
// task-39: the first value cell of the models row is a value (M), not a name column.
ok('the name column is left-aligned by its scope, not by being the first cell', CARD_CSS.indexOf('.wcard-table th[scope=row], .wcard-table th[scope=rowgroup] { text-align:left; }') !== -1);
ok('and no rule left-aligns a first value cell', CARD_CSS.indexOf('.wcard-table td:first-child') === -1);
// task-39: the base is one token, never a broken value.
ok('the base cell never wraps', CARD_CSS.indexOf('.wcard-models td:last-child { white-space:nowrap; }') !== -1);
// task-40: a detachment header is the same row table a stratagem gets.
const detach = byIdAll.get('detachment#000000862');
if (detach) {
  const h = recordBody(detach, { record: detach, csvSource: detach.source, csvKind: detach.kind });
  ok('a detachment header renders as rows', h.indexOf('<table class="svl-rows">') !== -1);
  ok('with the points row', h.indexOf('<th>Detachment points</th><td>1</td>') !== -1);
  ok('and the force disposition row', h.indexOf('<th>Force disposition</th><td>Disruption</td>') !== -1);
  ok('and the header line leaves the prose', h.indexOf('Detachment points: 1  Force disposition') === -1);
}
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
