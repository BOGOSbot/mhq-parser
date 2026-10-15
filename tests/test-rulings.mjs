import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, csvQuotedRows, buildRulingsCorpus } from '../src/rules-corpus.mjs';
import { wikiTree } from '../src/wiki-toc.mjs';
import { recordBody } from '../src/wiki-cards.mjs';

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
t('155 records: 121 WTC + 34 FEQ', [rulings.length, wtc.length, feq.length], [155, 121, 34]);
t('ids are unique and prefixed wtc11- / feq11-', [new Set(rulings.map(r => r.id)).size, rulings.every(r => /^(?:wtc11|feq11)-/.test(r.id))], [155, true]);
t('no record has empty text', rulings.filter(r => !String(r.text || '').trim()).length, 0);
t('every record is edition 11 and delivered', rulings.every(r => String(r.edition) === '11'), true);
t('scope tallies: game 134 (100 WTC + 34 FEQ), event 11, tip 10', [scopes(rulings).game, scopes(rulings).event, scopes(rulings).tip], [134, 11, 10]);
t('the WTC document splits 100 game / 11 event / 10 tip', [scopes(wtc).game, scopes(wtc).event, scopes(wtc).tip], [100, 11, 10]);
t('the FEQ document is 34 game', scopes(feq), { game: 34 });

// --- provenance and verbatim text --------------------------------------------
t('every record carries source_id, publisher, url, version, edition, language, retrieved_at', rulings.filter(r => {
  const p = r.provenance || {};
  return p.source_id && p.publisher && p.url && p.version && p.edition === '11' && p.language && p.retrieved_at;
}).length, 155);
const wtcAlias = manifest.alias_tables.wtc_faction_by_topic;
t('every WTC faction resolves through the alias table (never name matching)', wtc.filter(r => r.provenance.faction && wtcAlias[r.provenance.topic] !== r.provenance.faction).length, 0);
const feqTypes = new Set(Object.values(manifest.alias_tables.feq_type));
t('every FEQ type_norm resolves through the alias table', feq.filter(r => r.provenance.type_norm && !feqTypes.has(r.provenance.type_norm)).length, 0);
t('the FEQ rows keep their modification date', feq.filter(r => r.provenance.modified).length, 34);
ok('FEQ is French and ships FR-only: no text_en field is claimed', feq.every(r => !('text_en' in r)));
const csvWtc = new Map(csvQuotedRows(fs.readFileSync(path.join(STAGE, 'wtc-11-faq-1.0.normalised.csv'), 'utf8')).map(r => [r.id, r.text]));
const csvFeq = new Map(csvQuotedRows(fs.readFileSync(path.join(STAGE, 'feq-11-faq.normalised.csv'), 'utf8')).map(r => [r.id, r.text]));
ok('every ruling text is the staged CSV cell, byte for byte', rulings.every(r => (r.id.indexOf('wtc11-') === 0 ? csvWtc.get(r.id) : csvFeq.get(r.id)) === r.text));
ok('source typos survive raw where the sheet has them', wtc.every(r => !r.provenance.type_raw) && feq.every(r => r.provenance.type_raw === r.provenance.type_raw));

// --- the branch ---------------------------------------------------------------
const tree = wikiTree(all);
const rulingFiles = Object.entries(tree.files).filter(pair => pair[0].indexOf('tree/rulings') === 0);
const leafTotal = rulingFiles.filter(pair => pair[1].lvl === 'leaf').reduce((n, pair) => n + pair[1].c, 0);
t('Rulings branch c equals the record count', tree.files['tree/rulings.js'].c, 155);
t('and its leaf count equals it too', leafTotal, 155);
t('four branches, Rulings last', tree.index.branches.map(b => b.n), ['Rules', 'Missions', 'Factions', 'Rulings']);
ok('no ruling id has a path under the Rules branch', rulings.every(r => !(tree.paths.get(r.id) || []).some(p => String(p.f).indexOf('tree/rules') === 0)));
ok('and no Rules node lists a ruling row', Object.entries(tree.files).filter(pair => pair[0].indexOf('tree/rules') === 0).every(pair => !(pair[1].recs || []).some(x => /^(?:wtc11|feq11)-/.test(String(x.i)))));
t('the two documents are the branch children', tree.files['tree/rulings.js'].kids.map(k => k.n), ['WTC 11th Edition FAQ', 'FEQ 40K FAQ']);
t('WTC groups by topic, and the game rules topic is a chapter', tree.files['tree/rulings/wtc.js'].kids.some(k => k.n === 'core-rules' && k.c === 26), true);
t('then by facet inside it', tree.files['tree/rulings/wtc/core-rules.js'].kids.some(k => k.n === 'Stratagems'), true);
const wtcTopics = tree.files['tree/rulings/wtc.js'].kids.map(k => k.n);
ok('event and tips are labelled and sorted last', wtcTopics[wtcTopics.length - 1].indexOf('not game rules') !== -1 && wtcTopics[wtcTopics.length - 2].indexOf('not game rules') !== -1);
t('FEQ groups by type_norm', tree.files['tree/rulings/feq.js'].kids.some(k => k.n === 'Datasheet') && tree.files['tree/rulings/feq/datasheet.js'].kids.some(k => k.n === 'Adepta Sororitas'), true);
t('no empty node was made for the five empty tabs', tree.files['tree/rulings/wtc.js'].kids.filter(k => k.c === 0).length, 0);

// --- the provenance banner, in the shared fragment ----------------------------
const banner = recordBody({ kind: 'ruling', text: 'Le texte', provenance: { source_id: 'wtc-40k-11th-faq', publisher: 'WTC', document: 'WTC 11th Edition FAQ 1.0', version: '1.0', retrieved_at: '2026-10-15T02:20:00+02:00', language: 'en', scope: 'game' } }, {});
ok('the record fragment carries the banner', banner.indexOf('Third-party ruling') !== -1 && banner.indexOf('Not Games Workshop rules text.') !== -1);
ok('with the publisher, the document, the version and the date', banner.indexOf('WTC') !== -1 && banner.indexOf('WTC 11th Edition FAQ 1.0') !== -1 && banner.indexOf('version 1.0') !== -1 && banner.indexOf('2026-10-15') !== -1);
ok('and the ruling text is escaped, never interpreted', recordBody({ kind: 'ruling', text: '<b>raw</b>', provenance: {} }, {}).indexOf('&lt;b&gt;raw&lt;/b&gt;') !== -1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
