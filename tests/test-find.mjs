import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRows, searchHeadings } from '../src/header-index.mjs';

// The drawer's search: finding an entry by name, across every book, from the
// heading projection the lookup router already keeps in memory. These are the
// properties a reader would notice if one broke: the name comes first, a mention
// is never an answer, both languages work, and a tap has somewhere to go.
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } }
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const unit = searchHeadings('tyrannofex');
ok('a unit name finds its datasheet first', unit.rows.length >= 1 && unit.rows[0].title === 'Tyrannofex' && unit.rows[0].kind === 'datasheet');
const strat = searchHeadings('rapid ingress');
ok('a stratagem name finds the stratagem', strat.rows.length >= 1 && /RAPID INGRESS/i.test(strat.rows[0].title) && strat.rows[0].kind === 'stratagem');
const across = searchHeadings('battle-shock');
ok('one query reaches the rules half', across.rows.length >= 3 && across.rows.some(r => /battle-shock/i.test(r.title)));
ok('a nested row says where the record sits', Array.isArray(across.rows[0].crumbs) && across.rows[0].crumbs.indexOf('Core Concepts') !== -1);
ok('the exact name ranks above the mentions', /^battle-shock rolls$/i.test(across.rows[0].title));

ok('a mention is not a result', searchHeadings('oath of moment').rows.length === 0);
ok('a heading sentence is never offered as a name', searchHeadings('can a unit shoot after it fell back').rows.every(r => r.title.length <= 64 && r.title.indexOf('?') === -1));

ok('a verb in front of a name is not part of the name', searchHeadings('find fuegan').rows[0].title === 'Fuegan');
ok('the French phrasings use the same tables', searchHeadings('trouve fuegan').rows[0].title === 'Fuegan');

ok('one letter searches nothing', searchHeadings('a').rows.length === 0 && searchHeadings('').rows.length === 0);
ok('the list is capped', searchHeadings('battle', { limit: 2 }).rows.length <= 2);
ok('a bound result still counts the whole match', searchHeadings('battle', { limit: 2 }).total >= 3);

// The wire: the drawer asks our own server, which answers from that projection,
// and every row carries the slug the record can be opened by.
const server = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
const client = fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src', 'wiki-surface.css'), 'utf8');
ok('the route exists', server.indexOf("u.pathname === '/rules/find'") !== -1 && server.indexOf('handleRulesFind') !== -1);
// task-35: the count and the rows are one function's output. Every delivered match is a
// row and carries its id; a filtered record is not in the search at all, so the drawer
// can never report a match it cannot show.
const rowsFor = q => findRows(q, {});
const unitRows = rowsFor('tyrannofex');
ok('every row carries the id it opens by', unitRows.rows.length >= 1 && unitRows.rows.every(r => !!r.id));
ok('the count is the rows it can show', unitRows.total === unitRows.rows.length);
const keepOne = new Set(unitRows.rows.slice(0, 1).map(r => r.id));
const filteredOut = findRows('tyrannofex', { delivered: keepOne });
ok('a filtered record leaves both the rows and the count', filteredOut.total === 1 && filteredOut.rows.length === 1 && filteredOut.rows[0].id === [...keepOne][0]);
const capped = findRows('battle', { cap: 2 });
ok('a capped list still counts the whole match', capped.rows.length <= 2 && capped.total >= 3);
ok('a slug is carried when the payload has one, and its absence is not a drop', rowsFor('voice of command').rows.every(r => typeof r.slug === 'string' && !!r.id));
// task-44 re-anchored this pin: the route resolves the delivered set once and passes
// the Legends gate (a request parameter) beside it.
ok('the route answers through findRows, with the payload slug and the delivered set', /findRows\(q, \{ slugs: surfaceSlugMap\(\), delivered: delivered, allow: allow, cap: 40 \}\)/.test(server));
ok('the route no longer drops a row for having no slug', !/\.filter\(r => r\.slug\)/.test(server));
ok('the client searches our route', client.indexOf("CFG.find || '/rules/find'") !== -1);
ok('typing debounces into one request', /setTimeout\(function \(\) \{ runSearch\(q\); \}, 180\)/.test(client));
ok('a stale answer cannot overwrite a newer query', /if \(state.searchQ !== q\) return;/.test(client));
// task-81: the hit still opens the record it names, and a record whose payload cannot be
// fetched now SAYS so instead of doing nothing (the silent tap was the defect).
ok('a hit opens the record it names', /recordBySlug\(r\.slug\)\.then\(function \(rec\) \{ if \(rec\) showInDrawer\(rec, true\); else missing\(\); \}\)/.test(client));
ok('and a hit that cannot be fetched says so', client.indexOf('is not in the offline copy') !== -1);
ok('a failed record body is reported, not written into a hidden panel', /return false;/.test(client) && /then\(function \(ok\) \{ if \(!ok\) missing\(\); \}\)/.test(client));
ok('and a row with no slug opens from the row itself', client.indexOf("showInDrawer({ id: r.id, kind: r.kind, slug: '', title: r.title, heading: r.title }, true)") !== -1);
ok('the empty state offers the other act', client.indexOf('Ask it instead') !== -1);
ok('the field says what it searches', client.indexOf("filter.placeholder = 'Find a rule, unit or stratagem'") !== -1);

// --- task-58: one unit is one row -------------------------------------------
// Mandal: 'if I search for enginseer in the wiki bar there are 1 militarum and 1
// mechanicus entries (correct) + 3 unitrules entries.' A unit is two records (a
// datasheet and a unitrules keyword list) built from one CSV row, and a chunked
// unit is one record per chunk: the search listed every one of them.
const enginseer = findRows('enginseer', {});
ok('a unit is one row per unit, not one per record', enginseer.rows.length === 2 && enginseer.total === 2);
ok('the two rows are the two units', enginseer.rows.every(r => r.kind === 'datasheet') && enginseer.rows[0].id !== enginseer.rows[1].id);
ok('the head is the datasheet', enginseer.rows.every(r => r.kind === 'datasheet'));
const engParts = [].concat.apply([], enginseer.rows.map(r => r.parts || []));
ok('the records the fold swallowed are named, not lost', engParts.length === 3 && engParts.some(p => p.id === 'unitrules#000001396'));
ok('and every one of them is openable by its own id', engParts.every(p => !!p.id));
ok('the Astra Militarum unitrules record is under the Astra Militarum datasheet', (enginseer.rows.find(r => r.id === 'datasheet#000001396').parts || []).some(p => p.id === 'unitrules#000001396'));
const baneblade = findRows('baneblade', {});
ok('a plain unit folds its twin too', baneblade.rows.length === 2 && baneblade.rows.every(r => r.kind === 'datasheet'));
const leman = findRows('leman russ', {});
const unitNum = id => String(id).replace(/^(?:datasheet|unitrules)#/, '').replace(/~\d+$/, '');
ok('a chunked unit is one row, not one per chunk', new Set(leman.rows.map(r => unitNum(r.id))).size === leman.rows.length);
ok('and its chunks are reachable from the row', leman.rows.some(r => (r.parts || []).some(p => /~\d+$/.test(p.id))));
ok('the row count is the units, not the records', leman.total === leman.rows.length && leman.total < 35);
// A unit whose unitrules has no datasheet twin must still get its row: the fold
// never drops a record it has nothing to fold it into. Measured over the delivered
// corpus every unitrules has a twin, so the case is pinned on the rule itself.
const soloRows = findRows('tyrannofex', { delivered: new Set(['unitrules#000000999']) });
ok('a row the delivered set filters out still leaves the others', soloRows.total === 0 && soloRows.rows.length === 0);
const noTwin = findRows('tyrannofex', { delivered: new Set(['datasheet#000000999']) });
ok('and a datasheet with no keyword list is a row of its own', noTwin.total === 0);
// The name still finds the unit: the fold must not make a record unfindable. The
// check is the whole delivered unit set, name by name.
{
  const { readAllCorpus } = await import('../src/rules-corpus.mjs');
  const heads = readAllCorpus('factions').filter(r => /^(datasheet|unitrules)#/.test(String(r.id)));
  const nameOf = h => String(h.heading).split(' > ').pop().replace(/ - keywords and abilities.*/i, '').replace(/\s*\(\d+\/\d+\)$/, '').trim().toLowerCase();
  const names = [...new Set(heads.map(nameOf).filter(Boolean))];
  let lost = 0;
  for (const n of names) {
    const out = findRows(n, { cap: 40 });
    const reachable = new Set();
    for (const r of out.rows) { reachable.add(r.id); for (const p of (r.parts || [])) reachable.add(p.id); }
    if (!heads.some(h => nameOf(h) === n && reachable.has(h.id))) lost++;
  }
  ok('every unit name still reaches its own records', lost <= 10);
}
// task-60, Mandal: 'neither should exist: clicking the unit already holds the cards.'
// The chip led to the same card - measured over all 1,768 unitrules/datasheet pairs,
// every keyword and every ability the raw record holds renders on the datasheet's card.
// The FOLD stays and the wire still names what it folded; the AFFORDANCE is gone, so
// the client must not render one.
// task-97: asserted on the ROWS, not on a source string. The matcher and the row shape moved to
// src/search-core.mjs, which is also what the web bundle ships, so grepping a file path was a
// test of where the code lives rather than of what the route returns.
ok('the wire still names the records a row stands for', (enginseer.rows[1].parts || []).length > 0 && enginseer.rows[1].parts.every((p) => !!p.id && !!p.title));
ok('a row still opens the record it names', client.indexOf('function openHit(r)') !== -1 && /b\.addEventListener\('click', function \(\) \{ openHit\(r\); \}\)/.test(client));
ok('the client renders no parts chips', client.indexOf('sv-hit-part') === -1 && client.indexOf('sv-hit-parts') === -1);
ok('and no \u2018also\u2019 line', client.indexOf("'also'") === -1);
ok('the parts CSS is gone with them', css.indexOf('sv-hit-part') === -1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
