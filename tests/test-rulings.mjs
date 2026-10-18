import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, csvQuotedRows, buildRulingsCorpus, deliveredSections } from '../src/rules-corpus.mjs';
import { wikiTree } from '../src/wiki-toc.mjs';
import { recordBody, rulingBody } from '../src/wiki-cards.mjs';

// The card escapes the text it puts in HTML; the French is full of apostrophes,
// so a plain indexOf on the raw string would fail on the escaping, not on the
// language. Same map as src/wiki-cards.mjs.
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, 'workspace', 'rules-corpus', 'rulings');
const manifest = JSON.parse(fs.readFileSync(path.join(STAGE, 'sources.json'), 'utf8'));
const all = readAllCorpus();
const rulings = all.filter(r => r.set === 'rulings');
const wtc = rulings.filter(r => r.id.indexOf('wtc11-') === 0);
const feq = rulings.filter(r => r.id.indexOf('feq11-') === 0);
const scopes = list => list.reduce((a, r) => { const s = r.provenance.scope || '(none)'; a[s] = (a[s] || 0) + 1; return a; }, {});

// --- the records --------------------------------------------------------------
t('154 records: 120 WTC + 34 FEQ', [rulings.length, wtc.length, feq.length], [154, 120, 34]);
t('the tab intro row is not a record', rulings.some(r => r.id === 'wtc11-did-you-know-057'), false);
t('ids are unique and prefixed wtc11- / feq11-', [new Set(rulings.map(r => r.id)).size, rulings.every(r => /^(?:wtc11|feq11)-/.test(r.id))], [154, true]);
t('no record has empty text', rulings.filter(r => !String(r.text || '').trim()).length, 0);
t('every record is edition 11 and delivered', rulings.every(r => String(r.edition) === '11'), true);
t('scope tallies: game 134 (100 WTC + 34 FEQ), event 11, tip 9 (the dropped row was a tip)', [scopes(rulings).game, scopes(rulings).event, scopes(rulings).tip], [134, 11, 9]);
t('the WTC document splits 100 game / 11 event / 9 tip', [scopes(wtc).game, scopes(wtc).event, scopes(wtc).tip], [100, 11, 9]);
t('the FEQ document is 34 game', scopes(feq), { game: 34 });

// --- provenance and verbatim text --------------------------------------------
t('every record carries source_id, publisher, url, version, edition, language, retrieved_at', rulings.filter(r => {
  const p = r.provenance || {};
  return p.source_id && p.publisher && p.url && p.version && p.edition === '11' && p.language && p.retrieved_at;
}).length, 154);
const wtcAlias = manifest.alias_tables.wtc_faction_by_topic;
t('every WTC faction resolves through the alias table (never name matching)', wtc.filter(r => r.provenance.faction && wtcAlias[r.provenance.topic] !== r.provenance.faction).length, 0);
const feqTypes = new Set(Object.values(manifest.alias_tables.feq_type));
t('every FEQ type_norm resolves through the alias table', feq.filter(r => r.provenance.type_norm && !feqTypes.has(r.provenance.type_norm)).length, 0);
t('the FEQ rows keep their modification date', feq.filter(r => r.provenance.modified).length, 34);
// The English is an addition to the French, joined on the record id; the French
// stays the source of record and stays verbatim.
const feqEn = JSON.parse(fs.readFileSync(path.join(STAGE, 'feq-11-faq.en.json'), 'utf8'));
t('all 34 translations join and none is orphaned', [feq.filter(r => r.text_en).length, Object.keys(feqEn.text_en).length, feq.filter(r => !r.text_en).length], [34, 34, 0]);
ok('every translated record carries the machine/reviewed:false provenance', feq.every(r => r.provenance.translation && r.provenance.translation.by === 'machine' && r.provenance.translation.reviewed === false && r.provenance.translation.model));
t('the French is untouched by the translation', feq.filter(r => r.text_en === r.text).length, 0);
ok('a translated record renders French under fr and English under en', (function () {
  const rec = feq.find(r => r.text_en);
  const fr = rulingBody(rec, 'fr'), en = rulingBody(rec, 'en');
  return fr.indexOf(esc(rec.text)) !== -1 && fr.indexOf(esc(rec.text_en)) === -1 && en.indexOf(esc(rec.text_en)) !== -1 && en.indexOf('Machine translation, unreviewed') !== -1;
})());
ok('the default keeps the French and hides the English until the reader chooses it', (function () {
  const rec = feq.find(r => r.text_en);
  const html = rulingBody(rec);
  return html.indexOf('wlang-fr') !== -1 && html.indexOf('wlang-en') !== -1 && html.indexOf(esc(rec.text)) !== -1 && html.indexOf(esc(rec.text_en)) !== -1;
})());
ok('a record with no translation falls back to the French and says so', (function () {
  const html = rulingBody({ id: 'feq11-x', text: 'Le texte francais' }, 'en');
  return html.indexOf('Le texte francais') !== -1 && html.indexOf('No English translation yet') !== -1;
})());
const csvWtc = new Map(csvQuotedRows(fs.readFileSync(path.join(STAGE, 'wtc-11-faq-1.0.normalised.csv'), 'utf8')).map(r => [r.id, r.text]));
const csvFeq = new Map(csvQuotedRows(fs.readFileSync(path.join(STAGE, 'feq-11-faq.normalised.csv'), 'utf8')).map(r => [r.id, r.text]));
ok('every ruling text is the staged CSV cell, byte for byte', rulings.every(r => (r.id.indexOf('wtc11-') === 0 ? csvWtc.get(r.id) : csvFeq.get(r.id)) === r.text));
ok('source typos survive raw where the sheet has them', wtc.every(r => !r.provenance.type_raw) && feq.every(r => r.provenance.type_raw === r.provenance.type_raw));

// --- the branch ---------------------------------------------------------------
const tree = wikiTree(all);
// The dropped row is not delivered, so it has no tree path and no search row:
// search.html, the tree and the index all read this one set.
ok('the dropped id has no tree path', !tree.paths.has('wtc11-did-you-know-057'));
ok('and no search row can point at it (it is not delivered)', !deliveredSections(all).some(r => r.id === 'wtc11-did-you-know-057'));
const rulingFiles = Object.entries(tree.files).filter(pair => pair[0].indexOf('tree/rulings') === 0);
const leafTotal = rulingFiles.filter(pair => pair[1].lvl === 'leaf').reduce((n, pair) => n + pair[1].c, 0);
t('the branch count equals the record count', tree.stats.rulings, 154);
t('and its leaf count equals it too', leafTotal, 154);
t('three branches, with Rulings a chapter under Rules', tree.index.branches.map(b => b.n), ['Rules', 'Missions', 'Factions']);
// The branch move is Mandal's call: the rulings live under Rules now, and the
// guarantee is the provenance label on each record, not the distance from the
// rulebook. A ruling without provenance would be the one thing we cannot ship.
ok('every ruling sits under Rules, in one of the two books', rulings.every(r => { const p = tree.paths.get(r.id) || []; return p.length >= 2 && p[0].n === 'Rules' && ['WTC 11th Edition FAQ', 'FEQ 40K FAQ'].indexOf(p[1].n) !== -1; }));
ok('and every ruling is provenance-labelled', rulings.every(r => { const p = r.provenance || {}; return p.publisher && p.document && p.url && p.language; }));
ok('with a third-party banner in its own record fragment', recordBody(rulings[0], {}).indexOf('Third-party ruling') !== -1 && recordBody(rulings[0], {}).indexOf('Not Games Workshop rules text.') !== -1);
ok('ruling rows live in the ruling chapter files, never among the rulebook chapters', rulings.every(r => { const last = (tree.paths.get(r.id) || []).slice(-1)[0]; return last && String(last.f).indexOf('tree/rulings/') === 0; }));
t('and both are siblings of the rulebooks under Rules', tree.files['tree/rules.js'].kids.filter(k => k.lvl === 'book').map(k => k.n), ['Core Rules', 'Rules Appendix', 'WTC 11th Edition FAQ', 'FEQ 40K FAQ']);
t('WTC groups by topic, and the game rules topic is a chapter', tree.files['tree/rulings/wtc.js'].kids.some(k => k.n === 'core-rules' && k.c === 26), true);
t('then by facet inside it', tree.files['tree/rulings/wtc/core-rules.js'].kids.some(k => k.n === 'Stratagems'), true);
const wtcTopics = tree.files['tree/rulings/wtc.js'].kids.map(k => k.n);
ok('event and tips are labelled and sorted last', wtcTopics[wtcTopics.length - 1].indexOf('not game rules') !== -1 && wtcTopics[wtcTopics.length - 2].indexOf('not game rules') !== -1);
t('FEQ groups by type_norm', tree.files['tree/rulings/feq.js'].kids.some(k => k.n === 'Datasheet') && tree.files['tree/rulings/feq/datasheet.js'].kids.some(k => k.n === 'Adepta Sororitas'), true);
t('no empty node was made for the five empty tabs', tree.files['tree/rulings/wtc.js'].kids.filter(k => k.c === 0).length, 0);

// --- the provenance banner, in the shared fragment ----------------------------
const banner = recordBody({ kind: 'ruling', text: 'Le texte', provenance: { source_id: 'wtc-40k-11th-faq', publisher: 'WTC', document: 'WTC 11th Edition FAQ 1.0', version: '1.0', retrieved_at: '2026-10-15T02:20:00+02:00', language: 'en', scope: 'game', translation: { from: 'fr', to: 'en', by: 'machine', reviewed: false, model: 'deepseek-v4.1-flash' } } }, {});
ok('the record fragment carries the banner', banner.indexOf('Third-party ruling') !== -1 && banner.indexOf('Not Games Workshop rules text.') !== -1);
ok('and the banner says a machine translated it and no human reviewed it', banner.indexOf('machine translation') !== -1 && banner.indexOf('not reviewed') !== -1 && banner.indexOf('no human has read') !== -1);
ok('with the publisher, the document, the version and the date', banner.indexOf('WTC') !== -1 && banner.indexOf('WTC 11th Edition FAQ 1.0') !== -1 && banner.indexOf('version 1.0') !== -1 && banner.indexOf('2026-10-15') !== -1);
ok('and the ruling text is escaped, never interpreted', recordBody({ kind: 'ruling', text: '<b>raw</b>', provenance: {} }, {}).indexOf('&lt;b&gt;raw&lt;/b&gt;') !== -1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
