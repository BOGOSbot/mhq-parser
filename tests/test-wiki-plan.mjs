import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINK_BLOCK_MAX, MIN_PART, WIKI_BUDGET, chars, distribution, idReport, planWiki, renderLinks, resolveLinks, splitWithin, stripBuiltBlock } from '../src/wiki-plan.mjs';
import { carryStamps, toSection, writeWikiCorpus } from '../src/wiki-build.mjs';
import { DELETE_BATCH, MAX_DELETE_FRACTION, massDeleteGuard, scrapeBuildsWiki, textHash } from '../src/rules-corpus.mjs';

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log('FAIL ' + name + '\n  got : ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); }
}
function ok(name, got) { t(name, !!got, true); }

// --- phase A cannot write ----------------------------------------------------
// The task is a dry run: this module must not be able to touch the corpus or the
// index, whatever a caller does with it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'wiki-plan.mjs'), 'utf8');
t('the planner never writes a file', /writeFileSync|appendFileSync|createWriteStream/.test(source), false);
t('the planner never reaches the index', /upsertSections|deleteIds|ingest|pruneIndex|queryIndex/.test(source), false);

// --- the overflow rule -------------------------------------------------------
// A part under the floor is debris, not a record: it joins the part before it.
const long = Array.from({ length: 60 }, (_, i) => 'Paragraph ' + i + '. ' + 'x'.repeat(60)).join('\n\n');
const parts = splitWithin(long, 2000, MIN_PART);
ok('a long body is split into parts', parts.length > 1);
ok('every part is at or above the floor', parts.every(p => chars(p) >= MIN_PART));
ok('every part fits the budget except a merged tail', parts.filter(p => chars(p) > 2000).length <= 1);
ok('splitting keeps every character of the body', chars(parts.join(' ')) >= chars(long.replace(/\s+/g, ' ')) * 0.99);

// A link whose target is not in the plan is dropped, never emitted.
t('an unresolvable link is dropped', resolveLinks([{ to: 'a' }, { to: 'zz' }], id => id === 'a'), { links: [{ to: 'a' }], dropped: 1 });
t('a link with no target is dropped', resolveLinks([{ title: 'no id' }], () => true).dropped, 1);
t('the link block is capped, and says how much it left out', renderLinks(Array.from({ length: LINK_BLOCK_MAX + 5 }, (_, i) => ({ to: 'x' + i, title: 'T' + i, kind: 'card' }))).omitted, 5);

// --- the plan, on a corpus small enough to read ------------------------------
const rules = [
  { id: 'r#parent', set: 'rules', source: 'core-rules', heading: 'Parent Rule', text: 'The lead-in of the parent.', url: 'u', anchor: 'Parent-Rule', ruleId: '01.01' },
  { id: 'r#parent->-Child', set: 'rules', source: 'core-rules', heading: 'Parent Rule > Child Rule', text: 'The child states the rule.', url: 'u', anchor: 'Child-Rule' },
  { id: 'r#alone', set: 'rules', source: 'core-rules', heading: 'Alone', text: 'Nothing under this one.', url: 'u' },
];
const factions = [
  { id: 'datasheet#1', set: 'factions', source: 'faction-ae', faction: 'faction-ae', heading: 'Fuegan', text: 'values', url: 'u' },
  { id: 'unitrules#1', set: 'factions', source: 'faction-ae', faction: 'faction-ae', heading: 'Fuegan - keywords and abilities', text: 'keywords', url: 'u' },
];
const abilities = [
  { id: '000009894', name: 'Battle Focus', faction_id: 'AE', description: '<div>Battle Focus tokens: at the start of the battle round you receive tokens based on the battle size.</div>' },
  { id: '000008346', name: 'Leader', faction_id: '', description: '<div>Leader text with enough characters to pass the eighty character floor of the planner.</div>' },
];
const factionsCsv = [{ id: 'AE', name: 'Aeldari' }];
const plan = planWiki({ rules, factions, abilities, factionsCsv });
const byId = plan.index;

// A parent carries the NAMES of its children in its own text: that is the bet.
const parent = byId.get('r#parent');
ok('the parent links to its child', parent.links.some(l => l.to === 'r#parent->-Child'));
// task-85 D4: the section link is metadata, not prose - the text no longer carries it.
ok('the parent text no longer carries the section link', parent.text.indexOf('- section: ') === -1);
t('the child keeps its own id and text', [byId.get('r#parent->-Child').id, byId.get('r#parent->-Child').text], ['r#parent->-Child', 'The child states the rule.']);
ok('every link in the plan resolves', plan.records.every(r => (r.links || []).every(l => byId.has(l.to))));
t('no link was dropped against a plan that holds every target', plan.stats.linksDropped, 0);

// Battle Focus: a faction rule the corpus has no record for, from the CSV.
const focus = byId.get('faction-rule#000009894');
ok('Battle Focus gets a record of its own', focus);
t('the record is keyed by the CSV ability id', focus.idFrom, 'csv-ability-id');
t('a non-faction ability does not get one', byId.get('faction-rule#000008346'), undefined);
ok('the faction rule links back to its faction index', focus.links.some(l => l.to === 'faction-index#faction-ae'));

// The faction index exists and links to its cards.
const idx = byId.get('faction-index#faction-ae');
ok('the faction has an index', idx);
ok('the index links to a card', idx.links.some(l => l.to === 'datasheet#1'));
ok('a card links back to its index', byId.get('datasheet#1').links.some(l => l.to === 'faction-index#faction-ae'));

// --- id stability ------------------------------------------------------------
const existing = rules.concat(factions);
const ids = idReport(existing, plan.records);
t('every existing id survives the plan', ids.moved, 0);
t('every existing id is kept', ids.kept, existing.length);
t('the new ids are the records the plan creates', [ids.added, ids.newKinds['faction-rule'] || 0, ids.newKinds['faction-index'] || 0], [plan.records.length - existing.length, 1, 1]);

// Distribution, for the report's before/after table.
const dist = distribution(plan.records);
t('the distribution counts every record', dist.n, plan.records.length);
ok('the buckets sum to the record count', Object.values(dist.buckets).reduce((a, b) => a + b, 0) === plan.records.length);

// --- the surgical variant: links out of the embedded text --------------------
// The block is the retrieval bet; this takes it out of the text the vector sees
// and keeps every link on the record. A body that only overflowed BECAUSE of the
// block must go back to being one record, and a parent must lose the child's
// NAME from its text while keeping the link.
const surgical = planWiki({ rules, factions, abilities, factionsCsv }, { blockInText: false });
const sParent = surgical.index.get('r#parent');
t('the parent still links to its child', sParent.links.map(l => l.to), ['r#parent->-Child']);
t('the parent text no longer carries the child title', sParent.text.indexOf('Child Rule'), -1);
ok('fewer links sit in the text', surgical.stats.linksInText < plan.stats.linksInText);
// A body that fits alone must be its own text again, exactly - and the link it
// used to carry in that text is still on the record. (Whether the block forced a
// chunk depends on how many children a parent has: with the block out, a parent
// that only overflowed because of it is one record again. That is measured on
// the real corpus by the surgical build, not on a toy.)
const bigBody = 'x'.repeat(WIKI_BUDGET - 5);
const bigRules = [
  { id: 'r#big', set: 'rules', source: 'core-rules', heading: 'Big', text: bigBody, url: 'u' },
  { id: 'r#big->-Kid', set: 'rules', source: 'core-rules', heading: 'Big > Kid', text: 'The kid states the rule.', url: 'u' },
];
const withBlock = planWiki({ rules: bigRules });
const without = planWiki({ rules: bigRules }, { blockInText: false });
ok('with a section-only link the block adds nothing to the text (task-85 D4)', chars(withBlock.index.get('r#big').text) === chars(bigBody));
t('with the block out, the parent text is its own body', without.index.get('r#big').text, bigBody);
t('and the link is still on the record', (without.index.get('r#big').links || []).map(l => l.to), ['r#big->-Kid']);

// --- the written hash, for the ingest ----------------------------------------
// Phase C compares this hash to the per-source ingest state to decide what to
// embed. A record whose text was rewritten must not carry the source's hash, or
// --ingest skips it and the live index keeps the old vector.
const rewritten = { id: 'r#x', set: 'rules', heading: 'X', text: 'X\nnew body', hash: 'stale' };
t('the written hash describes the written text', toSection(rewritten).hash, textHash('X\nnew body'));
t('and a rewritten record does not carry the source hash', toSection(rewritten).hash === 'stale', false);
t('an unchanged record keeps the same hash', toSection({ id: 'r#y', set: 'rules', heading: 'Y', text: 'Y\nbody', hash: textHash('Y\nbody') }).hash, textHash('Y\nbody'));

// --- the rebuilt corpus stays datable ----------------------------------------
// /health publishes each source payload's scrapedAt and the marker's lastUpdate,
// and a trace records the same stamp. A build that wrote only { sections } made
// the served corpus say updated:null - indistinguishable from a stale one.
const stamped = carryStamps(
  { source: 'core-rules', set: 'rules', url: 'u', edition: '11', marker: { lastUpdate: 'June 2026' }, scrapedAt: '2026-10-13T00:55:31.036Z', bytes: 777918, count: 377, anchored: 159 },
  [{ id: 'a', hasAnchor: false }, { id: 'b', hasAnchor: true }],
);
t('the source stamps ride along with the planned sections', stamped, {
  source: 'core-rules', set: 'rules', url: 'u', edition: '11', marker: { lastUpdate: 'June 2026' },
  scrapedAt: '2026-10-13T00:55:31.036Z', bytes: 777918, count: 2, anchored: 1, sections: [{ id: 'a', hasAnchor: false }, { id: 'b', hasAnchor: true }],
});
t('the record count is recomputed, not the scrape\'s', stamped.count, 2);
t('and so is the anchored count', stamped.anchored, 1);
t('a source with no payload still writes a countable file', carryStamps(null, []), { count: 0, anchored: 0, sections: [] });

// --- the scrape cannot silently revert the shape ------------------------------
// The live corpus is the wiki build; a scrape writes the FLAT corpus into the
// same directory, so the scrape ends by building the wiki shape and --flat is
// the only way to keep the raw scrape.
t('a scrape builds the wiki shape by default', scrapeBuildsWiki(['--scrape']), true);
t('--flat is the only opt-out', scrapeBuildsWiki(['--scrape', '--flat']), false);
t('no scrape flag reports the default', scrapeBuildsWiki([]), true);
const scrapeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'rules-corpus.mjs'), 'utf8');
const scrapeBranch = scrapeSrc.slice(scrapeSrc.indexOf("if (flag('--scrape'))"), scrapeSrc.indexOf("if (flag('--ingest'))"));
ok('the scrape branch routes through the build, guarded by the flag',
  scrapeBranch.indexOf('scrapeBuildsWiki(argv)') !== -1 && scrapeBranch.indexOf('buildWikiShape(corpusDir())') !== -1);

// And the build lands the shape the scrape must keep: the link block inside the
// text (that is what the vector sees), on a record that has children.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mhq-wiki-'));
try {
  const manifest = writeWikiCorpus(tmp, { rules, factions, abilities, factionsCsv }, { blockInText: true });
  const written = JSON.parse(fs.readFileSync(path.join(tmp, 'core-rules.json'), 'utf8'));
  ok('the written corpus carries no section link in the text (task-85 D4)',
    written.sections.every(s => !/^- section: /m.test(String(s.text))));
  ok('a non-section link still renders its block line', /- faction: X/.test(renderLinks([{ to: 'x', title: 'X', kind: 'faction' }], 40).text));
  ok('renderLinks still renders a section line; the plan is what drops it',
    /- section: X/.test(renderLinks([{ to: 'x', title: 'X', kind: 'section' }], 40).text) && plan.records.every(r => !/^- section: /m.test(String(r.text))));
  t('and its count is what it wrote', written.count, manifest.written['core-rules']);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

// --- a re-build of a built corpus is a no-op ---------------------------------
// The scrape ends by building the wiki shape in place, and a partial scrape
// (--set factions, --source) leaves the other sources already built. So the build
// has to be idempotent: re-building a built corpus must change nothing, or the
// scrape would grow the very link blocks it exists to preserve. Measured on the
// live corpus, the rebuild is now byte-identical on all five sources.
t('the built block is stripped before it is rebuilt',
  stripBuiltBlock({ text: 'H\nbody\n\n- section: Kid', links: [{ to: 'x', title: 'Kid', kind: 'section' }] }), 'H\nbody');
t('a record with no links is left alone', stripBuiltBlock({ text: 'H\nbody', links: [] }), 'H\nbody');
t('a text that does not end with the block is left alone',
  stripBuiltBlock({ text: 'H\nbody', links: [{ to: 'x', title: 'Kid', kind: 'section' }] }), 'H\nbody');
// The delete endpoint refuses more than 1,000 ids in one call; task-30 deletes
// 1,619. The batch size must stay under the limit, and the ingest must go through
// the batching helper rather than calling the endpoint once with the whole list.
t('the delete batch stays under the endpoint limit', DELETE_BATCH < 1000, true);
// The guard that would have stopped tonight's 5,769-record deletion.
ok('a quarter of a namespace is allowed', massDeleteGuard('factions', 1700, 6829) === null);
ok('just over a quarter is refused', massDeleteGuard('factions', 1800, 6829) !== null);
ok('and the refusal names the flag', /--allow-mass-delete/.test(massDeleteGuard('factions', 5769, 6829)));
ok('an empty state is not a mass delete', massDeleteGuard('factions', 5, 0) === null);
t('the fraction stays at a quarter', MAX_DELETE_FRACTION, 0.25);
ok('the ingest asks the guard before it deletes', /const guard = massDeleteGuard\(/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'rules-corpus.mjs'), 'utf8')));
// An ability record is not a card of a pseudo-faction, and is not lost either.
const abilityPlan = planWiki({ rules: [], factions: [{ id: 'ability#x', set: 'factions', source: 'factions-csv', heading: 'Deadly Demise', text: 'Deadly Demise\nFrom detonating ammo stores.', kind: 'ability' }], abilities: [], factionsCsv: [] });
t('an ability record makes no pseudo-faction index', abilityPlan.records.filter(r => /^faction-index#/.test(r.id)).length, 0);
t('and it is emitted unchanged', abilityPlan.records.map(r => r.id), ['ability#x']);
t('with its kind', abilityPlan.index.get('ability#x').kind, 'ability');
ok('the ingest deletes through deleteIds', /const deleted = await deleteIds\(vanished/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'rules-corpus.mjs'), 'utf8')));

// A record that arrives with its own kind keeps it: the extractor's ability records
// must not be reclassified as rules, nor become faction cards.
t('an arriving kind survives the planner',
  planWiki({ rules: [{ id: 'ability#000008334', set: 'rules', source: 'core-rules', heading: 'Deadly Demise', text: 'Deadly Demise\nFrom detonating ammo stores.', kind: 'ability' }], factions: [], abilities: [], factionsCsv: [] }).index.get('ability#000008334').kind, 'ability');
const built = planWiki({ rules, factions, abilities, factionsCsv });
const roundTrip = planWiki({
  rules: [built.index.get('r#parent'), built.index.get('r#parent->-Child')],
  factions: [], abilities: [], factionsCsv: [],
});
t('a re-build reproduces the built parent text', roundTrip.index.get('r#parent').text, built.index.get('r#parent').text);
t('and does not add a record', roundTrip.records.length, 2);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
