import { readAllCorpus, isDelivered, deliveredSections, deliveredIds, indexedIds, deliveredHits, ingest, TENTH_EDITION_RULE_IDS } from '../src/rules-corpus.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

const all = readAllCorpus();
const delivered = deliveredSections(all);
const filtered = all.filter(r => !isDelivered(r));

// --- the one predicate --------------------------------------------------------
t('the named tenth-edition rule is not delivered', isDelivered({ id: 'faction-rule#000008445', edition: '11' }), false);
ok('and it is the only id in that set', TENTH_EDITION_RULE_IDS.size === 1 && TENTH_EDITION_RULE_IDS.has('faction-rule#000008445'));
t('an edition-0 datasheet is not delivered', isDelivered({ id: 'datasheet#000000524', edition: '0' }), false);
t('an edition-11 datasheet is', isDelivered({ id: 'datasheet#000000882', edition: '11' }), true);
t('an index stub is delivered (counted navigation, not filtered content)', isDelivered({ id: 'faction-index#faction-ae', edition: '11' }), true);
t('an empty record is not delivered', isDelivered(null), false);
// task-13 dropped ten rules-branch records: the core-stratagem copy of PULSE JET
// MOVE (its definition now rides the Wazdakka Gutsmek datasheet) and the nine
// Challenger mission stratagems (outside matched play).
// task-33, the 2026-10-19 export with the Legends name rule: 6,327 delivered / 1,063
// filtered. task-40: the $FAQ$ marker leaves one ability's text, which merges one
// edition-0 part back, so the corpus is 7,390.
t('the corpus splits into delivered and filtered with nothing lost', [all.length, delivered.length + filtered.length], [7426, 7426]);
// task-99: 6,363. The appendix split adds 34 records and the ability definitions 2.
t('delivered is 6,363 and filtered is 1,063 (task-33 export, task-40 marker, task-99 split)', [delivered.length, filtered.length], [6363, 1063]);

// --- the query path cannot return what the product does not deliver -----------
const ids = deliveredIds();
ok('the delivered index does not carry the filtered id', !ids.has('faction-rule#000008445') && ids.size === delivered.length);
t('a hit on a filtered id is dropped even if the index still holds it', deliveredHits([{ id: 'faction-rule#000008445', score: 0.99 }]), []);
const kept = deliveredHits([{ id: 'faction-rule#000008445' }, { id: 'datasheet#000000958~1' }, { id: 'nope#nope' }]);
t('and only delivered hits survive', kept.map(h => h.id), ['datasheet#000000958~1']);
const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/rules-corpus.mjs', import.meta.url), 'utf8'));
ok('both query backends return through that filter', (src.match(/deliveredHits\(/g) || []).length >= 3);

// --- the ingest plan skips the filtered records -------------------------------
const dry = await ingest(null, { set: 'factions', dryRun: true });
t('a dry-run faction ingest filtered exactly the 1,063', dry.filtered, 1063);
const row = dry.sources.find(s => s.source === 'factions-csv');
ok('and the source row reports its delivered sections, not the corpus count', !!row && row.sections + row.filtered > row.sections);
// task-33: the ingest plans the indexable sections - the 175 kind 'index' pages are
// delivered but never embedded - so the factions plan is 5,438 delivered minus 175.
ok('the source row reports its indexable, filtered and index-excluded counts', row.sections === 5263 && row.filtered === 1063 && row.indexExcluded === 175);
t('and the dry run totals the exclusion', dry.indexExcluded, 175);
const indexIds = indexedIds();
ok('an index page is delivered but never indexed', isDelivered({ id: 'faction-index#faction-ae', kind: 'index', edition: '11' }) && !indexIds.has('faction-index#faction-ae') && indexIds.size === delivered.length - 175);
t('and a hit on an index page is dropped even if the index still holds it', deliveredHits([{ id: 'faction-index#faction-ac', score: 0.99 }]), []);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
