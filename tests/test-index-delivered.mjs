import { readAllCorpus, isDelivered, deliveredSections, deliveredIds, deliveredHits, ingest, TENTH_EDITION_RULE_IDS } from '../src/rules-corpus.mjs';

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
t('the corpus splits into delivered and filtered with nothing lost', [all.length, delivered.length + filtered.length], [7268, 7268]);
t('delivered is 6,228 (with the 154 rulings) and filtered is 1,040', [delivered.length, filtered.length], [6228, 1040]);

// --- the query path cannot return what the product does not deliver -----------
const ids = deliveredIds();
ok('the delivered index does not carry the filtered id', !ids.has('faction-rule#000008445') && ids.size === delivered.length);
t('a hit on a filtered id is dropped even if the index still holds it', deliveredHits([{ id: 'faction-rule#000008445', score: 0.99 }]), []);
const kept = deliveredHits([{ id: 'faction-rule#000008445' }, { id: 'datasheet#000000882' }, { id: 'nope#nope' }]);
t('and only delivered hits survive', kept.map(h => h.id), ['datasheet#000000882']);
const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/rules-corpus.mjs', import.meta.url), 'utf8'));
ok('both query backends return through that filter', (src.match(/deliveredHits\(/g) || []).length >= 3);

// --- the ingest plan skips the filtered records -------------------------------
const dry = await ingest(null, { set: 'factions', dryRun: true });
t('a dry-run faction ingest filtered exactly the 1,040', dry.filtered, 1040);
const row = dry.sources.find(s => s.source === 'factions-csv');
ok('and the source row reports its delivered sections, not the corpus count', !!row && row.sections + row.filtered > row.sections);
ok('the source row reports its delivered and filtered counts', row.sections === 5360 && row.filtered === 1040);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
