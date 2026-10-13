import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINK_BLOCK_MAX, MIN_PART, WIKI_BUDGET, chars, distribution, idReport, planWiki, renderLinks, resolveLinks, splitWithin } from '../src/wiki-plan.mjs';

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
ok('the parent text carries the child title', parent.text.indexOf('Child Rule') !== -1);
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

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
