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
// 2026-10-24: a kind 'index' page is a faction's card list, not a rule, so the predicate
// filters it. The tree never showed one and no reader could reach one.
t('an index stub is not delivered (a card list is not a rule)', isDelivered({ id: 'faction-index#faction-ae', kind: 'index', edition: '11' }), false);
t('an empty record is not delivered', isDelivered(null), false);
// task-13 dropped ten rules-branch records: the core-stratagem copy of PULSE JET
// MOVE (its definition now rides the Wazdakka Gutsmek datasheet) and the nine
// Challenger mission stratagems (outside matched play).
// task-33, the 2026-10-19 export with the Legends name rule: 6,327 delivered / 1,063
// filtered. task-40: the $FAQ$ marker leaves one ability's text, which merges one
// edition-0 part back, so the corpus is 7,390.
t('the corpus splits into delivered and filtered with nothing lost', all.length - delivered.length - filtered.length, 0);
// 2026-10-26: the faction half comes from the MFM dump, so the CSV's 144 ally copies
// and its 958 Legends records are gone at the source and 5,666 records are delivered.
// The 134 filtered are the faction index pages, which the predicate drops by kind.
t('delivered is 5,702 and filtered is 134 (MFM corpus, 2026-10-27)', [delivered.length, filtered.length], [5702, 134]);

// --- the query path cannot return what the product does not deliver -----------
// The ids are read from the corpus, never hardcoded: the faction half now comes from
// the MFM dump and its ids are dump UUIDs, so a fixed id is a baseline that breaks on
// every source change while proving nothing about the filter.
const idOf = r => (typeof r === 'string' ? r : String(r && r.id));
const filteredId = idOf(filtered[0]);
const deliveredId = idOf(delivered.find(r => String(r && r.kind) === 'datasheet'));
const ids = deliveredIds();
ok('the delivered index does not carry the filtered id', !ids.has(filteredId) && ids.size === delivered.length);
t('a hit on a filtered id is dropped even if the index still holds it', deliveredHits([{ id: filteredId, score: 0.99 }]), []);
const kept = deliveredHits([{ id: filteredId }, { id: deliveredId }, { id: 'nope#nope' }]);
t('and only delivered hits survive', kept.map(h => h.id), [deliveredId]);
const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/rules-corpus.mjs', import.meta.url), 'utf8'));
ok('both query backends return through that filter', (src.match(/deliveredHits\(/g) || []).length >= 3);

// --- the ingest plan skips the filtered records -------------------------------
const dry = await ingest(null, { set: 'factions', dryRun: true });
t('a dry-run faction ingest filtered exactly the corpus filtered count', dry.filtered, filtered.length);
const row = dry.sources.find(s => s.source === 'factions-csv');
ok('and the source row reports its delivered sections, not the corpus count', !!row && row.sections + row.filtered > row.sections);
// The index pages are filtered by the predicate itself, so the index-excluded gap the
// report computes (delivered minus indexable) is structurally zero. The section count
// is not pinned: the faction half is the dump's own row count now.
ok('the source row reports its indexable, filtered and index-excluded counts', !!row && row.sections > 0 && row.filtered === filtered.length && row.indexExcluded === 0);
t('and the dry run totals the exclusion', dry.indexExcluded, 0);
const indexIds = indexedIds();
ok('an index page is neither delivered nor indexed', !isDelivered({ id: 'faction-index#faction-ae', kind: 'index', edition: '11' }) && !indexIds.has('faction-index#faction-ae') && indexIds.size === delivered.length);
t('and a hit on an index page is dropped even if the index still holds it', deliveredHits([{ id: 'faction-index#faction-ac', score: 0.99 }]), []);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
