import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readAllCorpus, isDelivered, isLegendsRecord, indexedSections, exclusionReason, TENTH_EDITION_RULE_IDS } from '../src/rules-corpus.mjs';
import { findRows, searchHeadings } from '../src/header-index.mjs';
import { recordBody } from '../src/wiki-cards.mjs';

// task-44: Warhammer Legends is a SETTING, and this file is the setting's contract.
//
// The rule Mandal gave, exactly: a Legends record is NEVER EMBEDDED - never in the
// vector index, never in an ask's findings, in any setting. Everything else follows
// the switch. OFF (the default) is today's behaviour and it costs nothing: the book
// is not fetched, not searched and not in the tree. ON makes it readable and findable
// - it is a book the reader can browse and a name the reader can search - and it is
// STILL never embedded, and still labelled, so nobody is misled about matched play.
//
// The three states are pinned here: the corpus predicate, the baked payload, and the
// request parameter the search takes. The wiring (the sheet, the client, the route)
// is pinned as source, the same way test-find.mjs pins its own route.
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name); } };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = rel => JSON.parse(read(rel));

const all = readAllCorpus();
const delivered = all.filter(isDelivered);
const legends = all.filter(isLegendsRecord);
const legendsIds = new Set(legends.map(r => String(r.id)));
const indexed = new Set(indexedSections(all).map(r => String(r.id)));

// --- the rule that does not move: never embedded -----------------------------
ok('the corpus still holds its 958 Legends records', legends.length === 958);
ok('not one of them is delivered', legends.every(r => !isDelivered(r)));
ok('not one of them is in the indexed set', legends.every(r => !indexed.has(String(r.id))));
ok('the indexed set is the delivered set minus the navigation pages', indexed.size === delivered.filter(r => r.kind !== 'index').length);
ok('the delivered count is unchanged by the setting', delivered.length === 6363);
ok('a Legends record still names its reason', legends.every(r => exclusionReason(r) === 'Warhammer Legends'));
const tenth = all.filter(r => TENTH_EDITION_RULE_IDS.has(String(r.id)));
const pack = all.filter(r => String(r.edition) === '0' && !isLegendsRecord(r));
ok('the other two exclusions are still excluded', pack.length === 104 && tenth.length === 1);

// --- the payload: OFF downloads nothing extra --------------------------------
const index = json('workspace/wiki-data/index.json');
const named = (index.branches || []).map(b => b.b);
ok('index.json names exactly the three real books', named.length === 3 && named.join(',') === 'rules,missions,factions');
ok('no branch index.json names is a Legends payload', named.every(b => b.indexOf('legend') === -1));
// The default reader fetches index.json and the branches it names, nothing else.
for (const b of named) ok('the default reader\'s branch exists: ' + b, fs.existsSync(path.join(ROOT, 'workspace', 'wiki-data', 'index', b + '.json')));

// --- the payload: ON is a real book ------------------------------------------
const branch = json('workspace/wiki-data/index/legends.json');
const content = json('workspace/wiki-data/content/legends.json');
const slugFile = json('workspace/wiki-data/index/legends-slugs.json');
const rows = [];
const walk = n => { for (const r of (n.recs || [])) rows.push(r); for (const k of (n.kids || [])) walk(k); };
walk(branch);
ok('the Legends branch is named for the setting', branch.n === 'Warhammer Legends' && branch.b === 'legends');
ok('the branch counts every Legends record', branch.c === 958);
ok('the content book holds every Legends record', Object.keys(content.records).length === 958);
ok('and the id map the search reads holds the same 958', Object.keys(slugFile.slugs).length === 958);
ok('the content ids ARE the Legends ids', Object.keys(content.records).every(id => legendsIds.has(id)));
// Reachability: every Legends record is either a row or named by a row's own list.
const namedIds = new Set();
for (const r of rows) { if (r.id) namedIds.add(String(r.id)); for (const o of (r.own || [])) namedIds.add(String(o)); }
ok('every Legends record is reachable in the tree', legends.every(r => namedIds.has(String(r.id))));
ok('every row carries a slug the client can open', rows.every(r => !!r.slug));
ok('every slug is a legends slug', rows.every(r => String(r.slug).indexOf('legends--') === 0));
ok('the slugs are unique', new Set(rows.map(r => r.slug)).size === rows.length);
ok('the content slug matches the row slug for the same record', rows.every(r => !r.id || !content.records[String(r.id)] || content.records[String(r.id)].slug === r.slug));
// The record's own reason rides in the fragment, whatever the branch is called. A
// faction rule renders its stored text verbatim; a datasheet renders as the unit
// card, whose prose is rebuilt from the tables, so it cannot carry it verbatim.
const leg = legends.find(r => r.kind === 'faction-rule');
const html = recordBody(leg, { href: () => '' });
ok('a Legends record reached by id renders', html.length > 200 && html.indexOf(leg.text.slice(0, 40)) !== -1);
ok('with the banner above it', html.indexOf('wprov-excl') !== -1 && html.indexOf('Not used in matched play') !== -1);
ok('and the banner names the reason', html.indexOf('Warhammer Legends') !== -1);
ok('a delivered record carries no such banner', recordBody(delivered.find(r => r.kind === 'rule'), { href: () => '' }).indexOf('wprov-excl') === -1);

// --- the request parameter: ?legends=1 --------------------------------------
// The route's gate is a PREDICATE, so one process can answer for a page with the
// book open and for a page without it - a global would be one reader's setting
// deciding another reader's results.
const name = String(leg.heading).split(' > ').pop();
const inIndex = searchHeadings(name).rows.some(r => r.id === leg.id);
ok('the heading index does hold the Legends name (the gate is the filter, not the index)', inIndex);
// The route passes the payload's slug map; without it a row carries no address and
// the drawer could not open it, which is the property task-35 pinned for the route.
const slugs = new Map(Object.entries(slugFile.slugs));
const offRows = findRows(name, { slugs: slugs, delivered: new Set([...indexed]) });
ok('with the delivered set the Legends row is not offered', offRows.rows.every(r => r.id !== leg.id));
const onRows = findRows(name, { slugs: slugs, delivered: new Set([...indexed]), allow: id => indexed.has(id) || legendsIds.has(id) });
ok('with the Legends gate the same name IS offered', onRows.rows.some(r => r.id === leg.id));
ok('and the row carries the slug its payload resolves', onRows.rows.filter(r => r.id === leg.id).every(r => content.records[r.id] && content.records[r.id].slug === r.slug));
ok('the count follows the gate, not the index', onRows.total > offRows.total);

// --- the wiring, as source pins ---------------------------------------------
const server = read('src/server.mjs');
const client = read('src/wiki-surface.js');
const page = read('src/rules.html');
const headerIndex = read('src/header-index.mjs');
const payloadSrc = read('src/wiki-payload.mjs');
ok('the route reads legends as a request parameter', /searchParams\.get\('legends'\)/.test(server));
ok('and never as a module global', !/^(let|var|const)\s+LEGENDS\s*=/m.test(server));
ok('the gate is the Legends book the page holds', /legendsSlugMap\(\)/.test(server) && /delivered\.has\(id\) \|\| legendIds\.has\(id\)/.test(server));
// task-97: asserted on BEHAVIOUR. The row shape moved to src/search-core.mjs (the file the web
// bundle ships), so grepping header-index.mjs for the string was a test of where the code lives.
const gateRows = findRows('baneblade', { allow: (id) => String(id).indexOf('datasheet') === 0, slugs: new Map(), cap: 40 });
ok('findRows takes the caller\'s gate', gateRows.rows.length > 0 && gateRows.rows.every((r) => String(r.id).indexOf('datasheet') === 0));
ok('the bake writes the Legends book', /write\('index\/legends\.json'/.test(payloadSrc) && /write\('content\/legends\.json'/.test(payloadSrc));
ok('and never names it in index.json', !/branches\.push\([^)]*legends/.test(payloadSrc));
ok('the setting is per device', client.indexOf("LEGENDS_KEY = 'mhq.rules.legends'") !== -1 && page.indexOf("LEGENDS_KEY = 'mhq.rules.legends'") !== -1);
ok('the client fetches the branch only when the setting is on', /if \(legendsOn\(\)\) return ensureLegendsBranch\(\)/.test(client));
ok('and sends the parameter only then', /legendsOn\(\) && legendsBranch\(\) \? '&legends=1' : ''/.test(client));
ok('the sheet has the switch', /id="legendsseg"/.test(page) && /data-legends="on"/.test(page) && /data-legends="off"/.test(page));
ok('the sheet shows the state', /id="legendsState"/.test(page) && /data-legends-state/.test(page));
ok('the state is visible where the records are', /sv-legends-badge/.test(client) && /Legends on/.test(client));
ok('the sheet writes through the surface API', /api\.setLegends\(on\)/.test(page) && /setLegends: setLegends/.test(client));

console.log('corpus ' + all.length + ': delivered ' + delivered.length + ', Legends ' + legends.length + ', pack ' + pack.length + ', indexed ' + indexed.size + ', Legends rows ' + rows.length);
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
