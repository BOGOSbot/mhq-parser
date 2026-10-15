import { readAllCorpus } from '../src/rules-corpus.mjs';
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
const ds = byId.get('datasheet#000000882');   // Custodian Guard, the example page
const baseOf = id => String(String(id).split('#')[1] || '').split('~')[0];
const ur = [...byId.values()].find(r => r.kind === 'unitrules' && baseOf(r.id) === baseOf('datasheet#000000882'));   // the same datasheet's keywords half
const card = cardFor(ds, { corpora });
t('the card builder resolves the datasheet', !!card, true);
t('and it is the CSV card, not a second builder', [card.name, card.models.length > 0, card.ranged.length > 0, card.melee.length > 0], ['Custodian Guard', true, true, true]);
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
ok('and the model values, escaped where they hold a quote', dsHtml.indexOf('<td>6&quot;</td>') !== -1 && dsHtml.indexOf('<td>40mm</td>') !== -1);
ok('the ranged weapons table is headed Range/A/BS/S/AP/D', /Ranged weapons<\/h2><div class="wcard-scroll"><table class="wcard-table wcard-weapons"><thead><tr>(<th scope="col">(Range|A|BS|S|AP|D)<\/th>){6}<\/tr>/.test(dsHtml));
ok('and holds the datasheet\'s own weapon with its stats', dsHtml.indexOf('Guardian spear') !== -1 && dsHtml.indexOf('<td>24</td><td>2</td><td>2</td><td>5</td><td>-1</td><td>2</td>') !== -1);
ok('the melee table is headed with WS, where the export puts the skill', /Melee weapons<\/h2><div class="wcard-scroll"><table class="wcard-table wcard-weapons"><thead><tr>(<th scope="col">(Range|A|WS|S|AP|D)<\/th>){6}<\/tr>/.test(dsHtml) && dsHtml.indexOf('Misericordia') !== -1);
t('every name row is followed by its stats row', (dsHtml.match(/<tr class="wcard-name"/g) || []).length, (dsHtml.match(/<tr class="wcard-stats"/g) || []).length);
ok('the rule abilities are a table, in the two-row shape', dsHtml.indexOf('Core abilities and army rules') !== -1 && /<table class="wcard-table wcard-abilities"><thead><tr><th scope="col">Type<\/th><th scope="col">Name<\/th><th scope="col">Description<\/th>/.test(dsHtml));
ok('the named abilities are bold-name paragraphs', dsHtml.indexOf('<b class="wcard-ability-name">Stand Vigil</b>') !== -1);
ok('keywords are printed, the faction ones marked', dsHtml.indexOf('wcard-kw-faction') !== -1 && dsHtml.indexOf('Custodian Guard') !== -1 && dsHtml.indexOf('Infantry') !== -1);
ok('points are printed with their cost', /<span class="wcard-pts-cost">[0-9]/.test(dsHtml));
ok('wargear options are printed', dsHtml.indexOf('Wargear options') !== -1 && /replaced with/.test(dsHtml));
ok('composition is printed', dsHtml.indexOf('Composition') !== -1);
ok('the source is named with the external page', dsHtml.indexOf('wcard-foot') !== -1 && dsHtml.indexOf('Wahapedia</a>') !== -1);
const dmg = byId.get('datasheet#000000884');
ok('a damaged bracket is rendered when the datasheet has one', bodyOf(dmg).indexOf('wcard-damaged') !== -1);

// --- the text fallback -------------------------------------------------------
const st = byId.get('stratagem#000000001') || all.find(r => r.kind === 'stratagem');
const stBody = bodyOf(st);
t('a record with no card keeps the text block', stBody.slice(0, '<pre class="text">'.length), '<pre class="text">');
const fake = { id: 'datasheet#000000882', kind: 'datasheet', text: '<b>a & b</b>' };
t('and that text is escaped', bodyOf(fake, { corpora: {}, index: cardIndex(new Map()), cardBuilder: () => null }), '<pre class="text">&lt;b&gt;a &amp; b&lt;/b&gt;</pre>');
ok('the unitrules half renders as a card too', bodyOf(ur).indexOf('<section class="wcard"') === 0 && bodyOf(ur).indexOf('<pre') === -1);

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

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
